import { describe, expect, it } from "vitest";

import { MEDIA_SIZES } from "../../media/responsive-media";
import {
  TIMELINE_CHAPTERS,
  TIMELINE_RAIL,
  buildChapterSegments,
  buildRailCells,
  buildShelfSections,
  buildTimelineIndex,
  buildTimelineRows,
  buildYearBars,
  estimateRowHeight,
  estimateTextWidth,
  foldTimelineGroups,
  lookupReign,
  prefixOffsets,
  railCellIndexOfChapter,
  railRowAt,
  rowIndexAtOffset,
  rowIndexForChapter,
  rowIndexForYear,
  rowIndexInChapter,
  timelineChapterInfo,
  timelineColumns,
  timelineContentWidth,
  TIMELINE_NOW_YEAR,
  timelineEntryDate,
  timelineEntryMeta,
  timelineEntryTag,
  timelineMediaBox,
  timelinePositionAt,
  timelineShelfMeta,
  timelineWindowRange,
  timelineYearFraction,
} from "./timeline-model";

import type { MediaId, TimelineChapter, TimelineEntry } from "@moya/contracts";
import type { TimelineRow } from "./timeline-model";

const media = (width: number, height: number) => ({
  alt: "虚构图",
  height,
  id: "media-fixture" as MediaId,
  kind: "image" as const,
  src: "https://media.invalid/fixture.jpg",
  width,
});

let serial = 0;
const entry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry => {
  serial += 1;
  return {
    id: `row-${serial}`,
    title: `虚构南寺碑${serial}`,
    fullTitle: `唐虚构南寺碑${serial}`,
    startYear: 700,
    endYear: 700,
    precision: "year",
    dateLabel: "虚元八年",
    onAxis: true,
    chapter: "唐",
    polity: "唐",
    disputed: false,
    groupId: null,
    groupTitle: null,
    province: "虚构西州",
    holder: "虚构碑林",
    catalogId: null,
    media: null,
    ...overrides,
  } as TimelineEntry;
};

const groupMembers = (
  count: number,
  id: string,
  overrides: Partial<TimelineEntry> = {},
) =>
  Array.from({ length: count }, () =>
    entry({ groupId: id, groupTitle: `虚构${id}诸刻`, ...overrides }),
  );

const kinds = (rows: readonly TimelineRow[]) => rows.map((row) => row.kind);

const inChapter = (rows: readonly TimelineRow[], chapter: TimelineChapter) =>
  rows.filter((row) => row.chapter === chapter);

/** A generated archive larger than the real one, with every row kind. */
const largeDataset = (): readonly TimelineEntry[] => {
  const rows: TimelineEntry[] = [];
  const chapters = TIMELINE_CHAPTERS.filter(
    ({ chapter }) => !["商", "西周", "春秋", "民国", "当代"].includes(chapter),
  );
  chapters.forEach(({ chapter, startYear, endYear }, chapterIndex) => {
    const end = endYear ?? 2000;
    for (let at = 0; at < 120; at += 1) {
      const year = startYear + Math.floor(((end - startYear) * at) / 120);
      const startsAt = year === 0 ? 1 : year;
      rows.push(
        entry({
          chapter,
          polity: chapter,
          startYear: startsAt,
          endYear: at % 5 === 0 ? Math.max(startsAt + 3, 1) : startsAt,
          precision:
            at % 11 === 0
              ? "multi"
              : at % 5 === 0
                ? "reign"
                : at % 7 === 0
                  ? "period"
                  : "year",
          disputed: at % 13 === 0,
          ...(at % 17 === 0
            ? {
                catalogId: `catalog-${chapterIndex}-${at}` as never,
                media: at % 2 === 0 ? media(600, 420) : media(360, 520),
              }
            : {}),
        }),
      );
    }
    rows.push(
      entry({
        chapter,
        polity: chapter,
        onAxis: false,
        precision: "dynasty",
        startYear,
        endYear: end,
        dateLabel: null,
      }),
    );
  });
  rows.push(
    ...groupMembers(23, "yunfeng", {
      chapter: "南北朝",
      startYear: 511,
      endYear: 511,
    }),
    ...groupMembers(10, "shijing", {
      chapter: "东汉",
      startYear: 175,
      endYear: 183,
      precision: "reign",
    }),
    ...groupMembers(4, "longmen", {
      chapter: "南北朝",
      onAxis: false,
      startYear: 500,
      endYear: 520,
    }),
    ...Array.from({ length: 9 }, () =>
      entry({ chapter: "唐", startYear: 720, endYear: 720 }),
    ),
    entry({ chapter: "民国", startYear: 1912, endYear: 1912 }),
    entry({ chapter: "民国", startYear: 1940, endYear: 1940 }),
  );
  return rows;
};

const metrics = {
  layout: "phone",
  listWidth: 390,
  measure: estimateTextWidth,
} as const;

