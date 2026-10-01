"use client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Icon } from "@moya/ui";
import type { DirectConversation } from "@moya/contracts";
import { useAuthors } from "../authors/author-context";
import { requestIdentity } from "../shell/request-identity";
import commentStyles from "../comments/comment-section.module.css";
import styles from "../authors/message-preview.module.css";
import panelStyles from "./direct-message-panel.module.css";
import { DirectConversationRow, MutedMark } from "./direct-conversation-row";
import { formatEditorialTime } from "../editorial-content/format-time";
import { authorClient } from "./message-data";
import {
  findConversationWith,
  startConversationWith,
  useConversation,
  useConversations,
} from "./use-direct-messages";

const UNDO_NOTICE_MS = 4000;
const TEXT_MAXIMUM = 2000;

const initial = (name: string) => name.trim().slice(0, 1) || "友";

const Avatar = ({ name, onOpen }: { name: string; onOpen?: () => void }) =>
  onOpen ? (
    <button
      type="button"
      className={`${styles.avatar} ${styles.smallAvatar}`}
      aria-label={`查看${name}的主页`}
      onClick={onOpen}
    >
      {initial(name)}
    </button>
  ) : (
    <span
      className={`${styles.avatar} ${styles.smallAvatar}`}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
  );

/**
 * The open conversation's participant for the host's dialog header, as in the
 * accepted chat: a clickable avatar beside the nickname, no extra profile row.
 */
export interface DirectMessageTitle {
  readonly label: string;
  readonly content: ReactNode;
}

const HeaderTitle = ({
  name,
  onOpen,
}: {
  name: string;
  onOpen: (opener: HTMLElement) => void;
}) => (
  <button
    type="button"
    className={panelStyles.headerTitle}
    aria-label={`查看${name}的主页`}
    onClick={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      onOpen(event.currentTarget);
    }}
  >
    <span
      className={`${styles.avatar} ${styles.smallAvatar} ${panelStyles.headerAvatar}`}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
    <span>{name}</span>
  </button>
);

/**
 * Hands the participant to a host that shows it in its header; a host without
 * that seam keeps the title row inside the view. Returns whether the host
 * shows it.
 */
const useHostTitle = (
  onTitleChange: ((title: DirectMessageTitle | null) => void) | undefined,
  participant: { id: string; displayName: string } | null,
  onOpenProfile: (userId: string, opener: HTMLElement) => void,
): boolean => {
  const open = useRef(onOpenProfile);
  open.current = onOpenProfile;
  // The latest callback is used, so a host may pass an inline function
  // without re-running the effect (which would loop through its own render).
  const change = useRef(onTitleChange);
  change.current = onTitleChange;
  const seam = onTitleChange !== undefined;
  const id = participant?.id ?? null;
  const name = participant?.displayName ?? null;
  useEffect(() => {
    if (!seam || id === null || name === null) return;
    change.current?.({
      label: name,
      content: (
        <HeaderTitle
          name={name}
          onOpen={(opener) => open.current(id, opener)}
        />
      ),
    });
    return () => change.current?.(null);
  }, [seam, id, name]);
  return seam;
};

/**
 * A request's state for the row's accessible name only. Owner acceptance
 * (2026-09-25): a row shows no visible state tag, just the unread count.
 */
const requestState = (conversation: DirectConversation): string =>
  conversation.state !== "requested"
    ? ""
    : conversation.sendRefusal === "request_pending"
      ? "，等待对方回复"
      : "，私信请求";

const refusalText = (conversation: DirectConversation): string | null =>
  conversation.sendRefusal === "request_pending"
    ? "你已发送一条私信，等对方回复后才能继续发送。"
    : conversation.sendRefusal === "blocked"
      ? "对方目前不接受你的私信。"
      : conversation.sendRefusal === "unavailable"
        ? "对方账号暂不可用。"
        : null;

/**
 * A fixed bottom composer; drafts survive refusals and the text is plain. Like
 * the comment composer it is one box with the send button on its right (Owner
 * acceptance 2026-09-25).
 */
