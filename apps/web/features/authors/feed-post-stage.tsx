"use client";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { CatalogCardLiveBadge, MediaFallback } from "../home/card-media-parts";
import {
  MEDIA_SIZES,
  mediaLoading,
  placeholderStyle,
  responsiveImage,
} from "../media/responsive-media";
import type { MediaPriority } from "../media/responsive-media";
import { QUICK_ACTION_LIKE_PATH } from "../quick-actions/quick-action-card-action";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";
import { FeedPostDots } from "./feed-post-dots";
import {
  FEED_POST_CLICK_SUPPRESSION_MS,
  FEED_POST_DOUBLE_TAP_MS,
  FEED_POST_SETTLE_MS,
  FEED_POST_TAP_TOLERANCE_PX,
  isLegacyRtlScroll,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  stripIndex,
  stripProgress,
  stripRegion,
  stripScrollLeft,
} from "./feed-post-strip-geometry";
import styles from "../home/home-screen.module.css";

export interface FeedPostStageHandle {
  readonly scrollToIndex: (index: number) => void;
  /** Brings the comments region in; false when the post has none. */
  readonly scrollToComments: () => boolean;
}

export interface FeedPostStageProps {
  /** The post's images in order; the first is shown at the right edge. */
  readonly media: readonly DetailMediaPresentation[];
  /** Loading priority of the first image only. */
  readonly priority?: MediaPriority | undefined;
  /** Badges the first image as a Live Photo still. */
  readonly live?: boolean;
  /** Overlay on the stage, such as the province badge. */
  readonly badge?: ReactNode;
  /** The comments region continuing left of the last image, when any. */
  readonly comments?: ReactNode;
  readonly onMediaSettled?: () => void;
  readonly onOpenViewer: (index: number, opener: HTMLElement) => void;
  /** A double tap (or more) on an image: like, never un-like. */
  readonly onDoubleTap: () => void;
  /** Plays the heart burst for a double tap (a reader who can like). */
  readonly burstEnabled: boolean;
  /** The viewer this post opened is showing. */
  readonly viewerOpen: boolean;
  readonly onRegionChange?: (region: "media" | "comments") => void;
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The media stage of a phone single-column post: one right-to-left native
 * scroll-snap strip. The first image sits at the right edge and a rightward
 * swipe brings the next one in from the left; past the last image the strip
 * continues into the comments region. `data-local-horizontal` keeps every
 * swipe that starts here away from the outer Home and profile tab pagers.
 *
 * A single tap opens the viewer (after the double-tap window), a double tap
 * likes. Taps come from `click`, which the browser sends only for a real tap,
 * never for the start or end of a swipe.
 */
export const FeedPostStage = forwardRef<
  FeedPostStageHandle,
  FeedPostStageProps
>(function FeedPostStage(
  {
    media,
    priority,
    live = false,
    badge,
    comments,
    onMediaSettled,
    onOpenViewer,
    onDoubleTap,
    burstEnabled,
    viewerOpen,
    onRegionChange,
  },
  ref,
) {
  const count = media.length;
  const hasComments = comments !== undefined && comments !== null;
  const ratio = resolveStageAspect(media[0]);
  const stripRef = useRef<HTMLDivElement>(null);
  const legacyRef = useRef(false);
  const touchRef = useRef<{ active: boolean; startOffset: number }>({
    active: false,
    startOffset: 0,
  });
  const suppressUntilRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingTapRef = useRef<number | null>(null);
  const lastDoubleTapRef = useRef(Number.NEGATIVE_INFINITY);
  const indexRef = useRef(0);
  const regionRef = useRef<"media" | "comments">("media");
  const [activeIndex, setActiveIndex] = useState(0);
  const [region, setRegion] = useState<"media" | "comments">("media");
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [burst, setBurst] = useState(0);
  const firstImageRef = useRef<HTMLImageElement>(null);

  const cancelPendingTap = () => {
    if (pendingTapRef.current !== null) {
      window.clearTimeout(pendingTapRef.current);
      pendingTapRef.current = null;
    }
  };

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return { offset: 0, width: 0, progress: 0 };
    const offset = readStripOffset(strip, legacyRef.current);
    const width = strip.clientWidth;
    return { offset, width, progress: stripProgress(offset, width) };
  }, []);

