-- content-community-completion-v1 (track C): published editorial Articles
-- become a third discussion target kind. The physical names
-- community.catalog_comments / catalog_comment_replies / catalog_id are kept:
-- catalog_id holds the target identity of whichever kind target_type names
-- (a CatalogId, a work-<32hex> id or an article-<32hex> id). The CHECK only
-- proves a valid kind; target existence and visibility are verified by the
-- Backend on every read and mutation.
ALTER TABLE community.catalog_comments DROP CONSTRAINT catalog_comments_target_type_check;
ALTER TABLE community.catalog_comments
  ADD CONSTRAINT catalog_comments_target_type_check CHECK (target_type IN ('catalog','work','article'));
COMMENT ON COLUMN community.catalog_comments.catalog_id IS
  'Discussion target identity for target_type: CatalogId, work id or article id (legacy column name retained).';
