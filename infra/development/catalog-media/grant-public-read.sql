-- Post-Community public read phase (unified-media-pipeline-v1, PR 1b):
-- Catalog readers join the published-only delivery view of Catalog
-- renditions. Requires community migration 20261004020000 applied and
-- verified first; an absent view is a hard failure. Do not append these
-- statements to the earlier CMS grant-public-read.sql phase, which runs
-- before the Community family exists.
-- Apply as the setup role with ON_ERROR_STOP in one transaction; in
-- Development use public_read_role=yoyi_dev_public. Never table access,
-- never a write (amendment entry 8).
GRANT USAGE ON SCHEMA community TO :"public_read_role";
GRANT SELECT ON community.catalog_media_delivery TO :"public_read_role";
-- catalog-deep-zoom-v1 (community migration 20261020010000): Catalog readers
-- read the published-blocks view (each image's block frame and the
-- delivery keys of its active master's ready cells; readers check that a
-- set is complete). Requires that
-- migration applied first; nothing else that is new (never the master table).
GRANT SELECT ON community.catalog_media_zoom_blocks TO :"public_read_role";
