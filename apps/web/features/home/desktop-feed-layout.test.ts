import { describe, expect, it } from "vitest";
import { desktopLayout } from "@moya/design-tokens";
import {
  desktopFeedMedia,
  layoutDesktopFeed,
  resolveDesktopFeedColumns,
} from "./desktop-feed-layout";
import { HOME_PC_MIN_CARD_WIDTH } from "./catalog-masonry-layout";
import type { DesktopFeedMedia } from "./desktop-feed-layout";

const image = (ratio: number): DesktopFeedMedia => ({ ratio, cropped: false });
const text: DesktopFeedMedia = { ratio: null, cropped: false };
const widths = [896, 1024, 1440, 1920, 2560, 3440, 5120];
const counts = [1, 2, 3, 11, 12, 13, 23, 24, 36, 53];
const mixed = [0.4, 2.8, 0.5, 1, 1.6, 0.6, 2.8, 0.625, 2.4, 1, 0.65];
const assertMasonry = (items: readonly DesktopFeedMedia[], width: number) => {
  const layout = layoutDesktopFeed(items, width);
  expect(layout.positions).toHaveLength(items.length);
  expect(layout.positions.map(({ ratio }) => ratio)).toEqual(
    items.map(({ ratio }) => ratio),
  );
  const columns = resolveDesktopFeedColumns(width);
  const cardWidth = (width - (columns - 1) * 12) / columns;
  const bottoms = Array.from({ length: columns }, () => 0);
  layout.positions.forEach((position, index) => {
    expect(Number.isFinite(position.height)).toBe(true);
    expect(position.height).toBeGreaterThan(0);
    expect(position.height).toBeLessThanOrEqual(720);
    expect(position.width).toBeCloseTo(cardWidth, 8);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.x + position.width).toBeLessThanOrEqual(width + 0.000001);
    const column = Math.max(
      0,
      Math.round((width - position.x - position.width) / (cardWidth + 12)),
    );
    expect(position.y).toBeCloseTo(Math.min(...bottoms), 8);
    expect(column).toBe(bottoms.indexOf(Math.min(...bottoms)));
    expect(position.y).toBeCloseTo(bottoms[column]!, 8);
    bottoms[column] = position.y + position.height + 12;
    if (position.ratio === null) {
      expect(position.height).toBe(240);
      expect(position.mediaWidth).toBe(0);
    } else {
      expect(position.width - position.mediaWidth).toBeCloseTo(0, 8);
      const naturalHeight = position.mediaWidth / position.ratio;
      expect(position.height).toBeCloseTo(Math.min(720, naturalHeight), 8);
      expect(position.cropped).toBe(
        items[index]!.preserveContain
          ? false
          : items[index]!.cropped || naturalHeight > 720,
      );
    }
    if (index > 0)
      expect(position.y).toBeGreaterThanOrEqual(
        layout.positions[index - 1]!.y - 0.000001,
      );
  });
  expect(layout.height).toBeCloseTo(
    Math.max(...layout.positions.map((p) => p.y + p.height)),
    8,
  );
  return layout;
};

