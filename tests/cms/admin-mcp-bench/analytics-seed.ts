import { createHash } from "node:crypto";

import { BENCH_SCALE, catalogIdOf } from "./seed.ts";

// The analytics half of the bench seed (admin-mcp-completion-v1 section 21). One
// generator feeds both stores: the canonical `community.analytics_events` and Umami's
// tables, shaped as the worker forwards each event. Every event is a pure function of
// its index and the seed's clock, and the index runs in time order, because the tables
// these rows stand for only ever grow at the end and a scan's cost depends on that.
// The oracle adds up what is generated here, never through a tool and never through
// the SQL under test.

export const ANALYTICS_EVENTS = 1_000_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
/** Inside the 180 days of retention, so a report is never refused for its data. */
const DAYS = 170;
const VISITORS = 40_000;
const TARGETS = 4_000;

/** The repository's synthetic seed's mix: 8 page views, 6 impressions, 4 opens, 2 favorites. */
const NAMES = [
  ...Array<string>(8).fill("page_view"),
  ...Array<string>(6).fill("content_impression"),
  ...Array<string>(4).fill("content_open"),
  ...Array<string>(2).fill("favorite"),
];
const PROVINCES = [
  ["CN-GD", "Guangzhou", 18],
  ["CN-ZJ", "Hangzhou", 15],
  ["CN-BJ", "Beijing", 13],
  ["CN-SH", "Shanghai", 12],
  ["CN-JS", "Nanjing", 10],
  ["CN-SD", "Jinan", 8],
  ["CN-SC", "Chengdu", 7],
  ["CN-HE", "Shijiazhuang", 5],
  ["CN-HA", "Zhengzhou", 5],
  ["CN-SN", "Xi'an", 4],
] as const;
const FEEDS = ["home", "browse", "search", "thread"] as const;
const BROWSER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** Same ids as `seedCommunity`, so these events land on its works and authors. */
const workId = (index: number) => `work-${md5(`bench-work-${index}`)}`;
const authorIndexOf = (index: number) => 1 + (index % BENCH_SCALE.users);
export const authorHandleOf = (index: number) =>
  `bench-u${authorIndexOf(index)}`;

/** The most viewed target is self-only, so a wrong ranking shows at the first row. */
export const SELF_ONLY_HOT_WORK = 50;
/** The third is deleted: `seedAnalyticsTargets` empties it, and it stays its own row. */
export const DELETED_HOT_WORK = 7;

interface Target {
  readonly type: "work" | "catalog";
  readonly id: string;
  /** The index in `seedCommunity`, for a work. */
  readonly work?: number;
}

const targetOfRank = (rank: number): Target => {
  if (rank === 0)
    return {
      type: "work",
      id: workId(SELF_ONLY_HOT_WORK),
      work: SELF_ONLY_HOT_WORK,
    };
  if (rank === 2)
    return {
      type: "work",
      id: workId(DELETED_HOT_WORK),
      work: DELETED_HOT_WORK,
    };
  if (rank % 5 === 0)
    return {
      type: "catalog",
      id: catalogIdOf(1 + (rank % BENCH_SCALE.catalogs)),
    };
  // Multiples of 50 are `seedCommunity`'s self-only works, here and there in the tail.
  const work = rank % 13 === 0 ? 50 * (1 + (rank % 900)) : rank;
  return { type: "work", id: workId(work), work };
};

const isSelfOnly = (target: Target) =>
  target.work !== undefined && target.work % 50 === 0;

const TARGET_TABLE = Array.from({ length: TARGETS }, (_, rank) =>
  targetOfRank(rank),
);

