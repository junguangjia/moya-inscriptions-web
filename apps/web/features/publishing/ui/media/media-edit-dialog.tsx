"use client";

import { useEffect, useId, useRef, useState } from "react";

import { AuthorDialog } from "../../../authors/author-dialog";
import { seedMaxZoom } from "../../../media-composer/crop-window";
import { EditorSwitch } from "../editor/mode-switches";
import editor from "../editor/editor.module.css";
import { CROP_IMAGE_EDGE } from "./bounded-preview";
import {
  CropWorkspace,
  PresetPicker,
  restartCrop,
  resolvedCrop,
  resumeCrop,
  sessionRatio,
  startCrop,
  useNaturalSize,
} from "./crop-workspace";
import {
  FeedWindowOverlay,
  feedWindowHint,
  regionOf,
} from "./feed-window-overlay";
import {
  EDIT_PRESETS,
  closeEdit,
  cropFromPercentages,
  effectiveFeed,
  feedStageWindow,
  matchPreset,
  normalizeCrop,
  rotatedSize,
  sameEdit,
  sameFeed,
  turn,
  withFeed,
} from "./media-geometry";
import { useBoundedPreview } from "./media-preview";
import styles from "./media.module.css";

import type { CropPreset, CropSession } from "./crop-workspace";
import type { Size } from "./media-geometry";
import type { EditDraft } from "./media-ui-store";
import type {
  MediaEdit,
  MediaFeedFraming,
  MediaItemKind,
  MediaRotation,
} from "@moya/contracts";
import type { Dispatch, SetStateAction } from "react";

/**
 * Rotate and optional crop of one item (M01, L10): full frame by default,
 * aspect presets, quarter turns and 还原. The edit is geometry only; the
 * account applies it to the still and, for a Live Photo, to its motion.
 * Unfinished work is handed to `onDraftChange` and comes back through
 * `initialDraft`, so a layout change that remounts the dialog keeps it.
 * With `feedStage` the dialog also shows the feed display window (#244):
 * the part of the frame the phone single-column stage will show. For a frame
 * taller than that stage the author also picks how the feed shows it (#341):
 * 局部 (the region the window's handle or its arrow keys place) or 整张
 * (whole, blank at the sides); without a choice an uncropped frame shows
 * whole and a cropped one centred (r3). Like the crop, the choice is kept
 * by 完成 (`onApplyFeed`), reset by 还原 and handed on with the unfinished
 * work; it is offered only to a caller that keeps it.
 */

