import { z } from "zod";

/** Browser-safe read models for Owner-gated Admin endpoints; no service identity. */
export const ADMIN_ANALYTICS_CHINA_MAP_SHA256 =
  "99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275";
export const ADMIN_ANALYTICS_PROVINCE_CODES = [
  "CN-BJ",
  "CN-TJ",
  "CN-HE",
  "CN-SX",
  "CN-NM",
  "CN-LN",
  "CN-JL",
  "CN-HL",
  "CN-SH",
  "CN-JS",
  "CN-ZJ",
  "CN-AH",
  "CN-FJ",
  "CN-JX",
  "CN-SD",
  "CN-HA",
  "CN-HB",
  "CN-HN",
  "CN-GD",
  "CN-GX",
  "CN-HI",
  "CN-CQ",
  "CN-SC",
  "CN-GZ",
  "CN-YN",
  "CN-XZ",
  "CN-SN",
  "CN-GS",
  "CN-QH",
  "CN-NX",
  "CN-XJ",
  "CN-TW",
  "CN-HK",
  "CN-MO",
] as const;

const integer = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value,
    z.number().int().nonnegative().max(maximum),
  );
const dateValue = integer(8_640_000_000_000_000);
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone")
  .default("Asia/Shanghai");
const noControls = (value: string) => !/\p{Cc}/u.test(value);
const datedQuery = {
  startAt: dateValue,
  endAt: dateValue,
  unit: z.enum(["hour", "day", "month"]).default("day"),
  timezone,
  country: z
    .string()
    .regex(/^[A-Z]{2}$/u)
    .optional(),
  region: z
    .string()
    .regex(/^[A-Z]{2}-[A-Z0-9]{1,8}$/u)
    .optional(),
  // The upstream exact-match grammar treats commas as a union of values.
  city: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => noControls(value) && !value.includes(","))
    .optional(),
};
const offset = integer(100_000).default(0);
const positiveLimit = (maximum: number, fallback: number) =>
  integer(maximum)
    .refine((value) => value > 0)
    .default(fallback);

export const adminAnalyticsSummaryQuerySchema = z.strictObject({
  resource: z.literal("summary"),
  ...datedQuery,
});
export const adminAnalyticsTrendQuerySchema = z.strictObject({
  resource: z.literal("trend"),
  ...datedQuery,
});
export const adminAnalyticsMetricsQuerySchema = z.strictObject({
  resource: z.literal("metrics"),
  ...datedQuery,
  type: z.enum([
    "country",
    "region",
    "city",
    "event",
    "path",
    "title",
    "referrer",
    "browser",
    "os",
    "device",
  ]),
  limit: positiveLimit(500, 100),
  offset,
});
export const adminAnalyticsExpandedQuerySchema = z.strictObject({
  resource: z.literal("expanded"),
  ...datedQuery,
  type: z.enum(["city", "region"]),
  limit: positiveLimit(100, 100),
  offset,
  q: z.string().refine(noControls).trim().max(100).optional(),
});
export const adminAnalyticsEventsQuerySchema = z.strictObject({
  resource: z.literal("events"),
  ...datedQuery,
  limit: positiveLimit(50, 20),
});
export const adminAnalyticsMapQuerySchema = z.strictObject({
  resource: z.literal("map"),
});
export const adminAnalyticsQuerySchema = z
  .discriminatedUnion("resource", [
    adminAnalyticsSummaryQuerySchema,
    adminAnalyticsTrendQuerySchema,
    adminAnalyticsMetricsQuerySchema,
    adminAnalyticsExpandedQuerySchema,
    adminAnalyticsEventsQuerySchema,
    adminAnalyticsMapQuerySchema,
  ])
  .superRefine((value, context) => {
    if (value.resource === "map") return;
    if (
      value.endAt <= value.startAt ||
      value.endAt - value.startAt > 366 * 86_400_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Range must be positive and no longer than 366 days",
      });
    }
  });

