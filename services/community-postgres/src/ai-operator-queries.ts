import {
  aiCountResultSchema,
  aiFindResultSchema,
  aiSelectResultSchema,
  aiSettlementResultSchema,
  AI_OPERATOR_LABEL,
  PERSONAL_INFO_OWNER_REVIEW,
  SELF_ONLY_OWNER_REVIEW,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AiCountQuery,
  AiCountResult,
  AiCountSource,
  AiFindItem,
  AiFindQuery,
  AiFindResult,
  AiFindSource,
  AiFindStatus,
  AiLookupType,
  AiOperatorReader,
  AiOperatorSubject,
  AiSelectIdsQuery,
  AiSelectItem,
  AiSelectResult,
  AiSettlementQuery,
  AiSettlementResult,
  AiSettlementType,
  AiStampSource,
} from "@moya/contracts/internal/admin-mcp";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { asCommunityOperationError } from "./availability.js";
import { OPERATOR_SOURCES } from "./operator-filters.js";
import type { SourceQuery, SourceSpec } from "./operator-filters.js";
import type { PublicationSyncOptions } from "./publishing/publication-sync.js";
import {
  articleUsesSelfOnlyMediaSql,
  caseIsSelfOnlySql,
  commentIsSelfOnlySql,
  isSelfOnlyWorkInScanSql,
  isSelfOnlyWorkSql,
  jobSubjectIsSelfOnlySql,
  reportAsksOfOwnProfileSql,
  reportIsSelfOnlySql,
  revisionIsSelfOnlySql,
  workInSelfOnlySetSql,
  workIsSelfOnlySql,
} from "./self-only.js";
import { userMatchRankArms } from "./user-match-rank.js";

/**
 * The Backend's AI-only reads (admin-mcp-completion-v1 section 6). A budget is
 * enforced where the SQL runs: each branch has its own READ ONLY transaction, because
 * a timeout aborts the transaction it happens in and an abort on the Admin side would
 * not stop the statement. Branches run in turn on one pooled connection at a time and
 * hold it across nothing but their own SQL. That bounds one call: what keeps the AI
 * from holding the pool the Owner and the public site share is Admin's limit on calls
 * at once.
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
         WHERE NOT ${isSelfOnlyWorkInScanSql("w")} AND ${holdsEveryWord("m.doc")}
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
         WHERE NOT (e.target_type='work' AND ${workInSelfOnlySetSql("e.catalog_id")}) AND ${holdsEveryWord("e.text")}
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
      await db.query<
        ReportRow & { owner_only: boolean; owner_decides: boolean }
      >(
        `SELECT ${reportColumns},${reportIsSelfOnlySql("c")} AS owner_only,${reportAsksOfOwnProfileSql("c")} AS owner_decides FROM community.report_cases c WHERE c.id=$1`,
        [id],
      )
    ).rows.map((row) => {
      if (row.owner_only)
        return {
          type: "report" as const,
          id: row.id,
          state: row.status,
          disambiguators: {
            kind: row.kind,
            ownerOnly: true,
            code: SELF_ONLY_OWNER_REVIEW,
          },
          match: identity("id"),
        };
      const item = reportItem(row, identity("id"));
      // AI reads this one, and only its writes are the Owner's, so none is offered.
      return row.owner_decides
        ? {
            ...item,
            disambiguators: {
              ...item.disambiguators,
              ownerOnly: true,
              code: PERSONAL_INFO_OWNER_REVIEW,
            },
          }
        : item;
    }),
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

/** A count reads as the AI does: what only the Owner may see stays out. */
const AI_READ = { withholdSelfOnly: true } as const;

/** The same table, typed by source for a count of any of them. */
const SOURCES: {
  readonly [Source in AiCountSource]: SourceSpec<SourceQuery<Source>>;
} = OPERATOR_SOURCES;

/** Each source's own list filter, so a count and its list cannot disagree. */
const countOf = <Source extends AiCountSource>(
  query: Extract<AiCountQuery, { readonly source: Source }>,
) => {
  const spec = SOURCES[query.source as Source];
  return {
    from: `${spec.from} ${spec.where(query, AI_READ)}`,
    values: spec.values(query, AI_READ),
    oldest: spec.oldest,
    groups: spec.groups,
    leavesOutOwnerOnly: spec.withholds?.(query) === true,
  };
};

