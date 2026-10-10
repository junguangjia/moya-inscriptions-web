"use client";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
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
import { FeedStageContext } from "./feed-post-stage-context";
import type { FeedStageApi, FeedStageSettle } from "./feed-post-stage-context";
import {
  commentsStartOffset,
  elementStartOffset,
  FEED_POST_CARRY_WATCH_MS,
  FEED_POST_CLICK_SUPPRESSION_MS,
  FEED_POST_DOUBLE_TAP_MS,
  FEED_POST_INPUT_DIRECTION_MS,
  FEED_POST_SETTLE_MS,
  FEED_POST_TAP_TOLERANCE_PX,
  isCarriedStep,
  isLegacyRtlScroll,
  nextSnapOffset,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  stripIndex,
  stripProgress,
  stripRegion,
  stripScrollLeft,
} from "./feed-post-strip-geometry";
import styles from "../home/home-screen.module.css";

/** A comment row the comments region renders (a root or a reply). */
const COMMENT_ROW = "[data-colophon-anchor]";

/**
 * Whether a mutation batch committed comment rows: a fetched page or replies.
 * An expanded fold or a selected comment's actions also widen the region,
 * but come from the reader's own tap, not a commit racing a scroll.
 */
const committedRows = (records: readonly MutationRecord[]): boolean =>
  records.some((record) =>
    [...record.addedNodes].some(
      (node) =>
        node instanceof Element &&
        (node.matches(COMMENT_ROW) || node.querySelector(COMMENT_ROW) !== null),
    ),
  );

