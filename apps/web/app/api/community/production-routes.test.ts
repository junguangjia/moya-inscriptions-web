import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST, PUT } from "./[...path]/route";
import { GET as authGet, POST as authPost } from "./auth/[...path]/route";
import { GET as stream } from "./notifications/stream/route";

const ingress =
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const relay =
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const origin = "https://product.invalid";
const backend = "http://backend.invalid/";
const session = "S".repeat(43);
const account = `user-${"a".repeat(32)}`;
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`${origin}/api/community/${path}`, {
    method,
    headers: {
      host: "product.invalid",
      origin,
      cookie: `yoyi-session=${session}; payload-token=synthetic-not-forwarded`,
      "x-author-account": account,
      "x-moya-auth-ingress": ingress,
      "x-moya-client-ip": "192.0.2.11",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const capabilities = (developmentOnly: boolean) => ({
  profile: "email-first",
  email: { available: true, reason: null },
  phone: { available: false, reason: "AUTH_CHANNEL_UNAVAILABLE" },
  developmentOnly,
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("AUTH_INGRESS_TOKEN", ingress);
  vi.stubEnv("AUTH_SOURCE_RELAY_TOKEN", relay);
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", backend);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Production community route relays", () => {
  it.each([
    `authors/${account}`,
    `authors/${account}/following`,
    `authors/${account}/followers`,
    "me/blocks",
    `authors/${account}/favorites`,
    `authors/${account}/likes`,
    "discover?kind=all",
    "publishing/drafts",
    "threads",
    "messages",
    "notifications",
    "editorial/articles",
    "article-authoring",
  ])("relays %s to the real Backend namespace", async (path) => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ route: path }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await GET(request(path));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: path });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/${path}`,
    );
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${session}`);
    expect(headers.has("cookie")).toBe(false);
    if (path === "notifications" || path === "article-authoring")
      expect(headers.get("x-author-account")).toBe(account);
  });

  it("preserves same-origin and confirmed-account checks on real mutations", async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ saved: true }),
    );
    vi.stubGlobal("fetch", upstream);
    const accepted = await POST(
      request("content/favorite", "POST", { enabled: true }),
    );
    expect(accepted.status).toBe(200);
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).get("x-author-account"),
    ).toBe(account);
    const foreign = request("content/favorite", "POST", {});
    foreign.headers.set("origin", "https://foreign.invalid");
    expect((await POST(foreign)).status).toBe(403);
    const changedAccount = request("content/favorite", "POST", {});
    changedAccount.headers.set("x-author-account", "not-a-user");
    expect((await POST(changedAccount)).status).toBe(422);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("keeps Article document PUT within its existing namespace", async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ saved: true }),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      (await PUT(request("article-authoring/article-id", "PUT", {}))).status,
    ).toBe(200);
    expect((await PUT(request("me/profile", "PUT", {}))).status).toBe(405);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("retains Development business relay behavior", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ available: true })),
    );
    expect((await GET(request("threads"))).status).toBe(200);
  });
});

describe("Production authentication relay", () => {
  it("accepts delivered real capabilities and refuses Development-only verification", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(capabilities(false)))
      .mockResolvedValueOnce(Response.json(capabilities(true)));
    vi.stubGlobal("fetch", upstream);
    const real = await authGet(request("auth/capabilities"));
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual(capabilities(false));
    const simulated = await authGet(request("auth/capabilities"));
    expect(simulated.status).toBe(503);
    expect(await simulated.text()).toBe("");
  });

  it("does not substitute a Development provider when auth is unavailable", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", upstream);
    expect((await authGet(request("auth/capabilities"))).status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/auth/capabilities`,
    );
  });

  it.each([
    "passwords/login",
    "challenges/verify",
    "registrations",
    "factors/complete",
  ])("preserves the HttpOnly session relay for %s", async (path) => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        session: {
          token: session,
          expiresAt: "2030-01-01T00:00:00.000Z",
          profile: {
            id: account,
            handle: "runtime-user",
            displayName: "Runtime user",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await authPost(request(`auth/${path}`, "POST", {}));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Lax; Secure",
    );
    expect((await response.json()).session).not.toHaveProperty("token");
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/auth/${path}`,
    );
  });

  it("uses the real logout API and clears the browser cookie", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await authPost(request("auth/sign-out", "POST", {}));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/auth/sign-out`,
    );
  });
});

describe("Production notification stream", () => {
  it("streams the authenticated Backend response and carries request cancellation", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response("event: changed\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const incoming = request("notifications/stream");
    const response = await stream(incoming);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.text()).toBe("event: changed\ndata: {}\n\n");
    expect(upstream.mock.calls[0]?.[1]?.signal).toBe(incoming.signal);
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${session}`);
  });

  it("requires a session without calling the Backend", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const incoming = request("notifications/stream");
    incoming.headers.delete("cookie");
    expect((await stream(incoming)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
