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
import {
  assertCatalogPrepareReaderReady,
  assertCatalogPublicationScopeReady,
  createPostgresPool,
  PostgresStartupError,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  PostgresMediaPublicationAdapter,
  catalogMembershipStore,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isolatedFacts, sandboxRuntime } from "./publishing-sandbox-fixture.js";

/*
 * Composition of the separate media worker process (W1, W2, W10, W11): it
 * fails closed with exit 78 on configuration or isolation problems and 75
 * when the sandbox cannot run, removes leftovers before claiming, claims only
 * the media worker's kinds, never schedules the Backend's staging sweep, runs
 * the Catalog sync where Catalog sources are configured, claims
 * `profile_render` and runs the profile sweep only while
 * `MEDIA_PROFILE_RENDER` is on (default on in Development, off in
 * Production), and stops before its pools close. Only PostgreSQL and sandbox
 * I/O are replaced.
 */

const database = vi.hoisted(() => ({ end: vi.fn(async () => {}) }));

vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  return {
    ...actual,
    createPostgresPool: vi.fn(() => {
      const query = vi.fn(async (text: string) => ({
        rows: text.includes("clock_timestamp()") ? [{ at: new Date() }] : [],
      }));
      return {
        end: database.end,
        query,
        connect: async () => ({ query, release: vi.fn() }),
      };
    }),
    // catalog-scale-v1 W6: the Catalog grant checks are PostgreSQL I/O too;
    // their pools and refusals are observed below.
    assertCatalogPublicationScopeReady: vi.fn(async () => {}),
    assertCatalogPrepareReaderReady: vi.fn(async () => {}),
  };
});

// catalog-scale-v1 W8: the App side of the per-minute membership step.
const membership = vi.hoisted(() => ({
  readCatalogMembershipState: vi.fn(async () => ({
    public: null,
    private: null,
  })),
  readCatalogMembershipAppBuckets: vi.fn(async () => new Map()),
  applyCatalogMembership: vi.fn(async () => ({
    public: 0,
    private: 0,
    boundaries: 0,
  })),
}));

vi.mock("@moya/community-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    verifyCommunityMigrationLedger: vi.fn(async () => {}),
    catalogMembershipStore: vi.fn(() => membership),
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

const sourceEnvironment = {
  CATALOG_SOURCE_COS_BUCKET: "synthetic-source-1250000000",
  CATALOG_SOURCE_COS_REGION: "ap-guangzhou",
  CATALOG_SOURCE_COS_SECRET_ID: "synthetic-source-id",
  CATALOG_SOURCE_COS_SECRET_KEY: "synthetic-source-secret",
} as const;

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
  ...sourceEnvironment,
  // These are unrelated public signer settings, never source fallbacks.
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
  vi.spyOn(
    PostgresMediaPublicationAdapter.prototype,
    "hasRegisteredPublications",
  ).mockResolvedValue(false);
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
    profileSweep: vi
      .spyOn(prototype, "enqueueProfileRenders")
      .mockResolvedValue({
        missing: 0,
        blocked: 0,
        enqueued: 0,
        requeued: 0,
        paused: false,
      }),
    blockSync: vi
      .spyOn(prototype, "enqueueCatalogBlockSets")
      .mockResolvedValue({ enqueued: 0 }),
  };
};

