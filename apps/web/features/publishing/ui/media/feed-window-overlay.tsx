"use client";

import { useEffect, useRef, useState } from "react";

import { FEED_CENTRE_Y } from "../../../authors/feed-post-strip-geometry";
import {
  capturePointer,
  releasePointer,
} from "../../../media-composer/pointer-capture";
import { feedRegionText } from "./media-geometry";
import styles from "./media.module.css";

import type { FeedStageWindow, Size } from "./media-geometry";
import type { MediaFeedFraming } from "@moya/contracts";
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

/**
 * The feed display window drawn over the crop box of the edit dialog (#244):
 * what the phone single-column stage will show of this frame. The stage crops
 * a frame taller than itself at the author's region (#341; centred by
 * default), so a `cover` window dims the bands above and below the visible
 * part, each only where the stage cuts something; a frame the stage shows
 * whole gets no marks (the switch's description says so). With `region` the
 * author places the shown part: a handle on the window drags it up and down,
 * and as a slider it answers the arrow keys. The box follows the cropper's
 * own crop area, which is centred in the viewport; until the cropper has
 * laid it out the overlay is hidden but describes itself.
 */

/** A cut below this share of the frame is none: no band, no dashed edge. */
const NO_CUT = 0.001;

/** What the stage cuts above and below the frame, as shares of its height. */
export const feedCuts = (
  window: FeedStageWindow,
): { readonly top: number; readonly bottom: number } => {
  if (window.fit !== "cover") return { top: 0, bottom: 0 };
  const bottom = 1 - window.top - window.height;
  return {
    top: window.top > NO_CUT ? window.top : 0,
    bottom: bottom > NO_CUT ? bottom : 0,
  };
};

/** Where the shown region of a cropped frame sits: 0 top … 1 bottom, centred by default. */
export const regionOf = (feed: MediaFeedFraming | undefined): number =>
  feed?.fit === "cover" && Number.isFinite(feed.y)
    ? Math.min(1, Math.max(0, feed.y))
    : FEED_CENTRE_Y;

/** How far a key moves the region: an arrow, an arrow with Shift, Page Up / Down. */
const FEED_REGION_STEP = 0.05;
const FEED_REGION_FINE_STEP = 0.01;
const FEED_REGION_PAGE = 0.25;
/** How far a finger goes before the window moves (a tap moves nothing). */
const FEED_REGION_SLOP = 2;
/** A position is kept as stored (`normalizeFeed`'s rounding). */
const REGION_PRECISION = 1e4;

const clampRegion = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * REGION_PRECISION) /
  REGION_PRECISION;

/**
 * The region a key moves to, or null for a key the slider leaves alone. The
 * slider's value grows upwards (`aria-valuenow` = (1 − y) × 100, the APG's
 * vertical slider), so ↑ and Page Up move the window up, Home sets the
 * minimum (the bottom) and End the maximum (the top).
 */
const regionAfterKey = (
  key: string,
  y: number,
  fine: boolean,
): number | null => {
  const step = fine ? FEED_REGION_FINE_STEP : FEED_REGION_STEP;
  switch (key) {
    case "ArrowUp":
      return clampRegion(y - step);
    case "ArrowDown":
      return clampRegion(y + step);
    case "PageUp":
      return clampRegion(y - FEED_REGION_PAGE);
    case "PageDown":
      return clampRegion(y + FEED_REGION_PAGE);
    case "Home":
      return 1;
    case "End":
      return 0;
    default:
      return null;
  }
};

/** The window with its region at `y` (as `feedStageWindow` places it). */
const placed = (window: FeedStageWindow, y: number): FeedStageWindow => ({
  ...window,
  top: Math.round((1 - window.height) * y * 1e6) / 1e6,
});

/** A finger dragging the window. */
interface RegionDrag {
  readonly pointer: number;
  readonly element: HTMLElement;
  /** Where the finger landed, in client pixels. */
  readonly origin: number;
  readonly from: number;
  /** How far the window travels from the top to the bottom (what the feed cuts), in pixels. */
  readonly span: number;
  value: number;
  /** Past the slop: a drag, not a tap. */
  moved: boolean;
}

export interface FeedRegionOptions {
  /** The committed window of a frame taller than the stage (局部). */
  readonly feedWindow: FeedStageWindow;
  /** The committed region (0 top … 1 bottom). */
  readonly y: number;
  /** The frame as drawn, in pixels. */
  readonly frame: Size;
  /** Keeps a new region: once the finger lifts, at once for a key. */
  readonly onCommit: (y: number) => void;
  /** A drag under way is taken back (the back sheet opened over it). */
  readonly interrupted?: boolean | undefined;
  /** A finger moves the window (true) or no longer does (false). */
  readonly onDragging?: ((dragging: boolean) => void) | undefined;
  /** The slider's description (what the stage shows, in words). */
  readonly describedBy?: string | undefined;
}

