import {
  operatorWorksQuerySchema,
  operatorFeaturedQuerySchema,
  operatorUsersQuerySchema,
  recommendUserCommandSchema,
  moderateWorkCommandSchema,
  featuredMutationSchema,
  featuredOrderCommandSchema,
  featuredSettingsMutationSchema,
  operatorDeleteBodySchema,
  operatorRemoveThreadSchema,
} from "@moya/contracts/internal/community-operator";
import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";
import type { CommunityContentOperatorPort } from "../ports/community-content-operator-port.js";
import type { ExecutionFence } from "../ports/community-comment-port.js";
import type { DiscussionPort } from "../ports/discussion-port.js";
const parse = <T>(
  schema: {
    safeParse: (
      input: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new CommunityInputError("Invalid operator command");
  return result.data;
};
/** The internal command contract is enforced here, outside the Public API transport. */
export class CommunityContentOperatorService {
  constructor(
    private readonly content: CommunityContentOperatorPort | undefined,
    private readonly discussion: DiscussionPort | undefined,
    private readonly operator = "owner",
  ) {}
  private contentPort() {
    if (!this.content) throw new CommunityNotFoundError();
    return this.content;
  }
  readWorks(input: unknown) {
    return this.contentPort().readWorks(parse(operatorWorksQuerySchema, input));
  }
  readFeatured(input: unknown) {
    return this.contentPort().readFeatured(
      parse(operatorFeaturedQuerySchema, input),
    );
  }
  moderateWork(id: string, input: unknown) {
    return this.contentPort().moderateWork(
      id,
      this.operator,
      parse(moderateWorkCommandSchema, input),
    );
  }
  readUsers(input: unknown) {
    return this.contentPort().readUsers(parse(operatorUsersQuerySchema, input));
  }
  recommendUser(input: unknown) {
    return this.contentPort().recommendUser(
      this.operator,
      parse(recommendUserCommandSchema, input),
    );
  }
  setFeatured(input: unknown) {
    return this.contentPort().setFeatured(
      this.operator,
      parse(featuredMutationSchema, input),
    );
  }
  /**
   * One ordered recommendation command: the whole requested set commits, or
   * none of it does. The order is the array order and the store re-checks
   * every frozen version inside the same transaction.
   */
  setFeaturedOrder(input: unknown, fence?: ExecutionFence) {
    return this.contentPort().setFeaturedOrder(
      this.operator,
      parse(featuredOrderCommandSchema, input),
      fence,
    );
  }

  /** The authoritative result this exact ordered command committed, or null. */
  findFeaturedOrder(input: unknown) {
    return this.contentPort().findFeaturedOrder(
      this.operator,
      parse(featuredOrderCommandSchema, input),
    );
  }

  setFeaturedQuantity(input: unknown) {
    return this.contentPort().setFeaturedQuantity(
      this.operator,
      parse(featuredSettingsMutationSchema, input),
    );
  }
  async deleteBody(id: string, input: unknown) {
    if (!this.discussion) throw new CommunityNotFoundError();
    const command = parse(operatorDeleteBodySchema, input);
    await this.discussion.operatorDeleteBody(
      this.operator,
      id,
      command.requestId,
      command.reason,
    );
    return { deleted: true };
  }
  removeThread(id: string, input: unknown) {
    if (!this.discussion) throw new CommunityNotFoundError();
    const command = parse(operatorRemoveThreadSchema, input);
    return this.discussion.removeDiscussionThread(
      this.operator,
      id,
      command.requestId,
      command.expectedAffectedCount,
      command.reason,
    );
  }
}
