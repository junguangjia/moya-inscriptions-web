"use client";
import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import type {
  CommentItem,
  CommentReply,
  CommentReplyTarget,
  CommentUserPresentation,
} from "../comments/comment-types";
import { UserIdentity } from "./user-identity";
import {
  formatColophonTime,
  VerticalDigits,
  VerticalText,
} from "./vertical-text";
import styles from "./feed-colophon.module.css";

/**
 * Long colophons fold after this many characters (code points) at most;
 * shorter ones fold where their text would not fit one stage view with its
 * signature (see `colophonTextOverflows`).
 */
export const COLOPHON_FOLD_CHARS = 200;

/** Whether a folded text is cut short by its one-view limit. */
export const colophonTextOverflows = (node: HTMLElement): boolean =>
  node.scrollWidth > node.clientWidth + 1 ||
  node.scrollHeight > node.clientHeight + 1;

/** The folded opening of a long text, or null when it is shown whole. */
export const foldColophonText = (text: string): string | null => {
  const characters = [...text];
  return characters.length > COLOPHON_FOLD_CHARS
    ? `${characters.slice(0, COLOPHON_FOLD_CHARS).join("")}…`
    : null;
};

/** Shown where a deleted root's text was, while its replies remain. */
export const COLOPHON_DELETED_TEXT = "该正文已删除";

/** What every colophon row shares with the colophons around it. */
export interface ColophonInteractions {
  /** The reader's id; never matches a row for a guest. */
  readonly actorId: string;
  readonly now: Date;
  /** One selected root or reply per post. */
  readonly selectedId: string | null;
  /** The row briefly marked after it was sent. */
  readonly flashId: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly repliesLoading: ReadonlySet<string>;
  /** Whether 回复 is offered (signed in or out, composer not closed). */
  readonly canReply: boolean;
  readonly select: (id: string | null) => void;
  readonly toggleFold: (id: string) => void;
  readonly reply: (target: CommentReplyTarget, opener: HTMLElement) => void;
  readonly like: (
    rootId: string,
    replyId: string | undefined,
    opener: HTMLElement,
  ) => void;
  readonly remove: (id: string) => void;
  readonly moreReplies: (rootId: string) => void;
  readonly openAuthor: (id: string, opener: HTMLElement) => void;
}

const firstCharacter = (name: string) => [...name.trim()][0] ?? "访";

/**
 * Bottom-left signature: the time, then the nickname with its studio plaque
 * (read right to left in that order), the avatar beneath them. A draft's
 * signature is `presentational` (inside the draft's own button: spans only,
 * no avatar button) and shows its `mark` where the time would be.
 */
export const ColophonSignature = memo(function ColophonSignature({
  id,
  user,
  createdAt,
  now,
  variant,
  onOpenAuthor,
  presentational = false,
  mark,
}: {
  readonly id?: string | undefined;
  readonly user: CommentUserPresentation;
  readonly createdAt: string | undefined;
  readonly now: Date;
  readonly variant: "root" | "reply";
  readonly onOpenAuthor?:
    ((id: string, opener: HTMLElement) => void) | undefined;
  readonly presentational?: boolean;
  readonly mark?: ReactNode;
}) {
  const face = (
    <span
      aria-label={presentational ? undefined : `${user.name}的头像`}
      className={styles.sigFace}
      data-comment-avatar=""
      role={presentational ? undefined : "img"}
    >
      {user.avatarSrc === undefined || user.avatarSrc === null ? (
        firstCharacter(user.name)
      ) : (
        <img alt="" loading="lazy" src={user.avatarSrc} />
      )}
    </span>
  );
  const className = `${styles.signature} ${variant === "reply" ? styles.replySignature : ""}`;
  const meta = (
    <span className={styles.sigMeta}>
      {createdAt === undefined ? (
        (mark ?? null)
      ) : (
        <time className={styles.sigTime} dateTime={createdAt}>
          <VerticalDigits text={formatColophonTime(createdAt, now)} />
        </time>
      )}
      <UserIdentity
        name={user.name}
        orientation="vertical"
        studioName={user.studioName}
      />
    </span>
  );
  if (presentational)
    return (
      <span className={className} data-colophon-signature={variant} id={id}>
        {meta}
        <span className={styles.sigAvatar}>{face}</span>
      </span>
    );
  return (
    <footer className={className} data-colophon-signature={variant} id={id}>
      {meta}
      <button
        aria-label={`打开${user.name}的主页`}
        className={styles.sigAvatar}
        onClick={(event) => onOpenAuthor?.(user.id, event.currentTarget)}
        type="button"
      >
        {face}
      </button>
    </footer>
  );
});

