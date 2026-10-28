import { describe, expect, it, vi } from "vitest";
import { createAnalyticsProxy } from "admin/analytics-proxy";
import { createUmamiUpstream } from "admin/analytics-upstream";

const base = "/admin/analytics-workspace";
const url = (path: string) => `https://catalog.example.invalid${base}${path}`;
const environment = {
  UMAMI_ORIGIN: "http://127.0.0.1:3010",
  UMAMI_VIEWER_USERNAME: "synthetic-viewer",
  UMAMI_VIEWER_PASSWORD: "synthetic-fixture-password-not-a-live-credential",
};
const fixtureToken = "synthetic-session-for-fixture-only";

// Reviewed mock authorization; the token is an explicit non-live placeholder.
const syntheticAuthorization1 = `Bearer ${"REPLACE_ME_SYNTHETIC_311782FA2ED2"}`;

describe("private native analytics workspace", () => {
  it.each(["links", "pixels"])(
    "preserves existing team %s analysis pages and list reads without opening writes or management",
    async (kind) => {
      const team = "10000000-0000-4000-8000-000000000001";
      const request = vi.fn(async () => Response.json({ data: [], count: 0 }));
      const proxy = createAnalyticsProxy({
        isOwner: async () => true,
        upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
      });
      expect(
        (await proxy(new Request(url(`/teams/${team}/${kind}`)))).status,
      ).toBe(200);
      expect(
        (await proxy(new Request(url(`/api/teams/${team}/${kind}`)))).status,
      ).toBe(200);
      const reads = request.mock.calls.length;
      expect(
        (
          await proxy(
            new Request(url(`/api/teams/${team}/${kind}`), { method: "POST" }),
          )
        ).status,
      ).toBe(405);
      expect(
        (await proxy(new Request(url(`/api/teams/${team}/users`)))).status,
      ).toBe(404);
      expect(
        (await proxy(new Request(url(`/teams/${team}/api/auth/login`)))).status,
      ).toBe(404);
      expect(request).toHaveBeenCalledTimes(reads);
    },
  );
  it.each([
    "/_next/static/app.js",
    "/api/config",
    "/websites",
    "/api/auth/verify",
  ])("refuses a non-Owner before requesting %s", async (path) => {
    const request = vi.fn();
    const proxy = createAnalyticsProxy({
      isOwner: async () => false,
      upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
    });
    expect((await proxy(new Request(url(path)))).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });

  it("boots the pinned UI without exposing a token or forwarding browser authority", async () => {
    const calls: { path: string; headers: Headers; body: unknown }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return path.endsWith("/auth/login")
        ? Response.json({ token: fixtureToken })
        : Response.json(
            { user: { id: "synthetic-user", isAdmin: false }, teams: [] },
            { headers: { "set-cookie": "synthetic-never-forward=1" } },
          );
    });
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: createUmamiUpstream(environment, fetcher),
    });
    const response = await proxy(
      new Request(url("/api/auth/verify"), {
        method: "POST",
        headers: {
          cookie: "synthetic-payload-cookie=1",
          authorization: syntheticAuthorization1,
        },
        body: JSON.stringify({ token: "synthetic-browser-supplied-value" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("authorization")).toBe(
      `Bearer ${fixtureToken}`,
    );
    expect(calls[1]?.headers.get("cookie")).toBeNull();
    expect(calls[1]?.body).toBe("{}");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain(fixtureToken);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it.each([
    ["POST", "/api/send"],
    ["POST", "/api/batch"],
    ["POST", "/api/auth/login"],
    ["GET", "/share/synthetic-capability"],
    ["GET", "/api/users"],
    ["GET", "/api/auth/login"],
    ["GET", "/teams/synthetic/api/me"],
    ["GET", "/TEAMS/synthetic/api/me"],
    ["GET", "/%74eams/synthetic/api/me"],
    ["GET", "/API/ME"],
    ["GET", "/teams/10000000-0000-4000-8000-000000000001/api/me"],
    [
      "GET",
      "/teams/10000000-0000-4000-8000-000000000001/api/teams/10000000-0000-4000-8000-000000000001",
    ],
    ["GET", "/teams/10000000-0000-4000-8000-000000000001/compat/api/reports"],
    [
      "GET",
      "/teams/10000000-0000-4000-8000-000000000001/teams/10000000-0000-4000-8000-000000000001/api/me",
    ],
    [
      "GET",
      "/teams/10000000-0000-4000-8000-000000000001/websites/10000000-0000-4000-8000-000000000001/api/me",
    ],
    ["DELETE", "/api/websites/synthetic"],
    ["POST", "/api/websites/synthetic/funnels"],
  ])(
    "blocks %s %s independently of native permissions",
    async (method, path) => {
      const request = vi.fn();
      const proxy = createAnalyticsProxy({
        isOwner: async () => true,
        upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
      });
      expect(
        (await proxy(new Request(url(path), { method }))).status,
      ).toBeGreaterThanOrEqual(400);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("streams assets and native RSC without caching private responses", async () => {
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("rsc")).toBe("1");
      expect(
        new Headers(init.headers).get("next-router-segment-prefetch"),
      ).toBe("/_tree");
      return new Response("synthetic RSC stream", {
        headers: {
          "content-type": "text/x-component",
          vary: "RSC",
          "cache-control": "public",
        },
      });
    });
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
    });
    const response = await proxy(
      new Request(url("/websites/synthetic"), {
        headers: { RSC: "1", "next-router-segment-prefetch": "/_tree" },
      }),
    );
    expect(await response.text()).toBe("synthetic RSC stream");
    expect(response.headers.get("content-type")).toBe("text/x-component");
    expect(response.headers.get("vary")).toBe("RSC, Cookie");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("projects native /api/me without exposing its server auth context", async () => {
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: {
        origin: () => new URL(environment.UMAMI_ORIGIN),
        request: async () =>
          Response.json({
            token: fixtureToken,
            authKey: "synthetic-auth-key",
            shareToken: "synthetic-share-token",
            authType: "user",
            user: {
              id: "synthetic-user",
              username: "viewer",
              isAdmin: false,
              password: "synthetic-never-export",
            },
          }),
      },
    });
    const response = await proxy(new Request(url("/api/me")));
    expect(await response.json()).toEqual({
      authType: "user",
      user: { id: "synthetic-user", username: "viewer", isAdmin: false },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("restores the native RSC envelope before requesting the separate Next server", async () => {
    const request = vi.fn(async (path: string, init: RequestInit) => {
      expect(
        new URL(path, environment.UMAMI_ORIGIN).searchParams.get("_rsc"),
      ).toBe("synthetic-cache-hash");
      const headers = new Headers(init.headers);
      expect(headers.get("rsc")).toBe("1");
      expect(headers.get("next-url")).toBe(
        "/admin/analytics-workspace/websites",
      );
      expect(headers.get("next-router-segment-prefetch")).toBe("/_tree");
      expect(headers.get("x-moya-umami-rsc")).toBeNull();
      return new Response("synthetic RSC");
    });
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
    });
    const response = await proxy(
      new Request(url("/websites"), {
        headers: {
          "x-moya-umami-rsc": "1",
          "x-moya-umami-next-url": "/admin/analytics-workspace/websites",
          "x-moya-umami-next-router-segment-prefetch": "/_tree",
          "x-moya-umami-rsc-query": "synthetic-cache-hash",
        },
      }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ["/api/me/teams", "team"],
    ["/api/teams/10000000-0000-4000-8000-000000000001", "detail"],
    ["/api/me/websites", "website"],
    ["/api/teams/10000000-0000-4000-8000-000000000001/websites", "website"],
    ["/api/users/10000000-0000-4000-8000-000000000001/websites", "website"],
    ["/api/websites", "website"],
    ["/api/websites/10000000-0000-4000-8000-000000000001", "website-detail"],
  ])(
    "removes invitation and sharing capabilities from %s",
    async (path, shape) => {
      const row = {
        id: "synthetic-id",
        name: "Synthetic",
        domain: "localhost",
        accessCode: "synthetic-join-secret",
        shareId: "synthetic-share-capability",
        members: [
          {
            userId: "synthetic-member",
            role: "view-only",
            password: "synthetic-no-export",
          },
        ],
      };
      const request = vi.fn<(path: string) => Promise<Response>>(async () =>
        Response.json(
          shape.endsWith("detail")
            ? row
            : { data: [row], count: 1, page: 1, pageSize: 10 },
        ),
      );
      const proxy = createAnalyticsProxy({
        isOwner: async () => true,
        upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
      });
      const response = await proxy(new Request(url(path)));
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("Synthetic");
      expect(text).not.toContain("synthetic-join-secret");
      expect(text).not.toContain("synthetic-share-capability");
      expect(text).not.toContain("synthetic-no-export");
      if (path.startsWith("/api/users/"))
        expect(request.mock.calls[0]?.[0]).toBe(`${base}/api/me/websites`);
    },
  );

  it("does not follow a redirect that could expose server authority", async () => {
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: {
        origin: () => new URL(environment.UMAMI_ORIGIN),
        request: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://external.example.invalid/" },
          }),
      },
    });
    expect((await proxy(new Request(url("/websites")))).status).toBe(502);
  });

  it("returns a bounded generic failure without upstream diagnostics", async () => {
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: {
        origin: () => new URL(environment.UMAMI_ORIGIN),
        request: async () => {
          throw new Error("synthetic-private-diagnostic");
        },
      },
    });
    const response = await proxy(new Request(url("/websites")));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private-diagnostic");
  });
});

