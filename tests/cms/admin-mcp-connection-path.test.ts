import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  getPayload,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ConnectionRecord, VerifiedGrant } from "admin/agent-connections";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

// Behavior Matrix rows "Automation key or connection token on /api/mcp", "Pause
// on" and "artvenn_*, agent/*, AI operations, AI connections", with the connection
// surface composed the way Development composes it. Only the two lookups behind
// the door are synthetic, the token's signature and the connection store, because
// the real ones need an authorization service; the door, the dispatch, the plugin,
// the guard and the tools are the real ones, over real JSON-RPC on a real socket.
// scripts/editorial/verify-agent-connections.mjs drives the real ones end to end.

const door = vi.hoisted(() => {
  const tokens = new Map<string, unknown>();
  const records = new Map<string, unknown>();
  const refusals: string[] = [];
  const verified: string[] = [];
  return {
    tokens,
    records,
    refusals,
    verified,
    dependencies: {
      verifyAccessToken: (presented: string) =>
        Promise.resolve(tokens.get(presented) ?? null),
      readConnection: (id: string) => Promise.resolve(records.get(id) ?? null),
      issuer: "https://auth.artvenn.invalid",
      resource: "https://admin.artvenn.invalid/api/mcp",
      environment: "development",
      recordRefusal: (code: string) => refusals.push(code),
      recordVerified: (id: string) => verified.push(id),
    },
  };
});

vi.mock(
  "../../apps/admin/src/agent-connections/resource",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    connectionAuthDependencies: () => door.dependencies,
  }),
);

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const STREAMABLE_ACCEPT = "application/json, text/event-stream";
const CLIENT_ID = "artvenn-claude-desktop-01";
const READ_ONLY_TOOLS = [
  "artvenn_comments_query",
  "artvenn_comments_read",
  "artvenn_content_search",
  "artvenn_users_find",
];
const MANAGEMENT_TOOLS = [
  ...READ_ONLY_TOOLS,
  "artvenn_comments_prepare",
  "artvenn_featured_prepare",
  "artvenn_operations_cancel",
  "artvenn_operations_execute",
  "artvenn_operations_get",
  "artvenn_operations_prepare_undo",
].sort();
const UNPAUSED = { pause: false };

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let endpoint: string;
let automation: TypedUser;
let owner: TypedUser;

const token = (suffix: string) => `artvenn_ct_${suffix}-${run}`;
const db = () =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

const connect = (
  name: string,
  preset: "read-only" | "management",
  generation = 3,
): string => {
  const id = `${name}-${run}`;
  const scopes =
    preset === "management"
      ? ["artvenn:manage", "artvenn:read"]
      : ["artvenn:read"];
  const connection = {
    id,
    principalLabel: "agent-phone",
    humanAccountId: "user-owner",
    client: "claude",
    environment: "development",
    oauthClientId: CLIENT_ID,
    consentedAt: "2026-09-18T00:00:00Z",
    preset,
    status: "authorized",
    generation,
    revokedAt: null,
  } satisfies ConnectionRecord["connection"];
  door.records.set(id, {
    connection,
    grant: {
      grantId: `grant-${id}`,
      connectionId: id,
      generationAtConsent: generation,
      oauthClientId: CLIENT_ID,
      humanSubject: "user-owner",
      issuer: door.dependencies.issuer,
      resource: door.dependencies.resource,
      presetAtConsent: preset,
      capabilityScopes: scopes,
      consentedAt: "2026-09-18T00:00:00Z",
    },
  } satisfies ConnectionRecord);
  const presented = token(name);
  door.tokens.set(presented, {
    connectionId: id,
    subject: "user-owner",
    clientId: CLIENT_ID,
    resource: door.dependencies.resource,
    issuer: door.dependencies.issuer,
    scopes,
    generation,
    expiresAt: "2099-01-01T00:00:00Z",
  } satisfies VerifiedGrant);
  return presented;
};

const listed = async (secret: string) => {
  const { client } = await connectClient(endpoint, bearer(secret));
  try {
    return (await client.listTools()).tools.map(({ name }) => name).sort();
  } finally {
    await client.close();
  }
};

const post = (
  secret: string,
  method: string,
  params?: unknown,
): Promise<Response> =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      accept: STREAMABLE_ACCEPT,
      "content-type": "application/json",
      ...bearer(secret),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });

