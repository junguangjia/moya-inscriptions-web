import {
  isCatalogMediaResolutionError,
  isCatalogQueryUnavailableError,
  parseCatalogListQuery,
  parseCatalogSearchQuery,
} from "@moya/api";
import {
  catalogIdSchema,
  mediaIdSchema,
  noQueryTransportSchema,
} from "@moya/contracts/schemas";

import { sendApiError } from "../http/api-error-response.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";

import type {
  CatalogListQuery,
  CatalogReadService,
  CatalogSearchQuery,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

export const handleCatalogList = async (
  request: IncomingMessage,
  response: ServerResponse,
  catalogReadService: CatalogReadService,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");

  let query: CatalogListQuery;
  try {
    query = parseCatalogListQuery(collectTransportQuery(url.searchParams));
  } catch {
    sendApiError(response, "INVALID_QUERY", "Invalid catalog query");
    return;
  }

  try {
    sendJson(response, 200, await catalogReadService.list(query));
  } catch (error) {
    if (
      isCatalogQueryUnavailableError(error) ||
      isCatalogMediaResolutionError(error)
    ) {
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
      return;
    }
    sendApiError(response, "INTERNAL_ERROR", "Internal server error");
  }
};

export const handleCatalogSearch = async (
  request: IncomingMessage,
  response: ServerResponse,
  catalogReadService: CatalogReadService,
): Promise<void> => {
  let query: CatalogSearchQuery;
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    query = parseCatalogSearchQuery(collectTransportQuery(url.searchParams));
  } catch {
    sendApiError(response, "INVALID_QUERY", "Invalid catalog search query");
    return;
  }
  try {
    sendJson(response, 200, await catalogReadService.search(query));
  } catch (error) {
    if (
      isCatalogQueryUnavailableError(error) ||
      isCatalogMediaResolutionError(error)
    ) {
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
      return;
    }
    sendApiError(response, "INTERNAL_ERROR", "Internal server error");
  }
};

export const handleCatalogDetail = async (
  request: IncomingMessage,
  encodedCatalogId: string,
  response: ServerResponse,
  catalogReadService: CatalogReadService,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  try {
    noQueryTransportSchema.parse(collectTransportQuery(url.searchParams));
  } catch {
    sendApiError(response, "INVALID_QUERY", "Invalid catalog query");
    return;
  }

  let decodedCatalogId: string;
  try {
    decodedCatalogId = decodeURIComponent(encodedCatalogId);
  } catch {
    sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
    return;
  }

  const catalogId = catalogIdSchema.safeParse(decodedCatalogId);
  if (!catalogId.success) {
    sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
    return;
  }

  try {
    const detail = await catalogReadService.getById(catalogId.data);
    if (detail === null) {
      sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
      return;
    }

    sendJson(response, 200, detail);
  } catch (error) {
    if (
      isCatalogQueryUnavailableError(error) ||
      isCatalogMediaResolutionError(error)
    ) {
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
      return;
    }
    sendApiError(response, "INTERNAL_ERROR", "Internal server error");
  }
};

/**
 * catalog-deep-zoom-v1: `GET /v1/catalog/{catalogId}/media/{mediaId}/zoom-blocks`,
 * the blocks of one image while its Detail entry carries a `zoom` frame.
 * Every other image, and an unknown or malformed id, answers 404; a failed
 * delivery lookup answers 503 for that image only.
 */
export const handleCatalogZoomBlocks = async (
  request: IncomingMessage,
  encodedCatalogId: string,
  encodedMediaId: string,
  response: ServerResponse,
  catalogReadService: CatalogReadService,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  try {
    noQueryTransportSchema.parse(collectTransportQuery(url.searchParams));
  } catch {
    sendApiError(response, "INVALID_QUERY", "Invalid catalog query");
    return;
  }

  let decoded: readonly [string, string];
  try {
    decoded = [
      decodeURIComponent(encodedCatalogId),
      decodeURIComponent(encodedMediaId),
    ];
  } catch {
    sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
    return;
  }
  const catalogId = catalogIdSchema.safeParse(decoded[0]);
  const mediaId = mediaIdSchema.safeParse(decoded[1]);
  if (!catalogId.success || !mediaId.success) {
    sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
    return;
  }

  try {
    const blocks = await catalogReadService.getZoomBlocks(
      catalogId.data,
      mediaId.data,
    );
    if (blocks === null) {
      sendApiError(response, "ITEM_NOT_FOUND", "Catalog item not found");
      return;
    }

    sendJson(response, 200, blocks);
  } catch (error) {
    if (
      isCatalogQueryUnavailableError(error) ||
      isCatalogMediaResolutionError(error)
    ) {
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
      return;
    }
    sendApiError(response, "INTERNAL_ERROR", "Internal server error");
  }
};
