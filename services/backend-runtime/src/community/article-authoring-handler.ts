import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
  parseArticleBlockEditsCommand,
  parseArticleCandidateCommand,
  parseArticleDraftCreateCommand,
  parseArticleOwnMediaListQuery,
  parseArticleDraftListQuery,
  parseArticleDraftUpdateCommand,
  parseArticleDraftDeletionCommand,
  parseArticleId,
} from "@moya/api";
import type {
  ArticleAuthoringService,
  CommunitySessionService,
} from "@moya/api";
import { ARTICLE_DOCUMENT_LIMITS } from "@moya/contracts/schemas";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { decodePathSegment } from "../http/request-boundary.js";
import { collectTransportQuery } from "../http/transport-query.js";
import { readBearerToken } from "./session-credential.js";

/** Finite document plus command metadata; ordinary Work body limits stay intact. */
export const ARTICLE_AUTHORING_REQUEST_BYTES =
  ARTICLE_DOCUMENT_LIMITS.documentBytes + 16_384;

/**
 * Private human authoring under /v1/community/article-authoring.
 * The Development router alone composes this entry. MCP uses the same service
 * through its separately authenticated delegated actor, never this session route.
 */
export async function handleArticleAuthoringRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: readonly string[],
  service: ArticleAuthoringService,
  sessions: CommunitySessionService,
): Promise<void> {
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("vary", "Authorization, x-author-account");
  try {
    const token = readBearerToken(request);
    const viewer = token === undefined ? null : await sessions.identify(token);
    // Fence account changes on reads as well as writes. Identity never comes
    // from a document, byline, query, authorId or a delegated/Admin token.
    if (viewer === null || request.headers["x-author-account"] !== viewer.id) {
      sendApiError(
        response,
        "UNAUTHENTICATED",
        "A current user session is required",
      );
      return;
    }
    const actor = { source: "human" as const, userId: viewer.id };
    const url = new URL(request.url ?? "/", "http://request.invalid");
    const query = collectTransportQuery(url.searchParams);
    const method = request.method;
    const body = (maximumBytes = ARTICLE_AUTHORING_REQUEST_BYTES) => {
      const declaredBytes = request.headers["content-length"];
      if (
        typeof declaredBytes === "string" &&
        Number(declaredBytes) > maximumBytes
      ) {
        // A known oversized body can be refused before the async iterator
        // consumes it. Drain without buffering so the response can complete.
        request.resume();
        throw new JsonBodyError("Request body exceeds the allowed size");
      }
      return readJsonBody(request, maximumBytes);
    };
    if (path.length === 0 && method === "GET") {
      sendJson(
        response,
        200,
        await service.list(actor, parseArticleDraftListQuery(query)),
      );
      return;
    }
    if (path.length === 1 && path[0] === "media" && method === "GET") {
      sendJson(
        response,
        200,
        await service.listOwnMedia(actor, parseArticleOwnMediaListQuery(query)),
      );
      return;
    }
    if (Object.keys(query).length !== 0) {
      sendApiError(response, "INVALID_QUERY", "Unexpected Article query");
      return;
    }
    if (path.length === 0 && method === "POST") {
      const command = parseArticleDraftCreateCommand(await body());
      sendJson(response, 201, await service.create(actor, command));
      return;
    }
    if (path.length === 1 || path.length === 2) {
      const segment = decodePathSegment(path[0] ?? "");
      const id = parseArticleId(segment);
      if (path.length === 1 && method === "GET") {
        sendJson(response, 200, await service.read(actor, id));
        return;
      }
      if (path.length === 1 && method === "DELETE") {
        const command = parseArticleDraftDeletionCommand(await body(4096));
        sendJson(response, 200, await service.deleteDraft(actor, id, command));
        return;
      }
      if (path.length === 1 && method === "PUT") {
        const command = parseArticleDraftUpdateCommand(await body());
        sendJson(response, 200, await service.save(actor, id, command));
        return;
      }
      if (path.length === 2 && method === "POST" && path[1] === "blocks") {
        const command = parseArticleBlockEditsCommand(await body());
        sendJson(response, 200, await service.editBlocks(actor, id, command));
        return;
      }
      if (
        path.length === 2 &&
        method === "POST" &&
        ["validate", "preview", "publish", "withdraw"].includes(path[1] ?? "")
      ) {
        const command = parseArticleCandidateCommand(await body(4096));
        if (path[1] === "validate")
          sendJson(response, 200, await service.validate(actor, id, command));
        else if (path[1] === "preview")
          sendJson(response, 200, await service.preview(actor, id, command));
        else if (path[1] === "withdraw")
          sendJson(response, 200, await service.withdraw(actor, id, command));
        else {
          const draft = await service.publish(actor, id, command);
          if (draft.status !== "pending" && draft.status !== "published")
            throw new Error("Invalid Article publication result");
          sendJson(response, 200, {
            requestId: command.requestId,
            status: draft.status === "pending" ? "pending" : "published",
            draft,
          });
        }
        return;
      }
    }
    sendJson(response, 404, { error: { status: 404, message: "Not Found" } });
  } catch (error) {
    sendApiError(
      response,
      isCommunityNotFoundError(error)
        ? "ITEM_NOT_FOUND"
        : isCommunityConflictError(error)
          ? "CONFLICT"
          : isCommunityInputError(error) || error instanceof JsonBodyError
            ? "INVALID_INPUT"
            : isCommunityStoreUnavailableError(error)
              ? "SERVICE_UNAVAILABLE"
              : "INTERNAL_ERROR",
      isCommunityInputError(error) || isCommunityConflictError(error)
        ? error.message
        : "Article authoring request unavailable",
    );
  }
}
