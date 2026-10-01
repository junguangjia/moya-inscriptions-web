import {
  enqueueNotification,
  validateMentionUsers,
} from "./notifications/source.js";
import { normalizeMentionText } from "@moya/contracts/schemas";
import type { MentionReference } from "@moya/contracts";
import { asCommunityOperationError } from "./availability.js";
import { createHash, randomUUID } from "node:crypto";
import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import {
  discussionCommentSchema,
  discussionReplySchema,
  ownCommentSchema,
} from "@moya/contracts/schemas";
import type { DiscussionPort, DiscussionQuery } from "@moya/api";
import type {
  DiscussionTarget as ContentIdentity,
  DiscussionComment,
  DiscussionReply,
} from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const deletedText = "This comment has been deleted";
const pageMeta = (total: number, q: DiscussionQuery) => ({
  total,
  page: q.page,
  pageSize: q.pageSize,
  totalPages: Math.ceil(total / q.pageSize),
});
/** The same root/reply tables and identity graph serve both kinds of content. */
const rootPublic =
  "c.moderation='visible' AND (c.body_deleted_at IS NULL OR c.was_public)";
const rootEligible = `c.thread_removed_at IS NULL AND community.accounts_can_interact($3,c.author_id)
 AND ((${rootPublic}) OR (c.author_id=$3 AND u.status='active'))`;
const replyAudience = `community.accounts_can_interact($3,r.author_id)
 AND (((${rootPublic}) AND r.moderation='visible' AND (r.body_deleted_at IS NULL OR r.was_public)) OR (r.author_id=$3 AND ru.status='active'))`;
const rootFrom = `FROM community.catalog_comments c JOIN community.public_users u ON u.id=c.author_id
 WHERE c.target_type=$1 AND c.catalog_id=$2 AND ${rootEligible}`;
/** Effective work visibility for `$2`; reads also admit the author's own hidden-from-others work. */
const workVisible = (lock: boolean) =>
  `u.status='active' AND community.accounts_can_interact($2,w.author_id)
 AND (community.work_is_public(w)${lock ? "" : " OR (w.author_id=$2 AND w.deleted_at IS NULL AND w.trashed_at IS NULL AND w.operator_state='visible')"})`;
const likeCount = (
  alias: string,
) => `(SELECT count(*)::integer FROM community.comment_likes l JOIN community.public_users lu ON lu.id=l.user_id
 WHERE l.comment_id=${alias}.id AND lu.status='active' AND community.accounts_can_interact(l.user_id,${alias}.author_id))`;
const rootProjection = `c.id,c.author_id,u.display_name,c.text,c.created_at,c.body_deleted_at,
 CASE WHEN ${rootPublic} AND c.body_deleted_at IS NULL THEN ${likeCount("c")} ELSE 0 END AS like_count,
 EXISTS(SELECT 1 FROM community.comment_likes WHERE comment_id=c.id AND user_id=$3) AS liked`;
const replyFromFor = (roots: string) =>
  `FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id
 JOIN community.public_users u ON u.id=c.author_id JOIN community.public_users ru ON ru.id=r.author_id
 WHERE c.target_type=$1 AND c.catalog_id=$2 AND ${rootEligible} AND ${roots} AND ${replyAudience}`;
const replyFrom = replyFromFor("r.root_comment_id=$4");
/** The same audience rules over every root of a page (`$4` text[]). */
const groupedReplyFrom = replyFromFor("r.root_comment_id=ANY($4::text[])");
const replyVisible = `${rootPublic} AND r.moderation='visible' AND r.body_deleted_at IS NULL`;
const replyProjection = `r.id,r.author_id,ru.display_name,r.text,r.created_at,r.body_deleted_at,
 CASE WHEN ${rootPublic} AND r.moderation='visible' AND r.body_deleted_at IS NULL THEN ${likeCount("r")} ELSE 0 END AS like_count,
 EXISTS(SELECT 1 FROM community.comment_likes WHERE comment_id=r.id AND user_id=$3) AS liked,
 (SELECT json_build_object('id',tu.id,'displayName',tu.display_name) FROM community.catalog_comment_replies tr
 JOIN community.public_users tu ON tu.id=tr.author_id WHERE tr.id=r.reply_to_reply_id
 AND community.accounts_can_interact($3,tu.id) AND (tr.moderation='visible' OR (tr.author_id=$3 AND tu.status='active'))) AS reply_to`;
