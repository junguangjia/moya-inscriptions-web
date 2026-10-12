"use client";

import { useEffect, useRef, useState } from "react";

import editorStyles from "../editor/editor.module.css";
import { indexOfKey } from "../media/media-order";
import {
  EmptySelection,
  QualitySwitch,
  readOriginalQuality,
  storeOriginalQuality,
} from "./add-tiles";
import { MediaNotice } from "./media-notice";
import { PhoneBarCaption, PhoneScreen } from "./phone-screen";
import styles from "./select-screen.module.css";

import type { StartOptions } from "./add-tiles";
import type { FileOrigin } from "../../import-grouping";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type { HeldRemoval } from "../media/media-ui-store";
import type { MediaActions } from "../media/use-media-actions";
import type { ReactNode, Ref, RefObject } from "react";

/**
 * The start screen of the phone publishing flow (#244 r4, the old 选择照片
 * empty state, `data-editor-screen="select"`): 选择照片 · 拍照 · 专题 as
 * large tiles, 跳过，只发布文字 under them, 草稿箱 at the bar's end on an
 * untouched new work (ASK-2) and 原图画质 for the next photos in the bottom
 * bar. It shows exactly when no photo is visible (D4): the album is empty,
 * or every photo in it waits here for 撤销 (`heldRemoval`: 编辑's last
 * photo removed, or 重新选择照片). A pick goes straight on to 编辑 (D5),
 * which the flow does once the photos are in the album. Everything comes in
 * through props: the flow owns the one `useMediaActions` call, the
 * announcer and the re-selection input.
 */

export interface SelectScreenProps {
  readonly editor: EditorSessionHandle;
  /** The flow's media actions; every album change here goes through them. */
  readonly media: MediaActions;
  /** 发布作品, 编辑作品 or 参与话题 (`editorTitle`). */
  readonly title: string;
  /** The shell's Back target (`controls.backButtonRef`). */
  readonly backButtonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The flow's `SaveStatus` while a save failed or two versions wait
   * (§2.3); it replaces the bar's caption. Absent otherwise.
   */
  readonly saveStatus?: ReactNode;
  /**
   * The editor's own notices (a restored session, a media failure found at
   * submission, an ended session), shown above the tiles as on every step.
   */
  readonly notices?: ReactNode;
  /** ‹ 返回: closes the editor through its leave guard. */
  readonly onClose: () => void;
  /** 跳过，只发布文字. */
  readonly onSkipToText: () => void;
  /** Files from 选择照片 or 拍照, to stage (the flow then shows 编辑). */
  readonly onAddFiles: (files: readonly File[], origin: FileOrigin) => void;
  /**
   * Photos taken out of view and waiting here for 撤销 (D4, D20): one
   * from 编辑's last removal, or all of them from 重新选择照片. They are
   * hidden from the first render; the toast offers 撤销 (`onHeldUndo`);
   * otherwise they are removed when it ends, on ‹, 跳过 or a pick, when
   * photos start to be staged (a paste, a drop) and when the screen goes,
   * then `onHeldCommitted`.
   */
  readonly heldRemoval?: HeldRemoval | null | undefined;
  /** 撤销: the photos come back, and 编辑 shows the one it showed. */
  readonly onHeldUndo?: (() => void) | undefined;
  /** The held photos were removed from the album: the record can go. */
  readonly onHeldCommitted?: (() => void) | undefined;
  /**
   * 专题 and 草稿箱 (r4 §3.1), on an untouched new work with 专题文章 on;
   * absent otherwise. While 专题 creates its draft, ‹ is held and every
   * other control waits.
   */
  readonly start?: StartOptions | null | undefined;
  /**
   * Holds the commit of the held removals while the screen is mounted, so
   * the editor's leave guard can put them through before a browser Back
   * leaves (as ‹ does).
   */
  readonly commitRef?: RefObject<(() => void) | null> | undefined;
}

/** What takes focus on the start screen: 选择照片 (an emptied album, a hand-over). */
export const START_FOCUS = "[data-media-picker] button";

/** How long a toast shows (B): a plain one, and one that offers 撤销. */
export const TOAST_MS = 2200;
export const TOAST_UNDO_MS = 4200;
/** The toast's fade before it leaves (B: 220ms, the normal duration and a frame). */
const TOAST_FADE_MS = 220;

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly undo: (() => void) | null;
}

/**
 * One toast (B `.toast`): shows, fades, then asks to leave. Its time stands
 * still while focus or a pointer is on it, so 撤销 never leaves from under
 * the author (WCAG 2.2.1); should focus still be on it as it leaves, the
 * screen's heading takes focus instead of the page.
 */
