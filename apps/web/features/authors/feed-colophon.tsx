"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DiscussionTarget } from "@moya/contracts";
import { useAuthEntry } from "../auth/auth-return";
import type {
  CommentItem,
  CommentReplyTarget,
} from "../comments/comment-types";
import { useProductShell } from "../product-shell/product-shell";
import { contentKey, useAuthors } from "./author-context";
import {
  ColophonDraftReply,
  ColophonDraftSheet,
  ColophonInvite,
  createColophonDraftSource,
  useColophonDraftKept,
} from "./feed-colophon-draft";
import type {
  ColophonDraftSource,
  ColophonDraftState,
} from "./feed-colophon-draft";
import { ColophonEntry } from "./feed-colophon-entry";
import type { ColophonInteractions } from "./feed-colophon-entry";
import {
  colophonComposerScene,
  FeedColophonComposer,
  useColophonComposer,
} from "./feed-colophon-composer";
import { useFeedStage } from "./feed-post-stage-context";
import type { FeedStageApi, FeedStageSettle } from "./feed-post-stage-context";
import { elementStartOffset } from "./feed-post-strip-geometry";
import { useDiscussionThread } from "./use-discussion-thread";
import type { DiscussionThread } from "./use-discussion-thread";
import { colophonClipboardText, VerticalDigits } from "./vertical-text";
import styles from "./feed-colophon.module.css";

/**
 * Where the post renders its colophon composer (and the status after an
 * action): outside the stage strip, so neither is inert while the images are
 * shown, and outside the Home pager's transformed track, so both are fixed
 * to the viewport above the dock.
 */
export const FeedColophonOutletContext = createContext<HTMLElement | null>(
  null,
);

export interface FeedColophonProps {
  readonly target: DiscussionTarget;
  /** The post's label, naming the region. */
  readonly title: string;
  /** The count shown before the discussion is read (the feed's own). */
  readonly fallbackCount?: number | null | undefined;
}

const NOTICE_MS = 4000;
const HIGHLIGHT_MS = 1800;
// The discussion client's reply page size.
const REPLY_PAGE_SIZE = 10;
// The first read starts as soon as the last image comes in, so the first
// page is usually there before the reader swipes past it. A single-image
// post starts on its last image, so it waits for half a swipe instead:
// nothing is read while the feed loads.
const APPROACH_MARGIN = "0px 0px 0px 95%";
const APPROACH_MARGIN_SINGLE = "0px 0px 0px -50%";
// Next pages load while the end is within a stage width.
const END_MARGIN = "0px 100% 0px 100%";

const deleteQuestion = "删除正文？其他人的回复将保留。";

/** Changes when rows are added, removed, reordered or their replies change. */
const layoutSignature = (
  hot: readonly CommentItem[],
  items: readonly CommentItem[],
) =>
  [...hot, ".", ...items]
    .map((row) =>
      typeof row === "string"
        ? row
        : `${row.id}:${row.replies.map((reply) => reply.id).join(",")}`,
    )
    .join("|");

const findAnchor = (root: Element | null, id: string) => {
  if (root === null) return null;
  for (const node of root.querySelectorAll<HTMLElement>(
    "[data-colophon-anchor]",
  ))
    if (node.dataset.colophonAnchor === id) return node;
  return null;
};

// The head is a reading position too (the colophons' start), and so is the
// end column while a draft sheet fills it, under ids no comment can have.
const HEAD_ANCHOR = "\u0000head";
const END_ANCHOR = "\u0000end";
const READING_POSITIONS =
  "[data-colophon-head],[data-colophon-anchor],[data-colophon-end][data-colophon-drafting]";
const readingPositionId = (node: HTMLElement) =>
  node.dataset.colophonAnchor ??
  (node.matches("[data-colophon-end]") ? END_ANCHOR : HEAD_ANCHOR);
const findReadingPosition = (root: Element | null, id: string) =>
  id === HEAD_ANCHOR
    ? (root?.querySelector<HTMLElement>("[data-colophon-head]") ?? null)
    : id === END_ANCHOR
      ? (root?.querySelector<HTMLElement>("[data-colophon-end]") ?? null)
      : findAnchor(root, id);

