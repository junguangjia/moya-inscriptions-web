import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAgentAdministrationAdapter,
  RegisteredClientError,
  createAgentConnectionStore,
  createConsentStore,
} from "@moya/community-postgres";

import { ConnectionAuthority } from "./authority";
import {
  environmentRefusal,
  oauthSurfaceEnabled,
  servedPreset,
} from "./composition";
import { parseRegisteredClients } from "./consent";
import { AGENT_DATABASE_CA_SETTING, withQueryTimeout } from "./resource";

import type { ServedPreset } from "./composition";
import type { RegisteredClient } from "./consent";

import type { PrincipalRegistry } from "./principal";

import type { ConsentStore } from "@moya/community-postgres";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the Admin's control-plane
 * composition.
 *
 * The Admin already holds a Payload pool. This is deliberately NOT that pool.
 * The control plane authenticates as its own narrowly privileged role, which
 * is the point of splitting the roles at all: the Admin's consent path may
 * record a decision and move a connection's generation, and may not mint a
 * grant, touch a token store, or create an interaction. A pool that could do
 * those would make the grant file decorative.
 *
 * A misconfiguration is a refusal with a bare code when this is first built, on
 * the first request that needs it, never a runtime branch inside a handler. The
 * Admin keeps running, and these surfaces answer that they are unavailable.
 */

export const CONSENT_DATABASE_SETTING = "AGENT_CONSENT_DATABASE_URL";
export const AUTHORIZATION_ISSUER_SETTING = "AGENT_AUTHORIZATION_ISSUER";
export const AUTHORIZATION_RESOURCE_SETTING = "AGENT_AUTHORIZATION_RESOURCE";
export const AUTHORIZATION_CLIENTS_SETTING = "AGENT_AUTHORIZATION_CLIENTS";

export class ConsentRuntimeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`consent runtime refused: ${code}`);
    this.name = "ConsentRuntimeError";
    this.code = code;
  }
}

export interface ConsentRuntime {
  readonly consents: ConsentStore;
  readonly clients: ReadonlyMap<string, RegisteredClient>;
  readonly authority: ConnectionAuthority;
  readonly connections: ReturnType<typeof createAgentConnectionStore>;
  /** What a consent here grants. Every decision and new connection takes it. */
  readonly preset: ServedPreset;
  /**
   * The machine-principal registry a read-only consent provisions into. An
   * operator connection acts as the one `ai_operator` row and provisions nothing,
   * and Production's consent role holds no grant on this table.
   *
   * Under read-only it is REQUIRED, and a consent FAILS when the control-plane
   * role cannot write it.
   * An earlier version of this comment called it optional and claimed a
   * deployment without the grant would keep today's behaviour; that was wrong
   * in two ways, and running it proved both. The adapter is always
   * constructed, so it was never actually absent — and degrading would be the
   * wrong choice anyway: it would hand back a connection that authenticates
   * and can read nothing, which is the exact defect this closes, now with a
   * success message on top. The grant in
   * The runtime grant plan is a prerequisite (named in prose rather than by
   * filename: an Admin source file carrying a direct data-file reference is
   * itself a boundary violation, and the architecture test is right to say
   * so). A deployment missing it gets a loud 500 at consent rather than a
   * quiet 403 at every later tool call.
   */
  readonly principals: PrincipalRegistry;
  /** The frozen issuer origin. Never derived from a request. */
  readonly issuer: string;
  /** The frozen resource this Admin is the resource server for. */
  readonly resource: string;
  readonly environment: string;
  close(): Promise<void>;
}

/**
 * The exact origin/URL rules, applied once at startup rather than per request.
 *
 * An issuer with a path, query or fragment is refused rather than trimmed: a
 * silently normalized issuer is how two spellings of one audience appear, and
 * the audience is the thing a token is checked against.
 */
const frozenOrigin = (value: string, code: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConsentRuntimeError(code);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new ConsentRuntimeError(code);
  return url.origin;
};

const frozenResource = (value: string, code: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConsentRuntimeError(code);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ConsentRuntimeError(code);
  return url.href;
};

/**
 * Builds the control plane, or refuses. Returns `null` only when the feature
 * is OFF, which is the composition gate — not a failure, and not something a
 * handler recovers from by doing less.
 */
