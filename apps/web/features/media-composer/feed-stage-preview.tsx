"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { FeedPostDots } from "../authors/feed-post-dots";
import {
  FEED_POST_CLICK_SUPPRESSION_MS,
  FEED_POST_SETTLE_MS,
  FEED_POST_TAP_TOLERANCE_PX,
  isLegacyRtlScroll,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  slideFraming,
  slidePositionY,
  stripIndex,
  stripProgress,
  stripScrollLeft,
} from "../authors/feed-post-strip-geometry";
import { MediaFallback } from "../home/card-media-parts";
import home from "../home/home-screen.module.css";
import styles from "./media-composer.module.css";

import type { MediaFeedFraming } from "@moya/contracts";
import type { CSSProperties } from "react";

/**
 * The post as the phone single-column feed (#243) will show it, inside the
 * composer (#244): the same stage box (from the first image, between 1:1 and
 * 4:5), the same right-to-left native scroll-snap strip with the first image
 * at the right edge, the same fit and framing per slide and the same dot row
 * — without the feed's taps, likes, viewer or comments. Pictures come from
 * the editor's own media sources; the preview holds no object URLs of its
 * own.
 */

export interface FeedStagePreviewSlide {
  readonly key: string;
  readonly alt: string;
  /** null while the picture is still being prepared (a placeholder slide). */
  readonly src: string | null;
  /** The edited frame's size when known; the stage is square until it is. */
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly status: "ready" | "loading" | "unavailable";
  readonly placeholderColor?: string | undefined;
  /** The item's feed framing (`MediaEdit.feed`); absent, centred. */
  readonly feed?: MediaFeedFraming | undefined;
}

