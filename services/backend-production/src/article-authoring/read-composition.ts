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

/** Published Article projection shared by the real Development and Production runtimes. */
export const createArticleReadPort = (
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
