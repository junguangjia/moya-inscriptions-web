import { z } from "zod";
import {
  articleAuthoringArticleIdSchema,
  articleDocumentSchema,
} from "../../article-authoring.js";

const version = z.number().int().min(1).max(2_147_483_647);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const nullableRefId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .nullable();

/** Server-only Article moderation, behind the existing operator boundary. */
export const articlePendingListQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const articlePendingSummarySchema = z.strictObject({
  articleId: articleAuthoringArticleIdSchema,
  ownerId: z
    .string()
    .regex(/^user-[0-9a-f]{32}$/u)
    .brand<"PublicUserId">(),
  expectedVersion: version,
  candidateVersion: version,
  fingerprint,
  title: z
    .string()
    .max(240)
    .refine((value) => [...value].length <= 120),
  publicVersion: version.nullable(),
  submittedAt: z.iso.datetime({ offset: true }),
});
export const articlePendingPageSchema = z.strictObject({
  items: z.array(articlePendingSummarySchema).max(50),
  nextCursor: z.string().nullable(),
});
export const articlePendingCandidateSchema = articlePendingSummarySchema.extend(
  {
    coverRefId: nullableRefId,
    document: articleDocumentSchema,
  },
);
export const moderateArticlePendingCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: version,
  candidateVersion: version,
  fingerprint,
  action: z.enum(["approve", "reject"]),
});
/** Content-free receipt/audit: no title, body, media or private metadata. */
export const articleModerationResultSchema = z.strictObject({
  articleId: articleAuthoringArticleIdSchema,
  candidateVersion: version,
  fingerprint,
  version,
  disposition: z.enum(["approved", "rejected"]),
  status: z.enum(["published", "draft"]),
  publicVersion: version.nullable(),
});
export type ArticlePendingListQuery = z.infer<
  typeof articlePendingListQuerySchema
>;
export type ArticlePendingSummary = z.infer<typeof articlePendingSummarySchema>;
export type ArticlePendingPage = z.infer<typeof articlePendingPageSchema>;
export type ArticlePendingCandidate = z.infer<
  typeof articlePendingCandidateSchema
>;
export type ModerateArticlePendingCommand = z.infer<
  typeof moderateArticlePendingCommandSchema
>;
export type ArticleModerationResult = z.infer<
  typeof articleModerationResultSchema
>;
