import { randomUUID } from "node:crypto";

import { apiErrorSchema } from "@moya/contracts/schemas";

import { sendJson } from "./json-response.js";

import type { ApiErrorCode } from "@moya/contracts";
import type { ServerResponse } from "node:http";

const statusByErrorCode = {
  // A valid session whose account the product access policy does not admit.
  ACCESS_RESTRICTED: 403,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  // A well-formed request whose body fails a Contract or domain rule.
  INVALID_INPUT: 422,
  INVALID_QUERY: 400,
  ITEM_NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  UNAUTHENTICATED: 401,
} as const satisfies Record<
  ApiErrorCode,
  400 | 401 | 403 | 404 | 409 | 422 | 500 | 503
>;

export const sendApiError = (
  response: ServerResponse,
  code: ApiErrorCode,
  message: string,
): void => {
  const body = apiErrorSchema.parse({
    error: { code, message, requestId: randomUUID() },
  });
  sendJson(response, statusByErrorCode[code], body);
};
