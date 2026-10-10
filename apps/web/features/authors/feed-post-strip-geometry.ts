/*
 * Geometry of a phone single-column post's media strip: a right-to-left
 * native scroll-snap scroller whose first image sits at the right edge and
 * whose comments region continues to the left of the last image.
 */

/** The stage is never shorter than a square nor taller than 4:5. */
export const FEED_STAGE_MIN_RATIO = 1;
export const FEED_STAGE_MAX_RATIO = 1.25;
/** A scroll that stopped moving for this long has settled. */
export const FEED_POST_SETTLE_MS = 120;
/** A click this soon after a swipe belonged to the swipe. */
export const FEED_POST_CLICK_SUPPRESSION_MS = 500;
/** Movement under this many pixels is still a tap. */
export const FEED_POST_TAP_TOLERANCE_PX = 10;
/** A second tap within this window is a double tap. */
export const FEED_POST_DOUBLE_TAP_MS = 300;
/**
 * After the comments region grows, a scroll already running is watched this
 * long for being carried on by the added width.
 */
export const FEED_POST_CARRY_WATCH_MS = 600;
/** Growth under this many pixels is not watched. */
export const FEED_POST_CARRY_MIN_PX = 48;
/** How far a carried step may differ from the added width. */
export const FEED_POST_CARRY_TOLERANCE_PX = 24;
/**
 * The scroll's own motion a carried first step may also hold, when no step
 * was reported between commit and carry: a frame of a running animation,
 * kept under one wheel notch or key step (40 px and more), so that a step
 * of the reader's own is never taken for a small batch's carry.
 */
export const FEED_POST_CARRY_OWN_STEP_PX = 32;
/** How long the reader's last wheel, key or swipe direction holds. */
export const FEED_POST_INPUT_DIRECTION_MS = 1000;

interface MediaSize {
  readonly width: number;
  readonly height: number;
}

/** The stage's height-to-width ratio from the post's first image. */
export const resolveStageAspect = (media: MediaSize | undefined): number => {
  if (media === undefined) return FEED_STAGE_MIN_RATIO;
  const ratio = media.height / media.width;
  return Number.isFinite(ratio) && ratio > 0
    ? Math.min(FEED_STAGE_MAX_RATIO, Math.max(FEED_STAGE_MIN_RATIO, ratio))
    : FEED_STAGE_MIN_RATIO;
};

/**
 * How an image fills the stage: a taller image is centre-cropped (`cover`),
 * any other is shown whole with blank above and below (`contain`).
 */
export const slideFit = (media: MediaSize, stageRatio: number) =>
  media.height / media.width > stageRatio + 0.001 ? "cover" : "contain";

