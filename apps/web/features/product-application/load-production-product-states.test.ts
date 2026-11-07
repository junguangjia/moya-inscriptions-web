import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadHomeCatalogStateMock } = vi.hoisted(() => ({
  loadHomeCatalogStateMock: vi.fn(),
}));

vi.mock("../home/load-home-catalog", () => ({
  loadHomeCatalogState: loadHomeCatalogStateMock,
}));

import { loadProductionProductStates } from "./load-production-product-states";

import type { CatalogId, CatalogKind, CatalogPage } from "@moya/contracts";
import type { HomeCatalogState } from "../home/catalog-state";

type PopulatedHomeCatalogState = Extract<
  HomeCatalogState,
  { readonly state: "populated" }
>;

const page = (id: string, kind: CatalogKind): CatalogPage => ({
  items: [{ aliases: [], id: id as CatalogId, kind, title: id }],
  page: 1,
  pageSize: 24,
  total: 1,
  totalPages: 1,
});

const populated = (
  id: string,
  kind: CatalogKind,
): PopulatedHomeCatalogState => ({
  page: page(id, kind),
  state: "populated",
});

const empty = (): HomeCatalogState => ({
  page: {
    items: [],
    page: 1,
    pageSize: 24,
    total: 0,
    totalPages: 0,
  },
  state: "empty",
});

beforeEach(() => {
  loadHomeCatalogStateMock.mockReset();
});

describe("Production Product states", () => {
  it("loads the three frozen Catalog pages and composes truthful Production states", async () => {
    const discover = populated("runtime-discover", "inscription");
    const inscriptions = populated("runtime-inscription", "inscription");
    const calligraphy = populated("runtime-calligraphy", "calligraphy");
    loadHomeCatalogStateMock.mockImplementation(
      (query?: { readonly kind?: CatalogKind }) => {
        if (query?.kind === "inscription") {
          return Promise.resolve(inscriptions);
        }
        if (query?.kind === "calligraphy") {
          return Promise.resolve(calligraphy);
        }
        return Promise.resolve(discover);
      },
    );

    const states = await loadProductionProductStates();

    expect(loadHomeCatalogStateMock).toHaveBeenCalledTimes(3);
    expect(loadHomeCatalogStateMock.mock.calls.map(([query]) => query)).toEqual(
      [
        { page: "1", pageSize: "24" },
        { kind: "inscription", page: "1", pageSize: "24" },
        { kind: "calligraphy", page: "1", pageSize: "24" },
      ],
    );
    expect(states).toEqual({
      calligraphy: {
        categories: {
          all: calligraphy,
          ink: { state: "classification-unavailable" },
          rubbing: { state: "classification-unavailable" },
        },
        classificationSource: "runtime-unclassified",
      },
      home: {
        discover: {
          items: discover.page.items,
          state: "populated",
        },
        timeline: { state: "loading" },
        topics: { state: "unavailable" },
      },
      inscriptions,
    });
    expect(states.inscriptions).toBe(inscriptions);
    expect(states.calligraphy.categories.all).toBe(calligraphy);
  });

  it("preserves unavailable, error, and empty states without fallback records", async () => {
    const discover: HomeCatalogState = { state: "unavailable" };
    const inscriptions: HomeCatalogState = { state: "unexpected-error" };
    const calligraphy = empty();
    loadHomeCatalogStateMock.mockImplementation(
      (query?: { readonly kind?: CatalogKind }) => {
        if (query?.kind === "inscription") {
          return Promise.resolve(inscriptions);
        }
        if (query?.kind === "calligraphy") {
          return Promise.resolve(calligraphy);
        }
        return Promise.resolve(discover);
      },
    );

    await expect(loadProductionProductStates()).resolves.toEqual({
      calligraphy: {
        categories: {
          all: calligraphy,
          ink: { state: "classification-unavailable" },
          rubbing: { state: "classification-unavailable" },
        },
        classificationSource: "runtime-unclassified",
      },
      home: {
        discover: { state: "unavailable" },
        timeline: { state: "loading" },
        topics: { state: "unavailable" },
      },
      inscriptions,
    });
  });
});
