import { z } from "zod";

import { contentIdentitySchema, publicUserIdSchema } from "../../schemas.js";
import {
  commentModerationActionSchema,
  operatorLabelSchema,
} from "./schemas.js";

/**
 * Agent Administration V1 (Issue #141 r3, Phase B). Server-only shapes shared
 * by the Backend agent boundary, the Payload MCP adapter and the Owner-only
 * operations view. Nothing here is a Public DTO or reaches OpenAPI.
 *
 * A machine principal is an operator label with the `agent-` prefix: it is
 * recorded on every audit row and receipt exactly like the Owner's label, and
 * it is never a PublicUserId or a Payload row id. Scopes are enforced by the
 * Backend on every call; the Admin only asserts which principal is calling.
 */

/** Every operation is frozen at preparation; this is the ceiling per operation. */
export const AGENT_OPERATION_TARGET_MAXIMUM = 500;
/** Targets are executed and persisted in chunks of at most this many. */
export const AGENT_OPERATION_CHUNK_SIZE = 50;
/** A prepared operation that nobody approves is refused after this long. */
export const AGENT_OPERATION_PREPARED_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export const agentPrincipalLabelSchema = operatorLabelSchema.refine(
  (label) => /^agent-[a-z0-9-]{2,57}$/u.test(label),
  { message: "an agent principal label starts with agent-" },
);

export const agentScopeSchema = z.enum([
  "users:read",
  "content:read",
  "comments:read",
  "comments:moderate",
  "featured:write",
  "operations:execute",
  "operations:undo",
]);

const isoDateTime = z.iso.datetime({ offset: false });
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const agentPrincipalSchema = z.strictObject({
  label: agentPrincipalLabelSchema,
  displayName: z.string().min(1).max(80),
  scopes: z.array(agentScopeSchema).max(7),
  enabled: z.boolean(),
  version,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
});

/** Owner-only: create or change a principal; a revoked principal stays revoked. */
export const agentPrincipalMutationSchema = z.strictObject({
  requestId: z.uuid(),
  label: agentPrincipalLabelSchema,
  displayName: z.string().min(1).max(80),
  scopes: z.array(agentScopeSchema).max(7),
  enabled: z.boolean(),
  /** 0 creates; otherwise the version last read. */
  expectedVersion: version,
});

export const agentPrincipalRevokeSchema = z.strictObject({
  requestId: z.uuid(),
  label: agentPrincipalLabelSchema,
  expectedVersion: version,
});

export const agentOperationKindSchema = z.enum([
  "comments.moderate",
  "featured.set",
]);

/**
 * A bounded, persisted, revocable delegation: while it is active a principal's
 * prepared operation of this kind with at most `maxTargets` targets is
 * approved without an Owner click. It never covers future comments: an
 * operation still names a fixed, frozen selection.
 */
export const agentDelegationSchema = z.strictObject({
  id: z.uuid(),
  principal: agentPrincipalLabelSchema,
  kind: agentOperationKindSchema,
  maxTargets: z.number().int().min(1).max(AGENT_OPERATION_TARGET_MAXIMUM),
  expiresAt: isoDateTime,
  createdBy: operatorLabelSchema,
  createdAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  revokedBy: operatorLabelSchema.nullable(),
});

export const agentDelegationCreateSchema = z.strictObject({
  requestId: z.uuid(),
  principal: agentPrincipalLabelSchema,
  kind: agentOperationKindSchema,
  maxTargets: z.number().int().min(1).max(AGENT_OPERATION_TARGET_MAXIMUM),
  expiresAt: isoDateTime,
});

export const agentDelegationRevokeSchema = z.strictObject({
  requestId: z.uuid(),
  id: z.uuid(),
});

export const agentOperationStateSchema = z.enum([
  "prepared",
  "approved",
  "executing",
  "completed",
  "cancelled",
  "failed",
]);

export const agentTargetOutcomeSchema = z.enum([
  "applied",
  "conflict",
  "not_found",
  "failed",
  "cancelled",
]);