/** Where the draft being written is previewed, if anywhere. */
type DraftAt =
  | null
  | "head"
  | "end"
  | {
      readonly reply: CommentReplyTarget;
      readonly rootId: string;
      readonly list: "hot" | "latest";
    };

/** What the colophons show; held while the strip is moving. */
interface ShownThread {
  readonly hot: DiscussionThread["hot"];
  readonly items: DiscussionThread["items"];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly page: number;
  readonly hasMore: boolean;
  readonly readError: string | null;
  readonly unavailable: boolean;
  readonly visibleTotal: number;
}

const shownOf = (thread: DiscussionThread): ShownThread => ({
  hot: thread.hot,
  items: thread.items,
  loading: thread.loading,
  busy: thread.busy,
  page: thread.page,
  hasMore: thread.hasMore,
  readError: thread.readError,
  unavailable: thread.unavailable,
  visibleTotal: thread.visibleTotal,
});

const sameShown = (a: ShownThread, b: ShownThread) =>
  (Object.keys(a) as (keyof ShownThread)[]).every((key) => a[key] === b[key]);

/**
 * The write entry. In the head, the invite slip: a dashed column that says
 * one can write here (signed in, with the reader's own avatar), invites a
 * guest to sign in, or says why there is none; while a new colophon is being
 * written there, the same button is its draft sheet. In the end column, the
 * small 写题跋 or 登录后题跋 pill, which turns into the sheet the same way.
 */
const WriteEntry = ({
  thread,
  placement,
  draft,
  source,
  empty = false,
  cue = false,
  onCueEnd,
  open,
  replying = false,
  formId,
  onWrite,
}: {
  readonly thread: DiscussionThread;
  readonly placement: "head" | "end";
  /** The draft sheet, while a new colophon is written here. */
  readonly draft?: ReactNode;
  readonly source: ColophonDraftSource;
  /** The thread has no colophon yet. */
  readonly empty?: boolean;
  /** Inks the slip once, the first time the reader comes to the colophons. */
  readonly cue?: boolean;
  readonly onCueEnd?: () => void;
  readonly open: boolean;
  /** The kept draft is a reply, which the slip continues as such. */
  readonly replying?: boolean;
  readonly formId: string;
  readonly onWrite: (opener: HTMLElement) => void;
}) => {
  const kept = useColophonDraftKept(source);
  const head = placement === "head";
  if (thread.unavailable) return null;
  if (thread.composerClosed)
    return head && thread.closedNote !== null ? (
      <p
        className={styles.invite}
        data-colophon-closed=""
        data-colophon-invite="closed"
      >
        {thread.closedNote}
      </p>
    ) : null;
  const viewer = thread.viewerState;
  if (viewer.state === "signed-in") {
    const prompt =
      kept && replying
        ? "续写回复"
        : kept && !open
          ? "续写题跋"
          : empty
            ? "写第一则题跋"
            : "在此写题跋";
    return (
      <button
        aria-controls={formId}
        aria-expanded={open}
        // The slip's visible prompt names it; the sheet's ink is hidden.
        aria-label={draft === undefined && head ? undefined : "写题跋"}
        className={
          draft === undefined
            ? head
              ? styles.invite
              : styles.write
            : styles.sheet
        }
        data-colophon-invite={head ? "signed-in" : undefined}
        data-colophon-invite-cue={
          head && cue && draft === undefined ? "" : undefined
        }
        data-colophon-write=""
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) onCueEnd?.();
        }}
        onClick={(event) => onWrite(event.currentTarget)}
        type="button"
      >
        {draft ??
          (head ? (
            <ColophonInvite prompt={prompt} user={thread.currentUser} />
          ) : // The end pill names a kept draft too, so tapping it never surprises.
          kept && (replying || !open) ? (
            prompt
          ) : (
            "写题跋"
          ))}
      </button>
    );
  }
  if (viewer.state === "signed-out")
    return (
      <a
        className={head ? styles.invite : styles.write}
        data-colophon-invite={head ? "signed-out" : undefined}
        data-colophon-invite-cue={head && cue ? "" : undefined}
        data-colophon-sign-in=""
        href={viewer.signInHref}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) onCueEnd?.();
        }}
      >
        {head ? (
          <ColophonInvite prompt="登录后题跋" user={null} />
        ) : (
          "登录后题跋"
        )}
      </a>
    );
  if (!head) return null;
  if (viewer.state === "unavailable")
    return (
      <p
        className={styles.invite}
        data-colophon-invite="unavailable"
        data-colophon-viewer-unavailable=""
      >
        暂时无法确认登录状态
      </p>
    );
  // Its frame keeps the slip's place while the session is confirmed.
  return (
    <span
      aria-hidden="true"
      className={styles.invite}
      data-colophon-invite="checking"
    />
  );
};

