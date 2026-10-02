import type { MediaCrop } from "@moya/contracts";
import {
  CROP_MINIMUM,
  normalizeCrop,
} from "../../publishing/ui/media/media-geometry";

export type CropCorner = "nw" | "ne" | "sw" | "se";
export interface CropPoint {
  readonly x: number;
  readonly y: number;
}
export interface CropBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const FULL_ARTICLE_CROP: MediaCrop = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** A viewport pointer becomes a bounded point of the displayed original. */
export const normalizedCropPoint = (
  x: number,
  y: number,
  bounds: CropBounds,
): CropPoint | null =>
  [x, y, bounds.left, bounds.top, bounds.width, bounds.height].every(
    Number.isFinite,
  ) &&
  bounds.width > 0 &&
  bounds.height > 0
    ? {
        x: clamp((x - bounds.left) / bounds.width, 0, 1),
        y: clamp((y - bounds.top) / bounds.height, 0, 1),
      }
    : null;

/** Draw in either direction; the same normalized contract serves both devices. */
export const normalizedPointerRect = (
  start: CropPoint,
  end: CropPoint,
): MediaCrop | null =>
  normalizeCrop({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });

export const moveArticleCrop = (
  crop: MediaCrop,
  delta: CropPoint,
): MediaCrop | null =>
  normalizeCrop({
    ...crop,
    x: clamp(crop.x + delta.x, 0, 1 - crop.width),
    y: clamp(crop.y + delta.y, 0, 1 - crop.height),
  });

/** Each corner moves independently while the opposite corner stays anchored. */
export const resizeArticleCrop = (
  crop: MediaCrop,
  corner: CropCorner,
  point: CropPoint,
): MediaCrop | null => {
  const left = corner.endsWith("w")
    ? clamp(point.x, 0, crop.x + crop.width - CROP_MINIMUM)
    : crop.x;
  const right = corner.endsWith("e")
    ? clamp(point.x, crop.x + CROP_MINIMUM, 1)
    : crop.x + crop.width;
  const top = corner.startsWith("n")
    ? clamp(point.y, 0, crop.y + crop.height - CROP_MINIMUM)
    : crop.y;
  const bottom = corner.startsWith("s")
    ? clamp(point.y, crop.y + CROP_MINIMUM, 1)
    : crop.y + crop.height;
  return normalizeCrop({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
};

export const cropCornerPoint = (
  crop: MediaCrop,
  corner: CropCorner,
): CropPoint => ({
  x: crop.x + (corner.endsWith("e") ? crop.width : 0),
  y: crop.y + (corner.startsWith("s") ? crop.height : 0),
});

/** react-easy-crop's viewport window stays centered as its free ratio changes. */
export const centeredCropWindow = (
  width: number,
  height: number,
  viewport: { readonly width: number; readonly height: number },
): MediaCrop => {
  const w = clamp(width / viewport.width, CROP_MINIMUM, 1);
  const h = clamp(height / viewport.height, CROP_MINIMUM, 1);
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
};
