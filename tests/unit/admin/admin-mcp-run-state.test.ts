import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ADMIN_PREVIEW_TTL_MS,
  ADMIN_RUN_AWAITING_TTL_MS,
  ADMIN_RUN_FORMAT_VERSION,
  ADMIN_RUN_STALLED_MS,
  ADMIN_RUN_STATES,
  ADMIN_RUN_TERMINAL_STATES,
  type AdminRunState,
} from "@moya/contracts/internal/admin-mcp";
import {
  canTransition,
  deadlineOnEntering,
  executeEntryState,
  finalStateOf,
  isStale,
  isStalled,
  isTerminal,
  pastDeadline,
  RUN_TRANSITIONS,
} from "admin/admin-mcp";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * A run's state table (admin-mcp-completion-v1 section 8, S8 plan 2.2), walked whole:
 * every pair of states is either a move the table names or one it refuses, and the
 * mcp_runs trigger refuses at least what the table refuses.
 */

const EXPECTED: Readonly<Record<AdminRunState, readonly AdminRunState[]>> = {
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
};

const NOW = new Date("2026-11-06T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("the run state table", () => {
  it("names every state, and every pair of states is a move or a refusal", () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual(
      [...ADMIN_RUN_STATES].sort(),
    );
    for (const from of ADMIN_RUN_STATES)
      for (const to of ADMIN_RUN_STATES)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          EXPECTED[from].includes(to),
        );
  });

  it("moves no terminal state, and only a terminal state moves nowhere", () => {
    for (const state of ADMIN_RUN_STATES)
      expect(isTerminal(state), state).toBe(
        (ADMIN_RUN_TERMINAL_STATES as readonly string[]).includes(state),
      );
    for (const state of ADMIN_RUN_STATES)
      expect(RUN_TRANSITIONS[state].length === 0, state).toBe(
        isTerminal(state),
      );
  });

  it("runs nothing that was never sealed, and runs an irreversible run only past preview", () => {
    expect(canTransition("planning", "running")).toBe(false);
    expect(canTransition("planning", "awaiting_owner")).toBe(false);
    expect(canTransition("awaiting_owner", "running")).toBe(false);
    expect(canTransition("previewed", "confirmed")).toBe(false);
  });

  it("refuses at least what the mcp_runs trigger refuses", async () => {
    const migration = await readFile(
      path.join(
        repositoryRoot,
        "apps/admin/src/migrations/20261106_103000_mcp_runs.ts",
      ),
      "utf8",
    );
    const leavesAwaiting = migration.match(
      /OLD\."state" = 'awaiting_owner'\s+AND NEW\."state" NOT IN \(([^)]*)\)/u,
    )?.[1];
    expect(leavesAwaiting).toBeDefined();
    const allowed = [...leavesAwaiting!.matchAll(/'(\w+)'/gu)].map(
      ([, state]) => state,
    );
    for (const to of RUN_TRANSITIONS.awaiting_owner)
      expect(allowed, to).toContain(to);
    const terminal = migration.match(
      /OLD\."state" IN \(([^)]*)\)\s+AND NEW\."state" <> OLD\."state"/u,
    )?.[1];
    expect(
      [...terminal!.matchAll(/'(\w+)'/gu)].map(([, state]) => state).sort(),
    ).toEqual([...ADMIN_RUN_TERMINAL_STATES].sort());
  });
});

