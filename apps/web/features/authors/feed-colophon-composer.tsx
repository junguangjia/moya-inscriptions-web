"use client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FormEvent, RefObject } from "react";
import { flushSync } from "react-dom";
import type { MentionReference } from "@moya/contracts";
import { useAuthReturn } from "../auth/auth-return";
import type { CommentViewerState } from "../comments/comment-section";
import type { CommentReplyTarget } from "../comments/comment-types";
import cs from "../comments/comment-section.module.css";
import { MentionControl } from "../notifications/mention-control";
import { normalizeMentionText } from "../notifications/mention-data";
import { remapMentions } from "../notifications/mention-edits";
import type { ProductShellContextValue } from "../product-shell/product-shell";
import { resolvePrimaryNavigationViewportInset } from "../shell/primary-navigation-motion";
import {
  claimColophonComposer,
  releaseColophonComposer,
  useColophonComposerClaimed,
} from "./colophon-composer-claim";
import { useFeedStage } from "./feed-post-stage-context";
import c from "./feed-colophon-composer.module.css";

export const COLOPHON_COMPOSER_MAX_LENGTH = 1000;

/**
 * The feed's draft key for a post: kept apart from Detail's composer for the
 * same content, which can be mounted at the same time.
 */
export const colophonDraftKey = (contentKey: string): string =>
  contentKey.startsWith("feed:") ? contentKey : `feed:${contentKey}`;

interface SavedColophonDraft {
  readonly draft: string;
  readonly mentions: readonly MentionReference[];
  readonly replyTarget: CommentReplyTarget | null;
}

const targetIdentity = (target: CommentReplyTarget | null) =>
  target === null
    ? null
    : JSON.stringify([
        target.rootCommentId,
        target.replyId ?? null,
        target.user.id,
      ]);

export interface FeedColophonComposerProps {
  /** The post's `contentKey(target)`; the draft is kept under `feed:` + it. */
  readonly contentKey: string;
  /** The signed-in reader's id; null for a guest. */
  readonly actorId: string | null;
  readonly viewerState: CommentViewerState;
  readonly open: boolean;
  readonly replyTarget: CommentReplyTarget | null;
  readonly submitting: boolean;
  /**
   * Resolves true once accepted (published or awaiting approval); false keeps
   * the draft for another attempt.
   */
  readonly onSubmit: (
    text: string,
    mentions: readonly MentionReference[],
    target: CommentReplyTarget | null,
  ) => Promise<boolean>;
  /** Closes the bar: 取消, Escape in the box, or an accepted send. */
  readonly onCancel: () => void;
  readonly onReplyTargetChange: (target: CommentReplyTarget | null) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Every committed draft text: typing, a mention, the text restored after
   * sign-in, and the empty draft after an accepted send. The colophons
   * preview it vertically.
   */
  readonly onDraftChange?: ((draft: string) => void) | undefined;
  /** The form's id, for the preview's `aria-controls`. */
  readonly formId?: string | undefined;
}

/**
 * The colophons' horizontal composer, pinned above the bottom inset over the
 * dock while open. It stays mounted while closed (`data-open="false"` hides
 * it) so the draft survives and a tap can focus it after a synchronous open.
 */
