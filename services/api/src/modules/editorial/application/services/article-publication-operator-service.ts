import type { ArticleId } from "@moya/contracts";
import type {
  ArticleModerationResult,
  ArticlePendingCandidate,
  ArticlePendingListQuery,
  ArticlePendingPage,
  ModerateArticlePendingCommand,
} from "@moya/contracts/internal/community-operator";
import type { ArticlePublicationOperatorPort } from "../ports/article-publication-operator-port.js";

/** The transport validates the strict internal DTO; operator is server-fixed. */
export class ArticlePublicationOperatorService {
  private readonly operator: string;
  private readonly clock: () => Date;
  constructor(
    private readonly port: ArticlePublicationOperatorPort,
    options: {
      readonly operatorLabel?: string;
      readonly clock?: () => Date;
    } = {},
  ) {
    this.operator = options.operatorLabel ?? "owner";
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(this.operator))
      throw new Error("Invalid configured operator label");
    this.clock = options.clock ?? (() => new Date());
  }
  listPending(query: ArticlePendingListQuery): Promise<ArticlePendingPage> {
    return this.port.listPending(query);
  }
  readPending(id: ArticleId): Promise<ArticlePendingCandidate> {
    return this.port.readPending(id);
  }
  moderatePending(
    id: ArticleId,
    command: ModerateArticlePendingCommand,
  ): Promise<ArticleModerationResult> {
    return this.port.moderatePending(this.operator, id, command, this.clock());
  }
}
