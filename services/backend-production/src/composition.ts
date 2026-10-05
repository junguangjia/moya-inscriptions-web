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
  PostgresDirectMessageAdapter,
  PostgresPublishingOperatorAdapter,
  PostgresWorkPublishingAdapter,
  resolveCatalogRenditionRead,
  verifyCatalogDeliveryReadable,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { loadPilotConfiguration, openPilotPool } from "./pilot-config.js";
import { articleBackendConfigurationFrom } from "./article-authoring/runtime-config.js";
import { parseCommunityPostgresConfig } from "./community-postgres-config.js";
import {
  createArticleDelegationPersistence,
  createArticleDelegationRuntime,
} from "./article-authoring/delegation-composition.js";
import { createArticleReadPort } from "./article-authoring/read-composition.js";
import {
  CATALOG_SYNC_INTERVAL_MS,
  createCatalogRenderer,
  createCatalogSync,
  listPublishedCatalogSources,
} from "./publishing/catalog.js";
import {
  openPublishingMedia,
  openPublishingStore,
  openProductionPublishingStore,
  parseMediaWorkerMode,
  parsePublishingMediaConfig,
  parsePublishingStoreDirectory,
  parseProductionPublishingStoreConfig,
} from "./publishing/config.js";
import { externalPublishingProcessor } from "./publishing/external-processor.js";
import {
  UPLOAD_COUPLED_JOB_KINDS,
  createPublishingJobHandlers,
} from "./publishing/job-handlers.js";
import { PublishingWorker } from "./publishing/worker.js";
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
  if (
    runtimeConfig.nodeEnv !== "production" &&
    runtimeConfig.nodeEnv !== "development"
  ) {
    throw new Error(
      "NODE_ENV must be production or development for this backend",
    );
  }
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
  // Catalog readers on the published read connection join the community
  // rendition delivery view (unified media pipeline, PR 1b) wherever the
  // post-Community public read grant exists: every runtime except the Pilot,
  // whose dedicated database and resolver deliver no rendition. Discovery
  // cards join the view through the App role in every runtime, the Pilot
  // included. Startup verifies both grants, so a missing grant stops startup
  // instead of failing Catalog or discovery reads.
  const catalogReaders = { renditions: pilot === undefined };
  // Where media processing runs (W2): Production always leaves it to the
  // separate media worker and opens only the COS store; Development hosts it
  // in this process by default (`embedded`) with the same sandbox runner.
  const mediaWorkerMode = parseMediaWorkerMode(
    environment,
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
  const catalogUrlResolver: StorageUrlResolver =
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
    await assertPostgresStartupReady(pool, contentSource, catalogReaders);
  } catch (error) {
    await closePostgresPool(pool);
    throw error;
  }

  // The community namespace is reached only through the separate App role;
  // startup verifies its migration ledger read-only and never runs DDL.
  const communityPool = createPostgresPool(communityPostgresConfig, {
    onUnexpectedIdleError,
  });
  const articleControlPool =
    articleConfiguration === null
      ? undefined
      : createPostgresPool(articleConfiguration.controlPostgres, {
          onUnexpectedIdleError,
        });
  const workPublishingPort = new PostgresWorkPublishingAdapter(communityPool);
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
            concurrency: publishing.concurrency,
            ...(catalogSources
              ? {
                  extraMaintenance: [
                    {
                      label: "catalog sync",
                      intervalMs: CATALOG_SYNC_INTERVAL_MS,
                      run: createCatalogSync({
                        listSources: () => listPublishedCatalogSources(pool),
                        port: workPublishingPort,
                      }).run,
                    },
                  ],
                }
              : {}),
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
  const notificationSignals = new NotificationSignals();
  const notificationPort = new PostgresNotificationAdapter(communityPool);
  const notificationWorker = notificationPort
    ? new NotificationWorker(notificationPort, (ids) =>
        notificationSignals.publish(ids),
      )
    : undefined;
  const closeResources = async (): Promise<void> => {
    // Running jobs finish or give their leases back before the pools close.
    await notificationWorker?.stop();
    await publishingWorker?.stop();
    await Promise.all([
      closePostgresPool(pool),
      closePostgresPool(communityPool),
      ...(articleControlPool === undefined
        ? []
        : [closePostgresPool(articleControlPool)]),
    ]);
  };
  try {
    await verifyCommunityMigrationLedger(communityPool);
    // Discovery cards join the Catalog rendition delivery view (PR 1b).
    await verifyCatalogDeliveryReadable(communityPool);
  } catch (error) {
    await closeResources();
    throw error;
  }

  const catalogQueryPort = new PostgresCatalogQueryAdapter(
    pool,
    catalogReaders,
  );
  const communityIdentityPort = new PostgresCommunityIdentityAdapter(
    communityPool,
    { requireProductionSession: runtimeConfig.nodeEnv === "production" },
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
  const articleAdapter = new PostgresArticleAuthoringAdapter(
    communityPool,
    articlePersistence?.adapterOptions,
  );
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
    requestListener: createBackendApplication({
      nodeEnv: runtimeConfig.nodeEnv,
      catalogQueryPort,
      catalogSearchQueryPort: catalogQueryPort,
      storageUrlResolver: catalogUrlResolver,
      healthReadinessCheck: readinessCheck,
      communityIdentityPort,
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
              ...(authRequestSource === undefined ? {} : { authRequestSource }),
            };
      })(),
      communityCommentPort,
      ...(notificationPort ? { notificationPort, notificationSignals } : {}),
      ...{
        ...(articleAdapter === undefined
          ? {}
          : {
              articleAuthoringPort: articleAdapter,
              ...(articleDelegation === undefined ? {} : { articleDelegation }),
              articlePublicationOperatorPort: articleAdapter,
            }),
        discussionPort: communityCommentPort,
        contentOperatorPort: new PostgresCommunityContentOperatorAdapter(
          communityPool,
        ),
        discoveryPort: new PostgresCommunityDiscoveryAdapter(communityPool),
        // Published editorial views through the public read role.
        editorialContentPort: createArticleReadPort(
          pool,
          communityPool,
          catalogUrlResolver,
          catalogReaders,
        ),
        threadPort: new PostgresThreadAdapter(communityPool),
        directMessagePort: new PostgresDirectMessageAdapter(communityPool),
        authorCommunityPort: new PostgresAuthorCommunityAdapter(communityPool),
        ...(workPublishingPort && publishingTransfers
          ? { workPublishingPort, publishingTransfers }
          : {}),
        publishingOperatorPort: new PostgresPublishingOperatorAdapter(
          communityPool,
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
                  resolveCatalogRenditionRead(communityPool, renditionId, pool),
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
              result.rows.map((row) => row.catalog_id as (typeof ids)[number]),
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
    closeResources,
    startBackgroundWork: () => {
      publishingWorker?.start();
      notificationWorker?.start();
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
