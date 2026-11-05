import { UnauthorizedError } from "payload";

import { admitGrant } from "./admission";
import type { AdmittedConnection } from "./admission";

import {
  ConnectionAuthError,
  isConnectionToken,
  toolGrants,
  verifiedGrantSchema,
} from "./contracts";

import type {
  AgentConnection,
  ConnectionRecord,
  VerifiedGrant,
} from "./contracts";
import type { MCPAccessSettings } from "@payloadcms/plugin-mcp";
import type { PayloadRequest, TypedUser } from "payload";

/**
 * Agent Connections V1 (Issue #141 r10) — authenticating one MCP request.
 *
 * This is the seam where a browser-consented connection becomes a restricted
 * principal. It runs on EVERY protected request, not only on initialize:
 * `resolveAccessSettings` is called per request by the plugin, so a token
 * revoked a second ago is refused on the next tool call rather than at the
 * next handshake.
 *
 * Four rules hold here and are each covered by a regression:
 *
 *  1. A credential that claims to be ours succeeds on its own terms or is
 *     refused. It never falls back to the legacy API-key resolver, to an
 *     Owner session cookie, or to anonymous access.
 *  2. Every binding on the token is checked against the connection: the
 *     consenting human (`subject`), the exact registered OAuth client, the
 *     issuer, the resource, the environment and the scope set. A valid
 *     signature is not an authorization.
 *  3. What a connection may CALL is derived from its preset, never from the
 *     token's scope claim — the claim must equal the preset's canonical set,
 *     and the preset then decides the tools. A token can neither widen its
 *     connection nor silently narrow it.
 *  4. The connection's `generation` must match the token's. That is what
 *     makes disconnect effective against an unexpired token and a live
 *     session, without depending on a clock.
 */

/** Verifies the presented token's signature/format and returns its claims. */
export type AccessTokenVerifier = (
  presented: string,
) => Promise<VerifiedGrant | null>;

/**
 * Reads the current connection record together with its frozen consent
 * snapshot. Returns null when the connection does not exist.
 *
 * The record it returns is TRUSTED in the sense that it comes from ArtVenn's
 * own store rather than from a caller-supplied token — but "trusted" now
 * means "already parsed", not "unparsed". r14's PostgreSQL store parses every
 * row totally at the store boundary and refuses one that does not fit, which
 * is what the earlier version of this comment asked the persistence
 * implementer to do.
 */
export type ConnectionReader = (
  connectionId: string,
) => Promise<ConnectionRecord | null>;

export interface ConnectionAuthDependencies {
  readonly verifyAccessToken: AccessTokenVerifier;
  readonly readConnection: ConnectionReader;
  /** The issuer this deployment trusts. A token from any other is refused. */
  readonly issuer: string;
  /** The RFC 8707 resource this endpoint is. Audience binding, not decoration. */
  readonly resource: string;
  /** Which ArtVenn environment this endpoint serves. */
  readonly environment: string;
  /** Server-side refusal diagnostics. Receives a bare code, never a token. */
  readonly recordRefusal?: (code: string) => void;
  /**
   * Records that a request ACTUALLY authenticated, after admission and never
   * before it. The `AI 连接` page shows this as an observation, so stamping a
   * request that was then refused would make the page say something untrue.
   *
   * Fire-and-forget by contract: a failure to record must not refuse a valid
   * request. Until r15 nothing supplied this and nothing wrote the column, so
   * the page's "last observed" row was permanently empty — an independent
   * review found the grant for it was dead too.
   */
  readonly recordVerified?: (connectionId: string) => void;
}

const BEARER = /^bearer[ \t]+/iu;

const bearerOf = (req: PayloadRequest): string | null => {
  const header = req.headers.get("Authorization");
  if (header === null || !BEARER.test(header)) return null;
  const presented = header.replace(BEARER, "").trim();
  return presented === "" ? null : presented;
};

/**
 * The identity the existing tools already understand. `agentPrincipalOf`
 * reads `agentPrincipal` off `req.user`, so a connection reuses the whole
 * Backend path — scopes, approvals, delegations, fencing, receipts — with no
 * second copy of the business rules and no new trust in the adapter.
 */