export const agentCommentIdSchema = z
  .string()
  .regex(/^comment-[0-9a-f]{32}$/u, "not a platform comment id");

const commentModerationStateSchema = z.enum(["pending", "visible", "hidden"]);

/** A frozen comment target with the state observed at preparation. */
export const agentCommentTargetSchema = z.strictObject({
  id: agentCommentIdSchema,
  prior: commentModerationStateSchema.nullable(),
  /** Which table the target lives in; absent on operations prepared before r4. */
  kind: z.enum(["comment", "reply"]).optional(),
  /** Content evidence: first 16 hex of sha256(body) at preparation. */
  textSha: z
    .string()
    .regex(/^[0-9a-f]{16}$/u)
    .optional(),
});

const featuredPosition = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A frozen recommendation target with the row observed at preparation (null: no row). */
export const agentFeaturedTargetSchema = z.strictObject({
  target: contentIdentitySchema,
  enabled: z.boolean(),
  position: featuredPosition,
  prior: z
    .strictObject({
      enabled: z.boolean(),
      position: featuredPosition,
      version,
    })
    .nullable(),
});

export const agentOperationTargetSchema = z.union([
  agentCommentTargetSchema,
  agentFeaturedTargetSchema,
]);

export const agentOperationResultSchema = z.strictObject({
  index: z.number().int().min(0),
  id: z.string().min(1).max(128),
  outcome: agentTargetOutcomeSchema,
  /** The version or state after an applied item; a bare code otherwise. */
  detail: z.string().max(200).nullable(),
});

export const agentOperationApprovalSchema = z.strictObject({
  kind: z.enum(["owner", "delegation"]),
  by: operatorLabelSchema,
  delegationId: z.uuid().nullable(),
  at: isoDateTime,
});

export const agentOperationTallySchema = z.strictObject({
  applied: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  notFound: z.number().int().min(0),
  failed: z.number().int().min(0),
  cancelled: z.number().int().min(0),
});

/**
 * Keyword manifest (r4). A comment job names its targets in one of two modes.
 * `ids` is the original caller-enumerated list. `query` asks the Backend to
 * build the membership itself from a body-only literal search, freeze it and
 * persist it. The two modes are separate strict shapes, so a command that
 * carries both an id list and a selector matches neither and is refused.
 */
export const agentCommentMatchSchema = z.enum(["any", "all"]);
export const agentCommentScopeSchema = z.enum(["comments", "replies", "both"]);

/** Terms are literal Unicode substrings: %, _ and backslash carry no meaning. */
const agentCommentTermSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((term) => term.trim() === term && term.length > 0, {
    message: "a term is trimmed and non-empty",
  });

export const AGENT_MANIFEST_TERM_MAXIMUM = 10;
/**
 * The frozen membership ceiling of one manifest. It equals the per-operation
 * target ceiling on purpose: a manifest becomes one operation. It is a
 * different limit from the per-delegation ceiling (which never grows because a
 * manifest is larger), the per-chunk size (50) and the result page size.
 */
export const AGENT_MANIFEST_TARGET_MAXIMUM = AGENT_OPERATION_TARGET_MAXIMUM;
/** Bounded preview sample returned with a prepared manifest. */
export const AGENT_MANIFEST_SAMPLE_SIZE = 10;
/** Bounded page size for protected retrieval of frozen targets. */
export const AGENT_TARGET_PAGE_MAXIMUM = 100;

export const agentCommentQuerySelectorSchema = z.strictObject({
  terms: z
    .array(agentCommentTermSchema)
    .min(1)
    .max(AGENT_MANIFEST_TERM_MAXIMUM)
    .refine((terms) => new Set(terms).size === terms.length, {
      message: "duplicate term",
    }),
  match: agentCommentMatchSchema.default("any"),
  /** Exact Catalog or Work identity; never a name. */
  target: contentIdentitySchema.optional(),
  /** Exact author id. Mutually exclusive with authorHandle. */
  authorId: publicUserIdSchema.optional(),
  /** Exact handle, resolved to a stable id before matching. */
  authorHandle: z.string().min(1).max(64).optional(),
  scope: agentCommentScopeSchema.default("both"),
  moderation: commentModerationStateSchema.optional(),
  /** Explicit half-open interval in UTC; no range is invented when omitted. */
  createdFrom: z.iso.datetime({ offset: false }).optional(),
  createdTo: z.iso.datetime({ offset: false }).optional(),
});

