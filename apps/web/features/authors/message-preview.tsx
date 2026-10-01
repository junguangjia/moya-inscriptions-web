"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { Icon } from "@moya/ui";
import { QuickActionIcon } from "../quick-actions/quick-action-card-action";
import { AuthorDialog } from "./author-dialog";
import type { AuthorDialogNavigationHandle } from "./author-dialog";
import commentStyles from "../comments/comment-section.module.css";
import type { PreviewCommentLocation } from "../discussion-preview/preview-context";
import { PreviewAuthorProfile } from "./preview-author-profile";
import styles from "./message-preview.module.css";
import { CategoryIcon } from "./message-category-icon";

// Presentation fixtures only. These names are never public-user identities.
const people = [
  { name: "秋山", glyph: "山", bio: "山水之间，寻碑访古。", tone: "ink" },
  {
    name: "观石",
    glyph: "石",
    bio: "与金石为伴，记录每一次相遇。",
    tone: "sage",
  },
  { name: "墨池", glyph: "墨", bio: "读帖、临池，也分享日常。", tone: "clay" },
  { name: "听雨", glyph: "雨", bio: "看字，也看字外的风景。", tone: "blue" },
  { name: "一苇", glyph: "苇", bio: "在纸墨里，遇见同好。", tone: "sand" },
  ...[
    "南窗读帖",
    "青山与石",
    "小满",
    "临池记",
    "松风",
    "白露",
    "在路上的金石爱好者",
  ].map((name, index) => ({
    name,
    glyph: name.slice(0, 1),
    bio: "记录读帖与访碑的日常。",
    tone: ["sage", "clay", "blue", "sand", "ink"][index % 5],
  })),
];
const initialConversations = [
  {
    person: 0,
    text: "这方题刻的细节拍得真好，下次一起去看看。",
    time: "10:42",
    unread: 2,
    muted: false,
  },
  {
    person: 1,
    text: "谢谢分享，已经收藏了。",
    time: "09:18",
    unread: 1,
    muted: false,
  },
  {
    person: 2,
    text: "最近在临《张迁碑》，很喜欢这一笔。",
    time: "昨天",
    unread: 0,
    muted: true,
  },
  {
    person: 3,
    text: "周末去访碑，有什么推荐的地方吗？",
    time: "昨天",
    unread: 0,
    muted: false,
  },
  {
    person: 4,
    text: "有空再一起交流。",
    time: "周五",
    unread: 0,
    muted: false,
  },
  ...people.slice(5).map((actor, index) => ({
    person: index + 5,
    text: [
      "[图片] 分享一页读帖笔记。",
      "那处转折我又拍了一张，稍后发你。",
      "好的，周末见！",
      "翻到一本旧笔记，想起上次聊过的石刻。",
      "谢谢你的建议。",
      "[图片] 今天的临写练习。",
      "这一组照片里还保留了周围环境，方便比较观看的位置和方向。",
    ][index]!,
    time: index < 3 ? "周四" : "9月15日",
    unread: index === 0 ? 105 : 0,
    muted: index % 3 === 0,
  })),
];
const reactions = [
  { person: 1, action: "favorite", time: "10 分钟前" },
  { person: 0, action: "like", time: "半小时前" },
  { person: 3, action: "favorite", time: "1 小时前" },
  { person: 2, action: "like", time: "昨天" },
  ...people.slice(4).map((actor, index) => ({
    person: index + 4,
    action: index % 2 ? ("favorite" as const) : ("like" as const),
    time: `${index + 2} 天前`,
  })),
] as const;
const receivedComments = [
  {
    person: 0,
    work: "山间访碑记",
    text: "石面上的岁月痕迹也很动人，谢谢你记录下来。",
    time: "20 分钟前",
    origin: {
      state: "available",
      topicId: "news-field-notes",
      contentId: "news-field-notes",
      commentId: "news-field-notes-comment-1",
      rootCommentId: "news-field-notes-comment-1",
    },
  },
  {
    person: 1,
    work: "临帖日常 · 隶书",
    text: "这一笔的收势很有味道。",
    time: "1 小时前",
    origin: {
      state: "available",
      topicId: "thread-1",
      contentId: "thread-1-post-1",
      commentId: "thread-1-post-1-comment-1",
      rootCommentId: "thread-1-post-1-comment-1",
    },
  },
  {
    person: 3,
    work: "一方小印",
    text: "想知道这方印的尺寸，多谢分享。",
    time: "昨天",
    origin: { state: "unavailable", reason: "content-deleted" },
  },
] satisfies CommentActivity[];
const sentComments = [
  {
    person: 1,
    work: "石上春秋",
    text: "字口保存得很好，期待更多细节。",
    time: "今天 09:06",
    origin: {
      state: "available",
      topicId: "news-field-notes",
      contentId: "news-field-notes",
      commentId: "news-field-notes-comment-2",
      rootCommentId: "news-field-notes-comment-2",
    },
  },
  {
    person: 4,
    work: "窗前读帖",
    text: "纸墨的质感很美。",
    time: "昨天 18:30",
    origin: {
      state: "available",
      topicId: "thread-1",
      contentId: "thread-1-post-1",
      commentId: "thread-1-post-1-comment-2",
      rootCommentId: "thread-1-post-1-comment-2",
    },
  },
  {
    person: 3,
    work: "旧帖中的回复",
    text: "我补充了一处出处。",
    time: "周五",
    origin: { state: "unavailable", reason: "root-comment-deleted" },
  },
] satisfies CommentActivity[];

