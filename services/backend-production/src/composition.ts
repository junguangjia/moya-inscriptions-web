import { PrivateReportingEvidenceStore } from "./reporting/evidence-store.js";
import { loadOfflineIpLocation } from "./reporting/geography.js";
import {
  ReportingMaintenanceWorker,
  createUrgentReportSender,
} from "./reporting/worker.js";
import { PostgresCommunityReportingAdapter } from "@moya/community-postgres";
import { parseAnalyticsConfiguration } from "./analytics/config.js";
import { AnalyticsWorker } from "./analytics/worker.js";
import { PostgresAnalyticsAdapter } from "@moya/community-postgres";
import path from "node:path";

import { PostgresNotificationAdapter } from "@moya/community-postgres";
import { NotificationSignals } from "@moya/backend-runtime";
import { NotificationWorker } from "./notifications/worker.js";
import {
  createConfiguredProductionAuthService,
  loadProductionAuthConfiguration,
} from "./auth/index.js";
import type { AuthProviderDependencies } from "./auth/index.js";
import {
  createBackendApplication,
  createArticleAuthoringService,
  createArticleCatalogReadCallbacks,
  readBoundedArticleThumbnail,
  createDevelopmentAuthService,
  createTrustedAuthRequestSource,
  createPublishingTransferRegistry,
  parseRuntimeConfig,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  asPostgresOperationError,
  assertCatalogPrepareReaderReady,
  assertCatalogPublicationScopeReady,
  assertPostgresStartupReady,
  checkPostgresReadiness,
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
} from "@moya/catalog-postgres";
import {
  createWrapperStore,
  selectOwnArticleThumbnail,
  PostgresAgentAdministrationAdapter,
  PostgresArticleAuthoringAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresAuthorCommunityAdapter,
  PostgresCommunityDiscoveryAdapter,
  PostgresCommunityCommentAdapter,
  PostgresCommunityAuthAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresThreadAdapter,
  PostgresFeedbackAdapter,
  PostgresDirectMessageAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
  PostgresMediaPublicationAdapter,
  catalogMembershipStore,
  resolveCatalogRenditionRead,
  verifyCatalogDeliveryReadable,
  verifyCommunityMigrationLedger,
  createPostgresBetaAccountAccess,
} from "@moya/community-postgres";
import { loadProductAccess } from "./access/product-access.js";
import {
  parsePublicationConfig,
  allowsPublication,
  allowsEdgeDelivery,
} from "./publication/config.js";
import { publishedObjectUrl } from "./publication/keys.js";
import { withPublishedReads } from "./publication/delivery.js";
import { createPublicationWorkers } from "./publication/runtime.js";
import { createCatalogZoomGate } from "./publication/worker.js";
import { createLocalPublicationReadHandler } from "./publication/local-read.js";
import { loadPilotConfiguration, openPilotPool } from "./pilot-config.js";
import { articleBackendConfigurationFrom } from "./article-authoring/runtime-config.js";
import { parseCommunityPostgresConfig } from "./community-postgres-config.js";
import {
  createArticleDelegationPersistence,
  createArticleDelegationRuntime,
} from "./article-authoring/delegation-composition.js";
import { createArticleReadPort } from "./article-authoring/read-composition.js";
import {
  CATALOG_MEMBERSHIP_INTERVAL_MS,
  CATALOG_SYNC_INTERVAL_MS,
  createCatalogBlockRenderer,
  createCatalogMembershipWatch,
  createCatalogRenderer,
  createCatalogSync,
  listPublishedCatalogSources,
} from "./publishing/catalog.js";
import {
  MEDIA_CATALOG_ZOOM_BLOCKS,
  MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
  MEDIA_PROFILE_RENDER,
  MEDIA_PROFILE_RENDITIONS,
  openPublishingMedia,
  openPublishingStore,
  openProductionPublishingStore,
  parseCatalogZoomSwitch,
  parseMediaWorkerMode,
  parseProfileMediaSwitch,
  parsePublishingMediaConfig,
  parsePublishingStoreDirectory,
  parseProductionPublishingStoreConfig,
} from "./publishing/config.js";
import { externalPublishingProcessor } from "./publishing/external-processor.js";
import {
  UPLOAD_COUPLED_JOB_KINDS,
  MEDIA_WORKER_JOB_KINDS,
  PROFILE_RENDER_JOB_KINDS,
  createPublishingJobHandlers,
} from "./publishing/job-handlers.js";
import {
  PROFILE_SWEEP_INTERVAL_MS,
  createProfileRenderer,
  createProfileSweep,
} from "./publishing/profile.js";
import { PublishingWorker } from "./publishing/worker.js";
import {
  parseCatalogPrepareDatabaseConfig,
  readCatalogSourceSnapshot,
  createCatalogPublicationAuthority,
  createCatalogDeliveryFacts,
  createCatalogReadiness,
  createCatalogPublishedRenditions,
  currentCatalogRecipePolicy,
} from "./publishing/catalog-delivery-intents.js";
import { LocalCatalogSourceReader } from "./storage/catalog-source.js";
import { createLocalStorageUrlResolver } from "./storage/local-media.js";
import {
  ProductionCosStorageUrlResolver,
  productionCosOptions,
} from "./storage/production-cos.js";

