"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CatalogDetailScreen } from "./catalog-detail-screen";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import { CatalogDetailWithdrawalContext } from "./catalog-detail-withdrawal";
import { CatalogViewer } from "./catalog-viewer";
import { useAuthReturnView } from "../auth/auth-return";
import styles from "./catalog-detail.module.css";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  UIEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import type { CatalogDetailPresentationState } from "./catalog-detail-presentation";
import type { CatalogDetailWithdrawalNotice } from "./catalog-detail-withdrawal";
import type { PresentationPlatform } from "../shell/device-platform";

export interface CatalogDetailExperienceProps {
  readonly activeViewerMediaId: string | null;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly catalogId: string;
  readonly commentSection?: ReactNode;
  readonly colophon?: ReactNode;
  readonly calligraphy?: boolean;
  readonly positionKey?: string | undefined;
  readonly detailActions?: ReactNode;
  readonly initialScrollTop: number;
  readonly onBack: () => void;
  readonly onCloseViewer: () => void;
  readonly onOpenViewer: (mediaId: string) => void;
  readonly onScrollTopChange: (top: number) => void;
  readonly onViewerMediaChange: (mediaId: string) => void;
  readonly orientation: "landscape" | "portrait";
  readonly platform: PresentationPlatform;
  readonly state: CatalogDetailPresentationState;
}

const SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

// Session-only reading state, scoped by the composition to account and content.
const mediaPositions = new Map<string, number>();

