"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { THUMBNAIL_EDGE } from "./bounded-preview";
import { FULL_EDIT } from "./media-geometry";
import { EditedImage, useBoundedPreview } from "./media-preview";
import { isVerifiedLive, itemStatus } from "./media-status";
import styles from "./media.module.css";

import type { RetryPlan } from "./media-status";
import type { ItemDerivation } from "../../edit-readiness";
import type { UploadItemView } from "../../upload-manager";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";
import type { CSSProperties, KeyboardEvent } from "react";

/**
 * One ordered item (M02, M03, U03): visible order number, preview in its
 * edited frame, quality/LIVE/cover badges, the upload state, and the item
 * actions. The whole non-control card is draggable; the preview remains the
 * keyboard activator. Touch long press also selects the card. Child action
 * buttons keep their own gestures and never start sorting.
 */

export type CoverRole = "chosen" | "default" | null;

export interface MediaItemTileProps {
  readonly selecting: boolean;
  readonly selected: boolean;
  readonly onToggleSelection: (key: string) => void;
  readonly item: WorkDraftItem;
  readonly index: number;
  readonly count: number;
  readonly view: UploadItemView | undefined;
  /** The account's view when this browser's manager does not track the item. */
  readonly server: PublishingMediaItem | undefined;
  /** The local still while the account has no derivative (object URL made here). */
  readonly localStill: Blob | null;
  readonly cover: CoverRole;
  /** The editor has loaded: an item nobody can describe is unavailable, not loading. */
  readonly loaded: boolean;
  /** Whether the item's edit derivatives exist on the account (edit-readiness.ts). */
  readonly derivation: ItemDerivation;
  /** The account's thumbnail of the edited item, once its derivatives exist. */
  readonly editedThumbSrc: string | null;
  readonly reducedMotion: boolean;
  readonly onMove: (key: string, offset: -1 | 1) => void;
  readonly onRemove: (key: string) => void;
  readonly onSetCover: (key: string) => void;
  readonly onComposeCover: (key: string) => void;
  readonly onEdit: (key: string) => void;
  readonly onRetry: (key: string, plan: RetryPlan) => void;
  readonly onChooseOriginal: (key: string) => void;
  readonly onReselect: (key: string) => void;
}

const kindText = (item: WorkDraftItem) =>
  item.kind === "live" ? "实况照片" : "照片";

/**
 * The picture a tile (or the composer's rail) shows for an item: the
 * account's edited thumbnail once its derivatives exist, else the account's
 * thumbnail or a bounded copy of the local still, drawn in its edited frame.
 */
export const useItemThumb = ({
  view,
  server,
  localStill,
  editedThumbSrc,
  edit,
}: {
  readonly view: UploadItemView | undefined;
  readonly server: PublishingMediaItem | undefined;
  readonly localStill: Blob | null;
  readonly editedThumbSrc: string | null;
  readonly edit: WorkDraftItem["edit"];
}) => {
  const account = view === undefined ? (server ?? null) : view.serverItem;
  const serverMedia = account?.media ?? null;
  // A bounded copy of the local still, never the original, at tile size.
  const local = useBoundedPreview(
    serverMedia === null ? localStill : null,
    THUMBNAIL_EDGE,
  );
  // The account's edited thumbnail already carries the edit; anything else
  // is shown in its edited frame here.
  const edited = editedThumbSrc !== null && serverMedia !== null;
  return {
    account,
    serverMedia,
    local,
    edited,
    src: edited ? editedThumbSrc : (serverMedia?.thumbSrc ?? local.url),
    edit: edited ? FULL_EDIT : edit,
    knownSize: edited
      ? null
      : (account?.presentation ?? (serverMedia === null ? local.size : null)),
  };
};

