import { randomUUID } from "node:crypto";
import { CommunityConflictError, CommunityInputError } from "@moya/api";
import type {
  CommunityReportAction,
  CommunityReportTarget,
} from "@moya/contracts";
import type { QueryResultRow } from "pg";

export interface StaffReportingDb {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}
export type StaffReversal =
  | { kind: "informational" }
  | { kind: "restriction" }
  | { kind: "irreversible" }
  | {
      kind: "work_submission";
      workId: string;
      revisionId: string;
      contentSha256: string;
      revisionVersion: number;
      workVersion: number;
      authorRevisionId: string;
      visibility: string;
      publicRevisionId: string | null;
    }
  | {
      kind: "article_submission";
      articleId: string;
      candidateVersion: number;
      fingerprint: string;
      documentVersion: number;
      publicVersion: number | null;
    };
export interface StaffCapture {
  target: CommunityReportTarget;
  affectedUserId: string;
  canonicalPath: string;
  snapshot: Record<string, unknown>;
  reason: string;
  restriction?: {
    key: string;
    kind: "comment" | "reply" | "user_status" | "work" | "comment_thread";
    table: string;
    column: string;
    prior: unknown;
    revision: string;
  };
}
export const staffModerationReason = (
  reason: string | undefined,
): string | null => {
  if (reason === undefined || reason.trim() === "") return null;
  const value = reason.trim();
  if (value.length > 2000)
    throw new CommunityInputError("Moderation reason is too long");
  return value;
};
/** Reason has its bounded canonical case retention; legacy audits keep identity/state only. */
export function staffAuditCommand(action: string, input: unknown): unknown {
  if (
    ![
      "work.moderate",
      "publishing.submission.moderate",
      "article.submission.moderate",
    ].includes(action) ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    return input;
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "reason"),
  );
}
const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const pathFor = (type: string, id: string) =>
  type === "work"
    ? `/?workId=${encodeURIComponent(id)}#detail`
    : type === "catalog"
      ? `/?catalogId=${encodeURIComponent(id)}#detail`
      : type === "user"
        ? `/?authorId=${encodeURIComponent(id)}#profile`
        : `/?topic=${encodeURIComponent(id)}`;
