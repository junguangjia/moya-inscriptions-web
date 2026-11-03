import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_COMPLIANCE_PHRASES,
  ADMIN_MCP_KEY_LIFETIME_MS,
} from "@moya/contracts/internal/admin-mcp";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type PayloadRequest,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  controlFor,
  readControlPage,
  readMcpControl,
  withGuard,
  writeAuditEvent,
} from "admin/admin-mcp";

import {
  connectClient,
  serveRoutes,
  syntheticCatalogDraft,
} from "./admin-mcp-wire.js";

// Behavior Matrix rows "Pause on", "Owner opens a sensitive switch", "Audit record
// update or delete", "Admin control page and audit list" and "Reserved surface by
// any key or Authorization header" for the two new surfaces, driven as real REST
// and real JSON-RPC over a real socket on the synthetic database.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const email = (name: string) => `${name}-${run}@example.invalid`;
const password = randomBytes(24).toString("hex");
const ownerRestKey = randomBytes(32).toString("hex");
const automationRestKey = randomBytes(32).toString("hex");
const STREAMABLE_ACCEPT = "application/json, text/event-stream";
const ORIGIN = "http://localhost";
const CLOSED = {
  pause: false,
  threshold: 20,
  dm: false,
  evidence: false,
  rawIp: false,
  selfOnly: false,
};

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

const call = (
  route: string,
  init: { method?: string; headers?: HeadersInit; body?: unknown } = {},
) =>
  handleEndpoints({
    config,
    request: new Request(`http://localhost/api/${route}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...Object.fromEntries(new Headers(init.headers)),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  });

const browser = () => ({ cookie: `payload-token=${ownerToken}` });
const saveControl = (body: unknown, headers: HeadersInit = browser()) =>
  call("globals/mcp-control", { method: "POST", headers, body });

const refusedCredentials = () =>
  [
    ["no credential", {}],
    [
      "Authorization JWT with the Owner token",
      { authorization: `JWT ${ownerToken}` },
    ],
    [
      "Authorization Bearer with the Owner token",
      { authorization: `Bearer ${ownerToken}` },
    ],
    ["Owner REST key", { authorization: `users API-Key ${ownerRestKey}` }],
    [
      "automation REST key",
      { authorization: `users API-Key ${automationRestKey}` },
    ],
    ["AI key sent as a bearer", { authorization: `Bearer ${secrets.ai}` }],
    [
      "automation MCP key sent as a bearer",
      { authorization: `Bearer ${secrets.automation}` },
    ],
    [
      "the Owner cookie beside an Authorization header",
      { ...browser(), authorization: `Bearer ${secrets.ai}` },
    ],
  ] as const;

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
      label: `synthetic-${name}-${run}`,
      enableAPIKey: true,
      apiKey: secret,
      ...fields,
    } as never,
  });
  secrets[name] = secret;
  keyIds[name] = created.id;
};

const listed = async (name: string) => {
  const { client } = await connectClient(endpoint, {
    authorization: `Bearer ${secrets[name]}`,
  });
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
};

const callTool = async (name: string, tool: string, args: unknown = {}) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: STREAMABLE_ACCEPT,
      "content-type": "application/json",
      authorization: `Bearer ${secrets[name]}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const raw = await response.text();
  // The plugin path answers one SSE event when the transport picks the stream.
  const json = raw.startsWith("event:")
    ? raw.slice(raw.indexOf("data: ") + 6)
    : raw;
  return JSON.parse(json) as {
    error?: { code: number };
    result?: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
};

const replyOf = (answer: Awaited<ReturnType<typeof callTool>>) =>
  JSON.parse(answer.result?.content[0]?.text ?? "null") as Record<
    string,
    unknown
  >;

interface AuditRow {
  readonly id: number;
  readonly phase: string;
  readonly class: string;
  readonly tool: string | null;
  readonly op: string | null;
  readonly ok: boolean | null;
  readonly code: string | null;
  readonly call_id: string;
  readonly key_id: string | null;
  readonly key_label: string | null;
  readonly user_id: string | null;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly changed_fields: string[] | null;
  readonly duration_ms: string | null;
  readonly response_bytes: string | null;
}

const auditRows = async (where: ReturnType<typeof sql>): Promise<AuditRow[]> =>
  (
    await db().execute(
      sql`SELECT * FROM mcp_audit_events WHERE ${where} ORDER BY id`,
    )
  ).rows as unknown as AuditRow[];

const auditRowsForKey = (name: string) =>
  auditRows(sql`key_id = ${keyIds[name]}`);

let failures = 0;

/** A real database failure, narrowed so the ledger stays healthy for the rest. */
const withFailingAudit = async (
  condition: string,
  work: () => Promise<void>,
) => {
  failures += 1;
  const name = sql.raw(
    `mcp_audit_test_fail_${run.replaceAll("-", "_")}_${failures}`,
  );
  await db().execute(sql`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END; $$`);
  try {
    await db().execute(sql`
      CREATE TRIGGER ${name} BEFORE INSERT ON mcp_audit_events
      FOR EACH ROW WHEN (${sql.raw(condition)}) EXECUTE FUNCTION ${name}()`);
    await work();
  } finally {
    await db().execute(sql`DROP TRIGGER IF EXISTS ${name} ON mcp_audit_events`);
    await db().execute(sql`DROP FUNCTION ${name}()`);
  }
};

const catalogDraft = (suffix: string) =>
  syntheticCatalogDraft(`control-${run}-${suffix}`, `source-${run}-${suffix}`);

const ownerSessionRequest = (): Promise<PayloadRequest> =>
  createLocalReq(
    {
      user: {
        ...owner,
        collection: "users",
        _strategy: "local-jwt",
      } as unknown as TypedUser,
      req: { headers: new Headers(browser()) },
    },
    payload,
  );

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (
    name: string,
    role: "owner" | "automation",
    extra: Record<string, unknown> = {},
  ) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: email(name),
        password,
        role,
        scopeCatalogIds: [],
        ...extra,
      },
    });
  owner = await account("owner", "owner", {
    enableAPIKey: true,
    apiKey: ownerRestKey,
  });
  automation = await account("automation", "automation", {
    enableAPIKey: true,
    apiKey: automationRestKey,
    scopeCatalogIds: [
      `control-${run}-write`,
      `control-${run}-refused`,
      `control-${run}-paused-rest`,
    ],
  });
  aiOperator = await account("ai", "automation");
  aiOperator = await payload.update({
    collection: "users",
    id: aiOperator.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  const login = await call("users/login", {
    method: "POST",
    body: { email: email("owner"), password },
  });
  ownerToken = ((await login.json()) as { token: string }).token;

  await makeKey("ai", aiOperator, { toolProfile: "full" });
  await makeKey("automation", automation, {
    "payload-mcp-tool": { editorialQuery: true, editorialSaveDraft: true },
  });

  server = await serveRoutes(config);
  endpoint = server.endpoint;
});

