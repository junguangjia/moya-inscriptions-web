import type {
  CatalogMediaProjection,
  CatalogMediaRenditionProjection,
} from "@moya/api";

/*
 * Catalog rendition delivery facts (unified media pipeline, PR 1b). The
 * community view `community.catalog_media_delivery` (migration
 * 20261004020000) lists the ready renditions of the ready, referenced Catalog
 * asset of a published media row, by opaque delivery key, with the asset's
 * placeholder colour. Readers join it for one media row alias only where the
 * community schema and the view's read grant exist; every other reader
 * (legacy-only and CMS-only databases, the Pilot) keeps its SQL unchanged.
 */

/** Composition options of the published Catalog readers. */
export interface CatalogReaderOptions {
  /**
   * Join the Catalog rendition delivery view. Requires the community schema
   * and SELECT on the view for the reading role (the post-Community public
   * read grant).
   */
  readonly renditions?: boolean;
}

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

const DELIVERY_KEY = /^media-rendition-[0-9a-f]{32}$/u;
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

const rendition = (value: unknown): CatalogMediaRenditionProjection | null => {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.key === "string" &&
    DELIVERY_KEY.test(entry.key) &&
    side(entry.width) &&
    side(entry.height) &&
    CONTENT_TYPES.has(entry.contentType) &&
    LEVELS.has(entry.level)
    ? {
        key: entry.key,
        width: entry.width,
        height: entry.height,
        contentType:
          entry.contentType as CatalogMediaRenditionProjection["contentType"],
        level: entry.level as CatalogMediaRenditionProjection["level"],
      }
    : null;
};

/**
 * The projection fields of the joined delivery facts: well-formed renditions
 * only (an opaque key, a size, a delivered type and a level) and a valid
 * colour; nothing when the row has none.
 */
export const mapCatalogMediaDelivery = (
  renditions: unknown,
  placeholderColor: unknown,
): Pick<CatalogMediaProjection, "renditions" | "placeholderColor"> => {
  const entries = (Array.isArray(renditions) ? renditions : []).flatMap(
    (value) => {
      const entry = rendition(value);
      return entry === null ? [] : [entry];
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