/** One bounded preview row; the excerpt is a short body slice, never the thread. */
export const agentManifestSampleSchema = z.strictObject({
  id: agentCommentIdSchema,
  kind: z.enum(["comment", "reply"]),
  excerpt: z.string().max(160),
});

/**
 * The canonical, immutable record of how a manifest was built. Persisted with
 * the operation so the approval view and any later audit read the same thing
 * the Backend matched on.
 */
export const agentManifestCriteriaSchema = z.strictObject({
  kind: z.literal("comments.keyword"),
  terms: z.array(agentCommentTermSchema).min(1),
  match: agentCommentMatchSchema,
  scope: agentCommentScopeSchema,
  target: contentIdentitySchema.nullable(),
  authorId: publicUserIdSchema.nullable(),
  /** How the author was named before resolution, when a handle was used. */
  authorHandle: z.string().nullable(),
  moderation: commentModerationStateSchema.nullable(),
  createdFrom: z.iso.datetime({ offset: false }).nullable(),
  createdTo: z.iso.datetime({ offset: false }).nullable(),
  /** Stated explicitly so a preview never hides an assumed default. */
  interpretation: z.strictObject({
    field: z.literal("body"),
    matching: z.literal("literal-substring"),
    caseSensitive: z.literal(false),
    /**
     * No Unicode normalization is applied: matching compares the stored code
     * points after SQL `lower()`, so differently normalized forms of the same
     * grapheme (NFC vs NFD) do not match each other.
     */
    normalization: z.literal("none"),
    timezone: z.literal("UTC"),
    defaults: z.array(z.string()),
  }),
  preparedAt: z.iso.datetime({ offset: false }),
  matchCount: z.number().int().min(0),
  sample: z.array(agentManifestSampleSchema),
});

export const agentUserMatchKindSchema = z.enum([
  "id",
  "handle",
  "display_name",
  "substring",
]);

/**
 * Exact-match-first resolution (r4). `exact` means a unique id or handle hit:
 * the only evidence strong enough to drive a name-based mutation. A single
 * display-name hit is `candidates`, because display names are not unique.
 */
export const agentUserResolutionStatusSchema = z.enum([
  "exact",
  "candidates",
  "none",
]);

export const agentUserCandidateSchema = z.strictObject({
  id: publicUserIdSchema,
  handle: z.string(),
  displayName: z.string(),
  status: z.enum(["active", "suspended", "deleted"]),
  matchKind: agentUserMatchKindSchema,
});

export const agentUserResolutionSchema = z.strictObject({
  status: agentUserResolutionStatusSchema,
  /** True only for a unique exact id or handle hit. */
  uniqueIdentity: z.boolean(),
  matchKind: agentUserMatchKindSchema.nullable(),
  userId: publicUserIdSchema.nullable(),
  ambiguous: z.boolean(),
});

export const agentUserLookupQuerySchema = z.strictObject({
  /** Free-text discovery; ranked exact id, exact handle, exact name, substring. */
  search: z.string().max(200).optional(),
  /** Exact id only; a miss is never a licence to fall back to a similar account. */
  userId: publicUserIdSchema.optional(),
  /** Exact normalized handle only; no display-name fallback. */
  handle: z.string().min(1).max(64).optional(),
  /**
   * Paging arrives either as a number from a Backend caller or as text from a
   * query string, exactly as the operator content query accepts it. Accepting
   * both here keeps every refusal the strict object provides: a malformed,
   * repeated or unknown parameter is still an invalid command rather than a
   * silent default.
   */
  page: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(10_000))
    .default(1),
  pageSize: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(50))
    .default(20),
});