interface SelectRow extends QueryResultRow {
  id: string;
  stamp: string;
  version: number | null;
  state: string | null;
  kind: string | null;
  affected: number | null;
  withheld: "self_only" | "personal_info" | null;
}

/**
 * By ids, `$1` (admin-mcp-completion-v1 section 8): each row's stamp, the counter its
 * moderation bumps or its version, and the facts an op's preview reads. Each withheld
 * test is a lookup per row, so these few rows never read a whole table's self-only set.
 * A comment's stamp holds its thread's counter too, and a job's its attempts.
 */
const SELECT_BY_IDS: Readonly<Record<AiStampSource, string>> = {
  comments: `SELECT e.id,e.stamp,NULL::integer AS version,e.moderation AS state,e.kind,e.affected,
      CASE WHEN e.target_type='work' AND ${workIsSelfOnlySql("e.catalog_id")} THEN 'self_only' END AS withheld
    FROM (
      SELECT c.id,'comment' AS kind,c.moderation,c.target_type,c.catalog_id,
        'c'||c.reporting_revision||'.'||c.reporting_thread_revision AS stamp,
        1+(SELECT count(*) FROM community.catalog_comment_replies x WHERE x.root_comment_id=c.id)::integer AS affected
      FROM community.catalog_comments c WHERE c.id=ANY($1::text[])
      UNION ALL
      SELECT r.id,'reply',r.moderation,c.target_type,c.catalog_id,'r'||r.reporting_revision,NULL
      FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id
      WHERE r.id=ANY($1::text[])
    ) e`,
  works: `SELECT w.id,'w'||w.version AS stamp,w.version,w.operator_state AS state,NULL AS kind,NULL::integer AS affected,
      CASE WHEN ${isSelfOnlyWorkSql("w")} THEN 'self_only' END AS withheld
    FROM community.works w WHERE w.id=ANY($1::text[])`,
  users: `SELECT u.id,'u'||u.reporting_revision AS stamp,NULL::integer AS version,u.status AS state,NULL AS kind,
      NULL::integer AS affected,NULL AS withheld
    FROM community.public_users u WHERE u.id=ANY($1::text[])`,
  jobs: `SELECT j.id,'j'||j.state||'.'||j.attempts AS stamp,NULL::integer AS version,j.state,j.kind,NULL::integer AS affected,
      CASE WHEN ${jobSubjectIsSelfOnlySql("j.id")} THEN 'self_only' END AS withheld
    FROM community.publishing_jobs j WHERE j.id=ANY($1::text[])`,
  reports: `SELECT c.id,'r'||c.version AS stamp,c.version,c.status AS state,c.kind,NULL::integer AS affected,
      CASE WHEN ${reportIsSelfOnlySql("c")} THEN 'self_only'
        WHEN ${reportAsksOfOwnProfileSql("c")} THEN 'personal_info' END AS withheld
    FROM community.report_cases c WHERE c.id=ANY($1::text[])`,
};

/** What a source can withhold, named on every answer whatever it holds. */
const SELECT_WITHHOLDS: Readonly<Record<AiStampSource, readonly string[]>> = {
  comments: ["self_only"],
  works: ["self_only"],
  users: [],
  jobs: ["self_only"],
  reports: ["self_only", "personal_info"],
};

/** A withheld row says why and nothing of its state, so the mark reads back nothing. */
const selectItem = (row: SelectRow): AiSelectItem =>
  row.withheld !== null
    ? { id: row.id, stamp: "withheld", withheld: row.withheld }
    : {
        id: row.id,
        stamp: row.stamp,
        ...(row.version === null ? {} : { version: row.version }),
        ...(row.state === null ? {} : { state: row.state }),
        ...(row.kind === null ? {} : { kind: row.kind }),
        ...(row.affected === null ? {} : { affected: row.affected }),
      };

/**
 * Which statements answer for each subject (section 9). `items` holds every item the
 * subject's operations move, the union their publication sync touches: a work's across
 * all its revisions, the set its holds use, because an approval moves the public one.
 */
const SETTLEMENT_SUBJECTS: Readonly<
  Record<
    AiSettlementType,
    {
      readonly found: string;
      readonly withheld: string;
      readonly items: string;
    }
  >
