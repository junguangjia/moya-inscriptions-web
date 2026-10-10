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
