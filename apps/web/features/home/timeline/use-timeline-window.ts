"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  prefixOffsets,
  rowIndexAtOffset,
  timelineWindowRange,
} from "./timeline-model";

import type { RefCallback, RefObject } from "react";

/*
 * The timeline's small windowing hook: rows are absolutely placed by prefix
 * offsets inside a spacer of the total height, and only the viewport plus an
 * overscan is rendered. Estimates hold until a rendered row reports its real
 * height. No library is involved, and sizes of 0 (a hidden destination, jsdom)
 * never replace the last known values.
 */

const OVERSCAN_PX = 600;
/** Re-window before a scroll can reach the edge of what is rendered. */
const REWINDOW_MARGIN_PX = 240;
const SCROLL_SETTLE_MS = 300;
/**
 * `restoreActiveScrollTop` applies two frames after it is called and cancels
 * any earlier request, so calling it faster than this would starve a drag.
 */
const DRAG_SCROLL_INTERVAL_MS = 64;
const FALLBACK_WIDTH = 390;
const FALLBACK_VIEWPORT = 800;
const NO_CORRECTIONS: ReadonlyMap<string, number> = new Map();

const scrollerOf = (list: HTMLElement): HTMLElement | null =>
  list.closest<HTMLElement>("[data-home-feed-scroll-surface]");

/** Where the viewport's top edge falls in list coordinates. */
const viewTopOf = (list: HTMLElement, scroller: HTMLElement | null): number =>
  (scroller?.getBoundingClientRect().top ?? 0) -
  list.getBoundingClientRect().top;

export interface TimelineWindowRow {
  readonly key: string;
  readonly sizeKey?: string;
}

const sizeKeyOf = (row: TimelineWindowRow) => row.sizeKey ?? row.key;

export interface TimelineWindowOptions<Row extends TimelineWindowRow> {
  readonly enabled: boolean;
  readonly estimate: (row: Row, width: number) => number;
  readonly listRef: RefObject<HTMLElement | null>;
  /** This feed is on screen; programmatic scrolls reach the active scroller. */
  readonly active: boolean;
  readonly onScrollSettled?: (() => void) | undefined;
  /** A new layout discards the heights measured under the old one. */
  readonly resetKey: string;
  readonly rows: readonly Row[];
  /** Programmatic jumps go through the shell, which holds the bottom nav. */
  readonly scrollTo: (top: number) => void;
  /** Height of the sticky chrome that covers the top of the viewport. */
  readonly stickyTop: number;
}

export interface TimelineWindow {
  readonly end: number;
  readonly observeRow: RefCallback<HTMLElement>;
  readonly offsets: Float64Array;
  readonly scrollToIndex: (index: number) => void;
  /** Rate-limited for a rail drag; the last target always lands. */
  readonly scrollToIndexDuringDrag: (index: number) => void;
  /** The scroll position that puts a row just under the sticky chrome. */
  readonly scrollTopForIndex: (index: number) => number;
  readonly start: number;
  readonly topIndex: number;
  readonly totalHeight: number;
  readonly viewportHeight: number;
  readonly width: number;
}

/** How long a jump keeps its row under the chrome while heights correct. */
const JUMP_SETTLE_MS = 800;

interface JumpAnchor {
  readonly index: number;
  readonly until: number;
}

const activeAnchor = (anchor: JumpAnchor | null) =>
  anchor !== null && performance.now() < anchor.until ? anchor.index : null;

