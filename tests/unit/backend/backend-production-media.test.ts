import { prepareProductionBackend } from "@moya/backend-production";
import { ProductionCosStorageUrlResolver } from "@moya/backend-production/internal/production-cos";
import { openPublishingMedia } from "@moya/backend-production/internal/publishing-config";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import {
  createBackendApplication,
  startBackendProcess,
} from "@moya/backend-runtime";
import { createPostgresPool } from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  PostgresNotificationAdapter,
} from "@moya/community-postgres";
import {
  catalogDetailSchema,
  catalogPageSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendProcessHandle } from "@moya/backend-runtime";

const database = vi.hoisted(() => ({
  published: true,
  mediaKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.webp`,
  end: vi.fn(async () => {}),
}));

// The actual public application, mapper and official SDK signer run together.
// Only PostgreSQL I/O is replaced with a published-projection fixture.
vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  const projection = () => {
    const media = {
      id: "media-unit-published",
      position: 0,
      isRepresentative: true,
      kind: "image",
      alt: "Synthetic public media",
      width: 1200,
      height: 800,
      objectKey: database.mediaKey,
    };
    return {
      id: "catalog-unit-published",
      kind: "inscription",
      title: "Synthetic published projection",
      aliases: [],
      sourceCitations: [],
      representativeMedia: media,
      media: [media],
    };
  };
  return {
    ...actual,
    createPostgresPool: vi.fn(() => ({ end: database.end })),
    assertPostgresStartupReady: vi.fn(async () => {}),
    PostgresCatalogQueryAdapter: class {
      async getById(id: string) {
        return database.published && id === "catalog-unit-published"
          ? projection()
          : null;
      }
      async list({ page, pageSize }: { page: number; pageSize: number }) {
        return {
          items: database.published ? [projection()] : [],
          total: database.published ? 1 : 0,
          totalPages: database.published ? 1 : 0,
          page,
          pageSize,
        };
      }
    },
  };
});

// The community ledger check is read-only PostgreSQL I/O as well; the App-role
// adapter is unused by these media compositions.
vi.mock("@moya/community-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    verifyCommunityMigrationLedger: vi.fn(async () => {}),
  };
});

// Opening real private media directories is covered by the publishing worker
// tests; compositions here observe the call and may substitute fakes.
vi.mock(
  "@moya/backend-production/internal/publishing-config",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@moya/backend-production/internal/publishing-config")
      >();
    return {
      ...actual,
      openPublishingMedia: vi.fn(actual.openPublishingMedia),
    };
  },
);

// The composition's application and worker handler options are observed; the
// real runtime and handlers still run.
vi.mock("@moya/backend-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moya/backend-runtime")>();
  return {
    ...actual,
    createBackendApplication: vi.fn(actual.createBackendApplication),
  };
});
vi.mock(
  "@moya/backend-production/internal/publishing-job-handlers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@moya/backend-production/internal/publishing-job-handlers")
      >();
    return {
      ...actual,
      createPublishingJobHandlers: vi.fn(actual.createPublishingJobHandlers),
    };
  },
);

const environment = {
  HOST: "127.0.0.1",
  NODE_ENV: "production",
  PORT: "3001",
  MOYA_CONTENT_SOURCE: "payload",
  DATABASE_URL:
    "postgresql://synthetic-runtime@127.0.0.1:1/synthetic_published",
  APP_DATABASE_URL:
    "postgresql://synthetic-community@127.0.0.1:1/synthetic_published",
  COS_BUCKET: "synthetic-example-1250000000",
  COS_REGION: "ap-guangzhou",
  COS_MEDIA_ORIGIN: "https://media.example.invalid",
  COS_SECRET_ID: "synthetic-unit-id",
  COS_SECRET_KEY: "synthetic-unit-secret",
} as const;
const handles = new Set<BackendProcessHandle>();
const start = async () => {
  const prepared = await prepareProductionBackend(environment);
  const handle = await startBackendProcess({
    closeResources: prepared.closeResources,
    listen: { host: "127.0.0.1", port: 0 },
    requestListener: prepared.requestListener,
  });
  handles.add(handle);
  return `http://${handle.address.address}:${handle.address.port}`;
};

afterEach(async () => {
  for (const handle of handles) await handle.shutdown();
  handles.clear();
  database.published = true;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("non-Pilot production public media composition", () => {
  it.each([
    "COS_BUCKET",
    "COS_REGION",
    "COS_MEDIA_ORIGIN",
    "COS_SECRET_ID",
    "COS_SECRET_KEY",
  ])("fails closed without %s before database initialization", async (key) => {
    await expect(
      prepareProductionBackend({ ...environment, [key]: undefined }),
    ).rejects.toThrow(
      `Production COS configuration missing or invalid: ${key}`,
    );
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("returns signed src through the unchanged public DTO and rejects arbitrary key input", async () => {
    const base = await start();
    const resolver = vi.spyOn(
      ProductionCosStorageUrlResolver.prototype,
      "resolveMany",
    );
    const arbitraryKeyResponse = await fetch(
      `${base}/v1/catalog/catalog-unit-published?objectKey=arbitrary-private-object&bucket=other-bucket`,
    );
    expect(arbitraryKeyResponse.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    const detailResponse = await fetch(
      `${base}/v1/catalog/catalog-unit-published`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = catalogDetailSchema.parse(await detailResponse.json());
    const listResponse = await fetch(`${base}/v1/catalog`);
    expect(listResponse.status).toBe(200);
    const list = catalogPageSchema.parse(await listResponse.json());
    for (const media of [
      detail.media[0]!,
      detail.representativeMedia!,
      list.items[0]!.representativeMedia!,
    ]) {
      expect(Object.keys(media).sort()).toEqual([
        "alt",
        "height",
        "id",
        "kind",
        "src",
        "width",
      ]);
      const url = new URL(media.src);
      expect(url.origin).toBe(environment.COS_MEDIA_ORIGIN);
      expect(decodeURIComponent(url.pathname.slice(1))).toBe(database.mediaKey);
      expect(url.searchParams.has("q-signature")).toBe(true);
      expect(media.src).not.toContain(environment.COS_BUCKET);
      expect(media.src).not.toContain(environment.COS_REGION);
      expect(media.src).not.toContain(environment.COS_SECRET_KEY);
    }
    expect(
      await fetch(`${base}/media/arbitrary-token`).then(
        (response) => response.status,
      ),
    ).toBe(404);
  });

  it("does not resolve missing or withdrawn published projections", async () => {
    const resolver = vi.spyOn(
      ProductionCosStorageUrlResolver.prototype,
      "resolveMany",
    );
    const base = await start();
    expect(
      await fetch(`${base}/v1/catalog/catalog-unit-draft`).then(
        (response) => response.status,
      ),
    ).toBe(404);
    expect(resolver).not.toHaveBeenCalled();
    expect(
      await fetch(`${base}/v1/catalog/catalog-unit-published`).then(
        (response) => response.status,
      ),
    ).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
    database.published = false;
    expect(
      await fetch(`${base}/v1/catalog/catalog-unit-published`).then(
        (response) => response.status,
      ),
    ).toBe(404);
    const list = catalogPageSchema.parse(
      await fetch(`${base}/v1/catalog`).then((response) => response.json()),
    );
    expect(list.items).toEqual([]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe("local development database boundary", () => {
  const local = {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    MOYA_CONTENT_SOURCE: "payload",
    DATABASE_URL: "postgresql://synthetic-public@127.0.0.1:54330/yoyi_dev",
    CMS_DATABASE_URL: "postgresql://synthetic-payload@127.0.0.1:54330/yoyi_dev",
    APP_DATABASE_URL: "postgresql://synthetic-app@127.0.0.1:54330/yoyi_dev",
    CMS_ENVIRONMENT: "synthetic",
    CMS_STORAGE_MODE: "local",
    PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002",
  };

  it("uses the same loopback development database with separate runtime roles and no COS credentials", async () => {
    const prepared = await prepareProductionBackend(local);
    expect(createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({ max: 5, connectionString: local.DATABASE_URL }),
      expect.any(Object),
    );
    await prepared.closeResources();
  });

  it("allows the explicit local sslmode=disable used by development migration", async () => {
    const prepared = await prepareProductionBackend({
      ...local,
      DATABASE_URL: `${local.DATABASE_URL}?sslmode=disable`,
      CMS_DATABASE_URL: `${local.CMS_DATABASE_URL}?sslmode=disable`,
    });
    expect(createPostgresPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: local.DATABASE_URL,
        ssl: false,
      }),
      expect.any(Object),
    );
    await prepared.closeResources();
  });

  it.each(["DATABASE_URL", "CMS_DATABASE_URL"] as const)(
    "rejects query overrides on %s before opening a pool",
    async (key) => {
      for (const query of [
        "host=database.example.invalid",
        "port=55439",
        "user=synthetic-payload",
        "database=synthetic_stage_a",
        "sslmode=require",
        "sslmode=disable&host=database.example.invalid",
      ]) {
        await expect(
          prepareProductionBackend({
            ...local,
            [key]: `${local[key]}?${query}`,
          }),
        ).rejects.toThrow(/^Local /);
      }
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );

  it.each(["synthetic-public", "synthetic%2Dpublic"])(
    "rejects the same decoded runtime user before opening a pool",
    async (username) => {
      await expect(
        prepareProductionBackend({
          ...local,
          CMS_DATABASE_URL: `postgresql://${username}@127.0.0.1:54330/yoyi_dev`,
        }),
      ).rejects.toThrow(/^Local /);
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { HOST: "0.0.0.0" },
    {
      DATABASE_URL:
        "postgresql://synthetic-public@database.example.invalid:54330/yoyi_dev",
    },
    {
      CMS_DATABASE_URL:
        "postgresql://synthetic-payload@127.0.0.1:54331/yoyi_dev",
    },
    {
      CMS_DATABASE_URL:
        "postgresql://synthetic-payload@127.0.0.1:54330/stage_a",
    },
    {
      CMS_DATABASE_URL:
        "postgresql://synthetic-payload@127.0.0.1:54330/yoyi_dev?options=-csearch_path%3Dother",
    },
    { MOYA_CONTENT_SOURCE: "legacy" },
    { MOYA_PILOT_SCOPE_FILE: "unused-synthetic-path" },
  ])(
    "rejects mixed or nonlocal development configuration before opening a pool",
    async (invalid) => {
      await expect(
        prepareProductionBackend({ ...local, ...invalid }),
      ).rejects.toThrow(/^Local /);
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );
});

describe("Development work publishing composition", () => {
  const local = {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    MOYA_CONTENT_SOURCE: "payload",
    DATABASE_URL: "postgresql://synthetic-public@127.0.0.1:54330/yoyi_dev",
    CMS_DATABASE_URL: "postgresql://synthetic-payload@127.0.0.1:54330/yoyi_dev",
    APP_DATABASE_URL: "postgresql://synthetic-app@127.0.0.1:54330/yoyi_dev",
    CMS_ENVIRONMENT: "synthetic",
    CMS_STORAGE_MODE: "local",
    CMS_MEDIA_DIR: "/Users/synthetic/payload-media",
    PUBLIC_MEDIA_BASE_URL: "http://127.0.0.1:3002",
  };
  const publishingKeys = {
    WORK_MEDIA_STORE_DIR: "/Users/synthetic/publishing/store",
    WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v1",
    WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
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
        created: false,
      }),
    };
  };

  it("composes no publishing media and no worker without the media keys", async () => {
    const queue = quietQueue();
    const prepared = await prepareProductionBackend(local);
    prepared.startBackgroundWork();
    await pause(20);
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(queue.claim).not.toHaveBeenCalled();
    expect(queue.requeue).not.toHaveBeenCalled();
    await prepared.closeResources();
    expect(database.end).toHaveBeenCalled();
  });

  it.each([
    [
      { WORK_MEDIA_STORE_DIR: publishingKeys.WORK_MEDIA_STORE_DIR },
      /configured together/,
    ],
    [
      { ...publishingKeys, WORK_MEDIA_WORKER_CONCURRENCY: "9" },
      /^WORK_MEDIA_WORKER_CONCURRENCY /,
    ],
    [
      { ...publishingKeys, WORK_MEDIA_TOOLS_IMAGE: "latest" },
      /^WORK_MEDIA_TOOLS_IMAGE /,
    ],
    [
      { ...publishingKeys },
      /^WORK_MEDIA_STORE_DIR is invalid: Publishing media directory must exist$/,
    ],
  ])(
    "fails before opening a pool for unusable media configuration %#",
    async (keys, message) => {
      await expect(
        prepareProductionBackend({ ...local, ...keys }),
      ).rejects.toThrow(message);
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );

  it("starts the worker only on request and stops it before the pools close", async () => {
    const queue = quietQueue();
    const media = {
      store: {
        writeStream: vi.fn(),
        openRead: vi.fn(),
        remove: vi.fn(),
        listBlobs: vi.fn(),
        sweepStaging: vi.fn(),
      },
      runner: { createJob: vi.fn(), run: vi.fn(), sweepJobs: vi.fn() },
      processor: { process: vi.fn() },
    };
    vi.mocked(openPublishingMedia).mockResolvedValueOnce(
      media as unknown as Awaited<ReturnType<typeof openPublishingMedia>>,
    );
    const prepared = await prepareProductionBackend({
      ...local,
      ...publishingKeys,
      WORK_MEDIA_WORKER_CONCURRENCY: "2",
    });
    expect(openPublishingMedia).toHaveBeenCalledWith(
      {
        storeDirectory: publishingKeys.WORK_MEDIA_STORE_DIR,
        toolsImage: publishingKeys.WORK_MEDIA_TOOLS_IMAGE,
        workDirectory: publishingKeys.WORK_MEDIA_WORK_DIR,
        workerConcurrency: 2,
      },
      { foreignDirectories: [local.CMS_MEDIA_DIR] },
    );
    await pause(20);
    expect(queue.claim).not.toHaveBeenCalled();

    prepared.startBackgroundWork();
    await vi.waitFor(() =>
      expect(queue.claim).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 2, leaseMs: 5 * 60 * 1000 }),
        expect.any(Date),
      ),
    );
    expect(queue.requeue).toHaveBeenCalledTimes(1);
    expect(queue.cleanup).toHaveBeenCalledTimes(1);
    expect(queue.enqueue.mock.calls.map(([job]) => job.kind)).toEqual([
      "sweep_staging",
      "reconcile_capacity",
    ]);

    // Hold the worker inside its next claim: closing must wait for it before
    // any pool ends.
    let releaseClaim: (claims: []) => void = () => undefined;
    const polled = queue.claim.mock.calls.length;
    queue.claim.mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          releaseClaim = resolve;
        }),
    );
    await vi.waitFor(
      () => expect(queue.claim.mock.calls.length).toBeGreaterThan(polled),
      { timeout: 3_000 },
    );
    let closed = false;
    const closing = prepared.closeResources().then(() => {
      closed = true;
    });
    await pause(50);
    expect(closed).toBe(false);
    expect(database.end).not.toHaveBeenCalled();
    releaseClaim([]);
    await closing;
    expect(database.end).toHaveBeenCalledTimes(2);
    const claims = queue.claim.mock.calls.length;
    await pause(1_100);
    expect(queue.claim.mock.calls.length).toBe(claims);
    expect(media.processor.process).not.toHaveBeenCalled();
  });

  it("shares one upload registry between the upload route and the worker's session expiry", async () => {
    quietQueue();
    const media = {
      store: {
        writeStream: vi.fn(),
        openRead: vi.fn(),
        remove: vi.fn(),
        listBlobs: vi.fn(),
        sweepStaging: vi.fn(),
      },
      runner: { createJob: vi.fn(), run: vi.fn(), sweepJobs: vi.fn() },
      processor: { process: vi.fn() },
    };
    vi.mocked(openPublishingMedia).mockResolvedValueOnce(
      media as unknown as Awaited<ReturnType<typeof openPublishingMedia>>,
    );
    const prepared = await prepareProductionBackend({
      ...local,
      ...publishingKeys,
    });
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    const [handlers] = vi
      .mocked(createPublishingJobHandlers)
      .mock.calls.at(-1)!;
    const transfers = application.publishingTransfers;
    if (transfers === undefined) throw new Error("expected a shared registry");
    expect(application.workPublishingPort).toBe(handlers.port);
    const componentId = `media-component-${"2".repeat(32)}`;
    const stops: string[] = [];
    const streaming = transfers.claim(componentId, () => stops.push("stop"));
    streaming.markStreaming();
    const opening = transfers.claim(componentId, () => stops.push("never"));

    // What the worker calls with the component ids of an expired session.
    handlers.onUploadsCancelled?.([componentId]);
    expect(stops).toEqual(["stop"]);
    expect(transfers.isActive(componentId)).toBe(false);
    opening.release();
    expect(transfers.size).toBe(0);
    await prepared.closeResources();
  });

  it("composes the upload registry without a worker when publishing media is off", async () => {
    quietQueue();
    const prepared = await prepareProductionBackend(local);
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    expect(application.publishingTransfers).toBeDefined();
    expect(application.workPublishingPort).toBeDefined();
    expect(createPublishingJobHandlers).not.toHaveBeenCalled();
    await prepared.closeResources();
  });

  it("composes Production business and notification services without Development media fallback", async () => {
    const queue = quietQueue();
    const notificationClaim = vi
      .spyOn(PostgresNotificationAdapter.prototype, "claim")
      .mockResolvedValue([]);
    const prepared = await prepareProductionBackend({
      ...environment,
      WORK_MEDIA_STORE_DIR: "relative",
      WORK_MEDIA_TOOLS_IMAGE: "latest",
      WORK_MEDIA_WORKER_CONCURRENCY: "not-a-number",
    });
    prepared.startBackgroundWork();
    const handle = await startBackendProcess({
      closeResources: prepared.closeResources,
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: prepared.requestListener,
    });
    handles.add(handle);
    const base = `http://${handle.address.address}:${handle.address.port}`;
    for (const suffix of ["publishing/limits", "publishing/drafts"]) {
      expect(
        await fetch(`${base}/v1/community/${suffix}`).then(
          (response) => response.status,
        ),
      ).toBe(401);
    }
    expect(
      await fetch(`${base}/v1/development/sign-in`, { method: "POST" }).then(
        (response) => response.status,
      ),
    ).toBe(404);
    await pause(20);
    expect(notificationClaim).toHaveBeenCalled();
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(queue.claim).not.toHaveBeenCalled();
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    expect(application.publishingTransfers).toBeDefined();
    expect(application.workPublishingPort).toBeDefined();
    expect(createPublishingJobHandlers).not.toHaveBeenCalled();
    expect(application.notificationPort).toBeDefined();
    expect(application.authorCommunityPort).toBeDefined();
    expect(application.articleAuthoringPort).toBeDefined();
    expect(application.authService).toBeUndefined();
    expect(application.agentAdministrationPort).toBeUndefined();
    expect(application.articleDelegation).toBeUndefined();
  });
});
