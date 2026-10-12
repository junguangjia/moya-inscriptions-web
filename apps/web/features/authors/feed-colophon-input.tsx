"use client";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FormEvent, MouseEvent } from "react";
import { useAuthReturn } from "../auth/auth-return";
import type { CommentViewerState } from "../comments/comment-section";
import type { CommentReplyTarget } from "../comments/comment-types";
import { normalizeMentionText } from "../notifications/mention-data";
import styles from "./feed-colophon-input.module.css";

export const COLOPHON_INPUT_MAX_LENGTH = 1000;
/** The widest the input grows over the colophons, as a share of the stage. */
export const COLOPHON_INPUT_MAX_SHARE = 0.6;
/**
 * The reply lead names its target in at most this many characters (code
 * points); a longer name is cut with …, so the lead never takes the text's
 * room (display names run to 40 characters).
 */
export const COLOPHON_INPUT_LEAD_NAME_CHARS = 6;
/** The least height the column keeps above the keyboard. */
export const COLOPHON_INPUT_MIN_HEIGHT = 160;
/**
 * How long the column stays open after the text loses focus: a tap on 发送
 * that blurs the text first still lands on 发送 where it was.
 */
export const COLOPHON_INPUT_BLUR_MS = 250;

/**
 * The feed's draft key for a post: kept apart from Detail's composer for the
 * same content, which can be mounted at the same time.
 */
export const colophonDraftKey = (contentKey: string): string =>
  contentKey.startsWith("feed:") ? contentKey : `feed:${contentKey}`;

/** A reply target's name as the lead shows it: cut short when long. */
export const colophonLeadName = (name: string): string => {
  const characters = [...name.trim()];
  return characters.length > COLOPHON_INPUT_LEAD_NAME_CHARS
    ? `${characters.slice(0, COLOPHON_INPUT_LEAD_NAME_CHARS - 1).join("")}…`
    : characters.join("");
};

/**
 * The input's width for text that needs `content` pixels: never narrower
 * than the idle column, never wider than its share of the stage less the
 * `reserved` pixels beside it (the reply lead's column). Past that the text
 * scrolls inside it, and the width holds whole columns of `column` pixels
 * within its `padding`, so the newest columns show whole.
 */
export const colophonInputWidth = (
  content: number,
  idle: number,
  stage: number,
  column = 0,
  padding = 0,
  reserved = 0,
): number => {
  const cap = Math.round(stage * COLOPHON_INPUT_MAX_SHARE) - reserved;
  if (content <= cap) return Math.max(idle, content);
  const whole =
    column > 0 ? padding + Math.floor((cap - padding) / column) * column : cap;
  return Math.max(idle, whole);
};

/**
 * Marks which ends of a scrolled input hide text (vertical-rl scrolling).
 * Idle, the input shows only its first column: `data-cut` marks a draft
 * that runs on past it.
 */
const markHiddenText = (box: HTMLTextAreaElement, focused: boolean) => {
  const overflow = box.scrollWidth - box.clientWidth;
  // The start is at the right (scrollLeft 0), the end at the left.
  box.toggleAttribute(
    "data-more-before",
    focused && overflow > 1 && box.scrollLeft < -1,
  );
  box.toggleAttribute(
    "data-more-after",
    focused && overflow > 1 && box.scrollLeft > -overflow + 1,
  );
  box.toggleAttribute("data-cut", !focused && overflow > 1);
};

/** The width of the fade marking hidden text (`--colophon-input-fade`). */
const fadeWidth = (box: HTMLTextAreaElement): number =>
  Number.parseFloat(
    getComputedStyle(box).getPropertyValue("--colophon-input-fade"),
  ) || 0;

/**
 * The column's height while the visible area ends above the stage's foot
 * (the keyboard is up): it then ends at the visible bottom, keeping at least
 * `min`; null while the whole stage height is visible. Client coordinates.
 */
