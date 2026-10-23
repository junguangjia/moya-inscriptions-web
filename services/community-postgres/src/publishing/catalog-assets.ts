import { createHash } from "node:crypto";

import type {
  CatalogAssetSyncCounts,
  CatalogAssetSyncOptions,
  CatalogMediaSource,
  CatalogRenderOutcome,
  CatalogRenderPlan,
  CatalogRenditionIdentity,
  PublishingDerivativeCommit,
} from "@moya/api";
import type { Pool } from "pg";

import { nowParam, readTransaction, writeTransaction } from "./db.js";
import { RECIPE_DIGEST_PATTERN } from "./recipe-identity.js";
import {
  catalogPrivateProcessingReferenceSql,
  synchronizeCatalogDeliveryIntents,
} from "./catalog-delivery-intents.js";
import { CATALOG_SNAPSHOT_MAX_SOURCES } from "./catalog-snapshot-ceiling.js";
import {
  changedCatalogIntentAssets,
  markCatalogPublicationDirty,
  readCatalogMirrorStates,
  type CatalogPublicationDirtyReason,
} from "./catalog-publication-dirty.js";
import { recordRenditionRows, unrecordedKeys } from "./renditions.js";

/*
 * Catalog media assets (unified media pipeline, increment 1): sync from the
 * published Catalog list, the render plan of one `catalog_render` job, and
 * recording its renditions and facts in one transaction. Each exported
 * function implements the same-named CatalogMediaAssetPort method (see its
 * JSDoc in @moya/api); `pool` is the adapter's pool. Catalog source objects
 * are never written or deleted here; their renditions are owner-less blobs.
 */

/**
 * One sync pass as this store runs it: a complete snapshot may also name the
 * intents it holds but could not decode, whose mirror rows are left untouched
 * (catalog-delivery-release-hardening-v1 F7), and the pass reports the decoded
 * intents it refused and tombstoned (F3, including an identity drift of an
 * intent that is over), and the live ones whose immutable identity the
 * snapshot contradicts and whose mirror rows it left untouched, each only
 * when there are any, for the caller's log. Intent IDs are opaque UUIDs, never
 * content.
 */
export type CatalogAssetSyncPassOptions = CatalogAssetSyncOptions & {
  readonly snapshot?: NonNullable<CatalogAssetSyncOptions["snapshot"]> & {
    readonly undecodableIntentIds?: readonly string[];
  };
};
export type CatalogAssetSyncPassCounts = CatalogAssetSyncCounts & {
  readonly refusedIntentIds?: readonly string[];
  readonly mismatchedIntentIds?: readonly string[];
};

const MAX_BATCH = 1000;
/**
 * How long a failed render waits before the sync tries it again. A pending
 * asset that failed only because its source could not be read (missing or
 * forbidden: a read permission not granted yet, a transient signing or
 * deployment error) is rendered again this long after it failed; every other
 * failure of a pending asset is a fact of the hash-pinned source bytes and
 * stays final. A ready asset never fails: its failed render job (a rejected
 * re-render, or attempts used up) is queued again this long after it failed,
 * while the asset keeps its ready renditions.
 */
const RETRY_DELAY_SQL = "interval '24 hours'";
/** A ready rendition counts only while its blob is committed (a rollback can purge it). */
const LIVE_RENDITION_SQL = `community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'`;
/**
 * SQL: asset `a` misses a ready rendition, on a committed blob, of one of the
 * listed identities (`$3`, a JSON array of `{role, version, digest}`).
 */
const MISSING_IDENTITY_SQL = `EXISTS (
  SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS want(role text, version integer, digest text)
  WHERE NOT EXISTS (
    SELECT 1 FROM ${LIVE_RENDITION_SQL}
    WHERE r.catalog_asset_id=a.id AND r.state='ready' AND r.role=want.role
      AND r.recipe_version=want.version AND r.recipe_digest=want.digest))`;
/**
 * SQL: job alias `j` is a base `catalog_render` job (the four ordinary roles),
 * not a block job of a display master (payload variant `blocks`,
 * catalog-deep-zoom-v1). Base jobs carry no payload today; a future base
 * payload without a variant stays base.
 */
