import { randomUUID } from "node:crypto";

import { z } from "zod";

import { writeAuditEvent } from "../admin-mcp/audit";
import { isHumanOwner } from "../editorial/access";
import {
  ConsentError,
  consentDecisionSchema,
  interactionUidSchema,
} from "./consent";
import { decideConsent } from "./decide";
import { resolveConnection } from "./resolve";
import { connectionsEnabled, oauthSurfaceEnabled } from "./composition";
import { oauthClientIdSchema } from "./contracts";
import { consentRuntime } from "./runtime";

import type { ConsentRuntime } from "./runtime";
import type { Endpoint, PayloadRequest } from "payload";

/**
 * Agent Connections V1 (Issue #141 r15 §5, §7) and the login door (amendment
 * 2026-11-05) — the control plane, reserved to an Owner browser session.
 *
 * These endpoints exist only where the login door is on: Development on an explicit
 * opt-in, and Production on its own. The gate is the ARRAY being empty, not a branch
 * inside a handler, so the surface is absent rather than present-and-refusing where
 * it is not wanted.
 *
 * Nothing here trusts the request for authority. The acting human is the
 * Payload session; the client, resource and scopes are the row the PROVIDER
 * wrote; the issuer is frozen configuration. No request field names an actor,
 * an audience or a return URL.
 */

const readJson = async (req: PayloadRequest): Promise<unknown> => {
  if (!req.json) throw new ConsentError("JSON_BODY_REQUIRED");
  try {
    return await req.json();
  } catch {
    throw new ConsentError("JSON_BODY_REQUIRED");
  }
};

const parse = <Output>(
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: Output };
  },
  input: unknown,
): Output => {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined)
    throw new ConsentError("REQUEST_MALFORMED");
  return result.data;
};

/**
 * An Owner browser session and nothing else. Automation, an AI identity, a key, a
 * connection token and an Owner token in a header all stop here, because approving
 * or disconnecting a connection is one of the things a connection may never do.
 */
const requireHumanOwner = (req: PayloadRequest): string => {
  if (!isHumanOwner(req)) throw new ConsentError("OWNER_ONLY", 403);
  const id = req.user?.id;
  if (typeof id !== "string" && typeof id !== "number")
    throw new ConsentError("OWNER_ONLY", 403);
  return `payload-user-${String(id)}`;
};

/**
 * The second net on a change, as on the control page's renewal: the session cookie
 * is SameSite=Strict, and Next may normalize req.url to its internal HTTP origin
 * behind Nginx. A browser sends no Origin on a same-origin GET, so a read has no net.
 */
const requireSameOrigin = (req: PayloadRequest): void => {
  const publicUrl = process.env.CMS_PUBLIC_URL ?? req.url;
  if (!publicUrl || req.headers.get("origin") !== new URL(publicUrl).origin)
    throw new ConsentError("ORIGIN_REQUIRED", 403);
};

const failure = (error: unknown): Response => {
  const consent =
    error instanceof ConsentError
      ? error
      : new ConsentError("CONSENT_UNAVAILABLE", 500);
  return Response.json(
    { ok: false, error: consent.code },
    { status: consent.status, headers: { "Cache-Control": "no-store" } },
  );
};

const ok = (result: unknown): Response =>
  Response.json(
    { ok: true, result },
    { headers: { "Cache-Control": "no-store" } },
  );

const runtimeOrRefuse = (): ConsentRuntime => {
  const runtime = consentRuntime();
  if (runtime === null) throw new ConsentError("NOT_FOUND", 404);
  return runtime;
};

/**
 * A reserved change, with its audit rows around it. The first row comes before the
 * change: if it cannot be written, the change does not happen. It names the person
 * acting. The second says how it ended, a refused ticket included. If only that one
 * is lost, the ledger reads as it does for any call, a start with no finish being an
 * unknown outcome, and the change stands.
 */
