import { createHmac } from "node:crypto";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { APIError, UnauthorizedError } from "payload";
import type {
  AdminMcpDoorRefusal,
  AdminMcpToolProfile,
} from "@moya/contracts/internal/admin-mcp";
import type { MCPAccessSettings } from "@payloadcms/plugin-mcp";
import type { PayloadRequest } from "payload";

import type { OverrideAuth } from "../agent-connections/composition";
import type { PayloadMcpApiKey, User } from "../payload-types";
import { controlFor } from "./control/state";
import type { AdminMcpControl } from "./control/state";

/**
 * The key door of `/api/mcp`, on both paths (docs/development/
 * admin-mcp-completion-v1.md section 3). Only a holder of the correct secret
 * reaches the two named refusals, so they are no oracle; everything else answers
 * the plugin's generic 401. Each refusal logs one fixed category.
 */

export type AdminMcpPath = "native" | "plugin";

export interface AdminMcpKey {
  readonly id: number;
  readonly label?: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly toolProfile: AdminMcpToolProfile;
  readonly path: AdminMcpPath;
  /** The Owner's pause, read for this request. Only admin_whoami stays. */
  readonly paused: boolean;
  readonly user: { readonly id: User["id"]; readonly role: User["role"] };
  /** The stored ticks; the native path ignores them. */
  readonly pluginTools: Readonly<Record<string, boolean | null | undefined>>;
}

const LAST_USED_THROTTLE_MS = 60_000;

const admittedKeys = new WeakMap<PayloadRequest, AdminMcpKey>();

const requestStarts = new WeakMap<PayloadRequest, number>();

/** Set where a POST arrives, so an audit duration includes the door. */
export const markRequestStart = (req: PayloadRequest): void => {
  requestStarts.set(req, performance.now());
};

/** The first call on a request owns the door's time; a batch's next call does not. */
export const takeRequestStart = (req: PayloadRequest): number => {
  const started = requestStarts.get(req) ?? performance.now();
  requestStarts.delete(req);
  return started;
};

/** The key admitted for this request, on either path. */
export const admittedKeyOf = (req: PayloadRequest): AdminMcpKey | undefined =>
  admittedKeys.get(req);

/**
 * A production build compiles Payload once for the routes and once for the Admin
 * pages, and whichever loads first builds the one instance every request shares.
 * Once a page has, a route fails `instanceof APIError` on what this module throws,
 * and a class minified to no name answers "An unknown error occurred." So the code
 * travels in `name` and `data`: `message` then reaches the client on either copy.
 */
const namedRefusal = (code: string, status: number): APIError => {
  const refusal = new APIError(code, status, { code }, true);
  refusal.name = code;
  return refusal;
};

const refuse = (
  req: PayloadRequest,
  category: string,
  refusal: AdminMcpDoorRefusal | null,
): never => {
  req.payload.logger.warn({ category });
  throw refusal === null ? new UnauthorizedError() : namedRefusal(refusal, 401);
};