export const useTimelineWindow = <Row extends TimelineWindowRow>({
  active,
  enabled,
  estimate,
  listRef,
  onScrollSettled,
  resetKey,
  rows,
  scrollTo,
  stickyTop,
}: TimelineWindowOptions<Row>): TimelineWindow => {
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [topIndex, setTopIndex] = useState(0);
  const [corrections, setCorrections] = useState(NO_CORRECTIONS);

  const width = measuredWidth || FALLBACK_WIDTH;
  const estimates = useMemo(
    () => rows.map((row) => estimate(row, width)),
    [estimate, rows, width],
  );
  const heights = useMemo(
    () =>
      rows.map((row, at) => corrections.get(sizeKeyOf(row)) ?? estimates[at]!),
    [corrections, estimates, rows],
  );
  const offsets = useMemo(() => prefixOffsets(heights), [heights]);
  const viewportHeight = view.height || FALLBACK_VIEWPORT;
  const range = useMemo(
    () => timelineWindowRange(offsets, view.top, viewportHeight, OVERSCAN_PX),
    [offsets, view.top, viewportHeight],
  );
  const indexBySizeKey = useMemo(
    () => new Map(rows.map((row, at) => [sizeKeyOf(row), at])),
    [rows],
  );

  const latest = useRef({
    active,
    topIndex,
    corrections,
    enabled,
    heights,
    indexBySizeKey,
    measuredWidth,
    offsets,
    onScrollSettled,
    range,
    scrollTo,
    stickyTop,
    view,
  });
  latest.current = {
    active,
    topIndex,
    corrections,
    enabled,
    heights,
    indexBySizeKey,
    measuredWidth,
    offsets,
    onScrollSettled,
    range,
    scrollTo,
    stickyTop,
    view,
  };

  const anchor = useRef<JumpAnchor | null>(null);
  const read = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || list === null) return undefined;
    const scroller = scrollerOf(list);
    let subscribed = false;
    const readView = (paintNow: boolean) => {
      const listWidth = list.getBoundingClientRect().width;
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      if (listWidth === 0 || height === 0) return;
      const state = latest.current;
      if (listWidth !== state.measuredWidth) {
        // A new width reflows every row: hold the one under the chrome. Not on
        // a subscription's first read, whose scroll offset may be another
        // feed's or a pending restore's, and not from a hidden panel, because
        // the shell would scroll the feed the reader is on.
        if (
          subscribed &&
          state.measuredWidth !== 0 &&
          state.enabled &&
          state.active &&
          activeAnchor(anchor.current) === null
        ) {
          const index = rowIndexAtOffset(
            state.offsets,
            viewTopOf(list, scroller) + state.stickyTop,
          );
          if (index > 0)
            anchor.current = {
              index,
              until: performance.now() + JUMP_SETTLE_MS,
            };
        }
        setCorrections(NO_CORRECTIONS);
        setMeasuredWidth(listWidth);
      }
      const top = viewTopOf(list, scroller);
      setTopIndex(rowIndexAtOffset(state.offsets, top + state.stickyTop));
      const { start, end } = state.range;
      const rowCount = state.offsets.length - 1;
      const startEdge = state.offsets[start] ?? 0;
      const endEdge = state.offsets[end] ?? 0;
      const reachedStart = start > 0 && top - startEdge < REWINDOW_MARGIN_PX;
      const reachedEnd =
        end < rowCount && endEdge - (top + height) < REWINDOW_MARGIN_PX;
      if (!reachedStart && !reachedEnd && state.view.height === height) return;
      const next = { top, height };
      // A jump or a hard fling already shows blank space: paint rows now.
      const blank =
        (start > 0 && top < startEdge) ||
        (end < rowCount && top + height > endEdge);
      if (blank && paintNow) flushSync(() => setView(next));
      else setView(next);
    };
    const refresh = () => readView(false);
    read.current = refresh;
    let settle: number | null = null;
    const handleScroll = () => {
      readView(true);
      if (settle !== null) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = null;
        latest.current.onScrollSettled?.();
      }, SCROLL_SETTLE_MS);
    };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", refresh);
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(refresh);
    resize?.observe(list);
    if (scroller !== null) resize?.observe(scroller);
    refresh();
    subscribed = true;
    return () => {
      read.current = null;
      if (settle !== null) window.clearTimeout(settle);
      target.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", refresh);
      resize?.disconnect();
    };
    // A platform that resolves after hydration changes the scroller.
  }, [enabled, listRef, resetKey]);

  // New offsets (a correction, a group opening) move what the viewport shows.
  useLayoutEffect(() => {
    read.current?.();
  }, [offsets]);

  const previousResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    setCorrections(NO_CORRECTIONS);
    // A layout change reaches the hook as a new subscription, whose first read
    // holds nothing, and this render's top row is still the one the reader was
    // on: the offsets are new but topIndex is not yet.
    const state = latest.current;
    if (
      state.enabled &&
      state.active &&
      state.topIndex > 0 &&
      activeAnchor(anchor.current) === null
    )
      anchor.current = {
        index: state.topIndex,
        until: performance.now() + JUMP_SETTLE_MS,
      };
  }, [resetKey]);

  const rowObserver = useRef<ResizeObserver | null>(null);
  const correctHeights = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      const list = listRef.current;
      if (list === null) return;
      const state = latest.current;
      const scroller = scrollerOf(list);
      const line = viewTopOf(list, scroller) + state.stickyTop;
      let next: Map<string, number> | null = null;
      let delta = 0;
      for (const { target } of entries) {
        const element = target as HTMLElement;
        const key = element.dataset.timelineRowSize;
        const measured = element.offsetHeight;
        if (key === undefined || measured === 0) continue;
        const at = state.indexBySizeKey.get(key);
        if (at === undefined) continue;
        const current = state.heights[at]!;
        if (Math.abs(measured - current) < 1) continue;
        next ??= new Map(state.corrections);
        next.set(key, measured);
        // A row wholly above the line must not move what the reader sees.
        if (state.offsets[at]! + current <= line) delta += measured - current;
      }
      if (next === null) return;
      const corrected = next;
      flushSync(() => setCorrections(corrected));
      // A jump still settling lands by its row, not by the delta (see below).
      if (activeAnchor(anchor.current) !== null) return;
      // Disabled on a PC means the document's scroll is another feed's to keep.
      if (delta === 0 || !state.enabled) return;
      if (scroller !== null) scroller.scrollTop += delta;
      else window.scrollBy(0, delta);
    },
    [listRef],
  );
  const observeRow = useCallback<RefCallback<HTMLElement>>(
    (element) => {
      if (element === null || typeof ResizeObserver === "undefined")
        return undefined;
      rowObserver.current ??= new ResizeObserver(correctHeights);
      const observer = rowObserver.current;
      observer.observe(element);
      return () => observer.unobserve(element);
    },
    [correctHeights],
  );

  const scrollTopForIndex = useCallback(
    (index: number) => {
      const list = listRef.current;
      if (list === null) return 0;
      const scroller = scrollerOf(list);
      const listTop = scroller
        ? list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : list.getBoundingClientRect().top + window.scrollY;
      const { offsets: current, stickyTop: sticky } = latest.current;
      return Math.max(0, Math.round(listTop + (current[index] ?? 0) - sticky));
    },
    [listRef],
  );
  const scrollToIndex = useCallback(
    (index: number) => {
      anchor.current = {
        index,
        until: performance.now() + JUMP_SETTLE_MS,
      };
      latest.current.scrollTo(scrollTopForIndex(index));
    },
    [scrollTopForIndex],
  );
  // The target's rows mount, measure and correct only after a jump starts, and
  // the first measured width replaces every estimate, so the row is held under
  // the chrome until that settles. The reader's own input releases it.
  useLayoutEffect(() => {
    const target = activeAnchor(anchor.current);
    if (target !== null && latest.current.enabled && latest.current.active)
      latest.current.scrollTo(scrollTopForIndex(target));
  }, [offsets, scrollTopForIndex]);
  useEffect(() => {
    const release = () => {
      anchor.current = null;
    };
    const events = ["wheel", "pointerdown", "touchstart", "keydown"] as const;
    for (const name of events)
      window.addEventListener(name, release, { capture: true, passive: true });
    return () => {
      for (const name of events)
        window.removeEventListener(name, release, { capture: true });
    };
  }, []);

  const dragTarget = useRef<number | null>(null);
  const dragTimer = useRef<number | null>(null);
  const scrollToIndexDuringDrag = useCallback(
    (index: number) => {
      dragTarget.current = index;
      if (dragTimer.current !== null) return;
      const flush = () => {
        const target = dragTarget.current;
        dragTarget.current = null;
        if (target === null) {
          dragTimer.current = null;
          return;
        }
        scrollToIndex(target);
        dragTimer.current = window.setTimeout(flush, DRAG_SCROLL_INTERVAL_MS);
      };
      flush();
    },
    [scrollToIndex],
  );
  useEffect(
    () => () => {
      if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
    },
    [],
  );

  return {
    end: range.end,
    observeRow,
    offsets,
    scrollToIndex,
    scrollToIndexDuringDrag,
    scrollTopForIndex,
    start: range.start,
    topIndex,
    totalHeight: offsets[rows.length] ?? 0,
    viewportHeight,
    width,
  };
};