const CONTRACT_CHAPTERS = [
  "商",
  "西周",
  "春秋",
  "战国",
  "秦",
  "西汉",
  "东汉",
  "三国",
  "两晋",
  "南北朝",
  "隋",
  "唐",
  "五代十国",
  "宋辽金夏",
  "元",
  "明",
  "清",
  "民国",
  "当代",
];

describe("chapter table", () => {
  it("keeps the contract's chapter order and the display ranges", () => {
    expect(TIMELINE_CHAPTERS.map(({ chapter }) => chapter)).toEqual(
      CONTRACT_CHAPTERS,
    );
    expect(timelineChapterInfo("商").name).toBe("晚商");
    expect(timelineChapterInfo("西汉").name).toBe("西汉 · 新莽");
    expect(timelineChapterInfo("西汉").shortName).toBe("西汉");
    expect(timelineChapterInfo("当代").endYear).toBeNull();
  });

  it("maps the rail glyphs in order onto every chapter once", () => {
    expect(TIMELINE_RAIL.map(({ glyph }) => glyph).join("")).toBe(
      "商周春战秦汉三晋南隋唐五宋元明清民今",
    );
    expect(TIMELINE_RAIL.flatMap(({ chapters }) => chapters)).toEqual(
      CONTRACT_CHAPTERS,
    );
    expect(railCellIndexOfChapter("东汉")).toBe(railCellIndexOfChapter("西汉"));
  });
});

describe("rows", () => {
  it("gives empty chapters a text row and ends on the 今 marker", () => {
    const rows = buildTimelineRows(buildTimelineIndex([entry()]));
    expect(rows[0]).toMatchObject({ kind: "empty", chapter: "商" });
    expect(rows.at(-2)).toMatchObject({ kind: "empty", chapter: "当代" });
    expect(rows.at(-1)).toMatchObject({ kind: "marker", chapter: "当代" });
    expect(inChapter(rows, "唐").map(({ kind }) => kind)).toEqual([
      "head",
      "entry",
    ]);
  });

  it("gives a chapter with only shelf entries a head and its shelf", () => {
    const rows = buildTimelineRows(
      buildTimelineIndex([
        entry({
          chapter: "战国",
          onAxis: false,
          startYear: -300,
          endYear: -300,
        }),
        entry({
          chapter: "战国",
          onAxis: false,
          startYear: -250,
          endYear: -250,
        }),
      ]),
    );
    expect(kinds(inChapter(rows, "战国"))).toEqual(["head", "shelf"]);
    expect(inChapter(rows, "战国")[1]).toMatchObject({ count: 2 });
  });

  it("puts the shelf after the chapter's on-axis rows", () => {
    const rows = buildTimelineRows(
      buildTimelineIndex([
        entry({ onAxis: false, startYear: 640, endYear: 640 }),
        entry({ startYear: 700, endYear: 700 }),
      ]),
    );
    expect(kinds(inChapter(rows, "唐"))).toEqual(["head", "entry", "shelf"]);
  });

  it("orders one year by media, then group, then position", () => {
    const plainFirst = entry({ title: "甲" });
    const group = groupMembers(3, "g1");
    const withMedia = entry({
      title: "乙",
      catalogId: "catalog-a" as never,
      media: media(600, 400),
    });
    const plainLast = entry({ title: "丙" });
    const rows = inChapter(
      buildTimelineRows(
        buildTimelineIndex([plainFirst, ...group, withMedia, plainLast]),
      ),
      "唐",
    ).slice(1);
    expect(
      rows.map((row) =>
        row.kind === "entry"
          ? row.entry.title
          : row.kind === "group"
            ? "组"
            : row.kind,
      ),
    ).toEqual(["乙", "组", "甲", "丙"]);
  });

  it("prints each year text once in a year and marks only its first row", () => {
    const rows = inChapter(
      buildTimelineRows(
        buildTimelineIndex([
          entry({ startYear: 147, endYear: 147 }),
          entry({ startYear: 147, endYear: 147 }),
          entry({
            startYear: 147,
            endYear: 149,
            precision: "reign",
            chapter: "唐",
          }),
          entry({ startYear: 147, endYear: 147, disputed: true }),
        ]),
      ),
      "唐",
    ).slice(1);
    expect(
      rows.map((row) => (row.kind === "entry" ? row.yearLines : "other")),
    ).toEqual([["147"], null, ["147", "–149"], null]);
    expect(
      rows.map((row) => (row.kind === "entry" ? row.mark : "other")),
    ).toEqual(["dot", "none", "bar", "ring"]);
  });

  it("picks marks from precision, with a dispute overriding", () => {
    const marks = (overrides: Partial<TimelineEntry>) => {
      const rows = buildTimelineRows(buildTimelineIndex([entry(overrides)]));
      return rows.find((row) => row.kind === "entry");
    };
    expect(marks({ precision: "year" })).toMatchObject({ mark: "dot" });
    expect(marks({ precision: "reign" })).toMatchObject({ mark: "bar" });
    expect(marks({ precision: "period" })).toMatchObject({ mark: "bar" });
    expect(marks({ precision: "multi" })).toMatchObject({ mark: "multi" });
    expect(marks({ precision: "multi", disputed: true })).toMatchObject({
      mark: "ring",
    });
  });

  it("adds gap rows of 20 or more inside a chapter, never across chapters", () => {
    const rows = buildTimelineRows(
      buildTimelineIndex([
        entry({ chapter: "西汉", startYear: -149, endYear: -149 }),
        entry({ chapter: "西汉", startYear: -56, endYear: -56 }),
        entry({ chapter: "西汉", startYear: -26, endYear: -26 }),
        entry({ chapter: "西汉", startYear: -7, endYear: -7 }),
        entry({ chapter: "西汉", startYear: 7, endYear: 7 }),
        entry({ chapter: "东汉", startYear: 200, endYear: 200 }),
      ]),
    );
    expect(
      rows.filter((row) => row.kind === "gap").map((row) => row.years),
    ).toEqual([93, 30]);
    expect(kinds(inChapter(rows, "东汉"))).toEqual(["head", "entry"]);
  });

  it("does not count a gap against a year the group has folded away", () => {
    const rows = inChapter(
      buildTimelineRows(
        buildTimelineIndex([
          entry({ startYear: 640, endYear: 640 }),
          ...groupMembers(3, "g2", { startYear: 650, endYear: 700 }),
          entry({ startYear: 660, endYear: 660 }),
        ]),
      ),
      "唐",
    ).slice(1);
    expect(kinds(rows)).toEqual(["entry", "group", "entry"]);
  });
});

