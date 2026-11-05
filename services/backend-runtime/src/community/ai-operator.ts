import { createHash } from "node:crypto";

import { CommunityInputError } from "@moya/api";
import type { CommandReceipt } from "@moya/api";
import {
  AI_OPERATOR_REQUEST_ID_HEADER,
  SELF_ONLY_OWNER_REVIEW,
  aiCountQuerySchema,
  aiFindQuerySchema,
  aiSettlementQuerySchema,
} from "@moya/contracts/internal/admin-mcp";
import type { AiOperatorReader } from "@moya/contracts/internal/admin-mcp";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { sendJson } from "../http/json-response.js";
import { decodePathSegment } from "../http/request-boundary.js";
import { collectTransportQuery } from "../http/transport-query.js";

const noStore = { "cache-control": "private, no-store" };

const refuse = (
  response: ServerResponse,
  status: 400 | 403 | 404 | 503,
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

const requestIdSchema = z.uuid();

/**
 * The comment route's receipt on the AI path. Its body has no `requestId`, and the
 * Owner's route takes none, so the key arrives in a header and binds the exact command:
 * a repeat replays, and the same key on another command is a conflict.
 */
export const aiCommentReceipt = (
  request: IncomingMessage,
  id: string,
  command: unknown,
): CommandReceipt => {
  const requestId = requestIdSchema.safeParse(
    request.headers[AI_OPERATOR_REQUEST_ID_HEADER],
  );
  if (!requestId.success)
    throw new CommunityInputError("A request identity is required");
  const { action, reason } = command as { action?: unknown; reason?: unknown };
  return {
    requestId: requestId.data,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["comment.moderate", id, action, reason]))
      .digest("hex"),
  };
};

/**
 * `PUT featured` names its record in the body, so the route table cannot ask the
 * self-only question it asks of an `:id`. A Catalog is never self-only.
 */
export const featuringSelfOnly = async (
  command: unknown,
  reader: AiOperatorReader,
): Promise<boolean> => {
  const target = (
    command as { target?: { type?: unknown; id?: unknown } } | null
  )?.target;
  return (
    target?.type === "work" &&
    typeof target.id === "string" &&
    (await reader.isSelfOnly("work", target.id))
  );
};

/**
 * What is left of the media work an operation queued (section 9). A subject that
 * cannot be read says so and never reads as settled, and one the Owner holds is named.
 */
const answerSettlement = async (
  response: ServerResponse,
  query: unknown,
  reader: AiOperatorReader,
): Promise<void> => {
  const input = aiSettlementQuerySchema.safeParse(query);
  if (!input.success) return refuse(response, 400, "INVALID_QUERY");
  const answer = await reader.settlement(input.data);
  if (answer === "timed_out") refuse(response, 503, "READ_TIMED_OUT");
  else if (answer === "not_found") refuse(response, 404, "NOT_FOUND");
  else if (answer === "self_only")
    refuse(response, 403, SELF_ONLY_OWNER_REVIEW);
  else sendJson(response, 200, answer, noStore);
};

/** `internal/community/ai/find`, `ai/count` and `ai/settlement`, for AI alone. */
export const handleAiOperatorRead = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  reader: AiOperatorReader | undefined,
): Promise<boolean> => {
  const leaf = /^\/internal\/community\/ai\/(find|count|settlement)$/u.exec(
    pathname,
  )?.[1];
  if (leaf === undefined) return false;
  if (reader === undefined) {
    refuse(response, 503, "OPERATOR_UNAVAILABLE");
    return true;
  }
  const query = collectTransportQuery(
    new URL(request.url ?? "/", "http://request.invalid").searchParams,
  );
  if (leaf === "settlement") {
    await answerSettlement(response, query, reader);
    return true;
  }
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
