import { parsePostgresConfig } from "@moya/catalog-postgres";
import {
  providerAdapterKeysFrom,
  wrapperKeysFrom,
} from "@moya/community-postgres";

import {
  articleDatabaseRoleTarget,
  readArticleSigningJwks,
} from "./article-runtime-config.js";

import type { AuthorizationConfig } from "./config.js";

/**
 * Issue #355, login door: what the Admin issuer checks before any pool opens, the
 * same way the Article issuer does. The Article helpers are reused rather than
 * copied, and every refusal here is the Admin's own bare category, so a log line
 * cannot send someone to the wrong service.
 *
 * Production keys are new for this issuer. None may equal another key here or any
 * Article key this process can see; the two usually run from separate
 * environment files, so the release check compares hashes on the host as well.
 */

const refused = (category: string): never => {
  throw new Error(category);
};

const KEY_SETTINGS = [
  "AGENT_CONNECTION_PROVIDER_INDEX_KEY",
  "AGENT_CONNECTION_PROVIDER_SEAL_KEY",
  "AGENT_CONNECTION_WRAPPER_INDEX_KEY",
  "AGENT_CONNECTION_WRAPPER_SEAL_KEY",
] as const;

const ARTICLE_KEY_SETTINGS = [
  "ARTICLE_AUTHORING_PROVIDER_INDEX_KEY",
  "ARTICLE_AUTHORING_PROVIDER_SEAL_KEY",
  "ARTICLE_AUTHORING_WRAPPER_INDEX_KEY",
  "ARTICLE_AUTHORING_WRAPPER_SEAL_KEY",
] as const;

/** Role metadata only: another process's password has no business in this file. */
const ROLE_TARGET_SETTINGS = [
  "AGENT_CONSENT_DATABASE_TARGET",
  "AGENT_RESOURCE_DATABASE_TARGET",
  "CMS_DATABASE_TARGET",
  "DATABASE_TARGET",
] as const;

const roleTarget = (
  raw: string | undefined,
  options: Parameters<typeof articleDatabaseRoleTarget>[1],
) => {
  try {
    return articleDatabaseRoleTarget(raw, options);
  } catch {
    return refused("ADMIN_DATABASE_ROLE_REFUSED");
  }
};

/** The issuer's own role, kept apart from every other role on the same database. */
export const adminAuthorizationPostgresFrom = (
  config: AuthorizationConfig,
  environment: NodeJS.ProcessEnv,
) => {
  if (config.environment === "production") {
    const roles = [
      roleTarget(config.databaseUrl, { production: true }),
      ...ROLE_TARGET_SETTINGS.map((name) =>
        roleTarget(environment[name], { production: true, metadata: true }),
      ),
    ];
    if (
      new Set(roles.map((value) => value.target)).size !== 1 ||
      new Set(roles.map((value) => value.role)).size !== roles.length
    )
      refused("ADMIN_DATABASE_ROLE_SEPARATION");
  }
  try {
    return parsePostgresConfig({
      DATABASE_URL: config.databaseUrl,
      DATABASE_SSL_CA_FILE:
        environment.AGENT_AUTHORIZATION_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
      DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
    });
  } catch {
    return refused("ADMIN_DATABASE_TLS_REFUSED");
  }
};

const decoded = (
  value: string | undefined,
  encoding: "base64" | "base64url",
) =>
  value === undefined || value === "" ? null : Buffer.from(value, encoding);

const refuseSharedSigningKeys = (
  jwks: ReturnType<typeof readArticleSigningJwks>,
  environment: NodeJS.ProcessEnv,
): void => {
  const file = environment.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE;
  if (file === undefined || file === "") return;
  const article = new Set(
    readArticleSigningJwks(file).keys.map((key) => key.n),
  );
  if (jwks.keys.some((key) => article.has(key.n))) throw new Error();
};

/** Every piece of issuer private material, read and judged before a pool opens. */
export const prepareAdminAuthorizationKeys = (
  config: AuthorizationConfig,
  environment: NodeJS.ProcessEnv,
) => {
  const production = config.environment === "production";
  try {
    const providerKeys = providerAdapterKeysFrom(environment);
    const wrapperKeys = wrapperKeysFrom(environment);
    const cookieKey = environment.AGENT_AUTHORIZATION_COOKIE_KEY;
    if (
      !cookieKey ||
      Buffer.byteLength(cookieKey) < 32 ||
      Buffer.byteLength(cookieKey) > 1024
    )
      throw new Error();
    const signingFile = environment.AGENT_AUTHORIZATION_SIGNING_JWKS_FILE;
    const jwks =
      production || signingFile !== undefined
        ? readArticleSigningJwks(signingFile)
        : undefined;
    if (production) {
      for (const name of KEY_SETTINGS) {
        const value = environment[name];
        if (!value || Buffer.from(value, "base64").toString("base64") !== value)
          throw new Error();
      }
      const secrets = [
        providerKeys.indexKey,
        providerKeys.sealKey,
        wrapperKeys.indexKey,
        wrapperKeys.sealKey,
      ];
      const cookieBytes = Buffer.from(cookieKey, "base64url");
      if (
        cookieBytes.length < 32 ||
        new Set(secrets.map((key) => key.toString("hex"))).size !==
          secrets.length ||
        secrets.some((key) => key.equals(cookieBytes))
      )
        throw new Error();
      const ours = [...secrets, cookieBytes];
      const articles = [
        ...ARTICLE_KEY_SETTINGS.map((name) =>
          decoded(environment[name], "base64"),
        ),
        decoded(environment.ARTICLE_AUTHORING_COOKIE_KEY, "base64url"),
      ];
      if (
        articles.some(
          (key) => key !== null && ours.some((own) => own.equals(key)),
        ) ||
        environment.ARTICLE_AUTHORING_COOKIE_KEY === cookieKey
      )
        throw new Error();
      if (jwks !== undefined) refuseSharedSigningKeys(jwks, environment);
    }
    return { providerKeys, wrapperKeys, cookieKey, jwks };
  } catch {
    return refused("ADMIN_AUTHORIZATION_KEYS_REFUSED");
  }
};

export type PreparedAdminKeys = ReturnType<
  typeof prepareAdminAuthorizationKeys
>;