export interface FeedStagePreviewProps {
  /** At most the feed's gallery cap; the caller trims. */
  readonly slides: readonly FeedStagePreviewSlide[];
  /** The post's item count, for the note when the feed shows fewer. */
  readonly total: number;
  readonly activeIndex: number;
  readonly onActiveIndexChange: (index: number) => void;
  readonly layout: "phone" | "desktop";
  readonly label?: string;
  /**
   * Makes each ready picture a button that opens that slide for editing,
   * with the feed's guards: a tap that moved the strip is part of the swipe,
   * and slides off the stage are inert.
   */
  readonly onSlideActivate?: (index: number) => void;
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const FeedStagePreview = ({
  slides,
  total,
  activeIndex,
  onActiveIndexChange,
  layout,
  label = "动态预览",
  onSlideActivate,
}: FeedStagePreviewProps) => {
  const count = slides.length;
  /**
   * The owner's index can outrun the slides (a removal it has not caught up
   * with, or a post longer than the feed's cap): the last slide stays shown,
   * active and tappable instead of every slide going inert.
   */
  const current = Math.max(0, Math.min(activeIndex, count - 1));
  const ratio = resolveStageAspect(slides[0]?.size ?? undefined);
  const stripRef = useRef<HTMLDivElement>(null);
  const legacyRef = useRef(false);
  const indexRef = useRef(current);
  const settleTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const touchRef = useRef({ active: false, startOffset: 0 });
  const suppressUntilRef = useRef(0);
  /** The slide whose button takes focus once it is shown (keyboard paging). */
  const focusRef = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const change = useRef(onActiveIndexChange);
  change.current = onActiveIndexChange;

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return { offset: 0, width: 0, progress: 0 };
    const offset = readStripOffset(strip, legacyRef.current);
    const width = strip.clientWidth;
    return { offset, width, progress: stripProgress(offset, width) };
  }, []);

  const settle = useCallback(() => {
    settleTimerRef.current = null;
    const index = stripIndex(measure().progress, count);
    if (index !== indexRef.current) {
      indexRef.current = index;
      change.current(index);
    }
  }, [count, measure]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const strip = stripRef.current;
      if (strip === null) return;
      const target = Math.min(Math.max(0, index), Math.max(0, count - 1));
      const left = stripScrollLeft(
        strip,
        target * strip.clientWidth,
        legacyRef.current,
      );
      const behavior = reducedMotion() ? "auto" : "smooth";
      if (typeof strip.scrollTo === "function")
        strip.scrollTo({ left, behavior });
      else strip.scrollLeft = left;
    },
    [count],
  );

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip !== null) legacyRef.current = isLegacyRtlScroll(strip);
  }, []);

  // The owner (the order rail, a dot) chose a slide: bring it in.
  useEffect(() => {
    if (current === indexRef.current) return;
    indexRef.current = current;
    scrollToIndex(current);
  }, [current, scrollToIndex]);

  // Paging from a slide's button keeps focus on the shown slide; the one it
  // left becomes inert.
  useEffect(() => {
    if (focusRef.current !== current) return;
    focusRef.current = null;
    const strip = stripRef.current;
    const button = strip?.querySelector<HTMLElement>(
      `[data-feed-slide-edit="${current}"]`,
    );
    (button ?? strip)?.focus({ preventScroll: true });
  }, [current]);

  // A width change (rotation, resize, layout swap) keeps the shown slide.
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver !== "function")
      return undefined;
    const observer = new ResizeObserver(() => {
      const left = stripScrollLeft(
        strip,
        indexRef.current * strip.clientWidth,
        legacyRef.current,
      );
      if (Math.abs(strip.scrollLeft - left) > 1) strip.scrollLeft = left;
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [count]);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null)
        window.clearTimeout(settleTimerRef.current);
      if (frameRef.current !== null)
        window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  if (count === 0) return null;

  return (
    <div className={styles.stagePreview} data-layout={layout}>
      <div
        className={home.postStage}
        data-feed-preview-frame=""
        style={{ "--feed-stage-aspect": `1 / ${ratio}` } as CSSProperties}
      >
        <div
          ref={stripRef}
          aria-label={label}
          aria-roledescription="carousel"
          className={`${home.postStrip} ${styles.stageStrip}`}
          data-feed-preview-stage=""
          data-feed-stage-count={count}
          data-feed-stage-index={current}
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
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowLeft"
                ? Math.min(count - 1, indexRef.current + 1)
                : event.key === "ArrowRight"
                  ? Math.max(0, indexRef.current - 1)
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? count - 1
                      : null;
            if (next === null || next === indexRef.current) return;
            event.preventDefault();
            if (
              event.target instanceof Element &&
              event.target.closest("[data-feed-slide-edit]") !== null
            )
              focusRef.current = next;
            indexRef.current = next;
            change.current(next);
            scrollToIndex(next);
          }}
          onScroll={() => {
            if (
              touchRef.current.active &&
              Math.abs(measure().offset - touchRef.current.startOffset) >=
                FEED_POST_TAP_TOLERANCE_PX
            )
              suppressUntilRef.current =
                performance.now() + FEED_POST_CLICK_SUPPRESSION_MS;
            if (frameRef.current === null)
              frameRef.current = window.requestAnimationFrame(() => {
                frameRef.current = null;
                setProgress(measure().progress);
              });
            if (settleTimerRef.current !== null)
              window.clearTimeout(settleTimerRef.current);
            settleTimerRef.current = window.setTimeout(
              settle,
              FEED_POST_SETTLE_MS,
            );
          }}
          onTouchCancelCapture={() => {
            touchRef.current.active = false;
          }}
          onTouchEndCapture={() => {
            touchRef.current.active = false;
          }}
          onTouchStartCapture={(event) => {
            if (event.touches.length !== 1) return;
            touchRef.current = { active: true, startOffset: measure().offset };
          }}
          role="group"
          tabIndex={0}
        >
          {slides.map((slide, index) => {
            const active = index === current;
            const broken = failed.has(slide.key);
            const fit =
              slide.size === null
                ? "contain"
                : slideFit(slide.size, ratio, slide.feed);
            const positionY =
              slide.size === null
                ? undefined
                : slidePositionY(slide.size, ratio, slide.feed);
            const picture =
              slide.src === null ? null : (
                <img
                  alt={slide.alt}
                  className={styles.slideImage}
                  decoding="async"
                  draggable={false}
                  loading={index === 0 ? "eager" : "lazy"}
                  onError={() =>
                    setFailed((previous) => new Set(previous).add(slide.key))
                  }
                  src={slide.src}
                  style={
                    fit === "cover" && slide.placeholderColor !== undefined
                      ? { backgroundColor: slide.placeholderColor }
                      : undefined
                  }
                />
              );
            return (
              <div
                aria-hidden={!active}
                aria-label={`第 ${index + 1} 张，共 ${count} 张`}
                aria-roledescription="slide"
                className={home.postSlide}
                data-feed-framing={
                  slide.size === null
                    ? undefined
                    : slideFraming(slide.size, ratio, slide.feed)
                }
                data-feed-slide={index}
                data-fit={fit}
                inert={(onSlideActivate !== undefined && !active) || undefined}
                key={slide.key}
                role="group"
                style={
                  positionY === undefined
                    ? undefined
                    : ({ "--feed-slide-y": positionY } as CSSProperties)
                }
              >
                {broken ? (
                  <MediaFallback
                    label={`图像无法加载：${slide.alt}`}
                    state="failed"
                  />
                ) : picture === null ? (
                  <div
                    aria-label={`${slide.alt}${
                      slide.status === "unavailable"
                        ? "暂时无法预览"
                        : "正在准备预览"
                    }`}
                    className={styles.slidePlaceholder}
                    data-feed-preview-placeholder={slide.status}
                    role="img"
                  >
                    {slide.status === "unavailable" ? "无法预览" : "准备中"}
                  </div>
                ) : onSlideActivate === undefined ? (
                  picture
                ) : (
                  <button
                    aria-label={`编辑第 ${index + 1} 张`}
                    className={styles.slideButton}
                    data-feed-slide-edit={index}
                    onClick={() => onSlideActivate(index)}
                    tabIndex={active ? 0 : -1}
                    type="button"
                  >
                    {picture}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <FeedPostDots
        activeIndex={current}
        alts={slides.map((slide) => slide.alt)}
        hasComments={false}
        onSelect={(index) => {
          indexRef.current = index;
          change.current(index);
          scrollToIndex(index);
        }}
        onSelectComments={() => undefined}
        progress={progress}
        region="media"
      />
      {count > 1 ? (
        <p className={styles.stageCaption} data-feed-preview-caption="">
          第 1 张在最右，向右滑看下一张
          {total > count
            ? `；动态最多显示前 ${count} 张，其余 ${total - count} 张仅在作品页显示`
            : ""}
        </p>
      ) : null}
    </div>
  );
};
