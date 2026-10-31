import { describe, expect, it } from "vitest";
import { desktopLayout } from "@moya/design-tokens";
import {
  desktopFeedIdealSize,
  desktopFeedMedia,
  desktopFeedTargetArea,
  layoutDesktopFeed,
} from "./desktop-feed-layout";
import type { DesktopFeedMedia } from "./desktop-feed-layout";

const gap = 16;
const epsilon = 0.000001;
const image = (
  ratio: number,
  framing: Partial<DesktopFeedMedia> = {},
): DesktopFeedMedia => ({ ratio, cropped: false, ...framing });
const text: DesktopFeedMedia = { ratio: null, cropped: false };

const assertGeometry = (items: readonly DesktopFeedMedia[], width: number) => {
  const before = structuredClone(items);
  const layout = layoutDesktopFeed(items, width);
  // Array iteration must expose holes, rather than silently skipping them.
  const positions = Array.from(layout.positions);
  expect(positions).toHaveLength(items.length);
  expect(positions.every((position) => position !== undefined)).toBe(true);
  expect(positions.map((position) => position.ratio)).toEqual(
    items.map((item) => item.ratio),
  );
  const levels = new Map<number, typeof positions>();
  for (const [index, position] of positions.entries()) {
    expect(
      Number.isFinite(
        position.x +
          position.y +
          position.width +
          position.height +
          position.mediaWidth,
      ),
    ).toBe(true);
    expect(position.width).toBeGreaterThan(0);
    expect(position.height).toBeGreaterThan(0);
    expect(position.x).toBeGreaterThanOrEqual(-epsilon);
    expect(position.x + position.width).toBeLessThanOrEqual(width + epsilon);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.mediaWidth).toBeGreaterThanOrEqual(0);
    if (index > 0)
      expect(position.y).toBeGreaterThanOrEqual(positions[index - 1]!.y);
    levels.set(position.y, [...(levels.get(position.y) ?? []), position]);
    for (const earlier of positions.slice(0, index))
      expect(
        position.x + position.width + gap <= earlier.x + epsilon ||
          earlier.x + earlier.width + gap <= position.x + epsilon ||
          position.y + position.height + gap <= earlier.y + epsilon ||
          earlier.y + earlier.height + gap <= position.y + epsilon,
      ).toBe(true);
    if (items[index]!.ratio === null) {
      expect(position.mediaWidth).toBe(0);
      expect(position.cropped).toBe(false);
    } else if (
      !items[index]!.authorCover ||
      items[index]!.preserveContain ||
      position.paired
    ) {
      // A shared pair frame or bounded extreme frame may letterbox its full
      // original. Its source ratio stays separate and its native fit is contain.
      expect(position.cropped).toBe(false);
    } else if (position.cropped) {
      expect(position.mediaWidth / position.height).toBeGreaterThan(
        items[index]!.ratio!,
      );
    }
  }
  for (const level of levels.values())
    for (let index = 1; index < level.length; index += 1)
      expect(level[index]!.x + level[index]!.width + gap).toBeLessThanOrEqual(
        level[index - 1]!.x + epsilon,
      );
  expect(layout.height).toBeCloseTo(
    Math.max(0, ...positions.map((position) => position.y + position.height)),
    8,
  );
  expect(items).toEqual(before);
  return layout;
};

