import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  RegisteredClientError,
  createAgentConnectionStore,
  createWrapperStore,
  parseRegisteredClients,
  wrapperKeysFrom,
} from "@moya/community-postgres";

import {
  connectionsEnabled,
  environmentRefusal,
  oauthSurfaceEnabled,
  servedPreset,
} from "./composition";

import type { ConnectionAuthDependencies } from "./authorization";
import type { ConnectionRecord, VerifiedGrant } from "./contracts";
import type { RegisteredClient } from "@moya/community-postgres";

/**
 * Agent Connections V1 (Issue #141 r15 §7) — the RESOURCE server's half.
 *
 * This is the third pool and the third role, and the separation is the point:
 *
 *   provider role        mints tokens, owns the protocol's storage.
 *   consent role         records decisions, moves a connection's generation.
 *   resource role        may only READ a connection, its grant and a wrapper.
 *
 * The resource server authenticates requests and decides nothing about
 * authority. The runtime grant plan gives its role SELECT on those three
 * tables and one column of UPDATE (`last_verified_at`), so an injection on
 * this path reaches a role that cannot mint, cannot consent and cannot
 * revoke. (Named in prose rather than by filename: an Admin source file
 * carrying a direct data-file reference is itself a boundary violation, and
 * the architecture test is right to say so.)
 *
 * WHAT VERIFICATION MEANS HERE, stated exactly, because the honest boundary is
 * narrower than "the provider says yes":
 *
 *   * the presented value must resolve to a wrapper row, which requires the
 *     index key — a guessed or foreign token finds nothing;
 *   * the sealed provider identifier must OPEN, and its authenticated data
 *     binds the format version, the lookup digest, the grant, the connection
 *     and the generation. An edited grant_id, connection_id or generation
 *     fails the tag check and the row simply will not open;
 *   * the wrapper must not be expired or invalidated;
 *   * the frozen grant must exist, and every identity claim is read from IT.
 *
 * What it does NOT do, and must not be described as doing: it does not ask the
 * authorization service whether the underlying provider token still exists.
 * Those are separate processes with separate roles, and this one has no read
 * on the provider's token store by design. A disconnect reaches this boundary
 * through the generation `admitGrant` compares on each request. A revocation at
 * the provider, such as a tool revoking its own token or a detected replay,
 * reaches it when the issuer stamps the wrappers, not by lookup.
 */

export const RESOURCE_DATABASE_SETTING = "AGENT_RESOURCE_DATABASE_URL";
export const AGENT_DATABASE_CA_SETTING = "AGENT_DATABASE_SSL_CA_FILE";
/** The door's reads are single rows, so past this the database has gone silent. */
const RESOURCE_QUERY_TIMEOUT_MS = 5_000;
/** Shorter, so a read stuck on a lock ends at the server before the client gives up. */
const RESOURCE_STATEMENT_TIMEOUT_MS = 4_000;

export class ResourceRuntimeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`agent resource runtime refused: ${code}`);
    this.name = "ResourceRuntimeError";
    this.code = code;
  }
}

export interface ResourceRuntime extends ConnectionAuthDependencies {
  /**
   * The closed list, one setting read by both services, so taking a tool off it
   * and restarting stops that tool at the login door. Empty under the read-only
   * profile, whose plugin path never reads it.
   */
  readonly clients: ReadonlyMap<string, RegisteredClient>;
  close(): Promise<void>;
}

const frozen = (value: string | undefined, code: string): URL => {
  if (!value) throw new ResourceRuntimeError(code);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResourceRuntimeError(code);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ResourceRuntimeError(code);
  return url;
};

/**
 * A connect has its limit, and a database that goes silent after one would otherwise
 * hold a token request open. The shared helper takes no query timeout, so it goes
 * where pg reads one: the URL. A timed-out client leaves the pool, and its backend
 * stays while it waits on a lock, which would grow past the pool's limit, so the
 * server has a shorter limit of its own.
 */
export const withQueryTimeout = (
  config: ReturnType<typeof parsePostgresConfig>,
): ReturnType<typeof parsePostgresConfig> => {
  const url = new URL(config.connectionString);
  url.searchParams.set("query_timeout", String(RESOURCE_QUERY_TIMEOUT_MS));
  url.searchParams.set(
    "statement_timeout",
    String(RESOURCE_STATEMENT_TIMEOUT_MS),
  );
  return { ...config, connectionString: url.toString() };
};

