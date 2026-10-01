import type {
  ArticleConsentReview,
  CreateArticleAuthoringGrantCommand,
} from "@moya/contracts";
import { AuthorRequestError } from "../../../lib/public-api/author-community-client";
import type { articleDelegationClient } from "../../../lib/public-api/article-delegation-client";

type Decision = Parameters<typeof articleDelegationClient.decide>[0];
type Result = Awaited<ReturnType<typeof articleDelegationClient.decide>>;
interface ConsentAttempt {
  readonly decision: Decision;
  readonly command: CreateArticleAuthoringGrantCommand;
}

/** A lost one-use consent answer must replay the exact human decision receipt. */
export const createArticleConsentAttempt = (options: {
  readonly ownerId: string;
  readonly interactionUid: string;
  readonly currentAccount: () => string | null;
  readonly accountEpoch: () => number;
  readonly requestId: () => string;
  readonly decide: typeof articleDelegationClient.decide;
}) => {
  const epoch = options.accountEpoch();
  let closed = false;
  let attempt: ConsentAttempt | null = null;
  let unconfirmed = false;
  let active: Promise<Result> | null = null;
  const requireAccount = () => {
    if (
      closed ||
      options.currentAccount() !== options.ownerId ||
      options.accountEpoch() !== epoch
    )
      throw new AuthorRequestError(401, "账户状态已变化，请重新读取");
  };
  const submit = (decision: Decision, review: ArticleConsentReview) => {
    requireAccount();
    if (review.interactionUid !== options.interactionUid)
      return Promise.reject(new AuthorRequestError(409, "授权请求已变化"));
    if (
      attempt !== null &&
      (attempt.decision !== decision ||
        attempt.command.consentTicket !== review.consentTicket ||
        JSON.stringify(attempt.command.scopes) !==
          JSON.stringify(review.scopes))
    )
      return Promise.reject(
        new AuthorRequestError(409, "请先确认上一次授权决定的结果"),
      );
    if (active !== null) return active;
    if (attempt === null)
      attempt = Object.freeze({
        decision,
        command: Object.freeze({
          requestId: options.requestId(),
          interactionUid: options.interactionUid,
          consentTicket: review.consentTicket,
          scopes: [...review.scopes],
        }),
      });
    const exact = attempt;
    active = Promise.resolve()
      .then(async () => {
        requireAccount();
        try {
          const result = await options.decide(exact.decision, exact.command);
          requireAccount();
          if (result.decision !== exact.decision)
            throw new AuthorRequestError(502, "授权决定回执尚未确认");
          attempt = null;
          unconfirmed = false;
          return result;
        } catch (error) {
          if (!closed) {
            // The shared transport throws parser/network errors or an HTTP error.
            // 5xx replies can follow a committed decision; retain their receipt.
            unconfirmed =
              !(error instanceof AuthorRequestError) || error.status >= 500;
            if (!unconfirmed) attempt = null;
          }
          throw error;
        }
      })
      .finally(() => {
        active = null;
      });
    return active;
  };
  return {
    submit,
    pending: () => attempt,
    unconfirmed: () => unconfirmed,
    isCurrent: () =>
      !closed &&
      options.currentAccount() === options.ownerId &&
      options.accountEpoch() === epoch,
    dispose: () => {
      closed = true;
      attempt = null;
      unconfirmed = false;
    },
  };
};
