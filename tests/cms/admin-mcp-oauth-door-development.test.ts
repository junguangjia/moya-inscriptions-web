import { randomBytes, randomUUID } from "node:crypto";

import { getPayload, type Payload, type SanitizedConfig } from "payload";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { toolListingFor } from "admin/admin-mcp";
import type { ConnectionRecord, VerifiedGrant } from "admin/agent-connections";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

// The Behavior Matrix row "Development read-only connection token on /api/mcp" with
// the login door in front of it: the way Development composes both, the door on and
// the plugin path open. A read-only or management token passes the door to the plugin
// path as it did before, and an operator token on the same server takes the native
// path. admin-mcp-oauth-door.test.ts holds the Production composition.

const door = vi.hoisted(() => {
  const tokens = new Map<string, unknown>();
  const records = new Map<string, unknown>();
  const clients = new Map<string, unknown>();
  const refusals: string[] = [];
  const verified: string[] = [];
  return {
    tokens,
    records,
    clients,
    refusals,
    verified,
    runtime: {
      clients,
      verifyAccessToken: (presented: string) =>
        Promise.resolve(tokens.get(presented) ?? null),
      readConnection: (id: string) => Promise.resolve(records.get(id) ?? null),
      issuer: "https://auth.artvenn.invalid",
      resource: "https://admin.artvenn.invalid/api/mcp",
      environment: "synthetic",
      recordRefusal: (code: string) => refusals.push(code),
      recordVerified: (id: string) => verified.push(id),
      close: () => Promise.resolve(),
    },
  };
});

vi.mock(
  "../../apps/admin/src/agent-connections/resource",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resourceRuntime: () => door.runtime,
    connectionAuthDependencies: () => door.runtime,
  }),
);

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const CLIENT_ID = "https://tool.artvenn.invalid/oauth/client.json";
const SCOPES = {
  operator: ["artvenn:admin"],
  "read-only": ["artvenn:read"],
  management: ["artvenn:manage", "artvenn:read"],
} as const;
const READ_ONLY_TOOLS = [
  "artvenn_comments_query",
  "artvenn_comments_read",
  "artvenn_content_search",
  "artvenn_users_find",
];

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let subject: string;

const bearer = (secret: string) => ({
  authorization: ["Bearer", secret].join(" "),
});

const connect = (preset: keyof typeof SCOPES) => {
  const id = `conn-${randomBytes(16).toString("hex")}`;
  const consentedAt = new Date().toISOString();
  door.records.set(id, {
    connection: {
      id,
      principalLabel: "agent-synthetic-tool",
      humanAccountId: subject,
      client: "synthetic",
      environment: door.runtime.environment,
      oauthClientId: CLIENT_ID,
      consentedAt,
      preset,
      status: "authorized",
      generation: 1,
      revokedAt: null,
    },
    grant: {
      grantId: `grant-${id}`,
      connectionId: id,
      generationAtConsent: 1,
      oauthClientId: CLIENT_ID,
      humanSubject: subject,
      issuer: door.runtime.issuer,
      resource: door.runtime.resource,
      presetAtConsent: preset,
      capabilityScopes: [...SCOPES[preset]],
      consentedAt,
    },
  } satisfies ConnectionRecord);
  const presented = [
    "artvenn",
    "ct",
    randomBytes(32).toString("base64url"),
  ].join("_");
  door.tokens.set(presented, {
    connectionId: id,
    subject,
    clientId: CLIENT_ID,
    resource: door.runtime.resource,
    issuer: door.runtime.issuer,
    scopes: [...SCOPES[preset]],
    generation: 1,
    expiresAt: "2099-01-01T00:00:00Z",
  } satisfies VerifiedGrant);
  return { id, presented };
};

const listed = async (secret: string) => {
  const { client } = await connectClient(server.endpoint, bearer(secret));
  try {
    return (await client.listTools()).tools.map(({ name }) => name).sort();
  } finally {
    await client.close();
  }
};

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `owner-${run}@example.invalid`,
      password: randomBytes(24).toString("hex"),
      role: "owner",
      scopeCatalogIds: [],
    },
  });
  subject = `payload-user-${String(owner.id)}`;
  door.clients.set(CLIENT_ID, { clientId: CLIENT_ID, label: "Synthetic tool" });
  server = await serveRoutes(config);
}, 60_000);

afterEach(() => {
  door.refusals.length = 0;
  door.verified.length = 0;
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("the login door beside the Development plugin path", () => {
  it("passes a read-only token to the plugin path, as it was", async () => {
    const { id, presented } = connect("read-only");
    expect(await listed(presented)).toEqual(READ_ONLY_TOOLS);
    // The plugin path's own observation, exactly one per request: a door that also
    // stamped this token would make it two.
    door.verified.length = 0;
    const listing = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...bearer(presented),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listing.status).toBe(200);
    expect(door.verified).toEqual([id]);
    const got = await fetch(server.endpoint, {
      headers: {
        accept: "application/json, text/event-stream",
        ...bearer(presented),
      },
    });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).not.toBe("POST");
  });

  it("passes a management token to the plugin path, as it was", async () => {
    const names = await listed(connect("management").presented);
    expect(names).toContain("artvenn_operations_execute");
    expect(names.filter((name) => name.startsWith("admin_"))).toEqual([]);
  });

  it("serves an operator token natively on the same server, at profile full", async () => {
    expect(await listed(connect("operator").presented)).toEqual(
      toolListingFor("full", false)
        .map(({ name }) => name)
        .sort(),
    );
  });

  it("records one refusal for a forged token, from the door", async () => {
    const answer = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...bearer(["artvenn", "ct", "forged"].join("_")),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(answer.status).toBe(401);
    expect(door.refusals).toEqual(["CONNECTION_TOKEN_INVALID"]);
  });
});
