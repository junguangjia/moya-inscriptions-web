import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./server", () => ({
  parsePublicApiBaseUrl: (value: string) => new URL(value),
}));
import { relayServerAnalytics } from "./analytics-server";

const ingress = "i".repeat(43),
  relay = "r".repeat(43);
const id = "11111111-1111-4111-8111-111111111111";
const batch = {
  visitorId: id,
  sessionId: id,
  events: [
    {
      eventId: id,
      name: "page_view",
      surface: "home",
      occurredAt: "2026-10-19T00:00:00Z",
    },
  ],
};
const send = vi.fn();
const request = (change: Record<string, string> = {}, body: unknown = batch) =>
  new Request("https://product.example.test/api/community/analytics", {
    method: "POST",
    headers: {
      origin: "https://product.example.test",
      "content-type": "application/json",
      "x-moya-analytics-ingress": ingress,
      "x-moya-client-ip": "192.0.2.12",
      ...change,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MOYA_ANALYTICS_ENABLED", "true");
  vi.stubEnv("ANALYTICS_INGRESS_TOKEN", ingress);
  vi.stubEnv("ANALYTICS_RELAY_TOKEN", relay);
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:4301/");
  send
    .mockReset()
    .mockResolvedValue(Response.json({ accepted: 1, excluded: false }));
  vi.stubGlobal("fetch", send);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Reviewed mock authorization; the token is an explicit non-live placeholder.
const syntheticAuthorization1 = `Bearer ${"REPLACE_ME_SYNTHETIC_C12A25C7F8F5"}`;

describe("analytics trusted relay", () => {
  it("is disabled by default and in development before any upstream request", async () => {
    vi.stubEnv("MOYA_ANALYTICS_ENABLED", "false");
    expect(await (await relayServerAnalytics(request())).json()).toEqual({
      accepted: 0,
      excluded: false,
    });
    vi.stubEnv("MOYA_ANALYTICS_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect((await relayServerAnalytics(request())).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects unverified ingress, forwarded IP claims, foreign origins and mixed tokens", async () => {
    for (const headers of [
      { "x-moya-analytics-ingress": "forged" },
      { "x-moya-client-ip": "192.0.2.12, 198.51.100.1" },
      { origin: "https://foreign.example.test" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ])
      expect((await relayServerAnalytics(request(headers))).status).toBe(403);
    vi.stubEnv("ANALYTICS_RELAY_TOKEN", ingress);
    expect((await relayServerAnalytics(request())).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects body identity/IP fields and oversized chunked bodies", async () => {
    expect(
      (
        await relayServerAnalytics(
          request({}, { ...batch, userId: "forged", ip: "198.51.100.4" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await relayServerAnalytics(request({}, " ".repeat(60_001)))).status,
    ).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });
  it("relays only verified source, server session and cookie exclusion, never browser forwarding claims", async () => {
    const response = await relayServerAnalytics(
      request({
        "x-forwarded-for": "198.51.100.3",
        "x-moya-analytics-source": "198.51.100.3",
        "x-moya-analytics-excluded": "1",
        "user-agent": "SyntheticBrowser",
        cookie: "moya-analytics-excluded=1; payload-token=unrelated",
      }),
    );
    expect(response.status).toBe(200);
    const [, options] = send.mock.calls[0]!;
    expect(options.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-moya-analytics-relay": relay,
      "x-moya-analytics-source": "192.0.2.12",
      "x-moya-analytics-excluded": "1",
      "user-agent": "SyntheticBrowser",
    });
    expect(options.body).toBe(JSON.stringify(batch));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("forwards only the public session cookie as server authorization", async () => {
    const syntheticSession = "s".repeat(43);
    await relayServerAnalytics(
      request({
        cookie: `yoyi-session=${syntheticSession}; payload-token=unrelated`,
        authorization: syntheticAuthorization1,
      }),
    );
    expect(send.mock.calls[0]?.[1].headers.authorization).toBe(
      `Bearer ${syntheticSession}`,
    );
  });
  it("does not trust a browser exclusion header without the device cookie", async () => {
    await relayServerAnalytics(request({ "x-moya-analytics-excluded": "1" }));
    expect(
      send.mock.calls[0]?.[1].headers["x-moya-analytics-excluded"],
    ).toBeUndefined();
  });
});
