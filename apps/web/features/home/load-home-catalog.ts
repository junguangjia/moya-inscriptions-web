import { fetchServerCatalogPage } from "../../lib/public-api/server";
import { toHomeCatalogState } from "./catalog-state";

import type { CatalogListTransportQuery } from "@moya/contracts";
import type { CatalogPageTransportResult } from "../../lib/public-api/catalog-list";
import type { AccessDeniedTransportResult } from "../../lib/public-api/community-session";
import type { HomeCatalogState } from "./catalog-state";

export type HomeCatalogSource = (
  query?: CatalogListTransportQuery,
) => Promise<CatalogPageTransportResult | AccessDeniedTransportResult>;

/** Catalog reads that carry one visitor's session to the Backend. */
export const visitorCatalogSource =
  (token: string): HomeCatalogSource =>
  (query) =>
    fetchServerCatalogPage(query, token);

export const loadHomeCatalogState = async (
  query?: CatalogListTransportQuery,
  source: HomeCatalogSource = fetchServerCatalogPage,
): Promise<HomeCatalogState> =>
  toHomeCatalogState(
    query === undefined ? await source() : await source(query),
  );
