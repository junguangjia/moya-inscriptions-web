import {
  EDIT_PRESETS,
  centeredCrop,
  cropRatio,
  normalizeCrop,
  rotatedSize,
  sameEdit,
} from "../media/media-geometry";

import type {
  AspectPreset,
  AspectPresetId,
  Size,
} from "../media/media-geometry";
import type { MediaEdit, WorkDraftItem } from "@moya/contracts";

/**
 * 应用到全部 on the phone edit screen (#244): one shot, never a standing
 * rule. Every other photo gets the centred crop of the chosen ratio inside
 * its own (rotated) frame; a photo whose crop already has that shape keeps
 * the position its author gave it. Rotation is never touched. A photo whose
 * size is not known yet (nothing decoded, no account presentation) or that
 * cannot be edited (`legacy`) is left as it is.
 */

/** Same relative tolerance as `matchPreset` when it reads a crop's shape. */
const SHAPE_TOLERANCE = 0.01;

export interface RatioChange {
  readonly key: string;
  readonly edit: MediaEdit;
}

export const applyRatioToAll = (
  items: readonly Pick<WorkDraftItem, "key" | "edit" | "qualityMode">[],
  /** Each photo's source size in display orientation, before its rotation. */
  sizes: ReadonlyMap<string, Size>,
  presetId: AspectPresetId,
  presets: readonly AspectPreset[] = EDIT_PRESETS,
): readonly RatioChange[] => {
  const preset = presets.find((option) => option.id === presetId);
  if (preset === undefined) return [];
  const changes: RatioChange[] = [];
  for (const item of items) {
    if (item.qualityMode === "legacy") continue;
    const size = sizes.get(item.key);
    if (size === undefined || !(size.width > 0) || !(size.height > 0)) continue;
    const frame = rotatedSize(size, item.edit.rotation);
    const stored = normalizeCrop(item.edit.crop);
    let crop: MediaEdit["crop"] = null;
    // 原始比例 is the whole frame; any other ratio keeps a crop of its shape.
    if (preset.ratio !== null) {
      const shape = cropRatio(stored, frame);
      if (Math.abs(shape - preset.ratio) / preset.ratio < SHAPE_TOLERANCE)
        continue;
      crop = centeredCrop(preset.ratio, frame);
    }
    const edit: MediaEdit = { rotation: item.edit.rotation, crop };
    if (sameEdit(edit, { rotation: item.edit.rotation, crop: stored }))
      continue;
    changes.push({ key: item.key, edit });
  }
  return changes;
};
