import { z } from "zod";

/**
 * A raw aggregate can arrive as digits. Null or other text is not a zero, so it fails
 * the whole reply rather than read as a number.
 */
const umamiNumber = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/u)
    .transform(Number),
]);

/** Null where Umami divided by nothing (JSON has no Infinity): no base, not a zero. */
const umamiRatio = umamiNumber.nullable();

const statsValues = z.object({
  pageviews: umamiNumber,
  visitors: umamiNumber,
  accountVisitors: umamiNumber.optional(),
  legacyPageviews: umamiNumber.optional(),
  visits: umamiNumber,
  bounces: umamiNumber,
  totaltime: umamiNumber,
});

const timeSeries = z.array(z.object({ x: z.string(), y: umamiNumber }));

/** `y` counts visitors on region, city and device. Blank values are not rows. */
const metricRow = z.object({
  x: z.string().nullable(),
  y: umamiNumber,
  displayName: z.string().optional(),
  country: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});

const sessionFields = {
  id: z.uuid(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  device: z.string().nullable(),
  screen: z.string().nullable(),
  language: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  firstAt: z.string(),
  lastAt: z.string(),
  visits: umamiNumber,
  views: umamiNumber,
  events: umamiNumber.optional(),
};

const pageOf = <Row extends z.ZodType>(row: Row) =>
  z.object({
    data: z.array(row),
    count: umamiNumber,
    page: umamiNumber,
    pageSize: umamiNumber,
    isCapped: z.boolean().optional(),
  });

const nameValues = z.array(
  z.object({ name: z.string().nullable(), value: umamiNumber }),
);

const definition = z.object({
  id: z.uuid(),
  type: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()),
});

/** Text a filter may hold: no control character reaches a query string. */
const filterText = z
  .string()
  .regex(/^[^\p{Cc}]{1,128}$/u)
  .optional();

const filters = {
  region: filterText,
  city: filterText,
  device: filterText,
  segment: z.uuid().optional(),
  cohort: z.uuid().optional(),
};

const timezone = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u)
  .max(64);

const paging = {
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
};

const reading = <Query extends z.ZodType, Reply extends z.ZodType>(row: {
  readonly path: string;
  readonly ranged: boolean;
  readonly pool?: 1 | 2;
  readonly query: Query;
  readonly reply: Reply;
}) => ({ ...row, pool: row.pool ?? (1 as const) });

/**
 * Every Umami route the MCP path can reach, relative to the configured website. A
 * route with no row has no way to be called: native `/export` runs 7 queries at once
 * and `/realtime` 4, and reset, website delete and Umami's own MCP route stay out of
 * reach. A reply is parsed through its schema, which keeps only the fields named here,
 * so `shareId`, `accessCode` or a field added later never travels on.
 *
 * `pool` is how many of Umami's pool connections the route holds at once: `/pageviews`
 * runs two queries in parallel. `ranged` routes take startAt and endAt from the
 * resolved range, never from `query`. `{name}` in a path is taken from `query`.
 */
