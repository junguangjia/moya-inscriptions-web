import { CommunityInputError } from "@moya/api";
import type { MentionReference } from "@moya/contracts";
import { validMentionReferences } from "@moya/contracts/schemas";
import type { PoolClient } from "pg";

export type NotificationSourceKind =
  "work_like" | "comment_like" | "comment" | "work_mention";
/** Must be called on the source mutation's transaction connection. */
export async function enqueueNotification(
  db: PoolClient,
  kind: NotificationSourceKind,
  subject: string,
  actor: string,
): Promise<void> {
  const key = `${kind}:${subject}${kind.endsWith("like") ? `:${actor}` : ""}`;
  await db.query(
    `INSERT INTO community.notification_sources(action_key,kind,subject_id,actor_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(action_key) DO UPDATE SET
    generation=community.notification_sources.generation+1,attempts=0,run_after=CURRENT_TIMESTAMP,error_code=NULL`,
    [key, kind, subject, actor],
  );
}
export async function validateMentionUsers(
  db: PoolClient,
  actor: string,
  text: string,
  refs: readonly MentionReference[],
): Promise<void> {
  if (!validMentionReferences(text, refs))
    throw new CommunityInputError("Invalid mention references");
  if (!refs.length) return;
  const users = await db.query<{ id: string; handle: string }>(
    `SELECT id,handle FROM community.public_users WHERE id=ANY($1::text[]) AND status='active'
      AND community.accounts_can_interact($2,id)`,
    [refs.map((r) => r.userId), actor],
  );
  if (
    users.rows.length !== refs.length ||
    refs.some(
      (r) =>
        !users.rows.some((u) => u.id === r.userId && u.handle === r.handle),
    )
  )
    throw new CommunityInputError("Mention recipient unavailable");
}

/** Current source facts only; never a persisted excerpt or actor snapshot. */
export const sourceFactsSql = `SELECT s.action_key,s.kind,s.actor_id,s.created_at,
  a.handle,a.display_name,t.target_type,t.target_id,
  CASE WHEN s.kind IN ('comment','comment_like') THEN s.subject_id END AS comment_id,
  c.id AS root_id,c.author_id AS root_author,
  CASE WHEN r.id IS NOT NULL THEN COALESCE(rr.author_id,c.author_id) END AS reply_recipient,
  w.author_id AS work_author,
  CASE WHEN s.kind='work_mention' THEN wr.mentions WHEN r.id IS NOT NULL THEN r.mentions ELSE c.mentions END AS mentions,
  CASE WHEN s.kind IN ('work_like','work_mention') THEN w.text WHEN r.id IS NOT NULL THEN r.text ELSE c.text END AS text,
  (a.status='active' AND
    CASE WHEN t.target_type='work' THEN community.work_is_public(w) AND wa.status='active'
      WHEN t.target_type='catalog' THEN cat.catalog_id IS NOT NULL
      WHEN t.target_type='article' THEN art.article_id IS NOT NULL ELSE false END
    AND (w.author_id IS NULL OR community.accounts_can_interact(s.actor_id,w.author_id))
    AND CASE WHEN s.kind IN ('comment','comment_like') THEN
      c.moderation='visible' AND c.body_deleted_at IS NULL AND c.thread_removed_at IS NULL AND ca.status='active'
      AND community.accounts_can_interact(s.actor_id,c.author_id)
      AND (r.id IS NULL OR (r.moderation='visible' AND r.body_deleted_at IS NULL AND ra.status='active'))
      ELSE true END
    AND CASE WHEN s.kind='work_like' THEN EXISTS(SELECT 1 FROM community.content_relations l
      WHERE l.user_id=s.actor_id AND l.content_type='work' AND l.content_id=s.subject_id AND l.relation='like')
      WHEN s.kind='comment_like' THEN EXISTS(SELECT 1 FROM community.comment_likes l WHERE l.comment_id=s.subject_id AND l.user_id=s.actor_id)
      ELSE true END) AS eligible,
  COALESCE(r.author_id,c.author_id) AS comment_author
  FROM community.notification_sources s
  JOIN community.public_users a ON a.id=s.actor_id
  LEFT JOIN community.catalog_comment_replies r ON s.kind IN ('comment','comment_like') AND r.id=s.subject_id
  LEFT JOIN community.catalog_comments c ON s.kind IN ('comment','comment_like') AND c.id=COALESCE(r.root_comment_id,s.subject_id)
  LEFT JOIN community.catalog_comment_replies rr ON rr.id=r.reply_to_reply_id AND rr.root_comment_id=c.id
  LEFT JOIN community.public_users ca ON ca.id=c.author_id
  LEFT JOIN community.public_users ra ON ra.id=r.author_id
  CROSS JOIN LATERAL (SELECT CASE WHEN s.kind IN ('work_like','work_mention') THEN 'work' ELSE c.target_type END AS target_type,
    CASE WHEN s.kind IN ('work_like','work_mention') THEN s.subject_id ELSE c.catalog_id END AS target_id) t
  LEFT JOIN community.works w ON t.target_type='work' AND w.id=t.target_id
  LEFT JOIN community.public_users wa ON wa.id=w.author_id
  LEFT JOIN community.work_revisions wr ON wr.id=w.public_revision_id
  LEFT JOIN public.catalog_discovery cat ON t.target_type='catalog' AND cat.catalog_id=t.target_id
  LEFT JOIN public.article_entries art ON t.target_type='article' AND art.article_id=t.target_id`;
/** Used by both reads and projection. $1 is always the recipient. */
export const recipientEligibleSql = `f.eligible AND u.status='active' AND f.actor_id<>$1
  AND community.accounts_can_interact($1,f.actor_id)
  AND (f.work_author IS NULL OR community.accounts_can_interact($1,f.work_author))
  AND (f.root_author IS NULL OR community.accounts_can_interact($1,f.root_author))`;
