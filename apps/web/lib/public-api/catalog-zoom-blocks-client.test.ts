import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCatalogZoomBlocks } from "./catalog-zoom-blocks";
import {
  catalogZoomGrid,
  fetchSameOriginCatalogZoomBlocks,
} from "./catalog-zoom-blocks-client";

/*
 * catalog-deep-zoom-v1 (Issue #295), criteria 12 and 14: the block-list read
 * through the Backend transport and the same-origin client. Both parse
 * strictly; in Development the client turns each block URL into the
 * same-origin relay path, as Catalog renditions do; malformed ids read
 * nothing.
 */

const relay = (n: number) =>
  `http://127.0.0.1:3001/v1/development/catalog-renditions/media-rendition-${n.toString(16).padStart(32, "0")}`;
const list = {
  width: 2048,
  height: 1365,
  edge: 1024,
  overlap: 2,
  srcs: [0, 1, 2, 3].map(relay),
};
const respond = (status: number, body: unknown = list) =>
  vi.fn(
    async () =>
      new Response(status === 200 ? JSON.stringify(body) : null, { status }),
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Backend transport", () => {
  it("reads v1/catalog/{catalogId}/media/{mediaId}/zoom-blocks and parses strictly", async () => {
    const fetch = respond(200);
    const result = await fetchCatalogZoomBlocks(
      { baseUrl: new URL("http://127.0.0.1:3001/"), fetch },
      "catalog-zoom",
      "media-zoom",
    );
    expect(result).toEqual({ state: "success", blocks: list });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/v1/catalog/catalog-zoom/media/media-zoom/zoom-blocks",
      { method: "GET", headers: { Accept: "application/json" } },
    );
    for (const [status, state] of [
      [404, "not-found"],
      [503, "unavailable"],
      [500, "unexpected-error"],
    ] as const)
      expect(
        await fetchCatalogZoomBlocks(
          {
            baseUrl: new URL("http://127.0.0.1:3001/"),
            fetch: respond(status),
          },
          "catalog-zoom",
          "media-zoom",
        ),
      ).toEqual({ state });
    expect(
      await fetchCatalogZoomBlocks(
        {
          baseUrl: new URL("http://127.0.0.1:3001/"),
          fetch: respond(200, { ...list, srcs: list.srcs.slice(1) }),
        },
        "catalog-zoom",
        "media-zoom",
      ),
    ).toEqual({ state: "unexpected-error" });
  });
});

describe("the same-origin client", () => {
  const context = (fetch: typeof globalThis.fetch) => ({
    baseUrl: new URL("http://192.168.1.20:3000/catalog/catalog-zoom"),
    fetch,
  });

  it("rewrites block URLs to the same-origin relay in Development only", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fetch = respond(200);
    const result = await fetchSameOriginCatalogZoomBlocks(
      "catalog-zoom",
      "media-zoom",
      undefined,
      context(fetch),
    );
    expect(result.state).toBe("success");
    expect(result.state === "success" && result.blocks.srcs[0]).toBe(
      `/api/development/catalog-renditions/media-rendition-${"0".repeat(32)}`,
    );
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "http://192.168.1.20:3000/api/catalog/catalog-zoom/media/media-zoom/zoom-blocks",
    );
    vi.stubEnv("NODE_ENV", "production");
    const production = await fetchSameOriginCatalogZoomBlocks(
      "catalog-zoom",
      "media-zoom",
      undefined,
      context(respond(200)),
    );
    expect(production.state === "success" && production.blocks.srcs).toEqual(
      list.srcs,
    );
  });

  it("reads nothing for a malformed id and reports failures by state", async () => {
    const fetch = respond(200);
    expect(
      await fetchSameOriginCatalogZoomBlocks(
        "",
        "media-zoom",
        undefined,
        context(fetch),
      ),
    ).toEqual({ state: "not-found" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await fetchSameOriginCatalogZoomBlocks(
        "catalog-zoom",
        "media-zoom",
        undefined,
        context(respond(404)),
      ),
    ).toEqual({ state: "not-found" });
    expect(catalogZoomGrid).toEqual({ edge: 1024, overlap: 2 });
  });

  it("rethrows an abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("paged away"));
    const fetch = vi.fn(async () => {
      throw controller.signal.reason;
    });
    await expect(
      fetchSameOriginCatalogZoomBlocks(
        "catalog-zoom",
        "media-zoom",
        controller.signal,
        context(fetch),
      ),
    ).rejects.toThrow("paged away");
  });
});