type ActionKey = "reply" | "like" | "delete";

/** The selected text's vertical action column. */
const ColophonActions = ({
  item,
  rootId,
  replyId,
  interactions,
  textRef,
}: {
  readonly item: CommentItem | CommentReply;
  readonly rootId: string;
  readonly replyId: string | undefined;
  readonly interactions: ColophonInteractions;
  readonly textRef: RefObject<HTMLDivElement | null>;
}) => {
  const own = item.deleted !== true && interactions.actorId === item.user.id;
  const keys: ActionKey[] = [
    ...(interactions.canReply ? (["reply"] as const) : []),
    ...(item.deleted === true ? [] : (["like"] as const)),
    ...(own ? (["delete"] as const) : []),
  ];
  const [active, setActive] = useState<ActionKey | null>(null);
  const current = active !== null && keys.includes(active) ? active : keys[0];
  const buttons = useRef(new Map<ActionKey, HTMLButtonElement>());
  const bind = (key: ActionKey) => (node: HTMLButtonElement | null) => {
    if (node === null) buttons.current.delete(key);
    else buttons.current.set(key, node);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      interactions.select(null);
      textRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (current === undefined) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      keys[(keys.indexOf(current) + step + keys.length) % keys.length];
    if (next === undefined) return;
    setActive(next);
    buttons.current.get(next)?.focus();
  };
  const tabIndex = (key: ActionKey) => (key === current ? 0 : -1);
  const target: CommentReplyTarget =
    replyId === undefined
      ? { rootCommentId: rootId, user: item.user }
      : { replyId, rootCommentId: rootId, user: item.user };
  return (
    <div
      aria-label="题跋操作"
      aria-orientation="vertical"
      className={styles.actions}
      data-colophon-actions=""
      onKeyDown={onKeyDown}
      role="toolbar"
    >
      {interactions.canReply ? (
        <button
          data-colophon-reply=""
          onClick={(event) => interactions.reply(target, event.currentTarget)}
          onFocus={() => setActive("reply")}
          ref={bind("reply")}
          tabIndex={tabIndex("reply")}
          type="button"
        >
          回复
        </button>
      ) : null}
      <button
        aria-label={`赞，${item.likeCount}`}
        aria-pressed={item.liked}
        data-colophon-like=""
        disabled={item.deleted === true}
        onClick={(event) =>
          interactions.like(rootId, replyId, event.currentTarget)
        }
        onFocus={() => setActive("like")}
        ref={bind("like")}
        tabIndex={tabIndex("like")}
        type="button"
      >
        赞
        {item.likeCount > 0 ? (
          <VerticalDigits text={String(item.likeCount)} />
        ) : null}
      </button>
      {own ? (
        <button
          data-colophon-delete=""
          onClick={() => interactions.remove(item.id)}
          onFocus={() => setActive("delete")}
          ref={bind("delete")}
          tabIndex={tabIndex("delete")}
          type="button"
        >
          删除
        </button>
      ) : null}
    </div>
  );
};

