import { describe, expect, it } from "vitest";
import {
  commentsStartOffset,
  elementStartOffset,
  FEED_STAGE_MAX_RATIO,
  FEED_STAGE_MIN_RATIO,
  FEED_POST_CARRY_OWN_STEP_PX,
  isCarriedStep,
  isLegacyRtlScroll,
  nextSnapOffset,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  snapAreaOffset,
  stripIndex,
  stripProgress,
  stripRegion,
  stripRemaining,
  stripScrollLeft,
  drivesStrip,
  driveZones,
  FEED_POST_GLIDE_MAX_MS,
  FEED_POST_GLIDE_TAU_MS,
  glideOffset,
  glideRest,
  inDriveZone,
  isRestingOffset,
  planGlide,
  releaseThrow,
  releaseVelocity,
  sealSpan,
} from "./feed-post-strip-geometry";
import type { DrivePoint, DriveSpan } from "./feed-post-strip-geometry";

const strip = (scrollLeft: number, scrollWidth = 1200, clientWidth = 300) => ({
  scrollLeft,
  scrollWidth,
  clientWidth,
});

describe("resolveStageAspect", () => {
  it("falls back to a square without a first image", () => {
    expect(resolveStageAspect(undefined)).toBe(FEED_STAGE_MIN_RATIO);
    expect(FEED_STAGE_MIN_RATIO).toBe(1);
  });
  it("never goes shorter than a square for landscape images", () => {
    expect(resolveStageAspect({ width: 3, height: 2 })).toBe(1);
  });
  it("keeps a ratio inside the square–4:5 band", () => {
    expect(resolveStageAspect({ width: 4, height: 5 })).toBe(1.25);
    expect(resolveStageAspect({ width: 1, height: 1.1 })).toBeCloseTo(1.1);
    expect(resolveStageAspect({ width: 1, height: 1 })).toBe(1);
  });
  it("caps a tall image at 4:5", () => {
    expect(resolveStageAspect({ width: 9, height: 16 })).toBe(
      FEED_STAGE_MAX_RATIO,
    );
    expect(FEED_STAGE_MAX_RATIO).toBe(1.25);
  });
  it("falls back to a square for degenerate sizes", () => {
    expect(resolveStageAspect({ width: 0, height: 100 })).toBe(1);
    expect(resolveStageAspect({ width: Number.NaN, height: 100 })).toBe(1);
    expect(resolveStageAspect({ width: 100, height: Number.NaN })).toBe(1);
    expect(resolveStageAspect({ width: 0, height: 0 })).toBe(1);
    expect(resolveStageAspect({ width: 100, height: 0 })).toBe(1);
    expect(resolveStageAspect({ width: -1, height: 100 })).toBe(1);
  });
});

describe("slideFit", () => {
  it("contains an image shorter than the stage", () => {
    expect(slideFit({ width: 3, height: 2 }, 1)).toBe("contain");
    expect(slideFit({ width: 1, height: 1.1 }, 1.25)).toBe("contain");
  });
  it("contains an image exactly as tall as the stage", () => {
    expect(slideFit({ width: 4, height: 5 }, 1.25)).toBe("contain");
    expect(slideFit({ width: 1, height: 1 }, 1)).toBe("contain");
  });
  it("covers an image taller than the stage", () => {
    expect(slideFit({ width: 9, height: 16 }, 1.25)).toBe("cover");
    expect(slideFit({ width: 1, height: 1.1 }, 1)).toBe("cover");
  });
  it("tolerates floating-point noise around the stage ratio", () => {
    // 0.1 + 0.2 style drift must not flip an equal image to cover.
    expect(slideFit({ width: 3, height: 3.0000001 * 1.1 }, 1.1)).toBe(
      "contain",
    );
    expect(slideFit({ width: 1000, height: 1250.5 }, 1.25)).toBe("contain");
    expect(slideFit({ width: 1000, height: 1252 }, 1.25)).toBe("cover");
  });
});

