import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import type { CommunitySessionService, FeedbackService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";
import { readBearerToken } from "./session-credential.js";

const noStore = { "cache-control": "private, no-store", vary: "Authorization" };

export const handleFeedbackRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: FeedbackService,
  sessions: CommunitySessionService,
): Promise<void> => {
  if (request.method !== "POST") {
    sendJson(
      response,
      405,
      { error: { status: 405, message: "Method Not Allowed" } },
      { allow: "POST", ...noStore },
    );
    return;
  }
  try {
    const token = readBearerToken(request);
    const viewer = token === undefined ? null : await sessions.identify(token);
    if (viewer === null || request.headers["x-author-account"] !== viewer.id) {
      sendApiError(
        response,
        "UNAUTHENTICATED",
        "A valid account session is required",
      );
      return;
    }
    if (new URL(request.url ?? "/", "http://request.invalid").search) {
      sendApiError(response, "INVALID_QUERY", "Feedback accepts no query");
      return;
    }
    sendJson(
      response,
      201,
      await service.submit(viewer.id, await readJsonBody(request, 65536)),
      noStore,
    );
  } catch (error) {
    if (error instanceof JsonBodyError || isCommunityInputError(error))
      sendApiError(response, "INVALID_INPUT", "Invalid feedback request");
    else if (isCommunityConflictError(error))
      sendApiError(response, "CONFLICT", "Feedback submission conflict");
    else if (isCommunityStoreUnavailableError(error))
      sendApiError(
        response,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      );
    else throw error;
  }
};

/** This read-only family is called only after the existing operator credential gate. */
export const handleFeedbackOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: FeedbackService,
): Promise<void> => {
  if (request.method !== "GET") {
    sendJson(
      response,
      405,
      { error: { status: 405, code: "METHOD_NOT_ALLOWED" } },
      { allow: "GET", ...noStore },
    );
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "http://request.invalid");
    sendJson(
      response,
      200,
      await service.operatorList(collectTransportQuery(url.searchParams)),
      noStore,
    );
  } catch (error) {
    if (!isCommunityInputError(error)) throw error;
    sendJson(
      response,
      400,
      { error: { status: 400, code: "INVALID_QUERY" } },
      noStore,
    );
  }
};