export const agentUserLookupPageSchema = z.strictObject({
  items: z.array(agentUserCandidateSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  resolution: agentUserResolutionSchema,
});

export const agentOperationTargetPageSchema = z.strictObject({
  operationId: z.uuid(),
  items: z.array(agentOperationTargetSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

export const agentOperationSchema = z.strictObject({
  id: z.uuid(),
  principal: agentPrincipalLabelSchema,
  requestId: z.uuid(),
  kind: agentOperationKindSchema,
  /** The comment transition for `comments.moderate`; null for `featured.set`. */
  action: commentModerationActionSchema.nullable(),
  state: agentOperationStateSchema,
  approval: agentOperationApprovalSchema.nullable(),
  undoOf: z.uuid().nullable(),
  /** The frozen keyword manifest, when the operation was prepared by query. */
  criteria: agentManifestCriteriaSchema.nullable(),
  targetCount: z.number().int().min(1).max(AGENT_OPERATION_TARGET_MAXIMUM),
  nextIndex: z.number().int().min(0),
  results: z.array(agentOperationResultSchema),
  tally: agentOperationTallySchema,
  version,
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  approvedAt: isoDateTime.nullable(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  cancelRequestedAt: isoDateTime.nullable(),
  /** Whether an executor currently holds the lease (a second executor waits). */
  leaseHeld: z.boolean(),
});

export const agentOperationDetailSchema = agentOperationSchema.extend({
  /** The canonical command fingerprint this operation was created from. */
  fingerprint: z.string().min(1),
  targets: z.array(agentOperationTargetSchema),
});

export const agentPrepareCommentsIdsCommandSchema = z.strictObject({
  requestId: z.uuid(),
  action: commentModerationActionSchema,
  ids: z
    .array(agentCommentIdSchema)
    .min(1)
    .max(AGENT_OPERATION_TARGET_MAXIMUM)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "duplicate target",
    }),
});

export const agentPrepareCommentsQueryCommandSchema = z.strictObject({
  requestId: z.uuid(),
  action: commentModerationActionSchema,
  selector: agentCommentQuerySelectorSchema,
});

/**
 * Exactly one selection mode. Both shapes are strict, so a command carrying
 * `ids` and `selector` together matches neither branch and is refused rather
 * than silently preferring one.
 */
export const agentPrepareCommentsCommandSchema = z.union([
  agentPrepareCommentsIdsCommandSchema,
  agentPrepareCommentsQueryCommandSchema,
]);

export const agentPrepareFeaturedCommandSchema = z.strictObject({
  requestId: z.uuid(),
  items: z
    .array(
      z.strictObject({
        target: contentIdentitySchema,
        enabled: z.boolean(),
        position: featuredPosition,
      }),
    )
    .min(1)
    .max(AGENT_OPERATION_TARGET_MAXIMUM)
    .refine(
      (items) =>
        new Set(items.map((item) => `${item.target.type}:${item.target.id}`))
          .size === items.length,
      { message: "duplicate target" },
    )
    // The array order is the requested recommendation order, so the positions
    // of the items being recommended must rise strictly along it. A command
    // whose positions contradict its own order is refused at preparation
    // rather than silently reordered at execution.
    .refine(
      (items) => {
        const requested = items.filter((item) => item.enabled);
        return requested.every(
          (item, index) =>
            index === 0 || requested[index - 1]!.position < item.position,
        );
      },
      {
        message:
          "recommended positions must rise strictly along the requested order",
      },
    ),
});

/** Execute, cancel, approve and prepare-undo all name one operation. */
export const agentOperationCommandSchema = z.strictObject({
  requestId: z.uuid(),
  operationId: z.uuid(),
});

export const agentOperationReadSchema = z.strictObject({
  operationId: z.uuid(),
  /** Protected paginated retrieval of the frozen membership. */
  targetsPage: z.number().int().min(1).max(10_000).optional(),
  targetsPageSize: z
    .number()
    .int()
    .min(1)
    .max(AGENT_TARGET_PAGE_MAXIMUM)
    .optional(),
});

export const agentOperationQuerySchema = z.strictObject({
  state: agentOperationStateSchema.optional(),
  principal: agentPrincipalLabelSchema.optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const agentOperationPageSchema = z.strictObject({
  items: z.array(agentOperationSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

export const agentPrincipalPageSchema = z.strictObject({
  items: z.array(agentPrincipalSchema),
});

export const agentDelegationPageSchema = z.strictObject({
  items: z.array(agentDelegationSchema),
});

export const agentDelegationQuerySchema = z.strictObject({
  principal: agentPrincipalLabelSchema.optional(),
  includeInactive: z.boolean().default(false),
});

export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentPrincipal = z.infer<typeof agentPrincipalSchema>;
export type AgentPrincipalMutation = z.infer<
  typeof agentPrincipalMutationSchema
>;
export type AgentPrincipalRevoke = z.infer<typeof agentPrincipalRevokeSchema>;
export type AgentOperationKind = z.infer<typeof agentOperationKindSchema>;
export type AgentDelegation = z.infer<typeof agentDelegationSchema>;
export type AgentDelegationCreate = z.infer<typeof agentDelegationCreateSchema>;
export type AgentDelegationRevoke = z.infer<typeof agentDelegationRevokeSchema>;
export type AgentDelegationQuery = z.infer<typeof agentDelegationQuerySchema>;
export type AgentOperationState = z.infer<typeof agentOperationStateSchema>;
export type AgentTargetOutcome = z.infer<typeof agentTargetOutcomeSchema>;
export type AgentCommentTarget = z.infer<typeof agentCommentTargetSchema>;
export type AgentFeaturedTarget = z.infer<typeof agentFeaturedTargetSchema>;
export type AgentOperationTarget = z.infer<typeof agentOperationTargetSchema>;
export type AgentOperationResult = z.infer<typeof agentOperationResultSchema>;
export type AgentOperationApproval = z.infer<
  typeof agentOperationApprovalSchema
>;
export type AgentOperationTally = z.infer<typeof agentOperationTallySchema>;
export type AgentOperation = z.infer<typeof agentOperationSchema>;
export type AgentOperationDetail = z.infer<typeof agentOperationDetailSchema>;
export type AgentPrepareCommentsCommand = z.infer<
  typeof agentPrepareCommentsCommandSchema
>;
export type AgentPrepareFeaturedCommand = z.infer<
  typeof agentPrepareFeaturedCommandSchema
>;
export type AgentOperationCommand = z.infer<typeof agentOperationCommandSchema>;
export type AgentOperationRead = z.infer<typeof agentOperationReadSchema>;
export type AgentOperationQuery = z.infer<typeof agentOperationQuerySchema>;
export type AgentOperationPage = z.infer<typeof agentOperationPageSchema>;
export type AgentPrincipalPage = z.infer<typeof agentPrincipalPageSchema>;
export type AgentDelegationPage = z.infer<typeof agentDelegationPageSchema>;
export type AgentCommentMatch = z.infer<typeof agentCommentMatchSchema>;
export type AgentCommentScope = z.infer<typeof agentCommentScopeSchema>;
export type AgentCommentQuerySelector = z.infer<
  typeof agentCommentQuerySelectorSchema
>;
export type AgentManifestSample = z.infer<typeof agentManifestSampleSchema>;
export type AgentManifestCriteria = z.infer<typeof agentManifestCriteriaSchema>;
export type AgentUserMatchKind = z.infer<typeof agentUserMatchKindSchema>;
export type AgentUserCandidate = z.infer<typeof agentUserCandidateSchema>;
export type AgentUserResolution = z.infer<typeof agentUserResolutionSchema>;
export type AgentUserLookupQuery = z.infer<typeof agentUserLookupQuerySchema>;
export type AgentUserLookupPage = z.infer<typeof agentUserLookupPageSchema>;
export type AgentOperationTargetPage = z.infer<
  typeof agentOperationTargetPageSchema
>;
