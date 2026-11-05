import {
  aiCountQuerySchema,
  aiFindQuerySchema,
} from "@moya/contracts/internal/admin-mcp";
import type { AiOperatorReader } from "@moya/contracts/internal/admin-mcp";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "../http/json-response.js";
import { decodePathSegment } from "../http/request-boundary.js";
import { collectTransportQuery } from "../http/transport-query.js";

const noStore = { "cache-control": "private, no-store" };

const refuse = (
  response: ServerResponse,
  status: 400 | 404 | 503,
  code: string,
): void => sendJson(response, status, { error: { status, code } }, noStore);

/**
 * A NUL reaches no column, because PostgreSQL text cannot hold one, so it is named
 * here and never met as a driver error. A key an object inherits, such as
 * `constructor`, would read as a value already collected. A malformed escape names
 * no subject.
 */
export const aiInputRefusal = (
  request: IncomingMessage,
  pathname: string,
): { readonly status: 400 | 404; readonly code: string } | null => {
  const segments = pathname.split("/").map(decodePathSegment);
  if (segments.includes(undefined)) return { status: 404, code: "NOT_FOUND" };
  const query = [
    ...new URL(request.url ?? "/", "http://request.invalid").searchParams,
  ];
  return query.some(([key]) => key in Object.prototype) ||
    [...segments, ...query.flat()].some((value) => value?.includes("\u0000"))
    ? { status: 400, code: "INVALID_COMMAND" }
    : null;
};

/** `internal/community/ai/find` and `ai/count`, for the AI credential alone. */
export const handleAiOperatorRead = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  reader: AiOperatorReader | undefined,
): Promise<boolean> => {
  const leaf = /^\/internal\/community\/ai\/(find|count)$/u.exec(pathname)?.[1];
  if (leaf === undefined) return false;
  if (reader === undefined) {
    refuse(response, 503, "OPERATOR_UNAVAILABLE");
    return true;
  }
  const query = collectTransportQuery(
    new URL(request.url ?? "/", "http://request.invalid").searchParams,
  );
  if (leaf === "find") {
    const input = aiFindQuerySchema.safeParse(query);
    if (input.success)
      sendJson(response, 200, await reader.find(input.data), noStore);
    else refuse(response, 400, "INVALID_QUERY");
    return true;
  }
  const input = aiCountQuerySchema.safeParse(query);
  if (!input.success) {
    refuse(response, 400, "INVALID_QUERY");
    return true;
  }
  const answer = await reader.count(input.data);
  if (answer === "timed_out") refuse(response, 503, "READ_TIMED_OUT");
  else sendJson(response, 200, answer, noStore);
  return true;
};
