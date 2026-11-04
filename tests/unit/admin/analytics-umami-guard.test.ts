import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  adminMcpEnvelopeSchema,
  UMAMI_READ_ROUTES,
} from "@moya/contracts/internal/admin-mcp";

import {
  ANALYTICS_CACHE_TTL_MS,
  ANALYTICS_SETTLED_AFTER_MS,
  UMAMI_CALL_BUDGET_MS,
  UMAMI_OVERRUN_HOLD_MS,
  UMAMI_POOL_SHARE,
  UMAMI_TOOL_BUDGET_MS,
  CANONICAL_POOL_SHARE,
  analyticsEnvelope,
  analyticsTtlMs,
  createAnalyticsCache,
  createPoolSlots,
  createUmamiGuard,
  umamiFailureEnvelope,
} from "admin/admin-mcp";
import { createUmamiUpstream } from "admin/analytics-upstream";

const site = "10000000-0000-4000-8000-000000000001";
const session = "20000000-0000-4000-8000-000000000002";
const base = "/admin/analytics-workspace";
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-11-04T04:30:20.000Z");
// Built at runtime, so no credential-shaped literal is tracked.
const viewerToken = ["synthetic", "viewer", "session", "fixture"].join("-");

const stats = (pageviews: number | string | null = 7) => ({
  pageviews,
  visitors: 3,
  accountVisitors: 1,
  legacyPageviews: 0,
  visits: 4,
  bounces: 1,
  totaltime: 90,
  comparison: {
    pageviews: 5,
    visitors: 2,
    visits: 3,
    bounces: 0,
    totaltime: 60,
  },
});

