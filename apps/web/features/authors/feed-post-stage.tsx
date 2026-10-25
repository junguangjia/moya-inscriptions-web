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
import { LivePhotoFrame } from "../publishing/ui/live/live-photo";
import { QUICK_ACTION_LIKE_PATH } from "../quick-actions/quick-action-card-action";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";
import { FeedPostDots } from "./feed-post-dots";
import { FeedStageContext } from "./feed-post-stage-context";
import type { FeedStageApi, FeedStageSettle } from "./feed-post-stage-context";
import {
  commentsStartOffset,
  drivesStrip,
  driveZones,
  elementStartOffset,
  FEED_POST_CARRY_WATCH_MS,
  FEED_POST_CLICK_SUPPRESSION_MS,
  FEED_POST_DOUBLE_TAP_MS,
  FEED_POST_DRIVE_LONG_PRESS_MS,
  FEED_POST_DRIVE_SLOP_PX,
  FEED_POST_GLIDE_VELOCITY_MS,
  FEED_POST_INPUT_DIRECTION_MS,
  FEED_POST_SETTLE_MS,
  FEED_POST_TAP_TOLERANCE_PX,
  glideOffset,
  glideRest,
  inDriveZone,
  isCarriedStep,
  isLegacyRtlScroll,
  nextSnapOffset,
  planGlide,
  readStripOffset,
  releaseThrow,
  releaseVelocity,
  resolveStageAspect,
  sealSpan,
  slideFit,
  slideFraming,
  slidePositionY,
  snapAreaOffset,
  stripIndex,
  stripProgress,
  stripRegion,
  stripScrollLeft,
} from "./feed-post-strip-geometry";
import type {
  DrivePoint,
  DriveSpan,
  DriveZone,
  FingerSample,
  Glide,
} from "./feed-post-strip-geometry";
import styles from "../home/home-screen.module.css";

/** A comment row the comments region renders (a root or a reply). */
const COMMENT_ROW = "[data-colophon-anchor]";
/** The 落款 of an unfolded colophon or reply. */
const UNFOLDED_SEAL =
  "[data-colophon-anchor] > [data-expanded] > [data-colophon-signature]";
/** The colophons' writing column, pinned at the stage's left edge. */
const INPUT_COLUMN = "[data-colophon-input]";
/** The touch-action of a driven strip: the feed's vertical pan and pinch. */
const DRIVEN_TOUCH_ACTION = "pan-y pinch-zoom";
/** A delayed glide frame must not jump over a readable column. */
const GLIDE_MAX_FRAME_PX = 40;

const px = (value: string) => Number.parseFloat(value) || 0;

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
  /** Optional Detail/Viewer index; feed posts keep their own index by default. */
  readonly activeMediaIndex?: number | undefined;
  /** Reports a changed image only after the strip settles on it. */
  readonly onActiveMediaIndexChange?: ((index: number) => void) | undefined;
  /**
   * Detail contains every image and ignores the author's feed framing; the
   * feed keeps its adaptive fit, a taller image cropped at the author's
   * region (centred by default) or kept whole (`feed`).
   */
  readonly imageFit?: "adaptive" | "contain" | undefined;
  /** Explicit Live controls are opt-in; the feed remains a still surface. */
  readonly enableLivePlayback?: boolean | undefined;
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
  /** Feed posts return to the first image after a complete vertical exit. */
  readonly resetOnExit?: boolean | undefined;
  readonly onRegionChange?: (region: "media" | "comments") => void;
}

/**
 * Events from a portal rendered inside the strip (the colophon composer)
 * bubble through it in React; only the strip's own DOM counts here.
 */
const fromStrip = (event: { currentTarget: Element; target: EventTarget }) =>
  event.currentTarget.contains(event.target as Node) &&
  !(event.target as Element).closest?.("[data-feed-stage-control]");

const mediaIndex = (index: number, count: number): number =>
  Math.max(
    0,
    Math.min(count - 1, Number.isFinite(index) ? Math.floor(index) : 0),
  );

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

