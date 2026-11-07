import {
  CommunityInputError,
  isCommunityConflictError,
  isCommunityIdempotencyConflictError,
  isCommunityInputError,
  isCommunityNamedConflictError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
} from "@moya/api";

import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { decodePathSegment } from "../http/request-boundary.js";
import { collectTransportQuery } from "../http/transport-query.js";

import type { TimelineOperatorService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

const sendOperatorError = (
  response: ServerResponse,
  status: 400 | 404 | 405 | 409 | 422 | 503,
  code: string,
): void => sendJson(response, status, { error: { status, code } });

const internal = "/internal/community/";
const ROUTES = ["timeline-entries", "timeline-summary", "timeline-order"];
/** The shape of a contract refusal code (timelineRefusalCodeSchema): never text. */
const REFUSAL_CODE = /^[A-Z][A-Z_]{2,63}$/u;

/**
 * Operator routes of the Home timeline (home-timeline-v1, Issue #384 r3),
 * audited and receipted under the operator label:
 *
 *   GET  timeline-entries?page&pageSize&...  a filtered page of stored rows
 *   GET  timeline-summary                    counts, issues and limits
 *   POST timeline-entries                    a new row (body requestId)
 *   POST timeline-entries/{id}               a change against a read version
 *   POST timeline-order                      one start year's new order
 *
 * The three top-level paths differ, so an entry id never names another route.
 * A refusal by rule answers 422 with its fixed contract code (ENTRY_EXISTS,
 * TIMELINE_FULL, ...), which the Owner's transport keeps as well as the AI's.
 * The runtime does not import the operator contracts, so the code is checked
 * by its shape alone; the adapter only ever names a contract code.
 * Returns false when the path is not a timeline route.
 */
export const handleTimelineOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: TimelineOperatorService,
  operator: string,
): Promise<boolean> => {
  const route = ROUTES.find(
    (name) =>
      pathname === `${internal}${name}` ||
      pathname.startsWith(`${internal}${name}/`),
  );
  if (route === undefined) return false;
  const rest = pathname
    .slice(internal.length + route.length)
    .split("/")
    .filter(Boolean);
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://request.invalid");
  // The body alone carries a command.
  const command = async (): Promise<unknown> => {
    if (url.search) throw new CommunityInputError("Unexpected query");
    return readJsonBody(request, 100000);
  };
  try {
    if (route === "timeline-entries" && rest.length === 0) {
      if (method === "GET") {
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
      if (method === "POST") {
        sendJson(
          response,
          200,
          await service.operatorCreate(operator, await command()),
        );
        return true;
      }
    }
    if (
      route === "timeline-entries" &&
      rest.length === 1 &&
      method === "POST"
    ) {
      const id = decodePathSegment(rest[0]!);
      if (id === undefined) {
        sendOperatorError(response, 404, "NOT_FOUND");
        return true;
      }
      sendJson(
        response,
        200,
        await service.operatorUpdate(operator, id, await command()),
      );
      return true;
    }
    if (route === "timeline-summary" && rest.length === 0 && method === "GET") {
      if (url.search) sendOperatorError(response, 400, "INVALID_QUERY");
      else sendJson(response, 200, await service.operatorSummary());
      return true;
    }
    if (route === "timeline-order" && rest.length === 0 && method === "POST") {
      sendJson(
        response,
        200,
        await service.operatorReorder(operator, await command()),
      );
      return true;
    }
    const known =
      rest.length === 0 || (route === "timeline-entries" && rest.length === 1);
    sendOperatorError(
      response,
      known ? 405 : 404,
      known ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
    );
    return true;
  } catch (error) {
    if (error instanceof JsonBodyError)
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityNotFoundError(error))
      sendOperatorError(response, 404, "NOT_FOUND");
    else if (isCommunityInputError(error))
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityNamedConflictError(error)) {
      // Only a fixed code leaves: never a message, never content.
      if (REFUSAL_CODE.test(error.refusal))
        sendOperatorError(response, 422, error.refusal);
      else sendOperatorError(response, 409, "STATE_CONFLICT");
    } else if (isCommunityIdempotencyConflictError(error))
      sendOperatorError(response, 409, "IDEMPOTENCY_CONFLICT");
    else if (isCommunityConflictError(error))
      sendOperatorError(response, 409, "STATE_CONFLICT");
    else if (isCommunityStoreUnavailableError(error))
      sendOperatorError(response, 503, "OPERATOR_UNAVAILABLE");
    else throw error;
    return true;
  }
};
