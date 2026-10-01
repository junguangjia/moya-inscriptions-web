"use client";

import { useAuthReturnView } from "../auth/auth-return";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiscussionIcon } from "../discussion-preview/discussion-icons";
import { AnimatedTopTabs } from "../shell/animated-top-tabs";
import { HorizontalPager } from "../shell/horizontal-pager";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import type { ReactNode } from "react";
import type { HomeSurfaceData } from "./home-feed";
import { useProductShell } from "../product-shell/product-shell";
import { useDiscussionPreview } from "../discussion-preview/preview-context";
import {
  DiscussionPreviewFeed,
  previewFeed,
} from "../discussion-preview/discussion-preview";
import { CatalogMasonry } from "./catalog-masonry";
import {
  EditorialNewsFeed,
  EditorialTopicsFeed,
} from "../editorial-content/editorial-feed";
import {
  isArticleId,
  isCollectionId,
} from "../editorial-content/use-editorial-content";
import { ThreadsFeed, ThreadsUnavailable } from "../threads/threads-feed";
import { isThreadId } from "../threads/use-threads";
import { TopicCard } from "../topics/topic-card";
import styles from "./home-screen.module.css";
const feeds = ["news", "threads", "topics"] as const;
type DiscussionFeed = (typeof feeds)[number];
const labels = { news: "近闻", threads: "话题", topics: "专题" };
// Real editorial ids map to their feed; preview fixtures keep their own map.
const editorialFeed = (id: string | null): DiscussionFeed | null =>
  isArticleId(id)
    ? "news"
    : isCollectionId(id)
      ? "topics"
      : isThreadId(id)
        ? "threads"
        : null;