/** Every snap position in the strip (offsets from its start), and its stop. */
const snapPoints = (strip: HTMLElement, offset: number): DrivePoint[] => {
  const box = strip.getBoundingClientRect();
  const points: DrivePoint[] = [];
  for (const element of strip.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    if (style.scrollSnapAlign === "" || style.scrollSnapAlign === "none")
      continue;
    const snap = snapAreaOffset(
      style.scrollSnapAlign,
      box,
      element.getBoundingClientRect(),
      {
        left: px(style.scrollMarginLeft),
        right: px(style.scrollMarginRight),
      },
      offset,
    );
    if (snap !== null)
      points.push({ offset: snap, stop: style.scrollSnapStop === "always" });
  }
  return points;
};

/** Every snap position in the strip, as offsets from its start. */
const snapOffsets = (strip: HTMLElement, offset: number): number[] =>
  snapPoints(strip, offset).map((point) => point.offset);

/** The unfolded colophons and replies wider than the stage. */
const driveSpans = (strip: HTMLElement, offset: number): DriveSpan[] => {
  const box = strip.getBoundingClientRect();
  return [...strip.querySelectorAll<HTMLElement>(UNFOLDED_SEAL)].flatMap(
    (seal) => {
      const row = seal.parentElement?.parentElement;
      if (row === null || row === undefined) return [];
      const { snap, edge } = sealSpan(
        box,
        seal.getBoundingClientRect(),
        px(getComputedStyle(seal).scrollMarginLeft),
        offset,
      );
      const start = elementStartOffset(
        box.right - px(getComputedStyle(row).scrollMarginRight),
        row.getBoundingClientRect().right,
        offset,
      );
      // One that fits the stage shows its 落款 from its start: no span.
      if (snap <= start + 1) return [];
      return [
        {
          start,
          end: Math.max(start, Math.min(snap, edge)),
          seal: snap,
        },
      ];
    },
  );
};

/** One readable view: the stage less its gutter and the writing column. */
const readablePage = (strip: HTMLElement): number => {
  const box = strip.getBoundingClientRect();
  const column = strip.querySelector(INPUT_COLUMN);
  const row = strip.querySelector(COMMENT_ROW);
  const clear =
    column === null
      ? 64
      : column.getBoundingClientRect().right -
        box.left +
        (px(
          getComputedStyle(column).getPropertyValue("--colophon-input-edge"),
        ) || 16);
  return (
    strip.clientWidth -
    (row === null ? 0 : px(getComputedStyle(row).scrollMarginRight)) -
    clear
  );
};