export const FeedColophonComposer = ({
  contentKey,
  actorId,
  viewerState,
  open,
  replyTarget,
  submitting,
  onSubmit,
  onCancel,
  onReplyTargetChange,
  textareaRef,
  onDraftChange,
  formId,
}: FeedColophonComposerProps) => {
  const authReturn = useAuthReturn();
  const hintId = useId();
  const draftKey = colophonDraftKey(contentKey);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<readonly MentionReference[]>([]);
  const editorRevision = useRef(0);
  const mounted = useRef(true);
  const recovered = useRef(false);
  const editorScope = useRef<{ key: string; actor: string | null }>({
    key: draftKey,
    actor: actorId,
  });
  const latest = useRef({ replyTarget, onReplyTargetChange });
  latest.current = { replyTarget, onReplyTargetChange };
  const viewer = viewerState.state;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editorRevision.current += 1;
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
              SavedColophonDraft | undefined);
      setDraft(saved?.draft ?? "");
      setMentions(saved?.mentions ?? []);
      const target = saved?.replyTarget ?? null;
      if (targetIdentity(target) !== targetIdentity(latest.current.replyTarget))
        latest.current.onReplyTargetChange(target);
    }
    editorScope.current = { key: draftKey, actor: confirmedActor };
  }, [actorId, authReturn, draftKey, viewer]);

  useEffect(() => {
    const owner = editorScope.current.actor;
    if (owner !== null && viewer === "signed-in")
      authReturn?.remember(owner, draftKey, { draft, mentions, replyTarget });
  }, [authReturn, draft, draftKey, mentions, replyTarget, viewer]);

  // The vertical preview follows the committed text, wherever it came from.
  useLayoutEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  // The box grows with the text up to three whole lines (then scrolls), so
  // no second line shows cut in half under a one-line box.
  useLayoutEffect(() => {
    const box = textareaRef.current;
    if (!open || box === null) return;
    box.style.removeProperty("height");
    const style = getComputedStyle(box);
    const line =
      Number.parseFloat(style.lineHeight) ||
      1.4 * (Number.parseFloat(style.fontSize) || 16);
    const frame =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const padding =
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0);
    const needed = box.scrollHeight + frame;
    if (needed > box.offsetHeight + line / 2)
      box.style.height = `${Math.min(needed, 3 * line + padding + frame)}px`;
    // Writing at the end keeps the end in view once the box scrolls.
    if (box.selectionEnd === box.value.length) box.scrollTop = box.scrollHeight;
  }, [draft, open, textareaRef]);

  // A send still in flight must not clear a draft aimed somewhere else.
  const replyIdentity = targetIdentity(replyTarget);
  const shownIdentity = useRef(replyIdentity);
  useLayoutEffect(() => {
    if (shownIdentity.current === replyIdentity) return;
    shownIdentity.current = replyIdentity;
    editorRevision.current += 1;
  }, [replyIdentity]);

  // Above the keyboard the bar is already inside the visual viewport, so it
  // takes no second safe-area inset.
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!open || form === null) return undefined;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const synchronize = () => {
      frame = null;
      const inset =
        viewport == null
          ? 0
          : resolvePrimaryNavigationViewportInset(
              window.innerHeight,
              viewport.height,
              viewport.offsetTop,
            );
      if (inset > 1) form.style.setProperty("--colophon-safe-bottom", "0px");
      else form.style.removeProperty("--colophon-safe-bottom");
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(synchronize);
    };
    synchronize();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = normalizeMentionText(draft);
    if (text.length === 0 || submitting) return;
    const submittedRevision = editorRevision.current;
    const target = replyTarget;
    // A failed send keeps the text; nothing is shown as sent.
    void onSubmit(text, mentions, target).then(
      (accepted) => {
        if (
          !accepted ||
          !mounted.current ||
          editorRevision.current !== submittedRevision
        )
          return;
        editorRevision.current += 1;
        setDraft("");
        setMentions([]);
        onReplyTargetChange(null);
        onCancel();
      },
      () => undefined,
    );
  };

  const cancel = () => {
    if (replyTarget !== null) onReplyTargetChange(null);
    onCancel();
  };

  return (
    <form
      ref={formRef}
      className={`${cs.composer} ${c.bar}`}
      data-colophon-composer=""
      data-open={open ? "true" : "false"}
      id={formId}
      onSubmit={submit}
    >
      <span className={c.hint} id={hintId}>
        输入内容会在上方题跋中竖排预览
      </span>
      <div
        className={cs.replyMode}
        data-colophon-composer-head=""
        data-colophon-reply-mode={replyTarget === null ? undefined : ""}
      >
        {replyTarget === null ? (
          <span>写题跋</span>
        ) : (
          <span>
            回复 <b>{replyTarget.user.name}</b>
          </span>
        )}
        <button data-colophon-composer-cancel="" onClick={cancel} type="button">
          取消
        </button>
      </div>
      <div className={cs.composerInputRow}>
        <div className={cs.composerField}>
          <textarea
            ref={textareaRef}
            aria-describedby={hintId}
            aria-label="题跋内容"
            maxLength={COLOPHON_COMPOSER_MAX_LENGTH}
            onChange={(event) => {
              editorRevision.current += 1;
              const next = event.currentTarget.value;
              setMentions(remapMentions(draft, next, mentions));
              setDraft(next);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              cancel();
            }}
            placeholder={
              replyTarget === null
                ? "写题跋…"
                : `回复 ${replyTarget.user.name}…`
            }
            rows={1}
            value={draft}
          />
          <MentionControl
            inline
            maxLength={COLOPHON_COMPOSER_MAX_LENGTH}
            mentions={mentions}
            onChange={(text, refs) => {
              editorRevision.current += 1;
              setDraft(text);
              setMentions(refs);
              textareaRef.current?.focus();
            }}
            text={draft}
          />
        </div>
        <button
          className={cs.composerSend}
          data-colophon-composer-send=""
          disabled={draft.trim().length === 0 || submitting}
          type="submit"
        >
          {submitting ? "发送中…" : "发送"}
        </button>
      </div>
    </form>
  );
};

