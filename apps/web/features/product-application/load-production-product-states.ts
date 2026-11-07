import { createRuntimeCalligraphyCategorySurface } from "../calligraphy/calligraphy-category";
import {
  loadHomeCatalogState,
  visitorCatalogSource,
} from "../home/load-home-catalog";
import {
  loadDiscoverFeed,
  unavailableTopicsSource,
} from "../../sources/home/home-sources";

import type { T02pDevelopmentCatalogDestinationStates } from "../product-preview/catalog-scenarios";

export const loadProductionProductStates = async (
  /** The visitor's session; the Backend decides product access with it. */
  token?: string,
): Promise<T02pDevelopmentCatalogDestinationStates> => {
  const source = token === undefined ? undefined : visitorCatalogSource(token);
  const [discover, topics, inscriptions, calligraphy] = await Promise.all([
    loadDiscoverFeed(source),
    unavailableTopicsSource(),
    loadHomeCatalogState(
      { kind: "inscription", page: "1", pageSize: "24" },
      source,
    ),
    loadHomeCatalogState(
      { kind: "calligraphy", page: "1", pageSize: "24" },
      source,
    ),
  ]);

  return {
    calligraphy: createRuntimeCalligraphyCategorySurface(calligraphy),
    // The timeline loads its rows in the client when its feed first opens.
    home: { discover, timeline: { state: "loading" }, topics },
    inscriptions,
  };
};
