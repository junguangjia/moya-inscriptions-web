import {
  CATALOG_BLOCK_PURGE_BUDGET_PER_DAY,
  PUBLICATION_EDGE_FALLBACK_TTL_SECONDS,
  createPublicationJobHandlers,
  isBlockUnit,
  purgeQuotaDayStart,
} from "@moya/backend-production/internal/media-publication-worker";
import { describe, expect, it, vi } from "vitest";

import type {
  PublicationFence,
  PublicationRepository,
  PublicationUnit,
} from "@moya/backend-production/internal/media-publication-worker";
import type { PublicationProvider } from "@moya/backend-production/internal/media-publication-provider";
import type {
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
} from "@moya/backend-production/internal/publishing-job-handlers";

/*
 * catalog-deep-zoom-v1 (Issue #295) criteria 7 and 8: withdrawal purge
 * groups (ordinary roles first, in their own tasks, failing separately), the
 * daily block purge budget with its TTL path and content-free deferral line,
 * sampled block verification, and the sweep that visits a block once.
 * Synthetic offline fakes only; no cloud or store I/O.
 */

const NOW = new Date("2026-10-20T04:00:00.000Z");
const HEX = (n: number) => n.toString(16).padStart(32, "0");
const ORIGIN = "https://media.example.invalid";
const claim = (
  kind: PublishingWorkerJobKind = "withdraw_media",
): PublishingWorkerJobClaim => ({
  id: `publishing-job-${HEX(1)}`,
  subjectId: `catalog-asset-${HEX(7)}`,
  kind,
  payload: null,
  attempts: 1,
  maxAttempts: 3,
  leaseOwner: "test.1",
  leaseExpiresAt: new Date(NOW.getTime() + 120_000),
});

const unit = (
  n: number,
  role: string,
  overrides: Partial<PublicationUnit> = {},
): PublicationUnit => ({
  id: `media-publication-${HEX(n)}`,
  assetId: HEX(9),
  renditionId: `media-rendition-${HEX(n)}`,
  objectKey: `v1/${HEX(9)}/${HEX(2)}/base/${role}.r1.${role.startsWith("block-") ? "jpg" : "webp"}`,
  storageKey: `blobs/00/00/${HEX(n)}`,
  contentType: role.startsWith("block-") ? "image/jpeg" : "image/webp",
  purpose: "catalog_derivative",
  byteSize: 8,
  sha256: "0".repeat(64),
  role,
  editKey: "base",
  purgeTaskIds: [],
  withdrawRequestedAt: NOW,
  purgeAttempts: 0,
  sweepTaskIds: [],
  sweepAttempts: 0,
  sweepStartedAt: null,
  originDeletedAt: null,
  fallbackTtlSeconds: null,
  ...overrides,
});

const blocks = (count: number, overrides: Partial<PublicationUnit> = {}) =>
  Array.from({ length: count }, (_, index) =>
    unit(100 + index, `block-${String(index).padStart(2, "0")}`, overrides),
  );

