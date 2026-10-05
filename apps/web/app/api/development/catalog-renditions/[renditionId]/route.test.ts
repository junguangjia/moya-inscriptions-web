import { afterEach, describe, expect, it, vi } from "vitest";

const { relay } = vi.hoisted(() => ({ relay: vi.fn() }));
vi.mock("../../../../../lib/public-api/server", () => ({
  relayServerDevelopmentCatalogRendition: relay,
}));
import { GET } from "./route";

const renditionId = `media-rendition-${"d".repeat(32)}`;
const params = { params: Promise.resolve({ renditionId }) };
const url = `http://web.invalid/api/development/catalog-renditions/${renditionId}`;
afterEach(() => {
  vi.unstubAllEnvs();
  relay.mockReset();
});

describe("GET /api/development/catalog-renditions/[renditionId]", () => {
  it.each(["production", "test"])("does not exist in %s", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const response = await GET(new Request(url), params);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(relay).not.toHaveBeenCalled();
  });

  it("relays the named rendition in Development and refuses a query", async () => {
    vi.stubEnv("NODE_ENV", "development");
    relay.mockResolvedValue(new Response(null, { status: 200 }));
    expect((await GET(new Request(url), params)).status).toBe(200);
    expect(relay).toHaveBeenCalledWith(renditionId);
    relay.mockClear();
    expect((await GET(new Request(`${url}?x=1`), params)).status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });
});
