"use client";
import { UserIdentity } from "../authors/user-identity";

import { useAuthReturn } from "../auth/auth-return";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MentionControl } from "../notifications/mention-control";
import { remapMentions } from "../notifications/mention-edits";
import { normalizeMentionText } from "../notifications/mention-data";
import type { MentionReference } from "@moya/contracts";
import { createPortal } from "react-dom";

import {
  useCommentComposerPortalTarget,
  useCommentLocationReveal,
} from "./comment-composer-portal";
import { formatCommentCount, usePublishCommentCount } from "./comment-count";
import styles from "./comment-section.module.css";

import type { FormEvent, ReactNode } from "react";
import type { QaCommentScenarioName } from "./comment-scenarios";
import type {
  CommentItem,
  CommentMediaPresentation,
  CommentReply,
  CommentReplyTarget,
  CommentUserPresentation,
} from "./comment-types";

type CommentSort = "hot" | "latest";

/** Who is behind the composer in the live composition. */
export type CommentViewerState =
  | { readonly state: "checking" }
  | { readonly state: "signed-in" }
  | { readonly state: "signed-out"; readonly signInHref: string }
  /** The session service could not answer; never shown as signed out. */
  | { readonly state: "unavailable" };

/**
 * A send handler may report whether the submission was accepted. The QA
 * store returns nothing (always accepted); the live client resolves false on
 * a failure so the draft stays in the composer for another attempt.
 */
export type CommentSendResult = void | Promise<boolean>;

export interface CommentSectionNotice {
  readonly tone: "info" | "error";
  readonly text: string;
}

export interface CommentLoadMore {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}

export interface CommentSectionProps {
  readonly catalogId?: string;
  readonly contentKey?: string;
  readonly onOpenAuthor?: (id: string, opener: HTMLElement) => void;
  readonly onDeleteBody?: (id: string) => void;
  readonly highlightCommentId?: string;
  readonly currentUser: CommentUserPresentation;
  readonly items: readonly CommentItem[];
  readonly onSendComment: (
    text: string,
    mentions?: readonly MentionReference[],
  ) => CommentSendResult;
  readonly onSendReply: (
    target: CommentReplyTarget,
    text: string,
    mentions?: readonly MentionReference[],
  ) => CommentSendResult;
  /** The live Phase 4 composition supplies authorized like commands. */
  readonly onToggleLike?: (commentId: string, replyId?: string) => void;
  /** QA only; the live composition derives loading from the real client. */
  readonly scenario?: QaCommentScenarioName;
  /**
   * Live composition (scope amendment 2026-09-12): contract-derived props in
   * place of the QA inputs. `hotItems` is the Backend's hot section, rendered
   * above the latest list; the 热门/最新 client-side sort control is hidden.
   */
  readonly presentation?: "qa" | "live";
  readonly hotItems?: readonly CommentItem[];
  readonly loading?: boolean;
  readonly viewer?: CommentViewerState;
  readonly status?: "not-found" | "unavailable" | "unexpected-error" | null;
  readonly notice?: CommentSectionNotice | null;
  /** Visible comments including replies across all pages, counted by Backend. */
  readonly totalCount?: number;
  readonly loadMore?: CommentLoadMore;
  readonly onLoadMoreReplies?: (commentId: string) => void;
  readonly submitting?: boolean;
}

