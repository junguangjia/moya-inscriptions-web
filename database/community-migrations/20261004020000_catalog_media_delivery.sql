-- unified-media-pipeline-v1, increment 1, PR 1b (Owner instruction: unified
-- media pipeline, 2026-10-04): the one read seam for Catalog rendition
-- delivery. Forward-only; it creates one view and changes no data.
--
-- One row per ready rendition, on a committed blob, of a ready Catalog asset
-- that the published Catalog projection named at the media worker's last
-- Catalog sync (unreferenced_since IS NULL; the sync runs every five minutes
-- while the worker runs). Readers join it on (media_id, object_key) to the
-- published projection itself, so a withdrawn image leaves their answers at
-- once; a media id alone is not unique there. object_key is the asset's
-- approved source object key and serves only as that join key. delivery_key
-- is the rendition's opaque id, never a storage key, blob id or store name;
-- the Backend URL resolver maps it to a delivery URL. level is the context
-- class of the rendition: card (thumb, cover), display (the anchor) or zoom
-- (viewer, full). A full rendition appears only within the public resolution
-- bound (Owner decision D3, 2026-10-04): a long edge of at most 8192 px, or
-- for a long scroll (long edge more than 2.5 times the short edge) at most
-- 16000 px and 40 million pixels, measured on the scaled frame with half a
-- pixel of rounding per side: the predicate withinPublicPolicySql in
-- services/community-postgres/src/publishing/rendition-read.ts applies to
-- media items.
--
-- security_barrier keeps a caller's predicates from running before the
-- view's own conditions. Privileges come only from the named grant files
-- (amendment entry 8): the public read role and the App role receive SELECT
-- there. Nothing outside the community family is referenced, so the family
-- stays independently applicable.
CREATE VIEW community.catalog_media_delivery WITH (security_barrier = true) AS
SELECT
  a.media_id,
  a.source_object_key AS object_key,
  r.role,
  r.width,
  r.height,
  r.content_type,
  r.id AS delivery_key,
  CASE
    WHEN r.role IN ('thumb', 'cover') THEN 'card'
    WHEN r.role = 'display' THEN 'display'
    ELSE 'zoom'
  END AS level,
  a.placeholder_color
FROM community.catalog_media_assets a
JOIN community.media_renditions r ON r.catalog_asset_id = a.id
JOIN community.media_blobs b ON b.id = r.blob_id AND b.state = 'committed'
WHERE a.state = 'ready'
  AND a.unreferenced_since IS NULL
  AND r.state = 'ready'
  AND r.edit_key = 'base'
  AND r.role IN ('thumb', 'cover', 'display', 'viewer', 'full')
  AND (
    r.role <> 'full'
    OR GREATEST(r.width, r.height) <= 8192
    OR (
      GREATEST(r.width, r.height) + 0.5 > 2.5 * (LEAST(r.width, r.height) - 0.5)
      AND GREATEST(r.width, r.height) <= 16000
      AND (r.width - 0.5) * (r.height - 0.5) <= 40000000
    )
  );

REVOKE ALL ON community.catalog_media_delivery FROM PUBLIC;
