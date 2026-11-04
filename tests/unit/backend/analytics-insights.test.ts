import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
import {
  AI_OPERATOR_ROUTES,
  ANALYTICS_INSIGHT_REPORTS,
  ANALYTICS_NOT_COLLECTED,
  ANALYTICS_REPORT_PARAMS,
  AnalyticsInsightRefusal,
  AnalyticsInsightTimeout,
  aiOperatorRouteFor,
  analyticsInsightQuerySchema,
  analyticsUntrustedPointers,
  parseAnalyticsInsightQuery,
  resolveAnalyticsCompare,
  resolveAnalyticsRange,
} from "@moya/contracts/internal/admin-mcp";
import type { AnalyticsInsightsReader } from "@moya/contracts/internal/admin-mcp";
import { analyticsEventSchema } from "@moya/contracts/analytics";
import { CommunityStoreUnavailableError } from "@moya/api";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const baseToken = syntheticToken();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const issueOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof AnalyticsInsightRefusal) return error.issues[0];
    throw error;
  }
  throw new Error("Expected a refusal");
};

const parse = (query: string, report = "overview" as const) =>
  parseAnalyticsInsightQuery(report, new URLSearchParams(query));

describe("resolveAnalyticsRange", () => {
  const wednesdayNoon = new Date("2026-03-11T04:00:00.000Z");
  const resolved = (query: string, now = wednesdayNoon) =>
    resolveAnalyticsRange(parse(query), now);

  it("reads date-only input in the time zone, and a date-only `to` as that whole day", () => {
    expect(resolved("from=2026-03-10&to=2026-03-10")).toMatchObject({
      start: new Date("2026-03-09T16:00:00.000Z"),
      end: new Date("2026-03-10T16:00:00.000Z"),
      tz: "Asia/Shanghai",
      complete: true,
    });
    expect(resolved("from=2026-03-10&to=2026-03-10&tz=UTC")).toMatchObject({
      start: new Date("2026-03-10T00:00:00.000Z"),
      end: new Date("2026-03-11T00:00:00.000Z"),
      tz: "UTC",
    });
  });

  it("places an event at 23:59 and 00:01 in Asia/Shanghai on the right side of midnight", () => {
    const { start, end } = resolved("range=yesterday");
    const inside = (wall: string) => {
      const at = new Date(`${wall}+08:00`);
      return at >= start && at < end;
    };
    expect(inside("2026-03-09T23:59:00")).toBe(false);
    expect(inside("2026-03-10T00:01:00")).toBe(true);
    expect(inside("2026-03-10T23:59:00")).toBe(true);
    expect(inside("2026-03-11T00:01:00")).toBe(false);
  });

  it("keeps midnight right across a daylight saving change", () => {
    // New York moved to UTC-4 on 8 March 2026.
    expect(
      resolved("from=2026-03-08&to=2026-03-08&tz=America/New_York"),
    ).toMatchObject({
      start: new Date("2026-03-08T05:00:00.000Z"),
      end: new Date("2026-03-09T04:00:00.000Z"),
    });
  });

  it("resolves each preset, and last_N_days as N finished days", () => {
    const at = (wall: string) => new Date(`${wall}T00:00:00+08:00`);
    expect(resolved("range=today")).toMatchObject({
      start: at("2026-03-11"),
      end: wednesdayNoon,
      requestedEnd: at("2026-03-12"),
      complete: false,
    });
    expect(resolved("range=last_7_days")).toMatchObject({
      start: at("2026-03-04"),
      end: at("2026-03-11"),
      complete: true,
    });
    expect(resolved("range=last_30_days").start).toEqual(at("2026-02-09"));
    expect(resolved("range=this_week")).toMatchObject({
      start: at("2026-03-09"),
      end: wednesdayNoon,
      complete: false,
    });
    expect(resolved("range=last_week")).toMatchObject({
      start: at("2026-03-02"),
      end: at("2026-03-09"),
      complete: true,
    });
    // A Sunday still belongs to the week that began on Monday.
    expect(
      resolved("range=this_week", new Date("2026-03-15T04:00:00.000Z")).start,
    ).toEqual(at("2026-03-09"));
  });

  it("says a range left open at the end has not finished", () => {
    const open = resolved("from=2026-03-10");
    expect(open).toMatchObject({
      end: wednesdayNoon,
      requestedEnd: wednesdayNoon,
      complete: false,
    });
    expect(resolveAnalyticsCompare(open, "previous").aligned).toBe(true);
  });

  it("takes a full datetime only with an offset, and honours it", () => {
    expect(
      resolved("from=2026-03-10T08:00:00%2B08:00&to=2026-03-10T09:00:00Z"),
    ).toMatchObject({
      start: new Date("2026-03-10T00:00:00.000Z"),
      end: new Date("2026-03-10T09:00:00.000Z"),
    });
    expect(issueOf(() => resolved("from=2026-03-10T08:00:00"))?.code).toBe(
      "unparseable_date",
    );
  });

  it.each([
    ["from=2026-02-30", "impossible_date"],
    ["from=2026-13-01", "impossible_date"],
    ["from=2026-00-10", "impossible_date"],
    ["from=2025-02-29", "impossible_date"],
    ["from=2026-02-30T00:00:00Z", "impossible_date"],
    ["from=2026-02-01T24:00:00Z", "impossible_date"],
    ["from=2026-02-01T23:60:00Z", "impossible_date"],
    ["from=2026-02-01T23:59:60Z", "impossible_date"],
    ["from=2026-02-01T00:00:00%2B15:00", "impossible_date"],
    ["from=1999-12-31", "impossible_date"],
    ["from=2101-01-01", "impossible_date"],
    ["from=yesterday", "unparseable_date"],
    ["from=2026-3-1", "unparseable_date"],
    ["from=", "unparseable_date"],
    ["from=2026-03-01%00", "unparseable_date"],
    ["from=1741651200000", "unparseable_date"],
    ["from=2026-03-11&to=2026-03-09", "empty_range"],
    ["from=2026-03-12", "range_in_future"],
    ["to=2026-03-09", "to_needs_from"],
    ["range=today&from=2026-03-09", "range_or_dates_not_both"],
    ["from=2024-01-01&to=2026-03-01", "range_too_long"],
    ["tz=Moon/Base", "unknown_time_zone"],
  ])("refuses %s as %s", (query, code) => {
    expect(issueOf(() => resolved(query))?.code).toBe(code);
  });

  it("refuses a time zone written with a NUL or an offset before Intl sees it", () => {
    for (const tz of ["Asia/Shanghai%00", "%2B08:00", "../etc"])
      expect(issueOf(() => parse(`tz=${tz}`))?.path).toEqual(["tz"]);
  });
});

