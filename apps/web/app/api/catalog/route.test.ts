import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchServerCatalogPageMock } = vi.hoisted(() => ({
  fetchServerCatalogPageMock: vi.fn(),
}));

vi.mock("../../../lib/public-api/server", () => ({
  fetchServerCatalogPage: fetchServerCatalogPageMock,
}));

import { GET } from "./route";

const request = (query = "", cookie?: string) =>
  new Request(`http://localhost/api/catalog${query}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
const session = "s".repeat(43);

const emptyPage = {
  items: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 0,
};

beforeEach(() => {
  fetchServerCatalogPageMock.mockReset();
  fetchServerCatalogPageMock.mockResolvedValue({
    page: emptyPage,
    state: "success",
  });
});

describe("same-origin Catalog list bridge", () => {
  it.each([
    ["", {}],
    ["?kind=inscription", { kind: "inscription" }],
    ["?kind=calligraphy", { kind: "calligraphy" }],
    ["?page=2&pageSize=24", { page: "2", pageSize: "24" }],
    [
      "?kind=inscription&page=3&pageSize=24",
      { kind: "inscription", page: "3", pageSize: "24" },
    ],
  ])("accepts the declared query %s", async (query, expected) => {
    const response = await GET(request(query));

    expect(response.status).toBe(200);
    expect(fetchServerCatalogPageMock).toHaveBeenCalledOnce();
    expect(fetchServerCatalogPageMock).toHaveBeenCalledWith(
      expected,
      undefined,
    );
    expect(await response.json()).toEqual(emptyPage);
  });

  it("hands the visitor's session to the Backend and keeps the answer out of every cache", async () => {
    const response = await GET(
      request("?kind=inscription", `theme=dark; yoyi-session=${session}`),
    );

    expect(response.status).toBe(200);
    expect(fetchServerCatalogPageMock).toHaveBeenCalledWith(
      { kind: "inscription" },
      session,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it.each([401, 403] as const)(
    "answers the Backend's access refusal as %s, never as a page or a failure",
    async (status) => {
      fetchServerCatalogPageMock.mockResolvedValue({
        state: "access-denied",
        status,
      });

      const response = await GET(request());

      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
    },
  );

  it.each([
    "?page=",
    "?page=0",
    "?page=-1",
    "?page=1.5",
    "?pageSize=0",
    "?pageSize=101",
    "?kind=painting",
    "?unknown=value",
    "?page=1&page=2",
    "?kind=inscription&kind=calligraphy",
  ])("rejects invalid, unknown, or duplicated query: %s", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(fetchServerCatalogPageMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("maps %s without exposing internals", async (state, status) => {
    fetchServerCatalogPageMock.mockResolvedValue({ state });

    const response = await GET(request("?kind=inscription&page=2&pageSize=24"));

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  it("rejects an invalid upstream page", async () => {
    fetchServerCatalogPageMock.mockResolvedValue({
      page: { ...emptyPage, pageSize: 0 },
      state: "success",
    });

    const response = await GET(request());

    expect(response.status).toBe(502);
  });

  it("maps an unexpected server failure to 502", async () => {
    fetchServerCatalogPageMock.mockRejectedValue(new Error("failure"));

    const response = await GET(request());

    expect(response.status).toBe(502);
  });
});
