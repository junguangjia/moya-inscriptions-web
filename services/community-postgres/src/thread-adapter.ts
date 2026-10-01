import { createHash, randomUUID } from "node:crypto";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  threadPageSchema,
  threadSummarySchema,
  threadReadResultSchema,
} from "@moya/contracts/schemas";
import {
  operatorThreadPageSchema,
  operatorThreadSchema,
} from "@moya/contracts/internal/community-operator";

import { asCommunityOperationError } from "./availability.js";
import { workColumns, workDtos, workVisibleTo } from "./work-dto.js";

import type { WorkRow } from "./work-dto.js";
import type { AuthorPage, ThreadPort } from "@moya/api";
import type {
  AuthorListQuery,
  ThreadId,
  ThreadListQuery,
  ThreadPage,
  ThreadReadResult,
  ThreadSummary,
  UserWork,
} from "@moya/contracts";
import type {
  CreateThreadCommand,
  OperatorThread,
  OperatorThreadPage,
  UpdateThreadCommand,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient, QueryResultRow } from "pg";

/*
 * content-community-completion-v1: Threads over Works.
 *
 * Eligible activity of a Thread is what an anonymous reader may see: works
 * that are publicly visible (community.work_is_public, active author), their
 * visible root comments and replies (not body-deleted, thread not removed),
 * and active likes on those comments by active accounts. Heat at an anchor
 * instant is  Σ weight · 2^(-age_days / 7)  with weights work 1, comment /
 * reply 2, like 1; each logical item counts once. Ties break by latest
 * eligible activity, then by Thread id. Works submitted after the anchor do
 * not move a page that was ranked at that anchor.
 */

const HEAT_HALF_LIFE_DAYS = 7;

interface ThreadRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: "open" | "closed";
  hidden_at: Date | null;
  position: number;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  heat: string | number;
  post_count: string | number;
  latest_activity_at: Date | null;
  observed_activity_at: Date | null;
}

/** Publicly eligible works of a Thread (`tw` joins `w`/`u`); `$anchor` bounds first publication. */
const eligibleWorks = (anchor: string) => `
  SELECT tw.thread_id, w.id AS work_id, w.first_published_at AS at
  FROM community.thread_works tw
  JOIN community.works w ON w.id = tw.work_id
  JOIN community.public_users u ON u.id = w.author_id
  WHERE u.status = 'active' AND community.work_is_public(w)
    AND w.first_published_at IS NOT NULL AND w.first_published_at <= ${anchor}`;

/**
 * One row per eligible activity item with its weight and instant. Comments
 * and replies count when visible and not body-deleted under a visible,
 * non-removed root; likes count when the liker is active and the comment is
 * visible. Legacy items without an instant cannot happen: every row carries
 * created_at NOT NULL.
 */
const activityItems = (anchor: string) => `
  WITH ew AS (${eligibleWorks(anchor)}),
  roots AS (
    SELECT ew.thread_id, c.id, c.created_at
    FROM ew JOIN community.catalog_comments c
      ON c.target_type = 'work' AND c.catalog_id = ew.work_id
    JOIN community.public_users cu ON cu.id = c.author_id
    WHERE c.moderation = 'visible' AND c.body_deleted_at IS NULL
      AND c.thread_removed_at IS NULL AND cu.status = 'active'
      AND c.created_at <= ${anchor}),
  replies AS (
    SELECT roots.thread_id, r.id, r.created_at
    FROM roots JOIN community.catalog_comment_replies r ON r.root_comment_id = roots.id
    JOIN community.public_users ru ON ru.id = r.author_id
    WHERE r.moderation = 'visible' AND r.body_deleted_at IS NULL
      AND ru.status = 'active' AND r.created_at <= ${anchor}),
  likes AS (
    SELECT x.thread_id, l.created_at
    FROM (SELECT thread_id, id FROM roots UNION ALL SELECT thread_id, id FROM replies) x
    JOIN community.comment_likes l ON l.comment_id = x.id
    JOIN community.public_users lu ON lu.id = l.user_id
    WHERE lu.status = 'active' AND l.created_at <= ${anchor})
  SELECT thread_id, 1::numeric AS weight, at FROM ew
  UNION ALL SELECT thread_id, 2::numeric, created_at FROM roots
  UNION ALL SELECT thread_id, 2::numeric, created_at FROM replies
  UNION ALL SELECT thread_id, 1::numeric, created_at FROM likes`;