const refusalBody = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as { errors: { message: string }[] },
});

const makeKey = async (
  user: TypedUser,
  fields: Record<string, unknown> = {},
) => {
  const secret = randomBytes(32).toString("hex");
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: user.id,
      label: `synthetic-${randomUUID()}`,
      enableAPIKey: true,
      apiKey: secret,
      ...fields,
    } as never,
  });
  return secret;
};

const setPause = (pause: boolean) =>
  payload.updateGlobal({
    slug: "mcp-control",
    overrideAccess: true,
    data: { pause },
  });

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (name: string, role: "owner" | "automation") =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `${name}-${run}@example.invalid`,
        password: randomBytes(24).toString("hex"),
        role,
        scopeCatalogIds: [],
      },
    });
  automation = await account("automation", "automation");
  owner = await account("owner", "owner");
  server = await serveRoutes(config);
  endpoint = server.endpoint;
});

afterEach(async () => {
  await payload.updateGlobal({
    slug: "mcp-control",
    overrideAccess: true,
    data: UNPAUSED,
  });
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("a connection token, with the surface composed", () => {
  it("lists exactly its preset's tools: no admin_whoami and no editorial_*", async () => {
    expect(await listed(connect("reader", "read-only"))).toEqual(
      READ_ONLY_TOOLS,
    );
    expect(await listed(connect("manager", "management"))).toEqual(
      MANAGEMENT_TOOLS,
    );
  });

  it("refuses a tool its preset does not grant, on call", async () => {
    const { client } = await connectClient(
      endpoint,
      bearer(connect("reader", "read-only")),
    );
    try {
      for (const name of [
        "admin_whoami",
        "editorial_query",
        "artvenn_operations_execute",
      ])
        await expect(
          client.callTool({ name, arguments: {} }),
          name,
        ).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
    }
  });

  it("answers artvenn_* NOT_FOUND outside Development, and audits by connection with no key", async () => {
    const presented = connect("audited", "read-only");
    const { client } = await connectClient(endpoint, bearer(presented));
    try {
      const answer = await client.callTool({
        name: "artvenn_users_find",
        arguments: { page: 1, pageSize: 20 },
      });
      expect(
        JSON.parse((answer.content as { text: string }[])[0]!.text),
      ).toEqual({ ok: false, code: "NOT_FOUND" });
    } finally {
      await client.close();
    }
    const { rows } = await db().execute(sql`
      SELECT phase, class, tool, ok, code, key_id, user_id FROM mcp_audit_events
      WHERE user_id = ${`audited-${run}`} ORDER BY id`);
    expect(rows).toEqual([
      {
        phase: "finish",
        class: "read",
        tool: "artvenn_users_find",
        ok: false,
        code: "NOT_FOUND",
        key_id: null,
        user_id: `audited-${run}`,
      },
    ]);
  });

  describe("under Development, with a Backend to reach", () => {
    let backend: Server;
    const seen: {
      url: string | undefined;
      principal: string | string[] | undefined;
    }[] = [];

    beforeAll(async () => {
      backend = createServer((request, response) => {
        seen.push({
          url: request.url,
          principal: request.headers["x-agent-principal"],
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ total: 0, items: [] }));
      });
      await new Promise<void>((resolve) =>
        backend.listen(0, "127.0.0.1", resolve),
      );
    });

    afterAll(async () => {
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
    });

    it("reaches the Backend as the connection's principal, unchanged", async () => {
      const { port } = backend.address() as AddressInfo;
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", randomBytes(16).toString("hex"));
      try {
        const { client } = await connectClient(
          endpoint,
          bearer(connect("reaching", "read-only")),
        );
        try {
          const answer = await client.callTool({
            name: "artvenn_users_find",
            arguments: { handle: "synthetic", page: 1, pageSize: 20 },
          });
          expect(
            JSON.parse((answer.content as { text: string }[])[0]!.text),
          ).toEqual({ ok: true, result: { total: 0, items: [] } });
        } finally {
          await client.close();
        }
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual([
        {
          url: "/internal/community/agent/users?handle=synthetic&page=1&pageSize=20",
          principal: "agent-phone",
        },
      ]);
    });
  });

  it("answers a forged, revoked or stale token the plugin's generic 401, recording why", async () => {
    const forged = await refusalBody(
      await post(`artvenn_ct_forged-${run}`, "tools/list"),
    );
    expect(forged.status).toBe(401);
    expect(forged.body.errors[0]?.message).not.toMatch(/KEY_|CONNECTION_/u);
    expect(door.refusals.at(-1)).toBe("CONNECTION_TOKEN_INVALID");

    const stale = connect("stale", "read-only");
    expect((await post(stale, "tools/list")).status).toBe(200);
    // Every request re-reads the connection: disconnect stops the very next one.
    const record = door.records.get(`stale-${run}`) as ConnectionRecord;
    door.records.set(`stale-${run}`, {
      ...record,
      connection: { ...record.connection, generation: 4 },
    });
    expect(await refusalBody(await post(stale, "tools/list"))).toEqual(forged);
    expect(door.refusals.at(-1)).toBe("CONNECTION_GENERATION_STALE");
  });

  it("never retries a connection token as an API key", async () => {
    const secret = await makeKey(automation, {
      "payload-mcp-tool": { editorialQuery: true },
    });
    const refused = await post(`artvenn_ct_${secret}`, "tools/list");
    expect(refused.status).toBe(401);
    expect(door.refusals.at(-1)).toBe("CONNECTION_TOKEN_INVALID");
  });

  it("keeps the plugin's answer to GET", async () => {
    const got = await fetch(endpoint, {
      headers: {
        accept: STREAMABLE_ACCEPT,
        ...bearer(connect("getter", "read-only")),
      },
    });
    const keyed = await fetch(endpoint, {
      headers: {
        accept: STREAMABLE_ACCEPT,
        ...bearer(await makeKey(automation)),
      },
    });
    expect(got.status).toBe(keyed.status);
    expect(got.headers.get("allow")).toBe(keyed.headers.get("allow"));
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).not.toBe("POST");
  });

  it("stops while paused with nothing listed, from the next request, and comes back", async () => {
    const presented = connect("paused", "read-only");
    expect(await listed(presented)).toEqual(READ_ONLY_TOOLS);
    await setPause(true);
    const listing = await post(presented, "tools/list");
    expect(listing.status).toBe(200);
    expect(await listing.text()).not.toContain("artvenn_users_find");
    // With no tool at all the plugin's server has no tools method to answer with.
    const { client } = await connectClient(endpoint, bearer(presented));
    try {
      await expect(
        client.callTool({
          name: "artvenn_users_find",
          arguments: { page: 1, pageSize: 20 },
        }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await client.close();
    }
    await setPause(false);
    expect(await listed(presented)).toEqual(READ_ONLY_TOOLS);
  });
});

describe("an API key, with the surface composed", () => {
  it("still passes through the key door to its own ticks", async () => {
    const secret = await makeKey(automation, {
      "payload-mcp-tool": { editorialQuery: true },
    });
    expect(await listed(secret)).toEqual(["admin_whoami", "editorial_query"]);
    expect(door.verified).not.toContain(secret);
  });

  it("still names an expired and an Owner-bound key", async () => {
    const expired = await makeKey(automation, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await refusalBody(await post(expired, "ping"))).toMatchObject({
      status: 401,
      body: { errors: [{ message: "KEY_EXPIRED" }] },
    });
    const secret = randomBytes(32).toString("hex");
    const created = await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: automation.id,
        label: `synthetic-${randomUUID()}`,
        enableAPIKey: true,
        apiKey: secret,
      } as never,
    });
    await payload.db.updateOne({
      collection: "payload-mcp-api-keys",
      id: created.id,
      data: { user: owner.id },
    });
    expect(await refusalBody(await post(secret, "ping"))).toMatchObject({
      status: 401,
      body: { errors: [{ message: "KEY_OWNER_BOUND" }] },
    });
  });

  it("still sends an ai_operator key to the native path", async () => {
    const created = await payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `ai-${run}@example.invalid`,
        password: randomBytes(24).toString("hex"),
        role: "automation",
        scopeCatalogIds: [],
      },
    });
    const aiOperator = await payload.update({
      collection: "users",
      id: created.id,
      overrideAccess: true,
      data: { role: "ai_operator" },
    });
    const got = await fetch(endpoint, {
      headers: {
        accept: STREAMABLE_ACCEPT,
        ...bearer(await makeKey(aiOperator)),
      },
    });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST");
  });
});
