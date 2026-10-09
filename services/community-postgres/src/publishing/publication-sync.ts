import { randomUUID } from "node:crypto";
import { insertJob } from "./jobs.js";
import { nowParam } from "./db.js";
import type { PublishingDb } from "./db.js";

export interface PublicationSyncOptions {
  readonly allowPublish: () => boolean;
  readonly isPublic: () => boolean;
}
const hex = (): string => randomUUID().replaceAll("-", "");

interface SyncInput {
  readonly publishItemIds?: readonly string[];
  readonly withdrawItemIds?: readonly string[];
  readonly publishCatalogIds?: readonly string[];
  readonly withdrawCatalogIds?: readonly string[];
}
/** One union, one ordered asset lock pass, one sequence bump per affected asset. */
export const refreshPublicationReferences = async (
  db: PublishingDb,
  input: SyncInput,
  now: Date,
  options?: PublicationSyncOptions,
): Promise<void> => {
  const publishItems = [...new Set(input.publishItemIds ?? [])].sort();
  const publishCatalog = [...new Set(input.publishCatalogIds ?? [])].sort();
  const itemIds = [
    ...new Set([...publishItems, ...(input.withdrawItemIds ?? [])]),
  ].sort();
  const catalogIds = [
    ...new Set([...publishCatalog, ...(input.withdrawCatalogIds ?? [])]),
  ].sort();
  if (itemIds.length + catalogIds.length === 0) return;
  const publish =
    options?.isPublic() === true && options.allowPublish() === true;
  const at = nowParam(now);
  if (publish) {
    for (const itemId of publishItems)
      await db.query(
        `INSERT INTO community.media_public_assets(id,item_id,desired_at,created_at,updated_at) VALUES($1,$2,$3::timestamptz,$3::timestamptz,$3::timestamptz) ON CONFLICT(item_id) DO NOTHING`,
        [hex(), itemId, at],
      );
    for (const assetId of publishCatalog)
      await db.query(
        `INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3::timestamptz,$3::timestamptz,$3::timestamptz) ON CONFLICT(catalog_asset_id) DO NOTHING`,
        [hex(), assetId, at],
      );
  }
  const rows = (
    await db.query<{
      id: string;
      item_id: string | null;
      catalog_asset_id: string | null;
      live: boolean;
    }>(
      `SELECT a.id,a.item_id,a.catalog_asset_id,EXISTS(SELECT 1 FROM community.media_publications p WHERE p.public_asset_id=a.id AND p.state<>'withdrawn') AS live
     FROM community.media_public_assets a WHERE a.item_id=ANY($1::text[]) OR a.catalog_asset_id=ANY($2::text[]) ORDER BY a.id FOR UPDATE OF a`,
      [itemIds, catalogIds],
    )
  ).rows;
  for (const a of rows) {
    await db.query(
      "UPDATE community.media_public_assets SET desired_seq=desired_seq+1,desired_at=$2::timestamptz,updated_at=$2::timestamptz WHERE id=$1",
      [a.id, at],
    );
    const subject = a.item_id ?? a.catalog_asset_id!;
    // Every live old generation is reconsidered against the final pointer/hold/status.
    if (a.live)
      await insertJob(
        db,
        { kind: "withdraw_media", subjectId: subject, maxAttempts: 3 },
        now,
      );
    if (
      publish &&
      ((a.item_id !== null && publishItems.includes(a.item_id)) ||
        (a.catalog_asset_id !== null &&
          publishCatalog.includes(a.catalog_asset_id)))
    )
      await insertJob(
        db,
        { kind: "publish_media", subjectId: subject, maxAttempts: 3 },
        now,
      );
  }
};

