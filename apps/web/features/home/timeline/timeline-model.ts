import {
  elapsedYears,
  formatYear,
  formatYearLines,
  formatYearRange,
} from "./timeline-format";

import type { TimelineChapter, TimelineEntry } from "@moya/contracts";

/*
 * The Home timeline as pure data: the chapter table, the row list built from
 * API entries, per-layout row heights and every lookup the feed needs. Nothing
 * here reads the DOM; `timeline-feed.tsx` injects the text measure.
 */

export interface TimelineChapterInfo {
  readonly chapter: TimelineChapter;
  /** The chapter head and empty row: 晚商, 西汉 · 新莽. */
  readonly name: string;
  /** The 纪年 grid and the shelf row: 晚商, 西汉. */
  readonly shortName: string;
  readonly startYear: number;
  /** Open-ended only for 当代. */
  readonly endYear: number | null;
  readonly note: string | null;
}

const chapterInfo = (
  chapter: TimelineChapter,
  startYear: number,
  endYear: number | null,
  display: {
    readonly name?: string;
    readonly shortName?: string;
    readonly note?: string;
  } = {},
): TimelineChapterInfo => ({
  chapter,
  name: display.name ?? chapter,
  shortName: display.shortName ?? chapter,
  startYear,
  endYear,
  note: display.note ?? null,
});

export const TIMELINE_CHAPTERS: readonly TimelineChapterInfo[] = [
  chapterInfo("商", -1250, -1046, {
    name: "晚商",
    shortName: "晚商",
    note: "甲骨文与金文并见",
  }),
  chapterInfo("西周", -1046, -771, { note: "金文鼎盛" }),
  chapterInfo("春秋", -770, -476),
  chapterInfo("战国", -475, -221),
  chapterInfo("秦", -221, -207),
  chapterInfo("西汉", -206, 23, { name: "西汉 · 新莽" }),
  chapterInfo("东汉", 25, 220),
  chapterInfo("三国", 220, 280),
  chapterInfo("两晋", 265, 420),
  chapterInfo("南北朝", 420, 589),
  chapterInfo("隋", 581, 618),
  chapterInfo("唐", 618, 907),
  chapterInfo("五代十国", 907, 979),
  chapterInfo("宋辽金夏", 960, 1279),
  chapterInfo("元", 1271, 1368),
  chapterInfo("明", 1368, 1644),
  chapterInfo("清", 1644, 1911),
  chapterInfo("民国", 1912, 1949),
  chapterInfo("当代", 1949, null),
];

const chapterInfoByName = new Map(
  TIMELINE_CHAPTERS.map((info) => [info.chapter, info]),
);

export const timelineChapterInfo = (
  chapter: TimelineChapter,
): TimelineChapterInfo => chapterInfoByName.get(chapter)!;

export const TIMELINE_RAIL: readonly {
  readonly glyph: string;
  readonly chapters: readonly TimelineChapter[];
}[] = [
  { glyph: "商", chapters: ["商"] },
  { glyph: "周", chapters: ["西周"] },
  { glyph: "春", chapters: ["春秋"] },
  { glyph: "战", chapters: ["战国"] },
  { glyph: "秦", chapters: ["秦"] },
  { glyph: "汉", chapters: ["西汉", "东汉"] },
  { glyph: "三", chapters: ["三国"] },
  { glyph: "晋", chapters: ["两晋"] },
  { glyph: "南", chapters: ["南北朝"] },
  { glyph: "隋", chapters: ["隋"] },
  { glyph: "唐", chapters: ["唐"] },
  { glyph: "五", chapters: ["五代十国"] },
  { glyph: "宋", chapters: ["宋辽金夏"] },
  { glyph: "元", chapters: ["元"] },
  { glyph: "明", chapters: ["明"] },
  { glyph: "清", chapters: ["清"] },
  { glyph: "民", chapters: ["民国"] },
  { glyph: "今", chapters: ["当代"] },
];

