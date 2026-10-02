import { CatalogMediaResolutionError } from "@moya/api";
import { publicMediaSchema } from "@moya/contracts/schemas";
import type { StorageUrlResolver, StorageMediaLocator } from "@moya/api";
import type {
  ArticleMediaReference,
  MediaId,
  PublicMedia,
} from "@moya/contracts";
import type { Pool } from "pg";
import { asPostgresOperationError } from "./availability.js";
import { mapCatalogMediaRow } from "./row-mapper.js";
import type { CatalogMediaRow } from "./row-mapper.js";

type Pair = Omit<Extract<ArticleMediaReference, { type: "catalog" }>, "type">;
export const authoredArticleCatalogPairKey = (
  catalogId: string,
  mediaId: string,
): string => JSON.stringify([catalogId, mediaId]);

/** Exact published Catalog pairs; shares the existing object-key URL boundary. */
export class PostgresAuthoredArticleCatalogMediaResolver {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageUrlResolver,
  ) {}
  async resolveCatalog(
    pairs: readonly Pair[],
  ): Promise<ReadonlyMap<string, PublicMedia>> {
    const wanted = new Map(
      pairs.map((pair) => [
        authoredArticleCatalogPairKey(pair.catalogId, pair.mediaId),
        pair,
      ]),
    );
    if (wanted.size > 60) throw new Error("article_reference_limit");
    if (wanted.size === 0) return new Map();
    const db = await this.pool.connect().catch((error) => {
      throw asPostgresOperationError(error, "connect");
    });
    let rows: CatalogMediaRow[];
    try {
      await db.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      rows = (
        await db.query<CatalogMediaRow>(
          `
        SELECT cm.media_id,cm.catalog_id,cm.position,cm.is_representative,cm.kind,
          cm.alt_text,cm.width,cm.height,cm.object_key
        FROM jsonb_to_recordset($1::jsonb) AS pair("catalogId" text,"mediaId" text)
        JOIN public.catalog_entries ce ON ce.catalog_id=pair."catalogId"
        JOIN public.catalog_media cm ON cm.catalog_id=ce.catalog_id AND cm.media_id=pair."mediaId"
        ORDER BY cm.catalog_id,cm.media_id`,
          [JSON.stringify([...wanted.values()])],
        )
      ).rows;
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asPostgresOperationError(error, "query");
    } finally {
      db.release();
    }
    const projections = rows.map((row) => ({
      catalogId: row.catalog_id as string,
      media: mapCatalogMediaRow(row),
    }));
    const groups: StorageMediaLocator[][] = [];
    const locatorGroup = new Map<string, number>();
    const occurrence = new Map<MediaId, Map<string, number>>();
    // A MediaId map cannot represent two different object keys in one call.
    // Normally this is one batch; legacy repeated IDs use separate exact batches.
    for (const { media } of projections) {
      let keys = occurrence.get(media.id);
      if (!keys) {
        keys = new Map();
        occurrence.set(media.id, keys);
      }
      let group = keys.get(media.objectKey);
      if (group === undefined) {
        group = keys.size;
        keys.set(media.objectKey, group);
        (groups[group] ??= []).push({
          mediaId: media.id,
          objectKey: media.objectKey,
        });
      }
      locatorGroup.set(JSON.stringify([media.id, media.objectKey]), group);
    }
    const urls: ReadonlyMap<MediaId, string>[] = [];
    try {
      for (const group of groups)
        urls.push(await this.storage.resolveMany(group));
    } catch (error) {
      throw error instanceof CatalogMediaResolutionError
        ? error
        : new CatalogMediaResolutionError({ cause: error });
    }
    const result = new Map<string, PublicMedia>();
    for (const { catalogId, media } of projections) {
      const group = locatorGroup.get(
        JSON.stringify([media.id, media.objectKey]),
      );
      const src = group === undefined ? undefined : urls[group]?.get(media.id);
      if (src === undefined)
        throw new CatalogMediaResolutionError({
          cause: new Error("Article Catalog URL unavailable"),
        });
      const parsed = publicMediaSchema.safeParse({
        id: media.id,
        kind: "image",
        src,
        alt: media.alt,
        width: media.width,
        height: media.height,
      });
      if (!parsed.success)
        throw new CatalogMediaResolutionError({ cause: parsed.error });
      result.set(
        authoredArticleCatalogPairKey(catalogId, media.id),
        parsed.data,
      );
    }
    return result;
  }
}
