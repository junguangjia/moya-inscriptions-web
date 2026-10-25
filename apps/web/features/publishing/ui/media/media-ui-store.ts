"use client";

import { useSyncExternalStore } from "react";

import { createExternalStore } from "../../upload-manager-store";

import type { CropSession } from "./crop-workspace";
import type { ExternalStore } from "../../upload-manager-store";
import type {
  EditorSessionStore,
  ReferenceField,
} from "../editor/editor-session-state";
import type {
  MediaCrop,
  MediaEdit,
  MediaFeedFraming,
  MediaRotation,
  WorkDraftItem,
} from "@moya/contracts";

/**
 * The media section's own session state (§11 item 1: step changes and resize
 * never lose input). The phone steps mount only the current step and the
 * editor swaps the phone and desktop layouts at 896 px, so the open dialog
 * with its unfinished crop, a pending re-selection and the last notice live
 * here, next to the editor session store they belong to (a WeakMap entry, so
 * they end with that session). The phone composer (#244 r4) keeps its place
 * here for the same reason: the photo 编辑 shows, the removals the start
 * screen holds for 撤销 and 编辑's back sheet. Which phone screen shows is
 * not kept: it follows from the album (START exactly when no photo is
 * visible). Nothing here is an edit of the work.
 */

export interface EditDialog {
  readonly type: "edit";
  readonly key: string;
}

export interface CoverDialog {
  readonly type: "cover";
  readonly key: string;
}

export type MediaDialog = EditDialog | CoverDialog;

/** Unfinished work in the edit dialog, valid while the item keeps `basis`. */
export interface EditDraft {
  readonly basis: MediaEdit;
  readonly rotation: MediaRotation;
  readonly stored: {
    readonly previewable: boolean;
    readonly session: CropSession;
  } | null;
  /**
   * The draft carries a change the author made and has not kept yet (the
   * desktop edit dialog's turn or ratio, handed to the phone 编辑 by a
   * layout swap): the stage keeps it like its own change.
   */
  readonly explicit?: boolean | undefined;
  /**
   * The feed framing the desktop edit dialog shows and has not kept yet
   * (#341), when it is not the item's own; absent when there is none. A
   * return to the photo's default (还原; r3: whole when uncropped, else
   * centred) is null, so absent never stands for it. The phone keeps
   * framing at once: a layout swap keeps this choice instead of handing it
   * to the stage.
   */
  readonly feed?: MediaFeedFraming | null | undefined;
}

/** Unfinished work in the cover dialog, valid while edit and crop are unchanged. */
export interface CoverDraft {
  readonly basisEdit: MediaEdit;
  readonly basisCrop: MediaCrop | null;
  readonly session: CropSession | null;
}

export interface Replacement {
  /** The missing item the re-selected files replace. */
  readonly target: string;
  readonly files: ReadonlySet<File>;
  /** Staging has shown the files; staging ending afterwards ends the replacement. */
  readonly staged: boolean;
  /** What the missing item was (its edit travels when the kind matches). */
  readonly previous: Pick<WorkDraftItem, "kind" | "qualityMode" | "edit">;
}

/**
 * Photos taken out of view and waiting for 撤销 on the start screen (r4 D4,
 * D20): 编辑's removal of its last photo (one key), or the back sheet's
 * 重新选择照片 (every visible key). They stay in the album until START
 * commits them (`media.remove` for each key, then `setHeldRemoval(null)`);
 * 撤销 clears the record and shows `current` on 编辑 again.
 */
export interface HeldRemoval {
  /** Album keys hidden from every phone screen, in album order. */
  readonly keys: readonly string[];
  /** The photo 编辑 showed when they were taken: 撤销 returns to it. */
  readonly current: string | null;
}

export interface PhoneUiState {
  /** The item the edit screen shows; null shows photo 1. */
  readonly currentKey: string | null;
  /**
   * 发布's 参考作品 · 原作者 · 来源 sheet is open, with the field it focuses
   * first (前往修改 names one); null while it is closed.
   */
  readonly references: ReferenceField | null;
  /**
   * A photo 前往处理 on 发布 sent the author to: 编辑 opens its fix sheet
   * once and clears it.
   */
  readonly attentionKey: string | null;
  /**
   * Removals the start screen holds for 撤销; null when none. A held photo
   * counts as not visible, so START shows while every photo is held. The
   * editor keeps its leave guard while START holds any.
   */
  readonly heldRemoval: HeldRemoval | null;
  /**
   * 编辑's back sheet (重新选择照片 · 存草稿并退出 · 继续编辑) is open: ‹,
   * Escape and the browser's Back on a new work ask first (r4 ASK-1).
   */
  readonly backAsk: boolean;
}

