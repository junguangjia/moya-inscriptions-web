"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentImageInput, MentionReference } from "@moya/contracts";

import {
  createLiveCommentSource,
  LIVE_COMMENT_PAGE_SIZE,
  LIVE_REPLY_PAGE_SIZE,
  toCommentItemPresentation,
  toCommentReplyPresentation,
  toCommentUserPresentation,
} from "./live-comments";

import type { LiveCommentSource } from "./live-comments";
import type {
  CommentItem,
  CommentReplyTarget,
  CommentUserPresentation,
} from "./comment-types";

export type LiveCommentListingStatus =
  "loading" | "ready" | "not-found" | "unavailable" | "unexpected-error";

export type LiveCommentViewer =
  | { readonly status: "checking" }
  | { readonly status: "signed-in"; readonly user: CommentUserPresentation }
  | { readonly status: "signed-out" }
  | { readonly status: "unavailable" };

export interface LiveCommentNotice {
  readonly tone: "info" | "error";
  readonly text: string;
}

interface Listing {
  readonly status: LiveCommentListingStatus;
  readonly hot: readonly CommentItem[];
  readonly latest: readonly CommentItem[];
  readonly page: number;
  readonly totalPages: number;
  /** Latest roots the Backend counted, excluding the hot ones. */
  readonly latestTotal: number;
}

const emptyListing: Listing = {
  hot: [],
  latest: [],
  latestTotal: 0,
  page: 0,
  status: "loading",
  totalPages: 0,
};

const submissionNotice = (state: string): LiveCommentNotice => {
  switch (state) {
    case "invalid-input":
      return {
        text: "评论内容无效：请输入 1–1000 字的纯文本，首尾不留空白。",
        tone: "error",
      };
    case "not-found":
      return { text: "这条资料或评论暂不接受回复。", tone: "error" };
    case "unauthenticated":
      return { text: "登录后才能发表评论。", tone: "error" };
    case "unavailable":
      return { text: "评论服务暂时不可用，请稍后再试。", tone: "error" };
    default:
      return { text: "评论发送失败，请稍后再试。", tone: "error" };
  }
};

const pendingNotice: LiveCommentNotice = {
  text: "已提交，待审核通过后才会显示。",
  tone: "info",
};

const mergeUnseen = <Item extends { readonly id: string }>(
  existing: readonly Item[],
  incoming: readonly Item[],
): Item[] => {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
};

const withThread = (
  items: readonly CommentItem[],
  rootId: string,
  update: (thread: CommentItem) => CommentItem,
): CommentItem[] =>
  items.map((item) => (item.id === rootId ? update(item) : item));

/**
 * The real comment client behind the accepted #106 seam. The listing is the
 * Backend's combined list: the hot section first, then the latest page. A
 * load-more request pins the hot ids it holds, so the latest pages exclude
 * exactly those roots; ids are still deduplicated on merge, because offset
 * pagination cannot promise stability under concurrent inserts. A refresh
 * replaces the whole list coherently, and every submission ends in one.
 */
