import { z } from "zod";

import {
  notificationPageSchema,
  notificationReadSchema,
  mentionReferenceSchema,
  mentionLookupPageSchema,
  apiErrorCodeSchema,
  apiErrorSchema,
  catalogCitationScopeSchema,
  catalogCommentIdSchema,
  catalogCommentPageSchema,
  catalogCommentReplyPageSchema,
  catalogCommentReplySchema,
  catalogCommentSchema,
  catalogCommentListingTransportQuerySchema,
  catalogCommentTransportQuerySchema,
  catalogContributorRoleSchema,
  catalogContributorSchema,
  catalogDetailSchema,
  catalogIdSchema,
  commentAuthorSchema,
  createCatalogCommentReplyRequestSchema,
  createCatalogCommentRequestSchema,
  catalogKindSchema,
  catalogListTransportQuerySchema,
  catalogPageSchema,
  catalogSummarySchema,
  catalogSearchMatchKindSchema,
  catalogSearchTransportQuerySchema,
  catalogSearchItemSchema,
  catalogSearchPageSchema,
  authAccountSecuritySchema,
  authCapabilitiesSchema,
  authChallengeRequestSchema,
  authRegistrationRequestSchema,
  authPasswordLoginRequestSchema,
  authPasswordResetRequestSchema,
  authPasswordResetResultSchema,
  healthResponseSchema,
  mediaIdSchema,
  noQueryTransportSchema,
  publicMediaSchema,
  publicSourceCitationSchema,
  publicUserIdSchema,
  publicUserProfileSchema,
} from "./schemas.js";

const toJsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-2020-12" });

/** Article tools keep reused definitions small and expose an object root. */
export const articleAuthoringJsonSchema = (schema: z.ZodType) => {
  const result = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
  });
  if (result.$ref?.startsWith("#/$defs/")) {
    const definition = result.$defs?.[result.$ref.slice("#/$defs/".length)];
    if (definition !== undefined) {
      const root = { ...result, ...definition };
      delete root.$ref;
      return root;
    }
  }
  return result;
};

import {
  articleAuthoringDocumentSchema,
  articleDraftSchema,
  articleDraftSummarySchema,
  articleDraftPageSchema,
  articleOwnMediaListQuerySchema,
  articleOwnMediaPageSchema,
  articleAuthoringListQuerySchema,
  articleAuthoringCreateSchema,
  articleAuthoringUpdateSchema,
  deleteArticleDraftCommandSchema,
  articleDraftDeletionResultSchema,
  articleBlockEditsCommandSchema,
  articleAuthoringCandidateSchema,
  articleValidationResultSchema,
  articlePreviewSchema,
  articleAuthoringGrantSchema,
  createArticleAuthoringGrantCommandSchema,
  articleCandidateApprovalCommandSchema,
  revokeArticleAuthoringGrantCommandSchema,
  articlePublicationResultSchema,
} from "./article-authoring.ts";
import {
  articleApprovalCandidateSchema,
  articleApprovalResultSchema,
  articleCandidateApprovalSubmissionSchema,
  articleApprovalReviewSchema,
  articleConsentReviewSchema,
  articleAuthoringConnectionsSchema,
  articleConsentDecisionSchema,
} from "./article-delegation.js";

