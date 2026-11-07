import { z } from "zod";

import {
  operatorUsersQuerySchema,
  operatorWorksFilterSchema,
} from "../community-operator/content-schemas.js";
import {
  operatorExactIdSchema,
  rangeInOrder,
} from "../community-operator/query-filters.js";
import { operatorReportQuerySchema } from "../community-operator/reporting.ts";
import { operatorCommentFilterSchema } from "../community-operator/schemas.js";
import {
  operatorPublishingJobQuerySchema,
  operatorWorkSubmissionQuerySchema,
  publishingJobIdSchema,
} from "../community-operator/work-publishing-schemas.js";

/**
 * The Backend's AI-only community reads: `internal/community/ai/find` and `ai/count`
 * (admin-mcp-completion-v1 section 6). Server-only, like the rest of this contract.
 */

/** Text search covers these. Each runs in its own READ ONLY transaction. */
export const AI_FIND_SOURCES = [
  "users",
  "works",
  "comments",
  "threads",
  "reports",
] as const;
export type AiFindSource = (typeof AI_FIND_SOURCES)[number];

/** A record type an id can name exactly, on the Backend. */
export const AI_LOOKUP_TYPES = [
  "user",
  "work",
  "comment",
  "thread",
  "report",
  "feedback",
  "publishing_job",
  "work_revision",
  "media_item",
  "article",
] as const;
export type AiLookupType = (typeof AI_LOOKUP_TYPES)[number];

/** Each word costs a condition per row read, so more than this is refused. */
export const AI_FIND_WORDS_MAX = 32;
/** admin_find pages to 200 candidates and reads a page and one row past it. */
export const AI_FIND_LIMIT_MAX = 226;

const aiFindTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !value.includes("\u0000"))
  .refine(
    (value) =>
      new Set(value.split(/\s+/u).filter(Boolean)).size <= AI_FIND_WORDS_MAX,
  );

export const aiFindQuerySchema = z.union([
  z.strictObject({
    text: aiFindTextSchema,
    source: z.enum(AI_FIND_SOURCES).optional(),
    limit: z.coerce.number().int().min(1).max(AI_FIND_LIMIT_MAX).default(26),
  }),
  z.strictObject({
    type: z.enum(AI_LOOKUP_TYPES),
    id: operatorExactIdSchema,
  }),
  z.strictObject({ handle: operatorExactIdSchema }),
]);
export type AiFindQuery = z.infer<typeof aiFindQuerySchema>;

export const aiFindItemSchema = z.strictObject({
  type: z.enum(AI_LOOKUP_TYPES),
  id: z.string(),
  title: z.string().optional(),
  state: z.string(),
  updatedAt: z.iso.datetime().optional(),
  version: z.number().int().nonnegative().optional(),
  disambiguators: z.record(z.string(), z.unknown()),
  match: z.strictObject({
    field: z.string(),
    kind: z.enum(["identity", "raw"]),
    snippet: z.string().optional(),
  }),
});
export type AiFindItem = z.infer<typeof aiFindItemSchema>;

export const aiFindStatusSchema = z.enum(["ok", "timed_out", "failed"]);
export type AiFindStatus = z.infer<typeof aiFindStatusSchema>;

export const aiFindResultSchema = z.strictObject({
  items: z.array(aiFindItemSchema),
  /** A branch not really read says so here and never reads as zero. */
  sources: z.record(z.string(), aiFindStatusSchema),
  /** Named whatever the answer holds, with no count: withheld never reads as empty. */
  excluded: z.array(z.string()),
});
export type AiFindResult = z.infer<typeof aiFindResultSchema>;

const noPage = { page: true, pageSize: true } as const;

/** What each source groups a count by. Grouping reads back what a row shows. */
export const AI_COUNT_GROUPS = {
  reports: ["kind", "status", "reason", "targetType"],
  comments: ["moderation", "kind", "targetType"],
  works: ["state"],
  users: ["status"],
  work_submissions: ["state"],
  jobs: ["state", "kind"],
} as const;
export type AiCountSource = keyof typeof AI_COUNT_GROUPS;

/** The list filters of each source, so a count and its list answer to one rule. */
export const aiCountQuerySchema = z
  .discriminatedUnion("source", [
    operatorReportQuerySchema.omit(noPage).extend({
      source: z.literal("reports"),
      groupBy: z.enum(AI_COUNT_GROUPS.reports).optional(),
    }),
    operatorCommentFilterSchema.extend({
      source: z.literal("comments"),
      groupBy: z.enum(AI_COUNT_GROUPS.comments).optional(),
    }),
    operatorWorksFilterSchema.omit(noPage).extend({
      source: z.literal("works"),
      groupBy: z.enum(AI_COUNT_GROUPS.works).optional(),
    }),
    operatorUsersQuerySchema.omit(noPage).extend({
      source: z.literal("users"),
      groupBy: z.enum(AI_COUNT_GROUPS.users).optional(),
    }),
    operatorWorkSubmissionQuerySchema.omit(noPage).extend({
      source: z.literal("work_submissions"),
      groupBy: z.enum(AI_COUNT_GROUPS.work_submissions).optional(),
    }),
    operatorPublishingJobQuerySchema.omit(noPage).extend({
      source: z.literal("jobs"),
      groupBy: z.enum(AI_COUNT_GROUPS.jobs).optional(),
    }),
  ])
  .refine((query) =>
    rangeInOrder(
      query as { from?: string | undefined; to?: string | undefined },
    ),
  );
