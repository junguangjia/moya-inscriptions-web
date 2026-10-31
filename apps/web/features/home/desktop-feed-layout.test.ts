import { describe, expect, it } from "vitest";
import {
  desktopFeedIdealSize,
  desktopFeedMedia,
  desktopFeedTargetArea,
  layoutDesktopFeed,
} from "./desktop-feed-layout";
import type { DesktopFeedMedia } from "./desktop-feed-layout";

const image = (ratio: number): DesktopFeedMedia => ({ ratio, cropped: false });
const text: DesktopFeedMedia = { ratio: null, cropped: false };
const widths = [
  1, 32, 96, 144, 320, 650, 896, 1000, 1440, 1920, 2560, 3440, 5120,
];
const counts = [1, 2, 3, 12, 24, 62];
const ratios = [0.4, 922 / 2048, 1365 / 2048, 1, 1.5, 1.776, 2.4, 2.8];
const sequence = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index % 11 === 10 ? text : image(ratios[index % ratios.length]!),
  );

const assertPacking = (items: readonly DesktopFeedMedia[], width: number) => {
  const before = structuredClone(items);
  const result = layoutDesktopFeed(items, width);
  expect(result.positions.map((card) => card.ratio)).toEqual(
    items.map((item) => item.ratio),
  );
  const label = Math.min(72, width / 2);
  for (let index = 0; index < result.positions.length; index++) {
    const card = result.positions[index]!;
    expect(
      Number.isFinite(
        card.x + card.y + card.width + card.height + card.mediaWidth,
      ),
    ).toBe(true);
    expect(card.width).toBeGreaterThan(0);
    expect(card.height).toBeGreaterThan(0);
    expect(card.width).toBeLessThanOrEqual(Math.min(width, 580) + 0.000001);
    expect(card.height).toBeLessThanOrEqual(420 + 0.000001);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width + 0.000001);
    expect(card.cropped).toBe(
      items[index]!.preserveContain ? false : items[index]!.cropped,
    );
    if (card.ratio === null) {
      expect(card.mediaWidth).toBe(0);
      expect(card.width).toBeCloseTo(card.height, 8);
    } else {
      expect(card.width - card.mediaWidth).toBeCloseTo(label, 8);
      expect(card.mediaWidth / card.height).toBeCloseTo(card.ratio, 8);
    }
    if (width >= 650) {
      const target = desktopFeedTargetArea(width);
      expect(card.width * card.height).toBeGreaterThanOrEqual(
        target * 0.8 - 0.000001,
      );
      expect(card.width * card.height).toBeLessThanOrEqual(
        target * 1.2 + 0.000001,
      );
    }
    if (index > 0) {
      const previous = result.positions[index - 1]!;
      expect(card.y).toBeGreaterThanOrEqual(previous.y - 0.000001);
      if (card.y <= previous.y + 0.5)
        expect(card.x + card.width + 12).toBeLessThanOrEqual(
          previous.x + 0.000001,
        );
    }
    for (const earlier of result.positions.slice(0, index)) {
      const separated =
        card.x + card.width + 12 <= earlier.x + 0.000001 ||
        earlier.x + earlier.width + 12 <= card.x + 0.000001 ||
        card.y + card.height + 12 <= earlier.y + 0.000001 ||
        earlier.y + earlier.height + 12 <= card.y + 0.000001;
      expect(separated).toBe(true);
    }
  }
  expect(result.height).toBeCloseTo(
    Math.max(0, ...result.positions.map((card) => card.y + card.height)),
    8,
  );
  expect(items).toEqual(before);
  return result;
};