import type {
  BackendProcessHandle,
  RuntimeConfig,
  RuntimeEnvironment,
} from "@moya/backend-runtime";
import type { PublishingMediaStoreRuntime } from "./publishing/config.js";
import type { PublishingCosTransport } from "./storage/publishing-cos-transport.js";
import type { RequestListener } from "node:http";

export interface PreparedProductionBackend {
  readonly closeResources: () => Promise<void>;
  readonly readinessCheck: () => Promise<void>;
  readonly requestListener: RequestListener;
  readonly runtimeConfig: RuntimeConfig;
  /**
   * Starts notifications and, when media is configured, publishing work
   * once the listener is up.
   * `closeResources` stops it (bounded) before the pools close.
   */
  readonly startBackgroundWork: () => void;
}

/** The Catalog media URL port the public application reads through. */
type StorageUrlResolver = NonNullable<
  Parameters<typeof createBackendApplication>[0]["storageUrlResolver"]
>;

const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const isLocalYoyiDevUrl = (url: URL): boolean =>
  loopback.has(url.hostname) &&
  url.pathname === "/yoyi_dev" &&
  !url.hash &&
  [...url.searchParams].every(
    ([key, value]) => key === "sslmode" && value === "disable",
  );

const databaseUser = (url: URL): string => {
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error("Local database users are invalid");
  }
};

const assertLocalDevelopmentDatabase = (
  environment: RuntimeEnvironment,
  host: string,
): void => {
  parsePostgresConfig({
    DATABASE_URL: environment.CMS_DATABASE_URL,
    DATABASE_SSL_CA_FILE: environment.CMS_DATABASE_SSL_CA_FILE,
  });
  const backendUrl = new URL(environment.DATABASE_URL!);
  // Inspect the original URLs: the generic parser removes validated sslmode.
  // pg-connection-string permits query fields to override host, port and user.
  const cmsUrl = new URL(environment.CMS_DATABASE_URL!);
  const appUrl = new URL(environment.APP_DATABASE_URL!);
  const users = [backendUrl, cmsUrl, appUrl].map(databaseUser);
  if (
    !loopback.has(host) ||
    ![backendUrl, cmsUrl, appUrl].every(isLocalYoyiDevUrl) ||
    backendUrl.hostname !== cmsUrl.hostname ||
    backendUrl.hostname !== appUrl.hostname ||
    (backendUrl.port || "5432") !== (cmsUrl.port || "5432") ||
    (backendUrl.port || "5432") !== (appUrl.port || "5432") ||
    new Set(users).size !== users.length
  )
    throw new Error(
      "Local Backend, Admin and App roles must use the same loopback yoyi_dev database with different users",
    );
};

/**
 * The Owner's operator credential. It is optional: without it the loopback-only
 * internal subpath rejects every request, so a missing value fails closed
 * instead of opening the moderation boundary.
 */
const parseOperatorCredential = (environment: RuntimeEnvironment): string => {
  const value = environment.COMMUNITY_OPERATOR_TOKEN;
  if (value === undefined || value === "") return "";
  if (value.trim() !== value || value.length < 32 || value.length > 512)
    throw new Error(
      "COMMUNITY_OPERATOR_TOKEN must be 32 to 512 characters without surrounding whitespace",
    );
  return value;
};

/** Code-only low-level dependencies for isolated acceptance; main uses real transports. */
export interface ProductionBackendDependencies {
  readonly publishingCosTransport?: PublishingCosTransport;
  readonly authProvider?: AuthProviderDependencies;
}

