// @vitest-environment jsdom
import { getInitialCropFromCroppedAreaPercentages } from "react-easy-crop";
import { describe, expect, it } from "vitest";

import { CROP_MAX_ZOOM } from "../authors/crop-gestures";
import {
  cropRatio,
  percentagesFromCrop,
  rotatedSize,
} from "../publishing/ui/media/media-geometry";
import { cropperBox } from "../publishing/ui/phone/edit-stage";
import { CROP_FIELD_INSETS } from "../publishing/ui/phone/stage-frame";
import {
  cropCornerPoint,
  fieldRect,
  fitFrame,
  imageRect,
  intersectRect,
  minimumWindow,
  requiredZoom,
  resizeCropCorner,
  resizeRect,
  seedMaxZoom,
  snapToRatio,
  windowToCrop,
} from "./crop-window";

import type { CropCorner, CropRect } from "./crop-window";
import type { MediaCrop, MediaRotation } from "@moya/contracts";

const frame = { left: 0, top: 0, width: 300, height: 200 };
const roomy = { left: -100, top: -100, width: 500, height: 400 };
const small = { width: 88, height: 88 };

const expectRect = (actual: CropRect, expected: CropRect) => {
  expect(actual.left).toBeCloseTo(expected.left, 6);
  expect(actual.top).toBeCloseTo(expected.top, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
};

describe("resizeRect: a corner moves, the opposite one stays", () => {
  const opposite = (rect: CropRect, corner: CropCorner) => ({
    x: corner.endsWith("e") ? rect.left : rect.left + rect.width,
    y: corner.startsWith("s") ? rect.top : rect.top + rect.height,
  });

  it.each(["nw", "ne", "sw", "se"] as const)(
    "anchors the corner opposite %s",
    (corner) => {
      const delta = {
        x: corner.endsWith("e") ? -40 : 40,
        y: corner.startsWith("s") ? -30 : 30,
      };
      const moved = resizeRect(frame, corner, delta, roomy, small, null);
      expect(opposite(moved, corner)).toEqual(opposite(frame, corner));
      expect(moved.width).toBe(260);
      expect(moved.height).toBe(170);
    },
  );

  it("stays inside its bounds and keeps the minimum without turning inside out", () => {
    // Outward past the bounds: stopped at them.
    expectRect(
      resizeRect(frame, "se", { x: 500, y: 500 }, roomy, small, null),
      { left: 0, top: 0, width: 400, height: 300 },
    );
    expectRect(
      resizeRect(frame, "nw", { x: -500, y: -500 }, roomy, small, null),
      { left: -100, top: -100, width: 400, height: 300 },
    );
    // Past the opposite corner: the minimum, on the anchor's side.
    expectRect(
      resizeRect(frame, "nw", { x: 900, y: 900 }, roomy, small, null),
      { left: 212, top: 112, width: 88, height: 88 },
    );
    expectRect(
      resizeRect(frame, "se", { x: -900, y: -900 }, roomy, small, null),
      { left: 0, top: 0, width: 88, height: 88 },
    );
  });

  it("keeps a locked ratio whichever way the finger strays", () => {
    const portrait = { left: 0, top: 0, width: 160, height: 200 };
    const ratio = 0.8;
    // Inward, outward and a skewed drag: the shape holds, the anchor stays.
    for (const delta of [
      { x: -40, y: -10 },
      { x: 30, y: 30 },
      { x: 60, y: -50 },
    ]) {
      const moved = resizeRect(portrait, "se", delta, roomy, small, ratio);
      expect(moved.width / moved.height).toBeCloseTo(ratio, 9);
      expect(moved.left).toBe(0);
      expect(moved.top).toBe(0);
    }
    // Projected onto the diagonal: a sideways drag grows both edges.
    const sideways = resizeRect(
      portrait,
      "se",
      { x: 41, y: 0 },
      roomy,
      small,
      ratio,
    );
    expect(sideways.width).toBeCloseTo(160 + (41 * 160 * 160) / 65600, 6);
    // The bounds and the minimum hold too, in the ratio.
    const huge = resizeRect(
      portrait,
      "se",
      { x: 900, y: 900 },
      roomy,
      small,
      ratio,
    );
    expect(huge.height).toBeCloseTo(300, 6);
    expect(huge.width).toBeCloseTo(240, 6);
    const tiny = resizeRect(
      portrait,
      "nw",
      { x: 900, y: 900 },
      roomy,
      small,
      ratio,
    );
    expect(tiny.width).toBeCloseTo(88, 6);
    expect(tiny.height).toBeCloseTo(110, 6);
    expect(tiny.left + tiny.width).toBe(160);
    expect(tiny.top + tiny.height).toBe(200);
  });
});

describe("resizeCropCorner: the article crop's corners, in the unit square", () => {
  it("moves each corner freely while anchoring its opposite corner", () => {
    const crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
    expect(resizeCropCorner(crop, "nw", { x: 0.1, y: 0.3 })).toEqual({
      x: 0.1,
      y: 0.3,
      width: 0.7,
      height: 0.5,
    });
    expect(resizeCropCorner(crop, "ne", { x: 0.1, y: 1 })).toEqual({
      x: 0.2,
      y: 0.79,
      width: 0.01,
      height: 0.01,
    });
    // Out of the frame: clamped to it; the whole frame is null.
    expect(resizeCropCorner(crop, "se", { x: 2, y: 2 })).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.8,
      height: 0.8,
    });
    expect(
      resizeCropCorner({ x: 0, y: 0, width: 0.5, height: 0.5 }, "se", {
        x: 1,
        y: 1,
      }),
    ).toBe(null);
    expect(cropCornerPoint(crop, "sw")).toEqual({ x: 0.2, y: 0.8 });
  });
});

