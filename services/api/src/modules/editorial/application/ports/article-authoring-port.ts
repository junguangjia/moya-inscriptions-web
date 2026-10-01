import type {
  ArticleOwnMediaListQuery,
  ArticleOwnMediaPage,
  ArticleDraft,
  ArticleDraftPage,
  ArticleValidationResult,
  ArticleValidationIssue,
  ArticleBlockEditsCommand,
  ArticlePreview,
  ArticleMediaReference,
  ArticleDraftListQuery as SharedArticleDraftListQuery,
  ArticleId,
  ArticleAuthoringDocument,
  PublicUserId,
  CreateArticleDraftCommand,
  UpdateArticleDraftCommand,
  DeleteArticleDraftCommand,
  ArticleDraftDeletionResult,
  PublishArticleCommand,
} from "@moya/contracts";

/** Internal, transport-bound identity. Never parsed from a public command DTO. */
export type ArticleAuthoringActor =
  | { readonly source: "human"; readonly userId: PublicUserId }
  | {
      readonly source: "delegated";
      readonly userId: PublicUserId;
      readonly connectionId: string;
      readonly generation: number;
      readonly grantId: string;
      readonly expiresAt: string;
      readonly scopes: readonly string[];
      readonly approvalId?: string;
    };

// Shared transport commands are derived from the strict contract schemas.
export type ArticleCreateCommand = CreateArticleDraftCommand;
export type ArticleSaveCommand = UpdateArticleDraftCommand;
export type ArticleCandidateIdentity = Pick<
  PublishArticleCommand,
  "expectedVersion" | "fingerprint"
>;
export type ArticlePublishCommand = PublishArticleCommand;
export type ArticleWithdrawCommand = PublishArticleCommand;
export type ArticleDraftListQuery = SharedArticleDraftListQuery;
export type ArticleAuthoringPage = ArticleDraftPage;
export type ArticleCandidateValidation = ArticleValidationResult;
export type ArticleReferenceIssue = ArticleValidationIssue;
/** Exact immutable publication snapshot consumed by the SAME Article reader. */
export interface PublishedAuthoredArticle {
  readonly id: ArticleId;
  readonly ownerId: PublicUserId;
  readonly version: number;
  readonly title: string;
  readonly coverRefId: string | null;
  readonly document: ArticleAuthoringDocument;
  readonly fingerprint: string;
  readonly byline: string;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export type PublishedAuthoredArticleSummary = Omit<
  PublishedAuthoredArticle,
  "document"
> & {
  readonly coverReference: ArticleMediaReference | null;
};

/** All actor-bearing calls check current identity/grant, including receipt replay. */
export interface ArticleAuthoringPort {
  listOwnMedia(
    actor: ArticleAuthoringActor,
    query: ArticleOwnMediaListQuery,
    now: Date,
  ): Promise<ArticleOwnMediaPage>;
  create(
    actor: ArticleAuthoringActor,
    command: ArticleCreateCommand,
    now: Date,
  ): Promise<ArticleDraft>;
  read(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    now: Date,
  ): Promise<ArticleDraft>;
  list(
    actor: ArticleAuthoringActor,
    query: ArticleDraftListQuery,
    now: Date,
  ): Promise<ArticleAuthoringPage>;
  save(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleSaveCommand,
    now: Date,
  ): Promise<ArticleDraft>;
  /** Human-only private-draft deletion; immutable publication remains visible. */
  deleteDraft(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: DeleteArticleDraftCommand,
    now: Date,
  ): Promise<ArticleDraftDeletionResult>;
  editBlocks(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleBlockEditsCommand,
    now: Date,
  ): Promise<ArticleDraft>;
  validate(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    candidate: ArticleCandidateIdentity,
    now: Date,
  ): Promise<ArticleCandidateValidation>;
  preview(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    candidate: ArticleCandidateIdentity,
    now: Date,
  ): Promise<ArticlePreview>;
  publish(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticlePublishCommand,
    now: Date,
  ): Promise<ArticleDraft>;
  withdraw(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleWithdrawCommand,
    now: Date,
  ): Promise<ArticleDraft>;
  readPublished(id: ArticleId): Promise<PublishedAuthoredArticle | null>;
  listPublished(query: {
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{
    readonly items: readonly PublishedAuthoredArticleSummary[];
    readonly total: number;
  }>;
}