/** A UUID of the shape every store checks, from a kind and a number, at no cost. */
const uuidOf = (kind: number, value: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${value
    .toString(16)
    .padStart(12, "0")}`;

const KIND = { event: 1, visitor: 2, session: 3, umami: 4, visit: 5, data: 6 };

export const benchVisitorId = (visitor: number) =>
  uuidOf(KIND.visitor, visitor);

const hashOf = (value: number) => {
  let mixed = (Math.imul(value + 1, 2_654_435_761) ^ (value >>> 13)) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x2c1b3c6d) >>> 0;
  return ((mixed ^ (mixed >>> 12)) >>> 0) / 2 ** 32;
};

/** A stream of numbers in [0, 1) that depends only on the event's index. */
const randomOf = (index: number) => {
  let step = 0;
  return () => {
    step += 1;
    return hashOf(index * 31 + step * 2_147_483);
  };
};

const shanghaiMidnight = (at: number) =>
  Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;

const shanghaiDay = (at: number) =>
  new Date(shanghaiMidnight(at) + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);

const weekOf = (at: number) => {
  const wall = new Date(at + SHANGHAI_OFFSET_MS);
  wall.setUTCDate(wall.getUTCDate() - ((wall.getUTCDay() + 6) % 7));
  return wall.toISOString().slice(0, 10);
};

const provinceOf = (visitor: number) => {
  // A few visitors have no place, as with an address the GeoIP library cannot place.
  const pick = hashOf(visitor + 7_000_000) * 100;
  let passed = 0;
  for (const [region, city, weight] of PROVINCES) {
    passed += weight;
    if (pick < passed) return { region, city, country: "CN" };
  }
  return { region: null, city: null, country: null };
};

const deviceOf = (visitor: number) => {
  const pick = hashOf(visitor + 9_000_000);
  return pick < 0.7 ? "mobile" : pick < 0.95 ? "desktop" : "tablet";
};

export interface BenchEvent {
  readonly index: number;
  readonly eventId: string;
  readonly visitor: number;
  readonly visitorId: string;
  readonly sessionId: string;
  readonly userId: string | null;
  readonly distinctId: string;
  readonly name: string;
  readonly surface: string;
  readonly target: Target | null;
  readonly position: number | null;
  readonly at: number;
  readonly receivedAt: number;
  readonly umamiSession: string;
  readonly visit: string;
}

/** The instants one seed turns on. Rolls over at Shanghai's midnight, and refuses it. */
export const seedClock = (now: number) => {
  const today = shanghaiMidnight(now);
  // The first events are placed at 00:01 today, so they must be in the past.
  if (now - today < 2 * HOUR_MS) throw new Error("BENCH_TOO_CLOSE_TO_MIDNIGHT");
  return { now, today, day: shanghaiDay(now) };
};

export type SeedClock = ReturnType<typeof seedClock>;

const dayWeight = (daysAgo: number) =>
  (1 + 2 * ((DAYS - daysAgo) / DAYS)) *
  // A weekly rhythm with a little noise, so weeks really differ.
  (1 + 0.25 * Math.sin((2 * Math.PI * daysAgo) / 7)) *
  (0.8 + 0.4 * hashOf(daysAgo + 5_000_000));

export interface AnalyticsGenerator {
  readonly total: number;
  eventAt(index: number): BenchEvent;
}

/** The first four events are the 23:59 and 00:01 edges A1's fixture asks for. */
const edgesOf = (clock: SeedClock) => [
  {
    visitor: VISITORS,
    at: clock.today - 2 * DAY_MS + 23 * HOUR_MS + 59 * 60_000,
  },
  { visitor: VISITORS, at: clock.today - DAY_MS + 60_000 },
  {
    visitor: VISITORS + 1,
    at: clock.today - DAY_MS + 23 * HOUR_MS + 59 * 60_000,
  },
  { visitor: VISITORS + 2, at: clock.today + 60_000 },
];

export const analyticsGenerator = (
  clock: SeedClock,
  total: number,
): AnalyticsGenerator => {
  const edges = edgesOf(clock);
  const generated = total - edges.length;
  // Today is a part of a day, so it holds a part of a day's events.
  const elapsedToday = (clock.now - 60_000 - clock.today) / DAY_MS;
  const weights = Array.from({ length: DAYS }, (_, slot) => {
    const daysAgo = DAYS - 1 - slot;
    return dayWeight(daysAgo) * (daysAgo === 0 ? elapsedToday : 1);
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const counts: number[] = [];
  let assigned = 0;
  let carried = 0;
  for (const weight of weights) {
    carried += (weight / weightSum) * generated;
    const count = Math.floor(carried - assigned);
    counts.push(count);
    assigned += count;
  }
  counts[counts.length - 1]! += generated - assigned;
  const firstOfDay: number[] = [];
  counts.reduce((first, count) => {
    firstOfDay.push(first);
    return first + count;
  }, 0);

  const placed = (index: number) => {
    let low = 0;
    let high = counts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (firstOfDay[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    const daysAgo = DAYS - 1 - low;
    const start = clock.today - daysAgo * DAY_MS;
    const length = daysAgo === 0 ? clock.now - 60_000 - clock.today : DAY_MS;
    const within = (index - firstOfDay[low]!) / Math.max(1, counts[low]!);
    return Math.floor(start + within * length);
  };

  const eventAt = (index: number): BenchEvent => {
    const random = randomOf(index);
    const edge = edges[index];
    // Most visitors come rarely and a few come often.
    const visitor = edge?.visitor ?? Math.floor(VISITORS * random() ** 2.2);
    const at = edge?.at ?? placed(index - edges.length);
    const name = edge
      ? "page_view"
      : NAMES[Math.floor(random() * NAMES.length)]!;
    const rank = edge ? 1 : Math.floor(TARGETS * random() ** 3);
    // A view of home has no target, and reads as `unknown` in a content breakdown.
    const withoutTarget = !edge && name === "page_view" && random() < 0.12;
    const target = withoutTarget ? null : TARGET_TABLE[rank]!;
    const surface = withoutTarget
      ? "home"
      : name === "page_view" || name === "favorite"
        ? "detail"
        : FEEDS[Math.floor(random() * FEEDS.length)]!;
    const account = hashOf(visitor + 3_000_000) < 0.15;
    const month = new Date(at).getUTCMonth();
    const hour = Math.floor(at / HOUR_MS) - Math.floor(clock.today / HOUR_MS);
    return {
      index,
      eventId: uuidOf(KIND.event, index),
      visitor,
      visitorId: uuidOf(KIND.visitor, visitor),
      sessionId: uuidOf(
        KIND.session,
        visitor * 2_000 +
          Math.floor((at - clock.today) / (4 * HOUR_MS)) +
          1_100,
      ),
      userId: account
        ? `user-${md5(`bench-user-${1 + (visitor % BENCH_SCALE.users)}`)}`
        : null,
      distinctId: md5(`bench-distinct-${visitor}`).padEnd(40, "0"),
      name,
      surface,
      target,
      position:
        name === "content_impression" ? Math.floor(random() * 30) : null,
      at,
      receivedAt: at + Math.floor(random() * 90_000),
      umamiSession: uuidOf(KIND.umami, visitor * 12 + month),
      visit: uuidOf(KIND.visit, visitor * 5_000 + hour + 4_500),
    };
  };
  return { total, eventAt };
};

/** One row of `community.analytics_events`, in the order of `CANONICAL_COLUMNS`. */
export const CANONICAL_COLUMNS = [
  ["event_id", "uuid"],
  ["visitor_id", "uuid"],
  ["session_id", "uuid"],
  ["user_id", "text"],
  ["distinct_id", "varchar"],
  ["event_name", "text"],
  ["target_type", "text"],
  ["target_id", "varchar"],
  ["surface", "text"],
  ["event_data", "jsonb"],
  ["occurred_at", "timestamptz"],
  ["received_at", "timestamptz"],
  ["forwarded_at", "timestamptz"],
] as const;

const canonicalEventData = (event: BenchEvent) => ({
  name: event.name,
  ...(event.target === null
    ? {}
    : { targetType: event.target.type, targetId: event.target.id }),
  surface: event.surface,
  ...(event.position === null ? {} : { position: event.position }),
  occurredAt: new Date(event.at).toISOString(),
});

export const canonicalRowOf = (event: BenchEvent) => [
  event.eventId,
  event.visitorId,
  event.sessionId,
  event.userId,
  event.distinctId,
  event.name,
  event.target?.type ?? null,
  event.target?.id ?? null,
  event.surface,
  JSON.stringify(canonicalEventData(event)),
  new Date(event.at).toISOString(),
  new Date(event.receivedAt).toISOString(),
  new Date(event.receivedAt).toISOString(),
];

/** What the worker sends to Umami's collector for this event (analytics-adapter's `pending`). */
export const forwardedDataOf = (event: BenchEvent) => ({
  ...canonicalEventData(event),
  eventId: event.eventId,
  moyaBrowserId: event.visitorId,
  ...(event.userId === null ? {} : { moyaAccountId: event.distinctId }),
});

export const forwardedPathOf = (event: BenchEvent) =>
  event.surface === "home" && event.target === null
    ? "/"
    : `/analytics/${event.surface}${
        event.target === null ? "" : `/${event.target.type}/${event.target.id}`
      }`;

/** The body of one event the worker would post to `/api/batch`, for the collector check. */
export const forwardedPayloadOf = (
  event: BenchEvent,
  websiteId: string,
  hostname: string,
) => ({
  type: "event",
  payload: {
    website: websiteId,
    hostname,
    ip: "223.5.5.5",
    userAgent: BROWSER_AGENT,
    id: event.distinctId,
    timestamp: Math.floor(event.at / 1000),
    url: forwardedPathOf(event),
    ...(event.name === "page_view" ? {} : { name: event.name }),
    data: forwardedDataOf(event),
  },
});

export const UMAMI_EVENT_COLUMNS = [
  ["event_id", "uuid"],
  ["website_id", "uuid"],
  ["session_id", "uuid"],
  ["visit_id", "uuid"],
  ["created_at", "timestamptz"],
  ["url_path", "varchar"],
  ["url_query", "varchar"],
  ["event_type", "integer"],
  ["event_name", "varchar"],
  ["hostname", "varchar"],
] as const;

export const umamiEventRowOf = (
  event: BenchEvent,
  websiteId: string,
  hostname: string,
) => [
  event.eventId,
  websiteId,
  event.umamiSession,
  event.visit,
  new Date(event.at).toISOString(),
  forwardedPathOf(event),
  "",
  event.name === "page_view" ? 1 : 2,
  event.name === "page_view" ? null : event.name,
  hostname,
];

export const UMAMI_DATA_COLUMNS = [
  ["event_data_id", "uuid"],
  ["website_id", "uuid"],
  ["website_event_id", "uuid"],
  ["data_key", "varchar"],
  ["string_value", "varchar"],
  ["number_value", "numeric"],
  ["date_value", "timestamptz"],
  ["data_type", "integer"],
  ["created_at", "timestamptz"],
] as const;

const DATA_TYPE = { string: 1, number: 2, date: 4 } as const;

/** One row per flattened key, as Umami's saveEventData writes them. */
export const umamiDataRowsOf = (
  event: BenchEvent,
  websiteId: string,
  firstId: number,
) => {
  const createdAt = new Date(event.at).toISOString();
  return Object.entries(forwardedDataOf(event)).map(([key, value], offset) => {
    const isNumber = typeof value === "number";
    const isDate = key === "occurredAt";
    return [
      uuidOf(KIND.data, firstId + offset),
      websiteId,
      event.eventId,
      key,
      isDate ? String(value) : isNumber ? value.toFixed(4) : String(value),
      isNumber ? value : null,
      isDate ? value : null,
      isDate ? DATA_TYPE.date : isNumber ? DATA_TYPE.number : DATA_TYPE.string,
      createdAt,
    ];
  });
};

export const UMAMI_SESSION_COLUMNS = [
  ["session_id", "uuid"],
  ["website_id", "uuid"],
  ["browser", "varchar"],
  ["os", "varchar"],
  ["device", "varchar"],
  ["country", "bpchar"],
  ["region", "varchar"],
  ["city", "varchar"],
  ["distinct_id", "varchar"],
  ["created_at", "timestamptz"],
] as const;

export const umamiSessionRowOf = (event: BenchEvent, websiteId: string) => {
  const { region, city, country } = provinceOf(event.visitor);
  return [
    event.umamiSession,
    websiteId,
    "chrome",
    "Android OS",
    deviceOf(event.visitor),
    country,
    region,
    city,
    event.distinctId,
    new Date(event.at).toISOString(),
  ];
};

/** An event the real collector wrote, read straight from Umami's tables at seed time. */
export interface CollectedEvent {
  readonly sessionId: string;
  readonly visitId: string;
  readonly at: string;
  readonly eventType: number;
  readonly region: string | null;
  readonly country: string | null;
}

interface PeriodTally {
  pageViews: number;
  visitorsPageView: Set<string>;
  sessions: Set<string>;
  visits: Set<string>;
}

const emptyPeriod = (): PeriodTally => ({
  pageViews: 0,
  visitorsPageView: new Set(),
  sessions: new Set(),
  visits: new Set(),
});

const closed = (tally: PeriodTally) => ({
  pageViews: tally.pageViews,
  visitorsPageView: tally.visitorsPageView.size,
  canonicalSessions: tally.sessions.size,
  nativeVisits: tally.visits.size,
});

export interface AnalyticsOracle {
  readonly day: string;
  readonly a1: {
    readonly start: string;
    readonly end: string;
    readonly yesterday: ReturnType<typeof closed>;
    readonly dayBefore: ReturnType<typeof closed>;
  };
  readonly a2: {
    readonly rows: readonly {
      readonly type: string;
      readonly id: string;
      readonly hits: number;
    }[];
    readonly total: number;
    readonly withheld: number;
    readonly unknown: number;
    readonly provinces: readonly {
      readonly key: string;
      readonly visitors: number;
    }[];
  };
  readonly a3: {
    readonly weeks: Readonly<Record<string, number>>;
    readonly highest: { readonly label: string; readonly pageViews: number };
    readonly lowest: { readonly label: string; readonly pageViews: number };
  };
  readonly a4: {
    readonly id: string;
    readonly hits: number;
    readonly authorHandle: string;
    readonly state: string;
  };
  /** What must never appear in an answer: the self-only works in the seed. */
  readonly selfOnlyIds: readonly string[];
  /** Their indexes in `seedCommunity`, which names each title. */
  readonly selfOnlyWorks: readonly number[];
}

const byCount = <Row extends { readonly hits: number; readonly key: string }>(
  rows: readonly Row[],
) =>
  [...rows].sort(
    (a, b) => b.hits - a.hits || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

/** Sums what is generated, as it is generated, and the rows the collector really wrote. */
export const createOracle = (clock: SeedClock) => {
  const yesterdayStart = clock.today - DAY_MS;
  const beforeStart = clock.today - 2 * DAY_MS;
  const weekStart = clock.today - 7 * DAY_MS;
  const monthStart = clock.today - 30 * DAY_MS;
  const yesterday = emptyPeriod();
  const dayBefore = emptyPeriod();
  const hits = new Map<string, { target: Target; hits: number }>();
  let withheld = 0;
  let unknown = 0;
  const places = new Map<string, Set<string>>();
  const weeks = new Map<string, number>();
  const seenSelfOnly = new Map<string, number>();

  const place = (region: string | null, key: string) => {
    if (region === null) return;
    const set = places.get(region) ?? new Set<string>();
    set.add(key);
    places.set(region, set);
  };

  const add = (event: BenchEvent) => {
    const { at } = event;
    if (event.target !== null && isSelfOnly(event.target))
      seenSelfOnly.set(event.target.id, event.target.work!);
    const pageView = event.name === "page_view";
    const period =
      at >= yesterdayStart && at < clock.today
        ? yesterday
        : at >= beforeStart && at < yesterdayStart
          ? dayBefore
          : undefined;
    if (period !== undefined) {
      period.sessions.add(event.sessionId);
      if (pageView) {
        period.pageViews += 1;
        period.visitorsPageView.add(event.visitorId);
        period.visits.add(event.visit);
      }
    }
    if (pageView && at >= monthStart && at < clock.today) {
      const week = weekOf(at);
      weeks.set(week, (weeks.get(week) ?? 0) + 1);
    }
    if (pageView && at >= weekStart && at < clock.today) {
      place(provinceOf(event.visitor).region, event.visitorId);
      if (event.target === null) unknown += 1;
      else if (isSelfOnly(event.target)) withheld += 1;
      else {
        const key = `${event.target.type}:${event.target.id}`;
        const row = hits.get(key) ?? { target: event.target, hits: 0 };
        row.hits += 1;
        hits.set(key, row);
      }
    }
  };

  /** Umami alone holds these, with no browser id, so each session is its own visitor. */
  const addCollected = (rows: readonly CollectedEvent[]) => {
    for (const row of rows) {
      const at = Date.parse(row.at);
      if (row.eventType !== 1) continue;
      if (at >= yesterdayStart && at < clock.today)
        yesterday.visits.add(row.visitId);
      else if (at >= beforeStart && at < yesterdayStart)
        dayBefore.visits.add(row.visitId);
      if (at >= weekStart && at < clock.today)
        place(
          row.country === "TW" ? "CN-TW" : row.region,
          `legacy:${row.sessionId}`,
        );
    }
  };

  const result = (): AnalyticsOracle => {
    const ranked = byCount(
      [...hits.entries()].map(([key, row]) => ({ key, ...row })),
    );
    const works = ranked.filter((row) => row.target.type === "work");
    const top = works[0]!.target;
    const provinces = byCount(
      [...places.entries()].map(([key, set]) => ({ key, hits: set.size })),
    );
    const weekRows = [...weeks.entries()].map(([label, pageViews]) => ({
      label,
      pageViews,
    }));
    const ordered = [...weekRows].sort(
      (a, b) => b.pageViews - a.pageViews || (a.label < b.label ? -1 : 1),
    );
    return {
      day: clock.day,
      a1: {
        start: new Date(yesterdayStart).toISOString(),
        end: new Date(clock.today).toISOString(),
        yesterday: closed(yesterday),
        dayBefore: closed(dayBefore),
      },
      a2: {
        rows: ranked.slice(0, 5).map((row) => ({
          type: row.target.type,
          id: row.target.id,
          hits: row.hits,
        })),
        total: ranked.reduce((sum, row) => sum + row.hits, unknown + withheld),
        withheld,
        unknown,
        provinces: provinces
          .slice(0, 3)
          .map(({ key, hits: visitors }) => ({ key, visitors })),
      },
      a3: {
        weeks: Object.fromEntries(weeks),
        highest: ordered[0]!,
        lowest: ordered.at(-1)!,
      },
      a4: {
        id: top.id,
        hits: works[0]!.hits,
        authorHandle: authorHandleOf(top.work!),
        state:
          top.work === DELETED_HOT_WORK
            ? "deleted"
            : top.work! % 211 === 0
              ? "hidden"
              : "public",
      },
      selfOnlyIds: [...seenSelfOnly.keys()],
      selfOnlyWorks: [...seenSelfOnly.values()],
    };
  };
  return { add, addCollected, result };
};

/** Makes the hot work deleted the way permanent deletion leaves it, over `seedCommunity`. */
export const seedAnalyticsTargets = async (db: {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}) => {
  await db.query(
    "UPDATE community.works SET visibility='self', title='', text='', media_ids='{}', public_revision_id=NULL, author_revision_id=NULL, deleted_at=now() WHERE id=$1",
    [workId(DELETED_HOT_WORK)],
  );
  await db.query(
    "DELETE FROM community.work_revision_items WHERE revision_id IN (SELECT id FROM community.work_revisions WHERE work_id=$1)",
    [workId(DELETED_HOT_WORK)],
  );
  await db.query("DELETE FROM community.work_revisions WHERE work_id=$1", [
    workId(DELETED_HOT_WORK),
  ]);
};