export const baseCatalogRenderJobSql = (job: string): string =>
  `${job}.kind='catalog_render' AND COALESCE(${job}.payload->>'variant','base')='base'`;
/** SQL: when job `j` ended (failed rows always carry `finished_at`). */
const endedAtSql = (job: string): string =>
  `COALESCE(${job}.finished_at, ${job}.updated_at)`;
const MAX_DIMENSION = 65_535;
const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const MEDIA_ID = /^[^\s]{1,128}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLACEHOLDER_COLOR = /^#[0-9a-f]{6}$/u;
const CATALOG_ROLES: ReadonlySet<string> = new Set([
  "thumb",
  "cover",
  "display",
  "viewer",
]);
/** The two approved key forms; each embeds the SHA-256 of the object bytes. */
const DISPLAY_KEY = /^display\/v1\/media_[a-f0-9]{32}\/([a-f0-9]{64})\.webp$/u;
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-([a-f0-9]{64})\.(jpg|png|webp)$/u;
const SOURCE_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type SourceContentType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];

/** The byte hash and content type an approved key names, or null for any other key. */
const approvedKey = (
  key: string,
): {
  readonly sha256: string;
  readonly contentType: SourceContentType;
} | null => {
  const display = DISPLAY_KEY.exec(key);
  if (display?.[1] !== undefined)
    return { sha256: display[1], contentType: "image/webp" };
  const editorial = EDITORIAL_KEY.exec(key);
  if (editorial?.[1] !== undefined && editorial[2] !== undefined)
    return {
      sha256: editorial[1],
      contentType: SOURCE_TYPES[editorial[2] as keyof typeof SOURCE_TYPES],
    };
  return null;
};

/** `catalog-asset-` + md5(media id ':' key), as the table CHECK derives it. */
const assetIdOf = (mediaId: string, objectKey: string): string =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`, "utf8").digest("hex")}`;

const dimension = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_DIMENSION
    ? value
    : null;

const assertAssetId = (assetId: string): void => {
  if (!ASSET_ID.test(assetId))
    throw new TypeError("A Catalog asset id is catalog-asset-<32 hex>");
};

const assertIdentities = (
  identities: readonly CatalogRenditionIdentity[],
): void => {
  const roles = new Set<string>();
  for (const identity of identities) {
    if (
      !CATALOG_ROLES.has(identity.role) ||
      roles.has(identity.role) ||
      !Number.isSafeInteger(identity.version) ||
      identity.version < 1 ||
      !RECIPE_DIGEST_PATTERN.test(identity.digest)
    )
      throw new TypeError(
        "Catalog rendition identities name distinct roles, versions and digests",
      );
    roles.add(identity.role);
  }
};

