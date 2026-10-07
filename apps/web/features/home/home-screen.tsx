"use client";

import { useAuthReturnView } from "../auth/auth-return";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { CatalogCard } from "./catalog-card";
import { CatalogMasonry } from "./catalog-masonry";
import { HomeContentCard } from "./home-content-card";
import { HomeFeedPager } from "./home-feed-pager";
import { homeFeeds, parseHomeFeed } from "./home-feed";
import styles from "./home-screen.module.css";
import { listMediaPriority } from "../media/responsive-media";
import { useProductShell } from "../product-shell/product-shell";
import { AnimatedCategoryIcon } from "@moya/ui";
import { AnimatedTopTabs } from "../shell/animated-top-tabs";

import type { ReactNode } from "react";
import type { CatalogSummary } from "@moya/contracts";
import type { HomeFeedPagerHandle } from "./home-feed-pager";
import type {
  HomeFeed,
  HomeFeedState,
  HomeSurfaceData,
  NearbyCard,
} from "./home-feed";

const feedLabels = {
  discover: "发现",
  nearby: "附近",
  inscriptions: "碑刻",
  calligraphy: "书帖",
} as const satisfies Record<HomeFeed, string>;

const homeTabItems = homeFeeds.map((id) => ({
  id,
  label: feedLabels[id],
  ...(id === "discover" ? {} : { icon: <AnimatedCategoryIcon name={id} /> }),
}));

interface HomeTabMotion {
  readonly setProgress: (progress: number) => void;
}

// Pager frames update only the header. Populated Home feeds must not rerender
// or remeasure their masonry for every fractional position of a swipe.
const HomeTabs = forwardRef<
  HomeTabMotion,
  {
    activeFeed: HomeFeed;
    onSelect: (feed: HomeFeed) => void;
  }
>(function HomeTabs({ activeFeed, onSelect }, ref) {
  const [progress, setProgress] = useState(homeFeeds.indexOf(activeFeed));
  useImperativeHandle(ref, () => ({ setProgress }), []);
  return (
    <AnimatedTopTabs
      items={homeTabItems}
      activeKey={activeFeed}
      progress={progress}
      onSelect={onSelect}
      ariaLabel="首页内容范围"
      idPrefix="home"
    />
  );
});

const feedMessages = {
  discover: {
    empty: ["暂无公开档案", "当前没有可展示的公开内容。"],
    unavailable: ["档案服务暂时不可用", "请稍后再试。"],
    unexpectedError: ["无法加载公开档案", "发生了未预期的错误。"],
  },
  nearby: {
    empty: ["附近暂无内容", "当前没有可展示的附近内容。"],
    unavailable: ["附近内容尚未接入", "真实位置服务尚未提供。"],
    unexpectedError: ["无法加载附近内容", "发生了未预期的错误。"],
  },
  topics: {
    empty: ["暂无专题", "当前没有可展示的专题。"],
    unavailable: ["专题内容尚未接入", "真实策展内容服务尚未提供。"],
    unexpectedError: ["无法加载专题", "发生了未预期的错误。"],
  },
} as const;

const FeedMessage = ({
  feed,
  state,
}: {
  readonly feed: "discover" | "nearby" | "topics";
  readonly state: "empty" | "loading" | "unavailable" | "unexpected-error";
}) => {
  if (state === "loading") {
    return (
      <section
        className={styles.stateMessage}
        data-home-feed-state="loading"
        role="status"
      >
        <span className={styles.stateMark} aria-hidden="true">
          ···
        </span>
        <h2>正在加载</h2>
      </section>
    );
  }
  const copy = feedMessages[feed];
  const [title, description] =
    state === "unexpected-error" ? copy.unexpectedError : copy[state];
  return (
    <section
      className={styles.stateMessage}
      data-home-feed-state={state}
      role={state === "unexpected-error" ? "alert" : "status"}
    >
      <span className={styles.stateMark} aria-hidden="true">
        {state === "empty" ? "空" : "!"}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  );
};

const renderFeedState = <T,>(
  feed: "discover" | "nearby" | "topics",
  state: HomeFeedState<T>,
  populated: (items: readonly T[]) => ReactNode,
) => {
  if (state.state === "populated") return populated(state.items);
  return <FeedMessage feed={feed} state={state.state} />;
};

export interface HomeScreenProps {
  readonly renderDiscover?: (active: boolean) => ReactNode;
  readonly headerStart?: ReactNode;
  readonly headerEnd?: ReactNode;
  readonly data: HomeSurfaceData;
  readonly initialFeed?: HomeFeed;
  readonly onFeedChange?: (feed: HomeFeed) => void;
  readonly renderInscriptions?: (active: boolean) => ReactNode;
  readonly calligraphy?: ReactNode;
}

