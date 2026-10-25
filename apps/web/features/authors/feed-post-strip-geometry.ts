/*
 * Geometry of a phone single-column post's media strip: a right-to-left
 * native scroll-snap scroller whose first image sits at the right edge and
 * whose comments region continues to the left of the last image.
 */

import type { MediaFeedFraming } from "@moya/contracts";

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

/** Where an unframed taller image is cropped: the contract's MEDIA_FEED_CENTRE, kept local. */
export const FEED_CENTRE_Y = 0.5;

const taller = (media: MediaSize, boxRatio: number) =>
  media.height / media.width > boxRatio + 0.001;

/**
 * How an image fills a box of `boxRatio` (height / width): a taller image is
 * cropped (`cover`) at the author's region, centred by default, unless the
 * author keeps it whole (`feed.fit` 'contain', blank at the sides); any
 * other is shown whole with blank above and below (`contain`).
 */
export const slideFit = (
  media: MediaSize,
  boxRatio: number,
  feed?: MediaFeedFraming,
): "cover" | "contain" =>
  taller(media, boxRatio) && feed?.fit !== "contain" ? "cover" : "contain";

/**
 * The CSS vertical position (`--feed-slide-y`) of a cropped image at the
 * author's region; undefined when centred or not cropped.
 */
export const slidePositionY = (
  media: MediaSize,
  boxRatio: number,
  feed?: MediaFeedFraming,
): string | undefined =>
  feed?.fit === "cover" &&
  feed.y !== FEED_CENTRE_Y &&
  slideFit(media, boxRatio, feed) === "cover"
    ? `${Math.round(feed.y * 10000) / 100}%`
    : undefined;

/**
 * What the author's framing does to an image in a box of `boxRatio`: shows
 * its chosen region or the whole image; undefined when it shows as it
 * would unframed.
 */
export const slideFraming = (
  media: MediaSize,
  boxRatio: number,
  feed?: MediaFeedFraming,
): "region" | "whole" | undefined => {
  if (feed === undefined || !taller(media, boxRatio)) return undefined;
  if (feed.fit === "contain") return "whole";
  return feed.y === FEED_CENTRE_Y ? undefined : "region";
};

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

/**
 * An unfolded colophon's 落款 along the strip: `snap`, the offset of its own
 * snap position (its left edge at the stage's left edge plus its scroll
 * margin), and `edge`, the offset at which its right edge meets the stage's
 * left edge. Between the two it is partly on stage.
 */
export interface SealSpan {
  readonly snap: number;
  readonly edge: number;
}

export const sealSpan = (
  stripBox: HorizontalEdges,
  sealRect: HorizontalEdges,
  marginLeft: number,
  offset: number,
): SealSpan => ({
  snap: offset + stripBox.left + marginLeft - sealRect.left,
  edge: offset + stripBox.left - sealRect.right,
});

/*
 * The driven strip (Chromium only). An unfolded colophon wider than the
 * stage is a snap area that covers it: Chromium rests a fling anywhere
 * inside it, or carries it on past the 落款's scroll-snap-stop, and nothing
 * done once the finger lifts changes that fling. Around such a colophon the
 * stage takes the horizontal gesture over: the strip follows the finger and,
 * on release, glides on by itself to a resting offset chosen like a
 * mandatory snap that never passes a stop.
 */

/** A glide travels about its release velocity times this, like a fling. */
export const FEED_POST_GLIDE_TAU_MS = 325;
/** The longest glide with momentum. */
export const FEED_POST_GLIDE_MAX_MS = 600;
/** Finger samples this recent give the release velocity. */
export const FEED_POST_GLIDE_VELOCITY_MS = 80;
/** A finger held still this long before it lifts throws nothing. */
export const FEED_POST_GLIDE_HOLD_MS = 50;
/** Slower than this (px/ms), a release has no direction. */
export const FEED_POST_GLIDE_MIN_VELOCITY = 0.1;
/** A touch moving less than this is not a drag yet. */
export const FEED_POST_DRIVE_SLOP_PX = 8;
/** A touch held this long before it moves may be selecting text. */
export const FEED_POST_DRIVE_LONG_PRESS_MS = 400;