export const UMAMI_READ_ROUTES = {
  website: reading({
    path: "",
    ranged: false,
    query: z.strictObject({}),
    reply: z.object({
      id: z.uuid(),
      name: z.string(),
      domain: z.string().nullable(),
      createdAt: z.string(),
      resetAt: z.string().nullable(),
      teamId: z.string().nullable().optional(),
    }),
  }),
  stats: reading({
    path: "/stats",
    ranged: true,
    query: z.strictObject({
      compare: z.enum(["prev", "yoy"]).optional(),
      ...filters,
    }),
    reply: statsValues.extend({ comparison: statsValues }),
  }),
  metrics: reading({
    path: "/metrics",
    ranged: true,
    query: z.strictObject({
      type: z.enum(["region", "city", "device"]),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      ...filters,
    }),
    reply: z.array(metricRow),
  }),
  pageviews: reading({
    path: "/pageviews",
    ranged: true,
    pool: 2,
    query: z.strictObject({
      unit: z.enum(["hour", "day", "month"]),
      timezone,
      ...filters,
    }),
    reply: z.object({ pageviews: timeSeries, sessions: timeSeries }),
  }),
  sessions: reading({
    path: "/sessions",
    ranged: true,
    query: z.strictObject({ ...paging, ...filters }),
    reply: pageOf(z.object(sessionFields)),
  }),
  session: reading({
    path: "/sessions/{sessionId}",
    ranged: false,
    query: z.strictObject({ sessionId: z.uuid() }),
    reply: z.object({
      ...sessionFields,
      deviceVendor: z.string().nullable().optional(),
      deviceModel: z.string().nullable().optional(),
      distinctId: z.string().nullable().optional(),
      distinctIds: z.array(z.string()).optional(),
      stitchedSessionCount: umamiNumber.optional(),
      totaltime: umamiNumber.optional(),
    }),
  }),
  weekly: reading({
    path: "/sessions/weekly",
    ranged: true,
    query: z.strictObject({ timezone, ...filters }),
    reply: z.array(z.array(umamiNumber).length(24)).length(7),
  }),
  retention: reading({
    path: "/retention",
    ranged: true,
    query: z.strictObject({ timezone: timezone.optional(), ...filters }),
    reply: z.array(
      z.object({
        date: z.string(),
        day: umamiNumber,
        visitors: umamiNumber,
        returnVisitors: umamiNumber,
        percentage: umamiNumber,
      }),
    ),
  }),
  journey: reading({
    path: "/journeys",
    ranged: true,
    query: z.strictObject({
      steps: z.number().int().min(2).max(7),
      startStep: filterText,
      endStep: filterText,
      timezone: timezone.optional(),
      ...filters,
    }),
    reply: z.array(
      z.object({
        items: z.array(z.string().nullable()),
        count: umamiNumber,
      }),
    ),
  }),
  attribution: reading({
    path: "/attribution",
    ranged: true,
    query: z.strictObject({
      model: z.enum(["first-click", "last-click"]),
      type: z.enum(["path", "event"]),
      step: z.string().regex(/^[^\p{Cc}]{1,128}$/u),
      timezone: timezone.optional(),
      ...filters,
    }),
    reply: z.object({
      referrer: nameValues,
      paidAds: nameValues,
      utm_source: nameValues,
      utm_medium: nameValues,
      utm_campaign: nameValues,
      utm_content: nameValues,
      utm_term: nameValues,
      total: z.object({
        pageviews: umamiNumber,
        visitors: umamiNumber,
        visits: umamiNumber,
      }),
    }),
  }),
  goal: reading({
    path: "/goals/{goalId}/stats",
    ranged: true,
    query: z.strictObject({
      goalId: z.uuid(),
      timezone: timezone.optional(),
      ...filters,
    }),
    reply: z.object({ num: umamiNumber, total: umamiNumber }),
  }),
  funnel: reading({
    path: "/funnels/{funnelId}/stats",
    ranged: true,
    query: z.strictObject({
      funnelId: z.uuid(),
      timezone: timezone.optional(),
      ...filters,
    }),
    reply: z.array(
      z.object({
        type: z.string(),
        value: z.string(),
        visitors: umamiNumber,
        previous: umamiNumber,
        dropped: umamiNumber,
        dropoff: umamiRatio,
        remaining: umamiRatio,
      }),
    ),
  }),
  funnels: reading({
    path: "/funnels",
    ranged: false,
    query: z.strictObject(paging),
    reply: pageOf(definition),
  }),
  goals: reading({
    path: "/goals",
    ranged: false,
    query: z.strictObject(paging),
    reply: pageOf(definition),
  }),
  segments: reading({
    path: "/segments",
    ranged: false,
    query: z.strictObject({ type: z.enum(["segment", "cohort"]) }),
    reply: pageOf(definition),
  }),
  annotations: reading({
    path: "/annotations",
    ranged: true,
    query: z.strictObject(paging),
    reply: pageOf(
      z.object({
        id: z.uuid(),
        date: z.string(),
        allDay: z.boolean(),
        note: z.string(),
      }),
    ),
  }),
} as const;

export type UmamiReadRoute = keyof typeof UMAMI_READ_ROUTES;
export type UmamiRouteQuery<Route extends UmamiReadRoute> = z.input<
  (typeof UMAMI_READ_ROUTES)[Route]["query"]
>;
export type UmamiRouteReply<Route extends UmamiReadRoute> = z.output<
  (typeof UMAMI_READ_ROUTES)[Route]["reply"]
>;

/** How old an analytics answer is. `stale` only when it stands in for a fresh read that failed. */
export const analyticsCacheBlockSchema = z.strictObject({
  hit: z.boolean(),
  ageMs: z.number().int().nonnegative(),
  stale: z.literal(true).optional(),
});
export type AnalyticsCacheBlock = z.infer<typeof analyticsCacheBlockSchema>;
