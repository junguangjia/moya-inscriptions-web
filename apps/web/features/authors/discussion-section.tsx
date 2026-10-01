"use client";
import { useAuthEntry, useAuthReturnView } from "../auth/auth-return";
import type { MentionReference } from "@moya/contracts";
import { useEffect, useRef, useState } from "react";
import type {
  DiscussionTarget as ContentIdentity,
  DiscussionComment,
  DiscussionReply,
} from "@moya/contracts";
import { CommentSection } from "../comments/comment-section";
import type { CommentItem, CommentReply } from "../comments/comment-types";
import { useProductShell } from "../product-shell/product-shell";
import { authorClient, AuthorRequestError } from "./author-data";
import { useAuthors, contentKey } from "./author-context";
import { useDiscussionAvatars } from "./discussion-avatars";
import { useOwnWorkAudience } from "./own-work-audience";
import { requestIdentity } from "../shell/request-identity";
const row = (r: DiscussionReply): CommentReply => ({
  id: r.id,
  text: r.text,
  user: {
    id: r.author.id,
    name: r.author.displayName,
    studioName: r.author.studioName,
  },
  createdAtLabel: new Date(r.createdAt).toLocaleString(),
  likeCount: r.likeCount,
  liked: r.liked,
  deleted: r.deleted,
  ...(r.replyTo
    ? {
        replyToUser: {
          id: r.replyTo.id,
          name: r.replyTo.displayName,
          studioName: r.replyTo.studioName,
        },
      }
    : {}),
});
const rootRow = (r: DiscussionComment): CommentItem => ({
  ...row(r),
  isQaGenerated: false,
  replies: r.replies.map(row),
  replyTotal: r.replyTotal,
  replyPageTotal: r.replyPageTotal,
});
const ScopedDiscussionSection = ({ target }: { target: ContentIdentity }) => {
  const enterAuth = useAuthEntry();
  const author = useAuthors(),
    shell = useProductShell(),
    [hot, setHot] = useState<CommentItem[]>([]),
    [items, setItems] = useState<CommentItem[]>([]),
    [page, setPage] = useState(0),
    [totalPages, setTotalPages] = useState(0),
    [visibleTotal, setVisibleTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState<string | null>(null),
    [unavailable, setUnavailable] = useState(false),
    [notice, setNotice] = useState(""),
    [highlight, setHighlight] = useState<string>(),
    [locatedPage, setLocatedPage] = useState<number | null>(null);
  const sourcePage = useRef(0);
  sourcePage.current = page;
  const authReturnView = useAuthReturnView(
    `comments-window:${contentKey(target)}`,
    () => ({ pages: sourcePage.current }),
  );
  const mutationLocks = useRef(new Set<string>()),
    sendLock = useRef(false),
    failed = useRef<{ next: number; reset: boolean } | null>(null),
    listEpoch = useRef(0),
    epoch = useRef(0),
    loading = useRef(false),
    pinned = useRef<string[] | undefined>(undefined),
    replyInFlight = useRef(new Set<string>()),
    replyPages = useRef(new Map<string, number>()),
    listRef = useRef<CommentItem[]>([]);
  listRef.current = [...hot, ...items];
  const withAvatar = useDiscussionAvatars(listRef.current);
  // On the author's own work that others cannot see now (or not known again
  // after a visibility change), no comment can be sent: the composer gives
  // way to a truthful note, without any pending or review wording. Readers
  // of a public work, and every other target, keep the composer.
  const audience = useOwnWorkAudience(
    target.type === "work" ? (author.viewer?.id ?? null) : null,
    target.type === "work" ? target.id : null,
  );
  const composerClosed = audience !== null && audience.publiclyVisible !== true;
  const closedNote =
    audience === null || audience.publiclyVisible === true
      ? null
      : audience.publiclyVisible === false
        ? audience.visibility === "self"
          ? "此作品当前仅你可见，暂时无法发表评论。"
          : "此作品当前不对其他人显示，暂时无法发表评论。"
        : audience.unconfirmed === true
          ? "暂时无法确认其他人能否看到此作品，暂时无法发表评论。"
          : null;
  const present = (comment: CommentItem): CommentItem => ({
    ...comment,
    user: withAvatar(comment.user),
    replies: comment.replies.map((reply) => ({
      ...reply,
      user: withAvatar(reply.user),
    })),
  });
  const load = async (next = 1, reset = false) => {
    if (reset) {
      listEpoch.current++;
      loading.current = false;
      replyInFlight.current.clear();
    }
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setError(null);
    const run = epoch.current,
      listRun = listEpoch.current;
    try {
      const result = await authorClient.discussion(
        target,
        next,
        reset ? undefined : pinned.current,
      );
      if (run !== epoch.current || listRun !== listEpoch.current) return;
      failed.current = null;
      if (reset || next === 1) {
        pinned.current = result.hot.map((i) => i.id);
        setHot(result.hot.map(rootRow));
        setItems(result.items.map(rootRow));
        replyPages.current.clear();
      } else setItems((old) => [...old, ...result.items.map(rootRow)]);
      setPage(next);
      setTotalPages(result.totalPages);
      setVisibleTotal(result.visibleTotal);
      setUnavailable(false);
    } catch (e) {
      if (run === epoch.current && listRun === listEpoch.current) {
        failed.current = { next, reset };
        setError(e instanceof Error ? e.message : "评论加载失败");
        setUnavailable(e instanceof AuthorRequestError && e.status === 404);
      }
    } finally {
      if (run === epoch.current && listRun === listEpoch.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!author.checking && page === 0 && !loading.current && !error)
      void load(1, true);
  }, [author.checking, page, error]);
  useEffect(() => {
    if (
      authReturnView &&
      !author.checking &&
      page > 0 &&
      page < Math.min(authReturnView.pages, totalPages) &&
      !loading.current &&
      !error
    )
      void load(page + 1);
  }, [authReturnView, author.checking, page, totalPages, busy, error]);
  useEffect(
    () => () => {
      epoch.current++;
      loading.current = false;
    },
    [],
  );
  const loadReplies = async (root: string, through?: number) => {
    if (replyInFlight.current.has(root)) return;
    replyInFlight.current.add(root);
    const run = epoch.current,
      listRun = listEpoch.current;
    try {
      let remaining = 0;
      const begin = through ?? (replyPages.current.get(root) ?? 0) + 1,
        finish = begin;
      let rows: CommentReply[] = [];
      for (let n = begin; n <= finish; n++) {
        const result = await authorClient.replies(target, root, n);
        if (run !== epoch.current || listRun !== listEpoch.current) return;
        rows = [...rows, ...result.items.map(row)];
        remaining = Math.max(0, result.total - result.page * result.pageSize);
      }
      const update = (old: CommentItem[]) =>
        old.map((c) =>
          c.id === root
            ? {
                ...c,
                replyRemaining: remaining,
                replies:
                  through || begin === 1 ? rows : [...c.replies, ...rows],
              }
            : c,
        );
      setItems(update);
      setHot(update);
      replyPages.current.set(root, finish);
    } catch (e) {
      if (run === epoch.current && listRun === listEpoch.current)
        setError(e instanceof Error ? e.message : "回复加载失败");
    } finally {
      if (listRun === listEpoch.current) replyInFlight.current.delete(root);
    }
  };
  useEffect(() => {
    const location = author.cache.get("discussion-location") as
      { target: ContentIdentity; id: string } | undefined;
    if (
      author.checking ||
      page !== 1 ||
      !location ||
      contentKey(location.target) !== contentKey(target)
    )
      return;
    author.cache.delete("discussion-location");
    const run = epoch.current,
      listRun = listEpoch.current;
    const locate = async () => {
      try {
        const pinnedIds = pinned.current ?? [];
        const found = await authorClient.locate(target, location.id, pinnedIds);
        if (run !== epoch.current || listRun !== listEpoch.current) return;
        const containing = await authorClient.discussion(
          target,
          found.page,
          pinnedIds,
        );
        if (run !== epoch.current || listRun !== listEpoch.current) return;
        setItems(containing.items.map(rootRow));
        setPage(found.page);
        setTotalPages(containing.totalPages);
        setLocatedPage(found.page);
        if (found.replyPage > 0) {
          await loadReplies(found.rootId, found.replyPage);
          if (run !== epoch.current || listRun !== listEpoch.current) return;
        }
        setHighlight(location.id);
      } catch {
        if (run === epoch.current && listRun === listEpoch.current)
          setNotice("这条评论的位置已不可用，原文仍可在“我的评论”查看");
      }
    };
    void locate();
  }, [page, author.checking]);
  const send = async (
    text: string,
    root?: string,
    reply?: string,
    mentions: readonly MentionReference[] = [],
  ) => {
    if (sendLock.current || !author.viewer || author.checking || composerClosed)
      return false;
    sendLock.current = true;
    const run = epoch.current;
    setSubmitting(true);
    try {
      if (mentions.length)
        await authorClient.send(target, text, root, reply, mentions);
      else await authorClient.send(target, text, root, reply);
      if (run === epoch.current) {
        setNotice("已发送");
        await load(1, true);
      }
      return true;
    } catch (e) {
      if (run === epoch.current)
        setError(e instanceof Error ? e.message : "发送失败，输入仍保留");
      return false;
    } finally {
      sendLock.current = false;
      if (run === epoch.current) setSubmitting(false);
    }
  };
  const mutateItem = async (
    id: string,
    path: string,
    body: unknown,
    method = "POST",
  ) => {
    if (mutationLocks.current.has(id)) return;
    mutationLocks.current.add(id);
    const run = epoch.current;
    try {
      await authorClient.command(path, body, method);
      if (run === epoch.current) await load(1, true);
    } catch (e) {
      if (run === epoch.current)
        setError(e instanceof Error ? e.message : "操作未完成");
    } finally {
      mutationLocks.current.delete(id);
    }
  };
  return (
    <div>
      {locatedPage !== null && (
        <div className="phase4-actions">
          <span>已定位到第 {locatedPage} 页；展开回复从所在页开始。</span>
          {highlight && (
            <button
              type="button"
              onClick={() => {
                const root = listRef.current.find(
                  (c) =>
                    c.id === highlight ||
                    c.replies.some((r) => r.id === highlight),
                );
                if (root) void loadReplies(root.id, 1);
              }}
            >
              从第一条回复浏览
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setLocatedPage(null);
              setHighlight(undefined);
              void load(1, true);
            }}
          >
            返回最新评论
          </button>
        </div>
      )}
      {closedNote === null ? null : (
        // Outside the section's notice line, so a comment error never hides it.
        <p className="phase4-muted" data-discussion-closed="" role="status">
          {closedNote}
        </p>
      )}
      <CommentSection
        // The closed box is its own editor scope. CommentSection has no prop
        // for a closed box, so 回复 there still sets a reply target nothing
        // shows; scoping it away means the box never reopens in 回复 X mode
        // on a comment the author answered while nobody else could see the
        // work. Only the editor (its draft and reply target) is scoped by
        // this value, so the comments themselves stay as they are.
        contentKey={`${contentKey(target)}${composerClosed ? ":closed" : ""}`}
        currentUser={
          author.viewer
            ? withAvatar({
                id: author.viewer.id,
                name: author.viewer.displayName,
                studioName: author.viewer.studioName,
              })
            : { id: "guest", name: "访客" }
        }
        items={items.map(present)}
        hotItems={hot.map(present)}
        onSendComment={(text, refs) => send(text, undefined, undefined, refs)}
        onSendReply={(reply, text, refs) =>
          send(text, reply.rootCommentId, reply.replyId, refs)
        }
        onToggleLike={(root, reply) => {
          if (!author.viewer) {
            enterAuth(author.signInHref);
            return;
          }
          const id = reply ?? root,
            c = listRef.current.find((c) => c.id === root),
            r = reply ? c?.replies.find((r) => r.id === reply) : c;
          if (!r) return;
          void mutateItem(id, `discussion/items/${id}/like`, {
            requestId: requestIdentity(),
            enabled: !r.liked,
          });
        }}
        onOpenAuthor={(id, opener) => shell.openProfile(id, opener)}
        onDeleteBody={(id) => {
          if (!window.confirm("删除正文？其他人的回复将保留。")) return;
          void mutateItem(
            id,
            `discussion/items/${id}/body`,
            { requestId: requestIdentity() },
            "DELETE",
          );
        }}
        {...(highlight ? { highlightCommentId: highlight } : {})}
        presentation="live"
        viewer={
          // A closed composer renders nothing in its place (the note says why).
          author.checking || composerClosed
            ? { state: "checking" }
            : author.sessionError
              ? { state: "unavailable" }
              : author.viewer
                ? { state: "signed-in" }
                : { state: "signed-out", signInHref: author.signInHref }
        }
        loading={page === 0 && !error && !unavailable}
        status={unavailable ? "not-found" : null}
        notice={
          error
            ? { tone: "error", text: error }
            : notice
              ? { tone: "info", text: notice }
              : null
        }
        totalCount={visibleTotal}
        submitting={submitting}
        loadMore={{
          hasMore: page < totalPages,
          loading: busy,
          onLoadMore: () => void load(page + 1),
        }}
        onLoadMoreReplies={(id) => void loadReplies(id)}
      />
      {error && (
        <button
          className="phase4-button"
          onClick={() =>
            void load(failed.current?.next ?? 1, failed.current?.reset ?? true)
          }
        >
          重试读取评论
        </button>
      )}
    </div>
  );
};

export const DiscussionSection = ({ target }: { target: ContentIdentity }) => {
  const author = useAuthors();
  return (
    <ScopedDiscussionSection
      key={`${author.viewer?.id ?? "guest"}:${contentKey(target)}`}
      target={target}
    />
  );
};
