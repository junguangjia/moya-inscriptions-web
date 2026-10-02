import { z } from "zod";
import {
  articleCandidateApprovalCommandSchema,
  articleAuthoringGrantSchema,
  articlePreviewSchema,
  createArticleAuthoringGrantCommandSchema,
} from "./article-authoring.ts";

const timestamp = z.iso.datetime({ offset: true });
const ticket = createArticleAuthoringGrantCommandSchema.shape.consentTicket;
/** Identifiers are ordinary links; possession grants no access or approval. */
export const articleApprovalCandidateSchema =
  articleCandidateApprovalCommandSchema.omit({ requestId: true });
export const articleApprovalResultSchema =
  articleApprovalCandidateSchema.extend({
    id: z.string().regex(/^article-approval-[0-9a-f]{32}$/u),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: timestamp,
    consumedAt: timestamp.nullable(),
  });
export const articleCandidateApprovalSubmissionSchema =
  articleCandidateApprovalCommandSchema.extend({ reviewTicket: ticket });
export const articleApprovalReviewSchema = z.strictObject({
  preview: articlePreviewSchema,
  connection: articleAuthoringGrantSchema,
  publishedVersion: z.number().int().positive().nullable(),
  changes: z.strictObject({
    titleChanged: z.boolean(),
    coverChanged: z.boolean(),
    referencesChanged: z.boolean(),
    galleriesChanged: z.boolean(),
    addedBlocks: z.number().int().nonnegative(),
    removedBlocks: z.number().int().nonnegative(),
    changedBlocks: z.number().int().nonnegative(),
  }),
  reviewTicket: ticket,
});
export const articleConsentReviewSchema = z.strictObject({
  interactionUid: createArticleAuthoringGrantCommandSchema.shape.interactionUid,
  clientId: articleAuthoringGrantSchema.shape.clientId,
  clientLabel: z.string().min(1).max(120),
  redirectUris: z.array(z.url()).min(1).max(20),
  resource: articleAuthoringGrantSchema.shape.resource,
  scopes: createArticleAuthoringGrantCommandSchema.shape.scopes,
  expiresAt: timestamp,
  consentTicket: ticket,
});
export const articleAuthoringConnectionsSchema = z.strictObject({
  items: z.array(articleAuthoringGrantSchema).max(50),
});
export const articleConnectionRevocationSchema = z.null();
export const articleConsentDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  resumeUrl: z.url(),
});
export type ArticleApprovalCandidate = z.infer<
  typeof articleApprovalCandidateSchema
>;
export type ArticleApprovalResult = z.infer<typeof articleApprovalResultSchema>;
export type ArticleCandidateApprovalSubmission = z.infer<
  typeof articleCandidateApprovalSubmissionSchema
>;
export type ArticleApprovalReview = z.infer<typeof articleApprovalReviewSchema>;
export type ArticleConsentReview = z.infer<typeof articleConsentReviewSchema>;
