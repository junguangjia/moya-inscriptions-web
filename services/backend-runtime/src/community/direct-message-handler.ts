import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import {
  directConversationListQuerySchema,
  directMessageHistoryQuerySchema,
  directMessageReadCommandSchema,
  publicUserIdSchema,
  requestIdentitySchema,
  sendDirectMessageCommandSchema,
} from "@moya/contracts/schemas";
import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";

import type { DirectMessageService } from "@moya/api";
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
 * `/v1/community/messages/**` (content-community-completion-v1): the
 * signed-in account's direct messages. Every route requires the session; the
 * sender is the session account, never a body field.
 *
 *   GET  messages                              conversation list (cursor)
 *   GET  messages/unread                       unread conversation count (badge unit)
 *   GET  messages/with/{userId}                the canonical pair, if any (never creates)
 *   POST messages                              send (recipientId | conversationId)
 *   GET  messages/{id}?before|after&pageSize   history, newest first
 *   POST messages/{id}/{hide|unhide|mute|unmute}
 *   POST messages/{id}/read                    observed sequence (clamped, monotonic)
 */
export const handleDirectMessageRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: readonly string[],
  service: DirectMessageService,
  requireActor: () => string,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const query = collectTransportQuery(url.searchParams);
  const method = request.method ?? "GET";
  const invalidQuery = () =>
    sendApiError(response, "INVALID_QUERY", "Invalid message query");
  const body = async () => {
    if (url.search) throw new JsonBodyError("Unexpected query");
    return readJsonBody(request, 64_000);
  };
  try {
    const actor = requireActor();
    if (path.length === 0 && method === "GET") {
      const input = parsed(directConversationListQuerySchema, query);
      if (input === null) return invalidQuery();
      sendJson(response, 200, await service.list(actor, input), noStore);
      return;
    }
    if (path.length === 0 && method === "POST") {
      const input = parsed(sendDirectMessageCommandSchema, await body());
      if (input === null) {
        sendApiError(response, "INVALID_INPUT", "dm_text_invalid");
        return;
      }
      sendJson(response, 201, await service.send(actor, input), noStore);
      return;
    }
    if (path.length === 1 && path[0] === "unread" && method === "GET") {
      if (Object.keys(query).length > 0) return invalidQuery();
      sendJson(response, 200, await service.unread(actor), noStore);
      return;
    }
    if (path.length === 2 && path[0] === "with" && method === "GET") {
      const segment = decodePathSegment(path[1]!);
      const other =
        segment === undefined ? null : parsed(publicUserIdSchema, segment);
      if (other === null || Object.keys(query).length > 0)
        return invalidQuery();
      sendJson(
        response,
        200,
        { conversation: await service.with(actor, other) },
        noStore,
      );
      return;
    }
    const id = decodePathSegment(path[0] ?? "");
    if (id === undefined) {
      sendApiError(response, "ITEM_NOT_FOUND", "Conversation not found");
      return;
    }
    if (path.length === 1 && method === "GET") {
      const input = parsed(directMessageHistoryQuerySchema, query);
      if (input === null) return invalidQuery();
      sendJson(response, 200, await service.read(actor, id, input), noStore);
      return;
    }
    if (path.length === 2 && method === "POST") {
      const leaf = path[1];
      if (leaf === "read") {
        const input = parsed(directMessageReadCommandSchema, await body());
        if (input === null) {
          sendApiError(response, "INVALID_INPUT", "Invalid read command");
          return;
        }
        sendJson(
          response,
          200,
          await service.markRead(actor, id, input.sequence, input.requestId),
          noStore,
        );
        return;
      }
      if (
        leaf === "hide" ||
        leaf === "unhide" ||
        leaf === "mute" ||
        leaf === "unmute"
      ) {
        const input = parsed(requestIdentitySchema, await body());
        if (input === null) {
          sendApiError(response, "INVALID_INPUT", "Invalid command");
          return;
        }
        const result =
          leaf === "hide" || leaf === "unhide"
            ? await service.hide(actor, id, leaf === "hide", input.requestId)
            : await service.mute(actor, id, leaf === "mute", input.requestId);
        sendJson(response, 200, result, noStore);
        return;
      }
    }
    sendJson(response, 404, { error: { status: 404, message: "Not Found" } });
  } catch (error) {
    if (error instanceof JsonBodyError) {
      sendApiError(response, "INVALID_INPUT", "Invalid command body");
      return;
    }
    if (isCommunityNotFoundError(error)) {
      sendApiError(response, "ITEM_NOT_FOUND", "Conversation not found");
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
 * Owner-only DM moderation under `/internal/community/messages/**`: one
 * explicitly selected conversation (by id, or by both participant ids) with a
 * stated purpose, and removal of one message. Every access is audited
 * content-free. There is no listing or search of private messages.
 *
 *   POST messages/conversation      { id, purpose }
 *   POST messages/lookup            { userIds: [a, b], purpose }
 *   POST messages/{messageId}/remove { requestId, purpose }
 */
export const handleDirectMessageOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: DirectMessageService,
  operator: string,
): Promise<boolean> => {
  const prefix = "/internal/community/messages";
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  const rest = pathname.slice(prefix.length).split("/").filter(Boolean);
  const method = request.method ?? "GET";
  try {
    if (method !== "POST") {
      sendOperatorError(response, 405, "METHOD_NOT_ALLOWED");
      return true;
    }
    if (new URL(request.url ?? "/", "http://request.invalid").search) {
      sendOperatorError(response, 400, "INVALID_COMMAND");
      return true;
    }
    // The operator Contracts are applied inside the application service; the
    // runtime only moves the untrusted body and maps refusals to statuses.
    if (rest.length === 1 && rest[0] === "conversation") {
      sendJson(
        response,
        200,
        await service.operatorRead(
          operator,
          await readJsonBody(request, 10_000),
        ),
      );
      return true;
    }
    if (rest.length === 1 && rest[0] === "lookup") {
      const found = await service.operatorFind(
        operator,
        await readJsonBody(request, 10_000),
      );
      if (found === null) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return true;
      }
      sendJson(response, 200, found);
      return true;
    }
    if (rest.length === 2 && rest[1] === "remove") {
      const messageId = decodePathSegment(rest[0]!);
      if (messageId === undefined) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return true;
      }
      sendJson(
        response,
        200,
        await service.operatorRemove(
          operator,
          messageId,
          await readJsonBody(request, 10_000),
        ),
      );
      return true;
    }
    sendOperatorError(response, 404, "NOT_FOUND");
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