const operatorClients = (
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<string, RegisteredClient> => {
  try {
    return parseRegisteredClients(
      environment.AGENT_AUTHORIZATION_CLIENTS ?? "",
      { allowHosted: true },
    );
  } catch (error) {
    throw new ResourceRuntimeError(
      error instanceof RegisteredClientError ? error.code : "CLIENTS_MALFORMED",
    );
  }
};

/**
 * Builds the resource-server boundary, or refuses. `null` only when the login
 * door is OFF — which is the composition gate, not a failure.
 */
export const createResourceRuntime = (
  environment: NodeJS.ProcessEnv = process.env,
): ResourceRuntime | null => {
  if (!oauthSurfaceEnabled(environment)) return null;
  const production = environment.NODE_ENV === "production";
  const operator = servedPreset(environment) === "operator";

  const databaseUrl = environment[RESOURCE_DATABASE_SETTING];
  if (!databaseUrl)
    throw new ResourceRuntimeError("RESOURCE_DATABASE_REQUIRED");
  let connectionString: URL;
  try {
    connectionString = new URL(databaseUrl);
  } catch {
    throw new ResourceRuntimeError("RESOURCE_DATABASE_MALFORMED");
  }
  // Development stays on loopback. Production's database is across a network, so
  // the fence there is verified TLS, by exact spelling: the parser below also takes
  // weaker modes for other callers, and pg reads host and TLS files from the query.
  if (production) {
    if (connectionString.search !== "?sslmode=verify-full")
      throw new ResourceRuntimeError("RESOURCE_DATABASE_TLS_REQUIRED");
    // Unset, the pool trusts only the system roots, and a private CA's database
    // would read as an outage on every token, with no setting named.
    if (!environment[AGENT_DATABASE_CA_SETTING])
      throw new ResourceRuntimeError("RESOURCE_DATABASE_CA_REQUIRED");
  } else if (
    !["127.0.0.1", "localhost", "[::1]"].includes(connectionString.hostname)
  )
    throw new ResourceRuntimeError("RESOURCE_DATABASE_NOT_LOOPBACK");

  const issuer = frozen(
    environment.AGENT_AUTHORIZATION_ISSUER,
    "ISSUER_REQUIRED",
  );
  if (issuer.pathname !== "/")
    throw new ResourceRuntimeError("ISSUER_MUST_BE_ORIGIN");
  const resource = frozen(
    environment.AGENT_AUTHORIZATION_RESOURCE,
    "RESOURCE_REQUIRED",
  );
  if (
    production &&
    (issuer.protocol !== "https:" || resource.protocol !== "https:")
  )
    throw new ResourceRuntimeError("PRODUCTION_HTTPS_REQUIRED");
  const refusedEnvironment = environmentRefusal(environment);
  if (refusedEnvironment !== null)
    throw new ResourceRuntimeError(refusedEnvironment);
  const served = environment.CMS_ENVIRONMENT ?? "development";
  const clients = operator ? operatorClients(environment) : new Map();

  // A missing key is a refusal, never a silently generated one: a new key would
  // make every previously sealed wrapper unreadable, which looks exactly like
  // every connection being revoked at once. A bare code, and nothing of the value.
  let keys: ReturnType<typeof wrapperKeysFrom>;
  try {
    keys = wrapperKeysFrom(environment);
  } catch {
    throw new ResourceRuntimeError("WRAPPER_KEY_REFUSED");
  }

  let poolConfig: ReturnType<typeof parsePostgresConfig>;
  try {
    poolConfig = parsePostgresConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: "4",
      ...(production
        ? { DATABASE_SSL_CA_FILE: environment[AGENT_DATABASE_CA_SETTING] }
        : {}),
    });
  } catch {
    throw new ResourceRuntimeError("RESOURCE_DATABASE_REFUSED");
  }
  const pool = createPostgresPool(withQueryTimeout(poolConfig));
  const connections = createAgentConnectionStore({ pool });
  const wrappers = createWrapperStore({ pool, keys });

  const verifyAccessToken = async (
    presented: string,
  ): Promise<VerifiedGrant | null> => {
    const wrapper = await wrappers.resolve(presented);
    if (wrapper === undefined) return null;
    if (wrapper.invalidatedAt !== null) return null;
    // Carried through to `admitGrant`, which checks it again against its own
    // clock. Checked here too so an expired wrapper never reaches a lookup.
    if (Date.parse(wrapper.expiresAt) <= Date.now()) return null;

    const grant = await connections.readGrant(wrapper.grantId);
    if (grant === null) return null;
    // The wrapper's own authenticated data already binds these, so a
    // disagreement here means the two rows were written apart rather than
    // edited — still a refusal, and never a reconciliation.
    if (
      grant.connectionId !== wrapper.connectionId ||
      grant.generationAtConsent !== wrapper.generation
    )
      return null;

    // Every identity claim comes from the FROZEN grant. Nothing is read from
    // the presented value, and nothing is read from the connection's mutable
    // columns — which is the r14 defect (`readForAuthorization` once let the
    // connection's current identity overwrite the grant's frozen one).
    return {
      connectionId: grant.connectionId,
      subject: grant.humanSubject,
      clientId: grant.oauthClientId,
      resource: grant.resource,
      issuer: grant.issuer,
      scopes: [...grant.capabilityScopes],
      generation: grant.generationAtConsent,
      expiresAt: wrapper.expiresAt,
    };
  };

  const readConnection = async (
    connectionId: string,
  ): Promise<ConnectionRecord | null> => {
    const stored = await connections.readForAuthorization(connectionId);
    if (stored === null) return null;
    return {
      connection: stored.connection,
      grant: stored.grant,
    } as ConnectionRecord;
  };

  return {
    clients,
    verifyAccessToken,
    readConnection,
    issuer: issuer.origin,
    resource: resource.href,
    environment: served,
    // The boundary answers one shape on the wire whatever went wrong, so an
    // operator has no way to tell a store outage from a forged signature from
    // a revoked connection unless the code is recorded HERE. Nothing was
    // recording it: `connectionAuth` has always called `recordRefusal`, and
    // the composition root never supplied one. A bare code, never a token.
    recordRefusal: (code: string) =>
      process.stderr.write(`agent-connection refused: ${code}\n`),
    // The one column this role may write, and until r15 nothing wrote it:
    // the page's "last observed authenticated request" was permanently empty
    // and the grant for it was dead. Fire-and-forget, and never before
    // admission -- an observation must not claim a request that was refused.
    recordVerified: (connectionId: string) => {
      void connections.markVerified(connectionId).catch(() => {
        process.stderr.write("agent-connection observation not recorded\n");
      });
    },
    close: () => closePostgresPool(pool),
  };
};

