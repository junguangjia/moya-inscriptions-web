import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  adminMcpEnvelopeSchema,
  adminWhoamiDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { findKey } from "admin/admin-mcp";
import { isAiOperator, saveDraft } from "admin/editorial";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// Synthetic values built at runtime, so no credential-shaped literal is tracked.
const bearer = (value: string) => ["Bearer", value].join(" ");
const forgedConnectionToken = ["artvenn", "ct", "forged"].join("_");
const forgedArticleToken = ["artvenn", "article", "ct", "a".repeat(43)].join(
  "_",
);

// Behavior Matrix rows on the door and the native path, driven as real JSON-RPC
// over a real socket with the official client: "ai_operator key lists tools",
// "Automation key or connection token on /api/mcp", "JSON-RPC array on the native
// path", "GET /api/mcp with an AI key", "Client sends an unsupported protocol
// version header", "Read-profile key calls a write tool", "Same failure 3 times",
// "Expired key", "Forged or disabled key", "Owner-bound MCP key".

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const email = (name: string) => `${name}-${run}@example.invalid`;
const password = randomBytes(24).toString("hex");
const DAY_MS = 24 * 60 * 60 * 1000;
const STREAMABLE_ACCEPT = "application/json, text/event-stream";
// Matrix "admin_view_media result": text plus image, so no result schema. That
// tool arrives in a later slice; nothing else may join this list.
const TOOLS_WITHOUT_RESULT_SCHEMA = ["admin_view_media"];

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let endpoint: string;
let owner: TypedUser;
let automation: TypedUser;
let aiOperator: TypedUser;
let ownerToken: string;
const secrets: Record<string, string> = {};
const keyIds: Record<string, number> = {};

const db = () =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;

const makeKey = async (
  name: string,
  user: TypedUser,
  fields: Record<string, unknown> = {},
) => {
  const secret = randomBytes(32).toString("hex");
  const created = await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: user.id,
      label: `synthetic-${name}`,
      enableAPIKey: true,
      apiKey: secret,
      ...fields,
    } as never,
  });
  secrets[name] = secret;
  keyIds[name] = created.id;
  return created;
};

const bearer = (name: string) => ({ authorization: `Bearer ${secrets[name]}` });

const post = (
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      accept: STREAMABLE_ACCEPT,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const rpc = (method: string, params?: unknown, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const INITIALIZE = rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "synthetic", version: "1.0.0" },
});

const clientFor = async (name: string): Promise<Client> =>
  (await connectClient(endpoint, bearer(name))).client;

