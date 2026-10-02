import { isCommunityStoreUnavailableError } from "@moya/api";
import {
  authAccountSecuritySchema,
  authCapabilitiesSchema,
  authChallengeAcceptedSchema,
  authChallengeRequestSchema,
  authFactorCompleteRequestSchema,
  authRegistrationRequestSchema,
  authPasswordLoginRequestSchema,
  authPasswordResetRequestSchema,
  authPasswordResetResultSchema,
  authUnlinkRequestSchema,
  authVerifyRequestSchema,
  publicUserDisplayNameSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";

import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { readBearerToken } from "./session-credential.js";

import type { AuthRequestSource } from "./auth-request-source.js";

import type { ApiErrorCode } from "@moya/contracts";
import type { AuthReason, CommunityAuthService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

const noStore = { "cache-control": "private, no-store" };

/** Forwarding headers cannot choose the rate-limit identity. */
export const trustedRequestSource = (request: IncomingMessage): string =>
  request.socket.remoteAddress ?? "unknown";

const codeFor = (reason: AuthReason): { readonly code: ApiErrorCode } => {
  switch (reason) {
    case "AUTH_INVALID_CREDENTIALS":
    case "AUTH_UNAUTHENTICATED":
    case "AUTH_ACCOUNT_SUSPENDED":
      return { code: "UNAUTHENTICATED" };
    case "AUTH_IDENTIFIER_CONFLICT":
    case "AUTH_LAST_FACTOR":
    case "AUTH_STALE_VERSION":
    case "AUTH_RATE_LIMITED":
    case "AUTH_CODE_EXHAUSTED":
      return { code: "CONFLICT" };
    case "AUTH_CHANNEL_UNAVAILABLE":
    case "AUTH_DELIVERY_FAILED":
    case "AUTH_DELIVERY_UNKNOWN":
    case "AUTH_NOT_CONFIGURED":
      return { code: "SERVICE_UNAVAILABLE" };
    default:
      return { code: "INVALID_INPUT" };
  }
};

const sendFailure = (response: ServerResponse, reason: AuthReason): void => {
  sendApiError(response, codeFor(reason).code, reason);
};

const sendCaught = (response: ServerResponse, error: unknown): void => {
  if (isCommunityStoreUnavailableError(error)) {
    sendApiError(response, "SERVICE_UNAVAILABLE", "AUTH_NOT_CONFIGURED");
    return;
  }
  sendApiError(response, "INTERNAL_ERROR", "INTERNAL_ERROR");
};

const sessionBody = (session: {
  readonly token: string;
  readonly expiresAt: string;
  readonly profile: unknown;
}) => ({
  token: session.token,
  expiresAt: session.expiresAt,
  profile: publicUserProfileSchema.parse(session.profile),
});

/**
 * Authentication routes with composition-owned source forwarding authority. The session token in a success body is a server-to-server
 * grant; the same-origin Web route removes it before browser JavaScript.
 */
export const handleCommunityAuth = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: CommunityAuthService,
  resolveSource?: AuthRequestSource,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const path = url.pathname.slice("/v1/community/auth/".length);
  try {
    const source =
      request.method !== "POST"
        ? "unused"
        : resolveSource !== undefined
          ? resolveSource(request)
          : service.capabilities().developmentOnly
            ? trustedRequestSource(request)
            : null;
    if (source === null) {
      sendApiError(response, "UNAUTHENTICATED", "AUTH_SOURCE_UNTRUSTED");
      return;
    }
    if (path === "capabilities" && request.method === "GET") {
      sendJson(
        response,
        200,
        authCapabilitiesSchema.parse(service.capabilities()),
        noStore,
      );
      return;
    }
    if (path === "account" && request.method === "GET") {
      const token = readBearerToken(request);
      if (token === undefined) {
        sendFailure(response, "AUTH_UNAUTHENTICATED");
        return;
      }
      const account = await service.readAccount(token);
      if (!account.ok) {
        sendFailure(response, account.reason);
        return;
      }
      sendJson(
        response,
        200,
        authAccountSecuritySchema.parse(account.value),
        noStore,
      );
      return;
    }
    if (path === "sign-out" && request.method === "POST") {
      const token = readBearerToken(request);
      if (token === undefined) {
        sendFailure(response, "AUTH_UNAUTHENTICATED");
        return;
      }
      const result = await service.signOut(token);
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      response.writeHead(204, noStore);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      sendApiError(response, "INVALID_QUERY", "INVALID_QUERY");
      return;
    }
    const body = await readJsonBody(request);
    const token = readBearerToken(request);
    if (path === "challenges") {
      const parsed = authChallengeRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "AUTH_INVALID_IDENTIFIER");
        return;
      }
      const result = await service.sendChallenge({
        channel: parsed.data.channel,
        purpose: parsed.data.purpose,
        ...(parsed.data.identifier === undefined
          ? {}
          : { identifier: parsed.data.identifier }),
        idempotencyKey: parsed.data.idempotencyKey,
        source,
        ...(token === undefined ? {} : { sessionToken: token }),
        ...(parsed.data.reauthToken === undefined
          ? {}
          : { reauthToken: parsed.data.reauthToken }),
      });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        200,
        authChallengeAcceptedSchema.parse(result.value),
        noStore,
      );
      return;
    }
    if (path === "challenges/verify") {
      const parsed = authVerifyRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "AUTH_CODE_INVALID");
        return;
      }
      const result = await service.verifyChallenge(parsed.data);
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      const value = result.value;
      if (value.outcome === "signed_in") {
        sendJson(
          response,
          200,
          { outcome: value.outcome, session: sessionBody(value.session) },
          noStore,
        );
        return;
      }
      sendJson(response, 200, value, noStore);
      return;
    }
    if (path === "passwords/login") {
      const parsed = authPasswordLoginRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendFailure(response, "AUTH_INVALID_CREDENTIALS");
        return;
      }
      const result = await service.passwordLogin({ ...parsed.data, source });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        200,
        { outcome: "signed_in", session: sessionBody(result.value) },
        noStore,
      );
      return;
    }
    if (path === "passwords/reset") {
      const parsed = authPasswordResetRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendFailure(
          response,
          parsed.error.issues.some((issue) => issue.path[0] === "password")
            ? "AUTH_INVALID_PASSWORD"
            : "AUTH_PROOF_REJECTED",
        );
        return;
      }
      const result = await service.resetPassword({ ...parsed.data, source });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        200,
        authPasswordResetResultSchema.parse(result.value),
        noStore,
      );
      return;
    }
    if (path === "registrations") {
      const parsed = authRegistrationRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendFailure(
          response,
          parsed.error.issues.some((issue) => issue.path[0] === "password")
            ? "AUTH_INVALID_PASSWORD"
            : parsed.error.issues.some(
                  (issue) =>
                    issue.path[0] === "studioName" ||
                    issue.path[0] === "studioNameSuffix",
                )
              ? "AUTH_INVALID_STUDIO_NAME"
              : "AUTH_AGREEMENT_REQUIRED",
        );
        return;
      }
      if (
        !publicUserDisplayNameSchema.safeParse(parsed.data.displayName).success
      ) {
        sendApiError(response, "INVALID_INPUT", "AUTH_INVALID_DISPLAY_NAME");
        return;
      }
      const result = await service.confirmRegistration({
        ...parsed.data,
        source,
      });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        201,
        { outcome: "registered", session: sessionBody(result.value) },
        noStore,
      );
      return;
    }
    if (token === undefined) {
      sendFailure(response, "AUTH_UNAUTHENTICATED");
      return;
    }
    if (path === "factors/complete") {
      const parsed = authFactorCompleteRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "AUTH_CODE_INVALID");
        return;
      }
      const result = await service.completeFactor({
        ...parsed.data,
        sessionToken: token,
      });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        200,
        {
          outcome: "updated",
          session: sessionBody(result.value.session),
          account: authAccountSecuritySchema.parse(result.value.account),
        },
        noStore,
      );
      return;
    }
    if (path === "factors/unlink") {
      const parsed = authUnlinkRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(response, "INVALID_INPUT", "AUTH_LAST_FACTOR");
        return;
      }
      const result = await service.unlinkFactor({
        ...parsed.data,
        sessionToken: token,
      });
      if (!result.ok) {
        sendFailure(response, result.reason);
        return;
      }
      sendJson(
        response,
        200,
        {
          outcome: "updated",
          session: sessionBody(result.value.session),
          account: authAccountSecuritySchema.parse(result.value.account),
        },
        noStore,
      );
      return;
    }
    sendApiError(response, "ITEM_NOT_FOUND", "ITEM_NOT_FOUND");
  } catch (error) {
    if (error instanceof JsonBodyError) {
      sendApiError(response, "INVALID_INPUT", "AUTH_INVALID_IDENTIFIER");
      return;
    }
    sendCaught(response, error);
  }
};
