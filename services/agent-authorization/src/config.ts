/**
 * Agent Connections V1 (Issue #141 r15 §5) — what the authorization service
 * refuses to start without.
 *
 * Every value here is read once, at startup, and validated before anything
 * listens. There are no defaults for anything that decides authority: a
 * service that invents an issuer, a resource or a sealing key would be
 * authorising against values nobody chose.
 *
 * The composition gate has two doors and each needs its own explicit opt-in:
 * Development with `AGENT_AUTHORIZATION_ENABLED`, the same shape
 * `connectionsEnabled` uses in the Admin, and Production with
 * `ADMIN_MCP_OAUTH_ENABLED` (amendment 2026-11-05). Neither setting opens the
 * other's door, because a default that switches itself on is how a surface ends
 * up somewhere nobody chose.
 *
 * Production always runs the `operator` profile. Development reads
 * `AGENT_AUTHORIZATION_PROFILE` and defaults to `read-only`, so a Development
 * deployment means what it always meant unless it asks otherwise.
 */

import { parseRegisteredClients } from "@moya/community-postgres";

import type { RegisteredClient } from "@moya/community-postgres";

export class AuthorizationConfigError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`agent authorization configuration refused: ${code} (${detail})`);
    this.name = "AuthorizationConfigError";
    this.code = code;
  }
}

export const AUTHORIZATION_ENABLED_SETTING = "AGENT_AUTHORIZATION_ENABLED";
export const OPERATOR_ENABLED_SETTING = "ADMIN_MCP_OAUTH_ENABLED";
export const AUTHORIZATION_PROFILE_SETTING = "AGENT_AUTHORIZATION_PROFILE";

/**
 * What a consent on this issuer can grant. `operator` is what an administrator
 * grants by signing in; `read-only` is the Development-only profile from #141.
 */
export type AuthorizationProfile = "read-only" | "operator";

export interface AuthorizationConfig {
  readonly profile: AuthorizationProfile;
  /** The canonical issuer. Must be an exact origin with no path. */
  readonly issuer: string;
  /** The RFC 8707 resource indicator this provider mints tokens for. */
  readonly resource: string;
  /** Where the Owner consents, on a DIFFERENT host from the issuer. */
  readonly consentBaseUrl: string;
  readonly host: string;
  readonly port: number;
  /**
   * The registered clients, read from the SAME setting the Admin reads. Two
   * registries would drift, and a drift means the Admin shows the Owner one
   * client while this provider authorizes another.
   */
  readonly clients: ReadonlyMap<string, RegisteredClient>;
  readonly environment: string;
  readonly databaseUrl: string;
}

const origin = (raw: string | undefined, name: string): URL => {
  if (raw === undefined || raw === "")
    throw new AuthorizationConfigError("REQUIRED", name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthorizationConfigError("NOT_A_URL", name);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new AuthorizationConfigError("NOT_HTTP", name);
  if (url.username !== "" || url.password !== "")
    throw new AuthorizationConfigError("USERINFO_NOT_ALLOWED", name);
  if (url.hash !== "") throw new AuthorizationConfigError("FRAGMENT", name);
  return url;
};

const required = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw === "")
    throw new AuthorizationConfigError("REQUIRED", name);
  return raw;
};

/**
 * An explicit opt-in for the environment this is. Both halves, never either.
 */
export const authorizationEnabled = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  (environment.NODE_ENV === "development" &&
    environment[AUTHORIZATION_ENABLED_SETTING] === "true") ||
  (environment.NODE_ENV === "production" &&
    environment[OPERATOR_ENABLED_SETTING] === "true");

const profileFrom = (environment: NodeJS.ProcessEnv): AuthorizationProfile => {
  if (environment.NODE_ENV === "production") return "operator";
  const raw = environment[AUTHORIZATION_PROFILE_SETTING];
  if (raw === undefined || raw === "") return "read-only";
  if (raw !== "read-only" && raw !== "operator")
    throw new AuthorizationConfigError(
      "PROFILE_UNKNOWN",
      AUTHORIZATION_PROFILE_SETTING,
    );
  return raw;
};

/**
 * The shared registry, with this service's refusals wrapped around the shared
 * parser's. The parser is the contract; the wrapping keeps one error type
 * coming out of startup so a misconfiguration reads the same whichever setting
 * caused it.
 */
const registeredClients = (
  environment: NodeJS.ProcessEnv,
  profile: AuthorizationProfile,
): ReadonlyMap<string, RegisteredClient> => {
  const raw = required(
    environment.AGENT_AUTHORIZATION_CLIENTS,
    "AGENT_AUTHORIZATION_CLIENTS",
  );
  try {
    return parseRegisteredClients(raw, { allowHosted: profile === "operator" });
  } catch (error) {
    throw new AuthorizationConfigError(
      error instanceof Error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "CLIENTS_MALFORMED",
      "AGENT_AUTHORIZATION_CLIENTS",
    );
  }
};

/**
 * The public boundary. A Production setting is read from a file a person edits,
 * so anything the URL parser would quietly tidy up is refused rather than
 * normalized: a stray `?` becomes part of the resource every token is bound to.
 */