const callRaw = async (name: string, tool: string, args: unknown = {}) => {
  const response = await post(
    rpc("tools/call", { name: tool, arguments: args }),
    bearer(name),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
};

const lastUsedOf = async (name: string) => {
  const { rows } = await db().execute(
    sql`SELECT last_used_at, updated_at FROM payload_mcp_api_keys WHERE id = ${keyIds[name]}`,
  );
  return rows[0] as { last_used_at: unknown; updated_at: unknown };
};

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (name: string, role: "owner" | "automation") =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: email(name),
        password,
        role,
        scopeCatalogIds: [],
      },
    });
  owner = await account("owner", "owner");
  automation = await account("automation", "automation");
  aiOperator = await account("ai", "automation");
  aiOperator = await payload.update({
    collection: "users",
    id: aiOperator.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  const login = await handleEndpoints({
    config,
    request: new Request("http://localhost/api/users/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email("owner"), password }),
    }),
  });
  ownerToken = ((await login.json()) as { token: string }).token;

  await makeKey("ai-read", aiOperator, { toolProfile: "read" });
  await makeKey("ai-operate", aiOperator, { toolProfile: "operate" });
  await makeKey("ai-full", aiOperator, { toolProfile: "full" });
  await makeKey("automation", automation, {
    "payload-mcp-tool": { editorialQuery: true, editorialRead: true },
  });
  await makeKey("ai-expired", aiOperator, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await makeKey("automation-expired", automation, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await makeKey("ai-disabled", aiOperator);
  await payload.update({
    collection: "payload-mcp-api-keys",
    id: keyIds["ai-disabled"]!,
    overrideAccess: true,
    data: { enableAPIKey: false },
  });
  // Rows bound before the rule: only a direct write can produce them now.
  await makeKey("automation-for-rebind", automation);
  await payload.db.updateOne({
    collection: "payload-mcp-api-keys",
    id: keyIds["automation-for-rebind"]!,
    data: { user: owner.id },
  });
  secrets["owner-bound"] = secrets["automation-for-rebind"]!;
  await makeKey("ai-no-expiry", aiOperator);
  await db().execute(
    sql`UPDATE payload_mcp_api_keys SET expires_at = NULL WHERE id = ${keyIds["ai-no-expiry"]}`,
  );

  server = await serveRoutes(config);
  endpoint = server.endpoint;
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("ai_operator keys on the native path", () => {
  it.each(["ai-read", "ai-operate", "ai-full"])(
    "lists tools with the official client for %s, never an editorial or artvenn tool",
    async (name) => {
      const client = await clientFor(name);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(["admin_whoami"]);
        const [whoami] = tools;
        expect(whoami?.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(whoami?.outputSchema?.type).toBe("object");
        expect(client.getInstructions()?.length).toBeLessThanOrEqual(4096);
        // What the Matrix promises of any listing, so a later tool answers to it.
        expect(tools.length).toBeLessThanOrEqual(15);
        for (const tool of tools) {
          expect(tool.name).not.toMatch(/^(?:editorial|artvenn)_/u);
          expect(Object.keys(tool.annotations ?? {}).sort()).toEqual([
            "destructiveHint",
            "idempotentHint",
            "openWorldHint",
            "readOnlyHint",
          ]);
          if (!TOOLS_WITHOUT_RESULT_SCHEMA.includes(tool.name))
            expect(tool.outputSchema?.type, tool.name).toBe("object");
        }
        expect((await client.listTools()).tools).toEqual(tools);
      } finally {
        await client.close();
      }
    },
  );

  it.each(["ai-read", "ai-operate", "ai-full"])(
    "keeps the listing for %s inside its size budget",
    async (name) => {
      const listing = await post(rpc("tools/list"), bearer(name));
      // At most 4,000 tokens (section 21), read at a cautious 3 bytes a token
      // until a real client's count is measured.
      expect(Buffer.byteLength(await listing.text())).toBeLessThanOrEqual(
        12_000,
      );
    },
  );

  it("hands the official client a failure it accepts, with the body readable", async () => {
    const client = await clientFor("ai-read");
    try {
      const failed = await client.callTool({
        name: "admin_whoami",
        arguments: { stray: true },
      });
      expect(failed.isError).toBe(true);
      expect(
        adminMcpEnvelopeSchema.parse(failed.structuredContent),
      ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      const passed = await client.callTool({ name: "admin_whoami" });
      expect(passed.isError).toBeUndefined();
      expect(
        adminWhoamiDataSchema.parse(
          (passed.structuredContent as { data: unknown }).data,
        ).key.toolProfile,
      ).toBe("read");
    } finally {
      await client.close();
    }
  });

  it("answers the official client's own GET with 405, and the client carries on", async () => {
    const seen: {
      method: string | undefined;
      status: number;
      allow: string | null;
    }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      seen.push({
        method: init?.method,
        status: response.status,
        allow: response.headers.get("allow"),
      });
      return response;
    };
    const { client } = await connectClient(
      endpoint,
      bearer("ai-read"),
      recording,
    );
    try {
      await vi.waitFor(() =>
        expect(seen).toContainEqual({
          method: "GET",
          status: 405,
          allow: "POST",
        }),
      );
      expect((await client.listTools()).tools).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("lets the official client recover from a version it was refused, by initializing again", async () => {
    const { client, transport } = await connectClient(
      endpoint,
      bearer("ai-read"),
    );
    try {
      expect(transport.protocolVersion).toBe("2025-11-25");
      transport.setProtocolVersion("2026-07-28");
      await expect(client.listTools()).rejects.toMatchObject({ code: 400 });
    } finally {
      await client.close();
    }
    const fresh = await clientFor("ai-read");
    try {
      expect((await fresh.listTools()).tools).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });

  it("negotiates a client asking for a later version down to the highest it serves", async () => {
    const answer = await post(
      rpc("initialize", {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1.0.0" },
      }),
      bearer("ai-read"),
    );
    expect(answer.status).toBe(200);
    expect(
      ((await answer.json()) as { result: { protocolVersion: string } }).result
        .protocolVersion,
    ).toBe("2025-11-25");
  });

  it("answers admin_whoami with one validated envelope in text and structuredContent", async () => {
    const client = await clientFor("ai-operate");
    try {
      const result = await client.callTool({ name: "admin_whoami" });
      expect(result.isError).toBeUndefined();
      const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
      expect(envelope).toMatchObject({
        ok: true,
        code: "OK",
        untrusted: ["/data/key/label"],
        data: {
          path: "native",
          user: { id: aiOperator.id, role: "ai_operator" },
          key: {
            id: keyIds["ai-operate"],
            label: "synthetic-ai-operate",
            toolProfile: "operate",
          },
          tools: ["admin_whoami"],
        },
      });
      const [text] = result.content as { type: string; text: string }[];
      expect(JSON.parse(text!.text)).toEqual(result.structuredContent);
      expect(text!.text).not.toContain(email("ai"));
      expect(text!.text).not.toContain(secrets["ai-operate"]);
      expect(Buffer.byteLength(text!.text)).toBeLessThanOrEqual(9000);
    } finally {
      await client.close();
    }
  });

  it("speaks only initialize, ping, tools/list and tools/call, with no session", async () => {
    const initialized = await post(INITIALIZE, bearer("ai-read"));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    expect(initialized.headers.get("cache-control")).toBe("private, no-store");
    const answer = (await initialized.json()) as {
      result: { protocolVersion: string; capabilities: object };
    };
    expect(answer.result.protocolVersion).toBe("2025-11-25");
    expect(answer.result.capabilities).toEqual({ tools: {} });
    expect((await post(rpc("ping"), bearer("ai-read"))).status).toBe(200);
    expect(
      (
        await post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          bearer("ai-read"),
        )
      ).status,
    ).toBe(202);
    for (const method of ["resources/list", "prompts/list", "tasks/list"]) {
      const unknown = await post(rpc(method), bearer("ai-read"));
      expect(
        ((await unknown.json()) as { error: { code: number } }).error.code,
      ).toBe(-32601);
    }
  });

  it("answers GET with 405 and a JSON-RPC array with -32600", async () => {
    const got = await fetch(endpoint, {
      headers: { accept: STREAMABLE_ACCEPT, ...bearer("ai-read") },
    });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST");

    const batch = await post(
      [rpc("ping", undefined, 1), rpc("ping", undefined, 2)],
      bearer("ai-read"),
    );
    expect(batch.status).toBe(400);
    expect(
      ((await batch.json()) as { error: { code: number } }).error.code,
    ).toBe(-32600);
    const empty = await post([], bearer("ai-read"));
    expect(
      ((await empty.json()) as { error: { code: number } }).error.code,
    ).toBe(-32600);
    const deleted = await fetch(endpoint, {
      method: "DELETE",
      headers: bearer("ai-read"),
    });
    expect(deleted.status).toBe(404);
    const broken = await post("{not json", bearer("ai-read"));
    expect(broken.status).toBe(400);
    expect(
      ((await broken.json()) as { error: { code: number } }).error.code,
    ).toBe(-32700);
  });

  it("answers an invalid Origin with 403 and accepts none or its own", async () => {
    const withOrigin = (origin: string) =>
      post(rpc("ping"), { ...bearer("ai-read"), origin });
    expect((await withOrigin("https://attacker.example.invalid")).status).toBe(
      403,
    );
    expect((await withOrigin("null")).status).toBe(403);
    expect((await withOrigin(new URL(endpoint).origin)).status).toBe(200);
    expect((await post(rpc("ping"), bearer("ai-read"))).status).toBe(200);
  });

  it("answers a protocol version it does not serve with 400 and -32000, so a client falls back to initialize", async () => {
    const future = await post(rpc("tools/list"), {
      ...bearer("ai-read"),
      "mcp-protocol-version": "2026-07-28",
    });
    expect(future.status).toBe(400);
    expect(
      ((await future.json()) as { error: { code: number } }).error.code,
    ).toBe(-32000);
    expect(
      (
        await post(INITIALIZE, {
          ...bearer("ai-read"),
          "mcp-protocol-version": "2026-07-28",
        })
      ).status,
    ).toBe(400);
    const fallback = await post(INITIALIZE, bearer("ai-read"));
    expect(fallback.status).toBe(200);
    const served = await post(rpc("tools/list"), {
      ...bearer("ai-read"),
      "mcp-protocol-version": "2025-11-25",
    });
    expect(served.status).toBe(200);
  });

  it("ignores ticks stored on an AI key: it never reaches an editorial tool", async () => {
    await makeKey("ai-ticked", aiOperator, {
      toolProfile: "full",
      "payload-mcp-tool": { editorialQuery: true, artvennUsersFind: true },
    });
    const client = await clientFor("ai-ticked");
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
        "admin_whoami",
      ]);
      await expect(
        client.callTool({ name: "editorial_query", arguments: { page: 1 } }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it("refuses a tool outside the key's profile as not found", async () => {
    for (const tool of [
      "admin_execute",
      "editorial_query",
      "artvenn_users_find",
    ]) {
      const refused = await post(
        rpc("tools/call", { name: tool, arguments: {} }),
        bearer("ai-read"),
      );
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({
        error: { code: -32602, message: "MCP error -32602: Tool not found" },
      });
    }
  });

  it("gives a read-profile key no write on REST either: a key is not a REST identity", async () => {
    const before = await payload.count({
      collection: "catalogs",
      overrideAccess: true,
    });
    const headers = {
      ...bearer("ai-read"),
      "content-type": "application/json",
    };
    const content = syntheticCatalogDraft(
      `native-${run}-rest`,
      `source-${run}-rest`,
    );
    const native = await fetch(`${new URL(endpoint).origin}/api/catalogs`, {
      method: "POST",
      headers,
      body: JSON.stringify(content),
    });
    expect(native.status).toBe(403);
    const editorial = await fetch(
      `${new URL(endpoint).origin}/api/editorial/save-draft`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: run, content }),
      },
    );
    expect(editorial.status).toBe(403);
    expect(
      await payload.count({ collection: "catalogs", overrideAccess: true }),
    ).toEqual(before);
  });

  it("names invalid input by path, sets meta.repeat at the third failure, and clears it on success", async () => {
    const canary = `canary-${run}`;
    const fail = () => callRaw("ai-full", "admin_whoami", { [canary]: canary });
    const first = await fail();
    expect(first.result.isError).toBe(true);
    const envelope = adminMcpEnvelopeSchema.parse(
      first.result.structuredContent,
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: [], code: "unrecognized_keys", allowedKeys: [] }],
    });
    expect(envelope.hint).toBeTypeOf("string");
    expect(envelope.retryable).toBeUndefined();
    expect(envelope.meta.repeat).toBeUndefined();
    expect(first.result.content[0]!.text).not.toContain(canary);
    expect(
      ((await fail()).result.structuredContent!.meta as { repeat?: number })
        .repeat,
    ).toBeUndefined();
    expect(
      ((await fail()).result.structuredContent!.meta as { repeat?: number })
        .repeat,
    ).toBe(3);
    expect(
      ((await fail()).result.structuredContent!.meta as { repeat?: number })
        .repeat,
    ).toBe(4);
    expect((await callRaw("ai-full", "admin_whoami")).result.isError).toBe(
      undefined,
    );
    expect(
      ((await fail()).result.structuredContent!.meta as { repeat?: number })
        .repeat,
    ).toBeUndefined();
  });
});

describe("the key door", () => {
  const refusal = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as { errors: { message: string }[] },
  });

  it("answers 401 KEY_EXPIRED on both paths and both methods", async () => {
    for (const name of ["ai-expired", "automation-expired", "ai-no-expiry"]) {
      expect(
        await refusal(await post(rpc("ping"), bearer(name))),
      ).toMatchObject({
        status: 401,
        body: { errors: [{ message: "KEY_EXPIRED" }] },
      });
    }
    expect(
      await refusal(
        await fetch(endpoint, {
          headers: { accept: STREAMABLE_ACCEPT, ...bearer("ai-expired") },
        }),
      ),
    ).toMatchObject({
      status: 401,
      body: { errors: [{ message: "KEY_EXPIRED" }] },
    });
  });

  it("answers 401 KEY_OWNER_BOUND for a key bound to the Owner", async () => {
    expect(
      await refusal(await post(rpc("ping"), bearer("owner-bound"))),
    ).toMatchObject({
      status: 401,
      body: { errors: [{ message: "KEY_OWNER_BOUND" }] },
    });
  });

  it("names the refusal to the official client, and only to the holder of the secret", async () => {
    for (const [name, code] of [
      ["ai-expired", "KEY_EXPIRED"],
      ["automation-expired", "KEY_EXPIRED"],
      ["owner-bound", "KEY_OWNER_BOUND"],
    ] as const)
      await expect(clientFor(name)).rejects.toMatchObject({
        code: 401,
        message: expect.stringContaining(code) as string,
      });
    for (const name of ["ai-disabled", "forged"]) {
      secrets.forged = randomBytes(32).toString("hex");
      const refused = (await clientFor(name).catch(
        (error: unknown) => error,
      )) as { code: number; message: string };
      expect(refused.code).toBe(401);
      expect(refused.message).not.toMatch(/KEY_/u);
    }
  });

  it("stops a key on its next request, however long the client has been connected", async () => {
    await makeKey("ai-lapsing", aiOperator);
    const client = await clientFor("ai-lapsing");
    try {
      expect((await client.listTools()).tools).toHaveLength(1);
      await db().execute(
        sql`UPDATE payload_mcp_api_keys SET expires_at = now() - interval '1 second' WHERE id = ${keyIds["ai-lapsing"]}`,
      );
      await expect(client.listTools()).rejects.toMatchObject({
        code: 401,
        message: expect.stringContaining("KEY_EXPIRED") as string,
      });
    } finally {
      await client.close();
    }
    await makeKey("ai-disabling", aiOperator);
    const disabling = await clientFor("ai-disabling");
    try {
      await payload.update({
        collection: "payload-mcp-api-keys",
        id: keyIds["ai-disabling"]!,
        overrideAccess: true,
        data: { enableAPIKey: false },
      });
      const refused = (await disabling
        .listTools()
        .catch((error: unknown) => error)) as { code: number; message: string };
      expect(refused.code).toBe(401);
      expect(refused.message).not.toMatch(/KEY_/u);
    } finally {
      await disabling.close();
    }
  });

  it("reads a lowercase scheme as no key at all, on the plugin's own rule", async () => {
    const lowercase = await post(rpc("ping"), {
      authorization: `bearer ${secrets["ai-read"]}`,
    });
    expect(lowercase.status).toBe(401);
    expect(
      ((await lowercase.json()) as { errors: { message: string }[] }).errors[0]
        ?.message,
    ).not.toMatch(/KEY_/u);
  });

  it("answers a forged, a disabled and an absent key the same generic 401", async () => {
    const generic = await refusal(
      await post(rpc("ping"), {
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      }),
    );
    expect(generic.status).toBe(401);
    expect(generic.body.errors[0]?.message).not.toMatch(/KEY_/u);
    expect(
      await refusal(await post(rpc("ping"), bearer("ai-disabled"))),
    ).toEqual(generic);
    expect(await refusal(await post(rpc("ping")))).toEqual(generic);
    expect(
      await refusal(
        await post(rpc("ping"), { authorization: `Bearer ${ownerToken}` }),
      ),
    ).toEqual(generic);
    // Issue #177 isolation: an Article token is no key here.
    expect(
      await refusal(
        await post(rpc("ping"), {
          authorization: bearer(forgedArticleToken),
        }),
      ),
    ).toEqual(generic);
  });

  it("refuses a connection token presented with the surface off, with no key lookup", async () => {
    const response = await refusal(
      await post(rpc("ping"), { authorization: bearer(forgedConnectionToken) }),
    );
    expect(response.status).toBe(401);
    expect(response.body.errors[0]?.message).not.toMatch(/KEY_/u);
  });

  it("stamps last_used_at by raw SQL at most once per 60 s and leaves updated_at alone", async () => {
    await makeKey("ai-stamp", aiOperator);
    const before = await lastUsedOf("ai-stamp");
    expect(before.last_used_at).toBeNull();
    expect((await post(rpc("ping"), bearer("ai-stamp"))).status).toBe(200);
    const first = await lastUsedOf("ai-stamp");
    expect(first.last_used_at).not.toBeNull();
    expect(first.updated_at).toEqual(before.updated_at);
    expect((await post(rpc("ping"), bearer("ai-stamp"))).status).toBe(200);
    expect((await lastUsedOf("ai-stamp")).last_used_at).toEqual(
      first.last_used_at,
    );
    await db().execute(
      sql`UPDATE payload_mcp_api_keys SET last_used_at = now() - interval '61 seconds' WHERE id = ${keyIds["ai-stamp"]}`,
    );
    const stale = (await lastUsedOf("ai-stamp")).last_used_at;
    expect((await post(rpc("ping"), bearer("ai-stamp"))).status).toBe(200);
    expect((await lastUsedOf("ai-stamp")).last_used_at).not.toEqual(stale);
  });

  it("hands the rest of the request the strategy that grants ai_operator authority", async () => {
    const req = await createLocalReq({}, payload);
    const key = await findKey(req, secrets["ai-read"]!);
    expect(key?.user).toMatchObject({
      id: aiOperator.id,
      collection: "users",
      _strategy: "mcp-api-key",
    });
    req.user = key?.user as unknown as TypedUser;
    expect(isAiOperator(req)).toBe(true);
    expect(await findKey(req, secrets["ai-disabled"]!)).toBeNull();
    expect(await findKey(req, randomBytes(32).toString("hex"))).toBeNull();
  });

  it("does not stamp a refused key", async () => {
    expect((await post(rpc("ping"), bearer("ai-expired"))).status).toBe(401);
    expect((await lastUsedOf("ai-expired")).last_used_at).toBeNull();
  });
});