describe("Umami server-side session client", () => {
  it("coalesces concurrent logins and refreshes an expired session once", async () => {
    let logins = 0;
    let reject = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/auth/login")) {
        logins += 1;
        return Response.json({ token: fixtureToken });
      }
      if (reject) {
        reject = false;
        return new Response(null, { status: 401 });
      }
      return Response.json({ ok: true });
    });
    const upstream = createUmamiUpstream(environment, fetcher);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        upstream.request(`${base}/api/config`, {}),
      ),
    );
    expect(logins).toBe(1);
    reject = true;
    expect((await upstream.request(`${base}/api/config`, {})).status).toBe(200);
    expect(logins).toBe(2);
  });

  it.each([
    "https://external.example.invalid",
    "http://127.0.0.1:3010/wrong",
    "http://127.0.0.1:3010/?unexpected=1",
  ])(
    "rejects an unexpected origin %s before sending credentials",
    async (origin) => {
      const fetcher = vi.fn<typeof fetch>();
      const upstream = createUmamiUpstream(
        { ...environment, UMAMI_ORIGIN: origin },
        fetcher,
      );
      await expect(upstream.request(`${base}/api/config`, {})).rejects.toThrow(
        "ANALYTICS_NOT_CONFIGURED",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("analytics static asset reuse", () => {
  it.each([
    "/_next/static/chunks/0mqay9f16jzy9.js",
    "/_next/static/css/08a4277ce80f892d.css",
  ])("privately caches only build addressed assets: %s", async (path) => {
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("if-none-match")).toBe(
        '"synthetic-build-etag"',
      );
      return new Response("synthetic asset", {
        headers: {
          "content-type": path.endsWith(".js")
            ? "application/javascript"
            : "text/css",
          etag: '"synthetic-build-etag"',
        },
      });
    });
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
    });
    const result = await proxy(
      new Request(url(path), {
        headers: { "if-none-match": '"synthetic-build-etag"' },
      }),
    );
    expect(result.headers.get("cache-control")).toBe("private, no-cache");
    expect(result.headers.get("etag")).toBe('"synthetic-build-etag"');
    expect(result.headers.get("vary")).toContain("Cookie");
  });
  it.each([
    "/api/config",
    "/websites/synthetic",
    "/_next/static/app.js",
    "/_next/static/chunks/webpack-runtime.js",
    "/_next/static/chunks/app-build-manifest.js",
    "/_next/static/chunks/react-refresh.js",
    "/_next/static/chunks/polyfills-es2015.js",
    "/maps/china-provinces.json",
  ])("keeps %s private and fresh", async (path) => {
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      expect(new Headers(init.headers).has("if-none-match")).toBe(false);
      return new Response("synthetic", {
        headers: { etag: '"synthetic-etag"' },
      });
    });
    const proxy = createAnalyticsProxy({
      isOwner: async () => true,
      upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
    });
    expect(
      (
        await proxy(
          new Request(url(path), {
            headers: { "if-none-match": '"synthetic-etag"' },
          }),
        )
      ).headers.get("cache-control"),
    ).toBe("private, no-store");
  });
});

it("authenticates and revalidates a cached asset without repeating its body", async () => {
  const isOwner = vi.fn(async () => true);
  const request = vi.fn(async (_path: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("if-none-match")).toBe(
      '"synthetic-build-etag"',
    );
    return new Response(null, {
      status: 304,
      headers: { etag: '"synthetic-build-etag"' },
    });
  });
  const proxy = createAnalyticsProxy({
    isOwner,
    upstream: { request, origin: () => new URL(environment.UMAMI_ORIGIN) },
  });
  const response = await proxy(
    new Request(url("/_next/static/chunks/0mqay9f16jzy9.js"), {
      headers: { "if-none-match": '"synthetic-build-etag"' },
    }),
  );
  expect(isOwner).toHaveBeenCalledOnce();
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("cache-control")).not.toContain("immutable");
});
