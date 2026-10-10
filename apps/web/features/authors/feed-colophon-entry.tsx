"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
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
  readonly now: Date;
  /** One selected root or reply per post. */
  readonly selectedId: string | null;
  /** The row briefly marked after it was sent. */
  readonly flashId: string | null;
  /** The row the input answers, marked while it does. */
  readonly replyTargetId?: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly repliesLoading: ReadonlySet<string>;
  /** Whether 回复 is offered (signed in or out, the thread not closed). */
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
  const studioName = item.user.studioName;
  const headName = colophonHeadName(item.user.name);
  const hasSeal =
    item.createdAt !== undefined ||
    (studioName !== undefined && studioName !== null && studioName !== "");
  return (
    <>
      <div
        className={replyId === undefined ? styles.root : styles.replyBody}
        data-expanded={expanded ? "true" : undefined}
      >
        <button
          aria-label={`打开${item.user.name}的主页`}
          className={styles.author}
          data-colophon-author=""
          onClick={(event) =>
            interactions.openAuthor(item.user.id, event.currentTarget)
          }
          type="button"
        >
          <ColophonFace className={styles.face} user={item.user} />
        </button>
        <div
          aria-describedby={hasSeal ? `${nameId} ${sealId}` : nameId}
          aria-pressed={selected}
          className={styles.text}
          data-colophon-text=""
          data-folded={foldable ? String(!expanded) : undefined}
          data-overflow={overflows && !expanded ? "true" : undefined}
          onMouseDown={(event) => {
            // While a colophon is being written, choosing another one to
            // answer keeps the keyboard up: the text never takes the focus.
            if (
              document.activeElement?.closest("[data-colophon-input]") != null
            )
              event.preventDefault();
          }}
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
          <span data-colophon-words="">
            {item.deleted === true && item.text.trim() === "" ? (
              <span className={styles.deleted} data-colophon-deleted="">
                {COLOPHON_DELETED_TEXT}
              </span>
            ) : (
              <VerticalText
                text={folded !== null && !expanded ? folded : item.text}
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