/** One finger sample: its time (ms) and position along the strip (px). */
export interface FingerSample {
  readonly t: number;
  readonly x: number;
}

/**
 * The finger's velocity as it lifts (px/ms, positive on into the strip): a
 * least-squares fit over the last FEED_POST_GLIDE_VELOCITY_MS of samples, 0
 * when it was held still FEED_POST_GLIDE_HOLD_MS before lifting.
 */
export const releaseVelocity = (
  samples: readonly FingerSample[],
  now: number,
): number => {
  const recent = samples.filter(
    (sample) => now - sample.t <= FEED_POST_GLIDE_VELOCITY_MS,
  );
  const last = recent.at(-1);
  if (
    recent.length < 2 ||
    last === undefined ||
    now - last.t > FEED_POST_GLIDE_HOLD_MS
  )
    return 0;
  const meanT = recent.reduce((sum, s) => sum + s.t, 0) / recent.length;
  const meanX = recent.reduce((sum, s) => sum + s.x, 0) / recent.length;
  let num = 0;
  let den = 0;
  for (const sample of recent) {
    num += (sample.t - meanT) * (sample.x - meanX);
    den += (sample.t - meanT) ** 2;
  }
  return den > 0 ? num / den : 0;
};

/** A release against the gesture this close to its farthest point throws nothing. */
export const FEED_POST_GLIDE_ROLL_PX = 16;

export interface ReleaseThrow {
  /** The velocity the glide starts with (px/ms, positive on). */
  readonly velocity: number;
  /** The way to settle without momentum (+1 on, -1 back, 0 the nearer). */
  readonly way: number;
}

/**
 * What a lift throws. A finger that rolls back a few pixels as it lifts at
 * the end of a drag or a flick (its last samples alone run against the
 * gesture) throws nothing back: the strip rests on the gesture's way, as
 * where a list's end holds it. Only a return of FEED_POST_GLIDE_ROLL_PX or
 * more from the gesture's farthest point is a throw back.
 */
export const releaseThrow = ({
  velocity,
  offset,
  origin,
  high,
  low,
}: {
  readonly velocity: number;
  /** The strip's offset at the lift. */
  readonly offset: number;
  /** The strip's offset when the drag began. */
  readonly origin: number;
  /** The farthest offsets the drag reached, on and back. */
  readonly high: number;
  readonly low: number;
}): ReleaseThrow => {
  const d =
    Math.abs(velocity) >= FEED_POST_GLIDE_MIN_VELOCITY
      ? Math.sign(velocity)
      : 0;
  const on = high - origin > FEED_POST_DRIVE_SLOP_PX;
  const back = origin - low > FEED_POST_DRIVE_SLOP_PX;
  if (d < 0 && on && high - offset < FEED_POST_GLIDE_ROLL_PX)
    return { velocity: 0, way: 1 };
  if (d > 0 && back && offset - low < FEED_POST_GLIDE_ROLL_PX)
    return { velocity: 0, way: -1 };
  return { velocity, way: 0 };
};

/**
 * An unfolded colophon wider than the stage, as strip offsets: `start`, its
 * row's start snap; `end`, the last offset Chromium lets the strip rest
 * inside it (where its 落款's right edge meets the stage's left edge;
 * between there and the 落款's own snap, it re-snaps); `seal`, the 落款's
 * snap.
 */
export interface DriveSpan {
  readonly start: number;
  readonly end: number;
  readonly seal: number;
}

/** A snap position (strip offset), and whether it has scroll-snap-stop. */
export interface DrivePoint {
  readonly offset: number;
  readonly stop: boolean;
}

/** A range of strip offsets in which a touch is driven. */
export interface DriveZone {
  readonly from: number;
  readonly to: number;
}

/**
 * Where a touch is driven: an unfolded colophon's own span, from its start
 * on to just short of its 落款. Before it (the 题跋 head, folded colophons,
 * images) and from its 落款 on, the strip is native.
 */
