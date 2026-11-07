import type {
  AdminCmsRecordType,
  AdminExecuteRow,
  AdminMcpNext,
  AdminOpSettlement,
} from "@moya/contracts/internal/admin-mcp";

import { CommunityOperatorError } from "../../community/backend";
import { BACKEND_CONTRACT_MISMATCH } from "../backend-answer";
import { CMS_FAMILIES, heldLocksOf, rowIdOf } from "../records";
import { targetFailureOf } from "../refusal";
import type { TargetFailure } from "../refusal";
import { admitTarget } from "./define";
import type { AdminOpContext, AdminOpEntry } from "./define";

/**
 * One target's one operation, as admin_execute runs it and as a run's executor will
 * (S8 plan 2.8): classified, admitted at that class, run, and settled. admin_execute
 * always allows only reversible, so a target whose input raises its class answers
 * PREVIEW_REQUIRED and never runs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A community record's id: a fixed word and hex, so no caller's text fits in it. */
const PLATFORM_ID =
  /^(?:comment|user|work|work-revision|report|thread|article|publishing-job|media-item)-[0-9a-f]{32}$/u;

/** An id is echoed only in a shape no text fits in: the caller's string stays theirs. */
export const safeRef = (value: unknown): number | string | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (/^[1-9]\d{0,14}$/u.test(value)) return Number(value);
  return UUID.test(value) || PLATFORM_ID.test(value) ? value : undefined;
};

type CompleteState = "applied" | "already_applied";

export interface TargetOutcome {
  readonly index: number;
  readonly id?: number | string | undefined;
  readonly state: CompleteState | "queued" | TargetFailure["state"];
  readonly code: string;
  readonly fields?: readonly string[];
  readonly lock?: AdminExecuteRow["lock"];
  readonly replayed?: boolean;
  readonly result?: Readonly<Record<string, unknown>>;
  /** A queued target whose effect was there before this call. */
  readonly alreadyApplied?: true;
  /** Settlement's own word on a queued target. */
  readonly settledState?: string;
  readonly settledNext?: AdminMcpNext;
  readonly settledHint?: string;
  /** On MEDIA_JOB_FAILED: what stopped. */
  readonly jobs?: readonly string[];
  /** Asked to publish with a gate shut, so no job exists. */
  readonly mediaGate?: "off";
}

export const COMPLETE: ReadonlySet<TargetOutcome["state"]> = new Set([
  "applied",
  "already_applied",
]);

/**
 * A refused lock says who holds it and until when; a failed read of that adds nothing.
 * The record may be named by its public identity, so its row is read here.
 */
const lockBlockOf = async (
  entry: AdminOpEntry,
  raw: unknown,
  context: AdminOpContext,
  target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined,
  id: number | string | undefined,
): Promise<{ id?: number; lock?: AdminExecuteRow["lock"] }> => {
  const { req } = context;
  try {
    const record = await entry.lockedRecord?.(raw, context);
    const type = record?.type ?? target?.type;
    const named = record?.id ?? (typeof id === "number" ? id : target?.id);
    if (
      type === undefined ||
      named === undefined ||
      !Object.hasOwn(CMS_FAMILIES, type)
    )
      return {};
    const family = CMS_FAMILIES[type as AdminCmsRecordType];
    const row =
      typeof named === "number" ? named : await rowIdOf(req, family, named);
    if (row === undefined) return {};
    return { id: row, lock: (await heldLocksOf(req, family, [row])).get(row) };
  } catch {
    return {};
  }
};

const settlementOf = async (
  entry: AdminOpEntry,
  raw: unknown,
  result: unknown,
  context: AdminOpContext,
): Promise<AdminOpSettlement | undefined> => {
  if (entry.completion.kind !== "async") return undefined;
  if (entry.completion.settle === undefined)
    return { ok: false, code: "QUEUED" as const, state: "accepted" };
  try {
    return await entry.completion.settle(raw, result, context);
  } catch (error) {
    // The state committed. An answer it cannot read reads the same on a repeat, so it
    // is refused by name, as admin_job files it; any other failed read shows nothing
    // about the work left.
    if (
      error instanceof CommunityOperatorError &&
      error.code === BACKEND_CONTRACT_MISMATCH
    )
      return { ok: false, code: BACKEND_CONTRACT_MISMATCH };
    return { ok: false, code: "QUEUED" as const, state: "settlement_unread" };
  }
};

