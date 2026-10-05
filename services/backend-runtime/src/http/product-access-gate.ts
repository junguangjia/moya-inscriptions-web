import { isCommunityStoreUnavailableError } from "@moya/api";
import { productAccessSchema } from "@moya/contracts/schemas";

import { refuseTransfer } from "../community/publishing-upload.js";
import { readBearerToken } from "../community/session-credential.js";
import { sendApiError } from "./api-error-response.js";
import { sendJson } from "./json-response.js";
import { containRequest } from "./request-boundary.js";

import type { CommunitySessionService } from "@moya/api";
import type { ProductAccess } from "@moya/contracts";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

/**
 * The one product access policy. `public` adds no restriction. `closed_beta`
 * admits only explicitly approved accounts, named by their immutable id; an
 * account, a session, a handle or an operator identity alone admits nobody.
 */
export interface ProductAccessPolicy {
  readonly mode: ProductAccess["mode"];
  /** Asked on every protected request, so a change applies to sessions that already exist. */
  admits(userId: string): boolean;
}

export const publicProductAccess: ProductAccessPolicy = Object.freeze({
  mode: "public",
  admits: () => true,
});

type SessionIdentity = Pick<CommunitySessionService, "identify">;

/**
 * Session identity for a connection that outlives its first request: an
 * account that is no longer admitted reads as signed out at the next check.
 */
export const admittedSessions = (
  sessions: SessionIdentity,
  policy: ProductAccessPolicy,
): SessionIdentity =>
  policy.mode === "public"
    ? sessions
    : {
        identify: async (token) => {
          const user = await sessions.identify(token);
          return user !== null && policy.admits(user.id) ? user : null;
        },
      };

export const productAccessPath = "/v1/community/access";

/**
 * Everything a closed beta leaves reachable without an admitted session. None
 * of it serves product content: readiness, the session owner's own identity,
 * the access answer, and the operations that obtain or end a session (each
 * keeps its own existing rules, such as closed registration).
 */
const openPaths: ReadonlySet<string> = new Set([
  "/health",
  "/v1/me",
  "/v1/development/sign-in",
  "/v1/development/sign-out",
]);
const authPrefix = "/v1/community/auth/";
const openAuthOperations: ReadonlySet<string> = new Set([
  "GET capabilities",
  "POST challenges",
  "POST challenges/verify",
  "POST passwords/login",
  "POST passwords/reset",
  "POST registrations",
  "POST sign-out",
]);
/** The Owner's operator boundary answers only to its own credential. */
const operatorPrefix = "/internal/community/";
/** A body that may still be streaming when the answer is written. */
const transferPrefix = "/v1/community/publishing/uploads/";

/** Whose authority decides a request: nobody's, another boundary's, or the session's. */
export const productRouteAuthority = (
  method: string | undefined,
  pathname: string,
  delegatedPaths: ReadonlySet<string>,
): "open" | "boundary" | "session" => {
  if (openPaths.has(pathname)) return "open";
  if (
    pathname.startsWith(authPrefix) &&
    openAuthOperations.has(`${method} ${pathname.slice(authPrefix.length)}`)
  )
    return "open";
  if (pathname.startsWith(operatorPrefix) || delegatedPaths.has(pathname))
    return "boundary";
  return "session";
};

export interface ProductAccessGateOptions {
  readonly policy: ProductAccessPolicy;
  /** Absent without an identity port: nobody can be identified, so a closed beta admits nobody. */
  readonly sessions: SessionIdentity | undefined;
  /**
   * Paths behind a separate grant (the Article MCP resource and its discovery
   * document). Their handler requires the represented account to be admitted.
   */
  readonly delegatedPaths: ReadonlySet<string>;
  readonly refusalReadMs: number;
}

const apiFailure = (response: ServerResponse): void =>
  sendApiError(response, "INTERNAL_ERROR", "Internal error");

/**
 * Runs in front of the router and decides before any product data or command
 * is served. Default deny: a route is protected unless it is named above.
 */
export const createProductAccessGate = (
  { policy, sessions, delegatedPaths, refusalReadMs }: ProductAccessGateOptions,
  next: RequestListener,
): RequestListener => {
  const standing = async (
    request: IncomingMessage,
  ): Promise<ProductAccess["access"]> => {
    const token = readBearerToken(request);
    if (token === undefined || sessions === undefined)
      return "sign_in_required";
    const user = await sessions.identify(token);
    if (user === null) return "sign_in_required";
    return policy.admits(user.id) ? "granted" : "restricted";
  };

  const refuse = (
    request: IncomingMessage,
    response: ServerResponse,
    status: 401 | 403 | 503,
  ): void => {
    const [code, message] =
      status === 401
        ? (["UNAUTHENTICATED", "A valid session is required"] as const)
        : status === 403
          ? ([
              "ACCESS_RESTRICTED",
              "This account is not approved for the closed beta",
            ] as const)
          : ([
              "SERVICE_UNAVAILABLE",
              "Service temporarily unavailable",
            ] as const);
    const pathname = new URL(request.url ?? "/", "http://request.invalid")
      .pathname;
    if (pathname.startsWith(transferPrefix))
      refuseTransfer(request, response, status, code, message, refusalReadMs);
    else sendApiError(response, code, message);
  };

  const answerAccess = async (
    request: IncomingMessage,
    response: ServerResponse,
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
    if (new URL(request.url ?? "/", "http://request.invalid").search !== "") {
      sendApiError(response, "INVALID_QUERY", "Invalid access query");
      return;
    }
    let access: ProductAccess["access"] = "granted";
    if (policy.mode !== "public") {
      try {
        access = await standing(request);
      } catch (error) {
        if (!isCommunityStoreUnavailableError(error)) throw error;
        refuse(request, response, 503);
        return;
      }
    }
    sendJson(
      response,
      200,
      productAccessSchema.parse({ mode: policy.mode, access }),
      { "cache-control": "private, no-store", vary: "Authorization" },
    );
  };

  const admit = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let access: ProductAccess["access"];
    try {
      access = await standing(request);
    } catch (error) {
      if (!isCommunityStoreUnavailableError(error)) throw error;
      refuse(request, response, 503);
      return;
    }
    if (access === "granted") next(request, response);
    else refuse(request, response, access === "restricted" ? 403 : 401);
  };

  return (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://request.invalid").pathname;
    } catch {
      // The router answers a request target that is not a URL path.
      next(request, response);
      return;
    }
    if (pathname === productAccessPath) {
      containRequest(response, answerAccess(request, response), apiFailure);
      return;
    }
    if (
      policy.mode === "public" ||
      productRouteAuthority(request.method, pathname, delegatedPaths) !==
        "session"
    ) {
      next(request, response);
      return;
    }
    containRequest(response, admit(request, response), apiFailure);
  };
};