/** Heat, eligible post count and latest activity per Thread at the anchor. */
const threadMetrics = (anchor: string) => `
  SELECT a.thread_id,
    COALESCE(SUM(a.weight * power(2::numeric,
      -(EXTRACT(EPOCH FROM (${anchor} - a.at)) / 86400.0) / ${HEAT_HALF_LIFE_DAYS})), 0) AS heat,
    MAX(a.at) AS latest_activity_at
  FROM (${activityItems(anchor)}) a
  GROUP BY a.thread_id`;

const postCounts = (anchor: string) => `
  SELECT thread_id, count(*)::integer AS post_count FROM (${eligibleWorks(anchor)}) ew GROUP BY thread_id`;

const threadColumns = `t.id, t.title, t.description, t.tags, t.status, t.hidden_at, t.position, t.version,
  t.created_by, t.created_at, t.updated_at,
  COALESCE(m.heat, 0) AS heat, COALESCE(p.post_count, 0) AS post_count, m.latest_activity_at,
  rs.observed_activity_at`;

const threadFrom = (anchor: string) => `
  FROM community.threads t
  LEFT JOIN (${threadMetrics(anchor)}) m ON m.thread_id = t.id
  LEFT JOIN (${postCounts(anchor)}) p ON p.thread_id = t.id
  LEFT JOIN community.thread_read_state rs ON rs.thread_id = t.id AND rs.user_id = $2`;

const commandFingerprint = (action: string, subject: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([action, subject, input]))
    .digest("hex");

export class PostgresThreadAdapter implements ThreadPort {
  constructor(private readonly pool: Pool) {}

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

  private summary(row: ThreadRow, viewer: string | null): ThreadSummary {
    const latest = row.latest_activity_at;
    return threadSummarySchema.parse({
      id: row.id,
      title: row.title,
      description: row.description,
      tags: row.tags,
      status: row.status,
      heat: Number(Number(row.heat).toFixed(4)),
      postCount: Number(row.post_count),
      latestActivityAt: latest ? latest.toISOString() : null,
      createdAt: row.created_at.toISOString(),
      unread:
        viewer === null
          ? null
          : latest !== null &&
            (row.observed_activity_at === null ||
              row.observed_activity_at.getTime() < latest.getTime()),
    });
  }

