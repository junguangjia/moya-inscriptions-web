import { createHash, randomUUID } from "node:crypto";

import {
  ADMIN_EXECUTE_MAX_TARGETS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminExecuteCallListedShape,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminExecuteCall,
  AdminExecuteData,
  AdminExecuteInput,
  AdminExecuteRow,
  AdminJobRef,
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminOpName,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { z } from "zod";

import { writeAuditEvent } from "../audit";
import { BACKEND_CONTRACT_MISMATCH } from "../backend-answer";
import { EXECUTE_BUDGET_MS } from "../budget";
import { readMcpControl } from "../control/state";
import { auditIdentity } from "../door";
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
import { COMPLETE, runTarget, safeRef } from "../ops/target";
import type { TargetOutcome } from "../ops/target";
import { envelopeCodeOf } from "../refusal";
import { adminOpMeta, currentOpName, lookupOp } from "../registry";
import type { AdminOpContext, AdminOpEntry } from "../registry";
import { dataOf } from "../runs/answer";
import { executeRunEnvelope } from "../runs/executor";
import { uuidOfDigest } from "../runs/keys";
import { JOB_TOOL_NAME, settlementNext } from "../settlement";
import {
  opRefusalOf,
  retiredOpEnvelope,
  unknownOpEnvelope,
  withDeprecation,
  wrongToolEnvelope,
} from "./read";

export const EXECUTE_TOOL_NAME = "admin_execute";

export const EXECUTE_DESCRIPTION = `Run one reversible write, or one op on up to ${ADMIN_EXECUTE_MAX_TARGETS} targets: {requestId,op:"editorial.publish-approved",input:{approvalId},targets:[{id:7},{id:8}]}; each merges over input. Or a run admin_preview sealed: {requestId,previewId}. A new requestId per intention; the same one replays, never repeats: retry it after OUTCOME_UNKNOWN. ok:true means every target completed; else data names each state.`;

// A plain string for op, as on admin_read: tools/list cannot carry the names within
// its token budget (section 5). A wrong name answers UNKNOWN_OP with near ones.
export const executeListedInput = z.strictObject(adminExecuteCallListedShape);

const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A call naming a previewed run, by either name: it carries nothing else. */
const runOf = (args: unknown): string | undefined => {
  const { previewId, runId } = (args ?? {}) as Record<string, unknown>;
  const run = previewId ?? runId;
  return typeof run === "string" ? run : undefined;
};

/**
 * A key per target, stable across retries: a uuid, so a Backend route takes it too.
 * Every connection acts as one `users` row, so its id goes in the hash, or two people's
 * tools that chose one requestId would meet at the CMS receipt and at the Backend. That
 * id outlives a token, so the same connection still replays. A key has its own row, and
 * its value does not change.
 */
export const requestKeyFor = (
  requestId: string,
  index: number,
  connectionId?: string,
) => {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        connectionId === undefined
          ? [requestId, index]
          : [requestId, index, connectionId],
      ),
    )
    .digest("hex");
  return uuidOfDigest(hash);
};

const SIMPLE_KEY = /^[\w-]{1,64}$/u;
const INPUT_MAX_DEPTH = 32;

/**
 * PostgreSQL holds no NUL, no input grows a prototype, and hashing a command must not
 * run out of stack. Named here, and never met as a driver error.
 */
export const unsafeInputOf = (
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
  const run = runOf(args);
  // A run's own call: its targets are frozen, and each writes a row of its own.
  if (run !== undefined)
    return {
      ...(typeof requestId === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
        ? { requestId }
        : {}),
      ...(RUN_ID.test(run) ? { runId: run } : {}),
    };
  // The registry's name, so an earlier one is recorded as the op that ran.
  const found = typeof op === "string" ? lookupOp(op) : undefined;
  const name = found !== undefined && "op" in found ? found.op : undefined;
  const entry = name === undefined ? undefined : adminOpMeta[name];
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
    ...(name === undefined ? {} : { op: name }),
    ...(typeof requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
      ? { requestId }
      : {}),
    count,
    ...(target === undefined || targetId === undefined
      ? {}
      : { targetType: target.type, targetId: String(targetId) }),
    // A cancel is filed with the run it ended, beside that run's own rows.
    ...(name === "run.cancel" &&
    typeof targetId === "string" &&
    RUN_ID.test(targetId)
      ? { runId: targetId }
      : {}),
  };
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
      ...auditIdentity(key),
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

// Long enough to carry a list of ids and short counters, and no real text: a cut
// answer has to hold its groups and `next` under the text cap.
const NEXT_ARGS_MAX_BYTES = 1_500;
const RETRY_AFTER_MS = 2_000;
// What a cut and the finished answer still add once the room is measured: its flags,
// `remaining`, the pointers of an op and the sentence on sending targets again.
const CAP_MARGIN_BYTES = 300;

