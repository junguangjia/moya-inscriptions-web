import { CROP_MAX_ZOOM } from "../authors/crop-gestures";
import {
  CROP_MINIMUM,
  normalizeCrop,
} from "../publishing/ui/media/media-geometry";

import type { Size } from "../publishing/ui/media/media-geometry";
import type { MediaCrop } from "@moya/contracts";

/**
 * Corner-handle crop geometry (#341), shared by the phone 编辑 stage and the
 * article crop: a window resized from one corner while the opposite corner
 * stays put, and how a window drawn over the photo a cropper shows maps back
 * to a crop of the edited frame.
 *
 * A window is a rectangle in the pixels of the cropper's frame (origin at
 * the frame's top-left), or in the unit square for a stored crop. The
 * cropper shows the edited frame axis-aligned whatever its quarter turn
 * (react-easy-crop measures its area in the turned frame), so none of this
 * depends on the rotation.
 */

export type CropCorner = "nw" | "ne" | "sw" | "se";

export interface CropPoint {
  readonly x: number;
  readonly y: number;
}

export interface CropRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Room taken off each side of a stage: `block` top and bottom, `inline` left and right. */
export interface CropInset {
  readonly block: number;
  readonly inline: number;
}

/**
 * The smallest window a drag leaves on screen: two 44px handles side by
 * side never overlap, and every edge keeps a tenth of the photo, so the
 * cropper never needs more than 10× to show it.
 */
export const WINDOW_MINIMUM_PX = 88;
export const WINDOW_MINIMUM_SHARE = 0.1;

const UNIT: CropRect = { left: 0, top: 0, width: 1, height: 1 };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const east = (corner: CropCorner) => corner.endsWith("e");
const south = (corner: CropCorner) => corner.startsWith("s");

/** Where a corner of `crop` sits. */
export const cropCornerPoint = (
  crop: MediaCrop,
  corner: CropCorner,
): CropPoint => ({
  x: crop.x + (east(corner) ? crop.width : 0),
  y: crop.y + (south(corner) ? crop.height : 0),
});

/**
 * `start` with `corner` moved by `delta`: the opposite corner stays where it
 * is, the window stays inside `bounds`, never smaller than `minimum` and
 * never turned inside out. With a `ratio` (width / height, the shape of
 * `start`) the drag is projected onto the window's diagonal, so the shape
 * holds however the finger strays.
 */
export const resizeRect = (
  start: CropRect,
  corner: CropCorner,
  delta: CropPoint,
  bounds: CropRect,
  minimum: Size,
  ratio: number | null,
): CropRect => {
  const sx = east(corner) ? 1 : -1;
  const sy = south(corner) ? 1 : -1;
  const anchorX = sx > 0 ? start.left : start.left + start.width;
  const anchorY = sy > 0 ? start.top : start.top + start.height;
  const roomX =
    sx > 0 ? bounds.left + bounds.width - anchorX : anchorX - bounds.left;
  const roomY =
    sy > 0 ? bounds.top + bounds.height - anchorY : anchorY - bounds.top;
  let width = start.width + sx * delta.x;
  let height = start.height + sy * delta.y;
  if (ratio === null) {
    width = clamp(width, minimum.width, roomX);
    height = clamp(height, minimum.height, roomY);
  } else {
    const scale =
      (width * start.width + height * start.height) /
      (start.width ** 2 + start.height ** 2);
    width = clamp(
      scale * start.width,
      Math.max(minimum.width, minimum.height * ratio),
      Math.min(roomX, roomY * ratio),
    );
    height = width / ratio;
  }
  return {
    left: sx > 0 ? anchorX : anchorX - width,
    top: sy > 0 ? anchorY : anchorY - height,
    width,
    height,
  };
};

/**
 * A stored crop with `corner` moved to `point`, the opposite corner anchored
 * (the article crop's corners): inside the frame, each edge at least
 * `minimum`, no fixed shape.
 */
