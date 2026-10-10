"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";
import type { CommentUserPresentation } from "../comments/comment-types";
import { ColophonSignature } from "./feed-colophon-entry";
import { VerticalText } from "./vertical-text";
import styles from "./feed-colophon.module.css";

/**
 * The composer's draft text, held outside React state: only the preview's
 * ink subscribes, so typing never renders the colophons around it.
 */
export interface ColophonDraftSource {
  readonly get: () => string;
  /** Ignores a value equal to the current one. */
  readonly set: (draft: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export const createColophonDraftSource = (): ColophonDraftSource => {
  let value = "";
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (draft) => {
      if (draft === value) return;
      value = draft;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const serverDraft = () => "";
const serverKept = () => false;

/** The draft text; re-renders the caller on every change. */
export const useColophonDraftText = (source: ColophonDraftSource): string =>
  useSyncExternalStore(source.subscribe, source.get, serverDraft);

/** Whether a draft is kept; re-renders only when that changes. */
export const useColophonDraftKept = (source: ColophonDraftSource): boolean =>
  useSyncExternalStore(
    source.subscribe,
    () => source.get().trim() !== "",
    serverKept,
  );

/** The preview shows at most this many characters: the draft's end. */
export const DRAFT_TAIL_CHARS = 600;

/** The end of a long draft, led by 「…」; a shorter one whole. */
export const colophonDraftTail = (text: string): string => {
  const characters = [...text];
  return characters.length > DRAFT_TAIL_CHARS
    ? `…${characters.slice(-DRAFT_TAIL_CHARS).join("")}`
    : text;
};

export type ColophonDraftState = "draft" | "sending" | "failed";

/** The mark in the draft's time slot. */
export const draftStatusLabel = (
  state: ColophonDraftState,
): "草稿" | "发送中" | "未发出" =>
  state === "sending" ? "发送中" : state === "failed" ? "未发出" : "草稿";

/**
 * How tall the draft's column may run so its end (and signature) stays above
 * the composer bar: from the column's top to a gap above the bar, never under
 * `min` nor over the full column; null while the bar has no box.
 */
export const colophonDraftBand = ({
  rootTop,
  formTop,
  gap,
  min,
  full,
}: {
  readonly rootTop: number;
  readonly formTop: number | null;
  readonly gap: number;
  readonly min: number;
  readonly full: number;
}): number | null =>
  formTop === null
    ? null
    : Math.min(full, Math.max(min, formTop - gap - rootTop));

/** The least band, in em of the draft's text: six characters. */
const DRAFT_MIN_BAND_EM = 6;
/** The one-time nudge waits this long for the keyboard when it never moves. */
const NUDGE_FALLBACK_MS = 450;
/** And this long for the visual viewport to rest after it moved. */
const NUDGE_SETTLE_MS = 120;

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const px = (value: string) => Number.parseFloat(value) || 0;

/** The nearest ancestor that scrolls vertically, if any. */
const verticalScroller = (node: Element | null): HTMLElement | null => {
  for (let at = node?.parentElement ?? null; at !== null; at = at.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  return null;
};

/**
 * Keeps the draft's end above the composer bar and the keyboard: measures the
 * band from the column's top to the bar and writes it to the sheet (never
 * through React state), on open and whenever the bar, the visual viewport or
 * a scroll moves it. Once per open, a band still under six characters after
 * the keyboard came up nudges the feed just enough, never the stage's top
 * past the visual viewport's.
 */
export const useColophonDraftBand = (
  sheetRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  composerForm: HTMLFormElement | null,
): void => {
  const nudged = useRef(false);
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const root = rootRef.current;
    if (sheet === null || root === null) return undefined;
    const clear = () => sheet.style.removeProperty("--colophon-draft-band");
    if (composerForm === null) {
      clear();
      return undefined;
    }
    const read = () => {
      const bar = composerForm.getBoundingClientRect();
      const sheetStyle = getComputedStyle(sheet);
      const min = DRAFT_MIN_BAND_EM * px(getComputedStyle(root).fontSize);
      const rootTop = root.getBoundingClientRect().top;
      const formTop = bar.height > 0 ? bar.top : null;
      const gap = px(sheetStyle.getPropertyValue("--yoyi-space-2"));
      const full =
        sheet.clientHeight -
        px(sheetStyle.paddingTop) -
        px(sheetStyle.paddingBottom);
      return {
        min,
        raw: formTop === null ? null : formTop - gap - rootTop,
        band: colophonDraftBand({ rootTop, formTop, gap, min, full }),
      };
    };
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const { band } = read();
      if (band === null) clear();
      else sheet.style.setProperty("--colophon-draft-band", `${band}px`);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    measure();

    const viewport = window.visualViewport;
    let nudgeTimer: number | null = null;
    const nudge = () => {
      nudgeTimer = null;
      if (nudged.current) return;
      nudged.current = true;
      const { raw, min } = read();
      if (raw === null || raw >= min) return;
      const stage = sheet.closest("[data-feed-stage]") ?? sheet;
      const scroller = verticalScroller(stage);
      if (scroller === null) return;
      // The stage's top stays in view: under the visual viewport's top and
      // the scroller's own (below any bar over the feed).
      const top = Math.max(
        viewport?.offsetTop ?? 0,
        scroller.getBoundingClientRect().top,
      );
      const amount = Math.min(
        min - raw,
        stage.getBoundingClientRect().top - top,
      );
      if (amount < 1) return;
      scroller.scrollBy({
        top: amount,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    };
    const armNudge = (ms: number) => {
      if (nudged.current) return;
      if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(nudge, ms);
    };
    const viewportResized = () => {
      schedule();
      armNudge(NUDGE_SETTLE_MS);
    };
    armNudge(NUDGE_FALLBACK_MS);

    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(composerForm);
    viewport?.addEventListener("resize", viewportResized);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("resize", viewportResized);
      viewport?.removeEventListener("scroll", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
      clear();
    };
  }, [composerForm, rootRef, sheetRef]);
};

/** Whether focus is inside the composer form. */
const useFormFocused = (form: HTMLFormElement | null): boolean => {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (form === null) {
      setFocused(false);
      return undefined;
    }
    setFocused(form.contains(document.activeElement));
    const enter = () => setFocused(true);
    const leave = (event: FocusEvent) =>
      setFocused(
        event.relatedTarget instanceof Node &&
          form.contains(event.relatedTarget),
      );
    form.addEventListener("focusin", enter);
    form.addEventListener("focusout", leave);
    return () => {
      form.removeEventListener("focusin", enter);
      form.removeEventListener("focusout", leave);
    };
  }, [form]);
  return focused;
};

/**
 * The draft's ink: the only part that follows the typing. A long draft keeps
 * its end in view (CSS clips its start); one new column at a time, the cut
 * edge is marked.
 */
const DraftInk = ({
  source,
  lead,
  placeholder,
  composerForm,
}: {
  readonly source: ColophonDraftSource;
  readonly lead?: ReactNode;
  readonly placeholder: string;
  readonly composerForm: HTMLFormElement | null;
}) => {
  const text = useColophonDraftText(source);
  const focused = useFormFocused(composerForm);
  const textRef = useRef<HTMLSpanElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = textRef.current;
    const ink = inkRef.current;
    if (box === null || ink === null) return undefined;
    // Cut only when a column's worth is lost: a sub-pixel difference between
    // the ink and its box would fade a lead that is still wholly shown.
    const measure = () => {
      const lost =
        ink.getBoundingClientRect().width - box.getBoundingClientRect().width;
      if (
        lost >
        0.5 * (Number.parseFloat(getComputedStyle(box).fontSize) || 16)
      )
        box.dataset.overflow = "true";
      else delete box.dataset.overflow;
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(ink);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const tail = colophonDraftTail(text);
  const pen = (
    <span
      className={styles.draftPen}
      data-colophon-draft-pen=""
      data-focused={focused ? "" : undefined}
    />
  );
  // The pen stands where the next character goes: before the placeholder
  // while nothing is written, after the last character once something is.
  return (
    <span
      className={`${styles.text} ${styles.draftText}`}
      data-colophon-draft-text=""
      ref={textRef}
    >
      <span className={styles.draftInk} ref={inkRef}>
        {lead}
        {tail === "" ? (
          <>
            {pen}
            <span className={styles.draftPlaceholder}>{placeholder}</span>
          </>
        ) : (
          <>
            <VerticalText text={tail} />
            {pen}
          </>
        )}
      </span>
    </span>
  );
};

/**
 * The draft's mark. 未发出 holds only for the text that failed: once the
 * reader changes it, it is a draft again. Re-renders only when that flips.
 */
const DraftMark = ({
  state,
  source,
}: {
  readonly state: ColophonDraftState;
  readonly source: ColophonDraftSource;
}) => {
  const failedText = useRef<string | null>(null);
  if (state !== "failed") failedText.current = null;
  else failedText.current ??= source.get();
  const edited = useSyncExternalStore(
    source.subscribe,
    () => failedText.current !== null && source.get() !== failedText.current,
    serverKept,
  );
  const shown = state === "failed" && edited ? "draft" : state;
  return (
    <span className={styles.draftMark} data-colophon-draft-status={shown}>
      {draftStatusLabel(shown)}
    </span>
  );
};

/** Only an unknown moment: a draft's signature shows its mark instead. */
const NO_TIME = new Date(0);

/**
 * The slip's face: its prompt with a pen mark at the top and the reader's own
 * avatar at its foot (a guest's an empty ring). Phrasing content only.
 */
export const ColophonInvite = ({
  user,
  prompt,
}: {
  /** Null for a guest. */
  readonly user: CommentUserPresentation | null;
  readonly prompt: string;
}) => (
  <>
    <span className={styles.invitePrompt}>
      {prompt}
      {user === null ? null : (
        <span aria-hidden="true" className={styles.invitePen} />
      )}
    </span>
    <span
      aria-hidden="true"
      className={styles.inviteFace}
      data-colophon-invite-face=""
    >
      {user === null ? null : user.avatarSrc === undefined ||
        user.avatarSrc === null ? (
        ([...user.name.trim()][0] ?? "")
      ) : (
        <img alt="" loading="lazy" src={user.avatarSrc} />
      )}
    </span>
  </>
);

/**
 * A new colophon as it is being written: in the head (or the end column),
 * where it will appear once sent, vertical and signed by the reader, framed
 * and marked as a draft. Its width never changes while typing.
 */
export const ColophonDraftSheet = ({
  source,
  user,
  slot,
  state,
  composerForm,
}: {
  readonly source: ColophonDraftSource;
  readonly user: CommentUserPresentation;
  readonly slot: "head" | "end";
  readonly state: ColophonDraftState;
  readonly composerForm: HTMLFormElement | null;
}) => {
  const sheetRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  useColophonDraftBand(sheetRef, rootRef, composerForm);
  return (
    <span
      aria-hidden="true"
      className={styles.draftSheet}
      data-colophon-draft={slot}
      data-draft-state={state}
      ref={sheetRef}
    >
      <span className={styles.root} ref={rootRef}>
        <DraftInk
          composerForm={composerForm}
          placeholder="在下方书写，此处竖排预览"
          source={source}
        />
        <ColophonSignature
          createdAt={undefined}
          mark={<DraftMark source={source} state={state} />}
          now={NO_TIME}
          presentational
          user={user}
          variant="root"
        />
      </span>
    </span>
  );
};

/**
 * A reply as it is being written: the replied colophon's last annotation,
 * where it will appear once sent, led by 「回复 X：」. A tap brings the
 * keyboard back.
 */
export const ColophonDraftReply = ({
  source,
  user,
  replyTo,
  state,
  composerForm,
  onRefocus,
}: {
  readonly source: ColophonDraftSource;
  readonly user: CommentUserPresentation;
  readonly replyTo: string;
  readonly state: ColophonDraftState;
  readonly composerForm: HTMLFormElement | null;
  readonly onRefocus: () => void;
}) => {
  const sheetRef = useRef<HTMLLIElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  useColophonDraftBand(sheetRef, rootRef, composerForm);
  return (
    <ol
      aria-hidden="true"
      className={styles.replies}
      data-colophon-draft-replies=""
    >
      <li
        className={`${styles.reply} ${styles.draftReply}`}
        data-colophon-draft="reply"
        data-draft-state={state}
        onClick={onRefocus}
        ref={sheetRef}
      >
        <span className={styles.replyBody} ref={rootRef}>
          <DraftInk
            composerForm={composerForm}
            lead={<span className={styles.replyLead}>回复 {replyTo}：</span>}
            placeholder="在下方书写…"
            source={source}
          />
          <ColophonSignature
            createdAt={undefined}
            mark={<DraftMark source={source} state={state} />}
            now={NO_TIME}
            presentational
            user={user}
            variant="reply"
          />
        </span>
      </li>
    </ol>
  );
};