describe("isLegacyRtlScroll", () => {
  it("treats a start at 0 or negative offsets as the modern engine", () => {
    expect(isLegacyRtlScroll(strip(0))).toBe(false);
    expect(isLegacyRtlScroll(strip(-300))).toBe(false);
    expect(isLegacyRtlScroll(strip(1))).toBe(false);
  });
  it("treats a positive start beyond one pixel as the legacy engine", () => {
    expect(isLegacyRtlScroll(strip(900))).toBe(true);
    expect(isLegacyRtlScroll(strip(1.5))).toBe(true);
  });
});

describe("readStripOffset / stripScrollLeft", () => {
  it("reads modern negative scrollLeft as distance from the right edge", () => {
    expect(readStripOffset(strip(0), false)).toBe(0);
    expect(readStripOffset(strip(-600), false)).toBe(600);
  });
  it("reads legacy scrollLeft from the maximum", () => {
    // scrollWidth 1200 - clientWidth 300 = 900 is the legacy start.
    expect(readStripOffset(strip(900), true)).toBe(0);
    expect(readStripOffset(strip(300), true)).toBe(600);
  });
  it("clamps overscroll to zero", () => {
    expect(readStripOffset(strip(12), false)).toBe(0);
    expect(readStripOffset(strip(950), true)).toBe(0);
  });
  it("round-trips an offset through scrollLeft in both engines", () => {
    for (const legacy of [false, true]) {
      for (const offset of [0, 300, 600, 900]) {
        const scrollLeft = stripScrollLeft(strip(0), offset, legacy);
        expect(readStripOffset(strip(scrollLeft), legacy)).toBe(offset);
      }
    }
  });
  it("writes the engine-specific scrollLeft", () => {
    expect(stripScrollLeft(strip(0), 600, false)).toBe(-600);
    expect(stripScrollLeft(strip(900), 600, true)).toBe(300);
  });
});

describe("stripProgress", () => {
  it("divides the offset by the slide width", () => {
    expect(stripProgress(0, 300)).toBe(0);
    expect(stripProgress(450, 300)).toBe(1.5);
    expect(stripProgress(900, 300)).toBe(3);
  });
  it("is 0 before the strip has a width", () => {
    expect(stripProgress(450, 0)).toBe(0);
    expect(stripProgress(450, -10)).toBe(0);
  });
});

describe("stripRegion", () => {
  it("stays on media before half of the step after the last image", () => {
    expect(stripRegion(0, 3, true)).toBe("media");
    expect(stripRegion(2, 3, true)).toBe("media");
    expect(stripRegion(2.49, 3, true)).toBe("media");
  });
  it("switches to comments from half of that step", () => {
    expect(stripRegion(2.5, 3, true)).toBe("comments");
    expect(stripRegion(3, 3, true)).toBe("comments");
  });
  it("never reports comments for a post without comments", () => {
    expect(stripRegion(2.5, 3, false)).toBe("media");
    expect(stripRegion(5, 3, false)).toBe("media");
  });
  it("treats a single image with comments the same way", () => {
    expect(stripRegion(0.4, 1, true)).toBe("media");
    expect(stripRegion(0.5, 1, true)).toBe("comments");
  });
});

describe("stripIndex", () => {
  it("rounds progress to the nearest image", () => {
    expect(stripIndex(0.49, 3)).toBe(0);
    expect(stripIndex(0.5, 3)).toBe(1);
    expect(stripIndex(1.4, 3)).toBe(1);
  });
  it("clamps to the first and last image", () => {
    expect(stripIndex(-0.8, 3)).toBe(0);
    expect(stripIndex(3, 3)).toBe(2);
    expect(stripIndex(10, 3)).toBe(2);
  });
  it("stays at 0 for an empty or single-image strip", () => {
    expect(stripIndex(2, 1)).toBe(0);
    expect(stripIndex(2, 0)).toBe(0);
  });
});

describe("commentsStartOffset", () => {
  it("starts the comments one width past the last image", () => {
    expect(commentsStartOffset(3, 300)).toBe(900);
    expect(commentsStartOffset(1, 390)).toBe(390);
  });
});

