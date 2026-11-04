import { z } from "zod";

import type { AnalyticsEvent } from "../../analytics.js";

/** The reports with a canonical source on the Backend (admin-mcp-completion-v1 section 19). */
export const ANALYTICS_INSIGHT_REPORTS = [
  "status",
  "overview",
  "trend",
  "breakdown",
  "compare",
  "funnel",
  "realtime",
  "sessions",
  "session",
  "product",
  "native",
  "reconcile",
] as const;
export type AnalyticsInsightReport = (typeof ANALYTICS_INSIGHT_REPORTS)[number];

export const ANALYTICS_INSIGHTS_PATH = "/internal/analytics/insights";

/** Each statement's limit, enforced where the SQL runs. Past it there is no number. */
export const ANALYTICS_INSIGHT_STATEMENT_TIMEOUT_MS = 3_000;

export const ANALYTICS_DEFAULT_TZ = "Asia/Shanghai";
export const ANALYTICS_MAX_RANGE_DAYS = 366;
export const ANALYTICS_MAX_HOURLY_RANGE_DAYS = 14;
export const ANALYTICS_MAX_SESSION_RANGE_DAYS = 31;
export const ANALYTICS_DEFAULT_MIN_BASE = 30;
export const ANALYTICS_REALTIME_WINDOW_SECONDS = 300;

/** Never collected, so absence never reads as zero (docs/analytics/umami-integration.md). */
export const ANALYTICS_NOT_COLLECTED = {
  referrer: "The client sends no referrer and the logical path drops it.",
  utm: "The client sends no UTM parameters and the logical path drops them.",
  channel: "No source attribution is collected, so no channel can be derived.",
  replay: "Session replay collection is not enabled.",
  heatmap: "Heatmap collection is not enabled.",
  revenue: "Revenue collection is not enabled.",
  performance: "Performance collection is not enabled.",
  rankingVersion:
    "The field is reserved, but the feed gives no version to record.",
} as const;
export type AnalyticsNotCollected = keyof typeof ANALYTICS_NOT_COLLECTED;

const NOT_COLLECTED_NAMES = Object.keys(ANALYTICS_NOT_COLLECTED) as [
  AnalyticsNotCollected,
  ...AnalyticsNotCollected[],
];

const EVENT_NAMES = [
  "page_view",
  "content_impression",
  "content_open",
  "content_dwell",
  "search",
  "search_click",
  "like",
  "favorite",
  "follow",
] as const satisfies readonly AnalyticsEvent["name"][];

const SURFACES = [
  "home",
  "browse",
  "search",
  "detail",
  "profile",
  "thread",
  "other",
] as const satisfies readonly AnalyticsEvent["surface"][];

const TARGET_TYPES = [
  "catalog",
  "work",
  "article",
  "profile",
] as const satisfies readonly NonNullable<AnalyticsEvent["targetType"]>[];

export const ANALYTICS_RANGE_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
] as const;
export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number];

export const ANALYTICS_COMPARE_MODES = [
  "previous",
  "week",
  "year",
  "none",
] as const;
export type AnalyticsCompareMode = (typeof ANALYTICS_COMPARE_MODES)[number];

export const ANALYTICS_CANONICAL_DIMENSIONS = [
  "content",
  "surface",
  "event",
] as const;
export type AnalyticsCanonicalDimension =
  (typeof ANALYTICS_CANONICAL_DIMENSIONS)[number];

/** Answered from Umami by Admin; the Backend names them instead of reading them as empty. */
export const ANALYTICS_UMAMI_DIMENSIONS = [
  "province",
  "city",
  "device",
] as const;

const countText = (maximum: number, minimum: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/u)
    .transform(Number)
    .refine((value) => value >= minimum && value <= maximum, {
      params: { code: "out_of_range" },
    });

