"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { FeedStageContext } from "../authors/feed-post-stage-context";
import { colophonClipboardText } from "../authors/vertical-text";
import { useAuthReturnView } from "../auth/auth-return";
import type {
  FeedStageApi,
  FeedStageSettle,
} from "../authors/feed-post-stage-context";
import {
  isLegacyRtlScroll,
  readStripOffset,
  stripScrollLeft,
} from "../authors/feed-post-strip-geometry";
import {
  captureDetailReadingAnchor,
  detailReadingAnchorOffset,
} from "./catalog-detail-reading-anchor";
import type { DetailReadingAnchor } from "./catalog-detail-reading-anchor";
import {
  clearDetailCommentsRequest,
  detailCommentsRequested,
} from "./detail-comments-request";
import styles from "./catalog-detail-reading-strip.module.css";

export interface CatalogDetailReadingStripHandle {
  readonly scrollToComments: () => boolean;
  readonly scrollToComment: (id: string) => boolean;
  readonly scrollToStart: () => void;
  readonly scrollToMedia: () => boolean;
  readonly scrollToInformation: () => void;
}

export interface CatalogDetailReadingStripProps {
  readonly id?: string | undefined;
  readonly detailId: string;
  readonly information: ReactNode;
  /** Desktop shares the same reader/colophon state owner in two distinct rows. */
  readonly variant?: "continuous" | "desktop-information" | "desktop-comments";
  readonly leading?: ReactNode;
  readonly media?: ReactNode;
  readonly colophon?: ReactNode;
  readonly label?: string;
  readonly onRegionChange?:
    ((region: "information" | "comments") => void) | undefined;
  /** Caller-owned reader/account, content and mode scope; never inferred. */
  readonly positionKey?: string | undefined;
  readonly onRevealReading?: (() => void) | undefined;
}

interface CommentReadingAnchor {
  readonly id: string;
  readonly rightDelta: number;
}
interface ReadingPosition {
  readonly offset: number;
  readonly text: DetailReadingAnchor | null;
  readonly comment: CommentReadingAnchor | null;
  readonly region: "media" | "comments";
}
// In-memory navigation restoration only: no content, author data or drafts.
const positions = new Map<string, ReadingPosition>();
const rememberPosition = (key: string, position: ReadingPosition) => {
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > 60) positions.delete(positions.keys().next().value!);
};

/** Full text followed by its colophons, in one continuous vertical scroll. */
export const CatalogDetailReadingStrip = forwardRef<
  CatalogDetailReadingStripHandle,
  CatalogDetailReadingStripProps
