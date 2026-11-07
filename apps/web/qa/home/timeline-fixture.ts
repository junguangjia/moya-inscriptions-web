import type {
  CatalogSummary,
  MediaId,
  PublicMedia,
  TimelineChapter,
  TimelineEntry,
  TimelinePrecision,
} from "@moya/contracts";

/*
 * Development-only rows for the Home timeline: about 420 fictional entries,
 * deterministic so a QA screenshot stays comparable. Every row kind appears;
 * 商, 西周, 春秋 and 当代 stay empty as they are in the real list, so their
 * dotted rows can be judged. These values never enter PostgreSQL, the API or
 * the Contracts.
 */

const PLACES = [
  "南寺",
  "北岭",
  "东塔",
  "西谷",
  "云岩",
  "石门",
  "青崖",
  "白鹿",
  "玄岗",
  "松溪",
  "灵台",
  "翠屏",
  "金沙",
  "鹤鸣",
  "龙泉",
  "碧落",
  "丹霞",
  "凤栖",
  "梅岭",
  "兰皋",
  "枫林",
  "霜桥",
  "雁回",
  "桃源",
  "月湖",
  "清溪",
  "飞来",
  "紫阁",
  "栖霞",
];
const KINDS = [
  "碑",
  "摩崖题记",
  "墓志",
  "造像记",
  "石阙铭",
  "经幢",
  "题名",
  "刻石",
  "塔铭",
  "残石",
];
const PROVINCES = ["虚构西州", "虚构东州", "虚构南州", "虚构北州", "虚构中州"];
const HOLDERS = [
  "虚构碑林",
  "虚构博物馆",
  "虚构石窟保管所",
  "虚构县文物管理所",
  "虚构谷口石门及其摩崖题刻保管所",
];
const NUMERALS = [
  "元",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "十一",
  "十二",
];
const POLITIES: Partial<Record<TimelineChapter, readonly string[]>> = {
  三国: ["魏", "蜀", "吴"],
  两晋: ["西晋", "东晋"],
  南北朝: ["北魏", "南梁", "北齐", "南陈"],
  五代十国: ["后唐", "南唐"],
  宋辽金夏: ["北宋", "辽", "金", "西夏", "南宋"],
};
/** 太玄 repeats across chapters so the reign box has a choice to offer. */
const REIGNS: Partial<Record<TimelineChapter, string>> = {
  秦: "虚始",
  西汉: "玄封",
  东汉: "太玄",
  三国: "虚武",
  两晋: "咸虚",
  南北朝: "玄平",
  隋: "开虚",
  唐: "太玄",
  五代十国: "虚祐",
  宋辽金夏: "虚圣",
  元: "至虚",
  明: "虚乐",
  清: "虚绪",
  民国: "虚国",
};

type MutableEntry = {
  -readonly [Key in keyof TimelineEntry]: TimelineEntry[Key];
};

const spread = (from: number, to: number, count: number): readonly number[] =>
  Array.from(
    { length: count },
    (_, at) => from + Math.floor(((to - from) * at) / Math.max(1, count - 1)),
  );

const repeat = (year: number, count: number): readonly number[] =>
  Array.from({ length: count }, () => year);