const requireProductionUrl = (
  url: URL,
  name: string,
  raw: string | undefined,
): void => {
  if (url.protocol !== "https:")
    throw new AuthorizationConfigError("PRODUCTION_HTTPS_REQUIRED", name);
  if (raw === undefined || /[\s?#]/u.test(raw))
    throw new AuthorizationConfigError("NOT_A_PLAIN_URL", name);
};

/** Cookies are host-scoped, so sharing Article's host would share its jar. */
const refuseArticleHost = (
  issuer: URL,
  environment: NodeJS.ProcessEnv,
): void => {
  const article = environment.ARTICLE_AUTHORING_ISSUER;
  if (article === undefined || !URL.canParse(article)) return;
  if (new URL(article).hostname === issuer.hostname)
    throw new AuthorizationConfigError(
      "ISSUER_SHARES_ARTICLE_HOST",
      "AGENT_AUTHORIZATION_ISSUER",
    );
};

/** The grant says where it was issued, so that claim has to match the process. */
const refuseEnvironmentDisagreement = (
  value: string,
  production: boolean,
): void => {
  if ((value === "production") !== production)
    throw new AuthorizationConfigError(
      "ENVIRONMENT_DISAGREES_WITH_NODE_ENV",
      "AGENT_AUTHORIZATION_ENVIRONMENT",
    );
};

export const authorizationConfigFrom = (
  environment: NodeJS.ProcessEnv,
): AuthorizationConfig => {
  const production = environment.NODE_ENV === "production";
  const profile = profileFrom(environment);
  const issuer = origin(
    environment.AGENT_AUTHORIZATION_ISSUER,
    "AGENT_AUTHORIZATION_ISSUER",
  );
  // An issuer with a path is a different issuer from the one a token will
  // claim, and the mismatch surfaces only when a client refuses a token that
  // looks correct. Refusing here is cheaper than discovering it there.
  if (issuer.pathname !== "/")
    throw new AuthorizationConfigError(
      "ISSUER_MUST_BE_ORIGIN",
      "AGENT_AUTHORIZATION_ISSUER",
    );
  refuseArticleHost(issuer, environment);

  const resource = origin(
    environment.AGENT_AUTHORIZATION_RESOURCE,
    "AGENT_AUTHORIZATION_RESOURCE",
  );
  const consent = origin(
    environment.AGENT_AUTHORIZATION_CONSENT_URL,
    "AGENT_AUTHORIZATION_CONSENT_URL",
  );

  // The cookie boundary this design rests on. r12 recorded that cookies are
  // host-scoped and not port-scoped, so an issuer and a consent page sharing a
  // host would share a cookie jar however different their ports look. This is
  // the one check that makes the separation real rather than decorative.
  if (issuer.hostname === consent.hostname)
    throw new AuthorizationConfigError(
      "ISSUER_AND_CONSENT_SHARE_A_HOST",
      `${issuer.hostname}`,
    );

  if (production) {
    requireProductionUrl(
      issuer,
      "AGENT_AUTHORIZATION_ISSUER",
      environment.AGENT_AUTHORIZATION_ISSUER,
    );
    requireProductionUrl(
      resource,
      "AGENT_AUTHORIZATION_RESOURCE",
      environment.AGENT_AUTHORIZATION_RESOURCE,
    );
    requireProductionUrl(
      consent,
      "AGENT_AUTHORIZATION_CONSENT_URL",
      environment.AGENT_AUTHORIZATION_CONSENT_URL,
    );
    if (consent.pathname !== "/")
      throw new AuthorizationConfigError(
        "CONSENT_MUST_BE_ORIGIN",
        "AGENT_AUTHORIZATION_CONSENT_URL",
      );
    if (resource.pathname !== "/api/mcp")
      throw new AuthorizationConfigError(
        "RESOURCE_MUST_BE_THE_MCP_PATH",
        "AGENT_AUTHORIZATION_RESOURCE",
      );
  }

  const port = Number(
    required(environment.AGENT_AUTHORIZATION_PORT, "AGENT_AUTHORIZATION_PORT"),
  );
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new AuthorizationConfigError(
      "NOT_A_PORT",
      "AGENT_AUTHORIZATION_PORT",
    );
  // Behind a proxy in Production, so the public port and the listener are two
  // different things and being equal means something is pointed at the wrong one.
  if (production) {
    if (port === Number(issuer.port || 443))
      throw new AuthorizationConfigError(
        "LISTENER_PORT_IS_THE_PUBLIC_PORT",
        "AGENT_AUTHORIZATION_PORT",
      );
  } else if (issuer.port !== "" && Number(issuer.port) !== port)
    throw new AuthorizationConfigError(
      "ISSUER_PORT_DISAGREES_WITH_LISTENER",
      `${issuer.port} vs ${port}`,
    );

  const environmentName = required(
    environment.AGENT_AUTHORIZATION_ENVIRONMENT,
    "AGENT_AUTHORIZATION_ENVIRONMENT",
  );
  refuseEnvironmentDisagreement(environmentName, production);

  return {
    profile,
    issuer: issuer.origin,
    resource: resource.href,
    consentBaseUrl: consent.origin,
    // Loopback only. This service has no authorization to listen anywhere a
    // network can reach, and binding is where that is enforced rather than
    // assumed.
    host: "127.0.0.1",
    port,
    clients: registeredClients(environment, profile),
    environment: environmentName,
    databaseUrl: required(
      environment.AGENT_AUTHORIZATION_DATABASE_URL,
      "AGENT_AUTHORIZATION_DATABASE_URL",
    ),
  };
};