function fixture(units: readonly PublicationUnit[], budget = 0) {
  const state = {
    now: NOW,
    units: [...units],
    taskState: "succeeded" as "pending" | "succeeded" | "failed",
    servedAtEdge: new Set<string>(),
    usedToday: 0,
    current: true,
  };
  const calls = {
    purges: [] as string[][],
    verified: [] as string[],
    deferred: [] as string[][],
    finished: [] as string[][],
    failed: [] as string[][],
    removed: [] as string[],
    originDeleted: [] as string[][],
    sweeps: [] as string[],
    sweepFailures: [] as string[],
  };
  const fence = (): PublicationFence => ({
    assetId: HEX(9),
    sequence: "1",
    job: claim(),
    intent: "withdraw",
    unitIds: state.units.map((entry) => entry.id),
  });
  const port: PublicationRepository = {
    hasRegisteredPublications: vi.fn(async () => true),
    planPublish: vi.fn(async () => ({ status: "disabled" }) as const),
    planWithdrawal: vi.fn(
      async () =>
        ({ status: "ready", fence: fence(), units: [...state.units] }) as const,
    ),
    isCurrent: vi.fn(async () => state.current),
    finishPublish: vi.fn(async () => false),
    recordOriginDeleted: vi.fn(async (_fence, ids: readonly string[]) => {
      calls.originDeleted.push([...ids]);
      state.units = state.units.map((entry) =>
        ids.includes(entry.id)
          ? { ...entry, originDeletedAt: state.now }
          : entry,
      );
      return true;
    }),
    recordPurge: vi.fn(
      async (_fence, ids: readonly string[], tasks: readonly string[]) => {
        state.units = state.units.map((entry) =>
          ids.includes(entry.id)
            ? {
                ...entry,
                purgeTaskIds: [...tasks],
                purgeAttempts: entry.purgeAttempts + 1,
              }
            : entry,
        );
        return true;
      },
    ),
    finishWithdrawal: vi.fn(async (_fence, ids: readonly string[]) => {
      calls.finished.push([...ids]);
      state.units = state.units.filter((entry) => !ids.includes(entry.id));
      return true;
    }),
    failPurge: vi.fn(async (_fence, ids: readonly string[]) => {
      calls.failed.push([...ids]);
      return true;
    }),
    blockPurgesSince: vi.fn(async () => state.usedToday),
    deferBlockWithdrawal: vi.fn(
      async (_fence, ids: readonly string[], ttl: number) => {
        calls.deferred.push([...ids]);
        state.units = state.units.map((entry) =>
          ids.includes(entry.id)
            ? { ...entry, purgeTaskIds: [], fallbackTtlSeconds: ttl }
            : entry,
        );
        return true;
      },
    ),
    release: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({ publish: 0, withdraw: 0 })),
    sweepCandidates: vi.fn(async () => [...state.units]),
    recordSweepPurge: vi.fn(async () => {}),
    recordSweepFailure: vi.fn(async (ids: readonly string[]) => {
      calls.sweepFailures.push(...ids);
    }),
    recordSweep: vi.fn(async (ids: readonly string[]) => {
      calls.sweeps.push(...ids);
    }),
    recordRequestUsage: vi.fn(async () => {}),
  };
  let task = 0;
  const provider: PublicationProvider = {
    write: vi.fn(async () => {
      throw new Error("no publication in these cases");
    }),
    head: vi.fn(async () => undefined),
    remove: vi.fn(async (key: string) => {
      calls.removed.push(key);
    }),
    purge: vi.fn(async (targets: readonly string[]) => {
      calls.purges.push([...targets]);
      task += 1;
      return `task-${task}`;
    }),
    purgeStatus: vi.fn(async () => state.taskState),
    verifyGone: vi.fn(async (target: string) => {
      calls.verified.push(target);
      return !state.servedAtEdge.has(target);
    }),
    monthlyRequests: vi.fn(async () => {
      throw new Error("unused");
    }),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const queue = {
    enqueueJob: vi.fn(async () => ({ id: "synthetic-job", created: true })),
  };
  const handlers = createPublicationJobHandlers({
    port,
    queue,
    source: { openRead: vi.fn(async () => null) },
    provider,
    origin: ORIGIN,
    allowPublish: () => true,
    clock: () => state.now,
    logger,
    blockPurgeBudget: budget,
  });
  return {
    state,
    calls,
    port,
    provider,
    logger,
    queue,
    handlers,
    signal: new AbortController().signal,
  };
}

const url = (entry: PublicationUnit) => `${ORIGIN}/${entry.objectKey}`;