describe("desktop equal whole-card-area sequential masonry", () => {
  it.each([
    [650, 52000],
    [700, 52000],
    [800, 64000],
    [896, 80281.6],
    [1000, 100000],
    [3440, 100000],
  ])("adapts one common whole-card target at %spx", (width, expected) =>
    expect(desktopFeedTargetArea(width!)).toBeCloseTo(expected!, 8),
  );
  it("includes the separate caption in the area instead of equalizing only the image", () => {
    const box = desktopFeedIdealSize(image(1), 1000);
    expect(box.width * box.height).toBeCloseTo(100000, 7);
    expect(box.width - box.mediaWidth).toBe(72);
    expect(box.mediaWidth).toBeCloseTo(box.height, 8);
    expect(box.mediaWidth * box.height).toBeLessThan(100000);
  });
  it("keeps portrait and panorama natural at the revised comfortable target", () => {
    const portrait = desktopFeedIdealSize(image(0.4), 1000);
    expect(portrait.width * portrait.height).toBeCloseTo(100000, 7);
    expect(portrait.height).toBeGreaterThan(360);
    expect(portrait.height).toBeLessThanOrEqual(420);
    expect(portrait.mediaWidth / portrait.height).toBeCloseTo(0.4, 8);
    const landscape = desktopFeedIdealSize(image(2.8), 1000);
    expect(landscape.width).toBeLessThanOrEqual(580);
    expect(landscape.height).toBeGreaterThanOrEqual(140);
    expect(landscape.mediaWidth / landscape.height).toBeCloseTo(2.8, 8);
    expect(landscape.width * landscape.height).toBeCloseTo(100000, 7);
  });
  it("uses the compact minimum for a natural landscape below the desktop feed boundary", () => {
    const landscape = desktopFeedIdealSize(image(2.8), 650);
    expect(landscape.height).toBeGreaterThanOrEqual(120);
    expect(landscape.height).toBeLessThan(140);
    expect(landscape.width * landscape.height).toBeCloseTo(52000, 7);
    expect(landscape.mediaWidth / landscape.height).toBeCloseTo(2.8, 8);
  });
  it("fits the initial mixed-ratio triplet without the first preview's large left void", () => {
    const cards = layoutDesktopFeed(
      [1080 / 608, 922 / 2048, 1365 / 2048].map(image),
      1024,
    ).positions;
    expect(cards.every((card) => card.y === 0)).toBe(true);
    expect(cards[2]!.x).toBeCloseTo(0, 7);
    expect(new Set(cards.map((card) => card.height)).size).toBe(3);
    const areas = cards.map((card) => card.width * card.height);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
  });
  it.each(
    widths.flatMap((width) => counts.map((count) => [width, count] as const)),
  )(
    "keeps %s px / %s ordered cards finite, natural and separated by the fine gutter",
    (width, count) => {
      assertPacking(sequence(count), width);
    },
  );
  it("uses natural variable heights and widths instead of imposing equal-height row bands", () => {
    const layout = assertPacking([0.4, 0.625, 1, 1.5, 2.8, 1].map(image), 1440);
    expect(
      new Set(layout.positions.map((card) => card.width)).size,
    ).toBeGreaterThan(3);
    expect(
      new Set(layout.positions.map((card) => card.height)).size,
    ).toBeGreaterThan(3);
    expect(
      new Set(layout.positions.map((card) => card.y + card.height)).size,
    ).toBeGreaterThan(3);
  });
  it("keeps horizontal and vertical whole-card footprints comparable", () => {
    const positions = layoutDesktopFeed(sequence(62), 1440).positions;
    const areas = positions.map((card) => card.width * card.height);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThanOrEqual(
      1.5 + 0.000001,
    );
  });
  it.each([650, 896, 1000, 1440, 3440, 5120])(
    "never consults future records or moves an existing prefix while pages append at %spx",
    (width) => {
      const all = sequence(62);
      const full = layoutDesktopFeed(all, width);
      for (const count of [1, 12, 24, 36]) {
        const prefix = layoutDesktopFeed(all.slice(0, count), width);
        expect(full.positions.slice(0, count)).toEqual(prefix.positions);
        const changedTail = [
          ...all.slice(0, count),
          ...Array.from({ length: 20 }, () => image(2.8)),
        ];
        expect(
          layoutDesktopFeed(changedTail, width).positions.slice(0, count),
        ).toEqual(prefix.positions);
      }
    },
  );
  it("places a same-level sequence from right to left", () => {
    const positions = layoutDesktopFeed(
      Array.from({ length: 4 }, () => image(1)),
      3440,
    ).positions;
    expect(positions.every((card) => card.y === 0)).toBe(true);
    expect(positions[0]!.x + positions[0]!.width).toBeCloseTo(3440, 8);
    positions
      .slice(1)
      .forEach((card, index) =>
        expect(positions[index]!.x - card.x - card.width).toBeCloseTo(12, 8),
      );
  });
  it("keeps sparse media and real text posts bounded on a wide display without filler", () => {
    for (const item of [image(0.4), image(1.5), text]) {
      const layout = assertPacking([item], 5120);
      expect(layout.positions).toHaveLength(1);
      expect(layout.positions[0]!.x + layout.positions[0]!.width).toBeCloseTo(
        5120,
        8,
      );
      expect(layout.positions[0]!.width).toBeLessThanOrEqual(580);
      expect(layout.positions[0]!.height).toBeLessThanOrEqual(420);
    }
    const box = layoutDesktopFeed([text], 5120).positions[0]!;
    expect(box.width * box.height).toBeCloseTo(100000, 7);
    expect(box.mediaWidth).toBe(0);
  });
  it("preserves the existing crop hint only for mapped extremes while saved contain wins", () => {
    const crop = desktopFeedMedia({ media: { width: 100, height: 2000 } });
    const contain = desktopFeedMedia({
      media: { width: 100, height: 2000, feed: { fit: "contain" } },
    });
    expect(crop).toEqual({ ratio: 0.4, cropped: true });
    expect(contain).toEqual({
      ratio: 0.4,
      cropped: false,
      preserveContain: true,
    });
    const positions = layoutDesktopFeed(
      [crop, contain, image(1.5)],
      1440,
    ).positions;
    expect(positions.map((card) => card.cropped)).toEqual([true, false, false]);
    expect(positions[1]!.preserveContain).toBe(true);
  });
  it("sanitizes dimensions without promoting missing covers or inventing image posts", () => {
    expect(desktopFeedMedia({ media: { width: NaN, height: 0 } })).toEqual(
      image(1),
    );
    expect(desktopFeedMedia({ target: { type: "work" }, media: null })).toEqual(
      text,
    );
    expect(
      desktopFeedMedia({ target: { type: "catalog" }, media: null }),
    ).toEqual({ ...image(1), preserveContain: true });
    expect(desktopFeedMedia({ media: { width: 4000, height: 100 } })).toEqual({
      ratio: 2.8,
      cropped: true,
    });
    expect(
      desktopFeedMedia({
        media: { width: 0, height: 0, feed: { fit: "contain" } },
      }),
    ).toEqual({ ratio: 1, cropped: false, preserveContain: true });
    expect(layoutDesktopFeed([], 1440)).toEqual({ height: 0, positions: [] });
    expect(layoutDesktopFeed([image(1)], 0).positions).toEqual([]);
    expect(layoutDesktopFeed([image(1)], Infinity).positions).toEqual([]);
    expect(desktopFeedIdealSize(image(1), 0)).toEqual(
      desktopFeedIdealSize(image(1)),
    );
  });
  it("handles a long ordered sequence with the same bounded geometry", () => {
    const layout = layoutDesktopFeed(sequence(1000), 5120);
    expect(layout.positions).toHaveLength(1000);
    expect(
      layout.positions.every((card) => card.height > 0 && card.height <= 420),
    ).toBe(true);
    expect(layout.positions[999]!.y).toBeGreaterThan(layout.positions[0]!.y);
  });
});
