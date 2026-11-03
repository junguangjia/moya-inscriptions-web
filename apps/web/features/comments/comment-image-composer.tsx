"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { CommentImage } from "@moya/contracts";
import { authorClient } from "../authors/author-data";
import { useBoundedPreview } from "../publishing/ui/media/media-preview";
import { THUMBNAIL_EDGE } from "../publishing/ui/media/bounded-preview";
import {
  COMMENT_IMAGE_LIMITS,
  createCommentImageComposerState,
} from "./comment-image-composer-state";
import type {
  CommentImageComposerItem,
  CommentImageComposerOptions,
  CommentImagePick,
} from "./comment-image-composer-state";
import styles from "./comment-image-composer.module.css";

export type {
  CommentImageComposerItem,
  CommentImageComposerOptions,
  CommentImagePick,
  CommentImageSubmission,
} from "./comment-image-composer-state";
export { CommentImageError } from "./comment-image-composer-state";

/** Add to the existing textarea host; this hook never owns or replaces its text. */
export function useCommentImageComposer(options: CommentImageComposerOptions) {
  const [controller] = useState(() => createCommentImageComposerState(options));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const epoch = authorClient.accountEpoch();
  useLayoutEffect(() => {
    controller.activate();
    return controller.dispose;
  }, [controller]);
  useLayoutEffect(() => {
    controller.configure(options);
  }, [
    controller,
    options.accountId,
    options.scopeKey,
    options.text,
    options.disabled,
    options.revalidating,
    epoch,
  ]);
  // A changed host scope never paints a previous account/content's preview while
  // the layout effect retires that session.
  const current =
    state.accountId === options.accountId &&
    state.scopeKey === options.scopeKey;
  const owner =
    options.accountId !== null && authorClient.account() === options.accountId;
  const disabled =
    !!options.disabled || !!options.revalidating || !owner || !current;
  return {
    ...state,
    items: current && owner ? state.items : [],
    previewImages: current && owner ? state.previewImages : [],
    hasImages: current && owner && state.hasImages,
    ready: current && !disabled && state.ready,
    disabled,
    pickerKey: JSON.stringify([options.accountId, options.scopeKey, epoch]),
    limits: COMMENT_IMAGE_LIMITS,
    captureSelection: controller.captureSelection,
    textChanged: controller.textChanged,
    normalizedTextChanged: controller.normalizedTextChanged,
    addFiles: controller.addFiles,
    beginFilePick: controller.beginFilePick,
    finishFilePick: controller.finishFilePick,
    cancelFilePick: controller.cancelFilePick,
    remove: controller.remove,
    retry: controller.retry,
    useOriginal: controller.useOriginal,
    retryConnection: controller.retryConnection,
    moveToCaret: controller.moveToCaret,
    reorder: controller.reorder,
    prepareSubmission: controller.prepareSubmission,
    localStill: controller.localStill,
  };
}

export type CommentImageComposer = ReturnType<typeof useCommentImageComposer>;

export const commentImageUploadStatus = (
  item: CommentImageComposerItem,
): string => {
  const image = item.upload;
  switch (image.phase) {
    case "ready":
      return "已就绪";
    case "failed":
    case "paused":
      return "上传未完成，请重试";
    case "needs_choice":
      return "当前浏览器无法优化，可使用原图";
    case "missing_local":
      return "本地图片不可用，请重新选择";
    case "cleanup":
      return "正在移除…";
    case "uploaded":
    case "processing":
      return "正在处理…";
    case "uploading": {
      const total = image.components.reduce(
        (sum, component) => sum + component.byteSize,
        0,
      );
      const sent = image.components.reduce(
        (sum, component) => sum + component.bytesSent,
        0,
      );
      return total > 0
        ? `正在上传 ${Math.min(100, Math.floor((sent / total) * 100))}%`
        : "正在上传…";
    }
    default:
      return "正在准备…";
  }
};

