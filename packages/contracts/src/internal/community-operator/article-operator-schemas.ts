import { z } from "zod";
import {
  articleAuthoringArticleIdSchema,
  articleDocumentSchema,
  articleReferences,
} from "../../article-authoring.js";
import { articleResolvedReferencesSchema } from "../../schemas.js";

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

/** Same-origin Owner-only Admin envelopes; the acting operator is never input. */
export const adminReadArticleSubmissionRequestSchema = z.strictObject({
  id: articleAuthoringArticleIdSchema,
});
export const adminModerateArticleSubmissionRequestSchema =
  moderateArticlePendingCommandSchema.extend({
    id: articleAuthoringArticleIdSchema,
  });
export type AdminReadArticleSubmissionRequest = z.infer<
  typeof adminReadArticleSubmissionRequestSchema
>;
export type AdminModerateArticleSubmissionRequest = z.infer<
  typeof adminModerateArticleSubmissionRequestSchema
>;

/** Private pending preview; only the exact used body/cover references are resolved. */
export const articlePendingPreviewSchema = articlePendingCandidateSchema
  .extend({ resolvedReferences: articleResolvedReferencesSchema })
  .superRefine((candidate, context) => {
    const wanted = new Set(
      articleReferences(candidate.document, candidate.coverRefId).map(
        ({ refId }) => refId,
      ),
    );
    for (const refId of wanted)
      if (!Object.hasOwn(candidate.resolvedReferences, refId))
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences", refId],
          message: "Pending Article reference resolution missing",
        });
    for (const { refId, reference } of articleReferences(
      candidate.document,
      candidate.coverRefId,
    )) {
      const resolved = candidate.resolvedReferences[refId];
      if (resolved === undefined) continue;
      const matches =
        resolved.type === "unavailable"
          ? resolved.reason ===
            (reference.type === "managed"
              ? "media_unavailable"
              : "catalog_unavailable")
          : resolved.type === reference.type &&
            resolved.media.id ===
              (reference.type === "managed"
                ? reference.itemId
                : reference.mediaId);
      if (!matches)
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences", refId],
          message: "Pending Article reference resolution does not match",
        });
    }
    for (const refId of Object.keys(candidate.resolvedReferences))
      if (!wanted.has(refId))
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences", refId],
          message: "Pending Article reference is not used",
        });
  });
const queryVersion = z.union([
  version,
  z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/u)
    .transform(Number)
    .pipe(version),
]);
/** Candidate identity is mandatory for every private derivative read. */
export const articlePendingMediaQuerySchema = z.strictObject({
  expectedVersion: queryVersion,
  candidateVersion: queryVersion,
  fingerprint,
  refId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  variant: z.enum(["display", "motion"]),
});
export type ArticlePendingPreview = z.infer<typeof articlePendingPreviewSchema>;
export type ArticlePendingMediaQuery = z.infer<
  typeof articlePendingMediaQuerySchema
>;