> = {
  work: {
    found: "EXISTS(SELECT 1 FROM community.works WHERE id=$1::text)",
    withheld: workIsSelfOnlySql("$1::text"),
    items:
      "SELECT DISTINCT ri.item_id AS id FROM community.work_revision_items ri JOIN community.work_revisions r ON r.id=ri.revision_id WHERE r.work_id=$1::text",
  },
  article: {
    found:
      "EXISTS(SELECT 1 FROM community.article_documents WHERE id=$1::text)",
    withheld: articleUsesSelfOnlyMediaSql("$1::text"),
    items: `SELECT DISTINCT ref.item_id AS id FROM community.article_revisions r
      JOIN community.media_item_refs ref ON ref.holder_kind='article_revision'
        AND ref.holder_id='article-revision-'||substr(encode(sha256(convert_to(r.article_id||':'||r.version::text,'UTF8')),'hex'),1,32)
      WHERE r.article_id=$1::text`,
  },
  user: {
    found: "EXISTS(SELECT 1 FROM community.public_users WHERE id=$1::text)",
    withheld: "FALSE",
    items: "SELECT id FROM community.media_items WHERE owner_id=$1::text",
  },
  // A job's own subject. It is a media item or a Catalog asset.
  item: {
    found:
      "(EXISTS(SELECT 1 FROM community.media_items WHERE id=$1::text) OR EXISTS(SELECT 1 FROM community.catalog_media_assets WHERE id=$1::text))",
    withheld: `EXISTS(SELECT 1 FROM community.work_revision_items ri
      JOIN community.work_revisions r ON r.id=ri.revision_id
      JOIN community.works w ON w.id=r.work_id
      WHERE ri.item_id=$1::text AND ${isSelfOnlyWorkSql("w")})`,
    items: "SELECT $1::text AS id",
  },
};

/**
 * The subject's unfinished jobs, on their partial index, and of those the ones that
 * stopped since the operation. Its time is what it set on the subject's public asset,
 * `desired_at`, so a replay and admin_job need carry none, and a later operation that
 * fences the asset again starts its own. That clock is the database's on some routes and
 * a job's is the worker's, and a job running through the operation that fails right
 * after has no successor, so the margin reads it as failed and never as finished. A job
 * that stopped within it before reads as failed too.
 */
const settlementJobsSql = (items: string): string => `
  WITH subjects AS (${items}),
  unfinished AS (
    SELECT j.id,j.kind,j.subject_id,j.state,j.updated_at
    FROM community.publishing_jobs j JOIN subjects s ON s.id=j.subject_id
    WHERE j.kind IN ('publish_media','withdraw_media','verify_withdrawal') AND j.state<>'succeeded'
  ),
  stopped AS (
    SELECT u.id,u.kind,u.subject_id,u.updated_at FROM unfinished u
    WHERE u.state IN ('failed','abandoned')
      AND u.updated_at>=(SELECT a.desired_at FROM community.media_public_assets a
        WHERE a.item_id=u.subject_id OR a.catalog_asset_id=u.subject_id)-interval '1 minute'
  )`;

const settlementOpenSql = (
  items: string,
): string => `${settlementJobsSql(items)}
  SELECT (SELECT count(*) FROM unfinished WHERE state IN ('queued','running'))::integer AS open,
    (SELECT min(updated_at) FROM stopped) AS oldest_stop`;

/**
 * Only past a stop, because no index serves a subject's finished jobs: the worker's
 * reconcile tries again, so a stop counts until a later job of its side has succeeded,
 * and a withdrawal and its verification run one handler, so either clears the other. The
 * stop's own time, a real value when this is planned, bounds it on the state index.
 */
const settlementStoppedSql = (
  items: string,
): string => `${settlementJobsSql(items)},
  standing AS (
    SELECT s.id,s.updated_at FROM stopped s
    WHERE NOT EXISTS(SELECT 1 FROM community.publishing_jobs later
      WHERE later.state='succeeded' AND later.updated_at>=$2::timestamptz
        AND later.updated_at>=s.updated_at AND later.created_at>=s.updated_at
        AND later.subject_id=s.subject_id
        AND later.kind=ANY(CASE WHEN s.kind='publish_media' THEN ARRAY['publish_media']
          ELSE ARRAY['withdraw_media','verify_withdrawal'] END))
  )
  SELECT (SELECT count(*) FROM standing)::integer AS failed,
    ARRAY(SELECT id FROM standing ORDER BY updated_at DESC,id DESC LIMIT 3) AS failed_jobs`;

