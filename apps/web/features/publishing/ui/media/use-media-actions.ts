"use client";

import { THREAD_QUICK_COMPOSER_ITEMS } from "../../publishing-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { itemDerivation, itemEditKey, withEditKey } from "../../edit-readiness";
import {
  useEditReadiness,
  useStagedItems,
  useUploadSession,
} from "../../publishing-provider";
import { attachDropGuard } from "./drop-guard";
import { FEED_GALLERY_MAXIMUM, useFeedStageSlides } from "./feed-stage-slides";
import {
  appendItems,
  confirmedItems,
  indexOfKey,
  moveBy,
  moveToIndex,
  removeItem,
  replaceItem,
  setCover,
  setCoverCrop,
  setItemEdit,
  setItemFeed,
  withValidCover,
} from "./media-order";
import { derivativeExpected, itemStatus } from "./media-status";
import { mediaUiFor, useMediaUiState } from "./media-ui-store";
import { attachPasteCapture } from "./paste-capture";

import type { FeedStageModel } from "./feed-stage-slides";
import type { MediaValue } from "./media-order";
import type { ItemStatus, RetryPlan } from "./media-status";
import type { MediaDialog, MediaUiStore, Replacement } from "./media-ui-store";
import type { ItemDerivation } from "../../edit-readiness";
import type {
  ConfirmedSource,
  FileOrigin,
  StagedEntry,
} from "../../import-grouping";
import type { UploadItemPhase, UploadItemView } from "../../upload-manager";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type { EditorMediaScope } from "../editor/preview";
import type {
  MediaCrop,
  MediaEdit,
  MediaFeedFraming,
  PublishingMediaItem,
  WorkDraftItem,
} from "@moya/contracts";
import type { ChangeEvent, ComponentPropsWithRef, RefObject } from "react";

/**
 * Everything the media section does apart from drawing it (#244): the
 * runtime hooks, the album derivations, the effects that follow the upload
 * manager and the closures every control calls. Exactly one caller per
 * mounted layout (MediaSection on desktop; PhoneFlow on phone once it
 * replaces the phone media step); screens receive its result as props. A
 * second caller would attach a second paste and drop listener and a second
 * announcer. React runs effects in declaration order; the order below is the
 * section's own and is part of its behaviour.
 */

type UploadSessionApi = ReturnType<typeof useUploadSession>;
type StagedItemsApi = ReturnType<typeof useStagedItems>;

export interface MediaDerivationView {
  readonly derivation: ItemDerivation;
  readonly thumbSrc: string | null;
}

/** The hidden input a 重新选择 opens (spread onto an `<input>`). */
export type ReselectInputProps = Pick<
  ComponentPropsWithRef<"input">,
  | "ref"
  | "accept"
  | "aria-label"
  | "hidden"
  | "multiple"
  | "onChange"
  | "tabIndex"
  | "type"
>;

/**
 * Where focus goes after a removal (the neighbouring item, or nothing left),
 * or after a re-selection replaced the item focus was on (its replacement).
 */
export type MediaFocusTarget =
  | { readonly type: "item"; readonly key: string }
  | { readonly type: "empty" }
  | { readonly type: "replaced"; readonly key: string };

/**
 * A cover rule the album changes this hook makes on its own must keep (the
 * phone's 首图 = 封面, `keepCoverOnFirst`): the album to keep once `before`
 * became `after`, and whether a chosen cover was reset on the way.
 */
export interface CoverRule {
  readonly apply: (
    before: MediaValue,
    after: MediaValue,
  ) => { readonly value: MediaValue; readonly coverReset: boolean };
  /** What the notice says when the cover was reset. */
  readonly notice: string;
}

/** How an edit is kept (`applyEdit`). */
export interface ApplyEditOptions {
  /**
   * Said elsewhere or not at all: the phone stage keeps its edits on its own
   * (idle, a switch, leaving) and says its turns and 还原 in its toasts, so
   * 「第 N 项的编辑已应用」 is not spoken. A notice is still said.
   */
  readonly quiet?: boolean;
}