export const useLiveComments = (
  catalogId: string,
  options: {
    readonly source?: LiveCommentSource;
    readonly now?: () => Date;
  } = {},
) => {
  const source = useMemo(
    () => options.source ?? createLiveCommentSource(),
    [options.source],
  );
  const now = options.now ?? (() => new Date());
  const nowRef = useRef(now);
  nowRef.current = now;
  const [listing, setListing] = useState<Listing>(emptyListing);
  const [viewer, setViewer] = useState<LiveCommentViewer>({
    status: "checking",
  });
  const [notice, setNotice] = useState<LiveCommentNotice | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A second click before the state re-renders must not start a second page.
  const loadingMoreRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const replyPages = useRef(new Map<string, number>());
  // Replies the reader published that no reply page has delivered yet: they
  // trail the paged ones in their thread until a page carries them.
  const trailingReplies = useRef(new Map<string, Set<string>>());

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      const result = await source.readListing(
        catalogId,
        { page: 1, pageSize: LIVE_COMMENT_PAGE_SIZE },
        signal,
      );
      if (signal?.aborted === true) return;
      replyPages.current = new Map();
      trailingReplies.current = new Map();
      if (result.state !== "success") {
        setListing({
          ...emptyListing,
          status:
            result.state === "invalid-query"
              ? "unexpected-error"
              : result.state,
        });
        return;
      }
      const at = nowRef.current();
      setListing({
        hot: result.page.hot.map((item) => toCommentItemPresentation(item, at)),
        latest: result.page.items.map((item) =>
          toCommentItemPresentation(item, at),
        ),
        latestTotal: result.page.total,
        page: result.page.page,
        status: "ready",
        totalPages: result.page.totalPages,
      });
    },
    [catalogId, source],
  );

  const loadViewer = useCallback(
    async (signal?: AbortSignal) => {
      const result = await source.readViewer(signal);
      if (signal?.aborted === true) return;
      if (result.state === "success")
        setViewer({
          status: "signed-in",
          user: toCommentUserPresentation(result.profile),
        });
      else if (result.state === "unauthenticated")
        setViewer({ status: "signed-out" });
      else setViewer({ status: "unavailable" });
    },
    [source],
  );

  useEffect(() => {
    const controller = new AbortController();
    setListing(emptyListing);
    setNotice(null);
    void loadFirstPage(controller.signal).catch(() => undefined);
    void loadViewer(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [loadFirstPage, loadViewer]);

  const refresh = useCallback(async () => {
    await loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || listing.status !== "ready") return;
    if (listing.page >= listing.totalPages) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await source.readListing(catalogId, {
        page: listing.page + 1,
        pageSize: LIVE_COMMENT_PAGE_SIZE,
        pinned: listing.hot.map((item) => item.id),
      });
      if (result.state !== "success") {
        setNotice({ text: "无法加载更多评论，请稍后再试。", tone: "error" });
        return;
      }
      setNotice((current) =>
        current?.text === "无法加载更多评论，请稍后再试。" ? null : current,
      );
      const at = nowRef.current();
      setListing((current) => ({
        ...current,
        latest: mergeUnseen(
          current.latest,
          result.page.items.map((item) => toCommentItemPresentation(item, at)),
        ),
        latestTotal: result.page.total,
        page: result.page.page,
        totalPages: result.page.totalPages,
      }));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [catalogId, listing, source]);

  const loadMoreReplies = useCallback(
    async (rootId: string) => {
      const page = (replyPages.current.get(rootId) ?? 0) + 1;
      const result = await source.readReplies(catalogId, rootId, {
        page,
        pageSize: LIVE_REPLY_PAGE_SIZE,
      });
      if (result.state !== "success") {
        setNotice({ text: "无法加载更多回复，请稍后再试。", tone: "error" });
        return;
      }
      replyPages.current.set(rootId, page);
      const at = nowRef.current();
      const incoming = result.page.items.map((reply) =>
        toCommentReplyPresentation(reply, at),
      );
      // Past the last page nothing more can arrive: the total then equals
      // what is shown, so the load-more control disappears even if a reply was
      // hidden between two loads.
      const exhausted = result.page.page >= result.page.totalPages;
      // The reader's own trailing replies stay last until a page carries
      // them, at which point the page decides their position.
      const trailing = new Set(trailingReplies.current.get(rootId));
      const carried = new Set(incoming.map((reply) => reply.id));
      for (const id of carried) trailingReplies.current.get(rootId)?.delete(id);
      const update = (thread: CommentItem): CommentItem => {
        const paged = thread.replies.filter((reply) => !trailing.has(reply.id));
        const replies = [
          ...mergeUnseen(paged, incoming),
          ...thread.replies.filter(
            (reply) => trailing.has(reply.id) && !carried.has(reply.id),
          ),
        ];
        return {
          ...thread,
          replies,
          replyTotal: exhausted ? replies.length : result.page.total,
        };
      };
      setNotice((current) =>
        current?.text === "无法加载更多回复，请稍后再试。" ? null : current,
      );
      setListing((current) => ({
        ...current,
        hot: withThread(current.hot, rootId, update),
        latest: withThread(current.latest, rootId, update),
      }));
    },
    [catalogId, source],
  );

  /** Explains a refused submission; a 401 also flips the viewer to signed out. */
  const reportFailure = useCallback((state: string) => {
    if (state === "unauthenticated") setViewer({ status: "signed-out" });
    setNotice(submissionNotice(state));
  }, []);

  /** Resolves true when the Backend accepted the comment (201 or 202). */
  const sendComment = useCallback(
    async (
      text: string,
      mentions: readonly MentionReference[] = [],
      images: readonly CommentImageInput[] = [],
      requestId?: string,
    ): Promise<boolean> => {
      if (submitting) return false;
      setSubmitting(true);
      try {
        const result =
          mentions.length || images.length || requestId
            ? await source.submitComment(
                catalogId,
                text,
                mentions,
                images,
                requestId,
              )
            : await source.submitComment(catalogId, text);
        if (result.state !== "success") {
          reportFailure(result.state);
          return false;
        }
        // A published root belongs at the top of the latest list; a pending
        // one refreshes as before so the reader sees the current list.
        setNotice(
          result.awaitingApproval
            ? pendingNotice
            : { text: "已发布。", tone: "info" },
        );
        await loadFirstPage();
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [catalogId, loadFirstPage, reportFailure, source, submitting],
  );

  /**
   * Resolves true when the Backend accepted the reply. The listing refreshes
   * as after any submission (the replied root may now be hot); a published
   * reply beyond the embedded first replies is then shown at the end of its
   * thread rather than hidden behind the reply pages, with the Backend's
   * refreshed total already counting it.
   */
  const sendReply = useCallback(
    async (
      target: CommentReplyTarget,
      text: string,
      mentions: readonly MentionReference[] = [],
      images: readonly CommentImageInput[] = [],
      requestId?: string,
    ): Promise<boolean> => {
      if (submitting) return false;
      setSubmitting(true);
      try {
        const result =
          mentions.length || images.length || requestId
            ? await source.submitReply(
                catalogId,
                target.rootCommentId,
                text,
                target.replyId,
                mentions,
                images,
                requestId,
              )
            : await source.submitReply(
                catalogId,
                target.rootCommentId,
                text,
                target.replyId,
              );
        if (result.state !== "success") {
          reportFailure(result.state);
          return false;
        }
        setNotice(
          result.awaitingApproval
            ? pendingNotice
            : { text: "已发布。", tone: "info" },
        );
        await loadFirstPage();
        if (result.awaitingApproval) return true;
        const reply = toCommentReplyPresentation(result.item, nowRef.current());
        const update = (thread: CommentItem): CommentItem => {
          if (thread.replies.some((existing) => existing.id === reply.id))
            return thread;
          const trailing =
            trailingReplies.current.get(thread.id) ?? new Set<string>();
          trailing.add(reply.id);
          trailingReplies.current.set(thread.id, trailing);
          return { ...thread, replies: [...thread.replies, reply] };
        };
        setListing((current) => ({
          ...current,
          hot: withThread(current.hot, target.rootCommentId, update),
          latest: withThread(current.latest, target.rootCommentId, update),
        }));
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [catalogId, loadFirstPage, reportFailure, source, submitting],
  );

  return {
    hasMore: listing.status === "ready" && listing.page < listing.totalPages,
    hot: listing.hot,
    latest: listing.latest,
    loadMore,
    loadMoreReplies,
    loadingMore,
    notice,
    refresh,
    /** Root comments only: the hot section plus every latest root. */
    rootTotal: listing.hot.length + listing.latestTotal,
    sendComment,
    sendReply,
    status: listing.status,
    submitting,
    viewer,
  };
};
