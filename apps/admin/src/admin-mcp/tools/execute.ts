import { createHash, randomUUID } from "node:crypto";

import {
  ADMIN_EXECUTE_MAX_TARGETS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminExecuteListedShape,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminExecuteData,
  AdminExecuteInput,
  AdminExecuteRow,
  AdminMcpEnvelope,
  AdminCmsRecordType,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { z } from "zod";

import { writeAuditEvent } from "../audit";
import { EXECUTE_BUDGET_MS } from "../budget";
import { readMcpControl } from "../control/state";
import type { AdminMcpKey } from "../door";
import {
  CODE_GUIDE,
  failedEnvelope,
  holdsInvisible,
  inputInvalidEnvelope,
  issuesOfError,
  okEnvelope,
  pointerResolves,
} from "../envelope";
import { CMS_FAMILIES, heldLocksOf, rowIdOf } from "../records";
import { envelopeCodeOf, targetFailureOf } from "../refusal";
import type { TargetFailure } from "../refusal";
import { adminOpMeta, isAdminOpName } from "../registry";
import type { AdminOpContext, AdminOpEntry } from "../registry";
import { opRefusalOf, unknownOpEnvelope } from "./read";

export const EXECUTE_TOOL_NAME = "admin_execute";

export const EXECUTE_DESCRIPTION = `Run one reversible write, or the same one on up to ${ADMIN_EXECUTE_MAX_TARGETS} targets, in order, each with its own outcome. One: {requestId,op:"editorial.save-draft",input:{id,expectedRevision,content}}. Many: {requestId,op:"editorial.publish-approved",input:{approvalId},targets:[{id:7},{id:8}]}; each target merges over input. A new requestId per intention: the same requestId replays and never repeats, and it is what to retry after OUTCOME_UNKNOWN. ok:true means every target's whole effect completed. Anything else names each target's state in data and gives next when you can go on. admin_actions gives each op's input.`;

// A plain string for op, as on admin_read: tools/list cannot carry the names within
// its token budget (section 5). A wrong name answers UNKNOWN_OP with near ones.
export const executeListedInput = z.strictObject(adminExecuteListedShape);

/** A key per target, stable across retries: a uuid, so a Backend route takes it too. */
const requestKeyFor = (requestId: string, index: number) => {
  const hash = createHash("sha256")
    .update(JSON.stringify([requestId, index]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SIMPLE_KEY = /^[\w-]{1,64}$/u;
const INPUT_MAX_DEPTH = 32;

/** An id is echoed only in a shape no text fits in: the caller's string stays theirs. */
const safeRef = (value: unknown): number | string | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (/^[1-9]\d{0,14}$/u.test(value)) return Number(value);
  return UUID.test(value) ? value : undefined;
};

/**
 * PostgreSQL holds no NUL, no input grows a prototype, and hashing a command must not
 * run out of stack. Named here, and never met as a driver error.
 */
const unsafeInputOf = (
  value: unknown,
  path: readonly (string | number)[],
):
  { readonly path: (string | number)[]; readonly code: string } | undefined => {
  if (typeof value === "string")
    return value.includes("\u0000")
      ? { path: [...path], code: "nul_character" }
      : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  if (path.length >= INPUT_MAX_DEPTH)
    return { path: path.slice(0, 8), code: "too_deep" };
  for (const [name, item] of Object.entries(value)) {
    if (name === "__proto__" || name.includes("\u0000"))
      return { path: [...path], code: "forbidden_key" };
    const found = unsafeInputOf(item, [
      ...path,
      SIMPLE_KEY.test(name) ? name : "?",
    ]);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The audit start row: fixed names and safe ids, never what the caller typed. */
export const executeReferences = (args: unknown) => {
  const { op, requestId, targets, input } = (args ?? {}) as Partial<
    Record<keyof AdminExecuteInput, unknown>
  >;
  const entry =
    typeof op === "string" && isAdminOpName(op) ? adminOpMeta[op] : undefined;
  const count = Array.isArray(targets) ? targets.length : 1;
  const target =
    entry?.target !== undefined && count === 1
      ? (() => {
          try {
            return entry.target({
              ...(input as object),
              ...(Array.isArray(targets) ? (targets[0] as object) : {}),
            });
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const targetId = safeRef(target?.id);
  return {
    ...(entry === undefined ? {} : { op: op as string }),
    ...(typeof requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
      ? { requestId }
      : {}),
    count,
    ...(target === undefined || targetId === undefined
      ? {}
      : { targetType: target.type, targetId: String(targetId) }),
  };
};

type CompleteState = "applied" | "already_applied";

interface TargetOutcome {
  readonly index: number;
  readonly id?: number | string | undefined;
  readonly state: CompleteState | "queued" | TargetFailure["state"];
  readonly code: string;
  readonly fields?: readonly string[];
  readonly lock?: AdminExecuteRow["lock"];
  readonly replayed?: boolean;
  readonly result?: Readonly<Record<string, unknown>>;
  /** Settlement's own word on a queued target. */
  readonly settledState?: string;
  readonly settledNext?: AdminMcpNext;
  readonly settledHint?: string;
}

const COMPLETE: ReadonlySet<TargetOutcome["state"]> = new Set([
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
) => {
  if (entry.completion.kind !== "async") return undefined;
  if (entry.completion.settle === undefined)
    return { ok: false, code: "QUEUED" as const, state: "accepted" };
  try {
    return await entry.completion.settle(raw, result, context);
  } catch {
    // The state committed, and a read that failed shows nothing about the work left.
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
  if (settlement === undefined || settlement.ok)
    return { ...row, state: complete, code: "OK" };
  if (settlement.code === "QUEUED")
    return {
      ...row,
      state: "queued",
      code: "QUEUED",
      settledState: settlement.state ?? "accepted",
      ...(settlement.next === undefined
        ? {}
        : { settledNext: settlement.next }),
      ...("hint" in settlement && settlement.hint !== undefined
        ? { settledHint: settlement.hint }
        : {}),
    };
  return { ...row, state: "failed", code: settlement.code };
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

/** Each target's one operation. Nothing thrown here is lost and none is a success. */
const runTarget = async (
  entry: AdminOpEntry,
  raw: Readonly<Record<string, unknown>>,
  index: number,
  context: AdminOpContext,
): Promise<TargetOutcome> => {
  let target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined;
  let id: number | string | undefined;
  try {
    target = entry.target?.(raw);
    id = safeRef(target?.id);
    // The class rises with the input. Bound identities only ever grow, so a save read
    // as binding none here cannot bind one by the time it runs.
    const klass = (await entry.classify?.(raw, context)) ?? entry.klass;
    if (klass !== "reversible")
      return { index, id, state: "failed", code: "PREVIEW_REQUIRED" };
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

/** Whether the row landed: a ledger that stopped must not watch more writes go by. */
const auditTarget = async (
  { req, key }: AdminOpContext,
  call: AdminExecuteInput,
  target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined,
  { id, state, code }: TargetOutcome,
) => {
  try {
    // No tool: the p95 per tool counts calls. No start: this row is not a call's.
    await writeAuditEvent(req.payload, {
      callId: randomUUID(),
      phase: "finish",
      class: "reversible",
      op: call.op,
      requestId: call.requestId,
      ok: COMPLETE.has(state),
      code,
      keyId: key.id,
      ...(key.label ? { keyLabel: key.label } : {}),
      userId: String(key.user.id),
      ...(target?.type ? { targetType: target.type } : {}),
      ...(id === undefined ? {} : { targetId: String(id) }),
    });
    return true;
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });
    return false;
  }
};

const rowOf = ({
  index,
  id,
  code,
  fields,
  replayed,
  lock,
}: TargetOutcome): AdminExecuteRow => ({
  index,
  ...(id === undefined ? {} : { id }),
  code,
  ...(fields === undefined ? {} : { fields: [...fields] }),
  ...(replayed ? { replayed: true as const } : {}),
  ...(lock === undefined ? {} : { lock }),
});

const dataOf = (outcomes: readonly TargetOutcome[]): AdminExecuteData => {
  const ids = (state: TargetOutcome["state"]) =>
    outcomes
      .filter((outcome) => outcome.state === state)
      .map(({ id, index }) => id ?? `#${index}`);
  const rows = (state: TargetOutcome["state"]) =>
    outcomes.filter((outcome) => outcome.state === state).map(rowOf);
  const queued = outcomes
    .filter(({ state }) => state === "queued")
    .map(({ index, id, settledState }) => ({
      index,
      ...(id === undefined ? {} : { id }),
      state: settledState ?? "accepted",
    }));
  const groups: AdminExecuteData = {
    applied: ids("applied"),
    already_applied: ids("already_applied"),
    queued,
    conflict: rows("conflict"),
    failed: rows("failed"),
    unknown: rows("unknown"),
  };
  return Object.fromEntries(
    Object.entries(groups).filter(([, group]) => group?.length),
  ) as AdminExecuteData;
};

// Long enough to carry a list of ids and short counters, and no real text: a cut
// answer has to hold its groups and `next` under the text cap.
const NEXT_ARGS_MAX_BYTES = 1_500;
const RETRY_AFTER_MS = 2_000;
// What a cut and the finished answer still add once the room is measured: its flags,
// `remaining`, the pointers of an op and the sentence on sending targets again.
const CAP_MARGIN_BYTES = 300;

const RESEND = " next leaves out input and targets: send the same ones again.";

const CONTINUED =
  "An earlier call of this batch left a target incomplete, and this answer covers only the targets from startAt on. Repeat the whole call with the same requestId and no startAt to see every target.";

const LEDGER_STOPPED =
  "The audit ledger could not record a target, so the batch stopped there. The targets named in data did run and the rest did not. Retry shortly with next.";

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const nextCall = (
  call: AdminExecuteInput,
  startAt: number,
  incomplete: boolean,
  afterMs?: number,
): AdminMcpNext => {
  const body = {
    ...(call.input === undefined ? {} : { input: call.input }),
    ...(call.targets === undefined ? {} : { targets: call.targets }),
  };
  return {
    tool: EXECUTE_TOOL_NAME,
    args: {
      requestId: call.requestId,
      op: call.op,
      // Returned text loses what the strip takes, so a body it would change goes unsent
      // and is never replayed as different text.
      ...(bytesOf(body) <= NEXT_ARGS_MAX_BYTES && !holdsInvisible(body)
        ? body
        : {}),
      ...(startAt > 0 ? { startAt } : {}),
      ...(startAt > 0 && incomplete ? { priorIncomplete: true } : {}),
    },
    ...(afterMs === undefined ? {} : { afterMs }),
  };
};

const afterMsOf = (row: AdminExecuteRow) => {
  const left = Date.parse(row.lock?.expiresAt ?? "") - Date.now();
  return Number.isFinite(left) ? Math.max(0, left) : RETRY_AFTER_MS;
};

/**
 * Past the cut in withResults, a group too long to fit: on from the last row kept,
 * because each row knows its index. It reads as incomplete: a cut group is a refused
 * one, since the ids of completed targets always fit.
 */
export const executeContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const { index } = (kept.at(-1) ?? {}) as { index?: unknown };
  return typeof index === "number"
    ? nextCall(rawInput as AdminExecuteInput, index + 1, true)
    : undefined;
};

type Stopped = "budget" | "paused" | "ledger";

const STOPPED_CODE = {
  budget: "IN_PROGRESS",
  paused: "MCP_PAUSED",
  ledger: "AUDIT_UNAVAILABLE",
} as const;

/** The whole answer of a call, from what each target it reached did. */
const answerOf = (
  call: AdminExecuteInput,
  outcomes: readonly TargetOutcome[],
  reached: number,
  stopped: Stopped | undefined,
): AdminMcpEnvelope => {
  const total = call.targets?.length ?? 1;
  const data = dataOf(outcomes);
  const incomplete =
    call.priorIncomplete === true ||
    outcomes.some(({ state }) => !COMPLETE.has(state));
  const progress = {
    // This call's own: from a startAt it cannot know what the targets before it did.
    done: outcomes.length,
    total,
    ...(reached < total ? { remaining: total - reached } : {}),
  };
  const fields = { data, ...progress };
  const refused = [...(data.conflict ?? []), ...(data.failed ?? [])];
  const single = total === 1 ? outcomes[0] : undefined;
  if (stopped !== undefined) {
    const answer = failedEnvelope(STOPPED_CODE[stopped], {
      ...fields,
      next: nextCall(call, reached, incomplete),
    });
    return stopped === "ledger" ? { ...answer, hint: LEDGER_STOPPED } : answer;
  }
  if (data.unknown !== undefined)
    return failedEnvelope("OUTCOME_UNKNOWN", {
      ...fields,
      next: nextCall(call, 0, false),
    });
  if (refused.length > 0) {
    // Only what the same call can get past is offered again: a replay meets a stored
    // rejection unchanged, and repeating that is what next must not invite.
    const retry = refused.find(
      (row) =>
        row.lock !== undefined ||
        CODE_GUIDE[envelopeCodeOf(row.code)].retryable,
    );
    const answer = failedEnvelope(
      single === undefined ? "PARTIAL" : envelopeCodeOf(single.code),
      {
        ...fields,
        ...(retry === undefined
          ? {}
          : { next: nextCall(call, 0, false, afterMsOf(retry)) }),
      },
    );
    return call.priorIncomplete === true
      ? { ...answer, hint: CONTINUED }
      : answer;
  }
  if (call.priorIncomplete === true)
    return { ...failedEnvelope("PARTIAL", fields), hint: CONTINUED };
  if (data.queued !== undefined) {
    const queued = failedEnvelope("QUEUED", {
      ...fields,
      ...(single?.settledState === undefined
        ? {}
        : { state: single.settledState }),
      // The op's own way on when it has one: a replay of it would say the same.
      next:
        outcomes.find(({ settledNext }) => settledNext !== undefined)
          ?.settledNext ?? nextCall(call, 0, false, RETRY_AFTER_MS),
    });
    const hint = outcomes.find(
      ({ settledHint }) => settledHint !== undefined,
    )?.settledHint;
    if (hint === undefined) return queued;
    // Its hint says repeating cannot change this answer, so retryable does not say so.
    delete queued.retryable;
    return { ...queued, hint };
  }
  return { ...okEnvelope(data), ...progress };
};

/**
 * Rows go in while they fit, so every group stays whole and only the echoes are cut,
 * and `next` then replays from the first one left out. The text cap in toolResult
 * stays behind this, for one record too large to fit at all.
 */
const withResults = (
  envelope: AdminMcpEnvelope,
  call: AdminExecuteInput,
  outcomes: readonly TargetOutcome[],
): AdminMcpEnvelope => {
  const rows = outcomes.flatMap(({ index, result }) =>
    result === undefined ? [] : [{ index, ...result }],
  );
  if (rows.length === 0) return envelope;
  const data = envelope.data as AdminExecuteData;
  const whole = { ...envelope, data: { ...data, results: rows } };
  const left = ADMIN_MCP_TEXT_CAP_BYTES - CAP_MARGIN_BYTES;
  if (bytesOf(whole) <= left) return whole;
  const incomplete =
    call.priorIncomplete === true ||
    outcomes.some(({ state }) => !COMPLETE.has(state));
  // A cut always carries a `next`, of about this size whichever index it names.
  const room =
    left -
    bytesOf(envelope) -
    (envelope.next === undefined
      ? bytesOf(nextCall(call, rows.at(-1)!.index, incomplete))
      : 0);
  let used = 0;
  let kept = 0;
  while (kept < rows.length) {
    used += bytesOf(rows[kept]) + 1;
    if (used > room) break;
    kept += 1;
  }
  // Not even one fits: the text cap says so, with no way on that would just repeat.
  if (kept === 0) return whole;
  return {
    ...envelope,
    data: { ...data, results: rows.slice(0, kept) },
    next: nextCall(call, rows[kept]!.index, incomplete),
    remaining: envelope.remaining ?? rows.length - kept,
    meta: { ...envelope.meta, truncated: true },
  };
};

/**
 * The Admin's pool holds 5 connections and the Owner's screens use the same ones. One
 * call holds one at a time, but a target can stall on it for a lock wait or the
 * Backend's readiness read, so calls at once are what could starve the Owner. Past
 * this share a call is refused at once and never waits: a queue would hold its request.
 */
const EXECUTE_POOL_SHARE = 2;
let inFlight = 0;

const runCall = async (
  rawInput: unknown,
  { key, req }: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const started = performance.now();
  const call = rawInput as AdminExecuteInput;
  if (!isAdminOpName(call.op)) return unknownOpEnvelope(call.op);
  const entry: AdminOpEntry = adminOpMeta[call.op];
  if (entry.tool === "admin_execute_irreversible")
    return failedEnvelope("USE_EXECUTE_IRREVERSIBLE");
  // Class decides the tool: a read named here is not a write of any kind.
  if (entry.tool !== EXECUTE_TOOL_NAME) return unknownOpEnvelope(call.op);
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  const total = call.targets?.length ?? 1;
  if (call.selector !== undefined || total > ADMIN_EXECUTE_MAX_TARGETS)
    return failedEnvelope("USE_PREVIEW");
  const startAt = call.startAt ?? 0;
  if (startAt >= total)
    return inputInvalidEnvelope([{ path: ["startAt"], code: "too_big" }]);
  const unsafe =
    unsafeInputOf(call.input, ["input"]) ??
    unsafeInputOf(call.targets, ["targets"]);
  if (unsafe !== undefined) return inputInvalidEnvelope([unsafe]);
  const merged = (call.targets ?? [{}]).map((target) => ({
    ...call.input,
    ...target,
  }));
  // Before any effect, so a slip in one target cannot leave the batch half done. The
  // operation gets what was sent and not this parse: a save reads which keys were
  // sent, and the schema's defaults would read as clearing the rest.
  const issues = merged.flatMap((command, index) => {
    const parsed = entry.input?.safeParse(command);
    return parsed === undefined || parsed.success
      ? []
      : issuesOfError(
          parsed.error,
          entry.input,
          call.targets === undefined ? ["input"] : ["targets", String(index)],
        );
  });
  if (issues.length > 0) return inputInvalidEnvelope(issues);

  const outcomes: TargetOutcome[] = [];
  let reached = startAt;
  let stopped: Stopped | undefined;
  // Past a start row that named no target, this call's own target row names it.
  const startNamedIt = executeReferences(rawInput).targetId !== undefined;
  while (reached < total) {
    if (reached > startAt) {
      if (performance.now() - started >= EXECUTE_BUDGET_MS) {
        stopped = "budget";
        break;
      }
      try {
        // A pause saved after the door read stops the work at the next target.
        if ((await readMcpControl(req.payload)).pause) {
          stopped = "paused";
          break;
        }
      } catch {
        // A pause that cannot be read is not read as off.
        stopped = "budget";
        break;
      }
    }
    const command = merged[reached]!;
    const context: AdminOpContext = {
      req,
      key,
      requestKey: requestKeyFor(call.requestId, reached),
    };
    const outcome = await runTarget(entry, command, reached, context);
    outcomes.push(outcome);
    reached += 1;
    if (total > 1 || (!startNamedIt && outcome.id !== undefined)) {
      let target: ReturnType<NonNullable<AdminOpEntry["target"]>> | undefined;
      try {
        target = entry.target?.(command);
      } catch {
        target = undefined;
      }
      if (
        !(await auditTarget(context, call, target, outcome)) &&
        reached < total
      ) {
        stopped = "ledger";
        break;
      }
    }
  }

  const answer = withResults(
    answerOf(call, outcomes, reached, stopped),
    call,
    outcomes,
  );
  const hasBody = call.input !== undefined || call.targets !== undefined;
  const next = answer.next;
  const resend =
    next?.tool === EXECUTE_TOOL_NAME &&
    hasBody &&
    !("input" in next.args) &&
    !("targets" in next.args);
  return {
    ...answer,
    ...(resend ? { hint: `${answer.hint ?? ""}${RESEND}`.trim() } : {}),
    // Only what this answer holds: a result may be cut, and a field is often absent.
    untrusted: entry.untrusted.filter((pointer) =>
      pointerResolves(answer, pointer.split("/").slice(1)),
    ),
    meta: {
      ...answer.meta,
      ...(outcomes.length > 0 && outcomes.every(({ replayed }) => replayed)
        ? { replayed: true as const }
        : {}),
      ...(answer.code === "PARTIAL" ? { partial: true as const } : {}),
    },
  };
};

export const executeEnvelope = async (
  rawInput: unknown,
  context: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  if (inFlight >= EXECUTE_POOL_SHARE) return failedEnvelope("EXECUTE_BUSY");
  inFlight += 1;
  try {
    return await runCall(rawInput, context);
  } finally {
    inFlight -= 1;
  }
};