describe("resolveAnalyticsCompare", () => {
  const now = new Date("2026-03-11T04:00:00.000Z");
  const range = (query: string) => resolveAnalyticsRange(parse(query), now);

  it("aligns a partial period to the time elapsed", () => {
    const compare = resolveAnalyticsCompare(
      range("range=this_week"),
      "previous",
    );
    expect(compare).toMatchObject({
      start: new Date("2026-03-02T00:00:00+08:00"),
      end: new Date("2026-03-04T12:00:00+08:00"),
      aligned: true,
    });
  });

  it("compares a finished period whole, with no alignment", () => {
    expect(
      resolveAnalyticsCompare(range("range=last_week"), "previous"),
    ).toMatchObject({
      start: new Date("2026-02-23T00:00:00+08:00"),
      end: new Date("2026-03-02T00:00:00+08:00"),
      aligned: false,
    });
  });

  it("moves year on year by the calendar, and 29 February to the 28th", () => {
    expect(
      resolveAnalyticsCompare(range("from=2026-03-01&to=2026-03-01"), "year")
        .start,
    ).toEqual(new Date("2025-03-01T00:00:00+08:00"));
    const leap = resolveAnalyticsRange(
      parse("from=2024-02-29&to=2024-02-29"),
      new Date("2024-03-10T00:00:00Z"),
    );
    expect(resolveAnalyticsCompare(leap, "year").start).toEqual(
      new Date("2023-02-28T00:00:00+08:00"),
    );
  });

  it("refuses a comparison that overlaps the range", () => {
    expect(
      issueOf(() =>
        resolveAnalyticsCompare(range("range=last_30_days"), "week"),
      )?.code,
    ).toBe("compare_overlaps_range");
  });
});

