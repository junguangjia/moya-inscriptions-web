import {
  isCatalogMediaResolutionError,
  isCatalogQueryUnavailableError,
} from "@moya/api";
import {
  articleCollectionIdSchema,
  articleCollectionListQuerySchema,
  articleIdSchema,
  articleListQuerySchema,
} from "@moya/contracts/schemas";

import { sendApiError } from "../http/api-error-response.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";

import type { EditorialContentReadService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

const headers = { "cache-control": "private, no-store" };

/**
 * `/v1/community/editorial/**`: anonymous reads of the exact published
 * editorial revisions. Composed only in the Development runtime (task
 * content-community-completion-v1); Production registers no such route.
 */
export const handleEditorialRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: readonly string[],
  service: EditorialContentReadService,
): Promise<void> => {
  if (request.method !== "GET") {
    sendJson(
      response,
      405,
      { error: { status: 405, message: "Method Not Allowed" } },
      { allow: "GET" },
    );
    return;
  }
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const query = collectTransportQuery(url.searchParams);
  try {
    if (path.length === 1 && path[0] === "articles") {
      const parsed = articleListQuerySchema.safeParse(query);
      if (!parsed.success) {
        sendApiError(response, "INVALID_QUERY", "Invalid article query");
        return;
      }
      sendJson(response, 200, await service.listArticles(parsed.data), headers);
      return;
    }
    if (path.length === 2 && path[0] === "articles" && path[1]) {
      const id = articleIdSchema.safeParse(decodeURIComponent(path[1]));
      if (!id.success || Object.keys(query).length > 0) {
        sendApiError(response, "ITEM_NOT_FOUND", "Article not found");
        return;
      }
      const detail = await service.readArticle(id.data);
      if (detail === null) {
        sendApiError(response, "ITEM_NOT_FOUND", "Article not found");
        return;
      }
      sendJson(response, 200, detail, headers);
      return;
    }
    if (path.length === 1 && path[0] === "collections") {
      const parsed = articleCollectionListQuerySchema.safeParse(query);
      if (!parsed.success) {
        sendApiError(response, "INVALID_QUERY", "Invalid collection query");
        return;
      }
      sendJson(
        response,
        200,
        await service.listCollections(parsed.data),
        headers,
      );
      return;
    }
    if (path.length === 2 && path[0] === "collections" && path[1]) {
      const id = articleCollectionIdSchema.safeParse(
        decodeURIComponent(path[1]),
      );
      if (!id.success || Object.keys(query).length > 0) {
        sendApiError(response, "ITEM_NOT_FOUND", "Collection not found");
        return;
      }
      const detail = await service.readCollection(id.data);
      if (detail === null) {
        sendApiError(response, "ITEM_NOT_FOUND", "Collection not found");
        return;
      }
      sendJson(response, 200, detail, headers);
      return;
    }
    sendJson(response, 404, { error: { status: 404, message: "Not Found" } });
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
