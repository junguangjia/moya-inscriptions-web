export { deriveCatalogPeriodLabel } from "./modules/catalog/application/catalog-read-projections.js";
export { parseCatalogListQuery } from "./modules/catalog/transport/catalog-list-query-parser.js";
export { parseCatalogSearchQuery } from "./modules/catalog/transport/catalog-search-query-parser.js";
export type { CatalogSearchQuery } from "./modules/catalog/application/queries/catalog-search-query.js";
export type {
  CatalogSearchQueryPort,
  CatalogSearchItemProjection,
  CatalogSearchPageProjection,
} from "./modules/catalog/application/ports/catalog-search-query-port.js";
export {
  mapCatalogDetail,
  mapCatalogPage,
  mapCatalogPublicMedia,
  mapCatalogSummary,
} from "./modules/catalog/application/mappers/catalog-public-contract-mapper.js";
export type {
  CatalogImageProjection,
  CatalogMediaContext,
  CatalogRenditionUrls,
} from "./modules/catalog/application/mappers/catalog-public-contract-mapper.js";
export {
  CatalogMediaResolutionError,
  isCatalogMediaResolutionError,
} from "./modules/catalog/application/errors/catalog-media-resolution-error.js";
export {
  CatalogQueryUnavailableError,
  isCatalogQueryUnavailableError,
} from "./modules/catalog/application/errors/catalog-query-unavailable-error.js";
export { CatalogReadService } from "./modules/catalog/application/services/catalog-read-service.js";
export {
  CommunityStoreUnavailableError,
  isCommunityStoreUnavailableError,
} from "./modules/community/application/errors/community-store-unavailable-error.js";
export {
  CommunityInputError,
  CommunityConflictError,
  ExecutionFenceLostError,
  CommunityNotFoundError,
  isCommunityConflictError,
  isExecutionFenceLostError,
  isCommunityInputError,
  isCommunityNotFoundError,
} from "./modules/community/application/errors/community-request-errors.js";
export { DisabledCommentAnalysisPort } from "./modules/community/application/ports/comment-analysis-port.js";
export type {
  CommentAnalysisPort,
  CommentAnalysisTarget,
} from "./modules/community/application/ports/comment-analysis-port.js";
export { mapPublicUserProfile } from "./modules/community/application/mappers/community-public-contract-mapper.js";
export { CatalogCommentService } from "./modules/community/application/services/catalog-comment-service.js";
export { CommunityModerationService } from "./modules/community/application/services/community-moderation-service.js";
export { CommunitySessionService } from "./modules/community/application/services/community-session-service.js";
export { CommunityAuthService } from "./modules/community/application/auth/community-auth-service.js";
export { createMemoryCommunityAuthPort } from "./modules/community/application/auth/memory-auth-port.js";
export {
  assertProductionAuthConfiguration,
  createDevelopmentAuthService,
  productionAuthConfigurationFrom,
  createProductionAuthService,
} from "./modules/community/application/auth/auth-configuration.js";
export type { ProductionAuthConfiguration } from "./modules/community/application/auth/auth-configuration.js";
export {
  assertLoopbackCaptureUrl,
  interpretAliyunCheck,
  interpretAliyunSend,
  interpretTencentSendEmail,
  mapAliyunCheckSmsVerifyCode,
  mapAliyunSendSmsVerifyCode,
  mapTencentSendEmail,
} from "./modules/community/application/auth/delivery.js";
export type {
  AuthDeliveryPorts,
  AuthReason,
  AuthResult,
  AuthSessionGrant,
  AuthVerifyValue,
  CommunityAuthServiceOptions,
} from "./modules/community/application/auth/community-auth-service.js";
export type {
  AuthChannelName,
  AuthEnvironmentName,
  AuthPurposeName,
  AuthUnitOfWork,
  CommunityAuthPort,
  StoredChallenge,
  StoredHandoff,
  StoredIdentity,
  StoredReceipt,
  StoredSession,
  StoredUser,
  StoredPasswordCredential,
  StoredPasswordResetReceipt,
  VerificationMode,
} from "./modules/community/application/auth/auth-port.js";
export type {
  CatalogCommentServiceOptions,
  CommentListingInput,
  CommentPageInput,
  CommentSubmission,
} from "./modules/community/application/services/catalog-comment-service.js";
export { COMMENT_EMBEDDED_REPLY_LIMIT } from "./modules/community/application/services/catalog-comment-service.js";
export { COMMENT_HOT_LIMIT } from "./modules/community/application/mappers/community-public-contract-mapper.js";
export {
  COMMENT_PAGE_SIZE_DEFAULT,
  COMMENT_REPLY_PAGE_SIZE_DEFAULT,
  parseCommentListingQuery,
  parseCommentPageQuery,
  parseCreateCommentRequest,
  parseCreateReplyRequest,
} from "./modules/community/transport/comment-request-parsers.js";
export type {
  CommentListingRequest,
  CommentPageRequest,
} from "./modules/community/transport/comment-request-parsers.js";
export type { CommunityModerationServiceOptions } from "./modules/community/application/services/community-moderation-service.js";
export type {
  CommunitySessionServiceOptions,
  DevelopmentSessionGrant,
} from "./modules/community/application/services/community-session-service.js";
export type {
  CommunityIdentityPort,
  SessionRecordInput,
} from "./modules/community/application/ports/community-identity-port.js";
export type { CatalogPublicationPort } from "./modules/community/application/ports/catalog-publication-port.js";
export type {
  CommentInsert,
  CommentPageQuery,
  CommandReceipt,
  ExecutionFence,
  CommunityCommentPort,
  ModeratedSubject,
  ModerationEvent,
  ModerationEventAction,
  ModerationEventDraft,
  ModerationEventQueryInput,
  ModerationSummaryRecord,
  OperatorCommentListing,
  OperatorCommentQueryInput,
  OperatorCommentRecord,
  OperatorQueueCountsRecord,
  ReplyInsert,
  ReplyPageQuery,
} from "./modules/community/application/ports/community-comment-port.js";
export type {
  CatalogCommentRecord,
  CatalogCommentReplyRecord,
  CatalogCommentWithReplies,
  CommentAuthorRecord,
  CommentListingRecord,
  CommentPageRecord,
} from "./modules/community/domain/catalog-comment.js";
export type {
  PublicUserRecord,
  PublicUserStatus,
} from "./modules/community/domain/public-user.js";

