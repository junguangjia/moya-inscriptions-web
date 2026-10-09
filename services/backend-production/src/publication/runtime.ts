import { PublishingWorker } from "../publishing/worker.js";
import type {
  PublishingWorkerPort,
  PublishingWorkerLogger,
} from "../publishing/job-handlers.js";
import type { CosCredentials } from "../storage/cos-read.js";
import { allowsPublication, hasPublicationProviderConfig } from "./config.js";
import type { PublicationConfig } from "./config.js";
import { createLocalPublicationProvider } from "./local-provider.js";
import { createTencentPublicationProvider } from "./tencent-provider.js";
import {
  createPublicationJobHandlers,
  publicationMaintenanceSteps,
  PUBLICATION_WITHDRAW_JOB_KINDS,
  PUBLICATION_PUBLISH_JOB_KINDS,
  PUBLICATION_WITHDRAW_LEASE_MS,
  PUBLICATION_PUBLISH_LEASE_MS,
} from "./worker.js";
import type { PublicationRepository, PublicationSource } from "./worker.js";

/** Two bounded lanes of the existing durable queue, inside the existing supervised process. */
export const createPublicationWorkers = (options: {
  readonly config: PublicationConfig;
  readonly port: PublicationRepository;
  readonly queue: PublishingWorkerPort;
  readonly source: PublicationSource;
  readonly ugcCredentials?: () => Promise<CosCredentials>;
  readonly logger?: PublishingWorkerLogger;
}): readonly PublishingWorker[] => {
  const { config, port, queue, source, logger } = options;
  const allowPublish = () => allowsPublication(config);
  const provider = !hasPublicationProviderConfig(config)
    ? undefined
    : config.nodeEnv === "development" && config.localRoot
      ? createLocalPublicationProvider(config)
      : options.ugcCredentials
        ? createTencentPublicationProvider(config, {
            credentials: options.ugcCredentials,
          })
        : (() => {
            throw new Error("Media publisher UGC identity is unavailable");
          })();
  const shared = {
    port,
    queue,
    source,
    allowPublish,
    ...(provider ? { provider } : {}),
    ...(config.origin ? { origin: config.origin } : {}),
    ...(logger ? { logger } : {}),
  };
  const handlers = createPublicationJobHandlers(shared);
  return [
    new PublishingWorker({
      port: queue,
      handlers,
      concurrency: 1,
      kinds: PUBLICATION_WITHDRAW_JOB_KINDS,
      leaseMs: PUBLICATION_WITHDRAW_LEASE_MS,
      maintenance: false,
      extraMaintenance: publicationMaintenanceSteps(queue, shared),
      ...(logger ? { logger } : {}),
    }),
    new PublishingWorker({
      port: queue,
      handlers,
      concurrency: 1,
      kinds: PUBLICATION_PUBLISH_JOB_KINDS,
      leaseMs: PUBLICATION_PUBLISH_LEASE_MS,
      maintenance: false,
      ...(logger ? { logger } : {}),
    }),
  ];
};