describe("group folding", () => {
  it("folds three members and leaves two alone", () => {
    const rows = inChapter(
      buildTimelineRows(
        buildTimelineIndex([
          ...groupMembers(3, "fold"),
          ...groupMembers(2, "keep", { startYear: 701, endYear: 701 }),
        ]),
      ),
      "唐",
    );
    expect(kinds(rows)).toEqual(["head", "group", "entry", "entry"]);
    expect(rows[1]).toMatchObject({
      expanded: false,
      title: "虚构fold诸刻",
      mark: "dot",
    });
  });

  it("folds a group spanning years under its first member with a reign bar", () => {
    const members = [
      entry({
        groupId: "s",
        groupTitle: "虚构石经",
        startYear: 175,
        endYear: 175,
      }),
      entry({
        groupId: "s",
        groupTitle: "虚构石经",
        startYear: 176,
        endYear: 180,
      }),
      entry({
        groupId: "s",
        groupTitle: "虚构石经",
        startYear: 178,
        endYear: 183,
      }),
    ];
    const rows = inChapter(
      buildTimelineRows(buildTimelineIndex(members)),
      "唐",
    );
    expect(rows[1]).toMatchObject({
      kind: "group",
      year: 175,
      endYear: 183,
      mark: "bar",
      yearLines: ["175", "–183"],
    });
  });

  it("summarises whole member names and marks what it cuts", () => {
    const long = groupMembers(23, "yunfeng");
    const row = buildTimelineRows(buildTimelineIndex(long)).find(
      (candidate) => candidate.kind === "group",
    );
    expect(row?.kind === "group" && row.summary.endsWith("……")).toBe(true);
    const short = groupMembers(3, "short");
    const shortRow = buildTimelineRows(buildTimelineIndex(short)).find(
      (candidate) => candidate.kind === "group",
    );
    expect(shortRow?.kind === "group" && shortRow.summary).toBe(
      short.map(({ title }) => title).join("、"),
    );
  });

  it("treats on-axis and shelf members of one id separately", () => {
    const items = foldTimelineGroups(groupMembers(4, "g3"), "scope");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "group", groupKey: "scope:g3" });
    const index = buildTimelineIndex([
      ...groupMembers(2, "split"),
      ...groupMembers(3, "split", { onAxis: false }),
    ]);
    const rows = inChapter(buildTimelineRows(index), "唐");
    expect(kinds(rows)).toEqual(["head", "entry", "entry", "shelf"]);
  });

  it("keeps rows above and below in order when a group expands", () => {
    const dataset = largeDataset();
    const index = buildTimelineIndex(dataset);
    const collapsed = buildTimelineRows(index);
    const groupAt = collapsed.findIndex((row) => row.kind === "group");
    const group = collapsed[groupAt];
    if (group?.kind !== "group") throw new Error("No group row");
    const opened = buildTimelineRows(index, new Set([group.groupKey]));

    expect(opened).toHaveLength(collapsed.length);
    expect(opened.map(({ key }) => key)).toEqual(
      collapsed.map(({ key }) => key),
    );
    expect(opened[groupAt]).toMatchObject({ kind: "group", expanded: true });

    const collapsedHeights = collapsed.map((row) =>
      estimateRowHeight(row, metrics),
    );
    const openedHeights = opened.map((row) => estimateRowHeight(row, metrics));
    const before = prefixOffsets(collapsedHeights);
    const after = prefixOffsets(openedHeights);
    const growth = openedHeights[groupAt]! - collapsedHeights[groupAt]!;
    expect(growth).toBeGreaterThan(0);
    for (let at = 0; at <= groupAt; at += 1) expect(after[at]).toBe(before[at]);
    for (let at = groupAt + 1; at < before.length; at += 1)
      expect(after[at]).toBe(before[at]! + growth);
    for (let at = 1; at < after.length; at += 1)
      expect(after[at]).toBeGreaterThan(after[at - 1]!);
  });
});

