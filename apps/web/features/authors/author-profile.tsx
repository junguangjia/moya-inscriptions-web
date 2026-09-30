"use client";
import { useAuthReturnView } from "../auth/auth-return";
import { Icon } from "@moya/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AuthorProfile,
  DiscussionTarget,
  OwnComment,
} from "@moya/contracts";
import type { ProductShellProfileOverlayRenderProps } from "../product-shell/product-shell";
import { useProductShell } from "../product-shell/product-shell";
import { HorizontalPager } from "../shell/horizontal-pager";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import { authorClient } from "./author-data";
import { useAuthors } from "./author-context";
import { useDirectMessageEntry } from "../messages/direct-message-entry";
import { AvatarEntry } from "./avatar-editor";
import { ProfileEditor } from "./profile-editor";
import { ProfileSettings } from "./profile-settings";
import { ProfileList } from "./profile-list";
import { PeopleList } from "./people-list";
import { ProfileBackgroundEditor } from "./profile-background-editor";
import { requestIdentity } from "../shell/request-identity";
import styles from "../user/user-presentation.module.css";
const tabs = ["works", "favorites", "likes", "history"] as const;
const publicTabs = tabs.slice(0, 3);
const labels = {
  works: "作品",
  favorites: "收藏",
  likes: "喜欢",
  history: "历史",
};
interface AuthorProfilePreview {
  readonly self?: boolean;
  readonly profile: AuthorProfile;
  readonly onFollowChange: (enabled: boolean) => void;
}
interface AuthorProfilePresentationProps {
  /** Development-only local data; no runtime requests or account-cache writes. */
  readonly preview?: AuthorProfilePreview | undefined;
  /** Retain the overlay layout inside an already-owned modal surface. */
  readonly insideDialog?: boolean | undefined;
  /** Primary-page action; overlay profiles retain their Back button. */
  readonly headerStart?: ReactNode;
}
const ScopedAuthorProfile = ({
  state,
  backButtonRef,
  onClose,
  onViewChange,
  embedded = false,
  preview,
  insideDialog = false,
  headerStart,
}: ProductShellProfileOverlayRenderProps &
  AuthorProfilePresentationProps & { embedded?: boolean }) => {
  const directEntry = useDirectMessageEntry();
  const author = useAuthors(),
    shell = useProductShell(),
    isPreview = preview !== undefined,
    viewerId = isPreview ? null : author.viewer?.id,
    checking = isPreview ? false : author.checking,
    sessionError = isPreview ? false : author.sessionError,
    authorRevision = isPreview ? 0 : author.revision,
    id = preview?.profile.id ?? state.authorId ?? viewerId ?? null,
    owner = !isPreview && (id === viewerId || id === null),
    cacheKey = `profile:${id}`;
  const profileCapture = useRef({
    open: false,
    positions: {} as Record<string, number>,
  });
  const authReturnView = useAuthReturnView<{
    open: boolean;
    positions: Record<string, number>;
  }>(`profile-settings:${state.entryId}`, () => profileCapture.current);
  const [loadedProfile, setProfile] = useState<AuthorProfile | null>(() =>
      isPreview
        ? null
        : ((author.cache.get(cacheKey) as AuthorProfile | undefined) ?? null),
    ),
    [error, setError] = useState(""),
    [modal, setModal] = useState<"edit" | "settings" | "background" | null>(
      authReturnView?.open ? "settings" : null,
    ),
    [people, setPeople] = useState<"following" | "followers" | null>(null),
    [revision, setRevision] = useState(0),
    [progress, setProgress] = useState(
      Math.max(0, tabs.indexOf(state.tab as (typeof tabs)[number])),
    );

  const profile = preview?.profile ?? loadedProfile;
  const root = useRef<HTMLElement>(null),
    profileHeader = useRef<HTMLElement>(null),
    pendingScrollTop = useRef<number | null>(null),
    collapseHeight = useRef(0),
    pager = useRef<HorizontalPagerHandle<(typeof tabs)[number]>>(null),
    tabId = useId(),
    currentTab = state.tab === "comments" ? "works" : state.tab;
  const visibleTabs = owner ? tabs : publicTabs,
    viewTab = visibleTabs.includes(currentTab as (typeof tabs)[number])
      ? currentTab
      : "works";
  const ownProfile =
    !isPreview && !!profile?.isOwner && profile.id === viewerId;
  useEffect(() => {
    if ((modal === "edit" || modal === "background") && !ownProfile)
      setModal(null);
  }, [modal, ownProfile]);
  useEffect(() => {
    if (isPreview) return;
    let current = true;
    setError("");
    if (!id) {
      setProfile(null);
      return;
    }
    // Keep the loaded profile (and its editor) while the session is rechecked.
    // Cleanup retires any earlier read before a failed check invalidates it.
    if (checking || sessionError) return;
    void authorClient
      .profile(id)
      .then((result) => {
        if (current) {
          setProfile(result);
          author.cache.set(cacheKey, result);
        }
      })
      .catch((e) => {
        if (current) {
          setProfile(null);
          setError(e.message);
        }
      });
    return () => {
      current = false;
    };
  }, [
    id,
    viewerId,
    checking,
    sessionError,
    authorRevision,
    revision,
    isPreview,
  ]);
  const save = () => setRevision((v) => v + 1);
  const positions = useRef<Record<string, number>>(
    isPreview
      ? {}
      : (authReturnView?.positions ??
          (author.cache.get(`profile-scroll:${state.entryId}`) as
            Record<string, number> | undefined) ??
          {}),
  );
  profileCapture.current = {
    open: modal === "settings",
    positions: { ...positions.current },
  };
  const scrollTab = viewTab;
  const scrollElement = () =>
    embedded
      ? shell.platform === "pc"
        ? ((document.scrollingElement ??
            document.documentElement) as HTMLElement)
        : root.current?.closest<HTMLElement>(
            '[data-primary-destination="user"]',
          )
      : root.current;
  const changeTab = (tab: (typeof tabs)[number]) => {
    if (tab === viewTab) return;
    // The pager sizes the destination before committing. Reading scrollTop
    // here can observe browser clamping and lose the departing body offset.
    const top = positions.current[viewTab] ?? scrollElement()?.scrollTop ?? 0;
    const collapse = profileHeader.current?.getBoundingClientRect().height ?? 0;
    // All collections share the cover expansion. Once pinned, each collection
    // keeps its own body offset without bringing the cover back on a switch.
    const next =
      top < collapse - 1
        ? top
        : Math.max(collapse, positions.current[tab] ?? 0);
    pendingScrollTop.current = next;
    onViewChange(tab, next);
  };
  useLayoutEffect(() => {
    if (embedded && shell.activeDestination !== "user") return;
    const node = scrollElement();
    if (!node) return;
    node.scrollTop =
      pendingScrollTop.current ??
      (embedded
        ? positions.current[scrollTab]
        : state.profileScrollTop || positions.current[scrollTab]) ??
      0;
    pendingScrollTop.current = null;
    positions.current[scrollTab] = node.scrollTop;
    const target = embedded && shell.platform === "pc" ? window : node;
    const scroll = () => {
      positions.current[scrollTab] = node.scrollTop;
      if (!isPreview)
        author.cache.set(`profile-scroll:${state.entryId}`, positions.current);
      if (!embedded) onViewChange(scrollTab, node.scrollTop);
    };
    target.addEventListener("scroll", scroll, { passive: true });
    return () => target.removeEventListener("scroll", scroll);
  }, [
    embedded,
    isPreview,
    scrollTab,
    state.entryId,
    profile?.isOwner,
    shell.activeDestination,
    shell.platform,
  ]);
  useLayoutEffect(() => {
    if (embedded && shell.activeDestination !== "user") return;
    const header = profileHeader.current;
    const node = scrollElement();
    if (!header || !node) return;
    const measure = () => {
      const height = header.getBoundingClientRect().height;
      const previous = collapseHeight.current;
      collapseHeight.current = height;
      if (previous <= 0 || Math.abs(height - previous) < 0.5) return;
      const top = positions.current[scrollTab] ?? node.scrollTop;
      // Loading a bio or changing viewport size must not reopen a collapsed
      // cover. Offsets inside each collection remain relative to its content.
      for (const tab of Object.keys(positions.current)) {
        const saved = positions.current[tab]!;
        if (saved >= previous - 1)
          positions.current[tab] = Math.max(height, saved + height - previous);
      }
      if (top >= previous - 1) {
        node.scrollTop = Math.max(height, top + height - previous);
        positions.current[scrollTab] = node.scrollTop;
        if (!embedded) onViewChange(scrollTab, node.scrollTop);
      }
      if (!isPreview)
        author.cache.set(`profile-scroll:${state.entryId}`, positions.current);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(header);
    return () => observer?.disconnect();
  }, [
    embedded,
    isPreview,
    scrollTab,
    state.entryId,
    shell.activeDestination,
    shell.platform,
  ]);
  const panels = Object.fromEntries(
    tabs.map((tab) => [
      tab,
      <div className={styles.panelContent}>
        {isPreview ? (
          <div>
            <p>暂无可显示的内容</p>
          </div>
        ) : (
          <ProfileList
            key={`${viewerId ?? "guest"}:${id}:${tab}:${state.entryId}`}
            authorId={id}
            tab={tab}
            entryId={state.entryId}
            owner={owner}
            active={tab === viewTab}
          />
        )}
      </div>,
    ]),
  ) as Record<(typeof tabs)[number], ReactNode>;
  const name = profile?.displayName ?? (id ? "作者主页" : "访客");
  return (
    <section
      ref={root}
      role={embedded || insideDialog ? "region" : "dialog"}
      aria-modal={embedded || insideDialog ? undefined : true}
      aria-label={embedded ? "用户主页" : "作者主页"}
      className={embedded ? styles.page : styles.overlay}
      data-author-profile={id ?? "guest"}
    >
      <header className={styles.header}>
        {embedded && headerStart ? (
          headerStart
        ) : (
          <button
            type="button"
            ref={backButtonRef}
            aria-label="返回"
            className="yoyi-icon-button"
            onClick={onClose}
          >
            <Icon name="back" />
          </button>
        )}
        <span />
        {owner ? (
          <nav className={styles.profileActions} aria-label="主页管理">
            <button
              type="button"
              aria-label="设置"
              className="yoyi-icon-button"
              onClick={() => setModal("settings")}
            >
              <Icon name="settings" />
            </button>
          </nav>
        ) : (
          <span />
        )}
      </header>
      <section
        ref={profileHeader}
        className={styles.profile}
        aria-label="用户资料"
        data-profile-background-slot=""
      >
        <div className={styles.profileCover} aria-label="主页背景">
          {profile?.background && <img src={profile.background.src} alt="" />}
        </div>
        {ownProfile && (
          <button
            type="button"
            aria-label="编辑主页背景"
            className={styles.backgroundEdit}
            onClick={() => setModal("background")}
          >
            <Icon name="edit" />
          </button>
        )}
        <div className={styles.profileIdentity}>
          {ownProfile && profile ? (
            <AvatarEntry profile={profile} className={styles.avatar}>
              {profile.avatar ? (
                <img src={profile.avatar.src} alt="" width={80} height={80} />
              ) : (
                <span>{name.slice(0, 1)}</span>
              )}
            </AvatarEntry>
          ) : (
            <div
              className={styles.avatar}
              role="img"
              aria-label={`${name}的头像`}
            >
              {profile?.avatar ? (
                <img src={profile.avatar.src} alt="" width={80} height={80} />
              ) : (
                <span>{name.slice(0, 1)}</span>
              )}
            </div>
          )}
          <div className={styles.identity}>
            <h1>{name}</h1>
            {profile ? (
              <>
                <p>@{profile.handle}</p>
                <p>{profile.bio}</p>
                <div className="phase4-actions">
                  {!isPreview && profile.totals.following !== null && (
                    <button
                      type="button"
                      className="phase4-inline-total"
                      onClick={() => setPeople("following")}
                    >
                      关注{" "}
                      <strong className={styles.relationshipCount}>
                        {profile.totals.following}
                      </strong>
                    </button>
                  )}
                  {!isPreview && profile.totals.followers !== null && (
                    <button
                      type="button"
                      className="phase4-inline-total"
                      onClick={() => setPeople("followers")}
                    >
                      粉丝{" "}
                      <strong className={styles.relationshipCount}>
                        {profile.totals.followers}
                      </strong>
                    </button>
                  )}
                  {preview ? (
                    preview.self ? null : (
                      <button
                        type="button"
                        aria-pressed={profile.following}
                        className="phase4-inline-total phase4-follow-toggle"
                        onClick={() =>
                          preview.onFollowChange(!profile.following)
                        }
                      >
                        {profile.following ? "取消关注" : "关注"}
                      </button>
                    )
                  ) : !profile.isOwner && author.viewer ? (
                    <>
                      <button
                        type="button"
                        aria-pressed={profile.following}
                        className="phase4-inline-total phase4-follow-toggle"
                        onClick={async () => {
                          try {
                            await authorClient.command("relationships/follow", {
                              requestId: requestIdentity(),
                              targetId: profile.id,
                              enabled: !profile.following,
                            });
                            save();
                            author.mutate();
                          } catch (e) {
                            author.notify(
                              e instanceof Error ? e.message : "关注未完成",
                            );
                          }
                        }}
                      >
                        {profile.following ? "取消关注" : "关注"}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `屏蔽 ${profile.displayName}？双方的关注将移除。`,
                            )
                          )
                            return;
                          try {
                            await authorClient.command("relationships/block", {
                              requestId: requestIdentity(),
                              targetId: profile.id,
                              enabled: true,
                            });
                            author.mutate();
                            onClose();
                          } catch (e) {
                            author.notify(
                              e instanceof Error ? e.message : "屏蔽未完成",
                            );
                          }
                        }}
                      >
                        屏蔽
                      </button>
                      {directEntry && (
                        <button
                          type="button"
                          data-profile-direct-message=""
                          aria-label={`给 ${profile.displayName} 发私信`}
                          onClick={() => {
                            // Opening never sends: the first submit in the
                            // message center creates the canonical pair.
                            directEntry.openWith(
                              profile.id,
                              profile.displayName,
                            );
                            onClose();
                          }}
                        >
                          私信
                        </button>
                      )}
                    </>
                  ) : !profile.isOwner ? (
                    <a href={author.signInHref}>登录后关注</a>
                  ) : null}
                </div>
              </>
            ) : !id ? (
              <>
                <p>无需登录即可浏览与搜索。登录后可跨设备收藏、喜欢、关注。</p>
                <div className="phase4-actions">
                  <a href={author.signInHref}>登录</a>
                </div>
              </>
            ) : null}
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      </section>
      <section className={styles.userContent} aria-label="用户内容">
        <div className={styles.tabs} role="tablist" aria-label="用户内容分类">
          {visibleTabs.map((tab) => (
            <button
              type="button"
              key={tab}
              role="tab"
              id={`${tabId}-${tab}`}
              aria-controls={`${tabId}-panel-${tab}`}
              aria-selected={viewTab === tab}
              tabIndex={viewTab === tab ? 0 : -1}
              onClick={() => pager.current?.scrollToKey(tab)}
              onKeyDown={(event) => {
                const index = visibleTabs.indexOf(tab);
                const next =
                  event.key === "ArrowRight"
                    ? visibleTabs[Math.min(index + 1, visibleTabs.length - 1)]
                    : event.key === "ArrowLeft"
                      ? visibleTabs[Math.max(0, index - 1)]
                      : undefined;
                if (next) {
                  event.preventDefault();
                  pager.current?.scrollToKey(next);
                  root.current
                    ?.querySelector<HTMLElement>(`[id="${tabId}-${next}"]`)
                    ?.focus({ preventScroll: true });
                }
              }}
            >
              {labels[tab]}
            </button>
          ))}
          <span
            aria-hidden
            className={styles.tabIndicator}
            style={{
              width: `${100 / visibleTabs.length}%`,
              transform: `translateX(${progress * 100}%)`,
            }}
          />
        </div>
        <HorizontalPager
          ref={pager}
          keys={visibleTabs}
          activeKey={viewTab as (typeof tabs)[number]}
          onCommit={changeTab}
          onProgress={setProgress}
          panels={panels}
          platform={shell.platform}
          scrollOwner="document"
          visible={
            (!embedded || shell.activeDestination === "user") &&
            modal === null &&
            people === null
          }
          frameClassName={styles.pager}
          panelClassName={styles.panel}
          panelAttributes={(tab) => ({ "data-author-panel": tab })}
          panelId={(tab) => `${tabId}-panel-${tab}`}
          panelLabelledBy={(tab) => `${tabId}-${tab}`}
        />
      </section>
      {ownProfile && profile && modal === "edit" && (
        <ProfileEditor
          profile={profile}
          onClose={() => setModal("settings")}
          onSaved={save}
        />
      )}
      {ownProfile && profile && modal === "background" && (
        <ProfileBackgroundEditor
          profile={profile}
          onClose={() => setModal(null)}
          onSaved={save}
        />
      )}
      {!isPreview &&
        people &&
        profile &&
        (ownProfile || profile.privacy[people] === "public") && (
          <PeopleList
            key={`${author.viewer?.id ?? "guest"}:${profile.id}:${people}`}
            id={profile.id}
            list={people}
            owner={ownProfile}
            revision={author.revision}
            onClose={() => setPeople(null)}
          />
        )}
      {owner && modal === "settings" && (
        <ProfileSettings
          key={profile?.id ?? "guest"}
          profile={profile}
          onClose={() => setModal(null)}
          onSaved={save}
          onEdit={ownProfile ? () => setModal("edit") : undefined}
        />
      )}
    </section>
  );
};
export const MyComments = ({
  entryId,
  onOpenContent,
}: {
  entryId: string;
  /**
   * A host that owns a modal (the message center) opens the target after it
   * has finished closing. Every target, Articles included, goes through it.
   */
  onOpenContent?:
    ((target: DiscussionTarget, opener: HTMLElement) => void) | undefined;
}) => {
  const author = useAuthors(),
    shell = useProductShell();
  const cacheKey = `own-comments:${author.viewer?.id}:${entryId}`;
  type Snapshot = { items: OwnComment[]; page: number; total: number };
  const [snapshot, setSnapshot] = useState<Snapshot>(
    () =>
      (author.cache.get(cacheKey) as Snapshot) ?? {
        items: [],
        page: 0,
        total: 0,
      },
  );
  const { items, page, total } = snapshot;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const lock = useRef(false),
    epoch = useRef(0),
    failed = useRef<number | null>(null),
    deletionLock = useRef(false);
  const saveSnapshot = (next: Snapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    author.cache.set(cacheKey, next);
  };
  const load = async (n = 0) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const run = epoch.current;
    try {
      const last = n || Math.max(1, snapshotRef.current.page);
      const collected: OwnComment[] = [];
      let count = 0;
      for (let current = n || 1; current <= last; current++) {
        const result = await authorClient.comments(current);
        if (run !== epoch.current) return;
        collected.push(...result.items);
        count = result.total;
      }
      const merged =
        n > 1 ? [...snapshotRef.current.items, ...collected] : collected;
      saveSnapshot({
        items: [...new Map(merged.map((item) => [item.id, item])).values()],
        page: last,
        total: count,
      });
      failed.current = null;
    } catch (e) {
      if (run === epoch.current) {
        failed.current = n;
        setError(e instanceof Error ? e.message : "评论记录不可用");
      }
    } finally {
      if (run === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
      lock.current = false;
    };
  }, [author.viewer?.id, author.revision]);
  return (
    <section>
      <h2>我的评论</h2>
      <p className="phase4-muted">
        仅自己可见。不可用的第三方内容不显示上下文。
      </p>
      <ul className="phase4-comment-list">
        {items.map((item) => (
          <li key={item.id}>
            <p>{item.text}</p>
            <small>{new Date(item.createdAt).toLocaleString()}</small>
            <div className="phase4-actions">
              {item.target ? (
                <button
                  type="button"
                  onClick={(event) => {
                    author.cache.set("discussion-location", {
                      target: item.target,
                      id: item.id,
                    });
                    const target = item.target!;
                    const opener = event.currentTarget;
                    if (onOpenContent) onOpenContent(target, opener);
                    else if (target.type === "article") {
                      // content-community-completion-v1: an Article discussion
                      // opens through the editorial reader, a topic overlay of
                      // the discussion destination (openTopic refuses from
                      // any other destination).
                      shell.navigatePrimary("discussion");
                      requestAnimationFrame(() =>
                        shell.openTopic(target.id, opener, 0),
                      );
                    } else shell.openContent(target, opener);
                  }}
                >
                  前往评论位置
                </button>
              ) : (
                <span>目标内容或讨论已不可用</span>
              )}
              {!item.deleted && (
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      !window.confirm("删除这条评论正文？其他人的回复会保留。")
                    )
                      return;
                    if (deletionLock.current) return;
                    deletionLock.current = true;
                    const run = epoch.current;
                    try {
                      await authorClient.command(
                        `discussion/items/${item.id}/body`,
                        { requestId: requestIdentity() },
                        "DELETE",
                      );
                      if (run !== epoch.current) return;
                      saveSnapshot({
                        ...snapshotRef.current,
                        items: snapshotRef.current.items.map((current) =>
                          current.id === item.id
                            ? {
                                ...current,
                                text: "该正文已删除",
                                deleted: true,
                              }
                            : current,
                        ),
                      });
                      await load();
                      author.mutate();
                    } catch (e) {
                      if (run === epoch.current)
                        setError(e instanceof Error ? e.message : "删除失败");
                    } finally {
                      deletionLock.current = false;
                    }
                  }}
                >
                  删除正文
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length < total && (
        <button
          className="phase4-button"
          disabled={busy}
          onClick={() => void load(page + 1)}
        >
          加载更多
        </button>
      )}
      {busy && <p role="status">读取中…</p>}
      {error && (
        <p role="alert">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(failed.current ?? 0)}
          >
            重试读取
          </button>
        </p>
      )}
    </section>
  );
};

