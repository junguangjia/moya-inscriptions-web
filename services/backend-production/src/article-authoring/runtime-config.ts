import {
  articleAuthorizationConfigFrom,
  articleDatabaseRoleTarget,
} from "@moya/agent-authorization";
import { wrapperKeysFrom } from "@moya/community-postgres";
import { parsePostgresConfig } from "@moya/catalog-postgres";
import type { RuntimeConfig, RuntimeEnvironment } from "@moya/backend-runtime";

/** Reuses the issuer registry without giving Backend the issuer's DB/signing credentials. */
export const articleBackendConfigurationFrom = (
  environment: RuntimeEnvironment,
  runtime: RuntimeConfig,
) => {
  if (!["development", "production"].includes(runtime.nodeEnv)) return null;
  const authorization = articleAuthorizationConfigFrom(
    {
      ...environment,
      NODE_ENV: runtime.nodeEnv,
    },
    { databaseRole: "resource" },
  );
  if (authorization === null) return null;
  const production = runtime.nodeEnv === "production";
  const resource = new URL(authorization.resource);
  if (
    resource.pathname !== "/mcp/article-authoring" ||
    (production
      ? resource.protocol !== "https:" ||
        !["127.0.0.1", "localhost", "::1", "[::1]"].includes(runtime.host)
      : resource.protocol !== "http:" ||
        Number(resource.port || "80") !== runtime.port)
  )
    throw new Error("ARTICLE_AUTHORING_RESOURCE: backend endpoint must agree");
  const roleTarget = (
    raw: string | undefined,
    key: string,
    metadata = false,
  ) => {
    if (!raw) throw new Error(`${key}: required protected configuration`);
    try {
      return articleDatabaseRoleTarget(raw, { production, metadata });
    } catch {
      throw new Error(`${key}: invalid role target`);
    }
  };
  const app = roleTarget(environment.APP_DATABASE_URL, "APP_DATABASE_URL"),
    control = roleTarget(
      environment.ARTICLE_AUTHORING_CONTROL_DATABASE_URL,
      "ARTICLE_AUTHORING_CONTROL_DATABASE_URL",
    ),
    issuer = roleTarget(
      authorization.databaseUrl,
      production
        ? "ARTICLE_AUTHORIZATION_DATABASE_TARGET"
        : "ARTICLE_AUTHORIZATION_DATABASE_URL",
      production,
    );
  if (
    new Set([app.target, control.target, issuer.target]).size !== 1 ||
    new Set([app.role, control.role, issuer.role]).size !== 3
  )
    throw new Error(
      "Article resource, control and issuer require the same database and distinct roles",
    );
  const staff = production
    ? [
        roleTarget(environment.DATABASE_URL, "DATABASE_URL"),
        roleTarget(
          environment.CMS_DATABASE_TARGET,
          "CMS_DATABASE_TARGET",
          true,
        ),
      ]
    : [environment.DATABASE_URL, environment.CMS_DATABASE_URL]
        .filter((value): value is string => value !== undefined)
        .map((raw) => roleTarget(raw, "Existing backend role"));
  if (
    staff.some(
      (value) =>
        value.target !== app.target ||
        [app.role, control.role, issuer.role].includes(value.role),
    ) ||
    new Set(staff.map((value) => value.role)).size !== staff.length
  )
    throw new Error(
      "Article roles must remain separate from Catalog/Admin roles on the same target",
    );
  const controlPostgres = parsePostgresConfig({
    DATABASE_URL: environment.ARTICLE_AUTHORING_CONTROL_DATABASE_URL,
    DATABASE_SSL_CA_FILE:
      environment.ARTICLE_AUTHORING_CONTROL_DATABASE_SSL_CA_FILE,
    DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
    DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
  });
  const keys = wrapperKeysFrom({
    NODE_ENV: runtime.nodeEnv,
    AGENT_CONNECTION_WRAPPER_INDEX_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY,
    AGENT_CONNECTION_WRAPPER_SEAL_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_SEAL_KEY,
  });
  return { authorization, controlPostgres, keys };
};