interface ItemRow extends QueryResultRow {
  id: string;
  author_id: string;
  display_name: string;
  text: string;
  created_at: Date;
  body_deleted_at: Date | null;
  like_count: number;
  liked: boolean;
  reply_to?: unknown;
}
const item = (r: ItemRow): DiscussionReply =>
  discussionReplySchema.parse({
    id: r.id,
    author: { id: r.author_id, displayName: r.display_name },
    text: r.body_deleted_at ? deletedText : r.text,
    createdAt: r.created_at.toISOString(),
    deleted: r.body_deleted_at !== null,
    likeCount: r.like_count,
    liked: r.body_deleted_at === null && r.like_count > 0 && r.liked,
    ...(r.reply_to ? { replyTo: r.reply_to } : {}),
  });

/** Shared persistence extension of the existing community comment adapter. */
export class PostgresDiscussionStore implements DiscussionPort {
  constructor(protected readonly pool: Pool) {}
  private async run<T>(
    write: boolean,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }
  /**
   * Work discussions follow effective work visibility (community.work_is_public
   * with an active, unblocked author). Reads (`lock` false) also admit the
   * work's author on their own self-only or pending work outside the recycle
   * bin that no operator hid or removed; writes and likes
   * (`lock` true) never happen on a work others cannot see. Comment rows are
   * never rewritten by visibility changes.
   */
  private async workAllowed(
    db: PoolClient,
    target: ContentIdentity,
    viewer: string | null,
    lock = false,
  ): Promise<void> {
    if (target.type !== "work") return;
    const r = await db.query(
      `SELECT w.id FROM community.works w JOIN community.public_users u ON u.id=w.author_id WHERE w.id=$1 AND ${workVisible(lock)}${lock ? " FOR SHARE OF w" : ""}`,
      [target.id, viewer],
    );
    if (r.rowCount !== 1) throw new CommunityNotFoundError();
  }
  /** The read-side `workAllowed` answer for every distinct work id in one statement. */
  private async allowedWorks(
    db: PoolClient,
    ids: readonly string[],
    viewer: string | null,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const r = await db.query<{ id: string }>(
      `SELECT w.id FROM community.works w JOIN community.public_users u ON u.id=w.author_id WHERE w.id=ANY($1::text[]) AND ${workVisible(false)}`,
      [[...new Set(ids)], viewer],
    );
    return new Set(r.rows.map((row) => row.id));
  }
  /**
   * The embedded first page of replies and both reply totals for every root
   * of a listing: two grouped statements instead of three per root, under the
   * same audience rules (`groupedReplyFrom`) and the same reply order.
   */
  private async replyGroups(
    db: PoolClient,
    target: ContentIdentity,
    roots: readonly string[],
    viewer: string | null,
    pageSize: number,
  ): Promise<
    Map<
      string,
      { items: DiscussionReply[]; total: number; visibleTotal: number }
    >
  > {
    const groups = new Map<
      string,
      { items: DiscussionReply[]; total: number; visibleTotal: number }
    >();
    if (roots.length === 0) return groups;
    const args = [target.type, target.id, viewer, [...roots]];
    const group = (root: string) => {
      let g = groups.get(root);
      if (!g) {
        g = { items: [], total: 0, visibleTotal: 0 };
        groups.set(root, g);
      }
      return g;
    };
    const totals = await db.query<{
      root_id: string;
      total: string;
      visible_total: string;
    }>(
      `SELECT r.root_comment_id AS root_id,count(*) AS total,count(*) FILTER (WHERE ${replyVisible}) AS visible_total ${groupedReplyFrom} GROUP BY r.root_comment_id`,
      args,
    );
    for (const row of totals.rows) {
      const g = group(row.root_id);
      g.total = Number(row.total);
      g.visibleTotal = Number(row.visible_total);
    }
    const rows = await db.query<ItemRow & { root_id: string }>(
      `SELECT * FROM (SELECT ${replyProjection},r.root_comment_id AS root_id,row_number() OVER (PARTITION BY r.root_comment_id ORDER BY r.created_at,r.id) AS position ${groupedReplyFrom}) x
   WHERE position<=$5 ORDER BY root_id,created_at,id`,
      [...args, pageSize],
    );
    for (const row of rows.rows) group(row.root_id).items.push(item(row));
    return groups;
  }
  private async interactionLocks(
    db: PoolClient,
    target: ContentIdentity,
    actor: string,
    root?: string,
    reply?: string,
  ): Promise<void> {
    const people = (
      await db.query<{ id: string }>(
        `SELECT author_id AS id FROM community.works WHERE $1='work' AND id=$2
   UNION SELECT author_id FROM community.catalog_comments WHERE id=$3
   UNION SELECT author_id FROM community.catalog_comment_replies WHERE id=$4`,
        [target.type, target.id, root ?? null, reply ?? null],
      )
    ).rows.map((r) => r.id);
    for (const other of [...new Set(people)].sort()) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        [actor, other].sort().join(":"),
      ]);
      if (
        !(
          await db.query(
            "SELECT community.accounts_can_interact($1,$2) AS allowed",
            [actor, other],
          )
        ).rows[0]?.allowed
      )
        throw new CommunityNotFoundError();
    }
  }
  private async active(db: PoolClient, actor: string): Promise<void> {
    if (
      (
        await db.query(
          "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
          [actor],
        )
      ).rowCount !== 1
    )
      throw new CommunityNotFoundError();
  }
  private async receipt<T>(
    db: PoolClient,
    actor: string,
    request: string,
    command: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
      `${actor}:${request}`,
    ]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const old = (
      await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM community.discussion_command_receipts WHERE actor_label=$1 AND request_id=$2",
        [actor, request],
      )
    ).rows[0];
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new CommunityConflictError("Request identity was reused");
      return old.result;
    }
    const result = await fn();
    // Columns are named so the row keeps its default created_at (migration
    // 20260916011000) and a later column never shifts this positional insert.
    await db.query(
      "INSERT INTO community.discussion_command_receipts(actor_label,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)",
      [actor, request, fingerprint, JSON.stringify(result ?? null)],
    );
    return result;
  }
  private async authorAudit(
    db: PoolClient,
    actor: string,
    action: string,
    subject: string,
  ): Promise<void> {
    await db.query(
      "INSERT INTO community.author_events(id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)",
      [opaque("author-event"), actor, action, subject],
    );
  }
  private async root(
    db: PoolClient,
    target: ContentIdentity,
    id: string,
    viewer: string | null,
    lock = false,
  ): Promise<void> {
    await this.workAllowed(db, target, viewer, lock);
    if (
      (
        await db.query(
          `SELECT c.id ${rootFrom} AND c.id=$4${lock ? " FOR UPDATE OF c" : ""}`,
          [target.type, target.id, viewer, id],
        )
      ).rowCount !== 1
    )
      throw new CommunityNotFoundError();
  }
  private async replyPage(
    db: PoolClient,
    target: ContentIdentity,
    root: string,
    viewer: string | null,
    q: DiscussionQuery,
  ) {
    const args = [target.type, target.id, viewer, root];
    const total = Number(
      (await db.query(`SELECT count(*) AS n ${replyFrom}`, args)).rows[0]?.n ??
        0,
    );
    const rows = (
      await db.query<ItemRow>(
        `SELECT ${replyProjection} ${replyFrom} ORDER BY r.created_at,r.id LIMIT $5 OFFSET $6`,
        [...args, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    const visibleTotal = Number(
      (
        await db.query(
          `SELECT count(*) AS n ${replyFrom} AND ${replyVisible}`,
          args,
        )
      ).rows[0]?.n ?? 0,
    );
    return { items: rows.map(item), ...pageMeta(total, q), visibleTotal };
  }
  private async hotIds(
    db: PoolClient,
    target: ContentIdentity,
    viewer: string | null,
    q: DiscussionQuery,
  ): Promise<string[]> {
    if (q.pinned !== undefined) return [...q.pinned];
    const rows = await db.query<{ id: string }>(
      `SELECT c.id,${likeCount("c")} AS score ${rootFrom}
   AND ${rootPublic} AND c.body_deleted_at IS NULL AND ${likeCount("c")}>0 ORDER BY score DESC,c.created_at DESC,c.id DESC LIMIT 3`,
      [target.type, target.id, viewer],
    );
    return rows.rows.map((r) => r.id);
  }
  async readDiscussion(
    target: ContentIdentity,
    viewer: string | null,
    q: DiscussionQuery,
  ) {
    return this.run(false, async (db) => {
      await this.workAllowed(db, target, viewer);
      const pinned = await this.hotIds(db, target, viewer, q),
        args = [target.type, target.id, viewer, pinned];
      const hot =
        q.pinned === undefined
          ? (
              await db.query<ItemRow>(
                `SELECT ${rootProjection} ${rootFrom} AND c.id=ANY($4::text[]) ORDER BY array_position($4::text[],c.id)`,
                args,
              )
            ).rows
          : [];
      const total = Number(
        (
          await db.query(
            `SELECT count(*) AS n ${rootFrom} AND c.id<>ALL($4::text[])`,
            args,
          )
        ).rows[0]?.n ?? 0,
      );
      const latest = (
        await db.query<ItemRow>(
          `SELECT ${rootProjection} ${rootFrom} AND c.id<>ALL($4::text[]) ORDER BY c.created_at DESC,c.id DESC LIMIT $5 OFFSET $6`,
          [...args, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      const replies = await this.replyGroups(
        db,
        target,
        [...hot, ...latest].map((r) => r.id),
        viewer,
        3,
      );
      const attach = (r: ItemRow): DiscussionComment => {
        const group = replies.get(r.id);
        return discussionCommentSchema.parse({
          ...item(r),
          target,
          replies: group?.items ?? [],
          replyTotal: group?.visibleTotal ?? 0,
          replyPageTotal: group?.total ?? 0,
        });
      };
      const hotItems = hot.map(attach),
        items = latest.map(attach);
      const visibleTotal = Number(
        (
          await db.query(
            `SELECT
              (SELECT count(*) ${rootFrom} AND ${rootPublic} AND c.body_deleted_at IS NULL)
              + (SELECT count(*) FROM community.catalog_comment_replies r
                 JOIN community.catalog_comments c ON c.id=r.root_comment_id
                 JOIN community.public_users u ON u.id=c.author_id
                 JOIN community.public_users ru ON ru.id=r.author_id
                 WHERE c.target_type=$1 AND c.catalog_id=$2 AND ${rootEligible}
                 AND ${replyAudience} AND ${rootPublic}
                 AND r.moderation='visible' AND r.body_deleted_at IS NULL) AS n`,
            [target.type, target.id, viewer],
          )
        ).rows[0]?.n ?? 0,
      );
      return { hot: hotItems, items, ...pageMeta(total, q), visibleTotal };
    });
  }
  async readDiscussionReplies(
    target: ContentIdentity,
    rootId: string,
    viewer: string | null,
    q: DiscussionQuery,
  ) {
    return this.run(false, async (db) => {
      await this.root(db, target, rootId, viewer);
      return this.replyPage(db, target, rootId, viewer, q);
    });
  }
  async submitDiscussion(
    target: ContentIdentity,
    actor: string,
    text: string,
    rootId?: string,
    replyTo?: string,
    mentions: readonly MentionReference[] = [],
  ) {
    text = normalizeMentionText(text);
    return this.run(true, async (db) => {
      await validateMentionUsers(db, actor, text, mentions);
      await this.active(db, actor);
      await this.interactionLocks(db, target, actor, rootId, replyTo);
      await this.workAllowed(db, target, actor, true);
      if (rootId) {
        await this.root(db, target, rootId, actor, true);
        if (
          replyTo &&
          (
            await db.query(
              `SELECT r.id ${replyFrom} AND r.id=$5 AND r.body_deleted_at IS NULL`,
              [target.type, target.id, actor, rootId, replyTo],
            )
          ).rowCount !== 1
        )
          throw new CommunityNotFoundError();
        const participants = (
          await db.query<{ author_id: string }>(
            "SELECT author_id FROM community.catalog_comments WHERE id=$1 UNION SELECT author_id FROM community.catalog_comment_replies WHERE id=$2",
            [rootId, replyTo ?? null],
          )
        ).rows;
        for (const p of participants.sort((a, b) =>
          a.author_id.localeCompare(b.author_id),
        )) {
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [[actor, p.author_id].sort().join(":")],
          );
          if (
            !(
              await db.query(
                "SELECT community.accounts_can_interact($1,$2) AS allowed",
                [actor, p.author_id],
              )
            ).rows[0]?.allowed
          )
            throw new CommunityNotFoundError();
        }
      }
      const policy = (
        await db.query(
          "SELECT policy FROM community.publication_setting WHERE id='publication' FOR SHARE",
        )
      ).rows[0]?.policy;
      const moderation =
          policy === "DIRECT_PUBLICATION" ? "visible" : "pending",
        id = opaque("comment");
      if (rootId)
        await db.query(
          "INSERT INTO community.catalog_comment_replies(id,root_comment_id,author_id,text,moderation,reply_to_reply_id,was_public,mentions) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
          [
            id,
            rootId,
            actor,
            text,
            moderation,
            replyTo ?? null,
            moderation === "visible",
            JSON.stringify(mentions),
          ],
        );
      else
        await db.query(
          "INSERT INTO community.catalog_comments(id,catalog_id,target_type,author_id,text,moderation,was_public,mentions) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
          [
            id,
            target.id,
            target.type,
            actor,
            text,
            moderation,
            moderation === "visible",
            JSON.stringify(mentions),
          ],
        );
      await enqueueNotification(db, "comment", id, actor);
      await this.authorAudit(db, actor, "comment_sent", id);
      const author = (
        await db.query(
          "SELECT display_name FROM community.public_users WHERE id=$1",
          [actor],
        )
      ).rows[0];
      const created = (
        await db.query(
          `SELECT created_at FROM community.${rootId ? "catalog_comment_replies" : "catalog_comments"} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      const to = replyTo
        ? (
            await db.query(
              "SELECT u.id,u.display_name FROM community.catalog_comment_replies r JOIN community.public_users u ON u.id=r.author_id WHERE r.id=$1",
              [replyTo],
            )
          ).rows[0]
        : undefined;
      return {
        id,
        rootId: rootId ?? id,
        awaitingApproval: moderation === "pending",
        item: discussionReplySchema.parse({
          id,
          author: { id: actor, displayName: author?.display_name },
          text,
          createdAt: created?.created_at.toISOString(),
          likeCount: 0,
          liked: false,
          deleted: false,
          ...(to
            ? { replyTo: { id: to.id, displayName: to.display_name } }
            : {}),
        }),
      };
    });
  }
  private async subject(db: PoolClient, id: string, lock = true) {
    const r = (
      await db.query<{
        id: string;
        root_id: string;
        author_id: string;
        target_type: "catalog" | "work" | "article";
        catalog_id: string;
        thread_removed_at: Date | null;
      }>(
        `SELECT c.id,c.id AS root_id,c.author_id,c.target_type,c.catalog_id,c.thread_removed_at FROM community.catalog_comments c WHERE c.id=$1
   UNION ALL SELECT r.id,c.id,r.author_id,c.target_type,c.catalog_id,c.thread_removed_at FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id WHERE r.id=$1`,
        [id],
      )
    ).rows[0];
    if (!r) throw new CommunityNotFoundError();
    if (lock)
      await db.query(
        "SELECT id FROM community.catalog_comments WHERE id=$1 FOR UPDATE",
        [r.root_id],
      );
    if (
      (
        await db.query(
          "SELECT thread_removed_at FROM community.catalog_comments WHERE id=$1",
          [r.root_id],
        )
      ).rows[0]?.thread_removed_at
    )
      throw new CommunityNotFoundError();
    return r;
  }
  async discussionTarget(id: string): Promise<ContentIdentity> {
    return this.run(false, async (db) => {
      const s = await this.subject(db, id, false);
      return { type: s.target_type, id: s.catalog_id } as ContentIdentity;
    });
  }
  async setDiscussionLike(
    actor: string,
    id: string,
    enabled: boolean,
    request: string,
  ) {
    await this.run(true, async (db) => {
      await this.active(db, actor);
      return this.receipt(
        db,
        actor,
        request,
        ["like", id, enabled],
        async () => {
          const s = await this.subject(db, id, false),
            target = {
              type: s.target_type,
              id: s.catalog_id,
            } as ContentIdentity;
          await this.interactionLocks(
            db,
            target,
            actor,
            s.root_id,
            s.id === s.root_id ? undefined : s.id,
          );
          await this.root(db, target, s.root_id, actor, true);
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [[actor, s.author_id].sort().join(":")],
          );
          const eligible =
            s.id === s.root_id
              ? await db.query(
                  `SELECT c.id ${rootFrom} AND c.id=$4 AND ${rootPublic} AND c.body_deleted_at IS NULL`,
                  [target.type, target.id, actor, id],
                )
              : await db.query(
                  `SELECT r.id ${replyFrom} AND r.id=$5 AND ${rootPublic} AND r.moderation='visible' AND r.body_deleted_at IS NULL`,
                  [target.type, target.id, actor, s.root_id, id],
                );
          if (eligible.rowCount !== 1) throw new CommunityNotFoundError();
          const changed = enabled
            ? await db.query(
                "INSERT INTO community.comment_likes(comment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
                [id, actor],
              )
            : await db.query(
                "DELETE FROM community.comment_likes WHERE comment_id=$1 AND user_id=$2",
                [id, actor],
              );
          if (changed.rowCount)
            await enqueueNotification(db, "comment_like", id, actor);
          await this.authorAudit(
            db,
            actor,
            enabled ? "comment_liked" : "comment_unliked",
            id,
          );
        },
      );
    });
  }
  async deleteDiscussionBody(actor: string, id: string, request: string) {
    await this.run(true, async (db) => {
      await this.active(db, actor);
      return this.receipt(db, actor, request, ["delete_body", id], async () => {
        const s = await this.subject(db, id);
        if (s.author_id !== actor) throw new CommunityNotFoundError();
        await db.query(
          `UPDATE community.${s.id === s.root_id ? "catalog_comments" : "catalog_comment_replies"} SET text=$2,body_deleted_at=COALESCE(body_deleted_at,CURRENT_TIMESTAMP) WHERE id=$1`,
          [id, deletedText],
        );
        await this.authorAudit(db, actor, "comment_body_deleted", id);
      });
    });
  }
  private async operatorAudit(
    db: PoolClient,
    operator: string,
    id: string,
    action: string,
    kind: string,
    detail: string,
  ) {
    await db.query(
      "INSERT INTO community.moderation_events(id,operator_label,action,subject_kind,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
      [opaque("moderation"), operator, action, kind, id, detail],
    );
  }
  async operatorDeleteBody(operator: string, id: string, request: string) {
    await this.run(true, (db) =>
      this.receipt(
        db,
        `operator:${operator}`,
        request,
        ["delete_body", id],
        async () => {
          const s = await this.subject(db, id);
          await db.query(
            `UPDATE community.${s.id === s.root_id ? "catalog_comments" : "catalog_comment_replies"} SET text=$2,body_deleted_at=COALESCE(body_deleted_at,CURRENT_TIMESTAMP) WHERE id=$1`,
            [id, deletedText],
          );
          await this.operatorAudit(
            db,
            operator,
            id,
            "delete_body",
            s.id === s.root_id ? "comment" : "reply",
            "Body deleted; eligible replies retained",
          );
        },
      ),
    );
  }
  async removeDiscussionThread(
    operator: string,
    rootId: string,
    request: string,
    expectedCount: number,
  ) {
    return this.run(true, (db) =>
      this.receipt(
        db,
        `operator:${operator}`,
        request,
        ["remove_thread", rootId, expectedCount],
        async () => {
          const s = await this.subject(db, rootId);
          if (s.id !== s.root_id) throw new CommunityNotFoundError();
          const total =
            1 +
            Number(
              (
                await db.query(
                  "SELECT count(*) AS n FROM community.catalog_comment_replies WHERE root_comment_id=$1",
                  [rootId],
                )
              ).rows[0]?.n ?? 0,
            );
          if (total !== expectedCount)
            throw new CommunityConflictError(
              `Thread now contains ${total} items; review the count before confirming`,
            );
          await db.query(
            "UPDATE community.catalog_comments SET thread_removed_at=CURRENT_TIMESTAMP WHERE id=$1",
            [rootId],
          );
          await this.operatorAudit(
            db,
            operator,
            rootId,
            "remove_thread",
            "comment",
            `Removed ${total} items`,
          );
          return { removed: total };
        },
      ),
    );
  }
  async ownComments(actor: string, q: DiscussionQuery) {
    return this.run(false, async (db) => {
      const own = `FROM (SELECT c.id,c.id AS root_id,c.author_id,c.text,c.created_at,c.body_deleted_at,c.target_type,c.catalog_id,c.thread_removed_at,c.author_id AS root_author,c.moderation AS root_moderation FROM community.catalog_comments c
   UNION ALL SELECT r.id,c.id,r.author_id,r.text,r.created_at,r.body_deleted_at,c.target_type,c.catalog_id,c.thread_removed_at,c.author_id,c.moderation FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id) x
   WHERE x.author_id=$1 AND x.thread_removed_at IS NULL`;
      const total = Number(
        (await db.query(`SELECT count(*) AS n ${own}`, [actor])).rows[0]?.n ??
          0,
      );
      const rows = (
        await db.query(
          `SELECT x.*, (root_moderation='visible' OR root_author=$1) AND community.accounts_can_interact($1,root_author) AND EXISTS(SELECT 1 FROM community.public_users WHERE id=root_author AND (root_moderation='visible' OR status='active')) AS context_available ${own} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
          [actor, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      // One statement answers work availability for the whole page; a work
      // the actor may not read leaves its retained record with a null target.
      const allowedWorks = await this.allowedWorks(
        db,
        rows.flatMap((r) =>
          r.context_available && r.target_type === "work" ? [r.catalog_id] : [],
        ),
        actor,
      );
      const items = rows.map((r) => {
        const target: ContentIdentity | null =
          r.context_available &&
          (r.target_type !== "work" || allowedWorks.has(r.catalog_id))
            ? { type: r.target_type, id: r.catalog_id }
            : null;
        return ownCommentSchema.parse({
          id: r.id,
          rootId: r.root_id,
          text: r.body_deleted_at ? deletedText : r.text,
          createdAt: r.created_at.toISOString(),
          deleted: !!r.body_deleted_at,
          target,
        });
      });
      return { items, ...pageMeta(total, q) };
    });
  }
  async locateDiscussion(
    target: ContentIdentity,
    id: string,
    viewer: string,
    q: DiscussionQuery,
  ) {
    return this.run(false, async (db) => {
      await this.workAllowed(db, target, viewer);
      const s = (
        await db.query<{ root_id: string }>(
          "SELECT id AS root_id FROM community.catalog_comments WHERE id=$1 UNION ALL SELECT root_comment_id FROM community.catalog_comment_replies WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!s) throw new CommunityNotFoundError();
      await this.root(db, target, s.root_id, viewer);
      const pinned = await this.hotIds(db, target, viewer, q);
      const row = (
        await db.query<{ n: string }>(
          `SELECT n FROM (SELECT c.id,row_number() OVER(ORDER BY c.created_at DESC,c.id DESC) AS n ${rootFrom} AND c.id<>ALL($4::text[])) x WHERE id=$5`,
          [target.type, target.id, viewer, pinned, s.root_id],
        )
      ).rows[0];
      if (!row && !pinned.includes(s.root_id))
        throw new CommunityNotFoundError();
      let replyPage = 1;
      if (id !== s.root_id) {
        const reply = (
          await db.query<{ n: string }>(
            `SELECT n FROM (SELECT r.id,row_number() OVER(ORDER BY r.created_at,r.id) AS n ${replyFrom}) x WHERE id=$5`,
            [target.type, target.id, viewer, s.root_id, id],
          )
        ).rows[0];
        if (!reply) throw new CommunityNotFoundError();
        replyPage = Math.ceil(Number(reply.n) / q.pageSize);
      }
      return {
        rootId: s.root_id,
        page: row ? Math.ceil(Number(row.n) / q.pageSize) : 1,
        replyPage,
      };
    });
  }
}