  async listThreads(
    viewer: string | null,
    query: ThreadListQuery,
  ): Promise<ThreadPage> {
    return this.run(false, async (db) => {
      // The anchor is the server's snapshot instant; a supplied anchor is
      // clamped to now so a future instant cannot pull unpublished activity.
      const anchor =
        query.anchor === undefined
          ? (await db.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now
          : new Date(Math.min(new Date(query.anchor).getTime(), Date.now()));
      const anchorParam = "$1::timestamptz";
      const total = Number(
        (
          await db.query<{ total: string }>(
            "SELECT count(*) AS total FROM community.threads t WHERE t.hidden_at IS NULL",
          )
        ).rows[0]!.total,
      );
      const rows = (
        await db.query<ThreadRow>(
          `SELECT ${threadColumns} ${threadFrom(anchorParam)}
           WHERE t.hidden_at IS NULL
           ORDER BY COALESCE(m.heat, 0) DESC, m.latest_activity_at DESC NULLS LAST, t.position ASC, t.id ASC
           LIMIT $3 OFFSET $4`,
          [
            anchor.toISOString(),
            viewer,
            query.pageSize,
            (query.page - 1) * query.pageSize,
          ],
        )
      ).rows;
      return threadPageSchema.parse({
        items: rows.map((row) => this.summary(row, viewer)),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
        anchor: anchor.toISOString(),
      });
    });
  }

  private async threadRow(
    db: PoolClient,
    id: string,
    viewer: string | null,
    anchor: string,
  ): Promise<ThreadRow> {
    const row = (
      await db.query<ThreadRow>(
        `SELECT ${threadColumns} ${threadFrom(anchor)} WHERE t.id = $3 AND t.hidden_at IS NULL`,
        [new Date().toISOString(), viewer, id],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return row;
  }

  async readThread(
    id: ThreadId,
    viewer: string | null,
  ): Promise<ThreadSummary> {
    return this.run(false, async (db) =>
      this.summary(
        await this.threadRow(db, id, viewer, "$1::timestamptz"),
        viewer,
      ),
    );
  }

  async listThreadPosts(
    id: ThreadId,
    viewer: string | null,
    q: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>> {
    return this.run(false, async (db) => {
      await this.threadRow(db, id, viewer, "$1::timestamptz");
      // Thread posts follow the same audience rule as the author's Works page:
      // public works for everybody, plus the author's own eligible works.
      const from = `FROM community.thread_works tw JOIN community.works w ON w.id = tw.work_id
        JOIN community.public_users u ON u.id = w.author_id
        WHERE tw.thread_id = $1 AND ${workVisibleTo("$2")}`;
      const total = Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total ${from}`,
            [id, viewer],
          )
        ).rows[0]?.total ?? 0,
      );
      const rows = (
        await db.query<WorkRow>(
          `SELECT ${workColumns} ${from} ORDER BY tw.created_at DESC, w.id DESC LIMIT $3 OFFSET $4`,
          [id, viewer, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      return {
        items: await workDtos(db, rows, viewer),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  async markThreadRead(id: ThreadId, actor: string): Promise<ThreadReadResult> {
    return this.run(true, async (db) => {
      const active = await db.query(
        "SELECT id FROM community.public_users WHERE id=$1 AND status='active'",
        [actor],
      );
      if (active.rowCount !== 1) throw new CommunityNotFoundError();
      const row = await this.threadRow(db, id, actor, "$1::timestamptz");
      const latest = row.latest_activity_at;
      if (latest === null)
        return threadReadResultSchema.parse({ observedActivityAt: null });
      // Monotonic: the marker only moves forward, to a server-observed instant.
      const updated = await db.query<{ observed_activity_at: Date }>(
        `INSERT INTO community.thread_read_state(user_id, thread_id, observed_activity_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (user_id, thread_id) DO UPDATE
           SET observed_activity_at = GREATEST(community.thread_read_state.observed_activity_at, EXCLUDED.observed_activity_at),
               updated_at = CURRENT_TIMESTAMP
         RETURNING observed_activity_at`,
        [actor, id, latest.toISOString()],
      );
      return threadReadResultSchema.parse({
        observedActivityAt: updated.rows[0]!.observed_activity_at.toISOString(),
      });
    });
  }

  async threadOfWork(workId: string): Promise<ThreadId | null> {
    try {
      const row = (
        await this.pool.query<{ thread_id: string }>(
          `SELECT tw.thread_id FROM community.thread_works tw JOIN community.threads t ON t.id = tw.thread_id
           WHERE tw.work_id = $1 AND t.hidden_at IS NULL`,
          [workId],
        )
      ).rows[0];
      return (row?.thread_id as ThreadId | undefined) ?? null;
    } catch (error) {
      throw asCommunityOperationError(error, "query");
    }
  }

  // -- operator boundary ---------------------------------------------------

  private operatorThread(row: ThreadRow): OperatorThread {
    return operatorThreadSchema.parse({
      id: row.id,
      title: row.title,
      description: row.description,
      tags: row.tags,
      status: row.status,
      hidden: row.hidden_at !== null,
      position: row.position,
      version: row.version,
      postCount: Number(row.post_count),
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }

  async operatorListThreads(query: {
    page: number;
    pageSize: number;
    includeHidden: boolean;
  }): Promise<OperatorThreadPage> {
    return this.run(false, async (db) => {
      const where = query.includeHidden ? "TRUE" : "t.hidden_at IS NULL";
      const total = Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total FROM community.threads t WHERE ${where}`,
          )
        ).rows[0]!.total,
      );
      const rows = (
        await db.query<ThreadRow>(
          `SELECT ${threadColumns} ${threadFrom("$1::timestamptz")} WHERE ${where}
           ORDER BY t.position ASC, t.created_at DESC, t.id ASC LIMIT $3 OFFSET $4`,
          [
            new Date().toISOString(),
            null,
            query.pageSize,
            (query.page - 1) * query.pageSize,
          ],
        )
      ).rows;
      return operatorThreadPageSchema.parse({
        items: rows.map((row) => this.operatorThread(row)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    });
  }

  /** Receipted, audited operator command over the content-operator tables. */
  private async command<T>(
    operator: string,
    action: string,
    subject: string,
    input: unknown,
    change: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.run(true, async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('phase4-content-operator',0))",
      );
      const requestId = (input as { requestId: string }).requestId;
      const fingerprint = commandFingerprint(action, subject, input);
      const old = await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
        [operator, requestId],
      );
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fingerprint)
          throw new CommunityConflictError("Request identity already used");
        return old.rows[0].result;
      }
      const result = await change(db);
      await db.query(
        "INSERT INTO community.content_operator_events(id,operator_label,action,content_type,content_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          operator,
          action,
          "thread",
          subject,
          JSON.stringify({ command: input, result }),
        ],
      );
      await db.query(
        "INSERT INTO community.content_operator_receipts(operator_label,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [operator, requestId, fingerprint, JSON.stringify(result)],
      );
      return result;
    });
  }

  async operatorCreateThread(
    operator: string,
    input: CreateThreadCommand,
  ): Promise<OperatorThread> {
    const id = `thread-${randomUUID().replaceAll("-", "")}`;
    return this.command(operator, "thread.create", id, input, async (db) => {
      await db.query(
        `INSERT INTO community.threads(id,title,description,tags,status,position,created_by)
         VALUES($1,$2,$3,$4::text[],'open',$5,$6)`,
        [
          id,
          input.title,
          input.description,
          input.tags,
          input.position,
          operator,
        ],
      );
      return this.operatorThread(
        (
          await db.query<ThreadRow>(
            `SELECT ${threadColumns} ${threadFrom("$1::timestamptz")} WHERE t.id = $3`,
            [new Date().toISOString(), null, id],
          )
        ).rows[0]!,
      );
    });
  }

  async operatorUpdateThread(
    operator: string,
    id: string,
    input: UpdateThreadCommand,
  ): Promise<OperatorThread> {
    return this.command(operator, "thread.update", id, input, async (db) => {
      const before = (
        await db.query<{ version: number; hidden_at: Date | null }>(
          "SELECT version, hidden_at FROM community.threads WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!before) throw new CommunityNotFoundError();
      if (before.version !== input.expectedVersion)
        throw new CommunityConflictError(
          "The Thread changed since it was read",
        );
      if (
        input.title === undefined &&
        input.description === undefined &&
        input.tags === undefined &&
        input.status === undefined &&
        input.hidden === undefined &&
        input.position === undefined
      )
        throw new CommunityInputError("Nothing to change");
      await db.query(
        `UPDATE community.threads SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           tags = COALESCE($4::text[], tags),
           status = COALESCE($5, status),
           hidden_at = CASE WHEN $6::boolean IS NULL THEN hidden_at
                            WHEN $6::boolean THEN COALESCE(hidden_at, CURRENT_TIMESTAMP)
                            ELSE NULL END,
           position = COALESCE($7, position),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          id,
          input.title ?? null,
          input.description ?? null,
          input.tags ?? null,
          input.status ?? null,
          input.hidden ?? null,
          input.position ?? null,
        ],
      );
      return this.operatorThread(
        (
          await db.query<ThreadRow>(
            `SELECT ${threadColumns} ${threadFrom("$1::timestamptz")} WHERE t.id = $3`,
            [new Date().toISOString(), null, id],
          )
        ).rows[0]!,
      );
    });
  }
}