afterEach(async () => {
  await payload.updateGlobal({
    slug: "mcp-control",
    overrideAccess: true,
    data: CLOSED,
  });
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

describe("the pause", () => {
  it("leaves only admin_whoami for every key from the next request, and comes back", async () => {
    expect(await listed("automation")).toEqual([
      "admin_whoami",
      "editorial_query",
      "editorial_save_draft",
    ]);
    expect((await saveControl({ pause: true })).status).toBe(200);

    expect(await listed("ai")).toEqual(["admin_whoami"]);
    expect(await listed("automation")).toEqual(["admin_whoami"]);

    const ai = replyOf(await callTool("ai", "admin_whoami"));
    expect(ai).toMatchObject({
      ok: true,
      data: { paused: true, tools: ["admin_whoami"] },
    });
    const automationWhoami = replyOf(
      await callTool("automation", "admin_whoami"),
    );
    expect(automationWhoami).toMatchObject({
      ok: true,
      data: { paused: true, tools: ["admin_whoami"], path: "plugin" },
    });

    expect((await saveControl({ pause: false })).status).toBe(200);
    expect(await listed("automation")).toEqual([
      "admin_whoami",
      "editorial_query",
      "editorial_save_draft",
    ]);
    expect(replyOf(await callTool("ai", "admin_whoami"))).toMatchObject({
      data: { paused: false },
    });
  });

  it("reaches a client that was already connected, on its next request", async () => {
    const { client: ai } = await connectClient(endpoint, {
      authorization: `Bearer ${secrets.ai}`,
    });
    const { client: keyed } = await connectClient(endpoint, {
      authorization: `Bearer ${secrets.automation}`,
    });
    try {
      expect((await keyed.listTools()).tools).toHaveLength(3);
      await saveControl({ pause: true });
      expect((await ai.listTools()).tools.map(({ name }) => name)).toEqual([
        "admin_whoami",
      ]);
      expect((await keyed.listTools()).tools.map(({ name }) => name)).toEqual([
        "admin_whoami",
      ]);
      await saveControl({ pause: false });
      expect((await keyed.listTools()).tools).toHaveLength(3);
    } finally {
      await ai.close();
      await keyed.close();
    }
  });

  it("refuses editorial_* over the wire while paused, and it runs again after", async () => {
    await saveControl({ pause: true });
    const refused = await callTool("automation", "editorial_query", {});
    expect(
      refused.error !== undefined || refused.result?.isError === true,
    ).toBe(true);
    expect(JSON.stringify(refused)).not.toContain("docs");

    await saveControl({ pause: false });
    const answer = await callTool("automation", "editorial_query", {});
    expect(answer.result?.isError).toBeFalsy();
    expect(replyOf(answer)).toHaveProperty("docs");
  });

  it("refuses a tool at the guard for a request no door has read control for", async () => {
    let ran = false;
    const req = await createLocalReq({}, payload);
    // Nothing read control on this request, so the guard's read is the first one.
    await saveControl({ pause: true });
    const answer = await withGuard({
      name: "editorial_save_draft",
      description: "",
      parameters: {},
      handler: () => {
        ran = true;
        return { content: [{ type: "text", text: "{}" }] };
      },
    }).handler({}, req, undefined);
    expect(ran).toBe(false);
    expect(JSON.parse(answer.content[0]!.text)).toMatchObject({
      ok: false,
      code: "MCP_PAUSED",
    });
  });

  it("keeps one answer per request: a request that read control before the pause still runs", async () => {
    // The Matrix says "next request". A real call has this shape, because the door
    // reads control first, so MCP_PAUSED cannot reach a call already past it. A run
    // that must stop between targets reads the row itself, with readMcpControl.
    let ran = false;
    const req = await createLocalReq({}, payload);
    expect((await controlFor(req)).pause).toBe(false);
    await saveControl({ pause: true });
    expect((await readMcpControl(payload)).pause).toBe(true);
    const answer = await withGuard({
      name: "editorial_save_draft",
      description: "",
      parameters: {},
      handler: () => {
        ran = true;
        return { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] };
      },
    }).handler({}, req, undefined);
    expect(ran).toBe(true);
    expect(JSON.parse(answer.content[0]!.text)).toEqual({ id: 1 });
    // The next request, with its own read, stops.
    const next = await createLocalReq({}, payload);
    expect((await controlFor(next)).pause).toBe(true);
  });

  it("leaves the Owner Admin and REST keys on the native routes alone", async () => {
    await saveControl({ pause: true });
    expect((await call("users/me", { headers: browser() })).status).toBe(200);
    expect(
      (await call("catalogs?limit=1", { headers: browser() })).status,
    ).toBe(200);
    expect(
      (
        await call("catalogs?limit=1", {
          headers: { authorization: `users API-Key ${automationRestKey}` },
        })
      ).status,
    ).toBe(200);
    // The Matrix says so in as many words: the pause is the MCP path's.
    for (const [route, authorization, body] of [
      [
        "editorial/owner-drafts",
        `users API-Key ${ownerRestKey}`,
        { page: 1, pageSize: 10 },
      ],
      [
        "editorial/save-draft",
        `users API-Key ${automationRestKey}`,
        {
          idempotencyKey: `${run}:paused-rest`,
          content: catalogDraft("paused-rest"),
        },
      ],
    ] as const) {
      const answer = await call(route, {
        method: "POST",
        headers: { authorization },
        body,
      });
      expect([route, answer.status]).toEqual([route, 200]);
    }
  });

  it("still takes effect when the ledger cannot record it, and logs nothing to the client", async () => {
    await withFailingAudit("NEW.op = 'mcp-control.change'", async () => {
      expect((await saveControl({ pause: true })).status).toBe(200);
      expect((await readMcpControl(payload)).pause).toBe(true);
      // Anything else that cannot be recorded does not happen.
      const refused = await saveControl({ threshold: 7 });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        errors: [{ data: { code: "AUDIT_UNAVAILABLE" } }],
      });
      expect((await readMcpControl(payload)).threshold).toBe(20);
      const resume = await saveControl({ pause: false });
      expect(resume.status).toBe(503);
      expect((await readMcpControl(payload)).pause).toBe(true);
    });
  });
});