export const articleAuthoringJsonSchemas = {
  ArticleOwnMediaListQuery: articleAuthoringJsonSchema(
    articleOwnMediaListQuerySchema,
  ),
  ArticleOwnMediaPage: articleAuthoringJsonSchema(articleOwnMediaPageSchema),
  ArticleAuthoringDocument: articleAuthoringJsonSchema(
    articleAuthoringDocumentSchema,
  ),
  ArticleDraft: articleAuthoringJsonSchema(articleDraftSchema),
  ArticleDraftSummary: articleAuthoringJsonSchema(articleDraftSummarySchema),
  ArticleDraftPage: articleAuthoringJsonSchema(articleDraftPageSchema),
  ArticleDraftListQuery: articleAuthoringJsonSchema(
    articleAuthoringListQuerySchema,
  ),
  CreateArticleDraftCommand: articleAuthoringJsonSchema(
    articleAuthoringCreateSchema,
  ),
  UpdateArticleDraftCommand: articleAuthoringJsonSchema(
    articleAuthoringUpdateSchema,
  ),
  DeleteArticleDraftCommand: articleAuthoringJsonSchema(
    deleteArticleDraftCommandSchema,
  ),
  ArticleDraftDeletionResult: articleAuthoringJsonSchema(
    articleDraftDeletionResultSchema,
  ),
  ArticleBlockEditsCommand: articleAuthoringJsonSchema(
    articleBlockEditsCommandSchema,
  ),
  ArticleCandidateCommand: articleAuthoringJsonSchema(
    articleAuthoringCandidateSchema,
  ),
  ArticleValidationResult: articleAuthoringJsonSchema(
    articleValidationResultSchema,
  ),
  ArticlePreview: articleAuthoringJsonSchema(articlePreviewSchema),
  ArticleAuthoringGrant: articleAuthoringJsonSchema(
    articleAuthoringGrantSchema,
  ),
  CreateArticleAuthoringGrantCommand: articleAuthoringJsonSchema(
    createArticleAuthoringGrantCommandSchema,
  ),
  ArticleCandidateApprovalCommand: articleAuthoringJsonSchema(
    articleCandidateApprovalCommandSchema,
  ),
  RevokeArticleAuthoringGrantCommand: articleAuthoringJsonSchema(
    revokeArticleAuthoringGrantCommandSchema,
  ),
  ArticlePublicationResult: articleAuthoringJsonSchema(
    articlePublicationResultSchema,
  ),
  ArticleApprovalCandidate: articleAuthoringJsonSchema(
    articleApprovalCandidateSchema,
  ),
  ArticleApprovalResult: articleAuthoringJsonSchema(
    articleApprovalResultSchema,
  ),
  ArticleCandidateApprovalSubmission: articleAuthoringJsonSchema(
    articleCandidateApprovalSubmissionSchema,
  ),
  ArticleApprovalReview: articleAuthoringJsonSchema(
    articleApprovalReviewSchema,
  ),
  ArticleConsentReview: articleAuthoringJsonSchema(articleConsentReviewSchema),
  ArticleAuthoringConnections: articleAuthoringJsonSchema(
    articleAuthoringConnectionsSchema,
  ),
  ArticleConsentDecision: articleAuthoringJsonSchema(
    articleConsentDecisionSchema,
  ),
};

export const catalogIdJsonSchema = toJsonSchema(catalogIdSchema);
export const catalogKindJsonSchema = toJsonSchema(catalogKindSchema);
export const catalogContributorRoleJsonSchema = toJsonSchema(
  catalogContributorRoleSchema,
);
export const catalogContributorJsonSchema = toJsonSchema(
  catalogContributorSchema,
);
export const catalogCitationScopeJsonSchema = toJsonSchema(
  catalogCitationScopeSchema,
);
export const mediaIdJsonSchema = toJsonSchema(mediaIdSchema);
export const publicMediaJsonSchema = toJsonSchema(publicMediaSchema);
export const catalogSummaryJsonSchema = toJsonSchema(catalogSummarySchema);
export const catalogDetailJsonSchema = toJsonSchema(catalogDetailSchema);
export const catalogListTransportQueryJsonSchema = toJsonSchema(
  catalogListTransportQuerySchema,
);
export const noQueryTransportJsonSchema = toJsonSchema(noQueryTransportSchema);
export const catalogPageJsonSchema = toJsonSchema(catalogPageSchema);
export const catalogSearchMatchKindJsonSchema = toJsonSchema(
  catalogSearchMatchKindSchema,
);
export const catalogSearchTransportQueryJsonSchema = toJsonSchema(
  catalogSearchTransportQuerySchema,
);
export const catalogSearchItemJsonSchema = toJsonSchema(
  catalogSearchItemSchema,
);
export const catalogSearchPageJsonSchema = toJsonSchema(
  catalogSearchPageSchema,
);
export const publicSourceCitationJsonSchema = toJsonSchema(
  publicSourceCitationSchema,
);
export const publicUserIdJsonSchema = toJsonSchema(publicUserIdSchema);
export const publicUserProfileJsonSchema = toJsonSchema(
  publicUserProfileSchema,
);
export const catalogCommentIdJsonSchema = toJsonSchema(catalogCommentIdSchema);
export const commentAuthorJsonSchema = toJsonSchema(commentAuthorSchema);
export const catalogCommentReplyJsonSchema = toJsonSchema(
  catalogCommentReplySchema,
);
export const catalogCommentJsonSchema = toJsonSchema(catalogCommentSchema);
export const catalogCommentPageJsonSchema = toJsonSchema(
  catalogCommentPageSchema,
);
export const catalogCommentReplyPageJsonSchema = toJsonSchema(
  catalogCommentReplyPageSchema,
);
export const catalogCommentTransportQueryJsonSchema = toJsonSchema(
  catalogCommentTransportQuerySchema,
);
export const catalogCommentListingTransportQueryJsonSchema = toJsonSchema(
  catalogCommentListingTransportQuerySchema,
);
export const createCatalogCommentRequestJsonSchema = toJsonSchema(
  createCatalogCommentRequestSchema,
);
export const createCatalogCommentReplyRequestJsonSchema = toJsonSchema(
  createCatalogCommentReplyRequestSchema,
);
export const healthResponseJsonSchema = toJsonSchema(healthResponseSchema);
export const apiErrorCodeJsonSchema = toJsonSchema(apiErrorCodeSchema);
export const apiErrorJsonSchema = toJsonSchema(apiErrorSchema);

