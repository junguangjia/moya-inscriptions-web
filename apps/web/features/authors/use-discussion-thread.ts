"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscussionComment,
  DiscussionReply,
  DiscussionTarget,
  MentionReference,
} from "@moya/contracts";
import { useAuthEntry, useAuthReturnView } from "../auth/auth-return";
import type { CommentViewerState } from "../comments/comment-section";
import type {
  CommentItem,
  CommentReply,
  CommentReplyTarget,
  CommentUserPresentation,
} from "../comments/comment-types";
import { requestIdentity } from "../shell/request-identity";
import { useAuthors, contentKey } from "./author-context";
import { authorClient, AuthorRequestError } from "./author-data";
import { publishCommentCount } from "./content-state-bus";
import { useDiscussionAvatars } from "./discussion-avatars";
import { useOwnWorkAudience } from "./own-work-audience";

export const row = (r: DiscussionReply): CommentReply => ({
  id: r.id,
  text: r.text,
  user: {
    id: r.author.id,
    name: r.author.displayName,
    studioName: r.author.studioName,
  },
  createdAtLabel: new Date(r.createdAt).toLocaleString(),
  createdAt: r.createdAt,
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

export const rootRow = (r: DiscussionComment): CommentItem => ({
  ...row(r),
  isQaGenerated: false,
  replies: r.replies.map(row),
  replyTotal: r.replyTotal,
  replyPageTotal: r.replyPageTotal,
});

export interface DiscussionThreadOptions {
  readonly target: DiscussionTarget;
  /** Default true. Gates ONLY the initial-read effect and the locate effect. Turning false never resets state. */
  readonly enabled?: boolean;
  /** Default `comments-window:${contentKey(target)}`. */
  readonly authReturnSlot?: string;
  /** Default true. Colophon passes false: never consumes author.cache "discussion-location". */
  readonly consumeLocation?: boolean;
  /** Default "detail" (today's behaviour, byte-for-byte). */
  readonly mode?: "detail" | "colophon";
}

export interface DiscussionThread {
  /** Presented rows: avatars applied to root and reply users, not to replyToUser. */
  readonly hot: readonly CommentItem[];
  readonly items: readonly CommentItem[];
  readonly currentUser: CommentUserPresentation;
  readonly visibleTotal: number;
  readonly page: number;
  readonly totalPages: number;
  /** page < totalPages */
  readonly hasMore: boolean;
  /** page === 0 && !error && !unavailable */
  readonly loading: boolean;
  /** A list read (or an in-place refresh) is in flight. */
  readonly busy: boolean;
  readonly submitting: boolean;
  /** The discussion answered 404. */
  readonly unavailable: boolean;
  /** Detail: the shared error channel. Colophon: list-read failures only (same as readError). */
  readonly error: string | null;
  /** Colophon: list-read failures only. Always null in detail mode. */
  readonly readError: string | null;
  /** Colophon: send, like, delete and reply-page failures. Always null in detail mode. */
  readonly actionError: {
    readonly id: string | null;
    readonly message: string;
  } | null;
  readonly notice: string;
  readonly viewerState: CommentViewerState;
  readonly composerClosed: boolean;
  readonly closedNote: string | null;
  readonly locatedPage: number | null;
  readonly highlightId: string | undefined;
  /** Root ids whose reply page is being read. */
  readonly repliesLoading: ReadonlySet<string>;
  /** The latest accepted submission; set after the in-place refresh when it is public. */
  readonly lastSubmit: {
    readonly id: string;
    readonly rootId: string;
    readonly awaitingApproval: boolean;
  } | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly returnToLatest: () => void;
  readonly browseHighlightFromFirstReply: () => void;
  readonly loadReplies: (rootId: string, through?: number) => void;
  readonly sendComment: (
    text: string,
    mentions?: readonly MentionReference[],
  ) => Promise<boolean>;
  readonly sendReply: (
    t: CommentReplyTarget,
    text: string,
    mentions?: readonly MentionReference[],
  ) => Promise<boolean>;
  /** A guest goes to sign-in, returning focus to `opener`. */
  readonly toggleLike: (
    rootId: string,
    replyId?: string,
    opener?: HTMLElement,
  ) => void;
  /** No confirmation here: the caller confirms. */
  readonly deleteBody: (id: string) => void;
  readonly setHighlight: (id: string | undefined) => void;
}

type Operations = Pick<
  DiscussionThread,
  | "loadMore"
  | "retry"
  | "returnToLatest"
  | "browseHighlightFromFirstReply"
  | "loadReplies"
  | "sendComment"
  | "sendReply"
  | "toggleLike"
  | "deleteBody"
  | "setHighlight"
>;

const messageOf = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

export function useDiscussionThread({
  target,
  enabled = true,
  authReturnSlot = `comments-window:${contentKey(target)}`,
  consumeLocation = true,
  mode = "detail",
}: DiscussionThreadOptions): DiscussionThread {
  const colophon = mode === "colophon";
  const enterAuth = useAuthEntry();
  const author = useAuthors(),
    [hot, setHot] = useState<CommentItem[]>([]),
    [items, setItems] = useState<CommentItem[]>([]),
    [page, setPage] = useState(0),
    [totalPages, setTotalPages] = useState(0),
    [visibleTotal, setVisibleTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState<string | null>(null),
    [actionError, setActionError] =
      useState<DiscussionThread["actionError"]>(null),
    [unavailable, setUnavailable] = useState(false),
    [notice, setNotice] = useState(""),
    [highlight, setHighlight] = useState<string>(),
    [locatedPage, setLocatedPage] = useState<number | null>(null),
    [repliesLoading, setRepliesLoading] = useState<ReadonlySet<string>>(
      () => new Set(),
    ),
    [lastSubmit, setLastSubmit] =
      useState<DiscussionThread["lastSubmit"]>(null);
  const sourcePage = useRef(0);
  sourcePage.current = page;
  const authReturnView = useAuthReturnView(authReturnSlot, () => ({
    pages: sourcePage.current,
  }));
  const mutationLocks = useRef(new Set<string>()),
    sendLock = useRef(false),
    // `refresh`: the failed read was an in-place refresh, retried as one.
    failed = useRef<{
      next: number;
      reset: boolean;
      refresh?: boolean;
    } | null>(null),
    listEpoch = useRef(0),
    epoch = useRef(0),
    loading = useRef(false),
    pinned = useRef<string[] | undefined>(undefined),
    replyInFlight = useRef(new Set<string>()),
    replyPages = useRef(new Map<string, number>()),
    listRef = useRef<CommentItem[]>([]),
    // Colophon likes that a list read begun before their command settled
    // would undo: re-applied on that read's commit. `settled` is the last
    // read begun before the command resolved (null while it runs).
    likes = useRef(
      new Map<string, { liked: boolean; settled: number | null }>(),
    ),
    reads = useRef(0);
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
  // withAvatar is a new closure on every render; key the presented rows on
  // the resolved sources so renderers get stable identities between changes.
  const avatarKey = JSON.stringify(
    listRef.current.map((c) => [
      withAvatar(c.user).avatarSrc ?? null,
      ...c.replies.map((r) => withAvatar(r.user).avatarSrc ?? null),
    ]),
  );
  const memoHot = useMemo(() => hot.map(present), [hot, avatarKey]);
  const memoItems = useMemo(() => items.map(present), [items, avatarKey]);
  // Detail keeps fresh rows on every render, as before.
  const presentedHot = colophon ? memoHot : hot.map(present);
  const presentedItems = colophon ? memoItems : items.map(present);

  /** Sets one row's like state; a row already in that state is unchanged. */
  const likeAs = <T extends CommentReply>(r: T, liked: boolean): T =>
    r.liked === liked
      ? r
      : { ...r, liked, likeCount: Math.max(0, r.likeCount + (liked ? 1 : -1)) };
  const keepLike = <T extends CommentReply>(r: T): T => {
    const like = likes.current.get(r.id);
    return like === undefined ? r : likeAs(r, like.liked);
  };
  const keepLikes = (c: CommentItem): CommentItem => {
    const root = keepLike(c),
      replies = c.replies.map(keepLike);
    return root === c && replies.every((r, i) => r === c.replies[i])
      ? c
      : { ...root, replies };
  };
  /** A read begun after a like settled already carries it. */
  const settleLikes = (began: number) => {
    for (const [id, like] of likes.current)
      if (like.settled !== null && began > like.settled)
        likes.current.delete(id);
  };

  const forgetReplyReads = () => {
    replyInFlight.current.clear();
    setRepliesLoading((old) => (old.size ? new Set() : old));
  };
  const markReplyRead = (root: string, active: boolean) => {
    if (active) replyInFlight.current.add(root);
    else replyInFlight.current.delete(root);
    setRepliesLoading(new Set(replyInFlight.current));
  };
  /** Resolves true once the page is committed. */
  const load = async (next = 1, reset = false): Promise<boolean> => {
    if (reset) {
      listEpoch.current++;
      loading.current = false;
      forgetReplyReads();
    }
    if (loading.current) return false;
    loading.current = true;
    setBusy(true);
    setError(null);
    const run = epoch.current,
      listRun = listEpoch.current,
      began = ++reads.current;
    try {
      const result = await authorClient.discussion(
        target,
        next,
        reset ? undefined : pinned.current,
      );
      if (run !== epoch.current || listRun !== listEpoch.current) return false;
      failed.current = null;
      settleLikes(began);
      const fresh = (c: DiscussionComment) => keepLikes(rootRow(c));
      if (reset || next === 1) {
        pinned.current = result.hot.map((i) => i.id);
        setHot(result.hot.map(fresh));
        setItems(result.items.map(fresh));
        replyPages.current.clear();
      } else setItems((old) => [...old, ...result.items.map(fresh)]);
      setPage(next);
      setTotalPages(result.totalPages);
      setVisibleTotal(result.visibleTotal);
      // Cards and Detail of this content show the same total without a re-read.
      publishCommentCount(
        author.viewer?.id ?? null,
        target,
        result.visibleTotal,
      );
      setUnavailable(false);
      return true;
    } catch (e) {
      if (run === epoch.current && listRun === listEpoch.current) {
        failed.current = { next, reset };
        setError(messageOf(e, "评论加载失败"));
        setUnavailable(e instanceof AuthorRequestError && e.status === 404);
      }
      return false;
    } finally {
      if (run === epoch.current && listRun === listEpoch.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (enabled && !author.checking && page === 0 && !loading.current && !error)
      void load(1, true);
  }, [enabled, author.checking, page, error]);
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
  // Reads reply pages begin..finish of one root; `replace` swaps the shown
  // replies for those pages instead of appending them.
  const readReplies = async (
    root: string,
    begin: number,
    finish: number,
    replace: boolean,
  ) => {
    if (replyInFlight.current.has(root)) return;
    markReplyRead(root, true);
    const run = epoch.current,
      listRun = listEpoch.current,
      began = ++reads.current;
    try {
      let remaining = 0;
      let rows: CommentReply[] = [];
      for (let n = begin; n <= finish; n++) {
        const result = await authorClient.replies(target, root, n);
        if (run !== epoch.current || listRun !== listEpoch.current) return;
        rows = [...rows, ...result.items.map(row)];
        remaining = Math.max(0, result.total - result.page * result.pageSize);
      }
      settleLikes(began);
      rows = rows.map(keepLike);
      const update = (old: CommentItem[]) =>
        old.map((c) =>
          c.id === root
            ? {
                ...c,
                replyRemaining: remaining,
                replies: replace ? rows : [...c.replies, ...rows],
              }
            : c,
        );
      setItems(update);
      setHot(update);
      replyPages.current.set(root, finish);
    } catch (e) {
      if (run === epoch.current && listRun === listEpoch.current) {
        if (colophon)
          setActionError({ id: root, message: messageOf(e, "回复加载失败") });
        else setError(messageOf(e, "回复加载失败"));
      }
    } finally {
      if (listRun === listEpoch.current) markReplyRead(root, false);
    }
  };
  const loadReplies = async (root: string, through?: number) => {
    const begin = through ?? (replyPages.current.get(root) ?? 0) + 1;
    await readReplies(root, begin, begin, Boolean(through) || begin === 1);
  };
  // Colophon only: re-reads pages 1..N (N = the current depth) and commits
  // them at once, so the strip never shrinks to page 1 and back. Resolves
  // true once committed.
  const refreshInPlace = async (): Promise<boolean> => {
    const depth = sourcePage.current;
    if (depth === 0) return load(1, true);
    listEpoch.current++;
    loading.current = true;
    const expanded = [...replyPages.current];
    forgetReplyReads();
    setBusy(true);
    setError(null);
    const run = epoch.current,
      listRun = listEpoch.current,
      began = ++reads.current;
    const current = () =>
      run === epoch.current && listRun === listEpoch.current;
    let committed = false;
    try {
      const first = await authorClient.discussion(target, 1, undefined);
      if (!current()) return false;
      const nextPinned = first.hot.map((i) => i.id);
      const last = Math.max(1, Math.min(depth, first.totalPages));
      let latest = first,
        rows = [...first.items];
      for (let n = 2; n <= last; n++) {
        const result = await authorClient.discussion(target, n, nextPinned);
        if (!current()) return false;
        latest = result;
        rows = [...rows, ...result.items];
      }
      const seen = new Set<string>(nextPinned);
      rows = rows.filter((c) => !seen.has(c.id) && Boolean(seen.add(c.id)));
      failed.current = null;
      pinned.current = nextPinned;
      replyPages.current.clear();
      settleLikes(began);
      // Opened reply pages keep what they show until their re-read below
      // replaces it, so the strip does not shrink and grow again.
      const opened = new Set(expanded.map(([root]) => root));
      const shown = new Map(
        listRef.current
          .filter((c) => opened.has(c.id))
          .map((c) => [c.id, c] as const),
      );
      const fresh = (c: DiscussionComment) => {
        const next = rootRow(c),
          before = shown.get(c.id);
        return keepLikes(
          before === undefined
            ? next
            : {
                ...next,
                replies: before.replies,
                ...(before.replyRemaining === undefined
                  ? {}
                  : { replyRemaining: before.replyRemaining }),
              },
        );
      };
      setHot(first.hot.map(fresh));
      setItems(rows.map(fresh));
      setPage(last);
      setTotalPages(latest.totalPages);
      setVisibleTotal(latest.visibleTotal);
      publishCommentCount(
        author.viewer?.id ?? null,
        target,
        latest.visibleTotal,
      );
      setUnavailable(false);
      committed = true;
      loading.current = false;
      setBusy(false);
      // Reply pages the reader had opened come back after the list commit.
      await Promise.all(
        expanded
          .filter(([root]) => seen.has(root))
          .map(([root, through]) => readReplies(root, 1, through, true)),
      );
      return true;
    } catch (e) {
      if (current()) {
        failed.current = { next: 1, reset: true, refresh: true };
        setError(messageOf(e, "评论加载失败"));
        setUnavailable(e instanceof AuthorRequestError && e.status === 404);
      }
      return committed;
    } finally {
      if (current() && !committed) {
        loading.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!consumeLocation || !enabled) return;
    const location = author.cache.get("discussion-location") as
      { target: DiscussionTarget; id: string } | undefined;
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
  }, [page, author.checking, enabled]);
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
    if (colophon) setActionError(null);
    try {
      const result = mentions.length
        ? await authorClient.send(target, text, root, reply, mentions)
        : await authorClient.send(target, text, root, reply);
      if (run === epoch.current) {
        const submitted = result?.id
          ? {
              id: result.id,
              rootId: result.rootId,
              awaitingApproval: result.awaitingApproval,
            }
          : null;
        if (!colophon) {
          setLastSubmit(submitted);
          setNotice("已发送");
          await load(1, true);
        } else {
          // Owner decision: the same notice whether the comment is public
          // now or awaits approval; only a public one is shown in place,
          // and marked once the refresh shows it.
          if (submitted?.awaitingApproval !== true) {
            const shown = await refreshInPlace();
            if (run !== epoch.current) return true;
            if (shown && submitted) setHighlight(submitted.id);
          }
          setLastSubmit(submitted);
          setNotice("已发送");
        }
      }
      return true;
    } catch (e) {
      if (run === epoch.current) {
        if (colophon)
          setActionError({
            id: null,
            message: messageOf(e, "发送失败，输入仍保留"),
          });
        else setError(messageOf(e, "发送失败，输入仍保留"));
      }
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
    if (colophon) setActionError(null);
    try {
      await authorClient.command(path, body, method);
      if (run === epoch.current) {
        if (colophon) await refreshInPlace();
        else await load(1, true);
      }
    } catch (e) {
      if (run === epoch.current) {
        if (colophon)
          setActionError({ id, message: messageOf(e, "操作未完成") });
        else setError(messageOf(e, "操作未完成"));
      }
    } finally {
      mutationLocks.current.delete(id);
    }
  };
  const patchLike = (id: string, liked: boolean) => {
    const patch = <T extends CommentReply>(r: T): T =>
      r.id === id ? likeAs(r, liked) : r;
    const update = (old: CommentItem[]) =>
      old.map((c) => {
        const replies = c.replies.some((r) => r.id === id)
          ? c.replies.map(patch)
          : c.replies;
        const root = patch(c);
        return root === c && replies === c.replies ? c : { ...root, replies };
      });
    setHot(update);
    setItems(update);
  };
  // Colophon only: the like shows at once and is never followed by a
  // re-read, which would reorder hot and collapse the strip's depth.
  const likeInPlace = async (id: string, enabledLike: boolean) => {
    if (mutationLocks.current.has(id)) return;
    mutationLocks.current.add(id);
    const run = epoch.current;
    setActionError(null);
    likes.current.set(id, { liked: enabledLike, settled: null });
    patchLike(id, enabledLike);
    try {
      await authorClient.command(`discussion/items/${id}/like`, {
        requestId: requestIdentity(),
        enabled: enabledLike,
      });
      likes.current.set(id, { liked: enabledLike, settled: reads.current });
    } catch (e) {
      likes.current.delete(id);
      if (run === epoch.current) {
        // Any refresh since then showed the pending like, so undo it.
        patchLike(id, !enabledLike);
        setActionError({ id, message: messageOf(e, "操作未完成") });
      }
    } finally {
      mutationLocks.current.delete(id);
    }
  };

  const operations: Operations = {
    loadMore: () => void load(sourcePage.current + 1),
    retry: () =>
      void (failed.current?.refresh === true
        ? refreshInPlace()
        : load(failed.current?.next ?? 1, failed.current?.reset ?? true)),
    returnToLatest: () => {
      setLocatedPage(null);
      setHighlight(undefined);
      void load(1, true);
    },
    browseHighlightFromFirstReply: () => {
      const root = listRef.current.find(
        (c) => c.id === highlight || c.replies.some((r) => r.id === highlight),
      );
      if (root) void loadReplies(root.id, 1);
    },
    loadReplies: (rootId, through) => void loadReplies(rootId, through),
    sendComment: (text, mentions) => send(text, undefined, undefined, mentions),
    sendReply: (t, text, mentions) =>
      send(text, t.rootCommentId, t.replyId, mentions),
    toggleLike: (rootId, replyId, opener) => {
      if (!author.viewer) {
        if (opener) enterAuth(author.signInHref, opener);
        else enterAuth(author.signInHref);
        return;
      }
      const id = replyId ?? rootId,
        c = listRef.current.find((c) => c.id === rootId),
        r = replyId ? c?.replies.find((r) => r.id === replyId) : c;
      if (!r) return;
      if (colophon) {
        void likeInPlace(id, !r.liked);
        return;
      }
      void mutateItem(id, `discussion/items/${id}/like`, {
        requestId: requestIdentity(),
        enabled: !r.liked,
      });
    },
    deleteBody: (id) =>
      void mutateItem(
        id,
        `discussion/items/${id}/body`,
        { requestId: requestIdentity() },
        "DELETE",
      ),
    setHighlight: (id) => setHighlight(id),
  };
  // Stable operation identities that always run the latest closures.
  const latest = useRef(operations);
  latest.current = operations;
  const [stable] = useState<Operations>(() => ({
    loadMore: () => latest.current.loadMore(),
    retry: () => latest.current.retry(),
    returnToLatest: () => latest.current.returnToLatest(),
    browseHighlightFromFirstReply: () =>
      latest.current.browseHighlightFromFirstReply(),
    loadReplies: (rootId, through) =>
      latest.current.loadReplies(rootId, through),
    sendComment: (text, mentions) => latest.current.sendComment(text, mentions),
    sendReply: (t, text, mentions) =>
      latest.current.sendReply(t, text, mentions),
    toggleLike: (rootId, replyId, opener) =>
      latest.current.toggleLike(rootId, replyId, opener),
    deleteBody: (id) => latest.current.deleteBody(id),
    setHighlight: (id) => latest.current.setHighlight(id),
  }));

  return {
    hot: presentedHot,
    items: presentedItems,
    currentUser: author.viewer
      ? withAvatar({
          id: author.viewer.id,
          name: author.viewer.displayName,
          studioName: author.viewer.studioName,
        })
      : { id: "guest", name: "访客" },
    visibleTotal,
    page,
    totalPages,
    hasMore: page < totalPages,
    loading: page === 0 && !error && !unavailable,
    busy,
    submitting,
    unavailable,
    error,
    readError: colophon ? error : null,
    actionError: colophon ? actionError : null,
    notice,
    // A closed composer renders nothing in its place (the note says why).
    viewerState:
      author.checking || composerClosed
        ? { state: "checking" }
        : author.sessionError
          ? { state: "unavailable" }
          : author.viewer
            ? { state: "signed-in" }
            : { state: "signed-out", signInHref: author.signInHref },
    composerClosed,
    closedNote,
    locatedPage,
    highlightId: highlight,
    repliesLoading,
    lastSubmit,
    ...stable,
  };
}
