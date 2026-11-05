"use client";

import { useMemo, useRef, useState } from "react";

import { TimelineMarkGlyph } from "./timeline-rows";
import { TimelineSheet } from "./timeline-sheet";
import { formatPercent, formatYear, parseYearInput } from "./timeline-format";
import {
  TIMELINE_CHAPTERS,
  TIMELINE_NOW_YEAR,
  buildChapterSegments,
  buildYearBars,
  lookupReign,
  rowIndexForChapter,
  rowIndexForYear,
  rowIndexInChapter,
  timelineChapterInfo,
  timelineYearFraction,
} from "./timeline-model";
import styles from "./timeline.module.css";

import type { FormEvent } from "react";
import type { TimelineChapter } from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type {
  TimelineIndex,
  TimelineMark,
  TimelineReignMatch,
  TimelineRow,
} from "./timeline-model";

const LEGEND: readonly {
  readonly mark: TimelineMark;
  readonly title: string;
  readonly body: string;
}[] = [
  { mark: "dot", title: "实心点", body: "系到单年" },
  { mark: "bar", title: "竖条", body: "年号或短时段，按起年排序" },
  { mark: "multi", title: "下端开口", body: "多期刻成，放在最早的年份" },
  {
    mark: "ring",
    title: "空心红圈",
    body: "有异说，放在传统年份，说明行写明",
  },
];

const TimelineScale = ({
  currentYear,
  index,
}: {
  readonly currentYear: number | null;
  readonly index: TimelineIndex;
}) => {
  const bars = useMemo(() => buildYearBars(index), [index]);
  const segments = useMemo(() => buildChapterSegments(index), [index]);
  const firstSegment = segments[0];
  return (
    <div aria-hidden="true" className={styles.scale} data-timeline-scale="">
      <svg
        className={styles.scaleBars}
        preserveAspectRatio="none"
        viewBox="0 0 1 34"
      >
        {bars.map((bar) => (
          <rect
            height={bar.height}
            key={bar.fraction}
            width={bar.width * 0.78}
            x={bar.fraction}
            y={34 - bar.height}
          />
        ))}
      </svg>
      <span className={styles.scaleBaseline} />
      {segments.map(({ chapter, from, to }) => (
        <span
          className={styles.scaleSegment}
          key={chapter}
          style={{
            left: formatPercent(from),
            width: `calc(${formatPercent(to - from)} - 1px)`,
          }}
        />
      ))}
      {currentYear === null ? null : (
        <span
          className={styles.scaleCurrent}
          style={{ left: formatPercent(timelineYearFraction(currentYear)) }}
        />
      )}
      <span className={styles.scaleLabel} style={{ left: 0 }}>
        {formatYear(TIMELINE_CHAPTERS[0]!.startYear)}
      </span>
      {firstSegment === undefined ? null : (
        <span
          className={styles.scaleLabel}
          style={{ left: formatPercent(firstSegment.from) }}
        >
          {formatYear(timelineChapterInfo(firstSegment.chapter).startYear)}
        </span>
      )}
      <span className={styles.scaleLabel} style={{ right: 0 }}>
        {TIMELINE_NOW_YEAR}
      </span>
    </div>
  );
};

const LegendView = () => (
  <div className={styles.legend} data-timeline-legend="">
    <h2 className={styles.sheetTitle}>凡例</h2>
    <ul className={styles.legendList}>
      {LEGEND.map(({ mark, title, body }) => (
        <li key={mark}>
          <span className={styles.legendMark}>
            <TimelineMarkGlyph mark={mark} />
          </span>
          <span className={styles.legendText}>
            <strong>{title}</strong>
            <span>{body}</span>
          </span>
        </li>
      ))}
    </ul>
    <p className={styles.legendNote}>
      「其他」放的是不落在轴上的条目。「隔 N 年」是相邻两条的距离。前 841
      以前的年份加「约」。
    </p>
  </div>
);

/** 凡例 on its own: the wide bar opens it directly, with no 纪年 under it. */
export const TimelineLegendSheet = ({
  closeRequested,
  onClose,
}: {
  readonly closeRequested: boolean;
  readonly onClose: () => void;
}) => {
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  return (
    <TimelineSheet
      closeRequested={closeRequested}
      navigationRef={navigationRef}
      onClose={onClose}
      title="凡例"
    >
      <LegendView />
    </TimelineSheet>
  );
};