export const AuthorProfileOverlay = (
  props: ProductShellProfileOverlayRenderProps & AuthorProfilePresentationProps,
) => {
  const author = useAuthors();
  const preview = props.preview;
  return (
    <ScopedAuthorProfile
      key={`${preview ? "preview" : (author.viewer?.id ?? "guest")}:${props.state.entryId}`}
      {...props}
      preview={preview}
    />
  );
};

/** An in-flow primary destination; the shell owns its vertical scroll and Back. */
export const AuthorProfilePage = ({
  onBack,
  headerStart,
  entryId = "primary-user",
}: {
  onBack: () => void;
  headerStart?: ReactNode;
  entryId?: string;
}) => {
  const author = useAuthors();
  return (
    <ScopedAuthorProfilePage
      key={`${author.viewer?.id ?? "guest"}:${entryId}`}
      onBack={onBack}
      headerStart={headerStart}
      entryId={entryId}
    />
  );
};
const ScopedAuthorProfilePage = ({
  onBack,
  headerStart,
  entryId,
}: {
  onBack: () => void;
  headerStart?: ReactNode;
  entryId: string;
}) => {
  const author = useAuthors();
  const cacheKey = `primary-profile-tab:${author.viewer?.id ?? "guest"}:${entryId}`;
  const selectedTab = useRef<(typeof tabs)[number]>("works");
  const authReturnView = useAuthReturnView(
    `primary-profile:${entryId}`,
    () => ({ tab: selectedTab.current }),
  );
  const [tab, setTab] = useState<(typeof tabs)[number]>(() => {
    const saved = authReturnView?.tab ?? author.cache.get(cacheKey);
    return tabs.includes(saved as (typeof tabs)[number])
      ? (saved as (typeof tabs)[number])
      : "works";
  });
  selectedTab.current = tab;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <ScopedAuthorProfile
      embedded
      headerStart={headerStart}
      state={{
        kind: "profile",
        version: 2,
        authorId: author.viewer?.id ?? null,
        entryId,
        tab,
        profileScrollTop: 0,
        sourceDestination: "home",
        sourceScrollTop: 0,
      }}
      backButtonRef={backButtonRef}
      onClose={onBack}
      onViewChange={(next) => {
        const selected = next === "comments" ? "works" : next;
        author.cache.set(cacheKey, selected);
        setTab(selected);
      }}
    />
  );
};
