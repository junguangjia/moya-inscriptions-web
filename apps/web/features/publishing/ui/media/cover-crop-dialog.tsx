"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AuthorDialog } from "../../../authors/author-dialog";
import { CROP_IMAGE_EDGE } from "./bounded-preview";
import {
  CropWorkspace,
  PresetPicker,
  restartCrop,
  resolvedCrop,
  resumeCrop,
  startCrop,
} from "./crop-workspace";
import { renderEditedFrame } from "./edited-frame";
import {
  COVER_PRESETS,
  closeCrop,
  cropRatio,
  matchPreset,
  normalizeCrop,
  presetRatio,
  sameCrop,
  sameEdit,
} from "./media-geometry";
import { useBoundedPreview } from "./media-preview";
import styles from "./media.module.css";

import type { CropPreset, CropSession } from "./crop-workspace";
import type { EditedFrameImage } from "./edited-frame";
import type { CoverDraft } from "./media-ui-store";
import type { MediaCrop, MediaEdit } from "@moya/contracts";

/**
 * The card cover composition of the cover item (M03, L10): a crop inside the
 * item's edited frame that only shapes the card thumbnail and cover; the
 * item itself and its Detail presentation are unchanged. Unfinished work
 * survives a remount through `initialDraft` / `onDraftChange`.
 */

type FrameState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly frame: EditedFrameImage };

export interface CoverCompositionOptions {
  readonly edit: MediaEdit;
  readonly src: string | null;
  readonly blob: Blob | null;
  /** The current composition when this item is already the chosen cover. */
  readonly coverCrop: MediaCrop | null;
  readonly initialDraft?: CoverDraft | null;
  readonly onDraftChange?: ((draft: CoverDraft) => void) | undefined;
}

export interface CoverComposition {
  /** The item's edited frame, drawn once; null while it is drawn or failed. */
  readonly frame: EditedFrameImage | null;
  readonly session: CropSession;
  readonly onSession: (
    action: CropSession | ((current: CropSession) => CropSession),
  ) => void;
  /** Width / height of the composition's frame. */
  readonly ratio: number;
  /** The composition to keep (the stored one while nothing changed). */
  readonly next: MediaCrop | null;
  /** Nothing changed since the dialog opened. */
  readonly unchanged: boolean;
  /** No picture to compose on (none, or it failed to draw). */
  readonly unavailable: boolean;
}

/**
 * The composition model of 封面构图, shared by the desktop dialog and the
 * phone's 封面构图 screen: the item's edited frame drawn as one picture, the
 * crop session on it (resumed from `initialDraft` while edit and crop are
 * unchanged, reported to `onDraftChange`), its ratio and the crop to keep.
 */
