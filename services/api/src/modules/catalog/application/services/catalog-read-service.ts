import type {
  CatalogDetail,
  CatalogId,
  CatalogPage,
  CatalogSearchPage,
  MediaId,
} from "@moya/contracts";

import { CatalogMediaResolutionError } from "../errors/catalog-media-resolution-error.js";
import { CatalogQueryUnavailableError } from "../errors/catalog-query-unavailable-error.js";
import type { CatalogSearchQueryPort } from "../ports/catalog-search-query-port.js";
import type { CatalogSearchQuery } from "../queries/catalog-search-query.js";

import {
  catalogMediaRenditionKeys,
  mapCatalogDetail,
  mapCatalogPage,
  mapCatalogSearchPage,
} from "../mappers/catalog-public-contract-mapper.js";

import type { CatalogQueryPort } from "../ports/catalog-query-port.js";
import type {
  StorageMediaLocator,
  StorageUrlResolver,
  ResolvedMediaUrl,
} from "../ports/storage-url-resolver.js";
import type { CatalogListQuery } from "../queries/catalog-list-query.js";
import type {
  CatalogDetailProjection,
  CatalogListPageProjection,
  CatalogMediaProjection,
} from "../catalog-read-projections.js";

const mediaLocator = ({
  id,
  objectKey,
}: CatalogMediaProjection): StorageMediaLocator => ({
  mediaId: id,
  objectKey,
});

const listMediaLocators = (
  projection: CatalogListPageProjection,
): readonly StorageMediaLocator[] =>
  projection.items.flatMap(({ representativeMedia }) =>
    representativeMedia === undefined
      ? []
      : [mediaLocator(representativeMedia)],
  );

const detailMediaLocators = (
  projection: CatalogDetailProjection,
): readonly StorageMediaLocator[] => projection.media.map(mediaLocator);

/** Lists and search are card contexts: representative images up to the anchor. */
const listRenditionKeys = (
  projection: CatalogListPageProjection,
): readonly string[] =>
  projection.items.flatMap(({ representativeMedia }) =>
    representativeMedia === undefined
      ? []
      : catalogMediaRenditionKeys(representativeMedia, "card"),
  );

/** Detail: the representative image as a card, the gallery with zoom levels. */
const detailRenditionKeys = (
  projection: CatalogDetailProjection,
): readonly string[] => [
  ...(projection.representativeMedia === undefined
    ? []
    : catalogMediaRenditionKeys(projection.representativeMedia, "card")),
  ...projection.media.flatMap((media) =>
    catalogMediaRenditionKeys(media, "detail"),
  ),
];

/** Application orchestration for the public Catalog read use cases. */
export class CatalogReadService {
  constructor(
    private readonly catalogQueryPort: CatalogQueryPort,
    private readonly storageUrlResolver: StorageUrlResolver,
    private readonly catalogSearchQueryPort?: CatalogSearchQueryPort,
  ) {}

  /**
   * Approved image URLs and rendition delivery URLs in one step; either
   * batch failing fails the read (503), as before renditions.
   */
  private async resolveMedia(
    locators: readonly StorageMediaLocator[],
    renditionKeys: readonly string[],
  ) {
    try {
      const [media, renditions] = await Promise.all([
        locators.length === 0
          ? noResolvedMedia
          : this.storageUrlResolver.resolveMany(locators),
        renditionKeys.length === 0 ||
        this.storageUrlResolver.resolveKeys === undefined
          ? noRenditionUrls
          : this.storageUrlResolver.resolveKeys([...new Set(renditionKeys)]),
      ]);
      return { media, renditions };
    } catch (error) {
      if (error instanceof CatalogMediaResolutionError) throw error;
      throw new CatalogMediaResolutionError({ cause: error });
    }
  }

  async list(query: CatalogListQuery): Promise<CatalogPage> {
    const projection = await this.catalogQueryPort.list(query);
    const resolved = await this.resolveMedia(
      listMediaLocators(projection),
      listRenditionKeys(projection),
    );
    return mapCatalogPage(projection, resolved.media, resolved.renditions);
  }

  async getById(id: CatalogId): Promise<CatalogDetail | null> {
    const projection = await this.catalogQueryPort.getById(id);
    if (projection === null) return null;
    const resolved = await this.resolveMedia(
      detailMediaLocators(projection),
      detailRenditionKeys(projection),
    );
    return mapCatalogDetail(projection, resolved.media, resolved.renditions);
  }

  async search(query: CatalogSearchQuery): Promise<CatalogSearchPage> {
    if (!this.catalogSearchQueryPort) throw new CatalogQueryUnavailableError();
    const projection = await this.catalogSearchQueryPort.search(query);
    const resolved = await this.resolveMedia(
      listMediaLocators(projection),
      listRenditionKeys(projection),
    );
    return mapCatalogSearchPage(
      projection,
      resolved.media,
      resolved.renditions,
    );
  }
}

const noResolvedMedia = new Map<MediaId, ResolvedMediaUrl>();
const noRenditionUrls = new Map<string, ResolvedMediaUrl>();
