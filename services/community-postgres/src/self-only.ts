/**
 * Self-only works are exactly `visibility='self' AND deleted_at IS NULL`
 * (admin-mcp-completion-v1 section 6). Permanent deletion also sets visibility to
 * self and empties the work, so the second condition keeps reports and appeals on
 * deleted works with AI. Comments and replies under such a work are withheld with
 * it, because the flip to self leaves them untouched. Each reads current state, so
 * a flip is seen by the next statement. Arguments are SQL expressions from this
 * package, never caller text.
 */
export const isSelfOnlyWorkSql = (work: string): string =>
  `(${work}.visibility='self' AND ${work}.deleted_at IS NULL)`;

export const workIsSelfOnlySql = (workId: string): string =>
  `EXISTS(SELECT 1 FROM community.works so_w
    WHERE so_w.id=${workId} AND ${isSelfOnlyWorkSql("so_w")})`;

/** For a comment or a reply: ids are unique across both tables. */
export const commentIsSelfOnlySql = (commentId: string): string =>
  `EXISTS(SELECT 1 FROM community.catalog_comments so_c
    JOIN community.works so_w ON so_w.id=so_c.catalog_id
    WHERE so_c.id=COALESCE(
      (SELECT so_r.root_comment_id FROM community.catalog_comment_replies so_r WHERE so_r.id=${commentId}),
      ${commentId})
    AND so_c.target_type='work' AND ${isSelfOnlyWorkSql("so_w")})`;

/**
 * A case on a self-only work or on a comment under one goes to the Owner. The
 * snapshot's `post` still names the work once a purge has taken the comment's row,
 * and it holds that work's title.
 */
export const reportIsSelfOnlySql = (report: string): string =>
  `((${report}.target_type='work' AND ${workIsSelfOnlySql(`${report}.target_id`)})
    OR (${report}.target_type='comment' AND (${commentIsSelfOnlySql(`${report}.target_id`)}
      OR (${report}.snapshot->'post'->>'type'='work' AND ${workIsSelfOnlySql(`${report}.snapshot->'post'->>'id'`)}))))`;

export const revisionIsSelfOnlySql = (revisionId: string): string =>
  `EXISTS(SELECT 1 FROM community.work_revisions so_rev
    JOIN community.works so_w ON so_w.id=so_rev.work_id
    WHERE so_rev.id=${revisionId} AND ${isSelfOnlyWorkSql("so_w")})`;

/**
 * An author's Article may use an item the same author holds in a self-only work, and
 * its media route opens an item by the Article's reference, so that route asks this.
 */
export const articleUsesSelfOnlyMediaSql = (articleId: string): string =>
  `EXISTS(SELECT 1 FROM community.article_documents so_a
    JOIN community.article_revisions so_ar ON so_ar.article_id=so_a.id AND so_ar.version=so_a.pending_version
    CROSS JOIN LATERAL jsonb_path_query(so_ar.document,'$.references.*.itemId') so_ref(item)
    JOIN community.work_revision_items so_ri ON so_ri.item_id=so_ref.item#>>'{}'
    JOIN community.work_revisions so_rev ON so_rev.id=so_ri.revision_id
    JOIN community.works so_w ON so_w.id=so_rev.work_id
    WHERE so_a.id=${articleId} AND ${isSelfOnlyWorkSql("so_w")})`;
