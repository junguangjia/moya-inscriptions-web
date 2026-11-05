const WORK_TEXT_HOLDERS = [
  "work_revisions",
  "work_drafts",
  "work_draft_snapshots",
  "work_edit_drafts",
] as const;

const workRowHoldsContentSql = (work: string): string =>
  `${work}.title<>'' OR ${work}.text<>'' OR cardinality(${work}.media_ids)>0
    OR ${work}.public_revision_id IS NOT NULL OR ${work}.author_revision_id IS NOT NULL`;

/**
 * A deleted work still holds content an erasure removes. A trash purge marks a work
 * deleted but keeps its title, text, media list and revisions, an older delete did the
 * same with no `trashed_at`, and an erased work keeps none of them. The row's own
 * columns come first, so a row that holds its text reads no other table.
 */
export const deletedWorkHoldsContentSql = (work: string): string =>
  `(${workRowHoldsContentSql(work)}
    ${WORK_TEXT_HOLDERS.map((table) => `OR EXISTS(SELECT 1 FROM community.${table} hc WHERE hc.work_id=${work}.id)`).join(" ")})`;

const selfOnlyWorkSql = (work: string, deletedHoldsContent: string): string =>
  `((${work}.visibility='self' AND ${work}.deleted_at IS NULL) OR (${work}.deleted_at IS NOT NULL AND ${deletedHoldsContent}))`;

/**
 * What AI does not read (admin-mcp-completion-v1 section 6): a live work with
 * `visibility='self'`, and a deleted work that still holds content. Erasing a work also
 * sets visibility to self, but it empties the row and takes what held its text, so
 * reports and appeals on it stay with AI. Whatever else deleted a work leaves its text
 * there, whatever its visibility was. Comments and replies under such a work are
 * withheld with it, because the flip to self leaves them untouched. Each reads current
 * state, so a flip is seen by the next statement. Arguments are SQL expressions from
 * this package, never caller text.
 */
export const isSelfOnlyWorkSql = (work: string): string =>
  selfOnlyWorkSql(work, deletedWorkHoldsContentSql(work));

/**
 * The same condition for a statement that goes over the whole table. The lookups above
 * are priced into every row, deleted or not, so a large table would pay for them in
 * planning and compiling alone. These sets cost one read each, of a statement that
 * reaches an emptied row. Two of the tables have no index on `work_id` to look up by.
 */
export const isSelfOnlyWorkInScanSql = (work: string): string =>
  selfOnlyWorkSql(
    work,
    `(${workRowHoldsContentSql(work)}
    ${WORK_TEXT_HOLDERS.map((table) => `OR ${work}.id IN (SELECT hc.work_id FROM community.${table} hc WHERE hc.work_id IS NOT NULL)`).join(" ")})`,
  );

export const workIsSelfOnlySql = (workId: string): string =>
  `EXISTS(SELECT 1 FROM community.works so_w
    WHERE so_w.id=${workId} AND ${isSelfOnlyWorkSql("so_w")})`;

/**
 * The same condition for a scan: one hashed set read once in the statement, where the
 * lookup above runs once per row. For a value that is never NULL.
 */
export const workInSelfOnlySetSql = (workId: string): string =>
  `${workId} IN (SELECT so_w.id FROM community.works so_w WHERE ${isSelfOnlyWorkInScanSql("so_w")})`;

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

/** The same question for a case named by its id. Its alias is apart from the ones above. */
export const caseIsSelfOnlySql = (reportId: string): string =>
  `EXISTS(SELECT 1 FROM community.report_cases so_case
    WHERE so_case.id=${reportId} AND ${reportIsSelfOnlySql("so_case")})`;

/**
 * A job can name the work itself, as a trash purge does, and retrying it runs on that
 * work. A job on a media item is no write on the item's work, and its subject matches
 * no row here.
 */
export const jobSubjectIsSelfOnlySql = (jobId: string): string =>
  `EXISTS(SELECT 1 FROM community.publishing_jobs so_j
    JOIN community.works so_w ON so_w.id=so_j.subject_id
    WHERE so_j.id=${jobId} AND ${isSelfOnlyWorkSql("so_w")})`;

/**
 * A person's own request about their personal information, as far as columns can say:
 * a `privacy` report on the reporter's own profile. Section 12 says what this misses.
 */
export const reportAsksOfOwnProfileSql = (report: string): string =>
  `(${report}.reason='privacy' AND ${report}.target_type='user' AND ${report}.target_id=${report}.reporter_id)`;

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
