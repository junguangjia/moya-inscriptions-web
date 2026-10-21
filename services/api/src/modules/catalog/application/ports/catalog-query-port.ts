import type { CatalogId, MediaId } from "@moya/contracts";

import type {
  CatalogDetailProjection,
  CatalogListPageProjection,
  CatalogZoomBlocksProjection,
  CatalogZoomFrameProjection,
} from "../catalog-read-projections.js";
import type { CatalogListQuery } from "../queries/catalog-list-query.js";

/** Application-owned read port for base Catalog list and detail use cases. */
export interface CatalogQueryPort {
  list(query: CatalogListQuery): Promise<CatalogListPageProjection>;

  getById(id: CatalogId): Promise<CatalogDetailProjection | null>;

  /**
   * catalog-deep-zoom-v1, optional: the frames of the complete block sets of
   * a record's published images, by media id, while deep zoom is deliverable
   * (empty otherwise). Best effort: a failure omits every frame and never
   * fails the Detail.
   */
  getZoomFrames?(
    id: CatalogId,
  ): Promise<ReadonlyMap<MediaId, CatalogZoomFrameProjection>>;

  /**
   * catalog-deep-zoom-v1, optional: the block keys of one published image's
   * complete set while deep zoom is deliverable, else null.
   */
  getZoomBlocks?(
    id: CatalogId,
    mediaId: MediaId,
  ): Promise<CatalogZoomBlocksProjection | null>;
}
