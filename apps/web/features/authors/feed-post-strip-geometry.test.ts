import { describe, expect, it } from "vitest";
import {
  FEED_STAGE_MAX_RATIO,
  FEED_STAGE_MIN_RATIO,
  isLegacyRtlScroll,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  stripIndex,
  stripProgress,
  stripRegion,
  stripScrollLeft,
} from "./feed-post-strip-geometry";

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
