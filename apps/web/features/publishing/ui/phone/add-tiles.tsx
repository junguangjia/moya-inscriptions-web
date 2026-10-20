"use client";

import { Icon } from "@moya/ui";
import { useEffect, useId, useRef, useState } from "react";

import { ARTICLE_TOPIC_ICON } from "../../../editorial-content/article-authoring/use-article-draft-creation";
import editorStyles from "../editor/editor.module.css";
import { MEDIA_ACCEPT } from "../media/media-picker";
import { SELECTION_UNAVAILABLE } from "../media/use-media-actions";
import styles from "./select-screen.module.css";
import { PhoneSheet, closeSheetDialog } from "./tile-menu";

import type { ChangeEvent, MouseEvent, RefObject } from "react";

/**
 * How photos enter the phone publishing flow (#244 r4). The start screen
 * offers 选择照片 · 拍照 · 专题 as large tiles above 先写标题和正文, with
 * 原图画质 in its bottom bar; 编辑's + (beside the strip's last photo,
 * outside its scroller) opens the add sheet with 原图画质 · 选择照片 · 拍照
 * (r4 ASK-3). 选择照片 opens the system picker for several photos, 拍照 the
 * rear camera for one (phones only). Each control clicks its own hidden input inside the author's
 * gesture, as browsers require, and that click is the first thing its
 * handler does; a sheet closes its `<dialog>` element first, so the input
 * outside it is not inert (r4 D19). Files go to the screen as picked.
 */

/**
 * The flow's inline glyphs, copied from mockup B (its "new for this flow"
 * set, pending the shared icon set): 24 viewBox, the set's round 1.7 stroke,
 * no fills. The shared `Icon` covers back, close, next, previous, error,
 * image and academic-cap.
 */
const GLYPHS = {
  camera:
    "M3.8 8.6c0-.9.7-1.6 1.6-1.6h2.4l1.6-2.3h5.2l1.6 2.3h2.4c.9 0 1.6.7 1.6 1.6v9.3c0 .9-.7 1.6-1.6 1.6H5.4c-.9 0-1.6-.7-1.6-1.6V8.6ZM12 16.3a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z",
  crop: "M7 3.5V17h13.5M3.5 7H17v13.5",
  trash:
    "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10.3 10.8v5.4M13.7 10.8v5.4",
  first: "M5 4.5h14v15H5zM10.6 9.6 12.6 8v8",
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** One of the flow's glyphs; decorative, so the control names itself. */
export const Glyph = ({
  name,
  size = 24,
  className,
}: {
  readonly name: GlyphName;
  readonly size?: number;
  readonly className?: string | undefined;
}) => (
  <svg
    aria-hidden="true"
    className={className}
    data-glyph={name}
    fill="none"
    focusable="false"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.7}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d={GLYPHS[name]} />
  </svg>
);

/**
 * The device's last 原图画质 choice, namespaced like the shell's
 * preferences (`yoyi.theme-preference`), so every later pick (the start
 * screen's, 编辑's add sheet) and a later editor start from it.
 */
export const ORIGINAL_QUALITY_STORAGE_KEY = "yoyi.publishing.original-quality";

/** The remembered choice; null when none was made or storage is unavailable. */
export const readOriginalQuality = (): boolean | null => {
  try {
    const stored = window.localStorage.getItem(ORIGINAL_QUALITY_STORAGE_KEY);
    return stored === "original" ? true : stored === "standard" ? false : null;
  } catch {
    return null;
  }
};

/** Remembers a 原图画质 choice for this device. */
export const storeOriginalQuality = (original: boolean) => {
  try {
    window.localStorage.setItem(
      ORIGINAL_QUALITY_STORAGE_KEY,
      original ? "original" : "standard",
    );
  } catch {
    // Storage may be disabled: the choice still holds in this editor.
  }
};

export interface AddControlProps {
  /** At the limit, or while selection is not possible (the screen says why). */
  readonly disabled: boolean;
  readonly onFiles: (files: File[]) => void;
}

/**
 * Coarse pointers only (`(pointer: coarse)`): a desktop browser's camera
 * capture opens a file dialog, which 选择照片 already is.
 */
