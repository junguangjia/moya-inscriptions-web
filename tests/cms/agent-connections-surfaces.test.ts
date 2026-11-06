import { randomBytes, randomUUID } from "node:crypto";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  ADMIN_MCP_OPERATOR_ROW_EMAIL,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
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

import { ConnectionAuthority } from "admin/agent-connections";
import type {
  AgentConnection,
  ConnectionRecord,
  VerifiedGrant,
} from "admin/agent-connections";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

// The Behavior Matrix row "Reserved surface by any key or Authorization header" on
// its AI connection routes, the clause admin-mcp-oauth-door.test.ts cannot reach
// because those routes do not exist in its composition, the rows "Allow", "Deny" and
// "Disconnect by any owner" at their audit rows, and the row "Authorizing account
// leaves role owner, or changes password" through the real `users` hook. The two
// pages and the real stores on a real stack are in agent-connections-browser.mjs,
// which verify-agent-connections.mjs runs. This one is composed as
// Production composes it: `ADMIN_MCP_OAUTH_ENABLED` on before the config loads. The
// stores behind the door and the consent routes are synthetic, because the real ones
// need an authorization service, and `agent-operator-flow-cases.ts` runs them on
// PostgreSQL. Payload, its sessions, `isHumanOwner`, the audit ledger and the door are
// real, on a real socket, and the operator token below really is admitted.

const stores = vi.hoisted(() => {
  const before = { NODE_ENV: process.env.NODE_ENV };
  Object.assign(process.env, {
    NODE_ENV: "production",
    ADMIN_MCP_OAUTH_ENABLED: "true",
  });
  return {
    restoreEnvironment: () => {
      Object.assign(process.env, before);
      delete process.env.ADMIN_MCP_OAUTH_ENABLED;
    },
    connections: new Map<string, unknown>(),
    consents: new Map<string, unknown>(),
    tokens: new Map<string, unknown>(),
    records: new Map<string, unknown>(),
    clients: new Map<string, unknown>(),
    verified: [] as string[],
    onChange: [] as (() => Promise<void>)[],
    runtime: {} as Record<string, unknown>,
    /** What the consent runtime answers: built, off, or a kept refusal. */
    runtimeState: "built" as "built" | "off" | "refused",
    listedFor: [] as string[],
    /** A statement of the revoke that fails, for the test that sets it. */
    fault: null as "list" | "write" | null,
  };
});

vi.mock(
  "../../apps/admin/src/agent-connections/runtime",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    consentRuntime: () => {
      if (stores.runtimeState === "refused")
        throw new Error("synthetic refusal");
      return stores.runtimeState === "off" ? null : stores.runtime;
    },
  }),
);

vi.mock(
  "../../apps/admin/src/agent-connections/resource",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resourceRuntime: () => ({
      clients: stores.clients,
      verifyAccessToken: (presented: string) =>
        Promise.resolve(stores.tokens.get(presented) ?? null),
      readConnection: (id: string) =>
        Promise.resolve(
          (stores.records.get(id) as (() => unknown) | undefined)?.() ?? null,
        ),
      issuer: ISSUER,
      resource: RESOURCE,
      environment: "synthetic",
      recordVerified: (id: string) => stores.verified.push(id),
      close: () => Promise.resolve(),
    }),
  }),
);

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const ISSUER = "https://auth.artvenn.invalid";
const RESOURCE = "https://admin.artvenn.invalid/api/mcp";
const CLIENT_ID = "https://tool.artvenn.invalid/oauth/client.json";
const run = randomUUID();
const password = randomBytes(24).toString("hex");

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let ownerId: number | string;
let otherOwnerId: number | string;
let ownerCookie: string;
let automationCookie: string;
let ownerToken: string;
let ownerRestKey: string;
let aiKey: string;