export const MediaItemTile = ({
  selecting,
  selected,
  onToggleSelection,
  item,
  index,
  count,
  view,
  server,
  localStill,
  cover,
  loaded,
  derivation,
  editedThumbSrc,
  reducedMotion,
  onMove,
  onRemove,
  onSetCover,
  onComposeCover,
  onEdit,
  onRetry,
  onChooseOriginal,
  onReselect,
}: MediaItemTileProps) => {
  const sortable = useSortable({
    id: item.key,
    attributes: { roleDescription: "可排序的图片" },
    ...(reducedMotion ? { transition: null } : {}),
  });
  const number = index + 1;
  const status = itemStatus(view, server, { loaded, item, derivation });
  const thumb = useItemThumb({
    view,
    server,
    localStill,
    editedThumbSrc,
    edit: item.edit,
  });
  const { edited } = thumb;
  const previewSrc = thumb.src;
  const previewEdit = thumb.edit;
  const presentation = thumb.knownSize;
  const live = isVerifiedLive(view, server);
  const statusId = `media-item-${item.key}-status`;
  const style: CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    ...(sortable.transition ? { transition: sortable.transition } : {}),
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !sortable.isDragging
    ) {
      event.preventDefault();
      onMove(item.key, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    sortable.listeners?.onKeyDown?.(event);
  };
  const cardTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    (target.closest("button,input,select,textarea,a") === null ||
      target.closest("[data-media-handle]") !== null);

  return (
    <li
      ref={sortable.setNodeRef}
      className={styles.tile}
      data-dragging={sortable.isDragging ? "true" : undefined}
      data-media-key={item.key}
      data-media-status={status.kind}
      data-media-thumb={edited ? "edited" : undefined}
      data-selected={selected ? "true" : undefined}
      style={style}
      onPointerDown={(event) => {
        if (cardTarget(event.target))
          sortable.listeners?.onPointerDown?.(event);
      }}
      onTouchStart={(event) => {
        if (cardTarget(event.target)) sortable.listeners?.onTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        if (cardTarget(event.target)) onHandleKeyDown(event);
      }}
      onClick={(event) => {
        if (selecting && !sortable.isDragging && cardTarget(event.target))
          onToggleSelection(item.key);
      }}
      onContextMenu={(event) => {
        if (cardTarget(event.target)) event.preventDefault();
      }}
    >
      <button
        aria-label={`选择第 ${number} 项`}
        aria-pressed={selected}
        className={
          selecting ? styles.selectionButton : styles.selectionShortcut
        }
        data-media-select={item.key}
        onClick={() => onToggleSelection(item.key)}
        type="button"
      >
        <span aria-hidden="true">{selected ? "✓" : "○"}</span>
      </button>
      <button
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        aria-describedby={`${sortable.attributes["aria-describedby"]} ${statusId}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        aria-label={`第 ${number} 项，${kindText(item)}，长按可拖动排序或多选`}
        className={styles.handle}
        data-media-handle={item.key}
        type="button"
      >
        <span aria-hidden="true" className={styles.orderNumber}>
          {number}
        </span>
        <EditedImage
          edit={previewEdit}
          fallback={kindText(item)}
          knownSize={presentation}
          src={previewSrc}
        />
      </button>
      <div className={styles.tileBody}>
        <p className={styles.tileTitle}>
          <span>{`第 ${number} 项`}</span>
          {item.qualityMode !== "legacy" && (
            <span
              className={styles.badge}
              data-media-quality={item.qualityMode}
            >
              {item.qualityMode === "original" ? "原图" : "标准"}
            </span>
          )}
          {live && (
            <span className={styles.liveBadge} data-media-live="">
              <span aria-hidden="true">LIVE</span>
              <span className={styles.visuallyHidden}>实况照片</span>
            </span>
          )}
          {cover !== null && (
            <span className={styles.coverBadge} data-media-cover={cover}>
              {cover === "chosen" ? "封面" : "默认封面"}
            </span>
          )}
          {/* Pasted media keeps its label after a reload or restore (the content carries it). */}
          {(item.origin === "clipboard" ||
            view?.notCameraOriginal === true) && (
            <span
              className={styles.badge}
              data-media-clipboard=""
              title="剪贴板中的图片不是相机原始文件"
            >
              来自剪贴板
            </span>
          )}
        </p>
        <div className={styles.tileStatus} id={statusId}>
          <span data-media-state-label="">{status.label}</span>
          {status.kind === "uploading" && (
            <span
              aria-hidden="true"
              className={styles.progress}
              style={
                { "--media-progress": `${status.percent}%` } as CSSProperties
              }
            />
          )}
          {status.kind === "ready" && status.background === "failed" && (
            <span className={styles.mutedText}>{status.message}</span>
          )}
          {(status.kind === "failed" ||
            status.kind === "needs_choice" ||
            status.kind === "missing_local" ||
            status.kind === "unavailable" ||
            (status.kind === "paused" && status.message !== null)) && (
            <span
              className={
                status.kind === "failed" ? styles.errorText : styles.mutedText
              }
            >
              {status.message}
            </span>
          )}
        </div>
        <div className={styles.actions}>
          <button
            aria-label={`上移第 ${number} 项`}
            className={styles.actionButton}
            data-media-action="up"
            disabled={index === 0}
            onClick={() => onMove(item.key, -1)}
            type="button"
          >
            上移
          </button>
          <button
            aria-label={`下移第 ${number} 项`}
            className={styles.actionButton}
            data-media-action="down"
            disabled={index === count - 1}
            onClick={() => onMove(item.key, 1)}
            type="button"
          >
            下移
          </button>
          {status.kind === "ready" &&
            status.background === "failed" &&
            status.retry && (
              <button
                aria-label={`重试第 ${number} 项高清图`}
                className={styles.actionButton}
                data-media-action="retry-high-resolution"
                onClick={() => onRetry(item.key, status.retry!)}
                type="button"
              >
                重试高清图
              </button>
            )}
          {status.kind === "failed" && status.retry !== null && (
            <button
              aria-label={`重试第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="retry"
              onClick={() => onRetry(item.key, status.retry!)}
              type="button"
            >
              重试
            </button>
          )}
          {status.kind === "needs_choice" && (
            <button
              aria-label={`上传原图：第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="original"
              onClick={() => onChooseOriginal(item.key)}
              type="button"
            >
              上传原图
            </button>
          )}
          {status.kind === "missing_local" && (
            <button
              aria-label={`重新选择第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="reselect"
              onClick={() => onReselect(item.key)}
              type="button"
            >
              重新选择
            </button>
          )}
          {cover === "chosen" ? (
            <button
              aria-label={`封面构图：第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="compose-cover"
              onClick={() => onComposeCover(item.key)}
              type="button"
            >
              封面构图
            </button>
          ) : (
            <button
              aria-label={`设为封面：第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="cover"
              onClick={() => onSetCover(item.key)}
              type="button"
            >
              设为封面
            </button>
          )}
          {item.qualityMode !== "legacy" && (
            <button
              aria-label={`编辑第 ${number} 项`}
              className={styles.actionButton}
              data-media-action="edit"
              onClick={() => onEdit(item.key)}
              type="button"
            >
              编辑
            </button>
          )}
          <button
            aria-label={`移除第 ${number} 项`}
            className={styles.actionButton}
            data-media-action="remove"
            onClick={() => onRemove(item.key)}
            type="button"
          >
            移除
          </button>
        </div>
      </div>
    </li>
  );
};
