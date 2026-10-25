import type { MediaCrop } from "@moya/contracts";
import type { CropPoint } from "../../media-composer/crop-window";
import {
  CROP_MINIMUM,
  normalizeCrop,
} from "../../publishing/ui/media/media-geometry";

// The anchored-corner geometry is the Media Composer's (#341), shared with
// the phone 编辑 stage's corner handles.
export type { CropCorner, CropPoint } from "../../media-composer/crop-window";
export {
  cropCornerPoint,
  resizeCropCorner as resizeArticleCrop,
} from "../../media-composer/crop-window";

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
