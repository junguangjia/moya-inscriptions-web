import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommunityConflictError,
  CommunityNotFoundError,
  CommunityStoreUnavailableError,
} from "@moya/api";
import {
  PUBLISHING_WORKER_CONCURRENCY_DEFAULT,
  openPublishingMedia,
  parsePublishingMediaConfig,
} from "@moya/backend-production/internal/publishing-config";
import {
  PUBLISHING_LEFTOVER_AGE_MS,
  PUBLISHING_STAGING_SWEEP_SUBJECT,
  PUBLISHING_STORE_RECONCILE_SUBJECT,
  createPublishingJobHandlers,
} from "@moya/backend-production/internal/publishing-job-handlers";
import {
  FilesystemPublishingMediaStore,
  PublishingMediaStoreError,
} from "@moya/backend-production/internal/publishing-media-store";
import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaToolError,
} from "@moya/backend-production/internal/publishing-processing";
import {
  PUBLISHING_WORKER_DEFAULTS,
  PublishingWorker,
  classifyPublishingJobError,
} from "@moya/backend-production/internal/publishing-worker";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cosFixture, cosOptions } from "./publishing-cos-fixture.js";

import type { WorkPublishingPort } from "@moya/api";
import type {
  PublishingJobHandlerOptions,
  PublishingWorkerDerivativeCommit,
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
  PublishingWorkerPort,
  PublishingWorkerProcessingInput,
  PublishingWorkerPurgePlan,
  PublishingWorkerStore,
  PublishingWorkerTimers,
} from "@moya/backend-production/internal/publishing-job-handlers";
import type {
  ProcessorInput,
  ProcessorOutcome,
} from "@moya/backend-production/internal/publishing-processing";

// Structural conformance, checked by the tests typecheck: the application
// port and the filesystem store satisfy what the worker relies on.
const portConformance: PublishingWorkerPort =
  null as unknown as WorkPublishingPort;
const storeConformance: PublishingWorkerStore =
  null as unknown as FilesystemPublishingMediaStore;
void [portConformance, storeConformance];

const START = Date.parse("2026-09-14T12:00:00.000Z");
const hex = (seed: number) => seed.toString(16).padStart(32, "0");
const ITEM = (seed: number) => `media-item-${hex(seed)}`;
const OWNER = `user-${"1".repeat(32)}`;
const LEGACY_MEDIA = (seed: number) => `user-media-${hex(seed)}`;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes that start like a PNG; the fake processor never decodes them. */
const legacyPng = (size: number) => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set(PNG_SIGNATURE);
  return bytes;
};
const blobKey = (seed: number) => {
  const value = hex(seed + 0xabcd00);
  return `blobs/${value.slice(0, 2)}/${value.slice(2, 4)}/${value}`;
};

/** Settles pending promise chains driven by fake timers. */
const flush = async (rounds = 25) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Deterministic timers and clock: nothing runs until `advance`. */
class ManualTimers implements PublishingWorkerTimers {
  now = START;
  private sequence = 0;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();

  readonly clock = () => new Date(this.now);

  setTimeout(callback: () => void, ms: number): unknown {
    this.sequence += 1;
    this.tasks.set(this.sequence, { at: this.now + ms, run: callback });
    return this.sequence;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }

  get pending(): number {
    return this.tasks.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    await flush();
    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].run();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

interface FakeJob {
  id: string;
  kind: PublishingWorkerJobKind;
  subjectId: string;
  payload: PublishingWorkerJobClaim["payload"];
  state: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
}

interface FakeItem {
  state: "processing" | "ready" | "failed" | "cancelled";
  failureCode: string | null;
}

/** In-memory queue implementing the documented `WorkPublishingPort` job rules. */
class FakePort implements PublishingWorkerPort {
  readonly jobs = new Map<string, FakeJob>();
  readonly items = new Map<string, FakeItem>();
  readonly claimLimits: number[] = [];
  readonly calls: string[] = [];
  recordedKeys = new Set<string>();
  cancelOnCommit = new Set<string>();
  failClaims = false;
  purgePlans = new Map<string, PublishingWorkerPurgePlan>();
  confirmed: string[][] = [];
  expiredComponents: string[] = [];
  /** Ready legacy items: their declared PNG size and the user media bytes read. */
  legacy = new Map<string, { byteSize: number; bytes: Uint8Array | null }>();
  private sequence = 0;

  constructor(private readonly timers: ManualTimers) {}

