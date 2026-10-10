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