const RESEND = " next leaves out input and targets: send the same ones again.";
const PREVIEW_RESEND =
  " next leaves out input and targets: send the same ones to admin_preview.";

const CONTINUED =
  "An earlier call of this batch left a target incomplete, and this answer covers only the targets from startAt on. Repeat the whole call with the same requestId and no startAt to see every target.";

const LEDGER_STOPPED =
  "The audit ledger could not record a target, so the batch stopped there. The targets named in data did run and the rest did not. Retry shortly with next.";

const REPLAYED =
  "A replayed target did not run again: what results shows of it can be what its command answered when it committed, not a fresh read. Read the record to see what holds now.";

/**
 * A community write's receipt answers what it stored, and the Owner may have undone that
 * since (section 7). Said before the rows go in, so the cut in withResults counts it.
 */
const withReplayHint = (
  envelope: AdminMcpEnvelope,
  entry: AdminOpEntry,
  outcomes: readonly TargetOutcome[],
): AdminMcpEnvelope =>
  entry.credential === "community" && outcomes.some(({ replayed }) => replayed)
    ? { ...envelope, hint: `${envelope.hint ?? ""} ${REPLAYED}`.trim() }
    : envelope;

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

const PREVIEW_TOOL = "admin_preview";

/**
 * Where a call that needs a preview goes: the same op and requestId on admin_preview,
 * with what it sent while that fits. A run's requestId lives in its own ledger, so the
 * one this call used is free there.
 */
const previewNext = (call: AdminExecuteInput): AdminMcpNext => {
  const body = {
    ...(call.input === undefined ? {} : { input: call.input }),
    ...(call.targets === undefined ? {} : { targets: call.targets }),
    ...(call.selector === undefined ? {} : { selector: call.selector }),
  };
  return {
    tool: PREVIEW_TOOL,
    args: {
      requestId: call.requestId,
      op: call.op,
      ...(bytesOf(body) <= NEXT_ARGS_MAX_BYTES && !holdsInvisible(body)
        ? body
        : {}),
    },
  };
};

const afterMsOf = (row: AdminExecuteRow) => {
  const left = Date.parse(row.lock?.expiresAt ?? "") - Date.now();
  return Number.isFinite(left) ? Math.max(0, left) : RETRY_AFTER_MS;
};

/**
 * Past the cut in withResults, a group too long to fit: on from the last row kept,
 * because each row knows its index. It reads as incomplete: a cut group is a refused
 * one, since the ids of completed targets always fit. A run's call goes on by its own
 * next, which repeats it and runs nothing twice.
 */
export const executeContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  if (runOf(rawInput) !== undefined) return undefined;
  const { index } = (kept.at(-1) ?? {}) as { index?: unknown };
  const call = rawInput as AdminExecuteInput;
  return typeof index === "number"
    ? nextCall({ ...call, op: currentOpName(call.op) }, index + 1, true)
    : undefined;
};

type Stopped = "budget" | "paused" | "ledger";

const STOPPED_CODE = {
  budget: "IN_PROGRESS",
  paused: "MCP_PAUSED",
  ledger: "AUDIT_UNAVAILABLE",
} as const;

/**
 * How the queued targets go on. Each op's own way, when every one has it: a read of
 * their jobs needs nothing repeated, so their refs join into one, while they fit. Past
 * that, or for a target whose settlement could not be read, the same call replays and
 * asks again, which runs nothing twice.
 */
const queuedNext = (
  call: AdminExecuteInput,
  outcomes: readonly TargetOutcome[],
): AdminMcpNext => {
  const replay = nextCall(call, 0, false, RETRY_AFTER_MS);
  const ways = outcomes
    .filter(({ state }) => state === "queued")
    .map(({ settledNext }) => settledNext);
  const [first] = ways;
  if (first === undefined || ways.includes(undefined)) return replay;
  if (first.tool !== JOB_TOOL_NAME) return first;
  const joined = settlementNext(
    ways.flatMap((way) => way!.args.refs as AdminJobRef[]),
  );
  return bytesOf(joined) <= NEXT_ARGS_MAX_BYTES ? joined : replay;
};

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
  // A replay reads an unreadable answer the same way, so only a lost one is offered again.
  if (data.unknown?.every(({ code }) => code === BACKEND_CONTRACT_MISMATCH))
    return failedEnvelope(BACKEND_CONTRACT_MISMATCH, fields);
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
        // A target still waiting on its jobs has a way on, whatever stopped the others.
        // One whose input made it irreversible goes on through a preview of the same.
        ...(single?.code === "PREVIEW_REQUIRED"
          ? { next: previewNext(call) }
          : retry !== undefined
            ? { next: nextCall(call, 0, false, afterMsOf(retry)) }
            : data.queued === undefined
              ? {}
              : { next: queuedNext(call, outcomes) }),
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
      next: queuedNext(call, outcomes),
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
 * A preview and a run's execution take the same share: each holds the pool as a write.
 */
