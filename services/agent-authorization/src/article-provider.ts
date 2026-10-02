import { createRequire } from "node:module";
import {
  createProviderAdapter,
  createWrapperStore,
  parseRegisteredClients,
  providerAdapterKeysFrom,
  wrapperKeysFrom,
  createArticleConsentStore,
  assertArticleScopes,
} from "@moya/community-postgres";
import { installAccessTokenWrapper, providerGrantLifecycle } from "./wrap.js";
import type { OidcProvider, ProviderInteraction } from "./provider.js";
import type { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Same maintained oidc-provider and encrypted store implementation, with a
 * separate issuer/resource, protocol store, keys and public-user consent UI.
 * No admin presets are extended and no public user becomes a Payload user.
 */
export interface ArticleAuthorizationConfig {
  readonly issuer: string;
  readonly resource: string;
  readonly consentBaseUrl: string;
  readonly environment: "development";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly databaseUrl: string;
  readonly clients: ReturnType<typeof parseRegisteredClients>;
}

const origin = (raw: string | undefined, key: string): URL => {
  if (raw === undefined) throw new Error(`${key}: required`);
  const value = new URL(raw);
  if (
    !["http:", "https:"].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.hash ||
    value.search
  )
    throw new Error(`${key}: invalid URL`);
  // This task has authority for local loopback connectivity only.
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) &&
    !value.hostname.endsWith(".localhost")
  )
    throw new Error(`${key}: loopback required`);
  return value;
};
export const articleAuthorizationConfigFrom = (
  environment: NodeJS.ProcessEnv,
): ArticleAuthorizationConfig | null => {
  if (
    environment.NODE_ENV !== "development" ||
    environment.ARTICLE_AUTHORING_ENABLED !== "true"
  )
    return null;
  const issuer = origin(
    environment.ARTICLE_AUTHORING_ISSUER,
    "ARTICLE_AUTHORING_ISSUER",
  );
  const resource = origin(
    environment.ARTICLE_AUTHORING_RESOURCE,
    "ARTICLE_AUTHORING_RESOURCE",
  );
  const consent = origin(
    environment.ARTICLE_AUTHORING_CONSENT_ORIGIN,
    "ARTICLE_AUTHORING_CONSENT_ORIGIN",
  );
  if (
    issuer.pathname !== "/" ||
    consent.pathname !== "/" ||
    issuer.hostname === consent.hostname
  )
    throw new Error(
      "Article issuer must have a separate cookie host from human consent",
    );
  const port = Number(environment.ARTICLE_AUTHORIZATION_PORT);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    Number(issuer.port || (issuer.protocol === "https:" ? 443 : 80)) !== port
  )
    throw new Error(
      "ARTICLE_AUTHORIZATION_PORT: explicit issuer/listener port must agree",
    );
  if (issuer.protocol !== "http:")
    throw new Error("Local Article issuer listener requires http");
  const databaseUrl = environment.ARTICLE_AUTHORIZATION_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "")
    throw new Error(
      "ARTICLE_AUTHORIZATION_DATABASE_URL: required protected issuer-role configuration",
    );
  if (
    environment.AGENT_AUTHORIZATION_ENABLED === "true" &&
    environment.AGENT_AUTHORIZATION_ISSUER !== undefined &&
    new URL(environment.AGENT_AUTHORIZATION_ISSUER).hostname === issuer.hostname
  )
    throw new Error(
      "Article issuer must have a separate cookie host from Admin issuer",
    );
  return {
    issuer: issuer.origin,
    resource: resource.href,
    consentBaseUrl: consent.origin,
    host: "127.0.0.1",
    port,
    databaseUrl,
    environment: "development",
    clients: parseRegisteredClients(
      environment.ARTICLE_AUTHORING_CLIENTS ?? "",
    ),
  };
};

export const ARTICLE_CONSENT_PREFIX = "/article-authoring/consent";
export const ARTICLE_RESUME_PATH =
  /^\/article-authoring\/consent\/([A-Za-z0-9_-]{1,256})\/resume$/u;

