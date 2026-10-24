import { z } from "zod";
import { operatorModerationReasonSchema } from "./moderation-reason.js";

import {
  contentIdentitySchema,
  catalogCommentIdSchema,
  catalogIdSchema,
  publicUserHandleSchema,
  publicUserDisplayNameSchema,
  publicUserIdSchema,
  COMMENT_TEXT_MAXIMUM,
} from "../../schemas.js";

/**
 * Server-only operator boundary between the Owner's Payload Admin interface and
 * the Backend (amendment decision 4). Nothing here is a Public DTO, appears in
 * the OpenAPI document, or is reachable from a browser: the Backend serves it on
 * a loopback-only internal subpath behind an operator credential.
 */

/** The Owner-controlled global publication setting (decision 1). */
export const publicationPolicySchema = z.enum([
  "PRE_MODERATION",
  "DIRECT_PUBLICATION",
]);

/** Never a PublicUserId and never a Payload row id reused as public identity. */
export const operatorLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export const publicationPolicyStateSchema = z.strictObject({
  policy: publicationPolicySchema,
  updatedAt: z.iso.datetime({ offset: false }),
  updatedBy: operatorLabelSchema,
});

export const setPublicationPolicyCommandSchema = z.strictObject({
  policy: publicationPolicySchema,
});

export const commentModerationStateSchema = z.enum([
  "pending",
  "visible",
  "hidden",
]);

/**
 * The comment state machine, edge by edge: approve (pending -> visible),
 * reject (pending -> hidden, audited as its own action so a refusal is never
 * confused with taking down published content), hide (visible -> hidden),
 * unhide (hidden -> visible). The Backend enforces the edges; nothing deletes.
 */
export const commentModerationActionSchema = z.enum([
  "approve",
  "reject",
  "hide",
  "unhide",
]);

export const userModerationActionSchema = z.enum(["suspend", "reinstate"]);

/** The Backend command body: the subject id travels in the route, never here. */
export const moderateCommentCommandSchema = z.strictObject({
  reason: operatorModerationReasonSchema.optional(),
  action: commentModerationActionSchema,
});

export const moderateUserCommandSchema = z.strictObject({
  reason: operatorModerationReasonSchema.optional(),
  action: userModerationActionSchema,
});

/**
 * Platform-generated ids have one shape each; the Admin envelope refuses any
 * other before a route is built, so a stray value can never reach the Backend
 * as a subject id.
 */
const strictCommentIdSchema = catalogCommentIdSchema.refine(
  (id) => /^comment-[0-9a-f]{32}$/.test(id),
  { message: "not a platform comment id" },
);
const strictUserIdSchema = publicUserIdSchema.refine(
  (id) => /^user-[0-9a-f]{32}$/.test(id),
  { message: "not a platform user id" },
);

/** Selected items on one page only, never "every matching record". */
export const BULK_MODERATION_MAXIMUM = 50;

const distinctIds = (ids: readonly string[]): boolean =>
  new Set(ids).size === ids.length;

export const bulkModerateCommentsCommandSchema = z.strictObject({
  reason: operatorModerationReasonSchema.optional(),
  action: commentModerationActionSchema,
  ids: z
    .array(strictCommentIdSchema)
    .min(1)
    .max(BULK_MODERATION_MAXIMUM)
    .refine(distinctIds, { message: "ids must be distinct" }),
});

/**
 * The Admin request envelopes. Payload validates the complete envelope
 * strictly, maps the id into the Backend route and forwards only the command
 * body above. An unknown or extra field is rejected before any call is made.
 */
export const adminModerateCommentRequestSchema = z.strictObject({
  reason: operatorModerationReasonSchema,
  id: strictCommentIdSchema,
  action: commentModerationActionSchema,
});

export const adminModerateUserRequestSchema = z.strictObject({
  reason: operatorModerationReasonSchema,
  id: strictUserIdSchema,
  action: userModerationActionSchema,
});

export const adminBulkModerateCommentsRequestSchema =
  bulkModerateCommentsCommandSchema.extend({
    reason: operatorModerationReasonSchema,
  });

