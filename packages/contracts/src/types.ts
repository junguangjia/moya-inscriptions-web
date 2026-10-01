import type { z } from "zod";

import type {
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
  healthResponseSchema,
  mediaIdSchema,
  publicMediaSchema,
  publicSourceCitationSchema,
  publicUserIdSchema,
  publicUserProfileSchema,
} from "./schemas.js";

export type CatalogId = z.infer<typeof catalogIdSchema>;
export type CatalogKind = z.infer<typeof catalogKindSchema>;
export type CatalogContributorRole = z.infer<
  typeof catalogContributorRoleSchema
>;
export type CatalogContributor = z.infer<typeof catalogContributorSchema>;
export type CatalogCitationScope = z.infer<typeof catalogCitationScopeSchema>;
export type MediaId = z.infer<typeof mediaIdSchema>;
export type PublicMedia = z.infer<typeof publicMediaSchema>;
export type PublicSourceCitation = z.infer<typeof publicSourceCitationSchema>;
export type CatalogSummary = z.infer<typeof catalogSummarySchema>;
export type CatalogDetail = z.infer<typeof catalogDetailSchema>;
export type CatalogListTransportQuery = z.infer<
  typeof catalogListTransportQuerySchema
>;
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export type CatalogSearchMatchKind = z.infer<
  typeof catalogSearchMatchKindSchema
>;
export type CatalogSearchTransportQuery = z.infer<
  typeof catalogSearchTransportQuerySchema
>;
export type CatalogSearchItem = z.infer<typeof catalogSearchItemSchema>;
export type CatalogSearchPage = z.infer<typeof catalogSearchPageSchema>;
export type PublicUserId = z.infer<typeof publicUserIdSchema>;
export type PublicUserProfile = z.infer<typeof publicUserProfileSchema>;
export type CatalogCommentId = z.infer<typeof catalogCommentIdSchema>;
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;
export type CatalogComment = z.infer<typeof catalogCommentSchema>;
export type CatalogCommentReply = z.infer<typeof catalogCommentReplySchema>;
export type CatalogCommentPage = z.infer<typeof catalogCommentPageSchema>;
export type CatalogCommentReplyPage = z.infer<
  typeof catalogCommentReplyPageSchema
>;
export type CatalogCommentTransportQuery = z.infer<
  typeof catalogCommentTransportQuerySchema
>;
export type CatalogCommentListingTransportQuery = z.infer<
  typeof catalogCommentListingTransportQuerySchema
>;
export type CreateCatalogCommentRequest = z.infer<
  typeof createCatalogCommentRequestSchema
>;
export type CreateCatalogCommentReplyRequest = z.infer<
  typeof createCatalogCommentReplyRequestSchema
>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

export type { MentionReference } from "./mention-references.js";

export type NotificationItem = z.infer<
  typeof import("./schemas.js").notificationItemSchema
>;
export type NotificationPage = z.infer<
  typeof import("./schemas.js").notificationPageSchema
>;
export type NotificationUnread = z.infer<
  typeof import("./schemas.js").notificationUnreadSchema
>;
export type NotificationReason = z.infer<
  typeof import("./schemas.js").notificationReasonSchema
>;
export type MentionLookupPage = z.infer<
  typeof import("./schemas.js").mentionLookupPageSchema
>;
