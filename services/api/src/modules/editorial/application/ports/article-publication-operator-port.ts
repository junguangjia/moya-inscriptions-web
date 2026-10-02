import type { ArticleId } from "@moya/contracts";
import type {
  ArticleModerationResult,
  ArticlePendingCandidate,
  ArticlePendingListQuery,
  ArticlePendingPage,
  ModerateArticlePendingCommand,
} from "@moya/contracts/internal/community-operator";

/** Private staff moderation; never attached to human public/MCP tools. */
export interface ArticlePublicationOperatorPort {
  listPending(query: ArticlePendingListQuery): Promise<ArticlePendingPage>;
  readPending(id: ArticleId): Promise<ArticlePendingCandidate>;
  moderatePending(
    operator: string,
    id: ArticleId,
    command: ModerateArticlePendingCommand,
    now: Date,
  ): Promise<ArticleModerationResult>;
}
