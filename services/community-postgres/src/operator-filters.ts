import type {
  AiCountQuery,
  AiCountSource,
} from "@moya/contracts/internal/admin-mcp";
import type { OperatorReadScope } from "@moya/contracts/internal/community-operator";

import { commentImagesSql } from "./comment-images.js";
import {
  isSelfOnlyWorkInScanSql,
  isSelfOnlyWorkSql,
  reportIsSelfOnlySql,
  workInSelfOnlySetSql,
} from "./self-only.js";

/**
 * One filter per operator source (admin-mcp-completion-v1 S8). The Owner's queue, the
 * AI's read of it and the count beside it take their WHERE and its values from here,
 * and so will a selector, so none of them can apply a filter another drops. The text is
 * this package's own: every caller value is bound.
 */

/** A source's filters, as its count takes them. A list's query holds them too. */
export type SourceQuery<Source extends AiCountSource> = Omit<
  Extract<AiCountQuery, { readonly source: Source }>,
  "source"
>;

export interface SourceSpec<Query> {
  /** The table and its joins. */
  readonly from: string;
  /** What follows `from` after a space: the WHERE from `$1`, with any join it needs. */
  readonly where: (query: Query, scope?: OperatorReadScope) => string;
  /** `$1` on, in order. What a statement adds after them takes the next numbers. */
  readonly values: (query: Query, scope?: OperatorReadScope) => unknown[];
  /** What a count reads as how long the longest waiter has waited. */
  readonly oldest: string;
  /** What a count groups by, under the name a caller gives. */
  readonly groups: Readonly<Record<string, string>>;
  /**
   * Decided by the query alone, so saying it says nothing about any one row: what the
   * AI reads leaves out rows only the Owner reviews, and its answer says so.
   */
  readonly withholds?: (query: Query) => boolean;
}

/** The placeholder `step` past a filter's values, so LIMIT and OFFSET never collide. */
export const slotAfter = (values: readonly unknown[], step: number): string =>
  `$${values.length + step}`;

/** Turns free text into a bounded substring pattern for ILIKE ... ESCAPE '\\'. */
const toSearchPattern = (search: string): string =>
  `%${search.replaceAll(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** Roots and replies as one review queue, `entries`. */
const operatorCommentUnion = `
  SELECT c.id, 'comment' AS kind, c.catalog_id,c.target_type,c.body_deleted_at,c.thread_removed_at, NULL::text AS root_comment_id,
         NULL::text AS reply_to_reply_id,
         c.text, c.created_at, c.moderation, ${commentImagesSql("c", true)} AS images,
         u.id AS author_id, u.handle AS author_handle,
         u.display_name AS author_display_name, u.status AS author_status
  FROM community.catalog_comments c
  JOIN community.public_users u ON u.id = c.author_id
  UNION ALL
  SELECT r.id, 'reply' AS kind, c.catalog_id,c.target_type,r.body_deleted_at,c.thread_removed_at,r.root_comment_id,
         r.reply_to_reply_id,
         r.text, r.created_at, r.moderation, ${commentImagesSql("r", true)} AS images,
         u.id AS author_id, u.handle AS author_handle,
         u.display_name AS author_display_name, u.status AS author_status
  FROM community.catalog_comment_replies r
  JOIN community.catalog_comments c ON c.id = r.root_comment_id
  JOIN community.public_users u ON u.id = r.author_id
`;

/**
 * The review filters: `$1` state (NULL = every state), `$2` kind, `$3`
 * Catalog record, `$4` a pre-escaped substring pattern matched against the
 * text and the author's handle and display name, `$5` author, `$6` and `$7`
 * the creation range, `$8` true to leave out what a self-only work withholds.
 * Nothing here is the public hot ordering; the Owner reviews newest or oldest
 * first.
 */
const operatorCommentFilter = `
  WHERE ($1::text IS NULL OR entries.moderation = $1::text)
    AND ($2::text IS NULL OR entries.kind = $2::text)
    AND ($3::text IS NULL OR entries.catalog_id = $3::text)
    AND (
      $4::text IS NULL
      OR entries.text ILIKE $4::text ESCAPE '\\'
      OR entries.author_handle ILIKE $4::text ESCAPE '\\'
      OR entries.author_display_name ILIKE $4::text ESCAPE '\\'
    )
    AND ($5::text IS NULL OR entries.author_id = $5::text)
    AND ($6::timestamptz IS NULL OR entries.created_at >= $6::timestamptz)
    AND ($7::timestamptz IS NULL OR entries.created_at <= $7::timestamptz)
    AND NOT (
      $8::boolean
      AND entries.target_type = 'work'
      AND ${workInSelfOnlySetSql("entries.catalog_id")}
    )
