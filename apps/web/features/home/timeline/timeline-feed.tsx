"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@moya/ui";

import { useProductShell } from "../../product-shell/product-shell";
import { isWideLayout } from "../../shell/device-platform";
import { TimelineEntryCard } from "./timeline-entry-card";
import { TimelineEraSheet, TimelineLegendSheet } from "./timeline-era-sheet";
import { parseYearParam } from "./timeline-format";
import {
  TIMELINE_TEXT_SIZES,
  buildRailCells,
  buildTimelineIndex,
  buildTimelineRows,
  estimateRowHeight,
  estimateTextWidth,
  railCellIndexOfChapter,
  railRowAt,
  rowIndexForChapter,
  rowIndexForYear,
  timelineChapterInfo,
  timelineColumns,
  timelinePositionAt,
} from "./timeline-model";
import { TimelineRail } from "./timeline-rail";
import { TimelineRowView } from "./timeline-rows";
import { TimelineSheet } from "./timeline-sheet";
import { TimelineShelfSheet } from "./timeline-shelf-sheet";
import {
  TimelineWideChrome,
  WIDE_CHROME_HEIGHT,
  useTimelineWideFrame,
} from "./timeline-wide";
import { useTimelineWindow } from "./use-timeline-window";
import styles from "./timeline.module.css";

import type { CSSProperties } from "react";
import type { TimelineChapter, TimelineEntry } from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type { PresentationPlatform } from "../../shell/device-platform";
import type { HomeFeedState } from "../home-feed";
import type {
  TimelineGroupRow,
  TimelineRow,
  TimelineRowLayout,
  TimelineTextMeasure,
} from "./timeline-model";
import type { TimelineRailDragHandlers } from "./timeline-rail";
import type { TimelineRowActions } from "./timeline-rows";

const MEDIA_RESUME_MS = 120;
const POSITION_BAR_HEIGHT = 36;
const TABLET_COLUMN_HEADS_HEIGHT = 28;
const RAIL_CELLS = 18;
const RAIL_TOP = { phone: 15, tablet: 13 } as const;
const RAIL_CELL_MAX = { phone: 32, tablet: 40 } as const;
/** Room the fixed bottom navigation takes from the rail's or ruler's column. */
const DOCK_CLEARANCE = 76;
/** Frame P1 leaves this much under the 时代尺 where no dock stands there. */
const RULER_CLEARANCE = 24;
const RAIL_CELL_MIN = 18;
const EMPTY_ENTRIES: readonly TimelineEntry[] = [];
const EMPTY_ROWS: readonly TimelineRow[] = [];

/** PC, and a tablet that crossed the shell's wide width, use the wide layout. */
export const resolveTimelineLayout = (
  platform: PresentationPlatform,
  viewportWidth: number,
): TimelineRowLayout => {
  if (isWideLayout(platform, viewportWidth)) return "wide";
  return platform === "phone" ? "phone" : "tablet";
};