/** The final 今 row and the right end of the 总尺. */
export const TIMELINE_NOW_YEAR = new Date().getFullYear();
const SCALE_START_YEAR = -1250;
const GROUP_FOLD_MINIMUM = 3;
const GAP_MINIMUM_YEARS = 20;
const YEAR_FOLD_MINIMUM = 8;
const YEAR_FOLD_VISIBLE = 5;
const GROUP_SUMMARY_LENGTH = 40;

export type TimelineMark = "dot" | "bar" | "multi" | "ring" | "none";

interface RowBase {
  /** React identity; stable while a group opens and closes. */
  readonly key: string;
  readonly chapter: TimelineChapter;
}

export type TimelineEntryRow = RowBase & {
  readonly kind: "entry";
  readonly entry: TimelineEntry;
  readonly year: number;
  /** Null when an earlier row of this year already printed the same text. */
  readonly yearLines: readonly string[] | null;
  readonly mark: TimelineMark;
};

export type TimelineGroupRow = RowBase & {
  readonly kind: "group";
  readonly groupKey: string;
  readonly title: string;
  readonly summary: string;
  readonly entries: readonly TimelineEntry[];
  readonly year: number;
  readonly endYear: number;
  readonly yearLines: readonly string[] | null;
  readonly mark: TimelineMark;
  readonly expanded: boolean;
  /** A measured height belongs to one state of the group. */
  readonly sizeKey: string;
};

export type TimelineRow =
  | (RowBase & { readonly kind: "head" })
  | (RowBase & { readonly kind: "empty" })
  | (RowBase & { readonly kind: "marker" })
  | TimelineEntryRow
  | TimelineGroupRow
  | (RowBase & { readonly kind: "gap"; readonly years: number })
  | (RowBase & {
      readonly kind: "more";
      readonly moreKey: string;
      readonly year: number;
      readonly count: number;
    })
  | (RowBase & { readonly kind: "shelf"; readonly count: number });

export interface TimelineIndex {
  readonly onAxis: ReadonlyMap<TimelineChapter, readonly TimelineEntry[]>;
  readonly shelf: ReadonlyMap<TimelineChapter, readonly TimelineEntry[]>;
  readonly counts: ReadonlyMap<TimelineChapter, number>;
}

export const buildTimelineIndex = (
  entries: readonly TimelineEntry[],
): TimelineIndex => {
  const onAxis = new Map<TimelineChapter, TimelineEntry[]>();
  const shelf = new Map<TimelineChapter, TimelineEntry[]>();
  const counts = new Map<TimelineChapter, number>();
  // The API orders by (startYear, position, id); a stable sort keeps that.
  for (const entry of [...entries].sort((a, b) => a.startYear - b.startYear)) {
    const list = entry.onAxis ? onAxis : shelf;
    const bucket = list.get(entry.chapter);
    if (bucket) bucket.push(entry);
    else list.set(entry.chapter, [entry]);
    counts.set(entry.chapter, (counts.get(entry.chapter) ?? 0) + 1);
  }
  return { onAxis, shelf, counts };
};

const entryMark = (entry: TimelineEntry): TimelineMark => {
  if (entry.disputed) return "ring";
  if (entry.precision === "year") return "dot";
  return entry.precision === "multi" ? "multi" : "bar";
};

export type TimelineFoldItem =
  | { readonly type: "entry"; readonly entry: TimelineEntry }
  | {
      readonly type: "group";
      readonly groupKey: string;
      readonly title: string;
      readonly entries: readonly TimelineEntry[];
    };

/** Folds a group of three or more where its first member stands. */
export const foldTimelineGroups = (
  entries: readonly TimelineEntry[],
  scope: string,
): readonly TimelineFoldItem[] => {
  const members = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    if (entry.groupId === null) continue;
    const list = members.get(entry.groupId);
    if (list) list.push(entry);
    else members.set(entry.groupId, [entry]);
  }
  const emitted = new Set<string>();
  const items: TimelineFoldItem[] = [];
  for (const entry of entries) {
    const group =
      entry.groupId === null ? undefined : members.get(entry.groupId);
    if (
      entry.groupId === null ||
      group === undefined ||
      group.length < GROUP_FOLD_MINIMUM
    ) {
      items.push({ type: "entry", entry });
      continue;
    }
    if (emitted.has(entry.groupId)) continue;
    emitted.add(entry.groupId);
    items.push({
      type: "group",
      groupKey: `${scope}:${entry.groupId}`,
      title: entry.groupTitle ?? entry.title,
      entries: group,
    });
  }
  return items;
};

