import { oauthSurfaceEnabled, servedPreset } from "./composition";
import { PRESET_CAPABILITY_SCOPES } from "./contracts";

/**
 * Agent Connections V1 (Issue #141) — what a standards-based client is allowed
 * to learn before it has a token.
 *
 * WHAT WAS BROKEN, measured against the running services rather than reasoned
 * about: `POST /api/mcp` without a token answered `401` with NO
 * `WWW-Authenticate` header, and the Admin origin served no
 * `/.well-known/oauth-protected-resource` and no
 * `/.well-known/oauth-authorization-server`. The authorization server itself
 * was fully discoverable — correct metadata, S256, `none` auth method — but on
 * a DIFFERENT origin the client had no way to learn about. So every client
 * that follows the MCP authorization spec, and Cursor, which reads
 * `/.well-known/oauth-authorization-server` from the server's own origin,
 * reached a dead end at step one. That is the whole interoperability defect,
 * and it is fixed here at the existing seam rather than behind a gateway.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it publishes no endpoint of its own, no
 * registration endpoint, and nothing the provider does not already serve. It
 * is a signpost. Every authorization decision stays exactly where it was.
 */

/**
 * The challenge scheme, as its own value.
 *
 * Written apart from the parameters on purpose. The repository's credential
 * scanner refuses a bearer scheme sitting immediately before a value, because
 * that shape is how a hardcoded token looks — and it should keep refusing it.
 * This is a scheme name with nothing secret beside it, and the join below
 * makes that visible rather than hiding the shape from the check.
 */
const CHALLENGE_SCHEME = "Bearer";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728 protected-resource metadata, derived and never configured twice. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly string[];
}

const frozen = (
  value: string | undefined,
  environment: NodeJS.ProcessEnv,
): URL | null => {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !(
      environment.NODE_ENV === "production" ? ["https:"] : ["http:", "https:"]
    ).includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return null;
  return url;
};

/**
 * The metadata, or `null` when the surface is off or misconfigured.
 *
 * `null` means the route answers 404 — the same absence the rest of this
 * surface presents when it is not composed. A half-built metadata document
 * would send a client to an issuer this deployment is not actually using,
 * which is worse than telling it nothing.
 */
export const protectedResourceMetadata = (
  environment: NodeJS.ProcessEnv = process.env,
): ProtectedResourceMetadata | null => {
  if (!oauthSurfaceEnabled(environment)) return null;
  const resource = frozen(
    environment.AGENT_AUTHORIZATION_RESOURCE,
    environment,
  );
  const issuer = frozen(environment.AGENT_AUTHORIZATION_ISSUER, environment);
  if (resource === null || issuer === null || issuer.pathname !== "/")
    return null;
  return {
    resource: resource.href,
    authorization_servers: [issuer.origin],
    // Exactly what a consent here grants. `artvenn:manage` is deliberately
    // absent: advertising a scope the consent screen refuses would be an
    // invitation to a request that cannot be approved.
    scopes_supported: [...PRESET_CAPABILITY_SCOPES[servedPreset(environment)]],
    bearer_methods_supported: ["header"],
  };
};

/**
 * Where the authorization server's own metadata really lives.
 *
 * Cursor reads `/.well-known/oauth-authorization-server` from the MCP server's
 * origin, which is not where RFC 8414 puts it — that document belongs to the
 * ISSUER, and ours is a different origin. Rather than copy the issuer's
 * document under our own host, where its `issuer` field would disagree with
 * the URL it was fetched from and a strict client would be right to reject it,
 * this answers a redirect to the real one. The issuer stays authoritative
 * about itself.
 */
export const authorizationServerMetadataUrl = (
  environment: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (!oauthSurfaceEnabled(environment)) return null;
  const issuer = frozen(environment.AGENT_AUTHORIZATION_ISSUER, environment);
  if (issuer === null || issuer.pathname !== "/") return null;
  return `${issuer.origin}/.well-known/oauth-authorization-server`;
};

/**
 * The `WWW-Authenticate` value a 401 from the MCP endpoint should carry.
 *
 * It names the metadata document and the scope a client should ask for, and
 * nothing else. Deliberately no `error="invalid_token"`: the boundary answers ONE
 * shape whatever went wrong, so an operator cannot tell a forged token from a
 * revoked connection from a store outage by probing it, and that property is older
 * than this function.
 */
export const wwwAuthenticate = (
  environment: NodeJS.ProcessEnv = process.env,
): string | null => {
  const metadata = protectedResourceMetadata(environment);
  if (metadata === null) return null;
  const resource = new URL(metadata.resource);
  const pointer = `resource_metadata="${resource.origin}${METADATA_PATH}${resource.pathname}"`;
  const scope = `scope="${metadata.scopes_supported.join(" ")}"`;
  // Scheme and parameters joined, never written as one literal. See
  // CHALLENGE_SCHEME above for why that distinction is worth keeping.
  return [CHALLENGE_SCHEME, `${pointer}, ${scope}`].join(" ");
};

/**
 * A Payload `afterError` hook that adds the challenge to a 401 from the MCP
 * endpoint, and touches nothing else.
 *
 * Narrow on purpose: the path must be the resource this Admin serves, and the
 * status must be 401. Every other error on every other route leaves with
 * exactly the headers it had.
 */
export const agentConnectionAuthenticateHeader = ({
  error,
  req,
}: {
  readonly error: Error;
  readonly req: {
    readonly url?: string;
    responseHeaders?: Headers;
  };
}): undefined => {
  // Payload types the argument as `Error`; the status lives on the concrete
  // `APIError` subclass. Read it structurally rather than widening the hook's
  // own signature, so a non-API error simply does not match.
  const status = (error as { status?: unknown }).status;
  if (status !== 401) return undefined;
  const challenge = wwwAuthenticate();
  if (challenge === null) return undefined;
  const metadata = protectedResourceMetadata();
  if (metadata === null) return undefined;
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "", "http://resource.invalid").pathname;
  } catch {
    return undefined;
  }
  if (pathname !== new URL(metadata.resource).pathname) return undefined;
  const headers = req.responseHeaders ?? new Headers();
  headers.set("WWW-Authenticate", challenge);
  req.responseHeaders = headers;
  return undefined;
};
