import { resolveStageAspect } from "../../../authors/feed-post-strip-geometry";

import type { MediaCrop, MediaEdit, MediaRotation } from "@moya/contracts";

/**
 * Rotate/crop geometry shared by the item preview, the edit dialog and the
 * cover composition dialog (M01, L10). A crop is normalized to the edited
 * frame: the source in its display orientation, turned clockwise by
 * `rotation`; a cover crop is normalized to the item's edited frame (after
 * its own rotation and crop). The full frame is stored as `null`.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The contract minimum edge (`MEDIA_CROP_MINIMUM`); kept local so no contract runtime reaches the client. */
export const CROP_MINIMUM = 0.01;

/** Rounding and the "this is the full frame" tolerance of a normalized edge. */
const PRECISION = 1e6;
const FULL_FRAME_TOLERANCE = 0.002;
/** Relative tolerance when matching a crop's aspect to a preset. */
const ASPECT_TOLERANCE = 0.01;

export type AspectPresetId =
  "original" | "1:1" | "4:3" | "3:4" | "4:5" | "16:9" | "9:16";

export interface AspectPreset {
  readonly id: AspectPresetId;
  readonly label: string;
  /** Width / height; null follows the (rotated) frame. */
  readonly ratio: number | null;
}

export const EDIT_PRESETS: readonly AspectPreset[] = [
  { id: "original", label: "原始比例", ratio: null },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  /** The tallest shape the phone feed stage shows whole (#243). */
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

/** Card cover shapes: the card keeps the edited frame unless the author picks one. */
export const COVER_PRESETS: readonly AspectPreset[] = EDIT_PRESETS.filter(
  (preset) =>
    preset.id === "original" ||
    preset.id === "1:1" ||
    preset.id === "3:4" ||
    preset.id === "4:3",
);

export const FULL_EDIT: MediaEdit = { rotation: 0, crop: null };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number) => Math.round(value * PRECISION) / PRECISION;

export const rotatedSize = (size: Size, rotation: MediaRotation): Size =>
  rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };

/** A quarter turn clockwise (1) or counter-clockwise (-1). */
export const turn = (
  rotation: MediaRotation,
  direction: 1 | -1,
): MediaRotation =>
  ((((rotation + direction * 90) % 360) + 360) % 360) as MediaRotation;

/** The edited frame of a source (rotation, then crop), in source pixels. */
export const editedSize = (source: Size, edit: MediaEdit): Size => {
  const frame = rotatedSize(source, edit.rotation);
  return edit.crop === null
    ? frame
    : {
        width: frame.width * edit.crop.width,
        height: frame.height * edit.crop.height,
      };
};

/**
 * Clamps a crop inside the unit square with the contract minimum edge and
 * rounds it; the full frame becomes null.
 */
export const normalizeCrop = (crop: MediaCrop | null): MediaCrop | null => {
  if (crop === null) return null;
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (!values.every((value) => Number.isFinite(value))) return null;
  const width = clamp(round(crop.width), CROP_MINIMUM, 1);
  const height = clamp(round(crop.height), CROP_MINIMUM, 1);
  const x = clamp(round(crop.x), 0, round(1 - width));
  const y = clamp(round(crop.y), 0, round(1 - height));
  if (
    x <= FULL_FRAME_TOLERANCE &&
    y <= FULL_FRAME_TOLERANCE &&
    width >= 1 - FULL_FRAME_TOLERANCE &&
    height >= 1 - FULL_FRAME_TOLERANCE
  )
    return null;
  return { x, y, width, height };
};

/** A react-easy-crop area in percentages of the rotated frame. */
export interface PercentArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const cropFromPercentages = (area: PercentArea): MediaCrop | null =>
  normalizeCrop({
    x: area.x / 100,
    y: area.y / 100,
    width: area.width / 100,
    height: area.height / 100,
  });

export const percentagesFromCrop = (crop: MediaCrop): PercentArea => ({
  x: crop.x * 100,
  y: crop.y * 100,
  width: crop.width * 100,
  height: crop.height * 100,
});

/** The largest centered crop of `ratio` inside `frame` (null when it is the frame). */
export const centeredCrop = (ratio: number, frame: Size): MediaCrop | null => {
  if (!(ratio > 0) || !(frame.width > 0) || !(frame.height > 0)) return null;
  const frameRatio = frame.width / frame.height;
  if (Math.abs(frameRatio - ratio) / ratio < 1e-6) return null;
  if (frameRatio > ratio) {
    const width = ratio / frameRatio;
    return normalizeCrop({ x: (1 - width) / 2, y: 0, width, height: 1 });
  }
  const height = frameRatio / ratio;
  return normalizeCrop({ x: 0, y: (1 - height) / 2, width: 1, height });
};

/** Width / height of a crop in pixels of `frame`. */
export const cropRatio = (crop: MediaCrop | null, frame: Size): number =>
  crop === null
    ? frame.width / frame.height
    : (crop.width * frame.width) / (crop.height * frame.height);

/** The aspect a preset asks for inside `frame`. */
export const presetRatio = (preset: AspectPreset, frame: Size): number =>
  preset.ratio ?? frame.width / frame.height;

/**
 * The preset a stored crop was made with: the frame's own shape first, then
 * a fixed ratio; null for any other shape (kept as a custom ratio).
 */
