"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { FEED_CENTRE_Y } from "../../../authors/feed-post-strip-geometry";
import editorStyles from "../editor/editor.module.css";
import { feedWindowHint } from "../media/feed-window-overlay";
import { feedStageWindow, sameEdit } from "../media/media-geometry";
import {
  effectiveCoverKey,
  indexOfKey,
  setItemEdit,
} from "../media/media-order";
import { derivativeExpected } from "../media/media-status";
import { useMediaUiState } from "../media/media-ui-store";
import {
  AddSheet,
  readOriginalQuality,
  storeOriginalQuality,
  useCoarsePointer,
} from "./add-tiles";
import { applyRatioToAll } from "./apply-to-all";
import { COVER_RESET_NOTICE, keepCoverAround } from "./cover-rule";
import styles from "./edit-screen.module.css";
import {
  EditGlyph,
  EditStage,
  feedToolState,
  useStageCrop,
} from "./edit-stage";
import { MediaNotice } from "./media-notice";
import { PhoneNextButton, PhoneScreen } from "./phone-screen";
import { failureSource } from "./photo-tile";
import { FeedFitBar, RatioBar, isPhonePreset } from "./ratio-bar";
import sheetStyles from "./select-screen.module.css";
import {
  FIRST_MARK,
  ThumbnailStrip,
  focusThumb,
  revealThumb,
} from "./thumbnail-strip";
import {
  FixSheet,
  PhoneSheet,
  TileMenu,
  attentionOf,
  pauseText,
  runRemedy,
} from "./tile-menu";

import type { FileOrigin } from "../../import-grouping";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type { CropPreset } from "../media/crop-workspace";
import type {
  AspectPresetId,
  FeedStageWindow,
  Size,
} from "../media/media-geometry";
import type { MediaValue } from "../media/media-order";
import type { MediaActions } from "../media/use-media-actions";
import type { FeedToolState, StageSnapshot } from "./edit-stage";
import type { FeedFit } from "./ratio-bar";
import type { PhotoTileModel } from "./photo-tile";
import type { StripAddInputs, StripSource } from "./thumbnail-strip";
import type { WorkDraftItem } from "@moya/contracts";
import type { ReactNode, Ref, RefObject } from "react";

/**
 * The phone publishing flow's 编辑 (#244 r3, mockup B; r4): the current
 * photo fills the stage between the bar and one control band; the band
 * holds the editor's notices, the ratio row and the strip of every photo,
 * read right to left as the feed (photo 1, the 首图, at the right edge),
 * with 应用到全部 at its left end. Each photo keeps its own crop, 原始比例 (the
 * whole frame) by default, 自由 once a corner or a zoom makes it any other
 * shape (#341); nothing waits for a 完成: the shown edit is kept when the
 * author leaves the photo, turns it, picks a ratio, lets a corner go,
 * presses 还原, pauses for a moment or leaves the screen, never while a
 * finger is still down. A turn, 还原, 应用到全部 and 移除 can be taken back
 * from their toast (撤销).
 *
 * 「动态流」 at the stage's top (#341, off at first) shows what the phone
 * feed shows of each photo and rests the crop meanwhile; for a photo taller
 * than the feed's stage the ratio row turns into 局部 · 整张, and 局部's
 * region is dragged on the stage. Each photo keeps its framing at once, as
 * a ratio; 还原 resets it with the crop and the turn.
 *
 * The order is changed here (r4 R4): a long-press drag in the strip,
 * Alt + arrows, or the current photo's sheet (设为首图 · 前移 · 后移 ·
 * 封面构图 · 移除). Every change keeps 首图 = 封面 and never moves the stage
 * off the photo shown. + opens the add sheet (原图画质 · 选择照片 · 拍照);
 * ‹ on a work started in this editor asks first (重新选择照片 · 存草稿并退出 ·
 * 继续编辑), and a draft or a work leaves.
 */

export interface EditScreenProps {
  /** The editor session: the album, read and written as one edit by 应用到全部. */
  readonly editor: EditorSessionHandle;
  /** PhoneFlow's one `useMediaActions` result (statuses, sources, edits, removal). */
  readonly media: MediaActions;
  /**
   * ‹ on a work started in this editor (`openedAs` new, 参与话题 included):
   * the flow's step back, which opens the back sheet (`phone.backAsk`, r4
   * ASK-1). Nothing is kept first, so 继续编辑 finds the screen as it was.
   */
  readonly onBack: () => void;
  /**
   * Leaves the editor through its leave guard: ‹ on a draft or a published
   * work, and the back sheet's 退出编辑 (a session without drafts, whose
   * guard asks 结束本次编辑？). The crop and a removal waiting for 撤销 are
   * kept first.
   */
  readonly onLeave: () => void;
  /**
   * The back sheet's 存草稿并退出 (r4 ASK-1): saves the draft and leaves in
   * one tap, as the leave dialog's 保存草稿并离开. While the picks are still
   * uploading it waits for them (`saveWait`); closing the sheet (继续编辑,
   * Escape, the browser's Back) ends that wait. A save the runtime refuses
   * (a photo that needs the author, two versions waiting) keeps 编辑, the
   * reason among the editor's notices. Settles either way: with that
   * reason, which the screen says once ‹ has focus again, or null (left,
   * the wait ended, or the leave guard asks). The crop and a removal
   * waiting for 撤销 are kept first.
   */
  readonly onSaveAndLeave: () => Promise<string | null>;
  /**
   * 存草稿并退出 is waiting for the picks' uploads: how many of the album's
   * photos the account has received so far. Null otherwise.
   */
  readonly saveWait?: SaveWait | null | undefined;
  /** 下一步 to 发布 (the crop is kept first). */
  readonly onNext: () => void;
  /**
   * 移除 of the only photo left: nothing remains to edit, so the start
   * screen takes the removal over and offers its 撤销 there. Its crop is
   * kept first.
   */
  readonly onRemoveLast: (key: string) => void;
  /**
   * The back sheet's 重新选择照片: every photo shown (`keys`, album order)
   * goes to the start screen with one 撤销, which returns to `current`. The
   * crop and a waiting removal are kept first.
   */
  readonly onRemoveAll: (keys: readonly string[], current: string) => void;
  /** Files chosen through the strip's inputs (+ and its add sheet). */
  readonly onAddFiles: (files: readonly File[], origin: FileOrigin) => void;
  /** 封面构图 from photo 1's sheet: the flow draws 封面构图 over this screen. */
  readonly onComposeCover: (key: string) => void;
  /**
   * A photo 前往处理 on 发布 sent the author to: its fix sheet opens once,
   * its thumbnail focused beneath, and `onAttentionTaken` clears it.
   */
  readonly attentionKey?: string | null | undefined;
  readonly onAttentionTaken?: (() => void) | undefined;
  /**
   * Photos the start screen holds for 撤销 (`phone.heldRemoval`): never
   * shown here, even for the render before their removal lands.
   */
  readonly heldKeys?: readonly string[] | undefined;
  /**
   * The editor's notices (the local recovery, the media field's error, an
   * ended session), drawn first in the band; null when there are none.
   */
  readonly notices?: ReactNode;
  /** The bar's second line: SaveStatus, given only on a save error or conflict (§2.3). */
  readonly secondLine?: ReactNode;
  /** The shell's Back target when this bar is the editor's. */
  readonly backButtonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * Holds what ‹ keeps while the screen is mounted (the shown crop, then a
   * removal waiting for 撤销), so the editor's leave guard can keep it
   * before a browser Back or Escape leaves the screen.
   */
  readonly commitRef?: RefObject<(() => void) | null> | undefined;
}

