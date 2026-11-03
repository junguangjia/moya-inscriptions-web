/** Canonical comment rows survive body deletion and revocable thread removal. Their retained references
 * prove a managed item was submitted even after its live retention pin is released. */
export const commentImageWasCommittedSql = (
  item: string,
  deletedOnly = false,
): string => `(EXISTS(SELECT 1 FROM community.catalog_comments cc WHERE ${deletedOnly ? "cc.body_deleted_at IS NOT NULL AND" : ""} cc.image_refs @> jsonb_build_array(jsonb_build_object('itemId',${item})))
 OR EXISTS(SELECT 1 FROM community.catalog_comment_replies cr JOIN community.catalog_comments cp ON cp.id=cr.root_comment_id WHERE ${deletedOnly ? "cr.body_deleted_at IS NOT NULL AND" : ""} cr.image_refs @> jsonb_build_array(jsonb_build_object('itemId',${item}))))`;
