import type { PayloadRequest } from "payload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const operator = vi.hoisted(() => vi.fn());
vi.mock("../../../apps/admin/src/community/backend", () => ({
  callCommunityOperator: operator,
}));
import { analyticsEndpoints } from "admin/analytics-endpoints";

const request = (
  role: string | null,
  origin = "https://catalog.example.invalid",
) =>
  ({
    url: "https://catalog.example.invalid/api/analytics/exclude-device",
    headers: new Headers({ origin }),
    user: role ? { collection: "users", role } : null,
  }) as PayloadRequest;
const endpoint = (path: string) =>
  analyticsEndpoints.find((item) => item.path === path)!;

beforeEach(() => operator.mockReset());
afterEach(() => vi.unstubAllEnvs());
describe("analytics Owner endpoints", () => {
  it.each([null, "automation", "admin"])(
    "refuses %s without contacting the operator",
    async (role) => {
      for (const path of [
        "/analytics/status",
        "/analytics/ips",
        "/analytics/exclude-device",
      ]) {
        const response = await endpoint(path).handler(request(role));
        expect(response.status).toBe(403);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(operator).not.toHaveBeenCalled();
    },
  );
  it("sets a device exclusion only for same-origin Owner requests", async () => {
    const handler = endpoint("/analytics/exclude-device").handler;
    expect(
      (await handler(request("owner", "https://other.example.invalid"))).status,
    ).toBe(403);
    const response = await handler(request("owner"));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Strict; Secure",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects upstream schema drift without exposing diagnostics", async () => {
    operator.mockResolvedValue({
      items: [],
      unexpected: "synthetic-private-diagnostic",
    });
    const response = await endpoint("/analytics/ips").handler(request("owner"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private-diagnostic");
  });
  it("uses the configured public origin behind an internal HTTP proxy", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", "https://catalog.example.invalid");
    const req = {
      ...request("owner"),
      url: "http://localhost:3002/api/analytics/exclude-device",
    } as PayloadRequest;
    const response = await endpoint("/analytics/exclude-device").handler(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });
});