import {
  authorProfileSchema,
  authorPeoplePageSchema,
  authorMediaSchema,
  workSchema,
  workPageSchema,
  profileUpdateSchema,
  privacyUpdateSchema,
  avatarUpdateSchema,
  backgroundUpdateSchema,
  avatarUpdateResultSchema,
  relationshipUpdateSchema,
  contentRelationUpdateSchema,
  guestFavoriteMergeSchema,
  guestFavoriteMergeResultSchema,
  requestIdentitySchema,
  articleSummarySchema,
  articleSectionSchema,
  articleCitationSchema,
  articleDetailSchema,
  articlePageSchema,
  articleCollectionSummarySchema,
  articleCollectionMemberSchema,
  articleCollectionDetailSchema,
  articleCollectionPageSchema,
  discussionTargetSchema,
  threadSummarySchema,
  threadPageSchema,
  threadReadResultSchema,
  directConversationSchema,
  directConversationPageSchema,
  directMessageSchema,
  directMessagePageSchema,
  directMessageUnreadSchema,
  sendDirectMessageCommandSchema,
  directMessageReadCommandSchema,
} from "./schemas.js";

import {
  contentIdentitySchema,
  discussionReplySchema,
  discussionCommentSchema,
  discussionPageSchema,
  discussionReplyPageSchema,
  ownCommentSchema,
  ownCommentPageSchema,
  discussionSubmitResultSchema,
  discussionLocationSchema,
  commentLikeUpdateSchema,
  contentCardSchema,
  inscriptionFiltersSchema,
  discoveryQuerySchema,
  discoveryPageSchema,
  contentCollectionPageSchema,
  inscriptionFilterOptionsSchema,
  contentStateSchema,
  savedResultSchema,
  deletedResultSchema,
  discardedResultSchema,
} from "./schemas.js";