const withReservedAudit = async <Result>(
  req: PayloadRequest,
  action: "approve" | "deny" | "disconnect",
  target: {
    readonly id: string;
    readonly connectionId: string | null;
    readonly tool: string | undefined;
  },
  change: () => Promise<Result>,
): Promise<Result> => {
  const row = {
    callId: randomUUID(),
    class: "reserved",
    op: `agent-connections.${action}`,
    targetType: "agent-connections",
    targetId: target.id,
    userId: String(req.user?.id),
    ...(target.connectionId === null
      ? {}
      : { connectionId: target.connectionId }),
    ...(target.tool === undefined ? {} : { keyLabel: target.tool }),
  } as const;
  await writeAuditEvent(req.payload, { ...row, phase: "start" });
  const finish = async (succeeded: boolean, code: string) => {
    try {
      await writeAuditEvent(req.payload, {
        ...row,
        phase: "finish",
        ok: succeeded,
        code,
      });
    } catch {
      req.payload.logger.error({ category: "AGENT_CONNECTION_AUDIT_FAILED" });
    }
  };
  try {
    const result = await change();
    await finish(true, "OK");
    return result;
  } catch (error) {
    await finish(
      false,
      error instanceof ConsentError ? error.code : "CONSENT_UNAVAILABLE",
    );
    throw error;
  }
};

const decideEndpoint: Endpoint = {
  path: "/agent-connections/consent",
  method: "post",
  handler: async (req) => {
    try {
      const humanAccountId = requireHumanOwner(req);
      requireSameOrigin(req);
      const runtime = runtimeOrRefuse();
      const body = parse(consentDecisionSchema, await readJson(req));
      // A uid nobody opened is no attempt on anything, so it leaves no row.
      const consent = await runtime.consents.read(body.interaction);
      if (consent === null) throw new ConsentError("CONSENT_NOT_DECIDABLE");
      const decided = await withReservedAudit(
        req,
        body.decision,
        {
          id: body.interaction,
          connectionId: consent.connectionId,
          tool: runtime.clients.get(consent.oauthClientId)?.label,
        },
        () => decideConsent(runtime, humanAccountId, body),
      );
      return ok(decided);
    } catch (error) {
      return failure(error);
    }
  },
};

/**
 * The read-only page's data. Observations only: what the database recorded,
 * never a liveness claim. There is no "online" here because nothing observes one.
 */
const readOnlyList = async (
  runtime: ConsentRuntime,
  humanAccountId: string,
): Promise<unknown> => {
  const connections = await runtime.connections.listForHuman(humanAccountId);
  return {
    // Narrowed on purpose. The registry entry also carries the callback
    // policy and the redirect URIs, and the page has no use for either;
    // shipping deployment configuration to a browser because it happened
    // to be in the same object is how it ends up somewhere else.
    clients: [...runtime.clients.values()].map((client) => ({
      clientId: client.clientId,
      family: client.family,
      label: client.label,
    })),
    // What this deployment IS, so the page can say so rather than let a
    // reader assume which environment they are looking at.
    environment: runtime.environment,
    issuer: runtime.issuer,
    resource: runtime.resource,
    // One method exists in this milestone. Named rather than implied.
    authMethod: "oauth-browser-consent",
    connections: connections.map((entry) => ({
      id: entry.connection.id,
      client: entry.connection.client,
      // The EXACT identity this connection acts as: the registered OAuth
      // client the Owner approved, and the machine principal the Backend
      // authorizes. Shown because "which connection is this" must be
      // answerable without a database.
      principalLabel: entry.connection.principalLabel,
      clientLabel:
        runtime.clients.get(entry.connection.oauthClientId)?.label ?? null,
      oauthClientId: entry.connection.oauthClientId,
      environment: entry.connection.environment,
      preset: entry.connection.preset,
      status: entry.connection.status,
      generation: entry.connection.generation,
      consentedAt: entry.connection.consentedAt,
      revokedAt: entry.connection.revokedAt,
      // An observation of the last request that actually authenticated.
      // Null means none has been seen, not that anything is offline.
      lastVerifiedAt: entry.lastVerifiedAt,
      hasCurrentGrant: entry.currentGrantId !== null,
    })),
  };
};

/**
 * The login door's page data: every live connection, whoever authorized it, because
 * any owner may see and disconnect any of them. The person is matched by the same
 * stamp the consent wrote, and an account gone from `users` reads as nobody rather
 * than hiding a connection someone still has to be able to stop.
 */
const operatorList = async (
  req: PayloadRequest,
  runtime: ConsentRuntime,
  humanAccountId: string,
): Promise<unknown> => {
  const connections = await runtime.connections.listAuthorized();
  const { docs: accounts } = await req.payload.find({
    collection: "users",
    req,
    overrideAccess: false,
    depth: 0,
    limit: 0,
    pagination: false,
    select: { email: true },
  });
  const emails = new Map(
    accounts.map(({ id, email }) => [`payload-user-${String(id)}`, email]),
  );
  return {
    preset: runtime.preset,
    resource: runtime.resource,
    clients: [...runtime.clients.values()].map(({ family, label }) => ({
      family,
      label,
    })),
    connections: connections.map(({ connection, lastVerifiedAt }) => ({
      id: connection.id,
      family: connection.client,
      // Null for a tool that has left the list, which an owner can still stop.
      tool: runtime.clients.get(connection.oauthClientId)?.label ?? null,
      authorizedBy: emails.get(connection.humanAccountId) ?? null,
      mine: connection.humanAccountId === humanAccountId,
      consentedAt: connection.consentedAt,
      // An observation of the last request that authenticated, never a liveness
      // claim. Null means none has been seen.
      lastVerifiedAt,
    })),
  };
};

