import { afterEach, describe, expect, it, vi } from "vitest";

const { relay } = vi.hoisted(() => ({ relay: vi.fn() }));
vi.mock("../../../../../lib/public-api/server", () => ({
  relayServerLocalEditorialMedia: relay,
}));
import { GET } from "./route";

const file = `${"e".repeat(64)}-${"f".repeat(64)}.png`;
const owner = `article-${"3".repeat(32)}`;
const params = { params: Promise.resolve({ owner, file }) };
afterEach(() => {
  vi.unstubAllEnvs();
  relay.mockReset();
});

describe("GET /api/editorial-media/[owner]/[file]", () => {
  it("exists only in Development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await GET(
      new Request(`http://web.invalid/api/editorial-media/${owner}/${file}`),
      params,
    );
    expect(response.status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });

  it("relays the named file in Development and refuses a query", async () => {
    vi.stubEnv("NODE_ENV", "development");
    relay.mockResolvedValue(new Response(null, { status: 200 }));
    expect(
      (
        await GET(
          new Request(
            `http://web.invalid/api/editorial-media/${owner}/${file}`,
          ),
          params,
        )
      ).status,
    ).toBe(200);
    expect(relay).toHaveBeenCalledWith(owner, file);
    expect(
      (
        await GET(
          new Request(
            `http://web.invalid/api/editorial-media/${owner}/${file}?x=1`,
          ),
          params,
        )
      ).status,
    ).toBe(404);
  });
});
