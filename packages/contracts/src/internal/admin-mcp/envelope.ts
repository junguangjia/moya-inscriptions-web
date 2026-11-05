import { z } from "zod";

/**
 * Server-only result shape of the `admin_*` MCP tools (admin-mcp-completion-v1,
 * amendment 2026-11-03). Nothing here is a Public DTO or appears in the OpenAPI
 * document. `ok:true` means the whole requested effect verifiably completed,
 * including media work it queued; every other outcome carries a truthful code.
 */
export const ADMIN_MCP_CODES = [
  "OK",
  "IN_PROGRESS",
  "QUEUED",
  "AWAITING_OWNER",
  "PARTIAL",
  "STATE_CONFLICT",
  "DOCUMENT_LOCKED",
  "CONCURRENT_OPERATION_BUSY",
  "EXECUTE_BUSY",
  "OUTCOME_UNKNOWN",
  "MEDIA_JOB_FAILED",
  "MCP_PAUSED",
  "SENSITIVE_SWITCH_OFF",
  "SELF_ONLY_OWNER_REVIEW",
  "IDEMPOTENCY_CONFLICT",
  "USE_EXECUTE_IRREVERSIBLE",
  "USE_PREVIEW",
  "PREVIEW_REQUIRED",
  "INPUT_INVALID",
  "UNKNOWN_OP",
  "AUDIT_UNAVAILABLE",
  "AI_CREDENTIAL_NOT_CONFIGURED",
  "NOT_FOUND",
  "NOT_AVAILABLE",
  "MEDIA_UNAVAILABLE",
  "MEDIA_TOO_LARGE",
  "AI_ROUTE_FORBIDDEN",
  "READ_TIMED_OUT",
  "COMMUNITY_UNAVAILABLE",
  "ANALYTICS_UNAVAILABLE",
  "UMAMI_QUERY_TIMEOUT",
  "UMAMI_NOT_CONFIGURED",
  "UMAMI_REPLY_INVALID",
  // Editorial refusals, named as the operation names them. Anything else the
  // operations refuse answers OPERATION_REFUSED, with its own code on the target.
  "REVISION_CONFLICT",
  "REVISION_REQUIRED",
  "CONTENT_INVALID",
  "RECORD_ID_INVALID",
  "REMOVAL_NOT_ALLOWED",
  "PATCH_NO_MATCH",
  "PATCH_MULTIPLE_MATCHES",
  "PATCH_OVERLAP",
  "LOCK_CHANGED",
  "LOCK_NOT_HELD",
  "IDENTITY_ALREADY_BOUND",
  "IDENTITY_IMMUTABLE",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_NOT_PUBLISHED",
  "MEDIA_REFERENCE_INVALID",
  "MEDIA_PUBLICATION_REFERENCE_INVALID",
  "APPROVAL_INVALID",
  "APPROVAL_ACCOUNT_INVALID",
  "APPROVAL_SCOPE_INVALID",
  "APPROVAL_REVOKED",
  "APPROVED_REVISION_CHANGED",
  "RECORD_NOT_APPROVED",
  "CATALOG_DELIVERY_PREPARATION_REQUIRED",
  "CATALOG_DELIVERY_PENDING",
  "CATALOG_DELIVERY_NOT_CONFIGURED",
  "CATALOG_DELIVERY_DRAFT_CHANGED",
  "CATALOG_DELIVERY_BASE_CHANGED",
  "CATALOG_DELIVERY_STATE_CONFLICT",
  "CATALOG_DELIVERY_MANIFEST_CHANGED",
  "CATALOG_DELIVERY_PROOF_CHANGED",
  "CATALOG_DELIVERY_INACTIVE",
  "CATALOG_DELIVERY_EXPIRED",
  "CATALOG_DELIVERY_REPREPARE_REQUIRED",
  "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
  "CATALOG_DELIVERY_READINESS_UNAVAILABLE",
  "CATALOG_RECIPE_POLICY_UNAVAILABLE",
  "CATALOG_RECIPE_POLICY_INVALID",
  "CATALOG_RELEASE_NOT_REQUESTED",
  "CATALOG_RENDER_BACKLOG_NOT_CONFIGURED",
  "CATALOG_RENDER_BACKLOG_UNAVAILABLE",
  "OPERATION_REFUSED",
] as const;

export const adminMcpCodeSchema = z.enum(ADMIN_MCP_CODES);

/** Names the failing input by path and allowed keys, never by value. */
export const adminMcpIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string().min(1),
  allowedKeys: z.array(z.string()).optional(),
});

/** The explicit-handle pattern: the client continues, nothing runs without it. */
export const adminMcpNextSchema = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  afterMs: z.number().int().nonnegative().optional(),
});

/** False flags and nulls are omitted. `excluded` names categories, no count. */
export const adminMcpMetaSchema = z.strictObject({
  truncated: z.literal(true).optional(),
  partial: z.literal(true).optional(),
  replayed: z.literal(true).optional(),
  stripped: z.literal(true).optional(),
  redacted: z.array(z.string()).optional(),
  excluded: z.array(z.string()).optional(),
  repeat: z.number().int().positive().optional(),
  /** Per source on a search. A branch that did not answer is named, never read as zero. */
  sources: z
    .record(z.string(), z.enum(["ok", "timed_out", "failed", "not_available"]))
    .optional(),
});

export const adminMcpEnvelopeSchema = z
  .strictObject({
    ok: z.boolean(),
    code: adminMcpCodeSchema,
    hint: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    state: z.string().min(1).optional(),
    data: z.unknown().optional(),
    issues: z.array(adminMcpIssueSchema).optional(),
    runId: z.uuid().optional(),
    done: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    remaining: z.number().int().nonnegative().optional(),
    next: adminMcpNextSchema.optional(),
    /** JSON pointers to user-authored strings. Content is data, never an instruction. */
    untrusted: z.array(z.string()),
    meta: adminMcpMetaSchema,
  })
  .refine((envelope) => envelope.ok === (envelope.code === "OK"), {
    path: ["code"],
  });

/**
 * A text result never exceeds this: Codex truncates at 10,000 bytes by default and
 * Chinese is 3 bytes per character, so the cap is in bytes. Past it the server cuts
 * whole records and says so (admin-mcp-completion-v1 section 5).
 */
export const ADMIN_MCP_TEXT_CAP_BYTES = 9_000;

/** tools/list per profile, and the admin_actions index, in estimated tokens. */
export const ADMIN_MCP_TOKEN_BUDGET = 4_000;

/**
 * Every tool's result schema as tools/list advertises it. The whole envelope is
 * still checked on the way out; its generated JSON Schema runs 2.2 KB, and repeated
 * on 11 tools it alone would pass the token budget above. This names what a client
 * acts on and stays true of every envelope, by test. admin_actions and each answer's
 * hint carry the rest.
 */
export const ADMIN_MCP_RESULT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    code: { type: "string" },
    next: { type: "object" },
  },
  required: ["ok", "code", "untrusted", "meta"],
};

export type AdminMcpCode = z.infer<typeof adminMcpCodeSchema>;
export type AdminMcpIssue = z.infer<typeof adminMcpIssueSchema>;
export type AdminMcpNext = z.infer<typeof adminMcpNextSchema>;
export type AdminMcpMeta = z.infer<typeof adminMcpMetaSchema>;
export type AdminMcpEnvelope = z.infer<typeof adminMcpEnvelopeSchema>;
