"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import type { DiscussionTarget } from "@moya/contracts";
import { useAuthEntry } from "../auth/auth-return";
import type {
  CommentItem,
  CommentReplyTarget,
} from "../comments/comment-types";
import { useProductShell } from "../product-shell/product-shell";
import { contentKey, useAuthors } from "./author-context";
import { ColophonEntry } from "./feed-colophon-entry";
import type { ColophonInteractions } from "./feed-colophon-entry";
import {
  COLOPHON_INPUT_MAX_SHARE,
  FeedColophonInput,
} from "./feed-colophon-input";
import type { FeedColophonInputHandle } from "./feed-colophon-input";
import { useFeedStage } from "./feed-post-stage-context";
import type { FeedStageApi, FeedStageSettle } from "./feed-post-stage-context";
import { elementStartOffset } from "./feed-post-strip-geometry";
import { useDiscussionThread } from "./use-discussion-thread";
import type { DiscussionThread } from "./use-discussion-thread";
import { colophonClipboardText, VerticalDigits } from "./vertical-text";
import styles from "./feed-colophon.module.css";

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

// The head is a reading position too (the colophons' start), under an id
// no comment can have.
const HEAD_ANCHOR = "\u0000head";
const READING_POSITIONS = "[data-colophon-head],[data-colophon-anchor]";
const readingPositionId = (node: HTMLElement) =>
  node.dataset.colophonAnchor ?? HEAD_ANCHOR;