/** Canvas width when it is available; the character estimate otherwise. */
const createTextMeasure = (): TimelineTextMeasure => {
  if (typeof OffscreenCanvas === "undefined" || typeof document === "undefined")
    return estimateTextWidth;
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  const tokens = getComputedStyle(document.documentElement);
  const editorial = tokens.getPropertyValue("--yoyi-font-editorial").trim();
  const face = tokens.getPropertyValue("--yoyi-font-interface").trim();
  if (context === null || editorial === "" || face === "")
    return estimateTextWidth;
  // The list title and metadata tokens grow on the wide layout.
  const size = (token: string, fallback: number) =>
    Number.parseFloat(tokens.getPropertyValue(token)) || fallback;
  const titleSize = size(
    "--yoyi-type-list-title-size",
    TIMELINE_TEXT_SIZES.title,
  );
  const metaSize = size("--yoyi-type-metadata-size", TIMELINE_TEXT_SIZES.meta);
  const fonts = {
    title: `500 ${titleSize}px ${editorial}`,
    groupTitle: `500 ${TIMELINE_TEXT_SIZES.groupTitle}px ${editorial}`,
    meta: `400 ${metaSize}px ${face}`,
    column: `400 ${TIMELINE_TEXT_SIZES.column}px ${face}`,
  } as const;
  const widths = new Map<string, number>();
  return (text, style) => {
    const key = `${style}\n${text}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    context.font = fonts[style];
    const width = context.measureText(text).width;
    widths.set(key, width);
    return width;
  };
};

type TimelineSheetState =
  | { readonly kind: "era"; readonly opener: HTMLElement }
  | { readonly kind: "legend"; readonly opener: HTMLElement }
  | {
      readonly kind: "shelf";
      readonly chapter: TimelineChapter;
      readonly opener: HTMLElement;
    }
  | {
      readonly kind: "card";
      readonly entry: TimelineEntry;
      readonly opener: HTMLElement;
    };

const CardSheet = ({
  closeRequested,
  entry,
  onClose,
}: {
  readonly closeRequested: boolean;
  readonly entry: TimelineEntry;
  readonly onClose: () => void;
}) => {
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  return (
    <TimelineSheet
      closeRequested={closeRequested}
      navigationRef={navigationRef}
      onClose={onClose}
      title={entry.fullTitle}
    >
      <TimelineEntryCard entry={entry} />
    </TimelineSheet>
  );
};

export const TimelineFeed = ({
  active,
  onMediaFailed,
  state,
}: {
  readonly active: boolean;
  /** A row's image failed; its URL may have expired. */
  readonly onMediaFailed?: (() => void) | undefined;
  readonly state: HomeFeedState<TimelineEntry>;
}) => {
  const {
    browseOnly,
    openCatalog,
    platform,
    readActiveScrollTop,
    restoreActiveScrollTop,
  } = useProductShell();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // All panels mount and server-render: nothing is built until the feed has
  // been the active one, and the root stays one element across every state
  // because the pager observes `panel.firstElementChild` only once.
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  const entries = state.state === "populated" ? state.items : EMPTY_ENTRIES;
  const ready = activated && entries.length > 0;
  const failed =
    state.state === "unavailable" ||
    state.state === "unexpected-error" ||
    state.state === "empty" ||
    (state.state === "populated" && entries.length === 0);

  const index = useMemo(() => buildTimelineIndex(entries), [entries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () => (ready ? buildTimelineRows(index, expanded) : EMPTY_ROWS),
    [expanded, index, ready],
  );
  const cells = useMemo(() => buildRailCells(index, rows), [index, rows]);

  // A tablet keeps its platform across the wide width, so that width decides.
  // It is the viewport's: the wide list is narrower than the width it needs.
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    if (platform !== "tablet") return undefined;
    const read = () => setViewportWidth(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [platform]);
  const layout = resolveTimelineLayout(platform, viewportWidth);
  const wide = layout === "wide";
  // Only the document scroller needs the portal; a wide tablet's panel sticks.
  const portaled = wide && platform === "pc";
  const frame = useTimelineWideFrame(rootRef, portaled);
  const fixedFrame = portaled && frame.surface !== null ? frame : null;
  const stickyTop = wide
    ? (fixedFrame?.top ?? 0) + WIDE_CHROME_HEIGHT
    : layout === "phone"
      ? POSITION_BAR_HEIGHT
      : POSITION_BAR_HEIGHT + TABLET_COLUMN_HEADS_HEIGHT;

  const measure = useMemo(createTextMeasure, [layout]);
  const estimate = useCallback(
    (row: TimelineRow, listWidth: number) =>
      estimateRowHeight(row, { layout, listWidth, measure }),
    [layout, measure],
  );

  const latest = useRef({
    active,
    position: null as ReturnType<typeof timelinePositionAt>,
  });
  const writeYearToUrl = useCallback(() => {
    const { active: isActive, position } = latest.current;
    if (!isActive || position === null || position.year === null) return;
    // An inert root means Detail or another overlay owns the current entry; a
    // marked history state means one of the sheets does.
    if (rootRef.current?.closest("[inert]")) return;
    if (window.history.state?.phase4Dialog) return;
    const url = new URL(window.location.href);
    url.searchParams.set("feed", "timeline");
    url.searchParams.set("year", String(position.year));
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const view = useTimelineWindow({
    // Panels scroll alone, but the document's scroll belongs to the active feed.
    active,
    enabled: ready && (active || platform !== "pc"),
    estimate,
    listRef,
    onScrollSettled: writeYearToUrl,
    resetKey: `${platform}:${layout}`,
    rows,
    scrollTo: restoreActiveScrollTop,
    stickyTop,
  });
  const { scrollToIndex, scrollToIndexDuringDrag, scrollTopForIndex } = view;

  const position = useMemo(
    () => timelinePositionAt(rows, view.topIndex),
    [rows, view.topIndex],
  );
  latest.current = { active, position };

  // Past the feed, the URL no longer describes what the reader is looking at.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) {
      const url = new URL(window.location.href);
      const feed = url.searchParams.get("feed");
      const named = feed === "timeline" || feed === "nearby";
      if (named || url.searchParams.has("year")) {
        if (named) url.searchParams.delete("feed");
        url.searchParams.delete("year");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    wasActive.current = active;
  }, [active]);

  // `?year=` is read once, when the rows first exist.
  const readUrlYear = useRef(false);
  useEffect(() => {
    if (!ready || !active || readUrlYear.current) return;
    readUrlYear.current = true;
    const year = parseYearParam(
      new URL(window.location.href).searchParams.get("year"),
    );
    if (year !== null) scrollToIndex(rowIndexForYear(rows, year));
  }, [active, ready, rows, scrollToIndex]);

  // Closing a group the reader scrolled deep into returns to its fold row.
  const collapseAnchor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = collapseAnchor.current;
    if (key === null) return;
    collapseAnchor.current = null;
    const at = rows.findIndex((row) => row.key === key);
    if (at >= 0 && readActiveScrollTop() > scrollTopForIndex(at))
      scrollToIndex(at);
  }, [readActiveScrollTop, rows, scrollToIndex, scrollTopForIndex]);

  const [sheet, setSheet] = useState<TimelineSheetState | null>(null);
  const [sheetClosing, setSheetClosing] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);
  const openSheet = useCallback((next: TimelineSheetState) => {
    afterClose.current = null;
    setSheetClosing(false);
    setSheet(next);
  }, []);
  const closeSheetThen = useCallback((action: () => void) => {
    afterClose.current = action;
    setSheetClosing(true);
  }, []);
  const handleSheetClosed = () => {
    const opener = sheet?.opener;
    const action = afterClose.current;
    afterClose.current = null;
    setSheet(null);
    setSheetClosing(false);
    action?.();
    // The native dialog returns focus when it can; a jump may have moved on.
    window.requestAnimationFrame(() => {
      if (opener?.isConnected && document.activeElement === document.body)
        opener.focus({ preventScroll: true });
    });
  };

  const actions = useMemo<TimelineRowActions>(
    () => ({
      mediaFailed: () => onMediaFailed?.(),
      openEntry: (entry, opener) => {
        if (entry.catalogId !== null) openCatalog(entry.catalogId, opener);
        else openSheet({ kind: "card", entry, opener });
      },
      openShelf: (chapter, opener) =>
        openSheet({ kind: "shelf", chapter, opener }),
      toggleGroup: (row: TimelineGroupRow) => {
        if (row.expanded) collapseAnchor.current = row.key;
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(row.groupKey)) next.add(row.groupKey);
          return next;
        });
      },
    }),
    [onMediaFailed, openCatalog, openSheet],
  );

  const [drag, setDrag] = useState<{
    readonly cellIndex: number;
    readonly rowIndex: number;
  } | null>(null);
  const [mediaHeld, setMediaHeld] = useState(false);
  const mediaTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (mediaTimer.current !== null) window.clearTimeout(mediaTimer.current);
    },
    [],
  );
  const selectCell = useCallback(
    (cellIndex: number) => {
      const cell = cells[cellIndex];
      if (cell === undefined || cell.count === 0) return;
      const chapter = cell.chapters.find(
        (candidate) => (index.counts.get(candidate) ?? 0) > 0,
      );
      if (chapter !== undefined)
        scrollToIndex(rowIndexForChapter(rows, chapter));
    },
    [cells, index, rows, scrollToIndex],
  );
  const dragHandlers = useMemo<TimelineRailDragHandlers>(
    () => ({
      onDragStart: () => {
        if (mediaTimer.current !== null)
          window.clearTimeout(mediaTimer.current);
        mediaTimer.current = null;
        setMediaHeld(true);
      },
      onDragMove: (cellIndex, fraction) => {
        const cell = cells[cellIndex];
        if (cell === undefined) return;
        const rowIndex = railRowAt(cell, fraction);
        setDrag((current) =>
          current?.cellIndex === cellIndex && current.rowIndex === rowIndex
            ? current
            : { cellIndex, rowIndex },
        );
        scrollToIndexDuringDrag(rowIndex);
      },
      onDragEnd: (tappedCell) => {
        setDrag(null);
        mediaTimer.current = window.setTimeout(() => {
          mediaTimer.current = null;
          setMediaHeld(false);
        }, MEDIA_RESUME_MS);
        if (tappedCell !== null) selectCell(tappedCell);
      },
    }),
    [cells, scrollToIndexDuringDrag, selectCell],
  );
  const dragPosition = useMemo(
    () => (drag === null ? null : timelinePositionAt(rows, drag.rowIndex)),
    [drag, rows],
  );

  const currentCell =
    drag !== null
      ? drag.cellIndex
      : position === null
        ? null
        : railCellIndexOfChapter(position.chapter);
  const railLayout = layout === "phone" ? "phone" : "tablet";
  const cellHeight = Math.max(
    RAIL_CELL_MIN,
    Math.min(
      RAIL_CELL_MAX[railLayout],
      Math.floor(
        (view.viewportHeight -
          stickyTop -
          RAIL_TOP[railLayout] -
          DOCK_CLEARANCE) /
          RAIL_CELLS,
      ),
    ),
  );

  const currentYear =
    position === null
      ? null
      : (position.year ?? timelineChapterInfo(position.chapter).startYear);
  // A PC's panel cannot keep the opened group's head sticky; the chrome does.
  const topRow = rows[view.topIndex];
  const pinnedGroup =
    portaled && topRow?.kind === "group" && topRow.expanded ? topRow : null;
  // The list is only measured once it holds rows; the heads need no reflow.
  const columns = timelineColumns(
    layout,
    ready ? view.width : Number.POSITIVE_INFINITY,
  );

  const barLabel = failed
    ? "时间轴"
    : state.state === "loading"
      ? "正在载入"
      : (position?.label ?? "");
  const rendered = [];
  for (let at = view.start; at < view.end; at += 1) {
    const row = rows[at]!;
    rendered.push(
      <TimelineRowView
        actions={actions}
        index={at}
        key={row.key}
        layout={layout}
        listWidth={view.width}
        mediaHeld={mediaHeld}
        observeRow={view.observeRow}
        row={row}
        rowCount={rows.length}
        top={view.offsets[at]!}
      />,
    );
  }

  const wideChrome = wide ? (
    <TimelineWideChrome
      actions={actions}
      active={active}
      barLabel={barLabel}
      columns={columns}
      counts={index.counts}
      currentChapter={position?.chapter ?? null}
      currentYear={currentYear}
      failed={failed}
      fixedFrame={fixedFrame}
      index={index}
      onJumpToYear={(year) => scrollToIndex(rowIndexForYear(rows, year))}
      onOpenEra={(opener) => openSheet({ kind: "era", opener })}
      onOpenLegend={(opener) => openSheet({ kind: "legend", opener })}
      onSelectChapter={(chapter) =>
        scrollToIndex(rowIndexForChapter(rows, chapter))
      }
      pinnedGroup={pinnedGroup}
      ready={ready}
      rulerBottom={portaled || browseOnly ? RULER_CLEARANCE : DOCK_CLEARANCE}
      viewportHeight={view.viewportHeight}
    />
  ) : null;

  return (
    <div
      className={styles.root}
      data-timeline-feed=""
      data-timeline-layout={layout}
      data-timeline-platform={platform}
      data-timeline-state={state.state}
      ref={rootRef}
      style={
        wide
          ? ({
              "--timeline-col-place": `${columns.place}px`,
              "--timeline-col-holder": `${columns.holder}px`,
              ...(fixedFrame === null
                ? {}
                : {
                    "--timeline-panel-top": `${fixedFrame.panelTop}px`,
                    "--timeline-wide-drawer-end": `${fixedFrame.end}px`,
                  }),
            } as CSSProperties)
          : undefined
      }
    >
      {portaled
        ? active && frame.surface !== null
          ? createPortal(wideChrome, frame.surface)
          : null
        : wideChrome}
      {wide ? null : (
        <>
          <button
            aria-haspopup="dialog"
            className={styles.bar}
            data-timeline-position=""
            disabled={!ready}
            onClick={(event) =>
              openSheet({ kind: "era", opener: event.currentTarget })
            }
            type="button"
          >
            <span>{barLabel}</span>
            {ready ? (
              <Icon
                aria-hidden="true"
                className={styles.chevronDown}
                name="next"
              />
            ) : null}
          </button>
          {layout === "tablet" ? (
            <div aria-hidden="true" className={styles.columnHeads}>
              <span>年</span>
              <span />
              <span>名称</span>
              <span>地点</span>
              <span>保管</span>
            </div>
          ) : null}
          {failed ? null : (
            <div className={styles.railAnchor}>
              <TimelineRail
                bubble={
                  drag === null || dragPosition === null
                    ? null
                    : {
                        cellIndex: drag.cellIndex,
                        name: dragPosition.name,
                        yearText: dragPosition.yearText,
                      }
                }
                cellHeight={cellHeight}
                cells={cells}
                currentCell={ready ? currentCell : null}
                dragging={drag !== null}
                handlers={dragHandlers}
                onSelect={selectCell}
                ready={ready}
              />
            </div>
          )}
        </>
      )}
      <div
        className={styles.list}
        data-timeline-list=""
        ref={listRef}
        role="list"
        style={ready ? { height: view.totalHeight } : undefined}
      >
        {rendered}
      </div>
      {failed ? (
        <section
          className={styles.failure}
          data-home-feed-state={
            state.state === "populated" ? "empty" : state.state
          }
          role="status"
        >
          <span aria-hidden="true" className={styles.failureMark}>
            !
          </span>
          <h2>时间轴暂时不可用</h2>
          <p>请稍后再试。</p>
        </section>
      ) : null}
      {sheet?.kind === "era" ? (
        <TimelineEraSheet
          closeRequested={sheetClosing}
          currentChapter={position?.chapter ?? null}
          currentYear={currentYear}
          index={index}
          onClose={handleSheetClosed}
          onSelectRow={(rowIndex) =>
            closeSheetThen(() => scrollToIndex(rowIndex))
          }
          rows={rows}
        />
      ) : null}
      {sheet?.kind === "legend" ? (
        <TimelineLegendSheet
          closeRequested={sheetClosing}
          onClose={handleSheetClosed}
        />
      ) : null}
      {sheet?.kind === "shelf" ? (
        <TimelineShelfSheet
          chapter={sheet.chapter}
          closeRequested={sheetClosing}
          entries={index.shelf.get(sheet.chapter) ?? EMPTY_ENTRIES}
          onClose={handleSheetClosed}
          onOpenCatalog={(catalogId) =>
            closeSheetThen(() => openCatalog(catalogId, sheet.opener))
          }
        />
      ) : null}
      {sheet?.kind === "card" ? (
        <CardSheet
          closeRequested={sheetClosing}
          entry={sheet.entry}
          onClose={handleSheetClosed}
        />
      ) : null}
    </div>
  );
};
