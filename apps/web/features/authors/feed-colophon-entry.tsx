"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject, ReactNode } from "react";
import type {
  CommentItem,
  CommentReply,
  CommentReplyTarget,
  CommentUserPresentation,
} from "../comments/comment-types";
import { StudioName } from "./user-identity";
import {
  formatColophonTime,
  VerticalDigits,
  VerticalText,
} from "./vertical-text";
import styles from "./feed-colophon.module.css";
import { InlineCommentBody } from "../comments/inline-comment-body";

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

/**
 * The nickname at a colophon's head shows at most this many characters
 * (code points); a longer one (display names run to 40) is cut with …, the
 * full name staying in the avatar's label and the text's description. 「回复
 * X：」 cuts X the same way, the full name read by assistive technology.
 */
export const COLOPHON_NAME_CHARS = 12;
export const colophonHeadName = (name: string): string => {
  const characters = [...name];
  return characters.length > COLOPHON_NAME_CHARS
    ? `${characters.slice(0, COLOPHON_NAME_CHARS - 1).join("")}…`
    : name;
};

/** What every colophon row shares with the colophons around it. */
export interface ColophonInteractions {
  /** The reader's id; never matches a row for a guest. */
  readonly actorId: string;
  /** Live reporting or an explicitly local QA presentation of its control. */
  readonly renderReport?: ((id: string) => ReactNode) | undefined;
  readonly now: Date;
  /** The row briefly marked after it was sent. */
  readonly flashId: string | null;
  /** The row the input answers, marked while it does. */
  readonly replyTargetId?: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly repliesLoading: ReadonlySet<string>;
  /** Whether 回复 is offered (signed in or out, the thread not closed). */
  readonly canReply: boolean;
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
 * A nickname as a colophon shows it: cut with … past `COLOPHON_NAME_CHARS`,
 * the full name kept for assistive technology.
 */
const ColophonName = ({ name }: { readonly name: string }) => {
  const shown = colophonHeadName(name);
  if (shown === name) return <span>{name}</span>;
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className={styles.srOnly}>{name}</span>
    </>
  );
};

/** The author's small round face, or the first character of the name. */
const ColophonFace = ({
  user,
  className,
}: {
  readonly user: CommentUserPresentation;
  readonly className: string | undefined;
}) => (
  <span
    aria-label={`${user.name}的头像`}
    className={className}
    data-comment-avatar=""
    role="img"
  >
    {user.avatarSrc === undefined || user.avatarSrc === null ? (
      firstCharacter(user.name)
    ) : (
      <img alt="" loading="lazy" src={user.avatarSrc} />
    )}
  </span>
);

type ActionKey = "like" | "delete";

/** Every colophon's upper-left icon column, available without selection. */
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
      textRef.current?.focus({ preventScroll: true });
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
  return (
    <div
      aria-label="题跋操作"
      aria-orientation="vertical"
      className={styles.actions}
      data-colophon-actions=""
      onKeyDown={onKeyDown}
      role="toolbar"
    >
      <button
        aria-label={item.liked ? "取消喜欢评论" : "喜欢评论"}
        aria-description={`${item.likeCount} 人喜欢`}
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
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill={item.liked ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
        </svg>
      </button>
      {own ? (
        <button
          aria-label="删除正文"
          data-colophon-delete=""
          onClick={() => interactions.remove(item.id)}
          onFocus={() => setActive("delete")}
          ref={bind("delete")}
          tabIndex={tabIndex("delete")}
          type="button"
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
      ) : null}
    </div>
  );
};

/**
 * A root's or a reply's text, fold control, seal and actions. The author
 * leads the text: the avatar at the top of the first column, the nickname
 * after it, the text running on in the same flow (a reply's 「回复 X：」
 * after the nickname). The studio plaque and the time sit at the foot of
 * the last column (落款, bottom left).
 */