/** Every value arrives as URL text; each field states what it may hold. */
export const analyticsInsightQuerySchema = z.strictObject({
  range: z.enum(ANALYTICS_RANGE_PRESETS).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  tz: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u)
    .max(64)
    .optional(),
  compare: z.enum(ANALYTICS_COMPARE_MODES).optional(),
  surface: z.enum(SURFACES).optional(),
  targetType: z.enum(TARGET_TYPES).optional(),
  targetId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/u)
    .optional(),
  event: z.enum([...EVENT_NAMES, "any"]).optional(),
  groupBy: z.enum(["hour", "day", "week", "month"]).optional(),
  dimension: z
    .enum([
      ...ANALYTICS_CANONICAL_DIMENSIONS,
      ...ANALYTICS_UMAMI_DIMENSIONS,
      ...NOT_COLLECTED_NAMES,
    ])
    .optional(),
  direction: z.enum(["down", "up", "abs"]).optional(),
  minBase: countText(1_000_000, 0).optional(),
  limit: countText(100, 1).optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/u)
    .optional(),
  visitorId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  distinctId: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .optional(),
  userId: z
    .string()
    .regex(/^user-[0-9a-f]{32}$/u)
    .optional(),
  include: z.literal("ip").optional(),
  steps: z
    .string()
    .max(120)
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(EVENT_NAMES)).min(2).max(5))
    .refine((steps) => new Set(steps).size === steps.length, {
      params: { code: "duplicate_step" },
    })
    .optional(),
  sameTarget: z.enum(["true", "false"]).optional(),
  basis: z.enum(["visitor", "session"]).optional(),
});
export type AnalyticsInsightQuery = z.output<
  typeof analyticsInsightQuerySchema
>;
type AnalyticsInsightParam = keyof AnalyticsInsightQuery;

const RANGE = ["range", "from", "to", "tz"] as const;
const TARGET = ["surface", "targetType", "targetId"] as const;
const PAGE = ["limit", "cursor"] as const;

/** A parameter a report does not read is refused, never silently dropped. */
export const ANALYTICS_REPORT_PARAMS: Readonly<
  Record<AnalyticsInsightReport, readonly AnalyticsInsightParam[]>
> = {
  status: [],
  overview: [...RANGE, ...TARGET, "compare", "minBase", "limit"],
  trend: [...RANGE, ...TARGET, ...PAGE, "groupBy"],
  breakdown: [...RANGE, ...TARGET, ...PAGE, "dimension", "event"],
  compare: [
    ...RANGE,
    ...TARGET,
    ...PAGE,
    "compare",
    "dimension",
    "direction",
    "event",
    "minBase",
  ],
  funnel: [...RANGE, ...TARGET, "steps", "sameTarget", "basis"],
  realtime: [...PAGE],
  sessions: [
    ...RANGE,
    ...PAGE,
    "visitorId",
    "sessionId",
    "distinctId",
    "userId",
    "include",
  ],
  session: [
    ...RANGE,
    ...PAGE,
    "visitorId",
    "sessionId",
    "distinctId",
    "include",
  ],
  product: [...RANGE, ...PAGE, "surface"],
  native: [...RANGE],
  reconcile: [...RANGE, ...PAGE],
};

export interface AnalyticsInsightIssue {
  readonly path: readonly string[];
  readonly code: string;
  readonly allowedKeys?: readonly string[];
}

/** A named refusal. Names the failing input by path, never by value. */
export class AnalyticsInsightRefusal extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly code: "INPUT_INVALID" | "SELF_ONLY_OWNER_REVIEW",
    readonly issues: readonly AnalyticsInsightIssue[] = [],
  ) {
    super(code);
    this.name = "AnalyticsInsightRefusal";
  }
}

const refuse = (path: string, code: string): AnalyticsInsightRefusal =>
  new AnalyticsInsightRefusal(400, "INPUT_INVALID", [{ path: [path], code }]);

/**
 * Validates one report's query string. Keys are checked against a Set before any
 * object is built, so `constructor` or `__proto__` is an unknown key like any other.
 */
export const parseAnalyticsInsightQuery = (
  report: AnalyticsInsightReport,
  searchParams: URLSearchParams,
): AnalyticsInsightQuery => {
  const allowed = new Set<string>(ANALYTICS_REPORT_PARAMS[report]);
  const entries = new Map<string, string>();
  const issues: AnalyticsInsightIssue[] = [];
  for (const [key, value] of searchParams) {
    if (!allowed.has(key))
      issues.push({
        path: [],
        code: "not_for_this_report",
        allowedKeys: [...allowed],
      });
    else if (entries.has(key)) issues.push({ path: [key], code: "duplicate" });
    else entries.set(key, value);
  }
  if (issues.length > 0)
    throw new AnalyticsInsightRefusal(400, "INPUT_INVALID", issues);
  const parsed = analyticsInsightQuerySchema.safeParse(
    Object.fromEntries(entries),
  );
  if (!parsed.success)
    throw new AnalyticsInsightRefusal(
      400,
      "INPUT_INVALID",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code:
          (issue as { params?: { code?: string } }).params?.code ?? issue.code,
      })),
    );
  // A type alone narrows to one kind of content; an id alone names nothing.
  if (
    parsed.data.targetId !== undefined &&
    parsed.data.targetType === undefined
  )
    throw refuse("targetId", "target_id_needs_its_type");
  return parsed.data;
};

interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (tz: string): Intl.DateTimeFormat => {
  const known = formatters.get(tz);
  if (known) return known;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  formatters.set(tz, made);
  return made;
};

const civilIn = (instant: number, tz: string): Civil => {
  const parts = Object.fromEntries(
    formatterFor(tz)
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
};

const utcOf = (civil: Civil): number =>
  Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );

const offsetAt = (instant: number, tz: string): number =>
  utcOf(civilIn(instant, tz)) - Math.floor(instant / 1000) * 1000;

/** Two passes, because the offset at the wall-clock guess can differ across a change. */
const instantOf = (civil: Civil, tz: string): number => {
  const wall = utcOf(civil);
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
};

const midnight = (civil: Civil, tz: string, addDays = 0): number =>
  instantOf(
    {
      year: civil.year,
      month: civil.month,
      day: civil.day + addDays,
      hour: 0,
      minute: 0,
      second: 0,
    },
    tz,
  );

const realDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

/** Date-only reads in `tz`. Anything else needs an offset; nothing is guessed. */
const instantFromInput = (
  value: string,
  tz: string,
  path: string,
): { readonly at: number; readonly dateOnly: boolean } => {
  const date = DATE_ONLY.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number) as [
      number,
      number,
      number,
    ];
    if (!realDate(year, month, day)) throw refuse(path, "impossible_date");
    return {
      at: midnight({ year, month, day, hour: 0, minute: 0, second: 0 }, tz),
      dateOnly: true,
    };
  }
  const full = DATE_TIME.exec(value);
  if (!full) throw refuse(path, "unparseable_date");
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    full.slice(1).map((part) => Number(part ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  if (
    !realDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59
  )
    throw refuse(path, "impossible_date");
  return { at: Date.parse(value), dateOnly: false };
};

export interface AnalyticsResolvedRange {
  readonly start: Date;
  /** Half-open, and no later than now: a partial period ends at the present. */
  readonly end: Date;
  readonly requestedEnd: Date;
  readonly tz: string;
  readonly complete: boolean;
  readonly preset: AnalyticsRangePreset | null;
}

const DAY_MS = 86_400_000;

const presetBounds = (
  preset: AnalyticsRangePreset,
  today: Civil,
  tz: string,
): readonly [number, number] => {
  const weekday = new Date(
    Date.UTC(today.year, today.month - 1, today.day),
  ).getUTCDay();
  const monday = -((weekday + 6) % 7);
  switch (preset) {
    case "today":
      return [midnight(today, tz), midnight(today, tz, 1)];
    case "yesterday":
      return [midnight(today, tz, -1), midnight(today, tz)];
    case "last_7_days":
      return [midnight(today, tz, -7), midnight(today, tz)];
    case "last_30_days":
      return [midnight(today, tz, -30), midnight(today, tz)];
    case "this_week":
      return [midnight(today, tz, monday), midnight(today, tz, monday + 7)];
    case "last_week":
      return [midnight(today, tz, monday - 7), midnight(today, tz, monday)];
  }
};

/** Resolves the time zone, or refuses one that Intl cannot read. */
export const analyticsTimeZone = (query: AnalyticsInsightQuery): string => {
  const tz = query.tz ?? ANALYTICS_DEFAULT_TZ;
  try {
    return formatterFor(tz).resolvedOptions().timeZone;
  } catch {
    throw refuse("tz", "unknown_time_zone");
  }
};

/**
 * One resolver for both read paths, so a canonical answer and a Umami answer for
 * the same words cover the same instants. `last_N_days` are N finished days.
 */
export const resolveAnalyticsRange = (
  query: AnalyticsInsightQuery,
  now: Date,
  maximumDays: number = ANALYTICS_MAX_RANGE_DAYS,
): AnalyticsResolvedRange => {
  const tz = analyticsTimeZone(query);
  if (query.range !== undefined && (query.from ?? query.to) !== undefined)
    throw refuse("range", "range_or_dates_not_both");
  if (query.to !== undefined && query.from === undefined)
    throw refuse("to", "to_needs_from");
  let start: number;
  let requestedEnd: number;
  if (query.from !== undefined) {
    start = instantFromInput(query.from, tz, "from").at;
    if (query.to === undefined) requestedEnd = now.getTime();
    else {
      const to = instantFromInput(query.to, tz, "to");
      // A date-only `to` includes that whole day.
      requestedEnd = to.dateOnly ? midnight(civilIn(to.at, tz), tz, 1) : to.at;
    }
  } else {
    [start, requestedEnd] = presetBounds(
      query.range ?? "last_7_days",
      civilIn(now.getTime(), tz),
      tz,
    );
  }
  if (start >= now.getTime()) throw refuse("from", "range_in_future");
  if (start >= requestedEnd) throw refuse("from", "empty_range");
  if (requestedEnd - start > maximumDays * DAY_MS)
    throw refuse("from", "range_too_long");
  return {
    start: new Date(start),
    end: new Date(Math.min(requestedEnd, now.getTime())),
    requestedEnd: new Date(requestedEnd),
    tz,
    // A range left open at the end runs to the present, so it has not finished.
    complete:
      requestedEnd <= now.getTime() &&
      (query.from === undefined || query.to !== undefined),
    preset: query.from === undefined ? (query.range ?? "last_7_days") : null,
  };
};

export interface AnalyticsResolvedCompare {
  readonly start: Date;
  readonly end: Date;
  readonly mode: Exclude<AnalyticsCompareMode, "none">;
  /** The current period is partial, so this one covers the same elapsed time. */
  readonly aligned: boolean;
}

const yearBefore = (instant: number, tz: string): number => {
  const civil = civilIn(instant, tz);
  const year = civil.year - 1;
  // 29 February has no twin in a common year.
  const day = realDate(year, civil.month, civil.day)
    ? civil.day
    : civil.day - 1;
  return instantOf({ ...civil, year, day }, tz);
};

/** The comparison period for a resolved range. A partial period aligns to elapsed time. */
export const resolveAnalyticsCompare = (
  range: AnalyticsResolvedRange,
  mode: Exclude<AnalyticsCompareMode, "none">,
): AnalyticsResolvedCompare => {
  const start = range.start.getTime();
  const elapsed = range.end.getTime() - start;
  const length = range.requestedEnd.getTime() - start;
  const before =
    mode === "previous"
      ? start - length
      : mode === "week"
        ? instantOf(
            {
              ...civilIn(start, range.tz),
              day: civilIn(start, range.tz).day - 7,
            },
            range.tz,
          )
        : yearBefore(start, range.tz);
  if (before + length > start)
    throw refuse("compare", "compare_overlaps_range");
  return {
    start: new Date(before),
    end: new Date(before + elapsed),
    mode,
    aligned: !range.complete,
  };
};

/**
 * Shares in percent to two places that add to exactly 100, largest remainder first,
 * because each share rounded on its own can miss. Signed values work the same way.
 */
export const analyticsExactShares = (
  values: readonly number[],
  whole: number,
): number[] => {
  if (whole === 0) return values.map(() => 0);
  const raw = values.map((value) => (value / whole) * 10_000);
  const floors = raw.map(Math.floor);
  const missing = Math.round(10_000 - floors.reduce((sum, v) => sum + v, 0));
  const order = raw
    .map((value, index) => ({ index, part: value - floors[index]! }))
    .sort((a, b) => b.part - a.part || a.index - b.index);
  for (let step = 0; step < missing; step += 1)
    floors[order[step % order.length]!.index]! += 1;
  return floors.map((value) => value / 100);
};

const count = z.number().int().nonnegative();
const instant = z.iso.datetime();
const share = z.number().min(0).max(100).nullable();

const rangeSchema = z.strictObject({
  start: instant,
  end: instant,
  /** Only where the range was asked to run past the present. */
  requestedEnd: instant.optional(),
  tz: z.string(),
  complete: z.boolean(),
  dataFrom: instant.nullable(),
});

const compareSchema = z.strictObject({
  start: instant,
  end: instant,
  mode: z.enum(["previous", "week", "year"]),
  /** The current period is partial, so this one covers the same elapsed time. */
  aligned: z.literal(true).optional(),
  /** Before the data this store holds, so no number stands for this period. */
  outOfRetention: z.literal(true).optional(),
});

const metricSchema = z.strictObject({
  v: count,
  prev: count.nullable(),
  delta: z.number().nullable(),
  pct: z.number().nullable(),
  /** Unique counts are false: never add them across buckets or rows. */
  additive: z.boolean(),
  lowBase: z.literal(true).optional(),
});
export type AnalyticsInsightMetric = z.infer<typeof metricSchema>;

/** Named by definition, because one word "visitors" hides different things. */
export const ANALYTICS_CANONICAL_METRICS = [
  "pageViews",
  "visitorsPageView",
  "visitorsAny",
  "accountVisitors",
  "canonicalSessions",
] as const;

const qualitySchema = z.strictObject({
  unknownShare: share.optional(),
  outboxPending: count.optional(),
  truncated: z.literal(true).optional(),
});

const excludedSchema = z.array(z.literal("self_only"));
const nextSchema = z.strictObject({ cursor: z.string().min(1) }).optional();

const common = {
  source: z.literal("canonical"),
  asOf: instant,
  range: rangeSchema,
  quality: qualitySchema,
  /** Fixed codes, never user content. */
  notes: z.array(z.string()),
  /** Categories withheld on this answer, with no count. */
  excluded: excludedSchema,
  next: nextSchema,
};

const targetSchema = z.strictObject({
  type: z.enum(TARGET_TYPES),
  id: z.string(),
  /** Null when no public title could be read; `state` says why. */
  title: z.string().nullable(),
  authorHandle: z.string().nullable(),
  state: z.string(),
});
export type AnalyticsInsightTarget = z.infer<typeof targetSchema>;

/** A content row names its target; a surface or event row is that name. */
const countRowSchema = z.strictObject({
  key: z.string().optional(),
  target: targetSchema.optional(),
  count,
  share,
  /** Unique within this row. The rows do not add up to a total. */
  visitors: count,
});

const countSliceSchema = z.strictObject({ count, share });

/** rows + other + unknown + withheld is the total, so shares add to 100 percent. */
const countBlockSchema = z.strictObject({
  total: count,
  /** Unique over the whole period, read once, never summed from the rows. */
  totalVisitors: count,
  rows: z.array(countRowSchema),
  other: countSliceSchema,
  unknown: countSliceSchema,
  withheld: countSliceSchema
    .extend({ reason: z.literal("self_only") })
    .nullable(),
});
export type AnalyticsInsightCountBlock = z.infer<typeof countBlockSchema>;

const eventBasisSchema = z.enum([...EVENT_NAMES, "any"]);

export const analyticsOverviewSchema = z.strictObject({
  report: z.literal("overview"),
  ...common,
  compare: compareSchema.nullable(),
  metrics: z.record(z.string(), metricSchema),
  event: eventBasisSchema,
  topContent: countBlockSchema,
});

const bucketSchema = z.strictObject({
  start: instant,
  /** Wall-clock start in the answer's time zone. */
  label: z.string(),
  /** The range covers only part of this bucket. */
  partial: z.boolean(),
  pageViews: count,
  events: count,
  visitorsPageView: count,
  visitorsAny: count,
  accountVisitors: count,
  canonicalSessions: count,
});

export const analyticsTrendSchema = z.strictObject({
  report: z.literal("trend"),
  ...common,
  groupBy: z.enum(["hour", "day", "week", "month"]),
  buckets: z.array(bucketSchema),
  /** Read over the whole range: a unique total is not the sum of its buckets. */
  totals: bucketSchema
    .pick({
      pageViews: true,
      events: true,
      visitorsPageView: true,
      visitorsAny: true,
      accountVisitors: true,
      canonicalSessions: true,
    })
    .strict(),
});

export const analyticsNotCollectedSchema = z.strictObject({
  report: z.enum(["breakdown", "compare"]),
  source: z.literal("capability"),
  asOf: instant,
  dimension: z.enum(NOT_COLLECTED_NAMES),
  collected: z.literal(false),
  reason: z.string(),
});

export const analyticsBreakdownSchema = z.union([
  analyticsNotCollectedSchema,
  z
    .strictObject({
      report: z.literal("breakdown"),
      ...common,
      dimension: z.enum(ANALYTICS_CANONICAL_DIMENSIONS),
      event: eventBasisSchema,
    })
    .extend(countBlockSchema.shape),
]);

const deltaSliceSchema = z.strictObject({
  v: count,
  prev: count,
  delta: z.number(),
  shareOfChange: z.number().nullable(),
});

export const analyticsCompareRowSchema = z.strictObject({
  key: z.string().optional(),
  target: targetSchema.optional(),
  v: count,
  prev: count,
  delta: z.number(),
  pct: z.number().nullable(),
  lowBase: z.boolean(),
  onlyInBase: z.boolean(),
  onlyInCurrent: z.boolean(),
  shareOfChange: z.number().nullable(),
});

export const analyticsCompareSchema = z.union([
  analyticsNotCollectedSchema,
  z.strictObject({
    report: z.literal("compare"),
    ...common,
    compare: compareSchema,
    dimension: z.enum(ANALYTICS_CANONICAL_DIMENSIONS),
    direction: z.enum(["down", "up", "abs"]),
    event: eventBasisSchema,
    minBase: count,
    total: z.strictObject({
      v: count,
      prev: count.nullable(),
      delta: z.number().nullable(),
      pct: z.number().nullable(),
      lowBase: z.boolean(),
    }),
    rows: z.array(analyticsCompareRowSchema),
    /** Null when the comparison period holds no data to divide. */
    other: deltaSliceSchema.nullable(),
    unknown: deltaSliceSchema.nullable(),
    withheld: deltaSliceSchema
      .extend({ reason: z.literal("self_only") })
      .nullable(),
  }),
]);

export const analyticsFunnelSchema = z.strictObject({
  report: z.literal("funnel"),
  ...common,
  /** What was counted, in what grouping. Native funnels cannot claim sameTarget. */
  basis: z.strictObject({
    unit: z.enum(["visitor", "session"]),
    order: z.literal("same_session"),
    sameTarget: z.boolean(),
  }),
  steps: z.array(
    z.strictObject({
      event: z.enum(EVENT_NAMES),
      count,
      fromPrevious: z.number().nullable(),
      fromFirst: z.number().nullable(),
    }),
  ),
});

const accountSchema = z.strictObject({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  status: z.string(),
});

const ipWithheldSchema = z
  .strictObject({ withheld: z.literal(true), switch: z.literal("rawIp") })
  .optional();

export const analyticsRealtimeSchema = z.strictObject({
  report: z.literal("realtime"),
  source: z.literal("canonical"),
  asOf: instant,
  windowSeconds: z.number().int().positive(),
  activeVisitors: count,
  activeSessions: count,
  activeAccounts: count,
  /** Index 0 is the current minute, by time received. */
  eventsPerMinute: z.array(
    z.strictObject({ minutesAgo: count, events: count }),
  ),
  topContent: countBlockSchema,
  online: z.array(
    z.strictObject({
      visitorId: z.uuid(),
      sessionId: z.uuid(),
      account: accountSchema.nullable(),
      lastSeenAt: instant,
      lastEvent: z.enum(EVENT_NAMES),
      lastSurface: z.enum(SURFACES),
      target: targetSchema.nullable(),
      withheld: z.literal("self_only").optional(),
    }),
  ),
  excluded: excludedSchema,
  notes: z.array(z.string()),
  next: nextSchema,
});

export const analyticsSessionsSchema = z.strictObject({
  report: z.literal("sessions"),
  ...common,
  rows: z.array(
    z.strictObject({
      sessionId: z.uuid(),
      visitorId: z.uuid(),
      /** Umami's session distinct ids, more than one if the visitor signed in midway. */
      distinctIds: z.array(z.string()),
      account: accountSchema.nullable(),
      firstAt: instant,
      lastAt: instant,
      events: count,
      pageViews: count,
      contentOpens: count,
    }),
  ),
  ip: ipWithheldSchema,
});

const runSchema = z.strictObject({
  event: z.enum(EVENT_NAMES),
  surface: z.enum(SURFACES),
  target: targetSchema.nullable(),
  /** The target is a self-only work, so nothing about it is on this run. */
  withheld: z.literal("self_only").optional(),
  count: z.number().int().positive(),
  firstAt: instant,
  lastAt: instant,
  dwellMs: count.nullable(),
  query: z.string().nullable(),
});

export const analyticsSessionSchema = z.strictObject({
  report: z.literal("session"),
  ...common,
  subject: z.strictObject({
    sessionId: z.uuid().optional(),
    visitorId: z.uuid().optional(),
    distinctId: z.string().optional(),
  }),
  summary: z.strictObject({
    events: count,
    sessions: count,
    visitors: count,
    firstAt: instant.nullable(),
    lastAt: instant.nullable(),
  }),
  accounts: z.array(accountSchema),
  /** Repeated events in a row collapse into one run. */
  runs: z.array(runSchema),
  ip: ipWithheldSchema,
});

const relationSchema = z.strictObject({
  v: count,
  source: z.literal("business_tables"),
});

const clientEventSchema = z.strictObject({
  v: count,
  source: z.literal("client_evidence"),
});

export const analyticsProductSchema = z.strictObject({
  report: z.literal("product"),
  ...common,
  byPosition: z.array(
    z.strictObject({
      surface: z.enum(SURFACES),
      /** Positions 0 to 9, then one row for everything later. */
      position: z.union([z.number().int().min(0).max(9), z.literal("10+")]),
      impressions: count,
      opens: count,
      openRate: z.number().nullable(),
    }),
  ),
  dwell: z.strictObject({
    samples: count,
    p50Ms: z.number().nullable(),
    p90Ms: z.number().nullable(),
  }),
  search: z.strictObject({
    searches: count,
    clicks: count,
    clickRate: z.number().nullable(),
    topQueries: z.array(z.strictObject({ query: z.string(), count })),
  }),
  /** Rows created in the range that still exist. An undone like is not here. */
  finals: z.strictObject({
    likes: relationSchema,
    favorites: relationSchema,
    follows: relationSchema,
  }),
  /** Client success callbacks, not final state. */
  clientEvents: z.strictObject({
    like: clientEventSchema,
    favorite: clientEventSchema,
    follow: clientEventSchema,
  }),
  topContent: z.strictObject({
    rows: z.array(
      z.strictObject({
        target: targetSchema,
        impressions: count,
        opens: count,
        openRate: z.number().nullable(),
      }),
    ),
    other: z.strictObject({ impressions: count, opens: count }),
    withheld: z
      .strictObject({
        reason: z.literal("self_only"),
        impressions: count,
        opens: count,
      })
      .nullable(),
  }),
});

/** Umami answers `native`. This fixes the instants it asks about and what the store holds. */
export const analyticsNativeSchema = z.strictObject({
  report: z.literal("native"),
  source: z.literal("canonical"),
  asOf: instant,
  range: rangeSchema,
  startMs: z.number().int(),
  endMs: z.number().int(),
  retention: z.strictObject({ days: count, from: instant }),
  outOfRetention: z.boolean(),
  notes: z.array(z.string()),
});

export const analyticsReconcileSchema = z.strictObject({
  report: z.literal("reconcile"),
  ...common,
  days: z.array(
    z.strictObject({
      day: z.string(),
      partial: z.boolean(),
      events: count,
      pageViews: count,
      visitorsPageView: count,
      visitorsAny: count,
      forwarded: count,
      notForwarded: count,
    }),
  ),
  outbox: z.strictObject({ pending: count, failed: count }),
});

export const analyticsStatusInsightSchema = z.strictObject({
  report: z.literal("status"),
  source: z.literal("canonical"),
  asOf: instant,
  enabled: z.boolean(),
  forwardingConfigured: z.boolean(),
  ownerExclusionConfigured: z.boolean(),
  eventRetentionDays: z.number().int().positive(),
  ipRetentionDays: z.number().int().positive(),
  last24Hours: z.strictObject({
    events: count,
    visitors: count,
    users: count,
    sessions: count,
  }),
  outbox: z.strictObject({ pending: count, failed: count }),
  lastEventAt: instant.nullable(),
  lastForwardedAt: instant.nullable(),
  metrics: z.array(z.enum(ANALYTICS_CANONICAL_METRICS)),
  notCollected: z.record(
    z.enum(NOT_COLLECTED_NAMES),
    z.strictObject({ collected: z.literal(false), reason: z.string() }),
  ),
});

export const analyticsInsightResultSchemas = {
  status: analyticsStatusInsightSchema,
  overview: analyticsOverviewSchema,
  trend: analyticsTrendSchema,
  breakdown: analyticsBreakdownSchema,
  compare: analyticsCompareSchema,
  funnel: analyticsFunnelSchema,
  realtime: analyticsRealtimeSchema,
  sessions: analyticsSessionsSchema,
  session: analyticsSessionSchema,
  product: analyticsProductSchema,
  native: analyticsNativeSchema,
  reconcile: analyticsReconcileSchema,
} as const satisfies Record<AnalyticsInsightReport, z.ZodType>;

export type AnalyticsInsightResults = {
  readonly [Report in AnalyticsInsightReport]: z.infer<
    (typeof analyticsInsightResultSchemas)[Report]
  >;
};

/** Reads the canonical store. Throws AnalyticsInsightRefusal for a named refusal. */
export interface AnalyticsInsightsReader {
  read<Report extends Exclude<AnalyticsInsightReport, "status">>(
    report: Report,
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults[Report]>;
}

/** A read that ran out of time: no number, and not a zero. */
export class AnalyticsInsightTimeout extends Error {
  constructor() {
    super("READ_TIMED_OUT");
    this.name = "AnalyticsInsightTimeout";
  }
}

/** A key whose string value a person or a client wrote. */
const UNTRUSTED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "authorHandle",
  "handle",
  "displayName",
  "query",
  "distinctId",
  "distinctIds",
  // Umami's answers: paths, definition text and what a browser said about itself.
  "key",
  "items",
  "name",
  "description",
  "note",
  "value",
  "parameters",
  "browser",
  "os",
  "device",
  "deviceVendor",
  "deviceModel",
  "screen",
  "language",
  "country",
  "region",
  "city",
]);