  enqueue(
    kind: PublishingWorkerJobKind,
    subjectId: string,
    extra: Partial<FakeJob> = {},
  ): FakeJob {
    this.sequence += 1;
    const job: FakeJob = {
      id: `publishing-job-${hex(this.sequence)}`,
      kind,
      subjectId,
      payload: null,
      state: "queued",
      attempts: 0,
      maxAttempts: 5,
      runAfter: this.timers.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      ...extra,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  addItem(seed: number, state: FakeItem["state"] = "processing") {
    this.items.set(ITEM(seed), { state, failureCode: null });
    return this.enqueue("process_item", ITEM(seed));
  }

  private held(lease: { id: string; leaseOwner: string }, now: Date) {
    const job = this.jobs.get(lease.id);
    return job?.state === "running" &&
      job.leaseOwner === lease.leaseOwner &&
      (job.leaseExpiresAt ?? 0) > now.getTime()
      ? job
      : null;
  }

  readSettings = vi.fn(async () => ({ orphanGraceDays: 7 }));
  reconcileCapacity = vi.fn(async () => ({}));
  unrecordedStorageKeys = vi.fn(async (keys: readonly string[]) =>
    keys.filter((key) => !this.recordedKeys.has(key)),
  );
  expireSession = vi.fn(async () => ({
    status: "expired" as const,
    cancelledComponentIds: this.expiredComponents,
  }));

  readProcessing = vi.fn(
    async (
      job: Pick<PublishingWorkerJobClaim, "kind" | "subjectId" | "payload">,
    ): Promise<Omit<ProcessorInput, "signal"> | null> => {
      const item = this.items.get(job.subjectId);
      if (!item || item.state === "cancelled") return null;
      if (job.kind === "derive_edit" && item.state !== "ready") return null;
      const legacy = this.legacy.get(job.subjectId);
      if (legacy) {
        return {
          mode: job.kind === "derive_edit" ? "derive" : "process",
          itemId: job.subjectId,
          ownerId: OWNER,
          kind: "static",
          qualityMode: "standard",
          source: {
            kind: "legacy_user_media",
            legacyMediaId: LEGACY_MEDIA(1),
            byteSize: legacy.byteSize,
            contentType: "image/png",
          },
          components: [],
          clientPairing: null,
          editKey: job.payload?.editKey ?? "base",
          edit: job.payload?.edit ?? { rotation: 0, crop: null },
          coverCrop: job.payload?.coverCrop ?? null,
          variants: job.payload?.variants ?? ["thumb", "display", "full"],
        } satisfies PublishingWorkerProcessingInput;
      }
      return {
        mode: job.kind === "derive_edit" ? "derive" : "process",
        itemId: job.subjectId,
        ownerId: OWNER,
        kind: "static",
        qualityMode: "original",
        components: [
          {
            role: "still",
            storageKey: blobKey(0),
            byteSize: 10,
            sha256: "a".repeat(64),
            declaredType: "image/jpeg",
          },
        ],
        clientPairing: null,
        editKey: job.payload?.editKey ?? "base",
        edit: job.payload?.edit ?? { rotation: 0, crop: null },
        coverCrop: job.payload?.coverCrop ?? null,
        variants: job.payload?.variants ?? [
          "thumb",
          "display",
          "full",
          "cover",
        ],
      };
    },
  );

  private commit(
    itemId: string,
    storageKeys: readonly string[],
    next: FakeItem["state"] | null,
  ): PublishingWorkerDerivativeCommit {
    if (this.cancelOnCommit.has(itemId)) {
      this.items.set(itemId, { state: "cancelled", failureCode: null });
    }
    const item = this.items.get(itemId);
    if (!item || item.state === "cancelled") {
      return { status: "discarded", storageKeys };
    }
    for (const key of storageKeys) this.recordedKeys.add(key);
    if (next) item.state = next;
    return { status: "recorded" };
  }

  markItemReady = vi.fn(
    async (
      itemId: string,
      outcome: Extract<ProcessorOutcome, { status: "processed" }>,
    ) =>
      this.commit(
        itemId,
        outcome.derivatives.map((derivative) => derivative.storageKey),
        "ready",
      ),
  );
  recordDerivatives = vi.fn(
    async (
      itemId: string,
      outcome: Extract<ProcessorOutcome, { status: "derived" }>,
    ) =>
      this.commit(
        itemId,
        outcome.derivatives.map((derivative) => derivative.storageKey),
        null,
      ),
  );
  readLegacyMediaBytes = vi.fn(
    async (itemId: string) => this.legacy.get(itemId)?.bytes ?? null,
  );
  markItemFailed = vi.fn(async (itemId: string, failureCode: string) => {
    this.items.set(itemId, { state: "failed", failureCode });
  });
  purgeTrashedWork = vi.fn(async () => "purged" as const);

  claimJobs = vi.fn(
    async (
      options: {
        owner: string;
        limit: number;
        leaseMs: number;
        kinds?: readonly PublishingWorkerJobKind[];
      },
      now: Date,
    ) => {
      this.claimLimits.push(options.limit);
      if (this.failClaims) throw new Error("synthetic connection failure");
      const due = [...this.jobs.values()]
        .filter(
          (job) =>
            job.state === "queued" &&
            job.runAfter <= now.getTime() &&
            (options.kinds === undefined || options.kinds.includes(job.kind)),
        )
        .sort((a, b) => a.runAfter - b.runAfter)
        .slice(0, options.limit);
      return due.map((job): PublishingWorkerJobClaim => {
        job.state = "running";
        job.attempts += 1;
        job.leaseOwner = options.owner;
        job.leaseExpiresAt = now.getTime() + options.leaseMs;
        return {
          id: job.id,
          kind: job.kind,
          subjectId: job.subjectId,
          payload: job.payload,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          leaseOwner: options.owner,
          leaseExpiresAt: new Date(job.leaseExpiresAt),
        };
      });
    },
  );

  renewJobLease = vi.fn(
    async (
      lease: { id: string; leaseOwner: string },
      leaseMs: number,
      now: Date,
    ) => {
      const job = this.held(lease, now);
      if (!job) return false;
      job.leaseExpiresAt = now.getTime() + leaseMs;
      return true;
    },
  );

  completeJob = vi.fn(
    async (lease: { id: string; leaseOwner: string }, now: Date) => {
      const job = this.held(lease, now);
      if (!job) return false;
      job.state = "succeeded";
      job.leaseOwner = null;
      return true;
    },
  );

  failJob = vi.fn(
    async (
      lease: { id: string; leaseOwner: string },
      errorCode: string,
      now: Date,
      options?: { retryable?: boolean },
    ) => {
      const job = this.held(lease, now);
      if (!job) return "lease_lost" as const;
      job.lastErrorCode = errorCode;
      job.leaseOwner = null;
      if ((options?.retryable ?? true) && job.attempts < job.maxAttempts) {
        job.state = "queued";
        job.runAfter =
          now.getTime() +
          Math.min(30_000 * 2 ** (job.attempts - 1), 60 * 60 * 1000);
        return "retry_scheduled" as const;
      }
      job.state = "failed";
      return "failed" as const;
    },
  );

  releaseJob = vi.fn(
    async (lease: { id: string; leaseOwner: string }, now: Date) => {
      const job = this.held(lease, now);
      if (!job) return false;
      job.state = "queued";
      job.attempts = Math.max(0, job.attempts - 1);
      job.runAfter = now.getTime();
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      return true;
    },
  );

  requeueExpiredJobs = vi.fn(async () => 0);
  enqueueJob = vi.fn(
    async (job: { kind: PublishingWorkerJobKind; subjectId: string }) => {
      const existing = [...this.jobs.values()].find(
        (candidate) =>
          candidate.kind === job.kind &&
          candidate.subjectId === job.subjectId &&
          (candidate.state === "queued" || candidate.state === "running"),
      );
      if (existing) return { id: existing.id, created: false };
      return { id: this.enqueue(job.kind, job.subjectId).id, created: true };
    },
  );
  scheduleCleanup = vi.fn(async () => ({
    expireSession: 0,
    purgeTrashedWork: 0,
    purgeItem: 0,
    purgeBlob: 0,
  }));
  purgeItem = vi.fn(
    async (itemId: string) =>
      this.purgePlans.get(itemId) ?? { status: "missing" as const },
  );
  purgeBlob = vi.fn(
    async (blobId: string) =>
      this.purgePlans.get(blobId) ?? { status: "missing" as const },
  );
  confirmPurged = vi.fn(async (blobIds: readonly string[]) => {
    this.confirmed.push([...blobIds]);
  });
}

class FakeStore implements PublishingWorkerStore {
  readonly removed: string[] = [];
  failRemoval = new Set<string>();
  blobs: { storageKey: string; byteSize: number; modifiedAt: Date }[] = [];

  remove = vi.fn(async (storageKey: string) => {
    if (this.failRemoval.has(storageKey)) {
      throw new PublishingMediaStoreError("unavailable", "EIO");
    }
    this.removed.push(storageKey);
  });

  listBlobs = vi.fn(
    async (options: { after?: string | null; limit: number }) => {
      const after = options.after ?? null;
      const remaining = this.blobs
        .filter((blob) => after === null || blob.storageKey > after)
        .sort((a, b) => a.storageKey.localeCompare(b.storageKey));
      const entries = remaining.slice(0, options.limit);
      return {
        entries,
        nextAfter:
          entries.length === options.limit
            ? entries[entries.length - 1]!.storageKey
            : null,
      };
    },
  );

  sweepStaging = vi.fn(async () => ({ removed: 0 }));
}

type ProcessCall = {
  input: ProcessorInput;
  result: ReturnType<typeof deferred<ProcessorOutcome>>;
};

/** A processor whose runs stay pending until the test settles them. */
class ControlledProcessor {
  readonly calls: ProcessCall[] = [];
  active = 0;
  maxActive = 0;

  process = vi.fn(async (input: ProcessorInput) => {
    const result = deferred<ProcessorOutcome>();
    this.calls.push({ input, result });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    input.signal?.addEventListener("abort", () => {
      result.reject(new MediaToolError("aborted"));
    });
    try {
      return await result.promise;
    } finally {
      this.active -= 1;
    }
  });

  processed(seed: number): ProcessorOutcome {
    return {
      status: "processed",
      detectedTypes: [{ role: "still", contentType: "image/jpeg" }],
      presentation: { width: 4, height: 3 },
      pairing: null,
      stillExifOrientation: null,
      placeholderColor: null,
      derivatives: (["thumb", "display"] as const).map((variant, index) => ({
        variant,
        recipeVersion: 1,
        recipeDigest: "0".repeat(16),
        editKey: "base",
        storageKey: blobKey(seed * 10 + index),
        byteSize: 5,
        sha256: "b".repeat(64),
        contentType: "image/webp" as const,
        width: 4,
        height: 3,
        durationMs: null,
      })),
    };
  }
}

const logLines = () => {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    },
  };
};

interface Harness {
  timers: ManualTimers;
  port: FakePort;
  store: FakeStore;
  processor: ControlledProcessor;
  worker: PublishingWorker;
  lines: string[];
}

const harness = (
  options: {
    concurrency?: number;
    handler?: Partial<PublishingJobHandlerOptions>;
    worker?: Partial<ConstructorParameters<typeof PublishingWorker>[0]>;
  } = {},
): Harness => {
  const timers = new ManualTimers();
  const port = new FakePort(timers);
  const store = new FakeStore();
  const processor = new ControlledProcessor();
  const { lines, logger } = logLines();
  const handlers = createPublishingJobHandlers({
    port,
    store,
    processor,
    clock: timers.clock,
    timers,
    logger,
    cancellationCheckMs: 5_000,
    ...options.handler,
  });
  const worker = new PublishingWorker({
    port,
    handlers,
    concurrency: options.concurrency ?? 1,
    owner: "worker-test",
    clock: timers.clock,
    timers,
    logger,
    leaseMs: 60_000,
    renewIntervalMs: 20_000,
    shutdownGraceMs: 10_000,
    abortGraceMs: 2_000,
    ...options.worker,
  });
  return { timers, port, store, processor, worker, lines };
};

/** Outcome calls (complete or fail) recorded for one job. */
const outcomesFor = (h: Harness, job: { id: string }) =>
  [...h.port.completeJob.mock.calls, ...h.port.failJob.mock.calls].filter(
    ([lease]) => lease.id === job.id,
  );

const itemJobs = (h: Harness) =>
  [...h.port.jobs.values()].filter((job) => job.kind === "process_item");

const running: PublishingWorker[] = [];
const started = (h: Harness) => {
  running.push(h.worker);
  h.worker.start();
  return h;
};

afterEach(async () => {
  for (const worker of running.splice(0)) void worker.stop();
});

describe("publishing worker lease and concurrency bound", () => {
  it("never runs or claims more jobs than its concurrency and refills freed slots", async () => {
    const h = started(harness({ concurrency: 2 }));
    for (let seed = 1; seed <= 5; seed += 1) h.port.addItem(seed);
    await h.timers.advance(0);

    expect(h.processor.calls).toHaveLength(2);
    expect(h.worker.activeJobs).toBe(2);
    expect(h.port.claimLimits[0]).toBe(2);

    // Polling while both slots are busy claims nothing.
    await h.timers.advance(PUBLISHING_WORKER_DEFAULTS.pollIntervalMs * 3);
    expect(h.processor.calls).toHaveLength(2);
    expect(h.port.claimLimits.every((limit) => limit >= 1 && limit <= 2)).toBe(
      true,
    );

    for (let index = 0; index < 5; index += 1) {
      const call = h.processor.calls[index]!;
      call.result.resolve(h.processor.processed(index + 1));
      await h.timers.advance(0);
    }
    await h.timers.advance(PUBLISHING_WORKER_DEFAULTS.pollIntervalMs);

    expect(h.processor.maxActive).toBe(2);
    expect(h.processor.calls).toHaveLength(5);
    expect(itemJobs(h).map((job) => job.state)).toEqual(
      Array(5).fill("succeeded"),
    );
    expect(
      [...h.port.items.values()].every((item) => item.state === "ready"),
    ).toBe(true);
    expect(h.port.claimLimits.every((limit) => limit <= 2)).toBe(true);
  });

  it("renews the lease while a job runs and aborts it without recording when the lease is lost", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    await h.timers.advance(0);
    expect(h.processor.calls).toHaveLength(1);

    await h.timers.advance(20_000);
    expect(h.port.renewJobLease).toHaveBeenCalledTimes(1);
    expect(h.port.renewJobLease.mock.calls[0]![1]).toBe(60_000);
    expect(job.leaseExpiresAt).toBe(START + 20_000 + 60_000);

    // Another worker took the job over (for example after a pause).
    job.leaseOwner = "other-worker";
    await h.timers.advance(20_000);

    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(true);
    expect(outcomesFor(h, job)).toEqual([]);
    expect(job.state).toBe("running");
    expect(h.port.markItemReady).not.toHaveBeenCalled();
    expect(h.worker.activeJobs).toBe(0);
    expect(h.lines).toContain(
      "[publishing-worker] job lease lost kind=process_item",
    );
  });

  it("treats a lease it could not renew before expiry as lost", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    await h.timers.advance(0);
    h.port.renewJobLease.mockRejectedValue(new Error("synthetic outage"));
    await h.timers.advance(40_000);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(false);
    await h.timers.advance(20_000);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(true);
    expect(outcomesFor(h, job)).toEqual([]);
  });

