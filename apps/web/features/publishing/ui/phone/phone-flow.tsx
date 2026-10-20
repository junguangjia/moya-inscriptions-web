"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { useEditorSession } from "../editor/editor-session-provider";
import { fieldStep, isEmptyWork } from "../editor/editor-session-state";
import editorStyles from "../editor/editor.module.css";
import { FEED_GALLERY_MAXIMUM } from "../media/feed-stage-slides";
import { closeCrop, normalizeCrop } from "../media/media-geometry";
import { indexOfKey } from "../media/media-order";
import { mediaUiFor, useMediaUiState } from "../media/media-ui-store";
import mediaStyles from "../media/media.module.css";
import { useMediaActions } from "../media/use-media-actions";
import { readOriginalQuality } from "./add-tiles";
import {
  COVER_RESET_NOTICE,
  keepCoverAround,
  keepCoverOnFirst,
} from "./cover-rule";
import { CoverScreen } from "./cover-screen";
import { EditScreen } from "./edit-screen";
import { MediaNotice } from "./media-notice";
import { failureSource, needsAttention, tileChip } from "./photo-tile";
import { hasReferences } from "./publish-options";
import { PublishScreen, publishChipGlyph } from "./publish-screen";
import { START_FOCUS, SelectScreen } from "./select-screen";
import { revealThumb } from "./thumbnail-strip";

import type { FileOrigin } from "../../import-grouping";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type {
  EditorField,
  EditorSessionStore,
  EditorStep,
  ReferenceField,
} from "../editor/editor-session-state";
import type { EditorMediaScope } from "../editor/preview";
import type { ItemStatus } from "../media/media-status";
import type {
  EditDraft,
  HeldRemoval,
  MediaUiStore,
} from "../media/media-ui-store";
import type { WorkDraftItem } from "@moya/contracts";
import type {
  CoverRule,
  MediaActions,
  MediaFocusTarget,
  StageOutcome,
} from "../media/use-media-actions";
import type { StartOptions } from "./add-tiles";
import type { SaveWait } from "./edit-screen";
import type { PhoneScreenName } from "./phone-screen";
import type { FailureSource } from "./photo-tile";
import type {
  PublishAction,
  PublishConfirmation,
  PublishPreviewSlide,
  PublishTextProps,
} from "./publish-screen";
import type { ReactNode, RefObject } from "react";

/**
 * The phone publishing flow (#244, plan v2, r4): the start screen → 编辑 →
 * 发布 over one editor session. The session's step says whether the work is
 * still being assembled ("media") or described ("text", "confirm"); on the
 * media step the album says which of the two media screens shows: the start
 * screen exactly when no photo is visible, else 编辑 (r4 D4). The media UI
 * store keeps 编辑's photo, the removals the start screen holds for 撤销 and
 * 编辑's back sheet; it and the session outlive this component, so a layout
 * swap at 896 px or leaving and reopening the editor resumes the same
 * screen. This component owns the one `useMediaActions` call, the announcer
 * and the re-selection input; the screens draw.
 */

/** Album items the phone can show: those not held for 撤销 on the start screen. */
const visibleItems = <T extends { readonly key: string }>(
  items: readonly T[],
  heldRemoval: HeldRemoval | null,
): readonly T[] =>
  heldRemoval === null
    ? items
    : items.filter((item) => !heldRemoval.keys.includes(item.key));

/**
 * The screen the phone shows (r4 D4): 发布 off the media step; on it, 编辑
 * while any photo is visible, else the start screen (`select`): an empty
 * album, or every photo held for 撤销.
 */
export const shownPhoneScreen = (
  step: EditorStep,
  items: readonly { readonly key: string }[],
  heldRemoval: HeldRemoval | null,
): PhoneScreenName =>
  step !== "media"
    ? "publish"
    : visibleItems(items, heldRemoval).length > 0
      ? "edit"
      : "select";

/**
 * A work started in this editor (`{type:"new"}`, 参与话题 included), also
 * once it gained a draft: its 编辑 asks before Back (r4 ASK-1). A draft
 * opened from 草稿箱 or a published work leaves.
 */
const startedHere = (store: EditorSessionStore): boolean =>
  store.get().openedAs.type === "new";

