"use client";
import { createContext, useContext } from "react";

/**
 * What a post's stage offers the region continuing past its last image (the
 * colophons): the strip itself, the settled region, and offset-based scrolling
 * that works in both RTL scroll engines.
 */
/** What a settled scroll reports to the comments region. */
export interface FeedStageSettle {
  /** The scroll came from re-pinning after a resize, not from the reader. */
  readonly resized: boolean;
}

export interface FeedStageApi {
  /** The scroller, once mounted; an IntersectionObserver root. */
  readonly strip: HTMLDivElement | null;
  /** How many images precede the comments region. */
  readonly count: number;
  /** The settled region. */
  readonly region: "media" | "comments";
  /** Distance scrolled from the strip's start (its right edge), in pixels. */
  readonly readOffset: () => number;
  /**
   * Scrolls to `offset` pixels from the strip's start: smooth by default,
   * `auto` under reduced motion, and a direct write for `instant`.
   */
  readonly scrollToOffset: (offset: number, behavior?: ScrollBehavior) => void;
  /**
   * Scrolls so the element's right edge meets the strip's right edge, less
   * its `scroll-margin-right` (its snap gutter).
   */
  readonly scrollToElement: (
    element: Element,
    behavior?: ScrollBehavior,
  ) => void;
  /**
   * The comments region registers a getter for the offset that keeps its
   * reading position after a resize, or null to fall back to its start.
   */
  readonly setCommentsAnchor: (get: (() => number | null) | null) => void;
  /** Called after every settled scroll; returns the unsubscribe. */
  readonly subscribeSettle: (
    listener: (settle: FeedStageSettle) => void,
  ) => () => void;
  /**
   * False while a finger is down, a programmatic scroll runs or a scroll
   * (momentum, snapping) has not settled yet: content that grows the strip
   * then would move the view, so it waits for the next settle.
   */
  readonly isSettled: () => boolean;
  /** The viewer this post opened is showing. */
  readonly viewerOpen?: boolean;
}

export const FeedStageContext = createContext<FeedStageApi | null>(null);

/** The enclosing post stage, or null outside one. */
export const useFeedStage = (): FeedStageApi | null =>
  useContext(FeedStageContext);