export interface MediaActionsOptions {
  /**
   * The feed stage pictures kept decoded (default: the feed's ten). Each one
   * holds a bounded preview and, when edited, a drawn frame; a screen that
   * shows no stage asks for fewer.
   */
  readonly feedScope?: EditorMediaScope;
  /**
   * 首图 = 封面: after an order change, a removal or a confirmation, a chosen
   * cover that is no longer the first item moves to it (its crop is dropped);
   * choosing or composing the cover of another item makes it the 首图.
   */
  readonly coverFollowsFirst?: boolean;
  /**
   * The selector (inside `rootRef`) that takes focus after a removal; the
   * default names the desktop strip's handle and the picker. The phone
   * screens draw neither, so they name their own tile or add control.
   */
  readonly focusTarget?: (target: MediaFocusTarget) => string;
  /**
   * Every removal commits a photo the screen already took away (the phone
   * screens' 移除 with 撤销): the screen said so and placed focus then. The
   * commit says no more than a notice, and leaves focus where the author is
   * now unless it fell to the page.
   */
  readonly deferredRemoval?: boolean;
  /**
   * The phone's 首图 = 封面, kept by the album changes the hook makes on its
   * own: a re-selection that replaces item 1, and items cancelled on the
   * account elsewhere. The screens apply it to the changes they make.
   */
  readonly coverRule?: CoverRule;
}

/** What became of one selection, for a screen that moves on when it is added. */
export type StageOutcome =
  | {
      readonly status: "added";
      /** The confirmed items, a replacement's included, in selection order. */
      readonly keys: readonly string[];
      /** The 1-based place a re-selection filled, if any. */
      readonly replaced: number | null;
      readonly unsupported: number;
    }
  | {
      readonly status: "refused";
      readonly reason: "items_limit" | "nothing_ready" | "ended";
    }
  | { readonly status: "unreadable" }
  /** Ended before confirmation: no files, a stale re-selection, a session change. */
  | { readonly status: "dropped" };

export interface MediaActions {
  readonly session: UploadSessionApi;
  readonly ui: MediaUiStore;
  readonly dialog: MediaDialog | null;
  readonly replacement: Replacement | null;
  readonly notice: string | null;
  readonly selecting: boolean;
  readonly selectedKeys: readonly string[];
  readonly uploads: UploadSessionApi["uploads"];
  readonly staging: StagedItemsApi["staging"];
  readonly maxItems: number;
  readonly value: MediaValue;
  readonly views: ReadonlyMap<string, UploadItemView>;
  readonly derivations: ReadonlyMap<string, MediaDerivationView>;
  /** The slide the feed preview shows (and 发布's cards), within the album. */
  readonly activeSlide: number;
  readonly setActiveIndex: (index: number) => void;
  readonly feed: FeedStageModel;
  readonly reducedMotion: boolean;
  /** What the polite announcer says now. */
  readonly announcement: string;
  readonly canSelect: boolean;
  readonly loaded: boolean;
  readonly paused: boolean;
  readonly dialogItem: WorkDraftItem | null;
  readonly dialogServer: PublishingMediaItem | null;
  readonly dialogNumber: number;
  readonly dialogDerivative: boolean;
  readonly reselectInput: ReselectInputProps;
  readonly announce: (message: string) => void;
  readonly showNotice: (text: string | null, lead?: string | null) => void;
  readonly refuse: () => void;
  readonly stage: (
    files: readonly File[],
    origin: FileOrigin,
    onFailed?: () => void,
    replacing?: Replacement | null,
  ) => Promise<StageOutcome>;
  readonly readyReplacement: (
    pending: Replacement | null,
  ) => Replacement | null;
  readonly confirm: (
    original: boolean,
    replacement: Replacement | null,
  ) => StageOutcome;
  readonly move: (
    key: string,
    offset: -1 | 1,
    focus?: "strip" | "keep",
  ) => void;
  readonly reorder: (key: string, index: number) => void;
  /** 设为首图: moves `key` first and, when a cover is chosen, makes it the cover. */
  readonly makeFirst: (key: string) => void;
  readonly removeMany: (keys: readonly string[]) => void;
  readonly remove: (key: string) => void;
  readonly chooseCover: (key: string) => void;
  readonly applyEdit: (
    key: string,
    edit: MediaEdit,
    options?: ApplyEditOptions,
  ) => void;
  /**
   * How the phone feed frames `key` (#341; undefined: centred). Kept
   * silently, like a ratio choice; never its pixels, so the cover
   * composition stays.
   */
  readonly applyFeed: (key: string, feed: MediaFeedFraming | undefined) => void;
  readonly applyCoverCrop: (key: string, crop: MediaCrop | null) => void;
  readonly retry: (key: string, plan: RetryPlan) => void;
  readonly reselect: (key: string) => void;
  readonly startReplacement: (target: string, files: File[]) => void;
  readonly chooseOriginal: (key: string) => void;
  /** The status a strip tile shows for `item`, from the same inputs. */
  readonly statusOf: (item: WorkDraftItem) => ItemStatus;
  /** The account's view of `item`: the manager's first, then the editor's. */
  readonly serverFor: (item: WorkDraftItem) => PublishingMediaItem | null;
}