export const colophonInputFitHeight = ({
  frameTop,
  frameHeight,
  visibleBottom,
  min = COLOPHON_INPUT_MIN_HEIGHT,
}: {
  readonly frameTop: number;
  readonly frameHeight: number;
  readonly visibleBottom: number;
  readonly min?: number;
}): number | null => {
  if (visibleBottom >= frameTop + frameHeight - 1) return null;
  return Math.round(
    Math.min(frameHeight, Math.max(min, visibleBottom - frameTop)),
  );
};

/** The nearest ancestor that scrolls vertically, else the document's. */
const verticalScroller = (node: Element): Element | null => {
  for (
    let parent = node.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    if (
      parent.scrollHeight > parent.clientHeight + 1 &&
      /auto|scroll/u.test(getComputedStyle(parent).overflowY)
    )
      return parent;
  }
  return node.ownerDocument.scrollingElement;
};

/**
 * Brings the stage's top to the top of what scrolls the feed, under the
 * page header, so the column has the most room above the keyboard.
 */
const revealStageTop = (strip: Element) => {
  const scroller = verticalScroller(strip);
  if (scroller === null) return;
  const documentScroller = scroller === strip.ownerDocument.scrollingElement;
  const top = documentScroller ? 0 : scroller.getBoundingClientRect().top;
  const delta = strip.getBoundingClientRect().top - top;
  if (Math.abs(delta) > 1) scroller.scrollTop += delta;
};

/** Styles a hidden copy of the input needs to wrap its text the same way. */
const MIRRORED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "lineBreak",
  "overflowWrap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "textOrientation",
  "wordBreak",
  "writingMode",
] as const;

/**
 * How far the caret's column ends from the start (right) of the input's
 * scrolled content: the width of a hidden copy of the text up to the caret,
 * wrapped as the input wraps it.
 */
const caretReach = (box: HTMLTextAreaElement): number => {
  const style = getComputedStyle(box);
  const mirror = box.ownerDocument.createElement("div");
  for (const property of MIRRORED) mirror.style[property] = style[property];
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-100000px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.height = `${box.clientHeight}px`;
  // A trailing character keeps a final line break's empty column.
  mirror.textContent = `${box.value.slice(0, box.selectionEnd)}\u200b`;
  box.ownerDocument.body.append(mirror);
  const reach =
    mirror.scrollWidth - (Number.parseFloat(style.paddingLeft) || 0);
  mirror.remove();
  return reach;
};

/**
 * Scrolls the input so the caret's column shows: at the end, the newest
 * (left-most) column; elsewhere, as little as brings the caret's in, clear
 * of the fade that marks hidden text.
 */
const revealCaret = (box: HTMLTextAreaElement) => {
  const overflow = box.scrollWidth - box.clientWidth;
  if (overflow <= 1) return;
  if (box.selectionEnd === box.value.length) {
    box.scrollLeft = -overflow;
    return;
  }
  const style = getComputedStyle(box);
  const column = Number.parseFloat(style.lineHeight) || 0;
  const fade = fadeWidth(box);
  const reach = caretReach(box);
  // Shown: from -scrollLeft to -scrollLeft + clientWidth, from the right.
  const shown = -box.scrollLeft;
  if (reach > shown + box.clientWidth - fade)
    box.scrollLeft = -Math.min(overflow, reach - box.clientWidth + fade);
  else if (reach - column < shown + fade)
    box.scrollLeft = -Math.max(0, reach - column - fade);
};

/**
 * Where the visible area ends: the visual viewport's bottom, above the
 * keyboard. The dock is put away while the input is written in (see the
 * stylesheet), so it takes none of that room.
 */
const visibleBottom = (document: Document): number => {
  const viewport = document.defaultView?.visualViewport;
  return viewport == null
    ? (document.defaultView?.innerHeight ?? 0)
    : viewport.offsetTop + viewport.height;
};

interface SavedColophonDraft {
  readonly draft: string;
  readonly replyTarget: CommentReplyTarget | null;
}

export interface FeedColophonInputHandle {
  /**
   * Aims the text at `target` and focuses the input: call it inside the tap,
   * so iOS raises the keyboard.
   */
  readonly reply: (target: CommentReplyTarget) => void;
}