describe("a crowded year", () => {
  const crowded = (count: number) =>
    Array.from({ length: count }, () =>
      entry({ startYear: 720, endYear: 720 }),
    );

  it("shows every row of a year, however many share it", () => {
    for (const count of [7, 8, 9, 40]) {
      const rows = inChapter(
        buildTimelineRows(buildTimelineIndex(crowded(count))),
        "唐",
      );
      expect(kinds(rows)).toEqual([
        "head",
        ...Array.from({ length: count }, () => "entry"),
      ]);
    }
  });

  it("folds only a group, in the media, group, text order", () => {
    const withMedia = entry({
      startYear: 720,
      endYear: 720,
      catalogId: "catalog-crowded" as never,
      media: media(600, 400),
    });
    const rows = inChapter(
      buildTimelineRows(
        buildTimelineIndex([
          ...crowded(6),
          ...groupMembers(3, "g4", { startYear: 720, endYear: 720 }),
          ...groupMembers(2, "pair", { startYear: 720, endYear: 720 }),
          withMedia,
        ]),
      ),
      "唐",
    ).slice(1);
    expect(kinds(rows)).toEqual([
      "entry",
      "group",
      ...Array.from({ length: 8 }, () => "entry"),
    ]);
    expect(rows[0]).toMatchObject({ kind: "entry", entry: withMedia });
    expect(rows[1]).toMatchObject({ kind: "group", groupKey: "axis:唐:g4" });
  });

  it("reads each of its rows as that year, and jumps to its first row", () => {
    const list = buildTimelineRows(
      buildTimelineIndex([
        ...crowded(12),
        entry({ startYear: 730, endYear: 730 }),
      ]),
    );
    const first = list.findIndex((row) => row.kind === "entry");
    for (let at = first; at < first + 12; at += 1)
      expect(timelinePositionAt(list, at)).toMatchObject({
        label: "720 · 唐",
        year: 720,
      });
    expect(rowIndexForYear(list, 720)).toBe(first);
    expect(rowIndexForYear(list, 721)).toBe(first + 12);
  });
});