const sourceFiles = (source: ConfirmedSource["source"]): File[] =>
  source.kind === "live" && source.layout === "pair"
    ? [source.still.file, source.motion.file]
    : [source.still.file];

const stagedFiles = (entry: StagedEntry): File[] => {
  switch (entry.status) {
    case "ready":
      return sourceFiles(entry.source);
    case "needs_counterpart":
    case "container_invalid":
      return [entry.still.file];
    case "needs_still":
      return [entry.motion.file];
    case "ambiguous":
      return [...entry.stills, ...entry.motions].map((file) => file.file);
    case "unsupported":
      return [entry.file];
  }
};

/** The manager still counts this item against the limit. */
const holdsSlot = (view: UploadItemView | undefined) =>
  view !== undefined && view.phase !== "cancelled" && view.phase !== "cleanup";

const COVER_CROP_FOLLOWS_FIRST =
  "首图已更换，封面构图已恢复为完整画面，可重新调整";

const coverFallbackNotice = (value: MediaValue) =>
  value.items.length > 0
    ? "封面已移除，现在以第 1 项作为封面"
    : "封面已移除，没有图片时作品以文字展示";

const announcedPhases: Partial<Record<UploadItemPhase, string>> = {
  ready: "已就绪",
  failed: "上传失败",
  needs_choice: "需要选择",
  missing_local: "缺少本地文件",
  paused: "已暂停",
};

const RESELECT_ACCEPT =
  "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,video/quicktime,video/mp4,.mov";

export const SELECTION_UNAVAILABLE = "暂时无法添加图片";

const FEED_SCOPE: EditorMediaScope = { first: FEED_GALLERY_MAXIMUM };

const stripFocusTarget = (target: MediaFocusTarget): string =>
  target.type === "empty"
    ? "[data-media-picker] button"
    : `[data-media-handle="${target.key}"]`;

/** Whether focus fell to the page or still sits on one of `keys`' controls. */
const focusLostWith = (keys: readonly string[]): boolean => {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    keys.some(
      (key) =>
        active.closest(
          `[data-media-key="${key}"], [data-media-handle="${key}"], [data-edit-thumb="${key}"]`,
        ) !== null,
    )
  );
};

/** Callers per editor session, to catch a second one in development. */
const callers = new WeakMap<MediaUiStore, number>();

