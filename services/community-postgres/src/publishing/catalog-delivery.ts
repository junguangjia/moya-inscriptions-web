import type {
  CatalogMediaRenditionProjection,
  PublishingMediaReadTarget,
} from "@moya/api";
import type { Pool } from "pg";

import { asCommunityOperationError } from "../availability.js";
import { CommunitySchemaNotReadyError } from "../migrations/runner.js";
import { readTransaction } from "./db.js";
import { mediaReadTarget } from "./media-read.js";
import type { MediaReadTargetRow } from "./media-read.js";

/*
 * Catalog rendition delivery on the community side (unified media pipeline,
 * PR 1b). The published-only view community.catalog_media_delivery
 * (migration 20261004020000) lists the ready renditions of ready, referenced
 * Catalog assets by opaque delivery key (the rendition id). Discovery cards
 * join it exactly like the Catalog readers of @moya/catalog-postgres, and the
 * Development delivery route streams only a rendition it lists.
 */

/**
 * SQL: `LEFT JOIN LATERAL` one row with the delivery facts of the published
 * media row alias `media` (it names `media_id` and `object_key`) as
 * `<alias>.renditions` (a jsonb array ascending by size, recipe order within
 * one size, or null) and `<alias>.placeholder_color`.
 */
export const catalogMediaDeliveryJoinSql = (
  media: string,
  alias = "delivery",
): string => `
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'key', d.delivery_key, 'width', d.width, 'height', d.height,
             'contentType', d.content_type, 'level', d.level)
           ORDER BY d.width, d.height,
             array_position(ARRAY['thumb','cover','display','viewer','full'], d.role)
           ) AS renditions,
           min(d.placeholder_color) AS placeholder_color
    FROM community.catalog_media_delivery d
    WHERE d.media_id = ${media}.media_id AND d.object_key = ${media}.object_key
  ) ${alias} ON TRUE`;

const RENDITION_ID = /^media-rendition-[0-9a-f]{32}$/u;
const PLACEHOLDER_COLOR = /^#[0-9a-f]{6}$/u;
const LEVELS: ReadonlySet<unknown> = new Set(["card", "display", "zoom"]);
const CONTENT_TYPES: ReadonlySet<unknown> = new Set([
  "image/webp",
  "image/jpeg",
]);

const side = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= 65_535;

/**
 * The card record fields of the joined delivery facts: well-formed
 * renditions only (an opaque key, a size, a delivered type and a level) and
 * a valid colour; nothing when the row has none.
 */
export const mapCatalogMediaDelivery = (
  renditions: unknown,
  placeholderColor: unknown,
): {
  readonly renditions?: readonly CatalogMediaRenditionProjection[];
  readonly placeholderColor?: string;
} => {
  const entries = (Array.isArray(renditions) ? renditions : []).flatMap(
    (value: unknown): CatalogMediaRenditionProjection[] => {
      if (typeof value !== "object" || value === null) return [];
      const entry = value as Record<string, unknown>;
      return typeof entry.key === "string" &&
        RENDITION_ID.test(entry.key) &&
        side(entry.width) &&
        side(entry.height) &&
        CONTENT_TYPES.has(entry.contentType) &&
        LEVELS.has(entry.level)
        ? [
            {
              key: entry.key,
              width: entry.width,
              height: entry.height,
              contentType:
                entry.contentType as CatalogMediaRenditionProjection["contentType"],
              level: entry.level as CatalogMediaRenditionProjection["level"],
            },
          ]
        : [];
    },
  );
  if (Array.isArray(renditions) && entries.length !== renditions.length)
    console.warn("[catalog-media] rendition_fallback");
  return {
    ...(entries.length === 0 ? {} : { renditions: entries }),
    ...(typeof placeholderColor === "string" &&
    PLACEHOLDER_COLOR.test(placeholderColor)
      ? { placeholderColor }
      : {}),
  };
};

/**
 * The committed blob of a rendition the delivery view lists (ready, of a
 * ready Catalog asset within the public resolution bound), or null for any
 * other id. The separate Catalog read identity checks the current published
 * projection before bytes are served; withdrawal does not wait for worker
 * sync. Only the Development delivery route reads Catalog rendition bytes.
 */
export const resolveCatalogRenditionRead = async (
  pool: Pool,
  renditionId: string,
  catalogPool: Pool,
): Promise<PublishingMediaReadTarget | null> => {
  if (!RENDITION_ID.test(renditionId)) return null;
  return readTransaction(pool, async (db) => {
    const row = (
      await db.query<
        MediaReadTargetRow & { media_id: string; object_key: string }
      >(
        `SELECT b.storage_key,d.content_type,b.byte_size,b.sha256,d.media_id,d.object_key
           FROM community.catalog_media_delivery d
           JOIN community.media_renditions r ON r.id=d.delivery_key
           JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
           WHERE d.delivery_key=$1`,
        [renditionId],
      )
    ).rows[0];
    if (row === undefined) return null;
    const published = await catalogPool.query(
      "SELECT 1 FROM catalog_media WHERE media_id=$1 AND object_key=$2 LIMIT 1",
      [row.media_id, row.object_key],
    );
    return published.rows.length === 0 ? null : mediaReadTarget(row);
  });
};

const unreadableCodes: ReadonlySet<unknown> = new Set([
  "42P01",
  "3F000",
  "42501",
]);

/**
 * Read-only startup check with the App role: discovery cards join the
 * delivery view in every runtime (`grant-runtime.sql` grants it), so a
 * missing view or grant stops startup instead of failing discovery reads.
 */
export const verifyCatalogDeliveryReadable = async (
  pool: Pool,
): Promise<void> => {
  try {
    await pool.query("SELECT 1 FROM community.catalog_media_delivery LIMIT 0");
  } catch (error) {
    if (
      unreadableCodes.has((error as { readonly code?: unknown } | null)?.code)
    )
      throw new CommunitySchemaNotReadyError({ cause: error });
    throw asCommunityOperationError(error, "query");
  }
};