type CommentActivityOrigin =
  | ({ readonly state: "available" } & PreviewCommentLocation)
  | {
      readonly state: "unavailable";
      readonly reason: "content-deleted" | "root-comment-deleted";
    };

interface CommentActivity {
  readonly person: number;
  readonly work: string;
  readonly text: string;
  readonly time: string;
  readonly origin: CommentActivityOrigin;
}
type View =
  "home" | "followers" | "reactions" | "comments" | "profile" | "conversation";
const titles: Record<View, string> = {
  home: "消息",
  followers: "粉丝",
  reactions: "赞与收藏",
  comments: "评论",
  profile: "个人主页",
  conversation: "私信",
};

function Avatar({
  person,
  small = false,
}: {
  person: number;
  small?: boolean;
}) {
  const actor = people[person]!;
  return (
    <span
      aria-hidden="true"
      className={`${styles.avatar} ${small ? styles.smallAvatar : ""}`}
      data-tone={actor.tone}
    >
      {actor.glyph}
    </span>
  );
}

// Integration: replace ConversationRow and add this helper immediately before it.
// Imports: add useId to the existing React value imports, and CSSProperties to
// the existing React type imports. PointerEvent, useRef and useState remain used.

const CONVERSATION_TRASH_SNAP = 72;
const CONVERSATION_FULL_SNAP = 136;
const MESSAGE_NOTICE_DURATION = 4000;

function ConversationActionIcon({
  kind,
}: {
  kind: "trash" | "bell" | "bell-off";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "trash" ? (
        <>
          <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7M14 10v7" />
        </>
      ) : kind === "bell-off" ? (
        <>
          <path d="M9.7 4.5A5.5 5.5 0 0 1 17.5 10v3.1M6.5 6.5A5.5 5.5 0 0 0 6.5 10v4L4 17h13M10 20h4M3 3l18 18" />
        </>
      ) : (
        <>
          <path d="M6.5 10a5.5 5.5 0 0 1 11 0v4l2.5 3H4l2.5-3v-4ZM10 20h4M12 3v1.5" />
        </>
      )}
    </svg>
  );
}

