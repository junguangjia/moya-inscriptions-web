import { createHash, randomUUID } from "node:crypto";

import {
  catalogRecipePolicySchema,
  catalogDeliveryReadinessSchema,
  catalogPublishedRenditionsSchema,
  type CatalogDeliveryCapabilities,
  type CatalogPublishedRenditions,
  type CatalogPublishedRenditionsRequest,
  type CatalogRecipePolicy,
} from "@moya/contracts/internal/editorial";

import { EditorialError } from "./errors";
import {
  callCommunityOperator,
  CommunityOperatorError,
} from "../community/backend";

/** Policy is implemented, but a recipe pin alone is never rendering/copy
 * readiness. Whole-set persistence and the copy fence must supply that proof;
 * a generic operator URL or a caller-supplied boolean cannot replace it.
 */
export const catalogDeliveryReadiness = (policy: string | null) =>
  policy === null ? ("NOT_CONFIGURED" as const) : ("PENDING" as const);

/** Calls the implemented, authenticated metadata-only policy route. It reads
 * neither source bytes nor readiness. Exact prepare receipt replay skips this
 * call entirely; absence of an operator remains a private unconfigured intent.
 */
export const readCatalogRecipePolicy =
  async (): Promise<CatalogRecipePolicy | null> => {
    try {
      const value: unknown = await callCommunityOperator(
        "GET",
        "catalog-delivery/recipe-policy",
      );
      const parsed = catalogRecipePolicySchema.safeParse(value);
      if (
        !parsed.success ||
        createHash("sha256")
          .update(parsed.data.canonicalManifest)
          .digest("hex") !== parsed.data.recipeManifestSha256
      )
        throw new EditorialError("CATALOG_RECIPE_POLICY_INVALID", 503);
      return parsed.data;
    } catch (error) {
      if (
        error instanceof CommunityOperatorError &&
        error.code === "OPERATOR_NOT_CONFIGURED"
      )
        return null;
      if (error instanceof EditorialError) throw error;
      throw new EditorialError("CATALOG_RECIPE_POLICY_UNAVAILABLE", 503);
    }
  };

export const requireCatalogDeliveryBackend = (): never => {
  throw new EditorialError("CATALOG_DELIVERY_NOT_CONFIGURED", 503);
};

export const readCatalogReadiness = async (intentId: string) => {
  try {
    return catalogDeliveryReadinessSchema.parse(
      await callCommunityOperator("POST", "catalog-delivery/readiness", {
        intentId,
      }),
    );
  } catch {
    throw new EditorialError("CATALOG_DELIVERY_READINESS_UNAVAILABLE", 503);
  }
};

/** Publish gate for media that is already live, over the same operator
 * boundary: the Backend reads its own App facts; Admin gains no privilege.
 * `null` means no Backend answers this question (not connected, or older than
 * it), which is no proof; any other failure is an unavailable proof.
 */
export const readCatalogPublishedRenditions = async (
  media: CatalogPublishedRenditionsRequest["media"],
): Promise<CatalogPublishedRenditions | null> => {
  try {
    return catalogPublishedRenditionsSchema.parse(
      await callCommunityOperator(
        "POST",
        "catalog-delivery/published-renditions",
        { media },
      ),
    );
  } catch (error) {
    if (
      error instanceof CommunityOperatorError &&
      ["OPERATOR_NOT_CONFIGURED", "NOT_FOUND"].includes(error.code)
    )
      return null;
    throw new EditorialError("CATALOG_DELIVERY_READINESS_UNAVAILABLE", 503);
  }
};

/** Read-only capability probe for release tooling: the recipe policy must be
 * readable and the readiness route connected to its prepare reader. A fresh
 * random intent ID names no intent, so a connected route answers 404.
 */
export const probeCatalogDeliveryBackend = async (): Promise<
  CatalogDeliveryCapabilities["delivery"]
> => {
  let policy: CatalogRecipePolicy | null;
  try {
    policy = await readCatalogRecipePolicy();
  } catch {
    return "UNAVAILABLE";
  }
  if (policy === null) return "NOT_CONFIGURED";
  try {
    catalogDeliveryReadinessSchema.parse(
      await callCommunityOperator("POST", "catalog-delivery/readiness", {
        intentId: randomUUID(),
      }),
    );
    return "AVAILABLE";
  } catch (error) {
    if (error instanceof CommunityOperatorError && error.code === "NOT_FOUND")
      return "AVAILABLE";
    // Every Backend 503 reaches Admin as OPERATOR_UNAVAILABLE. A missing
    // prepare reader is the expected cause; a passing STORE_UNAVAILABLE reads
    // the same (documented for the operator).
    if (
      error instanceof CommunityOperatorError &&
      error.code === "OPERATOR_UNAVAILABLE"
    )
      return "NOT_CONFIGURED";
    return "UNAVAILABLE";
  }
};
