import { createHash } from "node:crypto";

import {
  catalogRecipePolicySchema,
  catalogDeliveryReadinessSchema,
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