export const authorCommunityJsonSchemas = {
  NotificationPage: toJsonSchema(notificationPageSchema),
  NotificationRead: toJsonSchema(notificationReadSchema),
  MentionReference: toJsonSchema(mentionReferenceSchema),
  MentionLookupPage: toJsonSchema(mentionLookupPageSchema),
  ContentIdentity: toJsonSchema(contentIdentitySchema),
  DiscussionReply: toJsonSchema(discussionReplySchema),
  DiscussionComment: toJsonSchema(discussionCommentSchema),
  DiscussionPage: toJsonSchema(discussionPageSchema),
  DiscussionReplyPage: toJsonSchema(discussionReplyPageSchema),
  OwnComment: toJsonSchema(ownCommentSchema),
  OwnCommentPage: toJsonSchema(ownCommentPageSchema),
  DiscussionSubmitResult: toJsonSchema(discussionSubmitResultSchema),
  DiscussionLocation: toJsonSchema(discussionLocationSchema),
  CommentLikeUpdate: toJsonSchema(commentLikeUpdateSchema),
  ContentCard: toJsonSchema(contentCardSchema),
  InscriptionFilters: toJsonSchema(inscriptionFiltersSchema),
  DiscoveryQuery: toJsonSchema(discoveryQuerySchema),
  DiscoveryPage: toJsonSchema(discoveryPageSchema),
  ContentCollectionPage: toJsonSchema(contentCollectionPageSchema),
  InscriptionFilterOptions: toJsonSchema(inscriptionFilterOptionsSchema),
  ContentState: toJsonSchema(contentStateSchema),
  SavedResult: toJsonSchema(savedResultSchema),
  DeletedResult: toJsonSchema(deletedResultSchema),
  DiscardedResult: toJsonSchema(discardedResultSchema),

  AuthorProfile: toJsonSchema(authorProfileSchema),
  AuthorPeoplePage: toJsonSchema(authorPeoplePageSchema),
  AuthorMedia: toJsonSchema(authorMediaSchema),
  UserWork: toJsonSchema(workSchema),
  WorkPage: toJsonSchema(workPageSchema),
  ProfileUpdate: toJsonSchema(profileUpdateSchema),
  PrivacyUpdate: toJsonSchema(privacyUpdateSchema),
  AvatarUpdate: toJsonSchema(avatarUpdateSchema),
  BackgroundUpdate: toJsonSchema(backgroundUpdateSchema),
  AvatarUpdateResult: toJsonSchema(avatarUpdateResultSchema),
  RelationshipUpdate: toJsonSchema(relationshipUpdateSchema),
  ContentRelationUpdate: toJsonSchema(contentRelationUpdateSchema),
  GuestFavoriteMerge: toJsonSchema(guestFavoriteMergeSchema),
  GuestFavoriteMergeResult: toJsonSchema(guestFavoriteMergeResultSchema),
  RequestIdentity: toJsonSchema(requestIdentitySchema),

  // content-community-completion-v1: editorial content read DTOs.
  ArticleSummary: toJsonSchema(articleSummarySchema),
  ArticleSection: toJsonSchema(articleSectionSchema),
  ArticleCitation: toJsonSchema(articleCitationSchema),
  ArticleDetail: articleAuthoringJsonSchema(articleDetailSchema),
  ArticlePage: toJsonSchema(articlePageSchema),
  ArticleCollectionSummary: toJsonSchema(articleCollectionSummarySchema),
  ArticleCollectionMember: toJsonSchema(articleCollectionMemberSchema),
  ArticleCollectionDetail: toJsonSchema(articleCollectionDetailSchema),
  ArticleCollectionPage: toJsonSchema(articleCollectionPageSchema),
  // content-community-completion-v1: Threads over Works.
  DiscussionTarget: toJsonSchema(discussionTargetSchema),
  ThreadSummary: toJsonSchema(threadSummarySchema),
  ThreadPage: toJsonSchema(threadPageSchema),
  ThreadReadResult: toJsonSchema(threadReadResultSchema),
  // content-community-completion-v1: direct messages.
  DirectConversation: toJsonSchema(directConversationSchema),
  DirectConversationPage: toJsonSchema(directConversationPageSchema),
  DirectMessage: toJsonSchema(directMessageSchema),
  DirectMessagePage: toJsonSchema(directMessagePageSchema),
  DirectMessageUnread: toJsonSchema(directMessageUnreadSchema),
  SendDirectMessageCommand: toJsonSchema(sendDirectMessageCommandSchema),
  DirectMessageReadCommand: toJsonSchema(directMessageReadCommandSchema),
};

