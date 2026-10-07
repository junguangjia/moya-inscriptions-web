import { CatalogMediaResolutionError, mapCatalogPublicMedia } from "@moya/api";
import type {
  CatalogRenditionUrls,
  StorageUrlResolver,
  StorageMediaLocator,
} from "@moya/api";
import type {
  ArticleMediaReference,
  MediaId,
  PublicMedia,
} from "@moya/contracts";
import type { Pool } from "pg";
import { asPostgresOperationError } from "./availability.js";
import { catalogMediaDeliveryJoinSql } from "./catalog-media-delivery.js";
import type { CatalogReaderOptions } from "./catalog-media-delivery.js";
import { mapCatalogMediaRow } from "./row-mapper.js";
import type { CatalogMediaRow } from "./row-mapper.js";

type Pair = Omit<Extract<ArticleMediaReference, { type: "catalog" }>, "type">;
export const authoredArticleCatalogPairKey = (
  catalogId: string,
  mediaId: string,
): string => JSON.stringify([catalogId, mediaId]);

const pairSql = (renditions: boolean) => `
        SELECT cm.media_id,cm.catalog_id,cm.position,cm.is_representative,cm.kind,
          cm.alt_text,cm.width,cm.height,cm.object_key${renditions ? ",delivery.renditions,delivery.placeholder_color" : ""}
        FROM jsonb_to_recordset($1::jsonb) AS pair("catalogId" text,"mediaId" text)
        JOIN public.catalog_entries ce ON ce.catalog_id=pair."catalogId"
        JOIN public.catalog_media cm ON cm.catalog_id=ce.catalog_id AND cm.media_id=pair."mediaId"${renditions ? catalogMediaDeliveryJoinSql("cm") : ""}
        ORDER BY cm.catalog_id,cm.media_id`;

/**
 * Exact published Catalog pairs; shares the existing object-key URL boundary.
 * References answer in the detail context; with `renditions` they carry
 * every candidate the URL resolver delivers (a summary narrows its cover).
 */
export class PostgresAuthoredArticleCatalogMediaResolver {
  private readonly sql: string;

  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageUrlResolver,
    options: CatalogReaderOptions = {},
  ) {
    this.sql = pairSql(options.renditions === true);
  }
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
        await db.query<CatalogMediaRow>(this.sql, [
          JSON.stringify([...wanted.values()]),
        ])
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
    // The detail context lists every delivered level of each image.
    const renditionKeys = [
      ...new Set(
        projections.flatMap(({ media }) =>
          (media.renditions ?? []).map(({ key }) => key),
        ),
      ),
    ];
    const urls: ReadonlyMap<MediaId, string>[] = [];
    let renditionUrls: CatalogRenditionUrls = new Map();
    try {
      for (const group of groups)
        urls.push(await this.storage.resolveMany(group));
      if (renditionKeys.length > 0 && this.storage.resolveKeys !== undefined)
        renditionUrls = await this.storage.resolveKeys(renditionKeys);
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
      const resolved = group === undefined ? undefined : urls[group];
      if (resolved === undefined || resolved.get(media.id) === undefined)
        throw new CatalogMediaResolutionError({
          cause: new Error("Article Catalog URL unavailable"),
        });
      result.set(
        authoredArticleCatalogPairKey(catalogId, media.id),
        mapCatalogPublicMedia(media, resolved, renditionUrls, "detail"),
      );
    }
    return result;
  }
}