const Composer = ({
  disabledReason,
  onSend,
  autoFocus = false,
}: {
  disabledReason: string | null;
  onSend: (
    text: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  autoFocus?: boolean;
}) => {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // A send error belongs to the refusal state it was shown in: once the
  // composer's own refusal appears or clears, the old error must not linger
  // (or come back as a stale alert when the pair can send again).
  useEffect(() => {
    setError(null);
  }, [disabledReason]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || disabledReason) return;
    setBusy(true);
    setError(null);
    const result = await onSend(text);
    setBusy(false);
    if (result.ok) setDraft("");
    else setError(result.message);
    // Sending disables the submit button, which drops its focus to the page
    // body; keep the writer in the composer instead.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body)
        input.current?.focus({ preventScroll: true });
    });
  };
  return (
    <form
      className={`${commentStyles.composer} ${styles.chatComposer}`}
      data-message-composer=""
      onSubmit={submit}
    >
      {disabledReason ? (
        <p
          role="status"
          className={`${panelStyles.inlineNotice} ${panelStyles.composerNotice}`}
          data-dm-refusal=""
        >
          {disabledReason}
        </p>
      ) : (
        <div className={commentStyles.composerInputRow}>
          <div className={commentStyles.composerField}>
            <textarea
              ref={input}
              value={draft}
              maxLength={TEXT_MAXIMUM * 2}
              rows={1}
              placeholder="写下私信…"
              aria-label="私信内容"
              autoFocus={autoFocus}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className={commentStyles.composerSend}
            disabled={busy || !draft.trim()}
          >
            发送
          </button>
        </div>
      )}
      {error && error !== disabledReason && (
        <p
          role="alert"
          className={`${panelStyles.inlineNotice} ${panelStyles.composerNotice}`}
          data-dm-error=""
        >
          {error}
        </p>
      )}
    </form>
  );
};

const ConversationView = ({
  id,
  onOpenProfile,
  onTitleChange,
}: {
  id: string;
  onOpenProfile: (userId: string, opener: HTMLElement) => void;
  onTitleChange?: (title: DirectMessageTitle | null) => void;
}) => {
  const author = useAuthors();
  const { state, loadOlder, send, refresh } = useConversation(id, true);
  const stream = useRef<HTMLDivElement>(null);
  const count = state.state === "populated" ? state.messages.length : 0;
  const titleInHost = useHostTitle(
    onTitleChange,
    state.state === "populated" ? state.conversation.participant : null,
    onOpenProfile,
  );
  useEffect(() => {
    stream.current?.scrollTo?.({
      top: stream.current.scrollHeight,
      behavior: "auto",
    });
  }, [count]);
  if (state.state !== "populated")
    return (
      <p
        role={state.state === "unavailable" ? "alert" : "status"}
        className={`${panelStyles.panel} ${panelStyles.viewStatus}`}
        data-dm-view-state={state.state}
      >
        {state.state === "loading" ? "正在加载对话…" : state.message}
        {state.state === "unavailable" && (
          <>
            {" "}
            <button
              type="button"
              className={panelStyles.textButton}
              onClick={() => void refresh()}
            >
              重试
            </button>
          </>
        )}
      </p>
    );
  const me = author.viewer?.id;
  return (
    <div
      className={`${styles.chat} ${panelStyles.panel} ${panelStyles.conversation}`}
      data-dm-view="conversation"
      data-dm-title={titleInHost ? "host" : "view"}
      data-dm-conversation={id}
      data-dm-state={state.conversation.state}
    >
      {!titleInHost && (
        <div className={panelStyles.title}>
          <Avatar
            name={state.conversation.participant.displayName}
            onOpen={() => {
              const opener =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : document.body;
              onOpenProfile(state.conversation.participant.id, opener);
            }}
          />
          <strong>{state.conversation.participant.displayName}</strong>
          {state.conversation.muted && <MutedMark />}
        </div>
      )}
      <div
        className={`${styles.chatStream} ${panelStyles.stream}`}
        ref={stream}
        data-dm-stream=""
      >
        {state.hasOlder && (
          <button
            type="button"
            className={panelStyles.olderButton}
            onClick={() => void loadOlder()}
          >
            加载更早的消息
          </button>
        )}
        {state.messages.map((message) => (
          <div
            key={message.id}
            className={panelStyles.message}
            data-dm-message={message.sequence}
            data-dm-removed={message.removed}
            data-dm-sent={message.senderId === me}
          >
            <p
              className={
                message.senderId === me
                  ? styles.sentBubble
                  : styles.receivedBubble
              }
            >
              {message.removed ? <em>此消息已被移除</em> : message.text}
            </p>
            <time className={panelStyles.time} dateTime={message.createdAt}>
              {formatEditorialTime(message.createdAt)}
            </time>
          </div>
        ))}
        {state.conversation.state === "requested" &&
          state.conversation.sendRefusal === "request_pending" && (
            <p
              role="status"
              className={panelStyles.inlineNotice}
              data-dm-gate=""
            >
              对方尚未回复。收到回复后即可继续交流。
            </p>
          )}
      </div>
      <Composer
        disabledReason={refusalText(state.conversation)}
        onSend={send}
      />
    </div>
  );
};