export const createArticleAuthorizationProvider = async (options: {
  readonly config: ArticleAuthorizationConfig;
  readonly pool: Pool;
  readonly environment: NodeJS.ProcessEnv;
  readonly recordFailure?: (code: string) => void;
}) => {
  const { config, pool, environment } = options;
  const require_ = createRequire(import.meta.url);
  const loaded = (await import(require_.resolve("oidc-provider"))) as {
    default: new (
      issuer: string,
      configuration: unknown,
    ) => OidcProvider & {
      on(
        event: string,
        listener: (context: unknown, error: unknown) => void,
      ): void;
    };
  };
  // Reuse existing key validation. Explicit separate configured inputs; there
  // is no fallback to long-term Admin keys and no generated startup default.
  const providerKeys = providerAdapterKeysFrom({
    NODE_ENV: environment.NODE_ENV,
    AGENT_CONNECTION_PROVIDER_INDEX_KEY:
      environment.ARTICLE_AUTHORING_PROVIDER_INDEX_KEY,
    AGENT_CONNECTION_PROVIDER_SEAL_KEY:
      environment.ARTICLE_AUTHORING_PROVIDER_SEAL_KEY,
  });
  const wrapperKeys = wrapperKeysFrom({
    NODE_ENV: environment.NODE_ENV,
    AGENT_CONNECTION_WRAPPER_INDEX_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY,
    AGENT_CONNECTION_WRAPPER_SEAL_KEY:
      environment.ARTICLE_AUTHORING_WRAPPER_SEAL_KEY,
  });
  const consents = createArticleConsentStore(pool, config);
  const wrappers = createWrapperStore({
    pool,
    keys: wrapperKeys,
    namespace: "article-authoring",
  });
  const cookieKey = environment.ARTICLE_AUTHORING_COOKIE_KEY;
  if (
    cookieKey === undefined ||
    new TextEncoder().encode(cookieKey).byteLength < 32
  )
    throw new Error(
      "ARTICLE_AUTHORING_COOKIE_KEY: required server signing key",
    );
  const provider = new loaded.default(config.issuer, {
    adapter: createProviderAdapter({
      pool,
      keys: providerKeys,
      namespace: "article-authoring",
    }),
    clients: [...config.clients.values()].map((client) => ({
      client_id: client.clientId,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [...client.redirectUris],
      application_type: "native",
    })),
    pkce: { required: () => true, methods: ["S256"] },
    cookies: { keys: [cookieKey] },
    rotateRefreshToken: true,
    scopes: [
      "artvenn:article:draft",
      "artvenn:article:publish",
      "offline_access",
    ],
    features: {
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        getResourceServerInfo: (_ctx: unknown, resource: string) => {
          if (resource !== config.resource)
            throw new Error("Article audience is unavailable");
          return {
            scope: "artvenn:article:draft artvenn:article:publish",
            audience: config.resource,
            accessTokenTTL: 300,
            accessTokenFormat: "opaque",
          };
        },
      },
      revocation: { enabled: true },
      devInteractions: { enabled: false },
    },
    ttl: { AccessToken: 300, AuthorizationCode: 60, Grant: 2592000 },
    issueRefreshToken: async (
      _ctx: unknown,
      client: { grantTypeAllowed(type: string): boolean },
      source: { scopes: Set<string> },
    ) =>
      client.grantTypeAllowed("refresh_token") &&
      source.scopes.has("artvenn:article:draft"),
    expiresWithSession: async (
      _ctx: unknown,
      source: { scopes: Set<string> },
    ) => !source.scopes.has("artvenn:article:draft"),
    findAccount: async (_ctx: unknown, id: string) => ({
      accountId: id,
      claims: async () => ({ sub: id }),
    }),
    interactions: {
      url: async (_ctx: unknown, interaction: ProviderInteraction) => {
        const raw = (interaction.params.scope ?? "").split(" ").filter(Boolean);
        if (
          raw.some(
            (scope) =>
              scope !== "offline_access" &&
              !scope.startsWith("artvenn:article:"),
          )
        )
          throw new Error("Article scope is unavailable");
        const scopes = assertArticleScopes(
          raw.filter((scope) => scope !== "offline_access"),
        );
        const resource = interaction.params.resource ?? config.resource;
        if (
          resource !== config.resource ||
          !config.clients.has(interaction.params.client_id ?? "")
        )
          throw new Error("Article authorization request is unavailable");
        try {
          await consents.open({
            interactionUid: interaction.uid,
            clientId: interaction.params.client_id!,
            scopes,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
        } catch (error) {
          recordCategory("ARTICLE_CONSENT_OPEN", error);
          throw error;
        }
        return `${config.consentBaseUrl}${ARTICLE_CONSENT_PREFIX}/${encodeURIComponent(interaction.uid)}`;
      },
    },
  });
  // Category-only diagnostics: never serialize provider context, messages,
  // authorization URLs, cookies, queries, credentials or protocol artifacts.
  function recordCategory(operation: string, error: unknown): void {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const sqlState =
      typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)
        ? code
        : "unclassified";
    options.recordFailure?.(`${operation}_${sqlState}`);
  }
  provider.on("server_error", (_context, error) =>
    recordCategory("ARTICLE_OAUTH_SERVER", error),
  );
  provider.on("authorization.error", (_context, error) =>
    recordCategory("ARTICLE_OAUTH_AUTHORIZATION", error),
  );
  installAccessTokenWrapper(
    { provider, wrappers },
    {
      ...(options.recordFailure === undefined
        ? {}
        : { recordFailure: options.recordFailure }),
      assertGrantCurrent: async (grantId) => {
        const current = await pool.query(
          `SELECT c.id FROM community.article_authoring_connections c
        JOIN community.article_authoring_grants g ON g.grant_id=c.current_grant_id
        JOIN community.public_users u ON u.id=c.owner_id
        WHERE g.grant_id=$1 AND c.status='authorized' AND c.revoked_at IS NULL
          AND c.generation=g.generation AND u.status='active' AND g.issuer=$2 AND g.resource=$3`,
          [grantId, config.issuer, config.resource],
        );
        if (current.rowCount !== 1)
          throw new Error("ARTICLE_GRANT_NO_LONGER_CURRENT");
      },
    },
  );
  const lifecycle = providerGrantLifecycle(provider);

  const resume = async (
    request: IncomingMessage,
    response: ServerResponse,
    uid: string,
  ): Promise<void> => {
    const deny = () =>
      provider.interactionFinished(
        request,
        response,
        {
          error: "access_denied",
          error_description: "consent was not granted",
        },
        { mergeWithLastSubmission: false },
      );
    let interaction: ProviderInteraction;
    try {
      interaction = await provider.interactionDetails(request, response);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const consent = await consents.read(uid);
    if (
      interaction.uid !== uid ||
      consent === null ||
      consent.decision !== "approved" ||
      consent.ownerId === null ||
      consent.generation === null ||
      consent.connectionId === null ||
      consent.resumedAt !== null ||
      Date.parse(consent.expiresAt) <= Date.now() ||
      consent.clientId !== interaction.params.client_id ||
      consent.resource !== config.resource
    ) {
      await deny();
      return;
    }
    const requestScopes = assertArticleScopes(
      (interaction.params.scope ?? "")
        .split(" ")
        .filter((scope) => scope && scope !== "offline_access"),
    );
    if (requestScopes.join(" ") !== [...consent.scopes].sort().join(" ")) {
      await deny();
      return;
    }
    const grant = new provider.Grant({
      accountId: consent.ownerId,
      clientId: consent.clientId,
    });
    for (const scope of consent.scopes) {
      grant.addOIDCScope(scope);
      grant.addResourceScope(config.resource, scope);
    }
    if ((interaction.params.scope ?? "").split(" ").includes("offline_access"))
      grant.addOIDCScope("offline_access");
    const grantId = await grant.save();
    try {
      await consents.finalizeGrant(uid, grantId, new Date());
    } catch {
      await lifecycle.revokeIssued(grantId).catch(() => undefined);
      await lifecycle.destroyGrant(grantId).catch(() => undefined);
      await deny();
      return;
    }
    await provider.interactionFinished(
      request,
      response,
      { login: { accountId: consent.ownerId }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
  };
  return { provider, wrappers, consents, config, resume };
};