const findReadingPosition = (root: Element | null, id: string) =>
  id === HEAD_ANCHOR
    ? (root?.querySelector<HTMLElement>("[data-colophon-head]") ?? null)
    : findAnchor(root, id);

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
  const headRef = useRef<HTMLElement>(null);
  const inputRef = useRef<FeedColophonInputHandle>(null);
  const region = stage?.region;
  // Latched: leaving the colophons never resets or rereads the thread.
  const [approached, setApproached] = useState(false);
  const enabled = approached || region === "comments";
  const thread = useDiscussionThread({
    target,
    enabled,
    mode: "colophon",
    authReturnSlot: `feed-colophon:${key}`,
    consumeLocation: false,
  });
  const sectionRef = useRef<HTMLElement>(null);
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
  // While the input is written in, the colophons recede, all but the one
  // it answers.
  const [writing, setWriting] = useState(false);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const onWritingChange = useCallback(
    (next: boolean, target: CommentReplyTarget | null) => {
      setWriting(next);
      setReplyTargetId(
        target === null ? null : (target.replyId ?? target.rootCommentId),
      );
    },
    [],
  );
  const strip = stage?.strip ?? null;

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
    // The reader's own colophon, just sent: focus moves on to it from the
    // input (which let go of it), rather than dropping to the page.
    const active = document.activeElement;
    if (
      thread.lastSubmit?.id === id &&
      (active === null ||
        active === document.body ||
        active.closest("[data-colophon-input]") !== null)
    )
      node
        .querySelector<HTMLElement>("[data-colophon-text]")
        ?.focus({ preventScroll: true });
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

  useEffect(() => {
    if (region === "media") setSelectedId(null);
  }, [region]);

  // The input column covers the stage's left edge. A selected colophon whose
  // actions sit under it, and the colophon a reply answers when the input
  // could grow over it, are brought to their snap position at the right.
  const [answering, setAnswering] = useState<string | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const current = stageRef.current;
    const column = section?.querySelector<HTMLElement>(
      "[data-colophon-input-shown]:not([data-colophon-input='none'])",
    );
    if (section == null || current?.strip == null || column == null) return;
    // The column's edge and the fade beyond it.
    const fade =
      Number.parseFloat(
        getComputedStyle(column).getPropertyValue("--colophon-input-edge"),
      ) || 0;
    const edge = column.getBoundingClientRect().right + fade;
    if (selectedId !== null) {
      const actions = section.querySelector("[data-colophon-actions]");
      const node = findAnchor(section, selectedId);
      if (
        actions !== null &&
        node !== null &&
        actions.getBoundingClientRect().left < edge
      )
        current.scrollToElement(node);
      return;
    }
    if (answering === null) return;
    setAnswering(null);
    const node = findAnchor(section, answering);
    // Its own text and seal, not a root's replies further left.
    const body = node?.querySelector("[data-colophon-text]")?.parentElement;
    if (node == null || body == null) return;
    // As far as the input can grow: its share of the stage.
    const box = current.strip.getBoundingClientRect();
    const reach = Math.max(
      edge,
      box.left + box.width * COLOPHON_INPUT_MAX_SHARE + fade,
    );
    // Out of sight on the right, too (the input aims wherever 回复 was).
    const rect = body.getBoundingClientRect();
    if (rect.left < reach || rect.right > box.right + 1)
      current.scrollToElement(node);
  }, [answering, selectedId]);

  // 收起 shortens a colophon read from its far end: bring its start back,
  // rather than leave the reader among later colophons. 全文 lengthens one
  // past the stage's left edge, under the input column: where the rest of it
  // (from the fold on) and its 落款 fit one view, the strip brings them in;
  // otherwise its start stays where it was (WebKit would re-snap the grown
  // strip elsewhere), and a swipe on stops at the 落款's own snap point.
  const foldedRef = useRef<{
    readonly id: string;
    readonly collapsing: boolean;
    /** The colophon's right edge and its text's left (the fold) when tapped. */
    readonly right: number;
    readonly foldLeft: number;
  } | null>(null);
  useLayoutEffect(() => {
    const folded = foldedRef.current;
    foldedRef.current = null;
    const current = stageRef.current;
    if (folded === null || current?.strip == null) return;
    const node = findAnchor(sectionRef.current, folded.id);
    if (node === null) return;
    const box = current.strip.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (folded.collapsing) {
      if (rect.right > box.right + 1 || rect.right <= box.left)
        current.scrollToElement(node, "instant");
      return;
    }
    // Shifts that move the content right by as much (a larger offset).
    const restore = folded.right - rect.right;
    const signature = node.querySelector<HTMLElement>(
      ":scope > div > [data-colophon-signature]",
    );
    const offset = current.readOffset();
    if (signature !== null) {
      const tail =
        box.left +
        (Number.parseFloat(getComputedStyle(signature).scrollMarginLeft) || 0) -
        signature.getBoundingClientRect().left;
      const further = tail - restore;
      const gutter =
        Number.parseFloat(getComputedStyle(node).scrollMarginRight) || 0;
      if (further > 1 && folded.foldLeft + further <= box.right - gutter) {
        current.scrollToOffset(offset + tail);
        return;
      }
    }
    if (Math.abs(restore) > 1)
      current.scrollToOffset(offset + restore, "instant");
  }, [expanded]);

  // A fresh clock whenever the rows change.
  const now = useMemo(() => new Date(), [shown.hot, shown.items]);
  const interactions: ColophonInteractions = {
    actorId: thread.currentUser.id,
    now,
    selectedId,
    flashId,
    replyTargetId,
    expanded,
    repliesLoading: thread.repliesLoading,
    canReply:
      !thread.composerClosed &&
      (viewer.state === "signed-in" || viewer.state === "signed-out"),
    select: setSelectedId,
    toggleFold: (id) => {
      const node = findAnchor(sectionRef.current, id);
      foldedRef.current =
        node === null
          ? null
          : {
              id,
              collapsing: expanded.has(id),
              right: node.getBoundingClientRect().right,
              foldLeft:
                node
                  .querySelector(":scope > div > [data-colophon-text]")
                  ?.getBoundingClientRect().left ?? 0,
            };
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
      setAnswering(replyTarget.replyId ?? replyTarget.rootCommentId);
      // The toolbar closes; the input takes focus in the same tap, so iOS
      // raises the keyboard, led by 「回复 X：」.
      inputRef.current?.reply(replyTarget);
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
  const end = shown.unavailable ? (
    <p data-colophon-unavailable="">此处暂不开放题跋</p>
  ) : shown.readError !== null ? (
    <>
      <p data-colophon-read-error="">{shown.readError}</p>
      <button
        className={styles.retry}
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
    <p data-colophon-done="">题跋至此</p>
  ) : null;

  return (
    <section
      aria-busy={shown.busy}
      aria-label={`${title}的题跋`}
      className={styles.colophon}
      data-colophon-writing={writing ? "" : undefined}
      data-feed-colophon=""
      onCopy={(event) => {
        // Copies what the reader selected, digits and all (see the helper).
        // A copy in the input is the input's own.
        if ((event.target as Element).closest?.("[data-colophon-input]"))
          return;
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed) return;
        event.preventDefault();
        event.clipboardData.setData(
          "text/plain",
          colophonClipboardText(selection),
        );
      }}
      onClick={(event) => {
        // A tap on blank colophon space clears the selection.
        if (
          selectedId !== null &&
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
      {strip === null ? null : (
        // In the strip, sticky at its left edge: the column stays put over
        // the colophons while they scroll, a swipe that starts on it still
        // moves the strip, and it leaves with the colophons. First, so it
        // is held there however little the colophons fill.
        <div className={styles.inputAnchor} data-colophon-input-anchor="">
          <FeedColophonInput
            actorId={author.viewer?.id ?? null}
            closed={thread.composerClosed}
            closedNote={thread.closedNote}
            contentKey={key}
            notice={toast.message}
            onSubmit={(text, replyTarget) =>
              replyTarget === null
                ? thread.sendComment(text)
                : thread.sendReply(replyTarget, text)
            }
            onWritingChange={onWritingChange}
            ref={inputRef}
            shown={region === "comments"}
            strip={strip}
            submitting={thread.submitting}
            unavailable={thread.unavailable}
            viewerState={viewer}
          />
        </div>
      )}
      <header className={styles.head} data-colophon-head="" ref={headRef}>
        <h4 className={styles.headTitle}>题跋</h4>
        {count === null || count === undefined ? null : (
          <p className={styles.headCount} data-colophon-count="">
            {count > 0 ? <VerticalDigits text={`${count}则`} /> : "尚无题跋"}
          </p>
        )}
      </header>
      {shown.hot.length > 0 ? (
        <h5 className={styles.groupLabel} data-colophon-group="hot">
          热评
        </h5>
      ) : null}
      <ol className={styles.list} data-colophon-list="hot" role="list">
        {shown.hot.map((comment) => (
          <ColophonEntry
            comment={comment}
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
      <footer aria-live="polite" className={styles.end} data-colophon-end="">
        {end}
      </footer>
    </section>
  );
};
