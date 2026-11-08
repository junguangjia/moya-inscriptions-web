import {
  ADMIN_PREVIEW_TTL_MS,
  ADMIN_RUN_AWAITING_TTL_MS,
  ADMIN_RUN_FORMAT_VERSION,
  ADMIN_RUN_STALLED_MS,
  ADMIN_RUN_TERMINAL_STATES,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminOpClass,
  AdminRunState,
  AdminRunTargetState,
} from "@moya/contracts/internal/admin-mcp";

/**
 * A run's states and the moves between them (admin-mcp-completion-v1 section 8, S8
 * plan 2.2), as one table: the ledger asks it before every compare-and-set, and the
 * tests walk it whole. The mcp_runs trigger holds the same rules a second time.
 * running and settling expire only by going stale; awaiting_owner leaves only by a
 * confirmation, a cancel or an expiry; a terminal state moves no more.
 */
export const RUN_TRANSITIONS = {
  planning: ["previewed", "cancelled", "expired"],
  previewed: ["running", "awaiting_owner", "cancelled", "expired"],
  awaiting_owner: ["confirmed", "cancelled", "expired"],
  confirmed: ["running", "cancelled", "expired"],
  running: [
    "settling",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "expired",
  ],
  settling: ["succeeded", "partial", "failed", "cancelled", "expired"],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
  expired: [],
} as const satisfies Readonly<Record<AdminRunState, readonly AdminRunState[]>>;

const TERMINAL: ReadonlySet<AdminRunState> = new Set(ADMIN_RUN_TERMINAL_STATES);

export const isTerminal = (state: AdminRunState) => TERMINAL.has(state);

export const canTransition = (from: AdminRunState, to: AdminRunState) =>
  (RUN_TRANSITIONS[from] as readonly AdminRunState[]).includes(to);

/**
 * States whose `expires_at` is a deadline, and how long each is given on entering it:
 * planning extends with each planning call, so a sealed run has its 15 minutes from
 * the last. No worker or timer: a read finds it past and expires it.
 */
const DEADLINES: Readonly<Partial<Record<AdminRunState, number>>> = {
  planning: ADMIN_PREVIEW_TTL_MS,
  previewed: ADMIN_PREVIEW_TTL_MS,
  awaiting_owner: ADMIN_RUN_AWAITING_TTL_MS,
  confirmed: ADMIN_RUN_AWAITING_TTL_MS,
};

/** The deadline a run entering `state` now gets; undefined keeps the one it has. */
export const deadlineOnEntering = (
  state: AdminRunState,
  now: Date,
): Date | undefined => {
  const ttl = DEADLINES[state];
  return ttl === undefined ? undefined : new Date(now.getTime() + ttl);
};

/** Whether a run in this state expires by its deadline at all. */
export const hasDeadline = (state: AdminRunState) =>
  DEADLINES[state] !== undefined;

export const pastDeadline = (
  {
    state,
    expiresAt,
  }: { readonly state: AdminRunState; readonly expiresAt: Date },
  now: Date,
) => hasDeadline(state) && expiresAt.getTime() <= now.getTime();

/**
 * Frozen in another format, or under another op schema: its input never runs. The
 * contract version is recorded and never compared, so an unrelated release leaves a
 * waiting run as it is.
 */
export const isStale = (
  run: { readonly formatVersion: number; readonly opSchemaHash: string },
  currentOpSchemaHash: string | undefined,
) =>
  run.formatVersion !== ADMIN_RUN_FORMAT_VERSION ||
  run.opSchemaHash !== currentOpSchemaHash;

/** Left with no live lease for a while: resumable, or cancellable. */
export const isStalled = (
  run: {
    readonly state: AdminRunState;
    readonly leaseExpiresAt: Date | null;
    readonly updatedAt: Date;
  },
  now: Date,
) =>
  (run.state === "planning" ||
    run.state === "running" ||
    run.state === "settling") &&
  (run.leaseExpiresAt === null ||
    run.leaseExpiresAt.getTime() <= now.getTime()) &&
  now.getTime() - run.updatedAt.getTime() >= ADMIN_RUN_STALLED_MS;

/**
 * Where a run's first execute call takes it. A reversible run runs; an irreversible
 * one runs at or under the Owner's threshold, read fresh, and past it waits for the
 * Owner. A confirmed run runs. Any other state is not one an execute call starts from.
 */
export const executeEntryState = (
  run: { readonly state: AdminRunState; readonly klass: AdminOpClass },
  count: number,
  threshold: number,
): "running" | "awaiting_owner" | undefined => {
  if (run.state === "confirmed") return "running";
  if (run.state !== "previewed") return undefined;
  return run.klass === "irreversible" && count > threshold
    ? "awaiting_owner"
    : "running";
};

/**
 * Where a run goes once no target is pending: settling while a queued one waits on
 * its jobs; succeeded only when every target completed; failed when none did; partial
 * otherwise. A conflict frozen at preview never ran, and still makes a run partial,
 * as a refused target makes admin_execute's answer PARTIAL.
 */
export const finalStateOf = (
  counts: Readonly<Partial<Record<AdminRunTargetState, number>>>,
): "settling" | "succeeded" | "partial" | "failed" | undefined => {
  const of = (state: AdminRunTargetState) => counts[state] ?? 0;
  if (of("pending") > 0) return undefined;
  if (of("queued") > 0) return "settling";
  const complete = of("applied") + of("already_applied");
  const incomplete =
    of("conflict") + of("failed") + of("unknown") + of("cancelled");
  if (incomplete === 0) return "succeeded";
  return complete === 0 ? "failed" : "partial";
};
