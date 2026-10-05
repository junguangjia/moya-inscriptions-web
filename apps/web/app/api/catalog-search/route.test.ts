import { beforeEach, describe, expect, it, vi } from "vitest";
const { fetchServerCatalogSearchPageMock } = vi.hoisted(() => ({
  fetchServerCatalogSearchPageMock: vi.fn(),
}));
vi.mock("../../../lib/public-api/server", () => ({
  fetchServerCatalogSearchPage: fetchServerCatalogSearchPageMock,
}));
import { GET } from "./route";
const request = (query = "q=测试") =>
  new Request(`https://example.test/api/catalog-search?${query}`);
const page = { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 };
beforeEach(() => {
  fetchServerCatalogSearchPageMock.mockReset();
  fetchServerCatalogSearchPageMock.mockResolvedValue({
    state: "success",
    page,
  });
});
describe("same-origin Catalog Search bridge", () => {
  it("forwards only declared fields and abort signal to the HTTP transport", async () => {
    const input = request("q=测试&kind=inscription&page=2&pageSize=20");
    const response = await GET(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(fetchServerCatalogSearchPageMock).toHaveBeenCalledWith(
      { q: "测试", kind: "inscription", page: "2", pageSize: "20" },
      input.signal,
      undefined,
    );
    expect(await response.json()).toEqual(page);
  });
  it("hands the visitor's session to the Backend", async () => {
    const session = "s".repeat(43);
    const input = new Request("http://localhost/api/catalog-search?q=a", {
      headers: { cookie: `yoyi-session=${session}` },
    });
    expect((await GET(input)).status).toBe(200);
    expect(fetchServerCatalogSearchPageMock).toHaveBeenCalledWith(
      { q: "a" },
      input.signal,
      session,
    );
  });
  it.each([401, 403] as const)(
    "answers the Backend's access refusal as %s without a body",
    async (status) => {
      fetchServerCatalogSearchPageMock.mockResolvedValue({
        state: "access-denied",
        status,
      });
      const response = await GET(request("q=a"));
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Vary")).toBe("Cookie");
      expect(await response.text()).toBe("");
    },
  );
  it.each([
    "",
    "q=",
    "q=%20",
    "q=a&q=b",
    "q=a&unknown=b",
    "q=a&kind=painting",
    "q=a&page=0",
    "q=a&pageSize=101",
    "q=%00",
    `q=${"文".repeat(201)}`,
  ])("rejects undeclared or invalid transport parameters", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(fetchServerCatalogSearchPageMock).not.toHaveBeenCalled();
  });
  it.each([
    ["invalid-query", 400],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("returns %s without internal details", async (state, status) => {
    fetchServerCatalogSearchPageMock.mockResolvedValue({ state });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });
  it("rejects an invalid upstream response", async () => {
    fetchServerCatalogSearchPageMock.mockResolvedValue({
      state: "success",
      page: { ...page, pageSize: 0 },
    });
    expect((await GET(request())).status).toBe(502);
  });
  it("contains a thrown transport failure", async () => {
    fetchServerCatalogSearchPageMock.mockRejectedValue(
      new Error("synthetic failure"),
    );
    expect((await GET(request())).status).toBe(502);
  });
});
