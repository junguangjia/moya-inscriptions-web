import { createHash } from "node:crypto";

import {
  MediaPublicationJobError,
  PUBLICATION_PUBLISH_JOB_KINDS,
  PUBLICATION_PUBLISH_LEASE_MS,
  PUBLICATION_WITHDRAW_JOB_KINDS,
  PUBLICATION_WITHDRAW_LEASE_MS,
  createPublicationJobHandlers,
  publicationMaintenanceSteps,
} from "@moya/backend-production/internal/media-publication-worker";
import { describe, expect, it, vi } from "vitest";

import type {
  PublicationFence,
  PublicationJobHandlerOptions,
  PublicationRepository,
  PublicationSource,
  PublicationUnit,
} from "@moya/backend-production/internal/media-publication-worker";
import type { PublicationProvider } from "@moya/backend-production/internal/media-publication-provider";
import type {
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
} from "@moya/backend-production/internal/publishing-job-handlers";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const SHA = (bytes = BYTES) => createHash("sha256").update(bytes).digest("hex");
const MD5 = (bytes = BYTES) => createHash("md5").update(bytes).digest("hex");
const HEX = (n: number) => n.toString(16).padStart(32, "0");
const claim = (
  kind: PublishingWorkerJobKind = "publish_media",
): PublishingWorkerJobClaim => ({
  id: `publishing-job-${HEX(1)}`,
  subjectId: `media-item-${HEX(1)}`,
  kind,
  payload: null,
  attempts: 1,
  maxAttempts: 3,
  leaseOwner: "test.1",
  leaseExpiresAt: new Date(NOW.getTime() + 300_000),
});

const unit = (n = 1, bytes = BYTES): PublicationUnit => ({
  id: `media-publication-${HEX(n)}`,
  assetId: `media-public-asset-${HEX(1)}`,
  renditionId: `media-rendition-${HEX(n)}`,
  objectKey: `v1/${HEX(1)}/${HEX(2)}/${HEX(3)}/display.r1.webp`,
  storageKey: `blobs/00/00/${HEX(n)}`,
  contentType: "image/webp",
  purpose: "derivative",
  byteSize: bytes.byteLength,
  sha256: SHA(bytes),
  role: "display",
  editKey: HEX(3),
  purgeTaskIds: [],
  withdrawRequestedAt: NOW,
  purgeAttempts: 0,
  sweepTaskIds: [],
  sweepAttempts: 0,
  sweepStartedAt: null,
});

