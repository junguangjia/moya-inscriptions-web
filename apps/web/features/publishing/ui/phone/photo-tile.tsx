"use client";

import { useItemThumb } from "../media/media-item-tile";
import { EditedImage } from "../media/media-preview";

import type { ItemStatus } from "../media/media-status";
import type { UploadItemView } from "../../upload-manager";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";

/**
 * What the phone screens say and draw about one photo (#244; r4: the
 * 选择照片 grid is gone): where a failure came from, whether the photo needs
 * the author, its status chip's short label, the place it would take while
 * another is sorted, and its picture in the edited frame. 编辑's strip,
 * the photo and fix sheets, 发布's cards and the flow share them.
 */

/** Where a failed item failed: the chip, the dialog and its remedy differ. */
export type FailureSource = "upload" | "processing" | "edit";

/** What a photo shows (a thumbnail, a sheet's header); the screen derives it from the media actions. */
export interface PhotoTileModel {
  readonly item: WorkDraftItem;
  /** The upload manager's view, when this browser tracks the item. */
  readonly view: UploadItemView | undefined;
  /** The account's view (`serverFor`), for the thumbnail. */
  readonly server: PublishingMediaItem | undefined;
  /** The local still while the account has no derivative. */
  readonly localStill: Blob | null;
  /** The account's thumbnail of the edited item, once it exists. */
  readonly editedThumbSrc: string | null;
  readonly status: ItemStatus;
  readonly failure: FailureSource | null;
  /**
   * An older draft's chosen cover that is not item 1 keeps its 封面 mark
   * until position 1 changes (§6 G6).
   */
  readonly chosenCover: boolean;
}

export const kindText = (item: WorkDraftItem) =>
  item.kind === "live" ? "实况照片" : "照片";

/** 原图画质 / 标准画质 (the photo sheet's line); a legacy item has none. */
export const qualityText = (item: WorkDraftItem): string | null =>
  item.qualityMode === "original"
    ? "原图画质"
    : item.qualityMode === "standard"
      ? "标准画质"
      : null;

/**
 * The three failures `itemStatus` folds into one `failed` (S1.8): the
 * manager's own transfer, the account's processing, or the edit derivatives
 * of an item that is otherwise ready.
 */
export const failureSource = (
  status: ItemStatus,
  view: UploadItemView | undefined,
  server: PublishingMediaItem | undefined,
): FailureSource | null => {
  if (status.kind !== "failed") return null;
  if (view !== undefined) return view.phase === "failed" ? "upload" : "edit";
  return server?.state === "failed" ? "processing" : "edit";
};

/** States a tap answers with the fix sheet instead of the photo sheet. */
export const needsAttention = (status: ItemStatus): boolean =>
  status.kind === "paused" ||
  status.kind === "needs_choice" ||
  status.kind === "failed" ||
  status.kind === "missing_local" ||
  status.kind === "unavailable";

/** The chip's short fixed label (S1.8, §6 G8); the full one is in the name. */
export const chipLabel = (
  status: ItemStatus,
  failure: FailureSource | null,
): string => {
  switch (status.kind) {
    case "uploaded":
      return "等待处理";
    case "failed":
      return failure === "upload" ? "上传失败" : "处理失败";
    case "missing_local":
      return "缺少文件";
    default:
      return status.label;
  }
};

/** What a photo's chip says: nothing once the photo is ready (B). */
export const tileChip = (
  status: ItemStatus,
  failure: FailureSource | null,
): string | null =>
  status.kind === "ready" ? null : chipLabel(status, failure);

/**
 * Where the photo at `index` sits while the held one (`active`) is over
 * `over` (dnd-kit's sortable indices, −1 when none): the order 编辑's strip
 * marks show live while a photo is dragged (r4 D9).
 */
export const projectedIndex = (
  index: number,
  active: number,
  over: number,
): number => {
  if (active < 0 || over < 0) return index;
  if (index === active) return over;
  if (active < over && index > active && index <= over) return index - 1;
  if (active > over && index >= over && index < active) return index + 1;
  return index;
};

/** The picture a thumbnail (or a sheet's header) shows: the photo in its edited frame. */
export const PhotoThumb = ({ model }: { readonly model: PhotoTileModel }) => {
  const thumb = useItemThumb({
    view: model.view,
    server: model.server,
    localStill: model.localStill,
    editedThumbSrc: model.editedThumbSrc,
    edit: model.item.edit,
  });
  return (
    <EditedImage
      edit={thumb.edit}
      fallback={kindText(model.item)}
      knownSize={thumb.knownSize}
      src={thumb.src}
    />
  );
};
