import type {
  ArticleCandidateCommand,
  ArticleDraft,
  ArticlePublishResult,
} from "@moya/contracts";
import { ArticleRequestError } from "../../../lib/public-api/article-authoring-client";
import type { ArticleAutosave } from "./article-autosave";
import type { ArticleEditorClient } from "./article-editor-props";

export type ArticlePublicationCheckpoint = ReturnType<
  ArticleAutosave["publicationCheckpoint"]
>;
interface PublicationAttempt {
  readonly id: ArticleDraft["id"];
  readonly command: ArticleCandidateCommand;
  readonly checkpoint: ArticlePublicationCheckpoint;
}

/** Retain one exact intent until its receipt is verified or definitively refused. */
export const createArticlePublicationAttempt = (options: {
  readonly ownerId: ArticleDraft["ownerId"];
  readonly currentAccount: () => string | null;
  readonly accountEpoch: () => number;
  readonly publish: ArticleEditorClient["publish"];
  readonly requestId: () => string;
}) => {
  const epoch = options.accountEpoch();
  let closed = false;
  let attempt: PublicationAttempt | null = null;
  let unconfirmed = false;
  let active: Promise<{
    readonly result: ArticlePublishResult;
    readonly checkpoint: ArticlePublicationCheckpoint;
  }> | null = null;
  const requireAccount = () => {
    if (
      closed ||
      options.currentAccount() !== options.ownerId ||
      options.accountEpoch() !== epoch
    )
      throw new ArticleRequestError(401, "article_account_changed", true);
  };
  const submit = (
    candidate: Pick<ArticleDraft, "id" | "version" | "fingerprint">,
    checkpoint: ArticlePublicationCheckpoint,
    signal: AbortSignal,
  ) => {
    requireAccount();
    if (
      candidate.version !== checkpoint.version ||
      candidate.fingerprint !== checkpoint.fingerprint
    )
      return Promise.reject(
        new ArticleRequestError(409, "article_candidate_changed", false),
      );
    if (
      attempt !== null &&
      (attempt.id !== candidate.id ||
        attempt.command.expectedVersion !== candidate.version ||
        attempt.command.fingerprint !== candidate.fingerprint ||
        attempt.checkpoint.generation !== checkpoint.generation)
    )
      return Promise.reject(
        new ArticleRequestError(409, "article_publication_unconfirmed", true),
      );
    if (active !== null) return active;
    if (attempt === null)
      attempt = Object.freeze({
        id: candidate.id,
        command: Object.freeze({
          requestId: options.requestId(),
          expectedVersion: candidate.version,
          fingerprint: candidate.fingerprint,
        }),
        checkpoint: Object.freeze({ ...checkpoint }),
      });
    const exact = attempt;
    active = Promise.resolve()
      .then(async () => {
        requireAccount();
        try {
          const result = await options.publish(exact.id, exact.command, signal);
          requireAccount();
          if (
            result.requestId !== exact.command.requestId ||
            result.draft.id !== exact.id ||
            result.draft.ownerId !== options.ownerId ||
            result.draft.version !== exact.command.expectedVersion + 1 ||
            result.draft.fingerprint !== exact.command.fingerprint ||
            result.draft.status !== result.status
          )
            throw new ArticleRequestError(
              502,
              "article_invalid_publication_acknowledgement",
              true,
            );
          attempt = null;
          unconfirmed = false;
          return { result, checkpoint: exact.checkpoint };
        } catch (error) {
          if (closed) throw error;
          // Transport/parser uncertainty preserves the frozen request and body.
          // The public transport boundary marks every potentially committed write.
          unconfirmed =
            !(error instanceof ArticleRequestError) || error.outcomeUnknown;
          if (!unconfirmed) attempt = null;
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
    dispose: () => {
      closed = true;
      attempt = null;
      unconfirmed = false;
    },
  };
};
export type ArticlePublicationAttempt = ReturnType<
  typeof createArticlePublicationAttempt
>;
