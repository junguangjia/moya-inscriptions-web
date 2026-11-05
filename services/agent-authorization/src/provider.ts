import { createRequire } from "node:module";

import {
  createAgentConnectionStore,
  createConsentStore,
  createProviderAdapter,
  createWrapperStore,
  providerAdapterKeysFrom,
  wrapperKeysFrom,
} from "@moya/community-postgres";

import { prepareAdminAuthorizationKeys } from "./admin-runtime-config.js";
import { articleResourceMatches } from "./article-provider.js";
import { plainPageHeaders, plainPageHtml } from "./plain-page.js";

import type { PreparedAdminKeys } from "./admin-runtime-config.js";
import type { AuthorizationConfig, AuthorizationProfile } from "./config.js";
import type { ConsentPreset } from "@moya/community-postgres";
import type { Pool } from "pg";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the provider, configured from
 * what r11 chose and r12 proved rather than from a fresh reading of the docs.
 *
 * Three settings here are load-bearing and each was learned the hard way, so
 * they are stated with their consequence rather than left as options:
 *
 *  - `devInteractions: { enabled: false }`. Without it the provider IGNORES
 *    `interactions.url` entirely and only warns, so consent silently goes to
 *    the quick-start screens instead of the Owner's Admin.
 *  - `prompt=consent` on the authorize request (the client's job, asserted in
 *    the tests). Without it `offline_access` does not survive consent and NO
 *    refresh token is issued — which would make the whole revocation story
 *    untestable.
 *  - The audience is on `token.aud`, NOT `token.resourceServer.audience`.
 *
 * Design B lives in `wrapAccessToken`: the provider cannot be made to emit a
 * prefixed token, so the token endpoint's successful responses are
 * post-processed and the access token replaced with an ArtVenn-minted opaque
 * value whose mapping is bound to the consent grant.
 */

export interface ProviderBundle {
  readonly provider: OidcProvider;
  readonly connections: ReturnType<typeof createAgentConnectionStore>;
  readonly wrappers: ReturnType<typeof createWrapperStore>;
  readonly consents: ReturnType<typeof createConsentStore>;
  readonly config: AuthorizationConfig;
  /** The artifact store's adapter class, for whatever sweeps it per model. */
  readonly Adapter: ReturnType<typeof createProviderAdapter>;
}

/**
 * The provider's surface this service uses. Deliberately NOT `any`: a public
 * security interface typed as unrestricted `any` is how a contract change
 * becomes a runtime surprise instead of a compile error.
 */