describe("the window over the photo the cropper shows", () => {
  const size = { width: 300, height: 200 };

  it("places the whole edited frame from the area the frame shows", () => {
    expectRect(imageRect(size, null), frame);
    // The middle half of the width, the top two thirds.
    const shown = { x: 0.25, y: 0, width: 0.5, height: 2 / 3 };
    expectRect(imageRect(size, shown), {
      left: -150,
      top: 0,
      width: 600,
      height: 300,
    });
  });

  it("finds the crop field and where a drag may go", () => {
    // A 300 × 200 frame centred on a 400 × 600 stage, 60 / 16 off its edges.
    const field = fieldRect(
      size,
      { width: 400, height: 600 },
      CROP_FIELD_INSETS,
    );
    expect(field).toEqual({ left: -34, top: -140, width: 368, height: 480 });
    expectRect(
      intersectRect(
        imageRect(size, { x: 0.25, y: 0, width: 0.5, height: 1 }),
        field,
      ),
      { left: -34, top: 0, width: 368, height: 200 },
    );
    expect(
      intersectRect(frame, { left: 400, top: 0, width: 10, height: 10 }),
    ).toEqual({ left: 400, top: 0, width: 0, height: 10 });
    // 88px, or a tenth of the photo where that is more.
    expect(
      minimumWindow({ left: 0, top: 0, width: 2000, height: 600 }),
    ).toEqual({ width: 200, height: 88 });
  });

  it("maps a window to a crop of the edited frame through the shown area", () => {
    expect(windowToCrop(frame, size, null)).toBe(null);
    const shown = { x: 0.2, y: 0.1, width: 0.5, height: 0.6 };
    expect(windowToCrop(frame, size, shown)).toEqual(shown);
    expect(
      windowToCrop({ left: 30, top: 50, width: 150, height: 100 }, size, shown),
    ).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.3 });
    // Rounded as stored, the whole frame within tolerance null.
    expect(
      windowToCrop(
        { left: 0.1, top: 0, width: 299.8, height: 200 },
        size,
        null,
      ),
    ).toBe(null);
  });

  it("snaps a locked window to the exact ratio about its centre, inside the frame", () => {
    const source = { width: 4000, height: 3000 };
    const snapped = snapToRatio(
      { x: 0.2, y: 0, width: 0.6003, height: 1 },
      0.8,
      source,
    )!;
    expect((snapped.width * 4000) / (snapped.height * 3000)).toBeCloseTo(
      0.8,
      5,
    );
    expect(snapped.x + snapped.width / 2).toBeCloseTo(0.50015, 5);
    expect(snapped.height).toBe(1);
    // Taller than the ratio: the height gives way.
    const tall = snapToRatio(
      { x: 0, y: 0.5, width: 0.3, height: 0.5 },
      1,
      source,
    )!;
    expect(tall.width * 4000).toBeCloseTo(tall.height * 3000, 3);
    expect(tall.y + tall.height).toBeLessThanOrEqual(1);
  });

  it("fits the largest frame of a ratio into the field", () => {
    expect(fitFrame({ width: 358, height: 480 }, 4 / 3)).toEqual({
      width: 358,
      height: 268.5,
    });
    expect(fitFrame({ width: 358, height: 480 }, 0.5)).toEqual({
      width: 240,
      height: 480,
    });
  });
});

