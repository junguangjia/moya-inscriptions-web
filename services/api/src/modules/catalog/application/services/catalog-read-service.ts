import type {
  CatalogDetail,
  CatalogId,
  CatalogPage,
  CatalogSearchPage,
  CatalogZoomBlocks,
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
  mapCatalogZoomBlocks,
  warnCatalogZoom,
  type CatalogZoomFrames,
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

  private async hydrate<
    T extends CatalogListPageProjection | CatalogDetailProjection,
  >(projection: T): Promise<T> {
    if (!this.storageUrlResolver.catalogFacts) return projection;
    const images =
      "media" in projection
        ? [
            ...projection.media,
            ...(projection.representativeMedia
              ? [projection.representativeMedia]
              : []),
          ]
        : projection.items.flatMap((p) =>
            p.representativeMedia ? [p.representativeMedia] : [],
          );
    // Rendition facts belong to media resolution: a failed lookup fails the
    // read as unavailable (503), like `resolveMedia`, never as a 500.
    let facts: Awaited<
      ReturnType<NonNullable<StorageUrlResolver["catalogFacts"]>>
    >;
    try {
      facts = await this.storageUrlResolver.catalogFacts(
        images.map(mediaLocator),
      );
    } catch (error) {
      if (error instanceof CatalogMediaResolutionError) throw error;
      throw new CatalogMediaResolutionError({ cause: error });
    }
    const media = (image: CatalogMediaProjection) => ({
      ...image,
      ...facts.get(JSON.stringify([image.id, image.objectKey])),
    });
    if ("media" in projection)
      return {
        ...projection,
        media: projection.media.map(media),
        ...(projection.representativeMedia
          ? { representativeMedia: media(projection.representativeMedia) }
          : {}),
      };
    return {
      ...projection,
      items: projection.items.map((item) => ({
        ...item,
        ...(item.representativeMedia
          ? { representativeMedia: media(item.representativeMedia) }
          : {}),
      })),
    };
  }

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
          : this.storageUrlResolver.resolveMany(
              locators.filter(
                ({ objectKey }) => !objectKey.startsWith("editorial/"),
              ),
            ),
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
    const projection = await this.hydrate(
      await this.catalogQueryPort.list(query),
    );
    const resolved = await this.resolveMedia(
      listMediaLocators(projection),
      listRenditionKeys(projection),
    );
    return mapCatalogPage(projection, resolved.media, resolved.renditions);
  }

  /**
   * catalog-deep-zoom-v1: the frames of the record's complete block sets,
   * best effort. A failure omits every frame (content-free warning) and
   * never fails the Detail.
   */
  private async zoomFrames(id: CatalogId): Promise<CatalogZoomFrames> {
    if (this.catalogQueryPort.getZoomFrames === undefined) return noZoomFrames;
    try {
      return await this.catalogQueryPort.getZoomFrames(id);
    } catch {
      warnCatalogZoom("frame_unavailable");
      return noZoomFrames;
    }
  }

  async getById(id: CatalogId): Promise<CatalogDetail | null> {
    const raw = await this.catalogQueryPort.getById(id);
    const projection = raw ? await this.hydrate(raw) : null;
    if (projection === null) return null;
    const [resolved, frames] = await Promise.all([
      this.resolveMedia(
        detailMediaLocators(projection),
        detailRenditionKeys(projection),
      ),
      projection.media.length === 0 ? noZoomFrames : this.zoomFrames(id),
    ]);
    return mapCatalogDetail(
      projection,
      resolved.media,
      resolved.renditions,
      frames,
    );
  }

  /**
   * catalog-deep-zoom-v1: the blocks of one image of a published record, only
   * while its Detail entry carries a `zoom` frame (the same gates) and every
   * block key resolves; null answers 404. Neither the article tool nor
   * Article bodies call it.
   */
  async getZoomBlocks(
    id: CatalogId,
    mediaId: MediaId,
  ): Promise<CatalogZoomBlocks | null> {
    if (this.catalogQueryPort.getZoomBlocks === undefined) return null;
    const detail = await this.getById(id);
    const frame = detail?.media.find((media) => media.id === mediaId)?.zoom;
    if (frame === undefined) return null;
    const blocks = await this.catalogQueryPort.getZoomBlocks(id, mediaId);
    if (
      blocks === null ||
      blocks.width !== frame.width ||
      blocks.height !== frame.height ||
      this.storageUrlResolver.resolveKeys === undefined
    )
      return null;
    let urls: ReadonlyMap<string, ResolvedMediaUrl>;
    try {
      urls = await this.storageUrlResolver.resolveKeys(blocks.keys);
    } catch (error) {
      throw new CatalogMediaResolutionError({ cause: error });
    }
    const srcs: ResolvedMediaUrl[] = [];
    for (const key of blocks.keys) {
      const url = urls.get(key);
      if (url === undefined) return null;
      srcs.push(url);
    }
    return mapCatalogZoomBlocks(frame, srcs);
  }

  async search(query: CatalogSearchQuery): Promise<CatalogSearchPage> {
    if (!this.catalogSearchQueryPort) throw new CatalogQueryUnavailableError();
    const projection = await this.hydrate(
      await this.catalogSearchQueryPort.search(query),
    );
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
const noZoomFrames: CatalogZoomFrames = new Map();