export type FeedRegionSliderProps = HTMLAttributes<HTMLSpanElement> &
  Readonly<Record<`data-${string}`, string | undefined>>;

export interface FeedRegion {
  /** The window as drawn now: the committed one, or where the finger has it. */
  readonly shown: FeedStageWindow;
  readonly dragging: boolean;
  /** For the slider element (`role="slider"`), the window or a handle on it. */
  readonly sliderProps: FeedRegionSliderProps;
}

/**
 * The shown region of a cropped frame as a vertical slider (#341, 局部), for
 * the phone stage's 「动态流」 tool and the edit dialog's feed window. A
 * finger moves it live and keeps it once it lifts; a cancelled pointer, the
 * page losing focus, Escape or `interrupted` take the drag back, and a
 * second finger never takes it over. The arrow keys (Shift for a fine step),
 * Page Up / Down, Home and End keep each step at once. Only the slider
 * renders while a finger moves it.
 */
export const useFeedRegion = ({
  feedWindow,
  y,
  frame,
  onCommit,
  interrupted = false,
  onDragging,
  describedBy,
}: FeedRegionOptions): FeedRegion => {
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<RegionDrag | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const latest = useRef({ y, onCommit, onDragging });
  latest.current = { y, onCommit, onDragging };
  const span = frame.height * (1 - feedWindow.height);

  /** Ends the drag: kept (`keep`, once the window moved) or taken back. */
  const end = (keep: boolean) => {
    const current = drag.current;
    if (current === null) return;
    // Cleared first: the capture released below is no cancel.
    drag.current = null;
    unlisten.current?.();
    unlisten.current = null;
    releasePointer(current.element, current.pointer);
    setLive(null);
    if (!current.moved) return;
    latest.current.onDragging?.(false);
    const value = clampRegion(current.value);
    if (keep && value !== clampRegion(current.from))
      latest.current.onCommit(value);
  };
  const endNow = useRef(end);
  endNow.current = end;
  useEffect(() => {
    if (interrupted) endNow.current(false);
  }, [interrupted]);
  // Nothing half moved outlives the slider (another photo, the tool off).
  useEffect(() => () => endNow.current(false), []);

  /** While a finger drags: the page stays still, and leaving it or Escape takes the drag back. */
  const listen = () => {
    const cancel = () => endNow.current(false);
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    // Before the screen's own Escape (a step back) and a dialog's.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const still = (event: Event) => event.preventDefault();
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("touchmove", still, { passive: false });
    document.addEventListener("gesturestart", still);
    unlisten.current = () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("touchmove", still);
      document.removeEventListener("gesturestart", still);
    };
  };

  /** Follows the finger to `clientY`; a move inside the slop is none. */
  const follow = (current: RegionDrag, clientY: number) => {
    const dy = clientY - current.origin;
    if (!current.moved) {
      if (Math.abs(dy) < FEED_REGION_SLOP) return;
      current.moved = true;
      latest.current.onDragging?.(true);
    }
    current.value = Math.min(1, Math.max(0, current.from + dy / current.span));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    // The photo and the stage under it never take this finger.
    event.stopPropagation();
    if (drag.current !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!(span > 0)) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    capturePointer(element, event.pointerId);
    const from = latest.current.y;
    drag.current = {
      pointer: event.pointerId,
      element,
      origin: event.clientY,
      from,
      span,
      value: from,
      moved: false,
    };
    listen();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (current === null || current.pointer !== event.pointerId) return;
    follow(current, event.clientY);
    if (current.moved) setLive(current.value);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (current === null || current.pointer !== event.pointerId) return;
    follow(current, event.clientY);
    end(true);
  };
  const onLost = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointer === event.pointerId) end(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const to = regionAfterKey(event.key, latest.current.y, event.shiftKey);
    if (to === null) return;
    // Neither the photo's keys nor the stage's.
    event.preventDefault();
    event.stopPropagation();
    if (drag.current !== null) return;
    if (to !== clampRegion(latest.current.y)) latest.current.onCommit(to);
  };

  const shownY = live ?? y;
  const shown = live === null ? feedWindow : placed(feedWindow, live);
  return {
    shown,
    dragging: live !== null,
    sliderProps: {
      role: "slider",
      tabIndex: 0,
      "aria-label": "动态流显示范围",
      "aria-orientation": "vertical",
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": Math.round((1 - shownY) * 100),
      "aria-valuetext": feedRegionText(shown),
      "aria-describedby": describedBy,
      "data-feed-control": "",
      // Its arrows and focus stay its own inside the crop surface.
      "data-crop-own-control": "",
      "data-dragging": live === null ? undefined : "",
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onLost,
      onLostPointerCapture: onLost,
      onKeyDown,
    },
  };
};

