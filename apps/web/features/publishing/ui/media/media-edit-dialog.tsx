"use client";

import { useEffect, useId, useRef, useState } from "react";

import { AuthorDialog } from "../../../authors/author-dialog";
import { EditorSwitch } from "../editor/mode-switches";
import editor from "../editor/editor.module.css";
import { CROP_IMAGE_EDGE } from "./bounded-preview";
import {
  CropWorkspace,
  PresetPicker,
  restartCrop,
  resolvedCrop,
  resumeCrop,
  startCrop,
  useNaturalSize,
} from "./crop-workspace";
import { FeedWindowOverlay, feedWindowHint } from "./feed-window-overlay";
import {
  EDIT_PRESETS,
  closeEdit,
  cropRatio,
  feedStageWindow,
  matchPreset,
  normalizeCrop,
  presetRatio,
  rotatedSize,
  sameEdit,
  turn,
} from "./media-geometry";
import { useBoundedPreview } from "./media-preview";
import styles from "./media.module.css";

import type { CropPreset, CropSession } from "./crop-workspace";
import type { Size } from "./media-geometry";
import type { EditDraft } from "./media-ui-store";
import type { MediaEdit, MediaItemKind, MediaRotation } from "@moya/contracts";
import type { Dispatch, SetStateAction } from "react";

/**
 * Rotate and optional crop of one item (M01, L10): full frame by default,
 * aspect presets, quarter turns and 还原. The edit is geometry only; the
 * account applies it to the still and, for a Live Photo, to its motion.
 * Unfinished work is handed to `onDraftChange` and comes back through
 * `initialDraft`, so a layout change that remounts the dialog keeps it.
 * With `feedStage` the dialog also shows the feed display window (#244):
 * the part of the frame the phone single-column stage will show.
 */

export interface FeedStageContext {
  /** This item is the post's first image, which gives the stage its shape. */
  readonly first: boolean;
  /** The stage ratio the first image sets, when known (for the other items). */
  readonly stageRatio: number | null;
}

/** The crop session a stored edit reopens at; the phone edit screen too. */
export const initialSession = (
  edit: MediaEdit,
  size: Size | null,
  rotation: MediaRotation,
): CropSession => {
  // A turn made before the preview opened invalidates the stored crop.
  if (rotation !== edit.rotation) return startCrop("original", null);
  if (size === null)
    return startCrop(edit.crop === null ? "original" : "custom", edit.crop);
  const frame = rotatedSize(size, edit.rotation);
  return startCrop(matchPreset(edit.crop, frame) ?? "custom", edit.crop);
};

export const rotationText = (rotation: MediaRotation) =>
  rotation === 0 ? "未旋转" : `已向右旋转 ${rotation}°`;

type Stored = EditDraft["stored"];

