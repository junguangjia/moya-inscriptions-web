import {
  ADMIN_ANALYTICS_CHINA_MAP_SHA256,
  ADMIN_ANALYTICS_PROVINCE_CODES,
  adminAnalyticsQuerySchema,
  adminAnalyticsReportSchema,
} from "@moya/contracts/admin-analytics";
import { describe, expect, it } from "vitest";

const startAt = Date.UTC(2026, 0, 1);
const endAt = Date.UTC(2026, 0, 8);
const dated = { startAt, endAt };
const summary = {
  pageviews: 12,
  visitors: 5,
  visits: 7,
  bounces: 2,
  totaltime: 180,
};
const expandedRow = {
  name: "Beijing",
  visitors: 5,
  visits: 7,
  pageviews: 12,
  bounces: 2,
  totaltime: 180,
  country: "CN",
  region: "CN-BJ",
  displayName: "北京",
};
const mapData = () => ({
  width: 800,
  height: 640,
  viewBox: "0 0 800 640",
  sha256: ADMIN_ANALYTICS_CHINA_MAP_SHA256,
  attribution: "Synthetic learning-use map fixture",
  referenceUrl: "https://maps.example.invalid/reference",
  shapes: [
    ...ADMIN_ANALYTICS_PROVINCE_CODES.map((code, index) => ({
      id: code,
      code: code as string | null,
      name: `Synthetic province ${index + 1}`,
      path: "M1,1L2,1L2,2Z",
      decorative: false,
    })),
    {
      id: "synthetic-decoration",
      code: null,
      name: "",
      path: "M3,3L4,4Z",
      decorative: true,
    },
  ],
});

describe("Owner internal analytics query contract", () => {
  it("parses integer query strings and applies the agreed display defaults", () => {
    expect(
      adminAnalyticsQuerySchema.parse({
        resource: "summary",
        startAt: String(startAt),
        endAt: String(endAt),
        country: "CN",
        region: "CN-BJ",
        city: "Beijing",
      }),
    ).toEqual({
      resource: "summary",
      ...dated,
      country: "CN",
      region: "CN-BJ",
      city: "Beijing",
      unit: "day",
      timezone: "Asia/Shanghai",
    });
    expect(adminAnalyticsQuerySchema.parse({ resource: "map" })).toEqual({
      resource: "map",
    });
  });

  it("keeps search only on expanded geography and preserves its raw exact-filter values", () => {
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "metrics",
        ...dated,
        type: "title",
      }).success,
    ).toBe(true);
    expect(
      adminAnalyticsQuerySchema.parse({
        resource: "expanded",
        ...dated,
        type: "city",
        country: "CN",
        city: "Shanghai",
        q: " 北京 ",
        offset: "100",
      }),
    ).toMatchObject({ city: "Shanghai", q: "北京", limit: 100, offset: 100 });
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "metrics",
        ...dated,
        type: "city",
        q: "北京",
      }).success,
    ).toBe(false);
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "expanded",
        ...dated,
        type: "path",
      }).success,
    ).toBe(false);
  });

  it("rejects unrecognized authority, target, route and filter fields", () => {
    for (const field of [
      "url",
      "path",
      "websiteId",
      "boardId",
      "headers",
      "authorization",
      "country1",
      "search",
    ]) {
      expect(
        adminAnalyticsQuerySchema.safeParse({
          resource: "summary",
          ...dated,
          [field]: "synthetic-untrusted",
        }).success,
      ).toBe(false);
    }
    expect(
      adminAnalyticsQuerySchema.safeParse({ resource: "unknown", ...dated })
        .success,
    ).toBe(false);
    expect(
      adminAnalyticsQuerySchema.safeParse({ resource: "map", ...dated })
        .success,
    ).toBe(false);
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "metrics",
        ...dated,
        type: "distinctId",
      }).success,
    ).toBe(false);
  });

  it("bounds dates, buckets, timezone, query integers and raw exact geography", () => {
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "trend",
        startAt,
        endAt: startAt + 366 * 86_400_000,
      }).success,
    ).toBe(true);
    for (const change of [
      { endAt: startAt },
      { endAt: startAt - 1 },
      { endAt: startAt + 366 * 86_400_000 + 1 },
      { startAt: "" },
      { startAt: " " },
      { startAt: true },
      { startAt: "1.5" },
      { startAt: "1e3" },
      { startAt: -1 },
      { startAt: Infinity },
      { endAt: 8_640_000_000_000_001 },
      { unit: "minute" },
      { timezone: "Synthetic/Invalid" },
      { country: "eq.CN" },
      { region: "eq.CN-BJ" },
      { city: "Beijing,Shanghai" },
      { city: "Beijing\n" },
    ]) {
      expect(
        adminAnalyticsQuerySchema.safeParse({
          resource: "trend",
          ...dated,
          ...change,
        }).success,
      ).toBe(false);
    }
  });

  it("caps rows, offset and the optional Chinese search", () => {
    for (const [resource, maximum, type] of [
      ["metrics", 500, "country"],
      ["expanded", 100, "city"],
    ] as const) {
      expect(
        adminAnalyticsQuerySchema.safeParse({
          resource,
          ...dated,
          type,
          limit: String(maximum),
          offset: "100000",
        }).success,
      ).toBe(true);
      for (const change of [
        { limit: 0 },
        { limit: maximum + 1 },
        { offset: -1 },
        { offset: 100_001 },
        { offset: "0.5" },
      ]) {
        expect(
          adminAnalyticsQuerySchema.safeParse({
            resource,
            ...dated,
            type,
            ...change,
          }).success,
        ).toBe(false);
      }
    }
    expect(
      adminAnalyticsQuerySchema.parse({ resource: "events", ...dated }),
    ).toMatchObject({ limit: 20 });
    expect(
      adminAnalyticsQuerySchema.safeParse({
        resource: "events",
        ...dated,
        limit: 51,
      }).success,
    ).toBe(false);
    for (const q of ["京".repeat(101), "北京\n"]) {
      expect(
        adminAnalyticsQuerySchema.safeParse({
          resource: "expanded",
          ...dated,
          type: "city",
          q,
        }).success,
      ).toBe(false);
    }
  });
});