type Respond = (url: URL, response: ServerResponse) => void;

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A real server, reached through the real upstream client and fetch. */
const startStub = async (initial: Respond) => {
  let respond = initial;
  let active = 0;
  let peak = 0;
  let logins = 0;
  let closedEarly = 0;
  let aloneViolation = false;
  const hits: { url: URL; method: string; authorization?: string }[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url!, "http://stub.invalid");
      active += 1;
      peak = Math.max(peak, active);
      let open = true;
      response.on("close", () => {
        if (open) active -= 1;
        open = false;
        if (!response.writableFinished) closedEarly += 1;
      });
      if (url.pathname.endsWith("/api/auth/login")) {
        logins += 1;
        request.resume();
        json(response, { token: viewerToken });
        return;
      }
      hits.push({
        url,
        method: request.method!,
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      if (url.pathname.endsWith("/pageviews") && active > 1)
        aloneViolation = true;
      respond(url, response);
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  closers.push(close);
  return {
    environment: {
      UMAMI_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      UMAMI_WEBSITE_ID: site,
      UMAMI_VIEWER_USERNAME: "synthetic-viewer",
      UMAMI_VIEWER_PASSWORD: ["synthetic", "fixture", "value"].join("-"),
    },
    hits,
    setRespond: (next: Respond) => {
      respond = next;
    },
    peak: () => peak,
    active: () => active,
    logins: () => logins,
    closedEarly: () => closedEarly,
    aloneViolation: () => aloneViolation,
    close,
  };
};

type Stub = Awaited<ReturnType<typeof startStub>>;

const guardFor = (
  stub: Stub,
  options: Parameters<typeof createUmamiGuard>[0] = {},
) =>
  createUmamiGuard({
    upstream: createUmamiUpstream(stub.environment),
    environment: stub.environment,
    ...options,
  });

const hang: Respond = () => undefined;
const answerStats: Respond = (_url, response) => json(response, stats());

/** A settled day: finished long ago, so its answer holds for hours. */
const settled = {
  start: new Date(NOW - 72 * HOUR_MS),
  end: new Date(NOW - 48 * HOUR_MS),
  complete: true,
};

const settledDay = (back: number) => ({
  start: new Date(NOW - (72 + back * 24) * HOUR_MS),
  end: new Date(NOW - (48 + back * 24) * HOUR_MS),
  complete: true,
});

const until = async (done: () => boolean, withinMs = 2_000) => {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > withinMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Umami route allowlist", () => {
  it("names exactly these routes, so a new one is a reviewed row", () => {
    expect(
      Object.entries(UMAMI_READ_ROUTES).map(([name, row]) => [name, row.path]),
    ).toEqual([
      ["website", ""],
      ["stats", "/stats"],
      ["metrics", "/metrics"],
      ["pageviews", "/pageviews"],
      ["sessions", "/sessions"],
      ["session", "/sessions/{sessionId}"],
      ["weekly", "/sessions/weekly"],
      ["retention", "/retention"],
      ["journey", "/journeys"],
      ["attribution", "/attribution"],
      ["goal", "/goals/{goalId}/stats"],
      ["funnel", "/funnels/{funnelId}/stats"],
      ["funnels", "/funnels"],
      ["goals", "/goals"],
      ["segments", "/segments"],
      ["annotations", "/annotations"],
    ]);
  });

  it("marks the route that runs two queries at once as holding both of its slots", () => {
    expect(UMAMI_POOL_SHARE).toBe(2);
    expect(UMAMI_READ_ROUTES.pageviews.pool).toBe(2);
    expect(UMAMI_READ_ROUTES.stats.pool).toBe(1);
    expect(UMAMI_READ_ROUTES.metrics.pool).toBe(1);
  });

  it("has the section 19 limits", () => {
    expect(UMAMI_CALL_BUDGET_MS).toBe(6_000);
    expect(UMAMI_TOOL_BUDGET_MS).toBe(8_000);
    expect(UMAMI_OVERRUN_HOLD_MS).toBe(5_000);
  });

  it.each([
    "export",
    "reset",
    "mcp",
    "realtime",
    "send",
    "constructor",
    "__proto__",
    "toString",
  ])("refuses %s with no upstream call", async (route) => {
    const stub = await startStub(answerStats);
    const answer = await guardFor(stub)
      .forTool()
      .read(route as "stats", { range: settled });
    expect(answer).toMatchObject({
      status: "failed",
      code: "INPUT_INVALID",
      issues: [{ path: ["route"], code: "route_not_allowed" }],
    });
    expect(stub.hits).toHaveLength(0);
    expect(stub.logins()).toBe(0);
  });

  it.each([
    [
      "an inherited key name",
      JSON.parse('{"type":"region","constructor":"x"}'),
    ],
    ["a prototype key", JSON.parse('{"type":"region","__proto__":"x"}')],
    ["an unknown filter", { type: "region", path: "/works/x" }],
    ["a type off the list", { type: "distinctId" }],
    ["a zero limit", { type: "region", limit: 0 }],
    ["a limit past the cap", { type: "region", limit: 501 }],
    ["a fractional limit", { type: "region", limit: 1.5 }],
    ["a limit that is no number", { type: "region", limit: Number.NaN }],
    ["an unbounded limit", { type: "region", limit: Number.POSITIVE_INFINITY }],
    ["a limit as text", { type: "region", limit: "5" }],
    ["a NUL in a filter", { type: "region", region: "a\u0000b" }],
    ["a bad segment id", { type: "region", segment: "not-an-id" }],
  ])("refuses %s by name, with no value and no call", async (_name, query) => {
    const stub = await startStub(answerStats);
    const answer = await guardFor(stub)
      .forTool()
      .read("metrics", {
        range: settled,
        query: query as { type: "region" },
      });
    expect(answer).toMatchObject({ status: "failed", code: "INPUT_INVALID" });
    expect(JSON.stringify(answer)).not.toContain("not-an-id");
    expect(stub.hits).toHaveLength(0);
  });

  it("refuses a path id that could leave the route", async () => {
    const stub = await startStub(answerStats);
    const answer = await guardFor(stub)
      .forTool()
      .read("session", { query: { sessionId: "../../reset" } });
    expect(answer).toMatchObject({ code: "INPUT_INVALID" });
    expect(JSON.stringify(answer)).not.toContain("reset");
    expect(stub.hits).toHaveLength(0);
  });

  it.each([
    ["stats", {}, "required"],
    ["funnels", { range: settled }, "not_for_this_route"],
    [
      "stats",
      {
        range: {
          start: new Date(Number.NaN),
          end: new Date(NOW),
          complete: true,
        },
      },
      "invalid_range",
    ],
    [
      "stats",
      { range: { start: new Date(NOW), end: new Date(NOW), complete: true } },
      "invalid_range",
    ],
  ])("refuses a range on %s: %j", async (route, input, code) => {
    const stub = await startStub(answerStats);
    const answer = await guardFor(stub)
      .forTool()
      .read(route as "stats", input);
    expect(answer).toMatchObject({
      code: "INPUT_INVALID",
      issues: [{ path: ["range"], code }],
    });
    expect(stub.hits).toHaveLength(0);
  });

  it("reads only over GET, straight to Umami's own API on loopback, as the viewer", async () => {
    const stub = await startStub(answerStats);
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("stats", { range: settled });
    expect(answer.status).toBe("fresh");
    expect(stub.hits).toHaveLength(1);
    const [hit] = stub.hits;
    expect(hit!.method).toBe("GET");
    expect(hit!.url.pathname).toBe(`${base}/api/websites/${site}/stats`);
    expect(hit!.authorization).toBe(`Bearer ${viewerToken}`);
    expect(hit!.url.searchParams.get("startAt")).toBe(
      String(settled.start.getTime()),
    );
    // Umami's end is included and a complete range's is not.
    expect(hit!.url.searchParams.get("endAt")).toBe(
      String(settled.end.getTime() - 1),
    );
  });

  it("keeps Umami's previous period whole on compare=prev, and moves nothing else", async () => {
    const stub = await startStub(answerStats);
    const guard = guardFor(stub, { now: () => NOW });
    const sent = async (
      range: typeof settled,
      query: { readonly compare?: "prev" | "yoy" },
    ) => {
      const answer = await guard.forTool().read("stats", { range, query });
      const { searchParams } = stub.hits.at(-1)!.url;
      return {
        answer,
        startAt: Number(searchParams.get("startAt")),
        endAt: Number(searchParams.get("endAt")),
      };
    };
    const start = settled.start.getTime();
    const end = settled.end.getTime();

    const prev = await sent(settled, { compare: "prev" });
    expect([prev.startAt, prev.endAt]).toEqual([start - 1, end - 1]);
    // Umami's own sum: the length in whole minutes, cut short, off both ends.
    const taken = Math.trunc((prev.endAt - prev.startAt) / 60_000) * 60_000;
    expect(prev.startAt - taken).toBe(start - (end - start) - 1);
    expect(prev.endAt - taken).toBe(start - 1);
    expect(prev.answer).toMatchObject({
      status: "fresh",
      covers: {
        start: settled.start.toISOString(),
        end: settled.end.toISOString(),
      },
    });

    const yoy = await sent(settled, { compare: "yoy" });
    expect([yoy.startAt, yoy.endAt]).toEqual([start, end - 1]);
    const plain = await sent(settled, {});
    expect([plain.startAt, plain.endAt]).toEqual([start, end - 1]);
    const open = await sent(
      { start: settled.start, end: new Date(NOW), complete: false },
      { compare: "prev" },
    );
    expect(open.startAt).toBe(start);
    expect(open.endAt).toBe(Date.parse("2026-11-04T04:30:00.000Z"));
    expect(stub.hits).toHaveLength(4);
  });

  it("fills a path id from the query and keeps it out of the query string", async () => {
    const stub = await startStub((_url, response) =>
      json(response, {
        id: session,
        browser: "chrome",
        os: null,
        device: "mobile",
        screen: null,
        language: null,
        country: "CN",
        region: "CN-11",
        city: "Beijing",
        firstAt: "2026-11-03T00:00:00.000Z",
        lastAt: "2026-11-03T00:05:00.000Z",
        visits: 1,
        views: 2,
      }),
    );
    await guardFor(stub)
      .forTool()
      .read("session", { query: { sessionId: session } });
    expect(stub.hits[0]!.url.pathname).toBe(
      `${base}/api/websites/${site}/sessions/${session}`,
    );
    expect(stub.hits[0]!.url.search).toBe("");
  });

  it.each([
    ["no website id", { UMAMI_WEBSITE_ID: undefined }],
    ["a website id that is not an id", { UMAMI_WEBSITE_ID: "x/../reset" }],
    ["an origin off loopback", { UMAMI_ORIGIN: "https://example.invalid" }],
    ["no viewer", { UMAMI_VIEWER_USERNAME: undefined }],
  ])("answers UMAMI_NOT_CONFIGURED with %s", async (_name, change) => {
    const stub = await startStub(answerStats);
    const environment = { ...stub.environment, ...change };
    const answer = await createUmamiGuard({
      upstream: createUmamiUpstream(environment),
      environment,
    })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toEqual({ status: "failed", code: "UMAMI_NOT_CONFIGURED" });
    expect(stub.hits).toHaveLength(0);
    expect(stub.logins()).toBe(0);
  });
});

describe("Umami replies", () => {
  it("keeps only the fields the schema names, and digits become numbers", async () => {
    const stub = await startStub((_url, response) =>
      json(response, {
        ...stats("12"),
        ip: "203.0.113.9",
        shareId: "synthetic-share",
        accessCode: "synthetic-access",
        bearer: "synthetic-bearer",
      }),
    );
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toMatchObject({
      status: "fresh",
      value: { pageviews: 12, visitors: 3 },
    });
    for (const secret of ["203.0.113.9", "synthetic-"])
      expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it("hides a website's invitation and sharing capabilities", async () => {
    const stub = await startStub((_url, response) =>
      json(response, {
        id: site,
        name: "Synthetic",
        domain: "localhost",
        createdAt: "2026-01-01T00:00:00.000Z",
        resetAt: null,
        shareId: "synthetic-share",
        accessCode: "synthetic-access",
      }),
    );
    const answer = await guardFor(stub).forTool().read("website");
    expect(answer).toMatchObject({
      status: "fresh",
      value: { id: site, name: "Synthetic", resetAt: null },
    });
    expect(JSON.stringify(answer)).not.toContain("synthetic-share");
    expect(JSON.stringify(answer)).not.toContain("synthetic-access");
  });

  it("leaves no IP on a session and none in what the cache keeps", async () => {
    const body = {
      id: session,
      browser: "chrome",
      os: "android",
      device: "mobile",
      screen: "390x844",
      language: "zh-CN",
      country: "CN",
      region: "CN-11",
      city: "Beijing",
      firstAt: "2026-11-03T00:00:00.000Z",
      lastAt: "2026-11-03T00:05:00.000Z",
      visits: 1,
      views: 2,
      ip: "203.0.113.9",
      canDelete: true,
    };
    let clock = NOW;
    const stub = await startStub((_url, response) => json(response, body));
    const cache = createAnalyticsCache({ now: () => clock });
    const read = () =>
      guardFor(stub, { now: () => clock, cache, callMs: 30, toolMs: 60 })
        .forTool()
        .read("session", { query: { sessionId: session } });
    const answer = await read();
    expect(answer.status).toBe("fresh");
    expect(JSON.stringify(answer)).not.toContain("203.0.113.9");
    clock += ANALYTICS_CACHE_TTL_MS.open;
    stub.setRespond(hang);
    const kept = await read();
    expect(kept.status).toBe("stale");
    expect(JSON.stringify(kept)).toContain("CN-11");
    expect(JSON.stringify(kept)).not.toContain("203.0.113.9");
    expect(JSON.stringify(kept)).not.toContain("canDelete");
  });

  it.each([
    ["a null count", stats(null)],
    ["text where a count goes", stats("many")],
    ["a missing field", { pageviews: 1 }],
    ["an empty object", {}],
    ["an array", []],
  ])("answers no number for %s", async (_name, body) => {
    const stub = await startStub((_url, response) => json(response, body));
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toEqual({
      status: "failed",
      code: "UMAMI_REPLY_INVALID",
      reason: "invalid",
    });
  });

  it("answers no number for a page that is not JSON, and does not cache it", async () => {
    const stub = await startStub((_url, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html></html>");
    });
    const guard = guardFor(stub, { now: () => NOW });
    const first = await guard.forTool().read("stats", { range: settled });
    expect(first).toMatchObject({ code: "UMAMI_REPLY_INVALID" });
    stub.setRespond(answerStats);
    const second = await guard.forTool().read("stats", { range: settled });
    expect(second).toMatchObject({ status: "fresh", cache: { hit: false } });
    expect(stub.hits).toHaveLength(2);
  });

  it("keeps a funnel's divide-by-nothing null, never a zero", async () => {
    const stub = await startStub((_url, response) =>
      json(response, [
        {
          type: "path",
          value: "/works",
          visitors: 0,
          previous: 0,
          dropped: 0,
          dropoff: null,
          remaining: null,
        },
      ]),
    );
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("funnel", {
        range: settled,
        query: { funnelId: session },
      });
    expect(answer).toMatchObject({
      status: "fresh",
      value: [{ dropoff: null, remaining: null }],
    });
  });

  it.each([
    [404, { code: "NOT_FOUND" }],
    [400, { code: "UMAMI_REPLY_INVALID", reason: "rejected" }],
    [401, { code: "UMAMI_REPLY_INVALID", reason: "rejected" }],
    [403, { code: "UMAMI_REPLY_INVALID", reason: "rejected" }],
    [500, { code: "UMAMI_QUERY_TIMEOUT", reason: "unavailable" }],
    [503, { code: "UMAMI_QUERY_TIMEOUT", reason: "unavailable" }],
  ])("names what a %i means", async (status, expected) => {
    const stub = await startStub((_url, response) =>
      json(response, { error: "synthetic" }, status),
    );
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toMatchObject({ status: "failed", ...expected });
  });

  it("does not follow a redirect", async () => {
    const elsewhere = await startStub(answerStats);
    const stub = await startStub((_url, response) => {
      response.writeHead(302, {
        location: `${elsewhere.environment.UMAMI_ORIGIN}/api/send`,
      });
      response.end();
    });
    const answer = await guardFor(stub, { now: () => NOW })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toMatchObject({
      code: "UMAMI_REPLY_INVALID",
      reason: "rejected",
    });
    expect(elsewhere.hits).toHaveLength(0);
  });
});

describe("Umami concurrency", () => {
  it("never holds more than 2 calls, login included, and uses both", async () => {
    const stub = await startStub((_url, response) => {
      setTimeout(() => json(response, []), 15);
    });
    const guard = guardFor(stub, { now: () => NOW });
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_value, limit) =>
        guard.forTool().read("metrics", {
          range: settled,
          query: { type: "region", limit: limit + 1 },
        }),
      ),
    );
    expect(answers.every((answer) => answer.status === "fresh")).toBe(true);
    expect(stub.hits).toHaveLength(12);
    expect(stub.peak()).toBe(2);
  });

  it("gives a route that runs two queries at once both slots", async () => {
    const stub = await startStub((url, response) => {
      setTimeout(
        () =>
          json(
            response,
            url.pathname.endsWith("/pageviews")
              ? { pageviews: [], sessions: [] }
              : [],
          ),
        10,
      );
    });
    const guard = guardFor(stub, { now: () => NOW });
    const reads = Array.from({ length: 6 }, (_value, index) =>
      index % 2 === 0
        ? guard.forTool().read("metrics", {
            range: settled,
            query: { type: "city", limit: index + 1 },
          })
        : guard.forTool().read("pageviews", {
            range: settledDay(index),
            query: { unit: "day", timezone: "Asia/Shanghai" },
          }),
    );
    const answers = await Promise.all(reads);
    expect(answers.every((answer) => answer.status === "fresh")).toBe(true);
    expect(stub.aloneViolation()).toBe(false);
  });

  it("answers at the limit but keeps the slot until the call has really ended", async () => {
    const finish: (() => void)[] = [];
    const starts: string[] = [];
    const upstream = {
      request: (path: string) => {
        starts.push(path);
        return new Promise<Response>((resolve) => {
          finish.push(() => resolve(Response.json(stats())));
        });
      },
    };
    const guard = createUmamiGuard({
      upstream,
      environment: { UMAMI_WEBSITE_ID: site },
      now: () => NOW,
      callMs: 20,
      toolMs: 60,
    });
    const answers = await Promise.all(
      [0, 1, 2].map((back) =>
        guard.forTool().read("stats", { range: settledDay(back) }),
      ),
    );
    // All three answered, and the third never started: two calls still run.
    expect(answers.map((answer) => answer.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(starts).toHaveLength(2);
    // Their end frees the slots, and a new read can start.
    finish.splice(0).forEach((end) => end());
    const later = guard.forTool().read("stats", { range: settledDay(3) });
    await until(() => starts.length === 3);
    finish.splice(0).forEach((end) => end());
    expect((await later).status).toBe("fresh");
  });
});

describe("Umami after a timeout", () => {
  it("keeps the slot while Umami's query may still run, then frees it", async () => {
    const stub = await startStub(hang);
    const guard = guardFor(stub, { callMs: 20, toolMs: 40, overrunMs: 500 });
    await Promise.all(
      [0, 1].map((back) =>
        guard.forTool().read("stats", { range: settledDay(back) }),
      ),
    );
    const sent = stub.hits.length;
    // Both timed out, so both slots are held: this one waits and gives up unsent.
    const queued = await guard
      .forTool()
      .read("stats", { range: settledDay(2) });
    expect(queued).toMatchObject({ code: "UMAMI_QUERY_TIMEOUT" });
    expect(stub.hits).toHaveLength(sent);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await guard.forTool().read("stats", { range: settledDay(3) });
    expect(stub.hits).toHaveLength(sent + 1);
  });

  it("frees the slot at once when a call failed fast, because nothing runs on", async () => {
    const stub = await startStub((_url, response) => json(response, {}, 500));
    const guard = guardFor(stub, { overrunMs: 60_000 });
    await Promise.all(
      [0, 1].map((back) =>
        guard.forTool().read("stats", { range: settledDay(back) }),
      ),
    );
    stub.setRespond(answerStats);
    const next = await guard.forTool().read("stats", { range: settledDay(2) });
    expect(next.status).toBe("fresh");
  });

  it("gives up on a body that never finishes", async () => {
    const stub = await startStub((_url, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"pageviews":');
    });
    const answer = await guardFor(stub, { callMs: 100, toolMs: 5_000 })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toMatchObject({
      code: "UMAMI_QUERY_TIMEOUT",
      reason: "timed_out",
    });
    await until(() => stub.active() === 0);
  });
});

describe("Umami single-flight and cache", () => {
  it("makes one upstream call for identical parallel reads, and later ones show their age", async () => {
    let clock = NOW;
    const stub = await startStub((_url, response) => {
      setTimeout(() => json(response, stats(41)), 15);
    });
    const guard = guardFor(stub, {
      now: () => clock,
      cache: createAnalyticsCache({ now: () => clock }),
    });
    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        guard.forTool().read("stats", { range: settled }),
      ),
    );
    expect(stub.hits).toHaveLength(1);
    for (const answer of answers)
      expect(answer).toMatchObject({
        status: "fresh",
        value: { pageviews: 41 },
        cache: { hit: false, ageMs: 0 },
      });
    clock += 1_234;
    const later = await guard.forTool().read("stats", { range: settled });
    expect(stub.hits).toHaveLength(1);
    expect(later).toMatchObject({
      status: "fresh",
      asOf: new Date(NOW).toISOString(),
      cache: { hit: true, ageMs: 1_234 },
    });
  });

  it("treats the same query in any key order as one query", async () => {
    const stub = await startStub((_url, response) => json(response, []));
    const guard = guardFor(stub, { now: () => NOW });
    await guard.forTool().read("metrics", {
      range: settled,
      query: { type: "region", limit: 5, region: "CN-11" },
    });
    const second = await guard.forTool().read("metrics", {
      range: settled,
      query: { region: "CN-11", limit: 5, type: "region" },
    });
    expect(second).toMatchObject({ status: "fresh", cache: { hit: true } });
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    ["a different limit", { type: "region", limit: 6 }, settled],
    ["a different type", { type: "city", limit: 5 }, settled],
    ["a different end", { type: "region", limit: 5 }, settledDay(1)],
  ])("does not merge %s", async (_name, query, range) => {
    const stub = await startStub((_url, response) => json(response, []));
    const guard = guardFor(stub, { now: () => NOW });
    await guard.forTool().read("metrics", {
      range: settled,
      query: { type: "region", limit: 5 },
    });
    await guard.forTool().read("metrics", {
      range,
      query: query as { type: "region" },
    });
    expect(stub.hits).toHaveLength(2);
  });

  it("does not let a realtime read take an open read's older answer", async () => {
    const stub = await startStub(answerStats);
    const guard = guardFor(stub, { now: () => NOW });
    const range = {
      start: new Date(NOW - HOUR_MS),
      end: new Date(NOW),
      complete: false,
    };
    await guard.forTool().read("stats", { range });
    await guard.forTool().read("stats", { range, realtime: true });
    expect(stub.hits).toHaveLength(2);
  });

  it("snaps an open range to the minute, so one minute is one call", async () => {
    let clock = NOW;
    const stub = await startStub(answerStats);
    const guard = guardFor(stub, {
      now: () => clock,
      cache: createAnalyticsCache({ now: () => clock }),
    });
    const open = { start: new Date(NOW - HOUR_MS), complete: false };
    const minute = Date.parse("2026-11-04T04:30:00.000Z");
    const first = await guard.forTool().read("stats", {
      range: { ...open, end: new Date(clock) },
    });
    clock += 15_000;
    const second = await guard.forTool().read("stats", {
      range: { ...open, end: new Date(clock) },
    });
    expect(stub.hits).toHaveLength(1);
    expect(stub.hits[0]!.url.searchParams.get("endAt")).toBe(String(minute));
    expect(first).toMatchObject({
      status: "fresh",
      covers: { end: new Date(minute).toISOString() },
    });
    expect(second).toMatchObject({ status: "fresh", cache: { hit: true } });
    clock = minute + 60_000;
    const third = await guard.forTool().read("stats", {
      range: { ...open, end: new Date(clock) },
    });
    expect(stub.hits).toHaveLength(2);
    expect(third).toMatchObject({
      status: "fresh",
      cache: { hit: false },
      covers: { end: new Date(minute + 60_000).toISOString() },
    });
  });

  it("gives a range that started this minute an end after its start", async () => {
    const stub = await startStub(answerStats);
    const guard = guardFor(stub, { now: () => NOW });
    const answer = await guard.forTool().read("stats", {
      range: {
        start: new Date(NOW - 5_000),
        end: new Date(NOW),
        complete: false,
      },
    });
    expect(answer.status).toBe("fresh");
    const { searchParams } = stub.hits[0]!.url;
    expect(Number(searchParams.get("endAt"))).toBeGreaterThan(
      Number(searchParams.get("startAt")),
    );
  });

  const ttlCases = [
    [
      "realtime",
      "stats",
      {
        range: {
          start: new Date(NOW - HOUR_MS),
          end: new Date(NOW),
          complete: false,
        },
        realtime: true as const,
      },
      10_000,
    ],
    ["a read with no range", "funnels", {}, 60_000],
    [
      "a finished period not yet settled",
      "stats",
      {
        range: {
          start: new Date(NOW - 2 * HOUR_MS),
          end: new Date(NOW - HOUR_MS),
          complete: true,
        },
      },
      5 * 60_000,
    ],
    ["a settled period", "stats", { range: settled }, 6 * HOUR_MS],
  ] as const;

  it.each(ttlCases)(
    "holds %s for its TTL and reads again at its end",
    async (_name, route, input, ttl) => {
      // The realtime window's minute is fixed, so only the TTL can end this answer.
      const start = Date.parse("2026-11-04T04:30:00.000Z");
      let clock = start;
      const stub = await startStub((url, response) =>
        json(
          response,
          url.pathname.endsWith("/funnels")
            ? { data: [], count: 0, page: 1, pageSize: 20 }
            : stats(),
        ),
      );
      const guard = guardFor(stub, {
        now: () => clock,
        cache: createAnalyticsCache({ now: () => clock }),
      });
      const read = () =>
        guard
          .forTool()
          .read(route as "stats", input as { range: typeof settled });
      await read();
      clock = start + ttl - 1;
      expect(await read()).toMatchObject({
        status: "fresh",
        cache: { hit: true, ageMs: ttl - 1 },
      });
      expect(stub.hits).toHaveLength(1);
      clock = start + ttl;
      expect(await read()).toMatchObject({
        status: "fresh",
        cache: { hit: false, ageMs: 0 },
      });
      expect(stub.hits).toHaveLength(2);
    },
  );

  it("calls a period settled 24.5 hours after it ends", () => {
    expect(ANALYTICS_SETTLED_AFTER_MS).toBe(24.5 * HOUR_MS);
    expect(ANALYTICS_CACHE_TTL_MS).toEqual({
      realtime: 10_000,
      open: 60_000,
      unsettled: 300_000,
      settled: 21_600_000,
    });
    const end = NOW;
    expect(analyticsTtlMs({ end }, end + 24.5 * HOUR_MS - 1)).toBe(300_000);
    expect(analyticsTtlMs({ end }, end + 24.5 * HOUR_MS)).toBe(21_600_000);
    expect(analyticsTtlMs("open", end)).toBe(60_000);
    expect(analyticsTtlMs("realtime", end)).toBe(10_000);
  });

  it("evicts the least recently used answer past its byte limit", async () => {
    const cache = createAnalyticsCache({ now: () => NOW, maxBytes: 250 });
    const load = (size: number) => async () => "x".repeat(size);
    const read = (family: string, size: number) =>
      cache.read({
        family,
        version: "",
        ttlMs: 1_000,
        waitMs: 1_000,
        load: load(size),
      });
    await read("a", 100);
    await read("b", 100);
    // Reading a keeps it, so b is the oldest when c arrives.
    expect(await read("a", 100)).toMatchObject({ hit: true });
    await read("c", 100);
    expect(cache.latest("a")).toBeDefined();
    expect(cache.latest("b")).toBeUndefined();
    expect(cache.latest("c")).toBeDefined();
    // Replacing an answer frees its old bytes, so nothing else has to go.
    await cache.read({
      family: "a",
      version: "next",
      ttlMs: 1_000,
      waitMs: 1_000,
      load: load(100),
    });
    expect(cache.latest("c")).toBeDefined();
    // One answer past the whole limit is not kept, and takes nothing with it.
    await read("huge", 400);
    expect(cache.latest("huge")).toBeUndefined();
    expect(cache.latest("a")).toBeDefined();
    expect(cache.latest("c")).toBeDefined();
  });

  it("stores nothing from a read that ran through a purge", async () => {
    const respondLater: (() => void)[] = [];
    const stub = await startStub((_url, response) => {
      respondLater.push(() => json(response, stats(1)));
    });
    const guard = guardFor(stub, { now: () => NOW });
    const running = guard.forTool().read("stats", { range: settled });
    await until(() => respondLater.length === 1);
    guard.purge();
    respondLater[0]!();
    expect((await running).status).toBe("fresh");
    // With no time left only a held answer could come back, and none is held.
    const held = await guard
      .forTool()
      .read("stats", { range: settled, softMs: 0 });
    expect(held).toMatchObject({ code: "UMAMI_QUERY_TIMEOUT" });
    expect(stub.hits).toHaveLength(1);
  });

  it("never lets a read after a purge join one from before it", async () => {
    const respondLater: (() => void)[] = [];
    const stub = await startStub((_url, response) => {
      const nth = respondLater.length + 1;
      respondLater.push(() => json(response, stats(nth)));
    });
    const guard = guardFor(stub, { now: () => NOW });
    const before = guard.forTool().read("stats", { range: settled });
    await until(() => respondLater.length === 1);
    guard.purge();
    const after = guard.forTool().read("stats", { range: settled });
    await until(() => respondLater.length === 2);
    respondLater[1]!();
    expect(await after).toMatchObject({ value: { pageviews: 2 } });
    respondLater[0]!();
    expect(await before).toMatchObject({ value: { pageviews: 1 } });
  });

  it("drops a held answer on purge, so the next read goes to Umami", async () => {
    const stub = await startStub(answerStats);
    const guard = guardFor(stub, { now: () => NOW });
    await guard.forTool().read("stats", { range: settled });
    guard.purge();
    const next = await guard.forTool().read("stats", { range: settled });
    expect(next).toMatchObject({ cache: { hit: false } });
    expect(stub.hits).toHaveLength(2);
  });
});

