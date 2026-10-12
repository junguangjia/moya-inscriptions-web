/*
 * Discussion visibility, one definition shared by the discussion read and the
 * content state read. Every fragment takes `$1` target type, `$2` target id
 * and `$3` the reader (null for a guest), over root alias `c` with author `u`
 * and, for replies, reply alias `r` with author `ru`. The same root/reply
 * tables and identity graph serve every kind of discussed content.
 */

/** A root everyone may read: visible, and public before any body deletion. */
export const rootPublic =
  "c.moderation='visible' AND (c.body_deleted_at IS NULL OR c.was_public)";

/** A root this reader may see: public, or their own while active. */
export const rootEligible = `c.thread_removed_at IS NULL AND community.accounts_can_interact($3,c.author_id)
 AND ((${rootPublic}) OR (c.author_id=$3 AND u.status='active'))`;

/** A reply this reader may see under an eligible root. */
export const replyAudience = `community.accounts_can_interact($3,r.author_id)
 AND (((${rootPublic}) AND r.moderation='visible' AND (r.body_deleted_at IS NULL OR r.was_public)) OR (r.author_id=$3 AND ru.status='active'))`;

/** FROM clause of the roots this reader may see on the target. */
export const rootFrom = `FROM community.catalog_comments c JOIN community.public_users u ON u.id=c.author_id
 WHERE c.target_type=$1 AND c.catalog_id=$2 AND ${rootEligible}`;

/**
 * One row `n`: the public, undeleted roots and replies this reader may see on
 * the target (the discussion page's `visibleTotal`, the content state's
 * `commentCount`). Pending and hidden items, removed threads and authors the
 * reader cannot interact with are not counted, nor are the reader's own
 * unpublished items.
 */
export const visibleDiscussionCountSql = `SELECT
  (SELECT count(*) ${rootFrom} AND ${rootPublic} AND c.body_deleted_at IS NULL)
  + (SELECT count(*) FROM community.catalog_comment_replies r
     JOIN community.catalog_comments c ON c.id=r.root_comment_id
     JOIN community.public_users u ON u.id=c.author_id
     JOIN community.public_users ru ON ru.id=r.author_id
     WHERE c.target_type=$1 AND c.catalog_id=$2 AND ${rootEligible}
     AND ${replyAudience} AND ${rootPublic}
     AND r.moderation='visible' AND r.body_deleted_at IS NULL) AS n`;
