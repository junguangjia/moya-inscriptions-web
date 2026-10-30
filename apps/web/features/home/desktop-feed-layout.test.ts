import { describe, expect, it } from "vitest";
import { desktopLayout } from "@moya/design-tokens";
import { desktopFeedMedia, layoutDesktopFeed } from "./desktop-feed-layout";
import type {
  DesktopFeedMedia,
  DesktopFeedPosition,
} from "./desktop-feed-layout";

const image = (ratio: number): DesktopFeedMedia => ({ ratio, cropped: false });
const text: DesktopFeedMedia = { ratio: null, cropped: false };
const widths = [1024, 1440, 3440, 5120];
const counts = [1, 2, 3, 11, 12, 13, 23, 24, 36, 53];
const mixed = [0.4, 2.8, 0.5, 1, 1.6, 0.6, 2.8, 0.625, 2.4, 1, 0.65];
const rows = (positions: readonly DesktopFeedPosition[]) => {
  const result: DesktopFeedPosition[][] = [];
  for (const position of positions) {
    if (result.at(-1)?.[0]?.y !== position.y) result.push([]);
    result.at(-1)!.push(position);
  }
  return result;
};
const expectCompleteRows = (
  items: readonly DesktopFeedMedia[],
  width: number,
) => {
  const layout = layoutDesktopFeed(items, width);
  expect(layout.positions).toHaveLength(items.length);
  expect(layout.positions.map(({ ratio }) => ratio)).toEqual(
    items.map(({ ratio }) => ratio),
  );
  const grouped = rows(layout.positions);
  grouped.forEach((row, rowIndex) => {
    expect(row[0]!.x + row[0]!.width).toBeCloseTo(width, 6);
    expect(row.at(-1)!.x).toBeCloseTo(0, 6);
    row.forEach((position, index) => {
      expect(Number.isFinite(position.height)).toBe(true);
      expect(position.height).toBeGreaterThan(0);
      expect(position.height).toBeLessThanOrEqual(720);
      expect(position.height).toBe(row[0]!.height);
      expect(position.width).toBeGreaterThan(0);
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x + position.width).toBeLessThanOrEqual(width + 0.000001);
      if (position.ratio !== null) {
        const naturalHeight = position.mediaWidth / position.ratio;
        if (naturalHeight > 720 + 0.000001) {
          expect(position.height).toBe(720);
          expect(position.cropped).toBe(!position.preserveContain);
        } else expect(naturalHeight).toBeCloseTo(position.height, 8);
        expect(position.width - position.mediaWidth).toBeCloseTo(72, 8);
      } else expect(position.mediaWidth).toBe(0);
      if (index > 0)
        expect(row[index - 1]!.x - position.x - position.width).toBeCloseTo(
          12,
          6,
        );
    });
    if (rowIndex > 0) {
      const previous = grouped[rowIndex - 1]![0]!;
      expect(row[0]!.y - previous.y - previous.height).toBeCloseTo(16, 6);
    }
  });
  expect(layout.height).toBeCloseTo(
    grouped.at(-1)![0]!.y + grouped.at(-1)![0]!.height,
    6,
  );
  return grouped;
};