interface StripElement {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/**
 * Engines before the CSSOM View RTL rule (Chromium < 85) report an RTL
 * scroller's start as its maximum `scrollLeft`; every current engine reports
 * 0 at the start and negative values towards the end.
 */
export const isLegacyRtlScroll = (element: StripElement): boolean =>
  element.scrollLeft > 1;

/** Distance scrolled from the strip's start (its right edge), in pixels. */
export const readStripOffset = (
  element: StripElement,
  legacy: boolean,
): number =>
  Math.max(
    0,
    legacy
      ? element.scrollWidth - element.clientWidth - element.scrollLeft
      : -element.scrollLeft,
  );

/** The `scrollLeft` that places the strip `offset` pixels from its start. */
export const stripScrollLeft = (
  element: StripElement,
  offset: number,
  legacy: boolean,
): number =>
  legacy ? element.scrollWidth - element.clientWidth - offset : -offset;

/** Slides scrolled past: 0 on the first image, `count` at the comments. */
export const stripProgress = (offset: number, width: number): number =>
  width > 0 ? offset / width : 0;

/** The region shown: past half of the step after the last image is comments. */
export const stripRegion = (
  progress: number,
  count: number,
  hasComments: boolean,
): "media" | "comments" =>
  hasComments && progress >= count - 0.5 ? "comments" : "media";

/** The image index a settled progress rests on. */
export const stripIndex = (progress: number, count: number): number =>
  Math.min(Math.max(0, count - 1), Math.max(0, Math.round(progress)));

/** Offset of the comments start from the strip start. */
export const commentsStartOffset = (count: number, width: number): number =>
  count * width;

/** Pixels left to scroll before the strip's end (its left edge). */
export const stripRemaining = (
  element: StripElement,
  legacy: boolean,
): number =>
  Math.max(
    0,
    element.scrollWidth -
      element.clientWidth -
      readStripOffset(element, legacy),
  );

/**
 * The strip offset that puts an element's right edge on the strip's right
 * edge, from both rectangles' current `right` and the current offset. An
 * element left of the view needs a larger offset, one right of it a smaller.
 */
export const elementStartOffset = (
  stripRight: number,
  elementRight: number,
  currentOffset: number,
): number => currentOffset + (stripRight - elementRight);

/** A horizontal extent: a rectangle's or its scroll margins' left and right. */
interface HorizontalEdges {
  readonly left: number;
  readonly right: number;
}

/**
 * The strip offset of an element's snap position, from its computed
 * `scroll-snap-align` (the strip runs right to left: `start` is the right
 * edge, `end` the left), its scroll margins and both rectangles; null when
 * it is no snap area. Never before the strip's start.
 */
export const snapAreaOffset = (
  align: string,
  stripBox: HorizontalEdges,
  elementBox: HorizontalEdges,
  margin: HorizontalEdges,
  currentOffset: number,
): number | null => {
  const values = align.trim().split(/\s+/u);
  // One value serves both axes; of two, the second is the strip's (inline).
  const inline = values[1] ?? values[0];
  const offset =
    inline === "start"
      ? elementStartOffset(
          stripBox.right - margin.right,
          elementBox.right,
          currentOffset,
        )
      : inline === "end"
        ? elementStartOffset(
            stripBox.left + margin.left,
            elementBox.left,
            currentOffset,
          )
        : inline === "center"
          ? elementStartOffset(
              (stripBox.left + stripBox.right) / 2,
              (elementBox.left + elementBox.right) / 2,
              currentOffset,
            )
          : null;
  return offset === null ? null : Math.max(0, offset);
};

/**
 * Whether one scroll step jumped by about `added` beyond the step before it:
 * a running scroll animation that the engine carried on by the width added
 * on the strip's left, rather than the reader's own motion. The first step
 * after the commit (`previousStep` 0) may hold the scroll's own first motion
 * too, up to a quarter of the added width.
 *
 * `direction` is the way the reader's own input last moved the strip (+1
 * towards its end, -1 back, 0 unknown). Undoing a carry leaves the scroll's
 * own motion (`step - added`); a step whose own motion would then run
 * against the reader's input is the reader's, never a carry.
 */
export const isCarriedStep = (
  step: number,
  previousStep: number,
  added: number,
  direction = 0,
): boolean =>
  added >= FEED_POST_CARRY_MIN_PX &&
  !(direction !== 0 && (step - added) * Math.sign(direction) < -2) &&
  Math.abs(step - previousStep - added) <=
    Math.max(FEED_POST_CARRY_TOLERANCE_PX, added * 0.1) +
      (previousStep === 0
        ? Math.min(FEED_POST_CARRY_OWN_STEP_PX, added * 0.25)
        : 0);

/**
 * The snap offset a scroll moving in `direction` (+1 towards the strip's end,
 * -1 back towards its start, 0 at rest) comes to from `offset`: the next one
 * on its way, else the last one it passed; the nearest one at rest.
 */
export const nextSnapOffset = (
  snaps: readonly number[],
  offset: number,
  direction: number,
): number => {
  if (snaps.length === 0) return offset;
  const sorted = [...snaps].sort((a, b) => a - b);
  const ahead =
    direction > 0
      ? sorted.find((snap) => snap >= offset - 1)
      : direction < 0
        ? sorted.findLast((snap) => snap <= offset + 1)
        : undefined;
  if (ahead !== undefined) return ahead;
  return sorted.reduce((best, snap) =>
    Math.abs(snap - offset) < Math.abs(best - offset) ? snap : best,
  );
};