/** What of the shell decides which layer and destination the reader sees. */
export type ColophonComposerShell = Pick<
  ProductShellContextValue,
  | "activeDestination"
  | "activeContent"
  | "activeProfile"
  | "activeFeedViewer"
  | "activeEditor"
  | "activeTopicId"
  | "activeViewerMediaId"
  | "settingsOpen"
>;

/**
 * The shell's layers as one value: it changes when the primary destination
 * changes or a Detail, profile, viewer, topic, editor or settings layer opens
 * or closes, any of which takes the post off screen. Fields a partial shell
 * lacks count as closed.
 */
export const colophonComposerScene = (
  shell: Partial<ColophonComposerShell> | null | undefined,
): string =>
  JSON.stringify([
    shell?.activeDestination ?? null,
    shell?.activeContent?.type ?? null,
    shell?.activeContent?.id ?? null,
    shell?.activeProfile?.authorId ?? null,
    shell?.activeProfile?.entryId ?? null,
    shell?.activeProfile?.tab ?? null,
    shell?.activeFeedViewer?.target.type ?? null,
    shell?.activeFeedViewer?.target.id ?? null,
    shell?.activeEditor === null || shell?.activeEditor === undefined
      ? null
      : shell.activeEditor.type,
    shell?.activeTopicId ?? null,
    shell?.activeViewerMediaId ?? null,
    shell?.settingsOpen === true,
  ]);

/**
 * Whether the post is visibly on screen: a panel the Home pager slid away
 * rests edge to edge with the viewport, which still counts as intersecting,
 * so a zero-area intersection does not count.
 */
export const colophonPostVisible = (
  entry: Pick<IntersectionObserverEntry, "isIntersecting"> &
    Partial<Pick<IntersectionObserverEntry, "intersectionRect">>,
): boolean =>
  entry.isIntersecting &&
  (entry.intersectionRect === undefined ||
    (entry.intersectionRect.width >= 1 && entry.intersectionRect.height >= 1));

/** The least of the post that must show above the open bar to count. */
export const COLOPHON_POST_MIN_SHOWN_PX = 16;

/**
 * Whether enough of the post shows in the visual viewport above the open
 * composer bar, which is fixed over the bottom of the screen: a post the
 * reader scrolled behind the bar is no longer on screen. All values are
 * client coordinates; `barTop` is null while the bar has no box.
 */
export const colophonPostShownAboveBar = ({
  postTop,
  postBottom,
  viewportTop,
  viewportBottom,
  barTop,
  min = COLOPHON_POST_MIN_SHOWN_PX,
}: {
  readonly postTop: number;
  readonly postBottom: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly barTop: number | null;
  readonly min?: number;
}): boolean =>
  Math.min(postBottom, viewportBottom, barTop ?? Number.POSITIVE_INFINITY) -
    Math.max(postTop, viewportTop) >=
  min;

/** Whether a modal dialog that does not hold the post covers it. */
export const colophonPostCovered = (post: Element): boolean => {
  let modals: Element[];
  try {
    modals = [...post.ownerDocument.querySelectorAll("dialog:modal")];
  } catch {
    // No :modal support: an open dialog, which the shell's layers open modally.
    modals = [...post.ownerDocument.querySelectorAll("dialog[open]")];
  }
  return modals.some((dialog) => !dialog.contains(post));
};

