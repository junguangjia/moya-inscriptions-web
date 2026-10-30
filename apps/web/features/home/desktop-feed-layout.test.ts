import { describe, expect, it } from "vitest";
import { desktopFeedMedia, layoutDesktopFeed } from "./desktop-feed-layout";

const image = (ratio: number) => ({ ratio, cropped: false });
const text = { ratio: null, cropped: false };

describe("desktop calligraphy sequential rows", () => {
  it.each([3440, 4920])(
    "fills across former page boundaries at %spx instead of repeating sparse bands",
    (width) => {
      const items = Array.from({ length: 36 }, () => image(0.5));
      const { positions } = layoutDesktopFeed(items, width);
      const lastY = positions.at(-1)!.y;
      const rows = [...new Set(positions.map((p) => p.y))];
      expect(positions[12]!.y).toBe(positions[0]!.y);
      for (const y of rows.filter((y) => y !== lastY))
        expect(
          Math.min(...positions.filter((p) => p.y === y).map((p) => p.x)),
        ).toBeCloseTo(0);
      expect(rows.length).toBeLessThanOrEqual(3);
    },
  );
  it("uses a bounded soft height for an otherwise impossible full mixed-ratio row", () => {
    const positions = layoutDesktopFeed(
      [0.4, 2.8, 2.8].map(image),
      1296,
    ).positions;
    expect(new Set(positions.map((p) => p.y)).size).toBe(1);
    expect(positions[0]!.height).toBeCloseTo(173.3333333);
    expect(positions.at(-1)!.x).toBeCloseTo(0);
    positions.forEach((p) =>
      expect(p.mediaWidth / p.height).toBeCloseTo(p.ratio!),
    );
  });
  it("does not repartition a distant complete prefix just because the open tail appends", () => {
    const items = Array.from({ length: 92 }, () => image(0.5));
    const before = layoutDesktopFeed(items.slice(0, 80), 3440).positions;
    const after = layoutDesktopFeed(items, 3440).positions;
    expect(after.slice(0, 32)).toEqual(before.slice(0, 32));
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
        expect(p.height).toBeGreaterThanOrEqual(160);
        expect(p.height).toBeLessThanOrEqual(360);
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
      expect(item.width).toBeGreaterThanOrEqual(232 * 0.85);
      expect(item.width).toBeLessThanOrEqual(232 * 1.35);
      expect(item.x + item.width).toBeLessThanOrEqual(900);
    }
    expect(p.at(-1)!.y).toBeGreaterThan(p[0]!.y);
    const lastY = p.at(-1)!.y;
    for (const y of [...new Set(p.map((item) => item.y))].filter(
      (y) => y !== lastY,
    ))
      expect(
        Math.min(...p.filter((item) => item.y === y).map((item) => item.x)),
      ).toBeCloseTo(0);
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
