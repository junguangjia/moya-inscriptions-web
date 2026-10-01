import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import {
  authorListQuerySchema,
  threadListQuerySchema,
} from "@moya/contracts/schemas";
import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";

import type { ThreadService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodePathSegment } from "../http/request-boundary.js";

const noStore = { "cache-control": "private, no-store", vary: "Authorization" };

const parsed = <T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T | null => {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
};

/**
 * Public Thread reads and the per-user read marker under `/v1/community/threads/**`
 * (content-community-completion-v1). Thread posts are Works: a post is
 * published through the existing publishing submission with `threadId`.
 *
 *   GET  threads?page&pageSize&anchor      ranked list at a fixed anchor
 *   GET  threads/{id}                      one Thread
 *   GET  threads/{id}/posts?page&pageSize  its eligible Works, newest first
 *   POST threads/{id}/read                 record the latest activity as seen (session)
 */
export const handleThreadRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: readonly string[],
  service: ThreadService,
  viewer: string | null,
  requireActor: () => string,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const query = collectTransportQuery(url.searchParams);
  const method = request.method ?? "GET";
  try {
    if (path.length === 0) {
      if (method !== "GET") {
        sendJson(
          response,
          405,
          { error: { status: 405, message: "Method Not Allowed" } },
          { allow: "GET" },
        );
        return;
      }
      const input = parsed(threadListQuerySchema, query);
      if (input === null) {
        sendApiError(response, "INVALID_QUERY", "Invalid thread query");
        return;
      }
      sendJson(response, 200, await service.list(viewer, input), noStore);
      return;
    }
    const id = decodePathSegment(path[0]!);
    if (id === undefined) {
      sendApiError(response, "ITEM_NOT_FOUND", "Thread not found");
      return;
    }
    if (path.length === 1) {
      if (method !== "GET") {
        sendJson(
          response,
          405,
          { error: { status: 405, message: "Method Not Allowed" } },
          { allow: "GET" },
        );
        return;
      }
      if (Object.keys(query).length > 0) {
        sendApiError(response, "INVALID_QUERY", "Invalid thread query");
        return;
      }
      sendJson(response, 200, await service.read(id, viewer), noStore);
      return;
    }
    if (path.length === 2 && path[1] === "posts" && method === "GET") {
      const input = parsed(authorListQuerySchema, query);
      if (input === null) {
        sendApiError(response, "INVALID_QUERY", "Invalid thread query");
        return;
      }
      sendJson(response, 200, await service.posts(id, viewer, input), noStore);
      return;
    }
    if (path.length === 2 && path[1] === "read" && method === "POST") {
      const actor = requireActor();
      if (Object.keys(query).length > 0) {
        sendApiError(response, "INVALID_QUERY", "Invalid thread query");
        return;
      }
      // The body carries no instant: the server records what it observed.
      await readJsonBody(request, 1000).catch(() => ({}));
      sendJson(response, 200, await service.markRead(id, actor), noStore);
      return;
    }
    sendJson(response, 404, { error: { status: 404, message: "Not Found" } });
  } catch (error) {
    if (isCommunityNotFoundError(error)) {
      sendApiError(response, "ITEM_NOT_FOUND", "Thread not found");
      return;
    }
    if (isCommunityInputError(error)) {
      sendApiError(response, "INVALID_INPUT", error.message);
      return;
    }
    if (isCommunityConflictError(error)) {
      sendApiError(response, "CONFLICT", error.message);
      return;
    }
    if (isCommunityStoreUnavailableError(error)) {
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
      return;
    }
    throw error;
  }
};

const sendOperatorError = (
  response: ServerResponse,
  status: 400 | 404 | 405 | 409 | 503,
  code: string,
): void => sendJson(response, status, { error: { status, code } });

/**
 * Owner operator routes under `/internal/community/threads/**` (audited,
 * receipted; the label is the operator label). Returns false when the path is
 * not a Thread route.
 */
export const handleThreadOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: ThreadService,
  operator: string,
): Promise<boolean> => {
  const prefix = "/internal/community/threads";
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  const rest = pathname.slice(prefix.length).split("/").filter(Boolean);
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://request.invalid");
  try {
    if (rest.length === 0 && method === "GET") {
      try {
        sendJson(
          response,
          200,
          await service.operatorList(collectTransportQuery(url.searchParams)),
        );
      } catch (error) {
        if (!isCommunityInputError(error)) throw error;
        sendOperatorError(response, 400, "INVALID_QUERY");
      }
      return true;
    }
    if (rest.length === 0 && method === "POST") {
      if (url.search) {
        sendOperatorError(response, 400, "INVALID_COMMAND");
        return true;
      }
      sendJson(
        response,
        200,
        await service.operatorCreate(
          operator,
          await readJsonBody(request, 100000),
        ),
      );
      return true;
    }
    if (rest.length === 1 && method === "POST") {
      if (url.search) {
        sendOperatorError(response, 400, "INVALID_COMMAND");
        return true;
      }
      const id = decodePathSegment(rest[0]!);
      if (id === undefined) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return true;
      }
      sendJson(
        response,
        200,
        await service.operatorUpdate(
          operator,
          id,
          await readJsonBody(request, 100000),
        ),
      );
      return true;
    }
    sendOperatorError(
      response,
      rest.length <= 1 ? 405 : 404,
      rest.length <= 1 ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
    );
    return true;
  } catch (error) {
    if (error instanceof JsonBodyError)
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityNotFoundError(error))
      sendOperatorError(response, 404, "NOT_FOUND");
    else if (isCommunityInputError(error))
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityConflictError(error))
      sendOperatorError(response, 409, "STATE_CONFLICT");
    else if (isCommunityStoreUnavailableError(error))
      sendOperatorError(response, 503, "OPERATOR_UNAVAILABLE");
    else throw error;
    return true;
  }
};