/** Existing assets are always fenced/drained; new public assets require both runtime gates. */
export const requestPublicationSync = async (
  db: PublishingDb,
  input: {
    readonly itemIds?: readonly string[];
    readonly catalogAssetIds?: readonly string[];
    readonly intent: "publish" | "withdraw";
  },
  now: Date,
  options?: PublicationSyncOptions,
): Promise<void> =>
  refreshPublicationReferences(
    db,
    input.intent === "publish"
      ? {
          publishItemIds: input.itemIds ?? [],
          publishCatalogIds: input.catalogAssetIds ?? [],
        }
      : {
          withdrawItemIds: input.itemIds ?? [],
          withdrawCatalogIds: input.catalogAssetIds ?? [],
        },
    now,
    options,
  );

export const beginWorkPublicationSync = async (
  db: PublishingDb,
  workId: string,
  options?: PublicationSyncOptions,
) => {
  const read = async (): Promise<string[]> =>
    (
      await db.query<{ item_id: string }>(
        `SELECT DISTINCT ri.item_id FROM community.work_revision_items ri JOIN community.works w ON w.public_revision_id=ri.revision_id WHERE w.id=$1`,
        [workId],
      )
    ).rows.map((r) => r.item_id);
  const before = await read();
  return {
    finish: async (
      now: Date,
      additionalItemIds: readonly string[] = [],
      additionalIntent: "publish" | "withdraw" = "withdraw",
    ): Promise<void> => {
      await refreshPublicationReferences(
        db,
        {
          withdrawItemIds: [...before, ...additionalItemIds],
          publishItemIds: [
            ...(await read()),
            ...(additionalIntent === "publish" ? additionalItemIds : []),
          ],
        },
        now,
        options,
      );
    },
  };
};
export const beginArticlePublicationSync = async (
  db: PublishingDb,
  articleId: string,
  options?: PublicationSyncOptions,
) => {
  const read = async (): Promise<string[]> =>
    (
      await db.query<{ item_id: string }>(
        `SELECT DISTINCT ref.item_id FROM community.article_documents a JOIN community.media_item_refs ref ON ref.holder_kind='article_revision' AND ref.holder_id='article-revision-'||substr(encode(sha256(convert_to(a.id||':'||a.published_version::text,'UTF8')),'hex'),1,32) WHERE a.id=$1 AND a.published_version IS NOT NULL`,
        [articleId],
      )
    ).rows.map((r) => r.item_id);
  const before = await read();
  return {
    finish: async (now: Date): Promise<void> => {
      await refreshPublicationReferences(
        db,
        { withdrawItemIds: before, publishItemIds: await read() },
        now,
        options,
      );
    },
  };
};
export const requestOwnerPublicationSync = async (
  db: PublishingDb,
  ownerId: string,
  intent: "publish" | "withdraw",
  now: Date,
  options?: PublicationSyncOptions,
): Promise<void> => {
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM community.media_items WHERE owner_id=$1 ORDER BY id",
      [ownerId],
    )
  ).rows.map((r) => r.id);
  await requestPublicationSync(db, { itemIds: ids, intent }, now, options);
};
export const syncWorkHolds = async (
  db: PublishingDb,
  workId: string,
  removed: boolean,
  now: Date,
): Promise<readonly string[]> => {
  const ids = (
    await db.query<{ item_id: string }>(
      "SELECT DISTINCT ri.item_id FROM community.work_revision_items ri JOIN community.work_revisions r ON r.id=ri.revision_id WHERE r.work_id=$1 ORDER BY ri.item_id",
      [workId],
    )
  ).rows.map((r) => r.item_id);
  if (removed)
    await db.query(
      `INSERT INTO community.media_item_holds(item_id,work_id,created_at) SELECT unnest($1::text[]),$2,$3::timestamptz ON CONFLICT(item_id,work_id) DO UPDATE SET created_at=EXCLUDED.created_at,released_at=NULL`,
      [ids, workId, nowParam(now)],
    );
  else
    await db.query(
      "UPDATE community.media_item_holds SET released_at=$2::timestamptz WHERE work_id=$1 AND released_at IS NULL",
      [workId, nowParam(now)],
    );
  return ids;
};