export const adminReadCommentRequestSchema = z.strictObject({
  id: strictCommentIdSchema,
});

export const bulkModerationOutcomeSchema = z.enum([
  "applied",
  "conflict",
  "not_found",
  "failed",
]);

/** Per-item truth: a conflict or failure never counts as applied. */
export const bulkModerationResultSchema = z.strictObject({
  action: commentModerationActionSchema,
  results: z
    .array(
      z.strictObject({
        id: catalogCommentIdSchema,
        outcome: bulkModerationOutcomeSchema,
        moderation: commentModerationStateSchema.optional(),
      }),
    )
    .max(BULK_MODERATION_MAXIMUM),
  applied: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  notFound: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export const operatorCommentKindSchema = z.enum(["comment", "reply"]);

export const operatorAuthorSchema = z.strictObject({
  id: publicUserIdSchema,
  handle: publicUserHandleSchema,
  displayName: publicUserDisplayNameSchema,
  status: z.enum(["active", "suspended"]),
});

/**
 * One review item: a root comment or a reply. The operator sees text and
 * state, never credentials. `catalogTitle` comes from the published Catalog
 * read side through the Backend; null when the record is no longer published.
 */
export const operatorCommentSchema = z.strictObject({
  id: catalogCommentIdSchema,
  kind: operatorCommentKindSchema,
  catalogId: catalogIdSchema.nullable(),
  target: contentIdentitySchema.optional(),
  contentTitle: z.string().nullable().optional(),
  bodyDeleted: z.boolean().optional(),
  threadRemoved: z.boolean().optional(),
  threadAffectedCount: z.number().int().positive().optional(),
  catalogTitle: z.string().min(1).max(500).nullable(),
  rootCommentId: catalogCommentIdSchema.optional(),
  /** The sibling reply this reply answers, when there is one. */
  replyToId: catalogCommentIdSchema.optional(),
  author: operatorAuthorSchema,
  text: z.string().min(1).max(COMMENT_TEXT_MAXIMUM),
  createdAt: z.iso.datetime({ offset: false }),
  moderation: commentModerationStateSchema,
});

const operatorPageSizeSchema = z.number().int().min(1).max(50);

/** Counts for the status tabs, under the same search and filters as the page. */
export const operatorQueueCountsSchema = z.strictObject({
  pending: z.number().int().min(0),
  visible: z.number().int().min(0),
  hidden: z.number().int().min(0),
  all: z.number().int().min(0),
});

export const operatorCommentPageSchema = z.strictObject({
  items: z.array(operatorCommentSchema),
  counts: operatorQueueCountsSchema,
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: operatorPageSizeSchema,
  totalPages: z.number().int().min(0),
});

export const OPERATOR_SEARCH_MAXIMUM = 100;

/**
 * Bounded review listing. Search is a plain server-side substring match over
 * comment text and the author's handle and display name; ordering is the
 * review order (newest or oldest first) and never the public hot ordering.
 * V1 has no keyword engine or scoring.
 */
export const operatorCommentQuerySchema = z.strictObject({
  moderation: commentModerationStateSchema.optional(),
  kind: operatorCommentKindSchema.optional(),
  catalogId: catalogIdSchema.optional(),
  search: z.string().trim().min(1).max(OPERATOR_SEARCH_MAXIMUM).optional(),
  order: z.enum(["newest", "oldest"]).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: operatorPageSizeSchema.optional(),
});

/** Every recorded moderation action, human or (in future) machine-attributed. */
export const moderationEventActionSchema = z.enum([
  "approve",
  "reject",
  "hide",
  "unhide",
  "suspend",
  "reinstate",
  "set_publication_policy",
  "delete_body",
  "remove_thread",
]);

export const moderationEventSubjectKindSchema = z.enum([
  "comment",
  "reply",
  "user",
  "setting",
]);

/** One authoritative audit record; the operator label is a server-side identity. */
export const moderationEventSchema = z.strictObject({
  id: z.string().regex(/^moderation-[0-9a-f]{32}$/),
  occurredAt: z.iso.datetime({ offset: false }),
  operatorLabel: operatorLabelSchema,
  action: moderationEventActionSchema,
  subjectKind: moderationEventSubjectKindSchema,
  subjectId: z.string().min(1).max(128),
  detail: z.string().min(1).max(200).optional(),
});

export const moderationEventPageSchema = z.strictObject({
  items: z.array(moderationEventSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: operatorPageSizeSchema,
  totalPages: z.number().int().min(0),
});

export const moderationEventQuerySchema = z.strictObject({
  subjectId: z.string().min(1).max(128).optional(),
  action: moderationEventActionSchema.optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: operatorPageSizeSchema.optional(),
});

/** A reply is never publicly visible past a root that is pending or hidden. */
export const parentRestrictionSchema = z.enum([
  "none",
  "root_pending",
  "root_hidden",
]);

/**
 * Machine analysis is advisory and provider-independent: it may recommend,
 * never act. A failed, skipped or stale run is not a clean verdict, and the
 * absence of a provider is reported as such rather than as "no findings".
 */
export const commentAnalysisStatusSchema = z.enum([
  "completed",
  "failed",
  "skipped",
  "stale",
]);

export const commentAnalysisRecommendationSchema = z.enum([
  "none",
  "approve",
  "review",
  "hide",
  "reject",
]);

export const commentAnalysisResultSchema = z.strictObject({
  targetId: catalogCommentIdSchema,
  targetKind: operatorCommentKindSchema,
  /** SHA-256 of the analysed text; a later edit makes the result stale. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  analyzer: z.strictObject({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
  }),
  runId: z.string().min(1).max(128),
  occurredAt: z.iso.datetime({ offset: false }),
  status: commentAnalysisStatusSchema,
  reasonCodes: z.array(z.string().min(1).max(64)).max(20),
  explanation: z.string().max(500),
  recommendation: commentAnalysisRecommendationSchema,
});

export const commentAnalysisStateSchema = z.union([
  z.strictObject({ status: z.literal("not_connected") }),
  z.strictObject({ status: z.literal("not_analyzed") }),
  commentAnalysisResultSchema,
]);

/** Item detail: full text, thread context, stored state, history, analysis state. */
export const operatorCommentDetailSchema = z.strictObject({
  item: operatorCommentSchema,
  root: operatorCommentSchema.nullable(),
  replyTo: operatorCommentSchema.nullable(),
  parentRestriction: parentRestrictionSchema,
  history: z.array(moderationEventSchema).max(50),
  analysis: commentAnalysisStateSchema,
});

export const moderationSummaryRangeSchema = z.enum(["24h", "7d", "30d"]);

/**
 * Small, explicit numbers: queue counts as of `generatedAt`, actions recorded
 * inside the range, and the last few events. Comment counts, action counts
 * and per-item failures are never mixed.
 */
export const moderationSummarySchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: false }),
  range: z.strictObject({
    key: moderationSummaryRangeSchema,
    from: z.iso.datetime({ offset: false }),
    to: z.iso.datetime({ offset: false }),
  }),
  policy: publicationPolicyStateSchema,
  queue: operatorQueueCountsSchema,
  actions: z.strictObject({
    approve: z.number().int().min(0),
    reject: z.number().int().min(0),
    hide: z.number().int().min(0),
    unhide: z.number().int().min(0),
    suspend: z.number().int().min(0),
    reinstate: z.number().int().min(0),
    set_publication_policy: z.number().int().min(0),
    delete_body: z.number().int().min(0).default(0),
    remove_thread: z.number().int().min(0).default(0),
  }),
  recentEvents: z.array(moderationEventSchema).max(10),
  analysis: z.strictObject({ connected: z.boolean() }),
});

export const moderationSummaryQuerySchema = z.strictObject({
  range: moderationSummaryRangeSchema.optional(),
});

export const moderationResultSchema = z.strictObject({
  id: catalogCommentIdSchema,
  moderation: commentModerationStateSchema,
});

export const userModerationResultSchema = z.strictObject({
  id: publicUserIdSchema,
  status: z.enum(["active", "suspended"]),
  revokedSessions: z.number().int().min(0),
});
