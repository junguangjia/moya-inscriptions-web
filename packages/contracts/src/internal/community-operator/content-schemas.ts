import { z } from "zod";
import {
  contentIdentitySchema,
  catalogCommentIdSchema,
} from "../../schemas.js";
const version = z.number().int().nonnegative().max(2147483647);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workId = z.string().regex(/^work-[0-9a-f]{32}$/u);
const userId = z.string().regex(/^user-[0-9a-f]{32}$/u);
const recommendationSchema = z.strictObject({
  enabled: z.boolean(),
  version,
  position,
  source: z.enum(["work", "user", "none"]),
});
export const operatorContentQuerySchema = z.strictObject({
  page: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(100000))
    .default(1),
  pageSize: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(50))
    .default(20),
  search: z.string().trim().max(200).default(""),
});
export const operatorWorksQuerySchema = operatorContentQuerySchema.extend({
  authorId: userId.optional(),
});
export const operatorFeaturedQuerySchema = operatorContentQuerySchema.extend({
  filter: z.enum(["all", "active"]).optional(),
});
export const operatorUsersQuerySchema = operatorContentQuerySchema.extend({
  userId: userId.optional(),
});
export const operatorUserSchema = z.strictObject({
  id: userId,
  handle: z.string(),
  displayName: z.string(),
  bio: z.string(),
  status: z.enum(["active", "suspended"]),
  createdAt: z.iso.datetime(),
  submittedWorks: z.number().int().nonnegative(),
  recommended: z.boolean(),
  recommendationVersion: version,
});
export const operatorUserPageSchema = z.strictObject({
  items: z.array(operatorUserSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export const recommendUserCommandSchema = z.strictObject({
  requestId: z.uuid(),
  id: userId,
  enabled: z.boolean(),
  expectedVersion: version,
});
export const operatorWorkSchema = z.strictObject({
  id: workId,
  title: z.string(),
  text: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorStatus: z.enum(["active", "suspended"]),
  state: z.enum(["visible", "hidden", "removed"]),
  authorDeleted: z.boolean(),
  version,
  /** Null for a work never publicly exposed (self-only or pending first submission). */
  firstPublishedAt: z.iso.datetime().nullable(),
  /** Only queue-readable immutable submissions; never a private draft. */
  latestSubmission: z
    .strictObject({
      revisionId: z.string().regex(/^work-revision-[0-9a-f]{32}$/u),
      title: z.string(),
      disposition: z.enum([
        "pending",
        "approved",
        "rejected",
        "superseded",
        "withdrawn",
      ]),
    })
    .nullable()
    .optional(),
  publicRevisionId: z
    .string()
    .regex(/^work-revision-[0-9a-f]{32}$/u)
    .nullable()
    .optional(),
  publiclyVisible: z.boolean().optional(),
  recommendation: recommendationSchema.optional(),
});
export const operatorWorkPageSchema = z.strictObject({
  items: z.array(operatorWorkSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export const moderateWorkCommandSchema = z.strictObject({
  requestId: z.uuid(),
  state: z.enum(["visible", "hidden", "removed"]),
  expectedVersion: version,
});
export const adminModerateWorkRequestSchema = moderateWorkCommandSchema.extend({
  id: workId,
});
export const featuredMutationSchema = z.strictObject({
  requestId: z.uuid(),
  target: contentIdentitySchema,
  enabled: z.boolean(),
  position,
  expectedVersion: version,
});
/** The same ceiling a prepared operation uses for its frozen target set. */
export const FEATURED_ORDER_MAXIMUM = 500;
export const featuredOrderItemSchema = z.strictObject({
  target: contentIdentitySchema,
  enabled: z.boolean(),
  position,
  expectedVersion: version,
});
/**
 * One ordered recommendation command (Issue #141 r6).
 *
 * "Recommend these works in this order" is a single business command, not a
 * collection of per-target writes: the whole set commits or none of it does.
 * This is the mechanism, so it applies exactly the positions it is given and
 * says nothing about intent: that the positions rise along the requested order
 * is checked where the order is requested, when the operation is prepared. An
 * undo restores the exact prior positions through this same command and is not
 * a new ordering request. Positions stay caller-chosen, which is the accepted
 * behaviour today; rows this command does not name keep their own positions
 * and therefore their own relative order.
 *
 * `expectedVersion` is the version the caller froze for that row (0 when it had
 * no row), so a concurrent change to any one of them refuses the whole command.
 */
export const featuredOrderCommandSchema = z.strictObject({
  requestId: z.uuid(),
  items: z
    .array(featuredOrderItemSchema)
    .min(1)
    .max(FEATURED_ORDER_MAXIMUM)
    .refine(
      (items) =>
        new Set(items.map((item) => `${item.target.type}:${item.target.id}`))
          .size === items.length,
      { message: "duplicate target" },
    ),
});
/** What the command actually committed, per target, in the requested order. */
export const featuredOrderEntrySchema = z.strictObject({
  target: contentIdentitySchema,
  enabled: z.boolean(),
  position,
  version,
  prior: z.strictObject({ enabled: z.boolean(), position, version }).nullable(),
});
export const featuredOrderResultSchema = z.strictObject({
  kind: z.literal("featured.order"),
  items: z.array(featuredOrderEntrySchema).min(1),
});

export const featuredSettingsMutationSchema = z.strictObject({
  requestId: z.uuid(),
  enabledQuantity: position.nullable(),
  expectedVersion: version,
});
export const featuredItemSchema = z.strictObject({
  target: contentIdentitySchema,
  title: z.string().nullable(),
  eligible: z.boolean(),
  enabled: z.boolean(),
  position,
  version,
});
export const featuredPageSchema = z.strictObject({
  items: z.array(featuredItemSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  enabledQuantity: position.nullable(),
  settingsVersion: version,
});
export const operatorDeleteBodySchema = z.strictObject({ requestId: z.uuid() });
export const operatorRemoveThreadSchema = z.strictObject({
  requestId: z.uuid(),
  expectedAffectedCount: z.number().int().positive(),
});
export const adminDeleteBodySchema = operatorDeleteBodySchema.extend({
  id: catalogCommentIdSchema.refine((id) => /^comment-[0-9a-f]{32}$/u.test(id)),
});
export const adminRemoveThreadSchema = operatorRemoveThreadSchema.extend({
  id: catalogCommentIdSchema.refine((id) => /^comment-[0-9a-f]{32}$/u.test(id)),
});
export type OperatorContentQuery = z.infer<typeof operatorContentQuerySchema>;
export type OperatorWorksQuery = z.infer<typeof operatorWorksQuerySchema>;
export type OperatorFeaturedQuery = z.infer<typeof operatorFeaturedQuerySchema>;
export type OperatorUsersQuery = z.infer<typeof operatorUsersQuerySchema>;
export type OperatorUser = z.infer<typeof operatorUserSchema>;
export type OperatorUserPage = z.infer<typeof operatorUserPageSchema>;
export type RecommendUserCommand = z.infer<typeof recommendUserCommandSchema>;
export type OperatorWork = z.infer<typeof operatorWorkSchema>;
export type OperatorWorkPage = z.infer<typeof operatorWorkPageSchema>;
export type ModerateWorkCommand = z.infer<typeof moderateWorkCommandSchema>;
export type FeaturedMutation = z.infer<typeof featuredMutationSchema>;
export type FeaturedOrderItem = z.infer<typeof featuredOrderItemSchema>;
export type FeaturedOrderCommand = z.infer<typeof featuredOrderCommandSchema>;
export type FeaturedOrderEntry = z.infer<typeof featuredOrderEntrySchema>;
export type FeaturedOrderResult = z.infer<typeof featuredOrderResultSchema>;
export type FeaturedSettingsMutation = z.infer<
  typeof featuredSettingsMutationSchema
>;
export type FeaturedPage = z.infer<typeof featuredPageSchema>;

// ---------------------------------------------------------------------------
// content-community-completion-v1: operator-managed Threads.
// ---------------------------------------------------------------------------
const threadId = z.string().regex(/^thread-[0-9a-f]{32}$/u);
const threadTitle = z.string().trim().min(1).max(120);
const threadDescription = z.string().max(2000);
const threadTags = z.array(z.string().trim().min(1).max(24)).max(6);
export const operatorThreadSchema = z.strictObject({
  id: threadId,
  title: threadTitle,
  description: threadDescription,
  tags: threadTags,
  status: z.enum(["open", "closed"]),
  hidden: z.boolean(),
  position: z.number().int(),
  version,
  postCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const operatorThreadPageSchema = z.strictObject({
  items: z.array(operatorThreadSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export const operatorThreadsQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  includeHidden: z.coerce.boolean().default(true),
});
export const createThreadCommandSchema = z.strictObject({
  requestId: z.uuid(),
  title: threadTitle,
  description: threadDescription.default(""),
  tags: threadTags.default([]),
  position: z.number().int().default(0),
});
export const updateThreadCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: version,
  title: threadTitle.optional(),
  description: threadDescription.optional(),
  tags: threadTags.optional(),
  status: z.enum(["open", "closed"]).optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().optional(),
});
/** Admin envelope: the id travels in the route on the Backend side. */
export const adminUpdateThreadRequestSchema = updateThreadCommandSchema.extend({
  id: threadId,
});
export type OperatorThread = z.infer<typeof operatorThreadSchema>;
export type OperatorThreadPage = z.infer<typeof operatorThreadPageSchema>;
export type CreateThreadCommand = z.infer<typeof createThreadCommandSchema>;
export type UpdateThreadCommand = z.infer<typeof updateThreadCommandSchema>;

// ---------------------------------------------------------------------------
// content-community-completion-v1: narrow Owner-only DM moderation shapes.
// Access is always to one explicitly selected conversation with a stated
// purpose; no search across private messages exists.
// ---------------------------------------------------------------------------
const dmConversationId = z.string().regex(/^dm-[0-9a-f]{32}$/u);
const dmMessageId = z.string().regex(/^dmsg-[0-9a-f]{32}$/u);
export const operatorDmPurposeSchema = z.string().trim().min(1).max(500);
export const operatorDmMessageSchema = z.strictObject({
  id: dmMessageId,
  sequence: z.number().int().positive(),
  senderId: userId,
  senderName: z.string(),
  text: z.string().nullable(),
  removed: z.boolean(),
  removedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const operatorDmConversationSchema = z.strictObject({
  id: dmConversationId,
  participants: z
    .array(
      z.strictObject({
        id: userId,
        displayName: z.string(),
        status: z.enum(["active", "suspended"]),
      }),
    )
    .length(2),
  initiatorId: userId,
  state: z.enum(["requested", "active"]),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  messages: z.array(operatorDmMessageSchema).max(200),
});
export const operatorDmReadRequestSchema = z.strictObject({
  id: dmConversationId,
  purpose: operatorDmPurposeSchema,
});
export const operatorDmLookupRequestSchema = z.strictObject({
  /** Both participant ids: the only way to find a conversation without an id. */
  userIds: z.array(userId).length(2),
  purpose: operatorDmPurposeSchema,
});
export const operatorRemoveDmMessageCommandSchema = z.strictObject({
  requestId: z.uuid(),
  purpose: operatorDmPurposeSchema,
});
export const adminRemoveDmMessageRequestSchema =
  operatorRemoveDmMessageCommandSchema.extend({
    id: dmMessageId,
  });
export type OperatorDmConversation = z.infer<
  typeof operatorDmConversationSchema
>;
export type OperatorDmMessage = z.infer<typeof operatorDmMessageSchema>;