/** A root's or a reply's text, fold control, signature and actions. */
const ColophonBody = ({
  item,
  rootId,
  replyId,
  lead,
  interactions,
}: {
  readonly item: CommentItem | CommentReply;
  readonly rootId: string;
  readonly replyId: string | undefined;
  readonly lead?: ReactNode;
  readonly interactions: ColophonInteractions;
}) => {
  const signatureId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const selected = interactions.selectedId === item.id;
  const folded = foldColophonText(item.text);
  const expanded = interactions.expanded.has(item.id);
  // Measured while folded, kept while expanded: 收起 stays offered.
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (node === null || expanded) return undefined;
    const measure = () => setOverflows(colophonTextOverflows(node));
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    // A rotation changes the view, and 全文 itself takes room from the text.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, item.text]);
  const foldable = folded !== null || overflows;
  const toggle = () => interactions.select(selected ? null : item.id);
  return (
    <>
      <div
        className={replyId === undefined ? styles.root : styles.replyBody}
        data-expanded={expanded ? "true" : undefined}
      >
        <div
          aria-describedby={signatureId}
          aria-pressed={selected}
          className={styles.text}
          data-colophon-text=""
          data-folded={foldable ? String(!expanded) : undefined}
          data-overflow={overflows && !expanded ? "true" : undefined}
          onClick={() => {
            // Selecting text never changes the selected colophon.
            if (window.getSelection()?.isCollapsed !== false) toggle();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle();
          }}
          ref={textRef}
          role="button"
          tabIndex={0}
        >
          {lead}
          {item.deleted === true && item.text.trim() === "" ? (
            <span className={styles.deleted} data-colophon-deleted="">
              {COLOPHON_DELETED_TEXT}
            </span>
          ) : (
            <VerticalText
              text={folded !== null && !expanded ? folded : item.text}
            />
          )}
        </div>
        {!foldable ? null : (
          <button
            aria-expanded={expanded}
            className={styles.fold}
            data-colophon-fold=""
            onClick={() => interactions.toggleFold(item.id)}
            type="button"
          >
            {expanded ? "收起" : "全文"}
          </button>
        )}
        <ColophonSignature
          createdAt={item.createdAt}
          id={signatureId}
          now={interactions.now}
          onOpenAuthor={interactions.openAuthor}
          user={item.user}
          variant={replyId === undefined ? "root" : "reply"}
        />
      </div>
      {selected ? (
        <ColophonActions
          interactions={interactions}
          item={item}
          replyId={replyId}
          rootId={rootId}
          textRef={textRef}
        />
      ) : null}
    </>
  );
};

/**
 * One colophon: the root text signed at its bottom left, then its replies as
 * small annotations (低格夹注) further left, each led by 「回复 X：」.
 */
export const ColophonEntry = ({
  comment,
  interactions,
  draft,
}: {
  readonly comment: CommentItem;
  readonly interactions: ColophonInteractions;
  /** A reply being written to this colophon: its last annotation. */
  readonly draft?: ReactNode;
}) => {
  const remaining =
    comment.replyRemaining ??
    Math.max(
      0,
      (comment.replyPageTotal ?? comment.replyTotal ?? 0) -
        comment.replies.length,
    );
  const highlight = (id: string) =>
    interactions.flashId === id ? "true" : undefined;
  return (
    <li
      className={styles.entry}
      data-colophon-anchor={comment.id}
      data-colophon-entry=""
      data-colophon-highlight={highlight(comment.id)}
      data-comment-id={comment.id}
      data-selected={
        interactions.selectedId === comment.id ? "true" : undefined
      }
    >
      <ColophonBody
        interactions={interactions}
        item={comment}
        replyId={undefined}
        rootId={comment.id}
      />
      {comment.replies.length === 0 ? null : (
        <ol className={styles.replies} data-colophon-replies="" role="list">
          {comment.replies.map((reply) => (
            <li
              className={styles.reply}
              data-colophon-anchor={reply.id}
              data-colophon-highlight={highlight(reply.id)}
              data-comment-reply={reply.id}
              key={reply.id}
            >
              <ColophonBody
                interactions={interactions}
                item={reply}
                lead={
                  <span
                    className={styles.replyLead}
                    data-colophon-reply-lead=""
                  >
                    回复 {(reply.replyToUser ?? comment.user).name}：
                  </span>
                }
                replyId={reply.id}
                rootId={comment.id}
              />
            </li>
          ))}
        </ol>
      )}
      {remaining > 0 ? (
        <button
          aria-busy={interactions.repliesLoading.has(comment.id)}
          className={styles.moreReplies}
          data-colophon-more-replies=""
          onClick={() => interactions.moreReplies(comment.id)}
          type="button"
        >
          <VerticalDigits text={`余${remaining}则回复`} />
        </button>
      ) : null}
      {draft}
    </li>
  );
};