const itemYear = (item: TimelineFoldItem): number =>
  item.type === "entry" ? item.entry.startYear : item.entries[0]!.startYear;

const itemRank = (item: TimelineFoldItem): number => {
  if (item.type === "group") return 1;
  return item.entry.media === null ? 2 : 0;
};

const groupSummary = (entries: readonly TimelineEntry[]): string => {
  const names: string[] = [];
  let length = 0;
  for (const { title } of entries) {
    if (names.length > 0 && length + title.length > GROUP_SUMMARY_LENGTH) break;
    names.push(title);
    length += title.length + 1;
  }
  const text = names.join("、");
  return names.length < entries.length ? `${text}……` : text;
};

const pushYearCluster = (
  rows: TimelineRow[],
  chapter: TimelineChapter,
  year: number,
  cluster: readonly TimelineFoldItem[],
  expanded: ReadonlySet<string>,
) => {
  // Array.prototype.sort is stable: equal ranks keep the API's position order.
  const ordered = [...cluster].sort((a, b) => itemRank(a) - itemRank(b));
  const moreKey = `more:${chapter}:${year}`;
  const folded = ordered.length >= YEAR_FOLD_MINIMUM && !expanded.has(moreKey);
  const visible = folded ? ordered.slice(0, YEAR_FOLD_VISIBLE) : ordered;
  const printed = new Set<string>();
  const yearText = (start: number, end: number) => {
    const label = formatYearRange(start, end);
    if (printed.has(label)) return null;
    printed.add(label);
    return formatYearLines(start, end);
  };
  for (const item of visible) {
    if (item.type === "entry") {
      const { entry } = item;
      const yearLines = yearText(entry.startYear, entry.endYear);
      rows.push({
        kind: "entry",
        key: `entry:${entry.id}`,
        chapter,
        entry,
        year,
        yearLines,
        // A repeated year stays unmarked; a dispute still reads at its row.
        mark: yearLines === null && !entry.disputed ? "none" : entryMark(entry),
      });
      continue;
    }
    const endYear = Math.max(...item.entries.map((entry) => entry.endYear));
    const yearLines = yearText(year, endYear);
    const isExpanded = expanded.has(item.groupKey);
    const key = `group:${item.groupKey}`;
    rows.push({
      kind: "group",
      key,
      sizeKey: isExpanded ? `${key}:open` : key,
      chapter,
      groupKey: item.groupKey,
      title: item.title,
      summary: groupSummary(item.entries),
      entries: item.entries,
      year,
      endYear,
      yearLines,
      mark: yearLines === null ? "none" : endYear === year ? "dot" : "bar",
      expanded: isExpanded,
    });
  }
  if (folded)
    rows.push({
      kind: "more",
      key: moreKey,
      moreKey,
      chapter,
      year,
      count: ordered.length - YEAR_FOLD_VISIBLE,
    });
};

/**
 * Every row in display order. `expanded` holds the opened group keys and any
 * opened 另 N 条 key; a row's position only ever depends on earlier rows.
 */