export const resizeCropCorner = (
  crop: MediaCrop,
  corner: CropCorner,
  point: CropPoint,
  minimum = CROP_MINIMUM,
): MediaCrop | null => {
  const from = cropCornerPoint(crop, corner);
  const rect = resizeRect(
    { left: crop.x, top: crop.y, width: crop.width, height: crop.height },
    corner,
    { x: point.x - from.x, y: point.y - from.y },
    UNIT,
    { width: minimum, height: minimum },
    null,
  );
  return normalizeCrop({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
};

/**
 * Where the whole edited frame lies, in pixels of a cropper's `frame` that
 * shows `area` of it (null: all of it).
 */
export const imageRect = (frame: Size, area: MediaCrop | null): CropRect => {
  const shown = area ?? { x: 0, y: 0, width: 1, height: 1 };
  const width = frame.width / shown.width;
  const height = frame.height / shown.height;
  return { left: -shown.x * width, top: -shown.y * height, width, height };
};

/**
 * The crop field (the stage less `inset`) in pixels of the cropper's
 * `frame`: both are centred on the stage.
 */
export const fieldRect = (
  frame: Size,
  stage: Size,
  inset: CropInset,
): CropRect => {
  const width = stage.width - 2 * inset.inline;
  const height = stage.height - 2 * inset.block;
  return {
    left: (frame.width - width) / 2,
    top: (frame.height - height) / 2,
    width,
    height,
  };
};

/** The overlap of two rectangles; empty (zero-sized) when they miss. */
export const intersectRect = (a: CropRect, b: CropRect): CropRect => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top),
  };
};

/** The smallest window a drag over `image` (its rectangle on screen) may leave. */
export const minimumWindow = (image: CropRect): Size => ({
  width: Math.max(WINDOW_MINIMUM_PX, WINDOW_MINIMUM_SHARE * image.width),
  height: Math.max(WINDOW_MINIMUM_PX, WINDOW_MINIMUM_SHARE * image.height),
});

/**
 * A window in a cropper's `frame` px as a crop of the edited frame, through
 * the `area` the frame shows (null: all of it); the full frame is null.
 */
export const windowToCrop = (
  rect: CropRect,
  frame: Size,
  area: MediaCrop | null,
): MediaCrop | null => {
  const shown = area ?? { x: 0, y: 0, width: 1, height: 1 };
  return normalizeCrop({
    x: shown.x + (rect.left / frame.width) * shown.width,
    y: shown.y + (rect.top / frame.height) * shown.height,
    width: (rect.width / frame.width) * shown.width,
    height: (rect.height / frame.height) * shown.height,
  });
};

/**
 * `crop` brought to exactly `ratio` (width / height in the pixels of the
 * edited frame `source`) about its centre, inside the frame: a window of a
 * locked ratio rounds to whole screen pixels, its stored crop never drifts
 * off the preset.
 */
export const snapToRatio = (
  crop: MediaCrop | null,
  ratio: number,
  source: Size,
): MediaCrop | null => {
  const shown = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  if (!(ratio > 0) || !(source.width > 0) || !(source.height > 0))
    return normalizeCrop(crop);
  const pixels = {
    width: shown.width * source.width,
    height: shown.height * source.height,
  };
  const width =
    pixels.width / pixels.height > ratio
      ? (pixels.height * ratio) / source.width
      : shown.width;
  const height =
    pixels.width / pixels.height > ratio
      ? shown.height
      : pixels.width / ratio / source.height;
  return normalizeCrop({
    x: clamp(shown.x + (shown.width - width) / 2, 0, 1 - width),
    y: clamp(shown.y + (shown.height - height) / 2, 0, 1 - height),
    width,
    height,
  });
};

/** The largest frame of `ratio` (width / height) inside `field`. */
export const fitFrame = (field: Size, ratio: number): Size => {
  const width = Math.min(field.width, field.height * ratio);
  return { width, height: width / ratio };
};

/**
 * The zoom a cropper of `ratio` needs to show `crop` over an edited `frame`
 * (source px): at zoom 1 it shows the largest centred part of that shape.
 * For a crop of the frame's own `ratio` this is `min(1 / width, 1 / height)`.
 */
export const requiredZoom = (
  crop: MediaCrop | null,
  ratio: number,
  frame: Size,
): number => {
  if (crop === null || !(crop.width > 0)) return 1;
  if (!(ratio > 0) || !(frame.width > 0) || !(frame.height > 0)) return 1;
  const fitted = Math.min(1, ratio / (frame.width / frame.height));
  return fitted / crop.width;
};

/** Slack over the exact zoom, so float rounding in the cropper never clamps a seed. */
const ZOOM_SLACK = 1e-4;

/**
 * How far a cropper seeded with `seed` may zoom: the shared 3×, or as far
 * as the seed itself needs (a small crop must reopen as it was, not
 * clamped larger), never past the contract's smallest crop.
 */
export const seedMaxZoom = (
  seed: MediaCrop | null,
  ratio: number,
  frame: Size,
): number =>
  Math.min(
    1 / CROP_MINIMUM,
    Math.max(
      CROP_MAX_ZOOM,
      requiredZoom(seed, ratio, frame) * (1 + ZOOM_SLACK),
    ),
  );
