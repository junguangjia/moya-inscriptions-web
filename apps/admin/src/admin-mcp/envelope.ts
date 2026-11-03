import { adminMcpEnvelopeSchema } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpCode,
  AdminMcpCodeGuide,
  AdminMcpEnvelope,
  AdminMcpIssue,
} from "@moya/contracts/internal/admin-mcp";

/**
 * Fixed English, so a hint never carries user content. `retryable` says whether
 * repeating the same call can change the answer; false is omitted on the wire.
 */
export const CODE_GUIDE: AdminMcpCodeGuide = {
  OK: {
    hint: "The whole requested effect completed, including media work it queued.",
    retryable: false,
  },
  IN_PROGRESS: {
    hint: "The call budget ran out with work remaining. Call next to continue; nothing runs without you.",
    retryable: true,
  },
  QUEUED: {
    hint: "The state committed and media work is still open. Follow next until it settles; do not repeat the write with a new requestId.",
    retryable: true,
  },
  AWAITING_OWNER: {
    hint: "This run waits for one Owner confirmation on the control page. No key can confirm it.",
    retryable: false,
  },
  PARTIAL: {
    hint: "Some targets did not complete. Read the per-target outcomes and act only on the ones that failed.",
    retryable: false,
  },
  STATE_CONFLICT: {
    hint: "The target changed since it was read. Read it again before deciding.",
    retryable: false,
  },
  DOCUMENT_LOCKED: {
    hint: "Someone holds this document open. Wait for the lock to expire or take it over.",
    retryable: false,
  },
  CONCURRENT_OPERATION_BUSY: {
    hint: "Another operation holds this target. Retry shortly with the same requestId.",
    retryable: true,
  },
  OUTCOME_UNKNOWN: {
    hint: "The write may or may not have committed. Retrying with the same requestId is safe.",
    retryable: true,
  },
  MEDIA_JOB_FAILED: {
    hint: "The state committed but a media job failed. Read the job before retrying it.",
    retryable: false,
  },
  MCP_PAUSED: {
    hint: "The Owner paused MCP. Only admin_whoami works until the Owner resumes it.",
    retryable: false,
  },
  SENSITIVE_SWITCH_OFF: {
    hint: "This category is off behind an Owner-only switch. Retrying cannot open it.",
    retryable: false,
  },
  SELF_ONLY_OWNER_REVIEW: {
    hint: "This case concerns a self-only work and stays in the Owner's queue.",
    retryable: false,
  },
  IDEMPOTENCY_CONFLICT: {
    hint: "This requestId was used with a different payload. Resend the original payload or use a new requestId.",
    retryable: false,
  },
  USE_EXECUTE_IRREVERSIBLE: {
    hint: "This op is irreversible. Preview it, then call admin_execute_irreversible with the previewId.",
    retryable: false,
  },
  USE_PREVIEW: {
    hint: "This op needs a preview first. Call admin_preview with the same input.",
    retryable: false,
  },
  PREVIEW_REQUIRED: {
    hint: "This save binds a new identity, which is irreversible. Call admin_preview first.",
    retryable: false,
  },
  INPUT_INVALID: {
    hint: "Fix the arguments named in issues. Repeating the call unchanged fails the same way.",
    retryable: false,
  },
  UNKNOWN_OP: {
    hint: "That op name does not exist. Use a listed name or admin_actions.",
    retryable: false,
  },
  AUDIT_UNAVAILABLE: {
    hint: "The audit ledger could not record this call, so nothing was done or delivered. Retry shortly.",
    retryable: true,
  },
  AI_CREDENTIAL_NOT_CONFIGURED: {
    hint: "The Backend credential for this op is not placed. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
};

type EnvelopeFields = Partial<
  Pick<AdminMcpEnvelope, "issues" | "state" | "next" | "runId">
>;

export const okEnvelope = (
  data: unknown,
  untrusted: readonly string[] = [],
): AdminMcpEnvelope => ({
  ok: true,
  code: "OK",
  data,
  untrusted: [...untrusted],
  meta: {},
});

export const failedEnvelope = (
  code: Exclude<AdminMcpCode, "OK">,
  fields: EnvelopeFields = {},
): AdminMcpEnvelope => {
  const { hint, retryable } = CODE_GUIDE[code];
  return {
    ok: false,
    code,
    hint,
    ...(retryable ? { retryable } : {}),
    ...fields,
    untrusted: [],
    meta: {},
  };
};

export const inputInvalidEnvelope = (
  issues: readonly AdminMcpIssue[],
): AdminMcpEnvelope => failedEnvelope("INPUT_INVALID", { issues: [...issues] });

// One entry per key and tool, so the map stays small. A process-memory counter
// is enough: a client retrying unchanged is what this names.
const lastFailures = new Map<string, { code: AdminMcpCode; count: number }>();
const REPEAT_FROM = 3;

/** The same failure 3 times for one key, tool and code sets meta.repeat. */
const withRepeat = (
  scope: string,
  envelope: AdminMcpEnvelope,
): AdminMcpEnvelope => {
  if (envelope.ok) {
    lastFailures.delete(scope);
    return envelope;
  }
  const previous = lastFailures.get(scope);
  const count = previous?.code === envelope.code ? previous.count + 1 : 1;
  lastFailures.set(scope, { code: envelope.code, count });
  return count < REPEAT_FROM
    ? envelope
    : { ...envelope, meta: { ...envelope.meta, repeat: count } };
};

/**
 * Unicode tag characters, bidi controls, zero-width characters, the soft hyphen,
 * the deprecated format controls and interlinear annotation anchors: text a model
 * reads and a person does not. Variation selectors stay, because rare Chinese
 * glyph variants use them.
 */
const INVISIBLE =
  /[\u{E0000}-\u{E007F}\u00AD\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F\u180E\u200B-\u200D\u2060-\u2064\uFEFF\uFFF9-\uFFFB]/gu;

/**
 * From returned text only, never from stored data. On the serialized form, which
 * reaches every string and key at once and has none of these characters of its own.
 */
const withoutInvisible = (envelope: AdminMcpEnvelope): AdminMcpEnvelope => {
  const text = JSON.stringify(envelope);
  const clean = text.replace(INVISIBLE, "");
  if (clean === text) return envelope;
  const stripped = JSON.parse(clean) as AdminMcpEnvelope;
  return { ...stripped, meta: { ...stripped.meta, stripped: true } };
};

/**
 * The tool result of one call: the JSON in content[0].text and structuredContent,
 * validated on the way out, with isError exactly when ok is false.
 */
export const toolResult = (
  scope: { readonly keyId: number; readonly tool: string },
  envelope: AdminMcpEnvelope,
) => {
  const checked = adminMcpEnvelopeSchema.parse(
    withRepeat(`${scope.keyId}:${scope.tool}`, withoutInvisible(envelope)),
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(checked) }],
    structuredContent: checked as Record<string, unknown>,
    ...(checked.ok ? {} : { isError: true }),
  };
};