describe("positions", () => {
  const dataset = largeDataset();
  const index = buildTimelineIndex(dataset);
  const rows = buildTimelineRows(index);

  it("covers every row kind in the generated dataset", () => {
    expect(new Set(kinds(rows))).toEqual(
      new Set(["head", "empty", "marker", "entry", "group", "gap", "shelf"]),
    );
    expect(new Set(rows.map(({ key }) => key)).size).toBe(rows.length);
  });

  it("reads the row's own year and polity", () => {
    const row = buildTimelineRows(
      buildTimelineIndex([
        entry({
          startYear: 511,
          endYear: 511,
          polity: "北魏",
          chapter: "南北朝",
        }),
      ]),
    );
    const at = row.findIndex((candidate) => candidate.kind === "entry");
    expect(timelinePositionAt(row, at)).toMatchObject({
      label: "511 · 北魏",
      year: 511,
    });
  });

  it("reads a head and a gap as the row they introduce", () => {
    const list = buildTimelineRows(
      buildTimelineIndex([
        entry({
          chapter: "西汉",
          polity: "西汉",
          startYear: -149,
          endYear: -149,
        }),
        entry({
          chapter: "西汉",
          polity: "西汉",
          startYear: -56,
          endYear: -56,
        }),
      ]),
    );
    const head = list.findIndex((row) => row.key === "head:西汉");
    const gap = list.findIndex((row) => row.kind === "gap");
    expect(timelinePositionAt(list, head)?.label).toBe("前149 · 西汉");
    expect(timelinePositionAt(list, gap)?.label).toBe("前56 · 西汉");
  });

  it("reads a shelf, an empty chapter and the final marker", () => {
    const list = buildTimelineRows(
      buildTimelineIndex([entry({ onAxis: false, chapter: "唐" })]),
    );
    const shelf = list.findIndex((row) => row.kind === "shelf");
    expect(timelinePositionAt(list, shelf)).toMatchObject({
      label: "唐 · 其他",
      year: null,
    });
    expect(timelinePositionAt(list, 0)).toMatchObject({
      label: "约前1250 · 晚商",
      year: null,
    });
    expect(timelinePositionAt(list, list.length - 1)?.label).toBe("2026 · 今");
    const head = list.findIndex((row) => row.key === "head:唐");
    expect(timelinePositionAt(list, head)?.label).toBe("唐");
    expect(timelinePositionAt(list, list.length)).toBeNull();
  });

  it("lands a year with no entry on the next entry", () => {
    const list = buildTimelineRows(
      buildTimelineIndex([
        entry({ startYear: 700, endYear: 700 }),
        entry({ startYear: 720, endYear: 720 }),
      ]),
    );
    const year = (target: number) => {
      const row = list[rowIndexForYear(list, target)];
      return row?.kind === "entry" ? row.entry.startYear : null;
    };
    expect(year(700)).toBe(700);
    expect(year(701)).toBe(720);
    expect(year(-300)).toBe(700);
    // Past the last entry the jump rests on it.
    expect(year(2000)).toBe(720);
  });

  it("prefers the nearest later year across overlapping chapters", () => {
    const list = buildTimelineRows(
      buildTimelineIndex([
        entry({ chapter: "三国", startYear: 270, endYear: 270 }),
        entry({ chapter: "两晋", startYear: 266, endYear: 266 }),
      ]),
    );
    expect(list[rowIndexForYear(list, 265)]).toMatchObject({
      chapter: "两晋",
      year: 266,
    });
    expect(rowIndexInChapter(list, "三国", 265)).toBe(
      list.findIndex((row) => row.kind === "entry" && row.chapter === "三国"),
    );
  });

  it("finds a chapter's first row", () => {
    expect(rows[rowIndexForChapter(rows, "东汉")]?.key).toBe("head:东汉");
    expect(rows[rowIndexForChapter(rows, "春秋")]?.key).toBe("empty:春秋");
  });

  it("partitions the rows into rail cells that count their chapters", () => {
    const cells = buildRailCells(index, rows);
    expect(cells).toHaveLength(18);
    expect(cells[0]).toMatchObject({ glyph: "商", count: 0 });
    expect(cells[0]?.firstRow).toBe(0);
    cells.slice(1).forEach((cell, at) => {
      expect(cell.firstRow).toBe(cells[at]?.endRow);
    });
    expect(cells.at(-1)?.endRow).toBe(rows.length);
    const han = cells.find(({ glyph }) => glyph === "汉");
    expect(han?.count).toBe(
      (index.counts.get("西汉") ?? 0) + (index.counts.get("东汉") ?? 0),
    );
    expect(han?.label).toBe("西汉 · 新莽、东汉");
  });

  it("maps a finger inside a cell onto its rows", () => {
    const cell = {
      glyph: "唐",
      label: "唐",
      chapters: ["唐"] as const,
      count: 10,
      firstRow: 100,
      endRow: 110,
    };
    expect(railRowAt(cell, 0)).toBe(100);
    expect(railRowAt(cell, 0.55)).toBe(105);
    expect(railRowAt(cell, 1)).toBe(109);
    expect(railRowAt(cell, -1)).toBe(100);
    expect(railRowAt({ ...cell, endRow: 100 }, 0.5)).toBe(100);
  });
});

describe("reign lookup", () => {
  const index = buildTimelineIndex([
    entry({
      chapter: "东汉",
      dateLabel: "太玄三年",
      startYear: 90,
      endYear: 90,
    }),
    entry({
      chapter: "东汉",
      dateLabel: "太玄五年",
      startYear: 92,
      endYear: 92,
    }),
    entry({
      chapter: "唐",
      dateLabel: "太玄元年",
      startYear: 700,
      endYear: 700,
    }),
    entry({
      chapter: "唐",
      dateLabel: "开宁八年",
      startYear: 720,
      endYear: 720,
    }),
    entry({
      chapter: "元",
      dateLabel: "传统定年开宁",
      startYear: 1300,
      endYear: 1300,
    }),
    entry({ chapter: "元", dateLabel: null, startYear: 1301, endYear: 1301 }),
    entry({ chapter: "明", dateLabel: "太玄", onAxis: false }),
  ]);

  it("returns one match for a reign in one chapter", () => {
    expect(lookupReign(index, "开宁")).toEqual([
      { chapter: "唐", year: 720, polity: "唐", dateLabel: "开宁八年" },
    ]);
  });

  it("returns a choice for each chapter that shares a reign title", () => {
    expect(
      lookupReign(index, " 太玄 ").map(({ chapter, year }) => [chapter, year]),
    ).toEqual([
      ["东汉", 90],
      ["唐", 700],
    ]);
  });

  it("returns nothing for an unknown or empty reign", () => {
    expect(lookupReign(index, "没有")).toEqual([]);
    expect(lookupReign(index, "   ")).toEqual([]);
  });
});