/** First message to an account without a conversation yet; opening sends nothing. */
const StartConversation = ({
  userId,
  displayName,
  onStarted,
  onOpenProfile,
  onTitleChange,
}: {
  userId: string;
  displayName: string;
  onStarted: (conversationId: string) => void;
  onOpenProfile: (userId: string, opener: HTMLElement) => void;
  onTitleChange?: (title: DirectMessageTitle | null) => void;
}) => {
  const titleInHost = useHostTitle(
    onTitleChange,
    { id: userId, displayName },
    onOpenProfile,
  );
  return (
    <div
      className={`${styles.chat} ${panelStyles.panel} ${panelStyles.conversation}`}
      data-dm-view="start"
      data-dm-title={titleInHost ? "host" : "view"}
      data-dm-start={userId}
    >
      {!titleInHost && (
        <div className={panelStyles.title}>
          <Avatar name={displayName} />
          <strong>{displayName}</strong>
        </div>
      )}
      <div className={`${styles.chatStream} ${panelStyles.stream}`}>
        <p role="status" className={panelStyles.inlineNotice}>
          发送第一条私信后，需等待对方回复才能继续发送。
        </p>
      </div>
      <Composer
        disabledReason={null}
        autoFocus
        onSend={async (text) => {
          const result = await startConversationWith(userId, text);
          if (result.ok) onStarted(result.conversationId);
          return result.ok ? { ok: true } : result;
        }}
      />
    </div>
  );
};

export interface DirectMessagePanelProps {
  /** Open straight into the conversation with this account (from a profile). */
  readonly openWith?: {
    readonly userId: string;
    readonly displayName: string;
  } | null;
  readonly onOpenProfile: (userId: string, opener: HTMLElement) => void;
  /** Reports whether a child conversation is open so the host's Back returns one level. */
  readonly onDepthChange?: (depth: number) => void;
  readonly backRequested?: number;
  /**
   * Hosts that show the open conversation's participant in their dialog header
   * pass this; without it the view keeps its own title row.
   */
  readonly onTitleChange?: (title: DirectMessageTitle | null) => void;
}

/**
 * The 私信 panel content-community-completion-v1 supplies to the message-center
 * host: a real conversation list with hide (timed Undo) and mute, and a real
 * conversation view over the same-origin API. Nothing here is a preview.
 */
