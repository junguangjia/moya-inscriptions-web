import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_READ_PAGE_SIZE_MAX,
  ADMIN_RUN_REASON_SHOWN,
  adminRunAboutSchema,
  adminRunCancelEchoSchema,
  adminRunCancelInputSchema,
  adminRunListDataSchema,
  adminRunListInputSchema,
  adminRunRowSchema,
  adminRunTargetRowSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminRunRow,
  AdminRunTargetRow,
  AdminRunTargetState,
} from "@moya/contracts/internal/admin-mcp";

import { controlFor } from "../control/state";
import {
  indexCursor,
  indexOfCursor,
  runCursor,
  runKeysetOfCursor,
} from "../cursor";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import type { AdminOpContext } from "../ops/define";
import { safeRef } from "../ops/target";
import { runCredentialOf } from "./keys";
import { cancelRun, listRuns, readRun, readTargetStates } from "./ledger";
import type { LedgerRun, LedgerTarget } from "./ledger";
import { hasDeadline, isStalled } from "./state";

/**
 * list.runs and run.cancel (admin-mcp-completion-v1 section 8): the engine's own two
 * ops, on the credential that made each run. Another credential's run reads as none,
 * a run's frozen input never shows, and a page fits the text cap whole, so its `next`
 * always goes on from the last row it holds.
 */

const DEFAULT_PAGE_SIZE = 20;
// What an answer holds besides its rows: the envelope, a `next` with its cursor, meta.
const CAP_MARGIN_BYTES = 1_000;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const FIXED_WORD = /^[a-z][a-z0-9_]{1,63}$/u;

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** How many leading rows fit beside what the answer already holds. */
const fitting = (rows: readonly unknown[], around: unknown): number => {
  let room = ADMIN_MCP_TEXT_CAP_BYTES - CAP_MARGIN_BYTES - bytesOf(around);
  let kept = 0;
  for (const row of rows) {
    room -= bytesOf(row) + 1;
    if (room < 0) break;
    kept += 1;
  }
  return kept;
};

const tallyOf = (
  counts: LedgerRun["counts"],
): Partial<Record<AdminRunTargetState, number>> =>
  Object.fromEntries(
    Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0),
  );

const rowOf = (run: LedgerRun, threshold: number, now: Date): AdminRunRow => {
  const pending = run.counts.pending ?? 0;
  // Before it runs, a conflict found at preview is all its conflicts, and never runs.
  const runnable = run.targetCount - (run.counts.conflict ?? 0);
  return adminRunRowSchema.parse({
    runId: run.runId,
    op: run.op,
    class: run.klass,
    state: run.state,
    count: run.targetCount,
    done: run.targetCount - pending,
    counts: tallyOf(run.counts),
    needsOwnerConfirmation:
      run.state === "awaiting_owner" ||
      (run.state === "previewed" &&
        run.klass === "irreversible" &&
        runnable > threshold),
    ...(isStalled(run, now) ? { stalled: true } : {}),
    ...(hasDeadline(run.state)
      ? { expiresAt: run.expiresAt.toISOString() }
      : {}),
    createdAt: run.createdAt.toISOString(),
  });
};

/** The reason in the caller's own words, cut by code point where it runs long. */
const reasonOf = (reason: string | null) => {
  if (reason === null) return {};
  const points = Array.from(reason);
  return points.length <= ADMIN_RUN_REASON_SHOWN
    ? { reason }
    : {
        reason: points.slice(0, ADMIN_RUN_REASON_SHOWN).join(""),
        reasonLength: points.length,
      };
};

const targetRowOf = (target: LedgerTarget): AdminRunTargetRow => {
  const stored = (target.result ?? {}) as {
    readonly id?: unknown;
    readonly settledState?: unknown;
  };
  const id = safeRef(target.ref.id ?? stored.id);
  return adminRunTargetRowSchema.parse({
    index: target.index,
    ...(id === undefined ? {} : { id }),
    state: target.state,
    ...(target.code !== null && FIXED_CODE.test(target.code)
      ? { code: target.code }
      : {}),
    ...(target.state === "queued" &&
    typeof stored.settledState === "string" &&
    FIXED_WORD.test(stored.settledState)
      ? { settledState: stored.settledState }
      : {}),
  });
};

const invalidCursor = () =>
  inputInvalidEnvelope([{ path: ["cursor"], code: "invalid_cursor" }]);

type Read = NonNullable<AdminOpContext["read"]>;