const pointerSegment = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/** JSON pointers to user-authored strings in an answer, so no such field escapes marking. */
export const analyticsUntrustedPointers = (
  value: unknown,
  at = "",
  marked = false,
): readonly string[] => {
  if (typeof value === "string") return marked ? [at] : [];
  if (Array.isArray(value))
    return value.flatMap((entry, index) =>
      analyticsUntrustedPointers(entry, `${at}/${index}`, marked),
    );
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    analyticsUntrustedPointers(
      entry,
      `${at}/${pointerSegment(key)}`,
      marked || UNTRUSTED_KEYS.has(key),
    ),
  );
};

/** Every report on `admin_analytics`. `traffic` has no answer yet and says so. */
export const ADMIN_ANALYTICS_REPORTS = [
  ...ANALYTICS_INSIGHT_REPORTS,
  "traffic",
] as const;
export type AdminAnalyticsReport = (typeof ADMIN_ANALYTICS_REPORTS)[number];

/** Umami's long tail. `attribution` holds only totals: its sources were never collected. */
export const ADMIN_ANALYTICS_NATIVE_KINDS = [
  "retention",
  "journey",
  "weekly",
  "goal",
  "funnel",
  "attribution",
  "segment",
  "cohort",
] as const;
export type AdminAnalyticsNativeKind =
  (typeof ADMIN_ANALYTICS_NATIVE_KINDS)[number];

