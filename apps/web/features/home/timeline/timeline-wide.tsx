"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatPercent, formatYear, parseYearInput } from "./timeline-format";
import {
  TIMELINE_CHAPTERS,
  TIMELINE_NOW_YEAR,
  buildChapterSegments,
  buildYearBars,
  timelineYearFraction,
} from "./timeline-model";
import { TimelineGroupToggle } from "./timeline-rows";
import styles from "./timeline.module.css";

import type { CSSProperties, FormEvent, RefObject } from "react";
import type { TimelineChapter } from "@moya/contracts";
import type {
  TimelineColumns,
  TimelineGroupRow,
  TimelineIndex,
} from "./timeline-model";
import type { TimelineRowActions } from "./timeline-rows";

/*
 * The wide layout's chrome (frames P1, P2, T3): the 时代尺 column with its
 * true-scale strip, then the bar with 凡例 and 跳到年份 over the column heads.
 *
 * A wide tablet scrolls its panel, so the chrome stays in the panel and sticks.
 * A PC scrolls the document and `.frame` has overflow hidden, so nothing inside
 * the panel can stick there, and track transforms make `fixed` unsafe inside
 * it: the feed portals this into [data-home-surface] and shows it only while
 * active. Either way it adds no height, and the list leaves room for it.
 */

/** Air over the bar, the bar and the column heads: 8 + 40 + 28. */
export const WIDE_CHROME_HEIGHT = 76;
const WIDE_CHROME_AIR = 8;
const ERA_CELL_MAX = 32;
const ERA_CELL_MIN = 22;
/** Frame P1's bars are this share of a 25-year step. */
const SCALE_BAR_SHARE = 0.866;
/** Frame P1's header, until the real one has been measured. */
const FALLBACK_HEADER_HEIGHT = 88;
const FALLBACK_PANEL_TOP = 8;

export interface TimelineWideFrameBox {
  /** Under the sticky page header: where the fixed chrome starts. */
  readonly top: number;
  /** The content column's left edge and width in the viewport. */
  readonly left: number;
  readonly width: number;
  /** From the content column's right edge to the viewport's. */
  readonly end: number;
  /** The panel padding above the root, which the root cancels. */
  readonly panelTop: number;
}

/** The column the panel gives its content, whatever a track transform does. */
export const timelineWideFrameBox = ({
  headerHeight,
  paddingLeft,
  paddingRight,
  paddingTop,
  surfaceLeft,
  surfaceWidth,
  viewportWidth,
}: {
  readonly headerHeight: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly paddingTop: number;
  readonly surfaceLeft: number;
  readonly surfaceWidth: number;
  readonly viewportWidth: number;
}): TimelineWideFrameBox => {
  const left = surfaceLeft + paddingLeft;
  const width = surfaceWidth - paddingLeft - paddingRight;
  return {
    top: headerHeight,
    left,
    width,
    end: Math.max(0, viewportWidth - left - width),
    panelTop: paddingTop,
  };
};

export interface TimelineWideFrame extends TimelineWideFrameBox {
  readonly surface: HTMLElement | null;
}

const NO_FRAME: TimelineWideFrame = {
  surface: null,
  top: FALLBACK_HEADER_HEIGHT,
  left: 0,
  width: 0,
  end: 0,
  panelTop: FALLBACK_PANEL_TOP,
};

const pixels = (value: string) => Number.parseFloat(value) || 0;

/** Where the fixed chrome goes on a PC. A hidden surface keeps the last box. */
export const useTimelineWideFrame = (
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): TimelineWideFrame => {
  const [frame, setFrame] = useState(NO_FRAME);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const surface = root?.closest<HTMLElement>("[data-home-surface]") ?? null;
    if (!enabled || root === null || surface === null) return undefined;
    const panel = root.closest<HTMLElement>("[data-home-feed-panel]");
    const header = surface.querySelector<HTMLElement>(":scope > header");
    const read = () => {
      const box = surface.getBoundingClientRect();
      const padding = panel === null ? null : getComputedStyle(panel);
      setFrame((current) => {
        if (box.width === 0)
          return current.surface === surface
            ? current
            : { ...current, surface };
        const next = timelineWideFrameBox({
          headerHeight:
            header?.getBoundingClientRect().height || FALLBACK_HEADER_HEIGHT,
          paddingLeft: pixels(padding?.paddingLeft ?? ""),
          paddingRight: pixels(padding?.paddingRight ?? ""),
          paddingTop: pixels(padding?.paddingTop ?? ""),
          surfaceLeft: box.left,
          surfaceWidth: box.width,
          viewportWidth: document.documentElement.clientWidth,
        });
        return current.surface === surface &&
          current.top === next.top &&
          current.left === next.left &&
          current.width === next.width &&
          current.end === next.end &&
          current.panelTop === next.panelTop
          ? current
          : { ...next, surface };
      });
    };
    read();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(surface);
    if (header !== null) observer?.observe(header);
    window.addEventListener("resize", read);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [enabled, rootRef]);
  return frame;
};

