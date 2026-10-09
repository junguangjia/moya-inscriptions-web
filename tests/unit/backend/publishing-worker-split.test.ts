import {
  MEDIA_WORKER_JOB_KINDS,
  UPLOAD_COUPLED_JOB_KINDS,
  createPublishingJobHandlers,
} from "@moya/backend-production/internal/publishing-job-handlers";
import { PublishingWorker } from "@moya/backend-production/internal/publishing-worker";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import {
  PUBLICATION_PUBLISH_JOB_KINDS,
  PUBLICATION_WITHDRAW_JOB_KINDS,
} from "@moya/backend-production/internal/media-publication-worker";
import { describe, expect, it, vi } from "vitest";

import type {
  CatalogRenderResult,
  CatalogWorkerRenderPlan,
} from "@moya/backend-production/internal/publishing-catalog";
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
 * `catalog_render`; a handler set without a processor fails processing claims
 * retryably.
 */

const START = Date.parse("2026-10-04T12:00:00.000Z");
const hex = (seed: number) => seed.toString(16).padStart(32, "0");
const ASSET = `catalog-asset-${hex(9)}`;

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