export interface ColophonComposerControl {
  readonly open: boolean;
  readonly replyTarget: CommentReplyTarget | null;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Call inside the tap handler: claims the feed's one composer, renders it
   * open and focuses the box in the same gesture so iOS raises the keyboard.
   * A new colophon (null) continues an unsent reply instead, so its text is
   * not sent as a colophon. Focus returns to `opener` when the bar closes.
   */
  readonly openComposer: (
    target?: CommentReplyTarget | null,
    opener?: HTMLElement,
  ) => void;
  /** Closes the bar (取消, Escape, a send); the draft stays. */
  readonly close: () => void;
  readonly setReplyTarget: (target: CommentReplyTarget | null) => void;
}

/** Inset from the viewport's edges within which the post counts as shown. */
const VISIBLE_MARGIN = "-1px";

/**
 * Open state for one post's composer. It closes when another post claims
 * the composer, when this post's viewer opens, and when the post leaves the
 * screen: the observed element (the post's article as the colophon passes
 * it; the stage strip by default) is no longer visibly in the viewport, the
 * Home tab holding it is no longer the shown one (its panel turns inert),
 * the shell's `scene` changes (another destination, or a layer over the
 * feed), or the page is hidden. Leaving keeps the draft and moves focus
 * nowhere: the opener is off screen.
 */
