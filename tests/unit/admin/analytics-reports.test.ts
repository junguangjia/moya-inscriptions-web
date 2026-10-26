import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createAdminAnalyticsReports } from "admin/analytics-upstream";
import { analyticsReportReady } from "admin/analytics-config";

const environment = {
  UMAMI_ORIGIN: "http://127.0.0.1:3010",
  UMAMI_WEBSITE_ID: "10000000-0000-4000-8000-000000000001",
  UMAMI_VIEWER_USERNAME: "synthetic-service-reader",
  UMAMI_VIEWER_PASSWORD: "REPLACE_ME_SYNTHETIC_NOT_VALID",
};
const range = { startAt: 1_767_225_600_000, endAt: 1_767_312_000_000 };
const totals = {
  pageviews: 8,
  visitors: 3,
  visits: 4,
  bounces: 1,
  totaltime: 53,
};

describe("native Owner aggregate reports", () => {
  it("is ready without a Board and refuses non-loopback or incomplete private configuration", async () => {
    expect(analyticsReportReady(environment)).toBe(true);
    for (const altered of [
      { UMAMI_ORIGIN: "https://external.example.invalid" },
      { UMAMI_ORIGIN: "http://127.0.0.1:3010/other" },
      { UMAMI_WEBSITE_ID: "../other" },
      { UMAMI_VIEWER_PASSWORD: "" },
    ]) {
      const request = vi.fn();
      const read = createAdminAnalyticsReports(
        { ...environment, ...altered },
        { request },
      );
      expect(analyticsReportReady({ ...environment, ...altered })).toBe(false);
      await expect(read({ resource: "summary", ...range })).rejects.toThrow(
        "ANALYTICS_NOT_CONFIGURED",
      );
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("constructs the fixed expanded endpoint and preserves exact city AND Chinese search", async () => {
    const raw = {
      name: "Shanghai",
      ...totals,
      country: "CN",
      region: "CN-SH",
      displayName: "上海",
      token: "synthetic-no-export",
      label: "do-not-overwrite-raw-key",
    };
    const request = vi.fn(async () => Response.json([raw]));
    const read = createAdminAnalyticsReports(environment, { request });
    const result = await read({
      resource: "expanded",
      ...range,
      type: "city",
      country: "CN",
      region: "CN-SH",
      city: "Shanghai",
      q: "北京",
      offset: 100,
    });
    const [path, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const url = new URL(path, environment.UMAMI_ORIGIN);
    expect(url.pathname).toBe(
      `/admin/analytics-workspace/api/websites/${environment.UMAMI_WEBSITE_ID}/metrics/expanded`,
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      city: "eq.Shanghai",
      country: "eq.CN",
      region: "eq.CN-SH",
      search: "北京",
      offset: "100",
      limit: "100",
      timezone: "Asia/Shanghai",
      unit: "day",
    });
    expect(url.searchParams.has("q")).toBe(false);
    expect(init.method).toBe("GET");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/json",
    });
    expect(result).toEqual({
      resource: "expanded",
      limit: 100,
      offset: 100,
      data: [
        {
          name: "Shanghai",
          ...totals,
          country: "CN",
          region: "CN-SH",
          displayName: "上海",
        },
      ],
    });
    expect(raw.name).toBe("Shanghai");
    expect(JSON.stringify(result)).not.toContain("synthetic-no-export");
  });

  it("projects summary, trend and events without forwarding unrelated auth fields", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("/stats?"))
        return Response.json({
          ...totals,
          comparison: { ...totals, password: "synthetic-no-export" },
          token: "synthetic-no-export",
        });
      if (path.includes("/pageviews?"))
        return Response.json({
          pageviews: [
            { x: "2026-01-01 00:00:00", y: 8, auth: "synthetic-no-export" },
          ],
          sessions: [{ x: "2026-01-01 00:00:00", y: 4 }],
          compare: { private: "synthetic-no-export" },
        });
      return Response.json([
        {
          x: "favorite",
          t: "2026-01-01 00:00:00",
          y: 2,
          private: "synthetic-no-export",
        },
      ]);
    });
    const read = createAdminAnalyticsReports(environment, { request });
    expect(await read({ resource: "summary", ...range })).toEqual({
      resource: "summary",
      data: { ...totals, comparison: totals },
    });
    expect(await read({ resource: "trend", ...range })).toEqual({
      resource: "trend",
      data: {
        pageviews: [{ x: "2026-01-01 00:00:00", y: 8 }],
        sessions: [{ x: "2026-01-01 00:00:00", y: 4 }],
      },
    });
    expect(await read({ resource: "events", ...range })).toEqual({
      resource: "events",
      data: [{ x: "favorite", t: "2026-01-01 00:00:00", y: 2 }],
    });
  });

  it("normalizes only the two observed PostgreSQL numeric fields in expanded rows", async () => {
    const raw = {
      name: "Shanghai",
      pageviews: "10",
      totaltime: "30.5",
      visitors: 7,
      visits: 8,
      bounces: 2,
      country: "CN",
      region: "CN-SH",
      displayName: "上海",
    };
    const request = vi.fn(async () => Response.json([raw]));
    const read = createAdminAnalyticsReports(environment, { request });
    expect(
      await read({ resource: "expanded", ...range, type: "city" }),
    ).toEqual({
      resource: "expanded",
      limit: 100,
      offset: 0,
      data: [{ ...raw, pageviews: 10, totaltime: 30.5 }],
    });
    expect(raw.pageviews).toBe("10");
    expect(raw.totaltime).toBe("30.5");
    request.mockResolvedValueOnce(
      Response.json([{ ...raw, pageviews: "0", totaltime: "0" }]),
    );
    const empty = await read({ resource: "expanded", ...range, type: "city" });
    if (empty.resource !== "expanded") throw new Error("EXPECTED_EXPANDED");
    expect(empty.data[0]).toMatchObject({ pageviews: 0, totaltime: 0 });
  });

  it.each([
    null,
    "",
    " ",
    false,
    true,
    "NaN",
    "Infinity",
    "-1",
    "1e3",
    "0x10",
    "1 ",
    "01",
    "9".repeat(400),
  ])(
    "does not turn invalid expanded numeric representation %j into zero/success",
    async (value) => {
      for (const field of ["pageviews", "totaltime"]) {
        const request = vi.fn(async () =>
          Response.json([{ name: "SyntheticCity", ...totals, [field]: value }]),
        );
        const read = createAdminAnalyticsReports(environment, { request });
        await expect(
          read({ resource: "expanded", ...range, type: "city" }),
        ).rejects.toThrow(/^ANALYTICS_UNAVAILABLE$/u);
      }
    },
  );

  it("keeps strict number semantics for unrelated aggregates and resources", async () => {
    const request = vi.fn(async () =>
      Response.json([{ name: "SyntheticCity", ...totals, visitors: "7" }]),
    );
    const read = createAdminAnalyticsReports(environment, { request });
    await expect(
      read({ resource: "expanded", ...range, type: "city" }),
    ).rejects.toThrow(/^ANALYTICS_UNAVAILABLE$/u);
    request.mockResolvedValueOnce(
      Response.json({ ...totals, pageviews: "8", comparison: totals }),
    );
    await expect(read({ resource: "summary", ...range })).rejects.toThrow(
      /^ANALYTICS_UNAVAILABLE$/u,
    );
  });

  it("preserves null geography and loaded row counts, with country display names only", async () => {
    const request = vi.fn(async () =>
      Response.json([{ x: "US", y: 3, country: null, region: null }]),
    );
    const read = createAdminAnalyticsReports(environment, { request });
    expect(
      await read({ resource: "metrics", type: "country", ...range, limit: 34 }),
    ).toEqual({
      resource: "metrics",
      limit: 34,
      offset: 0,
      data: [
        { x: "US", y: 3, country: null, region: null, displayName: "美国" },
      ],
    });
    request.mockResolvedValueOnce(Response.json([]));
    expect(
      await read({ resource: "metrics", type: "region", ...range }),
    ).toEqual({ resource: "metrics", limit: 100, offset: 0, data: [] });
  });

  it("refuses unknown parameters and ordinary metrics search before upstream IO", async () => {
    const request = vi.fn();
    const read = createAdminAnalyticsReports(environment, { request });
    for (const query of [
      {
        resource: "summary",
        ...range,
        url: "https://external.example.invalid",
      },
      { resource: "metrics", ...range, type: "city", q: "北京" },
      { resource: "summary", ...range, websiteId: "other" },
      {
        resource: "expanded",
        ...range,
        type: "city",
        city: "Shanghai,Beijing",
      },
      { resource: "summary", ...range, startAt: " " },
    ])
      await expect(read(query)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects redirects, HTML, malformed/oversized JSON and schema drift without raw diagnostics", async () => {
    const responses = [
      new Response("synthetic-private-error", { status: 500 }),
      new Response(null, {
        status: 302,
        headers: { location: "https://external.example.invalid" },
      }),
      new Response("synthetic-private-error", {
        headers: { "content-type": "text/html" },
      }),
      new Response("synthetic-private-error", {
        headers: { "content-type": "application/json" },
      }),
      Response.json({ pageviews: -1, comparison: totals }),
      Response.json({}, { headers: { "content-length": "999999999" } }),
    ];
    for (const response of responses) {
      const read = createAdminAnalyticsReports(environment, {
        request: vi.fn(async () => response),
      });
      await expect(read({ resource: "summary", ...range })).rejects.toThrow(
        /^ANALYTICS_UNAVAILABLE$/u,
      );
    }
  });

  it("reads only the fixed hashed China asset and returns bounded SVG province shapes", async () => {
    const original = await readFile(
      new URL(
        "../../../infra/production/umami/china-provinces.json",
        import.meta.url,
      ),
    );
    const request = vi.fn<
      (path: string, init: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(original, {
          headers: { "content-type": "application/json" },
        }),
    );
    const read = createAdminAnalyticsReports(environment, { request });
    const result = await read({ resource: "map" });
    if (result.resource !== "map") throw new Error("EXPECTED_MAP");
    expect(result.data.shapes).toHaveLength(35);
    expect(
      result.data.shapes.filter((shape) => !shape.decorative),
    ).toHaveLength(34);
    expect(
      result.data.shapes.find((shape) => shape.code === "CN-TW")?.name,
    ).toBe("台湾省");
    expect(
      result.data.shapes.find((shape) => shape.code === "CN-HK")?.name,
    ).toBe("香港特别行政区");
    expect(result.data.shapes.find((shape) => shape.decorative)).toMatchObject({
      id: "100000_JD",
      code: null,
    });
    let provinceArea = 0;
    for (const shape of result.data.shapes) {
      const values = (shape.path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
      for (let i = 0; i < values.length; i += 2) {
        expect(values[i]).toBeGreaterThanOrEqual(29.99);
        expect(values[i]).toBeLessThanOrEqual(770.01);
        expect(values[i + 1]).toBeGreaterThanOrEqual(29.99);
        expect(values[i + 1]).toBeLessThanOrEqual(610.01);
      }
      if (!shape.decorative) {
        let area = 0;
        for (const ring of shape.path.split("Z").filter(Boolean)) {
          const coordinates = (ring.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(
            Number,
          );
          for (
            let current = 0, previous = coordinates.length - 2;
            current < coordinates.length;
            previous = current, current += 2
          ) {
            const previousX = coordinates[previous];
            const previousY = coordinates[previous + 1];
            const currentX = coordinates[current];
            const currentY = coordinates[current + 1];
            if (
              previousX === undefined ||
              previousY === undefined ||
              currentX === undefined ||
              currentY === undefined
            )
              throw new Error("INVALID_SVG_COORDINATES");
            area += previousX * currentY - currentX * previousY;
          }
        }
        area = Math.abs(area / 2);
        expect(area).toBeGreaterThan(0);
        expect(area).toBeLessThan(51200);
        if (shape.code === "CN-BJ") expect(area).toBeGreaterThan(210);
        if (shape.code === "CN-BJ") expect(area).toBeLessThan(212);
        provinceArea += area;
      }
    }
    expect(provinceArea).toBeGreaterThan(100000);
    expect(provinceArea).toBeLessThan(120000);
    expect(request.mock.calls[0]?.[0]).toBe(
      "/admin/analytics-workspace/maps/china-provinces.json",
    );
    await read({ resource: "map" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed map verification or turn it into a successful empty map", async () => {
    const original = await readFile(
      new URL(
        "../../../infra/production/umami/china-provinces.json",
        import.meta.url,
      ),
    );
    const request = vi.fn(async () => Response.json({ features: [] }));
    const read = createAdminAnalyticsReports(environment, { request });
    await expect(read({ resource: "map" })).rejects.toThrow(
      /^ANALYTICS_UNAVAILABLE$/u,
    );
    request.mockResolvedValueOnce(
      new Response(original, {
        headers: { "content-type": "application/json" },
      }),
    );
    expect((await read({ resource: "map" })).resource).toBe("map");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