export const DirectMessagePanel = ({
  openWith = null,
  onOpenProfile,
  onDepthChange,
  backRequested = 0,
  onTitleChange,
}: DirectMessagePanelProps) => {
  const author = useAuthors();
  const conversations = useConversations(author.viewer !== null);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);
  const [undo, setUndo] = useState<{
    conversation: DirectConversation;
    until: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // At most one row shows its actions; scrolling or pressing anywhere outside
  // that row closes it, as in the accepted list.
  const [expanded, setExpanded] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (expanded === null) return;
    const close = () => setExpanded(null);
    const outside = (event: PointerEvent) => {
      const row = (event.target as Element | null)?.closest?.("[data-dm-row]");
      if (row?.getAttribute("data-dm-row") !== expanded) close();
    };
    document.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [expanded]);
  useEffect(() => {
    onDepthChange?.(open || starting ? 1 : 0);
  }, [open, starting, onDepthChange]);
  useEffect(() => {
    if (backRequested > 0) {
      setOpen(null);
      setStarting(null);
    }
  }, [backRequested]);
  // A profile's private-message action: resolve the canonical pair, never create it here.
  useEffect(() => {
    if (!openWith || !author.viewer) return;
    const key = `${author.viewer.id}:${openWith.userId}`;
    if (handled.current === key) return;
    handled.current = key;
    void findConversationWith(openWith.userId)
      .then((conversation) => {
        if (conversation) setOpen(conversation.id);
        else setStarting(openWith);
      })
      .catch(() => setStarting(openWith));
  }, [openWith, author.viewer?.id]);
  useEffect(() => {
    if (!undo && !notice) return;
    const timer = window.setTimeout(() => {
      setUndo(null);
      setNotice(null);
    }, UNDO_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [undo, notice]);
  // Background revalidation (window focus, reconnect) keeps the confirmed
  // account, so an open conversation and its draft stay mounted; only an
  // unknown account shows these states. A different account remounts the
  // panel through its host, and a revoked Session clears the viewer.
  if (!author.viewer && author.checking)
    return <p role="status">正在加载账户…</p>;
  if (!author.viewer && author.sessionError)
    return <p role="alert">账户暂时不可用，请稍后重试。</p>;
  if (!author.viewer)
    return (
      <p>
        <a href={author.signInHref}>登录后查看私信</a>
      </p>
    );
  if (starting)
    return (
      <StartConversation
        userId={starting.userId}
        displayName={starting.displayName}
        onStarted={(conversationId) => {
          setStarting(null);
          setOpen(conversationId);
          void conversations.refresh();
        }}
        onOpenProfile={onOpenProfile}
        {...(onTitleChange ? { onTitleChange } : {})}
      />
    );
  if (open)
    return (
      <ConversationView
        id={open}
        onOpenProfile={onOpenProfile}
        {...(onTitleChange ? { onTitleChange } : {})}
      />
    );
  const hide = async (conversation: DirectConversation) => {
    try {
      const hidden = await authorClient.messages.participant(
        conversation.id,
        "hide",
        requestIdentity(),
      );
      conversations.remove(hidden.id);
      setUndo({ conversation: hidden, until: Date.now() + UNDO_NOTICE_MS });
      setNotice("已删除对话");
    } catch {
      setNotice("删除未完成，请重试");
    }
  };
  const undoHide = async () => {
    if (!undo) return;
    try {
      // Restores only the version being undone; a newer state is never overwritten.
      await authorClient.messages.participant(
        undo.conversation.id,
        "unhide",
        requestIdentity(),
      );
      setUndo(null);
      setNotice("已恢复对话");
      await conversations.refresh();
    } catch {
      setNotice("恢复未完成，请重试");
    }
  };
  const toggleMute = async (conversation: DirectConversation) => {
    try {
      const updated = await authorClient.messages.participant(
        conversation.id,
        conversation.muted ? "unmute" : "mute",
        requestIdentity(),
      );
      conversations.replace(updated);
      setNotice(updated.muted ? "已静音" : "已取消静音");
    } catch {
      setNotice("操作未完成，请重试");
    }
  };
  const list = conversations.state;
  return (
    <div className={panelStyles.panel} data-dm-list="">
      {notice && (
        <p role="status" className={styles.notice} data-dm-notice="">
          {notice}
          {undo && (
            <button type="button" onClick={() => void undoHide()}>
              撤销
            </button>
          )}
        </p>
      )}
      {list.state === "loading" && (
        <p role="status" className={panelStyles.viewStatus}>
          正在加载私信…
        </p>
      )}
      {list.state === "unavailable" && (
        <p role="alert" className={panelStyles.viewStatus}>
          {list.message}{" "}
          <button
            type="button"
            className={panelStyles.textButton}
            onClick={() => void conversations.refresh()}
          >
            重试
          </button>
        </p>
      )}
      {list.state === "empty" && (
        <div className={styles.empty}>
          <Icon name="message" aria-hidden="true" />
          <h3>暂无私信</h3>
          <p>在他人主页点击「私信」即可开始对话。</p>
        </div>
      )}
      {list.state === "populated" && (
        <ul className={styles.conversationList} aria-label="私信会话">
          {list.items.map((conversation) => {
            const name = conversation.participant.displayName;
            const unread = conversation.muted ? 0 : conversation.unreadCount;
            return (
              <DirectConversationRow
                key={conversation.id}
                id={conversation.id}
                name={name}
                avatar={
                  <span className={styles.avatar} aria-hidden="true">
                    {initial(name)}
                  </span>
                }
                muted={conversation.muted}
                label={`打开与${name}的私信${requestState(conversation)}${unread > 0 ? `，${unread} 条未读` : ""}${conversation.muted ? "，已静音" : ""}`}
                expanded={expanded === conversation.id}
                onExpand={(value) =>
                  setExpanded(value ? conversation.id : null)
                }
                onOpen={() => setOpen(conversation.id)}
                onOpenProfile={(opener) =>
                  onOpenProfile(conversation.participant.id, opener)
                }
                onMute={() => void toggleMute(conversation)}
                onHide={() => void hide(conversation)}
              >
                <span className={styles.rowHeading}>
                  <strong>{name}</strong>
                  {conversation.lastMessage && (
                    <time dateTime={conversation.lastMessage.createdAt}>
                      {formatEditorialTime(conversation.lastMessage.createdAt)}
                    </time>
                  )}
                </span>
                <span className={styles.rowPreview}>
                  <span>
                    {conversation.lastMessage
                      ? conversation.lastMessage.removed
                        ? "此消息已被移除"
                        : conversation.lastMessage.text
                      : "尚无消息"}
                  </span>
                  {conversation.muted && <MutedMark />}
                  {unread > 0 && (
                    <span className={styles.unread} data-dm-unread={unread}>
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </span>
              </DirectConversationRow>
            );
          })}
        </ul>
      )}
      {list.state === "populated" && list.nextCursor && (
        <button
          type="button"
          className={panelStyles.olderButton}
          onClick={() => void conversations.loadMore()}
        >
          继续加载
        </button>
      )}
      <p className={styles.previewNote}>
        私信为纯文本，每 10 秒在前台自动刷新；删除仅对自己隐藏。
      </p>
    </div>
  );
};

export { useUnreadConversationCount } from "./direct-message-entry";