/** Where the author places the shown region of the overlay's window. */
export interface FeedRegionControl {
  /** The region (0 top … 1 bottom). */
  readonly y: number;
  readonly onChange: (y: number) => void;
  /** What the window shows, in words (the switch's description). */
  readonly describedBy?: string | undefined;
}

const share = (value: number) => `${Math.round(value * 100000) / 1000}%`;

/** The overlay itself: the window's cut bands, and anything drawn over it. */
const FeedWindowFrame = ({
  window,
  size,
  subtle,
  children,
}: {
  readonly window: FeedStageWindow;
  readonly size: Size | null;
  readonly subtle: boolean;
  readonly children?: ReactNode;
}) => {
  const cuts = feedCuts(window);
  return (
    <div
      aria-hidden={children === undefined ? "true" : undefined}
      className={styles.feedOverlay}
      data-feed-fit={window.fit}
      data-feed-whole={window.fit === "contain" && window.tall ? "" : undefined}
      data-feed-window=""
      data-subtle={subtle ? "true" : undefined}
      hidden={size === null}
      style={
        {
          width: size === null ? undefined : `${size.width}px`,
          height: size === null ? undefined : `${size.height}px`,
          "--feed-band-top": share(cuts.top),
          "--feed-band-bottom": share(cuts.bottom),
        } as CSSProperties
      }
    >
      {cuts.top > 0 ? (
        <span aria-hidden="true" className={styles.feedBand} data-edge="top" />
      ) : null}
      {cuts.bottom > 0 ? (
        <span
          aria-hidden="true"
          className={styles.feedBand}
          data-edge="bottom"
        />
      ) : null}
      {children}
    </div>
  );
};

/** The handle that drags the shown region, on the right of the bright window. */
const FeedRegionHandle = ({
  window,
  size,
  subtle,
  region,
}: {
  readonly window: FeedStageWindow;
  readonly size: Size;
  readonly subtle: boolean;
  readonly region: FeedRegionControl;
}) => {
  const control = useFeedRegion({
    feedWindow: window,
    y: region.y,
    frame: size,
    onCommit: region.onChange,
    describedBy: region.describedBy,
  });
  const { shown } = control;
  return (
    <FeedWindowFrame size={size} subtle={subtle} window={shown}>
      <span
        {...control.sliderProps}
        className={styles.feedHandle}
        style={{ top: share(shown.top + shown.height / 2) }}
      >
        <svg
          aria-hidden="true"
          fill="none"
          focusable="false"
          height={20}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.7}
          viewBox="0 0 20 20"
          width={20}
        >
          <path d="M10 3v14M6.5 6.5 10 3l3.5 3.5M6.5 13.5 10 17l3.5-3.5" />
        </svg>
      </span>
    </FeedWindowFrame>
  );
};

export const FeedWindowOverlay = ({
  window,
  size,
  subtle = false,
  region,
}: {
  readonly window: FeedStageWindow;
  readonly size: Size | null;
  /** A lighter dim, for a crop surface that stays on screen while editing. */
  readonly subtle?: boolean;
  /**
   * The author places the shown region of a cropped tall frame (#341, 局部);
   * without it the window only shows the stored one.
   */
  readonly region?: FeedRegionControl | undefined;
}) =>
  region !== undefined &&
  size !== null &&
  window.fit === "cover" &&
  window.tall ? (
    <FeedRegionHandle
      region={region}
      size={size}
      subtle={subtle}
      window={window}
    />
  ) : (
    <FeedWindowFrame size={size} subtle={subtle} window={window} />
  );

/**
 * The switch description: what the stage shows of this frame, in words;
 * `adjustable` when the author can move the shown region.
 */
export const feedWindowHint = (
  window: FeedStageWindow,
  first: boolean,
  { adjustable = false }: { readonly adjustable?: boolean } = {},
): string => {
  const fit =
    window.fit === "cover"
      ? `动态中显示亮处：${feedRegionText(window)}${
          adjustable ? "；上下拖动选择显示的部分" : ""
        }`
      : window.fit === "fill"
        ? "动态满幅显示"
        : window.tall
          ? "动态中整张显示，左右留白"
          : "动态中整张显示，上下留白";
  return first
    ? `${fit}；手机动态流的画幅介于 1:1 与 4:5，由第 1 张决定，超出部分读者点开后可见。`
    : `${fit}（画幅由第 1 张决定）。`;
};