describe("the one control row", () => {
  /** The state the migration leaves, or none, for a save that is truly the first. */
  const resetRow = async (state: "seeded" | "missing") => {
    await db().execute(sql`DELETE FROM mcp_control`);
    if (state === "seeded")
      await db().execute(
        sql`INSERT INTO mcp_control (updated_at, created_at) VALUES (now(), now())`,
      );
  };

  afterEach(async () => {
    const { rows } = await db().execute(sql`SELECT id FROM mcp_control`);
    if (rows.length === 0)
      await db().execute(
        sql`INSERT INTO mcp_control (updated_at, created_at) VALUES (now(), now())`,
      );
  });

  /** The text the migration runs, from its file, as the delivery suites read theirs. */
  const controlMigrationSql = async () => {
    const statements = /function up[\s\S]*?sql`([\s\S]*?)`\);/u.exec(
      await readFile(
        new URL(
          "../../apps/admin/src/migrations/20261103_153046_mcp_control.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    )?.[1];
    if (!statements) throw new Error("Control migration text not found");
    return statements;
  };

  it("is seeded closed by the migration, and the migration refuses a second", async () => {
    const statements = await controlMigrationSql();
    const rollback = new Error("ROLLBACK");
    await expect(
      db().transaction(async (tx) => {
        await tx.execute(sql`DROP TABLE mcp_control CASCADE`);
        await tx.execute(sql.raw(statements));
        const { rows } = await tx.execute(sql`
          SELECT pause, threshold, dm, evidence, raw_ip, self_only,
            updated_at IS NOT NULL AS stamped FROM mcp_control`);
        expect(rows).toEqual([
          {
            pause: false,
            threshold: "20",
            dm: false,
            evidence: false,
            raw_ip: false,
            self_only: false,
            stamped: true,
          },
        ]);
        await expect(
          tx.execute(sql`INSERT INTO mcp_control DEFAULT VALUES`),
        ).rejects.toMatchObject({ cause: { code: "23505" } });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("refuses a second row on the real table, whatever writes it", async () => {
    await expect(
      db().execute(sql`INSERT INTO mcp_control DEFAULT VALUES`),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    const { rows } = await db().execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'mcp_control' AND indexname = 'mcp_control_singleton'`);
    expect(String(rows[0]?.indexdef)).toContain("UNIQUE");
  });

  it("stays one row under two saves at once, and the door, the page and a save agree on it", async () => {
    await resetRow("seeded");
    const saves = await Promise.all([
      saveControl({ threshold: 8 }),
      saveControl({ threshold: 8 }),
    ]);
    expect(saves.map(({ status }) => status)).toEqual([200, 200]);
    const { rows } = await db().execute(sql`SELECT threshold FROM mcp_control`);
    expect(rows).toEqual([{ threshold: "8" }]);
    expect((await readMcpControl(payload)).threshold).toBe(8);
    expect((await readControlPage(await ownerSessionRequest())).threshold).toBe(
      8,
    );
    const stored = await payload.findGlobal({
      slug: "mcp-control",
      overrideAccess: true,
      depth: 0,
    });
    expect(stored.threshold).toBe(8);
  });

  it.each(["seeded", "missing"] as const)(
    "takes a pause on the first save from the %s state while the ledger is down",
    async (state) => {
      await resetRow(state);
      await withFailingAudit("NEW.op = 'mcp-control.change'", async () => {
        const answer = await saveControl({ pause: true });
        expect(answer.status).toBe(200);
        expect((await readMcpControl(payload)).pause).toBe(true);
      });
      const { rows } = await db().execute(sql`SELECT pause FROM mcp_control`);
      expect(rows).toEqual([{ pause: true }]);
    },
  );

  it("records a first save by what changed, never by the row's id", async () => {
    await resetRow("seeded");
    expect((await saveControl({ threshold: 6 })).status).toBe(200);
    const row = (await auditRows(sql`op = 'mcp-control.change'`)).at(-1);
    expect(row?.changed_fields).toEqual(["threshold"]);
  });

  it("shuts the door with no row at all, rather than reading it as not paused", async () => {
    await resetRow("missing");
    await expect(readMcpControl(payload)).rejects.toThrow(
      "MCP_CONTROL_ROW_MISSING",
    );
    for (const name of ["ai", "automation"]) {
      const answer = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: STREAMABLE_ACCEPT,
          "content-type": "application/json",
          authorization: `Bearer ${secrets[name]}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect([name, answer.status]).toEqual([name, 503]);
    }
  });
});

describe("the control global as a reserved surface", () => {
  it("reads and writes only for the Owner browser session", async () => {
    for (const [label, headers] of refusedCredentials()) {
      const read = await call("globals/mcp-control", { headers });
      expect([label, "read", read.status]).toEqual([label, "read", 403]);
      const saved = await saveControl({ pause: true }, headers);
      expect([label, "save", saved.status]).toEqual([label, "save", 403]);
    }
    expect((await readMcpControl(payload)).pause).toBe(false);
    expect(
      (await call("globals/mcp-control", { headers: browser() })).status,
    ).toBe(200);
  });

  it("refuses an AI request on the Local API, as the registry never reaches it", async () => {
    const req = await createLocalReq(
      {
        user: {
          ...aiOperator,
          collection: "users",
          _strategy: "mcp-api-key",
        } as unknown as TypedUser,
      },
      payload,
    );
    await expect(
      payload.updateGlobal({
        slug: "mcp-control",
        req,
        overrideAccess: false,
        data: { pause: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      payload.findGlobal({ slug: "mcp-control", req, overrideAccess: false }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("starts closed at a threshold of 20 and keeps a positive integer", async () => {
    expect(await readMcpControl(payload)).toEqual(CLOSED);
    for (const threshold of [0, -1, 1.5]) {
      const refused = await saveControl({ threshold });
      expect([threshold, refused.status]).toEqual([threshold, 400]);
    }
    expect((await saveControl({ threshold: 5 })).status).toBe(200);
    expect((await readMcpControl(payload)).threshold).toBe(5);
  });
});

describe("the typed compliance confirmation", () => {
  const code = async (response: Response) =>
    (
      (await response.json()) as {
        errors: { data?: { code?: string } }[];
      }
    ).errors[0]?.data?.code;

  it("refuses to open a switch without its own phrase", async () => {
    for (const complianceConfirmation of [
      undefined,
      "",
      "我确认",
      ADMIN_MCP_COMPLIANCE_PHRASES.evidence,
    ]) {
      const refused = await saveControl({ dm: true, complianceConfirmation });
      expect(refused.status).toBe(400);
      expect(await code(refused)).toBe("COMPLIANCE_CONFIRMATION_REQUIRED");
    }
    expect((await readMcpControl(payload)).dm).toBe(false);
  });

  it("opens one switch per phrase", async () => {
    const refused = await saveControl({
      dm: true,
      evidence: true,
      complianceConfirmation: ADMIN_MCP_COMPLIANCE_PHRASES.dm,
    });
    expect(refused.status).toBe(400);
    expect(await code(refused)).toBe("COMPLIANCE_ONE_SWITCH_AT_A_TIME");
  });

  it("takes effect at once, stamps it, records it and stores no phrase", async () => {
    const started = Date.now();
    const opened = await saveControl({
      rawIp: true,
      complianceConfirmation: ADMIN_MCP_COMPLIANCE_PHRASES.rawIp,
      // A caller cannot write its own stamp.
      dmOpenedAt: "2000-01-01T00:00:00.000Z",
      rawIpOpenedBy: automation.id,
    });
    expect(opened.status).toBe(200);
    expect((await readMcpControl(payload)).rawIp).toBe(true);

    const stored = await payload.findGlobal({
      slug: "mcp-control",
      overrideAccess: true,
      depth: 0,
    });
    expect(stored.rawIpOpenedBy).toBe(owner.id);
    expect(Date.parse(stored.rawIpOpenedAt ?? "")).toBeGreaterThanOrEqual(
      started - 1000,
    );
    expect(stored.dmOpenedAt ?? null).not.toBe("2000-01-01T00:00:00.000Z");
    expect(stored).not.toHaveProperty("complianceConfirmation");

    const rows = await auditRows(sql`op = 'mcp-control.change'`);
    const row = rows.at(-1);
    expect(row).toMatchObject({
      phase: "finish",
      class: "reserved",
      ok: true,
      user_id: String(owner.id),
      target_type: "mcp-control",
    });
    expect(row?.changed_fields).toEqual(
      expect.arrayContaining(["rawIp", "rawIpOpenedAt", "rawIpOpenedBy"]),
    );
    expect(JSON.stringify(row)).not.toContain(
      ADMIN_MCP_COMPLIANCE_PHRASES.rawIp,
    );
  });

  it("closes with no phrase, and reopening asks again", async () => {
    await saveControl({
      selfOnly: true,
      complianceConfirmation: ADMIN_MCP_COMPLIANCE_PHRASES.selfOnly,
    });
    expect((await saveControl({ selfOnly: false })).status).toBe(200);
    expect((await readMcpControl(payload)).selfOnly).toBe(false);
    expect((await saveControl({ selfOnly: true })).status).toBe(400);
  });

  it("asks nothing for an unrelated save while a switch stays open", async () => {
    await saveControl({
      evidence: true,
      complianceConfirmation: ADMIN_MCP_COMPLIANCE_PHRASES.evidence,
    });
    expect((await saveControl({ threshold: 9, evidence: true })).status).toBe(
      200,
    );
    expect((await readMcpControl(payload)).evidence).toBe(true);
  });
});

describe("the audit ledger", () => {
  it("reads only for the Owner browser session, and no one writes it over REST", async () => {
    const row = {
      at: new Date().toISOString(),
      phase: "finish",
      class: "read",
    };
    for (const [label, headers] of refusedCredentials()) {
      const read = await call("mcp-audit-events?limit=1", { headers });
      expect([label, "read", read.status]).toEqual([label, "read", 403]);
      const created = await call("mcp-audit-events", {
        method: "POST",
        headers,
        body: { ...row, callId: randomUUID() },
      });
      expect([label, "create", created.status]).toEqual([label, "create", 403]);
    }
    expect(
      (await call("mcp-audit-events?limit=1", { headers: browser() })).status,
    ).toBe(200);
    // The Owner has no write either: the ledger token is server-side only.
    const created = await call("mcp-audit-events", {
      method: "POST",
      headers: browser(),
      body: { ...row, callId: randomUUID() },
    });
    expect(created.status).toBe(403);
  });

  it("refuses update, delete and truncate for everyone, by access and by trigger", async () => {
    await callTool("ai", "admin_whoami");
    const [row] = await auditRowsForKey("ai");
    expect(row).toBeDefined();
    for (const method of ["PATCH", "DELETE"]) {
      const answer = await call(`mcp-audit-events/${row!.id}`, {
        method,
        headers: browser(),
        ...(method === "PATCH" ? { body: { code: "FORGED" } } : {}),
      });
      expect([method, answer.status]).toEqual([method, 403]);
    }
    await expect(
      payload.update({
        collection: "mcp-audit-events",
        id: row!.id,
        overrideAccess: true,
        data: { code: "FORGED" },
      }),
    ).rejects.toThrow();
    await expect(
      payload.delete({
        collection: "mcp-audit-events",
        id: row!.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow();
    // The table owner, which the grant does not bind: only the trigger is left.
    await expect(
      db().execute(
        sql`UPDATE mcp_audit_events SET code = 'FORGED' WHERE id = ${row!.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { message: "MCP_AUDIT_APPEND_ONLY", code: "42501" },
    });
    await expect(
      db().execute(sql`DELETE FROM mcp_audit_events WHERE id = ${row!.id}`),
    ).rejects.toMatchObject({
      cause: { message: "MCP_AUDIT_APPEND_ONLY", code: "42501" },
    });
    // A plain TRUNCATE stops at the lock table's foreign key. CASCADE gets past that.
    await expect(
      db().execute(sql`TRUNCATE mcp_audit_events`),
    ).rejects.toThrow();
    await expect(
      db().execute(sql`TRUNCATE mcp_audit_events CASCADE`),
    ).rejects.toMatchObject({
      cause: { message: "MCP_AUDIT_APPEND_ONLY", code: "42501" },
    });
    const [after] = await auditRows(sql`id = ${row!.id}`);
    expect(after?.code).toBe(row!.code);
  });

  it("records a read as one finish row with the key and account, and no content", async () => {
    const before = (await auditRowsForKey("ai")).length;
    const answer = await callTool("ai", "admin_whoami");
    const rows = (await auditRowsForKey("ai")).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phase: "finish",
      class: "read",
      tool: "admin_whoami",
      ok: true,
      code: "OK",
      key_label: `synthetic-ai-${run}`,
      user_id: String(aiOperator.id),
    });
    expect(Number(rows[0]?.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(Number(rows[0]?.response_bytes)).toBe(
      Buffer.byteLength(answer.result?.content[0]?.text ?? ""),
    );
  });

  it("records invalid input as a failed read", async () => {
    await callTool("ai", "admin_whoami", { stray: "synthetic-canary-value" });
    const row = (await auditRowsForKey("ai")).at(-1);
    expect(row).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(JSON.stringify(row)).not.toContain("synthetic-canary-value");
  });

  it("records a plugin save with no id as a start and a finish with one callId, the created target on the finish and no content", async () => {
    const before = (await auditRowsForKey("automation")).length;
    const content = catalogDraft("write");
    const answer = await callTool("automation", "editorial_save_draft", {
      idempotencyKey: `control-${randomUUID()}`,
      content,
    });
    const created = replyOf(answer).id;
    expect(created).toBeDefined();
    const rows = (await auditRowsForKey("automation")).slice(before);
    expect(rows.map(({ phase }) => phase)).toEqual(["start", "finish"]);
    expect(rows[1]?.call_id).toBe(rows[0]?.call_id);
    expect(rows[0]).toMatchObject({
      class: "write",
      ok: null,
      target_id: null,
    });
    expect(rows[1]).toMatchObject({
      ok: true,
      code: "OK",
      target_type: "catalogs",
      target_id: String(created),
    });
    expect(JSON.stringify(rows)).not.toContain(content.catalogId);
  });

  it("keeps the start row when the business transaction rolls back", async () => {
    const callCode = `ROLLED_BACK_${run.replaceAll("-", "_").toUpperCase()}`;
    const req = await createLocalReq({}, payload);
    const tx = await payload.db.beginTransaction();
    if (tx === null || tx === undefined) throw new Error("NO_TRANSACTION");
    req.transactionID = tx;
    const answer = await withGuard({
      name: "editorial_save_draft",
      description: "",
      parameters: {},
      handler: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, code: callCode }),
          },
        ],
      }),
    }).handler({}, req, undefined);
    expect(JSON.parse(answer.content[0]!.text).code).toBe(callCode);
    await payload.db.rollbackTransaction(tx);
    const [finish] = await auditRows(sql`code = ${callCode}`);
    expect(finish).toBeDefined();
    const rows = await auditRows(sql`call_id = ${finish!.call_id}`);
    expect(rows.map(({ phase }) => phase)).toEqual(["start", "finish"]);
  });

  it("refuses a native read and a plugin write when the audit write fails", async () => {
    await withFailingAudit(
      `NEW.key_id IN (${keyIds.ai}, ${keyIds.automation})`,
      async () => {
        const read = await callTool("ai", "admin_whoami");
        expect(read.result?.isError).toBe(true);
        expect(read.result?.structuredContent).toMatchObject({
          ok: false,
          code: "AUDIT_UNAVAILABLE",
          retryable: true,
        });
        expect(JSON.stringify(read)).not.toContain("expiresAt");

        const content = catalogDraft("refused");
        const write = replyOf(
          await callTool("automation", "editorial_save_draft", {
            idempotencyKey: `control-${randomUUID()}`,
            content,
          }),
        );
        expect(write).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
        const { totalDocs } = await payload.find({
          collection: "catalogs",
          overrideAccess: true,
          draft: true,
          where: { catalogId: { equals: content.catalogId } },
        });
        expect(totalDocs).toBe(0);
      },
    );
    expect(replyOf(await callTool("ai", "admin_whoami")).ok).toBe(true);
  });

  it("records key and account changes by field name only", async () => {
    const before = (await auditRows(sql`class = 'reserved'`)).length;
    const key = await call(`payload-mcp-api-keys/${keyIds.ai}`, {
      method: "PATCH",
      headers: browser(),
      body: { toolProfile: "operate", label: "synthetic-label-canary" },
    });
    expect(key.status).toBe(200);
    const account = await call(`users/${automation.id}`, {
      method: "PATCH",
      headers: browser(),
      body: { password: "synthetic-password-canary" },
    });
    expect(account.status).toBe(200);
    const rows = (await auditRows(sql`class = 'reserved'`)).slice(before);
    expect(
      rows.map(({ target_type, changed_fields }) => [
        target_type,
        changed_fields,
      ]),
    ).toEqual([
      ["payload-mcp-api-keys", ["label", "toolProfile"]],
      ["users", ["password"]],
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("canary");
    expect(rows[0]?.user_id).toBe(String(owner.id));
    await call(`payload-mcp-api-keys/${keyIds.ai}`, {
      method: "PATCH",
      headers: browser(),
      body: { toolProfile: "full", label: `synthetic-ai-${run}` },
    });
  });

  it("refuses a key change it cannot record", async () => {
    await withFailingAudit(
      "NEW.op = 'payload-mcp-api-keys.change'",
      async () => {
        const refused = await call(`payload-mcp-api-keys/${keyIds.ai}`, {
          method: "PATCH",
          headers: browser(),
          body: { label: "synthetic-never-stored" },
        });
        expect(refused.status).toBe(503);
      },
    );
    const key = await payload.findByID({
      collection: "payload-mcp-api-keys",
      id: keyIds.ai!,
      overrideAccess: true,
      depth: 0,
    });
    expect(key.label).toBe(`synthetic-ai-${run}`);
  });

  it("writes through the ledger on a request of its own", async () => {
    const callId = randomUUID();
    await writeAuditEvent(payload, {
      callId,
      phase: "finish",
      class: "read",
      ok: true,
      code: "OK",
    });
    expect(await auditRows(sql`call_id = ${callId}`)).toHaveLength(1);
  });
});

describe("the control page", () => {
  it("reads pause, switches, policy status, expiring keys and figures for the Owner", async () => {
    await callTool("ai", "admin_whoami");
    await makeKey("expiring", aiOperator, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const page = await readControlPage(await ownerSessionRequest());
    expect(page).toMatchObject({ pause: false, threshold: 20 });
    expect(page.switches.map(({ category }) => category)).toEqual([
      "dm",
      "evidence",
      "rawIp",
      "selfOnly",
    ]);
    expect(page.switches.every(({ policyCovers }) => !policyCovers)).toBe(true);
    expect(page.expiringKeys.map(({ id }) => id)).toContain(keyIds.expiring);
    expect(page.expiringKeys.map(({ id }) => id)).not.toContain(keyIds.ai);
    expect(page.figures?.timings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "admin_whoami", budgetMs: 100 }),
      ]),
    );
    expect(page.figures?.irreversibleTargets).toEqual(expect.any(Number));
  });

  it("never lets keys long expired push out one about to lapse, and lists soonest first", async () => {
    await db().execute(sql`
      INSERT INTO payload_mcp_api_keys (user_id, label, enable_a_p_i_key, expires_at, updated_at, created_at)
      SELECT ${automation.id}, 'synthetic-long-expired', true, now() - interval '30 days', now(), now()
      FROM generate_series(1, 51)`);
    await makeKey("lapsing", aiOperator, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { expiringKeys } = await readControlPage(await ownerSessionRequest());
    expect(expiringKeys.length).toBeLessThanOrEqual(50);
    expect(expiringKeys.map(({ id }) => id)).toContain(keyIds.lapsing);
    const times = expiringKeys.map(({ expiresAt }) =>
      Date.parse(expiresAt ?? ""),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("names a write older than five minutes with no finish as outcome unknown", async () => {
    const before = (await readControlPage(await ownerSessionRequest())).figures
      ?.outcomeUnknown as number;
    await db().execute(sql`
      INSERT INTO mcp_audit_events (at, phase, class, call_id)
      VALUES (now() - interval '6 minutes', 'start', 'write', ${randomUUID()})`);
    const after = await readControlPage(await ownerSessionRequest());
    expect(after.figures?.outcomeUnknown).toBe(before + 1);
  });

  it("renews a key by one click for the Owner session, capped at 30 days", async () => {
    await makeKey("renewed", aiOperator, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const route = `mcp-control/keys/${keyIds.renewed}/renew`;
    for (const [label, headers] of refusedCredentials()) {
      const refused = await call(route, {
        method: "POST",
        headers: { ...headers, origin: ORIGIN },
      });
      expect([label, refused.status]).toEqual([label, 403]);
    }
    const noOrigin = await call(route, { method: "POST", headers: browser() });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: "ORIGIN_REQUIRED" });

    const started = Date.now();
    const renewed = await call(route, {
      method: "POST",
      headers: { ...browser(), origin: ORIGIN },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("cache-control")).toBe("private, no-store");
    const { expiresAt } = (await renewed.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(
      started + ADMIN_MCP_KEY_LIFETIME_MS - 1000,
    );
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(
      Date.now() + ADMIN_MCP_KEY_LIFETIME_MS,
    );
    const row = (
      await auditRows(
        sql`target_id = ${String(keyIds.renewed)} AND class = 'reserved'`,
      )
    ).at(-1);
    expect(row?.changed_fields).toEqual(["expiresAt"]);

    const missing = await call("mcp-control/keys/not-a-key/renew", {
      method: "POST",
      headers: { ...browser(), origin: ORIGIN },
    });
    expect(missing.status).toBe(404);
  });
});