const ColophonBody = ({
  item,
  rootId,
  replyId,
  replyTo,
  interactions,
}: {
  readonly item: CommentItem | CommentReply;
  readonly rootId: string;
  readonly replyId: string | undefined;
  /** A reply's relation, shown as 「回复 X：」 after the nickname. */
  readonly replyTo?: string | undefined;
  readonly interactions: ColophonInteractions;
}) => {
  const nameId = useId();
  const sealId = useId();
  const wordsId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [authorRight, setAuthorRight] = useState<number | undefined>();
  const folded = foldColophonText(item.text);
  const foldedLength = folded === null ? item.text.length : folded.length - 1;
  const expanded = interactions.expanded.has(item.id);
  // Measured while folded, kept while expanded: 收起 stays offered.
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (node === null) return undefined;
    let active = true;
    const measure = () => {
      if (!active) return;
      if (!expanded) setOverflows(colophonTextOverflows(node));
      if (!item.images?.length) {
        setAuthorRight(undefined);
        return;
      }
      const body = node.parentElement;
      const author = body?.querySelector<HTMLElement>(
        ":scope > [data-colophon-author]",
      );
      const name = node.querySelector<HTMLElement>("[data-colophon-name]");
      const first = name?.getClientRects()[0];
      if (!body || !author || !first || first.width <= 0) return;
      const width = Number.parseFloat(getComputedStyle(author).width);
      const scale = author.getBoundingClientRect().width / width;
      if (!Number.isFinite(scale) || scale <= 0) return;
      // A first-column picture widens its line box. Follow the rendered
      // nickname, including after wrapping, expanding or loading a font.
      const right =
        (body.getBoundingClientRect().right - first.left - first.width / 2) /
          scale -
        width / 2;
      setAuthorRight(
        Math.abs(right) < 1 ? undefined : Math.round(right * 64) / 64,
      );
    };
    measure();
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener("loadingdone", measure);
    // A rotation changes the view, and 全文 itself takes room from the text.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => {
      active = false;
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [expanded, item.text, item.images, item.user.name]);
  const foldable = folded !== null || overflows;
  const target: CommentReplyTarget =
    replyId === undefined
      ? { rootCommentId: rootId, user: item.user }
      : { replyId, rootCommentId: rootId, user: item.user };
  const answer = (opener: HTMLElement) => {
    if (interactions.canReply) interactions.reply(target, opener);
  };
  const studioName = item.user.studioName;
  const headName = colophonHeadName(item.user.name);
  const hasSeal =
    item.createdAt !== undefined ||
    (studioName !== undefined && studioName !== null && studioName !== "");
  return (
    <div
      className={replyId === undefined ? styles.root : styles.replyBody}
      data-expanded={expanded ? "true" : undefined}
    >
      {item.user.deleted === true ? (
        // A deleted author (account-deletion-v1) has no profile to open.
        <span
          className={styles.author}
          data-colophon-author=""
          style={authorRight === undefined ? undefined : { right: authorRight }}
        >
          <ColophonFace className={styles.face} user={item.user} />
        </span>
      ) : (
        <button
          aria-label={`打开${item.user.name}的主页`}
          className={styles.author}
          data-colophon-author=""
          style={authorRight === undefined ? undefined : { right: authorRight }}
          onClick={(event) =>
            interactions.openAuthor(item.user.id, event.currentTarget)
          }
          type="button"
        >
          <ColophonFace className={styles.face} user={item.user} />
        </button>
      )}
      <div
        aria-describedby={[
          nameId,
          ...(hasSeal ? [sealId] : []),
          ...(interactions.canReply ? [wordsId] : []),
        ].join(" ")}
        aria-label={
          interactions.canReply ? `回复 ${item.user.name}` : undefined
        }
        aria-description={
          interactions.canReply
            ? item.images?.length
              ? "点击文字或按回车回复，点击图片放大查看"
              : "点击回复这条题跋"
            : undefined
        }
        aria-disabled={!interactions.canReply}
        className={styles.text}
        data-colophon-text=""
        data-folded={foldable ? String(!expanded) : undefined}
        data-overflow={overflows && !expanded ? "true" : undefined}
        onMouseDown={(event) => {
          if ((event.target as Element).closest?.("[data-comment-image]"))
            return;
          // While a colophon is being written, choosing another one to
          // answer keeps the keyboard up: the text never takes the focus.
          if (document.activeElement?.closest("[data-colophon-input]") != null)
            event.preventDefault();
        }}
        onClick={(event) => {
          // Selecting text for copying never starts a reply.
          if (window.getSelection()?.isCollapsed !== false)
            answer(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          answer(event.currentTarget);
        }}
        ref={textRef}
        role={item.images?.length ? "group" : "button"}
        tabIndex={interactions.canReply ? 0 : -1}
      >
        {/* Read once, as the text's description, not as part of it; a
              cut name is described whole (by the hidden one below). */}
        <span
          aria-hidden="true"
          className={styles.name}
          data-colophon-name=""
          id={headName === item.user.name ? nameId : undefined}
        >
          {headName}
        </span>
        {replyTo === undefined ? null : (
          <span className={styles.replyLead} data-colophon-reply-lead="">
            回复 <ColophonName name={replyTo} />：
          </span>
        )}
        <span data-colophon-words="" id={wordsId}>
          {item.deleted === true ? (
            <span className={styles.deleted} data-colophon-deleted="">
              {COLOPHON_DELETED_TEXT}
            </span>
          ) : (
            <InlineCommentBody
              text={folded !== null && !expanded ? folded : item.text}
              images={
                !expanded && folded !== null
                  ? item.images?.filter((image) => image.offset <= foldedLength)
                  : item.images
              }
              renderText={(text) => <VerticalText text={text} />}
              viewerImages={item.images}
              vertical
            />
          )}
        </span>
        {headName === item.user.name ? null : (
          <span hidden id={nameId}>
            {item.user.name}
          </span>
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
      {hasSeal ? (
        <footer
          className={styles.seal}
          data-colophon-signature={replyId === undefined ? "root" : "reply"}
          id={sealId}
        >
          <StudioName orientation="vertical" value={studioName} />
          {item.createdAt === undefined ? null : (
            <time className={styles.sealTime} dateTime={item.createdAt}>
              <VerticalDigits
                text={formatColophonTime(item.createdAt, interactions.now)}
              />
            </time>
          )}
        </footer>
      ) : null}
      <ColophonActions
        interactions={interactions}
        item={item}
        replyId={replyId}
        rootId={rootId}
        textRef={textRef}
      />
      {item.deleted !== true &&
      interactions.actorId !== item.user.id &&
      interactions.renderReport ? (
        <span className={styles.report} data-colophon-report="">
          {interactions.renderReport(item.id)}
        </span>
      ) : null}
    </div>
  );
};

/**
 * One colophon: the root text led by its author and sealed at its bottom
 * left, then its replies as small annotations (低格夹注) further left, each
 * led by its author and 「回复 X：」.
 */
export const ColophonEntry = ({
  comment,
  interactions,
}: {
  readonly comment: CommentItem;
  readonly interactions: ColophonInteractions;
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
  const replyTarget = (id: string) =>
    interactions.replyTargetId === id ? "" : undefined;
  return (
    <li
      className={styles.entry}
      data-colophon-anchor={comment.id}
      data-colophon-entry=""
      data-colophon-highlight={highlight(comment.id)}
      data-colophon-reply-target={replyTarget(comment.id)}
      data-comment-id={comment.id}
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
              data-colophon-reply-target={replyTarget(reply.id)}
              data-comment-reply={reply.id}
              key={reply.id}
            >
              <ColophonBody
                interactions={interactions}
                item={reply}
                replyId={reply.id}
                replyTo={(reply.replyToUser ?? comment.user).name}
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
    </li>
  );
};