export type { CatalogQueryPort } from "./modules/catalog/application/ports/catalog-query-port.js";
export type {
  ResolvedMediaUrl,
  StorageMediaLocator,
  StorageUrlResolver,
} from "./modules/catalog/application/ports/storage-url-resolver.js";
export type { CatalogListQuery } from "./modules/catalog/application/queries/catalog-list-query.js";
export type {
  CatalogFieldState,
  CatalogContributorProjection,
  CatalogDetailProjection,
  CatalogListItemProjection,
  CatalogListPageProjection,
  CatalogMediaProjection,
  CatalogMediaRenditionLevel,
  CatalogMediaRenditionProjection,
  CatalogSourceCitationProjection,
  CatalogStatefulTextProjection,
} from "./modules/catalog/application/catalog-read-projections.js";
export type { CatalogRecord } from "./modules/catalog/domain/catalog-record.js";

export type {
  AuthorCommunityPort,
  AuthorPage,
  AuthorListItem,
  OwnedMediaInput,
  OwnedMediaRead,
} from "./modules/community/application/ports/author-community-port.js";
export { AuthorCommunityService } from "./modules/community/application/services/author-community-service.js";
export type {
  DiscussionPort,
  DiscussionQuery,
} from "./modules/community/application/ports/discussion-port.js";
export type {
  CommunityDiscoveryPort,
  DiscoveryCardRecord,
  DiscoveryPageRecord,
} from "./modules/community/application/ports/community-discovery-port.js";
export type { CommunityContentOperatorPort } from "./modules/community/application/ports/community-content-operator-port.js";
export type {
  PublishingBlobContentType,
  PublishingBlobPurpose,
  PublishingMediaBlobListing,
  PublishingMediaBlobListOptions,
  PublishingMediaByteRange,
  PublishingMediaReadResult,
  PublishingMediaStoreFailureCode,
  PublishingMediaStorePort,
  PublishingMediaWriteOptions,
  PublishingMediaWriteResult,
} from "./modules/community/application/ports/publishing-media-store-port.js";
export type {
  PublishingClientPairing,
  PublishingComponentRole,
  PublishingDerivativeRecord,
  PublishingDerivativeVariant,
  PublishingRenditionRole,
  PublishingMediaEdit,
  PublishingMediaFailureCode,
  PublishingMediaKind,
  PublishingMediaPairing,
  PublishingMediaPresentation,
  PublishingMediaProcessorPort,
  PublishingNormalizedCrop,
  PublishingPairingMethod,
  PublishingProcessInput,
  PublishingProcessMode,
  PublishingProcessOutcome,
  PublishingProcessorComponent,
  PublishingQualityMode,
} from "./modules/community/application/ports/publishing-media-processor-port.js";
export type {
  CatalogAssetSyncCounts,
  CatalogAssetSyncOptions,
  CatalogMediaAssetPort,
  CatalogMediaSource,
  CatalogReadyRendition,
  CatalogRenderOutcome,
  CatalogRenderPlan,
  CatalogRenditionIdentity,
  CatalogRenditionRecord,
  CatalogRenditionRole,
} from "./modules/community/application/ports/catalog-media-asset-port.js";
export type {
  PublishingBlobUnlink,
  PublishingCleanupCounts,
  PublishingCommandIdentity,
  PublishingDerivativeCommit,
  PublishingDerivedOutcome,
  PublishingDeriveEditPayload,
  PublishingDraftDeletion,
  PublishingEditReadinessOptions,
  PublishingDraftOperations,
  PublishingEditItemState,
  PublishingEditReadiness,
  PublishingEditTarget,
  PublishingItemChange,
  PublishingJobClaim,
  PublishingJobClaimOptions,
  PublishingJobEnqueue,
  PublishingJobEnqueued,
  PublishingJobFailure,
  PublishingJobFailureOptions,
  PublishingJobLease,
  PublishingJobOperations,
  PublishingMediaOperations,
  PublishingMediaReadOperations,
  PublishingMediaReadTarget,
  PublishingProcessedOutcome,
  PublishingProcessingInput,
  PublishingProcessingSource,
  PublishingPurgePlan,
  PublishingSessionDiscard,
  PublishingSessionExpiry,
  PublishingSessionOperations,
  PublishingSettingsOperations,
  PublishingStoppedUploads,
  PublishingSubmissionOperations,
  PublishingTrashPurge,
  PublishingUploadCommit,
  PublishingUploadFence,
  PublishingUploadOperations,
  PublishingUploadStart,
  PublishingWorkOperations,
  WorkPublishingPort,
} from "./modules/community/application/ports/work-publishing-port.js";
export type { PublishingOperatorPort } from "./modules/community/application/ports/publishing-operator-port.js";
export {
  PublishingTransferRegistry,
  WorkPublishingService,
} from "./modules/community/application/services/work-publishing-service.js";
export type {
  PublishingComponentTransfer,
  PublishingComponentUploadOutcome,
  PublishingMediaDelivery,
  PublishingTransferClaim,
  PublishingTransferPolicy,
  WorkPublishingServiceOptions,
} from "./modules/community/application/services/work-publishing-service.js";
export { PublishingOperatorService } from "./modules/community/application/services/publishing-operator-service.js";
export {
  parseWorkPublishingCommand,
  parseWorkPublishingSegment,
} from "./modules/community/transport/work-publishing-request-parsers.js";
export type {
  WorkPublishingCommandKind,
  WorkPublishingSegmentKind,
} from "./modules/community/transport/work-publishing-request-parsers.js";
export type { PublishingOperatorServiceOptions } from "./modules/community/application/services/publishing-operator-service.js";

