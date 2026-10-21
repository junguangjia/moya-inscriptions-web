import { withinPublicPolicySql } from "./rendition-read.js";
import { variantEditKeySql } from "./media-read.js";
import { publishedArticleItemSql } from "../article-authoring/published-media.js";

/** Caller-owned SQL aliases only. A removal hold survives a deleted work tombstone. */
export const notHeldSql = (item: string): string =>
  `NOT EXISTS (SELECT 1 FROM community.media_item_holds h WHERE h.item_id=${item} AND h.released_at IS NULL)`;

/**
 * SQL: block rendition alias `r` (a `catalog_master_id`, on a committed blob
 * the caller joined) belongs to its asset's active master, on a committed,
 * held master blob, with the exact cell geometry inside the master's frame:
 * the rule of the published-blocks view `community.catalog_media_zoom_blocks`
 * (migration 20261020010000), spelled on the rendition row so one row is
 * checked by key lookups instead of materializing the view
 * (catalog-deep-zoom-v1).
 */
export const catalogBlockListedSql = (rendition: string): string => {
  const cell = `(CASE WHEN ${rendition}.role ~ '^block-[0-9]{2}$' THEN substring(${rendition}.role FROM 7)::integer END)`;
  const columns = "((zm.frame_width + 1023) / 1024)";
  const rows = "((zm.frame_height + 1023) / 1024)";
  return `EXISTS (
    SELECT 1 FROM community.catalog_display_masters zm
    JOIN community.media_blobs zb ON zb.id=zm.blob_id AND zb.state='committed' AND zb.retention_hold='catalog_master'
    WHERE zm.id=${rendition}.catalog_master_id AND zm.catalog_asset_id=${rendition}.catalog_asset_id
      AND zm.ended_at IS NULL
      AND ${rendition}.content_type='image/jpeg' AND ${rendition}.edit_key='base'
      AND ${cell} < ${columns} * ${rows}
      AND ${rendition}.width = LEAST(1026, zm.frame_width - (${cell} % ${columns}) * 1024)
      AND ${rendition}.height = LEAST(1026, zm.frame_height - (${cell} / ${columns}) * 1024))`;
};

/**
 * One anonymous desired set, recomputed in the transaction that commits public
 * references. No draft/history/profile/tiles eligibility; Catalog blocks only
 * of an asset's active master. Current Catalog projection is deliberately
 * late-bound to keep migration families separate.
 */
export const desiredRenditionsSql = (
  catalogAvailable = true,
  catalogSelector?: string,
): string => `
  SELECT DISTINCT r.id AS rendition_id,r.item_id,r.catalog_asset_id,b.storage_key,
    r.content_type,b.purpose,b.byte_size,b.sha256,r.role,r.edit_key,r.recipe_version
  FROM community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
  LEFT JOIN community.media_items i ON i.id=r.item_id
  LEFT JOIN community.catalog_media_assets ca ON ca.id=r.catalog_asset_id
  WHERE (r.state='ready' OR (${catalogSelector ? `r.catalog_asset_id IS NOT NULL AND (${catalogSelector}) AND r.state IN ('released','superseded')` : "FALSE"})) AND b.purpose IN ('derivative','catalog_derivative')
    AND r.content_type IN ('image/webp','image/jpeg','video/mp4') AND b.content_type=r.content_type
    AND ${withinPublicPolicySql("r")}
    AND (
      (i.state='ready' AND i.cancelled_at IS NULL AND i.purged_at IS NULL AND ${notHeldSql("i.id")} AND (
        EXISTS (
          SELECT 1 FROM community.work_revision_items ri
          JOIN community.work_revisions rv ON rv.id=ri.revision_id
          JOIN community.works w ON w.id=rv.work_id AND w.public_revision_id=rv.id
          JOIN community.public_users au ON au.id=w.author_id AND au.status='active'
          WHERE ri.item_id=i.id AND i.owner_id=w.author_id AND community.work_is_public(w)
            AND r.role IN ('thumb','cover','display','viewer','full','motion')
            AND r.edit_key=${variantEditKeySql("r.role", "ri", "rv")}
        ) OR (r.edit_key='base' AND r.role IN ('thumb','cover','display','viewer','full','motion')
          AND ${publishedArticleItemSql("i.id", "NULL::text", "i.owner_id")})
      ))
      OR (ca.state='ready' AND ${catalogSelector ? "TRUE" : "ca.unreferenced_since IS NULL"} AND r.edit_key='base'
        AND (r.role IN ('thumb','cover','display','viewer','full')
          OR (r.catalog_master_id IS NOT NULL AND ${catalogBlockListedSql("r")}))
        AND ${
          catalogSelector ??
          (catalogAvailable
            ? `EXISTS (SELECT 1 FROM public.catalog_media cm
          WHERE cm.media_id=ca.media_id AND cm.object_key=ca.source_object_key)`
            : "FALSE")
        })
    )`;
