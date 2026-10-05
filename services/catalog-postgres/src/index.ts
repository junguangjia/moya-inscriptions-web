export { parseCatalogCount, PostgresCatalogQueryAdapter } from "./adapter.js";
// content-community-completion-v1: published editorial content reads.
export { PostgresEditorialContentAdapter } from "./editorial-content-adapter.js";
export {
  catalogSearchSourceSelectSql,
  projectCatalogSearchSourceRow,
  rebuildCatalogSearchDocuments,
  refreshCatalogSearchDocument,
} from "./search-documents.js";
export { asPostgresOperationError } from "./availability.js";
export { parsePostgresConfig } from "./config.js";
export { catalogPageOffset } from "./pagination.js";
export { closePostgresPool, createPostgresPool } from "./pool.js";
export {
  assertPostgresStartupReady,
  checkPostgresReadiness,
  PostgresStartupError,
} from "./readiness.js";
export { requiredMigrations } from "./migrations/manifest.js";
export {
  DatabaseSchemaNotReadyError,
  MigrationStateError,
  readMigrationFiles,
  runMigrations,
  verifyRequiredMigrationLedger,
} from "./migrations/runner.js";
export {
  mapAliasRows,
  mapCatalogDetailRow,
  mapCatalogEntryRow,
  mapCatalogMediaRow,
  mapCatalogMediaRows,
  mapCitationRows,
  mapRepresentativeMediaRows,
} from "./row-mapper.js";

export type { PostgresConfig, PostgresEnvironment } from "./config.js";
export type { RequiredMigration } from "./migrations/manifest.js";
export type { MigrationFile } from "./migrations/runner.js";
export type { PostgresPoolOptions } from "./pool.js";
// unified-media-pipeline-v1: readers join the Catalog rendition delivery view by option.
export type { CatalogReaderOptions } from "./catalog-media-delivery.js";
export type {
  CatalogAliasRow,
  CatalogCitationRow,
  CatalogEntryRow,
  CatalogMediaRow,
} from "./row-mapper.js";

export {
  assertMigrationTarget,
  migrationTargetProbeSql,
} from "./migrations/target.js";

export { PostgresCompositeEditorialAdapter } from "./postgres-composite-editorial-adapter.js";
export type { AuthoredArticleReadProjector } from "./postgres-composite-editorial-adapter.js";
export {
  CanonicalAuthoredArticleProjector,
  articleCatalogMediaKey,
} from "./authored-article-read-projector.js";
export type { AuthoredArticleMediaResolver } from "./authored-article-read-projector.js";

export {
  PostgresAuthoredArticleCatalogMediaResolver,
  authoredArticleCatalogPairKey,
} from "./authored-article-media-resolver.js";