const email = (name: string) => `${name}-${run}@example.invalid`;
const db = () =>
  (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;
const bearer = (secret: string) => ({
  authorization: ["Bearer", secret].join(" "),
});

const account = (name: string, role: "owner" | "automation" | "ai_operator") =>
  payload.create({
    collection: "users",
    overrideAccess: true,
    data: { email: email(name), password, role, scopeCatalogIds: [] },
  });

const auditRows = async (targetId: string) =>
  (
    await db().execute(sql`
      SELECT phase, class, op, ok, code, target_type, target_id, user_id,
             connection_id, key_label, key_id
        FROM mcp_audit_events WHERE target_id = ${targetId} ORDER BY id`)
  ).rows;

/** A connection the door will really admit, and the stored row behind it. */
const connect = (subject: string): { id: string; presented: string } => {
  const id = `conn-${randomBytes(16).toString("hex")}`;
  const connection: AgentConnection = {
    id,
    principalLabel: "agent-synthetic-tool",
    humanAccountId: subject,
    client: "claude",
    oauthClientId: CLIENT_ID,
    environment: "synthetic",
    preset: "operator",
    status: "authorized",
    generation: 1,
    revokedAt: null,
    consentedAt: new Date().toISOString(),
  };
  stores.connections.set(id, { connection, version: 1 });
  const record = () =>
    ({
      connection: (
        stores.connections.get(id) as { connection: AgentConnection }
      ).connection,
      grant: {
        grantId: `grant-${id}`,
        connectionId: id,
        generationAtConsent: 1,
        oauthClientId: CLIENT_ID,
        humanSubject: subject,
        issuer: ISSUER,
        resource: RESOURCE,
        presetAtConsent: "operator",
        capabilityScopes: ["artvenn:admin"],
        consentedAt: connection.consentedAt ?? "",
      },
    }) satisfies ConnectionRecord;
  stores.records.set(id, record);
  const presented = [
    "artvenn",
    "ct",
    randomBytes(32).toString("base64url"),
  ].join("_");
  stores.tokens.set(presented, {
    connectionId: id,
    subject,
    clientId: CLIENT_ID,
    resource: RESOURCE,
    issuer: ISSUER,
    scopes: ["artvenn:admin"],
    generation: 1,
    expiresAt: "2099-01-01T00:00:00Z",
  } satisfies VerifiedGrant);
  return { id, presented };
};

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

const armedConsent = (humanAccountId: string) => {
  const interactionUid = `uid-${randomBytes(12).toString("hex")}`;
  const ticket = randomBytes(32).toString("hex");
  stores.consents.set(interactionUid, {
    interactionUid,
    connectionId: null,
    humanAccountId,
    oauthClientId: CLIENT_ID,
    resource: RESOURCE,
    preset: "operator",
  });
  return { interaction: interactionUid, ticket };
};

beforeAll(async () => {
  stores.clients.set(CLIENT_ID, {
    clientId: CLIENT_ID,
    family: "claude",
    label: "Claude",
  });
  const connections = {
    read: (id: string) => Promise.resolve(stores.connections.get(id) ?? null),
    compareAndSet: async (
      id: string,
      version: number,
      next: AgentConnection,
    ) => {
      for (const check of stores.onChange) await check();
      if (stores.fault === "write") throw new Error("synthetic write fault");
      stores.connections.set(id, { connection: next, version: version + 1 });
      return { connection: next, version: version + 1 };
    },
    findForClient: () => Promise.resolve(null),
    listForHuman: (subject: string) => {
      stores.listedFor.push(subject);
      if (stores.fault === "list") throw new Error("synthetic read fault");
      return Promise.resolve(
        [...stores.connections.values()].filter(
          (entry) =>
            (entry as { connection: AgentConnection }).connection
              .humanAccountId === subject,
        ),
      );
    },
    listAuthorized: () =>
      Promise.resolve(
        [...stores.connections.values()]
          .filter(
            (entry) =>
              (entry as { connection: AgentConnection }).connection.status ===
              "authorized",
          )
          .map((entry) => ({
            ...(entry as object),
            lastVerifiedAt: null,
            currentGrantId: "grant",
          })),
      ),
  };
  stores.runtime = {
    preset: "operator",
    issuer: ISSUER,
    resource: RESOURCE,
    environment: "synthetic",
    clients: stores.clients,
    connections,
    authority: new ConnectionAuthority({ store: connections as never }),
    principals: {},
    consents: {
      read: (uid: string) => Promise.resolve(stores.consents.get(uid) ?? null),
      decide: async (input: { decision: string }) => {
        for (const check of stores.onChange) await check();
        return { decision: input.decision };
      },
    },
    close: () => Promise.resolve(),
  };
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const owner = await account("owner", "owner");
  const otherOwner = await account("other-owner", "owner");
  ownerId = owner.id;
  otherOwnerId = otherOwner.id;
  await account("automation", "automation");
  const aiAccount = await account("ai", "ai_operator");
  const secret = randomBytes(32).toString("hex");
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiAccount.id,
      label: `synthetic-${run}`,
      enableAPIKey: true,
      apiKey: secret,
      toolProfile: "full",
    } as never,
  });
  aiKey = secret;
  ownerRestKey = randomBytes(32).toString("hex");
  await payload.update({
    collection: "users",
    id: owner.id,
    overrideAccess: true,
    data: { enableAPIKey: true, apiKey: ownerRestKey },
  });
  server = await serveRoutes(config);
  const login = async (name: string) => {
    const response = await fetch(`${server.origin}/api/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email(name), password }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  ownerToken = await login("owner");
  ownerCookie = `payload-token=${ownerToken}`;
  automationCookie = `payload-token=${await login("automation")}`;
}, 60_000);

afterEach(() => {
  stores.onChange.length = 0;
  stores.runtimeState = "built";
  stores.fault = null;
  stores.runtime.preset = "operator";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
  stores.restoreEnvironment();
});

const subjectOf = (id: number | string) => `payload-user-${String(id)}`;

const surfaces = () => {
  const { id } = connect(subjectOf(otherOwnerId));
  const consent = armedConsent(subjectOf(ownerId));
  return [
    ["POST", "agent-connections/consent", { ...consent, decision: "deny" }],
    ["GET", "agent-connections", undefined],
    ["POST", "agent-connections/disconnect", { id }],
  ] as const;
};

describe("every AI connection route", () => {
  it("is composed in Production, without /start", async () => {
    expect(
      config.endpoints
        .filter(({ path }) => path.startsWith("/agent-connections"))
        .map(({ method, path }) => `${method} ${path}`)
        .sort(),
    ).toEqual([
      "get /agent-connections",
      "post /agent-connections/consent",
      "post /agent-connections/disconnect",
    ]);
    const answer = await rest("agent-connections/start", "POST", {
      cookie: ownerCookie,
    });
    expect(answer.status).toBe(404);
  });

  it("answers an Owner browser session, as the positive control", async () => {
    for (const [method, route, body] of surfaces()) {
      const answer = await rest(route, method, { cookie: ownerCookie }, body);
      expect([route, answer.status]).toEqual([route, 200]);
    }
  });

  it("answers 403 to everything else, an admitted connection token first", async () => {
    const { presented } = connect(subjectOf(ownerId));
    // Really admitted: this same token lists the tools on the path it belongs to.
    const { client } = await connectClient(server.endpoint, bearer(presented));
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const answer = await client.callTool({
        name: "admin_whoami",
        arguments: {},
      });
      expect(adminMcpEnvelopeSchema.parse(answer.structuredContent).ok).toBe(
        true,
      );
    } finally {
      await client.close();
    }

    for (const [label, headers] of [
      ["no credential", {}],
      ["a connection token", bearer(presented)],
      [
        "a connection token beside the Owner cookie",
        { ...bearer(presented), cookie: ownerCookie },
      ],
      ["an AI key", bearer(aiKey)],
      [
        "an AI key beside the Owner cookie",
        { ...bearer(aiKey), cookie: ownerCookie },
      ],
      ["an Owner REST key", { authorization: `users API-Key ${ownerRestKey}` }],
      [
        "an Owner token in a JWT header",
        { authorization: `JWT ${ownerToken}` },
      ],
      ["an Owner token as a bearer", bearer(ownerToken)],
      ["an automation session", { cookie: automationCookie }],
    ] as const)
      for (const [method, route, body] of surfaces()) {
        const answer = await rest(route, method, headers, body);
        expect([label, route, answer.status]).toEqual([label, route, 403]);
        expect((await answer.json()) as unknown).toEqual({
          ok: false,
          error: "OWNER_ONLY",
        });
      }
  });

  it("writes nothing for any of those", async () => {
    const { id } = connect(subjectOf(ownerId));
    const consent = armedConsent(subjectOf(ownerId));
    for (const headers of [
      {},
      bearer(aiKey),
      { authorization: `JWT ${ownerToken}` },
    ]) {
      await rest("agent-connections/disconnect", "POST", headers, { id });
      await rest("agent-connections/consent", "POST", headers, {
        ...consent,
        decision: "approve",
      });
    }
    expect(await auditRows(id)).toEqual([]);
    expect(await auditRows(consent.interaction)).toEqual([]);
    expect(
      (stores.connections.get(id) as { connection: AgentConnection }).connection
        .status,
    ).toBe("authorized");
  });

  it("refuses a change from another origin, in an Owner's own session", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", server.origin);
    const { id } = connect(subjectOf(ownerId));
    const answer = await rest(
      "agent-connections/disconnect",
      "POST",
      { cookie: ownerCookie, origin: "https://evil.example.invalid" },
      { id },
    );
    expect(answer.status).toBe(403);
    expect((await answer.json()) as unknown).toEqual({
      ok: false,
      error: "ORIGIN_REQUIRED",
    });
    expect(await auditRows(id)).toEqual([]);
  });
});

describe("the reserved audit rows", () => {
  it("are on the ledger before a disconnect by another owner, naming who did it", async () => {
    const { id, presented } = connect(subjectOf(otherOwnerId));
    let rowsAtChange: unknown[] = [];
    stores.onChange.push(async () => {
      rowsAtChange = await auditRows(id);
    });

    const answer = await rest(
      "agent-connections/disconnect",
      "POST",
      { cookie: ownerCookie },
      { id },
    );
    expect(answer.status).toBe(200);
    expect((await answer.json()) as unknown).toEqual({
      ok: true,
      result: { id, status: "revoked" },
    });

    const row = {
      class: "reserved",
      op: "agent-connections.disconnect",
      target_type: "agent-connections",
      target_id: id,
      user_id: String(ownerId),
      connection_id: id,
      key_label: "Claude",
      key_id: null,
    };
    expect(rowsAtChange).toEqual([
      { ...row, phase: "start", ok: null, code: null },
    ]);
    expect(await auditRows(id)).toEqual([
      { ...row, phase: "start", ok: null, code: null },
      { ...row, phase: "finish", ok: true, code: "OK" },
    ]);

    // The next request on that token answers the door's 401.
    const next = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...bearer(presented),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(next.status).toBe(401);
  });

  it("are on the ledger before a decision, and say when it was refused", async () => {
    const consent = armedConsent(subjectOf(ownerId));
    let rowsAtChange: unknown[] = [];
    stores.onChange.push(async () => {
      rowsAtChange = await auditRows(consent.interaction);
    });
    const denied = await rest(
      "agent-connections/consent",
      "POST",
      { cookie: ownerCookie },
      { ...consent, decision: "deny" },
    );
    expect(denied.status).toBe(200);
    const row = {
      class: "reserved",
      op: "agent-connections.deny",
      target_id: consent.interaction,
      user_id: String(ownerId),
      key_label: "Claude",
    };
    expect(rowsAtChange).toEqual([
      expect.objectContaining({ ...row, phase: "start", ok: null }),
    ]);
    expect(await auditRows(consent.interaction)).toEqual([
      expect.objectContaining({ ...row, phase: "start", ok: null }),
      expect.objectContaining({
        ...row,
        phase: "finish",
        ok: true,
        code: "OK",
      }),
    ]);

    // Another person's armed page: no decision, and the ledger says so.
    const theirs = armedConsent(subjectOf(otherOwnerId));
    const refused = await rest(
      "agent-connections/consent",
      "POST",
      { cookie: ownerCookie },
      { ...theirs, decision: "approve" },
    );
    expect(refused.status).toBe(400);
    expect(await auditRows(theirs.interaction)).toEqual([
      expect.objectContaining({
        op: "agent-connections.approve",
        phase: "start",
      }),
      expect.objectContaining({
        phase: "finish",
        ok: false,
        code: "CONSENT_NOT_DECIDABLE",
      }),
    ]);
    // A ticket never reaches a row.
    expect(JSON.stringify(await auditRows(theirs.interaction))).not.toContain(
      theirs.ticket,
    );
  });

  it("stop the change when the ledger cannot take them", async () => {
    const { id } = connect(subjectOf(ownerId));
    const create = vi
      .spyOn(payload, "create")
      .mockRejectedValueOnce(new Error("synthetic ledger failure"));
    try {
      const answer = await rest(
        "agent-connections/disconnect",
        "POST",
        { cookie: ownerCookie },
        { id },
      );
      expect(answer.status).toBe(500);
      expect((await answer.json()) as unknown).toEqual({
        ok: false,
        error: "CONSENT_UNAVAILABLE",
      });
    } finally {
      create.mockRestore();
    }
    expect(
      (stores.connections.get(id) as { connection: AgentConnection }).connection
        .status,
    ).toBe("authorized");
  });
});

describe("the list", () => {
  it("shows every live connection with who authorized it, and no client id", async () => {
    const mine = connect(subjectOf(ownerId));
    const theirs = connect(subjectOf(otherOwnerId));
    const gone = connect("payload-user-2000000000");
    const answer = await rest("agent-connections", "GET", {
      cookie: ownerCookie,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const { result } = (await answer.json()) as {
      result: {
        resource: string;
        connections: {
          id: string;
          tool: string;
          authorizedBy: string | null;
          mine: boolean;
        }[];
      };
    };
    expect(result.resource).toBe(RESOURCE);
    const of = (id: string) =>
      result.connections.find((entry) => entry.id === id);
    expect(of(mine.id)).toMatchObject({
      tool: "Claude",
      authorizedBy: email("owner"),
      mine: true,
    });
    expect(of(theirs.id)).toMatchObject({
      authorizedBy: email("other-owner"),
      mine: false,
    });
    expect(of(gone.id)).toMatchObject({ authorizedBy: null, mine: false });
    expect(JSON.stringify(result)).not.toContain(CLIENT_ID);
    // The seeded AI row is an account too, but it never authorized anything.
    expect(JSON.stringify(result)).not.toContain(ADMIN_MCP_OPERATOR_ROW_EMAIL);
  });
});

describe("an account's connections, through the real users hook", () => {
  /** A person of their own, so changing them disturbs no other test's session. */
  const newPerson = async () => {
    const name = `person-${randomBytes(6).toString("hex")}`;
    const { id } = await account(name, "owner");
    return { id, name, subject: subjectOf(id) };
  };
  const change = (id: number | string, data: Record<string, unknown>) =>
    rest(`users/${String(id)}`, "PATCH", { cookie: ownerCookie }, data);
  /** The next request on a token, as a tool makes it. */
  const doorStatus = async (presented: string) =>
    (
      await fetch(server.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...bearer(presented),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).status;
  const statusOf = (id: string) =>
    (stores.connections.get(id) as { connection: AgentConnection }).connection
      .status;

  it("stops a demoted person's token, and a restore does not bring it back", async () => {
    const person = await newPerson();
    const { id, presented } = connect(person.subject);
    const bystander = connect(subjectOf(otherOwnerId));
    expect(await doorStatus(presented)).toBe(200);

    expect((await change(person.id, { role: "automation" })).status).toBe(200);
    expect(await doorStatus(presented)).toBe(401);
    expect(statusOf(id)).toBe("revoked");

    expect((await change(person.id, { role: "owner" })).status).toBe(200);
    // Without the revoke this would answer 200: the door reads only the role.
    expect(await doorStatus(presented)).toBe(401);
    expect(statusOf(id)).toBe("revoked");
    // Only that person's: nobody else's connection moved.
    expect(await doorStatus(bystander.presented)).toBe(200);
    expect(statusOf(bystander.id)).toBe("authorized");
  });

  it("stops every connection of a person whose password changes, and nobody else's", async () => {
    const person = await newPerson();
    const first = connect(person.subject);
    const second = connect(person.subject);
    const bystander = connect(subjectOf(otherOwnerId));

    const answer = await change(person.id, {
      password: randomBytes(24).toString("hex"),
    });
    expect(answer.status).toBe(200);
    expect(await doorStatus(first.presented)).toBe(401);
    expect(await doorStatus(second.presented)).toBe(401);
    expect(statusOf(first.id)).toBe("revoked");
    expect(statusOf(second.id)).toBe("revoked");
    expect(await doorStatus(bystander.presented)).toBe(200);
  });

  it("stops each owner one bulk update demotes, on one request, and nobody else", async () => {
    // A local-API update by `where` is one request for every account it changes,
    // and Payload runs their hooks side by side. REST refuses it by disableBulkEdit.
    const first = await newPerson();
    const second = await newPerson();
    const { id: unchangedId } = await account(
      `automation-${randomBytes(6).toString("hex")}`,
      "automation",
    );
    const firstConnection = connect(first.subject);
    const secondConnection = connect(second.subject);
    const unchanged = connect(subjectOf(unchangedId));
    const bystander = connect(subjectOf(otherOwnerId));

    const changed = await payload.update({
      collection: "users",
      where: { id: { in: [first.id, second.id, unchangedId] } },
      data: { role: "automation" },
    });
    expect(changed.errors).toEqual([]);
    expect(changed.docs).toHaveLength(3);
    for (const { id, presented } of [firstConnection, secondConnection]) {
      expect(statusOf(id)).toBe("revoked");
      expect(await doorStatus(presented)).toBe(401);
    }
    // In the same request but never an owner, and outside it altogether.
    expect(statusOf(unchanged.id)).toBe("authorized");
    expect(statusOf(bystander.id)).toBe("authorized");
    expect(await doorStatus(bystander.presented)).toBe(200);
  });

  it("stops nothing on any other change", async () => {
    const person = await newPerson();
    const { id, presented } = connect(person.subject);
    stores.listedFor.length = 0;

    for (const data of [
      { scopeCatalogIds: ["catalog-synthetic-keeps"] },
      { role: "owner" },
      // What a form sends with the box left empty: Payload saves no password then.
      { password: "" },
    ]) {
      expect((await change(person.id, data)).status).toBe(200);
      expect(await doorStatus(presented)).toBe(200);
    }
    expect(statusOf(id)).toBe("authorized");
    expect(stores.listedFor).toEqual([]);
  });

  it("stops nothing when a role changes between two others", async () => {
    const { id: accountId } = await account(
      `automation-${randomBytes(6).toString("hex")}`,
      "automation",
    );
    connect(subjectOf(accountId));
    stores.listedFor.length = 0;
    expect((await change(accountId, { role: "ai_operator" })).status).toBe(200);
    expect(stores.listedFor).toEqual([]);
  });

  it("looks for nothing to stop when an account is created", async () => {
    stores.listedFor.length = 0;
    await account(`fresh-${randomBytes(6).toString("hex")}`, "owner");
    expect(stores.listedFor).toEqual([]);
  });

  it("stops another role's account too, when its password changes", async () => {
    // Left over from a revoke that failed: a password change still ends it, whatever
    // the role is now.
    const { id: accountId } = await account(
      `automation-${randomBytes(6).toString("hex")}`,
      "automation",
    );
    const { id } = connect(subjectOf(accountId));
    const answer = await change(accountId, {
      password: randomBytes(24).toString("hex"),
    });
    expect(answer.status).toBe(200);
    expect(statusOf(id)).toBe("revoked");
  });

  it.each([
    ["the connections cannot be read", { fault: "list" as const }],
    ["a connection cannot be written", { fault: "write" as const }],
    ["the consent runtime refused", { runtimeState: "refused" as const }],
  ])(
    "logs a category and still changes the password when %s",
    async (_case, broken) => {
      const person = await newPerson();
      const { id, presented } = connect(person.subject);
      const logged = vi.spyOn(payload.logger, "error");
      Object.assign(stores, broken);

      const next = randomBytes(24).toString("hex");
      const answer = await change(person.id, { password: next });
      Object.assign(stores, { fault: null, runtimeState: "built" });

      expect(answer.status).toBe(200);
      const login = await fetch(`${server.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email(person.name), password: next }),
      });
      expect(login.status).toBe(200);
      expect(logged.mock.calls).toEqual([
        [{ category: "AGENT_CONNECTION_REVOKE_FAILED" }],
      ]);
      // The connection stays until someone disconnects it.
      expect(statusOf(id)).toBe("authorized");
      expect(await doorStatus(presented)).toBe(200);
      const disconnected = await rest(
        "agent-connections/disconnect",
        "POST",
        { cookie: ownerCookie },
        { id },
      );
      expect(disconnected.status).toBe(200);
      expect(await doorStatus(presented)).toBe(401);
    },
  );

  it("leaves the restored window open when the revoke failed, which the record states", async () => {
    const person = await newPerson();
    const { id, presented } = connect(person.subject);
    const logged = vi.spyOn(payload.logger, "error");
    stores.fault = "list";

    expect((await change(person.id, { role: "automation" })).status).toBe(200);
    stores.fault = null;
    expect(logged.mock.calls).toEqual([
      [{ category: "AGENT_CONNECTION_REVOKE_FAILED" }],
    ]);
    // Refused while demoted, by the door's own read of the role.
    expect(await doorStatus(presented)).toBe(401);
    expect(statusOf(id)).toBe("authorized");

    expect((await change(person.id, { role: "owner" })).status).toBe(200);
    expect(await doorStatus(presented)).toBe(200);
  });

  it("revokes nothing for a change that could not be recorded", async () => {
    const person = await newPerson();
    const { id, presented } = connect(person.subject);
    const create = vi
      .spyOn(payload, "create")
      .mockRejectedValueOnce(new Error("synthetic ledger failure"));
    const answer = await change(person.id, { role: "automation" });
    create.mockRestore();
    expect(answer.status).toBe(503);
    expect(statusOf(id)).toBe("authorized");
    expect(await doorStatus(presented)).toBe(200);
  });

  it.each([
    ["with the door off", () => void (stores.runtimeState = "off")],
    [
      "under the Development read-only profile",
      () => void (stores.runtime.preset = "read-only"),
    ],
  ])("revokes nothing %s", async (_case, arrange) => {
    const person = await newPerson();
    const { id } = connect(person.subject);
    const logged = vi.spyOn(payload.logger, "error");
    stores.listedFor.length = 0;
    arrange();

    const answer = await change(person.id, {
      password: randomBytes(24).toString("hex"),
    });
    expect(answer.status).toBe(200);
    expect(stores.listedFor).toEqual([]);
    expect(statusOf(id)).toBe("authorized");
    expect(logged).not.toHaveBeenCalled();
  });
});
