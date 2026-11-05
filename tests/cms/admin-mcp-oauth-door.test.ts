import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_BYTE_WORK,
  ADMIN_MCP_CONNECTION_LIFETIME_MS,
  ADMIN_MCP_OPERATOR_ROW_EMAIL,
  adminMcpEnvelopeSchema,
  adminWhoamiDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import {
  createLocalReq,
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

import { toolListingFor } from "admin/admin-mcp";
import type { ConnectionRecord, VerifiedGrant } from "admin/agent-connections";
import { saveDraft } from "admin/editorial";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// Behavior Matrix rows "Operator connection token on /api/mcp", "OAuth surface
// off", "POST /api/mcp with no token, surface on", "Pause on", "Reserved surface by
// any key or Authorization header" apart from its AI connection surfaces, which do
// not exist in this composition and which O3 pins, "Disconnect by any owner", "Access
// token expires while connected", "Authorizing account leaves role owner", "Tool
// removed from the list", "Audit row for a connection call" and "admin_whoami on a
// connection", the way Production composes them: the login door on and the plugin
// path closed. Only
// the lookups behind the door are synthetic, the token and the connection store,
// because the real ones need an authorization service. The door, the dispatch, the
// guard, the tools and the `users` rows are real, over real JSON-RPC on a real socket.

const door = vi.hoisted(() => {
  const tokens = new Map<string, unknown>();
  const records = new Map<string, unknown>();
  const clients = new Map<string, unknown>();
  const refusals: string[] = [];
  const verified: string[] = [];
  const state = { composed: "on" as "on" | "off" | "refused" };
  return {
    tokens,
    records,
    clients,
    refusals,
    verified,
    state,
    runtime: {
      clients,
      verifyAccessToken: (presented: string): Promise<unknown> =>
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
    resourceRuntime: () => {
      if (door.state.composed === "refused")
        throw new Error("SYNTHETIC_RUNTIME_DETAIL");
      return door.state.composed === "on" ? door.runtime : null;
    },
  }),
);

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const password = randomBytes(24).toString("hex");
const DAY_MS = 24 * 60 * 60 * 1000;
const STREAMABLE_ACCEPT = "application/json, text/event-stream";
const CLIENT_ID = "https://tool.artvenn.invalid/oauth/client.json";
const CLIENT_LABEL = "Synthetic tool";
const SCOPES = {
  operator: ["artvenn:admin"],
  "read-only": ["artvenn:read"],
  management: ["artvenn:manage", "artvenn:read"],
} as const;

type Preset = keyof typeof SCOPES;

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let owner: TypedUser;
let automation: TypedUser;
let aiKeyOwner: TypedUser;
let operatorRow: TypedUser;
let aiKeySecret: string;
let aiKeyId: number;
let ownerToken: string;

const email = (name: string) => `${name}-${run}@example.invalid`;
const db = () =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;
const bearer = (secret: string) => ({
  authorization: ["Bearer", secret].join(" "),
});
const syntheticToken = () =>
  ["artvenn", "ct", randomBytes(32).toString("base64url")].join("_");
const subjectOf = (id: unknown) => `payload-user-${String(id)}`;

interface Connect {
  readonly preset?: Preset;
  readonly subject?: string;
  readonly consentedAt?: string;
  readonly clientId?: string;
  readonly tokenExpiresAt?: string;
  readonly tokenScopes?: readonly string[];
}

/** One consented connection and its token, as the two real lookups would read them. */
const connect = ({
  preset = "operator",
  subject = subjectOf(owner.id),
  consentedAt = new Date(Date.now() - DAY_MS).toISOString(),
  clientId = CLIENT_ID,
  tokenExpiresAt = "2099-01-01T00:00:00Z",
  tokenScopes = SCOPES[preset],
}: Connect = {}) => {
  const id = `conn-${randomBytes(16).toString("hex")}`;
  const generation = 3;
  door.records.set(id, {
    connection: {
      id,
      principalLabel: "agent-synthetic-tool",
      humanAccountId: subject,
      client: "synthetic",
      environment: door.runtime.environment,
      oauthClientId: clientId,
      consentedAt,
      preset,
      status: "authorized",
      generation,
      revokedAt: null,
    },
    grant: {
      grantId: `grant-${id}`,
      connectionId: id,
      generationAtConsent: generation,
      oauthClientId: clientId,
      humanSubject: subject,
      issuer: door.runtime.issuer,
      resource: door.runtime.resource,
      presetAtConsent: preset,
      capabilityScopes: [...SCOPES[preset]],
      consentedAt,
    },
  } satisfies ConnectionRecord);
  const presented = syntheticToken();
  door.tokens.set(presented, {
    connectionId: id,
    subject,
    clientId,
    resource: door.runtime.resource,
    issuer: door.runtime.issuer,
    scopes: [...tokenScopes],
    generation,
    expiresAt: tokenExpiresAt,
  } satisfies VerifiedGrant);
  return { id, presented, consentedAt };
};

/** Changes one thing about a stored connection, as a disconnect or a move would. */
const editConnection = (
  id: string,
  change: Partial<ConnectionRecord["connection"]>,
) => {
  const record = door.records.get(id) as ConnectionRecord;
  door.records.set(id, {
    ...record,
    connection: { ...record.connection, ...change },
  });
};

const post = (
  headers: Record<string, string>,
  method: string,
  params?: unknown,
): Promise<Response> =>
  fetch(server.endpoint, {
    method: "POST",
    headers: {
      accept: STREAMABLE_ACCEPT,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });

const refusalOf = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as { errors: { message: string }[] },
});

const withClient = async <T>(
  secret: string,
  work: (
    client: Awaited<ReturnType<typeof connectClient>>["client"],
  ) => Promise<T>,
): Promise<T> => {
  const { client } = await connectClient(server.endpoint, bearer(secret));
  try {
    return await work(client);
  } finally {
    await client.close();
  }
};

const callTool = async (
  secret: string,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const result = await withClient(secret, (client) =>
    client.callTool({ name, arguments: args }),
  );
  return adminMcpEnvelopeSchema.parse(result.structuredContent);
};

const whoami = async (secret: string) => {
  const answer = await callTool(secret, "admin_whoami");
  return { answer, data: adminWhoamiDataSchema.parse(answer.data) };
};

const setPause = (pause: boolean) =>
  payload.updateGlobal({
    slug: "mcp-control",
    overrideAccess: true,
    data: { pause },
  });

const setRow = (id: TypedUser["id"], data: Record<string, unknown>) =>
  payload.db.updateOne({ collection: "users", id, data });

/** A draft of the Owner's, and what an admin_execute save of it would send. */
const draftTarget = async (name: string, title = "Edited") => {
  const catalogId = `oauth-door-${name}-${run}`;
  const sourceId = `oauth-door-source-${name}-${run}`;
  const draft = await saveDraft(
    await createLocalReq({ user: owner }, payload),
    {
      idempotencyKey: `${run}:${name}`,
      content: syntheticCatalogDraft(catalogId, sourceId),
    },
  );
  return {
    id: draft.id,
    expectedRevision: draft.revision,
    content: { catalogId, sourceId, kind: "calligraphy", title },
  };
};

const auditRowsOf = async (connectionId: string) =>
  (
    await db().execute(sql`
      SELECT phase, class, tool, op, ok, code, key_id, key_label, user_id,
             connection_id, authorized_by
        FROM mcp_audit_events WHERE connection_id = ${connectionId} ORDER BY id`)
  ).rows;

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (
    name: string,
    role: "owner" | "automation" | "ai_operator",
  ) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: { email: email(name), password, role, scopeCatalogIds: [] },
    });
  owner = await account("owner", "owner");
  automation = await account("automation", "automation");
  aiKeyOwner = await account("ai", "ai_operator");
  const { docs } = await payload.find({
    collection: "users",
    limit: 1,
    pagination: false,
    where: { email: { equals: ADMIN_MCP_OPERATOR_ROW_EMAIL } },
  });
  operatorRow = docs[0] as TypedUser;
  aiKeySecret = randomBytes(32).toString("hex");
  const key = await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiKeyOwner.id,
      label: `synthetic-${run}`,
      enableAPIKey: true,
      apiKey: aiKeySecret,
      toolProfile: "full",
    } as never,
  });
  aiKeyId = key.id;
  door.clients.set(CLIENT_ID, { clientId: CLIENT_ID, label: CLIENT_LABEL });
  server = await serveRoutes(config);
  const login = await fetch(`${server.origin}/api/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email("owner"), password }),
  });
  ownerToken = ((await login.json()) as { token: string }).token;
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  door.state.composed = "on";
  door.clients.clear();
  door.clients.set(CLIENT_ID, { clientId: CLIENT_ID, label: CLIENT_LABEL });
  door.refusals.length = 0;
  door.verified.length = 0;
  await setPause(false);
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("an operator connection token", () => {
  it("lists exactly profile full, the same list an ai_operator key at full gets", async () => {
    const { presented } = connect();
    const tools = await withClient(
      presented,
      async (client) => (await client.listTools()).tools,
    );
    const names = tools.map(({ name }) => name);
    expect(names).toEqual(
      toolListingFor("full", false).map(({ name }) => name),
    );
    expect(names.length).toBeLessThanOrEqual(15);
    expect(names.filter((name) => /^(editorial|artvenn)_/u.test(name))).toEqual(
      [],
    );
    expect(tools).toEqual(
      await withClient(
        aiKeySecret,
        async (client) => (await client.listTools()).tools,
      ),
    );
  });

  it("keeps the listing on the wire inside its size budget", async () => {
    const { presented } = connect();
    const listing = await post(bearer(presented), "tools/list");
    expect(listing.status).toBe(200);
    expect(Buffer.byteLength(await listing.text())).toBeLessThanOrEqual(12_000);
  });

  it("tells the client it runs on a credential's authority, not a key's", async () => {
    const { presented } = connect();
    const instructions = await withClient(presented, (client) =>
      Promise.resolve(client.getInstructions()),
    );
    expect(instructions).toContain("this credential's authority");
    expect(instructions).not.toMatch(/\bkey\b/u);
  });

  it("gets the same answers as a key: same actions, and reads as an operator", async () => {
    const { presented } = connect();
    expect(await callTool(presented, "admin_actions")).toEqual(
      await callTool(aiKeySecret, "admin_actions"),
    );
    const read = await callTool(presented, "admin_read", {
      op: "list.catalogs",
    });
    expect(read).toMatchObject({ ok: true, code: "OK" });
  });

  it("accepts any spelling of the scheme", async () => {
    const { presented } = connect();
    const { client } = await connectClient(server.endpoint, {
      authorization: ["bEaReR", presented].join("  "),
    });
    try {
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("admin_execute");
    } finally {
      await client.close();
    }
  });

  it("answers GET from the native handler, and refuses a JSON-RPC array", async () => {
    const { presented } = connect();
    const got = await fetch(server.endpoint, {
      headers: { accept: STREAMABLE_ACCEPT, ...bearer(presented) },
    });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST");
    const array = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        accept: STREAMABLE_ACCEPT,
        "content-type": "application/json",
        ...bearer(presented),
      },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    });
    expect(array.status).toBe(400);
    expect(await array.json()).toMatchObject({ error: { code: -32600 } });
  });

  it("reads the frozen grant: moving the connection's writable columns moves nothing", async () => {
    const moved = {
      preset: "read-only",
      oauthClientId: "https://unlisted.artvenn.invalid/oauth/client.json",
      consentedAt: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      humanAccountId: subjectOf(automation.id),
    } as const;
    for (const change of [
      ...Object.entries(moved).map(([column, value]) => ({ [column]: value })),
      moved,
    ]) {
      const { id, presented, consentedAt } = connect();
      editConnection(id, change);
      const { data } = await whoami(presented);
      expect(data.key, JSON.stringify(change)).toMatchObject({
        label: CLIENT_LABEL,
        authorizedBy: owner.id,
        expiresAt: new Date(
          Date.parse(consentedAt) + ADMIN_MCP_CONNECTION_LIFETIME_MS,
        ).toISOString(),
      });
      expect((await auditRowsOf(id)).at(-1)).toMatchObject({
        tool: "admin_whoami",
        ok: true,
        connection_id: id,
        authorized_by: email("owner"),
      });
    }
  });

  it("stamps an observation only once the request is admitted", async () => {
    const { id, presented } = connect();
    expect((await post(bearer(presented), "tools/list")).status).toBe(200);
    expect(door.verified).toEqual([id]);
    door.verified.length = 0;
    editConnection(id, { generation: 4 });
    expect((await post(bearer(presented), "tools/list")).status).toBe(401);
    expect(door.verified).toEqual([]);
  });
});

describe("admin_whoami on a connection", () => {
  it("names the connection, the profile, the limit and the authorizing account, with no email", async () => {
    const { id, presented, consentedAt } = connect();
    const { answer, data } = await whoami(presented);
    expect(data).toMatchObject({
      path: "native",
      user: { id: operatorRow.id, role: "ai_operator" },
      key: {
        id,
        label: CLIENT_LABEL,
        toolProfile: "full",
        authorizedBy: owner.id,
        expiresAt: new Date(
          Date.parse(consentedAt) + ADMIN_MCP_CONNECTION_LIFETIME_MS,
        ).toISOString(),
      },
      paused: false,
    });
    expect(data.key.id).toMatch(/^conn-[0-9a-f]{32}$/u);
    const text = JSON.stringify(answer);
    expect(text).not.toContain(email("owner"));
    expect(text).not.toContain(ADMIN_MCP_OPERATOR_ROW_EMAIL);
    expect(text).not.toContain(presented);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/u);
  });

  it("reports what a client with no local process cannot do", async () => {
    const { data } = await whoami(connect().presented);
    expect(data.byteChannel).toEqual({
      available: false,
      unavailable: [...ADMIN_MCP_BYTE_WORK],
    });
    expect(ADMIN_MCP_BYTE_WORK).toEqual([
      "upload",
      "download",
      "canonical_export",
      "report_csv",
      "rendered_preview",
      "deep_zoom_master",
      "local_import",
      "account_provision",
    ]);
  });

  it("keeps the playbook and the tools a key gets", async () => {
    const { data } = await whoami(connect().presented);
    const key = await whoami(aiKeySecret);
    expect(data.playbook).toEqual(key.data.playbook);
    expect(data.tools).toEqual(key.data.tools);
  });

  it("leaves a key's answer as it was", async () => {
    const { data } = await whoami(aiKeySecret);
    expect(data.key.id).toBe(aiKeyId);
    expect(data.user).toEqual({ id: aiKeyOwner.id, role: "ai_operator" });
    expect(data.key).not.toHaveProperty("authorizedBy");
    expect(data).not.toHaveProperty("byteChannel");
  });
});

describe("pause, for a connection", () => {
  it("leaves only admin_whoami from the next request, refuses the rest, and comes back", async () => {
    const { id, presented } = connect();
    expect(
      await withClient(presented, async (client) => {
        await setPause(true);
        return (await client.listTools()).tools.map(({ name }) => name);
      }),
    ).toEqual(["admin_whoami"]);
    expect((await whoami(presented)).data.paused).toBe(true);
    expect(await callTool(presented, "admin_actions")).toMatchObject({
      ok: false,
      code: "MCP_PAUSED",
    });
    expect((await auditRowsOf(id)).at(-1)).toMatchObject({
      tool: "admin_actions",
      code: "MCP_PAUSED",
      connection_id: id,
      authorized_by: email("owner"),
    });
    await setPause(false);
    expect(
      await withClient(
        presented,
        async (client) => (await client.listTools()).tools.length,
      ),
    ).toBe(toolListingFor("full", false).length);
  });

  it("answers 503 when it cannot read the pause, and stamps nothing", async () => {
    const { presented } = connect();
    vi.spyOn(db(), "execute").mockRejectedValueOnce(new Error("synthetic"));
    const answer = await refusalOf(await post(bearer(presented), "tools/list"));
    expect(answer).toMatchObject({
      status: 503,
      body: { errors: [{ message: "MCP_CONTROL_UNAVAILABLE" }] },
    });
    expect(door.verified).toEqual([]);
  });
});

describe("what a connection can never reach", () => {
  const surfaces = () =>
    [
      ["GET", "payload-mcp-api-keys?limit=1", undefined, 200],
      [
        "POST",
        "payload-mcp-api-keys",
        { user: automation.id, label: `synthetic-${randomUUID()}` },
        201,
      ],
      ["PATCH", `payload-mcp-api-keys/${aiKeyId}`, { label: "synthetic" }, 200],
      ["GET", `users/${automation.id}`, undefined, 200],
      [
        "POST",
        "users",
        {
          email: email(`matrix-${randomUUID()}`),
          password,
          role: "automation",
          scopeCatalogIds: [],
        },
        201,
      ],
      [
        "PATCH",
        `users/${automation.id}`,
        { agentPrincipal: "agent-matrix" },
        200,
      ],
      ["POST", "users/unlock", { email: email("automation") }, 200],
      ["GET", "mcp-audit-events?limit=1", undefined, 200],
      ["GET", "globals/mcp-control", undefined, 200],
      ["POST", "globals/mcp-control", { threshold: 20 }, 200],
      ["POST", `mcp-control/keys/${aiKeyId}/renew`, undefined, 200],
    ] as const;

  const rest = (
    route: string,
    method: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    fetch(`${server.origin}/api/${route}`, {
      method,
      headers: {
        origin: server.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("refuses the token on every reserved surface, alone or beside an Owner cookie", async () => {
    const { presented } = connect();
    const cookie = { cookie: `payload-token=${ownerToken}` };
    for (const [label, headers] of [
      ["alone", bearer(presented)],
      ["beside the Owner cookie", { ...cookie, ...bearer(presented) }],
    ] as const)
      for (const [method, route, body] of surfaces()) {
        const answer = await rest(route, method, headers, body);
        const refused =
          route.startsWith("users/") && method === "GET" ? [403, 404] : [403];
        expect(
          [label, method, route, refused.includes(answer.status)],
          String(answer.status),
        ).toEqual([label, method, route, true]);
      }
  });

  it("lets the Owner cookie session through the same surfaces, as the positive control", async () => {
    const cookie = { cookie: `payload-token=${ownerToken}` };
    for (const [method, route, body, status] of surfaces()) {
      const answer = await rest(route, method, cookie, body);
      expect([method, route, answer.status]).toEqual([method, route, status]);
    }
  });

  it("names no reserved surface as an op", async () => {
    const { presented } = connect();
    for (const op of ["users.update", "mcp-control.pause", "mcp-audit.read"])
      expect(
        await callTool(presented, "admin_execute", {
          requestId: randomUUID(),
          op,
          input: {},
        }),
      ).toMatchObject({ ok: false, code: "UNKNOWN_OP" });
  });

  it("is anonymous on every other route: the same answer as no credential at all", async () => {
    const { presented } = connect();
    const verify = vi.spyOn(door.runtime, "verifyAccessToken");
    for (const route of [
      "users/me",
      "catalogs?limit=1",
      "media?limit=1",
      "articles?limit=1",
      "access",
      "payload-mcp-api-keys/me",
      "editorial/preview/1",
      "mcp-audit-events?limit=1",
      "globals/mcp-control",
    ]) {
      const anonymous = await rest(route, "GET", {});
      const presenting = await rest(route, "GET", bearer(presented));
      expect([route, presenting.status]).toEqual([route, anonymous.status]);
      expect(await presenting.text(), route).toBe(await anonymous.text());
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("costs no lookup on another spelling of the URL", async () => {
    const { presented } = connect();
    const verify = vi.spyOn(door.runtime, "verifyAccessToken");
    for (const spelling of ["MCP", "globals/mcp", "%4Dcp"]) {
      const answer = await fetch(`${server.origin}/api/${spelling}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(presented) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect([spelling, answer.status]).toEqual([spelling, 404]);
    }
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("the audit, for a connection", () => {
  it("records a read under the AI row, naming the connection and the person, with no key", async () => {
    const { id, presented } = connect();
    await whoami(presented);
    expect(await auditRowsOf(id)).toEqual([
      {
        phase: "finish",
        class: "read",
        tool: "admin_whoami",
        op: null,
        ok: true,
        code: "OK",
        key_id: null,
        key_label: CLIENT_LABEL,
        user_id: String(operatorRow.id),
        connection_id: id,
        authorized_by: email("owner"),
      },
    ]);
  });

  it("carries both fields on a write's start, its finish and its per-target row", async () => {
    const { id, presented } = connect();
    const answer = await callTool(presented, "admin_execute", {
      requestId: randomUUID(),
      op: "editorial.save-draft",
      targets: [await draftTarget("first"), await draftTarget("second")],
    });
    expect(answer).toMatchObject({ ok: true, code: "OK" });
    const rows = await auditRowsOf(id);
    expect(rows.map(({ phase, tool, op }) => [phase, tool, op])).toEqual([
      ["start", "admin_execute", "editorial.save-draft"],
      ["finish", null, "editorial.save-draft"],
      ["finish", null, "editorial.save-draft"],
      ["finish", "admin_execute", "editorial.save-draft"],
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        key_id: null,
        key_label: CLIENT_LABEL,
        user_id: String(operatorRow.id),
        connection_id: id,
        authorized_by: email("owner"),
      });
  });

  it("names the person's email as it was at that moment", async () => {
    const { id, presented } = connect();
    const moved = email("owner-moved");
    await setRow(owner.id, { email: moved });
    try {
      await whoami(presented);
    } finally {
      await setRow(owner.id, { email: email("owner") });
    }
    await whoami(presented);
    expect((await auditRowsOf(id)).map((row) => row.authorized_by)).toEqual([
      moved,
      email("owner"),
    ]);
  });

  it("keeps a key's rows as they were: the key's id and no connection", async () => {
    await whoami(aiKeySecret);
    const { rows } = await db().execute(sql`
      SELECT key_id, connection_id, authorized_by, user_id FROM mcp_audit_events
       WHERE key_id = ${aiKeyId} ORDER BY id DESC LIMIT 1`);
    expect(rows).toEqual([
      {
        key_id: String(aiKeyId),
        connection_id: null,
        authorized_by: null,
        user_id: String(aiKeyOwner.id),
      },
    ]);
  });
});

