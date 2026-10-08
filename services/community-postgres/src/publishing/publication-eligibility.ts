import { withinPublicPolicySql } from "./rendition-read.js";
import { variantEditKeySql } from "./media-read.js";
import { publishedArticleItemSql } from "../article-authoring/published-media.js";

/** Caller-owned SQL aliases only. A removal hold survives a deleted work tombstone. */
export const notHeldSql = (item: string): string =>
  `NOT EXISTS (SELECT 1 FROM community.media_item_holds h WHERE h.item_id=${item} AND h.released_at IS NULL)`;

/**
 * One anonymous desired set, recomputed in the transaction that commits public
 * references. No draft/history/profile/tiles eligibility. Current Catalog
 * projection is deliberately late-bound to keep migration families separate.
 */
export const desiredRenditionsSql = (catalogAvailable = true): string => `
  SELECT DISTINCT r.id AS rendition_id,r.item_id,r.catalog_asset_id,b.storage_key,
    r.content_type,b.purpose,b.byte_size,b.sha256,r.role,r.edit_key,r.recipe_version
  FROM community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
  LEFT JOIN community.media_items i ON i.id=r.item_id
  LEFT JOIN community.catalog_media_assets ca ON ca.id=r.catalog_asset_id
  WHERE r.state='ready' AND b.purpose IN ('derivative','catalog_derivative')
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
        ) OR (r.edit_key='base' AND r.role IN ('thumb','cover','display','viewer','motion')
          AND ${publishedArticleItemSql("i.id", "NULL::text", "i.owner_id")})
      ))
      OR (ca.state='ready' AND ca.unreferenced_since IS NULL AND r.edit_key='base'
        AND r.role IN ('thumb','cover','display','viewer','full')
        AND ${
          catalogAvailable
            ? `EXISTS (SELECT 1 FROM public.catalog_media cm
          WHERE cm.media_id=ca.media_id AND cm.object_key=ca.source_object_key)`
            : "FALSE"
        })
    )`;