describe("desktop globally justified source-order rows", () => {
  it("uses the shared fine gutters", () => {
    expect(desktopLayout.feed.gap).toBe(12);
    expect(desktopLayout.feed.rowGap).toBe(16);
  });
  it.each(
    widths.flatMap((width) => counts.map((count) => [width, count] as const)),
  )(
    "fills both edges of every mixed row at %spx with %s source records",
    (width, count) => {
      const items = Array.from({ length: count }, (_, index) =>
        image(mixed[index % mixed.length]!),
      );
      const source = structuredClone(items);
      expectCompleteRows(items, width);
      expect(items).toEqual(source);
    },
  );
  it.each(widths)(
    "fills portrait and text-only pages, including sparse pages at %spx",
    (width) => {
      for (const count of counts) {
        expectCompleteRows(
          Array.from({ length: count }, () => image(0.4)),
          width,
        );
        expectCompleteRows(
          Array.from({ length: count }, () => text),
          width,
        );
      }
    },
  );
  it("rebalances earlier row breaks to avoid a short terminal band", () => {
    const grouped = expectCompleteRows(
      Array.from({ length: 53 }, () => image(0.5)),
      3440,
    );
    expect(grouped).toHaveLength(3);
    expect(grouped.map((row) => row.length).sort((a, b) => a - b)).toEqual([
      17, 18, 18,
    ]);
    grouped.forEach((row) => {
      expect(row[0]!.height).toBeGreaterThanOrEqual(200);
      expect(row[0]!.height).toBeLessThanOrEqual(300);
    });
    expect(
      Math.max(...grouped.map((row) => row[0]!.height)) -
        Math.min(...grouped.map((row) => row[0]!.height)),
    ).toBeLessThan(30);
  });
  it("chooses a globally readable partition instead of a locally attractive but short tail", () => {
    const grouped = expectCompleteRows(
      Array.from({ length: 13 }, () => image(0.5)),
      1440,
    );
    expect(grouped.map((row) => row.length).sort()).toEqual([6, 7]);
    grouped.forEach((row) => {
      expect(row[0]!.height).toBeGreaterThanOrEqual(160);
      expect(row[0]!.height).toBeLessThanOrEqual(360);
    });
  });
  it("does not prune a legal short row at the old soft-height candidate boundary", () => {
    const before = expectCompleteRows(
      Array.from({ length: 36 }, () => image(0.4)),
      5120,
    );
    const after = expectCompleteRows(
      Array.from({ length: 37 }, () => image(0.4)),
      5120,
    );
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]![0]!.height).toBeCloseTo(
      (5120 - 37 * 72 - 36 * 12) / (37 * 0.4),
    );
    expect(after[0]![0]!.height).toBeLessThan(before[0]![0]!.height);
  });
  it("uses a soft height when no preferred-height mixed partition can fill", () => {
    const grouped = expectCompleteRows([0.4, 2.8, 2.8].map(image), 1296);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]![0]!.height).toBeCloseTo(176);
  });
  it("prefers two readable landscape rows to an undersized complete row", () => {
    const grouped = expectCompleteRows([image(2.8), image(2.8)], 1024);
    expect(grouped).toHaveLength(2);
    grouped.forEach((row) => expect(row[0]!.height).toBe(340));
  });
  it("uses an explicitly cropped bounded feature for a lone portrait without stretching image pixels", () => {
    const item = image(0.4);
    const grouped = expectCompleteRows([item], 1440);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toHaveLength(1);
    expect(grouped[0]![0]!.height).toBe(720);
    expect(grouped[0]![0]!.mediaWidth).toBe(1368);
    expect(grouped[0]![0]!.cropped).toBe(true);
  });
  it("bounds sparse portraits in full-width cards and exposes the existing crop indication", () => {
    const grouped = expectCompleteRows(
      [image(0.4), image(0.4), image(0.4)],
      5120,
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]![0]!.height).toBe(720);
    grouped[0]!.forEach((position) => expect(position.cropped).toBe(true));
  });
  it("preserves an explicit keep-whole choice within the bounded full-width sparse card", () => {
    const item = desktopFeedMedia({
      media: { width: 400, height: 1000, feed: { fit: "contain" } },
    });
    const grouped = expectCompleteRows([item], 5120);
    expect(grouped[0]![0]!.height).toBe(720);
    expect(grouped[0]![0]!.mediaWidth).toBe(5048);
    expect(grouped[0]![0]!.preserveContain).toBe(true);
    expect(grouped[0]![0]!.cropped).toBe(false);
  });
  it("keeps an explicit contain choice authoritative even when dimensions need a safe fallback", () => {
    const item = desktopFeedMedia({
      media: { width: 0, height: 0, feed: { fit: "contain" } },
    });
    const grouped = expectCompleteRows([item], 1440);
    expect(grouped[0]![0]!.ratio).toBe(1);
    expect(grouped[0]![0]!.height).toBe(720);
    expect(grouped[0]![0]!.cropped).toBe(false);
  });
  it("does not invent a crop when a proportional sparse feature fits below the cap", () => {
    const grouped = expectCompleteRows([image(2.8)], 1440);
    expect(grouped[0]![0]!.height).toBeCloseTo(1368 / 2.8);
    expect(grouped[0]![0]!.cropped).toBe(false);
  });
  it("gives a sparse text-only row the real available width without fabricating media", () => {
    const grouped = expectCompleteRows([text], 5120);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]![0]!.width).toBe(5120);
    expect(grouped[0]![0]!.height).toBe(240);
    expect(grouped[0]![0]!.mediaWidth).toBe(0);
  });
  it("keeps text-only row widths bounded when enough excerpts exist", () => {
    const grouped = expectCompleteRows(
      Array.from({ length: 11 }, () => text),
      900,
    );
    expect(grouped.length).toBeGreaterThan(1);
    grouped.flat().forEach((position) => {
      expect(position.width).toBeGreaterThanOrEqual(232 * 0.85);
      expect(position.width).toBeLessThanOrEqual(232 * 1.35);
    });
  });
  it("preserves source order and framing while balancing media beside genuine text posts", () => {
    const items = Array.from({ length: 53 }, (_, index) =>
      index % 5 === 0 ? text : image(mixed[index % mixed.length]!),
    );
    expectCompleteRows(items, 1440);
  });
  it("keeps every row in the preferred or soft band whenever any complete ordered partition can", () => {
    const feasible = (
      items: readonly DesktopFeedMedia[],
      width: number,
      minimum: number,
      maximum: number,
    ) => {
      const answers = new Map<number, boolean>();
      const visit = (offset: number): boolean => {
        if (offset === items.length) return true;
        if (answers.has(offset)) return answers.get(offset)!;
        let ratio = 0;
        for (let end = offset + 1; end <= items.length; end++) {
          ratio += items[end - 1]!.ratio!;
          const count = end - offset;
          const height = (width - count * 72 - (count - 1) * 12) / ratio;
          if (height >= minimum && height <= maximum && visit(end)) {
            answers.set(offset, true);
            return true;
          }
        }
        answers.set(offset, false);
        return false;
      };
      return visit(0);
    };
    for (const width of widths) {
      for (let seed = 0; seed < 24; seed++) {
        const items = Array.from({ length: 9 }, (_, index) =>
          image(mixed[(seed * 3 + index * 7) % mixed.length]!),
        );
        const grouped = rows(layoutDesktopFeed(items, width).positions);
        for (const [minimum, maximum] of [
          [160, 360],
          [200, 300],
        ] as const)
          if (feasible(items, width, minimum, maximum))
            grouped.forEach((row) => {
              expect(row[0]!.height).toBeGreaterThanOrEqual(minimum - 0.000001);
              expect(row[0]!.height).toBeLessThanOrEqual(maximum + 0.000001);
            });
      }
    }
  });
  it("handles a large sequence with bounded candidate rows and no accumulated left-edge error", () => {
    const items = Array.from({ length: 1000 }, (_, index) =>
      index % 17 === 0 ? text : image(mixed[index % mixed.length]!),
    );
    const grouped = expectCompleteRows(items, 5120);
    expect(grouped.length).toBeGreaterThan(1);
    grouped.forEach((row) => {
      expect(row[0]!.height).toBeGreaterThanOrEqual(160);
      expect(row[0]!.height).toBeLessThanOrEqual(360);
    });
  });
  it("sanitizes dimensions and distinguishes absent covers from text-only works", () => {
    expect(desktopFeedMedia({ media: { width: NaN, height: 0 } })).toEqual(
      image(1),
    );
    expect(
      desktopFeedMedia({ target: { type: "catalog" }, media: null }),
    ).toEqual({ ...image(1), preserveContain: true });
    expect(desktopFeedMedia({ target: { type: "work" }, media: null })).toEqual(
      text,
    );
    expect(layoutDesktopFeed([image(1)], 0).positions).toEqual([]);
    expect(layoutDesktopFeed([image(1)], Infinity).positions).toEqual([]);
    expect(layoutDesktopFeed([], 1440).height).toBe(0);
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
    ).toEqual({ ratio: 0.4, cropped: false, preserveContain: true });
  });
  it("does not promise a cropped full-image preview for a missing Catalog image", () => {
    const missing = desktopFeedMedia({ target: { type: "catalog" } });
    const result = layoutDesktopFeed([missing], 1440).positions[0]!;
    expect(result.x).toBeCloseTo(0);
    expect(result.width).toBeCloseTo(1440);
    expect(result.cropped).toBe(false);
  });
});
