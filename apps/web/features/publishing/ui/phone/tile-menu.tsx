"use client";

import { Icon } from "@moya/ui";
import { useEffect, useId, useRef } from "react";

import { Glyph } from "./add-tiles";
import { PhotoThumb, chipLabel, qualityText, tileChip } from "./photo-tile";
import styles from "./select-screen.module.css";

import type { FailureSource, PhotoTileModel } from "./photo-tile";
import type { ItemStatus } from "../media/media-status";
import type { MediaActions } from "../media/use-media-actions";
import type { WorkDraftItem } from "@moya/contracts";
import type { ReactNode } from "react";

/**
 * The bottom sheets of the phone screens (#244 r3, mockup B; r4): one idiom
 * for a photo's actions on 编辑, for what a photo needs, for 编辑's Back and
 * + and for 发布's own sheets. A sheet rises from the bottom edge over the
 * dimmed screen, with the photo's thumbnail and its place at the top when it
 * is about one photo; focus starts on the first enabled choice and returns to
 * the opener; Escape and a tap on the dimmed screen close it; choosing an
 * action closes it first. It is a modal `<dialog>` with no history entry, so
 * the rest of the editor is inert while it is open: a choice that opens a
 * file picker through an input outside the sheet closes the `<dialog>`
 * element first (`closeSheetDialog`, r4 D19).
 */

export interface PhoneSheetProps {
  /**
   * `data-phone-sheet`: photo-menu, photo-attention, edit-back (编辑's Back
   * on a new work), add (编辑's +), references (发布), cover-discard
   * (封面构图).
   */
  readonly name: string;
  readonly title: string;
  /** The line under the title. */
  readonly subtitle?: string | null | undefined;
  /** The photo the sheet is about, drawn 44px in the header. */
  readonly thumb?: ReactNode;
  /** A longer explanation under the header, read as the description. */
  readonly description?: string | null | undefined;
  /** 取消, Escape and a tap outside the sheet. */
  readonly onCancel: () => void;
  /**
   * What takes focus when the sheet opens (inside it): the first enabled
   * button by default; a form sheet names its field.
   */
  readonly initialFocus?: string | undefined;
  readonly children: ReactNode;
}

const FIRST_BUTTON = "button:not(:disabled)";

/**
 * Closes the sheet `<dialog>` that holds `from`, at once and without a state
 * change (r4 D19). A modal sheet makes everything outside it inert, so a file
 * input outside the sheet (编辑's strip inputs, the flow's 重新选择 input)
 * cannot be clicked while it is open. A choice that opens a file picker calls
 * this first, then clicks the input in the same handler, then clears the
 * sheet's state. The sheet's unmount skips a dialog already closed and still
 * returns focus to its opener. Nothing happens outside an open `<dialog>`.
 */
export const closeSheetDialog = (from: Element): void => {
  const dialog = from.closest("dialog");
  if (dialog === null || !dialog.open) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
};