export interface MediaUiState {
  readonly dialog: MediaDialog | null;
  readonly replacement: Replacement | null;
  readonly notice: string | null;
  readonly selecting: boolean;
  readonly selectedKeys: readonly string[];
  readonly phone: PhoneUiState;
}

export interface MediaUiStore {
  readonly store: ExternalStore<MediaUiState>;
  get(): MediaUiState;
  subscribe(listener: () => void): () => void;
  openDialog(dialog: MediaDialog): void;
  closeDialog(): void;
  /**
   * The unfinished dialog work. Written on every change without notifying
   * (a drag must not re-render the strip); read when a dialog mounts.
   */
  draftFor(dialog: EditDialog): EditDraft | null;
  draftFor(dialog: CoverDialog): CoverDraft | null;
  saveDraft(dialog: EditDialog, draft: EditDraft): void;
  saveDraft(dialog: CoverDialog, draft: CoverDraft): void;
  setReplacement(replacement: Replacement | null): void;
  isCurrentReplacement(replacement: Replacement): boolean;
  finishReplacement(replacement: Replacement): void;
  markReplacementStaged(): void;
  setNotice(notice: string | null): void;
  select(key: string): void;
  toggleSelection(key: string): void;
  clearSelection(): void;
  retainSelection(keys: readonly string[]): void;
  setCurrentKey(key: string | null): void;
  /** Opens 发布's reference sheet at `field`, or closes it (null). */
  setReferences(field: ReferenceField | null): void;
  setAttentionKey(key: string | null): void;
  /**
   * Holds removals for 撤销 (replacing any record), or ends the hold (null).
   * Notifies only on a change of keys or current.
   */
  setHeldRemoval(value: HeldRemoval | null): void;
  /** Opens (true) or closes (false) 编辑's back sheet. */
  setBackAsk(open: boolean): void;
  /**
   * Drops what names an item that left the album (`keys` is the album's key
   * list): the current item, a 前往处理 photo, crop work, and held keys (the
   * record's `current` too; the whole record once no held key is left). An
   * empty album also closes the back sheet: there is nothing to go back from.
   */
  retainPhoneKeys(keys: readonly string[]): void;
  /**
   * The phone edit screen's unfinished crop per item, kept like `draftFor`
   * (written without notifying, read when the screen shows the item).
   */
  cropDraftFor(key: string): EditDraft | null;
  saveCropDraft(key: string, draft: EditDraft): void;
}

const initialPhone: PhoneUiState = {
  currentKey: null,
  references: null,
  attentionKey: null,
  heldRemoval: null,
  backAsk: false,
};

const sameKeys = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((key, at) => key === right[at]);

const sameHeld = (left: HeldRemoval | null, right: HeldRemoval | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.current === right.current &&
    sameKeys(left.keys, right.keys));

/** The held record once `keys` is the album: null when no held key is left. */
const retainHeld = (
  held: HeldRemoval | null,
  keys: readonly string[],
): HeldRemoval | null => {
  if (held === null) return null;
  const kept = held.keys.filter((key) => keys.includes(key));
  if (kept.length === 0) return null;
  const current =
    held.current === null || keys.includes(held.current) ? held.current : null;
  return kept.length === held.keys.length && current === held.current
    ? held
    : { keys: kept, current };
};

const initialState: MediaUiState = {
  dialog: null,
  replacement: null,
  notice: null,
  selecting: false,
  selectedKeys: [],
  phone: initialPhone,
};

const sameDialog = (left: MediaDialog | null, right: MediaDialog | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.type === right.type &&
    left.key === right.key);