export interface FeedColophonInputProps {
  /** The post's `contentKey(target)`; the draft is kept under `feed:` + it. */
  readonly contentKey: string;
  /** The signed-in reader's id; null for a guest. */
  readonly actorId: string | null;
  readonly viewerState: CommentViewerState;
  /** The thread takes no new colophons; `closedNote` says why, if anything. */
  readonly closed: boolean;
  readonly closedNote: string | null;
  /** The discussion is not open here at all. */
  readonly unavailable: boolean;
  readonly submitting: boolean;
  /**
   * Resolves true once accepted (published or awaiting approval); false keeps
   * the text for another attempt.
   */
  readonly onSubmit: (
    text: string,
    target: CommentReplyTarget | null,
  ) => Promise<boolean>;
  /** The status after an action (已发送, a failure), empty for none. */
  readonly notice: string;
  /** The stage shows the colophons; otherwise the column is hidden. */
  readonly shown: boolean;
  /** The stage strip the column is held at the left edge of. */
  readonly strip: HTMLElement;
  /**
   * Told whenever the input is being written in or not, and what it
   * answers: the colophons recede while it is, all but the one answered.
   */
  readonly onWritingChange?: (
    writing: boolean,
    target: CommentReplyTarget | null,
  ) => void;
}

/**
 * The colophons' input: a vertical column held at the stage's left edge
 * while the colophons are shown (the colophons place its anchor first in
 * the strip, sticky, so a swipe that starts on it still moves the strip).
 * The text is written vertically in it, the column widening over the
 * colophons as it grows, up to a share of the stage, and then scrolling so
 * the newest column stays in view. 发送 sits at its foot; a reply is led by
 * 「回复 X：」 in a column of its own on the right, the name cut short when
 * long, so the text keeps the column's full height. A guest is offered
 * sign-in instead,
 * and a closed thread says why, if it says anything. The draft stays while
 * the reader is elsewhere and comes back after sign-in.
 */
export const FeedColophonInput = forwardRef<
  FeedColophonInputHandle,
  FeedColophonInputProps