describe("the shelf", () => {
  const entries = [
    entry({ onAxis: false, province: "虚构东州", fullTitle: "唐丙碑" }),
    entry({ onAxis: false, province: "虚构西州", fullTitle: "唐甲碑" }),
    entry({ onAxis: false, province: "虚构西州", fullTitle: "唐乙碑" }),
    entry({ onAxis: false, province: null, fullTitle: "唐丁碑", polity: null }),
  ];

  it("sections by place, largest first, with no-value entries last", () => {
    const sections = buildShelfSections(entries, "place");
    expect(sections.map(({ label, count }) => [label, count])).toEqual([
      ["虚构西州", 2],
      ["虚构东州", 1],
      ["其他", 1],
    ]);
  });

  it("sections by polity", () => {
    const sections = buildShelfSections(entries, "polity");
    expect(sections.map(({ label }) => label)).toEqual(["唐", "其他"]);
  });

  it("lists by name without sections", () => {
    const [section] = buildShelfSections(entries, "name");
    expect(section?.label).toBeNull();
    expect(section?.count).toBe(4);
    expect(section?.items).toHaveLength(4);
  });

  it("folds a group inside its section", () => {
    const sections = buildShelfSections(
      groupMembers(3, "shelfgroup", { onAxis: false }),
      "place",
    );
    expect(sections[0]?.items).toHaveLength(1);
    expect(sections[0]?.items[0]).toMatchObject({ type: "group" });
  });

  it("omits what a section already says and any missing value", () => {
    const row = entry({
      onAxis: false,
      precision: "period",
      startYear: 712,
      endYear: 756,
      dateLabel: "虚宗朝",
      province: "虚构西州",
      holder: "虚构昭陵",
    });
    expect(timelineShelfMeta(row, "place")).toBe("虚宗朝 712–756 · 虚构昭陵");
    expect(timelineShelfMeta(row, "name")).toBe(
      "虚宗朝 712–756 · 虚构西州 · 虚构昭陵",
    );
    expect(
      timelineShelfMeta(
        entry({
          onAxis: false,
          precision: "dynasty",
          dateLabel: null,
          province: null,
          holder: null,
        }),
        "place",
      ),
    ).toBe("");
  });
});

describe("row text", () => {
  it("joins phone meta and omits a missing value", () => {
    expect(timelineEntryMeta(entry(), "phone")).toBe(
      "虚元八年 · 虚构西州 · 虚构碑林",
    );
    expect(timelineEntryMeta(entry({ province: null }), "phone")).toBe(
      "虚元八年 · 虚构碑林",
    );
    expect(timelineEntryMeta(entry(), "tablet")).toBe("虚元八年");
  });

  it("tags a dispute over a multi-period entry", () => {
    expect(timelineEntryTag(entry())).toBeNull();
    expect(timelineEntryTag(entry({ precision: "multi" }))).toEqual({
      kind: "multi",
      text: "多期",
    });
    expect(
      timelineEntryTag(entry({ precision: "multi", disputed: true })),
    ).toEqual({ kind: "disputed", text: "异说" });
  });

  it("writes a card's date from what the entry knows", () => {
    expect(timelineEntryDate(entry({ startYear: 511, endYear: 511 }))).toBe(
      "511 · 虚元八年",
    );
    expect(
      timelineEntryDate(
        entry({
          startYear: 147,
          endYear: 149,
          precision: "reign",
          dateLabel: null,
        }),
      ),
    ).toBe("147–149");
    expect(
      timelineEntryDate(
        entry({ precision: "dynasty", dateLabel: "唐代", onAxis: false }),
      ),
    ).toBe("唐代");
    expect(
      timelineEntryDate(
        entry({ precision: "dynasty", dateLabel: null, onAxis: false }),
      ),
    ).toBe("唐");
    expect(
      timelineEntryDate(
        entry({
          precision: "dynasty",
          dateLabel: null,
          onAxis: false,
          polity: null,
        }),
      ),
    ).toBeNull();
  });
});