export interface OidcProvider {
  callback: () => (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void;
  use: (
    middleware: (
      ctx: ProviderContext,
      next: () => Promise<void>,
    ) => Promise<void>,
  ) => void;
  on: (
    event: string,
    listener: (context: unknown, value: unknown) => void,
  ) => void;
  proxy: boolean;
  proxyIpHeader: string;
  maxIpsCount: number;
  interactionDetails: (
    request: unknown,
    response: unknown,
  ) => Promise<ProviderInteraction>;
  interactionFinished: (
    request: unknown,
    response: unknown,
    result: unknown,
    options: { mergeWithLastSubmission: boolean },
  ) => Promise<void>;
  Grant: new (options: { accountId: string; clientId: string }) => {
    addOIDCScope: (scope: string) => void;
    addResourceScope: (resource: string, scope: string) => void;
    save: () => Promise<string>;
  };
  AccessToken: {
    find: (jti: string) => Promise<ProviderAccessToken | undefined>;
    revokeByGrantId?: (grantId: string) => Promise<void>;
  };
  RefreshToken: { revokeByGrantId?: (grantId: string) => Promise<void> };
}

export interface ProviderAccessToken {
  readonly jti?: string;
  readonly accountId?: string;
  readonly clientId?: string;
  readonly aud?: string;
  readonly scope?: string;
  readonly exp?: number;
  readonly grantId?: string;
}

export interface ProviderInteraction {
  readonly uid: string;
  readonly params: Record<string, string>;
}

export interface ProviderContext {
  readonly oidc?: { route?: string };
  status?: number;
  body?:
    | {
        access_token?: string;
        expires_in?: number;
        error?: "invalid_grant";
        scopes_supported?: readonly string[];
        client_id_metadata_document_supported?: boolean;
      }
    | undefined;
}

/**
 * How long a human has to decide. Short, because an abandoned tab is not a
 * standing permission, and long enough that reading the screen is not a race.
 */
export const INTERACTION_TTL_MS = 10 * 60 * 1000;

/**
 * The path both hosts share, and the reason they must.
 *
 * oidc-provider scopes its `_interaction` cookie to the PATHNAME of whatever
 * `interactions.url` returns (lib/actions/authorization/interactions.js:137,
 * `path: new URL(destination, ctx.oidc.issuer).pathname`) — on the ISSUER's
 * host, using the destination's path. So the route that resumes the
 * interaction has to live under that same pathname, or the browser never
 * sends the cookie and the resume cannot find its own interaction.
 *
 * This cost a real failure to learn: the Node-level regression passed because
 * it replayed every cookie in its jar regardless of path, and only a real
 * browser refused. The resume route is therefore a descendant of this prefix
 * on the authorization host, mirroring the Admin path the human sees.
 */
export const CONSENT_PATH_PREFIX = "/agent-connections/consent";

/** What a consent on each profile grants. Never read from the request. */
export const PROFILE_GRANTS: Readonly<
  Record<
    AuthorizationProfile,
    { readonly preset: ConsentPreset; readonly capability: string }
  >
> = {
  "read-only": { preset: "read-only", capability: "artvenn:read" },
  operator: { preset: "operator", capability: "artvenn:admin" },
};

const OPERATOR_SCOPES = [PROFILE_GRANTS.operator.capability, "offline_access"];

/**
 * Consent window. Longer than the read-only one, because the person may have to
 * find their password on the way through.
 */
const OPERATOR_INTERACTION_TTL_MS = 30 * 60 * 1000;

/**
 * Amendment 2026-11-05, decision 4, and the record's section 22. Every request
 * re-reads the connection, so revoking does not wait for an access token to run
 * out; an hour keeps a tool from refreshing on nearly every use. The refresh
 * lifetime restarts with each rotation, which makes it the idle limit, and the
 * grant's does not, which makes it the hard one.
 */
const OPERATOR_TTL = {
  AccessToken: 60 * 60,
  AuthorizationCode: 60,
  RefreshToken: 30 * 24 * 60 * 60,
  Grant: 180 * 24 * 60 * 60,
  Interaction: OPERATOR_INTERACTION_TTL_MS / 1000,
  Session: 60 * 60,
};

const OPERATOR_REFRESH_REUSE_GRACE_MS = 30_000;

interface ProviderModule {
  default: new (issuer: string, configuration: unknown) => OidcProvider;
  errors: { InvalidTarget: new (description: string) => Error };
}

/** Loaded through the workspace's own dependency, never a deep import. */
const loadProvider = async (): Promise<ProviderModule> => {
  const require_ = createRequire(import.meta.url);
  const entry = require_.resolve("oidc-provider");
  return (await import(entry)) as ProviderModule;
};

// oidc-provider normalizes an explicit empty parameter to undefined. Inspect its
// already-parsed input at the native resource hooks before applying a default.
// The same check as the Article issuer's, for the same reason.
const requestedResourceMatches = (
  context: unknown,
  configured: string,
): boolean => {
  if (context === null || typeof context !== "object") return false;
  const ctx = context as {
    method?: string;
    query?: { resource?: unknown };
    oidc?: { body?: { resource?: unknown } };
  };
  const source = ctx.method === "POST" ? ctx.oidc?.body : ctx.query;
  return articleResourceMatches(source?.resource, configured);
};

/** Only under `operator`: what makes this issuer fit to face the internet. */
const operatorConfiguration = (
  config: AuthorizationConfig,
  keys: PreparedAdminKeys,
  errors: ProviderModule["errors"],
) => ({
  ...(keys.jwks === undefined ? {} : { jwks: keys.jwks }),
  cookies: {
    keys: [keys.cookieKey],
    ...(config.environment === "production"
      ? { long: { secure: true }, short: { secure: true } }
      : {}),
  },
  clientAuthMethods: ["none"],
  responseTypes: ["code"],
  rotateRefreshToken: true,
  scopes: OPERATOR_SCOPES,
  features: {
    resourceIndicators: {
      enabled: true,
      defaultResource: (ctx: unknown, _client: unknown, resources: unknown) => {
        if (
          !requestedResourceMatches(ctx, config.resource) ||
          !articleResourceMatches(resources, config.resource)
        )
          throw new errors.InvalidTarget("resource is unavailable");
        return config.resource;
      },
      getResourceServerInfo: (ctx: unknown, resource: string) => {
        if (
          !requestedResourceMatches(ctx, config.resource) ||
          resource !== config.resource
        )
          throw new errors.InvalidTarget("resource is unavailable");
        return {
          scope: PROFILE_GRANTS.operator.capability,
          audience: config.resource,
          accessTokenTTL: OPERATOR_TTL.AccessToken,
          accessTokenFormat: "opaque",
        };
      },
      // A token request may leave `resource` out. It still means the one the
      // grant was made for, never a token with no audience.
      useGrantedResource: () => true,
    },
    revocation: { enabled: true },
    userinfo: { enabled: false },
    devInteractions: { enabled: false },
  },
  ttl: OPERATOR_TTL,
  // Consent is the only thing that builds a grant, and a connection with no way
  // to renew would ask a person to sign in again every hour.
  issueRefreshToken: async (
    _ctx: unknown,
    client: { grantTypeAllowed: (type: string) => boolean },
  ) => client.grantTypeAllowed("refresh_token"),
  expiresWithSession: async () => false,
  // The library's own error page imports a web font from a third party. This
  // one says the same in a sentence, with the code in small text. Only the code:
  // the description can repeat parts of the request.
  renderError: async (
    ctx: { set: (headers: object) => void; body: unknown },
    out: { error?: unknown },
  ) => {
    ctx.set(plainPageHeaders);
    ctx.body = plainPageHtml(
      "这次连接没有完成",
      "没有任何工具因此获得权限。请回到你的工具，重新点一次连接。",
      typeof out.error === "string" && /^[a-z_]+$/u.test(out.error)
        ? out.error
        : "server_error",
    );
  },
});

/** The Development read-only profile, exactly as #141 left it. */
const readOnlyConfiguration = (config: AuthorizationConfig) => ({
  scopes: ["artvenn:read", "artvenn:manage", "offline_access"],
  features: {
    resourceIndicators: {
      enabled: true,
      defaultResource: () => config.resource,
      getResourceServerInfo: () => ({
        scope: "artvenn:read artvenn:manage",
        audience: config.resource,
        accessTokenTTL: 300,
        accessTokenFormat: "opaque",
      }),
    },
    revocation: { enabled: true },
    // Or `interactions.url` is ignored entirely and consent never reaches
    // the Owner's Admin. The provider only warns.
    devInteractions: { enabled: false },
  },
  ttl: { AccessToken: 300, AuthorizationCode: 60, Grant: 2592000 },
  /**
   * A refresh token for a client that never asked for `offline_access`.
   *
   * WHY THIS IS NEEDED AT ALL. `oidc-provider` splices `offline_access` out
   * of the requested scope unless the authorize request carries
   * `prompt=consent` (`lib/actions/authorization/check_scope.js`), and the
   * default `issueRefreshToken` then declines because the granted scopes no
   * longer contain it. The acceptance harness sends `prompt=consent` and so
   * never saw this; a real native client does not, and MCP's authorization
   * profile does not tell it to. The measured consequence for such a client
   * is a 300-second access token and no way to renew it — a connection that
   * has to re-run a browser consent every five minutes, which is not a
   * connection.
   *
   * WHY IT IS NOT A CONSENT BYPASS. A refresh token is only ever issued
   * against a GRANT, and the only thing that builds a grant here is
   * `resume.ts`, after a human approved this exact connection in the Admin
   * and after the connection has actually reached the generation that
   * consent recorded. This changes what a client must remember to ASK for.
   * It does not change who approved, what they approved, or the fact that a
   * disconnect bumps the generation and kills the refreshed token on its
   * next request — which the acceptance harness proves, unchanged.
   *
   * Bounded to this deployment's own capability scope, so it is not a blanket
   * "always refresh": a grant that somehow carried neither `artvenn:read`
   * nor `offline_access` still gets nothing.
   */
  issueRefreshToken: async (
    _ctx: unknown,
    client: { grantTypeAllowed: (type: string) => boolean },
    source: { scopes: Set<string> },
  ) =>
    client.grantTypeAllowed("refresh_token") &&
    (source.scopes.has("offline_access") || source.scopes.has("artvenn:read")),
  /**
   * And the refresh token must outlive the provider's own session.
   *
   * `expiresWithSession` defaults to `!scopes.has('offline_access')`, so
   * issuing a refresh token above without this would have produced one that
   * dies with the browser session that created it — a renewal path that
   * works in a test and expires overnight in use. Traced in the installed
   * package rather than assumed; overriding `issueRefreshToken` alone is NOT
   * sufficient, and finding that out later would have cost a full cycle.
   */
  expiresWithSession: async (_ctx: unknown, source: { scopes: Set<string> }) =>
    !source.scopes.has("offline_access") && !source.scopes.has("artvenn:read"),
});

export const createAuthorizationProvider = async (options: {
  readonly config: AuthorizationConfig;
  readonly pool: Pool;
  readonly environment: NodeJS.ProcessEnv;
  readonly preparedKeys?: PreparedAdminKeys;
  readonly recordFailure?: (code: string) => void;
}): Promise<ProviderBundle> => {
  const { config, pool, environment } = options;
  const operator = config.profile === "operator";
  const { default: Provider, errors } = await loadProvider();

  // Keys are read before anything listens. A missing key fails startup rather
  // than silently generating a new one — which would make every previously
  // sealed row unreadable and look exactly like everyone being logged out.
  const prepared = operator
    ? (options.preparedKeys ??
      prepareAdminAuthorizationKeys(config, environment))
    : undefined;
  const providerKeys =
    prepared?.providerKeys ?? providerAdapterKeysFrom(environment);
  const wrapperKeys = prepared?.wrapperKeys ?? wrapperKeysFrom(environment);
  if (config.environment === "production" && prepared?.jwks === undefined)
    throw new Error("ADMIN_AUTHORIZATION_KEYS_REFUSED");

  const connections = createAgentConnectionStore({ pool });
  const wrappers = createWrapperStore({ pool, keys: wrapperKeys });
  const consents = createConsentStore({ pool });
  const Adapter = createProviderAdapter({
    pool,
    keys: providerKeys,
    ...(operator
      ? { refreshReuseGraceMs: OPERATOR_REFRESH_REUSE_GRACE_MS }
      : {}),
  });

  const provider = new Provider(config.issuer, {
    adapter: Adapter,
    clients: [...config.clients.values()].map((client) => ({
      client_id: client.clientId,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [...client.redirectUris],
      // Native on every entry, the hosted ones too. `native_client_prompt` is
      // what forces a consent screen on every connect (prompts/consent.js): a
      // `web` client with a live provider session and grant gets no screen, and
      // after a disconnect would skip consent into `invalid_grant`, leaving a
      // person unable to reconnect until the session ran out. Only `http:`
      // loopback ignores the port, so a hosted `https:` callback matches exactly.
      application_type: "native",
    })),
    pkce: { required: () => true, methods: ["S256"] },
    ...(prepared === undefined
      ? readOnlyConfiguration(config)
      : operatorConfiguration(config, prepared, errors)),
    findAccount: async (_ctx: unknown, id: string) => ({
      accountId: id,
      claims: async () => ({ sub: id }),
    }),
    interactions: {
      /**
       * Where the browser goes, and where this interaction becomes a row the
       * Admin can decide from.
       *
       * The target is the LANDING page, which lives outside `/admin`: on this
       * navigation the browser withholds the Owner's `SameSite=Strict`
       * session, so anything inside the admin shell would bounce a signed-in
       * Owner to a login they do not need. The landing authenticates nobody
       * and offers one same-origin step, which is the navigation the cookie
       * does survive.
       *
       * The row written here carries ONLY what this provider will enforce.
       * There is deliberately no field for who is consenting: this service
       * never authenticates a human, and it holds no privilege on the decision
       * columns, so it could not record one even if it tried.
       */
      url: async (
        _ctx: unknown,
        interaction: ProviderInteraction & {
          save: (ttlSeconds: number) => Promise<unknown>;
        },
      ) => {
        if (operator) {
          // What is granted is the profile's, whatever the client asked for.
          // The strict resource hooks have already answered a wrong target;
          // this is the last place an unlisted client could still be stopped.
          const resource: unknown = interaction.params.resource;
          if (
            !articleResourceMatches(resource, config.resource) ||
            !config.clients.has(interaction.params.client_id ?? "")
          )
            throw new Error("authorization request is unavailable");
          // And what the provider resumes with has to say so. A client asking
          // for nothing, or for nothing we grant, would otherwise reach the end
          // of the flow with "no scope was granted": told `access_denied` after
          // the person clicked allow. `openid` stays only if it was asked for.
          const asked = (interaction.params.scope ?? "").split(" ");
          interaction.params.scope = [
            ...OPERATOR_SCOPES,
            ...(asked.includes("openid") ? ["openid"] : []),
          ].join(" ");
          await interaction.save(OPERATOR_TTL.Interaction);
          await consents.open({
            interactionUid: interaction.uid,
            oauthClientId: interaction.params.client_id ?? "",
            resource: config.resource,
            capabilityScopes: [PROFILE_GRANTS.operator.capability],
            protocolScopes: ["offline_access"],
            preset: PROFILE_GRANTS.operator.preset,
            expiresAt: new Date(
              Date.now() + OPERATOR_INTERACTION_TTL_MS,
            ).toISOString(),
          });
        } else {
          const requested = (interaction.params.scope ?? "")
            .split(" ")
            .filter((scope) => scope.length > 0);
          await consents.open({
            interactionUid: interaction.uid,
            oauthClientId: interaction.params.client_id ?? "",
            resource: interaction.params.resource ?? config.resource,
            // Recorded as ASKED FOR, not as narrowed. The Admin refuses a
            // management request rather than quietly handing back a read-only
            // token the client never asked for.
            capabilityScopes: requested.filter((scope) =>
              scope.startsWith("artvenn:"),
            ),
            protocolScopes: requested.filter(
              (scope) => scope === "offline_access",
            ),
            preset: "read-only",
            expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString(),
          });
        }
        return `${config.consentBaseUrl}${CONSENT_PATH_PREFIX}/${encodeURIComponent(interaction.uid)}`;
      },
    },
  });

  if (operator) {
    // The library's discovery document lists what the provider can do, which
    // includes `openid` and leaves this out. Saying what we mean takes a post-
    // route step. The flag is true of a client id that is a URL on our closed
    // list; `features.clientIdMetadataDocument` stays off, so no document is
    // ever fetched and an unlisted URL is simply an unknown client.
    provider.use(async (ctx, next) => {
      await next();
      if (ctx.oidc?.route !== "discovery" || ctx.body === undefined) return;
      ctx.body.scopes_supported = OPERATOR_SCOPES;
      ctx.body.client_id_metadata_document_supported = true;
    });
    // A replay past the grace window revokes the grant inside the provider, and
    // live access tokens have to stop with it. `invalidateByGrant` is a one-way
    // stamp, so a failure here leaves the token until its hour runs out and the
    // connection until someone disconnects it, which is why it is recorded.
    provider.on("grant.revoked", (_context, grantId) => {
      void wrappers
        .invalidateByGrant(String(grantId), new Date())
        .catch(() => options.recordFailure?.("WRAPPER_INVALIDATION_FAILED"));
    });
    // Category-only, as Article: never a provider context, message or URL.
    provider.on("server_error", () =>
      options.recordFailure?.("OAUTH_SERVER_ERROR"),
    );
  }

  return { provider, connections, wrappers, consents, config, Adapter };
};