export const createMediaUiStore = (): MediaUiStore => {
  const store = createExternalStore(initialState, (flush) => flush());
  // Identification is queued, but the latest explicit choice wins per card.
  const replacements = new Map<string, Replacement>();
  let draft: {
    readonly dialog: MediaDialog;
    readonly value: EditDraft | CoverDraft;
  } | null = null;
  const draftFor = (dialog: MediaDialog) =>
    draft !== null && sameDialog(draft.dialog, dialog) ? draft.value : null;
  const saveDraft = (dialog: MediaDialog, value: EditDraft | CoverDraft) => {
    if (sameDialog(store.get().dialog, dialog)) draft = { dialog, value };
  };
  const cropDrafts = new Map<string, EditDraft>();
  const updatePhone = (change: (phone: PhoneUiState) => PhoneUiState) =>
    store.update((state) => {
      const phone = change(state.phone);
      return phone === state.phone ? state : { ...state, phone };
    });
  return {
    store,
    get: () => store.get(),
    subscribe: (listener) => store.subscribe(listener),
    select: (key) =>
      store.update((state) => ({
        ...state,
        selecting: true,
        selectedKeys: state.selectedKeys.includes(key)
          ? state.selectedKeys
          : [...state.selectedKeys, key],
      })),
    toggleSelection: (key) =>
      store.update((state) => ({
        ...state,
        selecting: true,
        selectedKeys: state.selectedKeys.includes(key)
          ? state.selectedKeys.filter((item) => item !== key)
          : [...state.selectedKeys, key],
      })),
    clearSelection: () =>
      store.update((state) => ({
        ...state,
        selecting: false,
        selectedKeys: [],
      })),
    retainSelection: (keys) =>
      store.update((state) => {
        const selectedKeys = state.selectedKeys.filter((key) =>
          keys.includes(key),
        );
        return selectedKeys.length === state.selectedKeys.length
          ? state
          : { ...state, selectedKeys };
      }),
    openDialog: (dialog) => {
      if (sameDialog(store.get().dialog, dialog)) return;
      draft = null;
      store.update((state) => ({ ...state, dialog }));
    },
    closeDialog: () => {
      draft = null;
      if (store.get().dialog === null) return;
      store.update((state) => ({ ...state, dialog: null }));
    },
    // The dialog type fixes the draft type (both are written together).
    draftFor: draftFor as MediaUiStore["draftFor"],
    saveDraft: saveDraft as MediaUiStore["saveDraft"],
    setReplacement: (replacement) => {
      if (replacement !== null)
        replacements.set(replacement.target, replacement);
      store.update((state) =>
        state.replacement === replacement ? state : { ...state, replacement },
      );
    },
    isCurrentReplacement: (replacement) =>
      replacements.get(replacement.target) === replacement,
    finishReplacement: (replacement) => {
      if (replacements.get(replacement.target) === replacement)
        replacements.delete(replacement.target);
      store.update((state) =>
        state.replacement?.target === replacement.target &&
        state.replacement.files === replacement.files
          ? { ...state, replacement: null }
          : state,
      );
    },
    markReplacementStaged: () =>
      store.update((state) =>
        state.replacement === null || state.replacement.staged
          ? state
          : {
              ...state,
              replacement: { ...state.replacement, staged: true },
            },
      ),
    setNotice: (notice) =>
      store.update((state) =>
        state.notice === notice ? state : { ...state, notice },
      ),
    setCurrentKey: (currentKey) =>
      updatePhone((phone) =>
        phone.currentKey === currentKey ? phone : { ...phone, currentKey },
      ),
    setReferences: (references) =>
      updatePhone((phone) =>
        phone.references === references ? phone : { ...phone, references },
      ),
    setAttentionKey: (attentionKey) =>
      updatePhone((phone) =>
        phone.attentionKey === attentionKey
          ? phone
          : { ...phone, attentionKey },
      ),
    setHeldRemoval: (heldRemoval) =>
      updatePhone((phone) =>
        sameHeld(phone.heldRemoval, heldRemoval)
          ? phone
          : {
              ...phone,
              heldRemoval:
                heldRemoval === null
                  ? null
                  : {
                      keys: [...heldRemoval.keys],
                      current: heldRemoval.current,
                    },
            },
      ),
    setBackAsk: (backAsk) =>
      updatePhone((phone) =>
        phone.backAsk === backAsk ? phone : { ...phone, backAsk },
      ),
    retainPhoneKeys: (keys) => {
      for (const key of [...cropDrafts.keys()])
        if (!keys.includes(key)) cropDrafts.delete(key);
      updatePhone((phone) => {
        const currentKey =
          phone.currentKey === null || keys.includes(phone.currentKey)
            ? phone.currentKey
            : null;
        const attentionKey =
          phone.attentionKey === null || keys.includes(phone.attentionKey)
            ? phone.attentionKey
            : null;
        const heldRemoval = retainHeld(phone.heldRemoval, keys);
        const backAsk = keys.length === 0 ? false : phone.backAsk;
        return currentKey === phone.currentKey &&
          attentionKey === phone.attentionKey &&
          heldRemoval === phone.heldRemoval &&
          backAsk === phone.backAsk
          ? phone
          : { ...phone, currentKey, attentionKey, heldRemoval, backAsk };
      });
    },
    cropDraftFor: (key) => cropDrafts.get(key) ?? null,
    saveCropDraft: (key, value) => {
      cropDrafts.set(key, value);
    },
  };
};

const stores = new WeakMap<EditorSessionStore, MediaUiStore>();

/** The media UI state of one editor session (created on first use). */
export const mediaUiFor = (session: EditorSessionStore): MediaUiStore => {
  let store = stores.get(session);
  if (store === undefined) {
    store = createMediaUiStore();
    stores.set(session, store);
  }
  return store;
};

export const useMediaUiState = (store: MediaUiStore): MediaUiState =>
  useSyncExternalStore(store.subscribe, store.get, store.get);
