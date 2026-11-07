"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { CommentImage } from "@moya/contracts";
import { Icon } from "@moya/ui";
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

function AttachmentSymbol({
  name,
}: {
  readonly name: "caret" | "retry" | "check" | "preview";
}) {
  const paths = {
    caret: "M5 4h6M8 4v16M5 20h6M20 12h-8m4-4-4 4 4 4",
    retry: "M20 10a8 8 0 1 0-2 8M20 4v6h-6",
    check: "m5 12 4 4L19 6",
    preview:
      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  };
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

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
    <li
      className={styles.item}
      data-comment-image-state={item.upload.phase}
      aria-label={`图片 ${index + 1} · ${item.positionLabel}`}
    >
      <div className={styles.thumbnail}>
        {src ? (
          <img src={src} alt={`附图 ${index + 1} 预览`} decoding="async" />
        ) : (
          <Icon name="image" />
        )}
        <span className={styles.number} aria-hidden="true">
          {index + 1}
        </span>
        <span
          className={styles.uploadState}
          role="img"
          aria-label={status}
          title={status}
        >
          {item.upload.phase === "ready" ? (
            <AttachmentSymbol name="check" />
          ) : ["failed", "paused", "needs_choice", "missing_local"].includes(
              item.upload.phase,
            ) ? (
            <Icon name="error" size="sm" />
          ) : (
            <span className={styles.progress} />
          )}
        </span>
      </div>
      <div className={styles.details}>
        <span
          className={
            item.upload.phase === "missing_local"
              ? styles.notice
              : styles.srOnly
          }
        >
          {status}
        </span>
        <div className={styles.actions}>
          {(item.upload.phase === "failed" ||
            item.upload.phase === "paused") && (
            <button
              type="button"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => void composer.retry(item.key)}
              aria-label={`重试图片 ${index + 1}`}
              title="重试"
            >
              <AttachmentSymbol name="retry" />
            </button>
          )}
          {item.upload.phase === "needs_choice" && (
            <button
              type="button"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => void composer.useOriginal(item.key)}
              aria-label={`图片 ${index + 1} 使用原图`}
              title="当前浏览器无法优化，使用原图"
            >
              原图
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => composer.moveToCaret(item.key)}
            aria-label={`图片 ${index + 1} 移到光标位置`}
            title="移到光标位置"
          >
            <AttachmentSymbol name="caret" />
          </button>
          <button
            type="button"
            disabled={disabled || !before}
            onMouseDown={keepFocus}
            onClick={() => composer.reorder(item.key, -1)}
            aria-label={`图片 ${index + 1} 在当前位置向前移`}
            title="向前移"
          >
            <Icon name="previous" />
          </button>
          <button
            type="button"
            disabled={disabled || !after}
            onMouseDown={keepFocus}
            onClick={() => composer.reorder(item.key, 1)}
            aria-label={`图片 ${index + 1} 在当前位置向后移`}
            title="向后移"
          >
            <Icon name="next" />
          </button>
          <button
            type="button"
            disabled={disabled || item.upload.phase === "cleanup"}
            onMouseDown={keepFocus}
            onClick={() => void composer.remove(item.key)}
            aria-label={`移除图片 ${index + 1}`}
            title="移除"
          >
            <Icon name="close" />
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
  active = true,
  onPanelTopChange,
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
  /** Portaled controls must follow the host's actual visibility. */
  readonly active?: boolean;
  readonly onPanelTopChange?: (top: number | null) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const pickerIntent = useRef<CommentImagePick | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ bottom: 0, height: 0 });
  const openRef = useRef(false);
  const openChanged = useRef(onOpenChange);
  openChanged.current = onOpenChange;
  const controlScope = composer.pickerKey;
  const previousScope = useRef(controlScope);
  const panelVisible =
    active &&
    (orientation === "horizontal" || open) &&
    (composer.hasImages || !!composer.notice || composer.connectionPaused);
  // Inactive tabs retain their reader state; a body portal follows the real
  // host visibility, rather than only its saved comments region.
  useLayoutEffect(() => {
    if (!open || orientation !== "vertical") return;
    const anchor = trigger.current;
    if (!anchor) return;
    const ancestors: HTMLElement[] = [];
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement)
      ancestors.push(node);
    const hide = () => {
      setOpen(false);
      if (openRef.current) openChanged.current?.(false);
      openRef.current = false;
    };
    const check = () => {
      if (
        ancestors.some(
          (node) =>
            node.hidden ||
            node.hasAttribute("inert") ||
            node.getAttribute("aria-hidden") === "true" ||
            getComputedStyle(node).display === "none" ||
            getComputedStyle(node).visibility === "hidden",
        )
      )
        hide();
    };
    check();
    const mutations = new MutationObserver(check);
    for (const node of ancestors)
      mutations.observe(node, {
        attributes: true,
        attributeFilter: ["hidden", "inert", "aria-hidden", "style", "class"],
      });
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            if (entry && !entry.isIntersecting) hide();
          })
        : null;
    intersection?.observe(anchor);
    return () => {
      mutations.disconnect();
      intersection?.disconnect();
    };
  }, [open, orientation]);
  useLayoutEffect(() => {
    if (
      !open ||
      composer.hasImages ||
      composer.notice ||
      composer.connectionPaused ||
      composer.adding ||
      composer.picking
    )
      return;
    setOpen(false);
    if (openRef.current) openChanged.current?.(false);
    openRef.current = false;
  }, [
    open,
    composer.hasImages,
    composer.notice,
    composer.connectionPaused,
    composer.adding,
    composer.picking,
  ]);
  useLayoutEffect(() => {
    if (active) return;
    setOpen(false);
    if (openRef.current) openChanged.current?.(false);
    openRef.current = false;
  }, [active]);
  useLayoutEffect(() => {
    if (!panelVisible || orientation !== "vertical") return;
    const visual = window.visualViewport;
    const fit = () =>
      setViewport({
        bottom: Math.max(
          0,
          window.innerHeight -
            ((visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight)),
        ),
        height: visual?.height ?? window.innerHeight,
      });
    fit();
    visual?.addEventListener("resize", fit);
    visual?.addEventListener("scroll", fit);
    window.addEventListener("resize", fit);
    return () => {
      visual?.removeEventListener("resize", fit);
      visual?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
    };
  }, [panelVisible, orientation]);
  useLayoutEffect(() => {
    if (!panelVisible || orientation !== "vertical") {
      onPanelTopChange?.(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => onPanelTopChange?.(panel.getBoundingClientRect().top);
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
      onPanelTopChange?.(null);
    };
  }, [panelVisible, orientation, viewport, onPanelTopChange]);
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
    setPreviewOpen(false);
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
  const expanded = active && (orientation === "horizontal" || open);
  const remember = () => composer.captureSelection(editorRef.current);
  const show = (next: boolean) => {
    next = active && next;
    openRef.current = next;
    setOpen(next);
    openChanged.current?.(next);
  };
  const close = () => {
    const restoreFocus = panelRef.current?.contains(document.activeElement);
    show(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
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
  const liveNotice =
    composer.notice ||
    (composer.adding
      ? "正在添加图片…"
      : composer.picking
        ? composer.revalidating
          ? "正在确认登录状态，所选图片已保留。"
          : "正在选择图片…"
        : composer.connectionPaused
          ? "图片连接已暂停，请恢复连接后发送。"
          : "");
  const panel = panelVisible ? (
    <div
      ref={panelRef}
      id={panelId}
      role="region"
      aria-label="附图管理"
      className={styles.panel}
      data-comment-image-panel=""
      data-orientation={orientation}
      style={
        orientation === "vertical"
          ? {
              bottom: `calc(${viewport.bottom}px + max(var(--yoyi-space-3), env(safe-area-inset-bottom)))`,
              maxHeight: viewport.height
                ? `${Math.min(320, Math.max(136, viewport.height * 0.4), Math.max(80, viewport.height - 100))}px`
                : undefined,
            }
          : undefined
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          orientation !== "vertical"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div className={styles.heading}>
        <span
          className={styles.count}
          aria-label={`已选 ${composer.items.length} 张，最多 ${composer.limits.maxImages} 张`}
        >
          <Icon name="image" /> {composer.items.length}
          <span aria-hidden="true">/ {composer.limits.maxImages}</span>
        </span>
        <div className={styles.actions}>
          {renderPreview &&
            composer.previewImages.length > 0 &&
            orientation === "vertical" && (
              <button
                type="button"
                aria-label="预览发送效果"
                title="预览发送效果"
                aria-pressed={previewOpen}
                onMouseDown={keepFocus}
                onClick={() => setPreviewOpen(!previewOpen)}
              >
                <AttachmentSymbol name="preview" />
              </button>
            )}
          {composer.connectionPaused && (
            <button
              type="button"
              disabled={locked}
              onMouseDown={keepFocus}
              onClick={() => void composer.retryConnection()}
              aria-label="恢复图片连接"
              title="恢复图片连接"
            >
              <AttachmentSymbol name="retry" />
            </button>
          )}
          {orientation === "vertical" && (
            <button
              type="button"
              disabled={
                locked || composer.items.length >= composer.limits.maxImages
              }
              onMouseDown={keepFocus}
              onClick={pick}
              aria-label="继续添加图片"
              title="添加图片"
            >
              <span className={styles.plus} aria-hidden="true">
                ＋
              </span>
            </button>
          )}
          {orientation === "vertical" && (
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={close}
              aria-label="收起附图面板"
              title="收起"
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
      {composer.notice && <p className={styles.notice}>{composer.notice}</p>}
      <div className={styles.panelBody}>
        <ul className={styles.items} aria-label="已选评论图片">
          {composer.items.map((item, index) => (
            <DraftImage
              key={item.key}
              item={item}
              index={index}
              composer={composer}
              disabled={locked}
              before={
                index > 0 && composer.items[index - 1]!.offset === item.offset
              }
              after={
                index < composer.items.length - 1 &&
                composer.items[index + 1]!.offset === item.offset
              }
              preserveCaret={remember}
            />
          ))}
        </ul>
        {renderPreview &&
          composer.previewImages.length > 0 &&
          (orientation === "horizontal" || previewOpen) && (
            <div className={styles.preview} aria-label="发送效果预览">
              {renderPreview({
                text: composer.previewText,
                images: composer.previewImages,
              })}
            </div>
          )}
      </div>
    </div>
  ) : null;
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
        title={composer.hasImages ? "管理附图" : "添加图片"}
        aria-expanded={orientation === "vertical" ? expanded : undefined}
        tabIndex={orientation === "vertical" && open ? -1 : undefined}
        aria-controls={panelVisible ? panelId : undefined}
        onMouseDown={keepFocus}
        onClick={(event) => {
          if (orientation === "vertical" && composer.hasImages) {
            show(!open);
            if (!open && event.detail === 0)
              requestAnimationFrame(() =>
                panelRef.current
                  ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                  ?.focus({ preventScroll: true }),
              );
          } else pick();
        }}
      >
        <Icon name="image" />
        {composer.items.length > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {composer.items.length}
          </span>
        )}
        {liveNotice && !composer.hasImages && (
          <span className={styles.noticeDot} aria-hidden="true" />
        )}
      </button>
      <span className={styles.srOnly} role="status">
        {liveNotice}
      </span>
      {composer.notice && orientation === "horizontal" && !panelVisible && (
        <p className={styles.notice}>{composer.notice}</p>
      )}
      {composer.picking && (
        <button
          type="button"
          className={styles.action}
          aria-label="取消选图"
          title="取消选图"
          onClick={() => {
            pickerIntent.current = null;
            composer.cancelFilePick();
          }}
        >
          <Icon name="close" />
        </button>
      )}
      {orientation === "vertical" && panel
        ? createPortal(panel, document.body)
        : panel}
    </div>
  );
}