/** 存草稿并退出's wait for the uploads: photos received of the album's. */
export interface SaveWait {
  readonly received: number;
  readonly total: number;
  /** A pick is still being read: its photos join the count once in. */
  readonly reading: boolean;
}

/**
 * How often 等待上传完成's progress is said at most: it is seen live, and
 * said when the wait starts and then no more often than this.
 */
export const WAIT_SAY_MS = 5000;

/**
 * `text` for a polite live region, said at once and then at most once per
 * `gap` (the latest text by then), with `lead` before the first; "" while
 * there is nothing to say.
 */
const useSparseStatus = (
  text: string | null,
  lead: string,
  gap: number,
): string => {
  const [said, setSaid] = useState("");
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (text === null) {
      last.current = null;
      setSaid("");
      return undefined;
    }
    const say = () => {
      setSaid(last.current === null ? `${lead}${text}` : text);
      last.current = Date.now();
    };
    const due = last.current === null ? 0 : last.current + gap - Date.now();
    if (due <= 0) {
      say();
      return undefined;
    }
    const timer = setTimeout(say, due);
    return () => clearTimeout(timer);
  }, [text, lead, gap]);
  return said;
};

/** The words `applyEdit` uses when an edit drops the cover composition. */
const EDIT_COVER_RESET = `图片编辑后，${COVER_RESET_NOTICE}，可重新调整`;

/** Why a carried-over photo's tools are off (review r2: never a disabled state alone). */
export const LEGACY_NOTE = "这张图片来自早期作品，不能裁剪或旋转";

/** What the 「动态流」 tool says in the band when there is nothing to choose. */
const feedNote = (
  state: FeedToolState,
  window: FeedStageWindow | null,
): string => {
  if (state === "pending") return "正在确定动态流画幅…";
  if (state === "none") return "这张图片暂时无法预览，不能选择动态流显示";
  return window?.fit === "fill"
    ? "动态流中满幅显示，无需选择"
    : "动态流中整张显示，无需选择";
};

/** What turning 「动态流」 on says for the photo shown. */
const feedToolText = (
  state: FeedToolState,
  window: FeedStageWindow | null,
): string => {
  if (state === "region") return "动态流：上下拖动亮处，选择动态流里显示的部分";
  if (state === "whole") return "动态流：这张整张显示，左右留白";
  return window?.fit === "fill"
    ? "动态流：这张满幅显示，无需选择"
    : "动态流：这张整张显示，无需选择";
};

const hasSize = (size: Size | undefined): boolean =>
  size !== undefined && size.width > 0 && size.height > 0;

/** Photos 应用到全部 leaves as they are until their size is known. */
const unsized = (
  album: readonly WorkDraftItem[],
  sizes: ReadonlyMap<string, Size>,
): readonly WorkDraftItem[] =>
  album.filter(
    (entry) => entry.qualityMode !== "legacy" && !hasSize(sizes.get(entry.key)),
  );

/**
 * What 应用到全部 did (`applyRatioToAll` skips what it cannot crop): how
 * many photos have the ratio now, and how many it left as they are, a
 * carried-over photo for good, one whose size is not known yet for now.
 */
const appliedText = (
  album: readonly WorkDraftItem[],
  sizes: ReadonlyMap<string, Size>,
): string => {
  const legacy = album.filter((entry) => entry.qualityMode === "legacy").length;
  const waiting = unsized(album, sizes).length;
  const reached = album.length - legacy - waiting;
  if (legacy === 0 && waiting === 0) return `已应用到全部 ${reached} 项`;
  return [
    `已应用到 ${reached} 项`,
    waiting > 0 ? `${waiting} 项暂不能裁剪` : null,
    legacy > 0 ? `${legacy} 项不能裁剪` : null,
  ]
    .filter((part) => part !== null)
    .join("，");
};

/** How long a toast stays: without an action, with 撤销, and its fade (mockup B). */
export const TOAST_MS = 2200;
export const TOAST_UNDO_MS = 4200;
const TOAST_FADE_MS = 220;

/** The first-time hint: how long it shows, and where the tab remembers it showed. */
export const HINT_MS = 2400;
const HINT_KEY = "yoyi.publishing.edit-hint-shown";

/**
 * The strip's one-time hint (r4 D13): how long it shows, and where the
 * device remembers it showed.
 */
export const STRIP_HINT_MS = 3200;
export const STRIP_HINT_KEY = "yoyi.publishing.strip-order-hint-shown";

const hintShownBefore = () => {
  try {
    return window.sessionStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
};

const rememberHint = () => {
  try {
    window.sessionStorage.setItem(HINT_KEY, "1");
  } catch {
    // Storage blocked: the hint may show again in another opening.
  }
};

/**
 * Mockup B's first-time hint: the first time the stage shows a photo the
 * author can crop in this tab, for 2.4 s or until the first touch.
 */
const useFirstHint = (ready: boolean) => {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!ready || hintShownBefore()) return;
    rememberHint();
    setShown(true);
    timer.current = setTimeout(() => setShown(false), HINT_MS);
  }, [ready]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setShown(false);
  }, []);
  return { shown, hide };
};

const stripHintShownBefore = () => {
  try {
    return window.localStorage.getItem(STRIP_HINT_KEY) === "1";
  } catch {
    return false;
  }
};

const rememberStripHint = () => {
  try {
    window.localStorage.setItem(STRIP_HINT_KEY, "1");
  } catch {
    // Storage blocked: the hint may show again another time.
  }
};

/**
 * The strip's hint 「长按拖动排序，最右是首图」, once per device: when there
 * are photos to sort and the stage's own hint is done, for 3.2 s or until
 * the author lifts a photo or touches the strip.
 */
const useStripHint = (due: boolean) => {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!due || stripHintShownBefore()) return;
    rememberStripHint();
    setShown(true);
    timer.current = setTimeout(() => setShown(false), STRIP_HINT_MS);
  }, [due]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setShown(false);
  }, []);
  return { shown, hide };
};

/** A sheet over 编辑: the current photo's (actions, or what it needs), or +'s. */
type EditSheet =
  | { readonly type: "menu" | "attention"; readonly key: string }
  | { readonly type: "add" };