function DraftImage({
  item,
  index,
  composer,
  disabled,
  before,
  after,
  preserveCaret,
}: {
  readonly item: CommentImageComposerItem;
  readonly index: number;
  readonly composer: CommentImageComposer;
  readonly disabled: boolean;
  readonly before: boolean;
  readonly after: boolean;
  readonly preserveCaret: () => void;
}) {
  const local = useBoundedPreview(
    composer.localStill(item.key),
    THUMBNAIL_EDGE,
  );
  const src = item.upload.serverItem?.media?.thumbSrc ?? local.url;
  const status = commentImageUploadStatus(item);
  const keepFocus = (event: MouseEvent) => {
    preserveCaret();
    if (event.button === 0) event.preventDefault();
  };
  return (
    <li className={styles.item} data-comment-image-state={item.upload.phase}>
      <div className={styles.thumbnail}>
        {src ? (
          <img src={src} alt={`附图 ${index + 1} 预览`} decoding="async" />
        ) : (
          <span>图片 {index + 1}</span>
        )}
      </div>
      <div className={styles.details}>
        <span className={styles.position}>
          图片 {index + 1} · {item.positionLabel}
        </span>
        <span className={styles.status}>{status}</span>
        <div className={styles.actions}>
          {(item.upload.phase === "failed" ||
            item.upload.phase === "paused") && (
            <button
              type="button"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => void composer.retry(item.key)}
              aria-label={`重试图片 ${index + 1}`}
            >
              重试
            </button>
          )}
          {item.upload.phase === "needs_choice" && (
            <button
              type="button"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => void composer.useOriginal(item.key)}
              aria-label={`图片 ${index + 1} 使用原图`}
            >
              使用原图
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => composer.moveToCaret(item.key)}
            aria-label={`图片 ${index + 1} 移到光标位置`}
          >
            移到光标
          </button>
          <button
            type="button"
            disabled={disabled || !before}
            onMouseDown={keepFocus}
            onClick={() => composer.reorder(item.key, -1)}
            aria-label={`图片 ${index + 1} 在当前位置向前移`}
          >
            向前
          </button>
          <button
            type="button"
            disabled={disabled || !after}
            onMouseDown={keepFocus}
            onClick={() => composer.reorder(item.key, 1)}
            aria-label={`图片 ${index + 1} 在当前位置向后移`}
          >
            向后
          </button>
          <button
            type="button"
            disabled={disabled || item.upload.phase === "cleanup"}
            onMouseDown={keepFocus}
            onClick={() => void composer.remove(item.key)}
            aria-label={`移除图片 ${index + 1}`}
          >
            移除
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * One picker/tray reused by horizontal comments and the existing vertical
 * input column. It adds no second text field or send button. The host may reuse
 * its own InlineCommentBody through renderPreview, rather than another renderer.
 */
export function CommentImageComposerControls({
  composer,
  editorRef,
  orientation = "horizontal",
  disabled = false,
  renderPreview,
  onOpenChange,
}: {
  readonly composer: CommentImageComposer;
  readonly editorRef: RefObject<HTMLTextAreaElement | null>;
  readonly orientation?: "horizontal" | "vertical";
  readonly disabled?: boolean;
  readonly renderPreview?: (preview: {
    readonly text: string;
    readonly images: readonly CommentImage[];
  }) => ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const pickerIntent = useRef<CommentImagePick | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const openChanged = useRef(onOpenChange);
  openChanged.current = onOpenChange;
  const controlScope = composer.pickerKey;
  const previousScope = useRef(controlScope);
  // React's delegated onCancel covers dialog elements, not every browser's
  // file-input cancel event. Listen on the exact identity-keyed native node.
  useLayoutEffect(() => {
    const input = picker.current;
    if (input === null) return;
    const cancel = () => {
      const intent = pickerIntent.current;
      if (intent === null || intent.key !== input.dataset.commentImagePickerKey)
        return;
      pickerIntent.current = null;
      composer.cancelFilePick(intent);
    };
    input.addEventListener("cancel", cancel);
    return () => input.removeEventListener("cancel", cancel);
  }, [composer.pickerKey, composer.cancelFilePick]);
  useLayoutEffect(() => {
    if (previousScope.current === controlScope) return;
    previousScope.current = controlScope;
    pickerIntent.current = null;
    setOpen(false);
    if (openRef.current) openChanged.current?.(false);
    openRef.current = false;
  }, [controlScope]);
  useLayoutEffect(
    () => () => {
      if (openRef.current) openChanged.current?.(false);
    },
    [],
  );
  const locked =
    disabled ||
    composer.disabled ||
    composer.pending ||
    composer.adding ||
    composer.reconnecting ||
    composer.mutating;
  const expanded = orientation === "horizontal" || open;
  const remember = () => composer.captureSelection(editorRef.current);
  const show = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
    openChanged.current?.(next);
  };
  const pick = () => {
    remember();
    const intent = composer.beginFilePick();
    if (intent === null) return;
    pickerIntent.current = intent;
    try {
      picker.current?.click();
    } catch {
      pickerIntent.current = null;
      composer.cancelFilePick(intent);
    }
  };
  const keepFocus = (event: MouseEvent) => {
    remember();
    if (event.button === 0) event.preventDefault();
  };
  return (
    <div
      className={styles.controls}
      data-comment-image-controls=""
      data-orientation={orientation}
    >
      <input
        key={composer.pickerKey}
        ref={picker}
        data-comment-image-picker-key={composer.pickerKey}
        className={styles.fileInput}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        aria-label="选择评论图片"
        tabIndex={-1}
        disabled={
          disabled ||
          (!composer.picking &&
            (locked || composer.items.length >= composer.limits.maxImages))
        }
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          const intent = pickerIntent.current;
          if (
            intent === null ||
            intent.key !== event.currentTarget.dataset.commentImagePickerKey
          )
            return;
          pickerIntent.current = null;
          if (disabled) {
            composer.cancelFilePick(intent);
            return;
          }
          if (files.length > 0) show(true);
          void composer.finishFilePick(files, intent);
        }}
      />
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={
          locked ||
          (orientation === "horizontal" &&
            composer.items.length >= composer.limits.maxImages)
        }
        aria-label={
          orientation === "vertical" && composer.hasImages
            ? `管理附图，共 ${composer.items.length} 张`
            : "添加图片"
        }
        aria-expanded={orientation === "vertical" ? expanded : undefined}
        onMouseDown={keepFocus}
        onClick={() => {
          if (orientation === "vertical" && composer.hasImages) show(!open);
          else pick();
        }}
      >
        {orientation === "vertical"
          ? `附图${composer.items.length ? ` ${composer.items.length}` : ""}`
          : "添加图片"}
      </button>
      <span className={styles.liveStatus} role="status">
        {composer.notice ||
          (composer.adding
            ? "正在添加图片…"
            : composer.picking
              ? composer.revalidating
                ? "正在确认登录状态，所选图片已保留。"
                : "正在选择图片…"
              : composer.connectionPaused
                ? "图片连接已暂停，请恢复连接后发送。"
                : "")}
      </span>
      {composer.picking && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            pickerIntent.current = null;
            composer.cancelFilePick();
          }}
        >
          取消选图
        </button>
      )}
      {expanded &&
        (composer.hasImages ||
          composer.notice ||
          composer.connectionPaused) && (
          <div
            className={styles.panel}
            data-comment-image-panel=""
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (orientation === "vertical") {
                event.preventDefault();
                event.stopPropagation();
                show(false);
                trigger.current?.focus();
              }
            }}
          >
            <div className={styles.heading}>
              <strong>
                附图 {composer.items.length} / {composer.limits.maxImages}
              </strong>
              {orientation === "vertical" && (
                <button
                  type="button"
                  onClick={() => show(false)}
                  aria-label="收起附图面板"
                >
                  收起
                </button>
              )}
            </div>
            <p className={styles.help}>
              先在输入框定位光标，再添加图片；“移到光标”可调整位置。同一位置的图片可向前、向后排序。
            </p>
            {composer.connectionPaused && (
              <button
                type="button"
                className={styles.action}
                disabled={locked}
                onMouseDown={keepFocus}
                onClick={() => void composer.retryConnection()}
              >
                {composer.reconnecting ? "恢复中…" : "恢复图片连接"}
              </button>
            )}
            <ul className={styles.items} aria-label="已选评论图片">
              {composer.items.map((item, index) => (
                <DraftImage
                  key={item.key}
                  item={item}
                  index={index}
                  composer={composer}
                  disabled={locked}
                  before={
                    index > 0 &&
                    composer.items[index - 1]!.offset === item.offset
                  }
                  after={
                    index < composer.items.length - 1 &&
                    composer.items[index + 1]!.offset === item.offset
                  }
                  preserveCaret={remember}
                />
              ))}
            </ul>
            {orientation === "vertical" && (
              <button
                type="button"
                className={styles.action}
                disabled={
                  locked || composer.items.length >= composer.limits.maxImages
                }
                onMouseDown={keepFocus}
                onClick={pick}
              >
                继续添加图片
              </button>
            )}
            {renderPreview && composer.previewImages.length > 0 && (
              <div className={styles.preview}>
                <span className={styles.help}>
                  发送效果预览
                  {composer.previewImages.length < composer.items.length
                    ? "（其余图片仍在处理）"
                    : ""}
                </span>
                {renderPreview({
                  text: composer.previewText,
                  images: composer.previewImages,
                })}
              </div>
            )}
          </div>
        )}
    </div>
  );
}