describe("row heights", () => {
  const row = (overrides: Partial<TimelineEntry>) => {
    const found = buildTimelineRows(
      buildTimelineIndex([entry(overrides)]),
    ).find((candidate) => candidate.kind === "entry");
    if (found === undefined) throw new Error("No entry row");
    return found;
  };

  it("matches the frames on a 390 phone", () => {
    expect(timelineContentWidth("phone", 390)).toBe(268);
    expect(estimateRowHeight(row({ title: "虚构南寺碑" }), metrics)).toBe(64);
    expect(
      estimateRowHeight(row({ title: "虚构南寺碑".repeat(6) }), metrics),
    ).toBe(88);
    expect(
      estimateRowHeight(
        row({
          title: "虚构南寺碑",
          catalogId: "catalog-a" as never,
          media: media(600, 420),
        }),
        metrics,
      ),
    ).toBe(64 + 8 + 179);
    expect(
      estimateRowHeight(
        row({
          title: "虚构南寺碑",
          catalogId: "catalog-a" as never,
          media: media(360, 520),
        }),
        metrics,
      ),
    ).toBe(64 + 8 + 357);
    expect(
      estimateRowHeight({ kind: "head", key: "h", chapter: "唐" }, metrics),
    ).toBe(55);
    expect(
      estimateRowHeight(
        { kind: "gap", key: "g", chapter: "唐", years: 30 },
        metrics,
      ),
    ).toBe(24);
    expect(
      estimateRowHeight(
        { kind: "shelf", key: "s", chapter: "唐", count: 3 },
        metrics,
      ),
    ).toBe(54);
    expect(
      estimateRowHeight({ kind: "empty", key: "e", chapter: "商" }, metrics),
    ).toBe(64);
    expect(
      estimateRowHeight({ kind: "empty", key: "e", chapter: "春秋" }, metrics),
    ).toBe(46);
    expect(
      estimateRowHeight({ kind: "marker", key: "m", chapter: "当代" }, metrics),
    ).toBe(46);
  });

  it("wraps a tagged meta to two lines and keeps a plain meta on one", () => {
    const longLabel = "虚构定年".repeat(12);
    expect(
      estimateRowHeight(
        row({ title: "虚构南寺碑", dateLabel: longLabel }),
        metrics,
      ),
    ).toBe(64);
    expect(
      estimateRowHeight(
        row({ title: "虚构南寺碑", dateLabel: longLabel, disputed: true }),
        metrics,
      ),
    ).toBe(82);
  });

  it("scales phone images with the column and keeps the tablet boxes", () => {
    expect(timelineMediaBox(media(600, 420), "phone", 430)).toEqual({
      width: 308,
      height: Math.round((308 * 179) / 268),
    });
    expect(timelineMediaBox(media(600, 420), "tablet", 834)).toEqual({
      width: 360,
      height: 240,
    });
    expect(timelineMediaBox(media(360, 520), "tablet", 834)).toEqual({
      width: 180,
      height: 240,
    });
    expect(timelineMediaBox(media(600, 600), "phone", 390).height).toBe(179);
  });

  it("uses the tablet row and its data columns", () => {
    const tablet = { ...metrics, layout: "tablet", listWidth: 834 } as const;
    expect(timelineContentWidth("tablet", 834)).toBe(392);
    expect(estimateRowHeight(row({ title: "虚构南寺碑" }), tablet)).toBe(58);
    expect(
      estimateRowHeight(
        row({
          title: "虚构南寺碑",
          catalogId: "catalog-a" as never,
          media: media(600, 420),
        }),
        tablet,
      ),
    ).toBe(58 + 8 + 240);
    // 32 characters of 13 px in a 150 column take three lines.
    expect(
      estimateRowHeight(
        row({ title: "虚构南寺碑", holder: "虚构".repeat(16) }),
        tablet,
      ),
    ).toBe(11 + 60 + 8);
  });

  it("uses the wide table and narrows its columns in a small window", () => {
    const wide = { ...metrics, layout: "wide", listWidth: 996 } as const;
    expect(timelineColumns("wide", 996)).toEqual({ place: 120, holder: 150 });
    expect(timelineColumns("wide", 566)).toEqual({ place: 120, holder: 150 });
    expect(timelineColumns("wide", 565)).toEqual({ place: 64, holder: 96 });
    expect(timelineColumns("tablet", 444)).toEqual({ place: 120, holder: 150 });
    // Frame P1's name column is 646, and 16 of that is its own right padding.
    expect(timelineContentWidth("wide", 996)).toBe(630);
    expect(timelineContentWidth("wide", 444)).toBe(188);
    expect(estimateRowHeight(row({ title: "虚构南寺碑" }), wide)).toBe(58);
    expect(timelineMediaBox(media(600, 420), "wide", 996)).toEqual({
      width: 360,
      height: 240,
    });
    expect(timelineMediaBox(media(360, 520), "wide", 996)).toEqual({
      width: 180,
      height: 240,
    });
    expect(
      estimateRowHeight(
        row({
          title: "虚构南寺碑",
          catalogId: "catalog-a" as never,
          media: media(600, 420),
        }),
        wide,
      ),
    ).toBe(58 + 8 + 240);
    // The narrowed 保管 column takes more lines for the same text.
    const holder = row({ title: "虚构南寺碑", holder: "虚构".repeat(16) });
    expect(estimateRowHeight(holder, wide)).toBe(11 + 60 + 8);
    expect(estimateRowHeight(holder, { ...wide, listWidth: 444 })).toBe(
      11 + 80 + 8,
    );
  });

  it("sizes an opened group as frame P2 does", () => {
    const wide = { ...metrics, layout: "wide", listWidth: 996 } as const;
    const index = buildTimelineIndex(groupMembers(23, "yunfeng"));
    const fold = buildTimelineRows(index).find(
      (candidate) => candidate.kind === "group",
    )!;
    expect(estimateRowHeight(fold, wide)).toBe(81);
    const key = fold.kind === "group" ? fold.groupKey : "";
    const open = buildTimelineRows(index, new Set([key])).find(
      (candidate) => candidate.kind === "group",
    )!;
    expect(estimateRowHeight(open, wide)).toBe(44 + 448);
  });

  it("sizes a group fold and an opened group", () => {
    const members = groupMembers(23, "yunfeng");
    const index = buildTimelineIndex(members);
    const find = (rows: readonly TimelineRow[]) =>
      rows.find((candidate) => candidate.kind === "group")!;
    const closed = find(buildTimelineRows(index));
    expect(estimateRowHeight(closed, metrics)).toBe(99);
    const key = closed.kind === "group" ? closed.groupKey : "";
    const open = find(buildTimelineRows(index, new Set([key])));
    expect(estimateRowHeight(open, metrics)).toBe(64 + 48 * 23);
    expect(
      estimateRowHeight(open, { ...metrics, layout: "tablet", listWidth: 834 }),
    ).toBe(68 + 42 * 12);
    expect(open.kind === "group" && open.sizeKey).toBe(
      closed.kind === "group" ? `${closed.sizeKey}:open` : "",
    );
  });

  it("estimates text by character class", () => {
    expect(estimateTextWidth("碑碑", "title")).toBe(32);
    expect(estimateTextWidth("ab", "meta")).toBeCloseTo(13.2);
  });
});

