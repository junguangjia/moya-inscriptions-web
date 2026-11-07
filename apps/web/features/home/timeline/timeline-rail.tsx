"use client";

import { useEffect, useRef } from "react";

import styles from "./timeline.module.css";

import type { CSSProperties } from "react";
import type { TimelineRailCell } from "./timeline-model";

const LONG_PRESS_MS = 150;
/** A finger that travels this far before the long press fires is a scroll. */
const SCROLL_SLOP_PX = 6;

export interface TimelineRailDragHandlers {
  readonly onDragStart: () => void;
  /** `fraction` is the finger's place inside the cell, 0 to 1. */
  readonly onDragMove: (cellIndex: number, fraction: number) => void;
  /** `tappedCell` is set when the finger never travelled: treat it as a tap. */
  readonly onDragEnd: (tappedCell: number | null) => void;
}

export interface TimelineRailBubble {
  readonly cellIndex: number;
  readonly name: string;
  readonly yearText: string | null;
}

/**
 * The right-edge era rail. A tap jumps to a chapter's head; a long press turns
 * the rail into a per-row scrubber. `data-local-horizontal` keeps the home
 * pager out of touches that start here, and the touchmove listener is
 * non-passive so it can stop scrolling, but only after the long press fired: a
 * finger that moves earlier scrolls the list as usual.
 */
export const TimelineRail = ({
  bubble,
  cellHeight,
  cells,
  currentCell,
  dragging,
  handlers,
  onSelect,
  ready,
}: {
  readonly bubble: TimelineRailBubble | null;
  readonly cellHeight: number;
  readonly cells: readonly TimelineRailCell[];
  readonly currentCell: number | null;
  readonly dragging: boolean;
  readonly handlers: TimelineRailDragHandlers;
  readonly onSelect: (cellIndex: number) => void;
  readonly ready: boolean;
}) => {
  const railRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ cellCount: cells.length, handlers, ready });
  latest.current = { cellCount: cells.length, handlers, ready };

  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return undefined;
    let timer: number | null = null;
    let active = false;
    let travelled = false;
    let startX = 0;
    let startY = 0;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const locate = (clientY: number) => {
      const rect = rail.getBoundingClientRect();
      const { cellCount } = latest.current;
      const size = rect.height / Math.max(1, cellCount);
      const offset = Math.min(
        Math.max(0, clientY - rect.top),
        rect.height - 0.001,
      );
      const cellIndex = Math.min(
        cellCount - 1,
        Math.floor(offset / Math.max(1, size)),
      );
      return {
        cellIndex,
        fraction: (offset - cellIndex * size) / Math.max(1, size),
      };
    };
    const handleStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined || event.touches.length > 1) return;
      if (!latest.current.ready) return;
      startX = touch.clientX;
      startY = touch.clientY;
      travelled = false;
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        active = true;
        latest.current.handlers.onDragStart();
        const { cellIndex, fraction } = locate(startY);
        latest.current.handlers.onDragMove(cellIndex, fraction);
      }, LONG_PRESS_MS);
    };
    const handleMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined) return;
      if (active) {
        if (event.cancelable) event.preventDefault();
        if (Math.abs(touch.clientY - startY) > SCROLL_SLOP_PX) travelled = true;
        if (travelled) {
          const { cellIndex, fraction } = locate(touch.clientY);
          latest.current.handlers.onDragMove(cellIndex, fraction);
        }
        return;
      }
      if (
        timer !== null &&
        (Math.abs(touch.clientY - startY) > SCROLL_SLOP_PX ||
          Math.abs(touch.clientX - startX) > SCROLL_SLOP_PX)
      )
        clearTimer();
    };
    const finish = (event: TouchEvent, cancelled: boolean) => {
      clearTimer();
      if (!active) return;
      active = false;
      // The synthesised click must not jump again after a drag.
      if (event.cancelable) event.preventDefault();
      latest.current.handlers.onDragEnd(
        travelled || cancelled ? null : locate(startY).cellIndex,
      );
    };
    const handleEnd = (event: TouchEvent) => finish(event, false);
    const handleCancel = (event: TouchEvent) => finish(event, true);
    // Android opens a long-press menu on some WebViews otherwise.
    const handleContextMenu = (event: Event) => event.preventDefault();
    rail.addEventListener("touchstart", handleStart, { passive: true });
    rail.addEventListener("touchmove", handleMove, { passive: false });
    rail.addEventListener("touchend", handleEnd, { passive: false });
    rail.addEventListener("touchcancel", handleCancel, { passive: false });
    rail.addEventListener("contextmenu", handleContextMenu);
    return () => {
      clearTimer();
      rail.removeEventListener("touchstart", handleStart);
      rail.removeEventListener("touchmove", handleMove);
      rail.removeEventListener("touchend", handleEnd);
      rail.removeEventListener("touchcancel", handleCancel);
      rail.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  return (
    <nav
      aria-label="朝代索引"
      className={styles.rail}
      data-dragging={dragging ? "" : undefined}
      data-local-horizontal=""
      data-timeline-rail={ready ? "ready" : "idle"}
      ref={railRef}
      style={{ "--timeline-rail-cell": `${cellHeight}px` } as CSSProperties}
    >
      {cells.map((cell, cellIndex) => {
        const current = cellIndex === currentCell;
        return (
          <button
            aria-current={current ? "true" : undefined}
            aria-label={cell.label}
            className={styles.railCell}
            data-has-count={cell.count > 0 ? "" : undefined}
            disabled={!ready || cell.count === 0}
            key={cell.glyph}
            onClick={() => onSelect(cellIndex)}
            type="button"
          >
            {cell.glyph}
          </button>
        );
      })}
      {bubble === null ? null : (
        <div
          aria-hidden="true"
          className={styles.bubble}
          data-timeline-bubble=""
          style={{
            top: bubble.cellIndex * cellHeight + cellHeight / 2,
          }}
        >
          <span className={styles.bubbleName}>{bubble.name}</span>
          {bubble.yearText === null ? null : (
            <span className={styles.bubbleYear}>{bubble.yearText}</span>
          )}
        </div>
      )}
    </nav>
  );
};
