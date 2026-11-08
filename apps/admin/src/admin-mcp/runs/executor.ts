import { randomUUID } from "node:crypto";

import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_PREVIEW_ROWS_MAX,
  ADMIN_RUN_EXECUTE_MAX,
  PERSONAL_INFO_OWNER_REVIEW,
  SELF_ONLY_OWNER_REVIEW,
  adminRunDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminJobRef,
  AdminMcpCode,
  AdminMcpEnvelope,
  AdminMcpNext,
  AiSelectItem,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import { CommunityOperatorError } from "../../community/backend";
import { writeAuditEvent } from "../audit";
import { BACKEND_CONTRACT_MISMATCH } from "../backend-answer";
import { EXECUTE_BUDGET_MS } from "../budget";
import { readMcpControl } from "../control/state";
import { auditIdentity } from "../door";
import type { AdminMcpKey } from "../door";
import {
  CODE_GUIDE,
  failedEnvelope,
  okEnvelope,
  pointerResolves,
} from "../envelope";
import { communityRefusal } from "../ops/community-reads";
import { issueRunTicket } from "../ops/define";
import { COMPLETE, runTarget, safeRef } from "../ops/target";
import type { TargetOutcome } from "../ops/target";
import { envelopeCodeOf } from "../refusal";
import { adminOpMeta, isAdminOpName } from "../registry";
import type { AdminOpContext, AdminOpEntry } from "../registry";
import { JOB_TOOL_NAME, readSettlement } from "../settlement";
import { opRefusalOf, wrongToolEnvelope } from "../tools/read";
import { dataOf } from "./answer";
import { runCredentialOf, runTargetKey } from "./keys";
import {
  acquireLease,
  markAttempted,
  moveRun,
  readPendingTargets,
  readQueuedTargets,
  readRun,
  readUnfinishedTargets,
  recordOutcome,
  releaseLease,
  renewLease,
} from "./ledger";
import type { LedgerRefusal, LedgerRun, LedgerTarget } from "./ledger";
import { executeEntryState, finalStateOf } from "./state";
import { stampsOf, withheldCode } from "./sources";

/**
 * A frozen run's execution (admin-mcp-completion-v1 section 8, S8 plan 2.6), on
 * admin_execute for a reversible run and admin_execute_irreversible for an irreversible
 * one. Nothing of the call but its requestId and the run's id travels, so what runs is
 * what the preview froze. One call at a time holds the run's lease; each target is
 * stamp-checked once, marked attempted, run through the per-target core under the
 * run's ticket and its own key, and its outcome lands before the next starts. The
 * requestId only goes into the audit: a run resumes under any.
 */

export type RunTool = "admin_execute" | "admin_execute_irreversible";

export interface RunCall {
  readonly requestId: string;
  readonly previewId?: string | undefined;
  readonly runId?: string | undefined;
}

interface Context {
  readonly key: AdminMcpKey;
  readonly req: PayloadRequest;
}

/** Where the Owner confirms a run: the control page, which no key can open. */
export const RUN_CONFIRM_PATH = "/admin/mcp-control";

/** Queued targets one settling call reads again; a read can take a Backend call each. */
const SETTLE_MAX = 50;
const RETRY_AFTER_MS = 2_000;
// What the answer adds once its rows are measured: flags, progress, `next` and a hint.
const CAP_MARGIN_BYTES = 600;

/** Fixed English, so a hint never carries a caller's text. */
const HINTS = {
  planning:
    "This run is still planning: it runs once its preview has every target. Send the rest through admin_preview.",
  ledger:
    "The audit ledger could not record a target, so the run stopped there. The targets named in data did run and the rest did not. Retry shortly with next.",
  lease:
    "Another call holds this run, so this one stopped where it was. Retry shortly with next; no target runs twice.",
  withheld:
    "A target that had already been tried is now withheld from this credential, so whether its effect committed is not known here. It stays with the Owner.",
  replayed:
    "A replayed target did not run again: what results shows of it can be what its command answered when it committed, not a fresh read. Read the record to see what holds now.",
} as const;