  it("aborts a job before its lease expires when a renewal call hangs", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    await h.timers.advance(0);
    h.port.renewJobLease.mockImplementation(() => new Promise(() => {}));
    // The lease (60 s) is guarded locally: abort 6 s before expiry although
    // no renewal ever answered.
    await h.timers.advance(53_000);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(false);
    await h.timers.advance(1_000);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(true);
    expect(h.timers.now).toBeLessThan(job.leaseExpiresAt!);
    expect(outcomesFor(h, job)).toEqual([]);
    expect(h.worker.activeJobs).toBe(0);
    expect(h.lines).toContain(
      "[publishing-worker] job lease lost kind=process_item",
    );
  });

  it("claims under a fresh lease owner each time so an old run cannot renew a reclaimed job", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    await h.timers.advance(0);
    const firstLease = { id: job.id, leaseOwner: job.leaseOwner! };
    expect(firstLease.leaseOwner).toMatch(/^worker-test\.[0-9a-z]+$/);
    // The lease expired while this process was paused and was requeued.
    job.state = "queued";
    job.leaseOwner = null;
    h.processor.calls[0]!.result.reject(new MediaToolError("aborted"));
    h.port.claimJobs.mockClear();
    await h.timers.advance(PUBLISHING_WORKER_DEFAULTS.pollIntervalMs * 40);
    expect(h.processor.calls.length).toBeGreaterThanOrEqual(2);
    expect(job.state).toBe("running");
    expect(job.leaseOwner).not.toBe(firstLease.leaseOwner);
    await expect(
      h.port.renewJobLease(firstLease, 60_000, h.timers.clock()),
    ).resolves.toBe(false);
    const owners = h.port.claimJobs.mock.calls.map(
      ([options]) => options.owner,
    );
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("refuses an owner label that leaves no room for the claim sequence", () => {
    const timers = new ManualTimers();
    const port = new FakePort(timers);
    const options = {
      port,
      handlers: { run: async () => ({ status: "completed" as const }) },
    };
    expect(
      () => new PublishingWorker({ ...options, owner: "a".repeat(100) }),
    ).not.toThrow();
    expect(
      () => new PublishingWorker({ ...options, owner: "a".repeat(101) }),
    ).toThrow(/owner label is invalid/);
  });

  it("backs off polling while the queue is unreachable and logs the outage once", async () => {
    const h = started(harness());
    h.port.failClaims = true;
    await h.timers.advance(0);
    await h.timers.advance(10_000);
    const failedClaims = h.port.claimJobs.mock.calls.length;
    // 1 s, 2 s, 4 s … instead of one claim per second.
    expect(failedClaims).toBeLessThan(6);
    expect(
      h.lines.filter((line) => line === "[publishing-worker] job claim failed"),
    ).toHaveLength(1);
    h.port.failClaims = false;
    await h.timers.advance(40_000);
    expect(h.lines).toContain("[publishing-worker] job queue reachable again");
  });
});

