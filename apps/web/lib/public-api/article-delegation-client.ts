import {
  articleApprovalResultSchema,
  articleApprovalReviewSchema,
  articleAuthoringConnectionsSchema,
  articleConsentReviewSchema,
  articleConsentDecisionSchema,
  articleConnectionRevocationSchema,
  articleApprovalCandidateSchema,
  createArticleAuthoringGrantCommandSchema,
  articleCandidateApprovalSubmissionSchema,
  articleConnectionIdSchema,
  revokeArticleAuthoringGrantCommandSchema,
} from "@moya/contracts/schemas";
import type {
  ArticleApprovalCandidate,
  ArticleCandidateApprovalSubmission,
  CreateArticleAuthoringGrantCommand,
  RevokeArticleAuthoringGrantCommand,
} from "@moya/contracts";
import { authorRequest } from "./author-community-client";
const prefix = "article-authoring";
/** Reuse the sole Web public API transport and existing HttpOnly/account fence. */
export const articleDelegationClient = {
  consent: (uid: string, signal: AbortSignal) =>
    authorRequest(
      `${prefix}/consents/${encodeURIComponent(uid)}`,
      articleConsentReviewSchema,
      { accountScoped: true, signal },
    ),
  decide: (
    decision: "approve" | "deny",
    input: CreateArticleAuthoringGrantCommand,
  ) => {
    const body = createArticleAuthoringGrantCommandSchema.parse(input);
    return authorRequest(
      `${prefix}/consents/${encodeURIComponent(body.interactionUid)}/${decision}`,
      articleConsentDecisionSchema,
      { method: "POST", body },
    );
  },
  review: (input: ArticleApprovalCandidate, signal: AbortSignal) =>
    authorRequest(`${prefix}/approvals/review`, articleApprovalReviewSchema, {
      method: "POST",
      body: articleApprovalCandidateSchema.parse(input),
      signal,
    }),
  approve: (input: ArticleCandidateApprovalSubmission) =>
    authorRequest(`${prefix}/approvals`, articleApprovalResultSchema, {
      method: "POST",
      body: articleCandidateApprovalSubmissionSchema.parse(input),
    }),
  connections: () =>
    authorRequest(`${prefix}/connections`, articleAuthoringConnectionsSchema, {
      accountScoped: true,
    }),
  revoke: (id: string, input: RevokeArticleAuthoringGrantCommand) =>
    authorRequest(
      `${prefix}/connections/${articleConnectionIdSchema.parse(id)}/revoke`,
      articleConnectionRevocationSchema,
      {
        method: "POST",
        body: revokeArticleAuthoringGrantCommandSchema.parse(input),
      },
    ),
};