export type AiCountQuery = z.infer<typeof aiCountQuerySchema>;

const countInstant = z.iso.datetime().nullable();
export const aiCountResultSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  /** How long the longest waiter has waited, so age needs no read of a row. */
  oldestAt: countInstant,
  /** This filter or grouping cannot count a case only the Owner reads, so says so. */
  leavesOutOwnerOnly: z.literal(true).optional(),
  groupBy: z.string().optional(),
  groups: z
    .array(
      z.strictObject({
        value: z.string().nullable(),
        count: z.number().int().positive(),
        oldestAt: countInstant,
      }),
    )
    .optional(),
});
export type AiCountResult = z.infer<typeof aiCountResultSchema>;

/**
 * Sources a selector freezes by filter, through `ai/select` (admin-mcp-completion-v1
 * section 8). No op selects reports, so they are read by id alone.
 */
export const AI_SELECT_SOURCES = [
  "comments",
  "works",
  "users",
  "jobs",
] as const satisfies readonly AiCountSource[];
export type AiSelectSource = (typeof AI_SELECT_SOURCES)[number];

/** Sources a preview reads the state of by id, to freeze it beside the input. */
export const AI_STAMP_SOURCES = [
  ...AI_SELECT_SOURCES,
  "reports",
] as const satisfies readonly AiCountSource[];
export type AiStampSource = (typeof AI_STAMP_SOURCES)[number];

/** Ids one read by id takes: one statement. */
export const AI_SELECT_IDS_MAX = 100;
/** Rows one block of a selector freezes: one statement, in one snapshot. */
export const AI_SELECT_FREEZE_MAX = 5_000;

/**
 * What a selected row must still allow, so a row its op would refuse is never counted
 * (section 8). The op picks one from its common input; the model never names one.
 * comments: `pending` to approve or reject, `visible` to hide, `hidden` to unhide,
 * `body_present` for a body not yet deleted, `thread_present` for a top-level comment
 * whose thread stands. works: not already in the state asked. users: `active` to
 * suspend, `suspended` to reinstate. jobs: `retryable` stopped, `abandonable` queued
 * or failed, neither a Catalog block job.
 */
export const AI_SELECT_MOVABLE = {
  comments: ["pending", "visible", "hidden", "body_present", "thread_present"],
  works: ["not_visible", "not_hidden", "not_removed"],
  users: ["active", "suspended"],
  jobs: ["retryable", "abandonable"],
} as const satisfies { readonly [Source in AiSelectSource]: readonly string[] };
export type AiSelectMovable =
  (typeof AI_SELECT_MOVABLE)[AiSelectSource][number];

// Comma-separated, so one id and many read alike: a repeated key arrives as a string
// or an array by count. No platform id holds a comma.
const selectIds = z
  .string()
  .max(AI_SELECT_IDS_MAX * 129)
  .transform((value) => value.split(","))
  .pipe(z.array(operatorExactIdSchema).min(1).max(AI_SELECT_IDS_MAX))
  .refine((ids) => new Set(ids).size === ids.length);

/** Where a block ended, as the Backend issued it: opaque to the Admin. */
const selectCursor = z.string().regex(/^k1:[A-Za-z0-9_-]{1,512}$/u);

const movableOf = <Source extends AiSelectSource>(source: Source) =>
  z.enum(AI_SELECT_MOVABLE[source]).optional();
const byIds = <Source extends AiSelectSource>(source: Source) =>
  z.strictObject({
    source: z.literal(source),
    ids: selectIds,
    movable: movableOf(source),
  });
const byFilter = <Source extends AiSelectSource>(source: Source) => ({
  source: z.literal(source),
  movable: movableOf(source),
  after: selectCursor.optional(),
});

/**
 * By ids: the state of up to 100 named rows, a withheld one marked and never left out
 * unnamed. By filter: the next block of the rows a list filter of the source matches,
 * in one order, past `after`. A filter never selects a withheld row.
 */