describe("window arithmetic", () => {
  const offsets = prefixOffsets([10, 20, 30, 40]);

  it("builds prefix offsets", () => {
    expect([...offsets]).toEqual([0, 10, 30, 60, 100]);
    expect([...prefixOffsets([])]).toEqual([0]);
  });

  it("finds the row at an offset by binary search and clamps", () => {
    expect(rowIndexAtOffset(offsets, -5)).toBe(0);
    expect(rowIndexAtOffset(offsets, 0)).toBe(0);
    expect(rowIndexAtOffset(offsets, 9.5)).toBe(0);
    expect(rowIndexAtOffset(offsets, 10)).toBe(1);
    expect(rowIndexAtOffset(offsets, 59)).toBe(2);
    expect(rowIndexAtOffset(offsets, 60)).toBe(3);
    expect(rowIndexAtOffset(offsets, 1000)).toBe(3);
    expect(rowIndexAtOffset(prefixOffsets([]), 0)).toBe(0);
  });

  it("renders the viewport plus overscan", () => {
    expect(timelineWindowRange(offsets, 30, 10, 0)).toEqual({
      start: 2,
      end: 3,
    });
    expect(timelineWindowRange(offsets, 30, 10, 25)).toEqual({
      start: 0,
      end: 4,
    });
    expect(timelineWindowRange(offsets, 0, 1000, 600)).toEqual({
      start: 0,
      end: 4,
    });
    expect(timelineWindowRange(prefixOffsets([]), 0, 100, 10)).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("stays small over a large generated list", () => {
    const rows = buildTimelineRows(buildTimelineIndex(largeDataset()));
    const large = prefixOffsets(
      rows.map((row) => estimateRowHeight(row, metrics)),
    );
    const middle = large[Math.floor(rows.length / 2)]!;
    const range = timelineWindowRange(large, middle, 800, 600);
    expect(rows.length).toBeGreaterThan(1500);
    expect(range.end - range.start).toBeLessThan(80);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(rows.length);
  });
});

describe("the row image's sizes", () => {
  it("follows each layout's box and bounds a panorama", () => {
    expect(MEDIA_SIZES.timelineRow({ width: 600, height: 420 })).toBe(
      "(min-width: 768px) 360px, calc(100vw - 122px)",
    );
    expect(MEDIA_SIZES.timelineRow({ width: 360, height: 610 })).toBe(
      "(min-width: 768px) 180px, calc(100vw - 122px)",
    );
    expect(MEDIA_SIZES.timelineRow({ width: 960, height: 280 })).toBe(
      "(min-width: 768px) 720px, calc(200vw - 244px)",
    );
  });
});

describe("the 总尺", () => {
  it("places years on the true scale", () => {
    expect(timelineYearFraction(-1250)).toBe(0);
    expect(timelineYearFraction(TIMELINE_NOW_YEAR)).toBe(1);
    expect(timelineYearFraction(-475)).toBeCloseTo(775 / 3276);
    expect(timelineYearFraction(-3000)).toBe(0);
  });

  it("buckets on-axis rows and scales bars to the tallest", () => {
    const index = buildTimelineIndex([
      ...Array.from({ length: 16 }, () =>
        entry({ startYear: 720, endYear: 720 }),
      ),
      entry({ startYear: 100, endYear: 100, chapter: "东汉" }),
      entry({ startYear: 300, endYear: 300, chapter: "两晋", onAxis: false }),
    ]);
    const bars = buildYearBars(index);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.height).toBe(2);
    expect(bars[1]?.height).toBe(32);
    expect(bars[0]?.fraction).toBeLessThan(bars[1]!.fraction);
  });

  it("segments only the chapters that hold entries", () => {
    const segments = buildChapterSegments(
      buildTimelineIndex([
        entry({ chapter: "秦", startYear: -210, endYear: -210 }),
        entry({ chapter: "当代", startYear: 1950, endYear: 1950 }),
      ]),
    );
    expect(segments.map(({ chapter }) => chapter)).toEqual(["秦", "当代"]);
    expect(segments[0]?.from).toBeCloseTo(timelineYearFraction(-221));
    expect(segments[1]?.to).toBe(1);
  });
});
