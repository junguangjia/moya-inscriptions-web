import { UnauthorizedError } from "payload";

import { connectionAuth } from "./authorization";
import { isConnectionToken } from "./contracts";

import type { ConnectionAuthDependencies } from "./authorization";
import type { ConnectionPreset } from "./contracts";
import type { MCPAccessSettings } from "@payloadcms/plugin-mcp";
import type { PayloadRequest } from "payload";

/**
 * Agent Connections V1 (Issue #141 r10) and the login door (amendment 2026-11-05)
 * — when each connection surface exists at all.
 *
 * There are two gates, and the second does not open the first. The plugin
 * connection path is composed only where the Agent Administration amendment
 * allows the agent boundary: `NODE_ENV=development`, and then only when this
 * deployment explicitly turns it on. The login door, where a consented token
 * reaches the native tools as `ai_operator`, composes there too and also in
 * Production, on its own explicit opt-in. Composition is the gate, not a runtime
 * branch inside a handler, so a surface is absent rather than present-and-refusing
 * when it is not wanted.
 *
 * The one runtime branch that does exist is deliberate: a request that
 * presents a connection token while the plugin path is OFF is refused outright.
 * It must not fall through to the legacy API-key resolver, because a caller
 * discovering that ArtVenn silently accepts its connection token as something
 * else is exactly the surprise this gate exists to prevent.
 */

export const CONNECTIONS_ENABLED_SETTING = "AGENT_CONNECTIONS_ENABLED";
export const OAUTH_SURFACE_SETTING = "ADMIN_MCP_OAUTH_ENABLED";

/**
 * The plugin connection path. Development AND an explicit opt-in. Both, never
 * either: a development default that switches itself on is how a Development-only
 * surface ends up somewhere else.
 */
export const connectionsEnabled = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  environment.NODE_ENV === "development" &&
  environment[CONNECTIONS_ENABLED_SETTING] === "true";

/**
 * The login door. Each environment has its own setting and neither opens the
 * other's: `AGENT_CONNECTIONS_ENABLED` does nothing in Production, and
 * `ADMIN_MCP_OAUTH_ENABLED` does nothing in Development.
 */
export const oauthSurfaceEnabled = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  connectionsEnabled(environment) ||
  (environment.NODE_ENV === "production" &&
    environment[OAUTH_SURFACE_SETTING] === "true");

/** What a consent can grant on a deployment. `management` stays unreachable. */
export type ServedPreset = Extract<ConnectionPreset, "read-only" | "operator">;

/**
 * The preset this deployment serves, by the rule the issuer's own configuration
 * reads: Production is always `operator`, and Development is `read-only` unless it
 * asks otherwise, so it means what it always meant.
 */
export const servedPreset = (
  environment: NodeJS.ProcessEnv = process.env,
): ServedPreset =>
  environment.NODE_ENV === "production" ||
  environment.AGENT_AUTHORIZATION_PROFILE === "operator"
    ? "operator"
    : "read-only";

/**
 * Why this deployment's name for itself cannot be used, or null. A connection row
 * carries that name, and it has to be admitted here and at the issuer. In Production
 * it is `production`: the issuer refuses any other name under NODE_ENV=production, so
 * the two cannot disagree and `admin.env` carries no copy of the issuer's setting.
 * Development's `operator` profile can name anything, and there the issuer compares
 * its own `AGENT_AUTHORIZATION_ENVIRONMENT` with that same column when a token
 * refreshes, so the two settings have to agree. Unset, or unequal, is a refusal by
 * name: a token from another environment never gets in on a default, and a refresh
 * never starts failing with no reason anyone can read.
 */
export const environmentRefusal = (
  environment: NodeJS.ProcessEnv,
): string | null => {
  const served = environment.CMS_ENVIRONMENT ?? "development";
  if (environment.NODE_ENV === "production")
    return served === "production"
      ? null
      : "ENVIRONMENT_DISAGREES_WITH_NODE_ENV";
  return servedPreset(environment) === "operator" &&
    environment.AGENT_AUTHORIZATION_ENVIRONMENT !== served
    ? "ENVIRONMENT_DISAGREES_WITH_ISSUER"
    : null;
};

export type OverrideAuth = (
  req: PayloadRequest,
  getDefaultMcpAccessSettings: (
    overrideApiKey?: null | string,
  ) => Promise<MCPAccessSettings>,
) => Promise<MCPAccessSettings>;

const BEARER = /^bearer[ \t]+/iu;

export const bearerOf = (req: PayloadRequest): string | null => {
  const header = req.headers.get("Authorization");
  if (header === null || !BEARER.test(header)) return null;
  const presented = header.replace(BEARER, "").trim();
  return presented === "" ? null : presented;
};

/**
 * The `overrideAuth` the plugin receives. When the plugin path is off this is
 * the legacy resolver plus one closed door; when it is on it is the full
 * connection boundary.
 */
export const connectionOverrideAuth = (
  dependencies: ConnectionAuthDependencies | null,
): OverrideAuth => {
  if (dependencies === null)
    return async (req, getDefaultMcpAccessSettings) => {
      const presented = bearerOf(req);
      if (presented !== null && isConnectionToken(presented))
        throw new UnauthorizedError();
      return getDefaultMcpAccessSettings();
    };
  return connectionAuth(dependencies);
};
