import { operatorCommentMediaRequestSchema } from "./schemas.js";
import type { z } from "zod";

import type {
  adminBulkModerateCommentsRequestSchema,
  adminModerateCommentRequestSchema,
  adminModerateUserRequestSchema,
  adminReadCommentRequestSchema,
  bulkModerateCommentsCommandSchema,
  bulkModerationOutcomeSchema,
  bulkModerationResultSchema,
  commentAnalysisRecommendationSchema,
  commentAnalysisResultSchema,
  commentAnalysisStateSchema,
  commentAnalysisStatusSchema,
  commentModerationActionSchema,
  commentModerationStateSchema,
  moderateCommentCommandSchema,
  moderateUserCommandSchema,
  moderationEventActionSchema,
  moderationEventPageSchema,
  moderationEventQuerySchema,
  moderationEventSchema,
  moderationEventSubjectKindSchema,
  moderationResultSchema,
  moderationSummaryQuerySchema,
  moderationSummaryRangeSchema,
  moderationSummarySchema,
  operatorAuthorSchema,
  operatorCommentDetailSchema,
  operatorCommentKindSchema,
  operatorCommentPageSchema,
  operatorCommentQuerySchema,
  operatorCommentSchema,
  operatorLabelSchema,
  operatorQueueCountsSchema,
  parentRestrictionSchema,
  publicationPolicySchema,
  publicationPolicyStateSchema,
  setPublicationPolicyCommandSchema,
  userModerationActionSchema,
  userModerationResultSchema,
} from "./schemas.js";

export type PublicationPolicy = z.infer<typeof publicationPolicySchema>;
export type OperatorLabel = z.infer<typeof operatorLabelSchema>;
export type PublicationPolicyState = z.infer<
  typeof publicationPolicyStateSchema
>;
export type SetPublicationPolicyCommand = z.infer<
  typeof setPublicationPolicyCommandSchema
>;
export type CommentModerationState = z.infer<
  typeof commentModerationStateSchema
>;
export type CommentModerationAction = z.infer<
  typeof commentModerationActionSchema
>;
export type UserModerationAction = z.infer<typeof userModerationActionSchema>;
export type ModerateCommentCommand = z.infer<
  typeof moderateCommentCommandSchema
>;
export type ModerateUserCommand = z.infer<typeof moderateUserCommandSchema>;
export type BulkModerateCommentsCommand = z.infer<
  typeof bulkModerateCommentsCommandSchema
>;
export type BulkModerationOutcome = z.infer<typeof bulkModerationOutcomeSchema>;
export type BulkModerationResult = z.infer<typeof bulkModerationResultSchema>;
export type AdminModerateCommentRequest = z.infer<
  typeof adminModerateCommentRequestSchema
>;
export type AdminModerateUserRequest = z.infer<
  typeof adminModerateUserRequestSchema
>;
export type AdminBulkModerateCommentsRequest = z.infer<
  typeof adminBulkModerateCommentsRequestSchema
>;
export type AdminReadCommentRequest = z.infer<
  typeof adminReadCommentRequestSchema
>;
export type OperatorCommentKind = z.infer<typeof operatorCommentKindSchema>;
export type OperatorAuthor = z.infer<typeof operatorAuthorSchema>;
export type OperatorComment = z.infer<typeof operatorCommentSchema>;
export type OperatorQueueCounts = z.infer<typeof operatorQueueCountsSchema>;
export type OperatorCommentPage = z.infer<typeof operatorCommentPageSchema>;
export type OperatorCommentQuery = z.infer<typeof operatorCommentQuerySchema>;
export type OperatorCommentDetail = z.infer<typeof operatorCommentDetailSchema>;
export type ParentRestriction = z.infer<typeof parentRestrictionSchema>;
export type ModerationResult = z.infer<typeof moderationResultSchema>;
export type UserModerationResult = z.infer<typeof userModerationResultSchema>;
export type ModerationEventAction = z.infer<typeof moderationEventActionSchema>;
export type ModerationEventSubjectKind = z.infer<
  typeof moderationEventSubjectKindSchema
>;
export type ModerationEvent = z.infer<typeof moderationEventSchema>;
export type ModerationEventPage = z.infer<typeof moderationEventPageSchema>;
export type ModerationEventQuery = z.infer<typeof moderationEventQuerySchema>;
export type ModerationSummaryRange = z.infer<
  typeof moderationSummaryRangeSchema
>;
export type ModerationSummary = z.infer<typeof moderationSummarySchema>;
export type ModerationSummaryQuery = z.infer<
  typeof moderationSummaryQuerySchema
>;
export type CommentAnalysisStatus = z.infer<typeof commentAnalysisStatusSchema>;
export type CommentAnalysisRecommendation = z.infer<
  typeof commentAnalysisRecommendationSchema
>;
export type CommentAnalysisResult = z.infer<typeof commentAnalysisResultSchema>;
export type CommentAnalysisState = z.infer<typeof commentAnalysisStateSchema>;

export type OperatorCommentMediaRequest = z.infer<
  typeof operatorCommentMediaRequestSchema
>;
