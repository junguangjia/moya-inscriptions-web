import { createHash, randomUUID } from "node:crypto";

import { prepareProductionBackend as prepareProductionBackendImplementation } from "@moya/backend-production";
import { ProductionCosStorageUrlResolver } from "@moya/backend-production/internal/production-cos";
import {
  openPublishingMedia,
  openPublishingStore,
  openProductionPublishingStore,
} from "@moya/backend-production/internal/publishing-config";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import {
  CATALOG_PUBLISHED_PAIRS_MAX,
  CATALOG_SYNC_MAX_SOURCES,
  publishedCatalogPairsSql,
} from "@moya/backend-production/internal/publishing-catalog";
import { CatalogQueryUnavailableError } from "@moya/api";
import {
  createBackendApplication,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  assertPostgresStartupReady,
  CanonicalAuthoredArticleProjector,
  createPostgresPool,
  PostgresAuthoredArticleCatalogMediaResolver,
} from "@moya/catalog-postgres";
import {
  PostgresAuthorCommunityAdapter,
  PostgresWorkPublishingAdapter,
  PostgresNotificationAdapter,
  PostgresMediaPublicationAdapter,
} from "@moya/community-postgres";
import {
  apiErrorSchema,
  articleAuthoringDocumentSchema,
  catalogDetailSchema,
  catalogPageSchema,
  discoveryPageSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendProcessHandle } from "@moya/backend-runtime";
import type {
  ArticleDetailRecord,
  AuthorCommunityPort,
  CatalogDetailProjection,
  CommunityDiscoveryPort,
  DiscoveryCardRecord,
  EditorialContentReadPort,
  PublishedAuthoredArticle,
} from "@moya/api";
import type { ArticleId, CatalogId, MediaId } from "@moya/contracts";

const productionStore = vi.hoisted(() => ({
  writeStream: vi.fn(),
  openRead: vi.fn(),
  remove: vi.fn(),
  listBlobs: vi.fn(),
  sweepStaging: vi.fn(),
}));

const database = vi.hoisted(() => ({
  published: true,
  mediaKey: `display/v1/media_${"a".repeat(32)}/${"b".repeat(64)}.webp`,
  // Further published images of the Detail, each its own pair.
  extraMedia: 0,
  snapshotObservedAt: new Date("2026-10-20T00:00:00.000Z"),
  snapshotClients: [] as { statements: string[]; released: boolean }[],
  snapshotsReleasedAtSync: null as boolean | null,
  end: vi.fn(async () => {}),
}));

// The actual public application, mapper and official SDK signer run together.
// Only PostgreSQL I/O is replaced with a published-projection fixture.
vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  const projection = (): CatalogDetailProjection => {
    const media = {
      id: "media-unit-published" as MediaId,
      position: 0,
      isRepresentative: true,
      kind: "image" as const,
      alt: "Synthetic public media",
      width: 1200,
      height: 800,
      objectKey: database.mediaKey,
    };
    return {
      id: "catalog-unit-published" as CatalogId,
      kind: "inscription",
      title: "Synthetic published projection",
      aliases: [],
      sourceCitations: [],
      representativeMedia: media,
      media: [
        media,
        ...Array.from({ length: database.extraMedia }, (_, n) => ({
          ...media,
          id: `media-unit-extra-${n}` as MediaId,
          position: n + 1,
          isRepresentative: false,
        })),
      ],
    };
  };
  return {
    ...actual,
    createPostgresPool: vi.fn(() => ({
      end: database.end,
      query: vi.fn(async () => ({ rows: [] })),
      // A real Catalog snapshot checks out its own read-only transaction.
      connect: vi.fn(async () => {
        const record = { statements: [] as string[], released: false };
        database.snapshotClients.push(record);
        return {
          query: vi.fn(async (sql: string) => {
            record.statements.push(sql);
            return {
              rows:
                sql === "SELECT clock_timestamp() AS at"
                  ? [{ at: database.snapshotObservedAt }]
                  : [],
            };
          }),
          release: vi.fn(() => {
            record.released = true;
          }),
        };
      }),
    })),
    assertPostgresStartupReady: vi.fn(async () => {}),
    PostgresCatalogQueryAdapter: class
      extends actual.PostgresCatalogQueryAdapter
    {
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
// adapter is unused by these media compositions. The author adapter's
// options (the profile rendition switch) are observed.
vi.mock("@moya/community-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    verifyCommunityMigrationLedger: vi.fn(async () => {}),
    PostgresAuthorCommunityAdapter: vi.fn(function (
      ...args: ConstructorParameters<
        typeof actual.PostgresAuthorCommunityAdapter
      >
    ) {
      return new actual.PostgresAuthorCommunityAdapter(...args);
    }),
  };
});

// Factory/store/processor contracts are covered separately. This composition
// suite preserves real configuration parsing and replaces only opening I/O.
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
      openPublishingStore: vi.fn(actual.openPublishingStore),
      openProductionPublishingStore: vi.fn(
        () =>
          productionStore as unknown as ReturnType<
            typeof actual.openProductionPublishingStore
          >,
      ),
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
  PRODUCT_ACCESS_MODE: "public",
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
  WORK_MEDIA_COS_BUCKET: "synthetic-publishing-1250000000",
  WORK_MEDIA_COS_REGION: "ap-guangzhou",
  WORK_MEDIA_COS_PREFIX: "ugc/publishing/synthetic/",
  WORK_MEDIA_COS_SECRET_ID: "synthetic-publishing-id",
  WORK_MEDIA_COS_SECRET_KEY: "synthetic-publishing-secret",
  WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v1",
  WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
  WORK_MEDIA_WORKER_CONCURRENCY: "2",
} as const;
const preparedResources = new Set<
  Awaited<ReturnType<typeof prepareProductionBackendImplementation>>
