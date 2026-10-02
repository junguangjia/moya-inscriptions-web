import type {
  ArticleAuthoringGrant,
  ArticleAuthoringScope,
  PublicUserId,
  ArticleApprovalCandidate,
  ArticleApprovalResult,
  ArticleCandidateApprovalSubmission,
} from "@moya/contracts";
import type { ArticleAuthoringActor } from "./article-authoring-port.js";

/** The authoring service and delegated transport use the same trusted actor. */
export type ArticleDelegationActor = ArticleAuthoringActor;
export interface ArticleConsentInteraction {
  readonly interactionUid: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly ArticleAuthoringScope[];
  readonly expiresAt: string;
  readonly decision: "approved" | "denied" | null;
  readonly ownerId: PublicUserId | null;
  readonly connectionId: string | null;
  readonly generation: number | null;
  readonly resumedAt: string | null;
}
export interface ArticleConsentPort {
  open(input: {
    readonly interactionUid: string;
    readonly clientId: string;
    readonly scopes: readonly string[];
    readonly expiresAt: Date;
  }): Promise<ArticleConsentInteraction>;
  read(uid: string): Promise<ArticleConsentInteraction | null>;
  prepareReview(
    ownerId: PublicUserId,
    uid: string,
    now: Date,
  ): Promise<{ interaction: ArticleConsentInteraction; consentTicket: string }>;
  decide(
    ownerId: PublicUserId,
    input: {
      readonly requestId: string;
      readonly interactionUid: string;
      readonly consentTicket: string;
      readonly decision: "approve" | "deny";
      readonly scopes: readonly ArticleAuthoringScope[];
    },
    now: Date,
  ): Promise<ArticleConsentInteraction>;
  finalizeGrant(
    uid: string,
    grantId: string,
    now: Date,
  ): Promise<ArticleConsentInteraction>;
}
export interface ArticleDelegationPort {
  list(ownerId: PublicUserId): Promise<ArticleAuthoringGrant[]>;
  revoke(
    ownerId: PublicUserId,
    connectionId: string,
    expectedGeneration: number,
    now: Date,
  ): Promise<void>;
  prepareApprovalReview(
    ownerId: PublicUserId,
    input: ArticleApprovalCandidate,
    now: Date,
  ): Promise<{ reviewTicket: string }>;
  readApproval(
    actor: Extract<ArticleDelegationActor, { source: "delegated" }>,
    input: ArticleApprovalCandidate,
    now: Date,
  ): Promise<ArticleApprovalResult | null>;
  approveCandidate(
    ownerId: PublicUserId,
    input: ArticleCandidateApprovalSubmission,
    now: Date,
  ): Promise<ArticleApprovalResult>;
}
