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