describe("Umami slow or down", () => {
  it("answers UMAMI_QUERY_TIMEOUT with retryAfterMs and gives the connection up", async () => {
    const stub = await startStub(hang);
    const started = Date.now();
    // The tool's limit is far away, so only the call's own limit can end this.
    const answer = await guardFor(stub, { callMs: 100, toolMs: 5_000 })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toEqual({
      status: "failed",
      code: "UMAMI_QUERY_TIMEOUT",
      reason: "timed_out",
      retryAfterMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The abort reached the wire: Umami's connection is not left to run.
    await until(() => stub.closedEarly() === 1 && stub.active() === 0);
  });

  it("carries that in a valid envelope with no number in it", async () => {
    const stub = await startStub(hang);
    const answer = await guardFor(stub, { callMs: 30, toolMs: 60 })
      .forTool()
      .read("stats", { range: settled });
    expect(answer.status).toBe("failed");
    if (answer.status !== "failed") return;
    const envelope = adminMcpEnvelopeSchema.parse(umamiFailureEnvelope(answer));
    expect(envelope).toMatchObject({
      ok: false,
      code: "UMAMI_QUERY_TIMEOUT",
      retryable: true,
      data: { reason: "timed_out", retryAfterMs: 30 },
    });
    expect(envelope.hint).toContain("narrow the range");
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
      ADMIN_MCP_TEXT_CAP_BYTES,
    );
  });

  it("serves the last answer marked stale, never as fresh", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const stub = await startStub((_url, response) =>
      json(response, stats(100)),
    );
    await guardFor(stub, { now: () => clock, cache })
      .forTool()
      .read("stats", { range: settled });
    clock += ANALYTICS_CACHE_TTL_MS.settled + 500;
    stub.setRespond(hang);
    const answer = await guardFor(stub, {
      now: () => clock,
      cache,
      callMs: 30,
      toolMs: 60,
    })
      .forTool()
      .read("stats", { range: settled });
    expect(answer).toEqual({
      status: "stale",
      value: expect.objectContaining({ pageviews: 100 }),
      asOf: new Date(NOW).toISOString(),
      covers: {
        start: settled.start.toISOString(),
        end: settled.end.toISOString(),
      },
      cache: {
        hit: true,
        ageMs: ANALYTICS_CACHE_TTL_MS.settled + 500,
        stale: true,
      },
      reason: "timed_out",
      retryAfterMs: 30,
    });
  });

  it("serves an open range's last minute as stale, saying which minute it covers", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const open = { start: new Date(NOW - HOUR_MS), complete: false };
    const stub = await startStub(answerStats);
    await guardFor(stub, { now: () => clock, cache })
      .forTool()
      .read("stats", { range: { ...open, end: new Date(clock) } });
    clock += 3 * 60_000;
    stub.setRespond(hang);
    const answer = await guardFor(stub, {
      now: () => clock,
      cache,
      callMs: 30,
      toolMs: 60,
    })
      .forTool()
      .read("stats", { range: { ...open, end: new Date(clock) } });
    expect(answer).toMatchObject({
      status: "stale",
      covers: { end: "2026-11-04T04:30:00.000Z" },
      cache: { stale: true, ageMs: 180_000 },
    });
  });

  it("never answers one finished period with another's numbers", async () => {
    const cache = createAnalyticsCache({ now: () => NOW });
    const stub = await startStub((_url, response) => json(response, stats(9)));
    await guardFor(stub, { now: () => NOW, cache })
      .forTool()
      .read("stats", { range: settled });
    stub.setRespond(hang);
    const answer = await guardFor(stub, {
      now: () => NOW,
      cache,
      callMs: 30,
      toolMs: 60,
    })
      .forTool()
      .read("stats", {
        range: {
          start: settled.start,
          end: new Date(settled.end.getTime() + HOUR_MS),
          complete: true,
        },
      });
    expect(answer).toMatchObject({
      status: "failed",
      code: "UMAMI_QUERY_TIMEOUT",
    });
  });

  it("answers the same when Umami is down: unavailable, or stale if it has one", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const stub = await startStub((_url, response) => json(response, stats(5)));
    const guard = guardFor(stub, { now: () => clock, cache });
    await guard.forTool().read("stats", { range: settled });
    clock += ANALYTICS_CACHE_TTL_MS.settled;
    await stub.close();
    const stale = await guard.forTool().read("stats", { range: settled });
    expect(stale).toMatchObject({
      status: "stale",
      reason: "unavailable",
      value: { pageviews: 5 },
      cache: { stale: true },
    });
    const none = await guard.forTool().read("stats", { range: settledDay(9) });
    expect(none).toMatchObject({
      status: "failed",
      code: "UMAMI_QUERY_TIMEOUT",
      reason: "unavailable",
    });
  });

  it("answers stale on a 500 too", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const stub = await startStub((_url, response) => json(response, stats(5)));
    const guard = guardFor(stub, { now: () => clock, cache });
    await guard.forTool().read("stats", { range: settled });
    clock += ANALYTICS_CACHE_TTL_MS.settled;
    stub.setRespond((_url, response) => json(response, {}, 500));
    const answer = await guard.forTool().read("stats", { range: settled });
    expect(answer).toMatchObject({ status: "stale", reason: "unavailable" });
  });

  it("keeps a refusal from reading as an old number", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const stub = await startStub((_url, response) => json(response, stats(5)));
    const guard = guardFor(stub, { now: () => clock, cache });
    await guard.forTool().read("stats", { range: settled });
    clock += ANALYTICS_CACHE_TTL_MS.settled;
    stub.setRespond((_url, response) => json(response, {}, 403));
    expect(await guard.forTool().read("stats", { range: settled })).toEqual({
      status: "failed",
      code: "UMAMI_REPLY_INVALID",
      reason: "rejected",
    });
  });

  it("shares one tool's limit across its reads, and starts nothing past it", async () => {
    const stub = await startStub(hang);
    const tool = guardFor(stub, { callMs: 40, toolMs: 50 }).forTool();
    const started = Date.now();
    await tool.read("stats", { range: settled });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const reads = stub.hits.length;
    const second = await tool.read("stats", { range: settledDay(1) });
    expect(second).toMatchObject({ code: "UMAMI_QUERY_TIMEOUT" });
    expect(stub.hits).toHaveLength(reads);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still serves an answer it holds once the tool's limit is spent", async () => {
    const stub = await startStub(answerStats);
    const cache = createAnalyticsCache();
    await guardFor(stub, { cache }).forTool().read("stats", { range: settled });
    const tool = guardFor(stub, { cache, toolMs: 1 }).forTool();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await tool.read("stats", { range: settled })).toMatchObject({
      status: "fresh",
      cache: { hit: true },
    });
    expect(stub.hits).toHaveLength(1);
  });

  it("never sends a queued read whose callers have all left", async () => {
    const stub = await startStub(hang);
    // The slots come free at once after the call limit, past every caller's limit.
    const guard = guardFor(stub, { callMs: 80, toolMs: 60, overrunMs: 0 });
    const answers = await Promise.all(
      [0, 1, 2, 3].map((back) =>
        guard.forTool().read("stats", { range: settledDay(back) }),
      ),
    );
    expect(answers.every((answer) => answer.status === "failed")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Only the two that held slots reached Umami; the other two gave up in the queue.
    expect(stub.hits.length).toBeLessThanOrEqual(2);
  });

  it("answers a soft budget stale at once while the read fills the cache", async () => {
    let clock = NOW;
    const cache = createAnalyticsCache({ now: () => clock });
    const stub = await startStub((_url, response) => json(response, stats(1)));
    const seed = guardFor(stub, { now: () => clock, cache });
    await seed.forTool().read("stats", { range: settled });
    clock += ANALYTICS_CACHE_TTL_MS.settled;
    let respond: (() => void) | undefined;
    stub.setRespond((_url, response) => {
      respond = () => json(response, stats(2));
    });
    const quick = await seed
      .forTool()
      .read("stats", { range: settled, softMs: 10 });
    expect(quick).toMatchObject({
      status: "stale",
      value: { pageviews: 1 },
      cache: { stale: true },
    });
    await until(() => respond !== undefined);
    respond!();
    // softMs 0 starts nothing: only an answer the running read stored can come back.
    let next = await seed
      .forTool()
      .read("stats", { range: settled, softMs: 0 });
    for (let tries = 0; tries < 200 && next.status !== "fresh"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      next = await seed.forTool().read("stats", { range: settled, softMs: 0 });
    }
    expect(next).toMatchObject({
      status: "fresh",
      value: { pageviews: 2 },
      cache: { hit: true },
    });
    expect(stub.hits).toHaveLength(2);
  });

  it("lets a read that timed out try again once Umami is back", async () => {
    const stub = await startStub(hang);
    const cache = createAnalyticsCache({ now: () => NOW });
    const slow = guardFor(stub, {
      now: () => NOW,
      cache,
      callMs: 30,
      toolMs: 60,
    });
    expect(
      await slow.forTool().read("stats", { range: settled }),
    ).toMatchObject({ code: "UMAMI_QUERY_TIMEOUT" });
    stub.setRespond(answerStats);
    const back = await guardFor(stub, { now: () => NOW, cache })
      .forTool()
      .read("stats", { range: settled });
    expect(back).toMatchObject({ status: "fresh", cache: { hit: false } });
  });
});

