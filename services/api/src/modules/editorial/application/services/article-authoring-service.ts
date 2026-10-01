import type {
  ArticleOwnMediaListQuery,
  ArticleOwnMediaPage,
  ArticleId,
  ArticleDraft,
  ArticleDraftPage,
  ArticleDraftListQuery,
  ArticlePreview,
  ArticleValidationResult,
  ArticleBlockEditsCommand,
  CreateArticleDraftCommand,
  UpdateArticleDraftCommand,
  DeleteArticleDraftCommand,
  ArticleDraftDeletionResult,
  ArticleCandidateCommand,
} from "@moya/contracts";
import type {
  ArticleAuthoringActor,
  ArticleAuthoringPort,
} from "../ports/article-authoring-port.js";

export interface ArticleAuthoringServiceOptions {
  readonly now?: () => Date;
}

/**
 * HTTP and MCP pass the shared strict transport-parser output. Identity is
 * independently authenticated by the transport, never parsed from commands.
 * The port owns current authorization, version checks and transaction receipts.
 */
export class ArticleAuthoringService {
  private readonly now: () => Date;
  constructor(
    private readonly port: ArticleAuthoringPort,
    options: ArticleAuthoringServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }
  listOwnMedia(
    actor: ArticleAuthoringActor,
    query: ArticleOwnMediaListQuery,
  ): Promise<ArticleOwnMediaPage> {
    return this.port.listOwnMedia(actor, query, this.now());
  }
  create(
    actor: ArticleAuthoringActor,
    command: CreateArticleDraftCommand,
  ): Promise<ArticleDraft> {
    return this.port.create(actor, command, this.now());
  }
  read(actor: ArticleAuthoringActor, id: ArticleId): Promise<ArticleDraft> {
    return this.port.read(actor, id, this.now());
  }
  list(
    actor: ArticleAuthoringActor,
    query: ArticleDraftListQuery,
  ): Promise<ArticleDraftPage> {
    return this.port.list(actor, query, this.now());
  }
  save(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: UpdateArticleDraftCommand,
  ): Promise<ArticleDraft> {
    return this.port.save(actor, id, command, this.now());
  }
  deleteDraft(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: DeleteArticleDraftCommand,
  ): Promise<ArticleDraftDeletionResult> {
    return this.port.deleteDraft(actor, id, command, this.now());
  }
  validate(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleCandidateCommand,
  ): Promise<ArticleValidationResult> {
    return this.port.validate(actor, id, command, this.now());
  }
  preview(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleCandidateCommand,
  ): Promise<ArticlePreview> {
    return this.port.preview(actor, id, command, this.now());
  }
  publish(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleCandidateCommand,
  ): Promise<ArticleDraft> {
    return this.port.publish(actor, id, command, this.now());
  }
  withdraw(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleCandidateCommand,
  ): Promise<ArticleDraft> {
    return this.port.withdraw(actor, id, command, this.now());
  }
  /** The port applies the batch inside its version/receipt transaction. */
  editBlocks(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleBlockEditsCommand,
  ): Promise<ArticleDraft> {
    return this.port.editBlocks(actor, id, command, this.now());
  }
}
