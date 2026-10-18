"use client";

import { useState } from "react";
import type { DiscussionTarget } from "@moya/contracts";
import { FeedColophonPresentation } from "../authors/feed-colophon";
import type { DiscussionThread } from "../authors/use-discussion-thread";
import type { QaCommentScenarioName } from "../comments/comment-scenarios";
import type { useQaCommentStore } from "../comments/use-qa-comment-store";
import { qaCurrentUser } from "./user-scenarios";

const idle = () => undefined;

/** The same local QA store as normal Detail, with no runtime discussion reads. */
export const QaDetailColophon = ({
  target,
  title,
  store,
  scenario,
}: {
  readonly target: DiscussionTarget;
  readonly title: string;
  readonly store: ReturnType<typeof useQaCommentStore>;
  readonly scenario: QaCommentScenarioName;
}) => {
  const [highlightId, setHighlight] = useState<string | undefined>(undefined);
  const items = store.getItems(target.id);
  const thread: DiscussionThread = {
    hot: [],
    items,
    currentUser: qaCurrentUser,
    visibleTotal: items.reduce(
      (total, item) => total + 1 + item.replies.length,
      0,
    ),
    page: 1,
    totalPages: 1,
    hasMore: false,
    loading: scenario === "comment-loading",
    busy: false,
    submitting: false,
    unavailable: false,
    error: null,
    readError: null,
    actionError: null,
    notice: "",
    viewerState: { state: "signed-in" },
    composerClosed: false,
    closedNote: null,
    locatedPage: null,
    highlightId,
    repliesLoading: new Set(),
    lastSubmit: null,
    loadMore: idle,
    retry: idle,
    returnToLatest: idle,
    browseHighlightFromFirstReply: idle,
    loadReplies: idle,
    sendComment: async (text) => {
      store.sendComment(target.id, text, qaCurrentUser);
      return true;
    },
    sendReply: async (reply, text) => {
      store.sendReply(target.id, reply, text, qaCurrentUser);
      return true;
    },
    toggleLike: (root, reply) => store.toggleLike(target.id, root, reply),
    deleteBody: idle,
    setHighlight,
  };
  return (
    <FeedColophonPresentation
      target={target}
      title={title}
      thread={thread}
      presentation="detail"
    />
  );
};