describe("one requestId, on two connections", () => {
  const secondPerson = () =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: email(`second-owner-${randomUUID()}`),
        password,
        role: "owner",
        scopeCatalogIds: [],
      },
    });

  /** The token a refresh hands the tool: new, on the same connection. */
  const refreshed = (presented: string) => {
    const next = syntheticToken();
    door.tokens.set(next, door.tokens.get(presented));
    door.tokens.delete(presented);
    return next;
  };

  const titleOf = async (id: number) =>
    (await payload.findByID({ collection: "catalogs", id, draft: true })).title;

  it("gives each its own effect at the receipt, and replays one's own retry across a refresh", async () => {
    const first = connect();
    const second = connect({ subject: subjectOf((await secondPerson()).id) });
    const requestId = `one-request-${run}`;
    const save = (secret: string, input: object) =>
      callTool(secret, "admin_execute", {
        requestId,
        op: "editorial.save-draft",
        input,
      });
    const mine = await draftTarget("requestid-first", "First person's");
    const theirs = await draftTarget("requestid-second", "Second person's");

    expect(await save(first.presented, mine)).toMatchObject({
      ok: true,
      data: { applied: [mine.id] },
    });
    expect(await save(second.presented, theirs)).toMatchObject({
      ok: true,
      data: { applied: [theirs.id] },
    });
    expect(await titleOf(mine.id)).toBe("First person's");
    expect(await titleOf(theirs.id)).toBe("Second person's");

    const retried = await save(refreshed(first.presented), mine);
    expect(retried).toMatchObject({
      ok: true,
      data: { already_applied: [mine.id] },
      meta: { replayed: true },
    });
  });

  it("never answers another person's command as a replay", async () => {
    const first = connect();
    const second = connect({ subject: subjectOf((await secondPerson()).id) });
    const call = {
      requestId: `one-command-${run}`,
      op: "editorial.save-draft",
      input: await draftTarget("requestid-shared", "Only once"),
    };
    expect(
      await callTool(first.presented, "admin_execute", call),
    ).toMatchObject({ ok: true });
    const answer = await callTool(second.presented, "admin_execute", call);
    expect(answer).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(answer.meta).not.toHaveProperty("replayed");
  });

  it("sends the Backend each one's own key, and the same key on a retry", async () => {
    const seen: unknown[] = [];
    const backend = createServer((incoming, outgoing) => {
      if (incoming.method === "POST")
        seen.push(incoming.headers["x-operator-request-id"]);
      incoming.resume();
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end("{}");
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    try {
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${(backend.address() as AddressInfo).port}/`,
      );
      for (const name of [
        "COMMUNITY_OPERATOR_AI_TOKEN",
        "OPERATOR_AI_BASE_TOKEN",
      ])
        vi.stubEnv(name, randomBytes(32).toString("base64url"));
      const first = connect();
      const second = connect({ subject: subjectOf((await secondPerson()).id) });
      const hide = (secret: string) =>
        callTool(secret, "admin_execute", {
          requestId: `one-backend-${run}`,
          op: "community.moderate-comment",
          input: {
            id: `comment-${"a".repeat(32)}`,
            action: "hide",
            reason: "Synthetic reason",
          },
        });
      const unknown = { code: "OUTCOME_UNKNOWN" };
      expect(await hide(first.presented)).toMatchObject(unknown);
      expect(await hide(second.presented)).toMatchObject(unknown);
      expect(await hide(refreshed(first.presented))).toMatchObject(unknown);
    } finally {
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]).not.toEqual(seen[1]);
    expect(seen[2]).toEqual(seen[0]);
  });
});

describe("a refusal at the door", () => {
  const generic = async () =>
    refusalOf(
      await post(bearer(randomBytes(32).toString("hex")), "tools/list"),
    );

  /** Refused with the plugin's own generic answer, the code only in the diagnostics. */
  const expectRefused = async (presented: string, code: string) => {
    door.refusals.length = 0;
    door.verified.length = 0;
    const answer = await refusalOf(await post(bearer(presented), "tools/list"));
    expect(answer).toEqual(await generic());
    expect(answer.status).toBe(401);
    expect(door.refusals).toEqual([code]);
    expect(door.verified).toEqual([]);
  };

  const expectOpen = async (presented: string) =>
    expect((await post(bearer(presented), "tools/list")).status).toBe(200);

  it("answers a forged token the plugin's 401, and never tries it as a key", async () => {
    await expectRefused(syntheticToken(), "CONNECTION_TOKEN_INVALID");
    const find = vi.spyOn(payload, "find");
    const forged = await post(bearer(syntheticToken()), "tools/list");
    expect(forged.status).toBe(401);
    expect(find).not.toHaveBeenCalled();
  });

  it("stops a disconnected connection on the very next call, on a live client", async () => {
    const { id, presented } = connect();
    await withClient(presented, async (client) => {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      editConnection(id, { generation: 4 });
      await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
    });
    await expectRefused(presented, "CONNECTION_GENERATION_STALE");
    editConnection(id, {
      generation: 3,
      status: "revoked",
      revokedAt: "2026-11-05T00:00:00Z",
    });
    await expectRefused(presented, "CONNECTION_REVOKED");
  });

  it("refuses an expired access token, so the tool refreshes", async () => {
    await expectRefused(
      connect({ tokenExpiresAt: "2026-01-01T00:00:00Z" }).presented,
      "CONNECTION_TOKEN_EXPIRED",
    );
  });

  it("refuses a token from another environment", async () => {
    const { id, presented } = connect();
    editConnection(id, { environment: "production" });
    await expectRefused(presented, "CONNECTION_ENVIRONMENT_MISMATCH");
  });

  it("refuses a token whose scope is not the preset's", async () => {
    await expectRefused(
      connect({ tokenScopes: ["artvenn:read"] }).presented,
      "CONNECTION_SCOPE_MISMATCH",
    );
  });

  it("stops at the hard limit from consent, whatever the token says", async () => {
    const age = (days: number) =>
      new Date(Date.now() - days * DAY_MS).toISOString();
    await expectRefused(
      connect({ consentedAt: age(181) }).presented,
      "CONNECTION_LIFETIME_OVER",
    );
    await expectOpen(connect({ consentedAt: age(179) }).presented);
  });

  it("stops a tool taken off the list, with no cached admission", async () => {
    const { presented } = connect();
    await expectOpen(presented);
    door.clients.delete(CLIENT_ID);
    await expectRefused(presented, "CONNECTION_CLIENT_NOT_LISTED");
    door.clients.set(CLIENT_ID, { clientId: CLIENT_ID, label: CLIENT_LABEL });
    await expectOpen(presented);
  });

  it("stops at the next call once the person leaves role owner, and resumes if they return", async () => {
    const { presented } = connect();
    await expectOpen(presented);
    for (const role of ["automation", "ai_operator"]) {
      await setRow(owner.id, { role });
      try {
        await expectRefused(presented, "CONNECTION_AUTHORIZER_REFUSED");
      } finally {
        await setRow(owner.id, { role: "owner" });
      }
    }
    await expectOpen(presented);
  });

  it("refuses a subject that names no owner: gone, another form, or the operator row", async () => {
    for (const subject of [
      subjectOf(2_000_000_000),
      subjectOf(automation.id),
      subjectOf(operatorRow.id),
      String(owner.id),
      email("owner"),
      `${subjectOf(owner.id)} `,
      subjectOf(`0${owner.id}`),
      // At and past the id column's range: nobody, and never a store error.
      subjectOf(2_147_483_647),
      subjectOf(2_147_483_648),
      subjectOf("99999999999999999999"),
    ])
      await expectRefused(
        connect({ subject }).presented,
        "CONNECTION_AUTHORIZER_REFUSED",
      );
  });

  it("shuts when the operator row stops being ai_operator, even as an owner", async () => {
    const { presented } = connect();
    for (const role of ["automation", "owner"]) {
      await setRow(operatorRow.id, { role });
      try {
        await expectRefused(presented, "CONNECTION_OPERATOR_ROW_REFUSED");
      } finally {
        await setRow(operatorRow.id, { role: "ai_operator" });
      }
    }
    await expectOpen(presented);
  });

  it("shuts when the operator row is gone", async () => {
    const { presented } = connect();
    await setRow(operatorRow.id, { email: email("operator-moved") });
    try {
      await expectRefused(presented, "CONNECTION_OPERATOR_ROW_REFUSED");
    } finally {
      await setRow(operatorRow.id, { email: ADMIN_MCP_OPERATOR_ROW_EMAIL });
    }
    await expectOpen(presented);
  });

  it("answers the same 401 when a store fails, with no detail", async () => {
    const { presented } = connect();
    vi.spyOn(door.runtime, "verifyAccessToken").mockRejectedValueOnce(
      new Error("SYNTHETIC_STORE_DETAIL"),
    );
    const failed = await post(bearer(presented), "tools/list");
    expect(failed.status).toBe(401);
    expect(await failed.text()).not.toContain("SYNTHETIC");
    expect(door.refusals).toEqual(["CONNECTION_ERROR"]);
  });

  it("answers the same 401 when it cannot read the accounts, with no detail", async () => {
    const { presented } = connect();
    const real = payload.find.bind(payload);
    vi.spyOn(payload, "find").mockImplementation(((args: {
      collection: string;
    }) =>
      args.collection === "users"
        ? Promise.reject(new Error("SYNTHETIC_DB_DETAIL"))
        : real(args as never)) as never);
    const failed = await post(bearer(presented), "tools/list");
    expect(failed.status).toBe(401);
    expect(await failed.text()).not.toContain("SYNTHETIC");
    expect(door.refusals).toEqual(["CONNECTION_ERROR"]);
  });

  it("answers the same 401 when the resource runtime refused, never a 500 with detail", async () => {
    const { presented } = connect();
    door.state.composed = "refused";
    const answer = await refusalOf(await post(bearer(presented), "tools/list"));
    expect(answer).toEqual(await generic());
    expect(JSON.stringify(answer)).not.toContain("SYNTHETIC");
  });

  it("leaves the token to the plugin's closed door when the surface is off", async () => {
    const { presented } = connect();
    door.state.composed = "off";
    const verify = vi.spyOn(door.runtime, "verifyAccessToken");
    expect(
      await refusalOf(await post(bearer(presented), "tools/list")),
    ).toEqual(await generic());
    expect(verify).not.toHaveBeenCalled();
    expect(door.verified).toEqual([]);
  });

  it.each(["read-only", "management"] as const)(
    "never serves a %s token natively: with the plugin path closed it is refused",
    async (preset) => {
      const { presented } = connect({ preset });
      expect(
        await refusalOf(await post(bearer(presented), "tools/list")),
      ).toEqual(await generic());
      expect(door.verified).toEqual([]);
      const got = await fetch(server.endpoint, {
        headers: { accept: STREAMABLE_ACCEPT, ...bearer(presented) },
      });
      expect(got.status).toBe(401);
    },
  );
});

describe("the metadata pointer on a 401", () => {
  const POINTER =
    'resource_metadata="https://admin.artvenn.invalid/.well-known/oauth-protected-resource/api/mcp"';

  const surfaceOn = () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENT_CONNECTIONS_ENABLED", "true");
    vi.stubEnv("AGENT_AUTHORIZATION_ISSUER", door.runtime.issuer);
    vi.stubEnv("AGENT_AUTHORIZATION_RESOURCE", door.runtime.resource);
  };

  const expiredKey = async () => {
    const secret = randomBytes(32).toString("hex");
    await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: aiKeyOwner.id,
        label: `synthetic-expired-${randomUUID()}`,
        enableAPIKey: true,
        apiKey: secret,
        toolProfile: "full",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      } as never,
    });
    return secret;
  };

  it("carries it on every 401 of the path with the surface on, and names no reason", async () => {
    surfaceOn();
    const { id, presented } = connect();
    editConnection(id, { generation: 4 });
    for (const [label, headers] of [
      ["no token", {}],
      ["a forged token", bearer(syntheticToken())],
      ["a disconnected connection", bearer(presented)],
      ["an unknown key", bearer(randomBytes(32).toString("hex"))],
    ] as const) {
      const answer = await post(headers, "tools/list");
      expect([label, answer.status]).toEqual([label, 401]);
      const challenge = answer.headers.get("www-authenticate") ?? "";
      expect(challenge, label).toContain(POINTER);
      expect(challenge, label).not.toContain("error=");
    }
  });

  it("keeps a key's named refusal, with the pointer beside it", async () => {
    surfaceOn();
    const answer = await post(bearer(await expiredKey()), "tools/list");
    expect(answer.headers.get("www-authenticate")).toContain(POINTER);
    expect(await refusalOf(answer)).toMatchObject({
      status: 401,
      body: { errors: [{ message: "KEY_EXPIRED" }] },
    });
  });

  it("is absent with the surface off", async () => {
    for (const headers of [{}, bearer(syntheticToken())]) {
      const answer = await post(headers, "tools/list");
      expect(answer.status).toBe(401);
      expect(answer.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("leaves an admitted call alone", async () => {
    surfaceOn();
    const answer = await post(bearer(connect().presented), "tools/list");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("www-authenticate")).toBeNull();
  });
});