const ToastView = ({
  toast,
  onExpire,
  onGone,
}: {
  readonly toast: Toast;
  /** Its time is up: 撤销 is no longer offered. */
  readonly onExpire: () => void;
  readonly onGone: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [out, setOut] = useState(false);
  const [focusHeld, setFocusHeld] = useState(false);
  const [pointerHeld, setPointerHeld] = useState(false);
  const held = focusHeld || pointerHeld;
  const latest = useRef({ onExpire, onGone });
  latest.current = { onExpire, onGone };
  const remaining = useRef(toast.undo === null ? TOAST_MS : TOAST_UNDO_MS);
  useEffect(() => {
    if (out || held) return undefined;
    const started = Date.now();
    const fade = window.setTimeout(() => {
      remaining.current = 0;
      setOut(true);
      latest.current.onExpire();
    }, remaining.current);
    return () => {
      window.clearTimeout(fade);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [out, held]);
  useEffect(() => {
    if (!out) return undefined;
    const gone = window.setTimeout(() => {
      const node = ref.current;
      if (node?.contains(document.activeElement))
        node
          .closest("[data-editor-screen]")
          ?.querySelector<HTMLElement>("[data-editor-step-heading]")
          ?.focus({ preventScroll: true });
      latest.current.onGone();
    }, TOAST_FADE_MS);
    return () => window.clearTimeout(gone);
  }, [out]);
  return (
    <div
      ref={ref}
      className={styles.toast}
      data-action={toast.undo === null ? undefined : ""}
      data-out={out ? "" : undefined}
      data-select-toast=""
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocusHeld(false);
      }}
      onFocus={() => setFocusHeld(true)}
      onPointerEnter={() => setPointerHeld(true)}
      onPointerLeave={() => setPointerHeld(false)}
    >
      <span>{toast.text}</span>
      {toast.undo === null ? null : (
        <button onClick={toast.undo} type="button">
          撤销
        </button>
      )}
    </div>
  );
};

/** What the toast says for held photos: their place when one, else how many. */
const heldText = (keys: readonly string[], album: readonly string[]) =>
  keys.length === 1
    ? `已移除第 ${album.indexOf(keys[0]!) + 1} 项`
    : `已移除 ${keys.length} 项`;

export const SelectScreen = ({
  editor,
  media,
  title,
  backButtonRef,
  saveStatus,
  notices,
  onClose,
  onSkipToText,
  onAddFiles,
  heldRemoval = null,
  onHeldUndo,
  onHeldCommitted,
  start = null,
  commitRef,
}: SelectScreenProps) => {
  const [toast, setToast] = useState<Toast | null>(null);
  const toastIds = useRef(0);
  /**
   * The held removals this screen still has to commit. Read from the
   * props it was mounted with (never cleared at mount, H3) and dropped by
   * 撤销, so a commit after 撤销 (the screen going) removes nothing.
   */
  const pending = useRef<HeldRemoval | null>(heldRemoval);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { maxItems } = media;
  const original = editor.state.originalNext;
  const reading = media.staging !== null;
  const held = heldRemoval !== null;
  const topicBusy = start?.topic.busy === true;

  // Each batch resets 原图画质; the device's last choice is kept instead.
  useEffect(() => {
    const remembered = readOriginalQuality();
    if (remembered !== null && remembered !== original)
      editor.actions.setOriginalNext(remembered);
  }, [editor.actions, original]);

  /**
   * Commits the held removals: every held photo still in the album is
   * removed (its upload cancelled) in one album edit, then
   * `onHeldCommitted`. Runs once 撤销 is no longer offered (its toast ended
   * or gave way), before anything else is added and when the screen goes.
   * The album empties, so no cover rule is needed, and what the removal
   * says (a chosen cover gone) is worked out once, on the emptied album:
   * never one photo at a time.
   */
  const commitHeld = (expired = false) => {
    const taken = pending.current;
    if (taken === null) return;
    pending.current = null;
    // Its toast fades on its own once expired; otherwise its 撤销 goes now.
    if (!expired) setToast((current) => (current?.undo ? null : current));
    const album = editor.actions.media();
    const keys = taken.keys.filter((key) => indexOfKey(album, key) >= 0);
    if (keys.length > 0) media.removeMany(keys);
    onHeldCommitted?.();
  };
  const latestCommit = useRef(commitHeld);
  latestCommit.current = commitHeld;
  useEffect(() => {
    if (commitRef === undefined) return undefined;
    const commit = () => latestCommit.current();
    commitRef.current = commit;
    return () => {
      if (commitRef.current === commit) commitRef.current = null;
    };
  }, [commitRef]);
  // Leaving the screen (编辑 after a paste, the editor closed, a layout
  // swap) ends the undo too. Committed a microtask later, and only if the
  // screen did not come straight back: React's development double mount
  // runs this cleanup and mounts again at once, which must not end an undo
  // the screen was mounted with.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) latestCommit.current();
      });
    };
  }, []);
  // Photos start to be staged some other way (a paste, a drop): the held
  // ones go first, so 编辑 never shows them next to the new ones (D20).
  const wasReading = useRef(reading);
  useEffect(() => {
    const started = reading && !wasReading.current;
    wasReading.current = reading;
    if (started) latestCommit.current();
  }, [reading]);

  const showToast = (text: string, undo: (() => void) | null = null) => {
    toastIds.current += 1;
    setToast({ id: toastIds.current, text, undo });
  };

  // Held photos: their toast with 撤销, once per mount (the development
  // double mount too), and focus on 选择照片 where the photo was.
  const offered = useRef(false);
  useEffect(() => {
    const taken = pending.current;
    if (offered.current || taken === null) return;
    offered.current = true;
    bodyRef.current
      ?.querySelector<HTMLElement>(START_FOCUS)
      ?.focus({ preventScroll: true });
    showToast(
      heldText(
        taken.keys,
        editor.actions.media().items.map((item) => item.key),
      ),
      () => {
        if (pending.current !== taken) return;
        pending.current = null;
        setToast(null);
        onHeldUndo?.();
      },
    );
    // Mount only: the held record is read once.
  }, []);

  /**
   * 原图画质 for the next photos. It is not a commit trigger: photos held
   * for 撤销 stay held, and their toast stays with its 撤销, so the switch
   * is then said through the flow's announcer instead of a toast.
   */
  const chooseOriginal = (next: boolean) => {
    storeOriginalQuality(next);
    editor.actions.setOriginalNext(next);
    const text = next ? "原图画质已打开" : "原图画质已关闭";
    if (pending.current !== null) media.announce(text);
    else showToast(text);
  };

  /** Leaving the screen first commits the held removals. */
  const leaving = (go: () => void) => () => {
    commitHeld();
    go();
  };

  const add = (files: File[]) => {
    commitHeld();
    onAddFiles(files, "picker");
  };
  const caption = `选择照片 · 最多 ${maxItems} 项`;
  const secondLine =
    saveStatus === undefined ||
    saveStatus === null ||
    typeof saveStatus === "boolean" ? (
      <PhoneBarCaption data-select-count="">{caption}</PhoneBarCaption>
    ) : (
      saveStatus
    );
  const openDrafts = start?.onOpenDrafts;
  // 草稿箱 waits while photos are read or held and while 专题 creates:
  // `aria-disabled`, so it keeps focus should it have it (a paste).
  const draftsWaiting = reading || held || topicBusy;

  return (
    <PhoneScreen
      action={
        openDrafts === undefined ? undefined : (
          <button
            aria-disabled={draftsWaiting ? "true" : undefined}
            className={`${editorStyles.textButton} ${styles.waitingButton}`}
            data-start-drafts=""
            onClick={() => {
              if (!draftsWaiting) openDrafts();
            }}
            type="button"
          >
            草稿箱
          </button>
        )
      }
      backButtonRef={backButtonRef}
      backHeld={topicBusy}
      backLabel="返回"
      footer={<QualitySwitch onToggle={chooseOriginal} original={original} />}
      footerLayout="toolbar"
      onBack={leaving(onClose)}
      overlay={
        // Always mounted, so a new toast is announced (inserted regions often are not).
        <div className={styles.toastHost} role="status">
          {toast === null ? null : (
            <ToastView
              key={toast.id}
              onExpire={() => {
                if (toast.undo !== null) commitHeld(true);
              }}
              onGone={() =>
                setToast((current) =>
                  current?.id === toast.id ? null : current,
                )
              }
              toast={toast}
            />
          )}
        </div>
      }
      screen="select"
      scroll="bleed"
      secondLine={secondLine}
      title={title}
    >
      <div ref={bodyRef} className={styles.body} data-select-body="">
        <div className={styles.notes}>
          {notices}
          <MediaNotice
            notice={media.notice}
            onDismiss={() => media.ui.setNotice(null)}
          />
        </div>
        {/* Always mounted: only its words change while photos are read. */}
        <p className={styles.reading} role="status">
          {(media.staging?.identifying ?? 0) > 0 ? "正在读取照片…" : ""}
        </p>
        <EmptySelection
          disabled={!media.canSelect}
          held={held}
          onFiles={add}
          onSkip={reading ? null : leaving(onSkipToText)}
          reading={reading}
          start={start}
        />
      </div>
    </PhoneScreen>
  );
};

export { ORIGINAL_QUALITY_STORAGE_KEY, readOriginalQuality } from "./add-tiles";