describe("desktop complete-image source-order mosaic", () => {
  it.each(
    [
      1, 32, 144, 320, 650, 704, 896, 1024, 1440, 1920, 2560, 3440, 5120,
    ].flatMap((width) =>
      [1, 2, 3, 12, 24, 62].map((count) => [width, count] as const),
    ),
  )(
    "keeps mixed source geometry finite, ordered and separated at %spx/%srecords",
    (width, count) => {
      const ratios = [0.05, 0.45, 0.667, 1, 1.333, 1.776, 4];
      const items = Array.from({ length: count }, (_, index) =>
        index % 11 === 10 ? text : image(ratios[index % ratios.length]!),
      );
      assertGeometry(items, width);
    },
  );
  it("uses additional portrait groups on an ultra-wide canvas instead of an eight-column ceiling", () => {
    const positions = layoutDesktopFeed(
      Array.from({ length: 40 }, () => image(0.45)),
      5120,
    ).positions;
    expect(
      positions.filter((position) => position.y === 0).length,
    ).toBeGreaterThan(8);
    expect(positions[0]!.x + positions[0]!.width).toBeCloseTo(5120, 8);
  });
  it("keeps every record defined and bounded in a long loaded feed", () => {
    const items = Array.from({ length: 1000 }, (_, index) =>
      image(index % 3 === 0 ? 0.45 : 1.5),
    );
    const result = layoutDesktopFeed(items, 5120);
    expect(Array.from(result.positions)).toHaveLength(1000);
    expect(
      result.positions.every(
        (position) =>
          position.height > 0 &&
          position.height <= 640 &&
          Number.isFinite(
            position.x + position.y + position.width + position.height,
          ),
      ),
    ).toBe(true);
    expect(result.positions.every((position) => !position.cropped)).toBe(true);
  });
  it("uses the frozen mosaic dimensions and bounded grouping policy", () => {
    expect(desktopLayout.feed).toMatchObject({
      labelWidth: 96,
      gap: 16,
      rowGap: 16,
      cardRadius: 18,
      captionTitleMin: 16,
      captionTitleMax: 20,
      captionSuffix: 11,
      rowHeight: 240,
      textWidth: 232,
      mosaicTargetHeight: 500,
      mosaicMinBandHeight: 340,
      mosaicMaxBandHeight: 640,
      mosaicTargetArea: 150000,
      mosaicMaxTop: 16,
      mosaicPairCandidates: 8,
      mosaicMaxPairs: 4,
    });
    expect(desktopFeedTargetArea()).toBe(150000);
  });
  it("gives every selected pair a complete two-level box without moving source indices", () => {
    const positions = assertGeometry(
      [image(1.776), image(0.45), image(0.666), image(1.5)],
      1200,
    ).positions;
    const first = positions[0]!;
    const bottom = positions[3]!;
    expect(positions.map((position) => position.paired)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(positions.map((position) => position.cropped)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(first.x).toBeCloseTo(bottom.x, 8);
    expect(first.width).toBeCloseTo(bottom.width, 8);
    expect(first.height).toBeCloseTo(bottom.height, 8);
    expect(bottom.y).toBeCloseTo(first.y + first.height + gap, 8);
    expect(first.width).toBeCloseTo(460.158096, 5);
    expect(first.height).toBeCloseTo(223.111964, 5);
    expect(positions[1]!.height).toBeCloseTo(first.height * 2 + gap, 8);
    expect(positions[2]!.height).toBeCloseTo(positions[1]!.height, 8);
    expect(positions[0]!.ratio).toBe(1.776);
    expect(positions[3]!.ratio).toBe(1.5);
    expect(first.mediaWidth / first.height).not.toBeCloseTo(first.ratio!, 3);
  });
  it("shares truthful complete/cover/contain fits with the unmeasured fallback", () => {
    const complete = desktopFeedMedia({ media: { width: 100, height: 2000 } });
    const cover = desktopFeedMedia({
      media: { width: 100, height: 2000, feed: { fit: "cover", y: 0 } },
    });
    const contained = desktopFeedMedia({
      media: { width: 100, height: 2000, feed: { fit: "contain" } },
    });
    expect(desktopFeedIdealSize(complete, 1440).cropped).toBe(false);
    expect(desktopFeedIdealSize(cover, 1440).cropped).toBe(true);
    expect(desktopFeedIdealSize(contained, 1440).cropped).toBe(false);
    expect(
      desktopFeedIdealSize({ ...cover, preserveContain: true }, 1440).cropped,
    ).toBe(false);
    expect(desktopFeedIdealSize(text, 1440)).toMatchObject({
      width: 232,
      height: 240,
      mediaWidth: 0,
      cropped: false,
    });
  });
  it("keeps true text independent while preserving missing Catalog identity", () => {
    const work = desktopFeedMedia({ target: { type: "work" }, media: null });
    const catalog = desktopFeedMedia({
      target: { type: "catalog" },
      media: null,
    });
    expect(work).toMatchObject({ ratio: null, cropped: false });
    expect(catalog).toMatchObject({
      cropped: false,
      missing: true,
      preserveContain: true,
    });
    const positions = assertGeometry([work, catalog, text], 640).positions;
    expect(positions[0]).toMatchObject({
      width: 232,
      height: 240,
      mediaWidth: 0,
    });
    expect(positions[2]).toMatchObject({
      width: 232,
      height: 240,
      mediaWidth: 0,
    });
    expect(positions[1]!.missing).toBe(true);
    expect(positions[1]!.width).toBeLessThanOrEqual(640);
    expect(positions[2]!.y).toBeGreaterThanOrEqual(
      positions[1]!.y + positions[1]!.height + gap - epsilon,
    );
  });
  it("keeps a missing Catalog solo beside photographs instead of sealing an empty full-width band", () => {
    const missing = desktopFeedMedia({
      target: { type: "catalog" },
      media: null,
    });
    const positions = assertGeometry(
      [image(0.75), missing, image(0.75)],
      1440,
    ).positions;
    expect(positions.every((position) => position.y === 0)).toBe(true);
    expect(positions[1]).toMatchObject({
      missing: true,
      preserveContain: true,
      cropped: false,
      paired: false,
    });
    expect(positions[2]!.x).toBeCloseTo(0, 8);
    expect(positions[0]!.x + positions[0]!.width).toBeCloseTo(1440, 8);
  });
  it("bounds invalid dimensions without inventing cover or losing an output slot", () => {
    const invalid = desktopFeedMedia({
      media: { width: 0, height: 0, feed: { fit: "cover" } },
    });
    expect(invalid).toMatchObject({
      ratio: 1,
      cropped: false,
      preserveContain: true,
    });
    expect(invalid.authorCover).not.toBe(true);
    assertGeometry([invalid, image(1.2)], 1440);
  });
  it("keeps a sparse JavaScript input slot as a truthful bounded missing box", () => {
    const items: DesktopFeedMedia[] = Array(3);
    items[0] = image(1);
    items[2] = image(1.5);
    const positions = Array.from(layoutDesktopFeed(items, 640).positions);
    expect(positions).toHaveLength(3);
    expect(positions.every((position) => position !== undefined)).toBe(true);
    expect(positions[0]!.ratio).toBe(1);
    expect(positions[1]).toMatchObject({
      ratio: 1,
      missing: true,
      preserveContain: true,
      cropped: false,
    });
    expect(positions[1]!.width).toBeLessThanOrEqual(640);
    expect(positions[1]!.height).toBeLessThanOrEqual(640);
    expect(positions[2]!.ratio).toBe(1.5);
    expect(items[1]).toBeUndefined();
  });
  it("keeps sparse extreme previews bounded without changing their source ratio or fit", () => {
    for (const ratio of [0.05, 40]) {
      const position = assertGeometry([image(ratio)], 1440).positions[0]!;
      expect(position.x + position.width).toBeCloseTo(1440, 8);
      expect(position.width).toBeLessThanOrEqual(960);
      expect(position.height).toBeLessThanOrEqual(640);
      expect(position.ratio).toBe(ratio);
      expect(position.cropped).toBe(false);
    }
  });
  it("keeps raw portrait and panorama ratios without manufacturing a default crop", () => {
    const portrait = desktopFeedMedia({ media: { width: 100, height: 2000 } });
    const panorama = desktopFeedMedia({
      representativeMedia: { width: 4000, height: 100 },
    });
    expect(portrait).toMatchObject({ ratio: 0.05, cropped: false });
    expect(panorama).toMatchObject({ ratio: 40, cropped: false });
    expect(portrait.authorCover).not.toBe(true);
    expect(panorama.authorCover).not.toBe(true);
    assertGeometry([portrait, panorama, image(1), image(0.6)], 1920);
  });
  it("does not turn an ordinary unframed tall image into an authored cover", () => {
    const media = desktopFeedMedia({ media: { width: 900, height: 1600 } });
    expect(media.cropped).toBe(false);
    expect(media.authorCover).not.toBe(true);
    assertGeometry([media, image(1.6), image(1)], 1440);
  });
  it("requires canonical tall-image eligibility even when cover was saved", () => {
    const nearTall = desktopFeedMedia({
      media: { width: 800, height: 960, feed: { fit: "cover", y: 0 } },
    });
    const nearBoundary = desktopFeedMedia({
      media: { width: 1000, height: 1250.5, feed: { fit: "cover", y: 1 } },
    });
    expect(nearTall.authorCover).not.toBe(true);
    expect(nearBoundary.authorCover).not.toBe(true);
    assertGeometry([nearTall, nearBoundary, image(1.5)], 1440);
  });
  it("permits only an explicit eligible author cover and leaves its saved framing untouched", () => {
    const source = {
      media: { width: 100, height: 2000, feed: { fit: "cover", y: 0.23 } },
    };
    const before = structuredClone(source);
    const media = desktopFeedMedia(source);
    expect(media).toMatchObject({
      ratio: 0.05,
      cropped: false,
      authorCover: true,
    });
    const position = assertGeometry([media], 1440).positions[0]!;
    expect(position.ratio).toBe(0.05);
    expect(position.cropped).toBe(true);
    expect(position.mediaWidth / position.height).toBeGreaterThan(0.05);
    expect(source).toEqual(before);
  });
  it("keeps saved contain authoritative for an extreme original", () => {
    const media = desktopFeedMedia({
      media: { width: 100, height: 2000, feed: { fit: "contain" } },
    });
    expect(media).toMatchObject({
      ratio: 0.05,
      cropped: false,
      preserveContain: true,
    });
    expect(media.authorCover).not.toBe(true);
    assertGeometry([media, image(1.6)], 1440);
  });
  it("keeps every mixed input position defined, complete and in its actual reading order", () => {
    assertGeometry(
      [image(0.45), image(1.8), image(2.2), image(0.6), image(1.5), image(1)],
      1920,
    );
  });
  it("keeps pure-text records as bounded consecutive real text rows", () => {
    const layout = assertGeometry([text, text, text], 640);
    expect(
      layout.positions.map(({ width, height, mediaWidth }) => ({
        width,
        height,
        mediaWidth,
      })),
    ).toEqual([
      { width: 232, height: 240, mediaWidth: 0 },
      { width: 232, height: 240, mediaWidth: 0 },
      { width: 232, height: 240, mediaWidth: 0 },
    ]);
    expect(layout.positions.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 408, y: 0 },
      { x: 160, y: 0 },
      { x: 408, y: 256 },
    ]);
  });
  it("keeps real text between image groups instead of dropping its position", () => {
    const positions = assertGeometry(
      [image(1), text, text, image(1.2)],
      1440,
    ).positions;
    expect(positions[1]!.y).toBeGreaterThanOrEqual(
      positions[0]!.y + positions[0]!.height + gap - epsilon,
    );
    expect(positions[2]!.y).toBe(positions[1]!.y);
    expect(positions[3]!.y).toBeGreaterThanOrEqual(
      positions[1]!.y + 240 + gap - epsilon,
    );
  });
  it("returns no invented content for empty or unavailable host dimensions", () => {
    expect(layoutDesktopFeed([], 1440)).toEqual({ height: 0, positions: [] });
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(layoutDesktopFeed([image(1)], width)).toEqual({
        height: 0,
        positions: [],
      });
  });
});
