import type { PayloadRequest } from "payload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readReport = vi.hoisted(() => vi.fn());
vi.mock("../../../apps/admin/src/analytics/upstream", () => ({
  readAdminAnalyticsReport: readReport,
}));
vi.mock("../../../apps/admin/src/community/backend", () => ({
  callCommunityOperator: vi.fn(),
}));
import { analyticsEndpoints } from "admin/analytics-endpoints";

const endpoint = analyticsEndpoints.find(
  (item) => item.path === "/analytics/report",
)!;
const query =
  "resource=metrics&type=region&startAt=1767225600000&endAt=1767312000000&country=CN";
const request = (role: string | null, params = query, method = "GET") =>
  ({
    method,
    url: `https://catalog.example.invalid/api/analytics/report?${params}`,
    headers: new Headers({
      authorization: "REPLACE_ME_SYNTHETIC_AUTHORIZATION_HEADER",
      cookie: "synthetic-owner-session=1",
    }),
    user: role ? { collection: "users", role } : null,
  }) as PayloadRequest;
beforeEach(() => {
  readReport.mockReset();
  vi.stubEnv("UMAMI_ORIGIN", "http://127.0.0.1:3010");
  vi.stubEnv("UMAMI_WEBSITE_ID", "10000000-0000-4000-8000-000000000001");
  vi.stubEnv("UMAMI_VIEWER_USERNAME", "synthetic-server-reader");
  vi.stubEnv("UMAMI_VIEWER_PASSWORD", "REPLACE_ME_SYNTHETIC_NOT_VALID");
});
afterEach(() => vi.unstubAllEnvs());

describe("native analytics Owner read endpoint", () => {
  it.each([null, "automation", "admin"])(
    "refuses %s before any read or query work",
    async (role) => {
      expect(
        (await endpoint.handler(request(role, "resource=map&url=bad"))).status,
      ).toBe(403);
      expect(readReport).not.toHaveBeenCalled();
    },
  );
  it("only passes validated data, not browser authority, to the fixed reader", async () => {
    const result = {
      resource: "metrics",
      data: [{ x: "CN-BJ", y: 3, displayName: "北京市" }],
      limit: 100,
      offset: 0,
    };
    readReport.mockResolvedValue(result);
    const response = await endpoint.handler(request("owner"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(readReport).toHaveBeenCalledWith({
      resource: "metrics",
      type: "region",
      startAt: 1767225600000,
      endAt: 1767312000000,
      country: "CN",
      timezone: "Asia/Shanghai",
      unit: "day",
      limit: 100,
      offset: 0,
    });
    expect(readReport.mock.calls[0]).toHaveLength(1);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it.each([
    `${query}&resource=map`,
    `${query}&websiteId=other`,
    `${query}&url=https://external.example.invalid`,
    `${query}&q=北京`,
    "resource=map&startAt=1",
    "resource=summary&startAt=1&endAt=99999999999999",
    "resource=expanded&type=city&startAt=1&endAt=2&limit=101",
  ])("rejects invalid or duplicate fields without IO: %s", async (params) => {
    expect((await endpoint.handler(request("owner", params))).status).toBe(400);
    expect(readReport).not.toHaveBeenCalled();
  });
  it("is GET-only even when its handler is invoked directly", async () => {
    const response = await endpoint.handler(request("owner", query, "POST"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(readReport).not.toHaveBeenCalled();
  });
  it("does not require Board configuration or expose service failures", async () => {
    vi.stubEnv("UMAMI_BOARD_ID", "");
    readReport.mockRejectedValue(new Error("synthetic-private-error-body"));
    const response = await endpoint.handler(request("owner"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ANALYTICS_UNAVAILABLE" });
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("rejects an invalid internal DTO rather than exposing an unexpected field", async () => {
    readReport.mockResolvedValue({
      resource: "metrics",
      data: [],
      limit: 100,
      offset: 0,
      token: "synthetic-private",
    });
    const response = await endpoint.handler(request("owner"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private");
  });
  it("reports missing configuration instead of returning fake data", async () => {
    vi.stubEnv("UMAMI_VIEWER_PASSWORD", "");
    const response = await endpoint.handler(request("owner"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ANALYTICS_NOT_CONFIGURED",
    });
    expect(readReport).not.toHaveBeenCalled();
  });
});