/** 局部 · 整张: how the feed shows a frame taller than its stage. */
const FEED_FITS = [
  { id: "region", label: "局部" },
  { id: "whole", label: "整张" },
] as const;

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
  onApplyFeed,
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
  /**
   * Keeps the feed framing chosen here (#341), after `onApply` and only when
   * it changed; without it the dialog shows the stored framing only.
   */
  readonly onApplyFeed?:
    ((feed: MediaFeedFraming | undefined) => void) | undefined;
  readonly onClose: () => void;
  /** Shows the feed display window for a post item; null for other uses. */
  readonly feedStage?: FeedStageContext | null;
}) => {
  const presetName = useId();
  const feedFitName = useId();
  const regionHintId = useId();
  const [feedGuide, setFeedGuide] = useState(true);
  // Work from before a remount, while the item still has the same edit.
  const [resumed] = useState(() =>
    initialDraft !== null && sameEdit(initialDraft.basis, edit)
      ? initialDraft
      : null,
  );
  // The feed framing as the author sets it here, kept by 完成: their choice,
  // or none for the default of the crop shown (#341 r3). An unkept one comes
  // back from before a remount while the item keeps its own.
  const [feed, setFeed] = useState<MediaFeedFraming | undefined>(() =>
    resumed?.feed !== undefined && sameFeed(resumed.basis.feed, edit.feed, edit)
      ? (resumed.feed ?? undefined)
      : edit.feed,
  );
  // 整张 → 局部 returns to the region left last.
  const lastRegion = useRef(regionOf(edit.feed));
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
  const keepsFeed = onApplyFeed !== undefined;

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
  const ratio =
    frame === null
      ? 1
      : sessionRatio(session, frame, {
          crop: edit.crop,
          frame: rotatedSize(size!, edit.rotation),
        });
  // A seed smaller than a third of the frame (a phone 自由 crop) reopens as
  // it was, not clamped larger by the shared 3× (#341).
  const maxZoom =
    frame === null
      ? undefined
      : seedMaxZoom(
          session.seed === undefined ? null : cropFromPercentages(session.seed),
          ratio,
          frame,
        );
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
  // What the feed shows of the crop shown: the framing set here, else that
  // crop's default (whole when uncropped, else centred).
  const shownFeed = effectiveFeed(withFeed(next, feed));
  // The feed window: the frame's shape against the stage, and the framing.
  const feedWindow =
    feedStage === null || frame === null
      ? null
      : feedStage.first
        ? feedStageWindow(ratio, undefined, shownFeed)
        : feedStage.stageRatio === null
          ? null
          : feedStageWindow(ratio, feedStage.stageRatio, shownFeed);
  const framing = onApplyFeed !== undefined && feedWindow?.tall === true;
  const feedFit = feedWindow?.fit === "contain" ? "whole" : "region";
  // Against what the item would show with the edit kept (`onApply` first).
  const feedChanged = !sameFeed(feed, edit.feed, next);
  const chooseFeedFit = (fit: "region" | "whole") => {
    if (fit === feedFit) return;
    if (fit === "whole") {
      lastRegion.current = regionOf(shownFeed);
      setFeed({ fit: "contain" });
    } else setFeed({ fit: "cover", y: lastRegion.current });
  };
  useEffect(() => {
    draftChange.current?.({
      basis: edit,
      rotation,
      stored,
      // The framing 完成 would keep, a return to the default as null.
      feed: keepsFeed && feedChanged ? (feed ?? null) : undefined,
    });
  }, [edit, rotation, stored, feed, keepsFeed, feedChanged]);

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
    if (onApplyFeed !== undefined) setFeed(undefined);
  };

  return (
    <AuthorDialog
      dirty={!unchanged || feedChanged}
      onClose={onClose}
      title={`编辑第 ${itemNumber} 项`}
    >
      <div className={styles.dialogBody} data-media-edit-dialog="">
        {previewable ? (
          <CropWorkspace
            image={image}
            itemKey={itemKey}
            label="拖动图片调整裁剪位置，可用方向键移动"
            maxZoom={maxZoom}
            onCropSize={setCropSize}
            onSession={onSession}
            overlay={
              feedWindow !== null && feedGuide ? (
                <FeedWindowOverlay
                  region={
                    framing
                      ? {
                          y: regionOf(shownFeed),
                          onChange: (y) => setFeed({ fit: "cover", y }),
                          describedBy: regionHintId,
                        }
                      : undefined
                  }
                  size={cropSize}
                  window={feedWindow}
                />
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
        {framing && feedWindow !== null && feedStage !== null ? (
          <fieldset className={styles.presets} data-feed-fit-picker="">
            <legend>动态流显示</legend>
            <div className={styles.presetOptions}>
              {FEED_FITS.map((fit) => (
                <label key={fit.id} className={styles.presetOption}>
                  <input
                    checked={feedFit === fit.id}
                    data-feed-choice={fit.id}
                    name={feedFitName}
                    onChange={() => chooseFeedFit(fit.id)}
                    type="radio"
                    value={fit.id}
                  />
                  <span>{fit.label}</span>
                </label>
              ))}
            </div>
            <span className={styles.visuallyHidden} id={regionHintId}>
              {feedWindowHint(feedWindow, feedStage.first, {
                adjustable: true,
              })}
            </span>
          </fieldset>
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
              if (onApplyFeed !== undefined && feedChanged) onApplyFeed(feed);
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