/**
 * A complete target unless its op says otherwise: an op that found its effect already
 * in place asks the same question, since the work it queued may still be open.
 */
const settledOutcome = async (
  entry: AdminOpEntry,
  raw: unknown,
  result: unknown,
  context: AdminOpContext,
  row: Pick<TargetOutcome, "index" | "id" | "result" | "replayed">,
  complete: CompleteState,
): Promise<TargetOutcome> => {
  const settlement = await settlementOf(entry, raw, result, context);
  if (settlement === undefined) return { ...row, state: complete, code: "OK" };
  const gate =
    settlement.mediaGate === undefined
      ? {}
      : { mediaGate: settlement.mediaGate };
  if (settlement.ok) return { ...row, ...gate, state: complete, code: "OK" };
  if (settlement.code === "QUEUED")
    return {
      ...row,
      ...gate,
      state: "queued",
      code: "QUEUED",
      ...(complete === "already_applied" ? { alreadyApplied: true } : {}),
      settledState: settlement.state ?? "accepted",
      ...(settlement.next === undefined
        ? {}
        : { settledNext: settlement.next }),
      ...(settlement.hint === undefined
        ? {}
        : { settledHint: settlement.hint }),
    };
  return {
    ...row,
    ...gate,
    state: "failed",
    code: settlement.code,
    ...(settlement.jobs === undefined ? {} : { jobs: settlement.jobs }),
  };
};

/** The row a public identity names, for an answer and an audit row that did not read one. */
const namedRow = async (
  { req }: AdminOpContext,
  target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined,
) => {
  if (target?.id === undefined || !Object.hasOwn(CMS_FAMILIES, target.type))
    return undefined;
  try {
    return await rowIdOf(
      req,
      CMS_FAMILIES[target.type as AdminCmsRecordType],
      target.id,
    );
  } catch {
    return undefined;
  }
};

/**
 * The highest class a call may run a target at. admin_execute passes `reversible`; only
 * a run's executor passes `irreversible`, with the run's ticket on the context.
 */
export type TargetAllowance = "reversible" | "irreversible";

/** Each target's one operation. Nothing thrown here is lost and none is a success. */
export const runTarget = async (
  entry: AdminOpEntry,
  raw: Readonly<Record<string, unknown>>,
  index: number,
  context: AdminOpContext,
  allow: TargetAllowance,
): Promise<TargetOutcome> => {
  let target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined;
  let id: number | string | undefined;
  try {
    target = entry.target?.(raw);
    id = safeRef(target?.id);
    // The class rises with the input. Bound identities only ever grow, so a save read
    // as binding none here cannot bind one by the time it runs.
    const klass = (await entry.classify?.(raw, context)) ?? entry.klass;
    if (
      klass === "read" ||
      (klass === "irreversible" && allow !== "irreversible")
    )
      return { index, id, state: "failed", code: "PREVIEW_REQUIRED" };
    // On this same context, so the op's own reads stay the ones its class came from.
    admitTarget(context, klass);
    const answer = await entry.run!(raw, context);
    if (!answer.ok) {
      const failure = targetFailureOf(new Error(answer.code));
      return { index, id, ...failure };
    }
    const { replayed, ...result } = (answer.data ?? {}) as Record<
      string,
      unknown
    >;
    const resolved = id ?? safeRef(result.id) ?? safeRef(result.approvalId);
    return await settledOutcome(
      entry,
      raw,
      result,
      context,
      {
        index,
        id: resolved,
        result,
        ...(replayed === true ? { replayed: true } : {}),
      },
      replayed === true ? "already_applied" : "applied",
    );
  } catch (error) {
    const failure = targetFailureOf(error);
    const named = id ?? (await namedRow(context, target));
    if (failure.state === "already_applied")
      return settledOutcome(
        entry,
        raw,
        undefined,
        context,
        { index, id: named },
        "already_applied",
      );
    return {
      index,
      id: named,
      ...failure,
      ...(failure.code === "DOCUMENT_LOCKED"
        ? await lockBlockOf(entry, raw, context, target, id)
        : {}),
    };
  }
};