export const matchPreset = (
  crop: MediaCrop | null,
  frame: Size,
  presets: readonly AspectPreset[] = EDIT_PRESETS,
): AspectPresetId | null => {
  if (crop === null) return "original";
  const ratio = cropRatio(crop, frame);
  const close = (target: number) =>
    Math.abs(ratio - target) / target < ASPECT_TOLERANCE;
  if (close(frame.width / frame.height)) return "original";
  return (
    presets.find((preset) => preset.ratio !== null && close(preset.ratio))
      ?.id ?? null
  );
};

export const sameEdit = (left: MediaEdit, right: MediaEdit): boolean =>
  left.rotation === right.rotation && sameCrop(left.crop, right.crop);

export const sameCrop = (
  left: MediaCrop | null,
  right: MediaCrop | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height);

/**
 * How far a crop may differ and still be the same crop: the cropper
 * re-reports a seeded area through its own pixel rounding when a dialog
 * opens, which must not count as a change (0.05 % of the frame edge).
 */
export const CROP_TOLERANCE = 0.0005;

export const closeCrop = (
  left: MediaCrop | null,
  right: MediaCrop | null,
  tolerance = CROP_TOLERANCE,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance);

export const closeEdit = (left: MediaEdit, right: MediaEdit): boolean =>
  left.rotation === right.rotation && closeCrop(left.crop, right.crop);

/**
 * CSS placement of a source inside a box showing its edited frame: the box
 * has the edited aspect; the rotated frame is offset and scaled inside it so
 * the crop fills the box. The image inside the frame is turned by CSS.
 */
export interface PreviewPlacement {
  readonly aspectRatio: number;
  readonly frame: {
    readonly left: string;
    readonly top: string;
    readonly width: string;
    readonly height: string;
  };
  readonly rotation: MediaRotation;
}

const percent = (value: number) => `${round(value * 100)}%`;

export const previewPlacement = (
  source: Size,
  edit: MediaEdit,
): PreviewPlacement => {
  const frame = rotatedSize(source, edit.rotation);
  const crop = edit.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    aspectRatio: (frame.width * crop.width) / (frame.height * crop.height),
    frame: {
      left: percent(-crop.x / crop.width),
      top: percent(-crop.y / crop.height),
      width: percent(1 / crop.width),
      height: percent(1 / crop.height),
    },
    rotation: edit.rotation,
  };
};

/**
 * Canvas drawing plan for the edited frame at a bounded size: the canvas
 * size, the scale and the translation/rotation that put the crop at the
 * origin.
 */
export interface DrawPlan {
  readonly canvas: Size;
  readonly scale: number;
  /** Translation (in rotated-frame pixels) applied after scaling. */
  readonly offset: { readonly x: number; readonly y: number };
  /** Translation of the source origin inside the rotated frame, before rotating. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly radians: number;
}

export const drawPlan = (
  source: Size,
  edit: MediaEdit,
  maxEdge: number,
): DrawPlan => {
  const frame = rotatedSize(source, edit.rotation);
  const crop = edit.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const cropWidth = frame.width * crop.width;
  const cropHeight = frame.height * crop.height;
  const scale = Math.min(1, maxEdge / Math.max(cropWidth, cropHeight));
  const origin =
    edit.rotation === 90
      ? { x: frame.width, y: 0 }
      : edit.rotation === 180
        ? { x: frame.width, y: frame.height }
        : edit.rotation === 270
          ? { x: 0, y: frame.height }
          : { x: 0, y: 0 };
  return {
    canvas: {
      width: Math.max(1, Math.round(cropWidth * scale)),
      height: Math.max(1, Math.round(cropHeight * scale)),
    },
    scale,
    offset: { x: -crop.x * frame.width, y: -crop.y * frame.height },
    origin,
    radians: (edit.rotation * Math.PI) / 180,
  };
};

/**
 * How the phone single-column feed stage (#243) shows an edited frame of
 * `cropRatio` (width / height). The stage takes its shape from the post's
 * first image, clamped between 1:1 and 4:5 (`resolveStageAspect`); a frame
 * taller than the stage is centre-cropped (`cover`, only `height` of it is
 * visible, centred), a frame of the stage's shape fills it (`fill`), any
 * other frame is shown whole with blank above and below (`contain`). The
 * stage has no focal point, so the window depends on the shape alone.
 */
export interface FeedStageWindow {
  readonly fit: "cover" | "fill" | "contain";
  /** Visible fraction of the frame's height (1 unless `cover`). */
  readonly height: number;
  /** The stage's height / width ratio the window was computed against. */
  readonly stageRatio: number;
}

/** Same tolerance as the stage's `slideFit`. */
const FEED_FIT_TOLERANCE = 0.001;

export const feedStageWindow = (
  cropRatio: number,
  stageRatio: number = resolveStageAspect({ width: 1, height: 1 / cropRatio }),
): FeedStageWindow => {
  const frameRatio = 1 / cropRatio;
  if (!(frameRatio > 0) || !Number.isFinite(frameRatio))
    return { fit: "fill", height: 1, stageRatio };
  if (frameRatio > stageRatio + FEED_FIT_TOLERANCE)
    return { fit: "cover", height: round(stageRatio / frameRatio), stageRatio };
  if (Math.abs(frameRatio - stageRatio) <= FEED_FIT_TOLERANCE)
    return { fit: "fill", height: 1, stageRatio };
  return { fit: "contain", height: 1, stageRatio };
};