describe("the query parser", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "nope"])(
    "answers an inherited or unknown key %s by name, not an internal error",
    (key) => {
      const issue = issueOf(() => parse(`${key}=1`));
      expect(issue?.code).toBe("not_for_this_report");
      expect(issue?.allowedKeys).toEqual(ANALYTICS_REPORT_PARAMS.overview);
      expect(JSON.stringify(issue)).not.toContain(key);
    },
  );

  it.each([
    ["limit=0", "out_of_range"],
    ["limit=101", "out_of_range"],
    ["limit=99999999999", "invalid_format"],
    ["limit=1.5", "invalid_format"],
    ["limit=-1", "invalid_format"],
    ["minBase=1000001", "out_of_range"],
  ])("refuses %s", (query, code) => {
    const issue = issueOf(() =>
      parseAnalyticsInsightQuery("compare", new URLSearchParams(query)),
    );
    expect(issue?.code).toBe(code);
  });

  it("refuses a repeated value rather than picking one", () => {
    expect(issueOf(() => parse("range=today&range=yesterday"))?.code).toBe(
      "duplicate",
    );
  });

  it("refuses a parameter its report does not read", () => {
    expect(
      issueOf(() =>
        parseAnalyticsInsightQuery(
          "status",
          new URLSearchParams("range=today"),
        ),
      )?.code,
    ).toBe("not_for_this_report");
    expect(
      issueOf(() =>
        parseAnalyticsInsightQuery(
          "realtime",
          new URLSearchParams("visitorId=x"),
        ),
      )?.code,
    ).toBe("not_for_this_report");
  });

  it("refuses an id with no type, and lets a type narrow alone", () => {
    expect(issueOf(() => parse("targetId=work-1"))?.code).toBe(
      "target_id_needs_its_type",
    );
    expect(parse("targetType=work")).toMatchObject({ targetType: "work" });
  });

  it.each([
    "steps=page_view",
    "steps=page_view,page_view",
    "steps=page_view,nope",
    "steps=a,b,c,d,e,f",
  ])("refuses funnel %s", (query) => {
    expect(
      issueOf(() =>
        parseAnalyticsInsightQuery("funnel", new URLSearchParams(query)),
      ),
    ).toBeDefined();
  });

  it("lists a schema field for every parameter, and no report takes one it has not", () => {
    const fields = Object.keys(analyticsInsightQuerySchema.shape);
    for (const report of ANALYTICS_INSIGHT_REPORTS)
      for (const param of ANALYTICS_REPORT_PARAMS[report])
        expect(fields, `${report} ${param}`).toContain(param);
  });

  it("knows every event name the collector accepts", () => {
    const names = (
      analyticsEventSchema as unknown as {
        shape: { name: { options: readonly string[] } };
      }
    ).shape.name.options;
    for (const name of names)
      expect(analyticsInsightQuerySchema.shape.event.parse(name), name).toBe(
        name,
      );
  });
});

describe("the route table", () => {
  const query = new URLSearchParams();

  it("names every report as an exact read row on the base credential", () => {
    for (const report of [...ANALYTICS_INSIGHT_REPORTS, "export", "traffic"]) {
      const route = aiOperatorRouteFor(
        "GET",
        `/internal/analytics/insights/${report}`,
        query,
      );
      expect(route, report).toMatchObject({
        klass: "read",
        credentials: ["base"],
      });
      expect(route?.path, report).toBe(
        `/internal/analytics/insights/${report}`,
      );
    }
  });

  it("denies anything it does not name, including a future route and a nested one", () => {
    for (const [method, path] of [
      ["GET", "/internal/analytics/insights/future"],
      ["GET", "/internal/analytics/insights/prune"],
      ["GET", "/internal/analytics/insights/session/extra"],
      ["POST", "/internal/analytics/insights/overview"],
      ["GET", "/internal/analytics/insights/"],
    ] as const)
      expect(aiOperatorRouteFor(method, path, query), path).toBeUndefined();
    expect(
      AI_OPERATOR_ROUTES.some(
        (route) =>
          route.path.startsWith("/internal/analytics/") &&
          route.path.endsWith("/*"),
      ),
    ).toBe(false);
  });

  it("keeps prune irreversible", () => {
    expect(
      aiOperatorRouteFor("POST", "/internal/analytics/insights/prune", query),
    ).toMatchObject({ klass: "irreversible", credentials: ["base"] });
  });
});

