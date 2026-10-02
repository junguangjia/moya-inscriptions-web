import { describe, expect, it, vi } from "vitest";
import type { CatalogQueryPort, CatalogSearchQueryPort } from "@moya/api";
import { CommunityInputError } from "@moya/api";
import { createArticleCatalogReadCallbacks } from "@moya/backend-runtime";

const fixture = () => {
  const search = vi.fn<CatalogSearchQueryPort["search"]>(async (query) => ({
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: 0,
  }));
  const port: CatalogQueryPort & CatalogSearchQueryPort = {
    search,
    list: async (query) => ({
      items: [],
      total: 0,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: 0,
    }),
    getById: async () => null,
  };
  const resolveMany = vi.fn(async () => new Map());
  return {
    search,
    resolveMany,
    callbacks: createArticleCatalogReadCallbacks(port, { resolveMany }),
  };
};
describe("actual delegated Catalog callback and native search parser", () => {
  it("converts MCP numeric page size into the existing HTTP parser's transport strings", async () => {
    const { search, resolveMany, callbacks } = fixture();
    await expect(
      callbacks.discoverCatalog({ query: " 合成 ", pageSize: 20 }),
    ).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    expect(search).toHaveBeenCalledExactlyOnceWith({
      q: "合成",
      page: 1,
      pageSize: 20,
    });
    expect(resolveMany).not.toHaveBeenCalled();
  });
  it("preserves a bounded MCP page cursor through the real transport parser", async () => {
    const { search, callbacks } = fixture();
    await expect(
      callbacks.discoverCatalog({ query: "合成", cursor: "3", pageSize: 7 }),
    ).resolves.toMatchObject({ page: 3, pageSize: 7 });
    expect(search).toHaveBeenCalledExactlyOnceWith({
      q: "合成",
      page: 3,
      pageSize: 7,
    });
  });
  it("rejects invalid or excessive cursor before the native Catalog port", () => {
    const { search, callbacks } = fixture();
    for (const cursor of ["0", "01", "1001", "-1", "3.0", "opaque"])
      expect(() =>
        callbacks.discoverCatalog({ query: "合成", cursor, pageSize: 20 }),
      ).toThrow(CommunityInputError);
    expect(search).not.toHaveBeenCalled();
  });
});