export const HomeScreen = ({
  renderDiscover,
  headerStart,
  headerEnd,
  data,
  initialFeed = "discover",
  onFeedChange,
  renderInscriptions,
  calligraphy,
}: HomeScreenProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const pagerRef = useRef<HomeFeedPagerHandle>(null);
  const tabMotion = useRef<HomeTabMotion>(null);
  const updateTabProgress = useCallback((progress: number) => {
    tabMotion.current?.setProgress(progress);
  }, []);
  const activeFeedRef = useRef<HomeFeed>(parseHomeFeed(initialFeed));
  const scrollPositionsRef = useRef<Record<HomeFeed, number>>({
    discover: 0,
    nearby: 0,
    inscriptions: 0,
    calligraphy: 0,
  });
  const {
    activeDestination,
    feedLayout,
    openCatalog,
    platform,
    readActiveScrollTop,
    registerActiveHomeScrollElement,
    restoreActiveScrollTop,
  } = useProductShell();
  const authReturnView = useAuthReturnView("home", () => ({
    feed: activeFeedRef.current,
    positions: {
      ...scrollPositionsRef.current,
      [activeFeedRef.current]: readActiveScrollTop(),
    },
  }));
  const [activeFeed, setActiveFeed] = useState<HomeFeed>(
    () => authReturnView?.feed ?? parseHomeFeed(initialFeed),
  );
  const restoredHome = useRef(false);
  useEffect(() => {
    if (!authReturnView || restoredHome.current) return;
    restoredHome.current = true;
    scrollPositionsRef.current = authReturnView.positions;
    pagerRef.current?.scrollToFeed(authReturnView.feed);
    restoreActiveScrollTop(authReturnView.positions[authReturnView.feed]);
  }, [authReturnView, restoreActiveScrollTop]);
  activeFeedRef.current = activeFeed;
  useEffect(() => onFeedChange?.(activeFeed), [activeFeed, onFeedChange]);

  const commitFeed = useCallback(
    (feed: HomeFeed) => {
      if (feed === activeFeed) return;
      if (platform === "pc") {
        scrollPositionsRef.current[activeFeed] = readActiveScrollTop();
      }
      setActiveFeed(feed);
      if (platform === "pc") {
        restoreActiveScrollTop(scrollPositionsRef.current[feed]);
      }
    },
    [activeFeed, platform, readActiveScrollTop, restoreActiveScrollTop],
  );

  const panels = {
    discover:
      renderDiscover?.(
        activeFeed === "discover" && activeDestination === "home",
      ) ??
      renderFeedState(
        "discover",
        data.discover,
        (items: readonly CatalogSummary[]) => (
          <CatalogMasonry
            feedLayout={feedLayout}
            getKey={(item) => item.id}
            spanAtAlignedRows
            items={items}
            platform={platform}
            renderItem={(item, onMediaSettled, index) => (
              <CatalogCard
                item={item}
                onMediaSettled={onMediaSettled}
                onOpenCatalog={(catalog, opener) =>
                  openCatalog(catalog.id, opener)
                }
                priority={
                  activeFeed === "discover" && activeDestination === "home"
                    ? listMediaPriority(index)
                    : undefined
                }
                variant="feed"
              />
            )}
          />
        ),
      ),
    nearby: renderFeedState(
      "nearby",
      data.nearby,
      (items: readonly NearbyCard[]) => (
        <CatalogMasonry
          feedLayout={feedLayout}
          getKey={(item) => item.id}
          spanAtAlignedRows
          items={items}
          platform={platform}
          renderItem={(item, onMediaSettled) => (
            <HomeContentCard item={item} onMediaSettled={onMediaSettled} />
          )}
        />
      ),
    ),
    inscriptions: renderInscriptions?.(
      activeFeed === "inscriptions" && activeDestination === "home",
    ) ?? <FeedMessage feed="discover" state="empty" />,
    calligraphy: calligraphy ?? <FeedMessage feed="discover" state="empty" />,
  } satisfies Readonly<Record<HomeFeed, ReactNode>>;

  return (
    <div
      ref={rootRef}
      className={styles.homeSurface}
      data-active-home-feed={activeFeed}
      data-home-platform={platform}
      data-home-surface=""
      tabIndex={-1}
    >
      <header
        className={styles.homeHeader}
        data-author-bar={headerEnd ? "" : undefined}
      >
        {headerStart}
        <HomeTabs
          ref={tabMotion}
          activeFeed={activeFeed}
          onSelect={(feed) => pagerRef.current?.scrollToFeed(feed)}
        />
        {headerEnd ?? (
          <span aria-hidden="true" className={styles.settingsClearance} />
        )}
      </header>
      <HomeFeedPager
        ref={pagerRef}
        activeFeed={activeFeed}
        onCommit={commitFeed}
        onProgress={updateTabProgress}
        panels={panels}
        platform={platform}
        primaryVisible={activeDestination === "home"}
        registerActiveScrollElement={registerActiveHomeScrollElement}
      />
    </div>
  );
};
