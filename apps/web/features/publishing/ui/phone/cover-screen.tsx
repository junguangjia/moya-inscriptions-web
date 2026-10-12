"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { CropSurface } from "../../../media-composer/crop-surface";
import { useCoverComposition } from "../media/cover-crop-dialog";
import { restartCrop } from "../media/crop-workspace";
import { COVER_PRESETS, cropFromPercentages } from "../media/media-geometry";
import mediaStyles from "../media/media.module.css";
import styles from "./cover-screen.module.css";
import editStyles from "./edit-screen.module.css";
import { EditGlyph, cropperBox } from "./edit-stage";
import { PhoneNextButton, PhoneScreen } from "./phone-screen";
import { PHONE_PRESETS, RatioBar } from "./ratio-bar";
import selectStyles from "./select-screen.module.css";
import { PhoneSheet } from "./tile-menu";

import type { CoverDraft } from "../media/media-ui-store";
import type { Size } from "../media/media-geometry";
import type { MediaCrop, MediaEdit } from "@moya/contracts";
import type { CSSProperties } from "react";

/** The cover's ratios in 编辑's order, so the shapes keep their places. */
const PHONE_COVER_PRESETS = PHONE_PRESETS.filter((preset) =>
  COVER_PRESETS.some((cover) => cover.id === preset.id),
);

/**
 * 封面构图 on the phone (#244 r3, r4): the card cover's composition drawn
 * as 编辑 draws a photo (mockup B) instead of the desktop dialog's ratio
 * radios. Its own screen, opened from photo 1's sheet on 编辑 and drawn
 * full screen over it: the bar (‹ · 封面构图 · 完成), the first photo's
 * edited frame full-bleed on the paper-dark stage with 还原 as a round tool,
 * then the note that only the card changes and the cover's ratios as shapes.
 * The model is the dialog's (`useCoverComposition`): the composition only
 * shapes the card thumbnail and cover, never the photo. 完成 keeps it; ‹,
 * Escape and the browser's Back (its close request, `cancelPhoneLayer`)
 * leave it, asking first when something changed.
 */

export interface CoverScreenProps {
  readonly itemKey: string;
  readonly edit: MediaEdit;
  readonly src: string | null;
  readonly blob: Blob | null;
  /** The current composition when this photo is already the cover. */
  readonly coverCrop: MediaCrop | null;
  /** The account will still produce a derivative (the no-preview copy says so). */
  readonly derivativeExpected: boolean;
  readonly initialDraft: CoverDraft | null;
  readonly onDraftChange: (draft: CoverDraft) => void;
  readonly onApply: (crop: MediaCrop | null) => void;
  readonly onClose: () => void;
}