export const driveZones = (spans: readonly DriveSpan[]): DriveZone[] =>
  spans.map((span) => ({ from: span.start - 2, to: span.seal - 2 }));

export const inDriveZone = (
  zones: readonly DriveZone[],
  offset: number,
): boolean => zones.some((zone) => offset >= zone.from && offset <= zone.to);

/** Whether the strip may rest at `offset` with snapping on, unmoved. */
export const isRestingOffset = (
  offset: number,
  spans: readonly DriveSpan[],
  points: readonly DrivePoint[],
): boolean =>
  spans.some(
    (span) => offset >= span.start - 0.5 && offset <= span.end + 0.5,
  ) ||
  points.some((point) => Math.abs(point.offset - offset) <= 0.5) ||
  spans.some((span) => Math.abs(span.seal - offset) <= 0.5);

export interface GlideRelease {
  /** The offset at the lift. */
  readonly offset: number;
  /** The release velocity (px/ms, positive on into the strip). */
  readonly velocity: number;
  /** The offset when the gesture began. */
  readonly origin: number;
  /** The way to settle without momentum (+1 on, -1 back, 0 the nearer). */
  readonly way?: number;
  readonly spans: readonly DriveSpan[];
  readonly points: readonly DrivePoint[];
  /** The strip's last offset. */
  readonly max: number;
  /** One readable view: the stage less its gutter and the input column. */
  readonly page: number;
}

/**
 * Where a released strip comes to rest, chosen like a mandatory snap that
 * never passes a stop:
 * - its natural end, offset + velocity * FEED_POST_GLIDE_TAU_MS, is held at
 *   the first snap-stop ahead (an image, the 题跋 head, a 落款); on into an
 *   unfolded colophon from before it, at its start; back from inside one,
 *   at its start too; thrown from outside every unfolded colophon, at the
 *   next snap position;
 * - within an unfolded colophon it moves on at most one readable view from
 *   where the gesture began, so every column gets a resting view (at the
 *   latest the colophon's end, the last rest short of its 落款);
 * - inside an unfolded colophon it may rest anywhere Chromium lets it;
 *   short of the 落款 beyond that, on at the 落款 (back at the colophon's
 *   last view); elsewhere at the nearest snap position on its way.
 */
