import {
  catalogIdSchema,
  catalogZoomBlocksSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";

import type { CatalogZoomBlocks } from "@moya/contracts";

/*
 * catalog-deep-zoom-v1: the per-image block-list read,
 * `GET v1/catalog/{catalogId}/media/{mediaId}/zoom-blocks`, parsed strictly.
 * Only Catalog Detail's Viewer asks for it, once per image.
 */

export type CatalogZoomBlocksTransportResult =
  | { state: "success"; blocks: CatalogZoomBlocks }
  | { state: "not-found" }
  | { state: "unavailable" }
  | { state: "unexpected-error" };

export interface CatalogZoomBlocksTransportContext {
  baseUrl: URL;
  fetch: typeof globalThis.fetch;
}

/** The read's path below an origin, or undefined for a malformed id. */
export const catalogZoomBlocksPath = (
  catalogId: string,
  mediaId: string,
): string | undefined => {
  const parsedCatalogId = catalogIdSchema.safeParse(catalogId);
  const parsedMediaId = mediaIdSchema.safeParse(mediaId);
  if (!parsedCatalogId.success || !parsedMediaId.success) return undefined;
  return `catalog/${encodeURIComponent(parsedCatalogId.data)}/media/${encodeURIComponent(parsedMediaId.data)}/zoom-blocks`;
};

export const fetchCatalogZoomBlocks = async (
  context: CatalogZoomBlocksTransportContext,
  catalogId: string,
  mediaId: string,
): Promise<CatalogZoomBlocksTransportResult> => {
  const path = catalogZoomBlocksPath(catalogId, mediaId);
  if (path === undefined) return { state: "not-found" };

  try {
    const response = await context.fetch(
      new URL(`v1/${path}`, context.baseUrl).toString(),
      { method: "GET", headers: { Accept: "application/json" } },
    );

    if (response.status === 404) return { state: "not-found" };
    if (response.status === 503) return { state: "unavailable" };
    if (response.status !== 200) return { state: "unexpected-error" };

    const parsed = catalogZoomBlocksSchema.safeParse(await response.json());
    if (!parsed.success) return { state: "unexpected-error" };
    return { state: "success", blocks: parsed.data };
  } catch {
    return { state: "unexpected-error" };
  }
};