const runNext = (
  tool: RunTool,
  requestId: string,
  runId: string,
  afterMs?: number,
): AdminMcpNext => ({
  tool,
  args: { requestId, runId },
  ...(afterMs === undefined ? {} : { afterMs }),
});

/** What a target keeps of its outcome: ids, states and job refs, never content. */
interface Stored {
  readonly id?: number | string;
  readonly settledState?: string;
  readonly alreadyApplied?: true;
  readonly refs?: readonly AdminJobRef[];
}

const storedOf = (outcome: TargetOutcome): Stored => {
  const refs =
    outcome.settledNext?.tool === JOB_TOOL_NAME
      ? (outcome.settledNext.args.refs as AdminJobRef[])
      : undefined;
  return {
    ...(outcome.id === undefined ? {} : { id: outcome.id }),
    ...(outcome.settledState === undefined
      ? {}
      : { settledState: outcome.settledState }),
    ...(outcome.alreadyApplied ? { alreadyApplied: true as const } : {}),
    ...(refs === undefined ? {} : { refs }),
  };
};

/** A target as the ledger holds it, read back as an outcome for an answer. */
const outcomeOfTarget = (target: LedgerTarget): TargetOutcome => {
  const stored = (target.result ?? {}) as Stored;
  const id = safeRef(target.ref.id ?? stored.id);
  return {
    index: target.index,
    ...(id === undefined ? {} : { id }),
    state: target.state as TargetOutcome["state"],
    code:
      target.code ??
      ((COMPLETE as ReadonlySet<string>).has(target.state) ? "OK" : "QUEUED"),
    ...(stored.settledState === undefined
      ? {}
      : { settledState: stored.settledState }),
    ...(stored.alreadyApplied ? { alreadyApplied: true as const } : {}),
  };
};

/**
 * What stays pending for the next call to repeat under the same key: a target whose
 * effect may have committed, or one a short wait can get past. A repeat runs nothing
 * twice. BACKEND_CONTRACT_MISMATCH reads the same answer on a repeat, so it lands.
 */
const heldFor = (outcome: TargetOutcome) => {
  if (outcome.code === BACKEND_CONTRACT_MISMATCH) return undefined;
  if (outcome.state === "unknown") return { code: outcome.code };
  if (outcome.state !== "conflict" && outcome.state !== "failed")
    return undefined;
  if (outcome.lock !== undefined) {
    const left = Date.parse(outcome.lock.expiresAt ?? "") - Date.now();
    return {
      code: outcome.code,
      afterMs: Number.isFinite(left) ? Math.max(0, left) : RETRY_AFTER_MS,
    };
  }
  return CODE_GUIDE[envelopeCodeOf(outcome.code)].retryable
    ? { code: outcome.code, afterMs: RETRY_AFTER_MS }
    : undefined;
};

type Stop =
  | { readonly kind: "budget" | "paused" | "ledger" | "lease" | "mismatch" }
  | { readonly kind: "held"; readonly code: string; readonly afterMs?: number }
  | { readonly kind: "refused"; readonly envelope: AdminMcpEnvelope };

const targetOf = (entry: AdminOpEntry, command: unknown) => {
  try {
    return entry.target?.(command);
  } catch {
    return undefined;
  }
};

