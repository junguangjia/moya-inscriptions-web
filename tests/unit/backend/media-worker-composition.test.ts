import {
  openProductionPublishingMedia,
  openPublishingMedia,
} from "@moya/backend-production/internal/publishing-config";
import {
  MEDIA_WORKER_EXIT_CODES,
  MediaWorkerStartupError,
  prepareMediaWorker,
  startMediaWorker,
} from "@moya/backend-production/internal/media-worker";
import { createPostgresPool } from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isolatedFacts, sandboxRuntime } from "./publishing-sandbox-fixture.js";

/*
 * Composition of the separate media worker process (W1, W2, W10, W11): it
 * fails closed with exit 78 on configuration or isolation problems and 75
 * when the sandbox cannot run, removes leftovers before claiming, claims only
 * the media worker's kinds, never schedules the Backend's staging sweep, runs
 * the Catalog sync where Catalog sources are configured, and stops before its
 * pools close. Only PostgreSQL and sandbox I/O are replaced.
 */

const database = vi.hoisted(() => ({ end: vi.fn(async () => {}) }));

vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  return {
    ...actual,
    createPostgresPool: vi.fn(() => ({
      end: database.end,
      query: vi.fn(async () => ({ rows: [] })),
    })),
  };
});

vi.mock("@moya/community-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    verifyCommunityMigrationLedger: vi.fn(async () => {}),
  };
});

const fakeMedia = vi.hoisted(() => {
  const sandbox = {
    createJob: vi.fn(),
    run: vi.fn(),
    selfCheck: vi.fn(),
    removeOrphanContainers: vi.fn(async () => ({ removed: 2 })),
    sweepJobs: vi.fn(async () => ({ removed: 1 })),
  };
  return {
    store: {
      writeStream: vi.fn(),
      openRead: vi.fn(),
      remove: vi.fn(),
      listBlobs: vi.fn(),
      sweepStaging: vi.fn(),
    },
    sandbox,
    processor: { process: vi.fn() },
  };
});

vi.mock(
  "@moya/backend-production/internal/publishing-config",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@moya/backend-production/internal/publishing-config")
      >();
    return {
      ...actual,
      openPublishingMedia: vi.fn(async () => fakeMedia),
      openProductionPublishingMedia: vi.fn(async () => fakeMedia),
    };
  },
);

const production = {
  NODE_ENV: "production",
  APP_DATABASE_URL:
    "postgresql://synthetic-community@127.0.0.1:1/synthetic_published",
  DATABASE_URL:
    "postgresql://synthetic-runtime@127.0.0.1:1/synthetic_published",
  WORK_MEDIA_COS_BUCKET: "synthetic-publishing-1250000000",
  WORK_MEDIA_COS_REGION: "ap-guangzhou",
  WORK_MEDIA_COS_PREFIX: "ugc/publishing/synthetic/",
  WORK_MEDIA_COS_SECRET_ID: "synthetic-publishing-id",
  WORK_MEDIA_COS_SECRET_KEY: "synthetic-publishing-secret",
  WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v2",
  WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
  COS_BUCKET: "synthetic-example-1250000000",
  COS_REGION: "ap-guangzhou",
  COS_SECRET_ID: "synthetic-unit-id",
  COS_SECRET_KEY: "synthetic-unit-secret",
} as const;

const development = {
  NODE_ENV: "development",
  APP_DATABASE_URL: "postgresql://synthetic-app@127.0.0.1:54330/yoyi_dev",
  DATABASE_URL: "postgresql://synthetic-public@127.0.0.1:54330/yoyi_dev",
  WORK_MEDIA_STORE_DIR: "/Users/synthetic/publishing/store",
  WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v2",
  WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
  CMS_MEDIA_DIR: "/Users/synthetic/payload-media",
} as const;

const silent = { info: vi.fn(), error: vi.fn() };

const quietQueue = () => {
  const prototype = PostgresWorkPublishingAdapter.prototype;
  return {
    claim: vi.spyOn(prototype, "claimJobs").mockResolvedValue([]),
    requeue: vi.spyOn(prototype, "requeueExpiredJobs").mockResolvedValue(0),
    cleanup: vi.spyOn(prototype, "scheduleCleanup").mockResolvedValue({
      expireSession: 0,
      purgeTrashedWork: 0,
      purgeItem: 0,
      purgeBlob: 0,
    }),
    enqueue: vi.spyOn(prototype, "enqueueJob").mockResolvedValue({
      id: `publishing-job-${"0".repeat(32)}`,
      created: true,
    }),
    catalogSync: vi.spyOn(prototype, "syncCatalogAssets").mockResolvedValue({
      referenced: 0,
      skipped: 0,
      created: 0,
      unreferenced: 0,
      enqueued: 0,
    }),
  };
};

const startupFailure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaWorkerStartupError);
    return [
      (error as MediaWorkerStartupError).exitCode,
      (error as Error).message,
    ] as const;
  }
  throw new Error("expected a startup refusal");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fakeMedia.sandbox.selfCheck.mockReset();
});