export const PhoneSheet = ({
  name,
  title,
  subtitle,
  thumb,
  description,
  onCancel,
  initialFocus = FIRST_BUTTON,
  children,
}: PhoneSheetProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const firstFocus = useRef(initialFocus);

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
    (
      dialog.querySelector<HTMLElement>(firstFocus.current) ??
      dialog.querySelector<HTMLElement>(FIRST_BUTTON)
    )?.focus({ preventScroll: true });
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

  const hasDescription = Boolean(description);

  return (
    <dialog
      ref={ref}
      aria-describedby={hasDescription ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={styles.sheetHost}
      data-phone-sheet={name}
      onCancel={(event) => {
        event.preventDefault();
        // Only its own close request: React passes a nested dialog's on.
        if (event.target !== event.currentTarget) return;
        cancel.current();
      }}
      onKeyDown={(event) => {
        // Escape that cancels an IME composition (Chinese input) is the
        // field's, not the sheet's.
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        cancel.current();
      }}
    >
      <div
        aria-hidden="true"
        className={styles.backdrop}
        data-sheet-backdrop=""
        onClick={() => cancel.current()}
      />
      <div className={styles.sheet}>
        <div className={styles.shHead}>
          {thumb === undefined || thumb === null ? null : (
            <span
              aria-hidden="true"
              className={`${styles.shThumb} ${styles.cover}`}
            >
              {thumb}
            </span>
          )}
          <div className={styles.shTitle}>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
        </div>
        {hasDescription ? (
          <p className={styles.shDesc} id={descriptionId}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>
  );
};

/**
 * The order the photos are drawn in: `ltr` puts 第 1 项 at the left, `rtl`
 * (编辑's strip, r4 R3) at the right edge, as the feed reads.
 */
export type PhotoOrderDirection = "ltr" | "rtl";

export interface TileMenuProps {
  readonly model: PhotoTileModel;
  /** 1-based: 第 N 项. */
  readonly number: number;
  readonly count: number;
  /**
   * Which way 前移 points (towards 第 1 项): left in `ltr` (the default),
   * right in `rtl`. 后移 points the other way. Only the icons change.
   */
  readonly direction?: PhotoOrderDirection | undefined;
  /** 设为首图: the photo moves to position 1. */
  readonly onMakeFirst: () => void;
  readonly onRetryHighResolution?: (() => void) | undefined;
  /** 前移 (−1, towards 第 1 项) and 后移 (+1). */
  readonly onMove: (offset: -1 | 1) => void;
  /** 封面构图, offered on item 1 only (首图 = 封面). */
  readonly onComposeCover: () => void;
  /** 移除: at once; the screen offers 撤销. */
  readonly onRemove: () => void;
  readonly onCancel: () => void;
}

/** The sheet's line under 第 N 项 (B): quality, 实况照片 and a status not yet ready. */
const menuSubtitle = (model: PhotoTileModel): string =>
  [
    qualityText(model.item),
    model.item.kind === "live" ? "实况照片" : null,
    tileChip(model.status, model.failure),
  ]
    .filter((part) => part !== null)
    .join(" · ");

const SheetRow = ({
  action,
  icon,
  label,
  disabled = false,
  danger = false,
  onClick,
}: {
  readonly action: string;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
}) => (
  <button
    className={styles.shRow}
    data-danger={danger ? "" : undefined}
    data-media-action={action}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {icon}
    <span>{label}</span>
  </button>
);

/**
 * A tap on 编辑's current, healthy photo (B's action sheet, r4 D11):
 * 设为首图 · 前移 · 后移 · 封面构图 (item 1 only) · 移除, then 取消. On item 1,
 * 设为首图 and 前移 are disabled and 封面构图 is drawn, so even a single
 * photo's sheet never starts on 移除. `direction="rtl"` mirrors the 前移 and
 * 后移 arrows to the strip's right-to-left order.
 */
export const TileMenu = ({
  model,
  number,
  count,
  direction = "ltr",
  onMakeFirst,
  onRetryHighResolution,
  onMove,
  onComposeCover,
  onRemove,
  onCancel,
}: TileMenuProps) => (
  <PhoneSheet
    name="photo-menu"
    onCancel={onCancel}
    subtitle={menuSubtitle(model)}
    thumb={<PhotoThumb model={model} />}
    title={number === 1 ? "第 1 项 · 首图" : `第 ${number} 项`}
  >
    <div className={styles.shList}>
      {model.status.kind === "ready" &&
        model.status.background === "failed" &&
        onRetryHighResolution && (
          <SheetRow
            action="retry-high-resolution"
            label="重试高清图"
            onClick={onRetryHighResolution}
          />
        )}
      <SheetRow
        action="first"
        disabled={number === 1}
        icon={<Glyph className={styles.rowIcon} name="first" />}
        label="设为首图"
        onClick={onMakeFirst}
      />
      <SheetRow
        action="earlier"
        disabled={number === 1}
        icon={
          <Icon
            aria-hidden="true"
            className={styles.rowIcon}
            name={direction === "rtl" ? "next" : "previous"}
          />
        }
        label="前移"
        onClick={() => onMove(-1)}
      />
      <SheetRow
        action="later"
        disabled={number === count}
        icon={
          <Icon
            aria-hidden="true"
            className={styles.rowIcon}
            name={direction === "rtl" ? "previous" : "next"}
          />
        }
        label="后移"
        onClick={() => onMove(1)}
      />
      {number === 1 ? (
        <SheetRow
          action="compose-cover"
          icon={<Glyph className={styles.rowIcon} name="crop" />}
          label="封面构图"
          onClick={onComposeCover}
        />
      ) : null}
      <SheetRow
        action="remove"
        danger
        icon={<Glyph className={styles.rowIcon} name="trash" />}
        label="移除"
        onClick={onRemove}
      />
    </div>
    <button
      className={styles.shRow}
      data-cancel=""
      data-media-action="cancel"
      onClick={onCancel}
      type="button"
    >
      取消
    </button>
  </PhoneSheet>
);

/** The one action that can resolve an attention state (S1.8 table). */
export type AttentionRemedy =
  "continue" | "original" | "retry" | "reedit" | "reselect";

const remedyLabels: Readonly<Record<AttentionRemedy, string>> = {
  continue: "继续上传",
  original: "上传原图",
  retry: "重试",
  reedit: "重新编辑",
  reselect: "重新选择",
};

/** The remedy's button text. */
export const remedyLabel = (remedy: AttentionRemedy): string =>
  remedyLabels[remedy];

/** Why uploads paused, for a paused photo without its own message. */
export const pauseText = (
  reason: "account" | "offline" | null | undefined,
): string =>
  reason === "account"
    ? "账户状态已变化，上传已暂停"
    : "上传已暂停，确认网络正常后可继续";

/** The media actions a remedy goes through (the flow's `useMediaActions`). */
export type RemedyActions = Pick<
  MediaActions,
  "session" | "chooseOriginal" | "retry" | "reselect"
>;

/**
 * Carries out a remedy the way the strip's own buttons do, on either media
 * screen. 重新编辑 is the caller's: it opens 编辑 at the photo.
 */
export const runRemedy = (
  media: RemedyActions,
  key: string,
  status: ItemStatus,
  remedy: Exclude<AttentionRemedy, "reedit">,
): void => {
  switch (remedy) {
    case "continue":
      void media.session.continueUploads();
      return;
    case "original":
      media.chooseOriginal(key);
      return;
    case "retry":
      if (status.kind === "failed" && status.retry !== null)
        media.retry(key, status.retry);
      return;
    case "reselect":
      // Opens the flow's hidden input inside this click: a sheet that offers
      // it has closed its <dialog> first (`closeSheetDialog`), or the input
      // would be inert.
      media.reselect(key);
      return;
  }
};

export interface Attention {
  readonly title: string;
  readonly description: string;
  readonly remedy: AttentionRemedy | null;
}

/**
 * What a tile in an attention state asks of the author (S1.8, S1.12): the
 * chip's words as the title (缺少本地文件 in full), the status message as
 * the description, and only the remedy the strip offers today. A paused
 * transfer without its own message says why uploads paused (`paused`).
 * Null for every other state: a tap opens the photo's actions instead.
 */
export const attentionOf = (
  item: WorkDraftItem,
  status: ItemStatus,
  failure: FailureSource | null,
  paused: string,
): Attention | null => {
  const title = chipLabel(status, failure);
  switch (status.kind) {
    case "paused":
      return {
        title,
        description: status.message ?? paused,
        remedy: "continue",
      };
    case "needs_choice":
      return { title, description: status.message, remedy: "original" };
    case "failed":
      return {
        title,
        description: status.message,
        remedy:
          failure === "upload"
            ? status.retry === null
              ? null
              : "retry"
            : failure === "edit" && item.qualityMode !== "legacy"
              ? "reedit"
              : null,
      };
    case "missing_local":
      return {
        title: status.label,
        description: status.message,
        remedy: "reselect",
      };
    case "unavailable":
      return { title, description: status.message, remedy: null };
    default:
      return null;
  }
};

export interface FixSheetProps {
  readonly model: PhotoTileModel;
  /** 1-based: 第 N 项. */
  readonly number: number;
  readonly attention: Attention;
  /**
   * The remedy button. For 重新选择 the sheet's `<dialog>` is already closed
   * when this runs (r4 D19), so it may click a file input outside the sheet.
   */
  readonly onRemedy: () => void;
  readonly onRemove: () => void;
  readonly onCancel: () => void;
}

/**
 * A photo that needs the author (B's fix sheet): the state as the title,
 * 第 N 项 under it, the message when it adds to the title, then the remedy
 * (ink, when there is one) · 取消 · 移除 stacked full width. 重新选择 closes
 * the `<dialog>` element before `onRemedy` opens the album (r4 D19).
 */
export const FixSheet = ({
  model,
  number,
  attention,
  onRemedy,
  onRemove,
  onCancel,
}: FixSheetProps) => (
  <PhoneSheet
    description={
      attention.description === attention.title ? null : attention.description
    }
    name="photo-attention"
    onCancel={onCancel}
    subtitle={`第 ${number} 项`}
    thumb={<PhotoThumb model={model} />}
    title={attention.title}
  >
    <div className={styles.shActions}>
      {attention.remedy === null ? null : (
        <button
          className={styles.inkBtn}
          data-media-action={attention.remedy}
          onClick={(event) => {
            if (attention.remedy === "reselect")
              closeSheetDialog(event.currentTarget);
            onRemedy();
          }}
          type="button"
        >
          {remedyLabel(attention.remedy)}
        </button>
      )}
      <button
        className={styles.plainBtn}
        data-media-action="cancel"
        onClick={onCancel}
        type="button"
      >
        取消
      </button>
      <button
        className={styles.plainBtn}
        data-danger=""
        data-media-action="remove"
        onClick={onRemove}
        type="button"
      >
        移除
      </button>
    </div>
  </PhoneSheet>
);