describe("a run's deadline", () => {
  it("gives planning and a preview 15 minutes and a wait for the Owner 24 hours", () => {
    expect(deadlineOnEntering("planning", NOW)).toEqual(
      later(ADMIN_PREVIEW_TTL_MS),
    );
    expect(deadlineOnEntering("previewed", NOW)).toEqual(
      later(ADMIN_PREVIEW_TTL_MS),
    );
    expect(deadlineOnEntering("awaiting_owner", NOW)).toEqual(
      later(ADMIN_RUN_AWAITING_TTL_MS),
    );
    expect(deadlineOnEntering("confirmed", NOW)).toEqual(
      later(ADMIN_RUN_AWAITING_TTL_MS),
    );
    for (const state of [
      "running",
      "settling",
      ...ADMIN_RUN_TERMINAL_STATES,
    ] as const)
      expect(deadlineOnEntering(state, NOW), state).toBeUndefined();
  });

  it("passes on its last instant, and never for a run that is running", () => {
    for (const state of [
      "planning",
      "previewed",
      "awaiting_owner",
      "confirmed",
    ] as const) {
      expect(pastDeadline({ state, expiresAt: later(1) }, NOW), state).toBe(
        false,
      );
      expect(pastDeadline({ state, expiresAt: NOW }, NOW), state).toBe(true);
    }
    for (const state of ["running", "settling"] as const)
      expect(
        pastDeadline(
          { state, expiresAt: later(-ADMIN_RUN_AWAITING_TTL_MS) },
          NOW,
        ),
        state,
      ).toBe(false);
  });
});

describe("a stale run", () => {
  const run = { formatVersion: ADMIN_RUN_FORMAT_VERSION, opSchemaHash: "a" };

  it("is one frozen in another format or under another op schema", () => {
    expect(isStale(run, "a")).toBe(false);
    expect(isStale(run, "b")).toBe(true);
    expect(isStale(run, undefined)).toBe(true);
    expect(
      isStale({ ...run, formatVersion: ADMIN_RUN_FORMAT_VERSION + 1 }, "a"),
    ).toBe(true);
  });
});

describe("a stalled run", () => {
  const quiet = later(-ADMIN_RUN_STALLED_MS);

  it("is a working run with no live lease, left alone for ten minutes", () => {
    for (const state of ["planning", "running", "settling"] as const) {
      expect(
        isStalled({ state, leaseExpiresAt: null, updatedAt: quiet }, NOW),
        state,
      ).toBe(true);
      expect(
        isStalled({ state, leaseExpiresAt: later(1), updatedAt: quiet }, NOW),
        state,
      ).toBe(false);
      expect(
        isStalled({ state, leaseExpiresAt: null, updatedAt: later(-1) }, NOW),
        state,
      ).toBe(false);
    }
    for (const state of ["previewed", "awaiting_owner", "succeeded"] as const)
      expect(
        isStalled({ state, leaseExpiresAt: null, updatedAt: quiet }, NOW),
        state,
      ).toBe(false);
  });
});

describe("a run's first execute call", () => {
  it("runs a reversible run, and an irreversible one only up to the threshold", () => {
    const previewed = { state: "previewed" as const };
    expect(
      executeEntryState({ ...previewed, klass: "reversible" }, 500, 20),
    ).toBe("running");
    expect(
      executeEntryState({ ...previewed, klass: "irreversible" }, 20, 20),
    ).toBe("running");
    expect(
      executeEntryState({ ...previewed, klass: "irreversible" }, 21, 20),
    ).toBe("awaiting_owner");
    expect(
      executeEntryState({ state: "confirmed", klass: "irreversible" }, 21, 20),
    ).toBe("running");
    for (const state of ADMIN_RUN_STATES.filter(
      (state) => state !== "previewed" && state !== "confirmed",
    ))
      expect(
        executeEntryState({ state, klass: "irreversible" }, 1, 20),
        state,
      ).toBeUndefined();
  });
});

describe("a run's last state", () => {
  it("waits on pending and queued targets, and succeeds only when every one completed", () => {
    expect(finalStateOf({ pending: 1, applied: 3 })).toBeUndefined();
    expect(finalStateOf({ queued: 1, applied: 3 })).toBe("settling");
    expect(finalStateOf({ applied: 3, already_applied: 1 })).toBe("succeeded");
    expect(finalStateOf({})).toBe("succeeded");
    expect(finalStateOf({ applied: 3, conflict: 1 })).toBe("partial");
    expect(finalStateOf({ already_applied: 1, unknown: 1 })).toBe("partial");
    expect(finalStateOf({ failed: 2, conflict: 1 })).toBe("failed");
    expect(finalStateOf({ cancelled: 2 })).toBe("failed");
  });
});
