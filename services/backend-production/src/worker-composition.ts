import path from "node:path";

import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";

import { parseCommunityPostgresConfig } from "./composition.js";
import {
  CATALOG_SYNC_INTERVAL_MS,
  createCatalogRenderer,
  createCatalogSync,
  listPublishedCatalogSources,
} from "./publishing/catalog.js";
import {
  openProductionPublishingMedia,
  openPublishingMedia,
  parseProductionPublishingMediaConfig,
  parsePublishingMediaConfig,
} from "./publishing/config.js";
import {
  MEDIA_WORKER_JOB_KINDS,
  createPublishingJobHandlers,
} from "./publishing/job-handlers.js";
import { PublishingWorker } from "./publishing/worker.js";
import {
  LocalCatalogSourceReader,
  openCosCatalogSourceReader,
  parseCatalogSourceConfig,
} from "./storage/catalog-source.js";

import type {
  PublishingMediaRuntime,
  SandboxRuntimeOptions,
} from "./publishing/config.js";
import type { SandboxRuntime } from "./publishing/sandbox/protocol.js";
import type { CatalogSourceReader } from "./storage/catalog-source.js";
import type { PublishingCosTransport } from "./storage/publishing-cos-transport.js";

/*
 * Composition of the media worker process (`yoyi-media-worker`, W1). It runs
 * the durable publishing queue for every processing and maintenance kind
 * except the two coupled to the Backend's own uploads, renders every job in
 * one media sandbox container, and syncs and renders published Catalog
 * media. It opens no HTTP listener. Startup is fail-closed: configuration or
 * isolation problems exit 78 (no restart), an unreachable container daemon
 * or a missing image exits 75 (retried by the supervisor). Logs are
 * content-free.
 */

export const MEDIA_WORKER_EXIT_CODES = {
  /** Container daemon or image unavailable: the supervisor retries. */
  unavailable: 75,
  /** Configuration or isolation mismatch: the supervisor must not retry. */
  config: 78,
} as const;

/** A startup refusal with the process exit status it maps to. */
export class MediaWorkerStartupError extends Error {
  constructor(
    readonly exitCode: 75 | 78,
    message: string,
  ) {
    super(message);
    this.name = "MediaWorkerStartupError";
  }
}

/** Code-only seams for isolated tests and acceptance; never selected by env. */
export interface MediaWorkerDependencies {
  readonly publishingCosTransport?: PublishingCosTransport;
  readonly catalogCosTransport?: PublishingCosTransport;
  readonly sandbox?: SandboxRuntimeOptions;
  readonly logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}

export interface PreparedMediaWorker {
  readonly concurrency: number;
  readonly runtime: SandboxRuntime;
  readonly catalog: boolean;
  start(): void;
  /** Stops the worker (bounded) and closes its pools. Idempotent. */
  stop(): Promise<void>;
}

/** Job directories untouched this long are crash leftovers (beyond the lease). */
export const MEDIA_WORKER_JOB_SWEEP_AGE_MS = 60 * 60 * 1000;

const configError = (error: unknown): never => {
  throw new MediaWorkerStartupError(
    MEDIA_WORKER_EXIT_CODES.config,
    error instanceof Error
      ? error.message
      : "Media worker configuration invalid",
  );
};

type Environment = Readonly<Record<string, string | undefined>>;

const parseWorkerConfiguration = (environment: Environment) => {
  const nodeEnv = environment.NODE_ENV;
  if (nodeEnv !== "production" && nodeEnv !== "development") {
    throw new Error(
      "NODE_ENV must be production or development for the media worker",
    );
  }
  const media =
    nodeEnv === "production"
      ? {
          production: true as const,
          config: parseProductionPublishingMediaConfig(environment),
        }
      : (() => {
          const config = parsePublishingMediaConfig(environment);
          if (config === null) {
            throw new Error(
              "WORK_MEDIA_STORE_DIR, WORK_MEDIA_TOOLS_IMAGE and WORK_MEDIA_WORK_DIR are required for the media worker",
            );
          }
          return { production: false as const, config };
        })();
  const community = parseCommunityPostgresConfig(environment);
  const catalogSource =
    nodeEnv === "production"
      ? parseCatalogSourceConfig(environment)
      : environment.CMS_MEDIA_DIR
        ? path.resolve(environment.CMS_MEDIA_DIR)
        : null;
  const catalogDatabase =
    catalogSource === null ? null : parsePostgresConfig(environment);
  return { nodeEnv, media, community, catalogSource, catalogDatabase };
};

/**
 * Parses and opens everything, runs the sandbox self-check, removes orphaned
 * sandbox containers and stale job directories, opens the pools and verifies
 * the community migration ledger (read-only). Starts nothing.
 */