/** 纪年: the true-scale 总尺, year and reign inputs, and the era grid. */
export const TimelineEraSheet = ({
  closeRequested,
  currentChapter,
  currentYear,
  index,
  onClose,
  onSelectRow,
  rows,
}: {
  readonly closeRequested: boolean;
  readonly currentChapter: TimelineChapter | null;
  readonly currentYear: number | null;
  readonly index: TimelineIndex;
  readonly onClose: () => void;
  readonly onSelectRow: (rowIndex: number) => void;
  readonly rows: readonly TimelineRow[];
}) => {
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  const [legend, setLegend] = useState(false);
  const [beforeCommonEra, setBeforeCommonEra] = useState(false);
  const [yearText, setYearText] = useState("");
  const [reignText, setReignText] = useState("");
  const [reign, setReign] = useState<{
    readonly query: string;
    readonly matches: readonly TimelineReignMatch[];
  } | null>(null);

  const submitYear = (event: FormEvent) => {
    event.preventDefault();
    const year = parseYearInput(yearText, beforeCommonEra);
    if (year !== null) onSelectRow(rowIndexForYear(rows, year));
  };
  const submitReign = (event: FormEvent) => {
    event.preventDefault();
    const query = reignText.trim();
    if (query === "") return;
    const matches = lookupReign(index, query);
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) {
      onSelectRow(rowIndexInChapter(rows, only.chapter, only.year));
      return;
    }
    setReign({ query, matches });
  };

  return (
    <TimelineSheet
      closeRequested={closeRequested}
      navigationDepth={legend ? 1 : 0}
      navigationRef={navigationRef}
      onBack={(depth) => {
        if (depth === 0) setLegend(false);
      }}
      onClose={onClose}
      title={legend ? "凡例" : "纪年"}
    >
      {legend ? (
        <LegendView />
      ) : (
        <div className={styles.era} data-timeline-era="">
          <header className={styles.eraHeader}>
            <h2 className={styles.sheetTitle}>纪年</h2>
            <button
              className={styles.eraLegendButton}
              onClick={() => setLegend(true)}
              type="button"
            >
              凡例
            </button>
          </header>
          <TimelineScale currentYear={currentYear} index={index} />
          <div className={styles.eraInputs}>
            <button
              aria-pressed={beforeCommonEra}
              className={styles.eraToggle}
              onClick={() => setBeforeCommonEra((value) => !value)}
              type="button"
            >
              公元前
            </button>
            <form onSubmit={submitYear}>
              <input
                aria-label="输入年份"
                autoComplete="off"
                className={styles.eraInput}
                enterKeyHint="go"
                inputMode="numeric"
                onChange={(event) => setYearText(event.target.value)}
                placeholder="输入年份"
                type="text"
                value={yearText}
              />
            </form>
            <form onSubmit={submitReign}>
              <input
                aria-label="年号"
                autoComplete="off"
                className={styles.eraInput}
                enterKeyHint="go"
                onChange={(event) => {
                  setReignText(event.target.value);
                  setReign(null);
                }}
                placeholder="年号，如开元"
                type="text"
                value={reignText}
              />
            </form>
          </div>
          {reign !== null && reign.matches.length === 0 ? (
            <p
              className={styles.eraNote}
              data-timeline-reign-none=""
              role="status"
            >
              没找到，试试年份
            </p>
          ) : null}
          {reign !== null && reign.matches.length > 1 ? (
            <ul className={styles.eraChoices} data-timeline-reign-choices="">
              {reign.matches.map((match) => (
                <li key={match.chapter}>
                  <button
                    className={styles.eraChoice}
                    onClick={() =>
                      onSelectRow(
                        rowIndexInChapter(rows, match.chapter, match.year),
                      )
                    }
                    type="button"
                  >
                    <span>
                      {timelineChapterInfo(match.chapter).shortName} ·{" "}
                      {formatYear(match.year)}
                    </span>
                    <span className={styles.eraChoiceLabel}>
                      {match.dateLabel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={styles.eraGrid}>
            {TIMELINE_CHAPTERS.map(({ chapter, shortName }) => {
              const count = index.counts.get(chapter) ?? 0;
              const current = chapter === currentChapter;
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={styles.eraCell}
                  disabled={count === 0}
                  key={chapter}
                  onClick={() => onSelectRow(rowIndexForChapter(rows, chapter))}
                  type="button"
                >
                  <span className={styles.eraCellName}>{shortName}</span>
                  {count === 0 ? null : (
                    <span className={styles.eraCellCount}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </TimelineSheet>
  );
};
