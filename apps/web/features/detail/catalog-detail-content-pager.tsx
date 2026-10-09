"use client";

import { useAuthReturnView } from "../auth/auth-return";

import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  CommentComposerPortalProvider,
  CommentLocationRevealContext,
} from "../comments/comment-composer-portal";
import {
  CommentCountLabel,
  CommentCountProvider,
} from "../comments/comment-count";
import { HorizontalPager } from "../shell/horizontal-pager";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import {
  clearDetailCommentsRequest,
  detailCommentsRequested,
} from "./detail-comments-request";
import styles from "./catalog-detail.module.css";

import type { ReactNode } from "react";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import type { PresentationPlatform } from "../shell/device-platform";

const detailContentPages = ["information", "comments"] as const;
type DetailContentPage = (typeof detailContentPages)[number];

export interface CatalogDetailContentPagerProps {
  readonly comments: ReactNode;
  readonly information: ReactNode;
  readonly platform: Exclude<PresentationPlatform, "pc">;
  /** The content shown; a feed post's comment entry may ask for comments. */
  readonly detailId?: string;
}

const ScopedCatalogDetailContentPager = ({
  comments,
  information,
  platform,
  detailId,
}: CatalogDetailContentPagerProps) => {
  const currentPage = useRef<DetailContentPage>("information");
  const capturedScroll = useContext(CatalogDetailScrollContext);
  const scrollRef = useRef(capturedScroll);
  scrollRef.current = capturedScroll;
  const authReturnView = useAuthReturnView("detail-pager", () => ({
    page: currentPage.current,
    top: scrollRef.current?.read() ?? 0,
  }));
  const [initialPage] = useState<DetailContentPage>(
    () =>
      authReturnView?.page ??
      (detailId !== undefined && detailCommentsRequested(detailId)
        ? "comments"
        : "information"),
  );
  const [activePage, setActivePage] = useState<DetailContentPage>(initialPage);
  currentPage.current = activePage;
  const [composerPortalTarget, setComposerPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const pagerRef = useRef<HorizontalPagerHandle<DetailContentPage>>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const scroll = useContext(CatalogDetailScrollContext);
  const positions = useRef<Partial<Record<DetailContentPage, number>>>({});
  const committedPage = useRef<DetailContentPage>(initialPage);
  const pendingTop = useRef<number | null>(null);
  const previousCollapse = useRef<number | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!authReturnView) return;
    pagerRef.current?.scrollToKey(authReturnView.page);
    scroll?.restore(authReturnView.top);
  }, [authReturnView, scroll]);
  // A comments request opens on comments once; any Detail consumes it.
  useLayoutEffect(() => {
    if (!authReturnView && initialPage === "comments")
      pagerRef.current?.scrollToKey("comments");
    // Mount only: the initial page is fixed for this Detail.
  }, []);
  useEffect(() => clearDetailCommentsRequest(), []);
  const selectPage = (page: DetailContentPage) => {
    pagerRef.current?.scrollToKey(page);
  };
  const commitPage = (page: DetailContentPage) => {
    if (page === committedPage.current) return;
    if (scroll !== null) {
      // The scroll owner retains the desired position through the pager's
      // temporary height clamp. Preserve shared expansion, then page offsets.
      const top = scroll.read();
      const collapse = sectionRef.current
        ? scroll.collapseTop(sectionRef.current)
        : 0;
      positions.current[committedPage.current] = top;
      pendingTop.current =
        top < collapse - 1
          ? top
          : Math.max(collapse, positions.current[page] ?? 0);
    }
    committedPage.current = page;
    setActivePage(page);
  };
  useLayoutEffect(() => {
    if (pendingTop.current === null) return;
    scroll?.restore(pendingTop.current);
    pendingTop.current = null;
  }, [activePage, scroll]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || !scroll) return;
    const measure = () => {
      const collapse = scroll.collapseTop(section);
      const previous = previousCollapse.current;
      previousCollapse.current = collapse;
      if (previous === null || Math.abs(collapse - previous) < 0.5) return;
      const delta = collapse - previous;
      for (const page of detailContentPages) {
        const saved = positions.current[page];
        if (saved !== undefined && saved >= previous - 1)
          positions.current[page] = Math.max(collapse, saved + delta);
      }
      const top = scroll.read();
      if (top >= previous - 1) scroll.restore(Math.max(collapse, top + delta));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    // Media and actions precede the tabs; their size can change the threshold
    // without resizing the section itself (rotation, counters or live media).
    const layout = section.parentElement;
    if (layout) {
      observer.observe(layout);
      for (const sibling of layout.children) observer.observe(sibling);
    }
    const scroller = section.closest("[data-detail-scroll]");
    if (scroller) {
      observer.observe(scroller);
      const header = scroller.querySelector("header");
      if (header) observer.observe(header);
    }
    return () => observer.disconnect();
  }, [scroll]);

  return (
    <section
      ref={sectionRef}
      className={styles.contentPager}
      data-detail-content-active-page={activePage}
      data-detail-content-pager=""
    >
      <div
        aria-label="详情内容"
        className={styles.contentPagerTabs}
        role="tablist"
      >
        <button
          aria-controls={`${id}-information-panel`}
          aria-selected={activePage === "information"}
          id={`${id}-information-tab`}
          onClick={() => selectPage("information")}
          role="tab"
          type="button"
        >
          资料
        </button>
        <button
          aria-controls={`${id}-comments-panel`}
          aria-selected={activePage === "comments"}
          id={`${id}-comments-tab`}
          onClick={() => selectPage("comments")}
          role="tab"
          type="button"
        >
          <CommentCountLabel />
        </button>
      </div>
      <HorizontalPager
        ref={pagerRef}
        activeKey={activePage}
        diagnosticPrefix="detail-content"
        frameAttributes={{ "data-detail-content-frame": "" }}
        frameClassName={styles.contentPagerFrame}
        keys={detailContentPages}
        onCommit={commitPage}
        panelAttributes={(page, selected) => ({
          "data-active": String(selected),
          "data-detail-content-panel": page,
        })}
        panelClassName={styles.contentPagerPanel}
        panelId={(page) => `${id}-${page}-panel`}
        panelLabelledBy={(page) => `${id}-${page}-tab`}
        panels={{
          comments: (
            <CommentLocationRevealContext.Provider
              value={{
                active: activePage === "comments",
                reveal: () => selectPage("comments"),
              }}
            >
              <CommentComposerPortalProvider target={composerPortalTarget}>
                {comments}
              </CommentComposerPortalProvider>
            </CommentLocationRevealContext.Provider>
          ),
          information,
        }}
        platform={platform}
        scrollOwner="document"
        trackAttributes={{ "data-detail-content-track": "" }}
        trackClassName={styles.contentPagerTrack}
      />
      <div
        data-active={String(activePage === "comments")}
        data-comment-composer-outlet=""
        ref={setComposerPortalTarget}
      />
    </section>
  );
};

export const CatalogDetailContentPager = (
  props: CatalogDetailContentPagerProps,
) => (
  <CommentCountProvider>
    <ScopedCatalogDetailContentPager {...props} />
  </CommentCountProvider>
);