const TYPING_TARGET =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** `/` goes to 跳到年份 unless the reader is typing or a modal holds the page. */
export const shouldFocusTimelineJump = (
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
    | "target"
  >,
): boolean => {
  if (event.key !== "/" || event.defaultPrevented || event.isComposing)
    return false;
  // Shift stays allowed: some keyboards can only reach this key through it.
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const { target } = event;
  if (target instanceof Element && target.closest(TYPING_TARGET) !== null)
    return false;
  return document.querySelector("dialog[open]") === null;
};

/** The height the 时代尺 gets and the cell its 19 chapters then fit. */
export const timelineRulerMetrics = (
  viewportHeight: number,
  top: number,
  bottom: number,
): { readonly height: number; readonly eraCell: number } => {
  const height = Math.max(0, viewportHeight - top - WIDE_CHROME_AIR - bottom);
  return {
    height,
    eraCell: Math.max(
      ERA_CELL_MIN,
      Math.min(ERA_CELL_MAX, Math.floor(height / TIMELINE_CHAPTERS.length)),
    ),
  };
};

const TimelineWideScale = ({
  currentYear,
  index,
}: {
  readonly currentYear: number | null;
  readonly index: TimelineIndex;
}) => {
  const bars = useMemo(() => buildYearBars(index), [index]);
  const segments = useMemo(() => buildChapterSegments(index), [index]);
  return (
    <div aria-hidden="true" className={styles.wideScale} data-timeline-scale="">
      {segments.map(({ chapter, from, to }) => (
        <span
          className={styles.wideScaleSegment}
          key={chapter}
          style={{
            top: formatPercent(from),
            height: `calc(${formatPercent(to - from)} - 1px)`,
          }}
        />
      ))}
      <span className={styles.wideScaleAxis} />
      {/* A bar's value runs across here, and `width` is its share of the years. */}
      <svg
        className={styles.wideScaleBars}
        preserveAspectRatio="none"
        viewBox="0 0 32 1"
      >
        {bars.map((bar) => (
          <rect
            height={bar.width * SCALE_BAR_SHARE}
            key={bar.fraction}
            width={bar.height}
            x={0}
            y={bar.fraction}
          />
        ))}
      </svg>
      {currentYear === null ? null : (
        <span
          className={styles.wideScaleCurrent}
          style={{ top: formatPercent(timelineYearFraction(currentYear)) }}
        />
      )}
      <span className={styles.wideScaleLabel} style={{ top: 0 }}>
        {formatYear(TIMELINE_CHAPTERS[0]!.startYear)}
      </span>
      <span className={styles.wideScaleLabel} style={{ bottom: 0 }}>
        {TIMELINE_NOW_YEAR}
      </span>
    </div>
  );
};

const TimelineJump = ({
  active,
  hint,
  onJump,
}: {
  readonly active: boolean;
  readonly hint: boolean;
  readonly onJump: (year: number) => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!active) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (!shouldFocusTimelineJump(event)) return;
      const input = inputRef.current;
      // Detail and the utility overlays make the page inert around them.
      if (input === null || input.closest("[inert]") !== null) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [active]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const year = parseYearInput(text, false);
    if (year === null) return;
    onJump(year);
    setText("");
    inputRef.current?.blur();
  };
  return (
    <form className={styles.wideJump} onSubmit={submit}>
      <input
        aria-label="跳到年份"
        autoComplete="off"
        className={styles.wideJumpInput}
        data-timeline-jump=""
        enterKeyHint="go"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        placeholder="跳到年份"
        ref={inputRef}
        type="text"
        value={text}
      />
      {hint ? (
        <kbd aria-hidden="true" className={styles.wideJumpKey}>
          /
        </kbd>
      ) : null}
    </form>
  );
};