interface NamedSource {
  readonly id: string;
  readonly media_id: string;
  readonly object_key: string;
  readonly source_sha256: string;
  readonly source_content_type: SourceContentType;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * SQL: asset alias `a` is named by the pass, the typed `text[]` bind `$1`.
 * Each statement of the sync joins or anti-joins that one array (never a
 * temporary table, which the App role may not create, and never a DELETE),
 * so a pass at the snapshot ceiling binds each id once per statement and
 * sends complete source rows only for the assets it creates
 * (catalog-scale-v1 W4).
 */
const NAMED_SQL = `EXISTS (SELECT 1 FROM unnest($1::text[]) AS named(id) WHERE named.id=a.id)`;

/** CatalogMediaAssetPort.syncCatalogAssets */
export const syncCatalogAssets = async (
  pool: Pool,
  sources: readonly CatalogMediaSource[],
  now: Date,
  options: CatalogAssetSyncPassOptions,
): Promise<CatalogAssetSyncPassCounts> => {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_BATCH
  )
    throw new TypeError("A Catalog sync takes 1..1000 assets per pass");
  assertIdentities(options.renditions);
  if (
    !Array.isArray(sources) ||
    sources.length > CATALOG_SNAPSHOT_MAX_SOURCES ||
    (options.snapshot !== undefined &&
      (!Array.isArray(options.snapshot.publishedSources) ||
        options.snapshot.publishedSources.length >
          CATALOG_SNAPSHOT_MAX_SOURCES))
  )
    throw new TypeError(
      "A Catalog sync takes at most the snapshot ceiling of sources",
    );
  const named = new Map<string, NamedSource>();
  let skipped = 0;
  for (const source of sources) {
    const key = approvedKey(source.objectKey);
    if (key === null || !MEDIA_ID.test(source.mediaId)) {
      skipped += 1;
      continue;
    }
    const id = assetIdOf(source.mediaId, source.objectKey);
    if (named.has(id)) continue;
    const width = dimension(source.width);
    const height = dimension(source.height);
    const paired = width !== null && height !== null;
    named.set(id, {
      id,
      media_id: source.mediaId,
      object_key: source.objectKey,
      source_sha256: key.sha256,
      source_content_type: key.contentType,
      width: paired ? width : null,
      height: paired ? height : null,
    });
  }
  const ids = [...named.keys()].sort();
  const at = nowParam(now);
  const publishedIds = options.snapshot
    ? [
        ...new Set(
          options.snapshot.publishedSources.map((source) =>
            assetIdOf(source.mediaId, source.objectKey),
          ),
        ),
      ].sort()
    : ids;
  return writeTransaction(pool, async (db) => {
    // The mirror rows of the snapshot's intents before and after the pass
    // applies them (catalog-scale-v1 W8): an intent whose state, version or
    // liveness the pass changes (a new, advanced or refused one) marks its
    // assets for the scoped reconcile. The membership step compares the CMS
    // with this mirror, so a change applied here first leaves it nothing to
    // find. An intent absent from the snapshot ended or lapsed more than R
    // ago and grants nothing, so its tombstone marks nothing.
    const snapshotIntentIds = (options.snapshot?.preparations ?? []).map(
      (intent) => (intent as { intentId?: unknown }).intentId,
    );
    const intentIds = snapshotIntentIds.filter(
      (id): id is string => typeof id === "string",
    );
    const mirrorBefore = options.snapshot?.preparations
      ? await readCatalogMirrorStates(db, intentIds)
      : undefined;
    const intents = options.snapshot
      ? await synchronizeCatalogDeliveryIntents(
          db,
          options.snapshot.preparations,
          options.snapshot.observedAt,
          options.snapshot.undecodableIntentIds,
        )
      : undefined;
    const marks = new Map<string, CatalogPublicationDirtyReason>();
    if (mirrorBefore)
      for (const id of await changedCatalogIntentAssets(
        db,
        mirrorBefore,
        await readCatalogMirrorStates(db, intentIds),
      ))
        marks.set(id, "intent");
    // The first `limit` named ids without an asset (anti-join), then only
    // their complete rows, as typed arrays.
    const missing = (
      await db.query<{ id: string }>(
        `SELECT named.id FROM unnest($1::text[]) AS named(id)
         WHERE NOT EXISTS (SELECT 1 FROM community.catalog_media_assets a WHERE a.id=named.id)
         ORDER BY named.id
         LIMIT $2`,
        [ids, options.limit],
      )
    ).rows.map((row) => named.get(row.id)!);
    const created = missing.length
      ? await db.query(
          `INSERT INTO community.catalog_media_assets(
             id, media_id, source_object_key, source_sha256, source_width, source_height,
             source_content_type, state, created_at, updated_at)
           SELECT s.id, s.media_id, s.object_key, s.source_sha256, s.width, s.height,
             s.source_content_type, 'pending', $8::timestamptz, $8::timestamptz
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
             $6::integer[], $7::integer[])
             AS s(id, media_id, object_key, source_sha256, source_content_type, width, height)
           ORDER BY s.id
           ON CONFLICT (media_id, source_object_key) DO NOTHING
           RETURNING id`,
          [
            missing.map((source) => source.id),
            missing.map((source) => source.media_id),
            missing.map((source) => source.object_key),
            missing.map((source) => source.source_sha256),
            missing.map((source) => source.source_content_type),
            missing.map((source) => source.width),
            missing.map((source) => source.height),
            at,
          ],
        )
      : { rowCount: 0 };
    // Every existing asset row the statements below change is locked first,
    // by one statement in id order: each row whose reference state flips and
    // each unreadable source due for a retry. That is the sorted asset lock
    // order readiness inspection and render recording take, so an inspection
    // running beside this pass (no lock of every mirror row holds it back
    // any more) waits for the pass or the pass for it, never each for the
    // other (40P01). The statements below then wait on no asset row: only
    // this pass writes reference state, and a row falls due only by a write
    // older than the retry delay.
    await db.query(
      `SELECT count(*)::integer AS locked FROM (
         SELECT a.id FROM community.catalog_media_assets a
         LEFT JOIN unnest($3::text[]) AS published(id) ON published.id=a.id
         WHERE (published.id IS NOT NULL) = (a.unreferenced_since IS NOT NULL)
           OR (a.state='failed' AND a.failure_code='source_unreadable'
             AND a.updated_at < $2::timestamptz - ${RETRY_DELAY_SQL}
             AND ${NAMED_SQL})
         ORDER BY a.id
         FOR UPDATE OF a
       ) changing`,
      [ids, at, publishedIds],
    );
    // Re-referenced (join) and newly unreferenced (anti-join) assets, from
    // the complete published list only: never from a partial one, which the
    // snapshot reader refuses as a whole (null) before this is called. Each
    // flip marks its asset for the scoped reconcile (W8): a re-published one
    // may copy its renditions again, a taken-down one must be withdrawn.
    const rereferenced = await db.query<{ id: string }>(
      `UPDATE community.catalog_media_assets a
       SET unreferenced_since=NULL, updated_at=$2::timestamptz
       FROM unnest($1::text[]) AS published(id)
       WHERE a.id=published.id AND a.unreferenced_since IS NOT NULL
       RETURNING a.id`,
      [publishedIds, at],
    );
    const unreferenced = await db.query<{ id: string }>(
      `UPDATE community.catalog_media_assets a
       SET unreferenced_since=$2::timestamptz, updated_at=$2::timestamptz
       WHERE a.unreferenced_since IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS published(id) WHERE published.id=a.id)
       RETURNING a.id`,
      [publishedIds, at],
    );
    for (const { id } of [...rereferenced.rows, ...unreferenced.rows])
      marks.set(id, "reference");
    // A named asset whose source was unreadable gets another render once the
    // retry delay passed (bounded per pass); other failures stay final.
    await db.query(
      `UPDATE community.catalog_media_assets a
       SET state='pending', failure_code=NULL, updated_at=$2::timestamptz
       FROM (
         SELECT a.id FROM community.catalog_media_assets a
         WHERE a.state='failed' AND a.failure_code='source_unreadable'
           AND a.updated_at < $2::timestamptz - ${RETRY_DELAY_SQL}
           AND ${NAMED_SQL}
         ORDER BY a.updated_at, a.id
         LIMIT $3
         FOR UPDATE OF a
       ) due
       WHERE a.id=due.id`,
      [ids, at, options.limit],
    );
    const wanted = JSON.stringify(options.renditions);
    // A named asset is rendered while pending, or again while ready but
    // missing a ready rendition (on a committed blob) of a listed identity.
    // One queued or running job per asset (the active unique index); a
    // failed or abandoned job waits for the operator, as every scheduled
    // kind does, except as below.
    const inserted = await db.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,created_at,updated_at)
       SELECT 'publishing-job-' || replace(gen_random_uuid()::text, '-', ''), 'catalog_render', c.id,
         'queued', 0, $2::timestamptz, $2::timestamptz, $2::timestamptz
       FROM (
         SELECT a.id FROM community.catalog_media_assets a
         WHERE ${NAMED_SQL}
           AND (a.state='pending' OR (a.state='ready' AND ${MISSING_IDENTITY_SQL}))
           AND NOT EXISTS (
             SELECT 1 FROM community.publishing_jobs j
             WHERE ${baseCatalogRenderJobSql("j")} AND j.subject_id=a.id
               AND j.state IN ('queued','running','failed','abandoned'))
         ORDER BY a.created_at, a.id
         LIMIT $4
       ) c
       ON CONFLICT (kind, subject_id, md5(COALESCE(payload, '{}'::jsonb)::text)) WHERE state IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [ids, at, wanted, options.limit],
    );
    const insertedCount = inserted.rowCount ?? 0;
    // A ready asset still missing a listed identity whose latest render job
    // failed (its re-render was rejected, or its attempts were used up) keeps
    // its ready renditions; that job is queued again, with fresh attempts,
    // once the retry delay passed since it failed, so a rejection is retried
    // daily instead of on every pass. An abandoned job (the operator's stop)
    // still blocks. Within the same per-pass bound as new jobs.
    const requeued =
      insertedCount >= options.limit
        ? 0
        : ((
            await db.query(
              `UPDATE community.publishing_jobs j
               SET state='queued', attempts=0, run_after=$2::timestamptz, lease_owner=NULL,
                   lease_expires_at=NULL, last_error_code=NULL, finished_at=NULL,
                   updated_at=$2::timestamptz
               FROM (
                 SELECT f.id FROM community.publishing_jobs f
                 JOIN community.catalog_media_assets a ON a.id=f.subject_id
                 WHERE ${baseCatalogRenderJobSql("f")} AND f.state='failed'
                   AND ${endedAtSql("f")} < $2::timestamptz - ${RETRY_DELAY_SQL}
                   AND ${NAMED_SQL}
                   AND a.state='ready' AND ${MISSING_IDENTITY_SQL}
                   AND NOT EXISTS (
                     SELECT 1 FROM community.publishing_jobs o
                     WHERE ${baseCatalogRenderJobSql("o")} AND o.subject_id=f.subject_id AND o.id<>f.id
                       AND (o.state IN ('queued','running','abandoned')
                         OR (o.state='failed'
                           AND (${endedAtSql("o")}, o.id) > (${endedAtSql("f")}, f.id))))
                 ORDER BY ${endedAtSql("f")}, f.id
                 LIMIT $4
                 FOR UPDATE OF f SKIP LOCKED
               ) due
               WHERE j.id=due.id AND j.state='failed'
               RETURNING j.id`,
              [ids, at, wanted, options.limit - insertedCount],
            )
          ).rowCount ?? 0);
    // The marks are the pass's last write, one statement in asset id order
    // after every asset and job row it writes (the lock order of
    // catalog-publication-dirty): the dirty rows are held only to commit.
    await markCatalogPublicationDirty(db, marks, now);
    return {
      referenced: ids.length,
      skipped,
      created: created.rowCount ?? 0,
      unreferenced: unreferenced.rowCount ?? 0,
      enqueued: insertedCount + requeued,
      ...(intents?.refused.length ? { refusedIntentIds: intents.refused } : {}),
      ...(intents?.mismatched.length
        ? { mismatchedIntentIds: intents.mismatched }
        : {}),
    };
  });
};