export class PostgresAiOperatorReader implements AiOperatorReader {
  constructor(
    private readonly pool: Pool,
    /** The gates publishing asks. Absent, nothing publishes, as in publication-sync. */
    private readonly publication?: PublicationSyncOptions,
  ) {}

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
    const spec = countOf(query);
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
      ...(spec.leavesOutOwnerOnly ? { leavesOutOwnerOnly: true } : {}),
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

  async select(query: AiSelectIdsQuery): Promise<AiSelectResult | "timed_out"> {
    const answer = await this.branch(
      async (db) =>
        (await db.query<SelectRow>(SELECT_BY_IDS[query.source], [query.ids]))
          .rows,
    );
    if (answer.status === "timed_out") return "timed_out";
    if (answer.status !== "ok")
      throw asCommunityOperationError(new Error("select failed"), "query");
    return aiSelectResultSchema.parse({
      items: answer.value.map(selectItem),
      excluded: [...SELECT_WITHHOLDS[query.source]],
    });
  }

  async settlement(
    query: AiSettlementQuery,
  ): Promise<AiSettlementResult | "timed_out" | "not_found" | "self_only"> {
    const { found, withheld, items } = SETTLEMENT_SUBJECTS[query.type];
    const answer = await this.branch(async (db) => {
      const subject = (
        await db.query<{ found: boolean; withheld: boolean }>(
          `SELECT ${found} AS found,${withheld} AS withheld`,
          [query.id],
        )
      ).rows[0]!;
      if (!subject.found) return "not_found" as const;
      if (subject.withheld) return "self_only" as const;
      const { open, oldest_stop: oldestStop } = (
        await db.query<{ open: number; oldest_stop: Date | null }>(
          settlementOpenSql(items),
          [query.id],
        )
      ).rows[0]!;
      if (oldestStop === null) return { open, failed: 0, failedJobs: [] };
      const { failed, failed_jobs: failedJobs } = (
        await db.query<{ failed: number; failed_jobs: string[] }>(
          settlementStoppedSql(items),
          [query.id, oldestStop],
        )
      ).rows[0]!;
      return { open, failed, failedJobs };
    });
    if (answer.status === "timed_out") return "timed_out";
    if (answer.status !== "ok")
      throw asCommunityOperationError(new Error("settlement failed"), "query");
    if (typeof answer.value === "string") return answer.value;
    const { open, failed, failedJobs } = answer.value;
    const gateShut =
      query.intent === "publish" &&
      !(this.publication?.isPublic() && this.publication.allowPublish());
    return aiSettlementResultSchema.parse({
      open,
      failed,
      failedJobs,
      ...(gateShut ? { mediaGate: "off" } : {}),
    });
  }

  async isSelfOnly(subject: AiOperatorSubject, id: string): Promise<boolean> {
    const check = {
      work: workIsSelfOnlySql,
      comment: commentIsSelfOnlySql,
      work_revision: revisionIsSelfOnlySql,
      article: articleUsesSelfOnlyMediaSql,
      report: caseIsSelfOnlySql,
      publishing_job: jobSubjectIsSelfOnlySql,
    }[subject]("$1::text");
    return this.holds(`SELECT ${check} AS held`, [id]);
  }

  isPersonalInfoRequest(reportId: string): Promise<boolean> {
    return this.holds(
      `SELECT EXISTS(SELECT 1 FROM community.report_cases c WHERE c.id=$1::text AND ${reportAsksOfOwnProfileSql("c")}) AS held`,
      [reportId],
    );
  }

  hasCommentReceipt(requestId: string): Promise<boolean> {
    return this.holds(
      "SELECT EXISTS(SELECT 1 FROM community.discussion_command_receipts WHERE actor_label=$1 AND request_id=$2) AS held",
      [AI_OPERATOR_LABEL, requestId],
    );
  }

  private async holds(
    statement: string,
    values: readonly string[],
  ): Promise<boolean> {
    const answer = await this.pool
      .query<{ held: boolean }>(statement, [...values])
      .catch((error: unknown) => {
        throw asCommunityOperationError(error, "query");
      });
    return answer.rows[0]!.held;
  }
}