>();
const prepareProductionBackend: typeof prepareProductionBackendImplementation =
  async (...args) => {
    const prepared = await prepareProductionBackendImplementation(...args);
    let closing: Promise<void> | undefined;
    const tracked = {
      ...prepared,
      closeResources: () => {
        closing ??= prepared.closeResources().finally(() => {
          preparedResources.delete(tracked);
        });
        return closing;
      },
    };
    preparedResources.add(tracked);
    return tracked;
  };
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
  try {
    const outcomes = await Promise.allSettled([
      ...[...handles].map((handle) => handle.shutdown()),
      ...[...preparedResources].map((prepared) => prepared.closeResources()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
      [],
    );
  } finally {
    handles.clear();
    database.published = true;
    database.mediaKey = `display/v1/media_${"a".repeat(32)}/${"b".repeat(64)}.webp`;
    database.extraMedia = 0;
    database.snapshotClients = [];
    database.snapshotsReleasedAtSync = null;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  }
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

  it.each([
    "WORK_MEDIA_COS_BUCKET",
    "WORK_MEDIA_COS_REGION",
    "WORK_MEDIA_COS_PREFIX",
    "WORK_MEDIA_COS_SECRET_ID",
    "WORK_MEDIA_COS_SECRET_KEY",
  ])("fails closed without required Production publishing %s", async (key) => {
    await expect(
      prepareProductionBackend({ ...environment, [key]: undefined }),
    ).rejects.toThrow(key);
    expect(openProductionPublishingStore).not.toHaveBeenCalled();
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it.each([
    [
      { WORK_MEDIA_STORE_DIR: "relative" },
      /WORK_MEDIA_STORE_DIR must be absent/,
    ],
    [
      { WORK_MEDIA_COS_PREFIX: "editorial/synthetic/" },
      /WORK_MEDIA_COS_PREFIX/,
    ],
    [
      { WORK_MEDIA_WORKER: "embedded" },
      /^WORK_MEDIA_WORKER=embedded is refused in production$/,
    ],
    [
      { WORK_MEDIA_WORKER: "both" },
      /^WORK_MEDIA_WORKER must be embedded or external$/,
    ],
    [
      { MEDIA_PROFILE_RENDITIONS: "synthetic-on" },
      /^MEDIA_PROFILE_RENDITIONS must be on or off$/,
    ],
  ])(
    "refuses invalid Production media configuration before pools %#",
    async (invalid, message) => {
      await expect(
        prepareProductionBackend({ ...environment, ...invalid }),
      ).rejects.toThrow(message);
      expect(openProductionPublishingStore).not.toHaveBeenCalled();
      expect(openPublishingMedia).not.toHaveBeenCalled();
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );

  it("ignores the media worker keys: the Production Backend opens no sandbox", async () => {
    for (const keys of [
      {
        WORK_MEDIA_TOOLS_IMAGE: undefined,
        WORK_MEDIA_WORK_DIR: undefined,
        WORK_MEDIA_WORKER_CONCURRENCY: undefined,
      },
      {
        WORK_MEDIA_TOOLS_IMAGE: "latest",
        WORK_MEDIA_WORK_DIR: "relative",
        WORK_MEDIA_WORKER_CONCURRENCY: "not-a-number",
        WORK_MEDIA_WORKER: "external",
        // The media worker's profile switch is never read here.
        MEDIA_PROFILE_RENDER: "synthetic-on",
      },
    ]) {
      const prepared = await prepareProductionBackend({
        ...environment,
        ...keys,
      });
      await prepared.closeResources();
    }
    expect(openProductionPublishingStore).toHaveBeenCalledTimes(2);
    expect(openPublishingMedia).not.toHaveBeenCalled();
  });

  it("does not fall back or open pools when the Production media factory refuses", async () => {
    vi.mocked(openProductionPublishingStore).mockImplementationOnce(() => {
      throw new Error("Synthetic Production media open refusal");
    });
    await expect(prepareProductionBackend(environment)).rejects.toThrow(
      "Synthetic Production media open refusal",
    );
    expect(openProductionPublishingStore).toHaveBeenCalledTimes(1);
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("preserves signed legacy display media through the unchanged public DTO and rejects arbitrary key input", async () => {
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

  it("omits new editorial originals without a published rendition family", async () => {
    database.mediaKey = `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.webp`;
    const base = await start();
    const signer = vi.spyOn(
      ProductionCosStorageUrlResolver.prototype,
      "resolveMany",
    );
    const response = await fetch(`${base}/v1/catalog/catalog-unit-published`);
    expect(response.status).toBe(200);
    const detail = catalogDetailSchema.parse(await response.json());
    expect(detail.title).toBe("Synthetic published projection");
    expect(detail.media).toEqual([]);
    expect(detail.representativeMedia).toBeUndefined();
    expect(signer).toHaveBeenCalled();
    for (const [locators] of signer.mock.calls) expect(locators).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("q-signature");
    expect(JSON.stringify(detail)).not.toContain("objectKey");
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

  // catalog-delivery-release-hardening-v1 (F9): the composed rendition-fact
  // lookup reads the live CMS pairs and the App delivery facts. Its failure
  // is Catalog unavailability for every reader that shares it (Catalog,
  // editorial Article and Collection, authored Article bodies, author cards):
  // the documented 503, never a 500 INTERNAL_ERROR. catalog-scale-v1 1A: the
  // CMS read is the exact pair check, and an oversized batch is refused.
  it("answers 503 for Catalog, editorial, authored Article and author-card reads when the rendition facts fail", async () => {
    const pools = vi.mocked(createPostgresPool).mock.results.length;
    const prepared = await prepareProductionBackend(environment);
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    type QueryMock = ReturnType<
      typeof vi.fn<(sql: string) => Promise<{ rows: readonly unknown[] }>>
    >;
    const created = vi
      .mocked(createPostgresPool)
      .mock.calls.slice(pools)
      .map(([config], index) => ({
        config,
        pool: vi.mocked(createPostgresPool).mock.results[pools + index]!
          .value as { query: QueryMock },
      }));
    const cmsPool = created.find(
      ({ config }) => config.connectionString === environment.DATABASE_URL,
    )!.pool;
    const appPool = created.find(
      ({ config }) => config.connectionString === environment.APP_DATABASE_URL,
    )!.pool;
    const resolver = application.storageUrlResolver!;
    expect(resolver.catalogFacts).toBeDefined();
    const source = {
      media_id: "media-unit-published",
      object_key: database.mediaKey,
      width: 1200,
      height: 800,
    };
    const unreadable = Object.assign(
      new Error("synthetic private relation denied"),
      { code: "42501" },
    );
    const terminated = Object.assign(
      new Error("synthetic private connection terminated"),
      { code: "57P01" },
    );
    const timedOut = Object.assign(new Error("synthetic statement timeout"), {
      code: "57014",
    });
    const cmsFailure = (cause: Error) => () => {
      cmsPool.query.mockImplementation(async (sql) => {
        if (sql.includes("FROM catalog_media")) throw cause;
        return { rows: [] };
      });
    };
    const failures: {
      readonly name: string;
      readonly cause: unknown;
      readonly arm: () => void;
      /** The batch handed to the facts lookup (one live pair otherwise). */
      readonly locators?: readonly { mediaId: MediaId; objectKey: string }[];
      /** The reads that carry the failing batch (every read otherwise). */
      readonly only?: "detail";
    }[] = [
      {
        name: "CMS pair check refused",
        cause: unreadable,
        arm: cmsFailure(unreadable),
      },
      {
        name: "CMS pair check terminated",
        cause: terminated,
        arm: cmsFailure(terminated),
      },
      {
        name: "CMS pair check timed out",
        cause: timedOut,
        arm: cmsFailure(timedOut),
      },
      {
        // More distinct pairs than one exact check (and one App projection)
        // accepts: refused before any read. Only a Detail carries that many.
        name: "more than 10,000 pairs",
        cause: TypeError,
        locators: Array.from(
          { length: CATALOG_PUBLISHED_PAIRS_MAX + 1 },
          (_, n) => ({
            mediaId: `media-unit-extra-${n}` as MediaId,
            objectKey: database.mediaKey,
          }),
        ),
        only: "detail",
        arm() {
          database.extraMedia = CATALOG_PUBLISHED_PAIRS_MAX;
          cmsPool.query.mockImplementation(async () => ({ rows: [] }));
          appPool.query.mockImplementation(async () => ({ rows: [] }));
        },
      },
      {
        name: "App delivery facts unavailable",
        cause: terminated,
        arm() {
          database.extraMedia = 0;
          // Both cited images are published, so each read asks the App (a
          // pair that is not live never reaches it).
          cmsPool.query.mockImplementation(async (sql) => ({
            rows: sql.includes("FROM catalog_media")
              ? [source, { ...source, media_id: authoredMediaId }]
              : [],
          }));
          appPool.query.mockImplementation(async (sql) => {
            if (sql.includes("community.catalog_media_assets"))
              throw terminated;
            return { rows: [] };
          });
        },
      },
    ];

    // Published Article reads over the same composed resolver: a staff
    // Article with a Catalog cover and an authored Article whose body cites
    // a Catalog image (the authored projection and its exact-pair resolver).
    const articleId = `article-${"a".repeat(32)}` as ArticleId;
    const authoredId = `article-${"5".repeat(32)}` as ArticleId;
    const cover = {
      id: "media-unit-published" as MediaId,
      objectKey: database.mediaKey,
      alt: "Synthetic cover",
      width: 1200,
      height: 800,
    };
    const staffArticle: ArticleDetailRecord = {
      id: articleId,
      presentation: "academic",
      title: "Synthetic Article",
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: "Synthetic desk",
      cover,
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      publishedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      intro: null,
      sections: [],
      citations: [],
    };
    const authoredCatalogId = `catalog-${"3".repeat(32)}`;
    const authoredMediaId = `media-${"4".repeat(32)}`;
    const authored: PublishedAuthoredArticle = {
      id: authoredId as PublishedAuthoredArticle["id"],
      ownerId: `user-${"6".repeat(32)}` as PublishedAuthoredArticle["ownerId"],
      version: 1,
      title: "Synthetic authored Article",
      coverRefId: null,
      document: articleAuthoringDocumentSchema.parse({
        format: "blocknote",
        version: 1,
        blocks: [
          {
            id: "body-image",
            type: "managedImage",
            props: { refId: "body", caption: "", alt: "" },
            children: [],
          },
        ],
        references: {
          body: {
            type: "catalog",
            catalogId: authoredCatalogId,
            mediaId: authoredMediaId,
          },
        },
        galleries: {},
      }),
      fingerprint: "a".repeat(64),
      byline: "Synthetic author",
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      publishedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    };
    // The exact-pair CMS read of the authored reference answers its row.
    const pairPool = {
      connect: async () => ({
        query: async (sql: string) => ({
          rows: sql.includes("jsonb_to_recordset")
            ? [
                {
                  catalog_id: authoredCatalogId,
                  media_id: authoredMediaId,
                  position: 0,
                  is_representative: true,
                  kind: "image",
                  alt_text: "Synthetic body image",
                  width: 1200,
                  height: 800,
                  object_key: database.mediaKey,
                },
              ]
            : [],
        }),
        release: () => undefined,
      }),
    } as unknown as ConstructorParameters<
      typeof PostgresAuthoredArticleCatalogMediaResolver
    >[0];
    const pairs = new PostgresAuthoredArticleCatalogMediaResolver(
      pairPool,
      resolver,
    );
    const projector = new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map(),
      resolveCatalog: (requested) => pairs.resolveCatalog(requested),
    });
    const editorialPort: EditorialContentReadPort = {
      listArticles: async (query) => ({
        items: [staffArticle],
        total: 1,
        page: query.page,
        pageSize: query.pageSize,
      }),
      findArticle: async (id) =>
        id === articleId
          ? staffArticle
          : id === authoredId
            ? projector.detail(authored)
            : null,
      isArticlePublished: async (id) => id === articleId || id === authoredId,
      listCollections: async (query) => ({
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      }),
      findCollection: async () => null,
    };
    // Author cards over the same composed resolver: the feed, one card and an
    // author's collection each show the published Catalog image.
    const catalogCard: DiscoveryCardRecord = {
      target: { type: "catalog", id: "catalog-unit-published" },
      title: "Synthetic published projection",
      aliases: [],
      kind: "inscription",
      authorId: null,
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      media: {
        type: "catalog",
        id: "media-unit-published" as MediaId,
        objectKey: database.mediaKey,
        width: 1200,
        height: 800,
      },
    };
    const discoveryPort: Pick<
      CommunityDiscoveryPort,
      "browse" | "card" | "collection"
    > = {
      browse: async () => ({
        items: [catalogCard],
        sequence: randomUUID(),
        nextAfter: 1,
        hasMore: false,
      }),
      card: async () => catalogCard,
      collection: async (_owner, _viewer, _list, query) => ({
        items: [catalogCard],
        total: 1,
        page: query.page,
        pageSize: query.pageSize,
      }),
    };
    const listen = { host: "127.0.0.1", port: 0 };
    const catalogHandle = await startBackendProcess({
      closeResources: prepared.closeResources,
      listen,
      requestListener: prepared.requestListener,
    });
    handles.add(catalogHandle);
    const editorialHandle = await startBackendProcess({
      listen,
      requestListener: createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort: application.catalogQueryPort!,
        communityIdentityPort: application.communityIdentityPort!,
        // Editorial and card reads never touch the author port; the branch
        // only needs it.
        authorCommunityPort: {} as unknown as AuthorCommunityPort,
        discoveryPort: discoveryPort as CommunityDiscoveryPort,
        storageUrlResolver: resolver,
        editorialContentPort: editorialPort,
      }),
    });
    handles.add(editorialHandle);
    const origin = (handle: BackendProcessHandle) =>
      `http://${handle.address.address}:${handle.address.port}`;
    const community = `${origin(editorialHandle)}/v1/community`;
    const editorial = `${community}/editorial`;
    const cards = [
      `${community}/discover`,
      `${community}/content/catalog/catalog-unit-published/card`,
      `${community}/authors/user-${"6".repeat(32)}/favorites`,
    ];
    const reads = [
      `${origin(catalogHandle)}/v1/catalog`,
      `${origin(catalogHandle)}/v1/catalog/catalog-unit-published`,
      `${editorial}/articles`,
      `${editorial}/articles/${articleId}`,
      `${editorial}/articles/${authoredId}`,
      ...cards,
    ];
    // The card routes answer while the lookup does (nothing is live yet), so
    // their 503 below is the failing lookup's.
    for (const url of cards) expect((await fetch(url)).status, url).toBe(200);

    for (const failure of failures) {
      failure.arm();
      const cmsReads = cmsPool.query.mock.calls.length;
      const error = await resolver.catalogFacts!(
        failure.locators ?? [
          {
            mediaId: "media-unit-published" as MediaId,
            objectKey: database.mediaKey,
          },
        ],
      ).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error, failure.name).toBeInstanceOf(CatalogQueryUnavailableError);
      if (failure.cause === TypeError) {
        expect((error as Error).cause, failure.name).toBeInstanceOf(TypeError);
        expect(cmsPool.query.mock.calls.length, failure.name).toBe(cmsReads);
      } else expect((error as Error).cause, failure.name).toBe(failure.cause);
      for (const url of failure.only === "detail" ? [reads[1]!] : reads) {
        const response = await fetch(url);
        expect(response.status, `${failure.name}: ${url}`).toBe(503);
        const body = apiErrorSchema.parse(await response.json());
        expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
        expect(JSON.stringify(body)).not.toContain("private");
        expect(JSON.stringify(body)).not.toContain("incomplete");
      }
    }
  });

  // catalog-scale-v1 (Issue #323) 1A: rendition facts and rendition URLs ask
  // the live published projection about the read's own exact pairs only, on
  // the public read pool. A Catalog beyond the old 10,000-image listing reads
  // like any other, no Catalog image reads nothing, and neither path ever
  // touches the prepare pool, although the authority behind resolveKeys holds
  // it.
  it("reads facts and rendition URLs by exact pairs beyond 10,000 published images, never through the prepare pool", async () => {
    const edge = {
      ...environment,
      CATALOG_PREPARE_DATABASE_URL:
        "postgresql://synthetic-prepare@127.0.0.1:1/synthetic_published",
      MEDIA_PUBLIC_DELIVERY: "edge",
      MEDIA_PUBLISHED_ORIGIN: "https://published.synthetic.test",
      MEDIA_PUBLISHED_COS_BUCKET: "synthetic-published-12345",
      MEDIA_PUBLISHED_COS_REGION: "ap-guangzhou",
      MEDIA_PUBLISHER_ROLE_ARN:
        "qcs::cam::uin/12345:roleName/synthetic-publisher",
      MEDIA_EDGE_ZONE_ID: "zone-synthetic",
    };
    const pools = vi.mocked(createPostgresPool).mock.results.length;
    const prepared = await prepareProductionBackend(edge);
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    type Rows = { rows: readonly unknown[] };
    type PoolMock = {
      query: ReturnType<
        typeof vi.fn<
          (sql: string, values?: readonly unknown[]) => Promise<Rows>
        >
      >;
      connect: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    };
    const created = vi
      .mocked(createPostgresPool)
      .mock.calls.slice(pools)
      .map(([config], index) => ({
        config,
        pool: vi.mocked(createPostgresPool).mock.results[pools + index]!
          .value as PoolMock,
      }));
    const poolOf = (url: string) =>
      created.find(({ config }) => config.connectionString === url)!.pool;
    const cmsPool = poolOf(edge.DATABASE_URL);
    const appPool = poolOf(edge.APP_DATABASE_URL);
    const preparePool = poolOf(edge.CATALOG_PREPARE_DATABASE_URL);
    expect(new Set([cmsPool, appPool, preparePool]).size).toBe(3);
    const resolver = application.storageUrlResolver!;

    // The published projection holds more images than the old listing
    // ceiling. The restriction form answers the rows whose media id and
    // object key are both bound; any other read lists the whole Catalog (and
    // would make the old read path 503).
    const live = {
      mediaId: "media-unit-published" as MediaId,
      objectKey: database.mediaKey,
    };
    const withdrawn = {
      mediaId: "media-unit-withdrawn" as MediaId,
      objectKey: `display/v1/media_${"c".repeat(32)}/${"d".repeat(64)}.webp`,
    };
    const filler = Array.from(
      { length: CATALOG_SYNC_MAX_SOURCES + 1 },
      (_, n) => ({
        media_id: `media-unit-filler-${n}`,
        object_key: `display/v1/media_${n.toString(16).padStart(32, "0")}/${"e".repeat(64)}.webp`,
        width: 1200,
        height: 800,
      }),
    );
    let published = true;
    const catalog = () => [
      ...filler,
      ...(published
        ? [
            {
              media_id: live.mediaId,
              object_key: live.objectKey,
              width: 1200,
              height: 800,
            },
          ]
        : []),
    ];
    cmsPool.query.mockImplementation(async (sql, values) => {
      if (sql.includes("community."))
        throw new Error("CMS_CROSS_DATABASE_READ");
      if (!sql.includes("FROM catalog_media")) return { rows: [] };
      const [mediaIds, objectKeys] = values ?? [];
      return {
        rows:
          Array.isArray(mediaIds) && Array.isArray(objectKeys)
            ? catalog()
                .filter(
                  (row) =>
                    mediaIds.includes(row.media_id) &&
                    objectKeys.includes(row.object_key),
                )
                .map(({ media_id, object_key }) => ({ media_id, object_key }))
            : catalog(),
      };
    });
    // App: the live pair's asset and one published rendition of it.
    const assetId = `catalog-asset-${createHash("md5")
      .update(`${live.mediaId}:${live.objectKey}`)
      .digest("hex")}`;
    const renditionId = `media-rendition-${"7".repeat(32)}`;
    const publishedKey = `v1/${"1".repeat(32)}/${"2".repeat(32)}/base/display.r1.webp`;
    const projected: unknown[] = [];
    appPool.query.mockImplementation(async (sql, values) => {
      const [first] = values ?? [];
      if (sql.includes('jsonb_to_recordset($1::jsonb) AS pair("mediaId"'))
        projected.push(JSON.parse(first as string));
      if (sql.startsWith("SELECT DISTINCT catalog_asset_id"))
        return {
          rows: (first as string[]).includes(renditionId)
            ? [{ catalog_asset_id: assetId }]
            : [],
        };
      if (sql.startsWith("SELECT id,media_id,source_object_key"))
        return {
          rows: (first as string[]).includes(assetId)
            ? [
                {
                  id: assetId,
                  media_id: live.mediaId,
                  source_object_key: live.objectKey,
                },
              ]
            : [],
        };
      return { rows: [] };
    });
    const publicationReads = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM community.media_publications p")
        ? [{ rendition_id: renditionId, object_key: publishedKey }]
        : [],
    }));
    appPool.connect.mockImplementation(async () => ({
      query: publicationReads,
      release: vi.fn(),
    }));
    const cmsReads = () =>
      cmsPool.query.mock.calls.map(([sql, values]) => ({ sql, values }));
    // Startup checks are covered elsewhere; count the reads from here on.
    cmsPool.query.mockClear();
    appPool.query.mockClear();

    // A work-only feed page names no Catalog image and reads neither
    // database; a page with one Catalog card makes the one exact check.
    const workItem = `media-item-${"9".repeat(32)}`;
    const workCard: DiscoveryCardRecord = {
      target: { type: "work", id: `work-${"9".repeat(32)}` },
      title: "Synthetic work",
      aliases: [],
      kind: null,
      authorId: `user-${"6".repeat(32)}`,
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      media: {
        type: "work",
        id: workItem,
        src: `/api/community/publishing/media/${workItem}/display/base`,
        width: 1200,
        height: 800,
      },
    };
    const catalogCard: DiscoveryCardRecord = {
      target: { type: "catalog", id: "catalog-unit-published" },
      title: "Synthetic published projection",
      aliases: [],
      kind: "inscription",
      authorId: null,
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      media: {
        type: "catalog",
        id: live.mediaId,
        objectKey: live.objectKey,
        width: 1200,
        height: 800,
      },
    };
    let feed = [workCard];
    const browse: Pick<CommunityDiscoveryPort, "browse"> = {
      browse: async () => ({
        items: feed,
        sequence: randomUUID(),
        nextAfter: feed.length,
        hasMore: false,
      }),
    };
    const feedHandle = await startBackendProcess({
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort: application.catalogQueryPort!,
        communityIdentityPort: application.communityIdentityPort!,
        // Feed reads never touch the author port; the branch only needs it.
        authorCommunityPort: {} as unknown as AuthorCommunityPort,
        discoveryPort: browse as CommunityDiscoveryPort,
        storageUrlResolver: resolver,
      }),
    });
    handles.add(feedHandle);
    const discover = `http://${feedHandle.address.address}:${feedHandle.address.port}/v1/community/discover`;
    const connects = [cmsPool, appPool].map(
      (pool) => pool.connect.mock.calls.length,
    );
    const workOnly = await fetch(discover);
    expect(workOnly.status).toBe(200);
    expect(
      discoveryPageSchema
        .parse(await workOnly.json())
        .items.map(({ target }) => target),
    ).toEqual([workCard.target]);
    expect(cmsPool.query).not.toHaveBeenCalled();
    expect(appPool.query).not.toHaveBeenCalled();
    expect(
      [cmsPool, appPool].map((pool) => pool.connect.mock.calls.length),
    ).toEqual(connects);
    feed = [workCard, catalogCard];
    expect((await fetch(discover)).status).toBe(200);
    expect(cmsReads()).toEqual([
      {
        sql: publishedCatalogPairsSql,
        values: [[live.mediaId], [live.objectKey]],
      },
    ]);
    cmsPool.query.mockClear();
    appPool.query.mockClear();
    projected.length = 0;

    // No Catalog image: neither database is read.
    expect(await resolver.catalogFacts!([])).toEqual(new Map());
    expect(cmsPool.query).not.toHaveBeenCalled();
    expect(appPool.query).not.toHaveBeenCalled();

    // Facts: one exact check of the de-duplicated pairs; only the live pair
    // reaches the App projection.
    expect(await resolver.catalogFacts!([live, live, withdrawn])).toEqual(
      new Map(),
    );
    expect(cmsReads()).toEqual([
      {
        sql: publishedCatalogPairsSql,
        values: [
          [live.mediaId, withdrawn.mediaId],
          [live.objectKey, withdrawn.objectKey],
        ],
      },
    ]);
    expect(projected).toEqual([[live]]);
    // Nothing live: the App is not asked.
    expect(await resolver.catalogFacts!([withdrawn])).toEqual(new Map());
    expect(projected).toHaveLength(1);
    // A Detail of exactly 10,000 images names its representative image
    // twice: each live pair reaches the App projection once, within its bound.
    const detail = Array.from(
      { length: CATALOG_PUBLISHED_PAIRS_MAX },
      (_, n) => ({
        mediaId: `media-unit-many-${n}` as MediaId,
        objectKey: live.objectKey,
      }),
    );
    cmsPool.query.mockImplementationOnce(async (_sql, values) => ({
      rows: (values![0] as string[]).map((media_id) => ({
        media_id,
        object_key: live.objectKey,
      })),
    }));
    expect(await resolver.catalogFacts!([detail[0]!, ...detail])).toEqual(
      new Map(),
    );
    expect(projected.at(-1)).toEqual(detail);

    // Rendition URLs: the App names the asset, the same exact check confirms
    // its pair is published now.
    const origin = edge.MEDIA_PUBLISHED_ORIGIN;
    expect(await resolver.resolveKeys!([renditionId])).toEqual(
      new Map([[renditionId, `${origin}/${publishedKey}`]]),
    );
    expect(cmsReads().at(-1)).toEqual({
      sql: publishedCatalogPairsSql,
      values: [[live.mediaId], [live.objectKey]],
    });
    // A key with no Catalog asset reads nothing from the CMS.
    const before = cmsPool.query.mock.calls.length;
    expect(
      await resolver.resolveKeys!([`media-rendition-${"8".repeat(32)}`]),
    ).toEqual(new Map());
    expect(cmsPool.query).toHaveBeenCalledTimes(before);
    // Withdrawn from the CMS while its App publication is still published:
    // the next read resolves nothing and reads no publication.
    published = false;
    const publications = publicationReads.mock.calls.length;
    expect(await resolver.resolveKeys!([renditionId])).toEqual(new Map());
    expect(publicationReads).toHaveBeenCalledTimes(publications);
    published = true;

    // The public reads themselves succeed at this Catalog size.
    const handle = await startBackendProcess({
      closeResources: prepared.closeResources,
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: prepared.requestListener,
    });
    handles.add(handle);
    const base = `http://${handle.address.address}:${handle.address.port}`;
    for (const path of ["/v1/catalog", "/v1/catalog/catalog-unit-published"])
      expect((await fetch(`${base}${path}`)).status, path).toBe(200);

    // Every CMS read was the exact check; nothing listed the Catalog.
    for (const { sql } of cmsReads())
      expect(sql).toBe(publishedCatalogPairsSql);
    expect(preparePool.query).not.toHaveBeenCalled();
    expect(preparePool.connect).not.toHaveBeenCalled();
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

describe("Work publishing composition", () => {
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
    vi.spyOn(
      PostgresMediaPublicationAdapter.prototype,
      "hasRegisteredPublications",
    ).mockResolvedValue(false);
    const prototype = PostgresWorkPublishingAdapter.prototype;
    return {
      notificationClaim: vi
        .spyOn(PostgresNotificationAdapter.prototype, "claim")
        .mockResolvedValue([]),
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
      catalogSync: vi
        .spyOn(prototype, "syncCatalogAssets")
        .mockImplementation(async () => {
          database.snapshotsReleasedAtSync =
            database.snapshotClients.length > 0 &&
            database.snapshotClients.every((client) => client.released);
          return {
            referenced: 0,
            skipped: 0,
            created: 0,
            unreferenced: 0,
            enqueued: 0,
          };
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

  const fakeMedia = () => ({
    store: {
      writeStream: vi.fn(),
      openRead: vi.fn(),
      remove: vi.fn(),
      listBlobs: vi.fn(),
      sweepStaging: vi.fn(),
    },
    sandbox: {
      createJob: vi.fn(),
      run: vi.fn(),
      selfCheck: vi.fn(),
      removeOrphanContainers: vi.fn(),
      sweepJobs: vi.fn(),
    },
    processor: { process: vi.fn() },
  });

  it.each(["development", "production"] as const)(
    "%s starts the worker only on request and stops it before the pools close",
    async (mode) => {
      const queue = quietQueue();
      const media = fakeMedia();
      if (mode === "development")
        vi.mocked(openPublishingMedia).mockResolvedValueOnce(
          media as unknown as Awaited<ReturnType<typeof openPublishingMedia>>,
        );
      const prepared = await prepareProductionBackend(
        mode === "development"
          ? {
              ...local,
              ...publishingKeys,
              WORK_MEDIA_WORKER_CONCURRENCY: "2",
            }
          : environment,
      );
      const releaseClaims: ((claims: []) => void)[] = [];
      let closing: Promise<void> | undefined;
      try {
        const [application] = vi
          .mocked(createBackendApplication)
          .mock.calls.at(-1)!;
        const [handlers] = vi
          .mocked(createPublishingJobHandlers)
          .mock.calls.at(-1)!;
        if (mode === "development") {
          expect(openPublishingMedia).toHaveBeenCalledWith(
            {
              storeDirectory: publishingKeys.WORK_MEDIA_STORE_DIR,
              toolsImage: publishingKeys.WORK_MEDIA_TOOLS_IMAGE,
              workDirectory: publishingKeys.WORK_MEDIA_WORK_DIR,
              workerConcurrency: 2,
            },
            { foreignDirectories: [local.CMS_MEDIA_DIR] },
          );
          expect(application.publishingMediaStore).toBe(media.store);
          expect(application.publishingMediaProcessor).toBe(media.processor);
          expect(handlers.store).toBe(media.store);
          expect(handlers.processor).toBe(media.processor);
          expect(handlers.toolJobs).toBe(media.sandbox);
          expect(handlers.catalog?.port).toBe(handlers.port);
          expect(handlers.profile?.port).toBe(handlers.port);
        } else {
          // The media worker processes media: no sandbox, no processor and no
          // Catalog rendering in the Backend.
          expect(openProductionPublishingStore).toHaveBeenCalledWith(
            expect.objectContaining({
              bucket: environment.WORK_MEDIA_COS_BUCKET,
              region: environment.WORK_MEDIA_COS_REGION,
              prefix: environment.WORK_MEDIA_COS_PREFIX,
            }),
            {},
          );
          expect(
            vi.mocked(openProductionPublishingStore).mock.calls[0]![0],
          ).not.toHaveProperty("workDirectory");
          expect(openPublishingMedia).not.toHaveBeenCalled();
          expect(application.publishingMediaStore).toBe(productionStore);
          expect(application.publishingMediaProcessor).toBeDefined();
          expect(handlers.store).toBe(productionStore);
          expect(handlers.processor).toBeUndefined();
          expect(handlers.catalog).toBeUndefined();
          expect(handlers.profile).toBeUndefined();
          expect(handlers.toolJobs).toBeUndefined();
        }
        // Both profile switches default on in Development and off in Production.
        expect(PostgresAuthorCommunityAdapter).toHaveBeenCalledWith(
          expect.anything(),
          { profileRenditions: mode === "development" },
        );
        await pause(20);
        expect(queue.claim).not.toHaveBeenCalled();

        prepared.startBackgroundWork();
        await vi.waitFor(() =>
          expect(queue.claim).toHaveBeenCalledWith(
            mode === "development"
              ? expect.objectContaining({
                  limit: 2,
                  leaseMs: 5 * 60 * 1000,
                  kinds: [
                    "expire_session",
                    "sweep_staging",
                    "process_item",
                    "derive_edit",
                    "purge_item",
                    "purge_blob",
                    "purge_trashed_work",
                    "reconcile_capacity",
                    "catalog_render",
                    "profile_render",
                  ],
                  // Catalog blocks (catalog-deep-zoom-v1) default on here.
                  catalogBlocks: true,
                })
              : expect.objectContaining({
                  limit: 1,
                  leaseMs: 5 * 60 * 1000,
                  kinds: ["expire_session", "sweep_staging"],
                }),
            expect.any(Date),
          ),
        );
        expect(queue.requeue).toHaveBeenCalledTimes(1);
        expect(queue.cleanup).toHaveBeenCalledTimes(1);
        expect(queue.enqueue.mock.calls.map(([job]) => job.kind)).toEqual(
          mode === "development"
            ? ["sweep_staging", "reconcile_capacity"]
            : ["sweep_staging"],
        );
        expect(queue.catalogSync).toHaveBeenCalledTimes(
          mode === "development" ? 1 : 0,
        );
        expect(queue.profileSweep).toHaveBeenCalledTimes(
          mode === "development" ? 1 : 0,
        );
        expect(queue.blockSync).toHaveBeenCalledTimes(
          mode === "development" ? 1 : 0,
        );
        if (mode === "development") {
          const snapshot = queue.catalogSync.mock.calls[0]?.[2]?.snapshot;
          expect(snapshot).toEqual({
            sources: [],
            publishedSources: [],
            observedAt: database.snapshotObservedAt,
          });
          expect(database.snapshotClients).toHaveLength(1);
          expect(database.snapshotClients[0]?.statements[0]).toBe(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          expect(database.snapshotClients[0]?.statements.at(-1)).toBe(
            "ROLLBACK",
          );
          expect(database.snapshotClients[0]?.released).toBe(true);
          expect(database.snapshotsReleasedAtSync).toBe(true);
        }

        // Hold the worker inside its next claim: closing must wait for it before
        // any pool ends.
        let enteredOwnPendingClaim = false;
        queue.claim.mockImplementation(function (
          this: PostgresWorkPublishingAdapter,
        ) {
          if (this !== handlers.port) return Promise.resolve([]);
          enteredOwnPendingClaim = true;
          return new Promise<[]>((resolve) => {
            releaseClaims.push(resolve);
          });
        });
        await vi.waitFor(() => expect(enteredOwnPendingClaim).toBe(true), {
          timeout: 7_000,
        });
        expect(releaseClaims.length).toBeGreaterThan(0);
        let closed = false;
        closing = prepared.closeResources().then(() => {
          closed = true;
        });
        await pause(50);
        expect(closed).toBe(false);
        expect(database.end).not.toHaveBeenCalled();
        for (const release of releaseClaims) release([]);
        await closing;
        expect(database.end).toHaveBeenCalledTimes(2);
        const ownClaims = () =>
          queue.claim.mock.contexts.filter(
            (context) => context === handlers.port,
          ).length;
        const claims = ownClaims();
        await pause(1_100);
        expect(ownClaims()).toBe(claims);
        expect(media.processor.process).not.toHaveBeenCalled();
      } finally {
        for (const release of releaseClaims) release([]);
        await (closing ?? prepared.closeResources());
      }
    },
    15_000,
  );

  it.each(["development", "production"] as const)(
    "%s shares one upload registry between upload and worker session expiry",
    async (mode) => {
      quietQueue();
      if (mode === "development")
        vi.mocked(openPublishingMedia).mockResolvedValueOnce(
          fakeMedia() as unknown as Awaited<
            ReturnType<typeof openPublishingMedia>
          >,
        );
      const prepared = await prepareProductionBackend(
        mode === "development"
          ? {
              ...local,
              ...publishingKeys,
            }
          : environment,
      );
      const [application] = vi
        .mocked(createBackendApplication)
        .mock.calls.at(-1)!;
      const [handlers] = vi
        .mocked(createPublishingJobHandlers)
        .mock.calls.at(-1)!;
      const transfers = application.publishingTransfers;
      if (transfers === undefined)
        throw new Error("expected a shared registry");
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
    },
  );

  it.each([
    ["development", { MEDIA_PROFILE_RENDER: "off" }, false, true],
    ["development", { MEDIA_PROFILE_RENDITIONS: "off" }, true, false],
    ["production", { MEDIA_PROFILE_RENDITIONS: "on" }, false, true],
  ] as const)(
    "%s follows the profile switches %o",
    async (mode, switches, render, renditions) => {
      const queue = quietQueue();
      if (mode === "development")
        vi.mocked(openPublishingMedia).mockResolvedValueOnce(
          fakeMedia() as unknown as Awaited<
            ReturnType<typeof openPublishingMedia>
          >,
        );
      const prepared = await prepareProductionBackend({
        ...(mode === "development"
          ? { ...local, ...publishingKeys }
          : environment),
        ...switches,
      });
      const [handlers] = vi
        .mocked(createPublishingJobHandlers)
        .mock.calls.at(-1)!;
      expect(handlers.profile !== undefined).toBe(render);
      expect(PostgresAuthorCommunityAdapter).toHaveBeenCalledWith(
        expect.anything(),
        { profileRenditions: renditions },
      );
      prepared.startBackgroundWork();
      await vi.waitFor(() => expect(queue.claim).toHaveBeenCalled());
      expect(
        queue.claim.mock.calls[0]![0].kinds?.includes("profile_render"),
      ).toBe(render);
      expect(queue.profileSweep).toHaveBeenCalledTimes(render ? 1 : 0);
      await prepared.closeResources();
    },
  );

  it("refuses an invalid embedded profile render switch before opening a pool", async () => {
    await expect(
      prepareProductionBackend({
        ...local,
        ...publishingKeys,
        MEDIA_PROFILE_RENDER: "synthetic-on",
      }),
    ).rejects.toThrow(/^MEDIA_PROFILE_RENDER must be on or off$/);
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("opens only the store for an external media worker in Development", async () => {
    const queue = quietQueue();
    const failure = await prepareProductionBackend({
      ...local,
      WORK_MEDIA_WORKER: "external",
      WORK_MEDIA_STORE_DIR: publishingKeys.WORK_MEDIA_STORE_DIR,
      WORK_MEDIA_TOOLS_IMAGE: "latest",
      // The separate media worker reads its profile switch.
      MEDIA_PROFILE_RENDER: "synthetic-on",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    // The store directory is validated (it does not exist here); the sandbox
    // keys are never read.
    expect((failure as Error).message).toMatch(/^WORK_MEDIA_STORE_DIR /);
    expect(openPublishingStore).toHaveBeenCalledTimes(1);
    expect(openPublishingMedia).not.toHaveBeenCalled();
    expect(queue.claim).not.toHaveBeenCalled();
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
    // With no publishing store, no derivative family exists. A new editorial
    // original must remain omitted from anonymous resolution in every mode.
    expect(application.developmentCatalogRenditions).toBeUndefined();
    expect(application.storageUrlResolver?.resolveKeys).toBeUndefined();
    expect(
      await application.storageUrlResolver?.resolveMany([
        {
          mediaId: "media-unit-local" as MediaId,
          objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.webp`,
        },
      ]),
    ).toEqual(new Map());
    await prepared.closeResources();
  });

  it.each(["development", "production"] as const)(
    "%s joins Catalog renditions, checks their read grant and composes the delivery route only in Development",
    async (mode) => {
      quietQueue();
      const media = fakeMedia();
      if (mode === "development")
        vi.mocked(openPublishingMedia).mockResolvedValueOnce(
          media as unknown as Awaited<ReturnType<typeof openPublishingMedia>>,
        );
      const pools = vi.mocked(createPostgresPool).mock.results.length;
      const prepared = await prepareProductionBackend(
        mode === "development" ? { ...local, ...publishingKeys } : environment,
      );
      const [application] = vi
        .mocked(createBackendApplication)
        .mock.calls.at(-1)!;
      const created = vi
        .mocked(createPostgresPool)
        .mock.calls.slice(pools)
        .map(([config], index) => ({
          config,
          pool: vi.mocked(createPostgresPool).mock.results[pools + index]!
            .value,
        }));
      expect(created).toHaveLength(2);
      const settings = mode === "development" ? local : environment;
      const catalogPool = created.find(
        ({ config }) => config.connectionString === settings.DATABASE_URL,
      )?.pool;
      const appPool = created.find(
        ({ config }) => config.connectionString === settings.APP_DATABASE_URL,
      )?.pool;
      expect(catalogPool).toBeDefined();
      expect(appPool).toBeDefined();
      expect(appPool).not.toBe(catalogPool);
      expect(assertPostgresStartupReady).toHaveBeenCalledTimes(1);
      // Discovery reads `public.catalog_discovery` through this public read
      // pool, so startup checks its grant there (catalog-delivery-release-
      // hardening-v1 N1).
      expect(assertPostgresStartupReady).toHaveBeenCalledWith(
        catalogPool,
        "payload",
        { renditions: false, discovery: true },
      );
      // CMS supplies live public metadata; only the independent App pool may
      // inspect its delivery view. Swapping the two pools must fail this test.
      const statements = (pool: unknown) =>
        (
          pool as { query: { mock: { calls: unknown[][] } } }
        ).query.mock.calls.map(([sql]) => sql);
      const deliverySql =
        "SELECT 1 FROM community.catalog_media_delivery LIMIT 0";
      expect(statements(appPool)).toContain(deliverySql);
      expect(statements(catalogPool)).not.toContain(deliverySql);
      // The actual adapter constructor/zoom methods run. Only SQL I/O is mocked:
      // current public pairs come from CMS, complete block facts from App.
      let liveMedia = true;
      let completeBlocks = true;
      const blockKeys = Array.from(
        { length: 24 },
        (_, cell) =>
          `media-rendition-${(cell + 100).toString(16).padStart(32, "0")}`,
      );
      // The zoom reads bind (record, media id or null); the exact pair check
      // of the rendition facts binds arrays of media ids and object keys.
      const names = (value: unknown, wanted: string) =>
        Array.isArray(value) ? value.includes(wanted) : value === wanted;
      const cmsQuery = vi.fn(
        async (sql: string, values?: readonly unknown[]) => {
          if (sql.includes("community."))
            throw new Error("CMS_CROSS_DATABASE_READ");
          return {
            rows:
              liveMedia &&
              sql.includes("FROM catalog_media") &&
              (Array.isArray(values?.[0])
                ? names(values[0], "media-unit-published") &&
                  names(values[1], database.mediaKey)
                : values?.[1] == null ||
                  names(values[1], "media-unit-published"))
                ? [
                    {
                      media_id: "media-unit-published",
                      object_key: database.mediaKey,
                    },
                  ]
                : [],
          };
        },
      );
      const appQuery = vi.fn(
        async (sql: string, values?: readonly unknown[]) => {
          if (sql.includes("community.catalog_media_zoom_blocks"))
            expect(values).toEqual([
              JSON.stringify([
                {
                  media_id: "media-unit-published",
                  object_key: database.mediaKey,
                },
              ]),
            ]);
          return {
            rows: !sql.includes("community.catalog_media_zoom_blocks")
              ? []
              : sql.includes("count(DISTINCT b.cell)")
                ? [
                    {
                      media_id: "media-unit-published",
                      frame_width: 6000,
                      frame_height: 4000,
                      cells: 24,
                      listed: completeBlocks ? 24 : 23,
                    },
                  ]
                : blockKeys
                    .slice(0, completeBlocks ? 24 : 23)
                    .map((delivery_key, cell) => ({
                      cell,
                      delivery_key,
                      frame_width: 6000,
                      frame_height: 4000,
                      cells: 24,
                    })),
          };
        },
      );
      const setClient = (pool: unknown, query: unknown) =>
        (
          pool as { connect: { mockResolvedValue(value: unknown): void } }
        ).connect.mockResolvedValue({ query, release: vi.fn() });
      setClient(catalogPool, cmsQuery);
      setClient(appPool, appQuery);
      const queryPort = application.catalogQueryPort;
      if (!queryPort?.getZoomFrames || !queryPort.getZoomBlocks)
        throw new Error("expected actual Catalog zoom read methods");
      const catalogId = "catalog-unit-published" as CatalogId;
      const mediaId = "media-unit-published" as MediaId;
      if (mode === "development") {
        expect(await queryPort.getZoomFrames(catalogId)).toEqual(
          new Map([[mediaId, { width: 6000, height: 4000 }]]),
        );
        expect(await queryPort.getZoomBlocks(catalogId, mediaId)).toEqual({
          width: 6000,
          height: 4000,
          keys: blockKeys,
        });
        expect(
          cmsQuery.mock.calls.some(([sql]) => sql.includes("community.")),
        ).toBe(false);
        expect(
          appQuery.mock.calls.some(([sql]) =>
            sql.includes("community.catalog_media_zoom_blocks"),
          ),
        ).toBe(true);
        expect(
          appQuery.mock.calls.some(([sql]) =>
            /FROM catalog_media\b/u.test(sql),
          ),
        ).toBe(false);
        completeBlocks = false;
        expect((await queryPort.getZoomFrames(catalogId)).size).toBe(0);
        expect(await queryPort.getZoomBlocks(catalogId, mediaId)).toBeNull();
        liveMedia = false;
        const appReads = appQuery.mock.calls.length;
        expect((await queryPort.getZoomFrames(catalogId)).size).toBe(0);
        expect(await queryPort.getZoomBlocks(catalogId, mediaId)).toBeNull();
        expect(appQuery).toHaveBeenCalledTimes(appReads);
      } else {
        // The existing Production switch/delivery gate remains closed by default.
        expect((await queryPort.getZoomFrames(catalogId)).size).toBe(0);
        expect(await queryPort.getZoomBlocks(catalogId, mediaId)).toBeNull();
        expect(cmsQuery).not.toHaveBeenCalled();
        expect(appQuery).not.toHaveBeenCalled();
      }
      // The rendition facts ask the same CMS, on the pool itself, about the
      // exact pair only; a pair that is not live never reaches the App.
      const poolQuery = (pool: unknown) =>
        (
          pool as {
            query: ReturnType<
              typeof vi.fn<
                (
                  sql: string,
                  values?: readonly unknown[],
                ) => Promise<{ rows: readonly unknown[] }>
              >
            >;
          }
        ).query;
      poolQuery(catalogPool).mockImplementation(cmsQuery);
      const projections = () =>
        poolQuery(appPool).mock.calls.filter(([sql]) =>
          sql.includes("community.catalog_media_assets"),
        );
      const pair = { mediaId, objectKey: database.mediaKey };
      liveMedia = true;
      const cmsReads = cmsQuery.mock.calls.length;
      await application.storageUrlResolver!.catalogFacts!([pair]);
      expect(cmsQuery.mock.calls.slice(cmsReads)).toEqual([
        [publishedCatalogPairsSql, [[mediaId], [database.mediaKey]]],
      ]);
      expect(projections().map(([, values]) => values)).toEqual([
        [JSON.stringify([pair])],
      ]);
      liveMedia = false;
      expect(
        await application.storageUrlResolver!.catalogFacts!([pair]),
      ).toEqual(new Map());
      expect(projections()).toHaveLength(1);
      const renditionId = `media-rendition-${"7".repeat(32)}`;
      const named = await application.storageUrlResolver?.resolveKeys?.([
        renditionId,
      ]);
      if (mode === "development") {
        // The Development resolver names this Backend's listener (3001 by default).
        expect(named?.get(renditionId)).toBe(
          `http://127.0.0.1:3001/v1/development/catalog-renditions/${renditionId}`,
        );
        expect(application.developmentCatalogRenditions?.store).toBe(
          media.store,
        );
      } else {
        // Production Catalog rendition delivery stays off in increment 1.
        expect(named?.size).toBe(0);
        expect(application.developmentCatalogRenditions).toBeUndefined();
      }
      await prepared.closeResources();
    },
  );

  it("composes Production business and notification services without Development media fallback", async () => {
    const queue = quietQueue();
    const notificationClaim = queue.notificationClaim;
    const transport = { request: vi.fn() };
    const prepared = await prepareProductionBackend(environment, {
      publishingCosTransport: transport,
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
    expect(queue.claim).toHaveBeenCalled();
    expect(openProductionPublishingStore).toHaveBeenCalledTimes(1);
    expect(openProductionPublishingStore).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: environment.WORK_MEDIA_COS_BUCKET }),
      { transport },
    );
    expect(transport.request).not.toHaveBeenCalled();
    const [application] = vi
      .mocked(createBackendApplication)
      .mock.calls.at(-1)!;
    expect(application.publishingTransfers).toBeDefined();
    expect(application.workPublishingPort).toBeDefined();
    expect(createPublishingJobHandlers).toHaveBeenCalledTimes(1);
    expect(application.publishingMediaStore).toBe(productionStore);
    // Uploads are accepted; the separate media worker processes them.
    await expect(
      application.publishingMediaProcessor?.process(
        {} as Parameters<
          NonNullable<typeof application.publishingMediaProcessor>["process"]
        >[0],
      ),
    ).rejects.toMatchObject({ name: "MediaProcessingUnavailableError" });
    expect(application.notificationPort).toBeDefined();
    expect(application.authorCommunityPort).toBeDefined();
    expect(application.articleAuthoringPort).toBeDefined();
    expect(application.authService).toBeUndefined();
    expect(application.agentAdministrationPort).toBeUndefined();
    expect(application.articleDelegation).toBeUndefined();
  });
});