export const aiSelectQuerySchema = z.union([
  z.discriminatedUnion("source", [
    byIds("comments"),
    byIds("works"),
    byIds("users"),
    byIds("jobs"),
    z.strictObject({ source: z.literal("reports"), ids: selectIds }),
  ]),
  z
    .discriminatedUnion("source", [
      operatorCommentFilterSchema.extend(byFilter("comments")),
      operatorWorksFilterSchema.omit(noPage).extend(byFilter("works")),
      operatorUsersQuerySchema.omit(noPage).extend(byFilter("users")),
      operatorPublishingJobQuerySchema.omit(noPage).extend(byFilter("jobs")),
    ])
    .refine((query) =>
      rangeInOrder(
        query as { from?: string | undefined; to?: string | undefined },
      ),
    ),
]);
export type AiSelectQuery = z.infer<typeof aiSelectQuerySchema>;
/** By ids: what a preview stamps its targets with. */
export type AiSelectIdsQuery = Extract<
  AiSelectQuery,
  { readonly ids: readonly string[] }
>;

const fixedWord = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const aiSelectItemSchema = z.strictObject({
  id: z.string(),
  /** Content-free and opaque: the same at execution as at the preview, it has not moved. */
  stamp: z.string().min(1).max(128),
  /** What the row's write compares, where it takes one: a work's or a case's version. */
  version: z.number().int().nonnegative().optional(),
  /** Its state column now: a comment's moderation, a job's state, a user's status. */
  state: fixedWord.optional(),
  /** A comment's or a job's kind. */
  kind: fixedWord.optional(),
  /** The items a thread removal takes, its top-level comment included. */
  affected: z.number().int().positive().optional(),
  /** By ids alone: why this credential cannot act on the row. */
  withheld: z.enum(["self_only", "personal_info"]).optional(),
  /** By ids, with `movable`: the row is past what the op moves, so the op would refuse it. */
  immovable: z.literal(true).optional(),
});
export type AiSelectItem = z.infer<typeof aiSelectItemSchema>;

export const aiSelectResultSchema = z.strictObject({
  items: z.array(aiSelectItemSchema).max(AI_SELECT_FREEZE_MAX),
  /** By filter: where the next block starts, null once this one reached the end. */
  next: selectCursor.nullable().optional(),
  /** Named whatever the answer holds, with no count: withheld never reads as empty. */
  excluded: z.array(z.string()),
});
export type AiSelectResult = z.infer<typeof aiSelectResultSchema>;

/**
 * What a settlement names (admin-mcp-completion-v1 section 9). `item` is a job's own
 * subject, a media item or a Catalog asset, so it needs no community state and passes
 * on the base credential. The others name the record whose items an operation moved.
 */
export const AI_SETTLEMENT_TYPES = ["work", "article", "user", "item"] as const;
export type AiSettlementType = (typeof AI_SETTLEMENT_TYPES)[number];

export const aiSettlementQuerySchema = z.strictObject({
  type: z.enum(AI_SETTLEMENT_TYPES),
  id: operatorExactIdSchema,
  /** What the operation asked of the media. Withdrawal runs whatever the gates say. */
  intent: z.enum(["publish", "withdraw"]),
});
export type AiSettlementQuery = z.infer<typeof aiSettlementQuerySchema>;

export const aiSettlementResultSchema = z.strictObject({
  /** Jobs still to run, or running: the operation's media work is not done. */
  open: z.number().int().nonnegative(),
  /** Jobs that stopped since the operation, with no later one that succeeded. */
  failed: z.number().int().nonnegative(),
  /** The newest of those, for reading and retrying: content-free ids. */
  failedJobs: z.array(publishingJobIdSchema).max(3),
  /** Asked to publish with a gate shut: no job exists, and none will. */
  mediaGate: z.literal("off").optional(),
});
export type AiSettlementResult = z.infer<typeof aiSettlementResultSchema>;

/** The records a route can name by its first parameter, for the self-only check. */
export type AiOperatorSubject =
  | "work"
  | "comment"
  | "work_revision"
  | "article"
  | "report"
  | "publishing_job";

/** The Backend's AI-only reads, implemented in services/community-postgres. */
export interface AiOperatorReader {
  find(query: AiFindQuery): Promise<AiFindResult>;
  /** `timed_out`: no number, and the same call is worth repeating. */
  count(query: AiCountQuery): Promise<AiCountResult | "timed_out">;
  /**
   * The state of up to 100 named rows in one statement, a withheld one marked and never
   * left out unnamed. A row that is not there is absent. `timed_out` is no answer.
   */
  select(query: AiSelectIdsQuery): Promise<AiSelectResult | "timed_out">;
  /** A subject that did not answer is `timed_out` or a throw, and never a settled one. */
  settlement(
    query: AiSettlementQuery,
  ): Promise<AiSettlementResult | "timed_out" | "not_found" | "self_only">;
  /** Reads current visibility, so a flip is seen by the next call. */
  isSelfOnly(subject: AiOperatorSubject, id: string): Promise<boolean>;
  /** A `privacy` report on the reporter's own profile, as its columns stand now. */
  isPersonalInfoRequest(reportId: string): Promise<boolean>;
  /** This comment write's key has committed, so its route answers from the receipt. */
  hasCommentReceipt(requestId: string): Promise<boolean>;
}