/**
 * One screen back (‹, Escape and the browser's Back): 发布 → 编辑, or the
 * start screen when the work has no photos. On 编辑 a work started here
 * opens the back sheet (重新选择照片 · 存草稿并退出 · 继续编辑, r4 ASK-1)
 * and stays; a draft or a work leaves. `commitScreen` first keeps what 编辑
 * or the start screen still holds (the shown crop, a removal waiting for
 * 撤销), as their ‹ does. False where Back leaves the editor: by then the
 * album the leave guard reads is final. A 封面构图 left open without its
 * screen (`cancelPhoneLayer` gives a shown one the close request instead)
 * just closes.
 */
export const stepBackPhone = (
  store: EditorSessionStore,
  ui: MediaUiStore,
  commitScreen: () => void,
): boolean => {
  if (ui.get().dialog?.type === "cover") {
    ui.closeDialog();
    return true;
  }
  const state = store.get();
  const screen = shownPhoneScreen(
    state.step,
    state.items,
    ui.get().phone.heldRemoval,
  );
  if (screen === "publish") {
    // The album then shows 编辑 or the start screen.
    store.setStep("media");
    return true;
  }
  if (screen === "edit" && startedHere(store)) {
    ui.setBackAsk(true);
    return true;
  }
  commitScreen();
  return false;
};

/**
 * The browser's Back over an open phone layer (a sheet, 封面构图 and its
 * discard sheet): the topmost one gets the close request the platform's own
 * Back gives a modal dialog (`cancel`), so it closes as its ‹, 取消 or
 * Escape would; 封面构图 with a changed composition asks first and stays.
 * False when no layer is open in `root`.
 */
export const cancelPhoneLayer = (root: ParentNode | null): boolean => {
  const open = root?.querySelectorAll<HTMLDialogElement>("dialog[open]");
  const top = open?.[open.length - 1];
  if (top === undefined) return false;
  top.dispatchEvent(new Event("cancel", { cancelable: true }));
  return true;
};

/**
 * Where an opened editor resumes (plan v2, r4 D7: a recovered session, a
 * draft, a work, a kept session): 编辑 at the first photo that needs the
 * author (its stage says what; no sheet opens by itself), else 发布 once the
 * work has something to describe. An empty work, or one whose photos are
 * still being staged, stays. Returns the screen it moved to, or null when
 * nothing moved.
 */
export const resumePhone = (
  store: EditorSessionStore,
  ui: MediaUiStore,
  attention: (item: WorkDraftItem) => boolean,
  adding: boolean,
): PhoneScreenName | null => {
  const state = store.get();
  const needing = state.items.find(attention);
  if (needing !== undefined) {
    const phone = ui.get().phone;
    const before = shownPhoneScreen(state.step, state.items, phone.heldRemoval);
    const was = phone.currentKey ?? state.items[0]?.key ?? null;
    ui.setCurrentKey(needing.key);
    store.setStep("media");
    return before === "edit" && was === needing.key ? null : "edit";
  }
  if (adding || state.step !== "media" || isEmptyWork(state)) return null;
  store.setStep("text");
  return "publish";
};

/**
 * Whether an edit dialog's unfinished work holds a change the author made:
 * a turn, a ratio (or 还原) chosen, which restarts the crop, or a drag or
 * zoom of theirs that moved the crop off the one the photo has. A position
 * the cropper reported on its own is never one (review r2), and neither is
 * a seeded crop re-reported within its rounding after a touch.
 */
export const draftChanged = (draft: EditDraft): boolean => {
  if (draft.rotation !== draft.basis.rotation) return true;
  const session = draft.stored?.session;
  if (session === undefined) return false;
  if (session.generation > 0) return true;
  return (
    session.touched &&
    session.area !== undefined &&
    !closeCrop(normalizeCrop(session.area), normalizeCrop(draft.basis.crop))
  );
};

/**
 * A layout swap from the desktop editor with one of its media dialogs open.
 * The phone draws no 编辑 dialog: the photo opens on 编辑 instead, with the
 * dialog's unfinished crop as the stage's draft, kept like the stage's own
 * change when the author made one there (it is not lost to the swap). A
 * 封面构图 of a photo other than the 首图 ends, since here the cover is the
 * first photo (§6 G6); the first photo's stays open over 编辑, as 封面构图
 * from its photo sheet would be. Without a dialog the album picks the
 * screen (r4 D4).
 */