const insightField = analyticsInsightQuerySchema.shape;
const umamiFilterText = z
  .string()
  .regex(/^[^\p{Cc}]{1,128}$/u)
  .optional();

const adminAnalyticsFilterSchema = z.strictObject({
  surface: insightField.surface,
  targetType: insightField.targetType,
  targetId: insightField.targetId,
  event: insightField.event,
  distinctId: insightField.distinctId,
  userId: insightField.userId,
  // Answered by Umami, so a report reading these has no canonical part to filter.
  region: umamiFilterText,
  city: umamiFilterText,
  device: umamiFilterText,
  segment: z.uuid().optional(),
  cohort: z.uuid().optional(),
});

export const ADMIN_ANALYTICS_UMAMI_FILTERS = [
  "region",
  "city",
  "device",
  "segment",
  "cohort",
] as const;

/**
 * The arguments of `admin_analytics` (admin-mcp-completion-v1 section 19), each with
 * the limits the Backend's query holds, so a bad input never leaves the Admin.
 */
export const adminAnalyticsInputSchema = z.strictObject({
  report: z.enum(ADMIN_ANALYTICS_REPORTS),
  range: insightField.range,
  from: insightField.from,
  to: insightField.to,
  tz: insightField.tz,
  compare: insightField.compare,
  filter: adminAnalyticsFilterSchema.optional(),
  groupBy: insightField.groupBy,
  dimension: insightField.dimension,
  direction: insightField.direction,
  minBase: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: insightField.cursor,
  visitorId: insightField.visitorId,
  sessionId: insightField.sessionId,
  /** Umami's own session id: the start that finds the session's device and place. */
  umamiSessionId: z.uuid().optional(),
  /** `ip` always answers withheld here; `umami` adds or asks Umami's rows. */
  include: z.enum(["ip", "umami"]).optional(),
  steps: z.array(z.enum(EVENT_NAMES)).min(2).max(5).optional(),
  sameTarget: z.boolean().optional(),
  basis: insightField.basis,
  funnelId: z.uuid().optional(),
  kind: z.enum(ADMIN_ANALYTICS_NATIVE_KINDS).optional(),
  goalId: z.uuid().optional(),
  /** The path or event a native journey starts from, or attribution counts. */
  step: z
    .string()
    .regex(/^[^\p{Cc}]{1,128}$/u)
    .optional(),
});
export type AdminAnalyticsInput = z.output<typeof adminAnalyticsInputSchema>;

/** Fixed English for each code a reconcile day can carry, never user content. */
export const ANALYTICS_RECONCILE_EXPLANATIONS = {
  DAY_NOT_FINISHED:
    "The day is still running, so both sides are still growing.",
  LATE_EVENTS_POSSIBLE:
    "The day ended less than 24.5 hours ago, so late client events can still arrive.",
  NOT_YET_FORWARDED:
    "Canonical holds events on this day that have not reached Umami yet.",
  UMAMI_HIGHER:
    "Umami counts more: delivery is at least once, so a lost acknowledgement can repeat an event, and page views from before the logical path count there too.",
  CANONICAL_HIGHER:
    "Canonical counts more with nothing left to forward. No known cause explains this; canonical stands.",
  VISITOR_KEYS_DIFFER:
    "Visitors differ: canonical counts visitor ids, Umami counts browser keys and falls back to its own session id.",
} as const;
export type AnalyticsReconcileExplanation =
  keyof typeof ANALYTICS_RECONCILE_EXPLANATIONS;