import {
  createPublishingDraftCommandSchema,
  createPublishingSessionCommandSchema,
  editableWorkSchema,
  mediaEditSchema,
  openWorkEditDraftCommandSchema,
  publishingDraftDeletionCommandSchema,
  publishingDraftDeletionResultSchema,
  publishingDraftPageSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingLimitsSchema,
  publishingMediaItemSchema,
  publishingOpenedEditDraftSchema,
  publishingSessionHeartbeatCommandSchema,
  publishingSessionSchema,
  publishingSnapshotPageSchema,
  publishingUploadResultSchema,
  registerMediaItemCommandSchema,
  resolvePublishingConflictCommandSchema,
  restorePublishingSnapshotCommandSchema,
  savePublishingDraftCommandSchema,
  workAuthorshipSchema,
  workDraftContentSchema,
  workSubmissionCommandSchema,
  workSubmissionReceiptSchema,
  workSubmissionResultSchema,
  publishingReadinessCommandSchema,
  publishingReadinessSchema,
  workVisibilityCommandSchema,
  workVisibilityResultSchema,
} from "./schemas.js";

/** Work publishing public DTOs, for the Development-only OpenAPI components. */
export const authJsonSchemas = {
  AuthCapabilities: toJsonSchema(authCapabilitiesSchema),
  AuthChallengeRequest: toJsonSchema(authChallengeRequestSchema),
  AuthRegistrationRequest: toJsonSchema(authRegistrationRequestSchema),
  AuthPasswordLoginRequest: toJsonSchema(authPasswordLoginRequestSchema),
  AuthPasswordResetRequest: toJsonSchema(authPasswordResetRequestSchema),
  AuthPasswordResetResult: toJsonSchema(authPasswordResetResultSchema),
  AuthAccountSecurity: toJsonSchema(authAccountSecuritySchema),
};

export const workPublishingJsonSchemas = {
  MediaEdit: toJsonSchema(mediaEditSchema),
  WorkAuthorship: toJsonSchema(workAuthorshipSchema),
  WorkDraftContent: toJsonSchema(workDraftContentSchema),
  PublishingMediaItem: toJsonSchema(publishingMediaItemSchema),
  RegisterMediaItemCommand: toJsonSchema(registerMediaItemCommandSchema),
  PublishingUploadResult: toJsonSchema(publishingUploadResultSchema),
  CreatePublishingDraftCommand: toJsonSchema(
    createPublishingDraftCommandSchema,
  ),
  OpenWorkEditDraftCommand: toJsonSchema(openWorkEditDraftCommandSchema),
  SavePublishingDraftCommand: toJsonSchema(savePublishingDraftCommandSchema),
  PublishingDraft: toJsonSchema(publishingDraftSchema),
  PublishingOpenedEditDraft: toJsonSchema(publishingOpenedEditDraftSchema),
  PublishingDraftPage: toJsonSchema(publishingDraftPageSchema),
  PublishingDraftSaveResult: toJsonSchema(publishingDraftSaveResultSchema),
  PublishingDraftDeletionCommand: toJsonSchema(
    publishingDraftDeletionCommandSchema,
  ),
  PublishingDraftDeletionResult: toJsonSchema(
    publishingDraftDeletionResultSchema,
  ),
  PublishingSnapshotPage: toJsonSchema(publishingSnapshotPageSchema),
  RestorePublishingSnapshotCommand: toJsonSchema(
    restorePublishingSnapshotCommandSchema,
  ),
  ResolvePublishingConflictCommand: toJsonSchema(
    resolvePublishingConflictCommandSchema,
  ),
  CreatePublishingSessionCommand: toJsonSchema(
    createPublishingSessionCommandSchema,
  ),
  PublishingSessionHeartbeatCommand: toJsonSchema(
    publishingSessionHeartbeatCommandSchema,
  ),
  PublishingSession: toJsonSchema(publishingSessionSchema),
  WorkSubmissionCommand: toJsonSchema(workSubmissionCommandSchema),
  WorkSubmissionResult: toJsonSchema(workSubmissionResultSchema),
  PublishingReadinessCommand: toJsonSchema(publishingReadinessCommandSchema),
  PublishingReadiness: toJsonSchema(publishingReadinessSchema),
  WorkSubmissionReceipt: toJsonSchema(workSubmissionReceiptSchema),
  EditableWork: toJsonSchema(editableWorkSchema),
  WorkVisibilityCommand: toJsonSchema(workVisibilityCommandSchema),
  WorkVisibilityResult: toJsonSchema(workVisibilityResultSchema),
  PublishingLimits: toJsonSchema(publishingLimitsSchema),
};