/**
 * One runtime per process, built lazily so importing never opens a pool. A refusal
 * is kept as well: the door asks on every request, a process's settings do not
 * change while it runs, and a junk token must not re-read a file each time.
 */
let cached: ResourceRuntime | null | undefined;
let refusal: unknown;

export const resourceRuntime = (): ResourceRuntime | null => {
  if (refusal !== undefined) throw refusal;
  if (cached === undefined) {
    try {
      cached = createResourceRuntime();
    } catch (error) {
      refusal = error;
      throw error;
    }
  }
  return cached;
};

/** Testing seam. Never called by the composition root. */
export const resetResourceRuntime = (): void => {
  cached = undefined;
  refusal = undefined;
};

/**
 * What `mcp.ts` passes to `connectionOverrideAuth`.
 *
 * `null` is the CLOSED DOOR: a request presenting a connection token is
 * refused outright rather than falling through to the API-key resolver.
 * Wiring the real boundary did not remove that door; it gave it a hinge.
 *
 * This is the plugin path's, so `connectionsEnabled` alone decides what comes
 * back, and Production always answers `null`. The login door takes its runtime
 * from `resourceRuntime`, never from here.
 *
 * A REFUSAL HERE MUST NOT TAKE DOWN THE ADMIN. This is called inside
 * `buildConfig`, during module evaluation of the Payload config, so a thrown
 * `ResourceRuntimeError` — a missing wrapper key, say — would stop editorial,
 * media, community and every legacy API-key caller from loading at all.
 * `connectionOverrideAuth(null)` could never do that, and an independent
 * review pointed out that wiring it had quietly introduced the possibility
 * while a comment still promised legacy callers were unaffected.
 *
 * So a misconfiguration fails CLOSED and LOUD rather than fatal: the
 * connection surface is absent, connection tokens are refused, everything
 * else runs, and the operator gets a bare code on stderr, on the first request
 * that loads the Payload config, not when the process starts. Silence would be
 * the wrong trade in the other direction.
 */
export const connectionAuthDependencies = (
  report: (code: string) => void = (code) =>
    process.stderr.write(`agent-connections composition refused: ${code}\n`),
): ConnectionAuthDependencies | null => {
  try {
    // Built whenever the login door is on, whichever path it serves, so a bad
    // setting is a bare code on the first request that loads the Payload config,
    // whatever that request is, and not on someone's first connect.
    const runtime = resourceRuntime();
    return connectionsEnabled() ? runtime : null;
  } catch (error) {
    report(
      error instanceof ResourceRuntimeError
        ? error.code
        : "RESOURCE_UNAVAILABLE",
    );
    return null;
  }
};