describe("media worker composition", () => {
  it("refuses configuration problems with exit 78 before any sandbox or pool", async () => {
    for (const [environment, message] of [
      [{ ...production, NODE_ENV: "test" }, /NODE_ENV/],
      [
        { ...production, WORK_MEDIA_TOOLS_IMAGE: undefined },
        /WORK_MEDIA_TOOLS_IMAGE/,
      ],
      [
        { ...production, WORK_MEDIA_TOOLS_IMAGE: "latest" },
        /WORK_MEDIA_TOOLS_IMAGE/,
      ],
      [
        { ...production, WORK_MEDIA_WORK_DIR: "relative" },
        /WORK_MEDIA_WORK_DIR/,
      ],
      [{ ...production, APP_DATABASE_URL: undefined }, /APP_DATABASE_URL/],
      [{ ...production, COS_SECRET_KEY: undefined }, /COS_SECRET_KEY/],
      [
        { ...production, WORK_MEDIA_STORE_DIR: "/srv/store" },
        /WORK_MEDIA_STORE_DIR/,
      ],
      [
        {
          ...development,
          WORK_MEDIA_STORE_DIR: undefined,
          WORK_MEDIA_TOOLS_IMAGE: undefined,
          WORK_MEDIA_WORK_DIR: undefined,
        },
        /required for the media worker/,
      ],
    ] as const) {
      const [code, text] = await startupFailure(() =>
        prepareMediaWorker(environment, { logger: silent }),
      );
      expect(code).toBe(MEDIA_WORKER_EXIT_CODES.config);
      expect(text).toMatch(message);
      expect(text).not.toMatch(/synthetic/);
    }
    expect(openProductionPublishingMedia).not.toHaveBeenCalled();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("exits 75 when the sandbox cannot run and 78 on an isolation mismatch, before any pool", async () => {
    fakeMedia.sandbox.selfCheck.mockResolvedValueOnce({
      status: "unavailable",
      reason: "sandbox_unavailable",
    });
    expect(
      await startupFailure(() =>
        prepareMediaWorker(production, { logger: silent }),
      ),
    ).toEqual([75, "Media sandbox unavailable: sandbox_unavailable"]);
    fakeMedia.sandbox.selfCheck.mockResolvedValueOnce({
      status: "mismatch",
      mismatches: ["networkInterfaces", "memoryMax"],
      runtime: sandboxRuntime(),
      facts: isolatedFacts({ networkInterfaces: ["eth0", "lo"] }),
    });
    expect(
      await startupFailure(() =>
        prepareMediaWorker(production, { logger: silent }),
      ),
    ).toEqual([
      78,
      "Media sandbox isolation mismatch: networkInterfaces,memoryMax",
    ]);
    expect(fakeMedia.sandbox.removeOrphanContainers).not.toHaveBeenCalled();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it.each(["production", "development"] as const)(
    "%s: cleans leftovers, claims only the media worker kinds and stops before the pools close",
    async (mode) => {
      const queue = quietQueue();
      fakeMedia.sandbox.selfCheck.mockResolvedValue({
        status: "ok",
        runtime: sandboxRuntime(),
        facts: isolatedFacts(),
      });
      const worker = await startMediaWorker(
        mode === "production" ? production : development,
        { logger: silent },
      );
      expect(
        mode === "production"
          ? openProductionPublishingMedia
          : openPublishingMedia,
      ).toHaveBeenCalledTimes(1);
      expect(fakeMedia.sandbox.removeOrphanContainers).toHaveBeenCalledTimes(1);
      expect(fakeMedia.sandbox.sweepJobs).toHaveBeenCalledTimes(1);
      expect(verifyCommunityMigrationLedger).toHaveBeenCalledTimes(1);
      // Community App role and read-only Catalog connection.
      expect(createPostgresPool).toHaveBeenCalledTimes(2);
      expect(worker.catalog).toBe(true);
      await vi.waitFor(() => expect(queue.claim).toHaveBeenCalled());
      expect(queue.claim.mock.calls[0]![0]).toMatchObject({
        limit: 1,
        kinds: [
          "process_item",
          "derive_edit",
          "purge_item",
          "purge_blob",
          "purge_trashed_work",
          "reconcile_capacity",
          "catalog_render",
        ],
      });
      expect(queue.requeue).toHaveBeenCalledTimes(1);
      expect(queue.cleanup).toHaveBeenCalledTimes(1);
      // The Backend owns the staging sweep; the worker owns reconciliation.
      expect(queue.enqueue.mock.calls.map(([job]) => job.kind)).toEqual([
        "reconcile_capacity",
      ]);
      expect(queue.catalogSync).toHaveBeenCalledTimes(1);
      expect(silent.info).toHaveBeenCalledWith(
        `[media-worker] ready concurrency=1 sharp=${sandboxRuntime().sharp} vips=${sandboxRuntime().vips} catalog=on`,
      );
      expect(silent.info).toHaveBeenCalledWith(
        "[media-worker] leftovers removed containers=2 job_directories=1",
      );
      await worker.stop();
      await worker.stop();
      expect(database.end).toHaveBeenCalledTimes(2);
      const claims = queue.claim.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(queue.claim.mock.calls.length).toBe(claims);
    },
  );

  it("turns Catalog rendering off without Catalog source configuration", async () => {
    quietQueue();
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const worker = await prepareMediaWorker(
      {
        ...production,
        COS_BUCKET: undefined,
        COS_REGION: undefined,
        COS_SECRET_ID: undefined,
        COS_SECRET_KEY: undefined,
      },
      { logger: silent },
    );
    expect(worker.catalog).toBe(false);
    // The Community App role only.
    expect(createPostgresPool).toHaveBeenCalledTimes(1);
    await worker.stop();
  });
});
