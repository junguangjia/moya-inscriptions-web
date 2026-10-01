import { PostgresNotificationAdapter } from "@moya/community-postgres";
import { NotificationSignals } from "@moya/backend-runtime";
import { NotificationWorker } from "./notifications/worker.js";
import {
  assertProductionAuthConfiguration,
  createBackendApplication,
  createDevelopmentAuthService,
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
  PostgresEditorialContentAdapter,
} from "@moya/catalog-postgres";
import {
  PostgresAgentAdministrationAdapter,
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
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { loadPilotConfiguration, openPilotPool } from "./pilot-config.js";
import {
  openPublishingMedia,
  parsePublishingMediaConfig,
} from "./publishing/config.js";
import { createPublishingJobHandlers } from "./publishing/job-handlers.js";
import { PublishingWorker } from "./publishing/worker.js";
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
import type { PostgresConfig } from "@moya/catalog-postgres";
import type { RequestListener } from "node:http";

export interface PreparedProductionBackend {
  readonly closeResources: () => Promise<void>;
  readonly readinessCheck: () => Promise<void>;
  readonly requestListener: RequestListener;
  readonly runtimeConfig: RuntimeConfig;
  /**
   * Starts background work once the listener is up: the Development
   * publishing worker when publishing media is configured, otherwise nothing.
   * `closeResources` stops it (bounded) before the pools close.
   */
  readonly startBackgroundWork: () => void;
}

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

/** The Community App role is read at runtime only here and is DML-only. */
const parseCommunityPostgresConfig = (
  environment: RuntimeEnvironment,
): PostgresConfig => {
  const url = environment.APP_DATABASE_URL;
  if (url === undefined || url === "")
    throw new Error("APP_DATABASE_URL is required");
  try {
    return parsePostgresConfig({
      DATABASE_URL: url,
      DATABASE_SSL_CA_FILE: environment.APP_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
      DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message.replace(/\bDATABASE_URL\b/g, "APP_DATABASE_URL")
        : "APP_DATABASE_URL is invalid",
      { cause: error },
    );
  }
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

export const prepareProductionBackend = async (
  environment: RuntimeEnvironment,
): Promise<PreparedProductionBackend> => {
  const runtimeConfig = parseRuntimeConfig(environment);
  assertProductionAuthConfiguration(environment);
  if (
    runtimeConfig.nodeEnv !== "production" &&
    runtimeConfig.nodeEnv !== "development"
  ) {
    throw new Error(
      "NODE_ENV must be production or development for this backend",
    );
  }
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
  const storageUrlResolver = pilot
    ? pilot.storage.createStorageUrlResolver()
    : runtimeConfig.nodeEnv === "development"
      ? createLocalStorageUrlResolver(environment)
      : new ProductionCosStorageUrlResolver(productionCosOptions(environment));
  // Development work publishing media (design §9.6). Without its keys the
  // Backend still starts and publishing uploads answer 503; a partial or
  // unusable configuration fails here, before any pool opens. Production
  // never reads these keys.
  const publishingMediaConfig =
    runtimeConfig.nodeEnv === "development"
      ? parsePublishingMediaConfig(environment)
      : null;
  const publishingMedia = publishingMediaConfig
    ? await openPublishingMedia(publishingMediaConfig, {
        foreignDirectories: [environment.CMS_MEDIA_DIR],
      })
    : undefined;
  const onUnexpectedIdleError = () => {
    console.error("[backend-production] unexpected PostgreSQL pool error");
  };
  const pool = pilot
    ? openPilotPool(environment, pilot.scope)
    : createPostgresPool(postgresConfig, { onUnexpectedIdleError });

  try {
    await assertPostgresStartupReady(pool, contentSource);
  } catch (error) {
    await closePostgresPool(pool);
    throw error;
  }

  // The community namespace is reached only through the separate App role;
  // startup verifies its migration ledger read-only and never runs DDL.
  const communityPool = createPostgresPool(communityPostgresConfig, {
    onUnexpectedIdleError,
  });
  const workPublishingPort =
    runtimeConfig.nodeEnv === "development"
      ? new PostgresWorkPublishingAdapter(communityPool)
      : undefined;
  // One upload registry shared by the HTTP upload route and the worker: a
  // session the worker expires stops its transfers still streaming here.
  const publishingTransfers = workPublishingPort
    ? createPublishingTransferRegistry()
    : undefined;
  const publishingWorker =
    workPublishingPort &&
    publishingTransfers &&
    publishingMedia &&
    publishingMediaConfig
      ? new PublishingWorker({
          port: workPublishingPort,
          concurrency: publishingMediaConfig.workerConcurrency,
          handlers: createPublishingJobHandlers({
            port: workPublishingPort,
            store: publishingMedia.store,
            processor: publishingMedia.processor,
            toolJobs: publishingMedia.runner,
            onUploadsCancelled: (componentIds) => {
              publishingTransfers.stop(componentIds);
            },
          }),
        })
      : undefined;
  const notificationSignals = new NotificationSignals();
  const notificationPort =
    runtimeConfig.nodeEnv === "development"
      ? new PostgresNotificationAdapter(communityPool)
      : undefined;
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
    ]);
  };
  try {
    await verifyCommunityMigrationLedger(communityPool);
  } catch (error) {
    await closeResources();
    throw error;
  }

  const catalogQueryPort = new PostgresCatalogQueryAdapter(pool);
  const communityIdentityPort = new PostgresCommunityIdentityAdapter(
    communityPool,
  );
  const communityCommentPort = new PostgresCommunityCommentAdapter(
    communityPool,
  );
  const readinessCheck = async (): Promise<void> => {
    await checkPostgresReadiness(pool);
    await checkPostgresReadiness(communityPool);
  };
  return {
    runtimeConfig,
    readinessCheck,
    requestListener: createBackendApplication({
      nodeEnv: runtimeConfig.nodeEnv,
      catalogQueryPort,
      catalogSearchQueryPort: catalogQueryPort,
      storageUrlResolver,
      healthReadinessCheck: readinessCheck,
      communityIdentityPort,
      ...(() => {
        if (runtimeConfig.nodeEnv !== "development") return {};
        const authService = createDevelopmentAuthService(
          new PostgresCommunityAuthAdapter(communityPool),
          environment,
        );
        return authService === null ? {} : { authService };
      })(),
      communityCommentPort,
      ...(notificationPort ? { notificationPort, notificationSignals } : {}),
      ...(runtimeConfig.nodeEnv === "development"
        ? {
            discussionPort: communityCommentPort,
            contentOperatorPort: new PostgresCommunityContentOperatorAdapter(
              communityPool,
            ),
            discoveryPort: new PostgresCommunityDiscoveryAdapter(communityPool),
            // Published editorial views through the public read role.
            editorialContentPort: new PostgresEditorialContentAdapter(pool),
            threadPort: new PostgresThreadAdapter(communityPool),
            directMessagePort: new PostgresDirectMessageAdapter(communityPool),
            authorCommunityPort: new PostgresAuthorCommunityAdapter(
              communityPool,
            ),
            ...(workPublishingPort && publishingTransfers
              ? { workPublishingPort, publishingTransfers }
              : {}),
            publishingOperatorPort: new PostgresPublishingOperatorAdapter(
              communityPool,
            ),
            agentAdministrationPort: new PostgresAgentAdministrationAdapter(
              communityPool,
            ),
            ...(publishingMedia
              ? {
                  publishingMediaStore: publishingMedia.store,
                  publishingMediaProcessor: publishingMedia.processor,
                }
              : {}),
          }
        : {}),
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