`;

/** The queue's filters, on `community.report_cases c`, from `$1`. */
const reportWhere = `($1::text IS NULL OR c.status=$1)
    AND ($2::boolean IS NULL OR c.urgent=$2)
    AND ($3::boolean IS NULL OR c.status<>'resolved')
    AND ($4::text IS NULL OR c.target_type=$4)
    AND ($5::text IS NULL OR c.target_id=$5)
    AND ($6::text IS NULL OR c.affected_user_id=$6)
    AND ($7::text IS NULL OR c.reporter_id=$7)`;

/**
 * An owner-only row shows its id, kind and status and no more, so it stays only under
 * a filter on what it shows. Anything else would read its target, its people or its
 * urgency back by counting, and grouping reads back what a row shows no more than
 * filtering does.
 */
const reportNamesWithheld = (query: SourceQuery<"reports">): boolean =>
  query.urgent !== undefined ||
  query.targetType !== undefined ||
  query.targetId !== undefined ||
  query.affectedUserId !== undefined ||
  query.reporterId !== undefined ||
  query.groupBy === "reason" ||
  query.groupBy === "targetType";

/**
 * `$1` search, `$2` author, `$3` work, `$4` and `$5` the time range, `$6` true to
 * leave self-only works out, so a search or a total cannot reveal their text. The
 * search reads the author's current revision, so the join is part of the filter.
 */
const worksWhere = `LEFT JOIN community.work_revisions ar ON ar.id=w.author_revision_id AND ar.requested_visibility='public'
  WHERE ($1='' OR position(lower($1) in lower(w.id||' '||w.title||' '||w.text||' '||COALESCE(ar.title,'')||' '||COALESCE(ar.body,'')||' '||u.display_name||' '||u.handle))>0)
  AND ($2::text IS NULL OR (w.author_id=$2 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM community.work_revisions r WHERE r.work_id=w.id AND r.disposition<>'not_required')))
  AND ($3::text IS NULL OR w.id=$3)
  AND ($4::timestamptz IS NULL OR COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at)>=$4::timestamptz)
  AND ($5::timestamptz IS NULL OR COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at)<=$5::timestamptz)
  AND NOT ($6::boolean AND ${isSelfOnlyWorkInScanSql("w")})`;

const usersWhere = `WHERE ($1='' OR position(lower($1) in lower(u.id||' '||u.handle||' '||u.display_name))>0)
  AND ($2::text IS NULL OR u.id=$2)`;

/** Queue-visible revisions: explicit or legacy, never self-only, of works that are not purged. */
export const submissionFrom = `FROM community.work_revisions r
  JOIN community.works w ON w.id=r.work_id
  JOIN community.public_users u ON u.id=r.author_id
  WHERE r.disposition<>'not_required' AND w.deleted_at IS NULL`;

/** The queue holds explicit submissions only; legacy baselines are read by id. */
const submissionWhere = `AND r.origin='submission'
  AND ($1::text IS NULL OR r.disposition=$1::text)
  AND ($2::text IS NULL OR r.author_id=$2::text)
  AND ($3::text IS NULL OR r.work_id=$3::text)
  AND NOT ($4::boolean AND ${isSelfOnlyWorkSql("w")})`;

const jobsWhere =
  "WHERE ($1::text IS NULL OR state=$1::text) AND ($2::text IS NULL OR kind=$2::text) AND ($3::text IS NULL OR subject_id=$3::text) AND ($4::text IS NULL OR id=$4::text)";

const withholdsSelfOnly = (scope: OperatorReadScope | undefined): boolean =>
  scope?.withholdSelfOnly === true;

export const OPERATOR_SOURCES = {
  reports: {
    from: "FROM community.report_cases c",
    where: (query, scope?) =>
      `WHERE ${reportWhere}${
        withholdsSelfOnly(scope) && reportNamesWithheld(query)
          ? ` AND NOT ${reportIsSelfOnlySql("c")}`
          : ""
      }`,
    values: (query) => [
      query.status ?? null,
      query.urgent === undefined ? null : query.urgent === "true",
      query.unresolved === undefined ? null : true,
      query.targetType ?? null,
      query.targetId ?? null,
      query.affectedUserId ?? null,
      query.reporterId ?? null,
    ],
    oldest: "c.created_at",
    groups: {
      kind: "c.kind",
      status: "c.status",
      reason: "c.reason",
      targetType: "c.target_type",
    },
    withholds: reportNamesWithheld,
  },
  comments: {
    from: `FROM (${operatorCommentUnion}) entries`,
    where: () => operatorCommentFilter,
    values: (query, scope?) => [
      query.moderation ?? null,
      query.kind ?? null,
      query.catalogId ?? null,
      query.search === undefined ? null : toSearchPattern(query.search),
      query.authorId ?? null,
      query.from ?? null,
      query.to ?? null,
      withholdsSelfOnly(scope),
    ],
    oldest: "entries.created_at",
    groups: {
      moderation: "entries.moderation",
      kind: "entries.kind",
      targetType: "entries.target_type",
    },
  },
  works: {
    from: "FROM community.works w JOIN community.public_users u ON u.id=w.author_id",
    where: () => worksWhere,
    values: (query, scope?) => [
      query.search,
      query.authorId ?? null,
      query.workId ?? null,
      query.from ?? null,
      query.to ?? null,
      withholdsSelfOnly(scope),
    ],
    oldest: "COALESCE(w.first_published_at,w.first_submitted_at,w.updated_at)",
    groups: { state: "w.operator_state" },
  },
  users: {
    from: "FROM community.public_users u",
    where: () => usersWhere,
    values: (query) => [query.search, query.userId ?? null],
    oldest: "u.created_at",
    groups: { status: "u.status" },
  },
  work_submissions: {
    from: submissionFrom,
    where: () => submissionWhere,
    values: (query, scope?) => [
      query.state ?? null,
      query.authorId ?? null,
      query.workId ?? null,
      withholdsSelfOnly(scope),
    ],
    oldest: "r.submitted_at",
    groups: { state: "r.disposition" },
  },
  jobs: {
    from: "FROM community.publishing_jobs",
    where: () => jobsWhere,
    values: (query) => [
      query.state ?? null,
      query.kind ?? null,
      query.subjectId ?? null,
      query.id ?? null,
    ],
    oldest: "created_at",
    groups: { state: "state", kind: "kind" },
  },
} satisfies {
  readonly [Source in AiCountSource]: SourceSpec<SourceQuery<Source>>;
};