export const useCoarsePointer = (): boolean => {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    setCoarse(query.matches);
    const change = () => setCoarse(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return coarse;
};

/** Hands over what was picked; clearing the input lets the same photo be picked again. */
const picked =
  (onFiles: (files: File[]) => void) =>
  (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  };

export interface AddInputProps extends AddControlProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The system picker for several photos: hidden, and mounted for as long as
 * a pick can come back (an input that unmounts before its `change` loses
 * the pick). Its control clicks it.
 */
export const PickInput = ({ inputRef, disabled, onFiles }: AddInputProps) => (
  <input
    ref={inputRef}
    accept={MEDIA_ACCEPT}
    aria-label="选择照片"
    disabled={disabled}
    hidden
    multiple
    onChange={picked(onFiles)}
    tabIndex={-1}
    type="file"
  />
);

/** The rear camera for one photo (coarse pointers); hidden like `PickInput`. */
export const CaptureInput = ({
  inputRef,
  disabled,
  onFiles,
}: AddInputProps) => (
  <input
    ref={inputRef}
    accept={MEDIA_ACCEPT}
    aria-label="拍照"
    capture="environment"
    disabled={disabled}
    hidden
    onChange={picked(onFiles)}
    tabIndex={-1}
    type="file"
  />
);

export interface QualitySwitchProps {
  /** The next photos upload as their original files. */
  readonly original: boolean;
  /** A tap anywhere on the block: the other choice. */
  readonly onToggle: (next: boolean) => void;
}

/**
 * 原图画质 (mockup B `.selFoot`): the editor's switch with its words and
 * the scope 仅对之后选择的照片生效, the full effect as its description. The
 * whole block toggles; the switch's own click bubbles to it, so one tap is
 * one change. The start screen's bottom bar and 编辑's add sheet draw it.
 */
export const QualitySwitch = ({ original, onToggle }: QualitySwitchProps) => {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div
      className={styles.quality}
      data-editor-switch="original"
      onClick={() => onToggle(!original)}
    >
      <button
        aria-checked={original}
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        className={editorStyles.switch}
        role="switch"
        type="button"
      >
        <span aria-hidden="true" className={editorStyles.switchThumb} />
      </button>
      <span className={styles.qTxt}>
        <span className={styles.qLabel} id={labelId}>
          原图画质
        </span>
        <span aria-hidden="true" className={styles.qHint}>
          仅对之后选择的照片生效
        </span>
      </span>
      <span className={editorStyles.visuallyHidden} id={descriptionId}>
        {original
          ? "下一批选择的图片按原文件上传，不压缩"
          : "下一批选择的图片先优化为标准画质再上传"}
      </span>
    </div>
  );
};

/** 专题 on the start screen (r4 R1, D3): a new 专题文章 draft, opened in place. */
export interface StartTopicOption {
  /** A create is in flight: 正在创建…; the other start controls wait. */
  readonly busy: boolean;
  /** The account is being checked or could not be (the dialog's 专题文章 rule). */
  readonly disabled: boolean;
  /** The last outcome is unknown: 重试确认创建 re-sends the same create. */
  readonly retry: boolean;
  /** Why the last create did not open the article editor; null otherwise. */
  readonly notice: string | null;
  readonly onCreate: () => void;
}

/**
 * What the start screen offers besides photos, on an untouched new work
 * with 专题文章 on (r4 §3.1): 专题, and 草稿箱 at the bar's end (ASK-2).
 * Local props, not a contract.
 */
export interface StartOptions {
  readonly topic: StartTopicOption;
  /** 草稿箱: 用户 → 作品 with its 草稿箱 open; absent, no 草稿箱. */
  readonly onOpenDrafts?: (() => void) | undefined;
}

export interface EmptySelectionProps extends AddControlProps {
  /** 先写标题和正文; absent while files are still being read. */
  readonly onSkip: (() => void) | null;
  /** 专题 (the screen draws 草稿箱 in its bar); absent: photos only. */
  readonly start?: StartOptions | null | undefined;
  /** A pick is being read: every tile waits in place (r4 critique 7). */
  readonly reading?: boolean | undefined;
  /** Removals wait for 撤销: 专题 waits until they are committed. */
  readonly held?: boolean | undefined;
}

/**
 * The start screen's choices (B `.empty`, r4 §3.1): 选择照片, on a phone
 * 拍照, and 专题 as large tiles in one row that never reflows, the
 * picker's hint, 专题's own notice, then the media step's skip.
 * `data-media-picker` is where focus lands when the last photo is removed;
 * 选择照片 is what the editor focuses first when it opens. 专题 never
 * follows the photo session (`disabled`): it creates an article, not a
 * photo.
 */