const createRows = (): MutableEntry[] => {
  const rows: MutableEntry[] = [];
  let serial = 0;

  const shape = (
    start: number,
  ): {
    readonly precision: TimelinePrecision;
    readonly endYear: number;
    readonly disputed: boolean;
  } => {
    if (serial % 29 === 7)
      return { precision: "multi", endYear: start + 12, disputed: false };
    if (serial % 23 === 3)
      return { precision: "year", endYear: start, disputed: true };
    if (serial % 9 === 4)
      return {
        precision: "reign",
        endYear: start + (serial % 5) + 2,
        disputed: false,
      };
    if (serial % 13 === 6)
      return {
        precision: "period",
        endYear: start + (serial % 7) + 8,
        disputed: false,
      };
    return { precision: "year", endYear: start, disputed: false };
  };

  const add = (
    chapter: TimelineChapter,
    startYear: number,
    overrides: Partial<MutableEntry> = {},
  ): MutableEntry => {
    serial += 1;
    const place = PLACES[serial % PLACES.length]!;
    const kind = KINDS[serial % KINDS.length]!;
    const title =
      serial % 17 === 5
        ? `虚构${place}重修${kind}并序及阴侧诸题名合录`
        : `虚构${place}${kind}`;
    const polities = POLITIES[chapter];
    const polity =
      polities === undefined ? chapter : polities[serial % polities.length]!;
    const { precision, endYear, disputed } = shape(startYear);
    const row: MutableEntry = {
      id: `qa-tl-${serial}`,
      title,
      fullTitle: `${polity}${title}`,
      startYear,
      endYear: endYear === 0 ? 1 : endYear,
      precision,
      dateLabel: `${REIGNS[chapter] ?? "虚历"}${NUMERALS[serial % NUMERALS.length]}年`,
      onAxis: true,
      chapter,
      polity,
      disputed,
      groupId: null,
      groupTitle: null,
      province:
        serial % 19 === 5 ? null : PROVINCES[serial % PROVINCES.length]!,
      holder: serial % 7 === 3 ? null : HOLDERS[serial % HOLDERS.length]!,
      catalogId: null,
      media: null,
      ...overrides,
    };
    rows.push(row);
    return row;
  };

  const addYears = (chapter: TimelineChapter, years: readonly number[]) => {
    for (const year of years) add(chapter, year);
  };

  const addShelf = (
    chapter: TimelineChapter,
    from: number,
    to: number,
    count: number,
  ) => {
    for (let at = 0; at < count; at += 1)
      add(
        chapter,
        from,
        at % 4 === 1
          ? {
              onAxis: false,
              precision: "period",
              startYear: from,
              endYear: Math.min(to, from + 30),
              disputed: false,
            }
          : {
              onAxis: false,
              precision: "dynasty",
              startYear: from,
              endYear: to,
              dateLabel: null,
              disputed: false,
            },
      );
  };

  const addGroup = (
    chapter: TimelineChapter,
    id: string,
    title: string,
    count: number,
    overrides: Partial<MutableEntry>,
  ) => {
    for (let at = 0; at < count; at += 1)
      add(chapter, overrides.startYear ?? 0, {
        groupId: id,
        groupTitle: title,
        endYear: overrides.startYear ?? 0,
        disputed: false,
        precision: "year",
        ...overrides,
      });
  };

  // 战国 has only a shelf: a head and its shelf row, no spine rows.
  addShelf("战国", -475, -221, 6);

  add("秦", -219, {
    precision: "multi",
    endYear: -209,
    disputed: false,
    dateLabel: "虚始二十八年立，二世元年加刻；现存残石为二世诏",
  });
  add("秦", -219, { precision: "multi", endYear: -209, disputed: false });
  add("秦", -215, { precision: "year", endYear: -215, disputed: false });

  // Gaps of 93, 25 and 32 years, the last across the missing year 0.
  for (const year of [-158, -149, -149, -56, -51, -26, 7, 7, 12])
    add("西汉", year, {
      precision: "year",
      endYear: year,
      disputed: false,
      polity: year > 8 ? "新莽" : "西汉",
    });
  rows.find(({ startYear }) => startYear === -149)!.disputed = true;
  addShelf("西汉", -206, 23, 3);

  addYears("东汉", spread(30, 138, 8));
  add("东汉", 140, { precision: "year", endYear: 140, disputed: false });
  add("东汉", 147, { precision: "year", endYear: 147, disputed: false });
  add("东汉", 147, { precision: "year", endYear: 147, disputed: false });
  add("东汉", 147, { precision: "reign", endYear: 149, disputed: false });
  addYears("东汉", spread(150, 174, 10));
  addGroup("东汉", "qa-tl-shijing", "虚构石经", 10, {
    startYear: 175,
    endYear: 183,
    precision: "reign",
  });
  addYears("东汉", spread(175, 218, 16));
  addShelf("东汉", 25, 220, 8);

  addYears("三国", spread(222, 278, 8));
  addShelf("三国", 220, 280, 2);

  addYears("两晋", spread(266, 418, 14));
  addShelf("两晋", 265, 420, 4);

  add("南北朝", 424, { disputed: true, precision: "year", endYear: 424 });
  add("南北朝", 433, { precision: "year", endYear: 433, disputed: false });
  add("南北朝", 452, { precision: "reign", endYear: 465, disputed: false });
  add("南北朝", 456, {
    disputed: true,
    precision: "year",
    endYear: 456,
    dateLabel: "传统著录玄平二年，立碑年代另有虚延说",
  });
  addYears("南北朝", spread(460, 510, 14));
  addGroup("南北朝", "qa-tl-yunfeng-511", "虚构云峰诸山摩崖", 23, {
    startYear: 511,
  });
  add("南北朝", 511, { precision: "year", endYear: 511, disputed: false });
  addGroup("南北朝", "qa-tl-yunfeng-512", "虚构云峰诸山摩崖", 3, {
    startYear: 512,
  });
  // Two members share an id and stay plain rows.
  addGroup("南北朝", "qa-tl-pair", "虚构双阙", 2, { startYear: 520 });
  addYears("南北朝", spread(525, 588, 20));
  addShelf("南北朝", 420, 589, 10);
  addGroup("南北朝", "qa-tl-shelf-caves", "虚构石窟诸题记", 5, {
    onAxis: false,
    startYear: 500,
    endYear: 530,
    precision: "period",
    province: PROVINCES[0]!,
  });

  addYears("隋", spread(582, 616, 8));
  addShelf("隋", 581, 618, 2);

  addYears("唐", spread(620, 719, 30));
  // A crowded year: all nine rows show, since only groups fold.
  addYears("唐", repeat(720, 9));
  addYears("唐", spread(721, 905, 40));
  addShelf("唐", 618, 907, 14);

  addYears("五代十国", spread(908, 975, 6));
  addShelf("五代十国", 907, 979, 2);

  addYears("宋辽金夏", spread(962, 1278, 40));
  addShelf("宋辽金夏", 960, 1279, 8);

  addYears("元", spread(1272, 1366, 16));
  addShelf("元", 1271, 1368, 3);

  addYears("明", spread(1370, 1642, 20));
  addShelf("明", 1368, 1644, 4);

  addYears("清", spread(1646, 1907, 22));
  addShelf("清", 1644, 1911, 6);

  add("民国", 1917, { precision: "year", endYear: 1917, disputed: false });

  return rows;
};

