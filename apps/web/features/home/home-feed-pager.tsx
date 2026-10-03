"use client";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { HorizontalPager } from "../shell/horizontal-pager";
import { homeFeeds } from "./home-feed";
import styles from "./home-screen.module.css";
import type { ReactNode } from "react";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import type { PresentationPlatform } from "../shell/device-platform";
import type { HomeFeed } from "./home-feed";

export interface HomeFeedPagerHandle {
  readonly scrollToFeed: (feed: HomeFeed) => void;
}

const withFilingFooter = (content: ReactNode) => (
  <>
    {content}
    <footer className={styles.filingFooter}>
      <a
        href="https://beian.miit.gov.cn"
        target="_blank"
        rel="noopener noreferrer"
      >
        豫ICP备2026047894号-1
      </a>
    </footer>
  </>
);

export interface HomeFeedPagerProps {
  readonly activeFeed: HomeFeed;
  readonly onCommit: (feed: HomeFeed) => void;
  readonly onProgress?: (progress: number) => void;
  readonly primaryVisible?: boolean;
  readonly registerActiveScrollElement?: (element: HTMLElement) => () => void;
  readonly panels: Readonly<Record<HomeFeed, ReactNode>>;
  readonly platform: PresentationPlatform;
}
export const HomeFeedPager = forwardRef<
  HomeFeedPagerHandle,
  HomeFeedPagerProps
>(function HomeFeedPager(
  {
    activeFeed,
    primaryVisible = true,
    platform,
    onProgress,
    registerActiveScrollElement,
    ...props
  },
  ref,
) {
  const pagerRef = useRef<HorizontalPagerHandle<HomeFeed>>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToFeed: (feed) => pagerRef.current?.scrollToKey(feed),
    }),
    [],
  );
  return (
    <HorizontalPager
      {...props}
      panels={{
        discover: withFilingFooter(props.panels.discover),
        nearby: withFilingFooter(props.panels.nearby),
        inscriptions: withFilingFooter(props.panels.inscriptions),
        calligraphy: withFilingFooter(props.panels.calligraphy),
      }}
      activeKey={activeFeed}
      keys={homeFeeds}
      platform={platform}
      scrollOwner={platform === "pc" ? "document" : "panel"}
      visible={primaryVisible}
      ref={pagerRef}
      diagnosticPrefix="home"
      panelClassName={styles.feedPanel}
      frameAttributes={{
        "data-home-feed-pager": "",
        "data-home-pager-native": "",
        "data-home-pager-platform": platform,
      }}
      trackAttributes={{ "data-home-feed-track": "" }}
      panelAttributes={(feed) => ({
        "data-home-feed-panel": feed,
        "data-home-feed-scroll-surface": platform === "pc" ? undefined : "",
      })}
      panelId={(feed) => `home-panel-${feed}`}
      panelLabelledBy={(feed) => `home-tab-${feed}`}
      {...(onProgress === undefined ? {} : { onProgress })}
      {...(registerActiveScrollElement === undefined
        ? {}
        : { registerActiveScrollElement })}
    />
  );
});
