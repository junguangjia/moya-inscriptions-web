import { z } from "zod";
import { publicUserProfileSchema } from "./schemas.ts";

export const communityReportReasonSchema = z.enum([
  "illegal_harmful",
  "spam_scam",
  "harassment",
  "privacy",
  "impersonation",
  "copyright",
  "other",
]);
export const communityReportTargetSchema = z
  .object({
    type: z.enum(["work", "comment", "user", "article", "thread", "catalog"]),
    id: z.string().min(1).max(128).regex(/^\S+$/u),
  })
  .strict();
const nonCommentTarget = communityReportTargetSchema.extend({
  type: z.enum(["work", "user", "article", "thread", "catalog"]),
});
const text = z.string().trim().min(1).max(10000);
export const createCommunityReportRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("standard"),
      target: nonCommentTarget,
      reason: communityReportReasonSchema,
      description: text.optional(),
      requestId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("quick_comment"),
      target: communityReportTargetSchema.extend({
        type: z.literal("comment"),
      }),
      requestId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rights_notice"),
      sourceCaseId: z
        .string()
        .regex(/^report-[0-9a-f]{32}$/u)
        .optional(),
      target: communityReportTargetSchema,
      reason: z.literal("copyright"),
      description: text,
      claimantName: z.string().trim().min(1).max(200),
      contact: z.string().trim().min(1).max(500),
      rightsBasis: text,
      requestId: z.uuid(),
    })
    .strict(),
]);
export const communityReportStatusSchema = z.enum([
  "open",
  "reviewing",
  "resolved",
  "appealed",
]);
export const communityReportActionSchema = z.enum([
  "retain",
  "hide",
  "warn",
  "restrict_comments",
  "suspend",
  "approve",
  "reject",
  "restore",
  "delete_body",
  "remove_thread",
]);
export const communityReportDecisionSchema = z
  .object({
    id: z.string(),
    action: communityReportActionSchema,
    reason: z.string(),
    createdAt: z.iso.datetime(),
    reversedAt: z.iso.datetime().nullable(),
    reviewReason: z.string().nullable(),
  })
  .strict();
export const communityReportAppealSchema = z
  .object({
    text: z.string(),
    status: z.enum(["pending", "upheld", "overturned"]),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const communityReportMessageSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["notice", "statement", "result"]),
    text: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const communityReportEvidenceSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    size: z.number().int().positive(),
    sensitive: z.boolean(),
    createdAt: z.iso.datetime(),
    downloadPath: z.string(),
  })
  .strict();
export const communityReportSchema = z
  .object({
    id: z.string(),
    target: communityReportTargetSchema,
    canonicalPath: z.string(),
    kind: z.enum(["standard", "quick_comment", "rights_notice", "moderation"]),
    reason: communityReportReasonSchema.nullable(),
    description: z.string(),
    status: communityReportStatusSchema,
    urgent: z.boolean(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    decision: communityReportDecisionSchema.nullable(),
    appeal: communityReportAppealSchema.nullable(),
    messages: z.array(communityReportMessageSchema),
    evidence: z.array(communityReportEvidenceSchema),
  })
  .strict();
export const communityReportPageSchema = z
  .object({
    items: z.array(communityReportSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export const communityReportingDecisionSchema = z
  .object({
    caseId: z.string(),
    kind: z.enum(["standard", "quick_comment", "rights_notice", "moderation"]),
    evidence: z.array(communityReportEvidenceSchema),
    target: communityReportTargetSchema,
    canonicalPath: z.string(),
    decision: communityReportDecisionSchema,
    appeal: communityReportAppealSchema.nullable(),
    messages: z.array(communityReportMessageSchema),
  })
  .strict();
export const communityReportingDecisionPageSchema = z
  .object({
    items: z.array(communityReportingDecisionSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export const communityReportMaterialRequestSchema = z
  .object({ text, requestId: z.uuid() })
  .strict();
export const communityReportAppealRequestSchema = z
  .object({ text, requestId: z.uuid() })
  .strict();
export const communityReportEvidenceUploadRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    mimeType: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]),
    contentBase64: z.string().min(4).max(11184812),
    sensitive: z.boolean().default(true).meta({
      description:
        "All public complaint uploads are treated as sensitive; a client flag cannot extend retention.",
    }),
    requestId: z.uuid(),
  })
  .strict();
export const communityReportingInboxSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          caseId: z.string(),
          kind: communityReportMessageSchema.shape.kind,
          text: z.string(),
          createdAt: z.iso.datetime(),
          readAt: z.iso.datetime().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type CommunityReportReason = z.infer<typeof communityReportReasonSchema>;
export type CommunityReportTarget = z.infer<typeof communityReportTargetSchema>;
export type CreateCommunityReportRequest = z.infer<
  typeof createCommunityReportRequestSchema
>;
export type CommunityReportStatus = z.infer<typeof communityReportStatusSchema>;
export type CommunityReportAction = z.infer<typeof communityReportActionSchema>;
export type CommunityReport = z.infer<typeof communityReportSchema>;
export type CommunityReportPage = z.infer<typeof communityReportPageSchema>;
export type CommunityReportEvidence = z.infer<
  typeof communityReportEvidenceSchema
>;
export type CommunityReportingDecision = z.infer<
  typeof communityReportingDecisionSchema
>;
export type CommunityReportingDecisionPage = z.infer<
  typeof communityReportingDecisionPageSchema
>;
export type CommunityReportMaterialRequest = z.infer<
  typeof communityReportMaterialRequestSchema
>;
export type CommunityReportAppealRequest = z.infer<
  typeof communityReportAppealRequestSchema
>;
export type CommunityReportEvidenceUploadRequest = z.infer<
  typeof communityReportEvidenceUploadRequestSchema
>;
export type CommunityReportingInbox = z.infer<
  typeof communityReportingInboxSchema
>;

export const communityAppealSessionSchema = z
  .object({
    expiresAt: z.iso.datetime(),
    profile: z.lazy(() => publicUserProfileSchema),
  })
  .strict();
export const communityAppealLoginResultSchema = z
  .object({
    outcome: z.literal("appeal_signed_in"),
    session: communityAppealSessionSchema,
  })
  .strict();
export type CommunityAppealSession = z.infer<
  typeof communityAppealSessionSchema
>;
export type CommunityAppealLoginResult = z.infer<
  typeof communityAppealLoginResultSchema
>;
