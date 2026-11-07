import { describe, expect, it, vi } from "vitest";

import { loadDiscoverFeed, unavailableTopicsSource } from "./home-sources";

import type { CatalogId, CatalogPage } from "@moya/contracts";
import type { HomeCatalogSource } from "../../features/home/load-home-catalog";
import type { CatalogPageTransportResult } from "../../lib/public-api/catalog-list";

const page = {
  items: [
    {
      aliases: [],
      id: "catalog-real" as CatalogId,
      kind: "inscription",
      title: "真实公开条目",
    },
  ],
  page: 1,
  pageSize: 24,
  total: 1,
  totalPages: 1,
} as CatalogPage;

describe("Home sources", () => {
  it("maps the REAL Discover Catalog source without a fixture fallback", async () => {
    const source = vi.fn<HomeCatalogSource>().mockResolvedValue({
      page,
      state: "success",
    });

    await expect(loadDiscoverFeed(source)).resolves.toEqual({
      items: page.items,
      state: "populated",
    });
    expect(source).toHaveBeenCalledWith({ page: "1", pageSize: "24" });
  });

  it.each<
    ["empty" | "unavailable" | "unexpected-error", CatalogPageTransportResult]
  >([
    [
      "empty",
      {
        page: { ...page, items: [], total: 0, totalPages: 0 },
        state: "success",
      },
    ],
    ["unavailable", { state: "unavailable" }],
    ["unexpected-error", { state: "unexpected-error" }],
  ])("preserves the %s REAL source lifecycle", async (expected, result) => {
    const source: HomeCatalogSource = async () => result;
    await expect(loadDiscoverFeed(source)).resolves.toMatchObject({
      state: expected,
    });
  });

  it("keeps Production Topics explicitly unavailable", async () => {
    await expect(unavailableTopicsSource()).resolves.toEqual({
      state: "unavailable",
    });
  });
});