const connectionUser = (connection: AgentConnection): TypedUser =>
  ({
    id: connection.id,
    collection: "users",
    _strategy: "artvenn-connection",
    agentPrincipal: connection.principalLabel,
    // Deliberately NOT "owner": a connection is never a human Owner, whatever
    // the human who consented to it can do in the Admin.
    role: "agent-connection",
  }) as unknown as TypedUser;

/**
 * The rule both paths apply to a presented token: it resolves, its claims parse,
 * and the connection admits it. Throws on any refusal, a `ConnectionAuthError` with
 * a bare code or whatever the store threw. What a refusal looks like on the wire,
 * and recording that a request authenticated, are each caller's own.
 */
export const verifyConnection = async (
  dependencies: ConnectionAuthDependencies,
  presented: string,
): Promise<AdmittedConnection> => {
  const verified = await dependencies.verifyAccessToken(presented);
  if (verified === null)
    throw new ConnectionAuthError("CONNECTION_TOKEN_INVALID");
  // The verifier's return is untrusted data: its fields come from a token a caller
  // supplied, and the TypeScript type is erased at runtime. Parse it rather than
  // assume it, so a malformed claim is a refusal here instead of a surprise inside
  // a comparison.
  const parsed = verifiedGrantSchema.safeParse(verified);
  if (!parsed.success)
    throw new ConnectionAuthError("CONNECTION_GRANT_MALFORMED");
  const grant = parsed.data;
  return admitGrant(
    grant,
    await dependencies.readConnection(grant.connectionId),
    {
      issuer: dependencies.issuer,
      resource: dependencies.resource,
      environment: dependencies.environment,
    },
  );
};

/**
 * Builds the plugin's `overrideAuth`. Legacy API-key callers are untouched:
 * a request with no bearer, or a bearer that is not one of ours, goes to the
 * plugin's own resolver exactly as before.
 */
export const connectionAuth =
  (dependencies: ConnectionAuthDependencies) =>
  async (
    req: PayloadRequest,
    getDefaultMcpAccessSettings: (
      overrideApiKey?: null | string,
    ) => Promise<MCPAccessSettings>,
  ): Promise<MCPAccessSettings> => {
    const presented = bearerOf(req);
    // Not ours: the legacy editorial and Agent Administration API-key path is
    // preserved verbatim, including its own refusals.
    if (presented === null || !isConnectionToken(presented))
      return getDefaultMcpAccessSettings();

    // From here the caller has claimed to be an ArtVenn connection. There is
    // no path back to the legacy resolver, so a forged or expired connection
    // token cannot be retried as an API key.
    try {
      const { connection, consent } = await verifyConnection(
        dependencies,
        presented,
      );
      // Admission succeeded, so this request really did authenticate. After
      // the decision, never before it.
      try {
        dependencies.recordVerified?.(connection.id);
      } catch {
        // An observation that throws must not refuse an admitted request.
      }
      return {
        user: connectionUser(connection),
        // Nothing but the agent tools. Collections, globals, config, jobs and
        // the auth tools stay off for a connection, whatever the plugin's
        // defaults become in a later version.
        collections: {
          create: false,
          delete: false,
          find: false,
          update: false,
        },
        globals: { find: false, update: false },
        config: { find: false, update: false },
        jobs: { create: false, run: false, update: false },
        auth: {
          auth: false,
          forgotPassword: false,
          login: false,
          resetPassword: false,
          unlock: false,
          verify: false,
        },
        "payload-mcp-tool": toolGrants(consent.presetAtConsent),
      } satisfies MCPAccessSettings;
    } catch (error) {
      // One shape out, whatever went wrong, so a probe cannot tell a bad
      // signature from a revoked connection by watching the response. The
      // specific code is recorded server-side — a store outage, a forged
      // signature and a revoked connection must be distinguishable to the
      // operator even though they are identical on the wire. Never the token.
      try {
        dependencies.recordRefusal?.(
          error instanceof ConnectionAuthError
            ? error.code
            : "CONNECTION_ERROR",
        );
      } catch {
        // A diagnostics sink that throws must not replace the refusal with its
        // own error — that is exactly the probe-distinguishable outcome the
        // single external shape exists to prevent.
      }
      throw new UnauthorizedError();
    }
  };