describe("analyticsUntrustedPointers", () => {
  it("marks every string a person or client wrote, at any depth", () => {
    expect(
      analyticsUntrustedPointers({
        report: "breakdown",
        rows: [
          {
            target: {
              type: "work",
              id: "work-1",
              title: "题名",
              authorHandle: "lishu",
              state: "public",
            },
          },
        ],
        search: { topQueries: [{ query: "加微信", count: 1 }] },
        accounts: [
          { id: "user-1", handle: "a", displayName: "名", status: "active" },
        ],
        runs: [{ query: null }],
      }),
    ).toEqual([
      "/rows/0/target/id",
      "/rows/0/target/title",
      "/rows/0/target/authorHandle",
      "/search/topQueries/0/query",
      "/accounts/0/id",
      "/accounts/0/handle",
      "/accounts/0/displayName",
    ]);
  });
});

describe("GET internal/analytics/insights/*", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all(
      [...servers].map(async (server) => {
        await stopServer(server);
        servers.delete(server);
      }),
    );
  });

  const policy = {
    enabled: false,
    production: false,
    excludedUserIds: new Set<string>(),
    ownerExclusionConfigured: false,
    hmacKey: "",
    forwardingConfigured: false,
    eventRetentionDays: 180,
  };
  const port = {
    status: vi.fn(async () => ({
      last24Hours: { events: 1, visitors: 1, users: 0, sessions: 1 },
      outbox: { pending: 0, failed: 0 },
      lastEventAt: null,
      lastForwardedAt: null,
    })),
    recentIps: vi.fn(async () => ({ items: [] })),
  };

  const start = async (
    read: AnalyticsInsightsReader["read"],
    options: Partial<BackendApplicationOptions> = {},
  ) => {
    const application = createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      analytics: {
        port: port as never,
        policy,
        insights: { read },
      },
      ...options,
    });
    const server = createBackendServer(application);
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    return async (
      path: string,
      headers: Record<string, string>,
      method = "GET",
    ) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/${path}`,
        { method, headers },
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          error?: {
            code?: string;
            issues?: readonly { path: string[]; code: string }[];
          };
          report?: string;
          notCollected?: Record<string, { collected: boolean }>;
          metrics?: readonly string[];
        },
      };
    };
  };

  const refusesUnread = () =>
    vi.fn(async () => {
      throw new Error("The reader must not be reached");
    }) as unknown as AnalyticsInsightsReader["read"];

  it("takes the base token with the community token absent, and answers status from config", async () => {
    expect(process.env.COMMUNITY_OPERATOR_AI_TOKEN).toBeUndefined();
    const send = await start(refusesUnread());
    const { status, body } = await send(
      "analytics/insights/status",
      bearer(baseToken),
    );
    expect(status).toBe(200);
    expect(body.report).toBe("status");
    expect(Object.keys(body.notCollected!).sort()).toEqual(
      Object.keys(ANALYTICS_NOT_COLLECTED).sort(),
    );
    expect(body.metrics).toContain("visitorsPageView");
  });

  it("accepts no other credential as the AI operator", async () => {
    const read = refusesUnread();
    const send = await start(read);
    expect(
      await send("analytics/insights/overview", {}).then((r) => r.status),
    ).toBe(401);
    expect(
      await send("analytics/insights/overview", bearer(syntheticToken())).then(
        (r) => r.status,
      ),
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("is closed when the Backend does not hold the base credential", async () => {
    const read = refusesUnread();
    const send = await start(read, { operatorAiBaseCredential: "" });
    expect(
      (await send("analytics/insights/overview", bearer(baseToken))).status,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses by the route table before any handler reads", async () => {
    const read = refusesUnread();
    const send = await start(read);
    for (const [path, code] of [
      ["analytics/insights/future", "AI_ROUTE_FORBIDDEN"],
      ["analytics/insights/prune", "AI_ROUTE_FORBIDDEN"],
    ] as const) {
      const { status, body } = await send(path, bearer(baseToken));
      expect(status, path).toBe(403);
      expect(body.error?.code, path).toBe(code);
    }
    expect(
      (await send("analytics/insights/overview", bearer(baseToken), "POST"))
        .body.error?.code,
    ).toBe("AI_ROUTE_FORBIDDEN");
    expect(
      (await send("analytics/insights/prune", bearer(baseToken), "POST")).body
        .error?.code,
    ).toBe("AI_RUN_REQUIRED");
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves raw IP records closed to the base token, whose refusal now names the switch", async () => {
    const send = await start(refusesUnread());
    expect(
      await send("community/analytics/ips", bearer(baseToken)),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "SENSITIVE_SWITCH_OFF" } },
    });
    expect(
      await send("community/analytics/status", bearer(baseToken)),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "AI_ROUTE_FORBIDDEN" } },
    });
    expect(port.recentIps).not.toHaveBeenCalled();
    expect(
      (await send("community/analytics/ips", bearer(ownerToken))).status,
    ).toBe(200);
  });

  it("answers a bad query by name before the reader runs", async () => {
    const read = refusesUnread();
    const send = await start(read);
    for (const query of [
      "constructor=1",
      "__proto__=1",
      "limit=0",
      "limit=99999",
      "range=today&range=today",
    ]) {
      const { status, body } = await send(
        `analytics/insights/overview?${query}`,
        bearer(baseToken),
      );
      expect(status, query).toBe(400);
      expect(body.error?.code, query).toBe("INPUT_INVALID");
      expect(body.error?.issues?.length, query).toBeGreaterThan(0);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("carries a reader's refusal, timeout and unavailable store as named answers", async () => {
    let fail: unknown;
    const send = await start(async () => {
      throw fail;
    });
    const answer = () => send("analytics/insights/overview", bearer(baseToken));
    fail = new AnalyticsInsightRefusal(400, "INPUT_INVALID", [
      { path: ["from"], code: "out_of_retention" },
    ]);
    expect(await answer()).toMatchObject({
      status: 400,
      body: { error: { code: "INPUT_INVALID" } },
    });
    fail = new AnalyticsInsightRefusal(403, "SELF_ONLY_OWNER_REVIEW");
    expect(await answer()).toMatchObject({
      status: 403,
      body: { error: { code: "SELF_ONLY_OWNER_REVIEW" } },
    });
    fail = new AnalyticsInsightTimeout();
    expect(await answer()).toMatchObject({
      status: 503,
      body: { error: { code: "READ_TIMED_OUT" } },
    });
    fail = new CommunityStoreUnavailableError();
    expect(await answer()).toMatchObject({
      status: 503,
      body: { error: { code: "STORE_UNAVAILABLE" } },
    });
  });

  it("refuses an answer that breaks its contract rather than passing it on", async () => {
    const send = await start(
      vi.fn(async () => ({
        report: "overview",
        leaked: true,
      })) as unknown as AnalyticsInsightsReader["read"],
    );
    const { status } = await send(
      "analytics/insights/overview",
      bearer(baseToken),
    );
    expect(status).toBe(500);
  });

  it("is an operator boundary, so a closed beta does not ask for a session", async () => {
    const send = await start(refusesUnread(), {
      productAccess: { mode: "closed_beta", admits: async () => false },
    });
    expect(
      (await send("analytics/insights/status", bearer(baseToken))).status,
    ).toBe(200);
    expect((await send("analytics/insights/status", {})).status).toBe(401);
  });
});
