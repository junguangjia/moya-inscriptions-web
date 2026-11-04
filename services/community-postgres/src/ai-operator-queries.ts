import {
  aiCountResultSchema,
  aiFindResultSchema,
  SELF_ONLY_OWNER_REVIEW,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AiCountQuery,
  AiCountResult,
  AiFindItem,
  AiFindQuery,
  AiFindResult,
  AiFindSource,
  AiFindStatus,
  AiLookupType,
  AiOperatorReader,
  AiOperatorSubject,
} from "@moya/contracts/internal/admin-mcp";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { asCommunityOperationError } from "./availability.js";
import {
  operatorCommentUnion,
  operatorFilter,
  toSearchPattern,
} from "./comment-queries.js";
import {
  operatorUsersWhere,
  operatorWorksWhere,
} from "./content-operator-adapter.js";
import {
  publishingJobsWhere,
  submissionQueueWhere,
} from "./publishing/operator.js";
import { operatorReportFilter } from "./reporting-adapter.js";
import {
  articleUsesSelfOnlyMediaSql,
  commentIsSelfOnlySql,
  isSelfOnlyWorkSql,
  reportIsSelfOnlySql,
  revisionIsSelfOnlySql,
  workIsSelfOnlySql,
} from "./self-only.js";
import { userMatchRankArms } from "./user-match-rank.js";

/**
 * The Backend's AI-only reads (admin-mcp-completion-v1 section 6). A budget is
 * enforced where the SQL runs: each branch has its own READ ONLY transaction, because
 * a timeout aborts the transaction it happens in and an abort on the Admin side would
 * not stop the statement. Branches run in turn on one pooled connection at a time and
 * hold it across nothing but their own SQL, so a slow one cannot starve the Owner or
 * the public site.
 */

const BRANCH_STATEMENT_TIMEOUT = "2000ms";
const QUERY_CANCELED = "57014";

/**
 * Within Admin's 15 s call, so a slow answer still names each branch instead of
 * reading as a lost one. Past it no branch starts, and the rest say so.
 */
const FIND_DEADLINE_MS = 12_000;

const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 120;

type Branch<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "timed_out" | "failed" };