function ConversationRow({
  conversation,
  expanded,
  onExpand,
  onOpen,
  onOpenProfile,
  onAction,
}: {
  conversation: (typeof initialConversations)[number];
  expanded: boolean;
  onExpand: (value: boolean) => void;
  onOpen: () => void;
  onOpenProfile: () => void;
  onAction: (action: "mute" | "delete") => void;
}) {
  const instructionsId = useId();
  const actionsId = useId();
  const conversationButton = useRef<HTMLButtonElement>(null);
  const muteButton = useRef<HTMLButtonElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    base: number;
    offset: number;
    horizontal: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [restOffset, setRestOffset] = useState(CONVERSATION_FULL_SNAP);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragging = dragOffset !== null;
  const offset = dragOffset ?? (expanded ? restOffset : 0);
  const clamp = (value: number) =>
    Math.max(0, Math.min(CONVERSATION_FULL_SNAP, value));
  const trashProgress = Math.max(0, Math.min(1, (offset - 8) / 52));
  const muteProgress = Math.max(0, Math.min(1, (offset - 72) / 52));
  const trashAvailable =
    !dragging && expanded && offset >= CONVERSATION_TRASH_SNAP;
  const muteAvailable =
    !dragging && expanded && offset >= CONVERSATION_FULL_SNAP;
  const name = people[conversation.person]!.name;

  useLayoutEffect(() => {
    if (expanded || !gesture.current?.horizontal) return;
    const pointerId = gesture.current.pointerId;
    gesture.current = null;
    setDragOffset(null);
    if (front.current?.hasPointerCapture?.(pointerId))
      front.current.releasePointerCapture(pointerId);
  }, [expanded]);

  const settle = (next: number) => {
    setRestOffset(next || CONVERSATION_FULL_SNAP);
    setDragOffset(null);
    onExpand(next > 0);
  };
  const releaseCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const cancelGesture = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (start.horizontal) settle(start.base);
    releaseCapture(event);
  };
  const finishGesture = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (start.horizontal) {
      const releasedOffset = clamp(start.base - (event.clientX - start.x));
      const next =
        releasedOffset < CONVERSATION_TRASH_SNAP / 2
          ? 0
          : releasedOffset <
              (CONVERSATION_TRASH_SNAP + CONVERSATION_FULL_SNAP) / 2
            ? CONVERSATION_TRASH_SNAP
            : CONVERSATION_FULL_SNAP;
      settle(next);
    }
    releaseCapture(event);
  };

  return (
    <li
      className={styles.swipeRow}
      data-dragging={dragging}
      data-reveal={offset}
      style={
        {
          "--conversation-offset": `${offset}px`,
          "--trash-opacity": trashProgress,
          "--trash-scale": 0.55 + trashProgress * 0.45,
          "--mute-opacity": muteProgress,
          "--mute-scale": 0.55 + muteProgress * 0.45,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          gesture.current = null;
          settle(CONVERSATION_FULL_SNAP);
          requestAnimationFrame(() => muteButton.current?.focus());
        } else if (
          (event.key === "ArrowRight" || event.key === "Escape") &&
          offset > 0
        ) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          gesture.current = null;
          settle(0);
          conversationButton.current?.focus();
        }
      }}
    >
      <span id={instructionsId} className={styles.rowInstructions}>
        左方向键展开会话操作，右方向键或 Escape 收起。
      </span>
      <div
        id={actionsId}
        className={styles.rowActions}
        role="group"
        aria-label={`${name}的会话操作`}
        aria-hidden={!trashAvailable}
      >
        <button
          ref={muteButton}
          type="button"
          className={styles.muteAction}
          aria-label={conversation.muted ? "取消免打扰" : "免打扰"}
          aria-hidden={!muteAvailable}
          disabled={!muteAvailable}
          tabIndex={muteAvailable ? 0 : -1}
          onClick={() => onAction("mute")}
        >
          <ConversationActionIcon
            kind={conversation.muted ? "bell" : "bell-off"}
          />
        </button>
        <button
          type="button"
          className={styles.deleteAction}
          aria-label="删除"
          aria-hidden={!trashAvailable}
          disabled={!trashAvailable}
          tabIndex={trashAvailable ? 0 : -1}
          onClick={() => onAction("delete")}
        >
          <ConversationActionIcon kind="trash" />
        </button>
      </div>
      <div
        ref={front}
        className={styles.rowFront}
        data-expanded={expanded}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || gesture.current) return;
          suppressClick.current = false;
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            base: offset,
            offset,
            horizontal: false,
          };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.horizontal) {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
              suppressClick.current = true;
              gesture.current = null;
              return;
            }
            if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(dy) * 1.2) {
              return;
            }
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              gesture.current = null;
              return;
            }
            start.horizontal = true;
            suppressClick.current = true;
            // Close another row as soon as this row takes horizontal ownership.
            if (!expanded) onExpand(true);
          }
          if (event.cancelable) event.preventDefault();
          start.offset = clamp(start.base - dx);
          setDragOffset(start.offset);
        }}
        onPointerUp={finishGesture}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={(event) => {
          // Touch initially captures the nested button. Its capture-loss event
          // bubbles when horizontal intent transfers capture to this row.
          // Only losing capture on the row itself cancels the row gesture.
          if (event.target === event.currentTarget) cancelGesture(event);
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          // Keyboard and assistive activation do not produce a pointer click.
          if (event.detail === 0) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className={styles.conversationAvatar}
          aria-label={`查看${name}的主页`}
          aria-describedby={instructionsId}
          onClick={onOpenProfile}
        >
          <Avatar person={conversation.person} />
        </button>
        <button
          ref={conversationButton}
          type="button"
          className={styles.conversation}
          aria-label={`与${name}的私信${conversation.unread ? `，${conversation.unread} 条未读` : ""}${conversation.muted ? "，已免打扰" : ""}`}
          aria-describedby={instructionsId}
          aria-controls={actionsId}
          aria-expanded={offset > 0}
          aria-keyshortcuts="ArrowLeft ArrowRight Escape"
          onClick={() => (expanded ? settle(0) : onOpen())}
        >
          <span className={styles.conversationBody}>
            <span className={styles.rowHeading}>
              <strong>{name}</strong>
              <time>{conversation.time}</time>
            </span>
            <span className={styles.rowPreview}>
              <span>{conversation.text}</span>
              {conversation.muted && (
                <span
                  className={styles.mutedMark}
                  role="img"
                  aria-label="已免打扰"
                >
                  <ConversationActionIcon kind="bell-off" />
                </span>
              )}
              {conversation.unread > 0 && (
                <span className={styles.unread}>
                  {conversation.unread > 99 ? "99+" : conversation.unread}
                </span>
              )}
            </span>
          </span>
        </button>
      </div>
    </li>
  );
}