export const EmptySelection = ({
  disabled,
  onFiles,
  onSkip,
  start = null,
  reading = false,
  held = false,
}: EmptySelectionProps) => {
  const coarse = useCoarsePointer();
  const pick = useRef<HTMLInputElement>(null);
  const capture = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const topicHintId = useId();
  const topic = start?.topic ?? null;
  const topicBusy = topic?.busy === true;
  // A tile that waits (a pick being read, 专题 creating, photos held) says
  // `aria-disabled` and ignores a tap, so it keeps focus as it turns busy;
  // `disabled` is kept for what selection cannot do at all.
  const photosWaiting = reading || topicBusy;
  const topicWaiting = topicBusy || reading || held;
  return (
    <div className={styles.empty} data-media-picker="">
      <PickInput disabled={disabled} inputRef={pick} onFiles={onFiles} />
      {coarse ? (
        <CaptureInput
          disabled={disabled}
          inputRef={capture}
          onFiles={onFiles}
        />
      ) : null}
      <div aria-busy={reading || undefined} className={styles.pickRow}>
        <button
          aria-describedby={hintId}
          aria-disabled={photosWaiting ? "true" : undefined}
          className={styles.pickBtn}
          data-editor-autofocus=""
          data-start-option="photos"
          disabled={disabled}
          onClick={() => {
            if (!photosWaiting) pick.current?.click();
          }}
          type="button"
        >
          <Icon aria-hidden="true" className={styles.pickIcon} name="image" />
          选择照片
        </button>
        {coarse ? (
          <button
            aria-describedby={hintId}
            aria-disabled={photosWaiting ? "true" : undefined}
            className={styles.pickBtn}
            data-start-option="camera"
            disabled={disabled}
            onClick={() => {
              if (!photosWaiting) capture.current?.click();
            }}
            type="button"
          >
            <Glyph className={styles.pickIcon} name="camera" size={28} />
            拍照
          </button>
        ) : null}
        {topic === null ? null : (
          <button
            aria-busy={topicBusy || undefined}
            aria-describedby={topicHintId}
            aria-disabled={topicWaiting ? "true" : undefined}
            className={styles.pickBtn}
            data-start-option="topic"
            disabled={topic.disabled}
            onClick={() => {
              if (!topicWaiting) topic.onCreate();
            }}
            type="button"
          >
            <Icon
              aria-hidden="true"
              className={styles.pickIcon}
              name={ARTICLE_TOPIC_ICON}
            />
            {topicBusy ? "正在创建…" : topic.retry ? "重试确认创建" : "专题"}
          </button>
        )}
      </div>
      {topic === null ? null : (
        <span className={editorStyles.visuallyHidden} id={topicHintId}>
          新建一篇专题文章草稿，并打开文章编辑
        </span>
      )}
      <p className={styles.pickHint} id={hintId}>
        {disabled
          ? SELECTION_UNAVAILABLE
          : "可一次选择多张，本次上传静态照片。"}
      </p>
      {topic === null || topic.notice === null ? null : (
        <p className={styles.pickHint} data-start-topic-notice="" role="alert">
          {topic.notice}
        </p>
      )}
      {onSkip === null ? null : (
        <button
          className={styles.skipBtn}
          data-media-skip=""
          disabled={topicBusy}
          onClick={onSkip}
          type="button"
        >
          先写标题和正文
        </button>
      )}
    </div>
  );
};

export interface AddSheetProps {
  /** Photos in the work now: 已选 N 项. */
  readonly count: number;
  readonly maxItems: number;
  /** 原图画质 for the next photos (`editor.state.originalNext`). */
  readonly original: boolean;
  /**
   * The switch: the screen remembers the choice for the device
   * (`storeOriginalQuality`), sets `originalNext` and says it.
   */
  readonly onOriginalChange: (next: boolean) => void;
  /** No photo can be added now (the limit, no session): the picks wait. */
  readonly disabled?: boolean | undefined;
  /**
   * 选择照片: clicks the strip's own pick input. The sheet's `<dialog>` is
   * already closed when this runs, so the input is not inert; `onClose`
   * follows.
   */
  readonly onPhotos: () => void;
  /** 拍照 (coarse pointers only): clicks the strip's capture input, as `onPhotos`. */
  readonly onCamera: () => void;
  /** 取消, Escape, a tap outside, and after 选择照片 / 拍照: the sheet goes. */
  readonly onClose: () => void;
}

/**
 * 编辑's + (r4 ASK-3 「菜单」, `dialog[data-phone-sheet="add"]`): 原图画质
 * for the next photos, then 选择照片 (focused first) and, on a phone, 拍照.
 * The inputs stay in the strip's + cell, as one inside the sheet would
 * unmount with it before its `change` fires: a choice closes this
 * `<dialog>` element first (`closeSheetDialog`), clicks the input in the
 * same tap, then lets the screen drop the sheet.
 */
export const AddSheet = ({
  count,
  maxItems,
  original,
  onOriginalChange,
  disabled = false,
  onPhotos,
  onCamera,
  onClose,
}: AddSheetProps) => {
  const coarse = useCoarsePointer();
  const choose =
    (open: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
      closeSheetDialog(event.currentTarget);
      open();
      onClose();
    };
  return (
    <PhoneSheet
      initialFocus='[data-add-option="photos"]'
      name="add"
      onCancel={onClose}
      subtitle={`已选 ${count} 项 · 最多 ${maxItems} 项`}
      title="添加照片"
    >
      <div className={styles.shActions}>
        <QualitySwitch onToggle={onOriginalChange} original={original} />
        <button
          className={styles.inkBtn}
          data-add-option="photos"
          disabled={disabled}
          onClick={choose(onPhotos)}
          type="button"
        >
          选择照片
        </button>
        {coarse ? (
          <button
            className={styles.plainBtn}
            data-add-option="camera"
            disabled={disabled}
            onClick={choose(onCamera)}
            type="button"
          >
            拍照
          </button>
        ) : null}
        <button
          className={styles.plainBtn}
          data-add-option="cancel"
          onClick={onClose}
          type="button"
        >
          取消
        </button>
      </div>
    </PhoneSheet>
  );
};