const EXECUTE_POOL_SHARE = 2;
let inFlight = 0;

export const withinExecuteShare = async (
  work: () => Promise<AdminMcpEnvelope>,
): Promise<AdminMcpEnvelope> => {
  if (inFlight >= EXECUTE_POOL_SHARE) return failedEnvelope("EXECUTE_BUSY");
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
  }
};

const runCall = async (
  rawInput: unknown,
  context: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const call = rawInput as AdminExecuteCall;
  // A previewed run carries only its id: what runs is what was frozen.
  if (call.previewId !== undefined || call.runId !== undefined)
    return executeRunEnvelope(
      {
        requestId: call.requestId,
        ...(call.previewId === undefined ? {} : { previewId: call.previewId }),
        ...(call.runId === undefined ? {} : { runId: call.runId }),
      },
      EXECUTE_TOOL_NAME,
      context,
    );
  const asCalled = rawInput as AdminExecuteInput;
  const found = lookupOp(asCalled.op);
  if ("unknown" in found) return unknownOpEnvelope(asCalled.op);
  if ("retired" in found) return retiredOpEnvelope(found.retired);
  // Under the registry's name, so every way on an answer gives calls it.
  return withDeprecation(
    await runOp(found.op, { ...asCalled, op: found.op }, context),
    found.deprecated === undefined ? [] : [found.deprecated],
  );
};

const runOp = async (
  name: AdminOpName,
  call: AdminExecuteInput,
  { key, req }: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const started = performance.now();
  const entry: AdminOpEntry = adminOpMeta[name];
  if (entry.tool === "admin_execute_irreversible")
    return failedEnvelope("USE_EXECUTE_IRREVERSIBLE");
  // Class decides the tool: a read named here is not a write of any kind.
  if (entry.tool !== EXECUTE_TOOL_NAME) return wrongToolEnvelope(entry.tool);
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  const total = call.targets?.length ?? 1;
  if (call.selector !== undefined || total > ADMIN_EXECUTE_MAX_TARGETS) {
    const answer = failedEnvelope("USE_PREVIEW", { next: previewNext(call) });
    return "input" in answer.next!.args ||
      "targets" in answer.next!.args ||
      "selector" in answer.next!.args
      ? answer
      : { ...answer, hint: `${answer.hint}${PREVIEW_RESEND}` };
  }
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
  // sent, and the schema's defaults would read as clearing the rest. A slip in the
  // shared input names its choices once, not once a target.
  const named = new Set<string>();
  const issues = merged.flatMap((command, index) => {
    const parsed = entry.input?.safeParse(command);
    return parsed === undefined || parsed.success
      ? []
      : issuesOfError(
          parsed.error,
          entry.input,
          call.targets === undefined ? ["input"] : ["targets", String(index)],
          named,
        );
  });
  if (issues.length > 0) return inputInvalidEnvelope(issues);

  const outcomes: TargetOutcome[] = [];
  let reached = startAt;
  let stopped: Stopped | undefined;
  // Past a start row that named no target, this call's own target row names it.
  const startNamedIt =
    (executeReferences(call) as { targetId?: string }).targetId !== undefined;
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
      requestKey: requestKeyFor(call.requestId, reached, key.connection?.id),
    };
    // Never more than reversible here: a target that rises answers PREVIEW_REQUIRED.
    const outcome = await runTarget(
      entry,
      command,
      reached,
      context,
      "reversible",
    );
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
    withReplayHint(answerOf(call, outcomes, reached, stopped), entry, outcomes),
    call,
    outcomes,
  );
  const hasBody = call.input !== undefined || call.targets !== undefined;
  const next = answer.next;
  const resend =
    (next?.tool === EXECUTE_TOOL_NAME || next?.tool === PREVIEW_TOOL) &&
    hasBody &&
    !("input" in next.args) &&
    !("targets" in next.args);
  return {
    ...answer,
    ...(resend
      ? {
          hint: `${answer.hint ?? ""}${next.tool === PREVIEW_TOOL ? PREVIEW_RESEND : RESEND}`.trim(),
        }
      : {}),
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
      ...(outcomes.some(({ mediaGate }) => mediaGate !== undefined)
        ? { mediaGate: "off" as const }
        : {}),
    },
  };
};

export const executeEnvelope = (
  rawInput: unknown,
  context: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> =>
  withinExecuteShare(() => runCall(rawInput, context));