export const buildTimelineRows = (
  index: TimelineIndex,
  expanded: ReadonlySet<string> = new Set(),
): readonly TimelineRow[] => {
  const rows: TimelineRow[] = [];
  for (const { chapter } of TIMELINE_CHAPTERS) {
    const axis = index.onAxis.get(chapter) ?? [];
    const shelf = index.shelf.get(chapter) ?? [];
    if (axis.length === 0 && shelf.length === 0)
      rows.push({ kind: "empty", key: `empty:${chapter}`, chapter });
    else {
      rows.push({ kind: "head", key: `head:${chapter}`, chapter });
      const clusters = new Map<number, TimelineFoldItem[]>();
      for (const item of foldTimelineGroups(axis, `axis:${chapter}`)) {
        const year = itemYear(item);
        const cluster = clusters.get(year);
        if (cluster) cluster.push(item);
        else clusters.set(year, [item]);
      }
      let previousYear: number | null = null;
      for (const [year, cluster] of clusters) {
        if (previousYear !== null) {
          const years = elapsedYears(previousYear, year);
          if (years >= GAP_MINIMUM_YEARS)
            rows.push({
              kind: "gap",
              key: `gap:${chapter}:${year}`,
              chapter,
              years,
            });
        }
        pushYearCluster(rows, chapter, year, cluster, expanded);
        previousYear = year;
      }
      if (shelf.length > 0)
        rows.push({
          kind: "shelf",
          key: `shelf:${chapter}`,
          chapter,
          count: shelf.length,
        });
    }
    if (chapter === "当代")
      rows.push({ kind: "marker", key: "marker:now", chapter });
  }
  return rows;
};

export const timelineEntryTag = (
  entry: TimelineEntry,
): { readonly kind: "disputed" | "multi"; readonly text: string } | null => {
  if (entry.disputed) return { kind: "disputed", text: "异说" };
  return entry.precision === "multi" ? { kind: "multi", text: "多期" } : null;
};

export type TimelineRowLayout = "phone" | "tablet" | "wide";

/** Phone meta carries the columns tablet and wide print on their own. */
export const timelineEntryMeta = (
  entry: TimelineEntry,
  layout: TimelineRowLayout,
): string =>
  (layout === "phone"
    ? [entry.dateLabel, entry.province, entry.holder]
    : [entry.dateLabel]
  )
    .filter((part) => part !== null)
    .join(" · ");

/** The 年代 row of a card: absent when a chapter-level entry has no label. */
export const timelineEntryDate = (entry: TimelineEntry): string | null => {
  // A dynasty-only entry states its polity, not a span it does not claim.
  const years =
    entry.precision !== "dynasty"
      ? formatYearRange(entry.startYear, entry.endYear)
      : entry.dateLabel === null
        ? entry.polity
        : null;
  const parts = [years, entry.dateLabel].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};

export interface TimelinePosition {
  readonly chapter: TimelineChapter;
  readonly name: string;
  /** Null only for a chapter that has a head and no on-axis row. */
  readonly yearText: string | null;
  /** The position bar text. */
  readonly label: string;
  /** The year this position writes to the URL; null keeps the last one. */
  readonly year: number | null;
}

const positionOf = (row: TimelineRow): TimelinePosition | null => {
  const info = timelineChapterInfo(row.chapter);
  const at = (name: string, year: number, urlYear: number | null) => ({
    chapter: row.chapter,
    name,
    yearText: formatYear(year),
    label: `${formatYear(year)} · ${name}`,
    year: urlYear,
  });
  switch (row.kind) {
    case "entry":
      return at(row.entry.polity ?? info.shortName, row.year, row.year);
    case "group":
      return at(row.entries[0]!.polity ?? info.shortName, row.year, row.year);
    case "empty":
      return at(info.name, info.startYear, null);
    case "marker":
      return at("今", TIMELINE_NOW_YEAR, null);
    case "shelf":
      return {
        chapter: row.chapter,
        name: info.shortName,
        yearText: "其他",
        label: `${info.shortName} · 其他`,
        year: null,
      };
    default:
      return null;
  }
};

/** What the position bar and the rail bubble read for a row at the top. */
export const timelinePositionAt = (
  rows: readonly TimelineRow[],
  index: number,
): TimelinePosition | null => {
  const row = rows[index];
  if (row === undefined) return null;
  const own = positionOf(row);
  if (own !== null) return own;
  // A head or a gap reads as the row it introduces, 另 N 条 as the row before.
  const step = row.kind === "more" ? -1 : 1;
  for (let at = index + step; at >= 0 && at < rows.length; at += step) {
    const candidate = rows[at]!;
    if (candidate.chapter !== row.chapter) break;
    const position = positionOf(candidate);
    if (position !== null && candidate.kind !== "shelf") return position;
    if (candidate.kind === "shelf") break;
  }
  const info = timelineChapterInfo(row.chapter);
  return {
    chapter: row.chapter,
    name: info.name,
    yearText: null,
    label: info.name,
    year: null,
  };
};

