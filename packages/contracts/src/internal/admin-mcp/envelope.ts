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

export type AdminMcpCode = z.infer<typeof adminMcpCodeSchema>;
export type AdminMcpIssue = z.infer<typeof adminMcpIssueSchema>;
export type AdminMcpNext = z.infer<typeof adminMcpNextSchema>;
export type AdminMcpMeta = z.infer<typeof adminMcpMetaSchema>;
export type AdminMcpEnvelope = z.infer<typeof adminMcpEnvelopeSchema>;
