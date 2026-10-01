export {
  assertProductionAuthConfiguration,
  createDevelopmentAuthService,
} from "@moya/api";
export {
  createBackendApplication,
  createPublishingTransferRegistry,
} from "./application.js";
export { createDevelopmentCatalogFixtureQueryPort } from "./catalog/development-catalog-fixture.js";
export { parseRuntimeConfig } from "./config.js";
export {
  installProcessShutdownHandlers,
  startBackendProcess,
} from "./process-lifecycle.js";
export { createBackendServer, startServer, stopServer } from "./server.js";
export { trustedRequestSource } from "./community/auth-handler.js";

export type {
  ConfiguredPort,
  NodeEnvironment,
  RuntimeConfig,
  RuntimeEnvironment,
} from "./config.js";
export type { BackendApplicationOptions } from "./application.js";
export type { HealthReadinessCheck } from "./health/health-handler.js";
export type {
  BackendProcessHandle,
  BackendProcessOptions,
  ProcessShutdownLogger,
} from "./process-lifecycle.js";
export type { InternalListenOptions, ShutdownOptions } from "./server.js";

export { NotificationSignals } from "./community/notification-stream.js";