const iso = (value: Date | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : value.toISOString();

/** Every word must be in `document`; `$1` holds them. Punctuation means itself. */
const holdsEveryWord = (document: string): string =>
  `NOT EXISTS(SELECT 1 FROM unnest($1::text[]) word WHERE position(lower(word) in lower(${document}))=0)`;

/** Around the first word, `$2`. PostgreSQL's substr never splits a code point. */
const snippetOf = (document: string): string =>
  `substr(${document},greatest(position(lower($2) in lower(${document}))-${SNIPPET_BEFORE},1),${SNIPPET_LENGTH})`;

interface UserRow extends QueryResultRow {
  id: string;
  handle: string;
  display_name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  match_rank?: number;
  snippet?: string;
}

const userItem = (row: UserRow, match: AiFindItem["match"]): AiFindItem => ({
  type: "user",
  id: row.id,
  title: row.display_name,
  state: row.status,
  updatedAt: row.updated_at.toISOString(),
  disambiguators: {
    handle: row.handle,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  },
  match,
});

const userColumns = `u.id,u.handle,u.display_name,u.status,u.created_at,u.updated_at`;

interface WorkRow extends QueryResultRow {
  id: string;
  title: string;
  operator_state: string;
  deleted_at: Date | null;
  version: number;
  updated_at: Date;
  author_id: string;
  handle: string;
  publicly_visible: boolean;
  field?: string;
  snippet?: string;
}

const workColumns = `w.id,w.title,w.operator_state,w.deleted_at,w.version,w.updated_at,w.author_id,u.handle,
  community.work_is_public(w) AND u.status='active' AS publicly_visible`;

const workItem = (row: WorkRow, match: AiFindItem["match"]): AiFindItem => ({
  type: "work",
  id: row.id,
  // A permanently deleted work holds no text.
  ...(row.title === "" ? {} : { title: row.title }),
  state: row.operator_state,
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
  disambiguators: {
    authorId: row.author_id,
    authorHandle: row.handle,
    publiclyVisible: row.publicly_visible,
    ...(row.deleted_at === null ? {} : { authorDeleted: true }),
  },
  match,
});

/** Roots and replies alike; `e` is what the search and the exact read select from. */
const commentEntries = `(
  SELECT c.id,'comment' AS kind,c.text,c.moderation,c.created_at,c.author_id,c.target_type,c.catalog_id,NULL::text AS root_comment_id
  FROM community.catalog_comments c
  UNION ALL
  SELECT r.id,'reply',r.text,r.moderation,r.created_at,r.author_id,c.target_type,c.catalog_id,r.root_comment_id
  FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id
) e`;

interface CommentRow extends QueryResultRow {
  id: string;
  kind: string;
  moderation: string;
  created_at: Date;
  author_id: string;
  target_type: string;
  catalog_id: string;
  root_comment_id: string | null;
  snippet?: string;
}

const commentItem = (
  row: CommentRow,
  match: AiFindItem["match"],
): AiFindItem => ({
  type: "comment",
  id: row.id,
  state: row.moderation,
  disambiguators: {
    kind: row.kind,
    authorId: row.author_id,
    targetType: row.target_type,
    targetId: row.catalog_id,
    createdAt: row.created_at.toISOString(),
    ...(row.root_comment_id === null ? {} : { rootId: row.root_comment_id }),
  },
  match,
});

interface ThreadRow extends QueryResultRow {
  id: string;
  title: string;
  status: string;
  hidden_at: Date | null;
  version: number;
  updated_at: Date;
  snippet?: string;
}

const threadItem = (
  row: ThreadRow,
  match: AiFindItem["match"],
): AiFindItem => ({
  type: "thread",
  id: row.id,
  title: row.title,
  state: row.hidden_at === null ? row.status : "hidden",
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
  disambiguators: {},
  match,
});

/**
 * Over what AI may read: never `contact` or an evidence file name, whatever they
 * hold. The claimant's other fields are read one by one for that reason.
 */
const reportDocument = `concat_ws(' ',c.description,c.claimant->>'name',c.claimant->>'rightsBasis',
  c.snapshot->>'title',c.snapshot->>'text',c.snapshot->>'displayName',c.snapshot->>'handle',
  (SELECT string_agg(concat_ws(' ',x.appeal_text,x.reason,x.review_reason),' ') FROM community.report_decisions x WHERE x.case_id=c.id),
  (SELECT string_agg(x.text,' ') FROM community.report_materials x WHERE x.case_id=c.id),
  (SELECT string_agg(x.text,' ') FROM community.report_messages x WHERE x.case_id=c.id),
  (SELECT string_agg(x.reason,' ') FROM community.report_audit x WHERE x.case_id=c.id))`;

interface ReportRow extends QueryResultRow {
  id: string;
  kind: string;
  reason: string | null;
  status: string;
  urgent: boolean;
  version: number;
  updated_at: Date;
  target_type: string;
  target_id: string;
  snippet?: string;
}

const reportColumns = `c.id,c.kind,c.reason,c.status,c.urgent,c.version,c.updated_at,c.target_type,c.target_id`;

const reportItem = (
  row: ReportRow,
  match: AiFindItem["match"],
): AiFindItem => ({
  type: "report",
  id: row.id,
  state: row.status,
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
  disambiguators: {
    kind: row.kind,
    ...(row.reason === null ? {} : { reason: row.reason }),
    urgent: row.urgent,
    targetType: row.target_type,
    targetId: row.target_id,
  },
  match,
});

const words = (text: string): string[] => [
  ...new Set(text.split(/\s+/u).filter(Boolean)),
];

const rawMatch = (field: string, snippet?: string): AiFindItem["match"] => ({
  field,
  kind: "raw",
  ...(snippet === undefined || snippet === "" ? {} : { snippet }),
});

const identity = (field: string): AiFindItem["match"] => ({
  field,
  kind: "identity",
});

type SearchBranch = (
  db: PoolClient,
  args: readonly [words: string[], first: string, limit: number],
  text: string,
) => Promise<AiFindItem[]>;

/** `$1` the words, `$2` the first of them, `$3` the row limit. */
const SEARCH_BRANCHES: Readonly<Record<AiFindSource, SearchBranch>> = {
  users: async (db, args, text) =>
    (
      await db.query<UserRow>(
        `SELECT ${userColumns},${snippetOf("m.doc")} AS snippet,
          CASE ${userMatchRankArms("$4")} END AS match_rank
         FROM community.public_users u
         CROSS JOIN LATERAL (SELECT u.id||' '||u.handle||' '||u.display_name AS doc) m
         WHERE ${holdsEveryWord("m.doc")}
         ORDER BY match_rank,u.created_at DESC,u.id LIMIT $3`,
        [...args, text],
      )
    ).rows.map((row) =>
      userItem(
        row,
        row.match_rank === 0
          ? identity("id")
          : row.match_rank === 1
            ? identity("handle")
            : rawMatch(
                row.match_rank === 2 ? "displayName" : "text",
                row.snippet,
              ),
      ),
    ),
  works: async (db, args) =>
    (
      await db.query<WorkRow>(
        `SELECT ${workColumns},${snippetOf("m.doc")} AS snippet,
          CASE WHEN position(lower($2) in lower(w.title))>0 THEN 'title'
            WHEN position(lower($2) in lower(w.text))>0 THEN 'text'
            ELSE 'other' END AS field
         FROM community.works w JOIN community.public_users u ON u.id=w.author_id
         LEFT JOIN community.work_revisions ar ON ar.id=w.author_revision_id AND ar.requested_visibility='public'
         CROSS JOIN LATERAL (SELECT concat_ws(' ',w.id,w.title,w.text,ar.title,ar.body,u.display_name,u.handle) AS doc) m
         WHERE NOT ${isSelfOnlyWorkSql("w")} AND ${holdsEveryWord("m.doc")}
         ORDER BY COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at) DESC,w.id LIMIT $3`,
        [...args],
      )
    ).rows.map((row) =>
      workItem(row, rawMatch(row.field ?? "text", row.snippet)),
    ),
  comments: async (db, args) =>
    (
      await db.query<CommentRow>(
        `SELECT e.id,e.kind,e.moderation,e.created_at,e.author_id,e.target_type,e.catalog_id,e.root_comment_id,
          ${snippetOf("e.text")} AS snippet
         FROM ${commentEntries}
         WHERE NOT (e.target_type='work' AND ${workIsSelfOnlySql("e.catalog_id")}) AND ${holdsEveryWord("e.text")}
         ORDER BY e.created_at DESC,e.id DESC LIMIT $3`,
        [...args],
      )
    ).rows.map((row) => commentItem(row, rawMatch("text", row.snippet))),
  threads: async (db, args) =>
    (
      await db.query<ThreadRow>(
        `SELECT t.id,t.title,t.status,t.hidden_at,t.version,t.updated_at,${snippetOf("m.doc")} AS snippet
         FROM community.threads t
         CROSS JOIN LATERAL (SELECT t.title||' '||t.description||' '||array_to_string(t.tags,' ') AS doc) m
         WHERE ${holdsEveryWord("m.doc")}
         ORDER BY t.position,t.created_at DESC,t.id LIMIT $3`,
        [...args],
      )
    ).rows.map((row) => threadItem(row, rawMatch("text", row.snippet))),
  reports: async (db, args) =>
    (
      await db.query<ReportRow>(
        `SELECT ${reportColumns},${snippetOf("m.doc")} AS snippet
         FROM community.report_cases c
         CROSS JOIN LATERAL (SELECT ${reportDocument} AS doc) m
         WHERE NOT ${reportIsSelfOnlySql("c")} AND ${holdsEveryWord("m.doc")}
         ORDER BY c.urgent DESC,c.created_at DESC,c.id LIMIT $3`,
        [...args],
      )
    ).rows.map((row) => reportItem(row, rawMatch("text", row.snippet))),
};

/** The source a lookup reports on; the same names the text search uses. */
const LOOKUP_SOURCE: Readonly<Record<AiLookupType, string>> = {
  user: "users",
  work: "works",
  comment: "comments",
  thread: "threads",
  report: "reports",
  feedback: "feedback",
  publishing_job: "publishing_jobs",
  work_revision: "work_revisions",
  media_item: "media_items",
  article: "article_documents",
};

const LOOKUPS: Readonly<
  Record<AiLookupType, (db: PoolClient, id: string) => Promise<AiFindItem[]>>
> = {
  user: async (db, id) =>
    (
      await db.query<UserRow>(
        `SELECT ${userColumns} FROM community.public_users u WHERE u.id=$1`,
        [id],
      )
    ).rows.map((row) => userItem(row, identity("id"))),
  work: async (db, id) =>
    (
      await db.query<WorkRow>(
        `SELECT ${workColumns} FROM community.works w JOIN community.public_users u ON u.id=w.author_id
         WHERE w.id=$1 AND NOT ${isSelfOnlyWorkSql("w")}`,
        [id],
      )
    ).rows.map((row) => workItem(row, identity("id"))),
  comment: async (db, id) =>
    (
      await db.query<CommentRow>(
        `SELECT e.id,e.kind,e.moderation,e.created_at,e.author_id,e.target_type,e.catalog_id,e.root_comment_id
         FROM ${commentEntries}
         WHERE e.id=$1 AND NOT (e.target_type='work' AND ${workIsSelfOnlySql("e.catalog_id")})`,
        [id],
      )
    ).rows.map((row) => commentItem(row, identity("id"))),
  thread: async (db, id) =>
    (
      await db.query<ThreadRow>(
        "SELECT id,title,status,hidden_at,version,updated_at FROM community.threads WHERE id=$1",
        [id],
      )
    ).rows.map((row) => threadItem(row, identity("id"))),
  // The one record a withheld answer still names: its case exists, and it is the Owner's.
  report: async (db, id) =>
    (
      await db.query<ReportRow & { owner_only: boolean }>(
        `SELECT ${reportColumns},${reportIsSelfOnlySql("c")} AS owner_only FROM community.report_cases c WHERE c.id=$1`,
        [id],
      )
    ).rows.map((row) =>
      row.owner_only
        ? {
            type: "report" as const,
            id: row.id,
            state: row.status,
            disambiguators: {
              kind: row.kind,
              ownerOnly: true,
              code: SELF_ONLY_OWNER_REVIEW,
            },
            match: identity("id"),
          }
        : reportItem(row, identity("id")),
    ),
  feedback: async (db, id) =>
    (
      await db.query<{ id: string; user_id: string; created_at: Date }>(
        "SELECT id,user_id,created_at FROM community.feedback WHERE id=$1",
        [id],
      )
    ).rows.map((row) => ({
      type: "feedback" as const,
      id: row.id,
      state: "received",
      disambiguators: {
        userId: row.user_id,
        createdAt: row.created_at.toISOString(),
      },
      match: identity("id"),
    })),
  publishing_job: async (db, id) =>
    (
      await db.query<{
        id: string;
        kind: string;
        state: string;
        subject_id: string;
        updated_at: Date;
      }>(
        "SELECT id,kind,state,subject_id,updated_at FROM community.publishing_jobs WHERE id=$1",
        [id],
      )
    ).rows.map((row) => ({
      type: "publishing_job" as const,
      id: row.id,
      state: row.state,
      updatedAt: row.updated_at.toISOString(),
      disambiguators: { kind: row.kind, subjectId: row.subject_id },
      match: identity("id"),
    })),
  // Autosaves are `not_required`: private drafts are not on this path.
  work_revision: async (db, id) =>
    (
      await db.query<{
        id: string;
        title: string;
        disposition: string;
        work_id: string;
        author_id: string;
        version: number;
      }>(
        `SELECT r.id,r.title,r.disposition,r.work_id,r.author_id,r.version
         FROM community.work_revisions r JOIN community.works w ON w.id=r.work_id
         WHERE r.id=$1 AND r.disposition<>'not_required' AND w.deleted_at IS NULL AND NOT ${isSelfOnlyWorkSql("w")}`,
        [id],
      )
    ).rows.map((row) => ({
      type: "work_revision" as const,
      id: row.id,
      title: row.title,
      state: row.disposition,
      version: row.version,
      disambiguators: { workId: row.work_id, authorId: row.author_id },
      match: identity("id"),
    })),
  media_item: async (db, id) =>
    (
      await db.query<{
        id: string;
        state: string;
        kind: string;
        owner_id: string;
        updated_at: Date;
      }>(
        `SELECT i.id,i.state,i.kind,i.owner_id,i.updated_at FROM community.media_items i
         WHERE i.id=$1 AND NOT EXISTS(
           SELECT 1 FROM community.work_revision_items ri
           JOIN community.work_revisions r ON r.id=ri.revision_id
           JOIN community.works w ON w.id=r.work_id
           WHERE ri.item_id=i.id AND ${isSelfOnlyWorkSql("w")})`,
        [id],
      )
    ).rows.map((row) => ({
      type: "media_item" as const,
      id: row.id,
      state: row.state,
      updatedAt: row.updated_at.toISOString(),
      disambiguators: { kind: row.kind, ownerId: row.owner_id },
      match: identity("id"),
    })),
  // A draft is private, and a live document's working title may be a draft's.
  article: async (db, id) =>
    (
      await db.query<{
        id: string;
        status: string;
        title: string | null;
        owner_id: string;
        version: number;
        updated_at: Date;
      }>(
        `SELECT id,status,CASE WHEN status='pending' THEN title END AS title,owner_id,version,updated_at
         FROM community.article_documents WHERE id=$1 AND status<>'draft'`,
        [id],
      )
    ).rows.map((row) => ({
      type: "article" as const,
      id: row.id,
      ...(row.title === null ? {} : { title: row.title }),
      state: row.status,
      updatedAt: row.updated_at.toISOString(),
      version: row.version,
      disambiguators: { ownerId: row.owner_id },
      match: identity("id"),
    })),
};

const withheld = (types: readonly string[]): string[] =>
  types.includes("article") ? ["private_draft"] : ["self_only"];

interface CountSpec {
  /** A FROM and WHERE from this package, never caller text. */
  readonly from: string;
  readonly values: readonly unknown[];
  readonly oldest: string;
  readonly groups: Readonly<Record<string, string>>;
}

/** Each source's own list filter, so a count and its list cannot disagree. */
const countSpecOf = (query: AiCountQuery): CountSpec => {
  switch (query.source) {
    case "reports":
      return {
        // Grouping reads back what a row shows no more than filtering does.
        from: `FROM community.report_cases c WHERE ${operatorReportFilter.sql}${
          operatorReportFilter.namesWithheld(query) ||
          query.groupBy === "reason" ||
          query.groupBy === "targetType"
            ? ` AND NOT ${reportIsSelfOnlySql("c")}`
            : ""
        }`,
        values: operatorReportFilter.values(query),
        oldest: "c.created_at",
        groups: {
          kind: "c.kind",
          status: "c.status",
          reason: "c.reason",
          targetType: "c.target_type",
        },
      };
    case "comments":
      return {
        from: `FROM (${operatorCommentUnion}) entries ${operatorFilter}`,
        values: [
          query.moderation ?? null,
          query.kind ?? null,
          query.catalogId ?? null,
          query.search === undefined ? null : toSearchPattern(query.search),
          query.authorId ?? null,
          query.from ?? null,
          query.to ?? null,
          true,
        ],
        oldest: "entries.created_at",
        groups: {
          moderation: "entries.moderation",
          kind: "entries.kind",
          targetType: "entries.target_type",
        },
      };
    case "works":
      return {
        from: `FROM community.works w JOIN community.public_users u ON u.id=w.author_id${operatorWorksWhere}`,
        values: [
          query.search,
          query.authorId ?? null,
          query.workId ?? null,
          query.from ?? null,
          query.to ?? null,
          true,
        ],
        oldest:
          "COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at)",
        groups: { state: "w.operator_state" },
      };
    case "users":
      return {
        from: `FROM community.public_users u ${operatorUsersWhere}`,
        values: [query.search, query.userId ?? null],
        oldest: "u.created_at",
        groups: { status: "u.status" },
      };
    case "work_submissions":
      return {
        from: submissionQueueWhere,
        values: [
          query.state ?? null,
          query.authorId ?? null,
          query.workId ?? null,
          true,
        ],
        oldest: "r.submitted_at",
        groups: { state: "r.disposition" },
      };
    case "jobs":
      return {
        from: `FROM community.publishing_jobs ${publishingJobsWhere}`,
        values: [
          query.state ?? null,
          query.kind ?? null,
          query.subjectId ?? null,
          query.id ?? null,
        ],
        oldest: "created_at",
        groups: { state: "state", kind: "kind" },
      };
  }
};

export class PostgresAiOperatorReader implements AiOperatorReader {
  constructor(private readonly pool: Pool) {}

  private async branch<T>(
    read: (db: PoolClient) => Promise<T>,
  ): Promise<Branch<T>> {
    let db: PoolClient;
    try {
      db = await this.pool.connect();
    } catch {
      return { status: "failed" };
    }
    try {
      await db.query("BEGIN READ ONLY");
      await db.query(
        `SET LOCAL statement_timeout='${BRANCH_STATEMENT_TIMEOUT}'`,
      );
      const value = await read(db);
      await db.query("COMMIT");
      return { status: "ok", value };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      const code = (error as { code?: unknown } | null)?.code;
      if (code === QUERY_CANCELED) return { status: "timed_out" };
      // The state code alone: never the statement, a value or a driver message.
      console.warn(`[ai-operator] find_branch_failed ${String(code)}`);
      return { status: "failed" };
    } finally {
      db.release();
    }
  }

  async find(query: AiFindQuery): Promise<AiFindResult> {
    const sources: Record<string, AiFindStatus> = {};
    const items: AiFindItem[] = [];
    const run = async (
      source: string,
      read: (db: PoolClient) => Promise<AiFindItem[]>,
    ) => {
      const answer = await this.branch(read);
      sources[source] = answer.status;
      if (answer.status === "ok") items.push(...answer.value);
    };
    if ("text" in query) {
      const parts = words(query.text);
      const args = [parts, parts[0]!, query.limit] as const;
      const deadline = Date.now() + FIND_DEADLINE_MS;
      for (const source of query.source === undefined
        ? (Object.keys(SEARCH_BRANCHES) as AiFindSource[])
        : [query.source]) {
        if (Date.now() >= deadline) sources[source] = "timed_out";
        else
          await run(source, (db) =>
            SEARCH_BRANCHES[source](db, args, query.text),
          );
      }
    } else if ("handle" in query)
      // handle is stored normalized, and lower(u.handle) could not use its index.
      await run("users", async (db) =>
        (
          await db.query<UserRow>(
            `SELECT ${userColumns} FROM community.public_users u WHERE u.handle=lower(ltrim($1,'@'))`,
            [query.handle],
          )
        ).rows.map((row) => userItem(row, identity("handle"))),
      );
    else
      await run(LOOKUP_SOURCE[query.type], (db) =>
        LOOKUPS[query.type](db, query.id),
      );
    return aiFindResultSchema.parse({
      items,
      sources,
      excluded: withheld("type" in query ? [query.type] : []),
    });
  }

  async count(query: AiCountQuery): Promise<AiCountResult | "timed_out"> {
    const spec = countSpecOf(query);
    const group =
      query.groupBy === undefined ? undefined : spec.groups[query.groupBy];
    const answer = await this.branch(
      async (db) =>
        (
          await db.query<{
            value?: unknown;
            count: number;
            oldest: Date | null;
          }>(
            group === undefined
              ? `SELECT count(*)::integer AS count,min(${spec.oldest}) AS oldest ${spec.from}`
              : `SELECT ${group} AS value,count(*)::integer AS count,min(${spec.oldest}) AS oldest ${spec.from}
                 GROUP BY 1 ORDER BY count DESC,value ASC NULLS LAST`,
            [...spec.values],
          )
        ).rows,
    );
    if (answer.status === "timed_out") return "timed_out";
    if (answer.status !== "ok")
      throw asCommunityOperationError(new Error("count failed"), "query");
    const rows = answer.value;
    const oldest = rows
      .map((row) => row.oldest?.getTime())
      .filter((at) => at !== undefined);
    return aiCountResultSchema.parse({
      total: rows.reduce((sum, row) => sum + row.count, 0),
      oldestAt: oldest.length === 0 ? null : iso(new Date(Math.min(...oldest))),
      ...(group === undefined
        ? {}
        : {
            groupBy: query.groupBy,
            groups: rows.map((row) => ({
              value: row.value === null ? null : String(row.value),
              count: row.count,
              oldestAt: iso(row.oldest) ?? null,
            })),
          }),
    });
  }

  async isSelfOnly(subject: AiOperatorSubject, id: string): Promise<boolean> {
    const check = {
      work: workIsSelfOnlySql,
      comment: commentIsSelfOnlySql,
      work_revision: revisionIsSelfOnlySql,
      article: articleUsesSelfOnlyMediaSql,
    }[subject]("$1::text");
    const answer = await this.pool
      .query<{ withheld: boolean }>(`SELECT ${check} AS withheld`, [id])
      .catch((error: unknown) => {
        throw asCommunityOperationError(error, "query");
      });
    return answer.rows[0]!.withheld;
  }
}