export { CommunityContentOperatorService } from "./modules/community/application/services/community-content-operator-service.js";

export {
  AgentAdministrationService,
  AgentForbiddenError,
  isAgentForbiddenError,
  targetRequestId,
} from "./modules/community/application/services/agent-administration-service.js";
export type { AgentAdministrationServiceOptions } from "./modules/community/application/services/agent-administration-service.js";
export {
  AgentManifestError,
  isAgentManifestError,
} from "./modules/community/application/ports/agent-administration-port.js";
export type {
  AgentAdministrationPort,
  AgentFeaturedState,
  AgentManifestQuery,
  AgentManifestSelection,
  AgentOperationDraft,
} from "./modules/community/application/ports/agent-administration-port.js";

// messaging-notification-foundation-v1
export type {
  NotificationPort,
  NotificationQuery,
  NotificationFilter,
  NotificationReadResult,
  NotificationStoredItem,
  NotificationJobClaim,
  NotificationWorkerPort,
} from "./modules/community/application/ports/notification-port.js";

export { NotificationService } from "./modules/community/application/services/notification-service.js";
// content-community-completion-v1: editorial content reads.
export {
  EditorialContentReadService,
  splitParagraphs,
} from "./modules/editorial/application/services/editorial-content-read-service.js";
export type {
  ArticleCitationRecord,
  ArticleCollectionDetailRecord,
  ArticleCollectionMemberRecord,
  ArticleCollectionSummaryRecord,
  ArticleDetailRecord,
  ArticleSectionRecord,
  ArticleSummaryRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
  EditorialPageRecord,
} from "./modules/editorial/application/ports/editorial-content-read-port.js";
// content-community-completion-v1: Threads over Works.
export { ThreadService } from "./modules/community/application/services/thread-service.js";
export type { ThreadPort } from "./modules/community/application/ports/thread-port.js";
// content-community-completion-v1: direct messages.
export { DirectMessageService } from "./modules/community/application/services/direct-message-service.js";
export type {
  DirectMessagePort,
  DirectMessageSendInput,
} from "./modules/community/application/ports/direct-message-port.js";