export const adoptDesktopDialog = (
  store: EditorSessionStore,
  ui: MediaUiStore,
): void => {
  const dialog = ui.get().dialog;
  if (dialog === null) return;
  if (dialog.type === "cover") {
    if (store.media().items[0]?.key !== dialog.key) ui.closeDialog();
    return;
  }
  const draft = ui.draftFor(dialog);
  if (draft !== null)
    ui.saveCropDraft(dialog.key, { ...draft, explicit: draftChanged(draft) });
  ui.closeDialog();
  if (indexOfKey(store.media(), dialog.key) < 0) return;
  ui.setCurrentKey(dialog.key);
  store.setStep("media");
};

const isReferenceField = (field: EditorField): field is ReferenceField =>
  field === "referenceTitle" ||
  field === "originalAuthor" ||
  field === "sourceNote";

/**
 * Shows the screen that holds `field` (前往修改, a layout swap that keeps the
 * field being typed in): media problems on the media step, where the album
 * shows 编辑 or the start screen (r4 §2.4), everything else on 发布, with
 * the reference sheet open at a reference field so its input exists.
 */
export const showPhoneField = (
  store: EditorSessionStore,
  ui: MediaUiStore,
  field: EditorField,
): void => {
  if (field === "media") {
    store.setStep("media");
    return;
  }
  if (isReferenceField(field) && hasReferences(store.get().authorshipKind))
    ui.setReferences(field);
  store.setStep(fieldStep(field));
};

/**
 * 前往处理 on 发布 (r4 D7): 编辑 at the first photo that needs the author,
 * which opens that photo's fix sheet once (`attentionKey`, mockup A
 * `fixPhoto`). False when none does.
 */
export const resolvePhoneMedia = (
  store: EditorSessionStore,
  ui: MediaUiStore,
  attention: (item: WorkDraftItem) => boolean,
): boolean => {
  const item = store.media().items.find(attention);
  if (item === undefined) return false;
  ui.setReferences(null);
  ui.setCurrentKey(item.key);
  ui.setAttentionKey(item.key);
  store.setStep("media");
  return true;
};

/**
 * What 前往修改 focuses for a media problem: the media screen's heading.
 * Only one screen is mounted, so exactly one matches.
 */
export const PHONE_MEDIA_TARGET =
  '[data-editor-screen="edit"] [data-editor-step-heading], [data-editor-screen="select"] [data-editor-step-heading]';

/** 编辑's thumbnail of `key`. */
const thumbOf = (key: string) => `[data-edit-thumb="${key}"]`;

/**
 * Focus once a removal is committed: the neighbour's thumbnail on 编辑, or
 * a re-selected photo's replacement; an emptied album focuses the start
 * screen's 选择照片 (`START_FOCUS`).
 */
export const phoneFocusTarget = (target: MediaFocusTarget): string =>
  target.type === "empty" ? START_FOCUS : thumbOf(target.key);

/**
 * A 发布 card's status, as 编辑's thumbnail names it: the chip's
 * short label (with the error glyph when the photo needs the author) and
 * the full clause for the card's name. Nothing once the photo is ready.
 */
export const publishSlideStatus = (
  status: ItemStatus,
  failure: FailureSource | null,
): Pick<PublishPreviewSlide, "chip" | "statusText"> => {
  const label = tileChip(status, failure);
  if (label === null) return { chip: null, statusText: null };
  const message = "message" in status ? status.message : null;
  return {
    chip: {
      label,
      attention: needsAttention(status),
      glyph: publishChipGlyph(status),
    },
    statusText:
      message === null || message === "" || message === label
        ? label
        : `${label}：${message}`,
  };
};

/** 首图 = 封面 (§6 G6) for the album changes the media actions make on their own. */
const PHONE_COVER_RULE: CoverRule = {
  apply: keepCoverOnFirst,
  notice: COVER_RESET_NOTICE,
};

/** Pictures each screen keeps decoded: none, the stage's shape, the feed. */
const feedScopes: Readonly<Record<PhoneScreenName, EditorMediaScope>> = {
  select: "none",
  edit: { first: 1 },
  publish: { first: FEED_GALLERY_MAXIMUM },
};