describe("publishing worker processing outcomes", () => {
  it("commits a processed item with its derivatives", async () => {
    const h = started(harness());
    h.port.addItem(1);
    await h.timers.advance(0);
    const input = h.processor.calls[0]!.input;
    expect(input.mode).toBe("process");
    expect(input.itemId).toBe(ITEM(1));
    h.processor.calls[0]!.result.resolve(h.processor.processed(1));
    await h.timers.advance(0);

    expect(h.port.markItemReady).toHaveBeenCalledTimes(1);
    expect(h.port.items.get(ITEM(1))!.state).toBe("ready");
    expect(h.store.removed).toEqual([]);
    expect([...h.port.jobs.values()][0]!.state).toBe("succeeded");
  });

  it("aborts processing when the item is cancelled meanwhile and records nothing", async () => {
    const h = started(harness());
    h.port.addItem(1);
    await h.timers.advance(0);
    const call = h.processor.calls[0]!;

    await h.timers.advance(5_000);
    expect(call.input.signal?.aborted).toBe(false);
    h.port.items.get(ITEM(1))!.state = "cancelled";
    await h.timers.advance(5_000);

    expect(call.input.signal?.aborted).toBe(true);
    expect(h.port.markItemReady).not.toHaveBeenCalled();
    expect(h.port.markItemFailed).not.toHaveBeenCalled();
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect([...h.port.jobs.values()][0]!.state).toBe("succeeded");
  });

  it("removes produced derivatives when the item was cancelled right before the commit", async () => {
    const h = started(harness());
    h.port.addItem(1);
    h.port.cancelOnCommit.add(ITEM(1));
    await h.timers.advance(0);
    const outcome = h.processor.processed(1);
    h.processor.calls[0]!.result.resolve(outcome);
    await h.timers.advance(0);

    expect(h.port.markItemReady).toHaveBeenCalledTimes(1);
    expect(h.store.removed.sort()).toEqual(
      outcome.status === "processed"
        ? outcome.derivatives.map((derivative) => derivative.storageKey).sort()
        : [],
    );
    expect(h.port.items.get(ITEM(1))!.state).toBe("cancelled");
    expect([...h.port.jobs.values()][0]!.state).toBe("succeeded");
  });

  it("removes only unrecorded derivatives when the commit certainly rolled back", async () => {
    const h = started(harness());
    h.port.addItem(1);
    await h.timers.advance(0);
    const outcome = h.processor.processed(1);
    const keys =
      outcome.status === "processed"
        ? outcome.derivatives.map((derivative) => derivative.storageKey)
        : [];
    // An ambiguous commit recorded the first key before the error surfaced.
    h.port.markItemReady.mockImplementationOnce(async () => {
      h.port.recordedKeys.add(keys[0]!);
      throw new CommunityConflictError();
    });
    h.processor.calls[0]!.result.resolve(outcome);
    await h.timers.advance(0);

    expect(h.store.removed).toEqual([keys[1]]);
    const job = [...h.port.jobs.values()][0]!;
    expect(job.state).toBe("queued");
    expect(job.lastErrorCode).toBe("state_conflict");
  });

  it.each([
    ["an unavailable store", new CommunityStoreUnavailableError()],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    [
      "an admin shutdown",
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
    ],
  ])(
    "leaves derivatives to store reconciliation when a commit fails with %s",
    async (_label, error) => {
      const h = started(harness());
      h.port.addItem(1);
      await h.timers.advance(0);
      // The commit may have landed although the client saw an error.
      h.port.markItemReady.mockRejectedValueOnce(error);
      h.processor.calls[0]!.result.resolve(h.processor.processed(1));
      await h.timers.advance(0);

      expect(h.port.unrecordedStorageKeys).not.toHaveBeenCalled();
      expect(h.store.remove).not.toHaveBeenCalled();
      expect([...h.port.jobs.values()][0]!.state).toBe("queued");
      expect(h.lines).toContain(
        "[publishing-worker] derivative commit outcome unknown count=2",
      );
    },
  );

  it("removes derivatives at once when the server reported a statement error", async () => {
    const h = started(harness());
    h.port.addItem(1);
    await h.timers.advance(0);
    const outcome = h.processor.processed(1);
    h.port.markItemReady.mockRejectedValueOnce(
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    );
    h.processor.calls[0]!.result.resolve(outcome);
    await h.timers.advance(0);
    expect(h.store.removed).toHaveLength(2);
  });

  it("fails the item without retry on a deterministic rejection", async () => {
    const h = started(harness());
    h.port.addItem(1);
    await h.timers.advance(0);
    h.processor.calls[0]!.result.resolve({
      status: "rejected",
      failureCode: "decode_failed",
    });
    await h.timers.advance(0);

    expect(h.port.markItemFailed).toHaveBeenCalledWith(
      ITEM(1),
      "decode_failed",
      expect.any(Date),
    );
    expect(h.port.items.get(ITEM(1))).toEqual({
      state: "failed",
      failureCode: "decode_failed",
    });
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect([...h.port.jobs.values()][0]!.state).toBe("succeeded");
    await h.timers.advance(10 * 60 * 1000);
    expect(h.processor.calls).toHaveLength(1);
  });

  it("derives an edit in derive mode and fails only that edit on rejection", async () => {
    const h = started(harness());
    h.port.items.set(ITEM(2), { state: "ready", failureCode: null });
    const payload = {
      editKey: "c".repeat(32),
      edit: { rotation: 90 as const, crop: null },
      coverCrop: null,
      variants: ["display" as const, "full" as const],
    };
    const job = h.port.enqueue("derive_edit", ITEM(2), { payload });
    await h.timers.advance(0);
    const input = h.processor.calls[0]!.input;
    expect(input).toMatchObject({
      mode: "derive",
      editKey: payload.editKey,
      edit: payload.edit,
      variants: payload.variants,
    });
    h.processor.calls[0]!.result.resolve({
      status: "rejected",
      failureCode: "dimensions_exceeded",
    });
    await h.timers.advance(0);

    expect(h.port.markItemFailed).not.toHaveBeenCalled();
    expect(h.port.items.get(ITEM(2))!.state).toBe("ready");
    expect(job.state).toBe("failed");
    expect(job.lastErrorCode).toBe("dimensions_exceeded");
    expect(h.port.failJob.mock.calls[0]![3]).toEqual({ retryable: false });
  });
});