/** The plugin's bearer rule, exactly: its default lookup is not exported. */
export const bearerKeyOf = (req: PayloadRequest): string | null => {
  const authorization = req.headers.get("Authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null;
};

type KeyDocument = PayloadMcpApiKey & { user: User };

/**
 * Reproduces the plugin's default lookup (plugin dist/endpoints/
 * resolveAccessSettings.js:3-36): HMAC index, find, then the strategy and
 * collection the rest of the request reads from req.user.
 */
export const findKey = async (
  req: PayloadRequest,
  presented: string,
): Promise<KeyDocument | null> => {
  const { docs } = await req.payload.find({
    collection: "payload-mcp-api-keys",
    depth: 1,
    limit: 1,
    pagination: false,
    where: {
      apiKeyIndex: {
        equals: createHmac("sha256", req.payload.secret)
          .update(presented)
          .digest("hex"),
      },
    },
  });
  const key = docs[0];
  if (!key || typeof key.user !== "object" || key.user === null) return null;
  Object.assign(key.user, { collection: "users", _strategy: "mcp-api-key" });
  return key as KeyDocument;
};

/** Uncached, per request. A door that cannot read the pause does not open. */
const doorControl = async (req: PayloadRequest): Promise<AdminMcpControl> => {
  try {
    return await controlFor(req);
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_CONTROL_READ_FAILED" });
    throw namedRefusal("MCP_CONTROL_UNAVAILABLE", 503);
  }
};

/** Raw SQL, so no hook runs and updated_at stays the Owner's last edit. */
const touchLastUsed = async (
  req: PayloadRequest,
  id: number,
  lastUsedAt: string | undefined,
): Promise<void> => {
  if (
    lastUsedAt !== undefined &&
    Date.now() - Date.parse(lastUsedAt) < LAST_USED_THROTTLE_MS
  )
    return;
  const { drizzle } = req.payload.db as unknown as Pick<
    PostgresAdapter,
    "drizzle"
  >;
  try {
    await drizzle.execute(sql`
      UPDATE payload_mcp_api_keys SET last_used_at = now()
      WHERE id = ${id}
        AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`);
  } catch {
    // A failed observation must not refuse an admitted request.
    req.payload.logger.warn({ category: "ADMIN_MCP_LAST_USED_WRITE_FAILED" });
  }
};

/**
 * Admits one key for one request. A key bound to the wrong role for this path
 * reads as unknown: an AI key never runs a plugin tool, however it got here.
 */
export const admitKey = async (
  req: PayloadRequest,
  key: KeyDocument,
  path: AdminMcpPath,
): Promise<AdminMcpKey> => {
  const { role } = key.user;
  if (role === "owner")
    return refuse(req, "ADMIN_MCP_KEY_OWNER_BOUND", "KEY_OWNER_BOUND");
  if (role !== (path === "native" ? "ai_operator" : "automation"))
    return refuse(req, "ADMIN_MCP_KEY_REFUSED", null);
  const expiresAt = key.expiresAt ? Date.parse(key.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    return refuse(req, "ADMIN_MCP_KEY_EXPIRED", "KEY_EXPIRED");
  const { pause } = await doorControl(req);
  const lastUsedAt = key.lastUsedAt
    ? new Date(key.lastUsedAt).toISOString()
    : undefined;
  await touchLastUsed(req, key.id, lastUsedAt);
  const admitted: AdminMcpKey = {
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    expiresAt: new Date(expiresAt).toISOString(),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    toolProfile: key.toolProfile ?? "read",
    path,
    paused: pause,
    user: { id: key.user.id, role },
    pluginTools: key["payload-mcp-tool"] ?? {},
  };
  admittedKeys.set(req, admitted);
  return admitted;
};

/**
 * The plugin path, as the `getDefaultMcpAccessSettings` argument of the existing
 * `connectionOverrideAuth`: the connection-token door is unchanged, and it never
 * asks for this resolver when a connection token was presented. The pause sits
 * outside it, so a connection token stops with every key; it has no admitted key
 * for admin_whoami to describe, so while paused it lists nothing.
 */
export const withKeyDoor =
  (connectionAuth: OverrideAuth): OverrideAuth =>
  async (req, getDefaultMcpAccessSettings) => {
    const settings = await connectionAuth(req, async (overrideApiKey) => {
      let resolved: MCPAccessSettings;
      try {
        resolved = await getDefaultMcpAccessSettings(overrideApiKey);
      } catch (error) {
        if (error instanceof UnauthorizedError)
          req.payload.logger.warn({ category: "ADMIN_MCP_KEY_REFUSED" });
        throw error;
      }
      await admitKey(req, resolved as unknown as KeyDocument, "plugin");
      return {
        ...resolved,
        "payload-mcp-tool": {
          ...resolved["payload-mcp-tool"],
          adminWhoami: true,
        },
      };
    });
    const { pause } = await doorControl(req);
    return pause
      ? {
          ...settings,
          "payload-mcp-tool": {
            adminWhoami: admittedKeyOf(req) !== undefined,
          },
        }
      : settings;
  };
