"use client";

import { CommentSection } from "./comment-section";
import { useLiveComments } from "./use-live-comments";

import type { LiveCommentSource } from "./live-comments";
import type { CommentUserPresentation } from "./comment-types";

export interface LiveCommentSectionProps {
  readonly catalogId: string;
  /** Where a signed-out reader goes to sign in (the Development entry). */
  readonly signInHref: string;
  readonly source?: LiveCommentSource;
  readonly now?: () => Date;
}

/** Never rendered: the composer is replaced by the sign-in link when signed out. */
const anonymousReader: CommentUserPresentation = {
  avatarSrc: null,
  id: "anonymous",
  name: "访客",
};

/**
 * The accepted #106 comment presentation over the real comment client. QA
 * inputs are replaced by contract-derived props; the section itself is not
 * redesigned.
 */
export const LiveCommentSection = ({
  catalogId,
  signInHref,
  source,
  now,
}: LiveCommentSectionProps) => {
  const live = useLiveComments(catalogId, {
    ...(source === undefined ? {} : { source }),
    ...(now === undefined ? {} : { now }),
  });
  const viewer =
    live.viewer.status === "signed-in"
      ? ({ state: "signed-in" } as const)
      : live.viewer.status === "checking"
        ? ({ state: "checking" } as const)
        : live.viewer.status === "unavailable"
          ? ({ state: "unavailable" } as const)
          : ({ signInHref, state: "signed-out" } as const);
  return (
    <CommentSection
      catalogId={catalogId}
      currentUser={
        live.viewer.status === "signed-in" ? live.viewer.user : anonymousReader
      }
      hotItems={live.hot}
      items={live.latest}
      loadMore={{
        hasMore: live.hasMore,
        loading: live.loadingMore,
        onLoadMore: () => void live.loadMore(),
      }}
      loading={live.status === "loading"}
      notice={live.notice}
      onLoadMoreReplies={(rootId) => void live.loadMoreReplies(rootId)}
      onSendComment={(text, mentions, images, requestId) =>
        mentions?.length || images?.length || requestId
          ? live.sendComment(text, mentions, images, requestId)
          : live.sendComment(text)
      }
      onSendReply={(target, text, mentions, images, requestId) =>
        mentions?.length || images?.length || requestId
          ? live.sendReply(target, text, mentions, images, requestId)
          : live.sendReply(target, text)
      }
      presentation="live"
      status={
        live.status === "ready" || live.status === "loading"
          ? null
          : live.status
      }
      submitting={live.submitting}
      totalCount={live.rootTotal}
      viewer={viewer}
    />
  );
};
