import http from "node:http";

import { RESUME_SECRET_PARAMETER } from "@moya/community-postgres";

import { articleAuthorizationRequestAllowed } from "./article-server.js";
import { createAuthorizationProvider } from "./provider.js";
import { RESUME_PATH, resumeInteraction } from "./resume.js";
import {
  installAccessTokenRevocation,
  installAccessTokenWrapper,
} from "./wrap.js";

import type { PreparedAdminKeys } from "./admin-runtime-config.js";
import type { AuthorizationConfig } from "./config.js";
import type { ProviderBundle } from "./provider.js";
import type { Pool } from "pg";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the listener.
 *
 * Loopback only, and explicitly opted in. It binds 127.0.0.1 because this
 * service has no authorization to be reachable from a network, and binding is
 * where that is enforced rather than promised. In Production the only way in is
 * the local proxy, whose headers are checked before the provider, the resume
 * route or a cookie sees the request.
 *
 * `/healthz` answers whether the process is up and which build it is. It
 * deliberately carries NO configuration: an issuer, a resource, a client id or
 * a database name in a health response is a map of the deployment handed to
 * anything that can reach the port.
 */

export interface AuthorizationServer {
  readonly origin: string;
  readonly bundle: ProviderBundle;
  close: () => Promise<void>;
}

export interface StartOptions {
  readonly config: AuthorizationConfig;
  readonly pool: Pool;
  readonly environment: NodeJS.ProcessEnv;
  readonly preparedKeys?: PreparedAdminKeys;
  /** Build identity, so evidence can name what actually ran. */
  readonly buildId: string;
  readonly recordFailure?: (code: string) => void;
  /** Server-side diagnostics for resumes. A bare code, never a credential. */
  readonly recordResume?: (code: string) => void;
}

/**
 * Whether this grant is still the connection's current one, at the generation
 * its consent froze. A refresh token is redeemed here, not at the door, so this
 * is what makes a disconnect answer `invalid_grant` instead of minting a token
 * the door then refuses. The Article issuer's check, over the Admin's tables.
 */
const grantCurrent =
  (pool: Pool, config: AuthorizationConfig) =>
  async (grantId: string): Promise<void | false> => {
    const current = await pool.query(
      `SELECT c.id FROM community.agent_connections c
        JOIN community.agent_connection_grants g
          ON g.grant_id=c.current_grant_id AND g.connection_id=c.id
       WHERE g.grant_id=$1 AND c.status='authorized' AND c.revoked_at IS NULL
         AND c.generation=g.generation_at_consent
         AND g.issuer=$2 AND g.resource=$3 AND c.environment=$4`,
      [grantId, config.issuer, config.resource, config.environment],
    );
    if (current.rowCount === 0) return false;
    if (current.rowCount !== 1) throw new Error("GRANT_LOOKUP_INVALID");
  };

export const startAuthorizationServer = async (
  options: StartOptions,
): Promise<AuthorizationServer> => {
  const { config, pool, environment, buildId } = options;
  const production = config.environment === "production";

  const bundle = await createAuthorizationProvider({
    config,
    pool,
    environment,
    ...(options.preparedKeys === undefined
      ? {}
      : { preparedKeys: options.preparedKeys }),
    ...(options.recordFailure === undefined
      ? {}
      : { recordFailure: options.recordFailure }),
  });
  if (production) {
    bundle.provider.proxy = true;
    bundle.provider.proxyIpHeader = "X-Admin-Proxy-Peer";
    bundle.provider.maxIpsCount = 1;
  }
  installAccessTokenWrapper(bundle, {
    ...(options.recordFailure === undefined
      ? {}
      : { recordFailure: options.recordFailure }),
    // The Development read-only profile is left as #141 measured it: its
    // disconnect is enforced at the door, not at the token endpoint.
    ...(config.profile === "operator"
      ? { assertGrantCurrent: grantCurrent(pool, config) }
      : {}),
  });
  if (config.profile === "operator")
    installAccessTokenRevocation(bundle, {
      ...(options.recordFailure === undefined
        ? {}
        : { recordFailure: options.recordFailure }),
    });

  const callback = bundle.provider.callback();
  const issuer = new URL(config.issuer);
  const refuse = (response: http.ServerResponse) => {
    response.statusCode = 400;
    response.end();
  };
  const server = http.createServer((request, response) => {
    if (production) {
      if (
        !articleAuthorizationRequestAllowed(request, {
          issuer: config.issuer,
          environment: "production",
        })
      )
        return refuse(response);
      // Never let an incoming header supply the trusted peer used by Koa.
      request.headers["x-admin-proxy-peer"] = request.socket.remoteAddress;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", issuer);
    } catch {
      return refuse(response);
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      // Liveness and identity. Nothing that describes the configuration.
      response.end(JSON.stringify({ status: "ok", buildId }));
      return;
    }
    // Where the browser comes back after the Owner decided in the Admin. The
    // authority is this provider's own interaction cookie, the decision row the
    // control plane wrote and, on the operator profile, the one-time secret.
    const resume = RESUME_PATH.exec(url.pathname);
    if (resume !== null && request.method === "GET") {
      const secrets = url.searchParams.getAll(RESUME_SECRET_PARAMETER);
      void resumeInteraction(
        bundle,
        request,
        response,
        resume[1]!,
        secrets.length === 1 ? secrets[0]! : null,
      )
        .then((outcome) => {
          options.recordResume?.(outcome.code);
        })
        .catch(() => {
          // A resume that throws must not leave a socket open and must not
          // report a reason: every refusal here looks the same from outside.
          options.recordFailure?.("RESUME_FAILED");
          if (!response.headersSent) {
            response.statusCode = 500;
            response.end();
          } else response.destroy();
        });
      return;
    }
    callback(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    origin: `http://${config.host}:${config.port}`,
    bundle,
    close: () =>
      new Promise<void>((resolve) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
        deadline.unref();
        server.close(() => {
          clearTimeout(deadline);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
};