export const glideRest = ({
  offset: p,
  velocity: v,
  origin: s0,
  way: hint = 0,
  spans,
  points,
  max,
  page,
}: GlideRelease): number => {
  const clamp = (value: number) => Math.min(max, Math.max(0, value));
  const d = Math.abs(v) >= FEED_POST_GLIDE_MIN_VELOCITY ? Math.sign(v) : 0;
  let natural = d === 0 ? p : p + v * FEED_POST_GLIDE_TAU_MS;
  let barrier: number | null = null;
  if (d !== 0) {
    const stops = points.filter((point) => point.stop).map((p0) => p0.offset);
    for (const span of spans) {
      stops.push(span.seal);
      if (d > 0 && span.start > s0 + 2) stops.push(span.start);
      if (d < 0 && s0 > span.start + 2 && s0 <= span.seal + 2)
        stops.push(span.start);
    }
    // A stop the gesture began before counts even when the finger left the
    // strip on it (offsets round to device pixels).
    const ahead = stops
      .filter(
        (o) => (o - p) * d > 1 || (Math.abs(o - p) <= 1.5 && (o - s0) * d > 2),
      )
      .sort((a, b) => (a - b) * d);
    barrier = ahead[0] ?? null;
    if (barrier !== null && (natural - barrier) * d > 0) natural = barrier;
    // Dragged out of the unfolded colophons (back over folded ones before
    // one): a throw moves on to the next snap position only, as short as a
    // native one there.
    if (!spans.some((s) => p >= s.start - 1 && p <= s.seal + 1)) {
      const next = [
        ...points.map((point) => point.offset),
        ...spans.flatMap((s) => [s.start, s.seal]),
      ]
        .filter((o) => (o - p) * d > 1)
        .sort((a, b) => (a - b) * d)[0];
      if (next !== undefined && (natural - next) * d > 0) {
        natural = next;
        barrier = next;
      }
    }
    // Reading pace inside an unfolded colophon the glide runs through.
    const span = spans.find((s) =>
      d > 0
        ? s.seal > p + 1 && s.start < natural
        : s.start < p - 1 && s.seal > natural,
    );
    if (span !== undefined && d > 0 && span.seal - s0 > page) {
      // Chromium never rests between the colophon's end and its 落款: short
      // of a view on from where the gesture began, the glide ends there at
      // the latest (once the finger has carried the strip past it, the 落款
      // is next).
      const limit = Math.min(Math.max(s0 + page, p + 40), span.end);
      if (p < span.end && natural > limit) natural = limit;
    } else if (span !== undefined && d < 0)
      natural = Math.max(natural, Math.min(s0 - page, p - 40));
  }
  natural = clamp(natural);
  const inside = spans.find(
    (s) => natural >= s.start - 0.5 && natural <= s.end + 0.5,
  );
  if (inside !== undefined)
    return Math.min(inside.end, Math.max(inside.start, natural));
  const way = d !== 0 ? d : hint !== 0 ? hint : Math.sign(p - s0);
  const gap = spans.find((s) => natural > s.end && natural < s.seal);
  if (gap !== undefined)
    return way > 0
      ? gap.seal
      : way < 0
        ? gap.end
        : natural - gap.end < gap.seal - natural
          ? gap.end
          : gap.seal;
  let pool = [
    ...points.map((point) => point.offset),
    ...spans.flatMap((s) => [s.start, s.end, s.seal]),
  ].map(clamp);
  // Thrown (or a caught glide's way): on its way. Held: the nearest, as a
  // native snap after a held drag.
  const onward = d !== 0 ? d : hint;
  if (onward !== 0) {
    const ahead = pool.filter(
      (o) =>
        (o - p) * onward >= -0.5 &&
        (barrier === null || (o - barrier) * onward <= 0.5),
    );
    if (ahead.length > 0) pool = ahead;
  }
  const ref = d === 0 ? p : natural;
  return pool.reduce(
    (best, o) => (Math.abs(o - ref) < Math.abs(best - ref) ? o : best),
    pool[0] ?? p,
  );
};

/** A glide's duration and the velocity it starts at. */
export interface Glide {
  readonly from: number;
  readonly to: number;
  readonly velocity: number;
  readonly duration: number;
}

/**
 * From `from` at `velocity` to rest at `to`. With momentum on its way it
 * starts at the finger's velocity and eases out (a cubic Hermite, which
 * never overshoots while duration * velocity <= 3 * distance), within
 * FEED_POST_GLIDE_MAX_MS; without, it eases in and out like a snap.
 */
export const planGlide = (
  from: number,
  velocity: number,
  to: number,
): Glide => {
  const distance = to - from;
  const vel =
    velocity * distance > 0 &&
    Math.abs(velocity) >= FEED_POST_GLIDE_MIN_VELOCITY
      ? velocity
      : 0;
  const duration =
    vel !== 0
      ? Math.min((3 * distance) / vel, FEED_POST_GLIDE_MAX_MS)
      : Math.min(420, Math.max(200, 200 + Math.abs(distance) * 0.5));
  return { from, to, velocity: vel, duration };
};

/** The glide's offset `elapsed` ms after it began. */
export const glideOffset = (glide: Glide, elapsed: number): number => {
  if (glide.duration <= 0 || elapsed >= glide.duration) return glide.to;
  const u = Math.max(0, elapsed / glide.duration);
  const distance = glide.to - glide.from;
  return (
    glide.from +
    distance * (3 * u * u - 2 * u * u * u) +
    glide.duration * glide.velocity * (u - 2 * u * u + u * u * u)
  );
};

/**
 * Whether the stage drives touches around unfolded colophons: Chromium
 * (Android Chrome, WeChat's XWeb, other Chromium browsers). WebKit (every
 * iPhone browser; it has `GestureEvent`) stops a fling at the 落款 by itself
 * and is left native.
 */
export const drivesStrip = (win: Window): boolean => !("GestureEvent" in win);