export interface TimelineRailCell {
  readonly glyph: string;
  readonly label: string;
  readonly chapters: readonly TimelineChapter[];
  readonly count: number;
  readonly firstRow: number;
  /** One past the last row of the cell. */
  readonly endRow: number;
}

export const buildRailCells = (
  index: TimelineIndex,
  rows: readonly TimelineRow[],
): readonly TimelineRailCell[] => {
  const first = new Map<TimelineChapter, number>();
  const end = new Map<TimelineChapter, number>();
  rows.forEach((row, at) => {
    if (!first.has(row.chapter)) first.set(row.chapter, at);
    end.set(row.chapter, at + 1);
  });
  return TIMELINE_RAIL.map(({ glyph, chapters }) => ({
    glyph,
    chapters,
    label: chapters
      .map((chapter) => timelineChapterInfo(chapter).name)
      .join("、"),
    count: chapters.reduce(
      (total, chapter) => total + (index.counts.get(chapter) ?? 0),
      0,
    ),
    firstRow: first.get(chapters[0]!) ?? 0,
    endRow: end.get(chapters.at(-1)!) ?? 0,
  }));
};

export const railCellIndexOfChapter = (chapter: TimelineChapter): number =>
  TIMELINE_RAIL.findIndex(({ chapters }) => chapters.includes(chapter));

/** The row a finger selects at `fraction` (0 to 1) down a rail cell. */
export const railRowAt = (cell: TimelineRailCell, fraction: number): number => {
  const span = cell.endRow - cell.firstRow;
  if (span <= 0) return cell.firstRow;
  return Math.min(
    cell.endRow - 1,
    cell.firstRow + Math.floor(Math.max(0, fraction) * span),
  );
};

const isYearRow = (
  row: TimelineRow,
): row is TimelineEntryRow | TimelineGroupRow =>
  row.kind === "entry" || row.kind === "group";

/**
 * The row of `year`, or of the next year that has one. Chapters overlap (三国
 * and 两晋), so the nearest later year wins over the first in display order.
 */
export const rowIndexForYear = (
  rows: readonly TimelineRow[],
  year: number,
): number => {
  let best = -1;
  let bestYear = Number.POSITIVE_INFINITY;
  let last = -1;
  rows.forEach((row, at) => {
    if (!isYearRow(row)) return;
    last = at;
    if (row.year >= year && row.year < bestYear) {
      best = at;
      bestYear = row.year;
    }
  });
  if (best >= 0) return best;
  return last >= 0 ? last : Math.max(0, rows.length - 1);
};

export const rowIndexForChapter = (
  rows: readonly TimelineRow[],
  chapter: TimelineChapter,
): number => {
  const at = rows.findIndex((row) => row.chapter === chapter);
  return at < 0 ? 0 : at;
};

/** A reign choice lands on its own chapter even when another shares the year. */
export const rowIndexInChapter = (
  rows: readonly TimelineRow[],
  chapter: TimelineChapter,
  year: number,
): number => {
  const at = rows.findIndex(
    (row) => row.chapter === chapter && isYearRow(row) && row.year >= year,
  );
  return at < 0 ? rowIndexForChapter(rows, chapter) : at;
};

export interface TimelineReignMatch {
  readonly chapter: TimelineChapter;
  readonly year: number;
  readonly polity: string | null;
  readonly dateLabel: string;
}

/** The first on-axis entry of each chapter whose dateLabel starts with `query`. */
export const lookupReign = (
  index: TimelineIndex,
  query: string,
): readonly TimelineReignMatch[] => {
  const title = query.trim();
  if (title === "") return [];
  const matches: TimelineReignMatch[] = [];
  for (const { chapter } of TIMELINE_CHAPTERS) {
    const entry = index.onAxis
      .get(chapter)
      ?.find(({ dateLabel }) => dateLabel?.startsWith(title));
    if (entry?.dateLabel)
      matches.push({
        chapter,
        year: entry.startYear,
        polity: entry.polity,
        dateLabel: entry.dateLabel,
      });
  }
  return matches;
};