describe("Catalog block withdrawal (catalog-deep-zoom-v1)", () => {
  it("records the expand release's constants: no block purge budget until P0, one-hour TTL", () => {
    expect(CATALOG_BLOCK_PURGE_BUDGET_PER_DAY).toBe(0);
    expect(PUBLICATION_EDGE_FALLBACK_TTL_SECONDS).toBe(3600);
    expect(purgeQuotaDayStart(new Date("2026-10-20T15:59:59Z"))).toEqual(
      new Date("2026-10-19T16:00:00Z"),
    );
    expect(purgeQuotaDayStart(new Date("2026-10-20T16:00:00Z"))).toEqual(
      new Date("2026-10-20T16:00:00Z"),
    );
    expect(isBlockUnit({ role: "block-07" })).toBe(true);
    expect(isBlockUnit({ role: "viewer" })).toBe(false);
  });

  it("purges ordinary roles first in their own task and defers blocks to the TTL path with one error line", async () => {
    const ordinary = ["thumb", "cover", "display", "viewer"].map(
      (role, index) => unit(index + 1, role),
    );
    const f = fixture([...ordinary, ...blocks(48)]);
    const result = await f.handlers.run(claim(), f.signal);
    expect(result).toEqual({ status: "completed" });
    // Every origin object is deleted, blocks included.
    expect(f.calls.removed).toHaveLength(52);
    // One purge task, ordinary URLs only; no block URL uses the quota.
    expect(f.calls.purges).toEqual([ordinary.map(url)]);
    expect(f.calls.deferred).toEqual([blocks(48).map((entry) => entry.id)]);
    expect(f.logger.error).toHaveBeenCalledWith(
      "publication.withdrawal code=block_budget_deferred units=48 ttl_seconds=3600",
    );
    expect(f.queue.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "verify_withdrawal" }),
      NOW,
    );
    // Content-free: no key, id or URL in any log line.
    for (const line of [
      ...f.logger.error.mock.calls,
      ...f.logger.info.mock.calls,
    ].flat())
      expect(String(line)).not.toMatch(/v1\/|media-publication|https?:/u);
  });

  it("finishes ordinary roles on verification while deferred blocks wait for the edge TTL", async () => {
    const ordinary = [unit(1, "display"), unit(2, "viewer")];
    const f = fixture([...ordinary, ...blocks(4)]);
    await f.handlers.run(claim(), f.signal);
    f.state.now = new Date(NOW.getTime() + 20_000);
    const verify = await f.handlers.run(claim("verify_withdrawal"), f.signal);
    expect(f.calls.finished).toEqual([ordinary.map((entry) => entry.id)]);
    // The block group waits (at most five minutes per deferral) without a GET.
    expect(verify).toEqual({ status: "deferred", delayMs: 300_000 });
    expect(f.calls.verified).toEqual(ordinary.map(url));
    // Blocks are not deleted twice while they wait.
    const removedBefore = f.calls.removed.length;
    f.state.now = new Date(NOW.getTime() + 600_000);
    await f.handlers.run(claim("verify_withdrawal"), f.signal);
    expect(f.calls.removed).toHaveLength(removedBefore);
    // After the TTL plus five minutes: two sampled GETs, then finished.
    f.state.now = new Date(NOW.getTime() + (3600 + 300) * 1000 + 1);
    const done = await f.handlers.run(claim("verify_withdrawal"), f.signal);
    expect(done).toEqual({ status: "completed" });
    const blockUrls = blocks(4).map(url);
    expect(f.calls.verified.slice(ordinary.length)).toEqual([
      blockUrls[0],
      blockUrls[3],
    ]);
    expect(f.calls.finished.at(-1)).toEqual(blocks(4).map((entry) => entry.id));
  });

  it("keeps warmed-edge GETs per withdrawn image within 2 × ordinary units + 4", async () => {
    const ordinary = ["thumb", "cover", "display", "viewer"].map(
      (role, index) => unit(index + 1, role),
    );
    const f = fixture([...ordinary, ...blocks(48)]);
    await f.handlers.run(claim(), f.signal);
    f.state.now = new Date(NOW.getTime() + 20_000);
    await f.handlers.run(claim("verify_withdrawal"), f.signal);
    f.state.now = new Date(NOW.getTime() + 3_901_000);
    await f.handlers.run(claim("verify_withdrawal"), f.signal);
    expect(f.state.units).toEqual([]);
    expect(f.calls.verified.length).toBeLessThanOrEqual(2 * 4 + 4);
  });

  it("purges blocks within the daily budget, and falls back to the TTL path beyond it", async () => {
    const within = fixture(blocks(10), 100);
    within.state.usedToday = 90;
    await within.handlers.run(claim(), within.signal);
    expect(within.calls.purges).toEqual([blocks(10).map(url)]);
    expect(within.calls.deferred).toEqual([]);
    expect(within.port.blockPurgesSince).toHaveBeenCalledWith(
      purgeQuotaDayStart(NOW),
    );

    const beyond = fixture(blocks(11), 100);
    beyond.state.usedToday = 90;
    await beyond.handlers.run(claim(), beyond.signal);
    expect(beyond.calls.purges).toEqual([]);
    expect(beyond.calls.deferred).toHaveLength(1);
  });

  it("verifies purged blocks by two samples only, and defers them when a purge fails", async () => {
    const ok = fixture(blocks(30), 1000);
    await ok.handlers.run(claim(), ok.signal);
    ok.state.now = new Date(NOW.getTime() + 20_000);
    expect(
      await ok.handlers.run(claim("verify_withdrawal"), ok.signal),
    ).toEqual({ status: "completed" });
    expect(ok.calls.verified).toHaveLength(2);
    expect(ok.calls.purges).toHaveLength(1);

    const failing = fixture(blocks(30), 1000);
    await failing.handlers.run(claim(), failing.signal);
    failing.state.taskState = "failed";
    failing.state.now = new Date(NOW.getTime() + 20_000);
    const result = await failing.handlers.run(
      claim("verify_withdrawal"),
      failing.signal,
    );
    // One attempt per block URL: a failed purge never resubmits, it waits.
    expect(failing.calls.purges).toHaveLength(1);
    expect(failing.calls.deferred).toHaveLength(1);
    expect(failing.logger.error).toHaveBeenCalledWith(
      "publication.withdrawal code=block_purge_unconfirmed units=30 ttl_seconds=3600",
    );
    expect(result).toEqual({ status: "deferred", delayMs: 300_000 });
  });

  it("never lets a stuck block group stop the ordinary roles' take-down", async () => {
    const ordinary = [unit(1, "display")];
    const stuck = blocks(3, {
      originDeletedAt: new Date(NOW.getTime() - 5_000_000),
      fallbackTtlSeconds: 3600,
      purgeAttempts: 3,
    });
    const f = fixture([...ordinary, ...stuck]);
    for (const entry of stuck) f.state.servedAtEdge.add(url(entry));
    const first = await f.handlers.run(claim(), f.signal);
    // The ordinary role is purged although the block group fails.
    expect(f.calls.purges).toEqual([ordinary.map(url)]);
    expect(f.calls.failed).toEqual([stuck.map((entry) => entry.id)]);
    expect(first).toEqual({
      status: "failed",
      errorCode: "withdrawal_still_served",
      retryable: false,
    });
    f.state.now = new Date(NOW.getTime() + 20_000);
    await f.handlers.run(claim("verify_withdrawal"), f.signal);
    expect(f.calls.finished).toEqual([["media-publication-" + HEX(1)]]);
    expect(
      f.calls.failed.every((ids) => ids.every((id) => !id.endsWith(HEX(1)))),
    ).toBe(true);
  });

  it("sweeps a withdrawn block once: one HEAD each, two sampled edge GETs per asset, no purge", async () => {
    const withdrawn = blocks(20);
    const f = fixture(withdrawn);
    const result = await f.handlers.run(claim("sweep_published"), f.signal);
    expect(result).toEqual({ status: "completed" });
    expect(f.provider.head).toHaveBeenCalledTimes(20);
    expect(f.calls.verified).toEqual([url(withdrawn[0]!), url(withdrawn[19]!)]);
    expect(f.calls.purges).toEqual([]);
    expect(f.calls.sweeps).toEqual(withdrawn.map((entry) => entry.id));
  });
});