const listEndpoint: Endpoint = {
  path: "/agent-connections",
  method: "get",
  handler: async (req) => {
    try {
      const humanAccountId = requireHumanOwner(req);
      const runtime = runtimeOrRefuse();
      return ok(
        runtime.preset === "operator"
          ? await operatorList(req, runtime, humanAccountId)
          : await readOnlyList(runtime, humanAccountId),
      );
    } catch (error) {
      return failure(error);
    }
  },
};

const startSchema = z.object({ clientId: oauthClientIdSchema }).strict();

/**
 * Starts a connection. It grants nothing: a new record is
 * `awaiting-consent` at generation 0, and stays there until a human approves
 * in a browser. This exists so the Owner can see what they are about to
 * connect before a client ever asks. The Development page's alone: a tool starts
 * a login door connection by connecting.
 */
const startEndpoint: Endpoint = {
  path: "/agent-connections/start",
  method: "post",
  handler: async (req) => {
    try {
      const humanAccountId = requireHumanOwner(req);
      requireSameOrigin(req);
      const runtime = runtimeOrRefuse();
      const body = parse(startSchema, await readJson(req));
      const connection = await resolveConnection(
        runtime,
        humanAccountId,
        body.clientId,
      );
      return ok({ id: connection.id, status: connection.status });
    } catch (error) {
      return failure(error);
    }
  },
};

const connectionSchema = z
  .object({ id: z.string().regex(/^conn-[0-9a-f]{32}$/u) })
  .strict();

/**
 * Disconnect, by any owner under `operator`: with equal power and a real risk of a
 * stolen tool account, limiting it to the person who connected would only delay the
 * response. The read-only profile stays scoped to the acting human.
 *
 * What this stores is the canonical deny, which the resource server reads on the
 * next request, so that token stops at once. It deletes nothing at the provider.
 * Under `operator` the token endpoint reads the same record, so a refresh answers
 * `invalid_grant`. Under read-only the provider still redeems a retained refresh
 * token, and whatever it mints carries the old generation and is refused. A
 * connection a replay already revoked at the provider is still listed until this
 * runs, because the consent role cannot see the provider's state.
 */
const disconnectEndpoint: Endpoint = {
  path: "/agent-connections/disconnect",
  method: "post",
  handler: async (req) => {
    try {
      const humanAccountId = requireHumanOwner(req);
      requireSameOrigin(req);
      const runtime = runtimeOrRefuse();
      const body = parse(connectionSchema, await readJson(req));
      const stored = await runtime.connections.read(body.id);
      if (
        stored === null ||
        (runtime.preset !== "operator" &&
          stored.connection.humanAccountId !== humanAccountId)
      )
        throw new ConsentError("CONNECTION_NOT_FOUND", 404);
      const revoked = await withReservedAudit(
        req,
        "disconnect",
        {
          id: body.id,
          connectionId: body.id,
          tool: runtime.clients.get(stored.connection.oauthClientId)?.label,
        },
        () => runtime.authority.revoke(body.id, new Date().toISOString()),
      );
      return ok({ id: revoked.id, status: revoked.status });
    } catch (error) {
      return failure(error);
    }
  },
};

/**
 * The endpoints, or none at all.
 *
 * An empty array is the composition gate: where the door is off, these paths do
 * not exist, and a request for one gets Payload's own 404 rather than a handler
 * that has to remember to refuse. `/start` goes no further than Development.
 */
export const agentConnectionEndpoints = (
  environment: NodeJS.ProcessEnv = process.env,
): Endpoint[] =>
  oauthSurfaceEnabled(environment)
    ? [
        decideEndpoint,
        listEndpoint,
        disconnectEndpoint,
        ...(connectionsEnabled(environment) ? [startEndpoint] : []),
      ]
    : [];

/** Re-exported for the review page, which arms an interaction before it renders. */
export { interactionUidSchema };