describe("stripRemaining", () => {
  it("measures what is left before the strip's left end", () => {
    // 1200 wide, 300 shown: 900 to scroll in all.
    expect(stripRemaining(strip(0), false)).toBe(900);
    expect(stripRemaining(strip(-600), false)).toBe(300);
    expect(stripRemaining(strip(-900), false)).toBe(0);
  });
  it("measures the legacy engine from its maximum", () => {
    expect(stripRemaining(strip(900), true)).toBe(900);
    expect(stripRemaining(strip(300), true)).toBe(300);
    expect(stripRemaining(strip(0), true)).toBe(0);
  });
  it("never goes negative past the end", () => {
    expect(stripRemaining(strip(-950), false)).toBe(0);
  });
});

describe("snapAreaOffset", () => {
  const stripBox = { left: 0, right: 300 };
  const margin = { left: 64, right: 24 };
  it("puts a start-aligned area's right edge at the right gutter", () => {
    expect(
      snapAreaOffset(
        "start",
        stripBox,
        { left: -400, right: -100 },
        margin,
        900,
      ),
    ).toBe(1276);
  });
  it("puts an end-aligned area's left edge clear of the left margin", () => {
    expect(
      snapAreaOffset("end", stripBox, { left: -40, right: 4 }, margin, 900),
    ).toBe(1004);
    expect(
      snapAreaOffset("end end", stripBox, { left: -40, right: 4 }, margin, 900),
    ).toBe(1004);
  });
  it("reads the inline (horizontal) value of two", () => {
    expect(
      snapAreaOffset(
        "start end",
        stripBox,
        { left: 0, right: 50 },
        margin,
        100,
      ),
    ).toBe(164);
  });
  it("never goes before the strip's start, and skips other values", () => {
    expect(
      snapAreaOffset("start", stripBox, { left: 400, right: 700 }, margin, 100),
    ).toBe(0);
    expect(
      snapAreaOffset("none", stripBox, { left: 0, right: 50 }, margin, 100),
    ).toBeNull();
  });
});

describe("elementStartOffset", () => {
  it("scrolls further for an element left of the view", () => {
    expect(elementStartOffset(300, -150, 900)).toBe(1350);
  });
  it("scrolls back for an element right of the view", () => {
    expect(elementStartOffset(300, 420, 900)).toBe(780);
  });
  it("keeps an element already at the right edge", () => {
    expect(elementStartOffset(300, 300, 600)).toBe(600);
  });
  it("lands the same offset in both engines", () => {
    const offset = elementStartOffset(300, -150, 600);
    for (const legacy of [false, true]) {
      const scrollLeft = stripScrollLeft(strip(0), offset, legacy);
      expect(readStripOffset(strip(scrollLeft), legacy)).toBe(offset);
    }
  });
});

describe("isCarriedStep", () => {
  it("takes a step that jumped by about the added width for a carry", () => {
    // Moving ~70px a frame, then on by the 2096px a page added.
    expect(isCarriedStep(2166, 74, 2096)).toBe(true);
    expect(isCarriedStep(2096, 0, 2096)).toBe(true);
    expect(isCarriedStep(2096 + 200, 0, 2096)).toBe(true);
    // A wheel notch whose first step was itself carried by a 622px page.
    expect(isCarriedStep(622 + 70, 0, 622)).toBe(true);
  });

  it("allows the scroll's own motion only in the first step after the commit", () => {
    expect(isCarriedStep(622 + 70 + 74, 74, 622)).toBe(false);
    // Nor for a small growth, where it would match a reader's wheel notch.
    expect(isCarriedStep(60 + 70, 0, 60)).toBe(false);
    expect(isCarriedStep(622 + 200, 0, 622)).toBe(false);
  });

  it("never takes the reader's own steps for one", () => {
    expect(isCarriedStep(74, 70, 2096)).toBe(false);
    expect(isCarriedStep(140, 70, 600)).toBe(false);
    expect(isCarriedStep(-600, 0, 600)).toBe(false);
  });

  it("ignores growth too small to tell from a step", () => {
    expect(isCarriedStep(30, 0, 30)).toBe(false);
  });

  it("never undoes a step against the reader's own input", () => {
    // 余3则回复 added 118 px, then a forward wheel step of 70 px: undoing it
    // would move the reader back by 48 px.
    expect(isCarriedStep(70, 0, 118, 1)).toBe(false);
    // A real carry leaves the scroll's own motion the reader's way.
    expect(isCarriedStep(622 + 70, 0, 622, 1)).toBe(true);
    expect(isCarriedStep(622 - 60, 0, 622, -1)).toBe(true);
    expect(isCarriedStep(622 - 60, 0, 622, 1)).toBe(false);
    expect(isCarriedStep(2166, 74, 2096, 1)).toBe(true);
  });

  it("holds less of the scroll's own motion than a wheel or key step", () => {
    expect(FEED_POST_CARRY_OWN_STEP_PX).toBeLessThan(40);
    // A whole 100 px wheel notch on a 300 px batch is the reader's.
    expect(isCarriedStep(300 + 100, 0, 300)).toBe(false);
  });
});

