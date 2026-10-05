import type { CatalogPage } from "@moya/contracts";
import type { CatalogPageTransportResult } from "../../lib/public-api/catalog-list";
import type { AccessDeniedTransportResult } from "../../lib/public-api/community-session";

export type HomeCatalogState =
  | { state: "populated"; page: CatalogPage }
  | { state: "empty"; page: CatalogPage }
  | { state: "unavailable" }
  | { state: "unexpected-error" };

export const toHomeCatalogState = (
  result: CatalogPageTransportResult | AccessDeniedTransportResult,
): HomeCatalogState => {
  // The page settles product access before it loads anything, so a refusal
  // here is a race with a change of access and reads as unavailable.
  if (result.state === "access-denied") return { state: "unavailable" };
  if (result.state !== "success") return result;

  return result.page.total === 0
    ? { state: "empty", page: result.page }
    : { state: "populated", page: result.page };
};
