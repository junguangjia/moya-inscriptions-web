import {
  MEDIA_WORKER_JOB_KINDS,
  PROFILE_RENDER_JOB_KINDS,
  UPLOAD_COUPLED_JOB_KINDS,
  createPublishingJobHandlers,
} from "@moya/backend-production/internal/publishing-job-handlers";
import { PublishingWorker } from "@moya/backend-production/internal/publishing-worker";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import {
  PUBLICATION_PUBLISH_JOB_KINDS,
  PUBLICATION_WITHDRAW_JOB_KINDS,
} from "@moya/backend-production/internal/media-publication-worker";
import { profileAnchorIdentities } from "@moya/backend-production/internal/publishing-profile";
import { describe, expect, it, vi } from "vitest";

import type {
  CatalogRenderResult,
  CatalogWorkerRenderPlan,
} from "@moya/backend-production/internal/publishing-catalog";
import type {
  ProfileRenderResult,
  ProfileWorkerRenderPlan,
} from "@moya/backend-production/internal/publishing-profile";
import type {
  PublishingJobHandlerOptions,
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
  PublishingWorkerPort,
  PublishingWorkerTimers,
} from "@moya/backend-production/internal/publishing-job-handlers";

/*
 * The process split of the publishing queue (W1-W3, P1-6): the Backend keeps
 * the two kinds coupled to its own uploads with the maintenance that
 * schedules them; the media worker claims every other kind, including
 * `catalog_render`; profile renders keep a list of their own, claimed only
 * behind their switch; a handler set without a processor, Catalog or profile
 * rendering fails those claims retryably.
 */

const START = Date.parse("2026-10-04T12:00:00.000Z");
const hex = (seed: number) => seed.toString(16).padStart(32, "0");
const ASSET = `catalog-asset-${hex(9)}`;
const USER_MEDIA = `user-media-${hex(7)}`;

const flush = async (rounds = 25) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

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

const silent = { info: () => undefined, error: () => undefined };

/** A queue port whose claims hand out the given jobs once. */
const queuePort = (jobs: PublishingWorkerJobClaim[] = []) => {
  const pending = [...jobs];
  return {
    claimJobs: vi.fn(
      async (options: {
        readonly kinds?: readonly PublishingWorkerJobKind[];
        readonly limit: number;
      }) => {
        const claimable = pending.filter(
          (job) => !options.kinds || options.kinds.includes(job.kind),
        );
        const claimed = claimable.slice(0, options.limit);
        for (const job of claimed) pending.splice(pending.indexOf(job), 1);
        return claimed;
      },
    ),
    renewJobLease: vi.fn(async () => true),
    completeJob: vi.fn(async () => true),
    releaseJob: vi.fn(async () => true),
    failJob: vi.fn(async () => "retry_scheduled" as const),
    requeueExpiredJobs: vi.fn(async () => 0),
    scheduleCleanup: vi.fn(async () => ({
      expireSession: 0,
      purgeTrashedWork: 0,
      purgeItem: 0,
      purgeBlob: 0,
    })),
    enqueueJob: vi.fn(
      async (job: { readonly kind: string; readonly subjectId: string }) => ({
        id: `publishing-job-${hex(job.kind.length)}`,
        created: true,
      }),
    ),
    unrecordedStorageKeys: vi.fn(async (keys: readonly string[]) => keys),
  };
};

const claim = (
  kind: PublishingWorkerJobKind,
  subjectId: string,
): PublishingWorkerJobClaim => ({
  id: `publishing-job-${hex(Math.floor(Math.random() * 1e9))}`,
  kind,
  subjectId,
  payload: null,
  attempts: 1,
  maxAttempts: 5,
  leaseOwner: "worker.1",
  leaseExpiresAt: new Date(START + 300_000),
});