/** CatalogMediaAssetPort.readCatalogRenderPlan */
export const readCatalogRenderPlan = async (
  pool: Pool,
  assetId: string,
): Promise<CatalogRenderPlan | null> => {
  assertAssetId(assetId);
  return readTransaction(pool, async (db) => {
    const asset = (
      await db.query<{
        id: string;
        media_id: string;
        source_object_key: string;
        source_width: number | null;
        source_height: number | null;
        state: "pending" | "ready" | "failed";
        unreferenced_since: Date | null;
        referenced: boolean;
        master_sha256: string | null;
        master_width: number | null;
        master_height: number | null;
      }>(
        `SELECT id, media_id, source_object_key, source_width, source_height, state, unreferenced_since,master_sha256,master_width,master_height,
          (unreferenced_since IS NULL OR ${catalogPrivateProcessingReferenceSql("id")}) AS referenced
         FROM community.catalog_media_assets WHERE id=$1`,
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed") return null;
    const key = approvedKey(asset.source_object_key);
    if (key === null) return null;
    const ready = await db.query<{
      role: CatalogRenditionIdentity["role"];
      recipe_version: number;
      recipe_digest: string;
      width: number;
      height: number;
    }>(
      `SELECT r.role, r.recipe_version, r.recipe_digest, r.width, r.height
       FROM ${LIVE_RENDITION_SQL}
       WHERE r.catalog_asset_id=$1 AND r.state='ready'
         AND r.role IN ('thumb','cover','display','viewer')
       ORDER BY r.role`,
      [assetId],
    );
    return {
      assetId: asset.id,
      mediaId: asset.media_id,
      sourceObjectKey: asset.source_object_key,
      sourceSha256: key.sha256,
      sourceContentType: key.contentType,
      sourceWidth: asset.source_width,
      sourceHeight: asset.source_height,
      state: asset.state,
      referenced: asset.referenced,
      masterSha256: asset.master_sha256,
      masterWidth: asset.master_width,
      masterHeight: asset.master_height,
      ready: ready.rows.map((row) => ({
        role: row.role,
        version: row.recipe_version,
        digest: row.recipe_digest,
        width: row.width,
        height: row.height,
      })),
    };
  });
};

const assertOutcome = (outcome: CatalogRenderOutcome): void => {
  const sideOk = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION;
  if (
    !SHA256.test(outcome.masterSha256) ||
    !sideOk(outcome.masterWidth) ||
    !sideOk(outcome.masterHeight) ||
    (outcome.placeholderColor !== null &&
      !PLACEHOLDER_COLOR.test(outcome.placeholderColor)) ||
    !Array.isArray(outcome.renditions)
  )
    throw new TypeError("Malformed Catalog render outcome");
  for (const record of outcome.renditions)
    if (!CATALOG_ROLES.has(record.role))
      throw new TypeError("Unknown Catalog rendition role");
};

/** CatalogMediaAssetPort.recordCatalogRenditions */
export const recordCatalogRenditions = async (
  pool: Pool,
  assetId: string,
  outcome: CatalogRenderOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  assertAssetId(assetId);
  assertOutcome(outcome);
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const asset = (
      await db.query<{ state: string; source_sha256: string | null }>(
        "SELECT state, source_sha256 FROM community.catalog_media_assets WHERE id=$1 FOR UPDATE",
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed")
      return {
        status: "discarded",
        storageKeys: await unrecordedKeys(db, outcome.renditions),
      };
    if (
      asset.source_sha256 !== null &&
      asset.source_sha256 !== outcome.masterSha256
    )
      throw new TypeError("The rendered source is not the asset's source");
    const { duplicates } = await recordRenditionRows(
      db,
      { kind: "catalog", id: assetId },
      outcome.renditions.map((record) => ({
        storageKey: record.storageKey,
        byteSize: record.byteSize,
        sha256: record.sha256,
        role: record.role,
        editKey: "base",
        contentType: record.contentType,
        width: record.width,
        height: record.height,
        durationMs: null,
        recipeVersion: record.recipeVersion,
        recipeDigest: record.recipeDigest,
      })),
      now,
    );
    await db.query(
      `UPDATE community.catalog_media_assets
       SET state='ready', failure_code=NULL, master_sha256=$2, master_width=$3, master_height=$4,
           placeholder_color=$5, updated_at=$6::timestamptz
       WHERE id=$1`,
      [
        assetId,
        outcome.masterSha256,
        outcome.masterWidth,
        outcome.masterHeight,
        outcome.placeholderColor,
        at,
      ],
    );
    // New renditions are copied only by a reconcile that plans the asset: a
    // first render of a published image, or a recipe re-render whose set
    // replaces the one serving (N3). The mark puts the asset in the next
    // scoped pass (catalog-scale-v1 W7/W8) instead of waiting for the sweep;
    // it is the last write, after the asset row's lock.
    await markCatalogPublicationDirty(
      db,
      new Map([[assetId, "rendition"]]),
      now,
    );
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });
};

/** CatalogMediaAssetPort.failCatalogAsset */
export const failCatalogAsset = async (
  pool: Pool,
  assetId: string,
  failureCode: string,
  now: Date,
): Promise<void> => {
  assertAssetId(assetId);
  if (!FAILURE_CODE.test(failureCode))
    throw new TypeError("Catalog failure codes are content-free identifiers");
  const at = nowParam(now);
  await writeTransaction(pool, (db) =>
    db.query(
      `UPDATE community.catalog_media_assets
       SET state='failed', failure_code=$2, updated_at=$3::timestamptz
       WHERE id=$1 AND state='pending'`,
      [assetId, failureCode, at],
    ),
  );
};
