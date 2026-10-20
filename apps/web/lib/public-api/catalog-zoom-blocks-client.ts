import {
  CATALOG_ZOOM_BLOCK_EDGE,
  CATALOG_ZOOM_BLOCK_OVERLAP,
  catalogZoomBlocksSchema,
} from "@moya/contracts/schemas";

import { localCatalogRenditionSrc } from "../../features/detail/local-catalog-media";
import { catalogZoomBlocksPath } from "./catalog-zoom-blocks";

import type { CatalogZoomBlocks } from "@moya/contracts";

/*
 * catalog-deep-zoom-v1: the Viewer's same-origin read of one image's block
 * list. The answer is parsed strictly; in Development each block URL then
 * becomes the same-origin relay path, as Catalog renditions do.
 */

/** The contract's block grid, for the Viewer before a list arrives. */
export const catalogZoomGrid = {
  edge: CATALOG_ZOOM_BLOCK_EDGE,
  overlap: CATALOG_ZOOM_BLOCK_OVERLAP,
} as const;

/** One image's blocks as the Viewer uses them. */
export interface CatalogZoomBlockList extends Omit<CatalogZoomBlocks, "srcs"> {
  readonly srcs: readonly string[];
}

export type CatalogZoomBlocksClientResult =
  | { readonly state: "success"; readonly blocks: CatalogZoomBlockList }
  | { readonly state: "not-found" }
  | { readonly state: "unavailable" }
  | { readonly state: "unexpected-error" };

export interface CatalogZoomBlocksClientContext {
  readonly baseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
}

const defaultContext = (): CatalogZoomBlocksClientContext => ({
  baseUrl: new URL(globalThis.location.href),
  fetch: globalThis.fetch,
});

export const fetchSameOriginCatalogZoomBlocks = async (
  catalogId: string,
  mediaId: string,
  signal?: AbortSignal,
  context: CatalogZoomBlocksClientContext = defaultContext(),
): Promise<CatalogZoomBlocksClientResult> => {
  const path = catalogZoomBlocksPath(catalogId, mediaId);
  if (path === undefined) return { state: "not-found" };

  try {
    const response = await context.fetch.call(
      globalThis,
      new URL(`/api/${path}`, context.baseUrl),
      {
        headers: { Accept: "application/json" },
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      },
    );

    if (response.status === 404) return { state: "not-found" };
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 200) return { state: "unexpected-error" };

    const parsed = catalogZoomBlocksSchema.safeParse(await response.json());
    if (!parsed.success) return { state: "unexpected-error" };
    return {
      state: "success",
      blocks: {
        ...parsed.data,
        srcs: parsed.data.srcs.map(localCatalogRenditionSrc),
      },
    };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};