export const CatalogDetailExperience = ({
  activeViewerMediaId,
  backButtonRef,
  catalogId,
  commentSection,
  colophon,
  calligraphy = false,
  positionKey,
  detailActions,
  initialScrollTop,
  onBack,
  onCloseViewer,
  onOpenViewer,
  onScrollTopChange,
  onViewerMediaChange,
  orientation,
  platform,
  state,
}: CatalogDetailExperienceProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const resizeRestoreFrameRef = useRef<number | null>(null);
  const scrollSuppressionFrameRef = useRef<number | null>(null);
  const scrollIntentTimerRef = useRef<number | null>(null);
  const suppressScrollRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const pointerCandidateRef = useRef<{
    readonly id: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const desiredScrollTopRef = useRef(initialScrollTop);
  const restoredCatalogIdRef = useRef(catalogId);
  const viewerOpenerRef = useRef<HTMLElement | null>(null);
  const viewerWasOpenRef = useRef(false);
  const viewerOpenSuppressedUntilRef = useRef(0);
  const mediaIndexRef = useRef(0);
  const mediaScopeRef = useRef(positionKey);
  const returnedMedia = useAuthReturnView(
    `calligraphy-detail-media:${catalogId}`,
    () => ({ index: mediaIndexRef.current }),
  );
  const restoredMediaIndex =
    calligraphy &&
    Number.isSafeInteger(returnedMedia?.index) &&
    returnedMedia!.index >= 0
      ? returnedMedia!.index
      : undefined;
  const [activeMediaIndex, setActiveMediaIndex] = useState(
    () =>
      restoredMediaIndex ??
      (positionKey === undefined ? 0 : (mediaPositions.get(positionKey) ?? 0)),
  );
  mediaIndexRef.current = activeMediaIndex;
  useEffect(() => {
    if (
      !calligraphy ||
      positionKey === undefined ||
      mediaScopeRef.current !== positionKey
    )
      return;
    mediaPositions.delete(positionKey);
    mediaPositions.set(positionKey, activeMediaIndex);
    if (mediaPositions.size > 100)
      mediaPositions.delete(mediaPositions.keys().next().value!);
  }, [activeMediaIndex, calligraphy, positionKey]);
  const [withdrawal, setWithdrawal] = useState<{
    readonly id: string;
    readonly notice: CatalogDetailWithdrawalNotice;
  } | null>(null);
  const withdraw = useCallback(
    (id: string, notice: CatalogDetailWithdrawalNotice) =>
      setWithdrawal({ id, notice }),
    [],
  );
  const withdrawn =
    state.state === "loaded" && withdrawal?.id === state.detail.id
      ? withdrawal.notice
      : null;
  // A withdrawn Detail offers no media: the Viewer closes and nothing plays.
  const media =
    state.state === "loaded" && withdrawn === null ? state.detail.media : [];
  useEffect(() => {
    if (state.state === "loaded")
      setActiveMediaIndex((index) =>
        Math.max(0, Math.min(index, media.length - 1)),
      );
  }, [state.state, media.length]);
  const requestedViewerIndex =
    activeViewerMediaId === null
      ? -1
      : media.findIndex(({ id }) => id === activeViewerMediaId);
  const viewerOpen = activeViewerMediaId !== null && requestedViewerIndex >= 0;

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = false;
    if (scrollIntentTimerRef.current !== null) {
      window.clearTimeout(scrollIntentTimerRef.current);
      scrollIntentTimerRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    // Verified vertical input takes over immediately, including the two frames
    // after a tab restore. Automatic layout clamps still keep the desired top.
    suppressScrollRef.current = false;
    if (scrollSuppressionFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollSuppressionFrameRef.current);
      scrollSuppressionFrameRef.current = null;
    }
    userScrollIntentRef.current = true;
    if (scrollIntentTimerRef.current !== null) {
      window.clearTimeout(scrollIntentTimerRef.current);
    }
    scrollIntentTimerRef.current = window.setTimeout(() => {
      scrollIntentTimerRef.current = null;
      userScrollIntentRef.current = false;
    }, 240);
  }, []);

  const restoreDesiredScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    suppressScrollRef.current = true;
    scroller.scrollTop = Math.max(0, desiredScrollTopRef.current);
    if (scrollSuppressionFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollSuppressionFrameRef.current);
    }
    scrollSuppressionFrameRef.current = window.requestAnimationFrame(() => {
      scrollSuppressionFrameRef.current = window.requestAnimationFrame(() => {
        scrollSuppressionFrameRef.current = null;
        suppressScrollRef.current = false;
      });
    });
  }, []);

  const contentScroll = useMemo(
    () => ({
      read: () => desiredScrollTopRef.current,
      restore: (top: number) => {
        clearUserScrollIntent();
        desiredScrollTopRef.current = Math.max(0, top);
        restoreDesiredScroll();
        onScrollTopChange(desiredScrollTopRef.current);
      },
      collapseTop: (section: HTMLElement) => {
        const scroller = scrollRef.current;
        if (scroller === null) return 0;
        const header = scroller.querySelector("header");
        return Math.max(
          0,
          scroller.scrollTop +
            section.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            (header?.getBoundingClientRect().height ?? 0),
        );
      },
    }),
    [clearUserScrollIntent, onScrollTopChange, restoreDesiredScroll],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    if (restoredCatalogIdRef.current !== catalogId) {
      restoredCatalogIdRef.current = catalogId;
      desiredScrollTopRef.current = initialScrollTop;
    }
    restoreDesiredScroll();
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        restoreDesiredScroll();
      });
    });
    return () => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [
    catalogId,
    initialScrollTop,
    orientation,
    platform,
    restoreDesiredScroll,
    state.state,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      clearUserScrollIntent();
      suppressScrollRef.current = true;
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current);
      }
      resizeRestoreFrameRef.current = window.requestAnimationFrame(() => {
        resizeRestoreFrameRef.current = null;
        restoreDesiredScroll();
      });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current);
        resizeRestoreFrameRef.current = null;
      }
    };
  }, [catalogId, clearUserScrollIntent, restoreDesiredScroll]);

  useEffect(() => {
    mediaScopeRef.current = positionKey;
    setActiveMediaIndex(
      restoredMediaIndex ??
        (calligraphy && positionKey !== undefined
          ? (mediaPositions.get(positionKey) ?? 0)
          : 0),
    );
  }, [catalogId, positionKey, calligraphy, restoredMediaIndex]);

  useEffect(() => {
    setWithdrawal(null);
  }, [catalogId]);

  // The notice replaces the content in place: read from the top, focused.
  useEffect(() => {
    if (withdrawn === null) return;
    const scroller = scrollRef.current;
    if (scroller !== null) {
      desiredScrollTopRef.current = 0;
      scroller.scrollTop = 0;
      onScrollTopChange(0);
    }
    const frame = window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>("[data-detail-withdrawn]")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
    // Only a new notice moves the focus and the scroll.
  }, [withdrawn]);

  useEffect(() => {
    if (activeViewerMediaId === null || state.state === "loading") return;
    if (requestedViewerIndex < 0) {
      onCloseViewer();
      return;
    }
    setActiveMediaIndex(requestedViewerIndex);
  }, [activeViewerMediaId, onCloseViewer, requestedViewerIndex, state.state]);

  useLayoutEffect(() => {
    if (viewerOpen) {
      viewerWasOpenRef.current = true;
      return;
    }
    if (!viewerWasOpenRef.current) return;
    viewerWasOpenRef.current = false;
    viewerOpenSuppressedUntilRef.current = performance.now() + 500;
    restoreDesiredScroll();
    const firstFrame = window.requestAnimationFrame(() => {
      restoreDesiredScroll();
      window.requestAnimationFrame(() => {
        const currentOpener = scrollRef.current?.querySelector<HTMLElement>(
          "[data-detail-main-image], [data-feed-slide][aria-hidden=false] [data-feed-slide-image]",
        );
        const opener = currentOpener ?? viewerOpenerRef.current;
        if (opener?.isConnected === true) opener.focus({ preventScroll: true });
      });
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [restoreDesiredScroll, viewerOpen]);

  useEffect(
    () => () => {
      if (scrollSuppressionFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollSuppressionFrameRef.current);
        scrollSuppressionFrameRef.current = null;
      }
      clearUserScrollIntent();
      onScrollTopChange(desiredScrollTopRef.current);
    },
    [clearUserScrollIntent, onScrollTopChange],
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const top = scroller.scrollTop;
    if (suppressScrollRef.current && top <= desiredScrollTopRef.current) {
      return;
    }
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (!userScrollIntentRef.current && top < desiredScrollTopRef.current) {
      return;
    }
    if (desiredScrollTopRef.current > maximum && Math.abs(top - maximum) <= 1) {
      return;
    }
    desiredScrollTopRef.current = top;
    onScrollTopChange(top);
    if (userScrollIntentRef.current) markUserScrollIntent();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    pointerCandidateRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = pointerCandidateRef.current;
    if (candidate === null || candidate.id !== event.pointerId) return;
    const deltaX = event.clientX - candidate.x;
    const deltaY = event.clientY - candidate.y;
    if (Math.hypot(deltaX, deltaY) < 10) return;
    pointerCandidateRef.current = null;
    if (Math.abs(deltaY) > Math.abs(deltaX) * 1.1) markUserScrollIntent();
  };

  const clearPointerCandidate = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerCandidateRef.current?.id === event.pointerId) {
      pointerCandidateRef.current = null;
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) markUserScrollIntent();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) markUserScrollIntent();
  };

  return (
    <div className={styles.experience} data-detail-experience="">
      <div
        className={styles.detailScroller}
        data-detail-scroll=""
        onKeyDown={handleKeyDown}
        onPointerCancel={clearPointerCandidate}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearPointerCandidate}
        onScroll={handleScroll}
        onWheel={handleWheel}
        ref={scrollRef}
      >
        <CatalogDetailWithdrawalContext.Provider value={withdraw}>
          <CatalogDetailScrollContext.Provider value={contentScroll}>
            <CatalogDetailScreen
              activeMediaIndex={activeMediaIndex}
              backButtonRef={backButtonRef}
              commentSection={commentSection}
              colophon={colophon}
              calligraphy={calligraphy}
              positionKey={positionKey}
              detailActions={detailActions}
              mediaMotionSuspended={viewerOpen}
              onActiveMediaIndexChange={setActiveMediaIndex}
              onBack={onBack}
              onOpenViewer={(index, opener) => {
                const item = media[index];
                if (
                  item === undefined ||
                  performance.now() < viewerOpenSuppressedUntilRef.current
                ) {
                  return;
                }
                const scroller = scrollRef.current;
                if (scroller !== null) {
                  desiredScrollTopRef.current = scroller.scrollTop;
                  onScrollTopChange(scroller.scrollTop);
                }
                viewerOpenerRef.current = opener;
                setActiveMediaIndex(index);
                onOpenViewer(item.id);
              }}
              orientation={orientation}
              platform={platform}
              state={state}
              withdrawn={withdrawn}
            />
          </CatalogDetailScrollContext.Provider>
        </CatalogDetailWithdrawalContext.Provider>
      </div>
      <CatalogViewer
        direction={calligraphy ? "rtl" : "ltr"}
        index={activeMediaIndex}
        media={media}
        onClose={() => {
          viewerOpenSuppressedUntilRef.current = performance.now() + 500;
          onCloseViewer();
        }}
        onIndexChange={(index) => {
          const item = media[index];
          if (item === undefined) return;
          setActiveMediaIndex(index);
          onViewerMediaChange(item.id);
        }}
        open={viewerOpen}
        platform={platform}
      />
    </div>
  );
};