function fixture(bytes = BYTES) {
  const events: string[] = [];
  const state = {
    now: NOW,
    allowed: true,
    current: true,
    finishAllowed: true,
    units: [unit(1, bytes)] as readonly PublicationUnit[],
    existing: false,
    existsAtEdge: false,
    taskState: "pending" as "pending" | "succeeded" | "failed",
    sourceChunks: [bytes] as readonly Uint8Array[],
    beforeChunk: (_n: number) => {},
  };
  const fence = (intent: "publish" | "withdraw"): PublicationFence => ({
    assetId: state.units[0]?.assetId ?? `media-public-asset-${HEX(1)}`,
    sequence: "1",
    job: claim(intent === "publish" ? "publish_media" : "withdraw_media"),
    intent,
    unitIds: state.units.map((entry) => entry.id),
  });
  const port: PublicationRepository = {
    hasRegisteredPublications: vi.fn(async () => true),
    planPublish: vi.fn(async () => {
      events.push("planPublish");
      return {
        status: "ready",
        fence: fence("publish"),
        units: state.units,
      } as const;
    }),
    planWithdrawal: vi.fn(async () => {
      events.push("planWithdrawal");
      return {
        status: "ready",
        fence: fence("withdraw"),
        units: state.units,
      } as const;
    }),
    isCurrent: vi.fn(async () => state.current),
    finishPublish: vi.fn(async () => {
      events.push("finishPublish");
      return state.finishAllowed;
    }),
    recordOriginDeleted: vi.fn(async () => {
      events.push("recordOriginDeleted");
      return true;
    }),
    recordPurge: vi.fn(async () => {
      events.push("recordPurge");
      return true;
    }),
    finishWithdrawal: vi.fn(async () => {
      events.push("finishWithdrawal");
      return true;
    }),
    failPurge: vi.fn(async () => {
      events.push("failPurge");
      return true;
    }),
    release: vi.fn(async () => {
      events.push("release");
    }),
    reconcile: vi.fn(async () => ({ publish: 0, withdraw: 1 })),
    sweepCandidates: vi.fn(async () => state.units),
    recordSweepPurge: vi.fn(async () => {
      events.push("recordSweepPurge");
    }),
    recordSweepFailure: vi.fn(async () => {
      events.push("recordSweepFailure");
    }),
    recordSweep: vi.fn(async () => {
      events.push("recordSweep");
    }),
    recordRequestUsage: vi.fn(async () => {
      events.push("recordRequestUsage");
    }),
  };
  const source: PublicationSource = {
    openRead: vi.fn(async () => {
      events.push("openRead");
      return {
        status: "ok" as const,
        byteSize: bytes.byteLength,
        contentLength: bytes.byteLength,
        body: (async function* () {
          for (let i = 0; i < state.sourceChunks.length; i += 1) {
            state.beforeChunk(i);
            yield state.sourceChunks[i]!;
          }
        })(),
        close: vi.fn(async () => {
          events.push("close");
        }),
      };
    }),
  };
  const provider: PublicationProvider = {
    write: vi.fn(async (_unit, stream) => {
      events.push("write");
      const hash = createHash("md5");
      let size = 0;
      for await (const chunk of stream) {
        hash.update(chunk);
        size += chunk.byteLength;
      }
      state.existing = true;
      return { byteSize: size, etag: hash.digest("hex"), crc64: "synthetic" };
    }),
    head: vi.fn(async () => {
      events.push("head");
      return state.existing
        ? {
            byteSize: bytes.byteLength,
            etag: `"${MD5(bytes)}"`,
            crc64: "synthetic",
          }
        : undefined;
    }),
    remove: vi.fn(async () => {
      events.push("remove");
      state.existing = false;
    }),
    purge: vi.fn(async () => {
      events.push("purge");
      return "synthetic-task";
    }),
    purgeStatus: vi.fn(async () => {
      events.push("purgeStatus");
      return state.taskState;
    }),
    verifyGone: vi.fn(async () => {
      events.push("verifyGone");
      return !state.existsAtEdge;
    }),
    monthlyRequests: vi.fn(async (end) => ({
      start: new Date("2026-10-03T16:00:00Z"),
      end,
      requests: 2_000_000,
      warning: true,
    })),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const queue = {
    enqueueJob: vi.fn(async () => {
      events.push("enqueueJob");
      return { id: "synthetic-job", created: true };
    }),
  };
  const options: PublicationJobHandlerOptions = {
    port,
    queue,
    source,
    provider,
    origin: "https://media.example.invalid",
    allowPublish: () => state.allowed,
    clock: () => state.now,
    logger,
  };
  return {
    options,
    state,
    events,
    port,
    source,
    provider,
    logger,
    queue,
    handlers: createPublicationJobHandlers(options),
    signal: new AbortController().signal,
  };
}

describe("public-mode media publication lifecycle (offline synthetic evidence)", () => {
  it("keeps withdrawal and publication in separate bounded lanes of the existing queue", () => {
    expect(PUBLICATION_WITHDRAW_JOB_KINDS).toEqual([
      "withdraw_media",
      "verify_withdrawal",
      "reconcile_publication",
    ]);
    expect(PUBLICATION_PUBLISH_JOB_KINDS).toEqual([
      "publish_media",
      "sweep_published",
    ]);
    expect(PUBLICATION_WITHDRAW_LEASE_MS).toBe(120_000);
    expect(PUBLICATION_PUBLISH_LEASE_MS).toBe(300_000);
  });

  it("refuses public planning, credentials and copying in Beta/off before any provider call", async () => {
    const f = fixture();
    f.state.allowed = false;
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.port.planPublish).not.toHaveBeenCalled();
    expect(f.source.openRead).not.toHaveBeenCalled();
    expect(f.provider.head).not.toHaveBeenCalled();
    expect(f.provider.write).not.toHaveBeenCalled();
  });

  it("copies only after row planning and commits only after full SHA, MD5 and HEAD checks", async () => {
    const f = fixture();
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.events).toEqual([
      "planPublish",
      "head",
      "openRead",
      "write",
      "head",
      "close",
      "finishPublish",
      "release",
    ]);
  });

  it("resumes a partial generation by validating existing immutable bytes, without overwriting", async () => {
    const f = fixture();
    f.state.existing = true;
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.source.openRead).toHaveBeenCalledTimes(1);
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.port.finishPublish).toHaveBeenCalledTimes(1);
  });

  it("does not accept same-length destination bytes with a different ETag", async () => {
    const f = fixture();
    f.state.existing = true;
    vi.mocked(f.provider.head).mockResolvedValue({
      byteSize: BYTES.length,
      etag: "0".repeat(32),
    });
    await expect(f.handlers.run(claim(), f.signal)).rejects.toMatchObject({
      code: "integrity",
    });
    expect(f.port.finishPublish).not.toHaveBeenCalled();
    expect(f.provider.remove).not.toHaveBeenCalled();
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.port.release).toHaveBeenCalledTimes(1);
  });

  it("rejects original/master units in code before storage I/O", async () => {
    const f = fixture();
    f.state.units = [
      { ...unit(), purpose: "original" } as unknown as PublicationUnit,
    ];
    await expect(f.handlers.run(claim(), f.signal)).rejects.toBeInstanceOf(
      MediaPublicationJobError,
    );
    expect(f.provider.head).not.toHaveBeenCalled();
    expect(f.provider.write).not.toHaveBeenCalled();
  });

  it("aborts a stream when withdrawal changes its desired sequence, then defers without committing", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(9);
    const f = fixture(bytes);
    f.state.sourceChunks = [
      bytes.subarray(0, 1024 * 1024),
      bytes.subarray(1024 * 1024),
    ];
    f.state.beforeChunk = (n) => {
      if (n === 1) f.state.current = false;
    };
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "deferred",
      delayMs: 2_000,
    });
    expect(f.port.finishPublish).not.toHaveBeenCalled();
    expect(f.events).toContain("close");
    expect(f.port.release).toHaveBeenCalledTimes(1);
  });

  it("does not publish when final same-transaction eligibility/lease fence rejects the copied generation", async () => {
    const f = fixture();
    f.state.finishAllowed = false;
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "deferred",
      delayMs: 2_000,
    });
    expect(f.port.finishPublish).toHaveBeenCalledTimes(1);
  });

  it("defers a stale stream even when a provider sanitizes the source fence exception", async () => {
    const f = fixture();
    vi.mocked(f.provider.write).mockImplementation(async () => {
      f.state.current = false;
      throw new Error("synthetic sanitized provider failure");
    });
    expect(await f.handlers.run(claim(), f.signal)).toEqual({
      status: "deferred",
      delayMs: 2_000,
    });
    expect(f.port.finishPublish).not.toHaveBeenCalled();
  });

  it("rechecks public mode while a copy runs", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(9);
    const f = fixture(bytes);
    f.state.sourceChunks = [
      bytes.subarray(0, 1024 * 1024),
      bytes.subarray(1024 * 1024),
    ];
    f.state.beforeChunk = (n) => {
      if (n === 1) f.state.allowed = false;
    };
    expect(await f.handlers.run(claim(), f.signal)).toMatchObject({
      status: "deferred",
    });
    expect(f.port.finishPublish).not.toHaveBeenCalled();
  });

  it("leaves shared eligible references alone when the repository plans no withdrawal units", async () => {
    const f = fixture();
    f.state.units = [];
    expect(await f.handlers.run(claim("withdraw_media"), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.provider.remove).not.toHaveBeenCalled();
    expect(f.provider.purge).not.toHaveBeenCalled();
  });

  it("drains existing generations even in Beta/off: delete, durable origin state, purge, task, verification job", async () => {
    const f = fixture();
    f.state.allowed = false;
    expect(await f.handlers.run(claim("withdraw_media"), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.events).toEqual([
      "planWithdrawal",
      "remove",
      "recordOriginDeleted",
      "purge",
      "recordPurge",
      "enqueueJob",
      "release",
    ]);
    expect(f.queue.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "verify_withdrawal", maxAttempts: 3 }),
      NOW,
    );
    expect(f.port.finishWithdrawal).not.toHaveBeenCalled();
    expect(f.source.openRead).not.toHaveBeenCalled();
  });

  it("marks withdrawn only after recorded purge success and edge denial", async () => {
    const f = fixture();
    f.state.units = [
      { ...unit(), purgeTaskIds: ["synthetic-task"], purgeAttempts: 1 },
    ];
    f.state.taskState = "succeeded";
    expect(await f.handlers.run(claim("verify_withdrawal"), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.events.indexOf("purgeStatus")).toBeLessThan(
      f.events.indexOf("verifyGone"),
    );
    expect(f.events.indexOf("verifyGone")).toBeLessThan(
      f.events.indexOf("finishWithdrawal"),
    );
    expect(f.provider.purge).not.toHaveBeenCalled();
  });

  it("resumes pending task IDs after restart without resubmitting purges", async () => {
    const f = fixture();
    f.state.units = [
      { ...unit(), purgeTaskIds: ["synthetic-task"], purgeAttempts: 1 },
    ];
    expect(await f.handlers.run(claim("verify_withdrawal"), f.signal)).toEqual({
      status: "deferred",
      delayMs: 30_000,
    });
    expect(f.provider.purge).not.toHaveBeenCalled();
    expect(f.port.failPurge).not.toHaveBeenCalled();
    expect(f.port.finishWithdrawal).not.toHaveBeenCalled();
  });

  it("bounds unconfirmed purges, records failure and emits only a code and the one-hour fallback", async () => {
    const f = fixture();
    f.state.now = new Date(NOW.getTime() + 10 * 60_000);
    f.state.units = [
      { ...unit(), purgeTaskIds: ["synthetic-task"], purgeAttempts: 2 },
    ];
    expect(await f.handlers.run(claim("verify_withdrawal"), f.signal)).toEqual({
      status: "failed",
      errorCode: "purge_unconfirmed",
      retryable: false,
    });
    expect(f.port.failPurge).toHaveBeenCalledWith(
      expect.anything(),
      [unit().id],
      "purge_unconfirmed",
      f.state.now,
    );
    expect(f.logger.error).toHaveBeenCalledWith(
      "publication.withdrawal code=purge_unconfirmed fallback_ttl_seconds=3600",
    );
    expect(f.port.finishWithdrawal).not.toHaveBeenCalled();
  });

  it("refuses a fourth purge submission even when the queue creates a later recovery job", async () => {
    const f = fixture();
    f.state.units = [{ ...unit(), purgeAttempts: 3 }];
    expect(await f.handlers.run(claim("withdraw_media"), f.signal)).toEqual({
      status: "failed",
      errorCode: "purge_failed",
      retryable: false,
    });
    expect(f.provider.purge).not.toHaveBeenCalled();
  });

  it("reconciles with the access-mode publication gate and keeps cleanup scheduling active", async () => {
    const f = fixture();
    f.state.allowed = false;
    expect(
      await f.handlers.run(claim("reconcile_publication"), f.signal),
    ).toEqual({ status: "completed" });
    expect(f.port.reconcile).toHaveBeenCalledWith(NOW, false, 500);
    const steps = publicationMaintenanceSteps(f.queue, {
      port: f.port,
      allowPublish: () => f.state.allowed,
    });
    expect(steps.map((step) => step.intervalMs)).toEqual([60_000, 3_600_000]);
    await Promise.all(steps.map((step) => step.run(NOW)));
    expect(f.queue.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reconcile_publication" }),
      NOW,
    );
    expect(f.queue.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "sweep_published" }),
      NOW,
    );
  });

  it("leaves the queue unchanged for Beta preparation without publication history", async () => {
    const f = fixture();
    f.state.allowed = false;
    vi.mocked(f.port.hasRegisteredPublications).mockResolvedValue(false);
    const steps = publicationMaintenanceSteps(f.queue, {
      port: f.port,
      allowPublish: () => f.state.allowed,
    });
    await Promise.all(steps.map((step) => step.run(NOW)));
    expect(f.queue.enqueueJob).not.toHaveBeenCalled();
    vi.mocked(f.port.hasRegisteredPublications).mockResolvedValue(true);
    await Promise.all(steps.map((step) => step.run(NOW)));
    expect(f.queue.enqueueJob).toHaveBeenCalledTimes(2);
  });

  it("never equates missing origin bytes with edge denial after a sweep restart", async () => {
    const f = fixture();
    f.state.existsAtEdge = true;
    expect(await f.handlers.run(claim("sweep_published"), f.signal)).toEqual({
      status: "deferred",
      delayMs: 30_000,
    });
    expect(f.provider.purge).toHaveBeenCalledTimes(1);
    expect(f.port.recordSweepPurge).toHaveBeenCalledTimes(1);
    expect(f.port.recordSweep).not.toHaveBeenCalled();
  });

  it("resumes durable sweep task IDs and only clears the intent after edge denial", async () => {
    const f = fixture();
    f.state.units = [
      {
        ...unit(),
        sweepTaskIds: ["synthetic-task"],
        sweepAttempts: 1,
        sweepStartedAt: NOW,
      },
    ];
    f.state.taskState = "succeeded";
    expect(await f.handlers.run(claim("sweep_published"), f.signal)).toEqual({
      status: "completed",
    });
    expect(f.provider.purge).not.toHaveBeenCalled();
    expect(f.port.recordSweep).toHaveBeenCalledWith([unit().id], NOW);
  });

  it("records daily plan-month usage and a content-free warning at the threshold", async () => {
    const f = fixture();
    const steps = publicationMaintenanceSteps(f.queue, {
      port: f.port,
      provider: f.provider,
      logger: f.logger,
      allowPublish: () => f.state.allowed,
    });
    const usage = steps.find(
      (step) => step.label === "publication_request_usage",
    )!;
    expect(usage.intervalMs).toBe(86_400_000);
    await usage.run(NOW);
    expect(f.port.recordRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({ requests: 2_000_000, warning: true }),
      NOW,
    );
    expect(f.logger.error).toHaveBeenCalledWith(
      "publication.usage code=monthly_request_warning threshold=2000000",
    );
  });

  it("does not assume the publisher role for scheduled usage reads during Beta/off", async () => {
    const f = fixture();
    f.state.allowed = false;
    const steps = publicationMaintenanceSteps(f.queue, {
      port: f.port,
      provider: f.provider,
      logger: f.logger,
      allowPublish: () => f.state.allowed,
    });
    await steps
      .find((step) => step.label === "publication_request_usage")!
      .run(NOW);
    expect(f.provider.monthlyRequests).not.toHaveBeenCalled();
    expect(f.port.recordRequestUsage).not.toHaveBeenCalled();
  });

  it("does no I/O when the queue lease was already aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("synthetic lease lost"));
    await expect(f.handlers.run(claim(), controller.signal)).rejects.toThrow(
      "synthetic lease lost",
    );
    expect(f.port.planPublish).not.toHaveBeenCalled();
    expect(f.provider.write).not.toHaveBeenCalled();
  });
});