export type TimelineShelfMode = "place" | "name" | "polity";

export interface TimelineShelfSection {
  readonly key: string;
  /** Null for the one flat 按名 list. */
  readonly label: string | null;
  readonly count: number;
  readonly items: readonly TimelineFoldItem[];
}

const compareNames = (a: string, b: string) => a.localeCompare(b, "zh-Hans-CN");

export const buildShelfSections = (
  entries: readonly TimelineEntry[],
  mode: TimelineShelfMode,
): readonly TimelineShelfSection[] => {
  if (mode === "name")
    return [
      {
        key: "name",
        label: null,
        count: entries.length,
        items: foldTimelineGroups(
          [...entries].sort((a, b) => compareNames(a.fullTitle, b.fullTitle)),
          "shelf:name",
        ),
      },
    ];
  const buckets = new Map<string | null, TimelineEntry[]>();
  for (const entry of entries) {
    const key = mode === "place" ? entry.province : entry.polity;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  return [...buckets]
    .sort(([aKey, a], [bKey, b]) => {
      // Entries with no value close the list under 其他.
      if ((aKey === null) !== (bKey === null)) return aKey === null ? 1 : -1;
      return b.length - a.length || compareNames(aKey ?? "", bKey ?? "");
    })
    .map(([key, list]) => ({
      key: `${mode}:${key ?? ""}`,
      label: key ?? "其他",
      count: list.length,
      items: foldTimelineGroups(list, `shelf:${mode}:${key ?? ""}`),
    }));
};

/** The second line of a shelf row: 按地 already says the place. */
export const timelineShelfMeta = (
  entry: TimelineEntry,
  mode: TimelineShelfMode,
): string => {
  const date =
    entry.precision === "dynasty"
      ? entry.dateLabel
      : [entry.dateLabel, formatYearRange(entry.startYear, entry.endYear)]
          .filter((part) => part !== null)
          .join(" ");
  return [date, mode === "place" ? null : entry.province, entry.holder]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
};

const SCALE_SPAN_YEARS = TIMELINE_NOW_YEAR - SCALE_START_YEAR;
const BAR_BUCKET_YEARS = 25;
const BAR_MAX_HEIGHT = 32;
const BAR_MIN_HEIGHT = 2;

/** A year's place on the true-scale 总尺, 0 to 1. */
export const timelineYearFraction = (year: number): number =>
  Math.min(1, Math.max(0, (year - SCALE_START_YEAR) / SCALE_SPAN_YEARS));

export interface TimelineYearBar {
  readonly fraction: number;
  readonly width: number;
  readonly height: number;
}

export const buildYearBars = (
  index: TimelineIndex,
): readonly TimelineYearBar[] => {
  const buckets = new Map<number, number>();
  for (const entries of index.onAxis.values())
    for (const { startYear } of entries) {
      const bucket = Math.floor(
        (startYear - SCALE_START_YEAR) / BAR_BUCKET_YEARS,
      );
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
  const largest = Math.max(1, ...buckets.values());
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([bucket, count]) => ({
      fraction: (bucket * BAR_BUCKET_YEARS) / SCALE_SPAN_YEARS,
      width: BAR_BUCKET_YEARS / SCALE_SPAN_YEARS,
      height: Math.max(
        BAR_MIN_HEIGHT,
        Math.round((count / largest) * BAR_MAX_HEIGHT),
      ),
    }));
};

export interface TimelineChapterSegment {
  readonly chapter: TimelineChapter;
  readonly from: number;
  readonly to: number;
}

/** Chapters that hold entries, proportional to their years on the 总尺. */
export const buildChapterSegments = (
  index: TimelineIndex,
): readonly TimelineChapterSegment[] =>
  TIMELINE_CHAPTERS.filter(
    ({ chapter }) => (index.counts.get(chapter) ?? 0) > 0,
  ).map(({ chapter, startYear, endYear }) => ({
    chapter,
    from: timelineYearFraction(startYear),
    to: timelineYearFraction(endYear ?? TIMELINE_NOW_YEAR),
  }));

export type TimelineTextStyle = "title" | "groupTitle" | "meta" | "column";

/** Width in CSS pixels of a text in one of the row's type styles. */
export type TimelineTextMeasure = (
  text: string,
  style: TimelineTextStyle,
) => number;

export const TIMELINE_TEXT_SIZES: Readonly<Record<TimelineTextStyle, number>> =
  {
    title: 16,
    groupTitle: 15,
    meta: 12,
    column: 13,
  };

/** The character estimate used when no canvas can measure. */
export const estimateTextWidth: TimelineTextMeasure = (text, style) => {
  let units = 0;
  for (const character of text)
    units += (character.codePointAt(0) ?? 0) < 0x2e80 ? 0.55 : 1;
  return units * TIMELINE_TEXT_SIZES[style];
};

/*
 * Phone: start 16 | year 44 | slot 18 | content | end 44 (8 plus the 36 rail).
 * Tablet: start 16 | year 56 | slot 24 | name | 地点 120 | 保管 150 | end 60
 * (16 plus the 44 rail), and the name column keeps 16 of its own on the right.
 * Wide: the list is the table, so year 56 | slot 24 | name | 地点 | 保管 with
 * nothing outside them; a PC window just over 896 px narrows the two columns.
 */
const PHONE_CHROME = 16 + 44 + 18 + 44;
const TABLET_CHROME = 16 + 56 + 24 + 60;
const WIDE_CHROME = 56 + 24;
const NAME_END = 16;
/** Below this a wide table cannot hold a 200 px name beside 120 and 150. */
const WIDE_FULL_COLUMNS_WIDTH = WIDE_CHROME + 200 + NAME_END + 120 + 150;
const TAG_WIDTH = 30;
const MEDIA_GAP = 8;

const atLeast = (minimum: number, value: number) => Math.max(minimum, value);

export interface TimelineColumns {
  readonly place: number;
  readonly holder: number;
}

/** The 地点 and 保管 column widths; phone has neither and never asks. */
export const timelineColumns = (
  layout: TimelineRowLayout,
  listWidth: number,
): TimelineColumns =>
  layout === "wide" && listWidth < WIDE_FULL_COLUMNS_WIDTH
    ? { place: 64, holder: 96 }
    : { place: 120, holder: 150 };

/** The text column of an entry row. */
export const timelineContentWidth = (
  layout: TimelineRowLayout,
  listWidth: number,
): number => {
  if (layout === "phone") return atLeast(120, listWidth - PHONE_CHROME);
  const { place, holder } = timelineColumns(layout, listWidth);
  const chrome = layout === "wide" ? WIDE_CHROME : TABLET_CHROME;
  return atLeast(120, listWidth - chrome - place - holder - NAME_END);
};

/** A group card: past phone it runs across the name and both data columns. */
const timelineGroupWidth = (layout: TimelineRowLayout, listWidth: number) => {
  if (layout === "phone") return timelineContentWidth("phone", listWidth);
  return atLeast(
    120,
    listWidth - (layout === "wide" ? WIDE_CHROME : TABLET_CHROME),
  );
};

export interface TimelineMediaBox {
  readonly width: number;
  readonly height: number;
}

/** Phone images fill the column at 268:179 or 268:357; wider layouts cap at 360 or 180. */
export const timelineMediaBox = (
  media: { readonly width: number; readonly height: number },
  layout: TimelineRowLayout,
  listWidth: number,
): TimelineMediaBox => {
  const portrait = media.height > media.width;
  const column = Math.floor(timelineContentWidth(layout, listWidth));
  if (layout === "phone")
    return {
      width: column,
      height: Math.round(column * ((portrait ? 357 : 179) / 268)),
    };
  const width = Math.min(portrait ? 180 : 360, column);
  return { width, height: Math.round(width * (portrait ? 4 / 3 : 2 / 3)) };
};

const lineCount = (width: number, available: number, maximum: number) =>
  Math.min(maximum, Math.max(1, Math.ceil(width / Math.max(1, available))));

export interface TimelineRowMetrics {
  readonly layout: TimelineRowLayout;
  readonly listWidth: number;
  readonly measure: TimelineTextMeasure;
}

const entryRowHeight = (
  row: TimelineEntryRow,
  { layout, listWidth, measure }: TimelineRowMetrics,
): number => {
  const { entry } = row;
  const content = timelineContentWidth(layout, listWidth);
  const title = entry.onAxis ? entry.title : entry.fullTitle;
  const titleLines = lineCount(measure(title, "title"), content, 2);
  const meta = timelineEntryMeta(entry, layout);
  const tag = timelineEntryTag(entry);
  const metaLines =
    tag !== null
      ? lineCount(measure(meta, "meta"), content - TAG_WIDTH, 2)
      : meta === ""
        ? 0
        : 1;
  const media =
    entry.media === null
      ? 0
      : MEDIA_GAP + timelineMediaBox(entry.media, layout, listWidth).height;
  const gutterLines = row.yearLines?.length ?? 0;
  if (layout === "phone")
    return Math.max(
      20 + 24 * titleLines + (metaLines === 0 ? 0 : 2 + 18 * metaLines) + media,
      13 + 18 * gutterLines,
    );
  const { place, holder } = timelineColumns(layout, listWidth);
  const columns = [
    entry.province === null
      ? 0
      : lineCount(measure(entry.province, "column"), place, 4),
    entry.holder === null
      ? 0
      : lineCount(measure(entry.holder, "column"), holder, 4),
  ];
  return Math.max(
    16 + 24 * titleLines + 18 * metaLines + media,
    11 + 20 * gutterLines,
    11 + 20 * Math.max(...columns) + 8,
  );
};

const groupRowHeight = (
  row: TimelineGroupRow,
  { layout, listWidth, measure }: TimelineRowMetrics,
): number => {
  const count = row.entries.length;
  if (row.expanded) {
    if (layout === "phone") return 4 + 44 + 48 * count + 8 + 8;
    const lines = Math.ceil(count / 2);
    // Frame P2 has no air around the group: head 44, then 4 + lines + 12.
    return layout === "wide"
      ? 44 + 4 + 36 * lines + 12
      : 4 + 44 + 42 * lines + 12 + 8;
  }
  const inner = timelineGroupWidth(layout, listWidth) - 12 - 8;
  const lines = lineCount(measure(row.summary, "meta"), inner, 2);
  // 6 above the card, 8 + 22 + 2 + 10 inside it, 4 + 3 of page edges, 8 below.
  return 63 + 18 * lines;
};

/** The estimated height of a row; a rendered row corrects its own estimate. */
export const estimateRowHeight = (
  row: TimelineRow,
  metrics: TimelineRowMetrics,
): number => {
  switch (row.kind) {
    case "head":
      return 55;
    case "empty":
      return timelineChapterInfo(row.chapter).note === null ? 46 : 64;
    case "marker":
      return 46;
    case "gap":
      return 24;
    case "more":
      return 40;
    case "shelf":
      return 54;
    case "entry":
      return entryRowHeight(row, metrics);
    case "group":
      return groupRowHeight(row, metrics);
  }
};

/** `heights.length + 1` offsets: where each row starts, then the total. */
export const prefixOffsets = (heights: readonly number[]): Float64Array => {
  const offsets = new Float64Array(heights.length + 1);
  heights.forEach((height, at) => {
    offsets[at + 1] = offsets[at]! + height;
  });
  return offsets;
};

/** The row covering offset `y`, clamped to the list. */
export const rowIndexAtOffset = (offsets: Float64Array, y: number): number => {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return 0;
  let low = 0;
  let high = rowCount - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return low;
};

export interface TimelineWindowRange {
  readonly start: number;
  /** One past the last row to render. */
  readonly end: number;
}

export const timelineWindowRange = (
  offsets: Float64Array,
  viewTop: number,
  viewHeight: number,
  overscan: number,
): TimelineWindowRange => {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return { start: 0, end: 0 };
  return {
    start: rowIndexAtOffset(offsets, viewTop - overscan),
    end: Math.min(
      rowCount,
      rowIndexAtOffset(offsets, viewTop + viewHeight + overscan) + 1,
    ),
  };
};