describe("publishing queue split between the Backend and the media worker", () => {
  it("partitions every job kind exactly once", () => {
    const all = publishingJobKindSchema.options;
    const split = [
      ...UPLOAD_COUPLED_JOB_KINDS,
      ...MEDIA_WORKER_JOB_KINDS,
      ...PROFILE_RENDER_JOB_KINDS,
      ...PUBLICATION_PUBLISH_JOB_KINDS,
      ...PUBLICATION_WITHDRAW_JOB_KINDS,
    ];
    expect(new Set(split).size).toBe(split.length);
    expect([...split].sort()).toEqual([...all].sort());
    expect(UPLOAD_COUPLED_JOB_KINDS).toEqual([
      "expire_session",
      "sweep_staging",
    ]);
    expect(MEDIA_WORKER_JOB_KINDS).toContain("catalog_render");
    expect(PROFILE_RENDER_JOB_KINDS).toEqual(["profile_render"]);
    expect(MEDIA_WORKER_JOB_KINDS).not.toContain("profile_render");
  });

  it("runs only the selected maintenance steps and extra steps on their cadence", async () => {
    const timers = new ManualTimers();
    const port = queuePort();
    const sync = vi.fn(async () => undefined);
    const worker = new PublishingWorker({
      port: port as unknown as PublishingWorkerPort,
      handlers: { run: vi.fn() },
      kinds: UPLOAD_COUPLED_JOB_KINDS,
      maintenance: { requeue: true, cleanup: true, sweep: true },
      extraMaintenance: [
        { label: "catalog sync", intervalMs: 300_000, run: sync },
      ],
      timers,
      clock: timers.clock,
      logger: silent,
    });
    worker.start();
    await timers.advance(0);
    expect(port.requeueExpiredJobs).toHaveBeenCalledTimes(1);
    expect(port.scheduleCleanup).toHaveBeenCalledTimes(1);
    expect(port.enqueueJob.mock.calls.map(([job]) => job)).toEqual([
      { kind: "sweep_staging", subjectId: "staging" },
    ]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(port.claimJobs.mock.calls[0]![0]).toMatchObject({
      kinds: ["expire_session", "sweep_staging"],
    });
    await timers.advance(299_000);
    expect(sync).toHaveBeenCalledTimes(1);
    await timers.advance(1_000);
    expect(sync).toHaveBeenCalledTimes(2);
    await worker.stop();
    expect(
      () =>
        new PublishingWorker({
          port: port as unknown as PublishingWorkerPort,
          handlers: { run: vi.fn() },
          extraMaintenance: [
            { label: "Bad Label!", intervalMs: 1000, run: sync },
          ],
        }),
    ).toThrow("label");
  });

  // catalog-scale-v1 W4: the Catalog sync of a large Catalog runs detached
  // from the tick, so it never holds job claims.
  it("claims jobs while a detached step runs, never runs it twice at once, and logs one line when it fails", async () => {
    const timers = new ManualTimers();
    const port = queuePort();
    const runs: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const sync = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          runs.push({ resolve, reject });
        }),
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = new PublishingWorker({
      port: port as unknown as PublishingWorkerPort,
      handlers: { run: vi.fn() },
      kinds: UPLOAD_COUPLED_JOB_KINDS,
      maintenance: false,
      extraMaintenance: [
        {
          label: "catalog sync",
          intervalMs: 300_000,
          run: sync,
          detached: true,
        },
      ],
      timers,
      clock: timers.clock,
      logger,
    });
    worker.start();
    await timers.advance(0);
    // The first tick started the sync and claimed without waiting for it.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(port.claimJobs).toHaveBeenCalledTimes(1);
    await timers.advance(1_000);
    expect(port.claimJobs).toHaveBeenCalledTimes(2);
    // Due again while it still runs: not started a second time.
    await timers.advance(299_000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(port.claimJobs).toHaveBeenCalledTimes(301);
    runs[0]!.resolve();
    await timers.advance(300_000);
    expect(sync).toHaveBeenCalledTimes(2);
    // A failure logs one content-free line, and claims keep the poll
    // interval: the queue's health and backoff are not the sync's.
    const claims = port.claimJobs.mock.calls.length;
    runs[1]!.reject(new Error("synthetic sync failure"));
    await timers.advance(5_000);
    expect(logger.error.mock.calls).toEqual([
      ["[publishing-worker] catalog sync failed"],
    ]);
    expect(port.claimJobs.mock.calls.length).toBe(claims + 5);
    await timers.advance(300_000);
    expect(sync).toHaveBeenCalledTimes(3);
    runs[2]!.resolve();
    await worker.stop();
  });

  it("stops only after a running detached step ends, within the shutdown grace", async () => {
    for (const ends of [true, false]) {
      const timers = new ManualTimers();
      const port = queuePort();
      let finish: (() => void) | undefined;
      const sync = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const worker = new PublishingWorker({
        port: port as unknown as PublishingWorkerPort,
        handlers: { run: vi.fn() },
        maintenance: false,
        extraMaintenance: [
          {
            label: "catalog sync",
            intervalMs: 300_000,
            run: sync,
            detached: true,
          },
        ],
        shutdownGraceMs: 30_000,
        timers,
        clock: timers.clock,
        logger: silent,
      });
      worker.start();
      await timers.advance(0);
      expect(sync).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await timers.advance(10_000);
      // The caller closes its pools after stop(): never under the sync.
      expect(stopped).toBe(false);
      if (ends) finish!();
      await timers.advance(ends ? 0 : 20_000);
      expect(stopped).toBe(true);
      await stopping;
      expect(port.claimJobs).toHaveBeenCalledTimes(1);
    }
  });

  it("fails processing claims retryably when the handlers have no processor", async () => {
    const handlers = createPublishingJobHandlers({
      port: {} as PublishingWorkerPort,
      store: {} as PublishingJobHandlerOptions["store"],
      logger: silent,
    });
    const signal = new AbortController().signal;
    for (const kind of ["process_item", "derive_edit"] as const) {
      const job = claim(kind, `media-item-${hex(1)}`);
      expect(
        await handlers.run(
          kind === "derive_edit"
            ? {
                ...job,
                payload: {
                  editKey: "base",
                  edit: { rotation: 0, crop: null },
                  coverCrop: null,
                  variants: ["display"],
                },
              }
            : job,
          signal,
        ),
      ).toEqual({
        status: "failed",
        errorCode: "processing_unavailable",
        retryable: true,
      });
    }
    expect(await handlers.run(claim("catalog_render", ASSET), signal)).toEqual({
      status: "failed",
      errorCode: "catalog_unavailable",
      retryable: true,
    });
    expect(
      await handlers.run(claim("profile_render", USER_MEDIA), signal),
    ).toEqual({
      status: "failed",
      errorCode: "profile_unavailable",
      retryable: true,
    });
  });
});

