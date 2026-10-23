export { PostgresCommunityIdentityAdapter } from "./adapter.js";
export { PostgresArticleAuthoringAdapter } from "./article-authoring/postgres-article-authoring-adapter.js";
export type { PostgresArticleAuthoringOptions } from "./article-authoring/postgres-article-authoring-adapter.js";
export { PostgresCommunityAuthAdapter } from "./auth-adapter.js";
export { createPostgresBetaAccountAccess } from "./beta-account-access.js";
export { asCommunityOperationError } from "./availability.js";
export { PostgresCommunityCommentAdapter } from "./comment-adapter.js";
export {
  mapCommentRow,
  mapOperatorCommentRow,
  mapReplyRow,
  parseCommentTotal,
} from "./comment-row-mapper.js";
export { requiredCommunityMigrations } from "./migrations/manifest.js";
export {
  CommunityMigrationStateError,
  CommunitySchemaNotReadyError,
  readCommunityMigrationFiles,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "./migrations/runner.js";
export { mapPublicUserRow } from "./row-mapper.js";

export type { CommentRow, OperatorCommentRow } from "./comment-row-mapper.js";
export type { RequiredCommunityMigration } from "./migrations/manifest.js";
export type { CommunityMigrationFile } from "./migrations/runner.js";
export type { PublicUserRow } from "./row-mapper.js";

export { PostgresAuthorCommunityAdapter } from "./author-adapter.js";
export { PostgresCommunityDiscoveryAdapter } from "./discovery-adapter.js";
export { PostgresCommunityContentOperatorAdapter } from "./content-operator-adapter.js";
export { PostgresWorkPublishingAdapter } from "./work-publishing-adapter.js";
export {
  synchronizeCatalogDeliveryIntents,
  parseCatalogPrepareRows,
  partitionCatalogPrepareRows,
  inspectCatalogDelivery,
  readCatalogDeliveryProjection,
} from "./publishing/catalog-delivery-intents.js";
// catalog-scale-v1 (W9/W10): the render tiers, the queue's backlog for the
// later pacing, and render grace (R as the App reads it, G's margin inside
// it, the render-only reference and the sync's grace members).
export {
  CATALOG_PREPARE_RETENTION_HOURS,
  CATALOG_RENDER_GRACE_MARGIN_HOURS,
  catalogRenderGraceReferenceSql,
  catalogRenderGraceSourcesSql,
} from "./publishing/catalog-delivery-intents.js";
export {
  CATALOG_RENDER_TIERS,
  catalogRenderBacklogWriteSql,
  readCatalogRenderBacklog,
} from "./publishing/catalog-assets.js";
export type {
  CatalogRenderBacklog,
  CatalogRenderTier,
} from "./publishing/catalog-assets.js";
// catalog-scale-v1 (W3): the one ceiling of a complete Catalog snapshot,
// shared by the worker's cursor reads and the store's bounds.
export {
  CATALOG_SNAPSHOT_FETCH_ROWS,
  CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
  CATALOG_SNAPSHOT_MAX_SOURCES,
  CATALOG_SNAPSHOT_WARN_RATIO,
  nearCatalogSnapshotCeiling,
  readCatalogSnapshotCursor,
} from "./publishing/catalog-snapshot-ceiling.js";
// catalog-scale-v1 (W7/W8): the one writer of the scoped reconcile's dirty
// queue (its mark, its consumers' lock and the lock order every writer
// keeps) and the per-minute membership fingerprints (App migration A1's two
// tables).
export {
  CATALOG_MEMBERSHIP_FIRST_WINDOW_MINUTES,
  CATALOG_PUBLICATION_DIRTY_REASONS,
  CATALOG_RENDER_GRACE_HOURS,
  CatalogReconcileStateMissingError,
  applyCatalogMembership,
  catalogIntentAssetsSql,
  catalogMembershipBoundariesSql,
  catalogMembershipBuckets,
  catalogMembershipChanged,
  catalogMembershipHashSql,
  catalogMembershipHoldsSql,
  catalogMembershipStateSql,
  catalogMembershipStore,
  catalogMembershipTotal,
  catalogMirrorStatesSql,
  catalogPrivateMembershipAppBucketsSql,
  catalogPrivateMembershipAppMembersSql,
  catalogPublicMembershipAppBucketsSql,
  catalogPublicMembershipAppMembersSql,
  catalogPublicationDirtyLockSql,
  catalogPublicationDirtyMarkSql,
  differingCatalogMembershipBuckets,
  lockCatalogPublicationDirty,
  markCatalogPublicationDirty,
  readCatalogMembershipAppBuckets,
  readCatalogMembershipHolds,
  readCatalogMembershipState,
} from "./publishing/catalog-publication-dirty.js";
export type {
  CatalogMembershipBucket,
  CatalogMembershipBuckets,
  CatalogMembershipFingerprint,
  CatalogMembershipIntent,
  CatalogMembershipMarks,
  CatalogMembershipObservation,
  CatalogMembershipSide,
  CatalogMembershipState,
  CatalogMirrorState,
  CatalogPublicationDirtyMark,
  CatalogPublicationDirtyReason,
} from "./publishing/catalog-publication-dirty.js";
// unified-media-pipeline-v1: the recorded form of rendition recipe
// identities (the registry itself lives with the processor) and the D7 hold.
export {
  ADOPTED_DERIVATIVE_ROLES,
  PROFILE_RENDITION_ROLES,
  RECIPE_DIGEST_PATTERN,
  RENDITION_ROLES,
  isProfileRenditionRole,
  isRenditionRole,
} from "./publishing/recipe-identity.js";
export type {
  RecipeIdentity,
  RenditionRole,
} from "./publishing/recipe-identity.js";
export { USER_PURGE_HOLDS_PRE_TASK_BLOBS } from "./publishing/renditions.js";
// PR 1b: the Development delivery route reads a listed Catalog rendition;
// startup verifies the App role's read of the delivery view.
export {
  catalogBlockReadTarget,
  resolveCatalogRenditionRead,
  verifyCatalogDeliveryReadable,
} from "./publishing/catalog-delivery.js";
export { PostgresPublishingOperatorAdapter } from "./publishing-operator-adapter.js";
export { PostgresAgentAdministrationAdapter } from "./agent-administration-adapter.js";
export {
  ProviderAdapterKeyError,
  createProviderAdapter,
  providerAdapterKeysFrom,
} from "./agent-connection-provider-adapter.js";
export {
  AgentConnectionInvariantError,
  AgentConnectionRowError,
  createAgentConnectionStore,
  parseConnectionRow,
  parseGrantRow,
} from "./agent-connection-store.js";
export {
  CALLBACK_POLICIES,
  CLIENT_ID_MAX_BYTES,
  CONNECTION_CLIENT_PATTERN,
  CONNECTION_CLIENT_PRESETS,
  RegisteredClientError,
  isCallbackPolicy,
  isCimdClientId,
  isConnectionClientSlug,
  isOauthClientId,
  isPreregisteredClientId,
  parseRegisteredClients,
} from "./agent-connection-identity.js";
export type {
  CallbackPolicy,
  ConnectionClientPreset,
  RegisteredClient,
} from "./agent-connection-identity.js";
export {
  createConsentStore,
  parseConsentRow,
} from "./agent-connection-consents.js";
export type {
  ConsentArming,
  ConsentDecision,
  ConsentOpening,
  ConsentPreset,
  ConsentStore,
  ConsentStoreOptions,
  StoredConsent,
} from "./agent-connection-consents.js";
export { createGrantDestroyer } from "./agent-connection-grant-destruction.js";
export type {
  GrantDestroyer,
  GrantDestroyerOptions,
  GrantDestructionOutcome,
  ProviderGrantLifecycle,
} from "./agent-connection-grant-destruction.js";
export {
  WRAPPER_PREFIX,
  WrapperGrantMissingError,
  WrapperKeyError,
  createWrapperStore,
  wrapperKeysFrom,
  wrapperValuesEqual,
} from "./agent-connection-wrappers.js";
export type {
  MintedWrapper,
  ResolvedWrapper,
  WrapperKeys,
  WrapperStore,
  WrapperStoreOptions,
} from "./agent-connection-wrappers.js";
export type {
  AgentConnectionStore,
  AgentConnectionStoreOptions,
  ConnectionForAuthorization,
  ListedConnection,
  StoredConnection,
  StoredConnectionClient,
  StoredConnectionPreset,
  StoredConnectionStatus,
  StoredConsentGrant,
  VersionedStoredConnection,
} from "./agent-connection-store.js";
export type {
  ProviderAdapterKeys,
  ProviderAdapterOptions,
  ProviderModel,
} from "./agent-connection-provider-adapter.js";

// messaging-notification-foundation-v1
export { PostgresNotificationAdapter } from "./notifications/adapter.js";
// content-community-completion-v1: Threads over Works.
export { PostgresThreadAdapter } from "./thread-adapter.js";
// content-community-completion-v1: direct messages.
export { PostgresDirectMessageAdapter } from "./direct-message-adapter.js";

export { createArticleConsentStore } from "./article-delegation-consent.js";
export {
  createArticleDelegationGuards,
  createArticleDelegationStore,
  admitArticleOAuthGrant,
  assertArticleScopes,
} from "./article-delegation.js";
export type {
  ArticleDelegationAuthority,
  ArticleDelegationActor,
} from "./article-delegation.js";

export { resolvePublishedArticleManagedMedia } from "./article-authoring/media-read.js";

export { selectOwnArticleThumbnail } from "./article-authoring/thumbnail-read.js";

export { sourceFactsSql } from "./notifications/source.js";
export {
  decodeArticleOwnMediaCursor,
  encodeArticleOwnMediaCursor,
  listArticleOwnMedia,
} from "./article-authoring/media-read.js";

export { PostgresMediaPublicationAdapter } from "./publishing/publication.js";
export { catalogBlockListedSql } from "./publishing/publication-eligibility.js";
export {
  CATALOG_BLOCK_GUARD_SQL,
  CATALOG_MASTER_SLICE_CAP,
  CATALOG_MASTER_TASK_CAP,
  CATALOG_MASTER_TASK_SINCE,
  PostgresCatalogDisplayMasterAdapter,
} from "./publishing/catalog-masters.js";
export {
  CATALOG_BLOCK_CONTENT_FAILURES,
  CATALOG_BLOCK_JOB_CELLS,
  CATALOG_BLOCK_OPEN_SETS,
  catalogBlockCell,
  catalogBlockGrid,
  catalogBlockJobPayload,
  catalogBlockJobRanges,
  catalogBlockRole,
  catalogMasterFrame,
  enqueueMissingCatalogBlocks,
} from "./publishing/catalog-zoom-blocks.js";
export type { PublicationSyncOptions } from "./publishing/publication-sync.js";

export { PostgresAnalyticsAdapter } from "./analytics-adapter.js";
