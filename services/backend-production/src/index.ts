export {
  prepareProductionBackend,
  startProductionBackend,
} from "./composition.js";

export type {
  PreparedProductionBackend,
  ProductionBackendDependencies,
} from "./composition.js";
export { platformCatalogIdAllocator } from "./catalog-id-allocator.js";

export { articleBackendConfigurationFrom } from "./article-authoring/runtime-config.js";
export {
  createArticleDelegationPersistence,
  createArticleDelegationRuntime,
} from "./article-authoring/delegation-composition.js";
export {
  MEDIA_WORKER_EXIT_CODES,
  MediaWorkerStartupError,
  prepareMediaWorker,
  startMediaWorker,
} from "./worker-composition.js";
export type {
  MediaWorkerDependencies,
  PreparedMediaWorker,
} from "./worker-composition.js";
