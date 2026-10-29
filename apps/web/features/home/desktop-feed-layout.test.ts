import { describe, expect, it } from "vitest";
import {
  desktopFeedMedia,
  layoutDesktopFeed,
  layoutDesktopFeedBatches,
} from "./desktop-feed-layout";

const image = (ratio: number) => ({ ratio, cropped: false });
const text = { ratio: null, cropped: false };

describe("desktop calligraphy sequential rows", () => {
  it("keeps an earlier page's geometry when another page appends, and reflows each batch on resize", () => {
    const items = [
      0.4, 1, 2.8, 0.6, 1.6, 1, 0.6, 1, 0.625, 2.4, 1, 1, 0.5, 1.5, 0.65, 2.8,
      0.4, 2.4,
    ].map(image);
    const before = layoutDesktopFeedBatches(items.slice(0, 12), 672, [12]);
    const after = layoutDesktopFeedBatches(items, 672, [12, 18]);
    expect(after.positions.slice(0, 12)).toEqual(before.positions);
    expect(after.positions[12]!.y).toBe(before.height + 24);
    const resized = layoutDesktopFeedBatches(items, 1296, [12, 18]);
    expect(resized.positions).toHaveLength(items.length);
    expect(resized.positions[12]!.y).toBeGreaterThan(resized.positions[11]!.y);
    expect(
      resized.positions.every((p) => p.x >= 0 && p.x + p.width <= 1296.001),
    ).toBe(true);
  });
  it.each([768, 1296, 1920, 3440])(
    "keeps source/DOM order and images in bounds at %spx",
    (width) => {
      const items = [
        0.5,
        1,
        1.6,
        0.6,
        1.6,
        null,
        0.6,
        1,
        0.625,
        2.4,
        1,
        null,
        0.5,
        1.5,
        0.65,
      ].map((ratio) => (ratio === null ? text : image(ratio)));
      const { positions } = layoutDesktopFeed(items, width);
      expect(positions).toHaveLength(items.length);
      positions.forEach((p, i) => {
        expect(p.ratio).toBe(items[i]!.ratio);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x + p.width).toBeLessThanOrEqual(width + 0.001);
        expect(p.height).toBeGreaterThan(0);
        expect(p.height).toBeLessThanOrEqual(300);
        if (p.ratio) expect(p.mediaWidth / p.height).toBeCloseTo(p.ratio);
        const previous = positions[i - 1];
        if (previous) {
          expect(p.y).toBeGreaterThanOrEqual(previous.y);
          if (p.y === previous.y)
            expect(p.x + p.width).toBeCloseTo(previous.x - 20);
        }
      });
    },
  );
  it("right aligns the final row without stretching a lone portrait", () => {
    const p = layoutDesktopFeed([image(0.5)], 1920).positions[0]!;
    expect(p.height).toBe(240);
    expect(p.width).toBe(192);
    expect(p.x + p.width).toBe(1920);
  });
  it("keeps an all-text page bounded and gives each excerpt a real card", () => {
    const p = layoutDesktopFeed(
      Array.from({ length: 11 }, () => text),
      900,
    ).positions;
    expect(p).toHaveLength(11);
    for (const item of p) {
      expect(item.width).toBe(232);
      expect(item.x + item.width).toBeLessThanOrEqual(900);
    }
    expect(p[3]!.y).toBeGreaterThan(p[2]!.y);
  });
  it("sanitizes dimensions and distinguishes absent covers from text-only works", () => {
    expect(desktopFeedMedia({ media: { width: NaN, height: 0 } })).toEqual(
      image(1),
    );
    expect(
      desktopFeedMedia({ target: { type: "catalog" }, media: null }),
    ).toEqual(image(1));
    expect(desktopFeedMedia({ target: { type: "work" }, media: null })).toEqual(
      text,
    );
    expect(layoutDesktopFeed([image(1)], 0).positions).toEqual([]);
  });
  it("marks extreme crops while honoring the author's keep-whole framing", () => {
    expect(desktopFeedMedia({ media: { width: 100, height: 2000 } })).toEqual({
      ratio: 0.4,
      cropped: true,
    });
    expect(desktopFeedMedia({ media: { width: 4000, height: 100 } })).toEqual({
      ratio: 2.8,
      cropped: true,
    });
    expect(
      desktopFeedMedia({
        media: { width: 100, height: 2000, feed: { fit: "contain" } },
      }),
    ).toEqual({ ratio: 0.4, cropped: false });
  });
});