describe("publishing worker legacy edits", () => {
  const payload = {
    editKey: "e".repeat(32),
    edit: { rotation: 90 as const, crop: null },
    coverCrop: { x: 0, y: 0, width: 0.5, height: 1 },
    variants: ["thumb" as const, "display" as const],
  };
  const legacyJob = (h: Harness, bytes: Uint8Array | null, byteSize = 64) => {
    h.port.items.set(ITEM(7), { state: "ready", failureCode: null });
    h.port.legacy.set(ITEM(7), { byteSize, bytes });
    return h.port.enqueue("derive_edit", ITEM(7), { payload });
  };
  const derived = (): ProcessorOutcome => ({
    status: "derived",
    derivatives: payload.variants.map((variant, index) => ({
      variant,
      recipeVersion: 1,
      recipeDigest: "0".repeat(16),
      editKey: payload.editKey,
      storageKey: blobKey(70 + index),
      byteSize: 5,
      sha256: "c".repeat(64),
      contentType: "image/webp" as const,
      width: 4,
      height: 3,
      durationMs: null,
    })),
  });

  it("derives the requested variants from the user media PNG read into the job input", async () => {
    const h = started(harness());
    const bytes = legacyPng(64);
    const job = legacyJob(h, bytes);
    await h.timers.advance(0);

    expect(h.port.readLegacyMediaBytes).toHaveBeenCalledWith(ITEM(7));
    const input = h.processor.calls[0]!.input;
    expect(input).toMatchObject({
      mode: "derive",
      itemId: ITEM(7),
      kind: "static",
      source: {
        kind: "legacy_user_media",
        legacyMediaId: LEGACY_MEDIA(1),
        byteSize: 64,
        contentType: "image/png",
      },
      components: [],
      editKey: payload.editKey,
      edit: payload.edit,
      coverCrop: payload.coverCrop,
      variants: payload.variants,
    });
    expect(input.legacyStill).toBe(bytes);
    h.processor.calls[0]!.result.resolve(derived());
    await h.timers.advance(0);

    expect(h.port.recordDerivatives).toHaveBeenCalledTimes(1);
    expect(job.state).toBe("succeeded");
    expect(h.store.removed).toEqual([]);
    // Reads only: no user media, item state or source write happens.
    expect(h.port.markItemReady).not.toHaveBeenCalled();
    expect(h.port.markItemFailed).not.toHaveBeenCalled();
    expect(h.port.items.get(ITEM(7))!.state).toBe("ready");
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it.each<[string, Uint8Array, number, string]>([
    ["fewer bytes than declared", legacyPng(32), 64, "size_mismatch"],
    ["more bytes than declared", legacyPng(96), 64, "size_mismatch"],
    [
      "bytes that are not a PNG",
      new Uint8Array(64).fill(0xff),
      64,
      "unsupported_type",
    ],
    [
      "a source above the user media bound",
      legacyPng(64),
      4 * 1024 * 1024 + 1,
      "processing_input_invalid",
    ],
  ])(
    "fails the edit without retry for %s before any decoder runs",
    async (_name, bytes, byteSize, code) => {
      const h = started(harness());
      const job = legacyJob(h, bytes, byteSize);
      await h.timers.advance(0);

      expect(h.processor.process).not.toHaveBeenCalled();
      expect(job).toMatchObject({
        state: "failed",
        attempts: 1,
        lastErrorCode: code,
      });
      expect(h.port.failJob.mock.calls[0]![3]).toEqual({ retryable: false });
      expect(h.port.readLegacyMediaBytes).toHaveBeenCalledTimes(
        code === "processing_input_invalid" ? 0 : 1,
      );
      expect(h.port.markItemFailed).not.toHaveBeenCalled();
      expect(h.port.items.get(ITEM(7))!.state).toBe("ready");
    },
  );

  it("completes without work when the legacy item was purged before its bytes were read", async () => {
    const h = started(harness());
    const job = legacyJob(h, null);
    await h.timers.advance(0);
    // The port reads no bytes only for a purged item (user media outlives
    // every item naming it), so there is nothing left to derive or retry.
    expect(h.port.readLegacyMediaBytes).toHaveBeenCalledTimes(1);
    expect(h.port.readProcessing).toHaveBeenCalledTimes(1);
    expect(h.processor.process).not.toHaveBeenCalled();
    expect(job.state).toBe("succeeded");
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.port.recordDerivatives).not.toHaveBeenCalled();
  });

  it("never processes a legacy source as a new item", async () => {
    const h = started(harness());
    h.port.items.set(ITEM(8), { state: "processing", failureCode: null });
    h.port.legacy.set(ITEM(8), { byteSize: 64, bytes: legacyPng(64) });
    const processJob = h.port.enqueue("process_item", ITEM(8));
    await h.timers.advance(0);

    expect(h.processor.process).not.toHaveBeenCalled();
    expect(h.port.readLegacyMediaBytes).not.toHaveBeenCalled();
    expect(processJob).toMatchObject({
      state: "failed",
      lastErrorCode: "processing_input_invalid",
    });
  });
});

describe("publishing worker failure classification and retry backoff", () => {
  it.each<[unknown, string, boolean]>([
    [
      new MediaToolError("sandbox_unavailable"),
      "media_tool_sandbox_unavailable",
      true,
    ],
    [new MediaToolError("timeout"), "media_tool_timeout", true],
    [
      new PublishingMediaStoreError("unavailable", "ENOSPC"),
      "media_store_unavailable",
      true,
    ],
    [
      new MediaProcessingUnavailableError("EIO"),
      "processing_unavailable",
      true,
    ],
    [new CommunityConflictError(), "state_conflict", true],
    [new MediaProcessingInputError(), "processing_input_invalid", false],
    [new CommunityNotFoundError(), "subject_not_found", false],
    [new TypeError("synthetic bug"), "unexpected_error", true],
    ["not an error", "unexpected_error", true],
  ])("classifies %o by name", (error, errorCode, retryable) => {
    expect(classifyPublishingJobError(error)).toEqual({ errorCode, retryable });
  });

  it("classifies look-alike errors by name without reading messages", () => {
    const foreign = Object.assign(new Error("/private/path/with/secret"), {
      name: "MediaToolError",
      code: "spawn_failed",
    });
    expect(classifyPublishingJobError(foreign)).toEqual({
      errorCode: "media_tool_spawn_failed",
      retryable: true,
    });
    const hostile = Object.assign(new Error("x"), {
      name: "PublishingMediaStoreError",
      code: "../../etc",
    });
    expect(classifyPublishingJobError(hostile).errorCode).toBe(
      "media_store_failure",
    );
  });

  it("retries system failures with exponential backoff until attempts run out", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    job.maxAttempts = 3;
    h.processor.process.mockRejectedValue(
      new MediaToolError("sandbox_unavailable"),
    );

    await h.timers.advance(0);
    expect(job).toMatchObject({
      state: "queued",
      attempts: 1,
      lastErrorCode: "media_tool_sandbox_unavailable",
      runAfter: START + 30_000,
    });
    await h.timers.advance(29_000);
    expect(h.processor.process).toHaveBeenCalledTimes(1);
    await h.timers.advance(2_000);
    expect(h.processor.process).toHaveBeenCalledTimes(2);
    expect(job.state).toBe("queued");
    expect(job.runAfter - h.timers.now).toBeGreaterThan(55_000);
    await h.timers.advance(61_000);
    expect(h.processor.process).toHaveBeenCalledTimes(3);
    expect(job.state).toBe("failed");
    // The item does not wait for a job that never runs again.
    expect(h.port.markItemFailed).toHaveBeenCalledTimes(1);
    expect(h.port.markItemFailed).toHaveBeenCalledWith(
      ITEM(1),
      "processing_failed",
      expect.any(Date),
    );
    expect(h.port.items.get(ITEM(1))).toEqual({
      state: "failed",
      failureCode: "processing_failed",
    });
    await h.timers.advance(10 * 60 * 1000);
    expect(h.processor.process).toHaveBeenCalledTimes(3);
    for (const line of h.lines) expect(line).not.toMatch(/media-item-|blobs\//);
  });

  it("fails malformed processing input without retry", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    h.processor.process.mockRejectedValue(new MediaProcessingInputError());
    await h.timers.advance(0);
    expect(job).toMatchObject({
      state: "failed",
      attempts: 1,
      lastErrorCode: "processing_input_invalid",
    });
    expect(h.port.items.get(ITEM(1))!.state).toBe("failed");
  });

  it("settles only processing items when a job fails for good and logs a follow-up failure", async () => {
    const h = started(harness({ concurrency: 3 }));
    h.port.items.set(ITEM(2), { state: "ready", failureCode: null });
    const derive = h.port.enqueue("derive_edit", ITEM(2), {
      payload: {
        editKey: "d".repeat(32),
        edit: { rotation: 0, crop: null },
        coverCrop: null,
        variants: ["display"],
      },
      maxAttempts: 1,
    });
    const trash = h.port.enqueue("purge_trashed_work", `work-${hex(3)}`, {
      maxAttempts: 1,
    });
    h.port.purgeTrashedWork.mockRejectedValueOnce(
      new CommunityStoreUnavailableError(),
    );
    const item = h.port.addItem(1);
    item.maxAttempts = 1;
    h.processor.process.mockRejectedValue(new MediaToolError("timeout"));
    h.port.markItemFailed.mockRejectedValueOnce(
      new CommunityStoreUnavailableError(),
    );
    await h.timers.advance(0);

    expect([derive.state, trash.state, item.state]).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(h.port.markItemFailed.mock.calls.map(([id]) => id)).toEqual([
      ITEM(1),
    ]);
    expect(h.port.items.get(ITEM(2))!.state).toBe("ready");
    expect(h.lines).toContain(
      "[publishing-worker] failed job subject not updated kind=process_item",
    );
  });

  it("refuses unknown subjects and payload-less edits without calling the port", async () => {
    const h = started(harness({ concurrency: 3 }));
    const badItem = h.port.enqueue("process_item", "work-1");
    const noPayload = h.port.enqueue("derive_edit", ITEM(3));
    const badAccount = h.port.enqueue("reconcile_capacity", "someone");
    await h.timers.advance(0);
    expect(badItem).toMatchObject({
      state: "failed",
      lastErrorCode: "invalid_job_subject",
    });
    expect(noPayload).toMatchObject({
      state: "failed",
      lastErrorCode: "invalid_job_payload",
    });
    expect(badAccount).toMatchObject({
      state: "failed",
      lastErrorCode: "invalid_job_subject",
    });
    expect(h.port.readProcessing).not.toHaveBeenCalled();
    expect(h.port.reconcileCapacity).not.toHaveBeenCalled();
  });
});

