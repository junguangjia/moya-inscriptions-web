"use client";
import { useAuthReturn } from "../auth/auth-return";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@moya/ui";
import type { DiscussionTarget, NotificationItem } from "@moya/contracts";
import { authorClient } from "../authors/author-data";
import { AuthorDialog } from "../authors/author-dialog";
import { MyComments } from "../authors/author-profile";
import { useAuthors } from "../authors/author-context";
import { CategoryIcon } from "../authors/message-category-icon";
import { useProductShell } from "../product-shell/product-shell";
import type { PrimaryDestination } from "../shell/primary-shell";
import { useNotifications } from "./notification-context";
import { NotificationRefresher } from "./notification-refresher";
import styles from "../authors/message-preview.module.css";
import triggerStyles from "../authors/message-center.module.css";
import local from "./notifications.module.css";

/** C supplies a stable adapter at the client composition boundary; no preview sender is imported here. */
export interface DirectMessagePanelAdapter {
  render: (props: {
    onOpenProfile: (id: string) => void;
    onDepthChange: (depth: number) => void;
    backRequested: number;
    /**
     * parallel-community-integration-qa: the open conversation's participant
     * for this host's dialog header, as in the accepted chat (avatar beside
     * the nickname, no extra profile row). A stable setter; null clears it.
     */
    onTitleChange: (title: DirectMessageHeader | null) => void;
  }) => ReactNode;
  useUnreadConversationCount: () => number;
  /**
   * parallel-community-integration-qa: a pending entry request (for example a
   * profile's 私信 action) that should open this host on its direct-message
   * view. Returns an opaque token that changes per request, or null. The
   * adapter consumes the request itself once its panel is mounted.
   */
  useOpenRequest?: () => number | null;
}
export interface DirectMessageHeader {
  readonly label: string;
  readonly content: ReactNode;
}
const noOpenRequest = () => null;
const unavailableDM: DirectMessagePanelAdapter = {
  render: () => <p className={styles.empty}>私信尚未在此环境接入。</p>,
  useUnreadConversationCount: () => 0,
};
type View = "home" | "followers" | "reactions" | "comments";
const labels = {
  home: "消息",
  followers: "粉丝",
  reactions: "赞和收藏",
  comments: "评论",
};
export function LiveMessageTrigger({
  directMessages = unavailableDM,
}: {
  directMessages?: DirectMessagePanelAdapter;
}) {
  const author = useAuthors();
  return (
    <AccountMessages
      key={author.viewer?.id ?? "guest"}
      directMessages={directMessages}
    />
  );
}
function AccountMessages({
  directMessages,
}: {
  directMessages: DirectMessagePanelAdapter;
}) {
  const author = useAuthors(),
    shell = useProductShell(),
    inbox = useNotifications();
  const dmUnread = directMessages.useUnreadConversationCount();
  const [open, setOpen] = useState(false),
    [closeRequested, setCloseRequested] = useState(false),
    [view, setView] = useState<View>("home"),
    [commentTab, setCommentTab] = useState<"received" | "sent" | "mentions">(
      "received",
    ),
    [notice, setNotice] = useState(""),
    [dmDepth, setDmDepth] = useState(0),
    [dmBack, setDmBack] = useState(0),
    [dmTitle, setDmTitle] = useState<DirectMessageHeader | null>(null);
  const opener = useRef<HTMLButtonElement>(null),
    content = useRef<HTMLDivElement>(null),
    scroll = useRef(new Map<string, number>()),
    pending = useRef<DiscussionTarget | string | null>(null),
    returning = useRef<{
      kind: "content" | "profile" | "topic";
      opened: boolean;
      /** The destination this host lives in, when the target left it. */
      source?: PrimaryDestination;
    } | null>(null),
    frame = useRef<number | null>(null);
  const authReturn = useAuthReturn();
  const restoredAuthView = useRef(false);
  const authSnapshot = useRef({
    owner: author.viewer?.id ?? null,
    open,
    view,
    commentTab,
    positions: new Map<string, number>(),
  });
  authSnapshot.current = {
    owner: author.viewer?.id ?? null,
    open,
    view,
    commentTab,
    positions: new Map(scroll.current),
  };
  useEffect(() => {
    const destination =
      opener.current?.closest<HTMLElement>("[data-primary-destination]")
        ?.dataset.primaryDestination ?? "home";
    return authReturn?.register(
      `messages-live:${destination}`,
      () => authSnapshot.current,
    );
  }, [authReturn]);
  useEffect(() => {
    if (restoredAuthView.current || author.checking || author.sessionError)
      return;
    const destination =
      opener.current?.closest<HTMLElement>("[data-primary-destination]")
        ?.dataset.primaryDestination ?? "home";
    const saved = authReturn?.read(`messages-live:${destination}`) as
      typeof authSnapshot.current | undefined;
    restoredAuthView.current = true;
    if (!saved || saved.owner !== (author.viewer?.id ?? null)) return;
    scroll.current = new Map(saved.positions);
    setView(saved.view);
    setCommentTab(saved.commentTab);
    setOpen(saved.open);
    inbox.setFilter(
      saved.view === "reactions"
        ? "likes"
        : saved.view === "comments"
          ? saved.commentTab === "mentions"
            ? "mentions"
            : "comments"
          : "all",
    );
  }, [
    authReturn,
    author.checking,
    author.sessionError,
    author.viewer?.id,
    inbox.setFilter,
  ]);
  const confirmed = !author.checking && !author.sessionError && !!author.viewer;
  const incoming =
    view === "reactions" || (view === "comments" && commentTab !== "sent");
  // parallel-community-integration-qa: C's profile 私信 action stores an entry
  // request. The live host must open itself for it, as the scoped host did;
  // otherwise the request waits until the user opens 消息 by hand. Only the
  // visible host inside the active destination reacts (same guard as below).
  const useOpenRequest = directMessages.useOpenRequest ?? noOpenRequest;
  const openRequest = useOpenRequest();
  const handledOpenRequest = useRef<number | null>(null);
  useEffect(() => {
    if (openRequest === null || handledOpenRequest.current === openRequest)
      return;
    if (!confirmed) return;
    let frame = 0,
      attempts = 0,
      hostless = false;
    const tryOpen = () => {
      frame = 0;
      if (
        !opener.current ||
        opener.current.closest('[inert], [hidden], [aria-hidden="true"]')
      ) {
        // The request arrives in the same commit that closes the profile that
        // issued it, while the page behind that profile is still inert. The
        // active host becomes reachable a frame or two later; hosts of other
        // destinations stay hidden and give up after a bounded wait.
        // The user destination has no message host at all: there the home
        // host brings the home destination forward, then opens as usual. The
        // shell refuses to switch while the closing profile is still
        // registered, so the (idempotent) switch is retried each frame.
        const destination = opener.current
          ?.closest("[data-primary-destination]")
          ?.getAttribute("data-primary-destination");
        const activeHasHost = document.querySelector(
          '[data-primary-destination][data-active="true"] [data-live-message-trigger]',
        );
        if (destination === "home" && !activeHasHost) {
          hostless = true;
          shell.navigatePrimary("home");
        }
        attempts += 1;
        if (attempts < (hostless ? 120 : 30))
          frame = requestAnimationFrame(tryOpen);
        return;
      }
      handledOpenRequest.current = openRequest;
      setView("home");
      setNotice("");
      setCloseRequested(false);
      setOpen(true);
    };
    tryOpen();
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [openRequest, confirmed]);
  const entryOpened = useRef(false);
  useEffect(() => {
    if (entryOpened.current || author.checking) return;
    if (
      !opener.current ||
      opener.current.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      return;
    entryOpened.current = true;
    const location = new URL(window.location.href);
    const requested = location.searchParams.get("notifications");
    if (
      requested !== "comments" &&
      requested !== "likes" &&
      requested !== "mentions"
    )
      return;
    // The shell retains hidden page headers. Only the active host consumes this entry.
    location.searchParams.delete("notifications");
    window.history.replaceState(window.history.state, "", location);
    setView(requested === "likes" ? "reactions" : "comments");
    setCommentTab(requested === "mentions" ? "mentions" : "received");
    inbox.setFilter(requested);
    setOpen(true);
  }, [author.checking, inbox.setFilter]);
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
  const activity = confirmed ? (inbox.page?.unread.total ?? 0) : 0;
  const conversations =
    confirmed && Number.isFinite(dmUnread)
      ? Math.max(0, Math.floor(dmUnread))
      : 0;
  // parallel-community-integration-qa: an open conversation or start view
  // replaces the home content, as in the accepted chat. The categories and the
  // heading step aside while the panel stays mounted, and the panel fills the
  // body so its stream scrolls inside and its composer stays at the bottom.
  // The list keeps its own scroll position for Back.
  const directOpen = view === "home" && dmDepth > 0;
  const total = activity + conversations,
    location = `${view}:${commentTab}${directOpen ? ":direct" : ""}`;
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (open && content.current)
      content.current.scrollTop = scroll.current.get(location) ?? 0;
  }, [open, location]);
  useEffect(() => {
    const target = returning.current;
    if (!target) return;
    const active =
      target.kind === "content"
        ? shell.activeContent
        : target.kind === "topic"
          ? shell.activeTopicId
          : shell.activeProfile;
    if (active) {
      target.opened = true;
      return;
    }
    if (target.opened) {
      returning.current = null;
      // parallel-community-integration-qa: an Article opens as a topic of the
      // discussion destination, and closing it stays there. This host lives
      // in the destination the reader came from, now hidden: return there
      // before reopening, as the scoped host does, because a modal reopened
      // inside a hidden destination blocks the whole page invisibly.
      if (target.source && shell.activeDestination !== target.source)
        shell.navigatePrimary(target.source);
      setCloseRequested(false);
      setOpen(true);
    }
  }, [shell.activeContent, shell.activeProfile, shell.activeTopicId]);
  const navigate = (target: DiscussionTarget | string) => {
    if (!confirmedRef.current) return;
    pending.current = target;
    setCloseRequested(true);
  };
  const select = (next: View) => {
    setView(next);
    setNotice("");
    inbox.setFilter(
      next === "reactions"
        ? "likes"
        : next === "comments"
          ? commentTab === "mentions"
            ? "mentions"
            : "comments"
          : "all",
    );
  };
  const openItem = async (item: NotificationItem) => {
    if (!item.available || !item.target || !confirmed) return;
    try {
      const target = item.target;
      if (item.commentId) await authorClient.locate(target, item.commentId, []);
      else if (target.type === "article")
        // An Article notification is always comment activity, so it always
        // carries a commentId. Without one there is nothing to resolve, and the
        // safe unavailable notice below is the truthful answer.
        throw new Error("Article notification without a comment");
      else await authorClient.card(target);
      if (!confirmedRef.current) return;
      if (item.commentId)
        author.cache.set("discussion-location", {
          target: item.target,
          id: item.commentId,
        });
      await inbox.read(item.observation);
      navigate(item.target);
    } catch {
      setNotice("原内容或评论已不可用");
      inbox.refresh();
    }
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={triggerStyles.trigger}
        data-live-message-trigger=""
        aria-label={
          total
            ? `打开消息，${activity} 条未读动态，${conversations} 个未读私信会话`
            : "打开消息"
        }
        onClick={() => {
          returning.current = null;
          setView("home");
          inbox.setFilter("all");
          setCloseRequested(false);
          setOpen(true);
          inbox.refresh();
        }}
      >
        <Icon name="message" aria-hidden="true" />
        {total > 0 && (
          <span
            className={triggerStyles.badge}
            data-message-unread-badge=""
            aria-hidden="true"
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </button>
      {open && (
        <AuthorDialog
          title={directOpen && dmTitle ? dmTitle.label : labels[view]}
          titleContent={directOpen ? dmTitle?.content : undefined}
          className={styles.page}
          navigationDepth={view === "home" ? dmDepth : 1}
          onBack={() => {
            if (view === "home" && dmDepth > 0) setDmBack((value) => value + 1);
            else select("home");
          }}
          closeRequested={closeRequested}
          onClose={() => {
            setOpen(false);
            setCloseRequested(false);
            const target = pending.current;
            pending.current = null;
            if (target && confirmedRef.current)
              frame.current = requestAnimationFrame(() => {
                frame.current = null;
                if (!opener.current || !confirmedRef.current) return;
                const element = opener.current;
                returning.current = {
                  kind:
                    typeof target === "string"
                      ? "profile"
                      : target.type === "article"
                        ? "topic"
                        : "content",
                  opened: false,
                  source: shell.activeDestination,
                };
                if (typeof target === "string")
                  shell.openProfile(target, element);
                else if (target.type === "article") {
                  // C renders a published Article as a topic overlay on the
                  // discussion destination, not as a Catalog/Work card. Switch
                  // first: openTopic refuses from any other destination.
                  const articleId = target.id;
                  shell.navigatePrimary("discussion");
                  frame.current = requestAnimationFrame(() => {
                    frame.current = null;
                    if (!confirmedRef.current) return;
                    shell.openTopic(articleId, element, 0);
                  });
                } else shell.openContent(target, element);
              });
          }}
        >
          <div
            ref={content}
            className={`${styles.content}${incoming && confirmed ? ` ${local.pullScroll}` : ""}${directOpen ? ` ${local.directOpen}` : ""}`}
            data-message-live=""
            data-message-view={view}
            onScroll={(event) =>
              scroll.current.set(location, event.currentTarget.scrollTop)
            }
          >
            {incoming && confirmed && (
              <NotificationRefresher
                key={location}
                scrollRef={content}
                loading={inbox.loading}
                onRefresh={() =>
                  inbox.page
                    ? inbox.read(inbox.page.observation)
                    : inbox.refresh()
                }
              />
            )}
            {/* parallel-community-integration-qa: revalidating the confirmed
                account (window focus, reconnect) is not an account switch, so
                the content — an open conversation and its draft — stays
                mounted; a different account remounts this host by its key and
                a revoked Session clears the viewer. */}
            {!author.viewer && author.checking ? (
              <p className={local.status} role="status">
                正在确认账户…
              </p>
            ) : !author.viewer && author.sessionError ? (
              <p className={local.status} role="alert">
                账户暂时不可用。
                <button onClick={() => void author.refresh()}>重试</button>
              </p>
            ) : !author.viewer ? (
              <p className={local.status}>
                <a href={author.signInHref}>登录后查看消息</a>
              </p>
            ) : (
              <>
                {author.sessionError && (
                  <p className={local.status} role="alert">
                    账户暂时不可用。
                    <button onClick={() => void author.refresh()}>重试</button>
                  </p>
                )}
                {notice && (
                  <p className={local.status} role="status">
                    {notice}
                  </p>
                )}
                {view === "home" && (
                  <>
                    {!directOpen && (
                      <nav className={styles.categories} aria-label="消息分类">
                        {(["followers", "reactions", "comments"] as const).map(
                          (kind) => {
                            const count =
                              kind === "reactions"
                                ? (inbox.page?.unread.likes ?? 0)
                                : kind === "comments"
                                  ? (inbox.page?.unread.comments ?? 0) +
                                    (inbox.page?.unread.mentions ?? 0)
                                  : 0;
                            return (
                              <button
                                type="button"
                                key={kind}
                                aria-label={`${labels[kind]}${count ? `，${count} 条未读动态` : ""}`}
                                onClick={() => select(kind)}
                              >
                                <span
                                  className={styles.categoryIcon}
                                  data-kind={kind}
                                >
                                  <CategoryIcon kind={kind} />
                                  {count > 0 && (
                                    <span
                                      className={styles.categoryBadge}
                                      aria-hidden="true"
                                    >
                                      {count > 99 ? "99+" : count}
                                    </span>
                                  )}
                                </span>
                              </button>
                            );
                          },
                        )}
                      </nav>
                    )}
                    {!directOpen && (
                      <div className={styles.listHeading}>
                        <h3>私信</h3>
                      </div>
                    )}
                    <div className={local.directRegion}>
                      {directMessages.render({
                        onOpenProfile: navigate,
                        onDepthChange: setDmDepth,
                        backRequested: dmBack,
                        onTitleChange: setDmTitle,
                      })}
                    </div>
                    {!directOpen && inbox.error && (
                      <p className={local.status} role="alert">
                        {inbox.error}{" "}
                        <button onClick={inbox.refresh}>重试</button>
                      </p>
                    )}
                  </>
                )}
                {view === "followers" && (
                  <Followers id={author.viewer.id} onOpen={navigate} />
                )}
                {view === "comments" && (
                  <div
                    className={styles.commentTabs}
                    role="tablist"
                    aria-label="评论消息"
                  >
                    {(["received", "sent", "mentions"] as const).map((tab) => (
                      <button
                        type="button"
                        key={tab}
                        role="tab"
                        aria-selected={tab === commentTab}
                        onClick={() => {
                          setCommentTab(tab);
                          inbox.setFilter(
                            tab === "mentions" ? "mentions" : "comments",
                          );
                        }}
                      >
                        {tab === "received"
                          ? "收到的评论"
                          : tab === "sent"
                            ? "发出的评论"
                            : "提到我"}
                      </button>
                    ))}
                  </div>
                )}
                {view === "comments" && commentTab === "sent" ? (
                  <MyComments
                    entryId={`notifications-${author.viewer.id}`}
                    onOpenContent={navigate}
                  />
                ) : (
                  (view === "reactions" || view === "comments") && (
                    <>
                      {view === "reactions" && (
                        <p className={local.status}>
                          这里显示收到的赞；收藏不会产生通知。
                        </p>
                      )}
                      {inbox.loading && !inbox.page && (
                        <p className={local.status} role="status">
                          正在加载消息…
                        </p>
                      )}
                      {inbox.error && (
                        <p className={local.status} role="alert">
                          {inbox.error}{" "}
                          <button onClick={inbox.refresh}>重试</button>
                        </p>
                      )}
                      {inbox.page && (
                        <>
                          {inbox.page.items.length === 0 && (
                            <p className={styles.empty}>暂无消息</p>
                          )}
                          <ul className={styles.comments}>
                            {inbox.page.items.map((item) => (
                              <li key={item.id} data-notification-id={item.id}>
                                {item.available ? (
                                  <>
                                    <button
                                      className={styles.commentAvatar}
                                      type="button"
                                      aria-label={`打开${item.actors[0]?.displayName ?? "用户"}的主页`}
                                      onClick={() => {
                                        if (item.actors[0])
                                          navigate(item.actors[0].id);
                                      }}
                                    >
                                      <span
                                        className={`${styles.avatar} ${styles.smallAvatar}`}
                                        aria-hidden="true"
                                      >
                                        {item.actors[0]?.displayName.slice(
                                          0,
                                          1,
                                        )}
                                      </span>
                                    </button>
                                    <div className={styles.commentBody}>
                                      <button
                                        type="button"
                                        className={styles.commentTarget}
                                        onClick={() => void openItem(item)}
                                      >
                                        <span className={local.itemHeading}>
                                          <span className={local.identity}>
                                            <strong>
                                              {item.actors
                                                .map(
                                                  (actor) => actor.displayName,
                                                )
                                                .join("、")}
                                              {item.actorCount >
                                              item.actors.length
                                                ? ` 等 ${item.actorCount} 人`
                                                : ""}
                                            </strong>
                                            <span className={styles.secondary}>
                                              {item.reason === "like"
                                                ? "赞了你的内容"
                                                : item.reason === "reply"
                                                  ? "回复了你"
                                                  : item.reason === "mention"
                                                    ? "提到了你"
                                                    : "评论了你的作品"}
                                            </span>
                                          </span>
                                          <time
                                            className={local.timestamp}
                                            dateTime={item.createdAt}
                                          >
                                            <span>
                                              {new Date(
                                                item.createdAt,
                                              ).toLocaleDateString("zh-CN")}
                                            </span>
                                            <span>
                                              {new Date(
                                                item.createdAt,
                                              ).toLocaleTimeString("zh-CN", {
                                                hour12: false,
                                              })}
                                            </span>
                                          </time>
                                        </span>
                                        <span className={local.itemPreview}>
                                          <span className={styles.commentText}>
                                            {item.text}
                                          </span>
                                          {item.unread && (
                                            <span
                                              className={local.unreadDot}
                                              role="img"
                                              aria-label="未读"
                                              data-notification-unread=""
                                            />
                                          )}
                                        </span>
                                        <span className={styles.workReference}>
                                          <Icon
                                            name="message"
                                            aria-hidden="true"
                                          />
                                          查看原内容
                                          {item.commentId ? "与评论" : ""}
                                        </span>
                                      </button>
                                    </div>
                                  </>
                                ) : (
                                  <p className={styles.unavailableComment}>
                                    原内容或评论已不可用
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                          {inbox.page.nextCursor &&
                            inbox.page.items.length < 200 && (
                              <div className={local.tools}>
                                <button
                                  type="button"
                                  disabled={inbox.loading}
                                  onClick={inbox.more}
                                >
                                  加载更多
                                </button>
                              </div>
                            )}
                          {inbox.page.items.length >= 200 && (
                            <p className={local.status}>
                              已显示本次浏览的 200 条消息。刷新可查看最新消息。
                            </p>
                          )}
                        </>
                      )}
                    </>
                  )
                )}
              </>
            )}
          </div>
        </AuthorDialog>
      )}
    </>
  );
}
function Followers({
  id,
  onOpen,
}: {
  id: string;
  onOpen: (id: string) => void;
}) {
  const [page, setPage] = useState(1),
    [result, setResult] = useState<Awaited<
      ReturnType<typeof authorClient.people>
    > | null>(null),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    setResult(null);
    void authorClient
      .people(id, "followers", page)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, page, retry]);
  if (error)
    return (
      <p className={local.status} role="alert">
        粉丝列表暂时不可用。
        <button onClick={() => setRetry((n) => n + 1)}>重试</button>
      </p>
    );
  if (!result)
    return (
      <p className={local.status} role="status">
        正在加载…
      </p>
    );
  return (
    <>
      <ul className={styles.peopleList}>
        {result.items.map((person) => (
          <li key={person.id}>
            <button
              className={styles.personLink}
              onClick={() => onOpen(person.id)}
            >
              <span className={styles.avatar} aria-hidden="true">
                {person.displayName.slice(0, 1)}
              </span>
              <span>
                <strong>{person.displayName}</strong>
                <span className={styles.secondary}>@{person.handle}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!result.items.length && <p className={styles.empty}>暂无粉丝</p>}
      <div className={local.tools}>
        {page > 1 && <button onClick={() => setPage(page - 1)}>上一页</button>}
        {page * result.pageSize < result.total && (
          <button onClick={() => setPage(page + 1)}>下一页</button>
        )}
      </div>
    </>
  );
}