export const CoverScreen = ({
  itemKey,
  edit,
  src,
  blob,
  coverCrop,
  derivativeExpected,
  initialDraft,
  onDraftChange,
  onApply,
  onClose,
}: CoverScreenProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const { frame, session, onSession, ratio, next, unchanged, unavailable } =
    useCoverComposition({
      edit,
      src,
      blob,
      coverCrop,
      initialDraft,
      onDraftChange,
    });
  // ‹ with a change asks before it goes (a sheet, never the native confirm).
  const [asking, setAsking] = useState(false);
  const latest = useRef({ unchanged, onClose });
  latest.current = { unchanged, onClose };
  const cancel = () => {
    if (latest.current.unchanged) latest.current.onClose();
    else setAsking(true);
  };

  // A modal layer of its own: the screen beneath is inert while it shows,
  // its heading takes focus, and focus returns to the opener as it goes.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return undefined;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    dialog
      .querySelector<HTMLElement>("[data-editor-step-heading]")
      ?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (
        opener?.isConnected &&
        opener.closest('[inert], [hidden], [aria-hidden="true"]') === null
      )
        opener.focus({ preventScroll: true });
    };
  }, []);

  // The stage's room, so the cropper's box can be fitted to it (as 编辑's).
  const [stageSize, setStageSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const node = stage.current;
    if (node === null) return undefined;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setStageSize((current) =>
        width > 0 && height > 0
          ? current?.width === width && current.height === height
            ? current
            : { width, height }
          : null,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const surface = `${itemKey}:${session.generation}`;
  const [measured, setMeasured] = useState<{
    readonly surface: string;
    readonly size: Size;
  } | null>(null);
  const cropSize = measured?.surface === surface ? measured.size : null;
  const box =
    stageSize === null || frame === null
      ? null
      : cropperBox(stageSize, ratio, frame.size, false);
  const restorable = session.preset !== "original" || next !== null;

  return (
    <dialog
      ref={ref}
      aria-label="封面构图"
      className={styles.host}
      data-phone-cover={itemKey}
      onCancel={(event) => {
        event.preventDefault();
        // The discard sheet answers its own close request (React passes a
        // nested dialog's `cancel` on to this one).
        if (event.target !== event.currentTarget) return;
        cancel();
      }}
    >
      <PhoneScreen
        action={
          <PhoneNextButton
            data-cover-done=""
            onClick={() => {
              onApply(next);
              onClose();
            }}
          >
            完成
          </PhoneNextButton>
        }
        backLabel="取消封面构图"
        onBack={cancel}
        overlay={
          asking ? (
            <PhoneSheet
              description="调整过的封面构图不会保留。"
              name="cover-discard"
              onCancel={() => setAsking(false)}
              title="放弃封面构图的更改？"
            >
              <div className={selectStyles.shActions}>
                <button
                  className={selectStyles.inkBtn}
                  data-cover-keep-editing=""
                  onClick={() => setAsking(false)}
                  type="button"
                >
                  继续调整
                </button>
                <button
                  className={selectStyles.plainBtn}
                  data-cover-discard=""
                  data-danger=""
                  onClick={() => {
                    setAsking(false);
                    onClose();
                  }}
                  type="button"
                >
                  放弃更改
                </button>
              </div>
            </PhoneSheet>
          ) : null
        }
        screen="cover"
        scroll={false}
        title="封面构图"
      >
        <div className={editStyles.editBody} data-cover-body="">
          <div
            ref={stage}
            aria-describedby={hintId}
            aria-label="封面构图区域。拖动调整位置，双指缩放"
            className={editStyles.stage}
            data-boxed={box === null ? undefined : ""}
            data-cover-stage=""
            role="group"
            style={
              box === null
                ? undefined
                : ({
                    "--crop-box-width": `${box.width}px`,
                    "--crop-box-height": `${box.height}px`,
                  } as CSSProperties)
            }
          >
            <div className={editStyles.slide}>
              {frame !== null ? (
                <CropSurface
                  key={itemKey}
                  aspect={ratio}
                  cropAreaClassName={editStyles.stageCropArea}
                  generation={session.generation}
                  image={frame.url}
                  label="拖动图片调整封面构图，可用方向键移动，+ − 键缩放，0 键还原"
                  objectFit="contain"
                  onArea={(area) =>
                    onSession((current) => ({
                      ...current,
                      area: cropFromPercentages(area),
                    }))
                  }
                  onCropSize={(size) => setMeasured({ surface, size })}
                  // Only a move or zoom of the author's is a change.
                  onTouched={() =>
                    onSession((current) =>
                      current.touched ? current : { ...current, touched: true },
                    )
                  }
                  overlay={
                    cropSize === null ? null : (
                      <span
                        aria-hidden="true"
                        className={editStyles.frame}
                        data-cover-frame=""
                        style={{
                          width: `${cropSize.width}px`,
                          height: `${cropSize.height}px`,
                        }}
                      >
                        <span
                          className={editStyles.corner}
                          data-corner="top-left"
                        />
                        <span
                          className={editStyles.corner}
                          data-corner="top-right"
                        />
                        <span
                          className={editStyles.corner}
                          data-corner="bottom-left"
                        />
                        <span
                          className={editStyles.corner}
                          data-corner="bottom-right"
                        />
                      </span>
                    )
                  }
                  seed={session.seed}
                  tools="hintOnly"
                  viewportClassName={editStyles.cropBox}
                />
              ) : (
                <div
                  className={`${mediaStyles.dialogMessage} ${editStyles.stageFallback}`}
                  data-cover-fallback=""
                >
                  <span role="status">
                    {!unavailable
                      ? "正在准备封面预览…"
                      : derivativeExpected
                        ? "这台设备暂时无法显示这张图片，处理完成后可调整封面构图。"
                        : "这台设备无法显示这张图片，暂时无法调整封面构图。"}
                  </span>
                </div>
              )}
            </div>
            <div className={editStyles.stageRail}>
              <button
                aria-disabled={frame === null || !restorable}
                aria-label="还原"
                className={editStyles.fab}
                data-cover-revert=""
                onClick={() => {
                  if (frame === null || !restorable) return;
                  onSession((current) => restartCrop(current, "original"));
                }}
                title="还原"
                type="button"
              >
                <EditGlyph name="reset" />
              </button>
            </div>
          </div>
          <div className={editStyles.editBand} data-cover-band="">
            <p className={styles.note} id={hintId}>
              封面构图只影响作品卡片的显示，不改变图片本身。
            </p>
            <RatioBar
              disabled={frame === null}
              label="封面比例"
              onChange={(id) =>
                onSession((current) =>
                  id === current.preset ? current : restartCrop(current, id),
                )
              }
              presets={PHONE_COVER_PRESETS}
              value={session.preset}
            />
            <div className={styles.bandEnd} />
          </div>
        </div>
      </PhoneScreen>
    </dialog>
  );
};