const DEMO_ROWS = 16;
const DEMO_IMAGES = [
  { file: "inscription-rubbing.svg", width: 600, height: 420 },
  { file: "stone-detail.svg", width: 360, height: 610 },
  { file: "qa-visual-ultrawide.svg", width: 960, height: 280 },
  { file: "rubbing-fragment.svg", width: 360, height: 480 },
  { file: "qa-visual-square.svg", width: 600, height: 600 },
  { file: "valley-wall.svg", width: 360, height: 430 },
] as const;

const demoMedia = (origin: string, at: number, title: string): PublicMedia => {
  const { file, width, height } = DEMO_IMAGES[at % DEMO_IMAGES.length]!;
  return {
    alt: `${title}（虚构演示图）`,
    height,
    id: `qa-tl-media-${at}` as MediaId,
    kind: "image",
    src: new URL(`/docs/design-system/assets/demo/${file}`, origin).href,
    width,
  };
};

/**
 * Images of both shapes at the frames' own rows and then spread through the
 * list, whatever records there are. These rows stay unlinked and open their
 * 词条卡: a real row has media only with a Catalog link, but a QA visual check
 * needs to see the boxes with or without records.
 */
const addDemoMedia = (rows: MutableEntry[], origin: string) => {
  const place = (row: MutableEntry | undefined, at: number) => {
    if (row !== undefined) row.media = demoMedia(origin, at, row.title);
  };
  place(
    rows.find(({ startYear }) => startYear === 140),
    0,
  );
  place(
    rows.find(({ startYear }) => startYear === 456),
    1,
  );
  const eligible = rows.filter(
    (row) => row.onAxis && row.groupId === null && row.media === null,
  );
  const step = Math.floor(eligible.length / DEMO_ROWS);
  for (let at = 0; at < DEMO_ROWS; at += 1)
    place(eligible[Math.floor(step / 2) + at * step], at + 2);
};

/**
 * A linked row opens Catalog Detail, so it takes the record's identity, title
 * and own media, which is absent on some (a text-only Detail row) and
 * deliberately broken on one.
 */
const linkCatalogRecords = (
  rows: MutableEntry[],
  records: readonly CatalogSummary[],
) => {
  const eligible = rows.filter(
    (row) =>
      row.onAxis && row.groupId === null && !row.disputed && row.media === null,
  );
  // One member of the small group links too: it opens Detail from inside it.
  const member = rows.find((row) => row.groupId === "qa-tl-yunfeng-512");
  const [memberRecord, ...spaced] = records;
  if (member !== undefined && memberRecord !== undefined) {
    member.catalogId = memberRecord.id;
    member.title = memberRecord.title;
    member.fullTitle = memberRecord.title;
  }
  const step = Math.max(1, Math.floor(eligible.length / (spaced.length + 1)));
  spaced.forEach((record, at) => {
    const row = eligible[Math.min(eligible.length - 1, (at + 1) * step)];
    if (row === undefined) return;
    row.catalogId = record.id;
    row.title = record.title;
    row.fullTitle = record.title;
    row.media = record.representativeMedia ?? null;
  });
};

export const createTimelineFixture = (
  origin: string,
  records: readonly CatalogSummary[] = [],
): readonly TimelineEntry[] => {
  const rows = createRows();
  addDemoMedia(rows, origin);
  linkCatalogRecords(rows, records);
  // The API's order: start year first, then the order within the year.
  return rows.sort((a, b) => a.startYear - b.startYear);
};