describe("canonical reads' share of the community pool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The real service to a real server standing in for the Backend. */
  const start = async (limits: { callMs: number; holdMs: number }) => {
    const stub = await startStub(hang);
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `${stub.environment.UMAMI_ORIGIN}/`,
    );
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", viewerToken);
    const deps = {
      guard: guardFor(stub),
      cache: createAnalyticsCache(),
      now: Date.now,
      canonical: {
        slots: createPoolSlots(CANONICAL_POOL_SHARE),
        ...limits,
      },
    };
    return {
      stub,
      deps,
      // Each day is a different question, so neither the cache nor single flight joins them.
      read: (day: string) =>
        analyticsEnvelope(
          {
            report: "compare",
            dimension: "content",
            from: `2026-03-${day}`,
            to: `2026-03-${day}`,
          },
          deps,
        ),
    };
  };

  it("answers READ_TIMED_OUT with no number when its turn does not come, and never starts", async () => {
    const { stub, read } = await start({ callMs: 100, holdMs: 800 });
    const holders = [read("01"), read("02")];
    const queued = read("03");
    expect(await queued).toMatchObject({ ok: false, code: "READ_TIMED_OUT" });
    expect(await queued).not.toHaveProperty("data");
    expect((await Promise.all(holders)).map(({ code }) => code)).toEqual([
      "READ_TIMED_OUT",
      "READ_TIMED_OUT",
    ]);
    // Past our abort the Backend's read runs on, so its slot stayed taken.
    expect(stub.hits).toHaveLength(CANONICAL_POOL_SHARE);
    // The slots come back, and the read nobody waits for still reaches nothing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stub.hits).toHaveLength(CANONICAL_POOL_SHARE);
    stub.setRespond((_url, response) =>
      json(
        response,
        { error: { status: 503, code: "STORE_UNAVAILABLE" } },
        503,
      ),
    );
    expect(await read("04")).toMatchObject({ code: "ANALYTICS_UNAVAILABLE" });
    expect(stub.hits).toHaveLength(CANONICAL_POOL_SHARE + 1);
  });

  it("answers a native report while both slots are held, because its facts read takes no turn", async () => {
    const { stub, deps, read } = await start({ callMs: 1_000, holdMs: 1_000 });
    stub.setRespond((url, response) => {
      if (url.pathname.endsWith("/native"))
        json(response, {
          report: "native",
          source: "canonical",
          asOf: new Date(NOW).toISOString(),
          range: {
            start: "2026-03-02T16:00:00.000Z",
            end: "2026-03-03T16:00:00.000Z",
            tz: "Asia/Shanghai",
            complete: true,
            dataFrom: null,
          },
          startMs: Date.parse("2026-03-02T16:00:00.000Z"),
          endMs: Date.parse("2026-03-03T16:00:00.000Z"),
          retention: { days: 180, from: "2025-09-12T04:00:00.000Z" },
          outOfRetention: false,
          notes: [],
        });
      else if (url.pathname.endsWith("/sessions/weekly"))
        json(
          response,
          Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
        );
    });
    const holders = [read("01"), read("02")];
    const held = () =>
      stub.hits.filter(({ url }) => url.pathname.endsWith("/compare")).length;
    await vi.waitFor(() => expect(held()).toBe(CANONICAL_POOL_SHARE));
    const native = await analyticsEnvelope(
      {
        report: "native",
        kind: "weekly",
        from: "2026-03-03",
        to: "2026-03-03",
      },
      deps,
    );
    expect(native).toMatchObject({
      ok: true,
      data: { report: "native", kind: "weekly", outOfRetention: false },
    });
    // It answered inside theirs: both reads are still waiting on the Backend.
    const both = Promise.all(holders);
    expect(await Promise.race([both, "waiting"])).toBe("waiting");
    expect((await both).map(({ code }) => code)).toEqual([
      "READ_TIMED_OUT",
      "READ_TIMED_OUT",
    ]);
  });
});
