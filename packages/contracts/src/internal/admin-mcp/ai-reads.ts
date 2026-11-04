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

/** The records a route can name by its first parameter, for the self-only check. */
export type AiOperatorSubject =
  "work" | "comment" | "work_revision" | "article";

/** The Backend's AI-only reads, implemented in services/community-postgres. */
export interface AiOperatorReader {
  find(query: AiFindQuery): Promise<AiFindResult>;
  /** `timed_out`: no number, and the same call is worth repeating. */
  count(query: AiCountQuery): Promise<AiCountResult | "timed_out">;
  /** Reads current visibility, so a flip is seen by the next call. */
  isSelfOnly(subject: AiOperatorSubject, id: string): Promise<boolean>;
}