>(function CatalogDetailReadingStrip(
  {
    detailId,
    information,
    variant = "continuous",
    leading,
    media,
    colophon,
    label = "正文与题跋",
    positionKey,
    id,
    onRegionChange,
    onRevealReading,
  },
  ref,
) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const informationRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const commentsOnly = variant === "desktop-comments";
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [region, setRegion] = useState<"media" | "comments">(
    commentsOnly ? "comments" : "media",
  );
  useEffect(() => {
    onRegionChange?.(region === "comments" ? "comments" : "information");
  }, [onRegionChange, region]);
  const legacy = useRef(false);
  const regionRef = useRef(region);
  const textAnchor = useRef<DetailReadingAnchor | null>(null);
  const savedCommentAnchor = useRef<CommentReadingAnchor | null>(null);
  const savedOffset = useRef(0);
  const commentAnchor = useRef<(() => number | null) | null>(null);
  const settleListeners = useRef(new Set<(settle: FeedStageSettle) => void>());
  const timer = useRef<number | null>(null);
  const restoreFrame = useRef<number | null>(null);
  const pointerDown = useRef(false);
  const intentUntil = useRef(0);
  const restoring = useRef(false);
  const commentsRequested = useRef(false);
  const navigationOffset = useRef<number | null>(null);
  const navigatingToComments = useRef(false);
  const authPosition = useAuthReturnView(
    `calligraphy-detail-reading:${detailId}${variant === "continuous" ? "" : `:${variant}`}`,
    (): ReadingPosition => ({
      offset: savedOffset.current,
      text: textAnchor.current,
      comment: savedCommentAnchor.current,
      region: regionRef.current,
    }),
  );
  const returnedPosition =
    authPosition !== undefined &&
    Number.isFinite(authPosition.offset) &&
    authPosition.offset >= 0 &&
    (authPosition.region === "media" || authPosition.region === "comments")
      ? authPosition
      : undefined;

  const remember = useCallback(() => {
    if (positionKey !== undefined)
      rememberPosition(positionKey, {
        offset: savedOffset.current,
        text: textAnchor.current,
        comment: savedCommentAnchor.current,
        region: regionRef.current,
      });
  }, [positionKey]);

  const bind = useCallback((node: HTMLDivElement | null) => {
    stripRef.current = node;
    setStrip(node);
  }, []);
  const readOffset = useCallback(() => {
    const node = stripRef.current;
    return node === null ? 0 : readStripOffset(node, legacy.current);
  }, []);
  // Legacy discussion renderers can omit a colophon head; their own first
  // element still marks the comments boundary in this continuous strip.
  const commentHead = useCallback(
    () =>
      stripRef.current?.querySelector<HTMLElement>("[data-colophon-head]") ??
      informationRef.current?.nextElementSibling ??
      null,
    [],
  );
  const startOffset = useCallback(() => {
    const node = stripRef.current;
    const head = commentHead();
    if (node == null || head == null) return null;
    const gutter =
      Number.parseFloat(getComputedStyle(head).scrollMarginRight) || 0;
    if (commentsOnly) return 0;
    return Math.max(
      0,
      readOffset() +
        node.getBoundingClientRect().right -
        head.getBoundingClientRect().right -
        gutter,
    );
  }, [readOffset, commentHead, commentsOnly]);

  const updateRegion = useCallback(() => {
    const node = stripRef.current;
    const head = commentHead();
    // The input appears only after the prose has passed the right edge.
    // A partly visible colophon never puts its input over the prose.
    const next =
      commentsOnly ||
      (node != null &&
        head != null &&
        head.getBoundingClientRect().right >=
          node.getBoundingClientRect().right -
            (Number.parseFloat(getComputedStyle(head).scrollMarginRight) || 0) -
            1)
        ? "comments"
        : "media";
    regionRef.current = next;
    setRegion(next);
  }, [commentHead, commentsOnly]);

  const record = useCallback(() => {
    const node = stripRef.current;
    const content = informationRef.current;
    if (node === null || content === null) return;
    savedOffset.current = readOffset();
    if (regionRef.current === "media")
      textAnchor.current = captureDetailReadingAnchor(
        content,
        node.getBoundingClientRect(),
      );
    else {
      const viewport = node.getBoundingClientRect();
      const visible = [
        ...node.querySelectorAll<HTMLElement>(
          "[data-colophon-head],[data-colophon-anchor]",
        ),
      ]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(
          ({ box }) => box.right > viewport.left && box.left < viewport.right,
        )
        .sort((a, b) => b.box.right - a.box.right)[0];
      if (visible !== undefined)
        savedCommentAnchor.current = {
          id: visible.element.dataset.colophonAnchor ?? "\u0000head",
          rightDelta: viewport.right - visible.box.right,
        };
    }
    remember();
  }, [readOffset, remember]);

  const settle = useCallback(
    (resized = false) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      const node = stripRef.current;
      const destination = navigatingToComments.current
        ? startOffset()
        : navigationOffset.current;
      if (
        !resized &&
        !pointerDown.current &&
        node !== null &&
        destination !== null
      ) {
        const target = Math.max(
          0,
          Math.min(destination, node.scrollWidth - node.clientWidth),
        );
        // Native smooth scrolling may stop a few fractional pixels short,
        // or the colophon head may move as its first rows become available.
        if (Math.abs(readOffset() - target) > 0.75)
          node.scrollLeft = stripScrollLeft(node, target, legacy.current);
      }
      navigationOffset.current = null;
      navigatingToComments.current = false;
      updateRegion();
      if (!resized) record();
      for (const listener of [...settleListeners.current])
        listener({ resized });
    },
    [record, updateRegion, startOffset, readOffset],
  );

  const scrollToOffset = useCallback(
    (offset: number, behavior?: ScrollBehavior) => {
      const node = stripRef.current;
      if (node === null) return;
      const bounded = Math.max(
        0,
        Math.min(offset, node.scrollWidth - node.clientWidth),
      );
      const reduced =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      const actual = behavior ?? (reduced ? "instant" : "smooth");
      // Colophons use instant writes to retain an anchor while rows arrive.
      // Such a maintenance write must not replace an in-flight shortcut.
      if (behavior !== "instant") {
        navigationOffset.current = bounded;
        navigatingToComments.current = false;
      }
      intentUntil.current = performance.now() + 500;
      node.scrollTo({
        left: stripScrollLeft(node, bounded, legacy.current),
        behavior: actual,
      });
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => settle(), 160);
    },
    [settle],
  );

  const scrollToElement = useCallback<FeedStageApi["scrollToElement"]>(
    (element, behavior, options) => {
      const node = stripRef.current;
      if (node === null) return;
      if (options?.reveal === true) onRevealReading?.();
      const gutter =
        Number.parseFloat(getComputedStyle(element).scrollMarginRight) || 0;
      scrollToOffset(
        readOffset() +
          node.getBoundingClientRect().right -
          element.getBoundingClientRect().right -
          gutter,
        behavior,
      );
    },
    [onRevealReading, readOffset, scrollToOffset],
  );

  const scrollToComments = useCallback(() => {
    const offset = startOffset();
    if (offset === null) return false;
    scrollToOffset(offset);
    navigatingToComments.current = true;
    return true;
  }, [scrollToOffset, startOffset]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToComments,
      scrollToComment: (id) => {
        const anchor = [
          ...(stripRef.current?.querySelectorAll<HTMLElement>(
            "[data-colophon-anchor]",
          ) ?? []),
        ].find((node) => node.dataset.colophonAnchor === id);
        if (anchor === undefined) return false;
        scrollToElement(anchor, undefined, { reveal: true });
        return true;
      },
      scrollToStart: () => scrollToOffset(0),
      scrollToMedia: () => {
        const mediaNode = mediaRef.current;
        if (mediaNode === null) return false;
        scrollToElement(mediaNode);
        return true;
      },
      scrollToInformation: () => {
        const informationNode = informationRef.current;
        if (informationNode !== null) scrollToElement(informationNode);
      },
    }),
    [scrollToComments, scrollToElement, scrollToOffset],
  );

  const restore = useCallback(() => {
    const node = stripRef.current;
    const content = informationRef.current;
    if (
      node === null ||
      content === null ||
      pointerDown.current ||
      timer.current !== null
    )
      return;
    const text = textAnchor.current;
    const savedComment = savedCommentAnchor.current;
    const commentNode =
      savedComment === null
        ? null
        : [
            ...node.querySelectorAll<HTMLElement>(
              "[data-colophon-head],[data-colophon-anchor]",
            ),
          ].find(
            (element) =>
              (element.dataset.colophonAnchor ?? "\u0000head") ===
              savedComment.id,
          );
    const commentOffset =
      commentNode == null || savedComment === null
        ? null
        : readOffset() +
          node.getBoundingClientRect().right -
          commentNode.getBoundingClientRect().right -
          savedComment.rightDelta;
    const desired =
      regionRef.current === "comments"
        ? (commentAnchor.current?.() ?? commentOffset ?? savedOffset.current)
        : text === null
          ? savedOffset.current
          : (detailReadingAnchorOffset(
              content,
              node.getBoundingClientRect(),
              readOffset(),
              text,
            ) ?? savedOffset.current);
    restoring.current = true;
    node.scrollLeft = stripScrollLeft(
      node,
      Math.max(0, desired),
      legacy.current,
    );
    savedOffset.current = readOffset();
    updateRegion();
    remember();
    for (const listener of [...settleListeners.current])
      listener({ resized: true });
    restoring.current = false;
  }, [readOffset, remember, updateRegion]);

  useLayoutEffect(() => {
    if (strip === null) return;
    legacy.current = strip !== null && isLegacyRtlScroll(strip);
    const saved =
      returnedPosition ??
      (positionKey === undefined ? undefined : positions.get(positionKey));
    if (strip !== null)
      strip.scrollLeft = stripScrollLeft(
        strip,
        saved?.offset ?? 0,
        legacy.current,
      );
    savedOffset.current = saved?.offset ?? 0;
    textAnchor.current = saved?.text ?? null;
    savedCommentAnchor.current = saved?.comment ?? null;
    regionRef.current = saved?.region ?? (commentsOnly ? "comments" : "media");
    setRegion(regionRef.current);
    if (variant !== "desktop-information") {
      commentsRequested.current = detailCommentsRequested(detailId);
      clearDetailCommentsRequest();
    }
    if (saved === undefined) record();
  }, [
    detailId,
    strip,
    record,
    positionKey,
    returnedPosition,
    commentsOnly,
    variant,
  ]);

  useLayoutEffect(
    () => () => {
      savedOffset.current = readOffset();
      remember();
    },
    [readOffset, remember],
  );

  useEffect(() => {
    if (strip === null) return;
    const changed = () => {
      if (restoreFrame.current !== null)
        window.cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = window.requestAnimationFrame(() => {
        restoreFrame.current = null;
        if (commentsRequested.current && scrollToComments()) {
          commentsRequested.current = false;
          if (variant === "desktop-comments") onRevealReading?.();
        } else restore();
      });
    };
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(changed) : null;
    resize?.observe(strip);
    if (informationRef.current !== null)
      resize?.observe(informationRef.current);
    const mutation = new MutationObserver(changed);
    mutation.observe(strip, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    changed();
    return () => {
      resize?.disconnect();
      mutation.disconnect();
      if (restoreFrame.current !== null)
        window.cancelAnimationFrame(restoreFrame.current);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [restore, scrollToComments, strip, onRevealReading, variant]);

  const stage = useMemo<FeedStageApi>(
    () => ({
      surface: "reading",
      strip,
      count: 0,
      commentsStartOffset: startOffset,
      region,
      readOffset,
      scrollToOffset,
      scrollToElement,
      setCommentsAnchor: (get) => {
        commentAnchor.current = get;
      },
      subscribeSettle: (listener) => {
        settleListeners.current.add(listener);
        return () => {
          settleListeners.current.delete(listener);
        };
      },
      isSettled: () => timer.current === null && !pointerDown.current,
    }),
    [readOffset, region, scrollToElement, scrollToOffset, startOffset, strip],
  );

  const noteIntent = () => {
    navigationOffset.current = null;
    navigatingToComments.current = false;
    intentUntil.current = performance.now() + 500;
  };
  return (
    <FeedStageContext.Provider value={stage}>
      <div
        id={id}
        aria-label={label}
        className={styles.strip}
        data-detail-reading-variant={variant}
        data-detail-reading-strip=""
        data-detail-reading-region={
          region === "comments" ? "comments" : "information"
        }
        data-local-horizontal=""
        onCopy={(event) => {
          if (
            event.defaultPrevented ||
            (event.target as Element).closest?.(
              "input,textarea,[contenteditable=true]",
            )
          )
            return;
          const selection = window.getSelection();
          if (selection === null || selection.isCollapsed) return;
          event.preventDefault();
          event.clipboardData.setData(
            "text/plain",
            colophonClipboardText(selection),
          );
        }}
        onKeyDown={noteIntent}
        onPointerDown={() => {
          pointerDown.current = true;
          noteIntent();
        }}
        onPointerUp={() => {
          pointerDown.current = false;
          noteIntent();
        }}
        onPointerCancel={() => {
          pointerDown.current = false;
          noteIntent();
        }}
        onWheel={noteIntent}
        onScroll={() => {
          if (restoring.current) return;
          if (
            !pointerDown.current &&
            navigationOffset.current === null &&
            performance.now() > intentUntil.current
          ) {
            restore();
            return;
          }
          // Continuous native momentum retains user intent until it settles.
          if (navigationOffset.current === null)
            intentUntil.current = performance.now() + 500;
          updateRegion();
          record();
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => settle(), 160);
        }}
        ref={bind}
        role="region"
        tabIndex={0}
      >
        {leading === undefined ? null : (
          <div className={`${styles.information} ${styles.leading}`}>
            {leading}
          </div>
        )}
        {media === undefined ? null : (
          <div
            className={styles.media}
            data-detail-reading-media=""
            ref={mediaRef}
          >
            {media}
          </div>
        )}
        <div
          className={styles.information}
          data-detail-reading-information=""
          ref={informationRef}
        >
          {information}
        </div>
        {colophon}
      </div>
    </FeedStageContext.Provider>
  );
});