describe("nextSnapOffset", () => {
  const snaps = [0, 393, 786, 1179, 1572, 1700, 1900];

  it("goes on to the next snap position in the direction of travel", () => {
    expect(nextSnapOffset(snaps, 1318, 1)).toBe(1572);
    expect(nextSnapOffset(snaps, 1318, -1)).toBe(1179);
    expect(nextSnapOffset(snaps, 1572, 1)).toBe(1572);
  });

  it("takes the nearest at rest or past the last one", () => {
    expect(nextSnapOffset(snaps, 1250, 0)).toBe(1179);
    expect(nextSnapOffset(snaps, 2400, 1)).toBe(1900);
    expect(nextSnapOffset(snaps, -10, -1)).toBe(0);
  });

  it("keeps the offset without snap positions", () => {
    expect(nextSnapOffset([], 512, 1)).toBe(512);
  });
});

describe("sealSpan", () => {
  it("measures a 落款's snap and the offset its right edge meets the stage's left", () => {
    const span = sealSpan(
      { left: 0, right: 393 },
      { left: -300, right: -280 },
      64,
      1000,
    );
    expect(span.snap).toBe(1364);
    expect(span.edge).toBe(1280);
  });
});

describe("releaseVelocity", () => {
  const steady = (from: number, to: number, speed: number) =>
    Array.from({ length: (to - from) / 16 + 1 }, (_, index) => ({
      t: from + index * 16,
      x: 100 + (from + index * 16) * speed,
    }));

  it("fits the finger's speed over its last moves", () => {
    expect(releaseVelocity(steady(0, 160, 1.5), 165)).toBeCloseTo(1.5, 5);
    expect(releaseVelocity(steady(0, 160, -0.8), 165)).toBeCloseTo(-0.8, 5);
  });

  it("weighs only the last 80 ms", () => {
    const samples = [
      ...steady(0, 96, 3),
      ...steady(112, 192, 0.5).map((s) => ({ ...s, x: s.x + 288 - 56 })),
    ];
    expect(releaseVelocity(samples, 195)).toBeCloseTo(0.5, 1);
  });

  it("throws nothing from a finger held still before it lifts", () => {
    expect(releaseVelocity(steady(0, 160, 2), 160 + 60)).toBe(0);
    expect(releaseVelocity([{ t: 0, x: 10 }], 5)).toBe(0);
  });
});

// A strip like the live one at 393 px: images to 1572, the 题跋 head at
// 1572 (a stop), two folded colophons, an unfolded one from 2351 (resting
// inside it to 2637), its 落款 at 2723, the next colophon at 3052.
const span: DriveSpan = { start: 2351, end: 2637, seal: 2723 };
const points: DrivePoint[] = [
  { offset: 0, stop: true },
  { offset: 393, stop: true },
  { offset: 786, stop: true },
  { offset: 1179, stop: true },
  { offset: 1572, stop: true },
  { offset: 1800, stop: false },
  { offset: 2050, stop: false },
  { offset: 2351, stop: false },
  { offset: 2723, stop: true },
  { offset: 3052, stop: false },
  { offset: 3300, stop: false },
];
const release = (offset: number, velocity: number, origin: number) =>
  glideRest({
    offset,
    velocity,
    origin,
    spans: [span],
    points,
    max: 4000,
    page: 305,
  });

