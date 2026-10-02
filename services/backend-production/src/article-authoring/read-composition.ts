import {
  PostgresEditorialContentAdapter,
  PostgresCompositeEditorialAdapter,
  CanonicalAuthoredArticleProjector,
  PostgresAuthoredArticleCatalogMediaResolver,
} from "@moya/catalog-postgres";
import { resolvePublishedArticleManagedMedia } from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";
type Pool = ReturnType<typeof createPostgresPool>;
type StorageUrlResolver = ConstructorParameters<
  typeof PostgresAuthoredArticleCatalogMediaResolver
>[1];

/** Inject only in the existing Development branch; opens no resources or credentials. */
export const createDevelopmentArticleReadPort = (
  publicPool: Pool,
  communityPool: Pool,
  storage: StorageUrlResolver,
) => {
  const catalog = new PostgresAuthoredArticleCatalogMediaResolver(
    publicPool,
    storage,
  );
  const projector = new CanonicalAuthoredArticleProjector({
    resolveManaged: (owner, ids) =>
      resolvePublishedArticleManagedMedia(communityPool, owner, ids),
    resolveCatalog: (pairs) => catalog.resolveCatalog(pairs),
  });
  return new PostgresCompositeEditorialAdapter(
    publicPool,
    new PostgresEditorialContentAdapter(publicPool),
    projector,
  );
};
