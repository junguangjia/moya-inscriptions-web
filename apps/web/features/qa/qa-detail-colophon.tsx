"use client";

import { useState } from "react";
import type { DiscussionTarget } from "@moya/contracts";
import { FeedColophonPresentation } from "../authors/feed-colophon";
import type { DiscussionThread } from "../authors/use-discussion-thread";
import type { QaCommentScenarioName } from "../comments/comment-scenarios";
import type { useQaCommentStore } from "../comments/use-qa-comment-store";
import { qaCurrentUser } from "./user-scenarios";
import { useAuthors } from "../authors/author-context";
import { CommentReportButton } from "../reporting/comment-report-button";
import type { CommentItem } from "../comments/comment-types";

const idle = () => undefined;

const QaCommentReport = () => {
  const [sent, setSent] = useState(false);
  const { notify } = useAuthors();
  return (
    <CommentReportButton
      sent={sent}
      disabled={sent}
      onClick={() => {
        setSent(true);
        notify("QA 演示：已标记，未提交真实举报");
      }}
    />
  );
};

/** Both QA readers share the live symbol, with no reporting transport. */
export const createQaCommentReportRenderer = (
  items: readonly CommentItem[],
) => {
  const reportable = new Set(
    items
      .flatMap((item) => [item, ...item.replies])
      .filter((item) => !item.deleted && item.user.id !== qaCurrentUser.id)
      .map((item) => item.id),
  );
  return (id: string) =>
    reportable.has(id) ? <QaCommentReport key={id} /> : null;
};

/** The same local QA store as normal Detail, with no runtime discussion reads. */
export const QaDetailColophon = ({
  target,
  title,
  store,
  scenario,
  presentation = "detail",
}: {
  readonly target: DiscussionTarget;
  readonly title: string;
  readonly store: ReturnType<typeof useQaCommentStore>;
  readonly scenario: QaCommentScenarioName;
  readonly presentation?: "detail" | "feed";
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
      imageUploadsEnabled={false}
      renderReport={createQaCommentReportRenderer(items)}
      target={target}
      title={title}
      thread={thread}
      presentation={presentation}
    />
  );
};