// special-article-editor-v1: Development authoring application boundary.
export { ArticleAuthoringService } from "./modules/editorial/application/services/article-authoring-service.js";
export type { ArticleAuthoringServiceOptions } from "./modules/editorial/application/services/article-authoring-service.js";
export type {
  ArticleAuthoringActor,
  ArticleAuthoringPort,
  ArticleAuthoringPage,
  ArticleCandidateIdentity,
  ArticleCandidateValidation,
  ArticleCreateCommand,
  ArticleDraftListQuery,
  ArticlePublishCommand,
  ArticleReferenceIssue,
  ArticleSaveCommand,
  ArticleWithdrawCommand,
  PublishedAuthoredArticle,
  PublishedAuthoredArticleSummary,
} from "./modules/editorial/application/ports/article-authoring-port.js";

export {
  parseArticleId,
  parseArticleDraftCreateCommand,
  parseArticleDraftUpdateCommand,
  parseArticleDraftDeletionCommand,
  parseArticleCandidateCommand,
  parseArticleOwnMediaListQuery,
  parseArticleDraftListQuery,
  parseArticleBlockEditsCommand,
} from "./modules/editorial/transport/article-authoring-request-parsers.js";

export type { ArticlePublicationOperatorPort } from "./modules/editorial/application/ports/article-publication-operator-port.js";
export { ArticlePublicationOperatorService } from "./modules/editorial/application/services/article-publication-operator-service.js";
export {
  parseArticlePendingId,
  parseArticlePendingListQuery,
  parseArticlePendingModerationCommand,
  parseArticlePendingMediaQuery,
} from "./modules/editorial/transport/article-publication-operator-parsers.js";

export type {
  ArticleDelegationActor,
  ArticleConsentInteraction,
  ArticleConsentPort,
  ArticleDelegationPort,
} from "./modules/editorial/application/ports/article-delegation-port.js";
export {
  generateSessionToken,
  hashSessionToken,
  generateOpaqueId,
} from "./modules/community/application/session-token.js";
export {
  hashPassword,
  verifyPassword,
  validPassword,
  PasswordHashBusyError,
} from "./modules/community/application/auth/password-crypto.js";

export {
  isValidAuthPassword,
  normalizeStudioName,
  normalizeStudioNameInput,
} from "./modules/community/domain/auth-profile-policy.js";

export type {
  MediaPublicationFence,
  MediaPublicationPlan,
  MediaPublicationPort,
  MediaPublicationUnit,
} from "./modules/community/application/ports/media-publication-port.js";