/** Whether a scroller of its own (an overflowing field) lies under a touch. */
const scrollerUnder = (strip: HTMLElement, target: EventTarget | null) => {
  for (
    let element = target instanceof Element ? target : null;
    element !== null && element !== strip;
    element = element.parentElement
  ) {
    const overflow = getComputedStyle(element).overflowX;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollWidth > element.clientWidth + 1
    )
      return true;
  }
  return false;
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
    activeMediaIndex,
    onActiveMediaIndexChange,
    imageFit = "adaptive",
    enableLivePlayback = false,
    priority,
    live = false,
    badge,
    comments,
    onMediaSettled,
    onOpenViewer,
    onDoubleTap,
    burstEnabled,
    viewerOpen,
    resetOnExit = false,
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
  // Chromium only (`drivesStrip`): on an unfolded colophon wider than the
  // stage (from its start to just short of its 落款, `driveZones`) the strip gets `touch-action: pan-y pinch-zoom`, so the
  // browser leaves its horizontal pan to us. The strip follows the finger
  // and, released, glides to a resting offset of `glideRest` (never past a
  // 落款, every column read at rest), with snapping off inline meanwhile;
  // it is back on, unmoved, once the glide has arrived. A touch catches a
  // glide; any scroll of ours cancels it. WebKit is never driven.
  const driveRef = useRef<{
    enabled: boolean;
    /** Driven: the strip's touch-action is handed over. */
    driven: boolean;
    /** idle; touch: a driven finger is down; glide: gliding to rest. */
    mode: "idle" | "touch" | "glide";
    gesture: {
      x0: number;
      y0: number;
      t0: number;
      origin: number;
      locked: boolean;
      xl: number;
      /** The strip's own motion (a held 落款 does not move it). */
      samples: FingerSample[];
      /** The farthest offsets the drag reached, on and back. */
      high: number;
      low: number;
      caught: boolean;
      way: number;
      pin: number;
    } | null;
    glide: Glide | null;
    started: number;
    frame: number | null;
    /** The zones, measured once per layout (null: measure again). */
    zones: DriveZone[] | null;
    refresh: number | null;
  }>({
    enabled: false,
    driven: false,
    mode: "idle",
    gesture: null,
    glide: null,
    started: 0,
    frame: null,
    zones: null,
    refresh: null,
  });
  // A selection's DOM change (feed-colophon.tsx) adds or takes away a snap
  // area, and WebKit re-snaps the strip by that at once: snapping is held
  // off until the strip next settles where the selection scrolled it.
  const holdRef = useRef(false);
  const suppressUntilRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingTapRef = useRef<number | null>(null);
  const lastDoubleTapRef = useRef(Number.NEGATIVE_INFINITY);
  const indexRef = useRef(mediaIndex(activeMediaIndex ?? 0, count));
  const regionRef = useRef<"media" | "comments">("media");
  const [activeIndex, setActiveIndex] = useState(() =>
    mediaIndex(activeMediaIndex ?? 0, count),
  );
  const [region, setRegion] = useState<"media" | "comments">("media");
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [burst, setBurst] = useState(0);
  const firstImageRef = useRef<HTMLImageElement>(null);

  const cancelPendingTap = useCallback(() => {
    if (pendingTapRef.current !== null) {
      window.clearTimeout(pendingTapRef.current);
      pendingTapRef.current = null;
    }
  }, []);

  // Written on the DOM at once: they must be in place for the next touch.
  const applyStrip = useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const drive = driveRef.current;
    const touchAction = drive.driven ? DRIVEN_TOUCH_ACTION : "";
    if (strip.style.touchAction !== touchAction)
      strip.style.touchAction = touchAction;
    const snap = drive.mode !== "idle" || holdRef.current ? "none" : "";
    if (strip.style.scrollSnapType !== snap) strip.style.scrollSnapType = snap;
  }, []);

  const writeOffset = (offset: number) => {
    const strip = stripRef.current;
    if (strip !== null)
      strip.scrollLeft = stripScrollLeft(strip, offset, legacyRef.current);
  };

  const readZones = (strip: HTMLElement, offset: number) => {
    const drive = driveRef.current;
    if (drive.zones === null) {
      const spans =
        strip.querySelector(UNFOLDED_SEAL) === null
          ? []
          : driveSpans(strip, offset);
      const mediaEnd =
        strip.querySelectorAll("[data-feed-slide]").length * strip.clientWidth;
      const entry = Math.max(0, readablePage(strip) - 2);
      drive.zones = driveZones(spans).map((zone) => ({
        from: Math.max(mediaEnd, zone.from - entry),
        to: zone.to,
      }));
    }
    return drive.zones;
  };

  /** Drives each long colophon from one readable view before it to its seal. */
  const refreshDrive = useCallback(() => {
    const strip = stripRef.current;
    const drive = driveRef.current;
    if (strip === null || !drive.enabled) return;
    const offset = readStripOffset(strip, legacyRef.current);
    drive.driven =
      drive.mode !== "idle" || inDriveZone(readZones(strip, offset), offset);
    applyStrip();
  }, [applyStrip]);

  const stopGlide = () => {
    const drive = driveRef.current;
    if (drive.frame !== null) window.cancelAnimationFrame(drive.frame);
    drive.frame = null;
  };

  /** Any scroll of ours, a wheel or a key ends a drive where it is. */
  const cancelDrive = useCallback(() => {
    const drive = driveRef.current;
    if (drive.mode === "idle" && drive.gesture === null) return;
    if (drive.frame !== null) window.cancelAnimationFrame(drive.frame);
    drive.frame = null;
    drive.gesture = null;
    drive.glide = null;
    drive.mode = "idle";
    applyStrip();
  }, [applyStrip]);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return { offset: 0, width: 0, progress: 0 };
    const offset = readStripOffset(strip, legacyRef.current);
    const width = strip.clientWidth;
    return { offset, width, progress: stripProgress(offset, width) };
  }, []);

  const settle = useCallback(() => {
    settleTimerRef.current = null;
    // A glide's frames came late: it settles once it has arrived.
    if (driveRef.current.mode === "glide") {
      settleTimerRef.current = window.setTimeout(
        () => settleRef.current(),
        FEED_POST_SETTLE_MS,
      );
      return;
    }
    if (holdRef.current) {
      holdRef.current = false;
      applyStrip();
    }
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
        onActiveMediaIndexChange?.(index);
      }
    }
    for (const listener of [...settleListenersRef.current])
      listener({ resized });
    driveRef.current.zones = null;
    refreshDrive();
  }, [
    applyStrip,
    count,
    hasComments,
    measure,
    onActiveMediaIndexChange,
    onRegionChange,
    refreshDrive,
  ]);
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
      cancelDrive();
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
    [cancelDrive, scheduleSettle],
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

  /** The drive ends where it rests: snapping back on there moves nothing. */
  const finishDrive = (rest: number | null) => {
    const drive = driveRef.current;
    stopGlide();
    if (rest !== null) writeOffset(rest);
    drive.glide = null;
    drive.mode = "idle";
    refreshDrive();
    scheduleSettle();
  };

  /** Lets the strip go at `offset` with `velocity`: it glides to rest. */
  const releaseDrive = (
    offset: number,
    velocity: number,
    origin: number,
    way: number,
    at: number,
  ) => {
    const strip = stripRef.current;
    const drive = driveRef.current;
    if (strip === null) return;
    const rest = glideRest({
      offset,
      velocity,
      origin,
      way,
      spans: driveSpans(strip, offset),
      points: snapPoints(strip, offset),
      max: strip.scrollWidth - strip.clientWidth,
      page: readablePage(strip),
    });
    if (Math.abs(rest - offset) < 0.5) {
      finishDrive(rest);
      return;
    }
    const glide = planGlide(offset, velocity, rest);
    drive.mode = "glide";
    drive.glide = glide;
    // From the lift: the first frame carries on at the finger's speed.
    const now = performance.now();
    drive.started = at <= now && at > now - 100 ? at : now;
    const step = (time: number) => {
      drive.frame = null;
      const elapsed = Math.max(0, time - drive.started);
      const planned = glideOffset(glide, elapsed);
      const current = measure().offset;
      const delta = planned - current;
      const next =
        current +
        Math.sign(delta) * Math.min(Math.abs(delta), GLIDE_MAX_FRAME_PX);
      if (
        elapsed >= glide.duration &&
        Math.abs(glide.to - current) <= GLIDE_MAX_FRAME_PX
      ) {
        finishDrive(glide.to);
        return;
      }
      // A fast entry throw or a late frame can otherwise compress a short
      // glide into one visible jump. Carry the same curve on over frames.
      writeOffset(next);
      drive.frame = window.requestAnimationFrame(step);
    };
    drive.frame = window.requestAnimationFrame(step);
  };

  /** The driven finger lifts (or the touch is cancelled). */
  const endDrive = (at: number, cancelled: boolean) => {
    const drive = driveRef.current;
    const gesture = drive.gesture;
    drive.gesture = null;
    if (gesture === null) return;
    const offset = measure().offset;
    if (!gesture.locked) {
      // A tap: it only stopped a glide, which comes to rest on its way.
      if (gesture.caught)
        releaseDrive(offset, 0, gesture.origin, gesture.way, at);
      return;
    }
    const thrown = cancelled
      ? { velocity: 0, way: 0 }
      : releaseThrow({
          velocity: releaseVelocity(gesture.samples, at),
          offset,
          origin: gesture.origin,
          high: gesture.high,
          low: gesture.low,
        });
    releaseDrive(offset, thrown.velocity, gesture.origin, thrown.way, at);
  };

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
      driveRef.current.mode !== "idle" ||
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
        driveRef.current.mode === "idle" &&
        settleTimerRef.current === null &&
        aimRef.current === null,
      holdSnap: () => {
        holdRef.current = true;
        applyStrip();
        scheduleSettle();
      },
      viewerOpen,
    }),
    [
      stripNode,
      count,
      region,
      measure,
      scrollToOffset,
      scrollToElement,
      applyStrip,
      scheduleSettle,
      viewerOpen,
    ],
  );

  // A Detail Viewer can change the selected image while this stage is
  // covered. Restore that image without animating through the other slides.
  // The normal feed has no external index and keeps its existing behavior.
  useLayoutEffect(() => {
    if (activeMediaIndex === undefined || stripNode === null) return;
    const next = mediaIndex(activeMediaIndex, count);
    indexRef.current = next;
    setActiveIndex(next);
    regionRef.current = "media";
    setRegion("media");
    const width = stripNode.clientWidth;
    if (width > 0) {
      const offset = next * width;
      if (Math.abs(offset - measure().offset) > 1)
        scrollToOffset(offset, "instant");
      setProgress(next);
    }
  }, [activeMediaIndex, count, measure, scrollToOffset, stripNode]);

  // Watch the whole post, including an expanded body. The nearest vertical
  // scrollport also covers profile overlays and Home's independently scrolled
  // tabs. A horizontal tab change alone must not count as leaving the post.
  useEffect(() => {
    const post = stripNode?.closest("[data-feed-post]");
    if (
      !resetOnExit ||
      viewerOpen ||
      post === null ||
      post === undefined ||
      typeof IntersectionObserver !== "function"
    )
      return undefined;
    let root = post.parentElement;
    while (
      root !== null &&
      !/^(auto|scroll)$/.test(getComputedStyle(root).overflowY)
    )
      root = root.parentElement;
    let seen = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // An explicit root can intersect a post in an inactive tab.
            // Revealing that tab need not emit another intersection entry.
            seen = true;
            continue;
          }
          // Profile tabs also restore their own vertical position on commit.
          // Their departing post can move vertically while the tab hides it.
          if (post.closest('[inert], [hidden], [aria-hidden="true"]') !== null)
            continue;
          const bounds = entry.rootBounds;
          const box = entry.boundingClientRect;
          if (
            !seen ||
            bounds === null ||
            bounds.height <= 0 ||
            box.height <= 0 ||
            (box.bottom > bounds.top && box.top < bounds.bottom)
          )
            continue;
          seen = false;
          cancelPendingTap();
          if (settleTimerRef.current !== null)
            window.clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
          if (frameRef.current !== null)
            window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
          holdRef.current = false;
          resizedRef.current = false;
          growthRef.current = null;
          touchRef.current = { active: false, startOffset: 0 };
          inputDirectionRef.current = { direction: 0, at: 0 };
          lastDoubleTapRef.current = Number.NEGATIVE_INFINITY;
          scrollToOffset(0, "instant");
          setProgress(0);
          // Reuse the normal region/index notification and drive cleanup.
          settleRef.current();
          applyStrip();
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(post);
    return () => observer.disconnect();
  }, [
    applyStrip,
    cancelPendingTap,
    resetOnExit,
    scrollToOffset,
    stripNode,
    viewerOpen,
  ]);

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
    driveRef.current.enabled = drivesStrip(window);
  }, []);

  // The zones move with the layout: measured again on the next check. A
  // rest that a change put inside or outside one hands the pan over or back.
  useEffect(() => {
    const strip = stripNode;
    const drive = driveRef.current;
    if (strip === null || !drive.enabled) return undefined;
    const invalidate = () => {
      drive.zones = null;
      if (drive.refresh === null)
        drive.refresh = window.requestAnimationFrame(() => {
          drive.refresh = null;
          refreshDrive();
        });
    };
    const mutations =
      typeof MutationObserver === "function"
        ? new MutationObserver((records) => {
            // The strip's own inline style is ours.
            if (records.some((record) => record.target !== strip)) invalidate();
          })
        : null;
    mutations?.observe(strip, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const sizes =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(invalidate)
        : null;
    sizes?.observe(strip);
    const part = strip.querySelector("[data-feed-stage-comments]");
    for (const child of part?.children ?? []) sizes?.observe(child);
    invalidate();
    return () => {
      mutations?.disconnect();
      sizes?.disconnect();
      if (drive.refresh !== null) window.cancelAnimationFrame(drive.refresh);
      drive.refresh = null;
    };
  }, [hasComments, refreshDrive, stripNode]);

  // A width change (rotation, resize) keeps the shown image in place, and
  // in the comments region the comment being read (its registered anchor).
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver !== "function")
      return undefined;
    const observer = new ResizeObserver(() => {
      if (touchRef.current.active || driveRef.current.mode !== "idle") return;
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
    // The compact head (feed-colophon.tsx) changes the width, too: not rows.
    observer.observe(part, {
      attributeFilter: ["data-compact"],
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
      const drive = driveRef.current;
      if (drive.frame !== null) window.cancelAnimationFrame(drive.frame);
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
              event.currentTarget.contains(event.target as Node) &&
              (event.target as Element).closest?.("[data-feed-stage-control]")
            ) {
              cancelPendingTap();
              return;
            }
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
              cancelDrive();
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
                if (driveRef.current.mode === "idle") refreshDrive();
              });
            if (!touchRef.current.active) scheduleSettle();
          }}
          onWheelCapture={(event) => {
            // So does a wheel or trackpad: moving from its first event.
            if (fromStrip(event) && (event.deltaX !== 0 || event.shiftKey)) {
              // The strip runs right to left: a leftward wheel moves on.
              const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
              noteInputDirection(-Math.sign(delta));
              cancelDrive();
              scheduleSettle();
            }
          }}
          onContextMenuCapture={() => {
            // A long press that became a text selection drives nothing.
            const gesture = driveRef.current.gesture;
            if (gesture !== null && !gesture.locked && !gesture.caught)
              driveRef.current.gesture = null;
          }}
          onTouchCancelCapture={(event) => {
            if (!fromStrip(event)) return;
            endDrive(event.timeStamp, true);
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchEndCapture={(event) => {
            if (!fromStrip(event)) return;
            // The momentum after the finger lifts runs the way it moved.
            noteInputDirection(
              Math.sign(measure().offset - touchRef.current.startOffset),
            );
            endDrive(event.timeStamp, false);
            touchRef.current.active = false;
            scheduleSettle();
          }}
          onTouchMoveCapture={(event) => {
            const drive = driveRef.current;
            const gesture = drive.gesture;
            const touch = event.touches[0];
            const strip = stripRef.current;
            if (
              gesture === null ||
              strip === null ||
              event.touches.length !== 1 ||
              touch === undefined
            )
              return;
            if (!gesture.locked) {
              const dx = touch.clientX - gesture.x0;
              const dy = touch.clientY - gesture.y0;
              if (Math.hypot(dx, dy) < FEED_POST_DRIVE_SLOP_PX) return;
              // Vertical first: the feed's own pan. Held first, then moved
              // with text selected: a selection.
              const selecting =
                event.timeStamp - gesture.t0 > FEED_POST_DRIVE_LONG_PRESS_MS &&
                !(window.getSelection()?.isCollapsed ?? true);
              if (Math.abs(dy) >= Math.abs(dx) || selecting) {
                drive.gesture = null;
                if (gesture.caught) {
                  const offset = measure().offset;
                  releaseDrive(offset, 0, offset, gesture.way, event.timeStamp);
                }
                return;
              }
              gesture.locked = true;
              gesture.xl = touch.clientX;
              gesture.origin = measure().offset;
              gesture.high = gesture.origin;
              gesture.low = gesture.origin;
              // The finger never drags a 落款 it began before out of view:
              // the strip holds there, like a list's end.
              gesture.pin = driveSpans(strip, gesture.origin).reduce(
                (pin, span) =>
                  span.seal > gesture.origin + 2
                    ? Math.min(pin, span.seal)
                    : pin,
                Number.POSITIVE_INFINITY,
              );
              drive.mode = "touch";
              drive.driven = true;
              applyStrip();
            }
            const next = Math.min(
              strip.scrollWidth - strip.clientWidth,
              gesture.pin,
              Math.max(0, gesture.origin + touch.clientX - gesture.xl),
            );
            gesture.high = Math.max(gesture.high, next);
            gesture.low = Math.min(gesture.low, next);
            gesture.samples.push({ t: event.timeStamp, x: next });
            while (
              gesture.samples.length > 2 &&
              event.timeStamp - (gesture.samples[0]?.t ?? 0) >
                FEED_POST_GLIDE_VELOCITY_MS * 2
            )
              gesture.samples.shift();
            writeOffset(next);
          }}
          onTouchStartCapture={(event) => {
            if (!fromStrip(event)) return;
            const drive = driveRef.current;
            const caught = drive.mode === "glide" || drive.mode === "touch";
            const way =
              drive.glide === null
                ? 0
                : Math.sign(drive.glide.to - drive.glide.from);
            stopGlide();
            // Snapping comes back for the reader's own gesture.
            if (holdRef.current) {
              holdRef.current = false;
              applyStrip();
            }
            const touch = event.touches[0];
            if (event.touches.length !== 1 || touch === undefined) {
              // A second finger (a pinch): the strip comes to rest.
              if (drive.gesture !== null || drive.mode === "glide") {
                const origin = drive.gesture?.origin;
                drive.gesture = null;
                const offset = measure().offset;
                releaseDrive(offset, 0, origin ?? offset, way, event.timeStamp);
              }
              return;
            }
            const startOffset = measure().offset;
            touchRef.current = {
              active: true,
              startOffset,
            };
            const strip = stripRef.current;
            drive.gesture =
              drive.driven &&
              strip !== null &&
              !scrollerUnder(strip, event.target)
                ? {
                    x0: touch.clientX,
                    y0: touch.clientY,
                    t0: event.timeStamp,
                    origin: startOffset,
                    locked: false,
                    xl: touch.clientX,
                    samples: [],
                    high: startOffset,
                    low: startOffset,
                    caught,
                    way,
                    pin: Number.POSITIVE_INFINITY,
                  }
                : null;
            // A glide the finger caught holds where it is; one under a touch
            // the browser pans itself comes to rest on its way.
            if (caught) {
              drive.glide = null;
              if (drive.gesture !== null) drive.mode = "touch";
              else
                releaseDrive(startOffset, 0, startOffset, way, event.timeStamp);
            }
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
              // Only the feed frames a taller image the author's way; Detail
              // contains every image whatever its framing.
              const feed = imageFit === "adaptive" ? item.feed : undefined;
              const fit =
                imageFit === "contain"
                  ? "contain"
                  : slideFit(item, ratio, feed);
              const positionY = slidePositionY(item, ratio, feed);
              const imageButton = (
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
                      fit === "cover"
                        ? placeholderStyle(item.placeholderColor)
                        : undefined
                    }
                    width={item.width}
                  />
                </button>
              );
              return (
                <div
                  aria-hidden={!active}
                  aria-label={`第 ${index + 1} 张，共 ${count} 张`}
                  aria-roledescription="slide"
                  className={styles.postSlide}
                  data-feed-framing={slideFraming(item, ratio, feed)}
                  data-feed-slide={index}
                  data-fit={fit}
                  data-media-id={item.id}
                  inert={!active || undefined}
                  key={item.id}
                  role="group"
                  style={
                    positionY === undefined
                      ? undefined
                      : ({ "--feed-slide-y": positionY } as CSSProperties)
                  }
                >
                  {broken ? (
                    <MediaFallback
                      label={`图像无法加载：${item.alt}`}
                      state="failed"
                    />
                  ) : enableLivePlayback && item.live !== undefined ? (
                    <LivePhotoFrame
                      active={active && region === "media" && !viewerOpen}
                      className={styles.postLiveFrame}
                      controlAttributes={{ "data-feed-stage-control": "" }}
                      motion={item.live}
                    >
                      {imageButton}
                    </LivePhotoFrame>
                  ) : (
                    imageButton
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
