import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchServerCatalogZoomBlocksMock } = vi.hoisted(() => ({
  fetchServerCatalogZoomBlocksMock: vi.fn(),
}));

vi.mock("../../../../../../../lib/public-api/server", () => ({
  fetchServerCatalogZoomBlocks: fetchServerCatalogZoomBlocksMock,
}));

import { GET } from "./route";

/*
 * catalog-deep-zoom-v1: the same-origin relay of one image's block list
 * forwards the visitor's session, keeps the answer out of every cache and
 * maps every Backend state to a bodiless status.
 */

const path =
  "http://localhost/api/catalog/catalog-001/media/media-001/zoom-blocks";
const context = (catalogId: string, mediaId: string) => ({
  params: Promise.resolve({ catalogId, mediaId }),
});
const blocks = {
  width: 2048,
  height: 1365,
  edge: 1024,
  overlap: 2,
  srcs: [0, 1, 2, 3].map(
    (cell) =>
      `https://images.example.invalid/v1/a/b/base/block-0${cell}.r1.jpg`,
  ),
};

beforeEach(() => {
  fetchServerCatalogZoomBlocksMock.mockReset();
});

describe("same-origin Catalog block-list relay", () => {
  it("returns the block list with the visitor's session, never cached", async () => {
    const session = "s".repeat(43);
    fetchServerCatalogZoomBlocksMock.mockResolvedValue({
      state: "success",
      blocks,
    });

    const response = await GET(
      new Request(path, { headers: { cookie: `yoyi-session=${session}` } }),
      context("catalog-001", "media-001"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(blocks);
    expect(fetchServerCatalogZoomBlocksMock).toHaveBeenCalledWith(
      "catalog-001",
      "media-001",
      session,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it.each([
    [{ state: "access-denied", status: 403 }, 403],
    [{ state: "not-found" }, 404],
    [{ state: "unavailable" }, 503],
    [{ state: "unexpected-error" }, 502],
  ] as const)("answers %j as %s without a body", async (result, status) => {
    fetchServerCatalogZoomBlocksMock.mockResolvedValue(result);

    const response = await GET(
      new Request(path),
      context("catalog-001", "media-001"),
    );

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });
});