describe("key lifecycle fields", () => {
  const browser = () => ({
    cookie: `payload-token=${ownerToken}`,
    "content-type": "application/json",
  });
  const api = (route: string, method: string, body?: unknown) =>
    handleEndpoints({
      config,
      request: new Request(`http://localhost/api/${route}`, {
        method,
        headers: browser(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    });

  it("defaults a new key to the read profile and a 30-day expiry", async () => {
    const started = Date.now();
    const created = await api("payload-mcp-api-keys", "POST", {
      user: aiOperator.id,
      label: `synthetic-${randomUUID()}`,
    });
    expect(created.status).toBe(201);
    const { doc } = (await created.json()) as {
      doc: { toolProfile: string; expiresAt: string; lastUsedAt?: string };
    };
    expect(doc.toolProfile).toBe("read");
    const expires = Date.parse(doc.expiresAt);
    expect(expires).toBeGreaterThan(started + 29 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    expect(doc.lastUsedAt ?? null).toBeNull();
  });

  it("caps expiry and renewal at 30 days, keeps last used read-only and refuses an unknown profile", async () => {
    const at = (days: number) =>
      new Date(Date.now() + days * DAY_MS).toISOString();
    const create = (fields: Record<string, unknown>) =>
      api("payload-mcp-api-keys", "POST", {
        user: aiOperator.id,
        label: `synthetic-${randomUUID()}`,
        ...fields,
      });
    expect((await create({ expiresAt: at(31) })).status).toBe(400);
    expect((await create({ toolProfile: "owner" })).status).toBe(400);
    const created = await create({ expiresAt: at(29), toolProfile: "full" });
    expect(created.status).toBe(201);
    const { doc } = (await created.json()) as { doc: { id: number } };
    const route = `payload-mcp-api-keys/${doc.id}`;
    expect((await api(route, "PATCH", { expiresAt: at(31) })).status).toBe(400);
    const stampAttempt = await api(route, "PATCH", {
      lastUsedAt: new Date().toISOString(),
    });
    expect(stampAttempt.status).toBe(200);
    expect(
      ((await stampAttempt.json()) as { doc: { lastUsedAt?: string } }).doc
        .lastUsedAt ?? null,
    ).toBeNull();
    const renewed = await api(route, "PATCH", { expiresAt: at(30) });
    expect(renewed.status).toBe(200);
  });

  it("starts a 30-day clock on a key from before the columns, at the read profile", async () => {
    // The migration itself, run down and up on one real row, then rolled back.
    const migration = (await import(
      /* @vite-ignore */
      path.join(
        (payload.db as unknown as Pick<PostgresAdapter, "migrationDir">)
          .migrationDir,
        "20261103_150451_mcp_key_lifecycle.ts",
      )
    )) as Record<"up" | "down", (args: unknown) => Promise<void>>;
    const started = Date.now();
    let stored: Record<string, unknown> | undefined;
    await db()
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await migration.down({ db: tx });
        const { rows } = await tx.execute(sql`
          INSERT INTO payload_mcp_api_keys (user_id, label, enable_a_p_i_key, updated_at, created_at)
          VALUES (${automation.id}, 'synthetic-legacy', true, now(), now())
          RETURNING id`);
        await migration.up({ db: tx });
        stored = (
          await tx.execute(sql`
            SELECT expires_at, last_used_at, tool_profile FROM payload_mcp_api_keys
            WHERE id = ${rows[0]?.id as number}`)
        ).rows[0];
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (stored === undefined) throw error;
      });
    expect(stored?.tool_profile).toBe("read");
    expect(stored?.last_used_at).toBeNull();
    const expires = Date.parse(String(stored?.expires_at));
    expect(expires).toBeGreaterThan(started + 29 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  it("stores no tick for an admin_ tool", () => {
    const keys = config.collections.find(
      ({ slug }) => slug === "payload-mcp-api-keys",
    );
    const names = JSON.stringify(keys?.fields);
    expect(names).toContain("editorialQuery");
    expect(names).not.toContain("adminWhoami");
  });
});

describe("the plugin path stays the plugin path", () => {
  const replyOf = (result: unknown) =>
    JSON.parse(
      (result as { content: { text: string }[] }).content[0]!.text,
    ) as Record<string, unknown>;

  const scoped = async () => {
    const account = await payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: email(`scoped-${randomUUID()}`),
        password,
        role: "automation",
        scopeCatalogIds: [
          `native-${run}-in`,
          `native-${run}-first`,
          `native-${run}-second`,
        ],
      },
    });
    await makeKey("scoped", account, {
      "payload-mcp-tool": { editorialQuery: true, editorialSaveDraft: true },
    });
  };
  const draftOf = (suffix: string) =>
    syntheticCatalogDraft(`native-${run}-${suffix}`, `source-${run}-${suffix}`);

  it("lists the stored ticks plus admin_whoami for an automation key", async () => {
    const client = await clientFor("automation");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "admin_whoami",
        "editorial_query",
        "editorial_read",
      ]);
      // The plugin's SDK server requires an arguments object on every call.
      const result = await client.callTool({
        name: "admin_whoami",
        arguments: {},
      });
      const [text] = result.content as { type: string; text: string }[];
      const envelope = adminMcpEnvelopeSchema.parse(JSON.parse(text!.text));
      expect(envelope).toMatchObject({
        ok: true,
        code: "OK",
        data: {
          path: "plugin",
          user: { id: automation.id, role: "automation" },
          key: { id: keyIds.automation },
          tools: ["editorial_query", "editorial_read", "admin_whoami"],
        },
      });
      expect(
        (envelope.data as { key: Record<string, unknown> }).key,
      ).not.toHaveProperty("toolProfile");
    } finally {
      await client.close();
    }
  });

  it("keeps the plugin's answer to GET for an automation key", async () => {
    const got = await fetch(endpoint, {
      headers: { accept: STREAMABLE_ACCEPT, ...bearer("automation") },
    });
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).not.toBe("POST");
  });

  it("keeps an automation key to its Catalog scope and its stored ticks", async () => {
    await scoped();
    const req = await createLocalReq({ user: owner }, payload);
    const outside = draftOf("owner-only");
    await saveDraft(req, {
      idempotencyKey: `${run}:owner-only`,
      content: outside,
    });
    const client = await clientFor("scoped");
    try {
      const saved = replyOf(
        await client.callTool({
          name: "editorial_save_draft",
          arguments: {
            idempotencyKey: `${run}:in`,
            content: draftOf("in"),
          },
        }),
      );
      expect(saved).toHaveProperty("id");
      expect(
        replyOf(
          await client.callTool({
            name: "editorial_save_draft",
            arguments: { idempotencyKey: `${run}:out`, content: outside },
          }),
        ),
      ).toEqual({ ok: false, code: "CATALOG_OUT_OF_SCOPE" });
      const { docs } = replyOf(
        await client.callTool({
          name: "editorial_query",
          arguments: { page: 1 },
        }),
      ) as { docs: { catalogId: string }[] };
      expect(docs.map(({ catalogId }) => catalogId)).toEqual([
        `native-${run}-in`,
      ]);
      // A tool the key has no tick for stays absent, and refused on call.
      await expect(
        client.callTool({
          name: "editorial_read",
          arguments: { id: saved.id as number },
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
    }
  });

  it("answers artvenn_* NOT_FOUND outside Development, even for a key with the tick", async () => {
    await makeKey("artvenn", automation, {
      "payload-mcp-tool": { artvennUsersFind: true },
    });
    const client = await clientFor("artvenn");
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
        "artvenn_users_find",
        "admin_whoami",
      ]);
      expect(
        replyOf(
          await client.callTool({
            name: "artvenn_users_find",
            arguments: { page: 1, pageSize: 20 },
          }),
        ),
      ).toEqual({ ok: false, code: "NOT_FOUND" });
    } finally {
      await client.close();
    }
  });

  it("gives an automation key no profile: a stored one grants it nothing", async () => {
    await makeKey("automation-full", automation, {
      toolProfile: "full",
      "payload-mcp-tool": { editorialQuery: true },
    });
    const client = await clientFor("automation-full");
    try {
      expect(
        (await client.listTools()).tools.map(({ name }) => name).sort(),
      ).toEqual(["admin_whoami", "editorial_query"]);
    } finally {
      await client.close();
    }
  });

  it("keeps the plugin's refusal of GET for a key it does not know", async () => {
    const answer = (headers: Record<string, string> = {}) =>
      fetch(endpoint, { headers: { accept: STREAMABLE_ACCEPT, ...headers } });
    const anonymous = await answer();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("allow")).toBeNull();
    const forged = await answer({
      authorization: `Bearer ${randomBytes(32).toString("hex")}`,
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual(await anonymous.json());
  });

  it("serializes an array of writes on one req, with no start between another call's start and finish", async () => {
    await scoped();
    const call = (id: number, suffix: string) =>
      rpc(
        "tools/call",
        {
          name: "editorial_save_draft",
          arguments: {
            idempotencyKey: `${run}:${suffix}`,
            content: draftOf(suffix),
          },
        },
        id,
      );
    const batch = await post(
      [call(1, "first"), call(2, "second")],
      bearer("scoped"),
    );
    expect(batch.status).toBe(200);
    const answers = await batch.text();
    expect(answers).not.toContain('\\"ok\\":false');
    const { rows } = await db().execute(sql`
      SELECT phase, call_id FROM mcp_audit_events
      WHERE key_id = ${keyIds.scoped} ORDER BY id`);
    expect(rows.map(({ phase }) => phase)).toEqual([
      "start",
      "finish",
      "start",
      "finish",
    ]);
    expect(rows[0]?.call_id).toBe(rows[1]?.call_id);
    expect(rows[2]?.call_id).toBe(rows[3]?.call_id);
    expect(rows[0]?.call_id).not.toBe(rows[2]?.call_id);
    expect(
      await payload.count({
        collection: "catalogs",
        overrideAccess: true,
        where: {
          catalogId: {
            in: [`native-${run}-first`, `native-${run}-second`],
          },
        },
      }),
    ).toEqual({ totalDocs: 2 });
  });

  it("still runs an array on the plugin path, one call at a time", async () => {
    const batch = await post(
      [
        rpc("tools/call", { name: "admin_whoami", arguments: {} }, 1),
        rpc(
          "tools/call",
          { name: "editorial_query", arguments: { page: 1 } },
          2,
        ),
      ],
      bearer("automation"),
    );
    expect(batch.status).toBe(200);
    const answers = await batch.text();
    expect(answers).toContain('"id":1');
    expect(answers).toContain('"id":2');
    expect(answers).not.toContain('"error"');
  });
});