describe("Owner internal analytics response contract", () => {
  it("preserves raw geography, unknown region and optional presentation labels", () => {
    const metric = {
      x: "Taipei",
      y: 5,
      country: "TW",
      region: "TW-TPE",
      displayName: "台北市",
    };
    expect(
      adminAnalyticsReportSchema.parse({
        resource: "metrics",
        data: [metric],
        limit: 100,
        offset: 0,
      }),
    ).toEqual({ resource: "metrics", data: [metric], limit: 100, offset: 0 });
    expect(
      adminAnalyticsReportSchema.parse({
        resource: "expanded",
        data: [{ ...expandedRow, region: null }],
        limit: 100,
        offset: 0,
      }),
    ).toMatchObject({
      data: [{ region: null, country: "CN", displayName: "北京" }],
    });
  });

  it("validates totals and sparse time series without fabricating rows or totals", () => {
    expect(
      adminAnalyticsReportSchema.parse({
        resource: "summary",
        data: { ...summary, comparison: summary },
      }),
    ).toMatchObject({ data: { visitors: 5 } });
    expect(
      adminAnalyticsReportSchema.parse({
        resource: "trend",
        data: { pageviews: [], sessions: [] },
      }),
    ).toEqual({ resource: "trend", data: { pageviews: [], sessions: [] } });
    expect(
      adminAnalyticsReportSchema.parse({
        resource: "events",
        data: [{ x: "content_open", t: "2026-01-01", y: 5 }],
      }),
    ).toMatchObject({ data: [{ x: "content_open", y: 5 }] });
    expect(
      adminAnalyticsReportSchema.safeParse({
        resource: "metrics",
        data: [],
        limit: 100,
        offset: 0,
        total: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects credential/context leakage, non-finite counts and oversized pages", () => {
    const response = {
      resource: "metrics",
      data: [{ x: "Beijing", y: 5 }],
      limit: 100,
      offset: 0,
    };
    for (const field of ["token", "credentials", "password", "headers"]) {
      expect(
        adminAnalyticsReportSchema.safeParse({
          ...response,
          [field]: "synthetic-not-a-live-credential",
        }).success,
      ).toBe(false);
      expect(
        adminAnalyticsReportSchema.safeParse({
          ...response,
          data: [
            { ...response.data[0], [field]: "synthetic-not-a-live-credential" },
          ],
        }).success,
      ).toBe(false);
    }
    for (const y of [-1, NaN, Infinity]) {
      expect(
        adminAnalyticsReportSchema.safeParse({
          ...response,
          data: [{ x: "Beijing", y }],
        }).success,
      ).toBe(false);
    }
    expect(
      adminAnalyticsReportSchema.safeParse({
        ...response,
        data: Array.from({ length: 501 }, () => ({ x: "synthetic", y: 1 })),
      }).success,
    ).toBe(false);
  });

  it("requires exactly 34 unique China provinces including Taiwan/Hong Kong/Macau and one uncounted decoration", () => {
    const valid = mapData();
    expect(
      adminAnalyticsReportSchema.parse({ resource: "map", data: valid }),
    ).toEqual({ resource: "map", data: valid });
    for (const code of ["CN-TW", "CN-HK", "CN-MO"])
      expect(valid.shapes.some((shape) => shape.code === code)).toBe(true);
    for (const shapes of [
      valid.shapes.slice(0, 34),
      [...valid.shapes, valid.shapes[0]],
      valid.shapes.map((shape, index) =>
        index === 0 ? { ...shape, code: "CN-TJ" } : shape,
      ),
      valid.shapes.map((shape) =>
        shape.decorative ? { ...shape, decorative: false } : shape,
      ),
    ]) {
      expect(
        adminAnalyticsReportSchema.safeParse({
          resource: "map",
          data: { ...valid, shapes },
        }).success,
      ).toBe(false);
    }
    expect(
      adminAnalyticsReportSchema.safeParse({
        resource: "map",
        data: { ...valid, sha256: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });
});
