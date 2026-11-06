import { adminMcpCodeSchema } from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpCode } from "@moya/contracts/internal/admin-mcp";

import { isMissingRecord, isMissingReference } from "../editorial/transaction";
import { BACKEND_CONTRACT_MISMATCH } from "./backend-answer";

/** What an op's failure says about its one target (admin-mcp-completion-v1 section 7). */
export type TargetFailureState =
  "already_applied" | "conflict" | "failed" | "unknown";

export interface TargetFailure {
  readonly state: TargetFailureState;
  readonly code: string;
  readonly fields?: readonly string[];
  readonly replayed?: true;
}

// A production compile can hold two copies of Payload's classes (door.ts), so this
// reads what an error says and never asks which class it is.
const FIXED_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const FIELD_NAME = /^[\w.-]{1,64}$/u;

const MISSES: ReadonlySet<string> = new Set([
  "RECORD_UNAVAILABLE",
  "RECORD_NOT_FOUND",
  "VERSION_NOT_FOUND",
]);

// The target moved or someone holds it: the command was fine when it was written.
const CONFLICTS: ReadonlySet<string> = new Set([
  "STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_CONFLICT",
  "APPROVED_REVISION_CHANGED",
  "CATALOG_DELIVERY_DRAFT_CHANGED",
  "CATALOG_DELIVERY_BASE_CHANGED",
  "CATALOG_DELIVERY_STATE_CONFLICT",
  "CATALOG_DELIVERY_MANIFEST_CHANGED",
  "CATALOG_DELIVERY_PROOF_CHANGED",
  "DOCUMENT_LOCKED",
  "LOCK_CHANGED",
  "LOCK_NOT_HELD",
  "CONCURRENT_OPERATION_BUSY",
]);

// The effect was already in place, so nothing was written and nothing is wrong.
const ALREADY_IN_PLACE: ReadonlySet<string> = new Set([
  "ALREADY_PUBLISHED",
  "ALREADY_WITHDRAWN",
  "ALREADY_REVOKED",
  "ALREADY_SET",
  "ALREADY_RELEASED",
]);

const fieldsOf = (error: object): readonly string[] => {
  const { fields, data } = error as {
    fields?: unknown;
    data?: { errors?: unknown };
  };
  const names = Array.isArray(fields)
    ? fields
    : Array.isArray(data?.errors)
      ? (data.errors as { path?: unknown }[]).map(({ path }) => path)
      : [];
  return [
    ...new Set(
      names.filter(
        (name): name is string =>
          typeof name === "string" && FIELD_NAME.test(name),
      ),
    ),
  ];
};

const namedCodeOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  if (FIXED_CODE.test(error.message)) return error.message;
  if (isMissingReference(error)) return "REFERENCE_NOT_FOUND";
  const { status, data } = error as { status?: unknown; data?: object };
  if (status === 423) return "DOCUMENT_LOCKED";
  if (status === 403 || status === 404) return "NOT_FOUND";
  if (status === 400 && Array.isArray((data as { errors?: unknown })?.errors))
    return "CONTENT_INVALID";
  return undefined;
};

/**
 * No value and no sentence ever leaves here. A failure with no known code may have
 * come after the write, so it reads as unknown and never as a refusal, and the same
 * request can be retried either way. An answer the Admin cannot read is unknown too,
 * under its own name, because a repeat reads the same answer.
 */
export const targetFailureOf = (error: unknown): TargetFailure => {
  if (isMissingRecord(error)) return { state: "failed", code: "NOT_FOUND" };
  const named = namedCodeOf(error);
  if (named === undefined || named === "OUTCOME_UNKNOWN")
    return { state: "unknown", code: "OUTCOME_UNKNOWN" };
  if (named === BACKEND_CONTRACT_MISMATCH)
    return { state: "unknown", code: named };
  const code = MISSES.has(named) ? "NOT_FOUND" : named;
  const fields = fieldsOf(error as object);
  return {
    state: ALREADY_IN_PLACE.has(code)
      ? "already_applied"
      : CONFLICTS.has(code)
        ? "conflict"
        : "failed",
    code,
    ...(fields.length > 0 ? { fields } : {}),
    ...("replayed" in (error as object) ? { replayed: true as const } : {}),
  };
};

/** A code outside the closed list keeps its name on the target's row. */
export const envelopeCodeOf = (code: string): Exclude<AdminMcpCode, "OK"> => {
  const known = adminMcpCodeSchema.safeParse(code);
  return known.success && known.data !== "OK"
    ? known.data
    : "OPERATION_REFUSED";
};