  const settle = useCallback(() => {
    settleTimerRef.current = null;
    const current = measure();
    const nextRegion = stripRegion(current.progress, count, hasComments);
    if (nextRegion !== regionRef.current) {
      regionRef.current = nextRegion;
      setRegion(nextRegion);
      onRegionChange?.(nextRegion);
    }
    if (nextRegion === "media") {
      const index = stripIndex(current.progress, count);
      if (index !== indexRef.current) {
        indexRef.current = index;
        setActiveIndex(index);
      }
    }
  }, [count, hasComments, measure, onRegionChange]);

  const scheduleSettle = () => {
    if (settleTimerRef.current !== null)
      window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(settle, FEED_POST_SETTLE_MS);
  };

  const scrollToOffset = (offset: number) => {
    const strip = stripRef.current;
    if (strip === null) return;
    const left = stripScrollLeft(strip, offset, legacyRef.current);
    const behavior = reducedMotion() ? "auto" : "smooth";
    if (typeof strip.scrollTo === "function")
      strip.scrollTo({ left, behavior });
    else strip.scrollLeft = left;
  };

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index) => {
      const strip = stripRef.current;
      if (strip === null) return;
      scrollToOffset(
        Math.min(Math.max(0, index), count - 1) * strip.clientWidth,
      );
    },
    scrollToComments: () => {
      const strip = stripRef.current;
      if (strip === null || !hasComments) return false;
      scrollToOffset(count * strip.clientWidth);
      return true;
    },
  }));

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip !== null) legacyRef.current = isLegacyRtlScroll(strip);
  }, []);

  // A width change (rotation, resize) keeps the shown image in place.
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver !== "function")
      return undefined;
    const observer = new ResizeObserver(() => {
      if (touchRef.current.active) return;
      const target =
        regionRef.current === "comments" ? count : indexRef.current;
      const left = stripScrollLeft(
        strip,
        target * strip.clientWidth,
        legacyRef.current,
      );
      if (Math.abs(strip.scrollLeft - left) > 1) strip.scrollLeft = left;
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [count]);

  useEffect(
    () => () => {
      cancelPendingTap();
      if (settleTimerRef.current !== null)
        window.clearTimeout(settleTimerRef.current);
      if (frameRef.current !== null)
        window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // A first image that failed before hydration never reports its error.
  useEffect(() => {
    const first = firstImageRef.current;
    const id = media[0]?.id;
    if (id === undefined || first?.complete !== true || first.naturalWidth > 0)
      return;
    setFailed((current) => new Set(current).add(id));
    onMediaSettled?.();
  }, [media, onMediaSettled]);

  // Closing the viewer by a tap must not reopen it through the same tap.
  const wasViewerOpen = useRef(viewerOpen);
  useEffect(() => {
    if (viewerOpen) cancelPendingTap();
    else if (wasViewerOpen.current)
      suppressUntilRef.current =
        performance.now() + FEED_POST_CLICK_SUPPRESSION_MS;
    wasViewerOpen.current = viewerOpen;
  }, [viewerOpen]);

  const tap = (index: number, button: HTMLButtonElement, detail: number) => {
    // Keyboard and assistive activation open the viewer at once.
    if (detail === 0) {
      onOpenViewer(index, button);
      return;
    }
    const now = performance.now();
    if (pendingTapRef.current !== null) {
      cancelPendingTap();
      lastDoubleTapRef.current = now;
      onDoubleTap();
      if (burstEnabled) setBurst((value) => value + 1);
      return;
    }
    // Further taps of the same burst are part of the double tap.
    if (now - lastDoubleTapRef.current < FEED_POST_DOUBLE_TAP_MS) {
      lastDoubleTapRef.current = now;
      return;
    }
    pendingTapRef.current = window.setTimeout(() => {
      pendingTapRef.current = null;
      if (button.isConnected) onOpenViewer(index, button);
    }, FEED_POST_DOUBLE_TAP_MS);
  };

  return (
    <>
      <div
        className={styles.postStage}
        data-feed-stage-frame=""
        style={{ "--feed-stage-aspect": `1 / ${ratio}` } as CSSProperties}
      >
        <div
          ref={stripRef}
          aria-label="作品图像"
          aria-roledescription="carousel"
          className={styles.postStrip}
          data-feed-stage=""
          data-feed-stage-count={count}
          data-feed-stage-index={activeIndex}
          data-feed-stage-region={region}
          data-local-horizontal=""
          onClickCapture={(event) => {
            if (
              event.detail !== 0 &&
              performance.now() < suppressUntilRef.current
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onScroll={() => {
            const current = measure();
            if (
              touchRef.current.active &&
              Math.abs(current.offset - touchRef.current.startOffset) >=
                FEED_POST_TAP_TOLERANCE_PX
            ) {
              suppressUntilRef.current =
                performance.now() + FEED_POST_CLICK_SUPPRESSION_MS;
              cancelPendingTap();
            }
            if (frameRef.current === null)
              frameRef.current = window.requestAnimationFrame(() => {
                frameRef.current = null;
                setProgress(measure().progress);
              });
            if (!touchRef.current.active) scheduleSettle();
          }}
          onTouchCancelCapture={() => {
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchEndCapture={() => {
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchStartCapture={(event) => {
            if (event.touches.length !== 1) return;
            touchRef.current = {
              active: true,
              startOffset: measure().offset,
            };
            if (settleTimerRef.current !== null) {
              window.clearTimeout(settleTimerRef.current);
              settleTimerRef.current = null;
            }
          }}
          role="group"
        >
          <div
            className={styles.postStripPart}
            data-feed-stage-media=""
            inert={region === "comments" || undefined}
          >
            {media.map((item, index) => {
              const active = index === activeIndex;
              const broken = failed.has(item.id);
              const image = responsiveImage(item, MEDIA_SIZES.feedPostStage());
              return (
                <div
                  aria-hidden={!active}
                  aria-label={`第 ${index + 1} 张，共 ${count} 张`}
                  aria-roledescription="slide"
                  className={styles.postSlide}
                  data-feed-slide={index}
                  data-fit={slideFit(item, ratio)}
                  data-media-id={item.id}
                  inert={!active || undefined}
                  key={item.id}
                  role="group"
                >
                  {broken ? (
                    <MediaFallback
                      label={`图像无法加载：${item.alt}`}
                      state="failed"
                    />
                  ) : (
                    <button
                      aria-label={`查看图像：${item.alt}`}
                      className={styles.postSlideButton}
                      data-feed-slide-image=""
                      onClick={(event) =>
                        tap(index, event.currentTarget, event.detail)
                      }
                      tabIndex={active ? 0 : -1}
                      type="button"
                    >
                      <img
                        ref={index === 0 ? firstImageRef : undefined}
                        alt={item.alt}
                        decoding="async"
                        draggable={false}
                        height={item.height}
                        {...(index === 0
                          ? mediaLoading(priority)
                          : { loading: "lazy" as const })}
                        onError={() => {
                          setFailed((current) => new Set(current).add(item.id));
                          if (index === 0) onMediaSettled?.();
                        }}
                        onLoad={index === 0 ? onMediaSettled : undefined}
                        sizes={image.sizes}
                        src={image.src}
                        srcSet={image.srcSet}
                        style={
                          slideFit(item, ratio) === "cover"
                            ? placeholderStyle(item.placeholderColor)
                            : undefined
                        }
                        width={item.width}
                      />
                    </button>
                  )}
                  {index === 0 && live && !broken ? (
                    <CatalogCardLiveBadge />
                  ) : null}
                </div>
              );
            })}
          </div>
          {hasComments ? (
            <div
              className={styles.postStripPart}
              data-feed-stage-comments=""
              inert={region === "media" || undefined}
            >
              {comments}
            </div>
          ) : null}
        </div>
        {region === "comments" ? null : badge}
        {burst > 0 ? (
          <span
            aria-hidden="true"
            className={styles.postBurst}
            data-feed-post-burst=""
            key={burst}
            onAnimationEnd={() => setBurst(0)}
          >
            <svg viewBox="0 0 24 24">
              <path d={QUICK_ACTION_LIKE_PATH} />
            </svg>
          </span>
        ) : null}
      </div>
      <FeedPostDots
        activeIndex={activeIndex}
        alts={media.map((item) => item.alt)}
        hasComments={hasComments}
        onSelect={(index) => {
          const strip = stripRef.current;
          if (strip !== null) scrollToOffset(index * strip.clientWidth);
        }}
        onSelectComments={() => {
          const strip = stripRef.current;
          if (strip !== null) scrollToOffset(count * strip.clientWidth);
        }}
        progress={progress}
        region={region}
      />
    </>
  );
});