/** A run's own: each target's finish, with the run's class and id and no tool. */
const auditTarget = async (
  { req, key }: Context,
  run: LedgerRun,
  requestId: string,
  entry: AdminOpEntry,
  command: unknown,
  { id, state, code }: TargetOutcome,
) => {
  const target = targetOf(entry, command);
  try {
    await writeAuditEvent(req.payload, {
      callId: randomUUID(),
      phase: "finish",
      class: run.klass === "irreversible" ? "irreversible" : "reversible",
      op: run.op,
      requestId,
      runId: run.runId,
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

const awaitingEnvelope = (run: LedgerRun): AdminMcpEnvelope =>
  failedEnvelope("AWAITING_OWNER", {
    runId: run.runId,
    state: run.state,
    data: adminRunDataSchema.parse({
      awaiting: {
        path: RUN_CONFIRM_PATH,
        expiresAt: run.expiresAt.toISOString(),
      },
    }),
    total: run.targetCount,
  });

const refusalEnvelope = (
  { code, issues }: LedgerRefusal,
  runId: string,
): AdminMcpEnvelope =>
  failedEnvelope(code, {
    runId,
    ...(issues === undefined
      ? {}
      : {
          issues: issues.map(({ path, code: issue }) => ({
            path: [...path],
            code: issue,
          })),
        }),
  });

interface Drive {
  readonly run: LedgerRun;
  readonly outcomes: readonly TargetOutcome[];
  readonly stop?: Stop;
}

/** Each target's command: the common input under its own frozen one. */
const commandOf = (run: LedgerRun, target: LedgerTarget) => ({
  ...run.commonInput,
  ...target.frozenInput,
});

/**
 * The targets still to run, a block at a time. Each block reads its stamps once, for
 * the targets never tried: a tried one may have moved by its own effect, and replays.
 */
const runTargets = async (
  run: LedgerRun,
  entry: AdminOpEntry,
  owner: string,
  requestId: string,
  started: number,
  context: Context,
): Promise<Drive> => {
  const { req, key } = context;
  const { payload } = req;
  const outcomes: TargetOutcome[] = [];
  const allow = run.klass === "irreversible" ? "irreversible" : "reversible";
  const source = entry.previewHooks?.stampSource ?? "none";
  let current = run;
  let first = true;
  for (;;) {
    const block = await readPendingTargets(
      payload,
      run.runId,
      ADMIN_RUN_EXECUTE_MAX,
    );
    if (block.length === 0) return { run: current, outcomes };
    let fresh: ReadonlyMap<string, AiSelectItem> | undefined;
    if (source !== "none") {
      const ids = block.flatMap((target) => {
        const id = targetOf(entry, commandOf(run, target))?.id;
        return target.attemptedAt === null && id !== undefined ? [id] : [];
      });
      try {
        fresh = ids.length === 0 ? new Map() : await stampsOf(source, ids);
      } catch (error) {
        if (!(error instanceof CommunityOperatorError)) throw error;
        return {
          run: current,
          outcomes,
          stop: { kind: "refused", envelope: communityRefusal(error) },
        };
      }
    }
    for (const target of block) {
      if (!first) {
        if (performance.now() - started >= EXECUTE_BUDGET_MS)
          return { run: current, outcomes, stop: { kind: "budget" } };
        try {
          // A pause saved after the door read stops the run at the next target.
          if ((await readMcpControl(payload)).pause)
            return { run: current, outcomes, stop: { kind: "paused" } };
        } catch {
          // A pause that cannot be read is not read as off.
          return { run: current, outcomes, stop: { kind: "budget" } };
        }
      }
      first = false;
      if (!(await renewLease(payload, { runId: run.runId, owner })))
        return { run: current, outcomes, stop: { kind: "lease" } };
      const command = commandOf(run, target);
      const land = async (
        outcome: TargetOutcome,
      ): Promise<Stop | undefined> => {
        const landed = await recordOutcome(payload, {
          runId: run.runId,
          index: target.index,
          leaseOwner: owner,
          state: outcome.state,
          code: outcome.code,
          result: storedOf(outcome),
        });
        if (landed === undefined) return { kind: "lease" };
        current = landed;
        outcomes.push(outcome);
        if (
          !(await auditTarget(context, run, requestId, entry, command, outcome))
        )
          return { kind: "ledger" };
        return undefined;
      };
      // Moved since its preview, or withheld now: a conflict, and nothing runs.
      if (target.attemptedAt === null && fresh !== undefined) {
        const id = targetOf(entry, command)?.id;
        const item = id === undefined ? undefined : fresh.get(id);
        const code =
          withheldCode(item) ??
          (item!.stamp === target.stamp ? undefined : "STATE_CONFLICT");
        if (code !== undefined) {
          const stop = await land({
            index: target.index,
            id: safeRef(target.ref.id),
            state: "conflict",
            code,
          });
          if (stop !== undefined) return { run: current, outcomes, stop };
          continue;
        }
      }
      const tried = target.attemptedAt !== null;
      // Before its effect, so a crash between the two leaves a target that replays.
      if (
        !(await markAttempted(payload, {
          runId: run.runId,
          index: target.index,
          leaseOwner: owner,
        }))
      )
        return { run: current, outcomes, stop: { kind: "lease" } };
      const targetContext: AdminOpContext = {
        req,
        key,
        requestKey: runTargetKey(run.runId, target.index),
        run: issueRunTicket(run.runId),
      };
      let outcome = await runTarget(
        entry,
        command,
        target.index,
        targetContext,
        allow,
      );
      // Tried before and withheld now: it may have committed then, so it is not known.
      if (
        tried &&
        (outcome.code === SELF_ONLY_OWNER_REVIEW ||
          outcome.code === PERSONAL_INFO_OWNER_REVIEW)
      )
        outcome = { ...outcome, state: "unknown" };
      const held = heldFor(outcome);
      if (held !== undefined) {
        outcomes.push(outcome);
        return {
          run: current,
          outcomes,
          stop: { kind: "held", ...held },
        };
      }
      const stop = await land(outcome);
      if (stop !== undefined) return { run: current, outcomes, stop };
      if (outcome.code === BACKEND_CONTRACT_MISMATCH)
        return { run: current, outcomes, stop: { kind: "mismatch" } };
    }
  }
};

/** A queued target's jobs, read again: still open, stopped, or done. */
const settledAgain = async (
  target: LedgerTarget,
  refs: readonly AdminJobRef[],
  req: PayloadRequest,
): Promise<TargetOutcome> => {
  const base = outcomeOfTarget(target);
  try {
    let failedJobs: string[] = [];
    for (const ref of refs) {
      const { open, failed, failedJobs: jobs } = await readSettlement(ref, req);
      if (open > 0)
        return { ...base, state: "queued", settledState: "media_jobs_open" };
      if (failed > 0) failedJobs = [...failedJobs, ...jobs];
    }
    if (failedJobs.length > 0)
      return {
        ...base,
        state: "failed",
        code: "MEDIA_JOB_FAILED",
        jobs: failedJobs.slice(0, 3),
      };
    return {
      ...base,
      state: base.alreadyApplied ? "already_applied" : "applied",
      code: "OK",
    };
  } catch {
    return { ...base, state: "queued", settledState: "settlement_unread" };
  }
};

/**
 * Once every target has run, the queued ones are read again, up to 50 a call: by the
 * job refs they kept, or by replaying the target under its own key, which runs nothing
 * twice. Each lands when it settles.
 */
const settleQueued = async (
  run: LedgerRun,
  entry: AdminOpEntry,
  owner: string,
  requestId: string,
  started: number,
  context: Context,
): Promise<Drive> => {
  const { req, key } = context;
  const { payload } = req;
  const outcomes: TargetOutcome[] = [];
  const allow = run.klass === "irreversible" ? "irreversible" : "reversible";
  let current = run;
  for (const target of await readQueuedTargets(
    payload,
    run.runId,
    SETTLE_MAX,
  )) {
    if (performance.now() - started >= EXECUTE_BUDGET_MS)
      return { run: current, outcomes, stop: { kind: "budget" } };
    if (!(await renewLease(payload, { runId: run.runId, owner })))
      return { run: current, outcomes, stop: { kind: "lease" } };
    const command = commandOf(run, target);
    const refs = ((target.result ?? {}) as Stored).refs;
    const outcome =
      refs !== undefined && refs.length > 0
        ? await settledAgain(target, refs, req)
        : await runTarget(
            entry,
            command,
            target.index,
            {
              req,
              key,
              requestKey: runTargetKey(run.runId, target.index),
              run: issueRunTicket(run.runId),
            },
            allow,
          );
    outcomes.push(outcome);
    if (outcome.state === "queued" || heldFor(outcome) !== undefined) continue;
    const landed = await recordOutcome(payload, {
      runId: run.runId,
      index: target.index,
      leaseOwner: owner,
      state: outcome.state,
      code: outcome.code,
      result: storedOf(outcome),
    });
    if (landed === undefined)
      return { run: current, outcomes, stop: { kind: "lease" } };
    current = landed;
    if (!(await auditTarget(context, run, requestId, entry, command, outcome)))
      return { run: current, outcomes, stop: { kind: "ledger" } };
  }
  return { run: current, outcomes };
};

const STOP_CODE: Readonly<
  Record<"budget" | "paused" | "ledger" | "lease", Exclude<AdminMcpCode, "OK">>
> = {
  budget: "IN_PROGRESS",
  paused: "MCP_PAUSED",
  ledger: "AUDIT_UNAVAILABLE",
  lease: "CONCURRENT_OPERATION_BUSY",
};

const progressOf = (run: LedgerRun) => {
  const pending = run.counts.pending ?? 0;
  return {
    done: run.targetCount - pending,
    total: run.targetCount,
    ...(pending > 0 ? { remaining: pending } : {}),
  };
};

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The op's echoes while they fit, so the groups always do; a cut says so. */
const withResults = (
  envelope: AdminMcpEnvelope,
  outcomes: readonly TargetOutcome[],
): AdminMcpEnvelope => {
  const rows = outcomes.flatMap(({ index, result }) =>
    result === undefined ? [] : [{ index, ...result }],
  );
  if (rows.length === 0) return envelope;
  const room = ADMIN_MCP_TEXT_CAP_BYTES - CAP_MARGIN_BYTES - bytesOf(envelope);
  let used = 0;
  let kept = 0;
  while (kept < rows.length) {
    used += bytesOf(rows[kept]) + 1;
    if (used > room) break;
    kept += 1;
  }
  if (kept === 0) return envelope;
  return {
    ...envelope,
    data: { ...(envelope.data as object), results: rows.slice(0, kept) },
    ...(kept < rows.length
      ? { meta: { ...envelope.meta, truncated: true as const } }
      : {}),
  };
};

/**
 * The answer of one execute call: the targets it reached, grouped as admin_execute
 * groups them, and the run's progress. The call that ends the run also names every
 * target that did not complete, those frozen as conflicts at preview included.
 */
const answerOf = async (
  { run, outcomes, stop }: Drive,
  entry: AdminOpEntry,
  tool: RunTool,
  requestId: string,
  { req }: Context,
  replayed = false,
): Promise<AdminMcpEnvelope> => {
  const next = (afterMs?: number) =>
    runNext(tool, requestId, run.runId, afterMs);
  const ended =
    run.state === "succeeded" ||
    run.state === "partial" ||
    run.state === "failed";
  const named = ended
    ? (
        await readUnfinishedTargets(
          req.payload,
          run.runId,
          ADMIN_PREVIEW_ROWS_MAX,
        )
      )
        .filter(({ index }) => !outcomes.some((row) => row.index === index))
        .map(outcomeOfTarget)
    : [];
  const cancelled = run.counts.cancelled ?? 0;
  const data = adminRunDataSchema.parse({
    ...dataOf([...named, ...outcomes].sort((a, b) => a.index - b.index)),
    ...(cancelled > 0 ? { cancelled } : {}),
  });
  const fields = {
    data,
    runId: run.runId,
    state: run.state,
    ...progressOf(run),
  };
  const meta = replayed ? { replayed: true as const } : {};
  let answer: AdminMcpEnvelope;
  if (stop?.kind === "refused")
    answer = {
      ...stop.envelope,
      ...fields,
      ...(stop.envelope.retryable ? { next: next(RETRY_AFTER_MS) } : {}),
    };
  else if (stop?.kind === "mismatch")
    answer = failedEnvelope(BACKEND_CONTRACT_MISMATCH, fields);
  else if (stop?.kind === "held")
    answer = failedEnvelope(
      stop.code === "OUTCOME_UNKNOWN"
        ? "OUTCOME_UNKNOWN"
        : envelopeCodeOf(stop.code),
      { ...fields, next: next(stop.afterMs) },
    );
  else if (stop !== undefined) {
    answer = failedEnvelope(STOP_CODE[stop.kind], {
      ...fields,
      next: next(stop.kind === "lease" ? RETRY_AFTER_MS : undefined),
    });
    if (stop.kind === "ledger") answer = { ...answer, hint: HINTS.ledger };
    if (stop.kind === "lease") answer = { ...answer, hint: HINTS.lease };
  } else if (run.state === "settling" || run.state === "running")
    answer = failedEnvelope("QUEUED", {
      ...fields,
      next: next(RETRY_AFTER_MS),
    });
  else if (run.state === "succeeded")
    answer = { ...okEnvelope(data), ...fields };
  else
    answer = {
      ...failedEnvelope("PARTIAL", fields),
      meta: { partial: true as const },
    };
  if (
    outcomes.some(
      ({ code, state }) =>
        state === "unknown" &&
        code !== "OUTCOME_UNKNOWN" &&
        code !== BACKEND_CONTRACT_MISMATCH,
    )
  )
    answer = {
      ...answer,
      hint: `${answer.hint ?? ""} ${HINTS.withheld}`.trim(),
    };
  // A community receipt answers what it stored, and the Owner may have undone it since.
  if (
    entry.credential === "community" &&
    outcomes.some(({ replayed: again }) => again)
  )
    answer = {
      ...answer,
      hint: `${answer.hint ?? ""} ${HINTS.replayed}`.trim(),
    };
  const whole = withResults(
    {
      ...answer,
      meta: {
        ...answer.meta,
        ...meta,
        ...(outcomes.some(({ mediaGate }) => mediaGate !== undefined)
          ? { mediaGate: "off" as const }
          : {}),
      },
    },
    outcomes,
  );
  // Only what this answer holds: an echo may be cut, and a field is often absent.
  return {
    ...whole,
    untrusted: entry.untrusted.filter((pointer) =>
      pointerResolves(whole, pointer.split("/").slice(1)),
    ),
  };
};

/**
 * Settling, then the end: settled when none is pending or queued any more. A target
 * this call ran has just read its jobs, so they are read again on the next call.
 */
const finish = async (
  drive: Drive,
  entry: AdminOpEntry,
  owner: string,
  requestId: string,
  started: number,
  context: Context,
): Promise<Drive> => {
  if (drive.stop !== undefined) return drive;
  const { payload } = context.req;
  let { run } = drive;
  if ((run.counts.queued ?? 0) > 0) {
    if (run.state === "running") {
      const moved = await moveRun(payload, {
        credential: run.credential,
        runId: run.runId,
        from: "running",
        to: "settling",
        leaseOwner: owner,
      });
      if (moved === undefined) return { ...drive, stop: { kind: "lease" } };
      run = moved;
    }
    if (drive.outcomes.length > 0) return { ...drive, run };
    const settled = await settleQueued(
      run,
      entry,
      owner,
      requestId,
      started,
      context,
    );
    if (settled.stop !== undefined) return settled;
    run = settled.run;
    if ((run.counts.queued ?? 0) > 0) return settled;
    drive = settled;
  }
  const final = finalStateOf(run.counts);
  if (final === undefined || final === "settling") return { ...drive, run };
  const ended = await moveRun(payload, {
    credential: run.credential,
    runId: run.runId,
    from: run.state,
    to: final,
    leaseOwner: owner,
  });
  return ended === undefined
    ? { ...drive, run, stop: { kind: "lease" } }
    : { ...drive, run: ended };
};

const execute = async (
  call: RunCall,
  tool: RunTool,
  context: Context,
): Promise<AdminMcpEnvelope> => {
  const started = performance.now();
  const { req, key } = context;
  const { payload } = req;
  const runId = (call.previewId ?? call.runId)!;
  const credential = runCredentialOf(key).credential;
  const read = await readRun(payload, credential, runId);
  // Another credential's run, or none: the same answer, so an id tells nothing.
  if (read === undefined || read.run.klass === "read")
    return failedEnvelope("NOT_FOUND");
  const { run, stale } = read;
  // Class decides the tool, so the irreversible one is never reached by mistake.
  if (tool === "admin_execute" && run.klass === "irreversible")
    return failedEnvelope("USE_EXECUTE_IRREVERSIBLE", { runId });
  if (tool === "admin_execute_irreversible" && run.klass === "reversible")
    return { ...wrongToolEnvelope("admin_execute"), runId };
  if (run.state === "expired")
    return failedEnvelope(stale ? "PREVIEW_STALE" : "PREVIEW_EXPIRED", {
      runId,
    });
  if (run.state === "cancelled")
    return failedEnvelope("RUN_CANCELLED", { runId });
  if (run.state === "planning")
    return {
      ...failedEnvelope("IN_PROGRESS", { runId, state: run.state }),
      hint: HINTS.planning,
    };
  if (!isAdminOpName(run.op)) return failedEnvelope("PREVIEW_STALE", { runId });
  const entry: AdminOpEntry = adminOpMeta[run.op];
  if (run.state === "awaiting_owner") return awaitingEnvelope(run);
  if (
    run.state === "succeeded" ||
    run.state === "partial" ||
    run.state === "failed"
  )
    return answerOf(
      { run, outcomes: [] },
      entry,
      tool,
      call.requestId,
      context,
      true,
    );
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return { ...refusal, runId };

  const owner = randomUUID();
  const leased = await acquireLease(payload, { credential, runId, owner });
  if (!leased.ok) {
    if (leased.code === "CONCURRENT_OPERATION_BUSY")
      return failedEnvelope("CONCURRENT_OPERATION_BUSY", {
        runId,
        next: runNext(tool, call.requestId, runId, leased.afterMs),
      });
    // It moved since the read: answer it as it stands now.
    return leased.state === undefined
      ? refusalEnvelope(leased, runId)
      : execute(call, tool, context);
  }
  try {
    let current = leased.run;
    if (current.state === "previewed" || current.state === "confirmed") {
      // Read now, never the request's copy: the Owner may have lowered it since.
      const { threshold } = await readMcpControl(payload);
      const to = executeEntryState(
        current,
        current.targetCount - (current.counts.conflict ?? 0),
        threshold,
      )!;
      const moved = await moveRun(payload, {
        credential,
        runId,
        from: current.state,
        to,
        leaseOwner: owner,
      });
      if (moved === undefined)
        return failedEnvelope("CONCURRENT_OPERATION_BUSY", {
          runId,
          next: runNext(tool, call.requestId, runId, RETRY_AFTER_MS),
        });
      if (to === "awaiting_owner") return awaitingEnvelope(moved);
      current = moved;
    }
    const drive =
      current.state === "running"
        ? await runTargets(
            current,
            entry,
            owner,
            call.requestId,
            started,
            context,
          )
        : { run: current, outcomes: [] };
    return await answerOf(
      await finish(drive, entry, owner, call.requestId, started, context),
      entry,
      tool,
      call.requestId,
      context,
    );
  } finally {
    await releaseLease(payload, { runId, owner }).catch(() => undefined);
  }
};

/** A stamp read the Backend refused, outside a target, says so by name. */
export const executeRunEnvelope = async (
  call: RunCall,
  tool: RunTool,
  context: Context,
): Promise<AdminMcpEnvelope> => {
  try {
    return await execute(call, tool, context);
  } catch (error) {
    if (error instanceof CommunityOperatorError) return communityRefusal(error);
    throw error;
  }
};