describe("the zoom a seed needs", () => {
  const frame43 = { width: 4000, height: 3000 };

  it("is min(1 / width, 1 / height) for a crop of the cropper's shape", () => {
    for (const crop of [
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      { x: 0, y: 0, width: 0.5, height: 0.25 },
      { x: 0.1, y: 0.3, width: 0.3, height: 0.6 },
    ]) {
      const ratio = cropRatio(crop, frame43);
      expect(requiredZoom(crop, ratio, frame43)).toBeCloseTo(
        Math.min(1 / crop.width, 1 / crop.height),
        9,
      );
    }
    expect(requiredZoom(null, 4 / 3, frame43)).toBe(1);
  });

  it("lets a small seed reopen as it was, and never asks less than the shared 3×", () => {
    const crop = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
    const ratio = cropRatio(crop, frame43);
    expect(seedMaxZoom(crop, ratio, frame43)).toBeGreaterThan(5);
    expect(seedMaxZoom(crop, ratio, frame43)).toBeCloseTo(5, 3);
    expect(seedMaxZoom(null, 4 / 3, frame43)).toBe(CROP_MAX_ZOOM);
    expect(
      seedMaxZoom({ x: 0, y: 0, width: 0.5, height: 1 }, 2 / 3, frame43),
    ).toBe(CROP_MAX_ZOOM);
    // The contract's smallest crop bounds it.
    const least = { x: 0, y: 0, width: 0.001, height: 0.001 };
    expect(seedMaxZoom(least, cropRatio(least, frame43), frame43)).toBe(100);
  });
});

/**
 * react-easy-crop's own model of what its frame shows (6.2.3,
 * `getCropSize` and `computeCroppedArea`), with the real
 * `getInitialCropFromCroppedAreaPercentages` seeding it: the stage's crops
 * reopen exactly as made, whatever the quarter turn.
 */