const thumbOf = (key: string) => `[data-edit-thumb="${key}"]`;

const NO_KEYS: readonly string[] = [];

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly undo: (() => void) | null;
  /** The flow's announcer already says it: the toast is only seen. */
  readonly quiet: boolean;
  readonly leaving: boolean;
  /** What the toast offers to take back, if it is one the screen ends early. */
  readonly kind: ToastKind | null;
}

/**
 * 应用到全部's 撤销 ends once the author moves on (another photo, a drag);
 * 移除's ends once its removal is made (`commitRemoval`), so a 撤销 that
 * could no longer bring the photo back is never left on screen.
 */
type ToastKind = "apply-all" | "removal";

interface ToastOptions {
  readonly undo?: () => void;
  readonly quiet?: boolean;
  readonly kind?: ToastKind;
  /** Its time is up: 撤销 is no longer offered. */
  readonly onExpire?: () => void;
}

/** Why a toast's time stands still: focus or a pointer is on it. */
type ToastHold = "focus" | "pointer";

/**
 * One toast at a time (mockup B): a new one replaces it; 撤销 runs and
 * clears it. Its time stands still while focus or a pointer is on it, so
 * 撤销 never leaves from under the author (WCAG 2.2.1); `end` takes 撤销
 * back at once, as its time running out would.
 */
const useToast = () => {
  const [toast, setToast] = useState<Toast | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const serial = useRef(0);
  const live = useRef<{
    readonly id: number;
    readonly kind: ToastKind | null;
    readonly onExpire: (() => void) | undefined;
    remaining: number;
    started: number;
  } | null>(null);
  const holds = useRef(new Set<ToastHold>());
  const clear = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);
  const run = useCallback(() => {
    const shown = live.current;
    if (shown === null) return;
    shown.started = Date.now();
    const { id } = shown;
    timers.current = [
      setTimeout(() => {
        live.current = null;
        setToast((current) =>
          current?.id === id ? { ...current, leaving: true } : current,
        );
        shown.onExpire?.();
      }, shown.remaining),
      setTimeout(() => {
        // Focus never falls to the page with the toast: the heading takes it.
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest("[data-edit-toasts]") !== null
        )
          active
            .closest("[data-editor-screen]")
            ?.querySelector<HTMLElement>("[data-editor-step-heading]")
            ?.focus({ preventScroll: true });
        setToast((current) => (current?.id === id ? null : current));
      }, shown.remaining + TOAST_FADE_MS),
    ];
  }, []);
  const show = useCallback(
    (text: string, options: ToastOptions = {}) => {
      clear();
      serial.current += 1;
      const id = serial.current;
      const undo = options.undo ?? null;
      setToast({
        id,
        text,
        undo,
        quiet: options.quiet ?? false,
        leaving: false,
        kind: options.kind ?? null,
      });
      holds.current.clear();
      live.current = {
        id,
        kind: options.kind ?? null,
        onExpire: options.onExpire,
        remaining: undo === null ? TOAST_MS : TOAST_UNDO_MS,
        started: Date.now(),
      };
      run();
    },
    [clear, run],
  );
  const hold = useCallback(
    (why: ToastHold) => {
      const shown = live.current;
      if (shown === null || holds.current.has(why)) return;
      holds.current.add(why);
      if (holds.current.size > 1) return;
      clear();
      shown.remaining = Math.max(
        0,
        shown.remaining - (Date.now() - shown.started),
      );
    },
    [clear],
  );
  const release = useCallback(
    (why: ToastHold) => {
      if (!holds.current.delete(why) || holds.current.size > 0) return;
      run();
    },
    [run],
  );
  const dismiss = useCallback(() => {
    clear();
    live.current = null;
    holds.current.clear();
    setToast(null);
  }, [clear]);
  /** Ends a showing toast of `kind` now: 撤销 goes and its time is up. */
  const end = useCallback(
    (kind: ToastKind) => {
      const shown = live.current;
      if (shown === null || shown.kind !== kind) return;
      clear();
      live.current = null;
      holds.current.clear();
      setToast((current) => (current?.id === shown.id ? null : current));
      shown.onExpire?.();
    },
    [clear],
  );
  useEffect(() => clear, [clear]);
  return { toast, show, dismiss, hold, release, end };
};

export const EditScreen = (props: EditScreenProps) => {
  const { phone } = useMediaUiState(props.media.ui);
  // A photo taken away by 移除 leaves the screen at once; its removal (which
  // cancels its upload) waits until 撤销 is no longer offered.
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  // Photos the start screen holds for 撤销 are never shown here (r4 D20).
  const heldKeys = props.heldKeys ?? NO_KEYS;
  const storeHeld = phone.heldRemoval?.keys ?? NO_KEYS;
  const held = [...heldKeys, ...storeHeld];
  const items = props.media.value.items.filter(
    (item) => item.key !== hiddenKey && !held.includes(item.key),
  );
  // Until the author picks a photo, the first one is shown.
  const found =
    phone.currentKey === null
      ? -1
      : items.findIndex((item) => item.key === phone.currentKey);
  const index = Math.max(0, found);
  const item = items[index];
  // No photo left to show: the flow shows the start screen.
  if (item === undefined) return null;
  return (
    <EditWorkspace
      {...props}
      backAsk={phone.backAsk}
      held={held}
      index={index}
      item={item}
      items={items}
      onHide={setHiddenKey}
    />
  );
};