/** Rows of fixed words: no count view, projection or grouping means anything here. */
const unreadArgsOf = (read: Read) =>
  [
    ...(read.view === "count" ? (["view"] as const) : []),
    ...(read.fields === undefined ? [] : (["fields"] as const)),
    ...(read.groupBy === undefined ? [] : (["groupBy"] as const)),
  ].map((name) => ({ path: [name], code: "not_for_this_op" }));

const withNext = (
  envelope: AdminMcpEnvelope,
  read: Read,
  cursor: string | undefined,
): AdminMcpEnvelope =>
  cursor === undefined
    ? envelope
    : { ...envelope, next: { tool: "admin_read", args: { ...read, cursor } } };

/** This credential's runs, newest first. */
const runsPage = async (
  { req, key }: AdminOpContext,
  read: Read,
  limit: number,
): Promise<AdminMcpEnvelope> => {
  const after =
    read.cursor === undefined ? undefined : runKeysetOfCursor(read.cursor);
  if (read.cursor !== undefined && after === undefined) return invalidCursor();
  const now = new Date();
  const listed = await listRuns(
    req.payload,
    runCredentialOf(key).credential,
    { ...(after === undefined ? {} : { after }), limit: limit + 1 },
    { now },
  );
  const { threshold } = await controlFor(req);
  const rows = listed
    .slice(0, limit)
    .map(({ run }) => rowOf(run, threshold, now));
  const kept = fitting(rows, okEnvelope({ rows: [], filter: {} }));
  const envelope = okEnvelope(
    adminRunListDataSchema.parse({ rows: rows.slice(0, kept), filter: {} }),
  );
  return withNext(
    envelope,
    read,
    kept > 0 && (kept < rows.length || listed.length > limit)
      ? runCursor(listed[kept - 1]!.keyset)
      : undefined,
  );
};

/** One run of this credential: what it is, then its targets in index order. */
const targetsPage = async (
  { req, key }: AdminOpContext,
  read: Read,
  runId: string,
  limit: number,
): Promise<AdminMcpEnvelope> => {
  const after = read.cursor === undefined ? -1 : indexOfCursor(read.cursor);
  if (after === undefined) return invalidCursor();
  const now = new Date();
  // Its expiry decided here, as any read of a run decides it.
  const found = await readRun(
    req.payload,
    runCredentialOf(key).credential,
    runId,
    { now },
  );
  if (found === undefined || found.run.klass === "read")
    return failedEnvelope("NOT_FOUND");
  const { run } = found;
  const { threshold } = await controlFor(req);
  const about = adminRunAboutSchema.parse({
    ...rowOf(run, threshold, now),
    ...reasonOf(run.reason),
  });
  const targets = await readTargetStates(req.payload, runId, after, limit + 1);
  const rows = targets.slice(0, limit).map(targetRowOf);
  const around = { rows: [], filter: { runId }, total: run.targetCount, about };
  const kept = fitting(rows, okEnvelope(around));
  const envelope = okEnvelope(
    adminRunListDataSchema.parse({ ...around, rows: rows.slice(0, kept) }),
    about.reason === undefined ? [] : ["/data/about/reason"],
  );
  return withNext(
    envelope,
    read,
    kept > 0 && (kept < rows.length || targets.length > limit)
      ? indexCursor(targets[kept - 1]!.index)
      : undefined,
  );
};

/** list.runs's body. */
export const listRunsRun = async (
  input: unknown,
  context: AdminOpContext,
): Promise<AdminMcpEnvelope> => {
  const { runId } = adminRunListInputSchema.parse(input);
  const read = context.read ?? {};
  const unread = unreadArgsOf(read);
  if (unread.length > 0) return inputInvalidEnvelope(unread);
  const limit = Math.min(
    read.pageSize ?? DEFAULT_PAGE_SIZE,
    ADMIN_READ_PAGE_SIZE_MAX,
  );
  return runId === undefined
    ? runsPage(context, read, limit)
    : targetsPage(context, read, runId, limit);
};

/**
 * run.cancel's body. A held lease answers busy; a run that already ended answers as it
 * is, replayed, so the target reads as already applied.
 */
export const cancelRunRun = async (
  raw: unknown,
  { req, key }: AdminOpContext,
): Promise<AdminMcpEnvelope> => {
  const { runId } = adminRunCancelInputSchema.parse(raw);
  const settled = await cancelRun(req.payload, runCredentialOf(key), runId);
  if (!settled.ok) return failedEnvelope(settled.code);
  const { run, already } = settled;
  return okEnvelope({
    ...adminRunCancelEchoSchema.parse({
      runId: run.runId,
      state: run.state,
      counts: tallyOf(run.counts),
    }),
    ...(already ? { replayed: true } : {}),
  });
};