const MEDIA_KINDS = [
  "process_item",
  "derive_edit",
  "purge_item",
  "purge_blob",
  "purge_trashed_work",
  "reconcile_capacity",
  "catalog_render",
];

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
      [
        { ...production, CATALOG_SOURCE_COS_SECRET_KEY: undefined },
        /CATALOG_SOURCE_COS_SECRET_KEY/,
      ],
      [
        { ...production, CATALOG_SOURCE_COS_BUCKET: "Invalid_Bucket" },
        /CATALOG_SOURCE_COS_BUCKET/,
      ],
      [
        { ...production, CATALOG_SOURCE_COS_REGION: "AP-Guangzhou" },
        /CATALOG_SOURCE_COS_REGION/,
      ],
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
      [
        { ...production, MEDIA_PROFILE_RENDER: "synthetic-on" },
        /^MEDIA_PROFILE_RENDER must be on or off$/,
      ],
      [
        { ...development, MEDIA_PROFILE_RENDER: "synthetic-off" },
        /^MEDIA_PROFILE_RENDER must be on or off$/,
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
    expect(openPublishingMedia).not.toHaveBeenCalled();
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
      // Profile renders default on in Development only.
      expect(worker.profile).toBe(mode === "development");
      expect(queue.claim.mock.calls[0]![0]).toMatchObject({
        limit: 1,
        kinds:
          mode === "development"
            ? [...MEDIA_KINDS, "profile_render"]
            : MEDIA_KINDS,
      });
      // Catalog blocks (catalog-deep-zoom-v1) default on in Development only.
      expect(queue.claim.mock.calls[0]![0].catalogBlocks).toBe(
        mode === "development" ? true : undefined,
      );
      expect(queue.requeue).toHaveBeenCalledTimes(1);
      expect(queue.cleanup).toHaveBeenCalledTimes(1);
      // The Backend owns the staging sweep; the worker owns reconciliation.
      expect(queue.enqueue.mock.calls.map(([job]) => job.kind)).toEqual([
        "reconcile_capacity",
      ]);
      // The Catalog sync runs detached from the tick (catalog-scale-v1 W4).
      await vi.waitFor(() =>
        expect(queue.catalogSync).toHaveBeenCalledTimes(1),
      );
      // So does the membership step (W8), on the App pool, from the
      // published pool's aggregate (no prepare reader here: no private side).
      expect(catalogMembershipStore).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(membership.applyCatalogMembership).toHaveBeenCalledTimes(1),
      );
      expect(
        (membership.applyCatalogMembership.mock.calls[0] as unknown[])[0],
      ).toMatchObject({
        public: { count: 0, sum: "0", diff: { buckets: [], members: [] } },
        private: null,
      });
      await vi.waitFor(() =>
        expect(queue.blockSync).toHaveBeenCalledTimes(
          mode === "development" ? 1 : 0,
        ),
      );
      expect(queue.profileSweep).toHaveBeenCalledTimes(
        mode === "development" ? 1 : 0,
      );
      if (mode === "development")
        expect(queue.profileSweep.mock.calls[0]![1]).toMatchObject({
          limit: 2,
          maxOpen: 2,
        });
      expect(silent.info).toHaveBeenCalledWith(
        `[media-worker] ready concurrency=1 sharp=${sandboxRuntime().sharp} vips=${sandboxRuntime().vips} catalog=on profile=${mode === "development" ? "on" : "off"} blocks=${mode === "development" ? "on" : "off"}`,
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

  // catalog-scale-v1 (Issue #323) 1B, W6: the worker checks the scoped
  // reconcile's grants on the App pool and, only with a prepare database, the
  // prepare reader's grants on that pool, after the ledger and before it
  // claims anything. Either refusal stops startup with every pool closed.
  it("checks the Catalog scope and prepare grants on their own pools at startup and refuses without them", async () => {
    const queue = quietQueue();
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const withPrepare = {
      ...production,
      CATALOG_PREPARE_DATABASE_URL:
        "postgresql://synthetic-prepare@127.0.0.1:1/synthetic_published",
    };
    const opened = (from: number) =>
      vi
        .mocked(createPostgresPool)
        .mock.calls.slice(from)
        .map(([config], index) => ({
          url: config.connectionString,
          pool: vi.mocked(createPostgresPool).mock.results[from + index]!
            .value as unknown,
        }));
    const poolOf = (from: number, url: string) =>
      opened(from).find((pool) => pool.url === url)!.pool;

    let from = vi.mocked(createPostgresPool).mock.results.length;
    const plain = await prepareMediaWorker(production, { logger: silent });
    expect(assertCatalogPublicationScopeReady).toHaveBeenCalledTimes(1);
    expect(assertCatalogPublicationScopeReady).toHaveBeenCalledWith(
      poolOf(from, production.APP_DATABASE_URL),
    );
    expect(assertCatalogPrepareReaderReady).not.toHaveBeenCalled();
    await plain.stop();

    from = vi.mocked(createPostgresPool).mock.results.length;
    const prepared = await prepareMediaWorker(withPrepare, { logger: silent });
    expect(opened(from)).toHaveLength(3);
    expect(assertCatalogPublicationScopeReady).toHaveBeenLastCalledWith(
      poolOf(from, withPrepare.APP_DATABASE_URL),
    );
    expect(assertCatalogPrepareReaderReady).toHaveBeenCalledTimes(1);
    expect(assertCatalogPrepareReaderReady).toHaveBeenCalledWith(
      poolOf(from, withPrepare.CATALOG_PREPARE_DATABASE_URL),
    );
    await prepared.stop();

    for (const check of [
      assertCatalogPublicationScopeReady,
      assertCatalogPrepareReaderReady,
    ]) {
      const refusal = new PostgresStartupError("Synthetic missing grant");
      vi.mocked(check).mockRejectedValueOnce(refusal);
      database.end.mockClear();
      from = vi.mocked(createPostgresPool).mock.results.length;
      await expect(
        startMediaWorker(withPrepare, { logger: silent }),
      ).rejects.toBe(refusal);
      expect(opened(from)).toHaveLength(3);
      expect(database.end).toHaveBeenCalledTimes(3);
    }
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it("keeps claiming while a long Catalog sync runs, and closes the pools only after it ends", async () => {
    const queue = quietQueue();
    let finish: (() => void) | undefined;
    queue.catalogSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              referenced: 0,
              skipped: 0,
              created: 0,
              unreferenced: 0,
              enqueued: 0,
            });
        }),
    );
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const worker = await startMediaWorker(production, { logger: silent });
    try {
      await vi.waitFor(() =>
        expect(queue.catalogSync).toHaveBeenCalledTimes(1),
      );
      // The sync has not returned, and the media worker (not only the
      // publication lanes on the same queue) still claims, poll after poll.
      const mediaClaims = () =>
        queue.claim.mock.calls.filter(([options]) =>
          options.kinds?.includes("catalog_render"),
        ).length;
      await vi.waitFor(() => expect(mediaClaims()).toBeGreaterThanOrEqual(2), {
        timeout: 5_000,
      });
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      expect(database.end).not.toHaveBeenCalled();
      finish!();
      await stopping;
      expect(database.end).toHaveBeenCalledTimes(2);
      expect(queue.catalogSync).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await worker.stop();
    }
  });

  it("keeps claiming while a membership step runs, and closes the pools only after it ends", async () => {
    const queue = quietQueue();
    let finish: (() => void) | undefined;
    membership.applyCatalogMembership.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ public: 0, private: 0, boundaries: 0 });
        }),
    );
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const worker = await startMediaWorker(production, { logger: silent });
    try {
      await vi.waitFor(() =>
        expect(membership.applyCatalogMembership).toHaveBeenCalledTimes(1),
      );
      const mediaClaims = () =>
        queue.claim.mock.calls.filter(([options]) =>
          options.kinds?.includes("catalog_render"),
        ).length;
      await vi.waitFor(() => expect(mediaClaims()).toBeGreaterThanOrEqual(2), {
        timeout: 5_000,
      });
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      expect(database.end).not.toHaveBeenCalled();
      finish!();
      await stopping;
      expect(database.end).toHaveBeenCalledTimes(2);
      expect(membership.applyCatalogMembership).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await worker.stop();
    }
  });

  it.each([
    ["production", "on"],
    ["development", "off"],
  ] as const)(
    "%s with MEDIA_PROFILE_RENDER=%s follows the switch",
    async (mode, value) => {
      const queue = quietQueue();
      fakeMedia.sandbox.selfCheck.mockResolvedValue({
        status: "ok",
        runtime: sandboxRuntime(),
        facts: isolatedFacts(),
      });
      const worker = await startMediaWorker(
        {
          ...(mode === "production" ? production : development),
          MEDIA_PROFILE_RENDER: value,
        },
        { logger: silent },
      );
      const on = value === "on";
      expect(worker.profile).toBe(on);
      await vi.waitFor(() => expect(queue.claim).toHaveBeenCalled());
      expect(queue.claim.mock.calls[0]![0].kinds).toEqual(
        on ? [...MEDIA_KINDS, "profile_render"] : MEDIA_KINDS,
      );
      expect(queue.profileSweep).toHaveBeenCalledTimes(on ? 1 : 0);
      expect(silent.info).toHaveBeenCalledWith(
        expect.stringMatching(
          on ? / profile=on blocks=/ : / profile=off blocks=/,
        ),
      );
      await worker.stop();
    },
  );

  it.each(["production", "development"] as const)(
    "%s refuses an incomplete source namespace before sandbox or pools, even with other identities or local media",
    async (mode) => {
      const environment = {
        ...(mode === "production" ? production : development),
        CMS_MEDIA_DIR: "/Users/synthetic/payload-media",
      };
      for (const partial of [
        { ...sourceEnvironment, CATALOG_SOURCE_COS_SECRET_KEY: undefined },
        { CATALOG_SOURCE_COS_SECURITY_TOKEN: "synthetic-orphan-session" },
        { ...sourceEnvironment, CATALOG_SOURCE_COS_REGION: "invalid" },
        { ...sourceEnvironment, CATALOG_SOURCE_COS_REQUEST_TIMEOUT_MS: "0" },
        {
          ...sourceEnvironment,
          CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT: "9999999999",
        },
        {
          ...sourceEnvironment,
          CATALOG_SOURCE_COS_SECURITY_TOKEN: "synthetic-orphan-session",
        },
        {
          ...sourceEnvironment,
          CATALOG_SOURCE_COS_SECURITY_TOKEN: "synthetic-expired-session",
          CATALOG_SOURCE_COS_CREDENTIAL_EXPIRES_AT: "1",
        },
      ]) {
        const [code, text] = await startupFailure(() =>
          prepareMediaWorker(
            { ...environment, ...partial },
            { logger: silent },
          ),
        );
        expect(code).toBe(MEDIA_WORKER_EXIT_CODES.config);
        expect(text).toMatch(/CATALOG_SOURCE_COS_/);
        expect(text).not.toMatch(/synthetic/);
      }
      expect(openProductionPublishingMedia).not.toHaveBeenCalled();
      expect(openPublishingMedia).not.toHaveBeenCalled();
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );

  it("accepts explicit COS source configuration in Development without a local directory", async () => {
    quietQueue();
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const worker = await prepareMediaWorker(
      { ...development, ...sourceEnvironment, CMS_MEDIA_DIR: undefined },
      { logger: silent },
    );
    expect(worker.catalog).toBe(true);
    expect(createPostgresPool).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  // catalog-delivery-release-hardening-v1 (N5): the COS_* → CATALOG_SOURCE_COS_*
  // rename must never turn catalog_render off silently. Setting names only.
  const withoutSource = {
    CATALOG_SOURCE_COS_BUCKET: undefined,
    CATALOG_SOURCE_COS_REGION: undefined,
    CATALOG_SOURCE_COS_SECRET_ID: undefined,
    CATALOG_SOURCE_COS_SECRET_KEY: undefined,
  } as const;
  const withoutRetiredKeys = {
    COS_BUCKET: undefined,
    COS_REGION: undefined,
    COS_SECRET_ID: undefined,
    COS_SECRET_KEY: undefined,
  } as const;
  it.each([
    [
      "only the retired COS_* source keys",
      { ...production, ...withoutSource },
      "error",
      "[media-worker] catalog=off reason=source_keys_renamed: CATALOG_SOURCE_COS_* is not set and COS_* is no longer read for Catalog sources; catalog_render jobs are not claimed",
    ],
    [
      "no Catalog source keys",
      { ...production, ...withoutSource, ...withoutRetiredKeys },
      "info",
      "[media-worker] catalog=off reason=source_unset: CATALOG_SOURCE_COS_* is not set; catalog_render jobs are not claimed",
    ],
    [
      "no published read connection",
      { ...production, DATABASE_URL: undefined },
      "info",
      "[media-worker] catalog=off reason=database_unset: DATABASE_URL is not set; catalog_render jobs are not claimed",
    ],
    [
      "neither source keys nor a local directory in Development",
      { ...development, CMS_MEDIA_DIR: undefined, DATABASE_URL: undefined },
      "info",
      "[media-worker] catalog=off reason=source_unset,database_unset: neither CATALOG_SOURCE_COS_* nor CMS_MEDIA_DIR is set; DATABASE_URL is not set; catalog_render jobs are not claimed",
    ],
  ] as const)(
    "names why Catalog rendering is off at startup with %s",
    async (_case, environment, level, line) => {
      quietQueue();
      fakeMedia.sandbox.selfCheck.mockResolvedValue({
        status: "ok",
        runtime: sandboxRuntime(),
        facts: isolatedFacts(),
      });
      const logger = { info: vi.fn(), error: vi.fn() };
      const worker = await startMediaWorker(environment, { logger });
      try {
        expect(worker.catalog).toBe(false);
        expect(logger[level]).toHaveBeenCalledWith(line);
        const other = level === "error" ? logger.info : logger.error;
        expect(
          other.mock.calls.filter(([text]) =>
            String(text).includes("catalog=off reason="),
          ),
        ).toEqual([]);
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringMatching(/^\[media-worker\] ready .* catalog=off /),
        );
        for (const [text] of [
          ...logger.info.mock.calls,
          ...logger.error.mock.calls,
        ])
          expect(String(text)).not.toMatch(/synthetic/);
      } finally {
        await worker.stop();
      }
    },
  );

  it("logs no Catalog-off reason while Catalog rendering is on", async () => {
    quietQueue();
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = await startMediaWorker(production, { logger });
    try {
      expect(worker.catalog).toBe(true);
      for (const [text] of [
        ...logger.info.mock.calls,
        ...logger.error.mock.calls,
      ])
        expect(String(text)).not.toContain("catalog=off");
    } finally {
      await worker.stop();
    }
  });

  it("turns Production Catalog rendering off without source settings despite a public signer, UGC identity and local directory", async () => {
    const queue = quietQueue();
    fakeMedia.sandbox.selfCheck.mockResolvedValue({
      status: "ok",
      runtime: sandboxRuntime(),
      facts: isolatedFacts(),
    });
    const worker = await startMediaWorker(
      {
        ...production,
        CATALOG_SOURCE_COS_BUCKET: undefined,
        CATALOG_SOURCE_COS_REGION: undefined,
        CATALOG_SOURCE_COS_SECRET_ID: undefined,
        CATALOG_SOURCE_COS_SECRET_KEY: undefined,
        CMS_MEDIA_DIR: "/Users/synthetic/payload-media",
      },
      { logger: silent },
    );
    try {
      expect(worker.catalog).toBe(false);
      // Rendering is off, but live published metadata/withdrawal discovery must
      // continue on its separate read-only CMS connection.
      expect(createPostgresPool).toHaveBeenCalledTimes(2);
      await vi.waitFor(() =>
        expect(queue.catalogSync).toHaveBeenCalledTimes(1),
      );
      expect(queue.catalogSync.mock.calls[0]![2].snapshot).toMatchObject({
        publishedSources: [],
      });
      expect(queue.catalogSync.mock.calls[0]![2].snapshot).not.toHaveProperty(
        "preparations",
      );
      await vi.waitFor(() => expect(queue.claim).toHaveBeenCalled());
      for (const [claim] of queue.claim.mock.calls) {
        expect(claim.kinds).not.toContain("catalog_render");
        expect(claim.catalogBlocks).toBeUndefined();
      }
      expect(queue.blockSync).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });
});
