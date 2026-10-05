import { createRuntimeCalligraphyCategorySurface } from "../calligraphy/calligraphy-category";
import {
  loadHomeCatalogState,
  visitorCatalogSource,
} from "../home/load-home-catalog";
import {
  loadDiscoverFeed,
  unavailableNearbySource,
  unavailableTopicsSource,
} from "../../sources/home/home-sources";

import type { T02pDevelopmentCatalogDestinationStates } from "../product-preview/catalog-scenarios";

export const loadProductionProductStates = async (
  /** The visitor's session; the Backend decides product access with it. */
  token?: string,
): Promise<T02pDevelopmentCatalogDestinationStates> => {
  const source = token === undefined ? undefined : visitorCatalogSource(token);
  const [discover, nearby, topics, inscriptions, calligraphy] =
    await Promise.all([
      loadDiscoverFeed(source),
      unavailableNearbySource(),
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
    home: { discover, nearby, topics },
    inscriptions,
  };
};