export interface PhoneFlowProps {
  /** The editor session the screens edit (`EditorSessionStore.key`). */
  readonly sessionKey: string;
  /** 发布作品 / 编辑作品 / 参与话题 (`editorTitle`). */
  readonly title: string;
  /** The shell's Back target: the shown screen's ‹ carries it. */
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  /**
   * Leaves the editor through its leave guard: ‹ on the start screen, ‹ on
   * 编辑 of a draft or a work, and 编辑's 退出编辑 (no drafts).
   */
  readonly onClose: () => void;
  /**
   * 编辑's 存草稿并退出 (r4 ASK-1): saves the draft and leaves in one tap,
   * waiting first while the picks are still uploading (`saveWait`); a
   * refused save (a photo that needs the author) keeps 编辑, the reason
   * among the notices. Settles either way: with the refusal's reason, which
   * 编辑 says, or null.
   */
  readonly onSaveAndLeave: () => Promise<string | null>;
  /**
   * 存草稿并退出 is waiting for the picks' uploads: 编辑's back sheet shows
   * the progress. Null otherwise.
   */
  readonly saveWait?: SaveWait | null | undefined;
  /** `SaveStatus`: always on 发布, elsewhere only while `saveAlert` (§2.3). */
  readonly saveStatus: ReactNode;
  /** A save failed or two versions wait: every screen shows the status. */
  readonly saveAlert: boolean;
  /** 保存草稿 (saved mode only), on 发布. */
  readonly saveAction?: ReactNode;
  /** 更多操作 with 历史版本, on 发布. */
  readonly menu?: ReactNode;
  /**
   * The editor's notices (recovery, a media failure, an ended session), on
   * every screen (r4 D6); null when there is none.
   */
  readonly notices?: ReactNode;
  readonly textProps: PublishTextProps;
  readonly confirmation: PublishConfirmation;
  readonly publish: PublishAction;
  /** 预览 on 发布: the editor opens `PhonePreview`. */
  readonly onOpenPreview: (opener: HTMLElement) => void;
  /**
   * Where 编辑 and the start screen register the commit of what they still
   * hold (the shown crop, a removal waiting for 撤销), for the leave guard's
   * Back.
   */
  readonly editCommitRef?: RefObject<(() => void) | null> | undefined;
  /**
   * The editor has just opened on the phone: once the uploads are known, it
   * resumes on the screen the work needs (`resumePhone`).
   */
  readonly checkResume?: boolean | undefined;
  readonly onResumeChecked?: (() => void) | undefined;
  /**
   * 专题 and 草稿箱 on the start screen (r4 §3.1), for an untouched new
   * work with 专题文章 on; null otherwise. While 专题 creates, the start
   * screen's ‹ and Escape are held.
   */
  readonly start?: StartOptions | null | undefined;
}

export const PhoneFlow = (props: PhoneFlowProps) => {
  const editor = useEditorSession(props.sessionKey);
  // The session ended (submitted or discarded): nothing to show.
  if (editor === null) return null;
  return <PhoneFlowBody key={props.sessionKey} {...props} editor={editor} />;
};

const NO_KEYS: readonly string[] = [];