/**
 * The phone feed post's discussion as colophons (题跋), continuing the stage
 * strip past the last image: vertical, read right to left, hot roots first
 * and then the latest, the next page loading as the reader swipes on.
 */
export const FeedColophon = (props: FeedColophonProps) => {
  const { viewer } = useAuthors();
  // The thread assumes a fresh mount per reader and content.
  return (
    <ScopedFeedColophon
      key={`${viewer?.id ?? "guest"}:${contentKey(props.target)}`}
      {...props}
    />
  );
};

const ScopedFeedColophon = ({
  target,
  title,
  fallbackCount,
}: FeedColophonProps) => {
  const key = contentKey(target);
  const author = useAuthors();
  const shell = useProductShell();
  const enterAuth = useAuthEntry();
  const stage = useFeedStage();
  const outlet = useContext(FeedColophonOutletContext);
  const headRef = useRef<HTMLElement>(null);
  // The composer stays open while any of the post is on screen, in the
  // destination and layer it was opened in.
  const composer = useColophonComposer(key, {
    observe:
      outlet?.closest("article") ?? stage?.strip?.closest("article") ?? null,
    fallbackFocus: () =>
      headRef.current?.querySelector<HTMLElement>("[data-colophon-write]") ??
      null,
    scene: colophonComposerScene(shell),
  });
  const region = stage?.region;
  // Latched: leaving the colophons never resets or rereads the thread.
  const [approached, setApproached] = useState(false);
  const enabled = approached || region === "comments" || composer.open;
  const thread = useDiscussionThread({
    target,
    enabled,
    mode: "colophon",
    authReturnSlot: `feed-colophon:${key}`,
    consumeLocation: false,
  });
  const sectionRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<FeedStageApi | null>(stage);
  stageRef.current = stage;
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [flashId, setFlashId] = useState<string | null>(null);
  const [toast, setToast] = useState({ message: "", serial: 0 });
  const strip = stage?.strip ?? null;
  // The draft being written, previewed vertically where it will appear.
  const [draftSource] = useState(createColophonDraftSource);
  // Where the composer was opened from: the head or the end column, and the
  // list a reply was opened in.
  const [origin, setOrigin] = useState<{
    readonly root: "head" | "end";
    readonly list: "hot" | "latest";
  }>({ root: "head", list: "latest" });
  const formId = useId();
  // The slip is inked once, the first time the reader comes to the colophons.
  const [cue, setCue] = useState<"pending" | "on" | "done">("pending");
  // The last submission when the composer opened: one after it was accepted
  // in this session, and its sheet leaves in the same commit as its mark.
  const sessionSubmit = useRef<DiscussionThread["lastSubmit"] | undefined>(
    undefined,
  );
  if (!composer.open) sessionSubmit.current = undefined;
  else if (sessionSubmit.current === undefined)
    sessionSubmit.current = thread.lastSubmit;
  const accepted = composer.open && thread.lastSubmit !== sessionSubmit.current;

  // Rows that arrive while the strip moves (a swipe, its momentum or snap, a
  // programmatic scroll) would grow it on the left under the moving view,
  // which browsers keep measured from the left: the reader would be thrown
  // on by the added width. They wait for the strip to settle. A scroll that
  // has not reported itself yet when they commit (its first frame) is the
  // stage's to catch: it undoes such a carry (see `watchCarry`).
  const live = shownOf(thread);
  const shownRef = useRef(live);
  if (stage === null || stage.isSettled()) shownRef.current = live;
  const shown = sameShown(shownRef.current, live) ? live : shownRef.current;
  const holding = shown !== live;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  const [, commitHeld] = useState(0);

  useEffect(() => {
    if (enabled && !approached) setApproached(true);
  }, [approached, enabled]);

  // The first read waits until the reader nears the colophons.
  const imageCount = stage?.count ?? 1;
  useEffect(() => {
    const head = headRef.current;
    if (approached || head === null) return undefined;
    if (stage !== null && strip === null) return undefined;
    if (typeof IntersectionObserver !== "function") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setApproached(true);
      },
      {
        root: strip,
        rootMargin: imageCount > 1 ? APPROACH_MARGIN : APPROACH_MARGIN_SINGLE,
        threshold: 0,
      },
    );
    observer.observe(head);
    return () => observer.disconnect();
  }, [approached, imageCount, stage, strip]);

  // The next page is requested when the end comes near. Each observer asks
  // once; a new one after every read (a page, a refresh or a failure)
  // re-checks a sentinel that is still in range.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || thread.page === 0 || holding) return undefined;
    if (!thread.hasMore || thread.busy || thread.readError !== null)
      return undefined;
    if (typeof IntersectionObserver !== "function") return undefined;
    let asked = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const current = threadRef.current;
        if (
          asked ||
          !entries.some((entry) => entry.isIntersecting) ||
          !current.hasMore ||
          current.busy ||
          current.readError !== null
        )
          return;
        asked = true;
        current.loadMore();
      },
      { root: strip, rootMargin: END_MARGIN, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    holding,
    strip,
    thread.page,
    thread.hasMore,
    thread.busy,
    thread.readError,
  ]);

  // Reading position: the right-most visible colophon and its distance from
  // the strip's right edge, so a resize or an in-place refresh keeps it.
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  const recordAnchor = useCallback(() => {
    const scroller = stageRef.current?.strip;
    const section = sectionRef.current;
    if (scroller == null || section === null) return;
    const box = scroller.getBoundingClientRect();
    let best: { id: string; right: number } | null = null;
    for (const node of section.querySelectorAll<HTMLElement>(
      READING_POSITIONS,
    )) {
      const rect = node.getBoundingClientRect();
      const id = readingPositionId(node);
      if (rect.right <= box.left || rect.left >= box.right) continue;
      if (best === null || rect.right > best.right)
        best = { id, right: rect.right };
    }
    anchor.current =
      best === null ? null : { id: best.id, delta: box.right - best.right };
  }, []);
  const anchorOffset = useCallback((): number | null => {
    const current = stageRef.current;
    const saved = anchor.current;
    if (current?.strip == null || saved === null) return null;
    const node = findReadingPosition(sectionRef.current, saved.id);
    if (node === null) return null;
    return (
      elementStartOffset(
        current.strip.getBoundingClientRect().right,
        node.getBoundingClientRect().right,
        current.readOffset(),
      ) - saved.delta
    );
  }, []);
  const subscribeSettle = stage?.subscribeSettle;
  useEffect(
    () =>
      subscribeSettle?.(({ resized }: FeedStageSettle) => {
        // Rows held during the scroll come in now, while nothing moves.
        if (holdingRef.current) commitHeld((value) => value + 1);
        // A resize re-pin may be clamped at the strip's end: the reading
        // position it restored stays the one to restore next time.
        if (!resized) recordAnchor();
      }),
    [recordAnchor, subscribeSettle],
  );
  const setCommentsAnchor = stage?.setCommentsAnchor;
  useEffect(() => {
    if (setCommentsAnchor === undefined) return undefined;
    setCommentsAnchor(anchorOffset);
    return () => setCommentsAnchor(null);
  }, [anchorOffset, setCommentsAnchor]);

  const rows = shown.hot.length + shown.items.length;
  const reading = shown.busy || (shown.loading && enabled);
  // The end column reads 题跋至此: the thread is all shown.
  const endDone =
    !shown.unavailable &&
    shown.readError === null &&
    !(reading && (shown.page === 0 || shown.hasMore)) &&
    shown.page > 0 &&
    !shown.hasMore &&
    rows > 0;
  const viewer = thread.viewerState;
  const writable =
    viewer.state === "signed-in" &&
    !thread.composerClosed &&
    !thread.unavailable;
  const replyRoot = composer.replyTarget?.rootCommentId;
  const draftAt: DraftAt =
    !composer.open || accepted || !writable
      ? null
      : composer.replyTarget !== null && replyRoot !== undefined
        ? shown[origin.list === "hot" ? "hot" : "items"].some(
            (row) => row.id === replyRoot,
          )
          ? {
              reply: composer.replyTarget,
              rootId: replyRoot,
              list: origin.list,
            }
          : null
        : origin.root === "end" && endDone
          ? "end"
          : "head";
  const draftKey =
    draftAt === null
      ? ""
      : typeof draftAt === "string"
        ? draftAt
        : `reply:${draftAt.list}:${draftAt.rootId}`;
  // A failure is the draft's only until the composer closes: reopened, the
  // text is a draft again.
  const dismissedError = useRef(thread.actionError);
  if (!composer.open) dismissedError.current = thread.actionError;
  const draftState: ColophonDraftState = thread.submitting
    ? "sending"
    : thread.actionError?.id === null &&
        thread.actionError !== dismissedError.current
      ? "failed"
      : "draft";

  // Any change in what the colophons hold changes the strip's width on its
  // left. Chromium keeps the view; WebKit keeps it measured from the left
  // edge and throws it on by the added width, and rows inserted right of the
  // view (a refresh reordering hot and latest) shift it in every engine. So
  // the reading position is read before such a commit and restored after:
  // in the images the offset from the strip's start, in the colophons the
  // right-most colophon in view.
  const signature = [
    layoutSignature(shown.hot, shown.items),
    shown.loading,
    shown.busy,
    shown.page,
    shown.hasMore,
    shown.readError,
    shown.unavailable,
    draftKey,
    thread.viewerState.state,
    thread.composerClosed,
  ].join("#");
  const committedSignature = useRef(signature);
  const offsetBefore = useRef<number | null>(null);
  if (committedSignature.current !== signature && stage !== null) {
    offsetBefore.current = stage.readOffset();
    if (region === "comments") recordAnchor();
  }
  useLayoutEffect(() => {
    if (committedSignature.current === signature) return;
    committedSignature.current = signature;
    const before = offsetBefore.current;
    offsetBefore.current = null;
    const current = stageRef.current;
    if (current === null) return;
    const offset =
      current.region === "comments" ? (anchorOffset() ?? before) : before;
    if (offset !== null && Math.abs(offset - current.readOffset()) > 1)
      current.scrollToOffset(offset, "instant");
  }, [anchorOffset, signature]);

  // A published colophon or reply: bring it in and mark it briefly.
  const repliesRequested = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = thread.highlightId;
    if (id === undefined || holding) return;
    const node = findAnchor(sectionRef.current, id);
    if (node === null) {
      // A reply past the preview: read its root's last reply page first.
      // Anything else that is not shown is dropped, so it cannot pull the
      // strip there later.
      const submitted = thread.lastSubmit;
      const root =
        submitted?.id === id && submitted.rootId !== id
          ? [...thread.hot, ...thread.items].find(
              (row) => row.id === submitted.rootId,
            )
          : undefined;
      if (root === undefined) {
        thread.setHighlight(undefined);
        return;
      }
      if (repliesRequested.current === id) {
        if (!thread.repliesLoading.has(root.id)) thread.setHighlight(undefined);
        return;
      }
      repliesRequested.current = id;
      const total = root.replyPageTotal ?? root.replyTotal ?? 0;
      thread.loadReplies(
        root.id,
        Math.max(1, Math.ceil(total / REPLY_PAGE_SIZE)),
      );
      return;
    }
    // The first colophon of a group comes in with its group's label.
    const label =
      node.matches("[data-colophon-entry]") &&
      node.previousElementSibling === null
        ? node.parentElement?.previousElementSibling
        : null;
    stageRef.current?.scrollToElement(
      label?.matches("[data-colophon-group]") === true ? label : node,
    );
    setFlashId(id);
    thread.setHighlight(undefined);
  }, [holding, thread]);
  useEffect(() => {
    if (flashId === null) return undefined;
    const timer = window.setTimeout(() => setFlashId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  // The status after an action: a send (published or awaiting approval
  // alike) or a failure, shown for a few seconds.
  const previous = useRef({
    submit: thread.lastSubmit,
    notice: thread.notice,
    error: thread.actionError,
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = {
      submit: thread.lastSubmit,
      notice: thread.notice,
      error: thread.actionError,
    };
    const message =
      thread.actionError !== null && thread.actionError !== before.error
        ? thread.actionError.message
        : thread.notice !== "" &&
            (thread.notice !== before.notice ||
              thread.lastSubmit !== before.submit)
          ? thread.notice
          : null;
    if (message !== null)
      setToast((value) => ({ message, serial: value.serial + 1 }));
  }, [thread.actionError, thread.lastSubmit, thread.notice]);
  useEffect(() => {
    if (toast.message === "") return undefined;
    const timer = window.setTimeout(
      () => setToast((value) => ({ ...value, message: "" })),
      NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

  // While the composer is open the status sits above it, not under it.
  const composerForm = composer.open
    ? (composer.textareaRef.current?.form ?? null)
    : null;
  useLayoutEffect(() => {
    const node = noticeRef.current;
    if (node === null) return undefined;
    const clear = () =>
      node.style.removeProperty("--colophon-composer-block-size");
    if (composerForm === null) {
      clear();
      return undefined;
    }
    const measure = () =>
      node.style.setProperty(
        "--colophon-composer-block-size",
        `${composerForm.offsetHeight}px`,
      );
    measure();
    if (typeof ResizeObserver !== "function") return clear;
    const observer = new ResizeObserver(measure);
    observer.observe(composerForm);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [composerForm]);

  useEffect(() => {
    if (region === "media") setSelectedId(null);
  }, [region]);

  // 收起 shortens a colophon read from its far end: bring its start back,
  // rather than leave the reader among later colophons.
  const collapsedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = collapsedRef.current;
    collapsedRef.current = null;
    const current = stageRef.current;
    if (id === null || current?.strip == null) return;
    const node = findAnchor(sectionRef.current, id);
    if (node === null) return;
    const box = current.strip.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (rect.right > box.right + 1 || rect.right <= box.left)
      current.scrollToElement(node, "instant");
  }, [expanded]);

  // The draft sheet just placed comes into view, once per place: the head
  // or the end column when it is not wholly shown, a reply with its colophon
  // when both fit one view, else the reply itself.
  const revealedKey = useRef("");
  // The slip tapped while an unsent reply is kept continues that reply: its
  // sheet is brought into view again, wherever the strip is.
  const [revealSerial, setRevealSerial] = useState(0);
  const revealedSerial = useRef(revealSerial);
  useLayoutEffect(() => {
    if (revealedSerial.current !== revealSerial) {
      revealedSerial.current = revealSerial;
      revealedKey.current = "";
    }
    if (draftKey === "") {
      revealedKey.current = "";
      return;
    }
    if (revealedKey.current === draftKey) return;
    revealedKey.current = draftKey;
    const current = stageRef.current;
    const section = sectionRef.current;
    if (current?.strip == null || section === null) return;
    const box = current.strip.getBoundingClientRect();
    const shownWhole = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return rect.right <= box.right + 1 && rect.left >= box.left - 1;
    };
    if (draftKey === "head" || draftKey === "end") {
      const node = section.querySelector(
        draftKey === "head" ? "[data-colophon-head]" : "[data-colophon-end]",
      );
      if (node !== null && !shownWhole(node)) current.scrollToElement(node);
      return;
    }
    const sheet = section.querySelector('[data-colophon-draft="reply"]');
    const entry = sheet?.closest("[data-colophon-entry]") ?? null;
    if (sheet == null || entry === null) return;
    // One view is the strip less its snap gutter on either side.
    const gutter =
      Number.parseFloat(getComputedStyle(entry).scrollMarginRight) || 0;
    const span =
      entry.getBoundingClientRect().right - sheet.getBoundingClientRect().left;
    const node = span <= box.width - 2 * gutter ? entry : sheet;
    if (!shownWhole(node) || !shownWhole(sheet)) current.scrollToElement(node);
  }, [draftKey, revealSerial]);

  // The slip is inked once, the first time the reader comes here. An ink cut
  // short (the slip opened, or re-rendered as the sheet) counts as done too.
  useEffect(() => {
    if (region !== "comments" || cue !== "pending") return;
    // Without motion there is no ink, and no animation event would end it.
    setCue(
      typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "done"
        : "on",
    );
  }, [cue, region]);
  useEffect(() => {
    const section = sectionRef.current;
    if (cue !== "on" || section === null) return undefined;
    const cancelled = (event: AnimationEvent) => {
      if (
        event.target instanceof Element &&
        event.target.matches("[data-colophon-invite-cue]")
      )
        setCue("done");
    };
    section.addEventListener("animationcancel", cancelled);
    return () => section.removeEventListener("animationcancel", cancelled);
  }, [cue]);

  const replyKept = composer.replyTarget !== null;
  const openWrite = (opener: HTMLElement) => {
    setSelectedId(null);
    // Opening ends the entry cue, so it does not ink again on 取消.
    setCue("done");
    if (replyKept && draftSource.get().trim() !== "")
      setRevealSerial((value) => value + 1);
    const root =
      opener.closest("[data-colophon-end]") === null ? "head" : "end";
    setOrigin((value) => (value.root === root ? value : { ...value, root }));
    composer.openComposer(null, opener);
  };
  // A fresh clock whenever the rows change.
  const now = useMemo(() => new Date(), [shown.hot, shown.items]);
  const interactions: ColophonInteractions = {
    actorId: thread.currentUser.id,
    now,
    selectedId,
    flashId,
    expanded,
    repliesLoading: thread.repliesLoading,
    canReply:
      !thread.composerClosed &&
      (viewer.state === "signed-in" || viewer.state === "signed-out"),
    select: setSelectedId,
    toggleFold: (id) => {
      if (expanded.has(id)) collapsedRef.current = id;
      setExpanded((value) => {
        const next = new Set(value);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    reply: (replyTarget: CommentReplyTarget, opener: HTMLElement) => {
      if (viewer.state === "signed-out") {
        enterAuth(viewer.signInHref, opener);
        return;
      }
      setSelectedId(null);
      const list =
        opener.closest<HTMLElement>("[data-colophon-list]")?.dataset
          .colophonList === "hot"
          ? "hot"
          : "latest";
      setOrigin((value) => (value.list === list ? value : { ...value, list }));
      // The toolbar closes; focus comes back to the text replied to.
      composer.openComposer(
        replyTarget,
        opener
          .closest("[data-colophon-anchor]")
          ?.querySelector<HTMLElement>("[data-colophon-text]") ?? opener,
      );
    },
    like: (rootId, replyId, opener) =>
      thread.toggleLike(rootId, replyId, opener),
    remove: (id) => {
      if (!window.confirm(deleteQuestion)) return;
      thread.deleteBody(id);
      setSelectedId(null);
      // The toolbar closes; focus stays with the colophon.
      findAnchor(sectionRef.current, id)
        ?.querySelector<HTMLElement>("[data-colophon-text]")
        ?.focus({ preventScroll: true });
    },
    moreReplies: (rootId) => thread.loadReplies(rootId),
    openAuthor: (id, opener) => shell.openProfile(id, opener),
  };

  const count = shown.page > 0 ? shown.visibleTotal : fallbackCount;
  const sheet = (slot: "head" | "end") =>
    draftAt === slot ? (
      <ColophonDraftSheet
        composerForm={composerForm}
        slot={slot}
        source={draftSource}
        state={draftState}
        user={thread.currentUser}
      />
    ) : undefined;
  const replyDraft = (list: "hot" | "latest", rootId: string) =>
    draftAt !== null &&
    typeof draftAt !== "string" &&
    draftAt.list === list &&
    draftAt.rootId === rootId ? (
      <ColophonDraftReply
        composerForm={composerForm}
        onRefocus={() =>
          composer.textareaRef.current?.focus({ preventScroll: true })
        }
        replyTo={draftAt.reply.user.name}
        source={draftSource}
        state={draftState}
        user={thread.currentUser}
      />
    ) : undefined;
  const writeEntry = (placement: "head" | "end") => (
    <WriteEntry
      cue={cue === "on"}
      draft={sheet(placement)}
      empty={count === 0}
      formId={formId}
      onCueEnd={() => setCue("done")}
      onWrite={openWrite}
      open={composer.open}
      placement={placement}
      replying={replyKept}
      source={draftSource}
      thread={thread}
    />
  );
  const end = shown.unavailable ? (
    <p data-colophon-unavailable="">此处暂不开放题跋</p>
  ) : shown.readError !== null ? (
    <>
      <p data-colophon-read-error="">{shown.readError}</p>
      <button
        className={styles.write}
        data-colophon-retry=""
        onClick={() => thread.retry()}
        type="button"
      >
        重试
      </button>
    </>
  ) : reading && (shown.page === 0 || shown.hasMore) ? (
    <p data-colophon-loading="">正在展开…</p>
  ) : endDone ? (
    <>
      <p data-colophon-done="">题跋至此</p>
      {writeEntry("end")}
    </>
  ) : null;

  const notice = (
    <p
      className={styles.notice}
      data-colophon-notice=""
      key="notice"
      ref={noticeRef}
      role="status"
    >
      {toast.message}
    </p>
  );

  return (
    <section
      aria-busy={shown.busy}
      aria-label={`${title}的题跋`}
      className={styles.colophon}
      data-feed-colophon=""
      onCopy={(event) => {
        // Copies what the reader selected, digits and all (see the helper).
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed) return;
        event.preventDefault();
        event.clipboardData.setData(
          "text/plain",
          colophonClipboardText(selection),
        );
      }}
      onClick={(event) => {
        // A tap on blank colophon space clears the selection; taps in the
        // composer (a portal) are not colophon space.
        if (
          selectedId !== null &&
          event.currentTarget.contains(event.target as Node) &&
          (event.target as Element).closest(
            "[data-colophon-text],[data-colophon-actions],button,a",
          ) === null
        )
          setSelectedId(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedId !== null) setSelectedId(null);
      }}
      ref={sectionRef}
      style={
        { "--colophon-highlight-ms": `${HIGHLIGHT_MS}ms` } as CSSProperties
      }
    >
      <header
        className={styles.head}
        data-colophon-drafting={draftAt === "head" ? "" : undefined}
        data-colophon-head=""
        ref={headRef}
      >
        <h4 className={styles.headTitle}>题跋</h4>
        {count === null || count === undefined ? null : (
          <p className={styles.headCount} data-colophon-count="">
            {count > 0 ? <VerticalDigits text={`${count}则`} /> : "尚无题跋"}
          </p>
        )}
        {writeEntry("head")}
      </header>
      {outlet === null ? notice : null}
      {shown.hot.length > 0 ? (
        <h5 className={styles.groupLabel} data-colophon-group="hot">
          热评
        </h5>
      ) : null}
      <ol className={styles.list} data-colophon-list="hot" role="list">
        {shown.hot.map((comment) => (
          <ColophonEntry
            comment={comment}
            draft={replyDraft("hot", comment.id)}
            interactions={interactions}
            key={comment.id}
          />
        ))}
      </ol>
      {shown.hot.length > 0 && shown.items.length > 0 ? (
        <h5 className={styles.groupLabel} data-colophon-group="latest">
          最新
        </h5>
      ) : null}
      <ol
        aria-busy={shown.loading}
        className={styles.list}
        data-colophon-list="latest"
        role="list"
      >
        {shown.items.map((comment) => (
          <ColophonEntry
            comment={comment}
            draft={replyDraft("latest", comment.id)}
            interactions={interactions}
            key={comment.id}
          />
        ))}
        {shown.loading
          ? [0, 1, 2].map((index) => (
              <li
                aria-hidden="true"
                className={styles.skeleton}
                data-colophon-skeleton=""
                key={`skeleton-${index}`}
              />
            ))
          : null}
      </ol>
      <span
        aria-hidden="true"
        className={styles.sentinel}
        data-colophon-sentinel=""
        ref={sentinelRef}
      />
      <footer
        aria-live="polite"
        className={styles.end}
        data-colophon-drafting={draftAt === "end" ? "" : undefined}
        data-colophon-end=""
      >
        {end}
      </footer>
      {outlet === null ? null : createPortal(notice, outlet, "notice")}
      {outlet === null || viewer.state === "signed-out"
        ? null
        : createPortal(
            <FeedColophonComposer
              actorId={author.viewer?.id ?? null}
              contentKey={key}
              formId={formId}
              onCancel={composer.close}
              onDraftChange={draftSource.set}
              onReplyTargetChange={composer.setReplyTarget}
              onSubmit={(text, mentions, replyTarget) =>
                replyTarget === null
                  ? thread.sendComment(text, mentions)
                  : thread.sendReply(replyTarget, text, mentions)
              }
              open={composer.open}
              replyTarget={composer.replyTarget}
              submitting={thread.submitting}
              textareaRef={composer.textareaRef}
              viewerState={viewer}
            />,
            outlet,
            "composer",
          )}
    </section>
  );
};
