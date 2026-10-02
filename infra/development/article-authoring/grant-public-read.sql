-- PRIVATE proposal: explicit Development-only post-community-migration phase.
-- Requires Article migration 20260930020000 applied and verified first.
-- Do not append these statements to the earlier CMS grant-public-read.sql phase.
-- Use the task's verified setup role and public_read_role=yoyi_dev_public.
-- Run with ON_ERROR_STOP and one transaction; absent view is a hard failure.
GRANT USAGE ON SCHEMA community TO :"public_read_role";
GRANT SELECT ON community.published_authored_articles TO :"public_read_role";
