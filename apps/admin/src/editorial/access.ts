import type { Access, PayloadRequest, Where } from "payload";
import { parseCookies } from "payload/shared";

import { EditorialError } from "./errors";

export const isOwner = (req: PayloadRequest): boolean =>
  req.user?.collection === "users" && req.user.role === "owner";

export const isAutomation = (req: PayloadRequest): boolean =>
  req.user?.collection === "users" && req.user.role === "automation";

// Set by the server after credential lookup, never by the caller. Payload does
// not type it on req.user.
const strategyOf = (req: PayloadRequest): unknown =>
  (req.user as { _strategy?: unknown } | null | undefined)?._strategy;

/**
 * The role grants authority only through an MCP door, a key or a consented
 * connection, and only the door sets those strategies. A JWT or REST key on the row
 * grants nothing, and neither strategy grants anything on a row with another role.
 */
export const isAiOperator = (req: PayloadRequest): boolean => {
  if (req.user?.collection !== "users" || req.user.role !== "ai_operator")
    return false;
  const strategy = strategyOf(req);
  return strategy === "mcp-api-key" || strategy === "mcp-connection";
};

/** Owner authority on every gate explicitly converted (amendment 2026-11-03). */
export const actsAsOwner = (req: PayloadRequest): boolean =>
  isOwner(req) || isAiOperator(req);

/**
 * Reserved surfaces: an Owner browser session only. `local-jwt` alone is any
 * valid Owner JWT, which Payload also accepts from `Authorization: JWT` and
 * `Authorization: Bearer`, so no key and no header token passes here.
 */
export const isHumanOwner = (req: PayloadRequest): boolean =>
  isOwner(req) &&
  strategyOf(req) === "local-jwt" &&
  !req.headers.has("authorization") &&
  Boolean(
    parseCookies(req.headers).get(`${req.payload.config.cookiePrefix}-token`),
  );

export const catalogScope = (req: PayloadRequest): string[] => {
  const value: unknown =
    req.user?.collection === "users" ? req.user.scopeCatalogIds : undefined;
  return Array.isArray(value) && value.every((id) => typeof id === "string")
    ? value
    : [];
};

export const canEditCatalog = (
  req: PayloadRequest,
  catalogId: string,
): boolean =>
  actsAsOwner(req) ||
  (isAutomation(req) && catalogScope(req).includes(catalogId));

export const requireActor = (req: PayloadRequest) => {
  if (
    req.user?.collection !== "users" ||
    !(actsAsOwner(req) || isAutomation(req))
  ) {
    throw new EditorialError("AUTHORIZATION_REQUIRED", 403);
  }
  return req.user;
};

export const catalogScopeAccess = (req: PayloadRequest): boolean | Where => {
  if (actsAsOwner(req)) return true;
  if (!isAutomation(req) || catalogScope(req).length === 0) return false;
  return { catalogId: { in: catalogScope(req) } };
};

const scoped: Access = ({ req }) => catalogScopeAccess(req);

export const catalogAccess = {
  create: ({ req }: { req: PayloadRequest }) =>
    actsAsOwner(req) || isAutomation(req),
  delete: () => false,
  read: scoped,
  readVersions: scoped,
  update: scoped,
};
