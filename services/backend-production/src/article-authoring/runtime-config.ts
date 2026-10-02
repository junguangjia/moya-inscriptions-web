import { articleAuthorizationConfigFrom } from "@moya/agent-authorization";
import { wrapperKeysFrom } from "@moya/community-postgres";
import { parsePostgresConfig } from "@moya/catalog-postgres";
import type { RuntimeConfig, RuntimeEnvironment } from "@moya/backend-runtime";

const roleTarget = (raw: string | undefined, key: string) => {
  if (!raw) throw new Error(`${key}: required protected configuration`);
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${key}: invalid configuration`);
  }
  if (
    !["postgres:", "postgresql:"].includes(value.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) ||
    [...value.searchParams].some(
      ([key, val]) => key !== "sslmode" || val !== "disable",
    ) ||
    value.hash ||
    !value.username
  )
    throw new Error(`${key}: direct loopback role URL required`);
  return {
    target: `${value.hostname}:${value.port || "5432"}${value.pathname}`,
    role: decodeURIComponent(value.username),
  };
};
/** Reuses the issuer's parser/registry; Production reads none of these settings. */
export const articleBackendConfigurationFrom = (
  environment: RuntimeEnvironment,
  runtime: RuntimeConfig,
) => {
  if (runtime.nodeEnv !== "development") return null;
  const authorization = articleAuthorizationConfigFrom({
    ...environment,
    NODE_ENV: "development",
  });
  if (authorization === null) return null;
  const resource = new URL(authorization.resource);
  if (
    resource.protocol !== "http:" ||
    resource.pathname !== "/mcp/article-authoring" ||
    Number(resource.port || "80") !== runtime.port
  )
    throw new Error(
      "ARTICLE_AUTHORING_RESOURCE: local backend endpoint must agree",
    );
  const app = roleTarget(environment.APP_DATABASE_URL, "APP_DATABASE_URL"),
    control = roleTarget(
      environment.ARTICLE_AUTHORING_CONTROL_DATABASE_URL,
      "ARTICLE_AUTHORING_CONTROL_DATABASE_URL",
    ),
    issuer = roleTarget(
      authorization.databaseUrl,
      "ARTICLE_AUTHORIZATION_DATABASE_URL",
    );
  if (
    new Set([app.target, control.target, issuer.target]).size !== 1 ||
    new Set([app.role, control.role, issuer.role]).size !== 3
  )
    throw new Error(
      "Article resource, control and issuer require the same loopback database and distinct roles",
    );
  const staffRoles = [environment.DATABASE_URL, environment.CMS_DATABASE_URL]
    .filter((value): value is string => value !== undefined)
    .map((raw) => roleTarget(raw, "Existing backend role").role);
  if (staffRoles.some((role) => role === control.role || role === issuer.role))
    throw new Error(
      "Article control and issuer roles must remain distinct from Catalog/Admin roles",
    );
  const controlPostgres = parsePostgresConfig({
    DATABASE_URL: environment.ARTICLE_AUTHORING_CONTROL_DATABASE_URL,
    DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
    DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
  });
  const keys = wrapperKeysFrom({
    NODE_ENV: "development",
    AGENT_CONNECTION_WRAPPER_INDEX_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY,
    AGENT_CONNECTION_WRAPPER_SEAL_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_SEAL_KEY,
  });
  return { authorization, controlPostgres, keys };
};