describe("round trip through react-easy-crop", () => {
  const source = { width: 4000, height: 3000 };
  const stageSize = { width: 390, height: 600 };
  const field = {
    width: stageSize.width - 2 * CROP_FIELD_INSETS.inline,
    height: stageSize.height - 2 * CROP_FIELD_INSETS.block,
  };
  const turnedSize = (width: number, height: number, rotation: number) =>
    rotation % 180 === 0 ? { width, height } : { width: height, height: width };

  /** The cropper laid out in the stage's box for `ratio`, as the library measures it. */
  const layOut = (ratio: number, rotation: MediaRotation) => {
    const box = cropperBox(
      stageSize,
      ratio,
      rotatedSize(source, rotation),
      rotation % 180 !== 0,
      CROP_FIELD_INSETS,
    )!;
    // `contain`: the unturned source fitted into the box.
    const aspect = source.width / source.height;
    const media =
      box.width / box.height > aspect
        ? { width: box.height * aspect, height: box.height }
        : { width: box.width, height: box.width / aspect };
    const bbox = turnedSize(media.width, media.height, rotation);
    const fitting = {
      width: Math.min(bbox.width, box.width),
      height: Math.min(bbox.height, box.height),
    };
    const cropSize =
      fitting.width > fitting.height * ratio
        ? { width: fitting.height * ratio, height: fitting.height }
        : { width: fitting.width, height: fitting.width / ratio };
    return {
      media: {
        ...media,
        naturalWidth: source.width,
        naturalHeight: source.height,
      },
      bbox,
      cropSize,
    };
  };
  /** What the frame shows at `crop` and `zoom` (the library's percentages). */
  const shownArea = (
    bbox: { width: number; height: number },
    cropSize: { width: number; height: number },
    position: { x: number; y: number },
    zoom: number,
  ): MediaCrop => ({
    x:
      ((bbox.width - cropSize.width / zoom) / 2 - position.x / zoom) /
      bbox.width,
    y:
      ((bbox.height - cropSize.height / zoom) / 2 - position.y / zoom) /
      bbox.height,
    width: cropSize.width / bbox.width / zoom,
    height: cropSize.height / bbox.height / zoom,
  });
  const expectClose = (actual: MediaCrop, expected: MediaCrop) => {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
    expect(actual.width).toBeCloseTo(expected.width, 6);
    expect(actual.height).toBeCloseTo(expected.height, 6);
  };
  /** Seeds a cropper of the crop's own shape with it, as a reframe does. */
  const seed = (crop: MediaCrop, rotation: MediaRotation) => {
    const edited = rotatedSize(source, rotation);
    const ratio = cropRatio(crop, edited);
    const { media, bbox, cropSize } = layOut(ratio, rotation);
    // The box makes the cropper's frame the largest of its ratio in the field.
    expect(cropSize.width).toBeCloseTo(fitFrame(field, ratio).width, 6);
    expect(cropSize.height).toBeCloseTo(fitFrame(field, ratio).height, 6);
    const maxZoom = seedMaxZoom(crop, ratio, edited);
    const { crop: position, zoom } = getInitialCropFromCroppedAreaPercentages(
      percentagesFromCrop(crop),
      media,
      rotation,
      cropSize,
      1,
      maxZoom,
    );
    expect(zoom).toBeCloseTo(requiredZoom(crop, ratio, edited), 9);
    expect(zoom).toBeCloseTo(Math.min(1 / crop.width, 1 / crop.height), 6);
    expect(zoom).toBeLessThanOrEqual(maxZoom);
    return { bbox, cropSize, position, zoom };
  };

  it.each([0, 90, 180, 270] as const)(
    "reopens a free crop as made and maps a window over it, turned %i°",
    (rotation) => {
      const made = { x: 0.31, y: 0.22, width: 0.27, height: 0.41 };
      const { bbox, cropSize, position, zoom } = seed(made, rotation);
      const shown = shownArea(bbox, cropSize, position, zoom);
      expectClose(shown, made);
      // Where the whole edited frame lies on screen, from the library's
      // placement: the turned frame centred, moved and zoomed.
      const placed = imageRect(cropSize, shown);
      expect(placed.left).toBeCloseTo(
        position.x - (bbox.width * zoom) / 2 + cropSize.width / 2,
        6,
      );
      expect(placed.top).toBeCloseTo(
        position.y - (bbox.height * zoom) / 2 + cropSize.height / 2,
        6,
      );
      expect(placed.width).toBeCloseTo(bbox.width * zoom, 6);
      // A window drawn over that frame becomes the crop it covers, and the
      // next cropper, seeded with it, shows exactly it.
      const window = {
        left: cropSize.width * 0.1,
        top: cropSize.height * 0.2,
        width: cropSize.width * 0.5,
        height: cropSize.height * 0.6,
      };
      const next = windowToCrop(window, cropSize, shown)!;
      expectClose(next, {
        x: made.x + 0.1 * made.width,
        y: made.y + 0.2 * made.height,
        width: 0.5 * made.width,
        height: 0.6 * made.height,
      });
      const again = seed(next, rotation);
      expectClose(
        shownArea(again.bbox, again.cropSize, again.position, again.zoom),
        next,
      );
    },
  );

  it("reopens a crop that needs more than 3× at its own zoom, not clamped larger", () => {
    const made = { x: 0.45, y: 0.45, width: 0.12, height: 0.12 };
    const { bbox, cropSize, position, zoom } = seed(made, 0);
    expect(zoom).toBeGreaterThan(CROP_MAX_ZOOM);
    expectClose(shownArea(bbox, cropSize, position, zoom), made);
  });
});