export const MediaEditDialog = ({
  itemKey,
  itemNumber,
  kind,
  edit,
  src,
  blob,
  knownSize = null,
  derivativeExpected = true,
  initialDraft = null,
  onDraftChange,
  onApply,
  onClose,
  feedStage = null,
}: {
  readonly itemKey: string;
  readonly itemNumber: number;
  readonly kind: MediaItemKind;
  readonly edit: MediaEdit;
  /** A decodable account derivative (unedited), preferred over local bytes. */
  readonly src: string | null;
  /** The local still, used (as a bounded copy) while no derivative exists. */
  readonly blob: Blob | null;
  readonly knownSize?: Size | null;
  /** The account will still produce a derivative (the no-preview note says so). */
  readonly derivativeExpected?: boolean;
  readonly initialDraft?: EditDraft | null;
  readonly onDraftChange?: (draft: EditDraft) => void;
  readonly onApply: (edit: MediaEdit) => void;
  readonly onClose: () => void;
  /** Shows the feed display window for a post item; null for other uses. */
  readonly feedStage?: FeedStageContext | null;
}) => {
  const presetName = useId();
  const [feedGuide, setFeedGuide] = useState(true);
  const [cropSize, setCropSize] = useState<Size | null>(null);
  const local = useBoundedPreview(src === null ? blob : null, CROP_IMAGE_EDGE);
  const image = src ?? local.url;
  // The bounded copy knows its size: no second full decode to measure it.
  const natural = useNaturalSize(
    image,
    knownSize ?? (src === null ? local.size : null),
  );
  const size = natural.size;
  const previewable = image !== null && size !== null;
  const loading =
    (src === null && local.status === "loading") ||
    (image !== null && size === null && !natural.failed);

  // Work from before a remount, while the item still has the same edit.
  const [resumed] = useState(() =>
    initialDraft !== null && sameEdit(initialDraft.basis, edit)
      ? initialDraft
      : null,
  );
  const [rotation, setRotation] = useState<MediaRotation>(
    resumed?.rotation ?? edit.rotation,
  );
  const [stored, setStored] = useState<Stored>(() =>
    resumed?.stored
      ? {
          previewable: resumed.stored.previewable,
          session: resumeCrop(resumed.stored.session),
        }
      : null,
  );
  const draftChange = useRef(onDraftChange);
  useEffect(() => {
    draftChange.current = onDraftChange;
  });
  useEffect(() => {
    draftChange.current?.({ basis: edit, rotation, stored });
  }, [edit, rotation, stored]);

  // The session starts once it is known whether the frame can be previewed.
  const session =
    stored !== null && stored.previewable === previewable
      ? stored.session
      : initialSession(edit, previewable ? size : null, rotation);
  const onSession: Dispatch<SetStateAction<CropSession>> = (action) =>
    setStored((previous) => {
      const base =
        previous !== null && previous.previewable === previewable
          ? previous.session
          : initialSession(edit, previewable ? size : null, rotation);
      return {
        previewable,
        session: typeof action === "function" ? action(base) : action,
      };
    });
  const frame = previewable ? rotatedSize(size, rotation) : null;
  const preset = EDIT_PRESETS.find((option) => option.id === session.preset);
  const ratio =
    frame === null
      ? 1
      : preset !== undefined
        ? presetRatio(preset, frame)
        : cropRatio(edit.crop, rotatedSize(size!, edit.rotation));
  const original: MediaEdit = {
    rotation: edit.rotation,
    crop: normalizeCrop(edit.crop),
  };
  // Without a preview the stored crop stays until a turn or 还原 restarts the session.
  const candidate: MediaEdit = {
    rotation,
    crop: resolvedCrop(session, ratio, frame),
  };
  // The cropper's re-report of the stored crop is not a change.
  const unchanged = closeEdit(candidate, original);
  const next = unchanged ? original : candidate;
  // The feed window depends on the frame's shape alone: the stage centres it.
  const feedWindow =
    feedStage === null || frame === null
      ? null
      : feedStage.first
        ? feedStageWindow(ratio)
        : feedStage.stageRatio === null
          ? null
          : feedStageWindow(ratio, feedStage.stageRatio);

  const rotate = (direction: 1 | -1) => {
    setRotation((current) => turn(current, direction));
    onSession((current) =>
      restartCrop(
        current,
        current.preset === "custom" ? "original" : current.preset,
      ),
    );
  };
  const choosePreset = (id: CropPreset) =>
    onSession((current) => restartCrop(current, id));
  const revert = () => {
    setRotation(0);
    onSession((current) => restartCrop(current, "original"));
  };

  return (
    <AuthorDialog
      dirty={!unchanged}
      onClose={onClose}
      title={`编辑第 ${itemNumber} 项`}
    >
      <div className={styles.dialogBody} data-media-edit-dialog="">
        {previewable ? (
          <CropWorkspace
            image={image}
            itemKey={itemKey}
            label="拖动图片调整裁剪位置，可用方向键移动"
            onCropSize={setCropSize}
            onSession={onSession}
            overlay={
              feedWindow !== null && feedGuide ? (
                <FeedWindowOverlay size={cropSize} window={feedWindow} />
              ) : undefined
            }
            ratio={ratio}
            rotation={rotation}
            session={session}
          />
        ) : (
          <p className={styles.dialogMessage} role="status">
            {loading
              ? "正在打开图片…"
              : derivativeExpected
                ? "这台设备暂时无法预览这张图片，仍可旋转；处理完成后可裁剪。"
                : "这台设备无法预览这张图片，仍可旋转。"}
          </p>
        )}
        {kind === "live" && (
          <p className={styles.dialogNote}>
            实况照片的动态影像会使用相同的旋转和裁剪。
          </p>
        )}
        <PresetPicker
          disabled={!previewable}
          name={presetName}
          onChange={choosePreset}
          presets={EDIT_PRESETS}
          value={session.preset}
        />
        {feedWindow !== null && feedStage !== null ? (
          <div className={editor.switches}>
            <EditorSwitch
              checked={feedGuide}
              description={feedWindowHint(feedWindow, feedStage.first)}
              label="动态流参考线"
              name="feed-window"
              onChange={setFeedGuide}
            />
          </div>
        ) : null}
        <div className={styles.dialogRow}>
          <button
            className={styles.secondaryButton}
            onClick={() => rotate(-1)}
            type="button"
          >
            向左旋转 90°
          </button>
          <button
            className={styles.secondaryButton}
            onClick={() => rotate(1)}
            type="button"
          >
            向右旋转 90°
          </button>
          <span aria-live="polite" className={styles.dialogMeta}>
            {rotationText(rotation)}
          </span>
        </div>
        <div className={styles.dialogActions}>
          <button
            className={styles.secondaryButton}
            onClick={revert}
            type="button"
          >
            还原
          </button>
          <button
            className={styles.primaryButton}
            onClick={() => {
              onApply(next);
              onClose();
            }}
            type="button"
          >
            完成
          </button>
        </div>
      </div>
    </AuthorDialog>
  );
};