/** Development-only, in-memory interactions. No author client or runtime IDs. */
export function MessagePreview({
  closeRequested = false,
  initialCommentTab = "received",
  initialView = "home",
  onClose,
  onOpenComment,
}: {
  closeRequested?: boolean;
  initialCommentTab?: "received" | "sent";
  initialView?: "home" | "comments";
  onClose: () => void;
  onOpenComment?: (
    location: PreviewCommentLocation,
    sourceTab: "received" | "sent",
  ) => void;
}) {
  const [view, setView] = useState<View>(initialView);
  const [trail, setTrail] = useState<View[]>(
    initialView === "comments" ? ["home"] : [],
  );
  const [person, setPerson] = useState(0);
  const [profilePerson, setProfilePerson] = useState<number | "self" | null>(
    null,
  );
  const [commentTab, setCommentTab] = useState<"received" | "sent">(
    initialCommentTab,
  );
  const [conversations, setConversations] = useState(initialConversations);
  const [expanded, setExpanded] = useState<number | null>(null);
  const scrollIntent = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [followed, setFollowed] = useState<number[]>([2]);
  const [unread, setUnread] = useState({
    followers: 3,
    reactions: 4,
    comments: 3,
  });
  const [undo, setUndo] = useState<{
    conversation: (typeof initialConversations)[number];
    index: number;
    action: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeRevision, setNoticeRevision] = useState(0);
  useEffect(() => {
    if (!notice && !undo) return;
    const timeout = window.setTimeout(() => {
      setNotice("");
      setUndo(null);
    }, MESSAGE_NOTICE_DURATION);
    return () => window.clearTimeout(timeout);
  }, [notice, noticeRevision, undo]);
  const showNotice = (message: string) => {
    setNotice(message);
    setNoticeRevision((old) => old + 1);
  };
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const draft = drafts[person] ?? "";
  const setDraft = (text: string) =>
    setDrafts((old) => ({ ...old, [person]: text }));
  const [messages, setMessages] = useState<Record<number, string[]>>({});
  const titleRef = useRef<HTMLDivElement>(null);
  const chatStream = useRef<HTMLDivElement>(null);
  const dialogNavigation = useRef<AuthorDialogNavigationHandle | null>(null);
  useLayoutEffect(() => {
    if (view !== "conversation" || !chatStream.current) return;
    chatStream.current.scrollTo?.({
      top: chatStream.current.scrollHeight,
      behavior: "auto",
    });
  }, [view, person, messages]);
  const opener = useRef<HTMLElement | null>(null);
  const profileOpener = useRef<HTMLElement | null>(null);
  const viewScroll = useRef<Partial<Record<View, number>>>({});
  const clearScrollIntent = (event: PointerEvent<HTMLDivElement>) => {
    if (scrollIntent.current?.pointerId === event.pointerId)
      scrollIntent.current = null;
  };
  const navigate = (next: View) => {
    viewScroll.current[view] = titleRef.current?.scrollTop ?? 0;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setTrail((old) => [...old, view]);
    setView(next);
    setExpanded(null);
    setNotice("");
    setUndo(null);
    titleRef.current?.scrollTo?.(0, 0);
    requestAnimationFrame(() =>
      titleRef.current?.focus({ preventScroll: true }),
    );
  };
  const restoreProfileFocus = () => {
    requestAnimationFrame(() => {
      if (profileOpener.current?.isConnected)
        profileOpener.current.focus({ preventScroll: true });
      else titleRef.current?.focus({ preventScroll: true });
    });
  };
  const back = (targetDepth: number) => {
    if (profilePerson !== null && targetDepth === trail.length) {
      setProfilePerson(null);
      restoreProfileFocus();
      return;
    }
    const previous = trail[targetDepth] ?? "home";
    setProfilePerson(null);
    setView(previous);
    setTrail((old) => old.slice(0, targetDepth));
    setNotice("");
    requestAnimationFrame(() => {
      titleRef.current?.scrollTo?.(0, viewScroll.current[previous] ?? 0);
      if (opener.current?.isConnected)
        opener.current.focus({ preventScroll: true });
      else titleRef.current?.focus({ preventScroll: true });
    });
  };
  const openPerson = (next: number | "self") => {
    profileOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProfilePerson(next);
  };
  const openComment = (origin: CommentActivityOrigin) => {
    if (origin.state !== "available") return;
    onOpenComment?.(
      {
        topicId: origin.topicId,
        contentId: origin.contentId,
        commentId: origin.commentId,
        rootCommentId: origin.rootCommentId,
      },
      commentTab,
    );
  };
  const toggleFollow = (next: number) =>
    setFollowed((old) =>
      old.includes(next) ? old.filter((id) => id !== next) : [...old, next],
    );
  const action = (id: number, value: "mute" | "delete") => {
    setExpanded(null);
    if (value === "mute") {
      const current = conversations.find((item) => item.person === id)!;
      setConversations((old) =>
        old.map((item) =>
          item.person === id ? { ...item, muted: !item.muted } : item,
        ),
      );
      showNotice(current.muted ? "已取消免打扰" : "已开启免打扰");
      setUndo(null);
    } else {
      const index = conversations.findIndex((item) => item.person === id);
      setUndo({
        conversation: conversations[index]!,
        index,
        action: "已删除会话",
      });
      setConversations((old) => old.filter((item) => item.person !== id));
      setNotice("");
    }
    requestAnimationFrame(() =>
      titleRef.current?.focus({ preventScroll: true }),
    );
  };
  return (
    <AuthorDialog
      title={view === "conversation" ? people[person]!.name : titles[view]}
      titleContent={
        view === "conversation" ? (
          <button
            type="button"
            className={styles.chatTitle}
            aria-label={`查看${people[person]!.name}的主页`}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              openPerson(person);
            }}
          >
            <Avatar person={person} small />
            <span>{people[person]!.name}</span>
          </button>
        ) : undefined
      }
      navigationDepth={trail.length + (profilePerson !== null ? 1 : 0)}
      navigationRef={dialogNavigation}
      onBack={back}
      closeRequested={closeRequested}
      onClose={onClose}
      headerHidden={profilePerson !== null}
      className={styles.page}
    >
      <div
        className={styles.content}
        data-message-view={view}
        ref={titleRef}
        tabIndex={-1}
        inert={profilePerson !== null}
        aria-hidden={profilePerson !== null ? true : undefined}
        style={profilePerson !== null ? { visibility: "hidden" } : undefined}
        onScroll={() => {
          scrollIntent.current = null;
          setExpanded(null);
        }}
        onPointerDownCapture={(event) => {
          if (
            expanded === null ||
            !event.isPrimary ||
            event.button !== 0 ||
            scrollIntent.current
          )
            return;
          scrollIntent.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }}
        onPointerMoveCapture={(event) => {
          const start = scrollIntent.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const dx = Math.abs(event.clientX - start.x);
          const dy = Math.abs(event.clientY - start.y);
          if (dy > 8 && dy >= dx) {
            scrollIntent.current = null;
            setExpanded(null);
          } else if (dx > 8 && dx > dy * 1.2) {
            scrollIntent.current = null;
          }
        }}
        onPointerUpCapture={clearScrollIntent}
        onPointerCancelCapture={clearScrollIntent}
      >
        {view === "home" && (
          <>
            <nav className={styles.categories} aria-label="消息分类">
              {(["followers", "reactions", "comments"] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  aria-label={`${titles[kind]}${unread[kind] ? `，${unread[kind]} 条未读` : ""}`}
                  onClick={() => {
                    navigate(kind);
                    setUnread((old) => ({ ...old, [kind]: 0 }));
                  }}
                >
                  <span className={styles.categoryIcon} data-kind={kind}>
                    <CategoryIcon kind={kind} />
                    {unread[kind] > 0 && (
                      <span className={styles.categoryBadge} aria-hidden="true">
                        {unread[kind]}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </nav>
            <div className={styles.listHeading}>
              <h3>私信</h3>
            </div>
            <ul className={styles.conversationList} aria-label="私信会话">
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.person}
                  conversation={conversation}
                  expanded={expanded === conversation.person}
                  onExpand={(value) =>
                    setExpanded(value ? conversation.person : null)
                  }
                  onAction={(value) => action(conversation.person, value)}
                  onOpenProfile={() => openPerson(conversation.person)}
                  onOpen={() => {
                    setPerson(conversation.person);
                    setConversations((old) =>
                      old.map((item) =>
                        item.person === conversation.person
                          ? { ...item, unread: 0 }
                          : item,
                      ),
                    );
                    navigate("conversation");
                  }}
                />
              ))}
            </ul>
            {conversations.length === 0 && (
              <p className={styles.empty}>暂无私信</p>
            )}
            {(notice || undo) && (
              <div className={styles.notice} role="status">
                <span>{undo?.action ?? notice}</span>
                {undo && (
                  <button
                    type="button"
                    onClick={() => {
                      setConversations((old) => {
                        const next = [...old];
                        next.splice(
                          Math.min(undo.index, next.length),
                          0,
                          undo.conversation,
                        );
                        return next;
                      });
                      setUndo(null);
                      showNotice("已恢复会话");
                    }}
                  >
                    撤销
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {view === "followers" && (
          <ul className={styles.peopleList} aria-label="粉丝列表">
            {people.map((actor, index) => (
              <li key={actor.name}>
                <button
                  type="button"
                  className={styles.personLink}
                  onClick={() => openPerson(index)}
                  aria-label={`查看${actor.name}的主页`}
                >
                  <Avatar person={index} />
                  <span>
                    <strong>{actor.name}</strong>
                    <span className={styles.secondary}>
                      {
                        ["10 分钟前", "1 小时前", "3 小时前", "昨天", "周五"][
                          index % 5
                        ]
                      }{" "}
                      关注了你
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.follow}
                  aria-label={`${followed.includes(index) ? "取消回关" : "回关"}${actor.name}`}
                  aria-pressed={followed.includes(index)}
                  onClick={() => toggleFollow(index)}
                >
                  {followed.includes(index) ? "互相关注" : "回关"}
                </button>
                <button
                  type="button"
                  className={styles.chevron}
                  aria-label={`进入${actor.name}的主页`}
                  onClick={() => openPerson(index)}
                >
                  <Icon name="next" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {view === "reactions" && (
          <ul className={styles.activityList} aria-label="收到的赞与收藏">
            {reactions.map((item, index) => (
              <li key={index}>
                <button
                  type="button"
                  className={styles.activityPerson}
                  aria-label={`${people[item.person]!.name}${item.action === "like" ? "赞了你的作品" : "收藏了你的作品"}，${item.time}，查看主页`}
                  onClick={() => openPerson(item.person)}
                >
                  <Avatar person={item.person} />
                  <span>
                    <strong>{people[item.person]!.name}</strong>
                    <span className={styles.secondary}>
                      {item.action === "like"
                        ? "赞了你的作品"
                        : "收藏了你的作品"}
                      <time>{item.time}</time>
                    </span>
                  </span>
                </button>
                <span className={styles.reactionMark} data-action={item.action}>
                  <QuickActionIcon action={item.action} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {view === "comments" && (
          <>
            <div
              className={styles.commentTabs}
              role="tablist"
              aria-label="评论分类"
            >
              {(["received", "sent"] as const).map((tab) => (
                <button
                  id={`message-preview-${tab}`}
                  key={tab}
                  role="tab"
                  type="button"
                  tabIndex={commentTab === tab ? 0 : -1}
                  aria-selected={commentTab === tab}
                  aria-controls="message-preview-comments"
                  onClick={() => setCommentTab(tab)}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? "received"
                        : event.key === "End"
                          ? "sent"
                          : tab === "received"
                            ? "sent"
                            : "received";
                    setCommentTab(next);
                    document.getElementById(`message-preview-${next}`)?.focus();
                  }}
                >
                  {tab === "received" ? "收到的评论" : "发出的评论"}
                </button>
              ))}
            </div>
            <ul
              id="message-preview-comments"
              role="tabpanel"
              aria-labelledby={`message-preview-${commentTab}`}
              className={styles.comments}
            >
              {(commentTab === "received"
                ? receivedComments
                : sentComments
              ).map((item) => (
                <li key={item.work}>
                  <button
                    type="button"
                    className={styles.commentAvatar}
                    aria-label={`查看${commentTab === "received" ? people[item.person]!.name : "我"}的主页`}
                    onClick={() =>
                      openPerson(
                        commentTab === "received" ? item.person : "self",
                      )
                    }
                  >
                    {commentTab === "received" ? (
                      <Avatar person={item.person} small />
                    ) : (
                      <span
                        className={`${styles.avatar} ${styles.smallAvatar}`}
                        aria-hidden="true"
                      >
                        我
                      </span>
                    )}
                  </button>
                  <div className={styles.commentBody}>
                    {item.origin.state === "available" ? (
                      <button
                        type="button"
                        className={styles.commentTarget}
                        data-comment-origin="available"
                        aria-label={`前往原帖并定位评论：${item.text}`}
                        onClick={() => openComment(item.origin)}
                      >
                        <span className={styles.rowHeading}>
                          <strong>
                            {commentTab === "received"
                              ? people[item.person]!.name
                              : "我"}
                          </strong>
                          <time>{item.time}</time>
                        </span>
                        <span className={styles.commentText}>{item.text}</span>
                        <span className={styles.workReference}>
                          <Icon name="image" aria-hidden="true" />
                          <span>
                            {commentTab === "sent"
                              ? `${people[item.person]!.name}的作品 · `
                              : "作品 · "}
                            {item.work}
                          </span>
                        </span>
                      </button>
                    ) : (
                      <div
                        className={styles.unavailableComment}
                        data-comment-origin="unavailable"
                        data-unavailable-reason={item.origin.reason}
                      >
                        <span className={styles.rowHeading}>
                          <strong>
                            {commentTab === "received"
                              ? people[item.person]!.name
                              : "我"}
                          </strong>
                          <time>{item.time}</time>
                        </span>
                        <span>内容不可见</span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {view === "conversation" && (
          <div
            className={styles.chat}
            data-message-chat=""
            data-discussion-comments-host=""
          >
            <div
              className={styles.chatStream}
              ref={chatStream}
              data-message-stream=""
            >
              <p className={styles.chatTime}>
                {
                  initialConversations.find((item) => item.person === person)
                    ?.time
                }
              </p>
              <div className={styles.receivedBubble}>
                {
                  initialConversations.find((item) => item.person === person)
                    ?.text
                }
              </div>
              <div
                className={styles.sentMessages}
                role="log"
                aria-label="本次预览消息"
              >
                {(messages[person] ?? []).map((text, index) => (
                  <p className={styles.sentBubble} key={index}>
                    {text}
                  </p>
                ))}
              </div>
            </div>
            <form
              className={`${commentStyles.composer} ${styles.chatComposer}`}
              data-message-composer=""
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text) return;
                setMessages((old) => ({
                  ...old,
                  [person]: [...(old[person] ?? []), text],
                }));
                setConversations((old) =>
                  old.map((item) =>
                    item.person === person
                      ? { ...item, text, time: "刚刚" }
                      : item,
                  ),
                );
                setDraft("");
              }}
            >
              <div className={commentStyles.composerInputRow}>
                <div className={commentStyles.composerField}>
                  <textarea
                    id="message-preview-draft"
                    aria-label="输入消息"
                    placeholder="说点什么…"
                    rows={1}
                    autoComplete="off"
                    value={draft}
                    maxLength={500}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                  />
                </div>
                <button
                  type="submit"
                  className={commentStyles.composerSend}
                  disabled={!draft.trim()}
                >
                  发送
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
      {profilePerson !== null && (
        <PreviewAuthorProfile
          enabled
          insideDialog
          name={profilePerson === "self" ? "我" : people[profilePerson]!.name}
          followed={
            profilePerson !== "self" && followed.includes(profilePerson)
          }
          onFollowChange={(enabled) => {
            if (profilePerson === "self") return;
            setFollowed((old) =>
              enabled
                ? [...new Set([...old, profilePerson])]
                : old.filter((id) => id !== profilePerson),
            );
          }}
          onClose={() => dialogNavigation.current?.back()}
        />
      )}
    </AuthorDialog>
  );
}
