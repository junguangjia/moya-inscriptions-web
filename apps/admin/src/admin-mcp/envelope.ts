import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpCode,
  AdminMcpCodeGuide,
  AdminMcpEnvelope,
  AdminMcpIssue,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

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
  NOT_FOUND: {
    hint: "No such record, or not one this key can read. Locate it with admin_find.",
    retryable: false,
  },
  NOT_AVAILABLE: {
    hint: "This part is not built yet, so nothing was read. It is not the same as nothing being there.",
    retryable: false,
  },
  MEDIA_UNAVAILABLE: {
    hint: "The image could not be read just now. Retry shortly; if it stays, report that you could not read it.",
    retryable: true,
  },
  MEDIA_TOO_LARGE: {
    hint: "This original is larger than this tool reads, so repeating the call cannot help. Read its thumbnail, or report that you could not read the original.",
    retryable: false,
  },
  AI_ROUTE_FORBIDDEN: {
    hint: "The Backend refused this credential on this route. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
  READ_TIMED_OUT: {
    hint: "This read ran out of time, so it gives no number and this is not a zero. Retry shortly, or narrow the filter.",
    retryable: true,
  },
};

type EnvelopeFields = Partial<
  Pick<AdminMcpEnvelope, "data" | "issues" | "state" | "next" | "runId">
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

/** The keys of the object a path reaches, through what wraps it. */
const allowedKeysAt = (
  schema: unknown,
  path: readonly PropertyKey[],
): readonly string[] | undefined => {
  const unwrapped = (value: unknown): unknown =>
    value instanceof z.ZodOptional ? unwrapped(value.unwrap()) : value;
  let current = unwrapped(schema);
  for (const part of path) {
    if (!(current instanceof z.ZodObject)) return undefined;
    current = unwrapped(current.shape[String(part)]);
  }
  return current instanceof z.ZodObject
    ? Object.keys(current.shape)
    : undefined;
};

/** Names the failing input by path and allowed keys, never by value. */
export const issuesOfError = (
  error: z.ZodError,
  schema: unknown,
  prefix: readonly string[] = [],
): readonly AdminMcpIssue[] =>
  error.issues.map((issue) => {
    const allowedKeys =
      issue.code === "unrecognized_keys"
        ? allowedKeysAt(schema, issue.path)
        : undefined;
    return {
      path: [
        ...prefix,
        ...issue.path.map((part) =>
          typeof part === "number" ? part : String(part),
        ),
      ],
      code: issue.code,
      ...(allowedKeys === undefined ? {} : { allowedKeys: [...allowedKeys] }),
    };
  });

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

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

type JsonPath = readonly string[];

/** Arrays reached through objects only: an array's items are whole records. */
const recordArrays = (value: unknown, path: JsonPath = []): JsonPath[] => {
  if (Array.isArray(value)) return [path];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    recordArrays(item, [...path, key]),
  );
};

const at = (root: unknown, path: JsonPath): unknown =>
  path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown>)[key],
    root,
  );

const withRecords = (
  root: unknown,
  path: JsonPath,
  records: readonly unknown[],
): unknown => {
  if (path.length === 0) return records;
  const [key, ...rest] = path as [string, ...string[]];
  const parent = root as Record<string, unknown>;
  return { ...parent, [key]: withRecords(parent[key], rest, records) };
};