describe("desktop natural-aspect RTL masonry", () => {
  it("uses the shared fine gutters and readable image width target", () => {
    expect(desktopLayout.feed.gap).toBe(12);
    expect(desktopLayout.feed.rowGap).toBe(12);
    expect(HOME_PC_MIN_CARD_WIDTH).toBe(220);
  });
  it.each(
    widths.flatMap((width) => counts.map((count) => [width, count] as const)),
  )(
    "packs consecutive mixed records without skipped column holes at %spx with %s items",
    (width, count) => {
      const items = Array.from({ length: count }, (_, index) =>
        index % 9 === 8 ? text : image(mixed[index % mixed.length]!),
      );
      const unchanged = structuredClone(items);
      assertMasonry(items, width);
      expect(items).toEqual(unchanged);
    },
  );
  it.each([
    [896, 3],
    [1024, 4],
    [1440, 6],
    [1920, 8],
    [3440, 14],
    [5120, 22],
  ])(
    "shares normal column density without reserving caption width at %spx",
    (width, columns) => {
      expect(resolveDesktopFeedColumns(width!)).toBe(columns);
      const position = layoutDesktopFeed([image(1)], width!).positions[0]!;
      expect(position.mediaWidth).toBe(position.width);
      expect(position.height).toBe(position.width);
    },
  );
  it("places each source item into the next shortest column with rightmost ties", () => {
    const layout = layoutDesktopFeed([1, 0.5, 2, 1, 2].map(image), 1050);
    expect(
      layout.positions.map(({ x, y, height }) => ({ x, y, height })),
    ).toEqual([
      { x: 796.5, y: 0, height: 253.5 },
      { x: 531, y: 0, height: 507 },
      { x: 265.5, y: 0, height: 126.75 },
      { x: 0, y: 0, height: 253.5 },
      { x: 265.5, y: 138.75, height: 126.75 },
    ]);
    expect(layout.height).toBe(507);
  });
  it.each([1024, 1440, 1920, 2560, 3440, 5120])(
    "keeps image widths readable and lets their heights vary at %spx",
    (width) => {
      const positions = layoutDesktopFeed(
        [0.5, 1, 2.4].map(image),
        width,
      ).positions;
      expect(positions[0]!.mediaWidth).toBeGreaterThanOrEqual(220);
      expect(positions[0]!.mediaWidth).toBeLessThanOrEqual(320);
      expect(new Set(positions.map((p) => p.mediaWidth)).size).toBe(1);
      expect(new Set(positions.map((p) => p.height)).size).toBe(3);
      positions.forEach((p) =>
        expect(p.mediaWidth / p.height).toBeCloseTo(p.ratio!, 8),
      );
    },
  );
  it("continues adding columns on an ultrawide display instead of enlarging eight cards without bounds", () => {
    expect(resolveDesktopFeedColumns(3440)).toBeGreaterThan(8);
    expect(resolveDesktopFeedColumns(5120)).toBeGreaterThan(
      resolveDesktopFeedColumns(3440),
    );
  });
  it.each([1, 2, 3])(
    "keeps %s sparse result cards at the ordinary size, starting on the right",
    (count) => {
      const few = layoutDesktopFeed(
        Array.from({ length: count }, () => image(0.4)),
        1440,
      );
      const full = layoutDesktopFeed(
        Array.from({ length: 36 }, () => image(0.4)),
        1440,
      );
      expect(few.positions).toEqual(full.positions.slice(0, count));
      expect(few.positions[0]!.x + few.positions[0]!.width).toBe(1440);
      expect(few.positions[0]!.width).toBe(230);
      expect(few.positions[0]!.height).toBe(575);
      expect(few.positions.at(-1)!.x).toBeGreaterThan(0);
    },
  );
  it("keeps every existing card stable while all subsequent API pages append", () => {
    const items = Array.from({ length: 53 }, (_, index) =>
      image(mixed[index % mixed.length]!),
    );
    for (const width of widths) {
      for (const count of [12, 24, 36]) {
        const old = layoutDesktopFeed(items.slice(0, count), width);
        const next = layoutDesktopFeed(items, width);
        expect(next.positions.slice(0, count)).toEqual(old.positions);
      }
    }
  });
  it("allows natural uneven column bottoms without a stretched final row or filler", () => {
    const layout = assertMasonry(
      [image(1), image(0.5), image(2), text, image(1.6)],
      1050,
    );
    expect(layout.positions).toHaveLength(5);
    expect(
      new Set(layout.positions.map((p) => p.y + p.height)).size,
    ).toBeGreaterThan(1);
  });
  it("keeps a complete text-only sequence as real vertical excerpt cards", () => {
    const positions = assertMasonry(
      Array.from({ length: 24 }, () => text),
      1440,
    ).positions;
    expect(positions.every((p) => p.mediaWidth === 0 && p.height === 240)).toBe(
      true,
    );
  });
  it("retains the bounded extreme preview hint while an explicit contain intent wins", () => {
    const cropped = layoutDesktopFeed([image(0.4)], 896).positions[0]!;
    expect(cropped.height).toBe(720);
    expect(cropped.cropped).toBe(true);
    const contained = desktopFeedMedia({
      media: { width: 100, height: 2000, feed: { fit: "contain" } },
    });
    const whole = layoutDesktopFeed([contained], 896).positions[0]!;
    expect(whole.height).toBe(720);
    expect(whole.preserveContain).toBe(true);
    expect(whole.cropped).toBe(false);
    expect(whole.mediaWidth).toBe(cropped.mediaWidth);
  });
  it.each([1, 32, 96, 144, 320])(
    "keeps transient narrow %spx measurement finite",
    (width) => {
      const layout = layoutDesktopFeed([image(0.4), text, image(2.8)], width);
      layout.positions.forEach((p) => {
        expect(
          Number.isFinite(p.x + p.y + p.width + p.height + p.mediaWidth),
        ).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x + p.width).toBeLessThanOrEqual(width + 0.000001);
        expect(p.width).toBeGreaterThan(0);
      });
    },
  );
  it("handles empty and unavailable dimensions without inventing content", () => {
    expect(layoutDesktopFeed([], 1440)).toEqual({ height: 0, positions: [] });
    expect(layoutDesktopFeed([image(1)], 0)).toEqual({
      height: 0,
      positions: [],
    });
    expect(layoutDesktopFeed([image(1)], Infinity)).toEqual({
      height: 0,
      positions: [],
    });
    expect(desktopFeedMedia({ media: { width: NaN, height: 0 } })).toEqual(
      image(1),
    );
    expect(desktopFeedMedia({ target: { type: "work" }, media: null })).toEqual(
      text,
    );
    expect(
      desktopFeedMedia({ target: { type: "catalog" }, media: null }),
    ).toEqual({ ratio: 1, cropped: false, preserveContain: true });
  });
  it("keeps extreme ratio mapping and explicit author framing unchanged", () => {
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
        media: { width: 0, height: 0, feed: { fit: "contain" } },
      }),
    ).toEqual({ ratio: 1, cropped: false, preserveContain: true });
  });
  it("packs a large sequence with the same ordered per-column invariants", () => {
    assertMasonry(
      Array.from({ length: 1000 }, (_, index) =>
        index % 17 === 0 ? text : image(mixed[index % mixed.length]!),
      ),
      5120,
    );
  });
});