export const useColophonComposer = (
  contentKey: string,
  options: {
    readonly observe?: Element | null;
    /** Where focus goes when the opener is gone. */
    readonly fallbackFocus?: () => HTMLElement | null;
    /** The shell's layers (`colophonComposerScene`); a change closes it. */
    readonly scene?: string;
  } = {},
): ColophonComposerControl => {
  const instance = useId();
  const claimKey = `${colophonDraftKey(contentKey)}#${instance}`;
  const stage = useFeedStage();
  const observed = options.observe ?? stage?.strip ?? null;
  const viewerOpen = stage?.viewerOpen === true;
  const scene = options.scene ?? "";
  const claimed = useColophonComposerClaimed(claimKey);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<CommentReplyTarget | null>(
    null,
  );

  const openerRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(options.fallbackFocus);
  fallbackRef.current = options.fallbackFocus;

  // Focus in the hidden bar would fall to the page: it goes back to where
  // the composer was opened. `dropped` also covers focus the bar already
  // lost (a disabled send button) when the reader closed it.
  const hide = useCallback(
    (dropped: boolean) => {
      const form = textareaRef.current?.form ?? null;
      const active = document.activeElement;
      const restore =
        (form !== null && active !== null && form.contains(active)) ||
        (dropped && (active === null || active === document.body));
      setOpen(false);
      releaseColophonComposer(claimKey);
      if (!restore) return;
      const opener = openerRef.current?.isConnected
        ? openerRef.current
        : (fallbackRef.current?.() ?? null);
      opener?.focus({ preventScroll: true });
    },
    [claimKey],
  );
  const close = useCallback(() => hide(true), [hide]);
  const dismiss = useCallback(() => hide(false), [hide]);
  // The post left the screen: the box lets go of focus (and the keyboard)
  // without handing it to an opener that is no longer shown.
  const leave = useCallback(() => {
    const form = textareaRef.current?.form ?? null;
    const active = document.activeElement;
    setOpen(false);
    releaseColophonComposer(claimKey);
    if (form !== null && active instanceof HTMLElement && form.contains(active))
      active.blur();
  }, [claimKey]);

  // A modal layer over the post hands focus back, as it closes, to where it
  // was taken from; the box is closed by then and it falls to the page: the
  // opener, still on screen, takes it instead.
  const uncoverRef = useRef<(() => void) | null>(null);
  const returnFocusOnUncover = useCallback((post: Element) => {
    uncoverRef.current?.();
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      if (colophonPostCovered(post)) return;
      stop();
      const active = document.activeElement;
      const opener = openerRef.current;
      if (
        (active === null || active === document.body) &&
        opener?.isConnected === true &&
        opener.closest("[inert]") === null
      )
        opener.focus({ preventScroll: true });
    });
    const stop = () => {
      observer.disconnect();
      uncoverRef.current = null;
    };
    observer.observe(post.ownerDocument.body, {
      attributeFilter: ["open"],
      childList: true,
      subtree: true,
    });
    uncoverRef.current = stop;
  }, []);

  const openComposer = useCallback(
    (target: CommentReplyTarget | null = null, opener?: HTMLElement) => {
      uncoverRef.current?.();
      claimColophonComposer(claimKey);
      openerRef.current = opener ?? null;
      const unsent = (textareaRef.current?.value ?? "").trim() !== "";
      // Preserve Safari's user activation through the box's first focus.
      flushSync(() => {
        setOpen(true);
        setReplyTarget((current) =>
          target === null && unsent ? current : target,
        );
      });
      textareaRef.current?.focus({ preventScroll: true });
    },
    [claimKey],
  );

  useEffect(() => {
    if (open && (!claimed || viewerOpen)) dismiss();
  }, [claimed, dismiss, open, viewerOpen]);

  // The scene the composer was opened in; any other one is somewhere else.
  const openScene = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      openScene.current = null;
      return;
    }
    if (openScene.current === null) openScene.current = scene;
    else if (openScene.current !== scene) leave();
  }, [leave, open, scene]);

  useEffect(() => {
    if (
      !open ||
      observed === null ||
      typeof IntersectionObserver !== "function"
    )
      return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => !colophonPostVisible(entry))) leave();
      },
      { rootMargin: VISIBLE_MARGIN, threshold: 0 },
    );
    observer.observe(observed);
    return () => observer.disconnect();
  }, [leave, observed, open]);

  // The viewport counts only above the bar itself: scrolled behind it, the
  // post has left the screen too. Only a scroll closes it, and only once the
  // post has shown above the bar where the bar is now: the bar rising with
  // the keyboard (or growing) over a post low on the screen, and the scroll
  // that then brings the post back above it, never close what a tap opened.
  useEffect(() => {
    if (!open || observed === null) return undefined;
    let shown = false;
    let shownBarTop: number | null = null;
    let frame: number | null = null;
    let closing = false;
    const check = () => {
      frame = null;
      const form = textareaRef.current?.form ?? null;
      const bar = form?.getBoundingClientRect();
      const barTop = bar === undefined || bar.height <= 0 ? null : bar.top;
      if (
        barTop === null ||
        shownBarTop === null ||
        Math.abs(barTop - shownBarTop) > 1
      )
        shown = false;
      shownBarTop = barTop;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const post = observed.getBoundingClientRect();
      const visible = colophonPostShownAboveBar({
        postTop: post.top,
        postBottom: post.bottom,
        viewportTop,
        viewportBottom:
          viewport == null ? window.innerHeight : viewportTop + viewport.height,
        barTop,
      });
      if (visible) shown = true;
      else if (closing && shown) leave();
      closing = false;
    };
    const schedule = (scrolled: boolean) => {
      closing ||= scrolled;
      if (frame === null) frame = window.requestAnimationFrame(check);
    };
    const scrolled = () => schedule(true);
    const moved = () => schedule(false);
    check();
    const viewport = window.visualViewport;
    const form = textareaRef.current?.form ?? null;
    const observer =
      form !== null && typeof ResizeObserver === "function"
        ? new ResizeObserver(moved)
        : null;
    if (form !== null) observer?.observe(form);
    viewport?.addEventListener("resize", moved);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", scrolled, {
      capture: true,
      passive: true,
    });
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("resize", moved);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", scrolled, { capture: true });
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [leave, observed, open]);

  // A pager panel that is no longer shown turns inert at once, before any
  // slide has carried it out of view; a modal layer the shell does not
  // track (消息) covers the post and makes it inert without the attribute.
  useEffect(() => {
    if (!open || observed === null || typeof MutationObserver !== "function")
      return undefined;
    const check = () => {
      if (observed.closest("[inert]") !== null) leave();
      else if (colophonPostCovered(observed)) {
        // showModal has already taken focus from the box by now.
        leave();
        returnFocusOnUncover(observed);
      }
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      attributeFilter: ["inert", "open"],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [leave, observed, open, returnFocusOnUncover]);

  useEffect(() => {
    if (!open) return undefined;
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
    };
  }, [leave, open]);

  useEffect(() => () => releaseColophonComposer(claimKey), [claimKey]);
  useEffect(() => () => uncoverRef.current?.(), []);

  return {
    open,
    replyTarget,
    textareaRef,
    openComposer,
    close,
    setReplyTarget,
  };
};