const count = z.number().finite().nonnegative();
const label = z.string().max(8_192);
const geographyContext = {
  country: z.string().max(32).nullable().optional(),
  region: z.string().max(128).nullable().optional(),
  displayName: z.string().min(1).max(500).optional(),
};
export const adminAnalyticsStatsValuesSchema = z.strictObject({
  pageviews: count,
  visitors: count,
  visits: count,
  bounces: count,
  totaltime: count,
});
export const adminAnalyticsSummarySchema = z.strictObject({
  resource: z.literal("summary"),
  data: adminAnalyticsStatsValuesSchema.extend({
    comparison: adminAnalyticsStatsValuesSchema,
  }),
});
export const adminAnalyticsTimePointSchema = z.strictObject({
  x: z.string().min(1).max(64),
  y: count,
});
export const adminAnalyticsTrendSchema = z.strictObject({
  resource: z.literal("trend"),
  data: z.strictObject({
    pageviews: z.array(adminAnalyticsTimePointSchema).max(10_000),
    sessions: z.array(adminAnalyticsTimePointSchema).max(10_000),
  }),
});
export const adminAnalyticsMetricRowSchema = z.strictObject({
  x: label.nullable(),
  y: count,
  ...geographyContext,
});
export const adminAnalyticsMetricsSchema = z.strictObject({
  resource: z.literal("metrics"),
  data: z.array(adminAnalyticsMetricRowSchema).max(500),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().nonnegative().max(100_000),
});
export const adminAnalyticsExpandedRowSchema = z.strictObject({
  name: label,
  visitors: count,
  visits: count,
  pageviews: count,
  bounces: count,
  totaltime: count,
  ...geographyContext,
});
export const adminAnalyticsExpandedSchema = z.strictObject({
  resource: z.literal("expanded"),
  data: z.array(adminAnalyticsExpandedRowSchema).max(100),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative().max(100_000),
});
export const adminAnalyticsEventPointSchema = z.strictObject({
  x: label,
  t: z.string().min(1).max(64),
  y: count,
});
export const adminAnalyticsEventsSchema = z.strictObject({
  resource: z.literal("events"),
  data: z.array(adminAnalyticsEventPointSchema).max(50_000),
});
export const adminAnalyticsMapShapeSchema = z.strictObject({
  id: z.string().min(1).max(80),
  code: z.enum(ADMIN_ANALYTICS_PROVINCE_CODES).nullable(),
  name: z.string().max(256),
  path: z.string().min(1).max(1_000_000),
  decorative: z.boolean(),
});
export const adminAnalyticsMapDataSchema = z
  .strictObject({
    width: z.literal(800),
    height: z.literal(640),
    viewBox: z.literal("0 0 800 640"),
    sha256: z.literal(ADMIN_ANALYTICS_CHINA_MAP_SHA256),
    attribution: z.string().min(1).max(2_000),
    referenceUrl: z.string().url().startsWith("https://"),
    shapes: z.array(adminAnalyticsMapShapeSchema).length(35),
  })
  .superRefine((value, context) => {
    const provinces = value.shapes.filter((shape) => !shape.decorative);
    const decorative = value.shapes.filter((shape) => shape.decorative);
    if (
      provinces.length !== 34 ||
      decorative.length !== 1 ||
      decorative[0]?.code !== null ||
      provinces.some(
        (shape) => shape.code === null || shape.name.length === 0,
      ) ||
      new Set(value.shapes.map((shape) => shape.id)).size !== 35 ||
      new Set(provinces.map((shape) => shape.code)).size !== 34
    ) {
      context.addIssue({
        code: "custom",
        path: ["shapes"],
        message:
          "Map must contain 34 distinct provinces and one uncounted decoration",
      });
    }
  });
export const adminAnalyticsMapSchema = z.strictObject({
  resource: z.literal("map"),
  data: adminAnalyticsMapDataSchema,
});
export const adminAnalyticsReportSchema = z.discriminatedUnion("resource", [
  adminAnalyticsSummarySchema,
  adminAnalyticsTrendSchema,
  adminAnalyticsMetricsSchema,
  adminAnalyticsExpandedSchema,
  adminAnalyticsEventsSchema,
  adminAnalyticsMapSchema,
]);

export type AdminAnalyticsQuery = z.infer<typeof adminAnalyticsQuerySchema>;
export type AdminAnalyticsReport = z.infer<typeof adminAnalyticsReportSchema>;
export type AdminAnalyticsStatsValues = z.infer<
  typeof adminAnalyticsStatsValuesSchema
>;
export type AdminAnalyticsSummary = z.infer<typeof adminAnalyticsSummarySchema>;
export type AdminAnalyticsTrend = z.infer<typeof adminAnalyticsTrendSchema>;
export type AdminAnalyticsTimePoint = z.infer<
  typeof adminAnalyticsTimePointSchema
>;
export type AdminAnalyticsMetricRow = z.infer<
  typeof adminAnalyticsMetricRowSchema
>;
export type AdminAnalyticsMetrics = z.infer<typeof adminAnalyticsMetricsSchema>;
export type AdminAnalyticsExpandedRow = z.infer<
  typeof adminAnalyticsExpandedRowSchema
>;
export type AdminAnalyticsExpanded = z.infer<
  typeof adminAnalyticsExpandedSchema
>;
export type AdminAnalyticsEventPoint = z.infer<
  typeof adminAnalyticsEventPointSchema
>;
export type AdminAnalyticsEvents = z.infer<typeof adminAnalyticsEventsSchema>;
export type AdminAnalyticsMapShape = z.infer<
  typeof adminAnalyticsMapShapeSchema
>;
export type AdminAnalyticsMapData = z.infer<typeof adminAnalyticsMapDataSchema>;
export type AdminAnalyticsMap = z.infer<typeof adminAnalyticsMapSchema>;
