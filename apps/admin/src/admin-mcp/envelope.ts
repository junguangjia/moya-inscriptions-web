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
    hint: "Someone holds this document open; the target's lock says who and until when. Wait for it to expire, or take it over with document.lock_takeover.",
    retryable: false,
  },
  CONCURRENT_OPERATION_BUSY: {
    hint: "Another operation holds this target. Retry shortly with the same requestId.",
    retryable: true,
  },
  EXECUTE_BUSY: {
    hint: "Too many writes are running at once on this Admin, so nothing of this call ran. Retry shortly with the same requestId.",
    retryable: true,
  },
  OUTCOME_UNKNOWN: {
    hint: "The write may or may not have committed. Retrying with the same requestId is safe.",
    retryable: true,
  },
  MEDIA_JOB_FAILED: {
    hint: "The state committed but a media job stopped; jobs names it. Read it with list.jobs before retrying it with community.retry-publishing-job.",
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
    hint: "This concerns a self-only work, or a deleted one that still holds its text, and stays in the Owner's queue.",
    retryable: false,
  },
  PERSONAL_INFO_OWNER_REVIEW: {
    hint: "This case is a person's own request about their personal information. Read it if you need to; it stays in the Owner's queue, and the Owner verifies and answers it.",
    retryable: false,
  },
  URGENT_OWNER_ONLY: {
    hint: "Urgent is one-way here: only the Owner clears it. Setting urgent:true works.",
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
    hint: "This input makes the op irreversible: a save binding a new identity, or a legal hold's release. Call admin_preview first.",
    retryable: false,
  },
  PREVIEW_EXPIRED: {
    hint: "This run expired, unused or unconfirmed past its time, so none of it runs. Preview again under a new requestId.",
    retryable: false,
  },
  PREVIEW_STALE: {
    hint: "This run was frozen under an earlier version of its op, so it cannot run and has expired. Preview again under a new requestId.",
    retryable: false,
  },
  RUN_CANCELLED: {
    hint: "This run was cancelled, so nothing more of it runs; targets it already applied stay applied. list.runs shows each target.",
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
  OP_RETIRED: {
    hint: "That op name was retired, so nothing ran. data.use names the op that replaced it; read its arguments with admin_actions.",
    retryable: false,
  },
  WRONG_TOOL: {
    hint: "This op runs on the tool named in data.tool, so nothing ran here. Call that tool; if your tool list lacks it, this credential cannot run the op.",
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
    hint: "No such record, or not one this credential can read. Locate it with admin_find.",
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
  COMMUNITY_UNAVAILABLE: {
    hint: "The community store could not be read just now, so this has no answer and it is not an empty one. Retry shortly.",
    retryable: true,
  },
  BACKEND_CONTRACT_MISMATCH: {
    hint: "The Backend answered in a shape this Admin cannot read, so this says nothing of what happened: no read is empty, and a write may have committed. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
  ANALYTICS_UNAVAILABLE: {
    hint: "The canonical analytics store could not be read just now, so this has no number and it is not a zero. Retry shortly.",
    retryable: true,
  },
  UMAMI_QUERY_TIMEOUT: {
    hint: "Umami did not answer in time or could not be reached, so this has no number and it is not a zero. Retry after retryAfterMs, or narrow the range.",
    retryable: true,
  },
  UMAMI_NOT_CONFIGURED: {
    hint: "The Umami connection is not configured here, so this has no number. Retrying cannot help; tell the Owner. Canonical reports do not need it.",
    retryable: false,
  },
  UMAMI_REPLY_INVALID: {
    hint: "Umami refused this read or answered in a shape this tool does not accept, so this has no number. Retrying unchanged cannot help; tell the Owner.",
    retryable: false,
  },
  REVISION_CONFLICT: {
    hint: "The record moved past the revision you sent. Read it again, then decide under a new requestId.",
    retryable: false,
  },
  REVISION_REQUIRED: {
    hint: "An edit needs the revision you read. Read the record and send it.",
    retryable: false,
  },
  CONTENT_INVALID: {
    hint: "The content does not pass validation; the target names the fields. Nothing was saved.",
    retryable: false,
  },
  RECORD_ID_INVALID: {
    hint: "That is not a record id. Locate the record with admin_find.",
    retryable: false,
  },
  REMOVAL_NOT_ALLOWED: {
    hint: "This save removes entries, or a stored link you could not read; the target names which. Nothing was saved. If you mean to, send allowRemoving:true on the same requestId.",
    retryable: false,
  },
  PATCH_NO_MATCH: {
    hint: "An edit's oldText is not in the field, so the whole patch was refused and nothing changed; the target names which edit. Read the field, then patch under a new requestId.",
    retryable: false,
  },
  PATCH_MULTIPLE_MATCHES: {
    hint: "An edit's oldText is in the field more than once, so the whole patch was refused and nothing changed; the target names which edit. Send more of the text, or occurrence, under a new requestId.",
    retryable: false,
  },
  PATCH_OVERLAP: {
    hint: "Two edits reach the same text, so the whole patch was refused and nothing changed; the target names them. Make them one edit, under a new requestId.",
    retryable: false,
  },
  LOCK_CHANGED: {
    hint: "The lock moved since you read it, so nothing was taken over: its holder may still be working. Read the record again, then decide.",
    retryable: false,
  },
  LOCK_NOT_HELD: {
    hint: "Nobody holds this document now, so there is nothing to take over and a save goes through. Read the record for its revision.",
    retryable: false,
  },
  IDENTITY_ALREADY_BOUND: {
    hint: "An identity in this save is already bound to another record, permanently. Use another, or edit that record.",
    retryable: false,
  },
  IDENTITY_IMMUTABLE: {
    hint: "A record's catalogId and sourceId never change. Send the ones it has.",
    retryable: false,
  },
  REFERENCE_NOT_FOUND: {
    hint: "This record references something that does not exist. Fix the reference, then use a new requestId.",
    retryable: false,
  },
  REFERENCE_NOT_PUBLISHED: {
    hint: "This record references a Catalog that is not published. Publish that one first; the same requestId then works.",
    retryable: false,
  },
  MEDIA_REFERENCE_INVALID: {
    hint: "A media entry does not match the registered media row. Read the row with admin_read list.media and send what it says.",
    retryable: false,
  },
  MEDIA_PUBLICATION_REFERENCE_INVALID: {
    hint: "A media entry cannot be published as it stands. Read the row with admin_read list.media and save a corrected draft.",
    retryable: false,
  },
  APPROVAL_INVALID: {
    hint: "This approval batch is not valid: an automation account and up to 100 distinct records.",
    retryable: false,
  },
  APPROVAL_ACCOUNT_INVALID: {
    hint: "Approvals go to an automation account, and this one is not. Name an automation account.",
    retryable: false,
  },
  APPROVAL_SCOPE_INVALID: {
    hint: "A record in this batch is outside that automation account's scope. Only the Owner can widen a scope.",
    retryable: false,
  },
  APPROVAL_REVOKED: {
    hint: "This approval was revoked. Approve the revision again.",
    retryable: false,
  },
  APPROVED_REVISION_CHANGED: {
    hint: "The record changed after it was approved. Read it and approve the revision it has now.",
    retryable: false,
  },
  RECORD_NOT_APPROVED: {
    hint: "This approval does not name this record. Read the approval, or approve the record.",
    retryable: false,
  },
  CATALOG_DELIVERY_PREPARATION_REQUIRED: {
    hint: "This record has images with no public renditions yet. Prepare and release it through editorial.prepare-catalog-delivery; the same requestId works once they are ready.",
    retryable: false,
  },
  CATALOG_DELIVERY_PENDING: {
    hint: "The images are not ready, so nothing was published. Retry shortly with the same requestId.",
    retryable: true,
  },
  CATALOG_DELIVERY_NOT_CONFIGURED: {
    hint: "Catalog delivery is not configured here. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
  CATALOG_DELIVERY_DRAFT_CHANGED: {
    hint: "The draft moved after this delivery was prepared. Read it and prepare again.",
    retryable: false,
  },
  CATALOG_DELIVERY_BASE_CHANGED: {
    hint: "The live record moved after this delivery was prepared. Read it and prepare again.",
    retryable: false,
  },
  CATALOG_DELIVERY_STATE_CONFLICT: {
    hint: "This delivery moved past the state version you sent. Read it with editorial.read-catalog-delivery.",
    retryable: false,
  },
  CATALOG_DELIVERY_MANIFEST_CHANGED: {
    hint: "The media manifest differs from the one you sent. Read the delivery with editorial.read-catalog-delivery.",
    retryable: false,
  },
  CATALOG_DELIVERY_PROOF_CHANGED: {
    hint: "The readiness proof no longer matches this delivery. Read it again with editorial.read-catalog-delivery.",
    retryable: false,
  },
  CATALOG_DELIVERY_INACTIVE: {
    hint: "This delivery has ended and cannot move. Prepare a new one if it is still wanted.",
    retryable: false,
  },
  CATALOG_DELIVERY_EXPIRED: {
    hint: "This delivery expired and cannot move. Prepare a new one.",
    retryable: false,
  },
  CATALOG_DELIVERY_REPREPARE_REQUIRED: {
    hint: "The render recipes changed since this delivery was prepared. Prepare it again.",
    retryable: false,
  },
  CATALOG_DELIVERY_SOURCE_TOO_LARGE: {
    hint: "An image in this record is longer on one edge than delivery can process. Replace it.",
    retryable: false,
  },
  CATALOG_DELIVERY_READINESS_UNAVAILABLE: {
    hint: "The readiness proof could not be read, so nothing was published. Retry shortly with the same requestId.",
    retryable: true,
  },
  CATALOG_RECIPE_POLICY_UNAVAILABLE: {
    hint: "The render recipes could not be read, so nothing changed. Retry shortly with the same requestId.",
    retryable: true,
  },
  CATALOG_RECIPE_POLICY_INVALID: {
    hint: "The render recipes came back in a shape this does not accept, so nothing changed. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
  CATALOG_RELEASE_NOT_REQUESTED: {
    hint: "A release needs editorial.request-catalog-release first.",
    retryable: false,
  },
  CATALOG_RENDER_BACKLOG_NOT_CONFIGURED: {
    hint: "The render backlog is not configured here, so this has no number. Retrying cannot help; tell the Owner.",
    retryable: false,
  },
  CATALOG_RENDER_BACKLOG_UNAVAILABLE: {
    hint: "The render backlog could not be read just now, so this has no number and it is not a zero. Retry shortly.",
    retryable: true,
  },
  OPERATION_REFUSED: {
    hint: "The operation refused this target; its row names why. Repeating the call unchanged meets the same refusal.",
    retryable: false,
  },
};

type EnvelopeFields = Partial<
  Pick<
    AdminMcpEnvelope,
    | "data"
    | "issues"
    | "state"
    | "next"
    | "runId"
    | "done"
    | "total"
    | "remaining"
  >
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

/** A closed value's choices, and in a union those of each branch that has them. */
const choicesOf = (issue: z.core.$ZodIssue): readonly unknown[] =>
  issue.code === "invalid_value"
    ? issue.values
    : issue.code === "invalid_union"
      ? issue.errors.flatMap((branch) =>
          branch.filter(({ path }) => path.length === 0).flatMap(choicesOf),
        )
      : [];

/**
 * The schema's own choices for a closed value, which tools/list may show as a string.
 * Named once per path and choices in one answer, so a slip in a shared input that
 * every target repeats does not repeat them.
 */
const allowedValuesOf = (
  issue: z.core.$ZodIssue,
  named: Set<string>,
): readonly string[] | undefined => {
  const choices = [...new Set(choicesOf(issue))];
  if (
    choices.length === 0 ||
    !choices.every((value): value is string => typeof value === "string")
  )
    return undefined;
  const once = JSON.stringify([issue.path.map(String), choices]);
  if (named.has(once)) return undefined;
  named.add(once);
  return choices;
};

/**
 * Names the failing input by path and by what the schema allows, never by value. The
 * calls behind one answer share `named`.
 */
export const issuesOfError = (
  error: z.ZodError,
  schema: unknown,
  prefix: readonly string[] = [],
  named = new Set<string>(),
): readonly AdminMcpIssue[] =>
  error.issues.map((issue) => {
    const allowedKeys =
      issue.code === "unrecognized_keys"
        ? allowedKeysAt(schema, issue.path)
        : undefined;
    const allowedValues = allowedValuesOf(issue, named);
    return {
      path: [
        ...prefix,
        ...issue.path.map((part) =>
          typeof part === "number" ? part : String(part),
        ),
      ],
      code: issue.code,
      ...(allowedKeys === undefined ? {} : { allowedKeys: [...allowedKeys] }),
      ...(allowedValues === undefined
        ? {}
        : { allowedValues: [...allowedValues] }),
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

/** Whether the strip would change this. By search: the g flag keeps a test's place. */
export const holdsInvisible = (value: unknown): boolean =>
  JSON.stringify(value).search(INVISIBLE) >= 0;

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
export const pointerResolves = (
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
 * How a cut answer goes on from what it kept. Undefined leaves the answer's own `next`
 * standing, and null drops it, because it stands past the whole page and following it
 * would skip what was cut.
 */
export type CutContinuation = (
  kept: readonly unknown[],
) => AdminMcpNext | null | undefined;

/**
 * A text result never passes the cap, and a cut says so: whole records are dropped
 * from the end of the largest array, the rest stays valid JSON, `meta.truncated` is
 * set and `next` continues from what was kept. With no way on, because not one record
 * fits, the answer carries a fixed hint instead, and a too-large answer never arrives
 * as a quiet empty one.
 */
const withinCap = (
  envelope: AdminMcpEnvelope,
  continuation?: CutContinuation,
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
  const wayOn = (kept: readonly unknown[]) => {
    const onward = continuation?.(kept);
    return onward === null ? undefined : (onward ?? ownNext);
  };
  for (const [index, path] of arrays.entries()) {
    const records = at(body, path) as readonly unknown[];
    const attempt = (count: number) => {
      const head = records.slice(0, count);
      return finished(
        withRecords(body, path, head) as typeof body,
        dropped + records.length - count,
        // Past the largest array its records are all gone, so nothing continues.
        index === 0 && count > 0 ? wayOn(head) : undefined,
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
  scope: { readonly keyId: number | string; readonly tool: string },
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
  scope: { readonly keyId: number | string; readonly tool: string },
  envelope: AdminMcpEnvelope,
  continuation?: CutContinuation,
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