describe("publishing worker graceful shutdown", () => {
  it("stops claiming and lets a job that finishes within the grace complete", async () => {
    const h = started(harness());
    h.port.addItem(1);
    h.port.addItem(2);
    await h.timers.advance(0);
    const stopped = h.worker.stop();
    await h.timers.advance(3_000);
    h.processor.calls[0]!.result.resolve(h.processor.processed(1));
    await h.timers.advance(0);
    await stopped;

    const [first, second] = [...h.port.jobs.values()];
    expect(first!.state).toBe("succeeded");
    expect(second!.state).toBe("queued");
    expect(h.processor.calls).toHaveLength(1);
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.worker.running).toBe(false);
    await h.timers.advance(60_000);
    expect(h.processor.calls).toHaveLength(1);
  });

  it("waits for a job whose handler requested the stop itself", async () => {
    const timers = new ManualTimers();
    const port = new FakePort(timers);
    const job = port.addItem(1);
    const finish = deferred<void>();
    const worker: PublishingWorker = new PublishingWorker({
      port,
      owner: "worker-test",
      clock: timers.clock,
      timers,
      logger: logLines().logger,
      maintenance: false,
      shutdownGraceMs: 10_000,
      handlers: {
        run() {
          void worker.stop();
          return finish.promise.then(() => ({ status: "completed" as const }));
        },
      },
    });
    worker.start();
    await timers.advance(0);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await timers.advance(5_000);
    expect(stopped).toBe(false);
    finish.resolve();
    await timers.advance(0);
    await stopping;
    expect(job.state).toBe("succeeded");
    expect(port.failJob).not.toHaveBeenCalled();
  });

  it("aborts jobs still running after the grace and releases their leases without spending attempts", async () => {
    const h = started(harness({ concurrency: 2 }));
    const first = h.port.addItem(1);
    const second = h.port.addItem(2);
    // The first processor ignores abort and never settles.
    h.processor.process.mockImplementationOnce(() => new Promise(() => {}));
    await h.timers.advance(0);
    expect(h.processor.calls).toHaveLength(1);
    let done = false;
    const stopped = h.worker.stop().then(() => {
      done = true;
    });
    await h.timers.advance(9_000);
    expect(done).toBe(false);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(false);
    await h.timers.advance(1_000);
    expect(h.processor.calls[0]!.input.signal?.aborted).toBe(true);
    expect(done).toBe(false);
    await h.timers.advance(2_000);
    await stopped;

    expect(done).toBe(true);
    for (const job of [first, second]) {
      expect(job).toMatchObject({
        state: "queued",
        attempts: 0,
        lastErrorCode: null,
      });
    }
    expect(h.port.releaseJob).toHaveBeenCalledTimes(2);
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.port.completeJob).not.toHaveBeenCalled();
    expect(h.port.markItemReady).not.toHaveBeenCalled();
  });

  it("releases a lease on its last attempt at shutdown without failing the job or its item", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    job.maxAttempts = 1;
    h.processor.process.mockImplementationOnce(() => new Promise(() => {}));
    await h.timers.advance(0);
    expect(job.attempts).toBe(1);
    const stopped = h.worker.stop();
    await h.timers.advance(10_000);
    await h.timers.advance(2_000);
    await stopped;

    // Last attempt, yet the job is queued again right away and nothing failed.
    expect(job).toMatchObject({
      state: "queued",
      attempts: 0,
      runAfter: h.timers.now,
      lastErrorCode: null,
    });
    expect(h.port.releaseJob).toHaveBeenCalledTimes(1);
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.port.markItemFailed).not.toHaveBeenCalled();
  });

  it("logs a release the queue could not record and records nothing else", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    h.processor.process.mockImplementationOnce(() => new Promise(() => {}));
    await h.timers.advance(0);
    h.port.releaseJob.mockRejectedValueOnce(
      new CommunityStoreUnavailableError(),
    );
    const stopped = h.worker.stop();
    await h.timers.advance(10_000);
    await h.timers.advance(2_000);
    await stopped;

    expect(h.port.releaseJob).toHaveBeenCalledTimes(1);
    expect(job.state).toBe("running");
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.lines).toContain(
      "[publishing-worker] job lease not released kind=process_item",
    );
  });

  it("releases jobs whose claim returned after the stop began without running them", async () => {
    const h = started(harness({ concurrency: 2 }));
    const first = h.port.addItem(1);
    const second = h.port.addItem(2);
    const claimed = deferred<void>();
    const claimJobs = h.port.claimJobs.getMockImplementation()!;
    h.port.claimJobs.mockImplementationOnce(async (options, now) => {
      const claims = await claimJobs(options, now);
      await claimed.promise;
      return claims;
    });
    await h.timers.advance(0);
    expect([first.state, second.state]).toEqual(["running", "running"]);
    const stopped = h.worker.stop();
    claimed.resolve();
    await h.timers.advance(0);
    await stopped;

    expect(h.processor.process).not.toHaveBeenCalled();
    expect(h.port.releaseJob).toHaveBeenCalledTimes(2);
    for (const job of [first, second]) {
      expect(job).toMatchObject({ state: "queued", attempts: 0 });
    }
    expect(h.port.failJob).not.toHaveBeenCalled();
  });

  it("discards a late result after its lease was released", async () => {
    const h = started(harness());
    const job = h.port.addItem(1);
    const hanging = deferred<ProcessorOutcome>();
    h.processor.process.mockImplementationOnce(() => hanging.promise);
    await h.timers.advance(0);
    const stopped = h.worker.stop();
    await h.timers.advance(10_000);
    await h.timers.advance(2_000);
    await stopped;
    expect(job).toMatchObject({ state: "queued", attempts: 0 });
    expect(h.port.releaseJob).toHaveBeenCalledTimes(1);

    const outcome = h.processor.processed(1);
    hanging.resolve(outcome);
    await h.timers.advance(0);
    expect(h.port.markItemReady).not.toHaveBeenCalled();
    expect(h.port.completeJob).not.toHaveBeenCalled();
    expect(h.port.failJob).not.toHaveBeenCalled();
    expect(h.store.removed.sort()).toEqual(
      outcome.status === "processed"
        ? outcome.derivatives.map((derivative) => derivative.storageKey).sort()
        : [],
    );
  });

  it("stops an idle or never-started worker immediately", async () => {
    const idle = harness();
    await idle.worker.stop();
    const h = started(harness());
    await h.timers.advance(0);
    await h.worker.stop();
    expect(h.timers.pending).toBe(0);
  });
});

describe("publishing worker maintenance and cleanup jobs", () => {
  it("requeues expired leases, schedules cleanup and enqueues the sweeps on their cadence", async () => {
    const h = started(harness());
    await h.timers.advance(0);
    expect(h.port.requeueExpiredJobs).toHaveBeenCalledTimes(1);
    expect(h.port.scheduleCleanup).toHaveBeenCalledTimes(1);
    expect(h.port.enqueueJob.mock.calls.map(([job]) => job)).toEqual([
      { kind: "sweep_staging", subjectId: PUBLISHING_STAGING_SWEEP_SUBJECT },
      {
        kind: "reconcile_capacity",
        subjectId: PUBLISHING_STORE_RECONCILE_SUBJECT,
      },
    ]);
    // Both scheduled jobs are valid operator-listable jobs and run right away.
    for (const [job] of h.port.enqueueJob.mock.calls) {
      expect(publishingJobKindSchema.parse(job.kind)).toBe(job.kind);
      expect(job.subjectId).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/);
    }
    await h.timers.advance(59_000);
    expect(h.port.scheduleCleanup).toHaveBeenCalledTimes(1);
    expect(h.port.requeueExpiredJobs).toHaveBeenCalledTimes(2);
    await h.timers.advance(1_000);
    expect(h.port.scheduleCleanup).toHaveBeenCalledTimes(2);
    expect(h.port.enqueueJob).toHaveBeenCalledTimes(2);
  });

  it("claims only the configured kinds and can leave maintenance to another worker", async () => {
    const h = started(
      harness({
        concurrency: 2,
        worker: { kinds: ["purge_trashed_work"], maintenance: false },
      }),
    );
    const item = h.port.addItem(1);
    const trash = h.port.enqueue("purge_trashed_work", `work-${hex(7)}`);
    await h.timers.advance(PUBLISHING_WORKER_DEFAULTS.cleanupIntervalMs * 2);
    expect(trash.state).toBe("succeeded");
    expect(item.state).toBe("queued");
    expect(
      h.port.claimJobs.mock.calls.every(
        ([options]) => options.kinds?.join() === "purge_trashed_work",
      ),
    ).toBe(true);
    expect(h.port.requeueExpiredJobs).not.toHaveBeenCalled();
    expect(h.port.scheduleCleanup).not.toHaveBeenCalled();
    expect(h.port.enqueueJob).not.toHaveBeenCalled();
  });

  it("finishes a purge by removing tombstoned blobs and confirming only removed ones", async () => {
    const h = started(harness({ concurrency: 2 }));
    h.port.purgePlans.set(ITEM(4), {
      status: "tombstoned",
      blobs: [
        { blobId: `media-blob-${hex(1)}`, storageKey: blobKey(1) },
        { blobId: `media-blob-${hex(2)}`, storageKey: blobKey(2) },
      ],
    });
    h.store.failRemoval.add(blobKey(2));
    const job = h.port.enqueue("purge_item", ITEM(4));
    const referenced = h.port.enqueue("purge_blob", `media-blob-${hex(9)}`);
    h.port.purgePlans.set(`media-blob-${hex(9)}`, { status: "referenced" });
    await h.timers.advance(0);

    expect(h.store.removed).toEqual([blobKey(1)]);
    expect(h.port.confirmed).toEqual([[`media-blob-${hex(1)}`]]);
    expect(job).toMatchObject({
      state: "queued",
      lastErrorCode: "media_store_unavailable",
    });
    expect(referenced.state).toBe("succeeded");

    h.store.failRemoval.clear();
    await h.timers.advance(30_000);
    expect(job.state).toBe("succeeded");
    expect(h.port.confirmed.at(-1)).toEqual([
      `media-blob-${hex(1)}`,
      `media-blob-${hex(2)}`,
    ]);
  });

  it("stops transfers of an expired session through the upload registry hook", async () => {
    const stoppedUploads: string[][] = [];
    const h = started(
      harness({
        handler: { onUploadsCancelled: (ids) => stoppedUploads.push([...ids]) },
      }),
    );
    h.port.expiredComponents = [`media-component-${hex(5)}`];
    const job = h.port.enqueue(
      "expire_session",
      `publishing-session-${hex(1)}`,
    );
    const trash = h.port.enqueue("purge_trashed_work", `work-${hex(2)}`);
    await h.timers.advance(0);
    await h.timers.advance(0);
    expect(stoppedUploads).toEqual([[`media-component-${hex(5)}`]]);
    expect(job.state).toBe("succeeded");
    expect(trash.state).toBe("succeeded");
    expect(h.port.purgeTrashedWork).toHaveBeenCalledWith(
      `work-${hex(2)}`,
      new Date(h.timers.now),
    );
  });

  it("sweeps staging and tool job leftovers older than a cutoff beyond the lease", async () => {
    const toolJobs = { sweepJobs: vi.fn(async () => ({ removed: 2 })) };
    const h = started(harness({ handler: { toolJobs } }));
    h.store.sweepStaging
      .mockResolvedValueOnce({ removed: 1000 })
      .mockResolvedValueOnce({ removed: 3 });
    await h.timers.advance(0);
    await h.timers.advance(0);
    const cutoff = new Date(START - PUBLISHING_LEFTOVER_AGE_MS);
    expect(PUBLISHING_LEFTOVER_AGE_MS).toBeGreaterThan(
      PUBLISHING_WORKER_DEFAULTS.leaseMs,
    );
    expect(h.store.sweepStaging).toHaveBeenCalledTimes(2);
    expect(h.store.sweepStaging).toHaveBeenCalledWith(
      cutoff,
      expect.any(AbortSignal),
    );
    expect(toolJobs.sweepJobs).toHaveBeenCalledWith(cutoff);
    expect(h.lines).toContain(
      "[publishing-worker] leftovers removed staging=1003 tool_jobs=2",
    );
  });

  it("reports unrecorded store blobs and removes only those older than the orphan grace", async () => {
    const h = started(harness());
    const day = 24 * 60 * 60 * 1000;
    h.store.blobs = [
      {
        storageKey: blobKey(1),
        byteSize: 1,
        modifiedAt: new Date(START - 8 * day),
      },
      {
        storageKey: blobKey(2),
        byteSize: 1,
        modifiedAt: new Date(START - 8 * day),
      },
      {
        storageKey: blobKey(3),
        byteSize: 1,
        modifiedAt: new Date(START - 1 * day),
      },
    ];
    h.port.recordedKeys.add(blobKey(2));
    const account = h.port.enqueue("reconcile_capacity", OWNER);
    await h.timers.advance(0);
    await h.timers.advance(0);
    await h.timers.advance(0);

    expect(h.port.reconcileCapacity).toHaveBeenCalledWith(
      OWNER,
      expect.any(Date),
    );
    expect(account.state).toBe("succeeded");
    expect(h.store.removed).toEqual([blobKey(1)]);
    expect(h.lines).toContain(
      "[publishing-worker] media store reconciliation unrecorded=2 removed=1",
    );
    for (const line of h.lines) {
      expect(line).not.toMatch(/blobs\/|user-|media-item-|publishing-job-/);
    }
  });
});