const EditWorkspace = ({
  editor,
  media,
  onBack,
  onLeave,
  onSaveAndLeave,
  saveWait = null,
  onNext,
  onRemoveLast,
  onRemoveAll,
  onAddFiles,
  onComposeCover,
  attentionKey = null,
  onAttentionTaken,
  notices,
  secondLine,
  backButtonRef,
  commitRef,
  backAsk,
  held,
  index,
  item,
  items,
  onHide,
}: EditScreenProps & {
  /** 编辑's back sheet is open (`phone.backAsk`). */
  readonly backAsk: boolean;
  /** Album keys held on the start screen (hidden here). */
  readonly held: readonly string[];
  readonly index: number;
  readonly item: WorkDraftItem;
  /** The photos shown: the album without a waiting or held removal. */
  readonly items: readonly WorkDraftItem[];
  readonly onHide: (key: string | null) => void;
}) => {
  const { ui } = media;
  const count = items.length;
  const number = index + 1;
  const server = media.serverFor(item);
  const status = media.statusOf(item);
  const view = media.views.get(item.key);
  const editable = item.qualityMode !== "legacy";
  // What the photo needs, as the phone's fix sheet offers it (the matrix's
  // remedies). 重新编辑 is this screen itself.
  const attention = attentionOf(
    item,
    status,
    failureSource(status, view, server ?? undefined),
    pauseText(media.uploads?.pauseReason),
  );
  const remedy =
    attention === null || attention.remedy === "reedit"
      ? null
      : attention.remedy;
  const crop = useStageCrop({
    item,
    src: server?.media?.displaySrc ?? null,
    blob: media.session.localStill(item.key),
    knownSize: server?.presentation ?? null,
    drafts: media.ui,
    editable,
    onCommit: media.applyEdit,
    // 继续编辑 finds the screen as it was: nothing is kept meanwhile.
    paused: backAsk,
  });

  const {
    toast,
    show: showToast,
    dismiss: dismissToast,
    hold: holdToast,
    release: releaseToast,
    end: endToast,
  } = useToast();
  const hint = useFirstHint(
    editable && crop.previewable && crop.image !== null,
  );
  // The strip's hint waits for the stage's: while it shows, and while a
  // photo the author can crop has not shown it yet in this tab.
  const stripHint = useStripHint(
    count >= 2 && !hint.shown && !(editable && !hintShownBefore()),
  );
  // 「动态流」 starts off (mockup B) and stays as the author left it from
  // photo to photo, within this opening of 编辑 (#341).
  const [feedTool, setFeedTool] = useState(false);
  // 整张 → 局部 brings back the region each photo had before (this opening).
  const regions = useRef(new Map<string, number>());
  // 应用到全部 just ran and nothing differs since: 已应用.
  const [applied, setApplied] = useState(false);
  // The sheet over the screen: the shown photo's actions or fix, or +'s.
  const [sheet, setSheet] = useState<EditSheet | null>(null);
  // 存草稿并退出 is saving: the back sheet stays, its choices wait.
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  // Why 存草稿并退出 did not leave, said once the back sheet has closed.
  const refusal = useRef<string | null>(null);
  // A photo's sheet ends once the photo is no longer shown or no longer
  // needs what its fix sheet offered; the back sheet takes over from any.
  if (
    sheet !== null &&
    (backAsk ||
      (sheet.type !== "add" && sheet.key !== item.key) ||
      (sheet.type === "attention" && attention === null))
  )
    setSheet(null);
  // + clicks these from its sheet (they stay in its cell, r4 D19).
  const pickInput = useRef<HTMLInputElement>(null);
  const captureInput = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  const addInputs: StripAddInputs = {
    pick: pickInput,
    capture: coarse ? captureInput : null,
  };
  const [enter, setEnter] = useState<{
    readonly key: string;
    readonly from: "next" | "previous";
  } | null>(null);

  // Focus follows the author's action once its render is on screen: the
  // photo now in a removed one's place, a photo brought back by 撤销, a
  // photo moved (React re-inserts a node that moves, which drops its
  // focus). A thumbnail is then shown inside the strip, which alone scrolls.
  const body = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const selector = focusAfter.current;
    if (selector === null) return;
    focusAfter.current = null;
    const target = body.current?.querySelector<HTMLElement>(selector) ?? null;
    if (target === null) return;
    target.focus({ preventScroll: true });
    const cell = target.closest<HTMLElement>("[data-edit-index]");
    const strip = target.closest<HTMLElement>("[data-edit-strip]");
    if (cell !== null && strip !== null) revealThumb(strip, cell);
  });

  /**
   * Commits a photo taken away by 移除: its upload is cancelled and it
   * leaves the album. Runs once 撤销 is no longer offered (its toast ended
   * or gave way), before any change to the whole album, and when the screen
   * goes. Its toast said it and focus moved on then: the flow's commit says
   * nothing more and leaves focus where the author is (`deferredRemoval`).
   * Its toast goes with it, should it still show (存草稿并退出 or a fix
   * made the removal first): its 撤销 could no longer bring the photo back.
   */
  const pendingRemoval = useRef<string | null>(null);
  const commitRemoval = () => {
    const key = pendingRemoval.current;
    if (key === null) return;
    pendingRemoval.current = null;
    endToast("removal");
    onHide(null);
    if (indexOfKey(editor.actions.media(), key) < 0) return;
    media.remove(key);
  };
  const latestCommitRemoval = useRef(commitRemoval);
  latestCommitRemoval.current = commitRemoval;
  useEffect(() => () => latestCommitRemoval.current(), []);
  // What ‹ keeps, for the leave guard's Back: the crop, then the removal.
  const latestLeave = useRef<() => void>(() => undefined);
  latestLeave.current = () => {
    crop.commit();
    commitRemoval();
  };
  useEffect(() => {
    if (commitRef === undefined) return undefined;
    const keep = () => latestLeave.current();
    commitRef.current = keep;
    return () => {
      if (commitRef.current === keep) commitRef.current = null;
    };
  }, [commitRef]);
  // The back sheet belongs to this screen: it never outlives it (a layout
  // swap, the last photo gone, 重新选择照片).
  useEffect(() => () => ui.setBackAsk(false), [ui]);
  // ‹ itself, besides the shell's ref: the back sheet's way home for focus.
  const backButton = useRef<HTMLButtonElement | null>(null);
  const barBackRef = useCallback(
    (node: HTMLButtonElement | null) => {
      backButton.current = node;
      if (typeof backButtonRef === "function") backButtonRef(node);
      else if (backButtonRef !== null && backButtonRef !== undefined)
        backButtonRef.current = node;
    },
    [backButtonRef],
  );
  // The back sheet closed (继续编辑, Escape, a second Back) with focus on
  // nothing (it opened from the browser's Back): ‹ takes it. A refused
  // 存草稿并退出 is said after that, through the flow's announcer (always
  // mounted, a repeat said again): the notice it adds is inserted, and an
  // inserted region is often not read out.
  const { announce } = media;
  const askedBefore = useRef(backAsk);
  useEffect(() => {
    const asked = askedBefore.current;
    askedBefore.current = backAsk;
    if (!asked || backAsk) return;
    const active = document.activeElement;
    if (active === null || active === document.body)
      backButton.current?.focus({ preventScroll: true });
    const reason = refusal.current;
    refusal.current = null;
    if (reason !== null) announce(reason);
  }, [backAsk, announce]);
  /** A toast for anything but a removal: an earlier 撤销 gives way to it. */
  const say = (text: string, options: ToastOptions = {}) => {
    commitRemoval();
    showToast(text, options);
  };

  // The stage takes its shape from the first photo (as the feed does), and
  // shows each photo as its framing asks (#341).
  const stageRatio = media.feed.slides[0]?.size ? media.feed.stageRatio : null;
  const feedWindow =
    crop.frame === null
      ? null
      : index === 0
        ? feedStageWindow(crop.ratio, undefined, item.edit.feed)
        : stageRatio === null
          ? null
          : feedStageWindow(crop.ratio, stageRatio, item.edit.feed);
  // On, the tool keeps the stage until it is turned off, whatever the photo
  // shown: one whose window is still unknown waits for it, crop resting.
  const feedState = feedToolState(
    feedTool,
    feedWindow,
    crop.loading || crop.frame !== null,
  );

  /** Each photo's source size as its thumbnail learns it, for 应用到全部. */
  const [sizes, setSizes] = useState<ReadonlyMap<string, Size>>(
    () => new Map(),
  );
  const noteSize = useCallback(
    (key: string, size: Size | null) =>
      setSizes((current) => {
        const known = current.get(key);
        if (
          size === null
            ? known === undefined
            : known?.width === size.width && known.height === size.height
        )
          return current;
        const next = new Map(current);
        if (size === null) next.delete(key);
        else next.set(key, size);
        return next;
      }),
    [],
  );
  const knownSizes = (album: readonly WorkDraftItem[]) => {
    const known = new Map(sizes);
    for (const entry of album) {
      const presentation = media.serverFor(entry)?.presentation;
      if (presentation)
        known.set(entry.key, {
          width: presentation.width,
          height: presentation.height,
        });
    }
    if (crop.size !== null) known.set(item.key, crop.size);
    return known;
  };

  const preset = crop.session.preset;
  // 自由 (a free shape, or a stored one outside the phone's ratios) is never
  // spread to the others.
  const applicable: AspectPresetId | null =
    editable && crop.previewable && isPhonePreset(preset) ? preset : null;
  // 应用到全部 is offered while another photo has a different ratio.
  const others = items.filter((entry) => entry.key !== item.key);
  const othersKnown = knownSizes(others);
  const differs =
    applicable !== null &&
    applyRatioToAll(others, othersKnown, applicable).length > 0;
  // 已应用 only once every photo could take it: one whose size is not known
  // yet was left as it is, so the ratios still differ.
  const done = applied && !differs && unsized(others, othersKnown).length === 0;
  // Off while 「动态流」 has the stage: the ratio row is away.
  const applyOff = done || !differs || feedTool;

  // An older draft's chosen cover that is not photo 1 keeps its 封面 mark.
  const albumFirst = media.value.items[0]?.key ?? null;
  const sourceOf = (entry: WorkDraftItem): StripSource => ({
    view: media.views.get(entry.key),
    server: media.serverFor(entry) ?? undefined,
    localStill: media.session.localStill(entry.key),
    editedThumbSrc: media.derivations.get(entry.key)?.thumbSrc ?? null,
    status: media.statusOf(entry),
    chosenCover: media.value.coverKey === entry.key && entry.key !== albumFirst,
  });
  const tileModel = (entry: WorkDraftItem): PhotoTileModel => {
    const source = sourceOf(entry);
    return {
      ...source,
      item: entry,
      failure: failureSource(source.status, source.view, source.server),
    };
  };

  const show = (key: string) => {
    if (key === item.key) return;
    const to = items.findIndex((entry) => entry.key === key);
    crop.commit();
    // 撤销 of 应用到全部 would now overwrite what the author does next.
    endToast("apply-all");
    setApplied(false);
    setEnter(
      media.reducedMotion || to < 0
        ? null
        : { key, from: to > index ? "next" : "previous" },
    );
    media.ui.setCurrentKey(key);
  };
  /**
   * ← / → on the focused stage. Focus stays on the stage, whose name does
   * not change, so the photo now shown is said.
   */
  const page = (direction: -1 | 1) => {
    const to = index + direction;
    const target = items[to];
    if (target === undefined) return;
    show(target.key);
    const state = media.statusOf(target);
    media.announce(
      `第 ${to + 1} 项，共 ${count} 项${
        state.kind === "ready" ? "" : `，${state.label}`
      }`,
    );
  };

  const choosePreset = (id: CropPreset) => {
    if (id === preset) return;
    setApplied(false);
    crop.choosePreset(id);
  };

  /**
   * 撤销 of a turn or 还原 (taken before it): the photo's edit and, for
   * 还原 (`feed`), its feed framing back and, when the step reset the
   * cover's composition (the photo is the cover), that composition too, as
   * 应用到全部's 撤销 brings it back. A turn leaves the framing as it is, so
   * its 撤销 never takes back a framing chosen since.
   */
  const stageUndo = (
    before: StageSnapshot,
    { feed = true }: { readonly feed?: boolean } = {},
  ) => {
    const album = editor.actions.media();
    const edited = album.items.find((entry) => entry.key === before.key);
    return () => {
      crop.restore(before);
      // The framing is not the pixels: it comes back on its own.
      if (feed) media.applyFeed(before.key, before.feed);
      if (
        edited === undefined ||
        album.coverCrop === null ||
        effectiveCoverKey(album) !== before.key
      )
        return;
      const now = editor.actions.media();
      const restored = now.items.find((entry) => entry.key === before.key);
      if (
        restored === undefined ||
        now.coverCrop !== null ||
        now.coverKey !== album.coverKey ||
        effectiveCoverKey(now) !== before.key ||
        // Only the edit the composition was made on.
        !sameEdit(restored.edit, edited.edit)
      )
        return;
      editor.actions.setMedia({ ...now, coverCrop: album.coverCrop });
      media.ui.setNotice(null);
    };
  };

  const rotate = () => {
    if (!editable) return;
    const undo = stageUndo(crop.snapshot(), { feed: false });
    crop.rotate();
    say("已向右旋转 90°", { undo });
  };

  /**
   * 还原: the whole frame, unturned, and the feed's centred cover (#341); a
   * carried-over photo has only its framing to reset.
   */
  const revert = () => {
    if (!crop.restorable) return;
    const undo = stageUndo(crop.snapshot());
    setApplied(false);
    if (editable) crop.revert();
    media.applyFeed(item.key, undefined);
    say(`第 ${number} 项已还原`, {
      undo: () => {
        setApplied(false);
        undo();
      },
    });
  };

  /**
   * 「动态流」 on or off. On, the crop shown is kept first, so the window
   * lies over the frame as the feed will have it.
   */
  const toggleFeedTool = () => {
    if (feedTool) {
      setFeedTool(false);
      say("已退出动态流");
      return;
    }
    if (feedWindow === null) return;
    crop.commit();
    setFeedTool(true);
    say(feedToolText(feedToolState(true, feedWindow, true), feedWindow));
  };
  /** 局部's region, as the finger lifts or a key moves it: kept at once. */
  const placeRegion = (y: number) =>
    media.applyFeed(item.key, { fit: "cover", y });
  /** 局部 or 整张; 整张 → 局部 returns to the region the photo had. */
  const chooseFeedFit = (fit: FeedFit) => {
    if (fit === feedState) return;
    if (fit === "whole") {
      const feed = item.edit.feed;
      regions.current.set(
        item.key,
        feed?.fit === "cover" ? feed.y : FEED_CENTRE_Y,
      );
      media.applyFeed(item.key, { fit: "contain" });
      media.announce("动态流整张显示，左右留白");
      return;
    }
    media.applyFeed(item.key, {
      fit: "cover",
      y: regions.current.get(item.key) ?? FEED_CENTRE_Y,
    });
    media.announce("动态流显示局部，上下拖动选择显示的部分");
  };

  const applyToAll = () => {
    // Off (`aria-disabled`, so focus stays on it as it turns to 已应用).
    if (applicable === null || applyOff) return;
    crop.commit();
    commitRemoval();
    const album = editor.actions.media();
    const sizes = knownSizes(album.items);
    const changes = applyRatioToAll(album.items, sizes, applicable);
    if (changes.length === 0) return;
    // One album edit for every photo, like one 完成 per photo would leave it.
    let value = album;
    let coverCropReset = false;
    for (const change of changes) {
      const result = setItemEdit(value, change.key, change.edit);
      value = result.value;
      coverCropReset ||= result.coverCropReset;
    }
    editor.actions.setMedia(value);
    setApplied(true);
    if (coverCropReset) media.showNotice(EDIT_COVER_RESET);
    say(appliedText(album.items, sizes), {
      kind: "apply-all",
      undo: () => {
        // Each changed photo gets its own edit back, the cover its composition.
        let restored: MediaValue = editor.actions.media();
        for (const change of changes) {
          const before = album.items.find((entry) => entry.key === change.key);
          if (before !== undefined)
            restored = setItemEdit(restored, change.key, before.edit).value;
        }
        if (coverCropReset && restored.coverKey === album.coverKey) {
          restored = { ...restored, coverCrop: album.coverCrop };
          media.ui.setNotice(null);
        }
        editor.actions.setMedia(restored);
        setApplied(false);
      },
    });
  };

  /**
   * Every order change (a drop, Alt + arrows, 设为首图, 前移 / 后移; r4 D12):
   * the shown crop and a removal waiting for 撤销 are kept first, so a place
   * in the strip is a place in the album; the stage is pinned to the photo
   * it shows, so a new 首图 never switches it; the move keeps 首图 = 封面
   * (the one place the phone keeps it for a move: the flow hands over the
   * plain `reorder`), and focus stays on the moved photo. A dropped cover
   * composition is said once, through the flow's announcer, after `lead`
   * (the move's words): the move's toast is then only seen. "reset" when
   * that happened, "moved" otherwise, null when nothing moved.
   */
  const reorder = (
    key: string,
    target: string,
    lead: string | null,
  ): "moved" | "reset" | null => {
    crop.commit();
    commitRemoval();
    if (ui.get().phone.currentKey !== item.key) ui.setCurrentKey(item.key);
    const album = editor.actions.media();
    const from = indexOfKey(album, key);
    const to = indexOfKey(album, target);
    if (from < 0 || to < 0 || from === to) return null;
    const reset = keepCoverAround(editor.actions, () => media.reorder(key, to));
    if (reset) media.showNotice(COVER_RESET_NOTICE, lead);
    focusAfter.current = thumbOf(key);
    return reset ? "reset" : "moved";
  };

  /** A drop on the photo at strip place `to`; dnd-kit has said where it went. */
  const drop = (key: string, to: number) => {
    const target = items[to];
    if (target === undefined || reorder(key, target.key, null) === null) return;
    say(to === 0 ? `已设为${FIRST_MARK}` : "顺序已更新", { quiet: true });
  };

  /** Alt + arrows, 前移 / 后移: one place towards 首图 (−1) or away from it. */
  const move = (key: string, offset: -1 | 1) => {
    const from = items.findIndex((entry) => entry.key === key);
    const to = from + offset;
    const target = items[to];
    if (from < 0 || target === undefined) return;
    const lead =
      to === 0
        ? `第 ${from + 1} 项已设为${FIRST_MARK}`
        : `第 ${from + 1} 项已移到第 ${to + 1} 位`;
    const moved = reorder(key, target.key, lead);
    if (moved === null) return;
    say(to === 0 ? `已设为${FIRST_MARK}` : `已移到第 ${to + 1} 项`, {
      quiet: moved === "reset",
    });
  };

  /** 设为首图: the photo moves to place 1 (never a separate cover). */
  const makeFirst = (key: string) => {
    const from = items.findIndex((entry) => entry.key === key);
    const first = items[0];
    if (from <= 0 || first === undefined) return;
    const moved = reorder(
      key,
      first.key,
      `第 ${from + 1} 项已设为${FIRST_MARK}`,
    );
    if (moved === null) return;
    say(`已设为${FIRST_MARK}`, { quiet: moved === "reset" });
  };

  /**
   * 移除 (B): the photo leaves the screen at once and 撤销 brings it back,
   * current again, while the toast shows; the removal itself waits until
   * then. The last photo leaves nothing to edit: its crop is kept and the
   * start screen takes the removal over, with the same 撤销 (`onRemoveLast`).
   */
  const remove = (key: string) => {
    setSheet(null);
    commitRemoval();
    const at = items.findIndex((entry) => entry.key === key);
    if (at < 0) return;
    const neighbour = items[at + 1] ?? items[at - 1];
    if (neighbour === undefined) {
      if (key === item.key) crop.commit();
      dismissToast();
      onRemoveLast(key);
      return;
    }
    if (key === item.key) {
      crop.commit();
      media.ui.setCurrentKey(neighbour.key);
    }
    pendingRemoval.current = key;
    onHide(key);
    focusAfter.current = `[data-edit-thumb="${neighbour.key}"]`;
    showToast(`已移除第 ${at + 1} 项`, {
      kind: "removal",
      undo: () => {
        if (pendingRemoval.current !== key) return;
        pendingRemoval.current = null;
        onHide(null);
        crop.commit();
        media.ui.setCurrentKey(key);
        focusAfter.current = `[data-edit-thumb="${key}"]`;
      },
      onExpire: () => latestCommitRemoval.current(),
    });
  };

  // A photo added from the strip is confirmed by a toast once it is in the
  // album (the stage stays on the photo being edited); the flow's announcer
  // already says how many and in which quality.
  const adding = useRef(false);
  const counted = useRef(count);
  useEffect(() => {
    const before = counted.current;
    counted.current = count;
    if (!adding.current || count <= before) return;
    adding.current = false;
    const last = items[count - 1];
    showToast(
      `已添加第 ${count} 项${last?.qualityMode === "original" ? "（原图画质）" : ""}`,
      { quiet: true },
    );
  }, [count, items, showToast]);

  const fix = () => {
    setSheet(null);
    if (remedy === null) return;
    commitRemoval();
    // The stage's chip that opened the sheet turns into a plain chip once
    // the remedy takes: focus goes to the photo's thumbnail, which stays.
    focusAfter.current = thumbOf(item.key);
    // 重新选择 opens the flow's input in this tap: FixSheet has closed its
    // <dialog> already, so the input is not inert (r4 D19).
    runRemedy(media, item.key, status, remedy);
    if (remedy === "retry") say(`正在重新上传第 ${number} 项`);
  };

  // 前往处理 from 发布 (r4 D7): that photo's fix sheet, once, its thumbnail
  // focused and shown in the strip beneath (where focus returns when the
  // sheet closes). A photo that needs nothing any more only clears the key.
  useEffect(() => {
    if (attentionKey === null) return;
    onAttentionTaken?.();
    const entry = items.find((candidate) => candidate.key === attentionKey);
    if (entry === undefined) return;
    const entryStatus = media.statusOf(entry);
    const needs = attentionOf(
      entry,
      entryStatus,
      failureSource(
        entryStatus,
        media.views.get(entry.key),
        media.serverFor(entry) ?? undefined,
      ),
      pauseText(media.uploads?.pauseReason),
    );
    if (needs === null) return;
    if (entry.key !== item.key) ui.setCurrentKey(entry.key);
    // Focused before the sheet opens, so the sheet hands focus back to it.
    if (body.current !== null) focusThumb(body.current, entry.key);
    setSheet({ type: "attention", key: entry.key });
    // The key alone starts it; the album is this render's.
  }, [attentionKey]);

  /** + : the add sheet, its 原图画质 as the device last chose it. */
  const openAdd = () => {
    const remembered = readOriginalQuality();
    if (remembered !== null && remembered !== editor.state.originalNext)
      editor.actions.setOriginalNext(remembered);
    setSheet({ type: "add" });
  };

  /** The add sheet's 原图画质: this device's choice for the next photos. */
  const chooseOriginal = (next: boolean) => {
    storeOriginalQuality(next);
    editor.actions.setOriginalNext(next);
    say(next ? "原图画质已打开" : "原图画质已关闭");
  };

  /**
   * ‹ (r4 ASK-1): a work started in this editor asks through the back
   * sheet (the flow's step back sets `backAsk`); a draft or a published
   * work keeps the crop and a waiting removal, then leaves.
   */
  const startedHere = editor.state.openedAs.type === "new";
  const back = () => {
    if (startedHere) {
      // The back sheet hands focus back to ‹ (a tap does not focus it everywhere).
      backButton.current?.focus({ preventScroll: true });
      onBack();
      return;
    }
    crop.commit();
    commitRemoval();
    onLeave();
  };
  /**
   * A pick from the add sheet is still being read: 重新选择照片 waits for
   * it, so its photos are taken back with the others and the start screen's
   * 撤销 is never ended by their arrival.
   */
  const readingPick = media.staging !== null;
  /** 重新选择照片: every photo shown waits on the start screen for one 撤销. */
  const reselectAll = () => {
    if (savingNow.current || readingPick) return;
    ui.setBackAsk(false);
    crop.commit();
    commitRemoval();
    const keys = editor.actions
      .media()
      .items.map((entry) => entry.key)
      .filter((key) => !held.includes(key));
    dismissToast();
    onRemoveAll(keys, item.key);
  };
  const noSave = media.session.session?.saveMode === "unsaved";
  /**
   * 存草稿并退出 (r4 ASK-1): one tap saves the draft and leaves. The sheet
   * stays while it saves (保存中…) or waits for the uploads (等待上传完成…
   * with the progress, `saveWait`; 继续编辑 ends the wait); a refused save
   * closes it on 编辑 as it was, the reason among the band's notices, the
   * sheet hands focus back to ‹ and then the reason is said. 退出编辑 (no
   * drafts) leaves through the leave guard, whose 结束本次编辑？ asks first.
   */
  const saveAndLeave = () => {
    if (savingNow.current) return;
    crop.commit();
    // A removal waiting for 撤销 is made first (the wait would otherwise
    // wait for a photo on its way out); its 撤销 goes with it, whether or
    // not the tap then leaves.
    commitRemoval();
    if (noSave) {
      ui.setBackAsk(false);
      onLeave();
      return;
    }
    savingNow.current = true;
    setSaving(true);
    void onSaveAndLeave()
      .catch(() => null)
      .then((refused) => {
        savingNow.current = false;
        setSaving(false);
        // Left, the editor goes with it; refused, 编辑 is back as it was.
        if (!ui.get().phone.backAsk) {
          // The sheet went another way (继续编辑 ended the wait, the album
          // emptied): a refusal is said now.
          if (refused !== null) announce(refused);
          return;
        }
        refusal.current = refused;
        ui.setBackAsk(false);
      });
  };
  /**
   * 继续编辑 (and Escape, the browser's Back): the sheet closes; while
   * 存草稿并退出 waits for the uploads this ends the wait (nothing is saved,
   * the uploads go on). A save under way is waited for.
   */
  const waiting = saving && saveWait !== null;
  const continueEditing = () => {
    if (!savingNow.current || waiting) ui.setBackAsk(false);
  };
  const waitProgress =
    waiting && saveWait !== null
      ? `已上传 ${saveWait.received} / ${saveWait.total} 项${
          saveWait.reading ? "，正在读取照片…" : ""
        }`
      : null;
  const waitSaid = useSparseStatus(waitProgress, "等待上传完成，", WAIT_SAY_MS);
  const hasNotices =
    notices !== null && notices !== undefined && notices !== false;

  return (
    <PhoneScreen
      action={
        <PhoneNextButton
          data-edit-next=""
          onClick={() => {
            crop.commit();
            commitRemoval();
            onNext();
          }}
        />
      }
      backButtonRef={barBackRef}
      backLabel="返回"
      onBack={back}
      overlay={
        <>
          {/* Always mounted, so a new toast is announced (inserted regions often are not). */}
          <div className={styles.toastHost} data-edit-toasts="" role="status">
            {toast === null ? null : (
              <div
                key={toast.id}
                className={styles.toast}
                data-action={toast.undo === null ? undefined : ""}
                data-leaving={toast.leaving ? "" : undefined}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    releaseToast("focus");
                }}
                onFocus={() => holdToast("focus")}
                onPointerEnter={() => holdToast("pointer")}
                onPointerLeave={() => releaseToast("pointer")}
              >
                <span aria-hidden={toast.quiet ? "true" : undefined}>
                  {toast.text}
                </span>
                {toast.undo === null ? null : (
                  <button
                    data-edit-undo=""
                    onClick={() => {
                      const undo = toast.undo;
                      dismissToast();
                      undo?.();
                      // 撤销 goes with its toast: the stage takes focus,
                      // unless the undo named a photo to focus.
                      focusAfter.current ??= "[data-edit-stage]";
                    }}
                    type="button"
                  >
                    撤销
                  </button>
                )}
              </div>
            )}
          </div>
          {sheet?.type === "attention" &&
          sheet.key === item.key &&
          attention !== null ? (
            <FixSheet
              attention={{ ...attention, remedy }}
              model={tileModel(item)}
              number={number}
              onCancel={() => setSheet(null)}
              onRemedy={fix}
              onRemove={() => remove(item.key)}
            />
          ) : null}
          {sheet?.type === "menu" && sheet.key === item.key ? (
            <TileMenu
              count={count}
              direction="rtl"
              model={tileModel(item)}
              number={number}
              onCancel={() => setSheet(null)}
              onComposeCover={() => {
                setSheet(null);
                crop.commit();
                commitRemoval();
                onComposeCover(item.key);
              }}
              onRetryHighResolution={() => {
                setSheet(null);
                media.retry(item.key, { type: "high_resolution" });
              }}
              onMakeFirst={() => {
                setSheet(null);
                makeFirst(item.key);
              }}
              onMove={(offset) => {
                setSheet(null);
                move(item.key, offset);
              }}
              onRemove={() => remove(item.key)}
            />
          ) : null}
          {sheet?.type === "add" ? (
            <AddSheet
              count={count}
              disabled={!media.canSelect || count >= media.maxItems}
              maxItems={media.maxItems}
              onCamera={() => captureInput.current?.click()}
              onClose={() => setSheet(null)}
              onOriginalChange={chooseOriginal}
              onPhotos={() => pickInput.current?.click()}
              original={editor.state.originalNext}
            />
          ) : null}
          {backAsk ? (
            <PhoneSheet
              description={
                readingPick ? "正在读取照片，读取完成后可重新选择照片" : null
              }
              name="edit-back"
              onCancel={continueEditing}
              subtitle={`已选 ${count} 项`}
              title="返回"
            >
              {/* Off while it saves or a pick is read, without `disabled`: focus stays put. */}
              <div className={sheetStyles.shActions}>
                <button
                  aria-disabled={saving || readingPick ? "true" : undefined}
                  className={sheetStyles.inkBtn}
                  data-back-action="reselect"
                  onClick={reselectAll}
                  type="button"
                >
                  重新选择照片
                </button>
                <button
                  aria-busy={saving ? "true" : undefined}
                  aria-disabled={saving ? "true" : undefined}
                  className={sheetStyles.plainBtn}
                  data-back-action="leave"
                  data-waiting={waiting ? "" : undefined}
                  onClick={saveAndLeave}
                  type="button"
                >
                  {waiting ? (
                    <>
                      <span className={sheetStyles.btnLine}>等待上传完成…</span>
                      {/* Seen live; said sparingly below. */}
                      <span
                        aria-hidden="true"
                        className={sheetStyles.btnProgress}
                        data-wait-progress=""
                      >
                        {waitProgress}
                      </span>
                    </>
                  ) : saving ? (
                    "保存中…"
                  ) : noSave ? (
                    "退出编辑"
                  ) : (
                    "存草稿并退出"
                  )}
                </button>
                <button
                  aria-disabled={saving && !waiting ? "true" : undefined}
                  className={sheetStyles.plainBtn}
                  data-back-action="continue"
                  onClick={continueEditing}
                  type="button"
                >
                  继续编辑
                </button>
              </div>
              {/* Always mounted with the sheet, so the wait's first words are said. */}
              <p
                aria-live="polite"
                className={editorStyles.visuallyHidden}
                data-wait-status=""
                role="status"
              >
                {waitSaid}
              </p>
            </PhoneSheet>
          ) : null}
        </>
      }
      screen="edit"
      scroll={false}
      secondLine={secondLine}
      title={`${number} / ${count}`}
      titleLabel={`第 ${number} 项，共 ${count} 项`}
    >
      <div ref={body} className={styles.editBody} data-edit-body="">
        <EditStage
          crop={crop}
          cropPaused={feedTool}
          derivativeExpected={derivativeExpected(status)}
          enter={enter?.key === item.key ? enter.from : undefined}
          feedHint={
            feedWindow === null
              ? null
              : feedWindowHint(feedWindow, index === 0, {
                  adjustable: feedState === "region",
                })
          }
          feedTool={feedState}
          feedWindow={feedWindow}
          hint={hint.shown}
          interrupted={backAsk}
          onFeedRegion={placeRegion}
          onFix={() => setSheet({ type: "attention", key: item.key })}
          onGestureEnd={(moved) => {
            if (!moved) return;
            setApplied(false);
            endToast("apply-all");
          }}
          onInput={hint.hide}
          onPage={page}
          onRevert={revert}
          onRotate={rotate}
          onToggleFeedTool={toggleFeedTool}
          reducedMotion={media.reducedMotion}
          status={status}
          uploadFailed={view?.phase === "failed"}
        />
        <div className={styles.editBand} data-edit-band="">
          {!hasNotices && editable && media.notice === null ? null : (
            <div className={styles.bandNotes}>
              {/* The editor's notices first: recovery, the media error, an ended session (r4 D6). */}
              {hasNotices ? (
                <div className={styles.bandNotices} data-edit-notices="">
                  {notices}
                </div>
              ) : null}
              {editable ? null : (
                <p className={styles.bandNote} data-edit-locked="">
                  {LEGACY_NOTE}
                </p>
              )}
              {/* Under the stage, never on it (a cover composition reset, §6 G6). */}
              <MediaNotice
                notice={media.notice}
                onDismiss={() => media.ui.setNotice(null)}
              />
            </div>
          )}
          {feedState === "off" ? (
            <RatioBar
              disabled={!crop.previewable || !editable}
              free
              onChange={choosePreset}
              value={preset}
            />
          ) : feedState === "region" || feedState === "whole" ? (
            <FeedFitBar onChange={chooseFeedFit} value={feedState} />
          ) : (
            <div className={styles.ratioRow}>
              <p
                className={styles.feedNote}
                data-edit-feed-note={feedState}
                role="status"
              >
                {feedNote(feedState, feedWindow)}
              </p>
            </div>
          )}
          {/* A touch anywhere on the row ends the strip's hint. */}
          <div className={styles.stripRow} onPointerDown={stripHint.hide}>
            <ThumbnailStrip
              addDisabled={!media.canSelect}
              addHidden={count >= media.maxItems}
              addInputs={addInputs}
              currentKey={item.key}
              id={`edit-strip-${editor.state.key}`}
              items={items}
              onAdd={openAdd}
              onAddFiles={(files, origin) => {
                commitRemoval();
                adding.current = true;
                onAddFiles(files, origin);
              }}
              onFix={(key) => setSheet({ type: "attention", key })}
              onMenu={(key) => setSheet({ type: "menu", key })}
              onMove={move}
              onRemove={remove}
              onReorder={drop}
              onSelect={show}
              onSortStart={stripHint.hide}
              onSourceSize={noteSize}
              reducedMotion={media.reducedMotion}
              sourceOf={sourceOf}
            />
            <span aria-hidden="true" className={styles.stripDivider} />
            <button
              aria-disabled={applyOff}
              className={styles.applyButton}
              data-done={done ? "" : undefined}
              data-edit-apply-all=""
              onClick={applyToAll}
              type="button"
            >
              <EditGlyph name={done ? "check" : "stack"} size={18} />
              <span>{done ? "已应用" : "应用到全部"}</span>
            </button>
            {count >= 2 ? (
              <p
                aria-hidden="true"
                className={styles.stripHint}
                data-edit-strip-hint=""
                data-show={stripHint.shown ? "" : undefined}
              >
                长按拖动排序，最右是{FIRST_MARK}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </PhoneScreen>
  );
};
