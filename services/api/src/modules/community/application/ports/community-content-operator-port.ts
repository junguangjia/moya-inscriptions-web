import type { ExecutionFence } from "./community-comment-port.js";
import type {
  OperatorReadScope,
  OperatorWorksQuery,
  OperatorFeaturedQuery,
  OperatorUsersQuery,
  OperatorUserPage,
  RecommendUserCommand,
  OperatorWork,
  OperatorWorkPage,
  ModerateWorkCommand,
  FeaturedMutation,
  FeaturedOrderCommand,
  FeaturedOrderResult,
  FeaturedSettingsMutation,
  FeaturedPage,
} from "@moya/contracts/internal/community-operator";
export interface CommunityContentOperatorPort {
  readWorkTitle(id: string): Promise<string | null>;
  readWorks(
    query: OperatorWorksQuery,
    scope?: OperatorReadScope,
  ): Promise<OperatorWorkPage>;
  readUsers(
    query: OperatorUsersQuery,
    scope?: OperatorReadScope,
  ): Promise<OperatorUserPage>;
  recommendUser(
    operator: string,
    input: RecommendUserCommand,
  ): Promise<{ version: number }>;
  moderateWork(
    id: string,
    operator: string,
    input: ModerateWorkCommand,
  ): Promise<OperatorWork>;
  readFeatured(
    query: OperatorFeaturedQuery,
    scope?: OperatorReadScope,
  ): Promise<FeaturedPage>;
  setFeatured(
    operator: string,
    input: FeaturedMutation,
  ): Promise<{ version: number }>;
  /**
   * One ordered recommendation command (Issue #141 r6). The whole requested
   * set commits in one transaction on one connection together with its audit
   * events and its authoritative execution receipt, or nothing commits: a
   * target that became ineligible, a frozen version that went stale, or a
   * concurrent change to any one row refuses the command with no partial
   * order left behind. A repeated identity carrying the same command replays
   * the committed result; carrying a different command it conflicts.
   */
  setFeaturedOrder(
    operator: string,
    input: FeaturedOrderCommand,
    fence?: ExecutionFence,
  ): Promise<FeaturedOrderResult>;

  /**
   * The result this exact ordered command already committed, or null when it
   * committed nothing. Read-only, so a caller that must not act — a cancelled
   * operation deciding whether its effects are real — can still read the
   * truth. A receipt stored under the same identity for a different command
   * answers null, because it is not this command's result.
   */
  findFeaturedOrder(
    operator: string,
    input: FeaturedOrderCommand,
  ): Promise<FeaturedOrderResult | null>;

  setFeaturedQuantity(
    operator: string,
    input: FeaturedSettingsMutation,
  ): Promise<{ version: number }>;
}