describe("COS worker maintenance cancellation", () => {
  const maintenance = () => {
    const h = harness();
    const f = cosFixture();
    for (const key of [blobKey(1), blobKey(2)]) {
      f.objects.set(cosOptions.prefix + key, {
        bytes: Buffer.from("x"),
        headers: {},
        modified: new Date(START - 8 * 24 * 60 * 60 * 1000),
      });
    }
    const handlers = createPublishingJobHandlers({
      port: h.port,
      store: f.store,
      processor: h.processor,
      clock: h.timers.clock,
    });
    const claim: PublishingWorkerJobClaim = {
      id: `publishing-job-${hex(1)}`,
      kind: "reconcile_capacity",
      subjectId: PUBLISHING_STORE_RECONCILE_SUBJECT,
      payload: null,
      attempts: 1,
      maxAttempts: 5,
      leaseOwner: "synthetic-maintenance-worker",
      leaseExpiresAt: new Date(START + 60_000),
    };
    return { h, f, handlers, claim, controller: new AbortController() };
  };

  it("cancels listing through the COS transport without deleting or completing", async () => {
    const { h, f, handlers, claim, controller } = maintenance();
    const reason = new Error("synthetic lease lost during listing");
    f.state.before = async (method, _input, signal) => {
      expect(signal).toBe(controller.signal);
      if (method === "getBucket") {
        controller.abort(reason);
        throw new PublishingMediaStoreError("aborted");
      }
    };
    await expect(handlers.run(claim, controller.signal)).rejects.toBe(reason);
    expect(f.calls.map((call) => call.method)).toEqual(["getBucket"]);
    expect(h.port.unrecordedStorageKeys).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(2);
  });

  it("stops after the first completed remote delete when its worker is cancelled", async () => {
    const { f, handlers, claim, controller } = maintenance();
    const reason = new Error("synthetic lease lost during delete");
    f.state.before = async (_method, _input, signal) => {
      expect(signal).toBe(controller.signal);
    };
    f.state.after = (method) => {
      if (method === "deleteObject") controller.abort(reason);
    };
    await expect(handlers.run(claim, controller.signal)).rejects.toBe(reason);
    expect(f.calls.map((call) => call.method)).toEqual([
      "getBucket",
      "getBucketVersioning",
      "deleteObject",
    ]);
    expect(f.objects.has(cosOptions.prefix + blobKey(1))).toBe(false);
    expect(f.objects.has(cosOptions.prefix + blobKey(2))).toBe(true);
  });

  it("does not start a DELETE after cancellation during the versioning check", async () => {
    const { f, handlers, claim, controller } = maintenance();
    const reason = new Error("synthetic shutdown during versioning");
    f.state.after = (method) => {
      if (method === "getBucketVersioning") controller.abort(reason);
    };
    await expect(handlers.run(claim, controller.signal)).rejects.toBe(reason);
    expect(f.calls.map((call) => call.method)).toEqual([
      "getBucket",
      "getBucketVersioning",
    ]);
    expect(f.objects.size).toBe(2);
  });

  it("preserves cancellation while the purge plan is being read", async () => {
    const { h, f, handlers, claim, controller } = maintenance();
    const plan = deferred<PublishingWorkerPurgePlan>();
    h.port.purgeItem.mockImplementation(() => plan.promise);
    const reason = new Error("synthetic lease lost during purge lookup");
    const result = handlers.run(
      { ...claim, kind: "purge_item", subjectId: ITEM(4) },
      controller.signal,
    );
    const rejected = expect(result).rejects.toBe(reason);
    controller.abort(reason);
    plan.resolve({ status: "missing" });
    await rejected;
    expect(f.calls).toEqual([]);
    expect(h.port.confirmed).toEqual([]);
  });

  it.each(["reconcile_capacity", "purge_item"] as const)(
    "normally completes %s cleanup of both old objects",
    async (kind) => {
      const { h, f, handlers, claim, controller } = maintenance();
      h.port.purgePlans.set(ITEM(4), {
        status: "tombstoned",
        blobs: [1, 2].map((seed) => ({
          blobId: `media-blob-${hex(seed)}`,
          storageKey: blobKey(seed),
        })),
      });
      await expect(
        handlers.run(
          {
            ...claim,
            kind,
            subjectId:
              kind === "purge_item"
                ? ITEM(4)
                : PUBLISHING_STORE_RECONCILE_SUBJECT,
          },
          controller.signal,
        ),
      ).resolves.toEqual({ status: "completed" });
      expect(
        f.calls.filter((call) => call.method === "deleteObject"),
      ).toHaveLength(2);
      expect(f.objects.size).toBe(0);
      if (kind === "purge_item") {
        expect(h.port.confirmed).toEqual([
          [1, 2].map((seed) => `media-blob-${hex(seed)}`),
        ]);
      }
    },
  );

  describe.each(["reconcile_capacity", "purge_item"] as const)(
    "running %s cancellation",
    (kind) => {
      it.each(["shutdown", "lease_lost"] as const)(
        "aborts a pending DELETE on %s without starting another or recording success",
        async (reason) => {
          const f = cosFixture();
          const h = started(
            harness({
              handler: { store: f.store },
              worker: { maintenance: false },
            }),
          );
          for (const key of [blobKey(1), blobKey(2)]) {
            f.objects.set(cosOptions.prefix + key, {
              bytes: Buffer.from("x"),
              headers: {},
              modified: new Date(START - 8 * 24 * 60 * 60 * 1000),
            });
          }
          h.port.purgePlans.set(ITEM(4), {
            status: "tombstoned",
            blobs: [1, 2].map((seed) => ({
              blobId: `media-blob-${hex(seed)}`,
              storageKey: blobKey(seed),
            })),
          });
          const pending = deferred<AbortSignal>();
          f.state.before = async (method, _input, signal) => {
            expect(signal).toBeDefined();
            if (method !== "deleteObject") return;
            pending.resolve(signal!);
            await new Promise<void>((_resolve, reject) => {
              signal!.addEventListener(
                "abort",
                () => reject(new PublishingMediaStoreError("aborted")),
                { once: true },
              );
            });
          };
          const job = h.port.enqueue(
            kind,
            kind === "purge_item"
              ? ITEM(4)
              : PUBLISHING_STORE_RECONCILE_SUBJECT,
          );
          await h.timers.advance(0);
          const signal = await pending.promise;
          expect(signal.aborted).toBe(false);
          if (reason === "shutdown") {
            const stopped = h.worker.stop();
            await h.timers.advance(10_000);
            await stopped;
            expect(h.port.releaseJob).toHaveBeenCalledTimes(1);
            expect(job.state).toBe("queued");
            expect(job.attempts).toBe(0);
          } else {
            job.leaseOwner = "other-worker";
            await h.timers.advance(20_000);
            expect(h.port.releaseJob).not.toHaveBeenCalled();
            expect(job.state).toBe("running");
            expect(job.leaseOwner).toBe("other-worker");
          }
          expect(signal.aborted).toBe(true);
          expect(signal.reason).toMatchObject({ reason });
          expect(
            f.calls.filter((call) => call.method === "deleteObject"),
          ).toHaveLength(1);
          expect(f.objects.size).toBe(2);
          expect(h.port.confirmed).toEqual([]);
          expect(outcomesFor(h, job)).toEqual([]);
          expect(h.worker.activeJobs).toBe(0);
          await h.worker.stop();
          expect(h.timers.pending).toBe(0);
        },
      );
    },
  );

  it("propagates purge cancellation and confirms only the already removed blob", async () => {
    const { h, f, handlers, claim, controller } = maintenance();
    const reason = new Error("synthetic shutdown during purge");
    h.port.purgePlans.set(ITEM(4), {
      status: "tombstoned",
      blobs: [1, 2].map((seed) => ({
        blobId: `media-blob-${hex(seed)}`,
        storageKey: blobKey(seed),
      })),
    });
    f.state.before = async (_method, _input, signal) => {
      expect(signal).toBe(controller.signal);
    };
    f.state.after = (method) => {
      if (method === "deleteObject") controller.abort(reason);
    };
    await expect(
      handlers.run(
        { ...claim, kind: "purge_item", subjectId: ITEM(4) },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(f.calls.map((call) => call.method)).toEqual([
      "getBucketVersioning",
      "deleteObject",
    ]);
    expect(h.port.confirmed).toEqual([[`media-blob-${hex(1)}`]]);
    expect(f.objects.has(cosOptions.prefix + blobKey(2))).toBe(true);
  });
});

describe("publishing media configuration", () => {
  const complete = {
    WORK_MEDIA_STORE_DIR: "/Users/synthetic/publishing/store",
    WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v1",
    WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
  };

  it("is disabled without any publishing media key", () => {
    expect(parsePublishingMediaConfig({})).toBeNull();
    // Without media the concurrency key is not read, so it cannot fail startup.
    expect(
      parsePublishingMediaConfig({ WORK_MEDIA_WORKER_CONCURRENCY: "0" }),
    ).toBeNull();
    expect(
      parsePublishingMediaConfig({
        WORK_MEDIA_STORE_DIR: "",
        WORK_MEDIA_TOOLS_IMAGE: "",
        WORK_MEDIA_WORK_DIR: "",
      }),
    ).toBeNull();
  });

  it("parses a complete configuration with the default concurrency", () => {
    expect(parsePublishingMediaConfig(complete)).toEqual({
      storeDirectory: complete.WORK_MEDIA_STORE_DIR,
      toolsImage: complete.WORK_MEDIA_TOOLS_IMAGE,
      workDirectory: complete.WORK_MEDIA_WORK_DIR,
      workerConcurrency: PUBLISHING_WORKER_CONCURRENCY_DEFAULT,
    });
    expect(
      parsePublishingMediaConfig({
        ...complete,
        WORK_MEDIA_WORKER_CONCURRENCY: "4",
        WORK_MEDIA_TOOLS_IMAGE: `local/tools@sha256:${"e".repeat(64)}`,
      }),
    ).toMatchObject({ workerConcurrency: 4 });
  });

  it.each([
    [
      { WORK_MEDIA_STORE_DIR: complete.WORK_MEDIA_STORE_DIR },
      /configured together/,
    ],
    [{ ...complete, WORK_MEDIA_WORK_DIR: undefined }, /configured together/],
    [
      { ...complete, WORK_MEDIA_STORE_DIR: "relative/store" },
      /^WORK_MEDIA_STORE_DIR must be an absolute/,
    ],
    [
      { ...complete, WORK_MEDIA_STORE_DIR: "/Users/synthetic/../store" },
      /^WORK_MEDIA_STORE_DIR must be an absolute/,
    ],
    [
      { ...complete, WORK_MEDIA_WORK_DIR: "/Users/synthetic/work/" },
      /^WORK_MEDIA_WORK_DIR must be an absolute/,
    ],
    [
      { ...complete, WORK_MEDIA_WORK_DIR: "/Users/synthetic/a,b" },
      /^WORK_MEDIA_WORK_DIR must be an absolute/,
    ],
    [
      { ...complete, WORK_MEDIA_STORE_DIR: "/tmp/publishing-store" },
      /^WORK_MEDIA_STORE_DIR must not be under temporary/,
    ],
    [
      { ...complete, WORK_MEDIA_WORK_DIR: "/private/var/folders/x/work" },
      /^WORK_MEDIA_WORK_DIR must not be under temporary/,
    ],
    [
      {
        ...complete,
        WORK_MEDIA_WORK_DIR: `${complete.WORK_MEDIA_STORE_DIR}/work`,
      },
      /must be separate directories/,
    ],
    [
      {
        ...complete,
        WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools",
      },
      /^WORK_MEDIA_TOOLS_IMAGE must be a local image reference/,
    ],
    [
      { ...complete, WORK_MEDIA_TOOLS_IMAGE: "Registry.example/Tools:v1" },
      /^WORK_MEDIA_TOOLS_IMAGE must be a local image reference/,
    ],
    [
      { ...complete, WORK_MEDIA_TOOLS_IMAGE: "tools:v1 --privileged" },
      /^WORK_MEDIA_TOOLS_IMAGE must be a local image reference/,
    ],
    [
      { ...complete, WORK_MEDIA_WORKER_CONCURRENCY: "0" },
      /^WORK_MEDIA_WORKER_CONCURRENCY must be an integer from 1 to 4$/,
    ],
    [
      { ...complete, WORK_MEDIA_WORKER_CONCURRENCY: "5" },
      /^WORK_MEDIA_WORKER_CONCURRENCY must be an integer from 1 to 4$/,
    ],
    [
      { ...complete, WORK_MEDIA_WORKER_CONCURRENCY: "2.5" },
      /^WORK_MEDIA_WORKER_CONCURRENCY must be an integer from 1 to 4$/,
    ],
  ] as const)("rejects %o without echoing values", (environment, message) => {
    let thrown: unknown;
    try {
      parsePublishingMediaConfig(environment);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const text = (thrown as Error).message;
    expect(text).toMatch(message);
    expect(text).not.toMatch(/synthetic|relative|tools:v1|privileged|\/tmp/);
  });

  describe("opening the private directories", () => {
    let base: string;
    const privateDirectory = async (name: string) => {
      const directory = path.join(base, name);
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
      return directory;
    };

    beforeEach(async () => {
      base = await realpath(
        await mkdtemp(path.join(tmpdir(), "publishing-config-")),
      );
    });

    afterEach(async () => {
      await rm(base, { recursive: true, force: true });
    });

    it("opens the store, sandbox runner and processor without any Docker call", async () => {
      const config = {
        storeDirectory: await privateDirectory("store"),
        workDirectory: await privateDirectory("work"),
        toolsImage: "yoyi-work-publishing-media-tools:v1",
        workerConcurrency: 1,
      };
      const media = await openPublishingMedia(config, {
        temporaryRoots: [],
        foreignDirectories: [undefined, path.join(base, "payload-media")],
      });
      expect(media.store).toBeInstanceOf(FilesystemPublishingMediaStore);
      expect(typeof media.processor.process).toBe("function");
      expect(typeof media.sandbox.sweepJobs).toBe("function");
      await expect(media.store.listBlobs({ limit: 10 })).resolves.toEqual({
        entries: [],
        nextAfter: null,
      });
    });

    it("refuses missing, shared or foreign-namespace directories with content-free messages", async () => {
      const store = await privateDirectory("store");
      const work = await privateDirectory("work");
      const toolsImage = "yoyi-work-publishing-media-tools:v1";
      const open = (
        storeDirectory: string,
        workDirectory: string,
        foreignDirectories: string[] = [],
      ) =>
        openPublishingMedia(
          { storeDirectory, workDirectory, toolsImage, workerConcurrency: 1 },
          { temporaryRoots: [], foreignDirectories },
        );
      await expect(open(path.join(base, "missing"), work)).rejects.toThrow(
        /^WORK_MEDIA_STORE_DIR is invalid: Publishing media directory must exist$/,
      );
      await chmod(work, 0o755);
      await expect(open(store, work)).rejects.toThrow(
        /^WORK_MEDIA_WORK_DIR is invalid: .*owner-only permissions$/,
      );
      await chmod(work, 0o700);
      await expect(open(store, work, [base])).rejects.toThrow(
        /^Publishing media directories must be separate from other media namespaces$/,
      );
      const nested = await privateDirectory("store/nested");
      await expect(open(store, nested)).rejects.toThrow(
        /must be separate directories$/,
      );
    });
  });
});