const PhoneFlowBody = ({
  editor,
  title,
  backButtonRef,
  onClose,
  onSaveAndLeave,
  saveWait = null,
  saveStatus,
  saveAlert,
  saveAction,
  menu,
  notices,
  textProps,
  confirmation,
  publish,
  onOpenPreview,
  editCommitRef,
  checkResume = false,
  onResumeChecked,
  start = null,
}: PhoneFlowProps & { readonly editor: EditorSessionHandle }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const { state, actions } = editor;
  const ui = mediaUiFor(actions);
  const { phone } = useMediaUiState(ui);
  const shown = shownPhoneScreen(state.step, state.items, phone.heldRemoval);
  const media = useMediaActions(editor, rootRef, {
    feedScope: feedScopes[shown],
    focusTarget: phoneFocusTarget,
    // Both media screens take a photo away at once and commit it after 撤销.
    deferredRemoval: true,
    coverRule: PHONE_COVER_RULE,
  });
  // The shown screen's commit (a crop, a removal waiting for 撤销).
  const ownCommitRef = useRef<(() => void) | null>(null);
  const commitRef = editCommitRef ?? ownCommitRef;

  // The photo shown on 编辑, paging included, is the 发布 slide on return.
  const editKey = shown === "edit" ? phone.currentKey : null;
  const { setActiveIndex } = media;
  useEffect(() => {
    if (editKey === null) return;
    const index = state.items.findIndex((item) => item.key === editKey);
    if (index >= 0) setActiveIndex(Math.min(index, FEED_GALLERY_MAXIMUM - 1));
  }, [editKey, state.items, setActiveIndex]);

  /** 编辑 at `key` (a 发布 card's tap, a finished pick). */
  const openItem = (key: string) => {
    ui.setCurrentKey(key);
    actions.setStep("media");
  };

  // The reference sheet belongs to 发布 and to a kind with references:
  // another screen, or another kind (chosen on the desktop meanwhile),
  // closes it, so it never reopens by itself later.
  const referencesOpen = phone.references !== null;
  const referenceKind = hasReferences(state.authorshipKind);
  useEffect(() => {
    if (referencesOpen && (shown !== "publish" || !referenceKind))
      ui.setReferences(null);
  }, [shown, referencesOpen, referenceKind, ui]);

  /**
   * Stages a selection under the device's last 原图画质 choice (`stage`
   * reads it at the call; the start screen restores it only while it is
   * shown, and 编辑's add sheet has just written it).
   */
  const addFiles = (
    files: readonly File[],
    origin: FileOrigin,
  ): Promise<StageOutcome> => {
    const remembered = readOriginalQuality();
    if (remembered !== null) actions.setOriginalNext(remembered);
    return media.stage(files, origin);
  };

  /**
   * A finished pick from the start screen opens 编辑 at its first photo
   * (r4 D5), unsupported files included: their notice shows in 编辑's band.
   */
  const openAdded = (outcome: StageOutcome) => {
    if (outcome.status !== "added" || outcome.keys.length === 0) return;
    const first = outcome.keys[0]!;
    if (
      actions.get().step !== "media" ||
      indexOfKey(actions.media(), first) < 0
    )
      return;
    openItem(first);
  };

  // Before the first paint: a dialog the desktop left open (a layout swap).
  useLayoutEffect(() => adoptDesktopDialog(actions, ui), [ui, actions]);

  // Resume (plan v2), once per opening on the phone, once the uploads are
  // known. Its screen change focuses as any other does (below): the screen's
  // heading, unless focus is already somewhere in the flow.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !checkResume || !media.loaded) return;
    // Once here too: the store's re-render may come before the editor's.
    resumed.current = true;
    onResumeChecked?.();
    resumePhone(
      actions,
      ui,
      (item) => needsAttention(media.statusOf(item)),
      media.staging !== null,
    );
  });

  // A screen change moves focus to the new bar title (also 编辑's 下一步 to
  // 发布, mockup A: no field takes focus, so no keyboard hides the 发布 bar
  // and the preview), or to 标题 when 先写标题和正文 went there to write,
  // or to what the change named (`focusNext`: the start screen's 撤销 names
  // the photo it brings back, revealed in 编辑's strip). Mounting (open,
  // layout swap) never does, and neither does a change whose removal already
  // placed focus. A resume's change is one too: the opening's focus may have
  // gone with the screen it left (focus fell to the page), and one made
  // before that focus leaves it the heading to keep.
  const shownBefore = useRef(shown);
  const writeNext = useRef(false);
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = shown;
    const root = rootRef.current;
    if (before === shown || root === null) return;
    const write = writeNext.current && shown === "publish";
    writeNext.current = false;
    const named = focusNext.current;
    focusNext.current = null;
    const thumb =
      named === null ? null : root.querySelector<HTMLElement>(named);
    if (thumb !== null) {
      thumb.focus({ preventScroll: true });
      const strip = thumb.closest<HTMLElement>("[data-edit-strip]");
      if (strip !== null)
        revealThumb(strip, thumb.closest<HTMLElement>("li") ?? thumb);
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      root.contains(active)
    )
      return;
    const target = write
      ? root.querySelector<HTMLElement>('[data-editor-input="title"]')
      : root.querySelector<HTMLElement>("[data-editor-step-heading]");
    target?.focus({ preventScroll: true });
  }, [shown]);
  const step = state.step;

  // "confirm" (前往查看 a general failure, a restored step) is 发布 with its
  // confirmation in view.
  useEffect(() => {
    if (shown !== "publish" || step !== "confirm") return;
    rootRef.current
      ?.querySelector<HTMLElement>("[data-editor-confirmation]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [shown, step]);

  /**
   * 编辑's 移除 (committed once its 撤销 ended, which said it), under 首图 =
   * 封面 (§6 G6).
   */
  const removeKeepingCover = (key: string) => {
    if (indexOfKey(actions.media(), key) < 0) return;
    if (keepCoverAround(actions, () => media.remove(key)))
      media.showNotice(COVER_RESET_NOTICE);
  };
  // 编辑's order changes (a drop, Alt + arrows, 设为首图, 前移 / 后移; r4
  // D12) keep 首图 = 封面 in 编辑 itself, around the plain `reorder`, so
  // the cover's reset is said once, with the move's own words.
  const editMedia: MediaActions = {
    ...media,
    remove: removeKeepingCover,
    // The stage keeps its edits on its own and says its turns and 还原 in
    // its toasts: 「第 N 项的编辑已应用」 is never said on each pause.
    applyEdit: (key, edit, options) =>
      media.applyEdit(key, edit, { quiet: true, ...options }),
  };

  /**
   * A submission in flight keeps 发布 and the work as submitted: its ‹,
   * Escape, 添加照片 and a card's tap go nowhere (the browser's Back gets the
   * leave guard's 正在确认结果… instead), so 编辑 cannot change a photo the
   * submission holds.
   */
  const holdPublish = shown === "publish" && publish.busy;
  /**
   * 专题 creating its draft keeps the start screen (r4 D3): its ‹ is held
   * and Escape does nothing (the leave guard blocks the browser's Back).
   */
  const holdStart = shown === "select" && start?.topic.busy === true;
  /**
   * One screen back, as the shown screen's ‹: 发布 → 编辑 (or the start
   * screen without photos), 编辑 → its back sheet for a work started here,
   * and out through the editor's leave guard from the start screen or from
   * 编辑 of a draft or a work (Escape, r2 matrix).
   */
  const stepBack = () => {
    if (holdPublish || holdStart) return;
    if (!stepBackPhone(actions, ui, () => commitRef.current?.())) onClose();
  };
  const latestStepBack = useRef(stepBack);
  latestStepBack.current = stepBack;
  // Escape steps back like ‹ unless something inside took it: a sheet or
  // 封面构图 (their dialogs), a field being typed in, the ≡ menu or a photo
  // being sorted (their own listeners prevent it before it reaches here).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      const root = rootRef.current;
      const target = event.target;
      if (
        root === null ||
        !(target instanceof HTMLElement) ||
        !root.contains(target) ||
        // An open layer (a sheet, 封面构图) owns Escape, wherever focus is.
        root.querySelector("dialog[open]") !== null ||
        // A photo being dragged (pointer or touch): Escape cancels the drag.
        root.querySelector('[aria-roledescription][aria-pressed="true"]') !==
          null ||
        target.closest('dialog, [role="menu"]') !== null ||
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      event.preventDefault();
      latestStepBack.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { dialog, dialogItem } = media;
  const alert = saveAlert ? saveStatus : undefined;
  // 发布's cards carry the photos' status chips until each photo is ready.
  const slides = media.feed.slides.map((slide): PublishPreviewSlide => {
    const item = media.value.items.find((entry) => entry.key === slide.key);
    if (item === undefined) return slide;
    const status = media.statusOf(item);
    return {
      ...slide,
      ...publishSlideStatus(
        status,
        failureSource(
          status,
          media.views.get(item.key),
          media.serverFor(item) ?? undefined,
        ),
      ),
    };
  });
  // 前往处理 on 发布's readiness line while a photo needs the author: that
  // photo on 编辑, with its fix sheet.
  const attention = (item: WorkDraftItem) =>
    needsAttention(media.statusOf(item));
  const needsAuthor = media.value.items.some(attention);
  const publishConfirmation: PublishConfirmation = needsAuthor
    ? {
        ...confirmation,
        onResolveMedia: () => {
          if (!resolvePhoneMedia(actions, ui, attention))
            confirmation.onGoToField("media");
        },
      }
    : confirmation;
  const coverItem =
    dialog?.type === "cover" && dialogItem !== null ? dialogItem : null;
  const held = phone.heldRemoval;

  return (
    <div
      ref={rootRef}
      className={editorStyles.phone}
      data-phone-flow={state.key}
    >
      {shown === "select" ? (
        <SelectScreen
          backButtonRef={backButtonRef}
          commitRef={commitRef}
          editor={editor}
          heldRemoval={held}
          media={media}
          notices={notices}
          // A finished pick goes straight on to 编辑 (r4 D5).
          onAddFiles={(files, origin) =>
            void addFiles(files, origin).then(openAdded)
          }
          onClose={onClose}
          onHeldCommitted={() => ui.setHeldRemoval(null)}
          onHeldUndo={() => {
            // 编辑 at the photo it showed, its thumbnail focused (r4 §2.4).
            const current = ui.get().phone.heldRemoval?.current ?? null;
            focusNext.current =
              current === null ? "[data-edit-thumb]" : thumbOf(current);
            ui.setCurrentKey(current);
            ui.setHeldRemoval(null);
          }}
          onSkipToText={() => {
            // 发布 entered to write: 标题 takes focus there.
            writeNext.current = true;
            actions.setStep("text");
          }}
          saveStatus={alert}
          start={start}
          title={title}
        />
      ) : shown === "edit" ? (
        <EditScreen
          attentionKey={phone.attentionKey}
          backButtonRef={backButtonRef}
          commitRef={commitRef}
          editor={editor}
          heldKeys={held?.keys ?? NO_KEYS}
          media={editMedia}
          notices={notices}
          // Mockup B: photos added from the strip or the add sheet join the
          // end and the stage stays on the photo being edited (the screen's
          // toast says where they went).
          onAddFiles={(files, origin) => void addFiles(files, origin)}
          onAttentionTaken={() => ui.setAttentionKey(null)}
          onBack={stepBack}
          onComposeCover={(key) => ui.openDialog({ type: "cover", key })}
          onLeave={onClose}
          onNext={() => actions.setStep("text")}
          // 重新选择照片: every photo waits on the start screen for 撤销.
          onRemoveAll={(keys, current) => ui.setHeldRemoval({ keys, current })}
          // Nothing is left to edit: the start screen takes the removal
          // over with its 撤销, which brings the photo back on 编辑.
          onRemoveLast={(key) =>
            ui.setHeldRemoval({ keys: [key], current: key })
          }
          onSaveAndLeave={onSaveAndLeave}
          saveWait={saveWait}
          secondLine={alert}
        />
      ) : (
        <PublishScreen
          backButtonRef={backButtonRef}
          confirmation={publishConfirmation}
          editor={editor}
          menu={menu}
          notices={
            <>
              {notices}
              <MediaNotice
                notice={media.notice}
                onDismiss={() => ui.setNotice(null)}
              />
            </>
          }
          onBack={() => {
            if (!holdPublish) stepBackPhone(actions, ui, () => undefined);
          }}
          onOpenPreview={onOpenPreview}
          onReferences={ui.setReferences}
          preview={
            slides.length === 0
              ? null
              : {
                  slides,
                  total: media.feed.total,
                  activeIndex: media.activeSlide,
                  onActiveIndexChange: media.setActiveIndex,
                  onOpenItem: (index) => {
                    const key = slides[index]?.key;
                    if (key !== undefined && !holdPublish) openItem(key);
                  },
                }
          }
          publish={publish}
          references={phone.references}
          saveAction={saveAction}
          saveStatus={saveStatus}
          textProps={textProps}
          title={title}
        />
      )}
      <input {...media.reselectInput} />
      <div
        aria-live="polite"
        className={mediaStyles.visuallyHidden}
        data-media-announcer=""
        role="status"
      >
        {media.announcement}
      </div>
      {coverItem === null ? null : (
        <CoverScreen
          blob={media.session.localStill(coverItem.key)}
          coverCrop={
            media.value.coverKey === coverItem.key
              ? media.value.coverCrop
              : null
          }
          derivativeExpected={media.dialogDerivative}
          edit={coverItem.edit}
          initialDraft={ui.draftFor({ type: "cover", key: coverItem.key })}
          itemKey={coverItem.key}
          onApply={(crop) => media.applyCoverCrop(coverItem.key, crop)}
          onClose={() => ui.closeDialog()}
          onDraftChange={(draft) =>
            ui.saveDraft({ type: "cover", key: coverItem.key }, draft)
          }
          src={media.dialogServer?.media?.displaySrc ?? null}
        />
      )}
    </div>
  );
};