export const useCoverComposition = ({
  edit,
  src,
  blob,
  coverCrop,
  initialDraft = null,
  onDraftChange,
}: CoverCompositionOptions): CoverComposition => {
  const local = useBoundedPreview(src === null ? blob : null, CROP_IMAGE_EDGE);
  const image = src ?? local.url;
  const [state, setState] = useState<FrameState>({ status: "loading" });
  const original = normalizeCrop(coverCrop);
  const [stored, setStored] = useState<CropSession | null>(() =>
    initialDraft !== null &&
    initialDraft.session !== null &&
    sameEdit(initialDraft.basisEdit, edit) &&
    sameCrop(initialDraft.basisCrop, original)
      ? resumeCrop(initialDraft.session)
      : null,
  );

  // The same edit by value: identities change when upload ids arrive.
  const editKey = `${edit.rotation}:${edit.crop?.x ?? ""}:${edit.crop?.y ?? ""}:${edit.crop?.width ?? ""}:${edit.crop?.height ?? ""}`;
  const frameEdit = useMemo(() => edit, [editKey]);
  const drawnEdit = useRef(frameEdit);

  useEffect(() => {
    if (image === null) return;
    let active = true;
    let rendered: EditedFrameImage | null = null;
    setState({ status: "loading" });
    if (!sameEdit(drawnEdit.current, frameEdit)) {
      // A different edit is a different frame: the composition starts again.
      drawnEdit.current = frameEdit;
      setStored(null);
    } else {
      // A new source of the same frame: the cropper continues from the crop made.
      setStored((current) => (current === null ? null : resumeCrop(current)));
    }
    renderEditedFrame(image, frameEdit).then(
      (frame) => {
        if (!active) {
          frame.release();
          return;
        }
        rendered = frame;
        setState({ status: "ready", frame });
      },
      () => {
        if (active) setState({ status: "failed" });
      },
    );
    return () => {
      active = false;
      rendered?.release();
    };
  }, [image, frameEdit]);

  const draftChange = useRef(onDraftChange);
  useEffect(() => {
    draftChange.current = onDraftChange;
  });
  useEffect(() => {
    draftChange.current?.({
      basisEdit: frameEdit,
      basisCrop: normalizeCrop(coverCrop),
      session: stored,
    });
  }, [frameEdit, stored, coverCrop]);

  const frame = state.status === "ready" ? state.frame : null;
  const initial = (): CropSession =>
    startCrop(
      frame === null
        ? coverCrop === null
          ? "original"
          : "custom"
        : (matchPreset(coverCrop, frame.size, COVER_PRESETS) ?? "custom"),
      coverCrop,
    );
  const session = stored ?? initial();
  const onSession = (
    action: CropSession | ((current: CropSession) => CropSession),
  ) =>
    setStored((previous) => {
      const base = previous ?? initial();
      return typeof action === "function" ? action(base) : action;
    });
  const preset = COVER_PRESETS.find((option) => option.id === session.preset);
  const ratio =
    frame === null
      ? 1
      : preset !== undefined
        ? presetRatio(preset, frame.size)
        : cropRatio(coverCrop, frame.size);
  const candidate = resolvedCrop(session, ratio, frame?.size ?? null);
  // The cropper's re-report of the stored composition is not a change.
  const unchanged = closeCrop(candidate, original);
  const next = unchanged ? original : candidate;
  const pendingLocal = src === null && local.status === "loading";
  const unavailable =
    (image === null && !pendingLocal) || state.status === "failed";
  return { frame, session, onSession, ratio, next, unchanged, unavailable };
};

export const CoverCropDialog = ({
  itemKey,
  itemNumber,
  edit,
  src,
  blob,
  coverCrop,
  derivativeExpected = true,
  initialDraft = null,
  onDraftChange,
  onApply,
  onClose,
}: {
  readonly itemKey: string;
  readonly itemNumber: number;
  readonly edit: MediaEdit;
  readonly src: string | null;
  readonly blob: Blob | null;
  /** The current composition when this item is already the chosen cover. */
  readonly coverCrop: MediaCrop | null;
  /** The account will still produce a derivative (the no-preview note says so). */
  readonly derivativeExpected?: boolean;
  readonly initialDraft?: CoverDraft | null;
  readonly onDraftChange?: (draft: CoverDraft) => void;
  readonly onApply: (crop: MediaCrop | null) => void;
  readonly onClose: () => void;
}) => {
  const presetName = useId();
  const { frame, session, onSession, ratio, next, unchanged, unavailable } =
    useCoverComposition({
      edit,
      src,
      blob,
      coverCrop,
      initialDraft,
      onDraftChange,
    });

  return (
    <AuthorDialog
      dirty={!unchanged}
      onClose={onClose}
      title={`调整封面：第 ${itemNumber} 项`}
    >
      <div className={styles.dialogBody} data-cover-crop-dialog="">
        {frame !== null ? (
          <CropWorkspace
            image={frame.url}
            itemKey={itemKey}
            label="拖动图片调整封面构图，可用方向键移动"
            onSession={onSession}
            ratio={ratio}
            rotation={0}
            session={session}
          />
        ) : (
          <p className={styles.dialogMessage} role="status">
            {!unavailable
              ? "正在准备封面预览…"
              : derivativeExpected
                ? "这台设备暂时无法显示这张图片，处理完成后可调整封面构图。"
                : "这台设备无法显示这张图片，暂时无法调整封面构图。"}
          </p>
        )}
        <p className={styles.dialogNote}>
          封面构图只影响作品卡片的显示，不改变图片本身。
        </p>
        <PresetPicker
          disabled={frame === null}
          name={presetName}
          onChange={(id: CropPreset) =>
            onSession((current) => restartCrop(current, id))
          }
          presets={COVER_PRESETS}
          value={session.preset}
        />
        <div className={styles.dialogActions}>
          <button
            className={styles.secondaryButton}
            onClick={() =>
              onSession((current) => restartCrop(current, "original"))
            }
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