describe("driveZones", () => {
  it("drives an unfolded colophon's own span, to just short of its 落款", () => {
    const zones = driveZones([span]);
    expect(zones).toEqual([{ from: 2349, to: 2721 }]);
    expect(inDriveZone(zones, 2351)).toBe(true);
    expect(inDriveZone(zones, 2500)).toBe(true);
    expect(inDriveZone(zones, 2722)).toBe(false);
    expect(inDriveZone(zones, 2723)).toBe(false);
    // The 题跋 head, the folded colophons before it and the images are native.
    expect(inDriveZone(zones, 1572)).toBe(false);
    expect(inDriveZone(zones, 2050)).toBe(false);
    expect(inDriveZone(zones, 1179)).toBe(false);
  });

  it("gives each unfolded colophon a zone of its own", () => {
    const next: DriveSpan = { start: 3052, end: 3400, seal: 3500 };
    const zones = driveZones([span, next]);
    expect(zones[1]).toEqual({ from: 3050, to: 3498 });
    expect(inDriveZone(zones, 2900)).toBe(false);
  });
});

describe("releaseThrow", () => {
  const lift = (velocity: number, offset: number, high: number, low = 2400) =>
    releaseThrow({ velocity, offset, origin: 2400, high, low });

  it("throws nothing back from a finger that rolls back as it lifts", () => {
    // Dragged on to the 落款 (held there), rolled back: no throw, on.
    expect(lift(-0.12, 2723, 2723)).toEqual({ velocity: 0, way: 1 });
    // A flick on that ends with a 6 px roll.
    expect(lift(-0.4, 2594, 2600)).toEqual({ velocity: 0, way: 1 });
    expect(lift(-0.4, 2585, 2600)).toEqual({ velocity: 0, way: 1 });
  });

  it("throws back once the finger has really come back", () => {
    expect(lift(-0.4, 2584, 2600)).toEqual({ velocity: -0.4, way: 0 });
  });

  it("throws on and back from a plain drag", () => {
    expect(lift(1.5, 2600, 2600)).toEqual({ velocity: 1.5, way: 0 });
    expect(lift(-1.5, 2300, 2400, 2300)).toEqual({ velocity: -1.5, way: 0 });
    // A short flick back from rest is a throw, not a roll.
    expect(lift(-0.5, 2388, 2400, 2388)).toEqual({ velocity: -0.5, way: 0 });
  });

  it("throws nothing on from a drag back that rolls on as it lifts", () => {
    expect(lift(0.3, 2304, 2400, 2300)).toEqual({ velocity: 0, way: -1 });
  });
});

describe("isRestingOffset", () => {
  it("rests inside a colophon only short of its 落款's dead zone, and on snaps", () => {
    expect(isRestingOffset(2500, [span], points)).toBe(true);
    expect(isRestingOffset(2637, [span], points)).toBe(true);
    expect(isRestingOffset(2680, [span], points)).toBe(false);
    expect(isRestingOffset(2723, [span], points)).toBe(true);
    expect(isRestingOffset(1900, [span], points)).toBe(false);
    expect(isRestingOffset(2050, [span], points)).toBe(true);
  });
});