export async function prepareMediaWorker(
  environment: Environment,
  dependencies: MediaWorkerDependencies = {},
): Promise<PreparedMediaWorker> {
  const logger = dependencies.logger ?? console;
  let configuration: ReturnType<typeof parseWorkerConfiguration>;
  try {
    configuration = parseWorkerConfiguration(environment);
  } catch (error) {
    return configError(error);
  }
  const { media: mediaConfig } = configuration;
  let media: PublishingMediaRuntime;
  try {
    media = mediaConfig.production
      ? await openProductionPublishingMedia(mediaConfig.config, {
          foreignDirectories: [environment.CMS_MEDIA_DIR],
          ...dependencies.sandbox,
          ...(dependencies.publishingCosTransport === undefined
            ? {}
            : { transport: dependencies.publishingCosTransport }),
        })
      : await openPublishingMedia(mediaConfig.config, {
          foreignDirectories: [environment.CMS_MEDIA_DIR],
          ...dependencies.sandbox,
        });
  } catch (error) {
    return configError(error);
  }
  const catalogSource: CatalogSourceReader | null =
    configuration.catalogSource === null
      ? null
      : typeof configuration.catalogSource === "string"
        ? new LocalCatalogSourceReader(configuration.catalogSource)
        : openCosCatalogSourceReader(
            configuration.catalogSource,
            dependencies.catalogCosTransport,
          );

  const check = await media.sandbox.selfCheck();
  if (check.status === "unavailable") {
    throw new MediaWorkerStartupError(
      MEDIA_WORKER_EXIT_CODES.unavailable,
      `Media sandbox unavailable: ${check.reason}`,
    );
  }
  if (check.status === "mismatch") {
    throw new MediaWorkerStartupError(
      MEDIA_WORKER_EXIT_CODES.config,
      `Media sandbox isolation mismatch: ${check.mismatches.join(",")}`,
    );
  }
  const orphans = await media.sandbox.removeOrphanContainers();
  const swept = await media.sandbox.sweepJobs(
    new Date(Date.now() - MEDIA_WORKER_JOB_SWEEP_AGE_MS),
  );
  if (orphans.removed + swept.removed > 0) {
    logger.info(
      `[media-worker] leftovers removed containers=${orphans.removed} job_directories=${swept.removed}`,
    );
  }

  const onUnexpectedIdleError = () => {
    logger.error("[media-worker] unexpected PostgreSQL pool error");
  };
  const communityPool = createPostgresPool(configuration.community, {
    onUnexpectedIdleError,
  });
  const catalogPool =
    configuration.catalogDatabase === null
      ? null
      : createPostgresPool(configuration.catalogDatabase, {
          onUnexpectedIdleError,
        });
  const closePools = () =>
    Promise.all([
      closePostgresPool(communityPool),
      ...(catalogPool === null ? [] : [closePostgresPool(catalogPool)]),
    ]).then(() => undefined);
  try {
    await verifyCommunityMigrationLedger(communityPool);
  } catch (error) {
    await closePools();
    throw error;
  }
  const port = new PostgresWorkPublishingAdapter(communityPool);
  const catalog =
    catalogSource !== null && catalogPool !== null
      ? {
          renderer: createCatalogRenderer({
            store: media.store,
            sandbox: media.sandbox,
            source: catalogSource,
            logger,
          }),
          sync: createCatalogSync({
            listSources: () => listPublishedCatalogSources(catalogPool),
            port,
            logger,
          }),
        }
      : null;
  const worker = new PublishingWorker({
    port,
    concurrency: mediaConfig.config.workerConcurrency,
    kinds: MEDIA_WORKER_JOB_KINDS,
    // The Backend schedules and claims the staging sweep (W3); lease requeue
    // and cleanup scheduling are idempotent across both processes.
    maintenance: { requeue: true, cleanup: true, reconcile: true },
    extraMaintenance: [
      ...(catalog
        ? [
            {
              label: "catalog sync",
              intervalMs: CATALOG_SYNC_INTERVAL_MS,
              run: catalog.sync.run,
            },
          ]
        : []),
      {
        label: "job directory sweep",
        intervalMs: MEDIA_WORKER_JOB_SWEEP_AGE_MS,
        run: (now: Date) =>
          media.sandbox.sweepJobs(
            new Date(now.getTime() - MEDIA_WORKER_JOB_SWEEP_AGE_MS),
          ),
      },
    ],
    handlers: createPublishingJobHandlers({
      port,
      store: media.store,
      processor: media.processor,
      ...(catalog ? { catalog: { port, renderer: catalog.renderer } } : {}),
      logger,
    }),
    logger,
  });
  let stopping: Promise<void> | null = null;
  return {
    concurrency: mediaConfig.config.workerConcurrency,
    runtime: check.runtime,
    catalog: catalog !== null,
    start: () => worker.start(),
    stop: () => {
      stopping ??= worker.stop().then(closePools);
      return stopping;
    },
  };
}

/** Prepares and starts the worker; logs one content-free ready line. */
export async function startMediaWorker(
  environment: Environment,
  dependencies: MediaWorkerDependencies = {},
): Promise<PreparedMediaWorker> {
  const logger = dependencies.logger ?? console;
  const prepared = await prepareMediaWorker(environment, dependencies);
  prepared.start();
  logger.info(
    `[media-worker] ready concurrency=${prepared.concurrency} sharp=${prepared.runtime.sharp} vips=${prepared.runtime.vips} catalog=${prepared.catalog ? "on" : "off"}`,
  );
  return prepared;
}