interface RowInteractions {
  readonly actor: string;
  readonly open?: ((id: string, opener: HTMLElement) => void) | undefined;
  readonly remove?: ((id: string) => void) | undefined;
}
const RowContext = createContext<RowInteractions>({ actor: "" });
const AuthorName = ({ user }: { user: CommentUserPresentation }) => {
  const actions = useContext(RowContext);
  return actions.open ? (
    <button
      className={styles.userName}
      type="button"
      onClick={(e) => actions.open?.(user.id, e.currentTarget)}
    >
      <UserIdentity name={user.name} studioName={user.studioName} />
    </button>
  ) : (
    <p className={styles.userName}>
      <UserIdentity name={user.name} studioName={user.studioName} />
    </p>
  );
};
const BodyDelete = ({
  id,
  userId,
  deleted,
}: {
  id: string;
  userId: string;
  deleted: boolean | undefined;
}) => {
  const actions = useContext(RowContext);
  return !deleted && actions.actor === userId && actions.remove ? (
    <button
      type="button"
      aria-label="删除正文"
      className={`${styles.textAction} ${styles.iconAction}`}
      onClick={() => actions.remove?.(id)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </svg>
    </button>
  ) : null;
};
const Avatar = ({ user }: { readonly user: CommentUserPresentation }) => {
  const actions = useContext(RowContext);
  return (
    <button
      type="button"
      className={styles.avatar}
      disabled={!actions.open}
      aria-label={`打开${user.name}的主页`}
      onClick={(e) => actions.open?.(user.id, e.currentTarget)}
    >
      <span
        aria-label={`${user.name}的头像`}
        className={styles.avatarContent}
        data-comment-avatar=""
        role="img"
      >
        {user.avatarSrc === undefined || user.avatarSrc === null ? (
          user.name.trim().slice(0, 1) || "访"
        ) : (
          <img alt="" src={user.avatarSrc} />
        )}
      </span>
    </button>
  );
};

const CommentContent = ({
  media,
  replyToUser,
  text,
  onReply,
  authorName,
}: {
  readonly onReply: () => void;
  readonly authorName: string;
  readonly media?: readonly CommentMediaPresentation[] | undefined;
  readonly replyToUser?: CommentUserPresentation | undefined;
  readonly text: string;
}) => (
  <div
    aria-label={`回复 ${authorName}`}
    className={styles.replyEntry}
    data-comment-reply-action=""
    role="button"
    tabIndex={0}
    onClick={() => {
      // Selecting text must not switch the current reply target.
      if (window.getSelection()?.isCollapsed !== false) onReply();
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onReply();
      }
    }}
  >
    <p className={styles.commentText}>
      {replyToUser === undefined ? null : (
        <span className={styles.replyTo}>
          回复{" "}
          <UserIdentity
            name={replyToUser.name}
            studioName={replyToUser.studioName}
          />
        </span>
      )}
      {text}
    </p>
    {media === undefined || media.length === 0 ? null : (
      <ul aria-label="评论图片" className={styles.commentMedia}>
        {media.map((item) => (
          <li
            data-comment-media={item.id}
            data-comment-media-kind={item.kind}
            key={item.id}
          >
            <img alt={item.alt} loading="lazy" src={item.src} />
          </li>
        ))}
      </ul>
    )}
  </div>
);

