import { describe, expectTypeOf, it } from "vitest";

import type {
  CatalogDetailProjection,
  CatalogListPageProjection,
  CatalogListQuery,
  CatalogQueryPort,
} from "@moya/api";
import type { CatalogDetail, CatalogId, CatalogPage } from "@moya/contracts";

describe("CatalogQueryPort contract", () => {
  it("accepts only normalized list input and Catalog identity", () => {
    expectTypeOf<Parameters<CatalogQueryPort["list"]>>().toEqualTypeOf<
      [query: CatalogListQuery]
    >();
    expectTypeOf<Parameters<CatalogQueryPort["getById"]>>().toEqualTypeOf<
      [id: CatalogId]
    >();
  });

  it("returns internal read projections rather than Public Contracts", () => {
    type ListResult = Awaited<ReturnType<CatalogQueryPort["list"]>>;
    type DetailResult = Awaited<ReturnType<CatalogQueryPort["getById"]>>;

    expectTypeOf<ListResult>().toEqualTypeOf<CatalogListPageProjection>();
    expectTypeOf<ListResult>().not.toEqualTypeOf<CatalogPage>();
    expectTypeOf<DetailResult>().toEqualTypeOf<CatalogDetailProjection | null>();
    expectTypeOf<DetailResult>().not.toEqualTypeOf<CatalogDetail | null>();
  });

  it("exposes exactly the frozen read methods, plus the optional deep-zoom reads", () => {
    expectTypeOf<keyof CatalogQueryPort>().toEqualTypeOf<
      "list" | "getById" | "getZoomFrames" | "getZoomBlocks"
    >();
    // catalog-deep-zoom-v1: the two block reads are optional; every existing
    // reader still satisfies the port with list and getById alone.
    expectTypeOf<
      Pick<CatalogQueryPort, "list" | "getById">
    >().toMatchTypeOf<CatalogQueryPort>();
  });
});