export const TimelineWideChrome = ({
  actions,
  active,
  barLabel,
  columns,
  counts,
  currentChapter,
  currentYear,
  failed,
  fixedFrame,
  index,
  onJumpToYear,
  onOpenEra,
  onOpenLegend,
  onSelectChapter,
  pinnedGroup,
  ready,
  rulerBottom,
  viewportHeight,
}: {
  readonly actions: TimelineRowActions;
  readonly active: boolean;
  readonly barLabel: string;
  readonly columns: TimelineColumns;
  readonly counts: ReadonlyMap<TimelineChapter, number>;
  readonly currentChapter: TimelineChapter | null;
  readonly currentYear: number | null;
  readonly failed: boolean;
  /** Set on a PC, where the chrome is portaled and fixed to this box. */
  readonly fixedFrame: TimelineWideFrameBox | null;
  readonly index: TimelineIndex;
  readonly onJumpToYear: (year: number) => void;
  readonly onOpenEra: (opener: HTMLElement) => void;
  readonly onOpenLegend: (opener: HTMLElement) => void;
  readonly onSelectChapter: (chapter: TimelineChapter) => void;
  readonly pinnedGroup: TimelineGroupRow | null;
  readonly ready: boolean;
  readonly rulerBottom: number;
  readonly viewportHeight: number;
}) => {
  const ruler = timelineRulerMetrics(
    viewportHeight,
    fixedFrame?.top ?? 0,
    rulerBottom,
  );
  const style = {
    "--timeline-col-place": `${columns.place}px`,
    "--timeline-col-holder": `${columns.holder}px`,
    "--timeline-wide-ruler": `${ruler.height}px`,
    "--timeline-wide-era": `${ruler.eraCell}px`,
    ...(fixedFrame === null
      ? {}
      : {
          "--timeline-wide-top": `${fixedFrame.top}px`,
          "--timeline-wide-left": `${fixedFrame.left}px`,
          "--timeline-wide-width": `${fixedFrame.width}px`,
        }),
  } as CSSProperties;
  return (
    <div
      className={styles.wide}
      data-timeline-wide={fixedFrame === null ? "sticky" : "fixed"}
      style={style}
    >
      {failed ? null : (
        <div className={styles.wideRuler}>
          <nav
            aria-label="朝代索引"
            className={styles.wideEras}
            data-timeline-eras=""
          >
            {TIMELINE_CHAPTERS.map(({ chapter, shortName }) => {
              const count = counts.get(chapter) ?? 0;
              return (
                <button
                  aria-current={chapter === currentChapter ? "true" : undefined}
                  className={styles.wideEra}
                  disabled={count === 0}
                  key={chapter}
                  onClick={() => onSelectChapter(chapter)}
                  type="button"
                >
                  <span className={styles.wideEraName}>{shortName}</span>
                  {count === 0 ? null : (
                    <span className={styles.wideEraCount}>{count}</span>
                  )}
                </button>
              );
            })}
          </nav>
          <TimelineWideScale currentYear={currentYear} index={index} />
        </div>
      )}
      <div className={styles.wideTop}>
        <div className={styles.wideBar}>
          <button
            aria-haspopup="dialog"
            className={styles.widePosition}
            data-timeline-position=""
            disabled={!ready}
            onClick={(event) => onOpenEra(event.currentTarget)}
            type="button"
          >
            {barLabel}
          </button>
          {ready ? (
            <>
              <button
                aria-haspopup="dialog"
                className={styles.wideAction}
                onClick={(event) => onOpenLegend(event.currentTarget)}
                type="button"
              >
                凡例
              </button>
              <TimelineJump
                active={active}
                hint={fixedFrame !== null}
                onJump={onJumpToYear}
              />
            </>
          ) : null}
        </div>
        {failed ? null : (
          <div aria-hidden="true" className={styles.columnHeads}>
            <span>年</span>
            <span />
            <span>名称</span>
            <span>地点</span>
            <span>保管</span>
          </div>
        )}
        {pinnedGroup === null ? null : (
          <div
            className={styles.group}
            data-expanded=""
            data-timeline-pinned=""
          >
            <TimelineGroupToggle actions={actions} pinned row={pinnedGroup} />
          </div>
        )}
      </div>
    </div>
  );
};
