import {
  catalogPlanReads,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  planCatalogPermissions,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";

/*
 * The whole Catalog's copy set, the tests' oracle since catalog-scale-v1
 * (Issue #323) W7 took it out of production: the set the reconcile read every
 * pass until it planned a bounded scope (the authority's copyRenditionIds()
 * as of 0859d19a, verbatim). One complete snapshot, planned by
 * planCatalogPermissions, the union of every asset's permitted renditions.
 */

type Pools = Parameters<typeof createCatalogPublicationAuthority>;

export const wholeCatalogCopySet = async (
  published: Pools[0],
  prepare: Pools[1],
  app: Pools[2],
): Promise<readonly string[]> => {
  const snapshot = await readCatalogSourceSnapshot(published, prepare);
  if (!snapshot) throw new Error("Catalog complete source unavailable");
  const policy = currentCatalogRecipePolicy().recipeManifestSha256;
  const permissions = await planCatalogPermissions(
    snapshot,
    catalogPlanReads(app, policy),
    policy,
  );
  return [...new Set(permissions.flatMap((p) => p.renditionIds))];
};

/** The production authority with the oracle's copy set beside it. */
export const catalogAuthorityWithCopySet = (
  published: Pools[0],
  prepare: Pools[1],
  app: Pools[2],
) => ({
  ...createCatalogPublicationAuthority(published, prepare, app),
  copyRenditionIds: () => wholeCatalogCopySet(published, prepare, app),
});
