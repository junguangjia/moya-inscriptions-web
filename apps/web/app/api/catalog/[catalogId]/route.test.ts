import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchServerCatalogDetailMock } = vi.hoisted(() => ({
  fetchServerCatalogDetailMock: vi.fn(),
}));

vi.mock("../../../../lib/public-api/server", () => ({
  fetchServerCatalogDetail: fetchServerCatalogDetailMock,
}));

import { GET } from "./route";

const request = new Request("http://localhost/api/catalog/catalog-001");
const context = (catalogId: string) => ({
  params: Promise.resolve({ catalogId }),
});

beforeEach(() => {
  fetchServerCatalogDetailMock.mockReset();
});

describe("same-origin Catalog Detail bridge", () => {
  it("returns validated Public Detail JSON", async () => {
    const detail = {
      id: "catalog-001",
      kind: "inscription",
      title: "真实碑刻",
      aliases: [],
      sourceCitations: [],
      media: [],
    };
    fetchServerCatalogDetailMock.mockResolvedValue({
      state: "success",
      detail,
    });

    const response = await GET(request, context(detail.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(fetchServerCatalogDetailMock).toHaveBeenCalledWith(
      detail.id,
      undefined,
    );
  });

  it("hands the visitor's session to the Backend and keeps the answer out of every cache", async () => {
    const session = "s".repeat(43);
    fetchServerCatalogDetailMock.mockResolvedValue({ state: "not-found" });

    const response = await GET(
      new Request("http://localhost/api/catalog/catalog-001", {
        headers: { cookie: `yoyi-session=${session}` },
      }),
      context("catalog-001"),
    );

    expect(fetchServerCatalogDetailMock).toHaveBeenCalledWith(
      "catalog-001",
      session,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it.each([401, 403] as const)(
    "answers the Backend's access refusal as %s without a body",
    async (status) => {
      fetchServerCatalogDetailMock.mockResolvedValue({
        state: "access-denied",
        status,
      });

      const response = await GET(request, context("catalog-001"));

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );

  it.each([
    ["not-found", 404],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("maps %s without exposing internals", async (state, status) => {
    fetchServerCatalogDetailMock.mockResolvedValue({ state });

    const response = await GET(request, context("catalog-001"));

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });
});