>(function FeedColophonInput(
  {
    contentKey,
    actorId,
    viewerState,
    closed,
    closedNote,
    unavailable,
    submitting,
    onSubmit,
    notice,
    shown,
    strip,
    onWritingChange,
  },
  ref,
) {
  const authReturn = useAuthReturn();
  const draftKey = colophonDraftKey(contentKey);
  const formRef = useRef<HTMLFormElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<CommentReplyTarget | null>(
    null,
  );
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<number | null>(null);
  const [fitHeight, setFitHeight] = useState<number | null>(null);
  // Bumped by every edit, so a send in flight never clears newer text.
  const editorRevision = useRef(0);
  const mounted = useRef(true);
  const recovered = useRef(false);
  const editorScope = useRef<{ key: string; actor: string | null }>({
    key: draftKey,
    actor: actorId,
  });
  const viewer = viewerState.state;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editorRevision.current += 1;
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    };
  }, []);

  // Same rules as Detail's composer: a new post or reader starts a new draft,
  // and a reader confirmed after sign-in gets back what they had written.
  useLayoutEffect(() => {
    const confirmedActor =
      viewer === "checking" || viewer === "unavailable"
        ? editorScope.current.actor
        : viewer === "signed-out"
          ? null
          : actorId;
    if (
      editorScope.current.key !== draftKey ||
      editorScope.current.actor !== confirmedActor ||
      (!recovered.current && confirmedActor !== null && viewer === "signed-in")
    ) {
      editorRevision.current += 1;
      if (confirmedActor !== null) recovered.current = true;
      const saved =
        confirmedActor === null
          ? undefined
          : (authReturn?.take(confirmedActor, draftKey) as
              Partial<SavedColophonDraft> | undefined);
      setDraft(typeof saved?.draft === "string" ? saved.draft : "");
      setReplyTarget(saved?.replyTarget ?? null);
    }
    editorScope.current = { key: draftKey, actor: confirmedActor };
  }, [actorId, authReturn, draftKey, viewer]);

  useEffect(() => {
    const owner = editorScope.current.actor;
    if (owner !== null && viewer === "signed-in")
      authReturn?.remember(owner, draftKey, {
        draft,
        replyTarget,
      } satisfies SavedColophonDraft);
  }, [authReturn, draft, draftKey, replyTarget, viewer]);

  // The input widens with its text, up to its share of the stage; writing
  // at the end keeps the newest (left-most) column in view.
  const [stageWidth, setStageWidth] = useState(() => strip.clientWidth);
  useEffect(() => {
    setStageWidth(strip.clientWidth);
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => setStageWidth(strip.clientWidth));
    observer.observe(strip);
    return () => observer.disconnect();
  }, [strip]);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const form = formRef.current;
    if (box === null || form === null || !shown) return undefined;
    box.style.removeProperty("width");
    const idle = box.offsetWidth;
    const lead = leadRef.current?.offsetWidth ?? 0;
    const style = getComputedStyle(box);
    // Not being written, the column keeps to its idle width and shows the
    // draft's start, so the colophons stay readable around it.
    const width = focused
      ? colophonInputWidth(
          box.scrollWidth,
          idle,
          stageWidth,
          Number.parseFloat(style.lineHeight) || 0,
          (Number.parseFloat(style.paddingLeft) || 0) +
            (Number.parseFloat(style.paddingRight) || 0),
          lead,
        )
      : idle;
    if (width !== idle) box.style.width = `${width}px`;
    // The column's own width is set outright: WebKit keeps an absolutely
    // placed column's shrink-to-fit width when only the text in it widens.
    const frame = getComputedStyle(form);
    const chrome = [
      frame.borderLeftWidth,
      frame.borderRightWidth,
      frame.paddingLeft,
      frame.paddingRight,
    ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    form.style.width = `${width + lead + chrome}px`;
    if (focused) {
      revealCaret(box);
      markHiddenText(box, true);
    } else {
      box.scrollLeft = 0;
      markHiddenText(box, false);
    }
    return () => {
      form.style.removeProperty("width");
    };
    // What the column offers (`viewer`, `closed`, `unavailable`) decides
    // whether there is a text at all.
  }, [
    closed,
    draft,
    fitHeight,
    focused,
    replyTarget,
    shown,
    stageWidth,
    unavailable,
    viewer,
  ]);

  useEffect(() => {
    onWritingChange?.(focused && shown, replyTarget);
  }, [focused, onWritingChange, replyTarget, shown]);

  // While the input has focus the column ends where the visible area does,
  // so the keyboard never covers 发送 or the line being written.
  useEffect(() => {
    if (!focused) {
      setFitHeight(null);
      return undefined;
    }
    const viewport = window.visualViewport;
    let frameId: number | null = null;
    const fit = () => {
      frameId = null;
      const rect = strip.getBoundingClientRect();
      setFitHeight(
        colophonInputFitHeight({
          frameTop: rect.top,
          frameHeight: rect.height,
          visibleBottom: visibleBottom(strip.ownerDocument),
        }),
      );
    };
    const schedule = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(fit);
    };
    fit();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The feed scrolling under the keyboard moves the stage's top.
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [focused, strip]);

  // Back on the images, the hidden column lets go of focus (and the
  // keyboard); the draft stays.
  useEffect(() => {
    if (shown) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && formRef.current?.contains(active))
      active.blur();
  }, [shown]);

  const focusAtEnd = useCallback(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.focus({ preventScroll: true });
    const end = box.value.length;
    box.setSelectionRange(end, end);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reply: (target) => {
        setReplyTarget(target);
        focusAtEnd();
      },
    }),
    [focusAtEnd],
  );

  // Tapping 发送 or the reply's × leaves the text focused: the column
  // neither narrows under the finger nor drops the keyboard.
  const keepFocus = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = normalizeMentionText(draft);
    if (text.length === 0 || submitting) return;
    const submittedRevision = editorRevision.current;
    // A failed send keeps the text; nothing is shown as sent.
    void onSubmit(text, replyTarget).then(
      (accepted) => {
        if (
          !accepted ||
          !mounted.current ||
          editorRevision.current !== submittedRevision
        )
          return;
        editorRevision.current += 1;
        setDraft("");
        setReplyTarget(null);
        // The keyboard goes down, so the colophon brought in shows.
        const active = document.activeElement;
        if (active instanceof HTMLElement && formRef.current?.contains(active))
          active.blur();
      },
      () => undefined,
    );
  };

  const status = (
    <p
      className={styles.status}
      data-colophon-notice=""
      key="status"
      role="status"
    >
      {notice}
    </p>
  );

  const state = unavailable
    ? "none"
    : closed
      ? closedNote === null
        ? "none"
        : "closed"
      : viewer === "signed-in"
        ? "write"
        : viewer === "signed-out"
          ? "guest"
          : viewer === "unavailable"
            ? "unknown"
            : "none";

  return (
    <form
      ref={formRef}
      className={styles.column}
      data-colophon-input={state}
      data-colophon-input-focused={focused ? "" : undefined}
      data-colophon-input-shown={shown ? "" : undefined}
      inert={!shown || undefined}
      noValidate
      onSubmit={submit}
      style={
        fitHeight === null
          ? undefined
          : { bottom: "auto", height: `${fitHeight}px` }
      }
    >
      {state === "write" ? (
        <>
          <div className={styles.field}>
            {replyTarget === null ? null : (
              <p
                className={styles.lead}
                data-colophon-input-reply=""
                ref={leadRef}
              >
                <span className={styles.leadText}>
                  回复 <b>{colophonLeadName(replyTarget.user.name)}</b>：
                </span>
                <button
                  aria-label={`不再回复${replyTarget.user.name}`}
                  className={styles.unreply}
                  data-colophon-input-unreply=""
                  onMouseDown={keepFocus}
                  onClick={() => {
                    setReplyTarget(null);
                    focusAtEnd();
                  }}
                  type="button"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </p>
            )}
            <textarea
              ref={boxRef}
              aria-label={
                replyTarget === null ? "写题跋" : `回复${replyTarget.user.name}`
              }
              autoCapitalize="off"
              autoComplete="off"
              className={styles.box}
              data-colophon-input-box=""
              enterKeyHint="enter"
              maxLength={COLOPHON_INPUT_MAX_LENGTH}
              onBlur={() => {
                if (blurTimer.current !== null)
                  window.clearTimeout(blurTimer.current);
                blurTimer.current = window.setTimeout(() => {
                  blurTimer.current = null;
                  if (document.activeElement !== boxRef.current)
                    setFocused(false);
                }, COLOPHON_INPUT_BLUR_MS);
              }}
              onChange={(event) => {
                editorRevision.current += 1;
                setDraft(event.currentTarget.value);
              }}
              onFocus={() => {
                if (blurTimer.current !== null) {
                  window.clearTimeout(blurTimer.current);
                  blurTimer.current = null;
                }
                setFocused(true);
                revealStageTop(strip);
              }}
              onScroll={(event) =>
                markHiddenText(
                  event.currentTarget,
                  document.activeElement === event.currentTarget,
                )
              }
              onKeyDown={(event) => {
                // An Escape that ends an IME composition is the IME's.
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                event.preventDefault();
                if (replyTarget !== null) setReplyTarget(null);
                else event.currentTarget.blur();
              }}
              placeholder="写题跋…"
              rows={1}
              spellCheck={false}
              value={draft}
            />
          </div>
          {status}
          <button
            className={styles.send}
            data-colophon-input-send=""
            onMouseDown={keepFocus}
            disabled={draft.trim().length === 0 || submitting}
            type="submit"
          >
            {submitting ? "发送中" : "发送"}
          </button>
        </>
      ) : (
        <>
          {state === "guest" && viewerState.state === "signed-out" ? (
            <a
              className={styles.signIn}
              data-colophon-sign-in=""
              href={viewerState.signInHref}
            >
              登录后题跋
            </a>
          ) : state === "closed" ? (
            <p className={styles.note} data-colophon-closed="">
              {closedNote}
            </p>
          ) : state === "unknown" ? (
            <p className={styles.note} data-colophon-viewer-unavailable="">
              暂时无法确认登录状态
            </p>
          ) : null}
          {status}
        </>
      )}
    </form>
  );
});