/** Called before the native row lock, using the report path's same advisory order. */
export async function captureStaffSubject(
  db: StaffReportingDb,
  target: { type: "work" | "user" | "comment"; id: string },
  reason: string | undefined,
): Promise<StaffCapture | null> {
  const text = staffModerationReason(reason);
  if (text === null) return null;
  let kind: "work" | "user_status" | "comment" | "reply" =
    target.type === "user" ? "user_status" : target.type;
  if (target.type === "comment") {
    const located = (
      await db.query<{ kind: "comment" | "reply" }>(
        "SELECT 'comment'::text AS kind FROM community.catalog_comments WHERE id=$1 UNION ALL SELECT 'reply'::text AS kind FROM community.catalog_comment_replies WHERE id=$1",
        [target.id],
      )
    ).rows[0];
    if (!located) return null;
    kind = located.kind;
  }
  const key = `${kind}:${target.id}`;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,328))", [
    key,
  ]);
  const table =
    kind === "work"
      ? "community.works"
      : kind === "user_status"
        ? "community.public_users"
        : kind === "comment"
          ? "community.catalog_comments"
          : "community.catalog_comment_replies";
  const column =
    kind === "work"
      ? "operator_state"
      : kind === "user_status"
        ? "status"
        : "moderation";
  const row = (
    await db.query<{
      author_id: string;
      state: unknown;
      revision: string;
      title?: string;
      text?: string;
      display_name?: string;
      handle?: string;
      target_type?: string;
      catalog_id?: string;
      root_comment_id?: string;
    }>(
      `SELECT *,${kind === "user_status" ? "id" : "author_id"} AS author_id,${column} AS state,reporting_revision::text AS revision FROM ${table} WHERE id=$1 FOR UPDATE`,
      [target.id],
    )
  ).rows[0];
  if (!row) return null;
  let canonicalPath = pathFor(target.type, target.id),
    snapshot: Record<string, unknown>;
  if (kind === "work")
    snapshot = { title: row.title, text: row.text, authorId: row.author_id };
  else if (kind === "user_status")
    snapshot = { displayName: row.display_name, handle: row.handle };
  else {
    const root =
      kind === "reply"
        ? (
            await db.query<{
              id: string;
              text: string;
              author_id: string;
              target_type: string;
              catalog_id: string;
            }>(
              "SELECT id,text,author_id,target_type,catalog_id FROM community.catalog_comments WHERE id=$1",
              [row.root_comment_id],
            )
          ).rows[0]
        : null;
    canonicalPath = pathFor(
      root?.target_type ?? row.target_type!,
      root?.catalog_id ?? row.catalog_id!,
    );
    snapshot = {
      text: row.text,
      authorId: row.author_id,
      rootId: root?.id ?? target.id,
      parent: root
        ? { id: root.id, text: root.text, authorId: root.author_id }
        : null,
      post: {
        type: root?.target_type ?? row.target_type,
        id: root?.catalog_id ?? row.catalog_id,
      },
    };
  }
  return {
    target,
    affectedUserId: row.author_id,
    canonicalPath,
    snapshot,
    reason: text,
    restriction: {
      key,
      kind,
      table,
      column,
      prior: row.state,
      revision: row.revision,
    },
  };
}
export async function captureStaffThread(
  db: StaffReportingDb,
  rootId: string,
  reason: string | undefined,
): Promise<StaffCapture | null> {
  const text = staffModerationReason(reason);
  if (text === null) return null;
  const key = `comment_thread:${rootId}`;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,328))", [
    key,
  ]);
  const root = (
    await db.query<{
      author_id: string;
      target_type: string;
      catalog_id: string;
      thread_removed_at: Date | null;
      revision: string;
    }>(
      "SELECT author_id,target_type,catalog_id,thread_removed_at,reporting_thread_revision::text AS revision FROM community.catalog_comments WHERE id=$1 FOR UPDATE",
      [rootId],
    )
  ).rows[0];
  if (!root) return null;
  return {
    target: { type: "comment", id: rootId },
    affectedUserId: root.author_id,
    canonicalPath: pathFor(root.target_type, root.catalog_id),
    snapshot: {
      rootId,
      post: { type: root.target_type, id: root.catalog_id },
      thread: true,
    },
    reason: text,
    restriction: {
      key,
      kind: "comment_thread",
      table: "community.catalog_comments",
      column: "thread_removed_at",
      prior: root.thread_removed_at,
      revision: root.revision,
    },
  };
}
export function captureStaffCandidate(
  target: CommunityReportTarget,
  affectedUserId: string,
  title: string,
  reason: string | undefined,
): StaffCapture | null {
  const text = staffModerationReason(reason);
  return text === null
    ? null
    : {
        target,
        affectedUserId,
        canonicalPath: pathFor(target.type, target.id),
        snapshot: {
          title,
          authorId: affectedUserId,
          ...(target.type === "article"
            ? { source: "community", ownerId: affectedUserId }
            : {}),
        },
        reason: text,
      };
}
/** The caller owns the transaction, native decision fences, and all media/session effects. */
export async function recordStaffModeration(
  db: StaffReportingDb,
  capture: StaffCapture | null,
  operator: string,
  action: CommunityReportAction,
  at: Date,
  reversal?: StaffReversal,
): Promise<void> {
  if (capture === null) return;
  let restrictionKey: string | null = null;
  if (
    capture.restriction &&
    [
      "hide",
      "reject",
      "suspend",
      "restrict_comments",
      "remove_thread",
    ].includes(action)
  ) {
    const r = capture.restriction;
    const after = (
      await db.query<{ revision: string }>(
        `SELECT ${r.kind === "comment_thread" ? "reporting_thread_revision" : "reporting_revision"}::text AS revision FROM ${r.table} WHERE id=$1`,
        [capture.target.id],
      )
    ).rows[0];
    if (!after)
      throw new CommunityConflictError("Moderated subject disappeared");
    const head = (
      await db.query<{ applied_revision: string }>(
        "SELECT applied_revision::text FROM community.report_restriction_heads WHERE restriction_key=$1 FOR UPDATE",
        [r.key],
      )
    ).rows[0];
    if (!head)
      await db.query(
        "INSERT INTO community.report_restriction_heads(restriction_key,subject_kind,subject_id,prior_state,applied_revision) VALUES($1,$2,$3,$4::jsonb,$5)",
        [
          r.key,
          r.kind,
          capture.target.id,
          JSON.stringify({ value: r.prior }),
          after.revision,
        ],
      );
    else if (head.applied_revision === r.revision)
      await db.query(
        "UPDATE community.report_restriction_heads SET applied_revision=$2 WHERE restriction_key=$1",
        [r.key, after.revision],
      );
    restrictionKey = r.key;
  }
  const id = opaque("report"),
    decision = opaque("report-decision"),
    time = at.toISOString();
  const snapshot = {
    ...capture.snapshot,
    origin: "staff",
    staffReversal: reversal ?? {
      kind: restrictionKey ? "restriction" : "informational",
    },
  };
  await db.query(
    "INSERT INTO community.report_cases(id,reporter_id,target_type,target_id,canonical_path,affected_user_id,snapshot,kind,reason,description,status,decision_id,created_at,updated_at,closed_at) VALUES($1,NULL,$2,$3,$4,$5,$6::jsonb,'moderation',NULL,'','resolved',$7,$8::timestamptz,$8::timestamptz,$8::timestamptz)",
    [
      id,
      capture.target.type,
      capture.target.id,
      capture.canonicalPath,
      capture.affectedUserId,
      JSON.stringify(snapshot),
      decision,
      time,
    ],
  );
  await db.query(
    "INSERT INTO community.report_decisions(id,case_id,action,reason,operator_label,restriction_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz)",
    [decision, id, action, capture.reason, operator, restrictionKey, time],
  );
  await db.query(
    "INSERT INTO community.report_audit(id,case_id,operator_label,action,reason,occurred_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz)",
    [opaque("report-audit"), id, operator, action, capture.reason, time],
  );
  await db.query(
    "INSERT INTO community.report_messages(id,case_id,recipient_id,kind,text,created_at) VALUES($1,$2,$3,'result',$4,$5::timestamptz)",
    [
      opaque("report-message"),
      id,
      capture.affectedUserId,
      `处理措施：${({ retain: "保留内容", hide: "隐藏内容", warn: "警告", restrict_comments: "限制评论", suspend: "停用账号", approve: "审核通过", reject: "审核未通过", restore: "恢复", delete_body: "删除正文（无法恢复）", remove_thread: "移除整串讨论" } satisfies Record<CommunityReportAction, string>)[action]}。理由：${capture.reason}。可在举报与申诉中申请复核。`,
      time,
    ],
  );
}