export const useMediaActions = (
  editor: EditorSessionHandle,
  rootRef: RefObject<HTMLElement | null>,
  {
    feedScope = FEED_SCOPE,
    coverFollowsFirst = false,
    focusTarget = stripFocusTarget,
    deferredRemoval = false,
    coverRule,
  }: MediaActionsOptions = {},
): MediaActions => {
  const session = useUploadSession();
  const staged = useStagedItems();
  const edits = useEditReadiness();
  const { state, actions } = editor;
  const ui = mediaUiFor(actions);
  const { dialog, replacement, notice, selecting, selectedKeys } =
    useMediaUiState(ui);
  const uploads = session.uploads;
  const staging = staged.staging;
  // A Thread quick composer (content-community-completion-v1) carries at most
  // three static items; the general editor keeps the server limit.
  const maxItems = session.session?.threadId
    ? Math.min(session.limits?.maxItems ?? 50, THREAD_QUICK_COMPOSER_ITEMS)
    : (session.limits?.maxItems ?? 50);
  const value = useMemo<MediaValue>(
    () => ({
      items: state.items,
      coverKey: state.coverKey,
      coverCrop: state.coverCrop,
    }),
    [state.items, state.coverKey, state.coverCrop],
  );

  const views = useMemo(
    () =>
      new Map<string, UploadItemView>(
        (uploads?.items ?? []).map((item) => [item.key, item]),
      ),
    [uploads],
  );

  // Edit derivatives per item (QA D1): 处理中 until the account confirms
  // them, and the account's edited thumbnail once it names an edit key.
  const derivations = useMemo(() => {
    const album = { coverKey: value.coverKey, coverCrop: value.coverCrop };
    return new Map(
      value.items.map((item) => {
        const editKey = itemEditKey(item, album, edits);
        const view = views.get(item.key);
        const server =
          view === undefined
            ? item.itemId === null
              ? null
              : (state.serverItems[item.itemId] ?? null)
            : view.serverItem;
        const thumb = server?.media?.thumbSrc;
        return [
          item.key,
          {
            derivation: itemDerivation(item, album, edits),
            thumbSrc:
              editKey === null || thumb === undefined
                ? null
                : withEditKey(thumb, editKey),
          },
        ] as const;
      }),
    );
  }, [value, views, state.serverItems, edits]);

  // The composer's feed preview (#244): what the phone single-column stage
  // will show, in content order, at one shared index.
  const [activeIndex, setActiveIndex] = useState(0);
  const activeSlide = Math.min(
    activeIndex,
    Math.max(0, value.items.length - 1),
  );
  const feed = useFeedStageSlides(
    state,
    uploads,
    session.localStill,
    value.items.length > 0 ? feedScope : "none",
  );
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const change = () => setReducedMotion(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);

  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => {
    // A repeated message still reaches screen readers.
    setAnnouncement((current) =>
      current === message ? `${message}\u200b` : message,
    );
  }, []);
  /** Shows a notice (kept by the session) and says it with `lead`, politely. */
  const showNotice = useCallback(
    (text: string | null, lead: string | null = null) => {
      ui.setNotice(text);
      const spoken = [lead, text].filter((part) => part !== null).join("。");
      if (spoken !== "") announce(spoken);
    },
    [ui, announce],
  );
  const reselectInput = useRef<HTMLInputElement>(null);
  const reselectTarget = useRef<string | null>(null);
  /** A selector to focus; `retried` once one render has missed it. */
  const pendingFocus = useRef<{
    readonly selector: string;
    retried: boolean;
  } | null>(null);
  const acceptSelection = useRef<
    (original: boolean, replacement: Replacement | null) => StageOutcome
  >(() => ({ status: "dropped" }));

  const canSelect = session.accountId !== null && session.session !== null;

  /** The album right now (the session store answers synchronously). */
  const current = useCallback(() => actions.media(), [actions]);

  // -- following the upload manager -----------------------------------------

  useEffect(() => {
    if (uploads === null) return;
    // Identities and newly confirmed items follow the manager (not an edit).
    actions.syncManagedItems(session.draftItems());
    const cancelled = uploads.items.filter(
      (item) =>
        item.phase === "cancelled" && indexOfKey(current(), item.key) >= 0,
    );
    if (cancelled.length === 0) return;
    // Cancelled on the account elsewhere: it is no longer part of the work.
    const before = current();
    let next = before;
    let coverRemoved = false;
    for (const item of cancelled) {
      const removed = removeItem(next, item.key);
      next = removed.value;
      coverRemoved ||= removed.coverRemoved;
      session.forgetItem(item.key);
    }
    // Item 1 may have gone: the phone's 首图 = 封面 holds here too.
    const ruled = coverRule?.apply(before, next) ?? null;
    if (ruled !== null) next = ruled.value;
    actions.setMedia(next);
    const gone = `${cancelled.length} 项已不可用，已从作品中移除`;
    showNotice(
      [
        gone,
        coverRemoved ? coverFallbackNotice(next) : null,
        ruled?.coverReset === true ? coverRule!.notice : null,
      ]
        .filter((part) => part !== null)
        .join("；"),
    );
  }, [uploads, session, actions, current, showNotice, coverRule]);

  useEffect(() => {
    const checked = withValidCover(value);
    if (!checked.coverRemoved) return;
    actions.setMedia(checked.value);
    showNotice(coverFallbackNotice(checked.value));
  }, [value, actions, showNotice]);

  // A dialog whose item left the album (removed elsewhere, another version)
  // ends; so do its selection, the phone's current item and its crop work.
  useEffect(() => {
    if (dialog !== null && indexOfKey(value, dialog.key) < 0) ui.closeDialog();
    const keys = value.items.map((item) => item.key);
    ui.retainSelection(keys);
    ui.retainPhoneKeys(keys);
  }, [dialog, value, ui]);

  // A re-selection ends with its target, or when its files leave staging.
  useEffect(() => {
    if (replacement === null) return;
    if (indexOfKey(value, replacement.target) < 0) {
      ui.setReplacement(null);
      return;
    }
    const present =
      staging !== null &&
      staging.batch.entries.some((entry) =>
        stagedFiles(entry).some((file) => replacement.files.has(file)),
      );
    if (present) ui.markReplacementStaged();
    else if (replacement.staged && (staging?.identifying ?? 0) === 0)
      ui.setReplacement(null);
  }, [replacement, staging, value, ui]);

  const phases = useRef(new Map<string, UploadItemPhase>());
  useEffect(() => {
    if (uploads === null) return;
    const messages: string[] = [];
    for (const item of uploads.items) {
      const before = phases.current.get(item.key);
      const text = announcedPhases[item.phase];
      if (before === undefined || before === item.phase || text === undefined)
        continue;
      const index = indexOfKey(current(), item.key);
      if (index < 0) continue;
      messages.push(
        item.phase === "failed" && item.failure !== null
          ? `第 ${index + 1} 项${text}：${item.failure.message}`
          : `第 ${index + 1} 项${text}`,
      );
    }
    phases.current = new Map(
      uploads.items.map((item) => [item.key, item.phase]),
    );
    if (messages.length > 0) announce(messages.join("；"));
  }, [uploads, announce, current]);

  // Focus follows the author's action when the control it was on goes away.
  // The target may belong to a screen that mounts a render later (an emptied
  // album returns the phone to selection), so one miss is allowed.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    const target =
      rootRef.current?.querySelector<HTMLElement>(pending.selector) ?? null;
    if (target === null && !pending.retried) {
      pending.retried = true;
      return;
    }
    pendingFocus.current = null;
    target?.focus();
  });

  // -- selection -----------------------------------------------------------

  const stage = useCallback(
    (
      files: readonly File[],
      origin: FileOrigin,
      onFailed?: () => void,
      replacing: Replacement | null = null,
    ): Promise<StageOutcome> => {
      if (files.length === 0) return Promise.resolve({ status: "dropped" });
      ui.setNotice(null);
      const original =
        replacing === null
          ? actions.get().originalNext
          : replacing.previous.qualityMode === "original";
      if (replacing === null) actions.setOriginalNext(false);
      let outcome: StageOutcome = { status: "dropped" };
      return staged
        .stageFiles(
          files,
          origin,
          () => {
            // Removing a missing item while its replacement is being read must
            // never turn that late replacement into an unrelated new upload.
            if (
              replacing !== null &&
              (!ui.isCurrentReplacement(replacing) ||
                indexOfKey(current(), replacing.target) < 0)
            ) {
              staged.cancel(false);
              return;
            }
            outcome = acceptSelection.current(original, replacing);
          },
          original,
          replacing
            ? { target: replacing.target, previous: replacing.previous }
            : undefined,
        )
        .then(
          () => outcome,
          (): StageOutcome => {
            onFailed?.();
            showNotice("文件无法读取，请重新选择");
            return { status: "unreadable" };
          },
        )
        .finally(() => {
          if (replacing !== null) ui.finishReplacement(replacing);
        });
    },
    [staged, actions, ui, current, showNotice],
  );
  const refuse = useCallback(() => announce(SELECTION_UNAVAILABLE), [announce]);
  const latest = useRef({ stage, canSelect, refuse });
  useEffect(() => {
    latest.current = { stage, canSelect, refuse };
  });

  useEffect(() => {
    const count = (callers.get(ui) ?? 0) + 1;
    callers.set(ui, count);
    if (count > 1 && process.env.NODE_ENV !== "production")
      console.error("useMediaActions mounted twice for one editor session");
    return () => {
      const left = (callers.get(ui) ?? 1) - 1;
      if (left > 0) callers.set(ui, left);
      else callers.delete(ui);
    };
  }, [ui]);

  useEffect(() => {
    const modalOpen = () => document.querySelector("dialog[open]") !== null;
    const detachPaste = attachPasteCapture(
      document,
      (files) => latest.current.stage(files, "paste"),
      () => latest.current.canSelect && !modalOpen(),
    );
    const detachDrop = attachDropGuard(document, {
      root: () => rootRef.current,
      availability: () =>
        modalOpen()
          ? "blocked"
          : latest.current.canSelect
            ? "accept"
            : "disabled",
      onFiles: (files) => latest.current.stage(files, "drop"),
      onRefused: () => latest.current.refuse(),
    });
    return () => {
      detachPaste();
      detachDrop();
    };
  }, [rootRef]);

  /** The re-selection whose files are ready to confirm now, if any. */
  const readyReplacement = (pending: Replacement | null) => {
    const staging = staged.current();
    if (
      pending === null ||
      staging === null ||
      indexOfKey(current(), pending.target) < 0
    )
      return null;
    const ready = staging.batch.entries.some(
      (entry) =>
        entry.status === "ready" &&
        stagedFiles(entry).some((file) => pending.files.has(file)),
    );
    return ready ? pending : null;
  };
  /** 首图 = 封面 (`coverFollowsFirst`): a chosen cover off the first place moves to it. */
  const followFirst = (next: MediaValue) => {
    const first = next.items[0]?.key ?? null;
    if (!coverFollowsFirst || next.coverKey === null || next.coverKey === first)
      return { value: next, coverCropReset: false };
    return {
      value: { ...next, coverKey: first, coverCrop: null },
      coverCropReset: next.coverCrop !== null,
    };
  };

  const confirm = (
    original: boolean,
    replacement: Replacement | null,
  ): StageOutcome => {
    if (session.session === null) {
      showNotice("本次编辑已结束，无法添加");
      return { status: "refused", reason: "ended" };
    }
    const staging = staged.current();
    if (staging !== null && staging.batch.original !== original)
      staged.setOriginal(original);
    const pending = readyReplacement(replacement);
    const limitCredit =
      pending !== null && holdsSlot(views.get(pending.target)) ? 1 : 0;
    const unsupported = staging?.count.unsupported ?? 0;
    // The missing item gives its place (and its slot in the limit) to its
    // replacement: cancelled first, only when the confirmation then fits.
    let cancelledTarget: Promise<void> | null = null;
    if (
      pending !== null &&
      staging !== null &&
      staging.count.overBy <= limitCredit
    )
      cancelledTarget = session.cancelItem(pending.target);
    const result = staged.confirm();
    if (!result.ok) {
      showNotice(
        result.error === "items_limit"
          ? `作品最多 ${maxItems} 项，本次选择未加入，请减少所选照片或先移除部分内容`
          : "所选文件无法添加，请选择支持的静态照片",
      );
      staged.cancel(false);
      if (replacement !== null) ui.finishReplacement(replacement);
      return { status: "refused", reason: result.error };
    }
    // Rejected files are explained below, not kept in an invisible staging batch.
    staged.cancel(false);
    const added = confirmedItems(result.confirmed);
    const before = current();
    let next = before;
    let replaced: number | null = null;
    if (pending !== null) {
      const replacing = added
        .filter((_, index) =>
          sourceFiles(result.confirmed[index]!.source).some((file) =>
            pending.files.has(file),
          ),
        )
        // The edit (rotation, crop and feed framing) travels when the kind
        // is the same: it is the same photo.
        .map((item) =>
          item.kind === pending.previous.kind
            ? { ...item, edit: pending.previous.edit }
            : item,
        );
      if (replacing.length > 0) {
        const target = pending.target;
        replaced = indexOfKey(next, target) + 1;
        // The replaced item's tile or thumbnail goes with it: focus on it
        // moves to its replacement's.
        if (focusLostWith([target]))
          pendingFocus.current = {
            selector: focusTarget({
              type: "replaced",
              key: replacing[0]!.key,
            }),
            retried: false,
          };
        next = replaceItem(next, target, replacing);
        // The phone edit screen stays on the place it showed.
        if (ui.get().phone.currentKey === target)
          ui.setCurrentKey(replacing[0]!.key);
        void (cancelledTarget ?? session.cancelItem(target)).then(() =>
          session.forgetItem(target),
        );
        ui.finishReplacement(pending);
      }
    }
    const followed = followFirst(appendItems(next, added));
    // A replacement of item 1 is a new 首图: the phone's 首图 = 封面 holds.
    const ruled = coverRule?.apply(before, followed.value) ?? null;
    actions.setMedia(ruled?.value ?? followed.value);
    const notices = [
      unsupported > 0
        ? `${unsupported} 个不支持的文件未添加，其余照片已开始上传`
        : null,
      followed.coverCropReset ? COVER_CROP_FOLLOWS_FIRST : null,
      ruled?.coverReset === true ? coverRule!.notice : null,
    ].filter((text) => text !== null);
    if (notices.length > 0) showNotice(notices.join("；"));
    announce(
      `已添加 ${added.length} 项，${original ? "原图" : "标准"}画质${
        replaced === null ? "" : `，已替换第 ${replaced} 项`
      }`,
    );
    return {
      status: "added",
      keys: added.map((item) => item.key),
      replaced,
      unsupported,
    };
  };
  acceptSelection.current = confirm;

  // -- item actions --------------------------------------------------------

  const move = (
    key: string,
    offset: -1 | 1,
    focus: "strip" | "keep" = "strip",
  ) => {
    const before = current();
    const from = indexOfKey(before, key);
    const moved = moveBy(before, key, offset);
    if (moved === before) return;
    const to = from + offset;
    if (focus === "strip" && (to === 0 || to === moved.items.length - 1))
      // The button used is disabled at the edge: focus moves to its sibling.
      pendingFocus.current = {
        selector: `[data-media-key="${key}"] [data-media-action="${
          to === 0 ? "down" : "up"
        }"]`,
        retried: false,
      };
    const next = followFirst(moved);
    actions.setMedia(next.value);
    const lead = `第 ${from + 1} 项已移到第 ${to + 1} 位`;
    if (next.coverCropReset) showNotice(COVER_CROP_FOLLOWS_FIRST, lead);
    else announce(lead);
  };

  const reorder = (key: string, index: number) => {
    const next = followFirst(moveToIndex(current(), key, index));
    actions.setMedia(next.value);
    if (next.coverCropReset) showNotice(COVER_CROP_FOLLOWS_FIRST);
  };

  const makeFirst = (key: string) => {
    const before = current();
    const from = indexOfKey(before, key);
    if (from < 0) return;
    let next = moveToIndex(before, key, 0);
    if (next.coverKey !== null && next.coverKey !== key)
      next = setCover(next, key);
    if (next === before) return;
    actions.setMedia(next);
    announce(`第 ${from + 1} 项已设为首图`);
  };

  const removeMany = (keys: readonly string[]) => {
    const before = current();
    const removing = before.items.filter((item) => keys.includes(item.key));
    if (removing.length === 0) return;
    const index = indexOfKey(before, removing[0]!.key);
    let result = { value: before, coverRemoved: false };
    // Fence every selected transfer first, then publish one album edit.
    for (const { key } of removing) {
      const view = views.get(key);
      const cancelled =
        view === undefined ||
        view.phase === "cleanup" ||
        view.phase === "cancelled"
          ? Promise.resolve()
          : session.cancelItem(key);
      const next = removeItem(result.value, key);
      result = {
        value: next.value,
        coverRemoved: result.coverRemoved || next.coverRemoved,
      };
      void cancelled.then(
        () => session.forgetItem(key),
        () => showNotice("图片已移除，上传清理尚未完成"),
      );
      if (ui.get().replacement?.target === key) ui.setReplacement(null);
    }
    const neighbour =
      result.value.items[index]?.key ?? result.value.items[index - 1]?.key;
    // A deferred commit leaves focus where the author is now, unless it fell
    // to the page or still sits on a photo that is going.
    if (!deferredRemoval || focusLostWith(removing.map((item) => item.key)))
      pendingFocus.current = {
        selector: focusTarget(
          neighbour === undefined
            ? { type: "empty" }
            : { type: "item", key: neighbour },
        ),
        retried: false,
      };
    // The phone edit screen moves on to the neighbour, like focus.
    const shown = ui.get().phone.currentKey;
    if (shown !== null && removing.some((item) => item.key === shown))
      ui.setCurrentKey(neighbour ?? null);
    const followed = followFirst(result.value);
    // In the same batch as the album edit: an emptied album shows selection
    // in this render, not one effect later with nothing to edit.
    ui.retainPhoneKeys(followed.value.items.map((item) => item.key));
    actions.setMedia(followed.value);
    ui.clearSelection();
    showNotice(
      result.coverRemoved
        ? coverFallbackNotice(followed.value)
        : followed.coverCropReset
          ? COVER_CROP_FOLLOWS_FIRST
          : null,
      // A deferred commit: the screen said it when the photo went.
      deferredRemoval
        ? null
        : removing.length === 1
          ? `已移除第 ${index + 1} 项`
          : `已移除 ${removing.length} 项`,
    );
  };
  const remove = (key: string) => removeMany([key]);

  const chooseCover = (key: string) => {
    // 首图 = 封面: the cover is chosen by making the item the 首图.
    if (coverFollowsFirst) {
      makeFirst(key);
      return;
    }
    const before = current();
    actions.setMedia(setCover(before, key));
    ui.setNotice(null);
    announce(`已将第 ${indexOfKey(before, key) + 1} 项设为封面`);
  };

  const applyEdit = (
    key: string,
    edit: MediaEdit,
    { quiet = false }: ApplyEditOptions = {},
  ) => {
    const number = indexOfKey(current(), key) + 1;
    const result = setItemEdit(current(), key, edit);
    if (result.value === current()) return;
    actions.setMedia(result.value);
    const lead = quiet ? null : `第 ${number} 项的编辑已应用`;
    if (result.coverCropReset)
      showNotice("图片编辑后，封面构图已恢复为完整画面，可重新调整", lead);
    else if (lead !== null) announce(lead);
  };

  const applyFeed = (key: string, feed: MediaFeedFraming | undefined) => {
    const next = setItemFeed(current(), key, feed);
    if (next !== current()) actions.setMedia(next);
  };

  const applyCoverCrop = (key: string, crop: MediaCrop | null) => {
    const before = current();
    const from = indexOfKey(before, key);
    // 首图 = 封面: composing another item's cover makes it the 首图 first,
    // so the next order change keeps the composition.
    const promoted = coverFollowsFirst && from > 0;
    const next = setCoverCrop(
      promoted ? moveToIndex(before, key, 0) : before,
      key,
      crop,
    );
    if (next === before) return;
    actions.setMedia(next);
    ui.setNotice(null);
    announce(
      promoted ? `第 ${from + 1} 项已设为首图并更新封面构图` : "封面构图已更新",
    );
  };

  const retry = (key: string, plan: RetryPlan) => {
    switch (plan.type) {
      case "high_resolution":
        void session.retryHighResolution(key);
        return;
      case "processing":
        void session.retryProcessing(key);
        return;
      case "registration":
        session.retryRegistration(key);
        return;
      case "components":
        for (const role of plan.roles) void session.retryComponent(key, role);
    }
  };

  const reselect = (key: string) => {
    reselectTarget.current = key;
    // Opened directly from the author's click (browsers require the gesture).
    reselectInput.current?.click();
  };

  const startReplacement = (target: string, files: File[]) => {
    const item = current().items.find((entry) => entry.key === target);
    if (item === undefined) return;
    const pending: Replacement = {
      target,
      files: new Set(files),
      staged: false,
      previous: {
        kind: item.kind,
        qualityMode: item.qualityMode,
        edit: item.edit,
      },
    };
    ui.setReplacement(pending);
    void stage(
      files,
      "picker",
      () => {
        ui.finishReplacement(pending);
      },
      pending,
    );
  };

  const chooseOriginal = (key: string) => session.chooseOriginal(key);

  // -- what the controls show ----------------------------------------------

  const paused =
    uploads !== null &&
    (uploads.status === "paused" ||
      uploads.items.some((item) => item.phase === "paused"));
  const loaded = state.phase === "ready" && uploads !== null;
  const serverFor = (item: WorkDraftItem): PublishingMediaItem | null =>
    views.get(item.key)?.serverItem ??
    (item.itemId === null ? null : (state.serverItems[item.itemId] ?? null));
  const statusOf = (item: WorkDraftItem): ItemStatus =>
    itemStatus(
      views.get(item.key),
      item.itemId === null ? undefined : state.serverItems[item.itemId],
      {
        loaded,
        item,
        derivation: derivations.get(item.key)?.derivation ?? "none",
      },
    );
  const dialogItem =
    dialog === null
      ? null
      : (value.items.find((item) => item.key === dialog.key) ?? null);
  const dialogServer = dialogItem === null ? null : serverFor(dialogItem);
  const dialogNumber =
    dialogItem === null ? 0 : indexOfKey(value, dialogItem.key) + 1;
  const dialogDerivative =
    dialogItem === null
      ? true
      : derivativeExpected(
          itemStatus(views.get(dialogItem.key), dialogServer ?? undefined, {
            loaded,
            item: dialogItem,
            derivation:
              derivations.get(dialogItem.key)?.derivation ?? ("none" as const),
          }),
        );

  return {
    session,
    ui,
    dialog,
    replacement,
    notice,
    selecting,
    selectedKeys,
    uploads,
    staging,
    maxItems,
    value,
    views,
    derivations,
    activeSlide,
    setActiveIndex,
    feed,
    reducedMotion,
    announcement,
    canSelect,
    loaded,
    paused,
    dialogItem,
    dialogServer,
    dialogNumber,
    dialogDerivative,
    reselectInput: {
      ref: reselectInput,
      accept: RESELECT_ACCEPT,
      "aria-label": "重新选择缺少的文件",
      hidden: true,
      multiple: true,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        const target = reselectTarget.current;
        reselectTarget.current = null;
        if (files.length === 0 || target === null) return;
        startReplacement(target, files);
      },
      tabIndex: -1,
      type: "file",
    },
    announce,
    showNotice,
    refuse,
    stage,
    readyReplacement,
    confirm,
    move,
    reorder,
    makeFirst,
    removeMany,
    remove,
    chooseCover,
    applyEdit,
    applyFeed,
    applyCoverCrop,
    retry,
    reselect,
    startReplacement,
    chooseOriginal,
    statusOf,
    serverFor,
  };
};