export const prepareProductionBackend = async (
  environment: RuntimeEnvironment,
  dependencies: ProductionBackendDependencies = {},
): Promise<PreparedProductionBackend> => {
  const runtimeConfig = parseRuntimeConfig(environment);
  const catalogPrepareConfiguration =
    parseCatalogPrepareDatabaseConfig(environment);
  const analyticsConfiguration = parseAnalyticsConfiguration(
    environment,
    runtimeConfig.nodeEnv,
  );
  if (
    runtimeConfig.nodeEnv !== "production" &&
    runtimeConfig.nodeEnv !== "development"
  ) {
    throw new Error(
      "NODE_ENV must be production or development for this backend",
    );
  }
  // Who may reach product content is decided before anything is opened.
  let productAccess = loadProductAccess(environment, runtimeConfig.nodeEnv);
  const publicationConfig = parsePublicationConfig(
    environment,
    runtimeConfig.nodeEnv,
    productAccess.mode === "public" ? "public" : "closed-beta",
  );
  const allowPublish = () => allowsPublication(publicationConfig);
  const isPublic = () => productAccess.mode === "public";
  const authConfiguration =
    runtimeConfig.nodeEnv === "production"
      ? await loadProductionAuthConfiguration(environment)
      : null;
  // Validate source authority before opening pools, independently of user and Owner roles.
  const authRequestSource =
    authConfiguration === null
      ? undefined
      : createTrustedAuthRequestSource(environment.AUTH_SOURCE_RELAY_TOKEN);
  if (
    authRequestSource !== undefined &&
    environment.AUTH_SOURCE_RELAY_TOKEN === environment.COMMUNITY_OPERATOR_TOKEN
  )
    throw new Error(
      "AUTH_SOURCE_RELAY_TOKEN: must be separate from Owner authority",
    );
  const articleConfiguration = articleBackendConfigurationFrom(
    environment,
    runtimeConfig,
  );
  const contentSource = environment.MOYA_CONTENT_SOURCE ?? "legacy";
  if (contentSource !== "legacy" && contentSource !== "payload")
    throw new Error("MOYA_CONTENT_SOURCE must be legacy or payload");
  const hasPilotConfiguration =
    environment.MOYA_PILOT_SCOPE_FILE !== undefined ||
    environment.MOYA_PILOT_MEDIA_FILE !== undefined;
  if (
    runtimeConfig.nodeEnv === "development" &&
    (contentSource !== "payload" || hasPilotConfiguration)
  )
    throw new Error(
      "Local development requires Payload without Pilot configuration",
    );
  const postgresConfig = parsePostgresConfig(environment);
  const communityPostgresConfig = parseCommunityPostgresConfig(environment);
  if (runtimeConfig.nodeEnv === "development")
    assertLocalDevelopmentDatabase(environment, runtimeConfig.host);
  const pilot = hasPilotConfiguration
    ? await loadPilotConfiguration(environment)
    : undefined;
  // Resolver configuration fails before opening the database pool. Only
  // published database projections can supply keys to the public read service.
  // Development names Catalog renditions on this Backend's own listener.
  const storageUrlResolver = pilot
    ? pilot.storage.createStorageUrlResolver()
    : runtimeConfig.nodeEnv === "development"
      ? createLocalStorageUrlResolver(environment, runtimeConfig)
      : new ProductionCosStorageUrlResolver(productionCosOptions(environment));
  // CMS supplies only current published Catalog metadata. Rendition and block
  // facts stay on the separate App connection; no CMS/community cross-DB join
  // or extra CMS grant is needed. The Pilot still delivers no renditions.
  const catalogReaders = { renditions: false };
  // Where media processing runs (W2): Production always leaves it to the
  // separate media worker and opens only the COS store; Development hosts it
  // in this process by default (`embedded`) with the same sandbox runner.
  const mediaWorkerMode = parseMediaWorkerMode(
    environment,
    runtimeConfig.nodeEnv,
  );
  // Profile image renditions (increment 3a): this Backend emits them on
  // AuthorMedia while MEDIA_PROFILE_RENDITIONS is on; only an embedded
  // worker (Development) also renders them, behind MEDIA_PROFILE_RENDER,
  // which the separate media worker reads otherwise.
  const profileRenditions = parseProfileMediaSwitch(
    environment,
    MEDIA_PROFILE_RENDITIONS,
    runtimeConfig.nodeEnv,
  );
  const profileRender =
    mediaWorkerMode === "embedded" &&
    parseProfileMediaSwitch(
      environment,
      MEDIA_PROFILE_RENDER,
      runtimeConfig.nodeEnv,
    );
  // Catalog deep zoom (catalog-deep-zoom-v1): this Backend serves the Detail
  // frame and the block-list read behind MEDIA_CATALOG_ZOOM_BLOCKS.
  const catalogZoom = parseCatalogZoomSwitch(
    environment,
    MEDIA_CATALOG_ZOOM_BLOCKS,
    runtimeConfig.nodeEnv,
  );
  // Catalog blocks (catalog-deep-zoom-v1): only an embedded worker
  // (Development) cuts them here, behind MEDIA_CATALOG_ZOOM_BLOCKS_RENDER.
  const blocksRender =
    mediaWorkerMode === "embedded" &&
    parseCatalogZoomSwitch(
      environment,
      MEDIA_CATALOG_ZOOM_BLOCKS_RENDER,
      runtimeConfig.nodeEnv,
    );
  const publishing = await (async (): Promise<{
    readonly store: PublishingMediaStoreRuntime;
    readonly media?: Awaited<ReturnType<typeof openPublishingMedia>>;
    readonly concurrency: number;
  } | null> => {
    if (runtimeConfig.nodeEnv === "production") {
      const config = parseProductionPublishingStoreConfig(environment);
      return {
        store: openProductionPublishingStore(
          config,
          dependencies.publishingCosTransport === undefined
            ? {}
            : { transport: dependencies.publishingCosTransport },
        ),
        concurrency: 1,
      };
    }
    if (mediaWorkerMode === "external") {
      const directory = parsePublishingStoreDirectory(environment);
      return directory === null
        ? null
        : {
            store: await openPublishingStore(directory, {
              foreignDirectories: [environment.CMS_MEDIA_DIR],
            }),
            concurrency: 1,
          };
    }
    const config = parsePublishingMediaConfig(environment);
    if (config === null) return null;
    const media = await openPublishingMedia(config, {
      foreignDirectories: [environment.CMS_MEDIA_DIR],
    });
    return {
      store: media.store,
      media,
      concurrency: config.workerConcurrency,
    };
  })();
  const publishingMedia = publishing?.media;
  // Development names Catalog renditions only where its delivery route is
  // composed (with a local publishing store, below); without one, Catalog
  // media keep the approved image's src rather than a URL that answers 404.
  const resolver: StorageUrlResolver = storageUrlResolver;
  let catalogUrlResolver: StorageUrlResolver =
    runtimeConfig.nodeEnv === "development" && publishing === null
      ? { resolveMany: (locators) => resolver.resolveMany(locators) }
      : resolver;
  const onUnexpectedIdleError = () => {
    console.error("[backend-production] unexpected PostgreSQL pool error");
  };
  const pool = pilot
    ? openPilotPool(environment, pilot.scope)
    : createPostgresPool(postgresConfig, { onUnexpectedIdleError });

  try {
    // Discovery reads the published Payload discovery view through this
    // public read connection (catalog-delivery-release-hardening-v1 N1).
    await assertPostgresStartupReady(pool, contentSource, {
      ...catalogReaders,
      discovery: contentSource === "payload",
    });
  } catch (error) {
    await closePostgresPool(pool);
    throw error;
  }

  // The community namespace is reached only through the separate App role;
  // startup verifies its migration ledger read-only and never runs DDL.
  const communityPool = createPostgresPool(communityPostgresConfig, {
    onUnexpectedIdleError,
  });
  const catalogPreparePool = catalogPrepareConfiguration
    ? createPostgresPool(catalogPrepareConfiguration, { onUnexpectedIdleError })
    : null;
  const publicationPort = new PostgresMediaPublicationAdapter(communityPool, {
    allowPublish,
    isPublic,
    catalogAuthority: createCatalogPublicationAuthority(
      pool,
      catalogPreparePool,
      communityPool,
    ),
  });
  const upstreamCatalogResolver = catalogUrlResolver;
  catalogUrlResolver = {
    resolveMany: (locators) =>
      upstreamCatalogResolver.resolveMany(
        locators.filter(
          (locator) => !locator.objectKey.startsWith("editorial/"),
        ),
      ),
    ...(upstreamCatalogResolver.resolveKeys
      ? { resolveKeys: (keys) => upstreamCatalogResolver.resolveKeys!(keys) }
      : {}),
    // Every reader shares this lookup (Catalog, editorial, authored Article
    // bodies, author cards): the exact check of only the read's own pairs on
    // the public read pool, never the prepare pool and never a listing of
    // the Catalog (catalog-scale-v1 1A). A failed or refused check or App
    // delivery-fact read is Catalog unavailability, the documented 503,
    // never a 500 (catalog-delivery-release-hardening-v1 F9).
    catalogFacts: createCatalogDeliveryFacts(pool, communityPool),
  };
  const deliveryOptions = {
    enabled: () => allowsEdgeDelivery(publicationConfig),
    ...(publicationConfig.origin ? { origin: publicationConfig.origin } : {}),
    lookup: (ids: readonly string[], now: Date) =>
      publicationPort.lookupPublishedItems(ids, now),
  };
  const existingCatalogResolver = catalogUrlResolver;
  if (allowsEdgeDelivery(publicationConfig))
    catalogUrlResolver = {
      resolveMany: (locators) => existingCatalogResolver.resolveMany(locators),
      ...(existingCatalogResolver.catalogFacts
        ? { catalogFacts: existingCatalogResolver.catalogFacts }
        : {}),
      async resolveKeys(keys) {
        if (!allowsEdgeDelivery(publicationConfig))
          return existingCatalogResolver.resolveKeys?.(keys) ?? new Map();
        const published = await publicationPort.lookupPublishedCatalog(
          keys,
          new Date(),
        );
        const urls = new Map<string, string>();
        for (const [key, objectKey] of published)
          urls.set(
            key,
            publishedObjectUrl(publicationConfig.origin!, objectKey),
          );
        return urls;
      },
    };
  const articleControlPool =
    articleConfiguration === null
      ? undefined
      : createPostgresPool(articleConfiguration.controlPostgres, {
          onUnexpectedIdleError,
        });
  const workPublishingPort = new PostgresWorkPublishingAdapter(communityPool, {
    publication: { allowPublish, isPublic },
  });
  // One upload registry shared by the HTTP upload route and the worker: a
  // session the worker expires stops its transfers still streaming here.
  const publishingTransfers = workPublishingPort
    ? createPublishingTransferRegistry()
    : undefined;
  const onUploadsCancelled = (componentIds: readonly string[]) => {
    publishingTransfers?.stop(componentIds);
  };
  // Development embedded mode also renders published Catalog media from the
  // local Payload media directory, like the media worker does in Production.
  const catalogSources =
    publishingMedia && environment.CMS_MEDIA_DIR
      ? new LocalCatalogSourceReader(path.resolve(environment.CMS_MEDIA_DIR))
      : undefined;
  const publishingWorker =
    workPublishingPort && publishingTransfers && publishing
      ? publishingMedia
        ? new PublishingWorker({
            port: workPublishingPort,
            kinds: [
              ...UPLOAD_COUPLED_JOB_KINDS,
              ...MEDIA_WORKER_JOB_KINDS,
              ...(profileRender ? PROFILE_RENDER_JOB_KINDS : []),
            ],
            ...(blocksRender && catalogSources ? { catalogBlocks: true } : {}),
            concurrency: publishing.concurrency,
            extraMaintenance: [
              // Detached, as in the media worker (catalog-scale-v1 W4): a sync
              // of a large Catalog never holds the tick and its job claims;
              // stopping waits for it before the pools close.
              ...(catalogSources
                ? [
                    {
                      label: "catalog sync",
                      intervalMs: CATALOG_SYNC_INTERVAL_MS,
                      run: createCatalogSync({
                        listSources: () => listPublishedCatalogSources(pool),
                        readSnapshot: () =>
                          readCatalogSourceSnapshot(pool, catalogPreparePool),
                        port: workPublishingPort,
                        ...(blocksRender ? { blocks: workPublishingPort } : {}),
                      }).run,
                      detached: true,
                    },
                  ]
                : []),
              // catalog-scale-v1 W8, as in the media worker: wherever the
              // scoped reconcile runs with a Catalog authority (here the
              // publication lanes below, whenever publishing media is set,
              // with the authority always on the published read pool), the
              // per-minute membership step marks its dirty assets (a
              // takedown between syncs or with no sync at all, a lease that
              // passed), from the published read pool, on the App pool. It
              // follows the reconcile, not the sync: without CMS_MEDIA_DIR
              // there is no sync, and the reconcile would otherwise reach a
              // takedown only on the sweep. One instance
              // per process: its memory of its own last observation limits
              // the marks.
              {
                label: "catalog membership",
                intervalMs: CATALOG_MEMBERSHIP_INTERVAL_MS,
                run: createCatalogMembershipWatch({
                  published: pool,
                  prepare: catalogPreparePool,
                  policy: currentCatalogRecipePolicy().recipeManifestSha256,
                  port: catalogMembershipStore(communityPool),
                }).run,
                detached: true,
              },
              ...(profileRender
                ? [
                    {
                      label: "profile sweep",
                      intervalMs: PROFILE_SWEEP_INTERVAL_MS,
                      run: createProfileSweep({ port: workPublishingPort }).run,
                    },
                  ]
                : []),
            ],
            handlers: createPublishingJobHandlers({
              port: workPublishingPort,
              store: publishingMedia.store,
              processor: publishingMedia.processor,
              toolJobs: publishingMedia.sandbox,
              ...(catalogSources
                ? {
                    catalog: {
                      port: workPublishingPort,
                      renderer: createCatalogRenderer({
                        store: publishingMedia.store,
                        sandbox: publishingMedia.sandbox,
                        source: catalogSources,
                      }),
                      ...(blocksRender
                        ? {
                            blocks: {
                              port: workPublishingPort,
                              renderer: createCatalogBlockRenderer({
                                store: publishingMedia.store,
                                sandbox: publishingMedia.sandbox,
                              }),
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(profileRender
                ? {
                    profile: {
                      port: workPublishingPort,
                      renderer: createProfileRenderer({
                        store: publishingMedia.store,
                        sandbox: publishingMedia.sandbox,
                      }),
                    },
                  }
                : {}),
              onUploadsCancelled,
            }),
          })
        : // The media worker processes media; this loop keeps the two kinds
          // coupled to this process's uploads, with the maintenance that
          // schedules them, so sessions expire while the worker is down.
          new PublishingWorker({
            port: workPublishingPort,
            concurrency: 1,
            pollIntervalMs: 5_000,
            kinds: UPLOAD_COUPLED_JOB_KINDS,
            maintenance: { requeue: true, cleanup: true, sweep: true },
            handlers: createPublishingJobHandlers({
              port: workPublishingPort,
              store: publishing.store,
              onUploadsCancelled,
            }),
          })
      : undefined;
  let publicationWorkers: ReturnType<typeof createPublicationWorkers> = [];
  try {
    if (publishingMedia)
      publicationWorkers = createPublicationWorkers({
        config: publicationConfig,
        port: publicationPort,
        queue: workPublishingPort,
        source: publishingMedia.store,
      });
  } catch (error) {
    await Promise.all([
      closePostgresPool(pool),
      closePostgresPool(communityPool),
      ...(catalogPreparePool ? [closePostgresPool(catalogPreparePool)] : []),
      ...(articleControlPool ? [closePostgresPool(articleControlPool)] : []),
    ]);
    throw error;
  }
  const analyticsPort = new PostgresAnalyticsAdapter(communityPool);
  const analyticsWorker = new AnalyticsWorker(
    analyticsPort,
    analyticsConfiguration.umami,
    analyticsConfiguration.policy.eventRetentionDays,
  );
  const ipLocations = await loadOfflineIpLocation(
    environment.MOYA_REPORT_IP_DATABASE,
  );
  const evidenceDirectory = environment.MOYA_REPORT_EVIDENCE_DIRECTORY;
  const reportingEvidenceStore = evidenceDirectory
    ? new PrivateReportingEvidenceStore(evidenceDirectory)
    : undefined;
  const reportingPort = new PostgresCommunityReportingAdapter(communityPool, {
    publication: { allowPublish, isPublic },
    resolveExternalTarget: async (target) => {
      if (target.type === "catalog") {
        const item = await catalogQueryPort.getById(
          target.id as Parameters<typeof catalogQueryPort.getById>[0],
        );
        return item
          ? {
              canonicalPath: `/?catalogId=${encodeURIComponent(target.id)}#detail`,
              affectedUserId: null,
              snapshot: { source: "official", title: item.title },
            }
          : null;
      }
      if (target.type === "article") {
        const item = await editorialReadPort.findArticle(
          target.id as Parameters<typeof editorialReadPort.findArticle>[0],
        );
        return item
          ? {
              canonicalPath: `/?topic=${encodeURIComponent(target.id)}`,
              affectedUserId: null,
              snapshot: { source: "official", title: item.title },
            }
          : null;
      }
      return null;
    },
  });
  const reportingWorker = new ReportingMaintenanceWorker(
    reportingPort,
    createUrgentReportSender(
      authConfiguration?.email ?? null,
      environment.MOYA_REPORT_URGENT_TO,
      environment.MOYA_REPORT_URGENT_TEMPLATE_ID,
      dependencies.authProvider?.transport,
    ),
    reportingEvidenceStore,
  );
  const notificationSignals = new NotificationSignals();
  const notificationPort = new PostgresNotificationAdapter(communityPool);
  const notificationWorker = notificationPort
    ? new NotificationWorker(notificationPort, (ids) =>
        notificationSignals.publish(ids),
      )
    : undefined;
  const closeResources = async (): Promise<void> => {
    // Running jobs finish or give their leases back before the pools close.
    await Promise.all([
      analyticsWorker.stop(),
      reportingWorker.stop(),
      notificationWorker?.stop(),
      publishingWorker?.stop(),
      ...publicationWorkers.map((lane) => lane.stop()),
    ]);
    await Promise.all([
      closePostgresPool(pool),
      closePostgresPool(communityPool),
      ...(catalogPreparePool ? [closePostgresPool(catalogPreparePool)] : []),
      ...(articleControlPool === undefined
        ? []
        : [closePostgresPool(articleControlPool)]),
    ]);
  };
  try {
    await verifyCommunityMigrationLedger(communityPool);
    // Discovery cards join the Catalog rendition delivery view (PR 1b).
    await verifyCatalogDeliveryReadable(communityPool);
    // catalog-scale-v1 W6: the Backend may run publication workers and the
    // reconcile, and its publication authority reads the prepare views: the
    // scoped reconcile's tables and grants (App migration 20261024010000)
    // and, where configured, the prepare reader's grant on both private
    // views (CMS migration M2) are checked as in the media worker.
    await assertCatalogPublicationScopeReady(communityPool);
    if (catalogPreparePool)
      await assertCatalogPrepareReaderReady(catalogPreparePool);
    productAccess = loadProductAccess(environment, runtimeConfig.nodeEnv, {
      betaAccountAccess: createPostgresBetaAccountAccess(communityPool),
    });
  } catch (error) {
    await closeResources();
    throw error;
  }

  // catalog-deep-zoom-v1: the Detail `zoom` frame and the per-image
  // block-list read, behind MEDIA_CATALOG_ZOOM_BLOCKS, only where blocks can
  // be delivered (edge delivery, or Development's relay) and while the
  // breaker is closed. Only the Catalog query port gets the gate: the Detail
  // and its block list, and the article tool's read of that same Detail,
  // which carries the frame only (never a block URL).
  const catalogZoomGate = catalogZoom
    ? createCatalogZoomGate({
        readUsage: () => publicationPort.readDayUsage(),
        edgeDelivery: () => allowsEdgeDelivery(publicationConfig),
        development: runtimeConfig.nodeEnv === "development",
      })
    : undefined;
  const catalogQueryPort = new PostgresCatalogQueryAdapter(pool, {
    ...catalogReaders,
    ...(catalogZoomGate === undefined || pilot
      ? {}
      : { zoom: catalogZoomGate, zoomPool: communityPool }),
  });
  const editorialReadPort = withPublishedReads(
    createArticleReadPort(
      pool,
      communityPool,
      catalogUrlResolver,
      catalogReaders,
    ),
    ["listArticles", "findArticle", "listCollections", "findCollection"],
    deliveryOptions,
  );
  const communityIdentityPort = new PostgresCommunityIdentityAdapter(
    communityPool,
    {
      requireProductionSession: runtimeConfig.nodeEnv === "production",
      publication: { allowPublish, isPublic },
    },
  );
  const communityCommentPort = new PostgresCommunityCommentAdapter(
    communityPool,
  );
  const readinessCheck = async (): Promise<void> => {
    await checkPostgresReadiness(pool);
    await checkPostgresReadiness(communityPool);
    if (articleControlPool !== undefined)
      await checkPostgresReadiness(articleControlPool);
  };
  const articlePersistence =
    articleConfiguration === null || articleControlPool === undefined
      ? undefined
      : createArticleDelegationPersistence(
          articleControlPool,
          articleConfiguration.authorization,
          { readPool: communityPool },
        );
  const articleAdapter = new PostgresArticleAuthoringAdapter(communityPool, {
    ...articlePersistence?.adapterOptions,
    publication: { allowPublish, isPublic },
  });
  const articleService =
    articleConfiguration !== null && articleAdapter !== undefined
      ? createArticleAuthoringService(articleAdapter)
      : undefined;
  const catalogReads = createArticleCatalogReadCallbacks(
    catalogQueryPort,
    catalogUrlResolver,
  );
  const articleDelegation =
    articleConfiguration === null ||
    articlePersistence === undefined ||
    articleAdapter === undefined ||
    articleService === undefined
      ? undefined
      : createArticleDelegationRuntime({
          nodeEnv: runtimeConfig.nodeEnv,
          enabled: true,
          pool: communityPool,
          authority: articleConfiguration.authorization,
          wrappers: {
            resolve: createWrapperStore({
              pool: communityPool,
              keys: articleConfiguration.keys,
              namespace: "article-authoring",
            }).resolve,
          },
          persistence: articlePersistence,
          authoring: articleService,
          humanWebOrigin: articleConfiguration.authorization.consentBaseUrl,
          clients: articleConfiguration.authorization.clients,
          readPublished: (id) => articleAdapter.readPublished(id),
          admitsAccount: (userId) => productAccess.admits(userId),
          discoverCatalog: (_db, _actor, query) =>
            catalogReads.discoverCatalog(query),
          readCatalog: (_db, _actor, id) => catalogReads.readCatalog(id),
          inspectThumbnail: (db, actor, id) =>
            readBoundedArticleThumbnail(publishing?.store, () =>
              selectOwnArticleThumbnail(db, actor.userId, id),
            ),
        });
  return {
    runtimeConfig,
    readinessCheck,
    requestListener: createLocalPublicationReadHandler(
      publicationConfig,
      createBackendApplication({
        catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
        // App facts only: no prepare reader and no CMS connection is needed.
        catalogPublishedRenditions:
          createCatalogPublishedRenditions(communityPool),
        ...(catalogPreparePool
          ? {
              catalogDeliveryReadiness: createCatalogReadiness(
                catalogPreparePool,
                communityPool,
              ),
            }
          : {}),
        nodeEnv: runtimeConfig.nodeEnv,
        analytics: {
          port: analyticsPort,
          policy: analyticsConfiguration.policy,
          ...(analyticsConfiguration.source
            ? { source: analyticsConfiguration.source }
            : {}),
        },
        productAccess,
        catalogQueryPort,
        catalogSearchQueryPort: catalogQueryPort,
        storageUrlResolver: catalogUrlResolver,
        healthReadinessCheck: readinessCheck,
        communityIdentityPort,
        reportingPort,
        ...(reportingEvidenceStore ? { reportingEvidenceStore } : {}),
        ...(ipLocations
          ? {
              onAuthenticated: async (id: string, source: string) => {
                const label = ipLocations.locate(source);
                if (label === null) {
                  await communityPool.query(
                    "UPDATE community.profile_ip_locations SET label=NULL,observed_at=CURRENT_TIMESTAMP WHERE user_id=$1",
                    [id],
                  );
                  return;
                }
                await communityPool.query(
                  "INSERT INTO community.profile_ip_locations(user_id,label,observed_at) VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET label=EXCLUDED.label,observed_at=EXCLUDED.observed_at",
                  [id, label],
                );
              },
            }
          : {}),
        ...(() => {
          const adapter = new PostgresCommunityAuthAdapter(communityPool);
          const authService =
            runtimeConfig.nodeEnv === "production"
              ? authConfiguration === null
                ? null
                : createConfiguredProductionAuthService(
                    adapter,
                    authConfiguration,
                    dependencies.authProvider,
                  )
              : createDevelopmentAuthService(adapter, environment);
          return authService === null
            ? {}
            : {
                authService,
                ...(authRequestSource === undefined
                  ? {}
                  : { authRequestSource }),
              };
        })(),
        communityCommentPort,
        ...(notificationPort ? { notificationPort, notificationSignals } : {}),
        ...{
          ...(articleAdapter === undefined
            ? {}
            : {
                articleAuthoringPort: articleAdapter,
                ...(articleDelegation === undefined
                  ? {}
                  : { articleDelegation }),
                articlePublicationOperatorPort: articleAdapter,
              }),
          discussionPort: communityCommentPort,
          contentOperatorPort: new PostgresCommunityContentOperatorAdapter(
            communityPool,
            { publication: { allowPublish, isPublic } },
          ),
          discoveryPort: withPublishedReads(
            new PostgresCommunityDiscoveryAdapter(communityPool, {
              catalogPool: pool,
            }),
            ["browse", "collection", "card"],
            deliveryOptions,
          ),
          // Published editorial views through the public read role.
          editorialContentPort: editorialReadPort,
          threadPort: withPublishedReads(
            new PostgresThreadAdapter(communityPool),
            ["listThreadPosts"],
            deliveryOptions,
          ),
          directMessagePort: new PostgresDirectMessageAdapter(communityPool),
          feedbackPort: new PostgresFeedbackAdapter(communityPool),
          authorCommunityPort: withPublishedReads(
            new PostgresAuthorCommunityAdapter(communityPool, {
              profileRenditions,
            }),
            ["readWork", "listWorks"],
            deliveryOptions,
          ),
          ...(workPublishingPort && publishingTransfers
            ? { workPublishingPort, publishingTransfers }
            : {}),
          publishingOperatorPort: new PostgresPublishingOperatorAdapter(
            communityPool,
            { publication: { allowPublish, isPublic } },
          ),
          ...(runtimeConfig.nodeEnv === "development"
            ? {
                agentAdministrationPort: new PostgresAgentAdministrationAdapter(
                  communityPool,
                ),
              }
            : {}),
          ...(publishing
            ? {
                publishingMediaStore: publishing.store,
                publishingMediaProcessor:
                  publishingMedia?.processor ?? externalPublishingProcessor,
              }
            : {}),
          // Development delivery of Catalog renditions: the local store's
          // committed blob of a rendition the delivery view lists, behind the
          // URLs the Development resolver names. Development here is already
          // synthetic with local storage (the local resolver refuses anything
          // else at startup); Production never composes it.
          ...(runtimeConfig.nodeEnv === "development" && publishing
            ? {
                developmentCatalogRenditions: {
                  resolve: (renditionId: string) =>
                    resolveCatalogRenditionRead(
                      communityPool,
                      renditionId,
                      pool,
                    ),
                  store: publishing.store,
                },
              }
            : {}),
        },
        // A comment attaches only to a currently published Catalog record; the
        // published read role answers that, so the App role needs no Catalog grant.
        catalogPublicationPort: {
          isPublished: async (catalogId) =>
            (await catalogQueryPort.getById(catalogId)) !== null,
          // One statement over the same published projection getById reads.
          publishedIds: async (ids) => {
            try {
              const result = await pool.query<{ catalog_id: string }>(
                "SELECT catalog_id FROM catalog_entries WHERE catalog_id = ANY($1::text[])",
                [[...ids]],
              );
              return new Set(
                result.rows.map(
                  (row) => row.catalog_id as (typeof ids)[number],
                ),
              );
            } catch (error) {
              throw asPostgresOperationError(error, "query");
            }
          },
          readTitle: async (catalogId) =>
            (await catalogQueryPort.getById(catalogId))?.title ?? null,
        },
        communityOperatorCredential: parseOperatorCredential(environment),
      }),
    ),
    closeResources,
    startBackgroundWork: () => {
      publishingWorker?.start();
      publicationWorkers.forEach((lane) => lane.start());
      if (runtimeConfig.nodeEnv === "production") analyticsWorker.start();
      notificationWorker?.start();
      reportingWorker.start();
    },
  };
};

export const startProductionBackend = async (
  environment: RuntimeEnvironment,
): Promise<BackendProcessHandle> => {
  const prepared = await prepareProductionBackend(environment);
  const handle = await startBackendProcess({
    closeResources: prepared.closeResources,
    listen: prepared.runtimeConfig,
    requestListener: prepared.requestListener,
  });
  prepared.startBackgroundWork();
  return handle;
};