const LikeButton = ({
  count,
  liked,
  onClick,
}: {
  readonly count: number;
  readonly liked: boolean;
  readonly onClick: () => void;
}) => (
  <button
    aria-label={liked ? "取消喜欢评论" : "喜欢评论"}
    aria-pressed={liked}
    aria-description={`${count} 人喜欢`}
    className={`${styles.textAction} ${styles.iconAction}`}
    data-comment-like=""
    onClick={onClick}
    type="button"
  >
    <svg
      aria-hidden="true"
      className={styles.heart}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={liked ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    </svg>
  </button>
);

const CommentActions = ({
  likeCount,
  liked,
  onLike,
}: {
  readonly likeCount: number;
  readonly liked: boolean;
  /** Absent in the live composition: no like data exists, so no control. */
  readonly onLike?: (() => void) | undefined;
}) => (
  <div className={styles.actions}>
    {onLike === undefined ? null : (
      <LikeButton count={likeCount} liked={liked} onClick={onLike} />
    )}
  </div>
);

const ReplyRow = ({
  commentId,
  onReply,
  onToggleLike,
  reply,
}: {
  readonly commentId: string;
  readonly onReply: (target: CommentReplyTarget) => void;
  readonly onToggleLike?:
    ((commentId: string, replyId?: string) => void) | undefined;
  readonly reply: CommentReply;
}) => (
  <li className={styles.reply} data-comment-reply={reply.id}>
    <Avatar user={reply.user} />
    <div className={styles.commentBody}>
      <AuthorName user={reply.user} />
      <CommentContent
        authorName={reply.user.name}
        onReply={() =>
          onReply({
            replyId: reply.id,
            rootCommentId: commentId,
            user: reply.user,
          })
        }
        media={reply.media}
        replyToUser={reply.replyToUser}
        text={reply.text}
      />
      <div className={styles.metaRow}>
        <time>{reply.createdAtLabel}</time>
        <BodyDelete
          id={reply.id}
          userId={reply.user.id}
          deleted={reply.deleted}
        />
        <CommentActions
          likeCount={reply.likeCount}
          liked={reply.liked}
          onLike={
            onToggleLike === undefined || reply.deleted
              ? undefined
              : () => onToggleLike(commentId, reply.id)
          }
        />
      </div>
    </div>
  </li>
);

const CommentRow = ({
  comment,
  expanded,
  onExpandedChange,
  onLoadMoreReplies,
  onReply,
  onToggleLike,
}: {
  readonly comment: CommentItem;
  readonly expanded: boolean;
  readonly onExpandedChange: () => void;
  readonly onLoadMoreReplies?: ((commentId: string) => void) | undefined;
  readonly onReply: (target: CommentReplyTarget) => void;
  readonly onToggleLike?:
    ((commentId: string, replyId?: string) => void) | undefined;
}) => {
  const visibleReplies = expanded
    ? comment.replies
    : comment.replies.slice(0, 2);
  // The Backend's real visible total; more exist only when it says so.
  const remoteRemaining =
    comment.replyRemaining !== undefined
      ? comment.replyRemaining
      : comment.replyTotal === undefined
        ? 0
        : Math.max(
            0,
            (comment.replyPageTotal ?? comment.replyTotal) -
              comment.replies.length,
          );
  return (
    <li className={styles.comment} data-comment-id={comment.id}>
      <Avatar user={comment.user} />
      <div className={styles.commentBody}>
        <AuthorName user={comment.user} />
        <CommentContent
          authorName={comment.user.name}
          onReply={() =>
            onReply({ rootCommentId: comment.id, user: comment.user })
          }
          media={comment.media}
          text={comment.text}
        />
        <div className={styles.metaRow}>
          <time>{comment.createdAtLabel}</time>
          <BodyDelete
            id={comment.id}
            userId={comment.user.id}
            deleted={comment.deleted}
          />
          <CommentActions
            likeCount={comment.likeCount}
            liked={comment.liked}
            onLike={
              onToggleLike === undefined || comment.deleted
                ? undefined
                : () => onToggleLike(comment.id)
            }
          />
        </div>
        {visibleReplies.length === 0 ? null : (
          <ul
            aria-label={`${comment.user.name}的回复`}
            className={styles.replies}
          >
            {visibleReplies.map((reply) => (
              <ReplyRow
                commentId={comment.id}
                key={reply.id}
                onReply={onReply}
                onToggleLike={onToggleLike}
                reply={reply}
              />
            ))}
          </ul>
        )}
        {comment.replies.length <= 2 ? null : (
          <button
            aria-expanded={expanded}
            className={styles.expandReplies}
            data-comment-expand-replies=""
            onClick={onExpandedChange}
            type="button"
          >
            {expanded
              ? "收起回复"
              : `展开其余 ${comment.replies.length - 2} 条回复`}
          </button>
        )}
        {onLoadMoreReplies === undefined || remoteRemaining === 0 ? null : (
          <button
            className={styles.expandReplies}
            data-comment-load-more-replies=""
            onClick={() => onLoadMoreReplies(comment.id)}
            type="button"
          >
            查看更多回复（还有 {remoteRemaining} 条）
          </button>
        )}
      </div>
    </li>
  );
};

export const CommentSection = ({
  catalogId: legacyCatalogId,
  contentKey,
  onOpenAuthor,
  onDeleteBody,
  highlightCommentId,
  currentUser,
  hotItems,
  items,
  loadMore,
  loading: loadingOverride,
  notice,
  onLoadMoreReplies,
  onSendComment,
  onSendReply,
  onToggleLike,
  presentation = "qa",
  scenario,
  status = null,
  submitting = false,
  totalCount,
  viewer,
}: CommentSectionProps) => {
  const authReturn = useAuthReturn();
  const catalogId = contentKey ?? legacyCatalogId ?? "discussion";
  const sectionRef = useRef<HTMLElement>(null),
    highlighted = useRef<string | null>(null),
    highlightTimer = useRef<number | null>(null);
  const locationReveal = useCommentLocationReveal();
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<readonly MentionReference[]>([]);
  const [expandedCommentIds, setExpandedCommentIds] = useState<Set<string>>(
    () => new Set(),
  );
  useLayoutEffect(() => {
    if (!highlightCommentId || highlighted.current === highlightCommentId)
      return;
    const all = [...(hotItems ?? []), ...items];
    const root = all.find(
      (c) =>
        c.id === highlightCommentId ||
        c.replies.some((r) => r.id === highlightCommentId),
    );
    if (!root) return;
    if (locationReveal && !locationReveal.active) {
      // The pager flushes its imperative transition; call it outside React's layout phase.
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) locationReveal.reveal();
      });
      return () => {
        cancelled = true;
      };
    }
    if (!expandedCommentIds.has(root.id)) {
      setExpandedCommentIds((old) => new Set([...old, root.id]));
      return;
    }
    const node = Array.from(
      sectionRef.current?.querySelectorAll<HTMLElement>(
        "[data-comment-id], [data-comment-reply]",
      ) ?? [],
    ).find(
      (n) =>
        n.dataset.commentId === highlightCommentId ||
        n.dataset.commentReply === highlightCommentId,
    );
    if (node) {
      highlighted.current = highlightCommentId;
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current);
      node.classList.add("phase4-comment-highlight");
      node.setAttribute("aria-current", "true");
      node.scrollIntoView?.({ block: "center" });
      highlightTimer.current = window.setTimeout(() => {
        node.classList.remove("phase4-comment-highlight");
        node.removeAttribute("aria-current");
        highlightTimer.current = null;
      }, 1800);
    }
  }, [highlightCommentId, hotItems, items, expandedCommentIds, locationReveal]);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current);
    },
    [],
  );
  const [replyTarget, setReplyTarget] = useState<CommentReplyTarget | null>(
    null,
  );
  const recoveredComposer = useRef(false);
  const editorRevision = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorMounted = useRef(true);
  const editorScope = useRef<{ catalogId: string; actor: string | null }>({
    catalogId,
    actor: currentUser.id,
  });
  const viewerState = viewer?.state;
  const loading = loadingOverride ?? scenario === "comment-loading";
  useLayoutEffect(() => {
    editorMounted.current = true;
    return () => {
      editorMounted.current = false;
      editorRevision.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    const confirmedActor =
      viewerState === "checking" || viewerState === "unavailable"
        ? editorScope.current.actor
        : viewerState === "signed-out"
          ? null
          : currentUser.id;
    if (
      editorScope.current.catalogId !== catalogId ||
      editorScope.current.actor !== confirmedActor ||
      (!recoveredComposer.current &&
        confirmedActor !== null &&
        viewerState === "signed-in")
    ) {
      editorRevision.current += 1;
      if (confirmedActor !== null) recoveredComposer.current = true;
      const saved =
        confirmedActor === null
          ? undefined
          : (authReturn?.take(confirmedActor, catalogId) as
              | {
                  draft: string;
                  mentions: readonly MentionReference[];
                  replyTarget: CommentReplyTarget | null;
                }
              | undefined);
      setDraft(saved?.draft ?? "");
      setMentions(saved?.mentions ?? []);
      // Page one cannot prove that a target from a later page disappeared.
      // An explicit reply still goes through the existing server validation.
      setReplyTarget(saved?.replyTarget ?? null);
    }
    editorScope.current = { catalogId, actor: confirmedActor };
  }, [catalogId, currentUser.id, viewerState, authReturn]);
  useEffect(() => {
    // Hidden during a refused session; restored only after /me confirms this owner.
    const owner = editorScope.current.actor;
    if (
      presentation === "live" &&
      owner !== null &&
      viewerState === "signed-in"
    )
      authReturn?.remember(owner, catalogId, { draft, mentions, replyTarget });
  }, [
    authReturn,
    catalogId,
    draft,
    mentions,
    presentation,
    replyTarget,
    viewerState,
  ]);
  const changeReplyTarget = (target: CommentReplyTarget | null) => {
    if (target !== null && textareaRef.current === null) return;
    const identity = (value: CommentReplyTarget | null) =>
      value === null
        ? null
        : JSON.stringify([
            value.rootCommentId,
            value.replyId ?? null,
            value.user.id,
          ]);
    if (identity(target) !== identity(replyTarget)) editorRevision.current += 1;
    setReplyTarget(target);
    // Focus inside the user's gesture so iPhone Safari can open the keyboard.
    if (target !== null) textareaRef.current?.focus();
  };
  const [sort, setSort] = useState<CommentSort>("hot");
  const composerPortalTarget = useCommentComposerPortalTarget();
  const postingAsId = useId();
  const live = presentation === "live";

  const hot = hotItems ?? [];
  const count =
    totalCount ??
    [...hot, ...items].reduce(
      (total, comment) => total + 1 + comment.replies.length,
      0,
    );
  usePublishCommentCount(loading || status != null ? null : count);
  const sortedItems = useMemo(() => {
    if (live) return items;
    const local = items.filter((item) => item.isQaGenerated);
    const fixture = items.filter((item) => !item.isQaGenerated);
    return [
      ...local,
      ...(sort === "latest" ? [...fixture].reverse() : fixture),
    ];
  }, [items, live, sort]);
  const toggleExpanded = (commentId: string) =>
    setExpandedCommentIds((current) => {
      const next = new Set(current);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  const expandThread = (commentId: string) =>
    setExpandedCommentIds((current) => new Set(current).add(commentId));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = normalizeMentionText(draft);
    if (text.length === 0 || submitting) return;
    const submittedRevision = editorRevision.current;
    const target = replyTarget;
    const outcome =
      target === null
        ? onSendComment(text, mentions)
        : onSendReply(target, text, mentions);
    const accepted = () => {
      if (
        !editorMounted.current ||
        editorRevision.current !== submittedRevision
      )
        return;
      editorRevision.current += 1;
      if (target !== null) expandThread(target.rootCommentId);
      setDraft("");
      setMentions([]);
      setReplyTarget(null);
    };
    // A failed live submission keeps the text; nothing is shown as sent.
    if (outcome instanceof Promise) {
      void outcome.then(
        (ok) => {
          if (ok) accepted();
        },
        () => undefined,
      );
    } else accepted();
  };
  // Owner acceptance (2026-09-25): every text composer is one box with the
  // send button on its right; the mention trigger sits inside the box.
  const composer = (
    <form
      className={styles.composer}
      data-comment-composer=""
      onSubmit={submit}
    >
      {replyTarget === null ? null : (
        <div className={styles.replyMode} data-comment-reply-mode="">
          <span>
            回复{" "}
            <UserIdentity
              name={replyTarget.user.name}
              studioName={replyTarget.user.studioName}
            />
          </span>
          <button onClick={() => changeReplyTarget(null)} type="button">
            取消
          </button>
        </div>
      )}
      <div className={styles.composerInputRow}>
        <div className={styles.composerField}>
          <textarea
            ref={textareaRef}
            aria-describedby={postingAsId}
            aria-label={
              replyTarget === null
                ? "写下你的评论"
                : `回复 ${replyTarget.user.name}`
            }
            onChange={(event) => {
              editorRevision.current += 1;
              const next = event.currentTarget.value;
              setMentions(remapMentions(draft, next, mentions));
              setDraft(next);
            }}
            placeholder="写下你的评论…"
            rows={1}
            value={draft}
          />
          {live && (
            <MentionControl
              inline
              text={draft}
              mentions={mentions}
              maxLength={1000}
              onChange={(text, refs) => {
                editorRevision.current++;
                setDraft(text);
                setMentions(refs);
                textareaRef.current?.focus();
              }}
            />
          )}
        </div>
        <button
          className={styles.composerSend}
          disabled={draft.trim().length === 0 || submitting}
          type="submit"
        >
          {submitting ? "发送中…" : "发送"}
        </button>
      </div>
      <span id={postingAsId} className={styles.visuallyHidden}>
        以“{currentUser.name}”发布
      </span>
    </form>
  );
  // Signed out, the composer's place carries the truthful state instead.
  const composerSlot: ReactNode =
    viewer === undefined || viewer.state === "signed-in" ? (
      composer
    ) : viewer.state === "signed-out" ? (
      <p className={styles.signedOut} data-comment-signed-out="">
        <a href={viewer.signInHref}>登录</a>后即可发表评论。
      </p>
    ) : viewer.state === "unavailable" ? (
      <p className={styles.signedOut} data-comment-viewer-unavailable="">
        暂时无法确认登录状态，请稍后刷新再试。
      </p>
    ) : null;
  const renderRow = (comment: CommentItem) => (
    <CommentRow
      comment={comment}
      expanded={expandedCommentIds.has(comment.id)}
      key={comment.id}
      onExpandedChange={() => toggleExpanded(comment.id)}
      onLoadMoreReplies={
        onLoadMoreReplies === undefined
          ? undefined
          : (commentId) => {
              expandThread(commentId);
              onLoadMoreReplies(commentId);
            }
      }
      onReply={changeReplyTarget}
      onToggleLike={onToggleLike}
    />
  );

  return (
    <RowContext.Provider
      value={{
        actor: currentUser.id,
        open: onOpenAuthor,
        remove: onDeleteBody,
      }}
    >
      <section
        ref={sectionRef}
        aria-busy={loading}
        aria-labelledby={`comment-title-${catalogId}`}
        className={styles.section}
        data-comment-presentation={presentation}
        data-comment-section=""
        {...(scenario === undefined
          ? {}
          : { "data-comment-scenario": scenario })}
      >
        <header className={styles.header}>
          <h2 id={`comment-title-${catalogId}`}>
            评论
            {loading || status !== null || count === 0 ? null : (
              <span aria-label={`${count} 条`}>
                {" "}
                {formatCommentCount(count)}
              </span>
            )}
          </h2>
          {loading || live ? null : (
            <label className={styles.sortControl}>
              <span className={styles.visuallyHidden}>评论排序</span>
              <select
                data-comment-sort=""
                onChange={(event) =>
                  setSort(event.currentTarget.value as CommentSort)
                }
                value={sort}
              >
                <option value="hot">热门</option>
                <option value="latest">最新</option>
              </select>
            </label>
          )}
        </header>

        {notice === undefined || notice === null ? null : (
          <p
            className={styles.notice}
            data-comment-notice={notice.tone}
            role="status"
          >
            {notice.text}
          </p>
        )}

        {loading ? (
          <div
            aria-label="正在加载评论"
            className={styles.skeleton}
            role="status"
          >
            <span />
            <span />
            <span />
          </div>
        ) : status !== null ? (
          <p className={styles.empty} data-comment-unavailable={status}>
            {status === "not-found"
              ? "这条资料暂不开放评论。"
              : "评论暂时无法加载，请稍后再试。"}
          </p>
        ) : (
          <>
            {composerPortalTarget === null
              ? composerSlot
              : createPortal(composerSlot, composerPortalTarget)}

            {hot.length === 0 ? null : (
              <section
                aria-label="热门评论"
                className={styles.group}
                data-comment-hot=""
              >
                <h3 className={styles.groupLabel}>热门</h3>
                <ul
                  aria-live="polite"
                  className={styles.list}
                  data-comment-list="hot"
                >
                  {hot.map(renderRow)}
                </ul>
              </section>
            )}

            {sortedItems.length === 0 ? (
              hot.length === 0 ? (
                <p className={styles.empty} data-comment-empty="">
                  还没有评论，来说说你的看法。
                </p>
              ) : null
            ) : (
              <section
                aria-label={hot.length === 0 ? undefined : "最新评论"}
                className={styles.group}
                data-comment-latest=""
              >
                {hot.length === 0 ? null : (
                  <h3 className={styles.groupLabel}>最新</h3>
                )}
                <ul
                  aria-live="polite"
                  className={styles.list}
                  data-comment-list=""
                >
                  {sortedItems.map(renderRow)}
                </ul>
              </section>
            )}

            {loadMore === undefined || !loadMore.hasMore ? null : (
              <button
                className={styles.loadMore}
                data-comment-load-more=""
                disabled={loadMore.loading}
                onClick={loadMore.onLoadMore}
                type="button"
              >
                {loadMore.loading ? "加载中…" : "加载更多评论"}
              </button>
            )}
          </>
        )}
      </section>
    </RowContext.Provider>
  );
};