describe("glideRest", () => {
  it("stops a fast swipe from the last view on the 落款, never past it", () => {
    expect(release(2600, 3, 2523)).toBe(2723);
    expect(release(2700, 6, 2523)).toBe(2723);
  });

  it("moves on at most one readable view from where the gesture began", () => {
    // From the colophon's start: at the latest its end (the 落款 is more
    // than a view away), however fast.
    expect(release(2420, 2, 2351)).toBe(2637);
    expect(release(2400, 0.5, 2351)).toBe(2400 + 0.5 * FEED_POST_GLIDE_TAU_MS);
  });

  it("goes on to the 落款 once the finger has carried the strip past the end", () => {
    expect(release(2650, 0.4, 2351)).toBe(2723);
  });

  it("moves a throw outside the unfolded colophon on one snap position only", () => {
    expect(release(1700, 4, 2360)).toBe(1800);
    expect(release(2000, 1.2, 2360)).toBe(2050);
    expect(release(2300, 4, 2360)).toBe(2351);
    expect(release(2300, -4, 2360)).toBe(2050);
  });

  it("stops a fling back from inside the colophon at its start", () => {
    expect(release(2400, -4, 2600)).toBe(2351);
  });

  it("holds a fling back at one view, too", () => {
    expect(release(2700, -4, 2723)).toBe(2723 - 305);
  });

  it("never runs back against the finger's way without momentum", () => {
    // Held in the dead zone after dragging on: on to the 落款.
    expect(release(2660, 0, 2560)).toBe(2723);
    // After dragging back: back to the colophon's end.
    expect(release(2690, 0, 2723)).toBe(2637);
    // A caught glide's own way decides a tap.
    expect(
      glideRest({
        offset: 2660,
        velocity: 0,
        origin: 2660,
        way: 1,
        spans: [span],
        points,
        max: 4000,
        page: 305,
      }),
    ).toBe(2723);
  });

  it("rests where it is inside the colophon when held", () => {
    expect(release(2480, 0, 2400)).toBe(2480);
  });

  it("snaps to the nearest snap position on its way among folded colophons", () => {
    expect(release(1820, 0.3, 1780)).toBe(2050);
    expect(release(1810, 0, 1790)).toBe(1800);
    expect(release(1620, -1, 1700)).toBe(1572);
  });

  it("only ever rests where snapping on moves nothing", () => {
    for (let offset = 1500; offset <= 3200; offset += 37)
      for (const velocity of [-4, -1, -0.2, 0, 0.2, 1, 4])
        for (const origin of [offset - 120, offset, offset + 120]) {
          const rest = release(offset, velocity, origin);
          expect(isRestingOffset(rest, [span], points)).toBe(true);
          // Never against the finger's throw.
          if (velocity >= 0.1)
            expect(rest).toBeGreaterThanOrEqual(offset - 0.5);
          if (velocity <= -0.1) expect(rest).toBeLessThanOrEqual(offset + 0.5);
          // Never past the 落款 from before it.
          if (offset < 2721) expect(rest).toBeLessThanOrEqual(2723);
        }
  });
});

describe("planGlide and glideOffset", () => {
  it("starts at the finger's velocity and eases out to rest, never past it", () => {
    const glide = planGlide(2500, 2, 2723);
    expect(glide.duration).toBeCloseTo((3 * 223) / 2, 5);
    expect(glideOffset(glide, 0)).toBe(2500);
    expect((glideOffset(glide, 1) - 2500) / 1).toBeCloseTo(2, 1);
    let last = 2500;
    for (let t = 0; t <= glide.duration + 50; t += 4) {
      const at = glideOffset(glide, t);
      expect(at).toBeGreaterThanOrEqual(last - 1e-9);
      expect(at).toBeLessThanOrEqual(2723 + 1e-9);
      last = at;
    }
    expect(glideOffset(glide, glide.duration)).toBe(2723);
  });

  it("keeps a long glide within the longest duration, never speeding up", () => {
    const glide = planGlide(1000, 2, 1650);
    expect(glide.duration).toBe(FEED_POST_GLIDE_MAX_MS);
    let lastStep = Number.POSITIVE_INFINITY;
    let last = 1000;
    for (let t = 4; t <= glide.duration; t += 4) {
      const at = glideOffset(glide, t);
      expect(at - last).toBeLessThanOrEqual(lastStep + 1e-6);
      lastStep = at - last;
      last = at;
    }
  });

  it("eases in and out without momentum, and never throws against the move", () => {
    const still = planGlide(2660, 0, 2723);
    expect(still.velocity).toBe(0);
    expect(still.duration).toBeGreaterThanOrEqual(200);
    const against = planGlide(2660, -1, 2723);
    expect(against.velocity).toBe(0);
    expect(glideOffset(against, against.duration / 2)).toBeGreaterThan(2660);
  });
});

describe("drivesStrip", () => {
  it("drives where WebKit's gestures do not exist", () => {
    expect(drivesStrip({} as Window)).toBe(true);
  });

  it("leaves WebKit native", () => {
    expect(drivesStrip({ GestureEvent: class {} } as unknown as Window)).toBe(
      false,
    );
  });
});