describe("catalog_render job handler", () => {
  const plan: CatalogWorkerRenderPlan = {
    assetId: ASSET,
    mediaId: "media-catalog-1",
    sourceObjectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.jpg`,
    sourceSha256: "c".repeat(64),
    sourceContentType: "image/jpeg",
    sourceWidth: 640,
    sourceHeight: 480,
    state: "pending",
    referenced: true,
    ready: [],
  };
  const rendered: CatalogRenderResult = {
    status: "rendered",
    outcome: {
      masterSha256: "c".repeat(64),
      masterWidth: 640,
      masterHeight: 480,
      placeholderColor: "#336699",
      renditions: ["thumb", "cover", "display"].map((role, index) => ({
        storageKey: `blobs/aa/bb/aabb${hex(index).slice(4)}`,
        byteSize: 10,
        sha256: "d".repeat(64),
        role: role as "thumb",
        recipeVersion: 1,
        recipeDigest: "0".repeat(16),
        contentType: "image/webp" as const,
        width: 64,
        height: 48,
      })),
    },
  };
  const setup = (
    result: CatalogRenderResult | Error,
    found: CatalogWorkerRenderPlan | null = plan,
  ) => {
    const catalogPort = {
      readCatalogRenderPlan: vi.fn(async () => found),
      recordCatalogRenditions: vi.fn(async () => ({
        status: "recorded" as const,
      })),
      failCatalogAsset: vi.fn(async () => undefined),
    };
    const renderer = {
      render: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    const store = { remove: vi.fn(async () => undefined) };
    const port = queuePort();
    const handlers = createPublishingJobHandlers({
      port: port as unknown as PublishingWorkerPort,
      store: store as unknown as PublishingJobHandlerOptions["store"],
      catalog: { port: catalogPort, renderer },
      clock: () => new Date(START),
      logger: silent,
    });
    return { handlers, catalogPort, renderer, store, port };
  };
  const signal = new AbortController().signal;

  it("renders, records the renditions and facts, and completes", async () => {
    const { handlers, catalogPort, renderer } = setup(rendered);
    expect(await handlers.run(claim("catalog_render", ASSET), signal)).toEqual({
      status: "completed",
    });
    expect(renderer.render).toHaveBeenCalledWith(plan, signal);
    expect(catalogPort.recordCatalogRenditions).toHaveBeenCalledWith(
      ASSET,
      rendered.status === "rendered" ? rendered.outcome : null,
      new Date(START),
    );
  });

  it("fails a pending asset, not the job, on a content rejection", async () => {
    const { handlers, catalogPort } = setup({
      status: "rejected",
      failureCode: "decode_failed",
    });
    expect(await handlers.run(claim("catalog_render", ASSET), signal)).toEqual({
      status: "completed",
    });
    expect(catalogPort.failCatalogAsset).toHaveBeenCalledWith(
      ASSET,
      "decode_failed",
      new Date(START),
    );
    expect(catalogPort.recordCatalogRenditions).not.toHaveBeenCalled();
  });

  it("fails the job, never a ready asset, when its re-render is rejected", async () => {
    // A ready asset re-rendered for a new recipe or a lost rendition keeps
    // its state and its ready renditions; the rejection is recorded as the
    // job's own final failure (content-free code), which the Catalog sync
    // queues again a day later instead of enqueueing on every pass.
    const ready: CatalogWorkerRenderPlan = {
      ...plan,
      state: "ready",
      ready: (["thumb", "cover", "display"] as const).map((role) => ({
        role,
        version: 1,
        digest: "0".repeat(16),
        width: 64,
        height: 48,
      })),
    };
    for (const failureCode of ["decode_failed", "source_hash_mismatch"]) {
      const { handlers, catalogPort } = setup(
        { status: "rejected", failureCode },
        ready,
      );
      expect(
        await handlers.run(claim("catalog_render", ASSET), signal),
      ).toEqual({ status: "failed", errorCode: failureCode, retryable: false });
      expect(catalogPort.failCatalogAsset).not.toHaveBeenCalled();
      expect(catalogPort.recordCatalogRenditions).not.toHaveBeenCalled();
    }
    const unreadable: CatalogRenderResult = {
      status: "rejected",
      failureCode: "source_unreadable",
    };
    const early = setup(unreadable, ready);
    expect(
      await early.handlers.run(claim("catalog_render", ASSET), signal),
    ).toEqual({
      status: "failed",
      errorCode: "source_unreadable",
      retryable: true,
    });
    const last = setup(unreadable, ready);
    expect(
      await last.handlers.run(
        { ...claim("catalog_render", ASSET), attempts: 5 },
        signal,
      ),
    ).toEqual({
      status: "failed",
      errorCode: "source_unreadable",
      retryable: false,
    });
    expect(last.catalogPort.failCatalogAsset).not.toHaveBeenCalled();
  });

  it("records a ready asset's rejected re-render as a final job failure through the worker", async () => {
    const timers = new ManualTimers();
    const job = claim("catalog_render", ASSET);
    const port = queuePort([job]);
    port.failJob.mockResolvedValue("failed" as never);
    const { handlers } = setup(
      { status: "rejected", failureCode: "decode_failed" },
      { ...plan, state: "ready" },
    );
    const worker = new PublishingWorker({
      port: port as unknown as PublishingWorkerPort,
      handlers,
      kinds: ["catalog_render"],
      maintenance: false,
      timers,
      clock: timers.clock,
      logger: silent,
    });
    worker.start();
    await timers.advance(0);
    await worker.stop();
    expect(port.failJob).toHaveBeenCalledWith(
      { id: job.id, leaseOwner: job.leaseOwner },
      "decode_failed",
      new Date(START),
      { retryable: false },
    );
    expect(port.completeJob).not.toHaveBeenCalled();
  });

  it("retries an unreadable source while attempts remain, then fails the asset", async () => {
    const unreadable: CatalogRenderResult = {
      status: "rejected",
      failureCode: "source_unreadable",
    };
    const early = setup(unreadable);
    expect(
      await early.handlers.run(claim("catalog_render", ASSET), signal),
    ).toEqual({
      status: "failed",
      errorCode: "source_unreadable",
      retryable: true,
    });
    expect(early.catalogPort.failCatalogAsset).not.toHaveBeenCalled();
    const last = setup(unreadable);
    expect(
      await last.handlers.run(
        { ...claim("catalog_render", ASSET), attempts: 5 },
        signal,
      ),
    ).toEqual({ status: "completed" });
    expect(last.catalogPort.failCatalogAsset).toHaveBeenCalledWith(
      ASSET,
      "source_unreadable",
      new Date(START),
    );
  });

  it("does no work for an unknown, failed or unreferenced asset or a malformed subject", async () => {
    for (const found of [null, { ...plan, referenced: false }]) {
      const { handlers, renderer } = setup(rendered, found);
      expect(
        await handlers.run(claim("catalog_render", ASSET), signal),
      ).toEqual({ status: "completed" });
      expect(renderer.render).not.toHaveBeenCalled();
    }
    const { handlers, catalogPort } = setup(rendered);
    expect(
      await handlers.run(claim("catalog_render", "media-catalog-1"), signal),
    ).toEqual({
      status: "failed",
      errorCode: "invalid_job_subject",
      retryable: false,
    });
    expect(catalogPort.readCatalogRenderPlan).not.toHaveBeenCalled();
  });

  it("removes produced blobs when the job was aborted before recording", async () => {
    const controller = new AbortController();
    const { handlers, store, catalogPort, renderer } = setup(rendered);
    renderer.render.mockImplementationOnce(async () => {
      controller.abort(new Error("lease lost"));
      return rendered;
    });
    await expect(
      handlers.run(claim("catalog_render", ASSET), controller.signal),
    ).rejects.toThrow("lease lost");
    expect(store.remove).toHaveBeenCalledTimes(3);
    expect(catalogPort.recordCatalogRenditions).not.toHaveBeenCalled();
  });

  it("lets infrastructure failures reach the worker for a retry", async () => {
    const { handlers } = setup(
      Object.assign(new Error("Publishing media processing unavailable"), {
        name: "MediaProcessingUnavailableError",
      }),
    );
    await expect(
      handlers.run(claim("catalog_render", ASSET), signal),
    ).rejects.toMatchObject({ name: "MediaProcessingUnavailableError" });
  });
});

describe("profile_render job handler", () => {
  const source = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const plan: ProfileWorkerRenderPlan = {
    userMediaId: USER_MEDIA,
    sha256: "c".repeat(64),
    width: 512,
    height: 512,
    byteSize: source.byteLength,
    families: ["avatar"],
  };
  const rendered: ProfileRenderResult = {
    status: "rendered",
    outcome: {
      sourceSha256: "c".repeat(64),
      renditions: (["avatar-128", "avatar-512"] as const).map(
        (role, index) => ({
          storageKey: `blobs/aa/bb/aabb${hex(index).slice(4)}`,
          byteSize: 10,
          sha256: "d".repeat(64),
          role,
          recipeVersion: 1,
          recipeDigest: "0".repeat(16),
          contentType: "image/webp" as const,
          width: index === 0 ? 128 : 512,
          height: index === 0 ? 128 : 512,
        }),
      ),
    },
  };
  const setup = (
    result: ProfileRenderResult | Error,
    found: ProfileWorkerRenderPlan | null = plan,
    bytes: Uint8Array | null = source,
  ) => {
    const profilePort = {
      readProfileRenderPlan: vi.fn(async () => found),
      readProfileMediaBytes: vi.fn(async () => bytes),
      recordProfileRenditions: vi.fn(
        async (): Promise<
          | { readonly status: "recorded" }
          | { readonly status: "discarded"; readonly storageKeys: string[] }
        > => ({ status: "recorded" }),
      ),
    };
    const renderer = {
      render: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    const store = { remove: vi.fn(async () => undefined) };
    const port = queuePort();
    const handlers = createPublishingJobHandlers({
      port: port as unknown as PublishingWorkerPort,
      store: store as unknown as PublishingJobHandlerOptions["store"],
      profile: { port: profilePort, renderer },
      clock: () => new Date(START),
      logger: silent,
    });
    return { handlers, profilePort, renderer, store, port };
  };
  const signal = new AbortController().signal;

  it("plans with the current anchors, renders the stored PNG, records the family and completes", async () => {
    const { handlers, profilePort, renderer } = setup(rendered);
    expect(
      await handlers.run(claim("profile_render", USER_MEDIA), signal),
    ).toEqual({ status: "completed" });
    expect(profilePort.readProfileRenderPlan).toHaveBeenCalledWith(
      USER_MEDIA,
      profileAnchorIdentities(),
    );
    expect(profilePort.readProfileMediaBytes).toHaveBeenCalledWith(USER_MEDIA);
    expect(renderer.render).toHaveBeenCalledWith(plan, source, signal);
    expect(profilePort.recordProfileRenditions).toHaveBeenCalledWith(
      USER_MEDIA,
      rendered.status === "rendered" ? rendered.outcome : null,
      new Date(START),
    );
  });

  it("does no work for an unknown, erased or current image or a malformed subject", async () => {
    for (const found of [null, { ...plan, families: [] }]) {
      const { handlers, profilePort, renderer } = setup(rendered, found);
      expect(
        await handlers.run(claim("profile_render", USER_MEDIA), signal),
      ).toEqual({ status: "completed" });
      expect(profilePort.readProfileMediaBytes).not.toHaveBeenCalled();
      expect(renderer.render).not.toHaveBeenCalled();
    }
    // Erased between the plan and the byte read.
    const erased = setup(rendered, plan, null);
    expect(
      await erased.handlers.run(claim("profile_render", USER_MEDIA), signal),
    ).toEqual({ status: "completed" });
    expect(erased.renderer.render).not.toHaveBeenCalled();
    expect(erased.profilePort.recordProfileRenditions).not.toHaveBeenCalled();
    const { handlers, profilePort } = setup(rendered);
    for (const subject of [ASSET, `user-media-${"G".repeat(32)}`])
      expect(
        await handlers.run(claim("profile_render", subject), signal),
      ).toEqual({
        status: "failed",
        errorCode: "invalid_job_subject",
        retryable: false,
      });
    expect(profilePort.readProfileRenderPlan).not.toHaveBeenCalled();
  });

  it("fails the job with the content-free code of a rejected source, recording nothing", async () => {
    for (const failureCode of [
      "size_mismatch",
      "unsupported_type",
      "source_mismatch",
      "decode_failed",
      "processing_failed",
    ]) {
      const { handlers, profilePort } = setup({
        status: "rejected",
        failureCode,
      });
      expect(
        await handlers.run(claim("profile_render", USER_MEDIA), signal),
      ).toEqual({ status: "failed", errorCode: failureCode, retryable: false });
      expect(profilePort.recordProfileRenditions).not.toHaveBeenCalled();
    }
  });

  it("removes discarded duplicates of a replay and lets infrastructure failures reach the worker", async () => {
    const replay = setup(rendered);
    replay.profilePort.recordProfileRenditions.mockResolvedValueOnce({
      status: "discarded",
      storageKeys: ["blobs/aa/bb/aabb0000000000000000000000000000"],
    });
    expect(
      await replay.handlers.run(claim("profile_render", USER_MEDIA), signal),
    ).toEqual({ status: "completed" });
    expect(replay.store.remove).toHaveBeenCalledWith(
      "blobs/aa/bb/aabb0000000000000000000000000000",
    );
    const { handlers } = setup(
      Object.assign(new Error("Publishing media processing unavailable"), {
        name: "MediaProcessingUnavailableError",
      }),
    );
    await expect(
      handlers.run(claim("profile_render", USER_MEDIA), signal),
    ).rejects.toMatchObject({ name: "MediaProcessingUnavailableError" });
  });

  it("removes produced blobs when the job was aborted before recording", async () => {
    const controller = new AbortController();
    const { handlers, store, profilePort, renderer } = setup(rendered);
    renderer.render.mockImplementationOnce(async () => {
      controller.abort(new Error("lease lost"));
      return rendered;
    });
    await expect(
      handlers.run(claim("profile_render", USER_MEDIA), controller.signal),
    ).rejects.toThrow("lease lost");
    expect(store.remove).toHaveBeenCalledTimes(2);
    expect(profilePort.recordProfileRenditions).not.toHaveBeenCalled();
  });

  it("records a rejected render as a final job failure through the worker", async () => {
    const timers = new ManualTimers();
    const job = claim("profile_render", USER_MEDIA);
    const port = queuePort([job]);
    port.failJob.mockResolvedValue("failed" as never);
    const { handlers } = setup({
      status: "rejected",
      failureCode: "source_mismatch",
    });
    const worker = new PublishingWorker({
      port: port as unknown as PublishingWorkerPort,
      handlers,
      kinds: [...MEDIA_WORKER_JOB_KINDS, ...PROFILE_RENDER_JOB_KINDS],
      maintenance: false,
      timers,
      clock: timers.clock,
      logger: silent,
    });
    worker.start();
    await timers.advance(0);
    await worker.stop();
    expect(port.claimJobs.mock.calls[0]![0].kinds).toContain("profile_render");
    expect(port.failJob).toHaveBeenCalledWith(
      { id: job.id, leaseOwner: job.leaseOwner },
      "source_mismatch",
      new Date(START),
      { retryable: false },
    );
    expect(port.completeJob).not.toHaveBeenCalled();
  });
});