/** A pointer into a record that was cut is dropped; `*` stands for any item. */
const pointerResolves = (
  value: unknown,
  [segment, ...rest]: readonly string[],
): boolean => {
  if (segment === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  const items = Object.entries(value);
  return segment === "*"
    ? items.some(([, item]) => pointerResolves(item, rest))
    : items.some(
        ([key, item]) => key === segment && pointerResolves(item, rest),
      );
};

export const CUT_WITH_NO_WAY_ON =
  "This result was cut at the size limit and cannot continue from here. Narrow the request, or read it through the companion.";

/**
 * A text result never passes the cap, and a cut says so: whole records are dropped
 * from the end of the largest array, the rest stays valid JSON, `meta.truncated` is
 * set and `next` continues from what was kept. With no way on, because not one record
 * fits, the answer carries a fixed hint instead, and a too-large answer never arrives
 * as a quiet empty one.
 */
const withinCap = (
  envelope: AdminMcpEnvelope,
  continuation?: (kept: readonly unknown[]) => AdminMcpNext | undefined,
): AdminMcpEnvelope => {
  if (bytesOf(envelope) <= ADMIN_MCP_TEXT_CAP_BYTES) return envelope;
  const {
    data: wholeData,
    issues: wholeIssues,
    next: ownNext,
    ...fields
  } = envelope;

  const finished = (
    body: Pick<AdminMcpEnvelope, "data" | "issues">,
    dropped: number,
    next: AdminMcpNext | undefined,
  ): AdminMcpEnvelope => ({
    ...fields,
    ...body,
    ...(next === undefined ? { hint: CUT_WITH_NO_WAY_ON } : { next }),
    remaining: envelope.remaining ?? dropped,
    untrusted: envelope.untrusted.filter((pointer) =>
      pointerResolves(body, pointer.split("/").slice(1)),
    ),
    meta: { ...envelope.meta, truncated: true },
  });

  let body: Pick<AdminMcpEnvelope, "data" | "issues"> = {
    ...(wholeData === undefined ? {} : { data: wholeData }),
    ...(wholeIssues === undefined ? {} : { issues: wholeIssues }),
  };
  const arrays = recordArrays(body).sort(
    (first, second) => bytesOf(at(body, second)) - bytesOf(at(body, first)),
  );
  let dropped = 0;
  for (const [index, path] of arrays.entries()) {
    const records = at(body, path) as readonly unknown[];
    const attempt = (count: number) => {
      const head = records.slice(0, count);
      return finished(
        withRecords(body, path, head) as typeof body,
        dropped + records.length - count,
        // Past the largest array its records are all gone, so nothing continues.
        index === 0 && count > 0
          ? (continuation?.(head) ?? ownNext)
          : undefined,
      );
    };
    let keep = 0;
    let low = 1;
    let high = records.length;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (bytesOf(attempt(middle)) <= ADMIN_MCP_TEXT_CAP_BYTES) {
        keep = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const candidate = attempt(keep);
    if (bytesOf(candidate) <= ADMIN_MCP_TEXT_CAP_BYTES) return candidate;
    body = withRecords(body, path, []) as typeof body;
    dropped += records.length;
  }
  return finished({}, dropped, undefined);
};

/**
 * admin_view_media: text plus image, with no structuredContent and, on the tool, no
 * outputSchema. The official client throws when a tool with an outputSchema answers
 * with no structuredContent, and Codex drops the image when structuredContent is set.
 */
export const imageToolResult = (
  scope: { readonly keyId: number; readonly tool: string },
  envelope: AdminMcpEnvelope,
  image?: { readonly data: Buffer; readonly mimeType: string },
) => {
  const checked = adminMcpEnvelopeSchema.parse(
    withRepeat(`${scope.keyId}:${scope.tool}`, withoutInvisible(envelope)),
  );
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(checked) },
      ...(image === undefined
        ? []
        : [
            {
              type: "image" as const,
              data: image.data.toString("base64"),
              mimeType: image.mimeType,
            },
          ]),
    ],
    ...(checked.ok ? {} : { isError: true }),
  };
};

/**
 * The tool result of one call: the JSON in content[0].text and structuredContent,
 * validated on the way out, with isError exactly when ok is false. `continuation`
 * says how to go on from a cut result.
 */
export const toolResult = (
  scope: { readonly keyId: number; readonly tool: string },
  envelope: AdminMcpEnvelope,
  continuation?: (kept: readonly unknown[]) => AdminMcpNext | undefined,
) => {
  const checked = adminMcpEnvelopeSchema.parse(
    withinCap(
      withRepeat(`${scope.keyId}:${scope.tool}`, withoutInvisible(envelope)),
      continuation,
    ),
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(checked) }],
    structuredContent: checked as Record<string, unknown>,
    ...(checked.ok ? {} : { isError: true }),
  };
};
