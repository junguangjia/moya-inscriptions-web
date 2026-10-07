import {
  PostgresEditorialContentAdapter,
  PostgresCompositeEditorialAdapter,
  CanonicalAuthoredArticleProjector,
  PostgresAuthoredArticleCatalogMediaResolver,
} from "@moya/catalog-postgres";
import { resolvePublishedArticleManagedMedia } from "@moya/community-postgres";
import type {
  CatalogReaderOptions,
  createPostgresPool,
} from "@moya/catalog-postgres";
type Pool = ReturnType<typeof createPostgresPool>;
type StorageUrlResolver = ConstructorParameters<
  typeof PostgresAuthoredArticleCatalogMediaResolver
>[1];

/**
 * Published Article projection shared by the real Development and Production
 * runtimes. `readers` composes the Catalog readers (rendition delivery facts
 * where the community view and its read grant exist).
 */
export const createArticleReadPort = (
  publicPool: Pool,
  communityPool: Pool,
  storage: StorageUrlResolver,
  readers: CatalogReaderOptions = {},
) => {
  const catalog = new PostgresAuthoredArticleCatalogMediaResolver(
    publicPool,
    storage,
    readers,
  );
  const projector = new CanonicalAuthoredArticleProjector({
    resolveManaged: (owner, ids) =>
      resolvePublishedArticleManagedMedia(communityPool, owner, ids),
    resolveCatalog: (pairs) => catalog.resolveCatalog(pairs),
  });
  return new PostgresCompositeEditorialAdapter(
    publicPool,
    new PostgresEditorialContentAdapter(publicPool, readers),
    projector,
    readers,
  );
};