/** The Discussion feed whose panel holds an opened card, if any. */
export const openerFeed = (
  opener: HTMLElement | undefined,
): DiscussionFeed | null => {
  const panel = opener?.closest<HTMLElement>('[id^="discussion-panel-"]');
  const feed = panel?.id.slice("discussion-panel-".length);
  return feeds.find((key) => key === feed) ?? null;
};
const icons = {
  news: "news",
  threads: "discussion",
  topics: "academic-cap",
} as const;
export function DiscussionScreen({
  data,
  headerStart,
  headerEnd,
  initialTopicId = null,
  liveThreads = false,
}: {
  readonly data: HomeSurfaceData["topics"];
  readonly headerStart?: ReactNode;
  readonly headerEnd?: ReactNode;
  readonly initialTopicId?: string | null;
  /** The live 话题 feed needs the author and publishing providers. */
  readonly liveThreads?: boolean;
}) {
  const shell = useProductShell();
  const preview = useDiscussionPreview();
  const initialFeed =
    (preview && previewFeed(initialTopicId)) ||
    editorialFeed(initialTopicId) ||
    (initialTopicId ? "topics" : "news");
  const root = useRef<HTMLDivElement>(null);
  const pager = useRef<HorizontalPagerHandle<DiscussionFeed>>(null);
  const activeRef = useRef<DiscussionFeed>(initialFeed);
  const authReturnView = useAuthReturnView("discussion", () => ({
    feed: activeRef.current,
    top: shell.readActiveScrollTop(),
  }));
  const [active, setActive] = useState<DiscussionFeed>(
    authReturnView?.feed ?? initialFeed,
  );
  activeRef.current = active;
  useEffect(() => {
    if (!authReturnView) return;
    pager.current?.scrollToKey(authReturnView.feed);
    shell.restoreActiveScrollTop(authReturnView.top);
  }, [authReturnView, shell.restoreActiveScrollTop]);
  const [progress, setProgress] = useState(
    feeds.indexOf(authReturnView?.feed ?? initialFeed),
  );
  const openedInitial = useRef(false);
  // Guest read memory for Threads (session-local; not synchronized account data).
  const [localRead, setLocalRead] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const positions = useRef<Record<DiscussionFeed, number>>({
    news: 0,
    threads: 0,
    topics: 0,
  });
  const commit = useCallback(
    (next: DiscussionFeed) => {
      if (shell.platform === "pc")
        positions.current[active] = shell.readActiveScrollTop();
      setActive(next);
      if (shell.platform === "pc")
        shell.restoreActiveScrollTop(positions.current[next]);
    },
    [active, shell],
  );
  useEffect(() => {
    const opener = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>("[data-topic-id]") ??
        [],
    ).find((button) => button.dataset.topicId === shell.activeTopicId);
    // An Article id alone does not say 近闻 or 专题: the feed that holds the
    // opened card wins, and the id prefix only decides for a deep link.
    const targetFeed =
      (preview && previewFeed(shell.activeTopicId)) ||
      openerFeed(opener) ||
      editorialFeed(shell.activeTopicId) ||
      "topics";
    const frame =
      shell.activeTopicId !== null && active !== targetFeed
        ? requestAnimationFrame(() => pager.current?.scrollToKey(targetFeed))
        : null;
    if (opener && shell.activeTopicId)
      shell.registerTopicOpener(shell.activeTopicId, opener);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [
    active,
    Boolean(preview),
    shell.activeTopicId,
    shell.registerTopicOpener,
  ]);
  useEffect(() => {
    if (!initialTopicId || openedInitial.current) return;
    if (shell.activeDestination !== "discussion") {
      shell.navigatePrimary("discussion");
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (openedInitial.current || !root.current) return;
      openedInitial.current = true;
      const opener =
        Array.from(
          root.current.querySelectorAll<HTMLButtonElement>("[data-topic-id]"),
        ).find((button) => button.dataset.topicId === initialTopicId) ??
        root.current;
      shell.openTopic(initialTopicId, opener, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    initialTopicId,
    shell.activeDestination,
    shell.navigatePrimary,
    shell.openTopic,
  ]);
  const topics =
    data.state === "populated" ? (
      <CatalogMasonry
        feedLayout={shell.feedLayout}
        getKey={(topic) => topic.id}
        spanAtAlignedRows
        items={data.items}
        platform={shell.platform}
        renderItem={(topic, onMediaSettled) => (
          <TopicCard
            topic={topic}
            onMediaSettled={onMediaSettled}
            onOpen={(item, opener) =>
              shell.openTopic(item.id, opener, shell.readActiveScrollTop())
            }
          />
        )}
      />
    ) : (
      <section
        className={styles.stateMessage}
        role={data.state === "unexpected-error" ? "alert" : "status"}
      >
        <h2>
          {data.state === "loading"
            ? "正在加载"
            : data.state === "empty"
              ? "暂无专题"
              : "专题暂时不可用"}
        </h2>
      </section>
    );
  return (
    <div
      ref={root}
      className={styles.homeSurface}
      data-home-platform={shell.platform}
      data-discussion-surface=""
      data-active-discussion-feed={active}
    >
      <header className={styles.homeHeader} data-author-bar="">
        {headerStart ?? <span />}
        <AnimatedTopTabs
          items={feeds.map((id) => ({
            id,
            label: labels[id],
            icon: <DiscussionIcon name={icons[id]} />,
          }))}
          activeKey={active}
          progress={progress}
          onSelect={(id) => pager.current?.scrollToKey(id)}
          ariaLabel="讨论内容范围"
          idPrefix="discussion"
        />
        {headerEnd ?? <span />}
      </header>
      <HorizontalPager
        ref={pager}
        keys={feeds}
        activeKey={active}
        onCommit={commit}
        onProgress={setProgress}
        panels={
          preview
            ? {
                news: <DiscussionPreviewFeed feed="news" />,
                threads: <DiscussionPreviewFeed feed="threads" />,
                topics: <DiscussionPreviewFeed feed="topics" />,
              }
            : {
                // Real published editorial reads (content-community-completion-v1).
                news: <EditorialNewsFeed />,
                threads: liveThreads ? (
                  <ThreadsFeed
                    localRead={localRead}
                    onOpen={(id, opener) => {
                      setLocalRead((old) => new Set(old).add(id));
                      shell.openTopic(id, opener, shell.readActiveScrollTop());
                    }}
                  />
                ) : (
                  <ThreadsUnavailable />
                ),
                topics: (
                  <>
                    <EditorialTopicsFeed />
                    {data.state === "populated" ? topics : null}
                  </>
                ),
              }
        }
        platform={shell.platform}
        visible={shell.activeDestination === "discussion"}
        scrollOwner={shell.platform === "pc" ? "document" : "panel"}
        registerActiveScrollElement={
          shell.registerActiveDiscussionScrollElement
        }
        panelClassName={styles.feedPanel}
        panelId={(id) => `discussion-panel-${id}`}
        panelLabelledBy={(id) => `discussion-tab-${id}`}
        diagnosticPrefix="discussion"
      />
    </div>
  );
}