export interface FeedPostStageHandle {
  readonly scrollToIndex: (index: number) => void;
  /** Brings the comments region in; false when the post has none. */
  readonly scrollToComments: () => boolean;
  /** Brings one comment in by its anchor id; false when it is not rendered. */
  readonly scrollToComment: (id: string) => boolean;
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

/**
 * Events from a portal rendered inside the strip (the colophon composer)
 * bubble through it in React; only the strip's own DOM counts here.
 */
const fromStrip = (event: { currentTarget: Element; target: EventTarget }) =>
  event.currentTarget.contains(event.target as Node);

/** Keys that scroll the strip when focus is inside it. */
const SCROLL_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** The way a scroll key moves the strip: +1 towards its end, -1 back. */
const KEY_DIRECTION: Readonly<Record<string, number>> = {
  ArrowLeft: 1,
  ArrowRight: -1,
  End: 1,
  Home: -1,
};

/** Every snap position in the strip, as offsets from its start. */
const snapOffsets = (strip: HTMLElement, offset: number): number[] => {
  const right = strip.getBoundingClientRect().right;
  const offsets: number[] = [];
  for (const element of strip.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    if (style.scrollSnapAlign === "" || style.scrollSnapAlign === "none")
      continue;
    const gutter = Number.parseFloat(style.scrollMarginRight) || 0;
    offsets.push(
      Math.max(
        0,
        elementStartOffset(
          right,
          element.getBoundingClientRect().right,
          offset,
        ) - gutter,
      ),
    );
  }
  return offsets;
};

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
  const stripRef = useRef<HTMLDivElement | null>(null);
  // State as well as a ref: the comments region binds observers to the strip.
  const [stripNode, setStripNode] = useState<HTMLDivElement | null>(null);
  const bindStrip = useCallback((element: HTMLDivElement | null) => {
    stripRef.current = element;
    setStripNode(element);
  }, []);
  const anchorRef = useRef<(() => number | null) | null>(null);
  // Where a smooth programmatic scroll is heading, until the strip settles.
  const aimRef = useRef<number | null>(null);
  const settleListenersRef = useRef(
    new Set<(settle: FeedStageSettle) => void>(),
  );
  // The pending settle follows a resize re-pin, not the reader's scroll.
  const resizedRef = useRef(false);
  // The comments region grew while nothing of ours scrolled: a scroll that
  // was already running (a wheel, a key, assistive or a script's scroll) is
  // watched for being carried on by the added width.
  const growthRef = useRef<{
    added: number;
    origin: number;
    last: number;
    step: number;
    until: number;
  } | null>(null);
  const stripWidthRef = useRef(0);
  // Which way the reader's own input last moved the strip (+1 towards its
  // end, -1 back), and when: a carry is never undone against it.
  const inputDirectionRef = useRef({ direction: 0, at: 0 });
  const noteInputDirection = (direction: number) => {
    if (direction !== 0)
      inputDirectionRef.current = { direction, at: performance.now() };
  };
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
    aimRef.current = null;
    const resized = resizedRef.current;
    resizedRef.current = false;
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
    for (const listener of [...settleListenersRef.current])
      listener({ resized });
  }, [count, hasComments, measure, onRegionChange]);
  const settleRef = useRef(settle);
  settleRef.current = settle;

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current !== null)
      window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(
      () => settleRef.current(),
      FEED_POST_SETTLE_MS,
    );
  }, []);

  const scrollToOffset = useCallback(
    (offset: number, requested: ScrollBehavior = "smooth") => {
      const strip = stripRef.current;
      if (strip === null) return;
      const left = stripScrollLeft(strip, offset, legacyRef.current);
      if (requested === "instant" || typeof strip.scrollTo !== "function") {
        aimRef.current = null;
        strip.scrollLeft = left;
        // A position written here is never taken for a carried scroll.
        if (growthRef.current !== null) growthRef.current.last = offset;
        return;
      }
      const behavior = reducedMotion() ? "auto" : requested;
      aimRef.current = behavior === "smooth" ? offset : null;
      strip.scrollTo({ left, behavior });
      // A scroll that goes nowhere sends no scroll event: settle anyway, so
      // nothing waits on it.
      scheduleSettle();
    },
    [scheduleSettle],
  );

  const scrollToElement = useCallback(
    (element: Element, behavior?: ScrollBehavior) => {
      const strip = stripRef.current;
      if (strip === null) return;
      // Its snap gutter too, so the scroll ends on its snap position rather
      // than one the snapping might trade for a neighbour's.
      const gutter =
        Number.parseFloat(getComputedStyle(element).scrollMarginRight) || 0;
      const offset = elementStartOffset(
        strip.getBoundingClientRect().right,
        element.getBoundingClientRect().right,
        readStripOffset(strip, legacyRef.current),
      );
      scrollToOffset(Math.max(0, offset - gutter), behavior);
    },
    [scrollToOffset],
  );

  // WebKit keeps a running smooth scroll measured from the strip's left
  // edge: when rows are committed in the frame or two before such a scroll
  // reports itself, the region's instant restore does not stop it, and a
  // frame later it jumps on by the added width. That jump is undone where
  // the scroll really is, and the scroll goes on to the snap position it
  // was heading for.
  const watchCarry = (offset: number) => {
    const growth = growthRef.current;
    const strip = stripRef.current;
    if (growth === null || strip === null) return;
    if (
      touchRef.current.active ||
      aimRef.current !== null ||
      resizedRef.current ||
      performance.now() > growth.until
    ) {
      growthRef.current = null;
      return;
    }
    const step = offset - growth.last;
    const input = inputDirectionRef.current;
    const direction =
      performance.now() - input.at <= FEED_POST_INPUT_DIRECTION_MS
        ? input.direction
        : 0;
    if (!isCarriedStep(step, growth.step, growth.added, direction)) {
      growth.last = offset;
      growth.step = step;
      return;
    }
    growthRef.current = null;
    const actual = offset - growth.added;
    const target = nextSnapOffset(
      snapOffsets(strip, offset),
      actual,
      Math.sign(actual - growth.origin),
    );
    strip.scrollLeft = stripScrollLeft(strip, actual, legacyRef.current);
    scrollToOffset(target);
  };

  const stage = useMemo<FeedStageApi>(
    () => ({
      strip: stripNode,
      count,
      region,
      readOffset: () => measure().offset,
      scrollToOffset,
      scrollToElement,
      setCommentsAnchor: (get) => {
        anchorRef.current = get;
      },
      subscribeSettle: (listener) => {
        settleListenersRef.current.add(listener);
        return () => {
          settleListenersRef.current.delete(listener);
        };
      },
      isSettled: () =>
        !touchRef.current.active &&
        settleTimerRef.current === null &&
        aimRef.current === null,
      viewerOpen,
    }),
    [
      stripNode,
      count,
      region,
      measure,
      scrollToOffset,
      scrollToElement,
      viewerOpen,
    ],
  );

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
      scrollToOffset(commentsStartOffset(count, strip.clientWidth));
      return true;
    },
    scrollToComment: (id) => {
      const anchor = [
        ...(stripRef.current?.querySelectorAll<HTMLElement>(COMMENT_ROW) ?? []),
      ].find((element) => element.dataset.colophonAnchor === id);
      if (anchor === undefined) return false;
      scrollToElement(anchor);
      return true;
    },
  }));

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip !== null) legacyRef.current = isLegacyRtlScroll(strip);
  }, []);

  // A width change (rotation, resize) keeps the shown image in place, and
  // in the comments region the comment being read (its registered anchor).
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver !== "function")
      return undefined;
    const observer = new ResizeObserver(() => {
      if (touchRef.current.active) return;
      const width = strip.clientWidth;
      const anchored =
        regionRef.current === "comments" ? anchorRef.current?.() : null;
      const offset =
        typeof anchored === "number" && Number.isFinite(anchored)
          ? Math.max(0, anchored)
          : regionRef.current === "comments"
            ? commentsStartOffset(count, width)
            : indexRef.current * width;
      const left = stripScrollLeft(strip, offset, legacyRef.current);
      if (Math.abs(strip.scrollLeft - left) > 1) {
        // Its settle must not move the reading position it restored.
        resizedRef.current = true;
        strip.scrollLeft = left;
      }
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [count]);

  // Comments that grow while a smooth scroll runs (the first page arriving
  // as the seal or the comment button scrolls there) extend the strip on its
  // left; browsers keep animating towards the old left-based position, which
  // would land far into the comments. Re-aim at the same offset instead.
  useEffect(() => {
    const part = stripNode?.querySelector("[data-feed-stage-comments]");
    if (
      part === null ||
      part === undefined ||
      typeof ResizeObserver !== "function"
    )
      return undefined;
    const observer = new ResizeObserver(() => {
      const aim = aimRef.current;
      const strip = stripRef.current;
      if (aim === null || strip === null || touchRef.current.active) return;
      // Stop the running animation where it is, then aim again.
      const offset = readStripOffset(strip, legacyRef.current);
      strip.scrollLeft = stripScrollLeft(strip, offset, legacyRef.current);
      scrollToOffset(aim);
    });
    const observeChildren = () => {
      observer.disconnect();
      for (const child of part.children) observer.observe(child);
    };
    observeChildren();
    const children = new MutationObserver(observeChildren);
    children.observe(part, { childList: true });
    return () => {
      children.disconnect();
      observer.disconnect();
    };
  }, [hasComments, scrollToOffset, stripNode]);

  // Rows the comments region commits while nothing of ours scrolls grow the
  // strip on its left, and the region restores the reading position as it
  // commits. A scroll it could not see coming (a wheel or a key in the same
  // frame, assistive or a script's scroll) may still carry the view on by
  // the added width a frame or two later: it is watched from the commit on
  // (a mutation is reported before the next frame's scroll events).
  useEffect(() => {
    const part = stripNode?.querySelector("[data-feed-stage-comments]");
    const strip = stripRef.current;
    if (
      part === null ||
      part === undefined ||
      strip === null ||
      typeof MutationObserver !== "function"
    )
      return undefined;
    stripWidthRef.current = strip.scrollWidth;
    const observer = new MutationObserver((records) => {
      const width = strip.scrollWidth;
      const added = width - stripWidthRef.current;
      stripWidthRef.current = width;
      if (added <= 0 || touchRef.current.active || aimRef.current !== null)
        return;
      // Only committed rows arm the watch: a key or a wheel step right after
      // 全文 or a selection could match their growth, and be undone.
      if (!committedRows(records)) {
        growthRef.current = null;
        return;
      }
      const offset = readStripOffset(strip, legacyRef.current);
      const now = performance.now();
      const pending = growthRef.current;
      // Commits within one frame add up until the scroll reports.
      const unreported =
        pending !== null && pending.last === offset && now <= pending.until;
      growthRef.current = {
        added: (unreported ? pending.added : 0) + added,
        origin: offset,
        last: offset,
        step: unreported ? pending.step : 0,
        until: now + FEED_POST_CARRY_WATCH_MS,
      };
    });
    observer.observe(part, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [hasComments, stripNode]);

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
    <FeedStageContext.Provider value={stage}>
      <div
        className={styles.postStage}
        data-feed-stage-frame=""
        style={{ "--feed-stage-aspect": `1 / ${ratio}` } as CSSProperties}
      >
        <div
          ref={bindStrip}
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
              fromStrip(event) &&
              event.detail !== 0 &&
              performance.now() < suppressUntilRef.current
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            // Keyboard scrolling sends its first scroll event a frame later:
            // the strip counts as moving from the key on.
            if (
              fromStrip(event) &&
              SCROLL_KEYS.has(event.key) &&
              !(event.target as Element).matches(
                "input, textarea, select, [contenteditable]",
              )
            ) {
              noteInputDirection(KEY_DIRECTION[event.key] ?? 0);
              scheduleSettle();
            }
          }}
          onScroll={() => {
            const current = measure();
            watchCarry(current.offset);
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
          onWheelCapture={(event) => {
            // So does a wheel or trackpad: moving from its first event.
            if (fromStrip(event) && (event.deltaX !== 0 || event.shiftKey)) {
              // The strip runs right to left: a leftward wheel moves on.
              const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
              noteInputDirection(-Math.sign(delta));
              scheduleSettle();
            }
          }}
          onTouchCancelCapture={(event) => {
            if (!fromStrip(event)) return;
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchEndCapture={(event) => {
            if (!fromStrip(event)) return;
            // The momentum after the finger lifts runs the way it moved.
            noteInputDirection(
              Math.sign(measure().offset - touchRef.current.startOffset),
            );
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchStartCapture={(event) => {
            if (!fromStrip(event) || event.touches.length !== 1) return;
            touchRef.current = {
              active: true,
              startOffset: measure().offset,
            };
            aimRef.current = null;
            resizedRef.current = false;
            growthRef.current = null;
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
          if (strip !== null)
            scrollToOffset(commentsStartOffset(count, strip.clientWidth));
        }}
        progress={progress}
        region={region}
      />
    </FeedStageContext.Provider>
  );
});