export const createConsentRuntime = (
  environment: NodeJS.ProcessEnv = process.env,
): ConsentRuntime | null => {
  if (!oauthSurfaceEnabled(environment)) return null;
  const production = environment.NODE_ENV === "production";
  const preset = servedPreset(environment);

  const databaseUrl = environment[CONSENT_DATABASE_SETTING];
  if (!databaseUrl) throw new ConsentRuntimeError("CONSENT_DATABASE_REQUIRED");
  const issuer = frozenOrigin(
    environment[AUTHORIZATION_ISSUER_SETTING] ?? "",
    "ISSUER_REQUIRED",
  );
  const resource = frozenResource(
    environment[AUTHORIZATION_RESOURCE_SETTING] ?? "",
    "RESOURCE_REQUIRED",
  );
  // The issuer and the resource server are separate origins on purpose: a
  // provider sharing an origin with the Admin would share its cookie jar, and
  // the whole cross-site measurement this design rests on would be void.
  if (new URL(resource).origin === issuer)
    throw new ConsentRuntimeError("ISSUER_AND_RESOURCE_SHARE_AN_ORIGIN");

  let connectionString: URL;
  try {
    connectionString = new URL(databaseUrl);
  } catch {
    throw new ConsentRuntimeError("CONSENT_DATABASE_MALFORMED");
  }
  // Development stays on loopback. Production's database is across a network, so
  // the fence there is verified TLS, by exact spelling, as the resource side has it.
  if (production) {
    if (connectionString.search !== "?sslmode=verify-full")
      throw new ConsentRuntimeError("CONSENT_DATABASE_TLS_REQUIRED");
    if (!environment[AGENT_DATABASE_CA_SETTING])
      throw new ConsentRuntimeError("CONSENT_DATABASE_CA_REQUIRED");
    if (!issuer.startsWith("https:") || !resource.startsWith("https:"))
      throw new ConsentRuntimeError("PRODUCTION_HTTPS_REQUIRED");
  } else if (
    !["127.0.0.1", "localhost", "[::1]"].includes(connectionString.hostname)
  )
    throw new ConsentRuntimeError("CONSENT_DATABASE_NOT_LOOPBACK");

  const refusedEnvironment = environmentRefusal(environment);
  if (refusedEnvironment !== null)
    throw new ConsentRuntimeError(refusedEnvironment);

  // Only `operator` reads a hosted callback, and only because this list is closed.
  let clients: ReadonlyMap<string, RegisteredClient>;
  try {
    clients = parseRegisteredClients(
      environment[AUTHORIZATION_CLIENTS_SETTING] ?? "",
      { allowHosted: preset === "operator" },
    );
  } catch (error) {
    throw new ConsentRuntimeError(
      error instanceof RegisteredClientError ? error.code : "CLIENTS_MALFORMED",
    );
  }

  let poolConfig: ReturnType<typeof parsePostgresConfig>;
  try {
    poolConfig = parsePostgresConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: "2",
      ...(production
        ? { DATABASE_SSL_CA_FILE: environment[AGENT_DATABASE_CA_SETTING] }
        : {}),
    });
  } catch {
    throw new ConsentRuntimeError("CONSENT_DATABASE_REFUSED");
  }
  // A person waits on these statements, so a silent database has its limit here too.
  const pool = createPostgresPool(withQueryTimeout(poolConfig));
  const connections = createAgentConnectionStore({ pool });
  return {
    consents: createConsentStore({ pool }),
    clients,
    connections,
    preset,
    // The same control-plane pool, so provisioning authenticates as the
    // consent role and is bounded by the grant that role holds — not by a
    // second, wider connection opened for convenience.
    principals: new PostgresAgentAdministrationAdapter(pool),
    authority: new ConnectionAuthority({ store: connections }),
    issuer,
    resource,
    environment: environment.CMS_ENVIRONMENT ?? "development",
    close: () => closePostgresPool(pool),
  };
};

/**
 * One runtime per process. Built lazily so importing this module never opens a
 * pool, and memoized so a page render and an endpoint share one. A refusal is kept
 * as well, as the resource side keeps its own, and says its bare code once.
 */
let cached: ConsentRuntime | null | undefined;
let refusal: unknown;

export const consentRuntime = (): ConsentRuntime | null => {
  if (refusal !== undefined) throw refusal;
  if (cached === undefined) {
    try {
      cached = createConsentRuntime();
    } catch (error) {
      refusal = error;
      process.stderr.write(
        `agent-connections composition refused: ${
          error instanceof ConsentRuntimeError
            ? error.code
            : "CONSENT_UNAVAILABLE"
        }\n`,
      );
      throw error;
    }
  }
  return cached;
};

/** Testing seam. Never called by the composition root. */
export const resetConsentRuntime = (): void => {
  cached = undefined;
  refusal = undefined;
};
