import { randomBytes, randomUUID } from "node:crypto";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";

import { approveBatch, ownerDraftPage, saveDraft } from "admin/editorial";
import { approveArticleBatch, saveArticleDraft } from "admin/editorial-content";

import { syntheticCatalogDraft } from "./admin-mcp-wire.js";

// Behavior Matrix rows "Reserved surface by any key or Authorization header",
// "JWT or REST key on the ai_operator row", the bulk edit half of "Approval
// duplicate, bulk edit of accounts or keys" and "Create or approve an approval
// batch under an AI key", driven through Payload's real REST handler on the
// synthetic database. An AI key reaches its requests through the MCP door, which
// sets the strategy on req.user, so here it is a local request carrying the same.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const run = randomUUID();
const email = (name: string) => `${name}-${run}@example.invalid`;
const password = randomBytes(24).toString("hex");
const ownerRestKey = randomBytes(32).toString("hex");
const automationRestKey = randomBytes(32).toString("hex");
const staleRestKey = randomBytes(32).toString("hex");
const aiMcpKey = randomBytes(32).toString("hex");
const automationMcpKey = randomBytes(32).toString("hex");
const ORIGIN = "http://localhost";

let config: SanitizedConfig;
let payload: Payload;
let owner: TypedUser;
let automation: TypedUser;
let aiOperator: TypedUser;
let staleRow: TypedUser;
let ownerToken: string;
let aiOperatorJwt: string;
let aiKeyId: number;

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

const login = async (account: string) => {
  const response = await call("users/login", {
    method: "POST",
    body: { email: account, password },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
};

const browser = () => ({ cookie: `payload-token=${ownerToken}` });
const refusedCredentials = () =>
  [
    ["Authorization JWT with the Owner token", `JWT ${ownerToken}`],
    ["Authorization Bearer with the Owner token", `Bearer ${ownerToken}`],
    ["Owner REST key", `users API-Key ${ownerRestKey}`],
    ["automation REST key", `users API-Key ${automationRestKey}`],
    ["JWT on the ai_operator row", `JWT ${aiOperatorJwt}`],
    ["REST key on an ai_operator row", `users API-Key ${staleRestKey}`],
    ["MCP key sent as a bearer", `Bearer ${randomBytes(32).toString("hex")}`],
  ] as const;

const aiRequest = () =>
  createLocalReq(
    {
      user: {
        ...aiOperator,
        collection: "users",
        _strategy: "mcp-api-key",
      } as unknown as TypedUser,
    },
    payload,
  );

const catalogDraft = (suffix: string) =>
  syntheticCatalogDraft(`identity-${run}-${suffix}`, `source-${run}-${suffix}`);

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (name: string, role: "owner" | "automation", extra = {}) =>
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
    scopeCatalogIds: [`identity-${run}-approve`, `identity-${run}-owner-rest`],
  });
  // Tokens outlive a role change, which is how a JWT can sit on this row.
  aiOperator = await account("ai", "automation");
  aiOperatorJwt = await login(email("ai"));
  aiOperator = await payload.update({
    collection: "users",
    id: aiOperator.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  // A row that held a REST key before the role changed bypasses the hook only
  // by writing straight to the database, the way a bad import could.
  staleRow = await account("stale", "automation", {
    enableAPIKey: true,
    apiKey: staleRestKey,
  });
  await payload.db.updateOne({
    collection: "users",
    id: staleRow.id,
    data: { role: "ai_operator" },
  });
  ownerToken = await login(email("owner"));
  const mcpKey = (user: TypedUser, apiKey: string) =>
    payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: user.id,
        label: `synthetic-${randomUUID()}`,
        enableAPIKey: true,
        apiKey,
      } as never,
    });
  aiKeyId = (await mcpKey(aiOperator, aiMcpKey)).id;
  await mcpKey(automation, automationMcpKey);
});

afterAll(async () => {
  await payload?.db?.destroy?.();
});

describe("Admin accounts and keys as reserved surfaces", () => {
  it("lets only the Owner browser session list every account", async () => {
    const seen = await call("users?limit=100", { headers: browser() });
    expect(seen.status).toBe(200);
    expect(
      ((await seen.json()) as { docs: { id: number }[] }).docs.map(
        ({ id }) => id,
      ),
    ).toEqual(expect.arrayContaining([owner.id, automation.id, aiOperator.id]));

    for (const authorization of [
      `JWT ${ownerToken}`,
      `Bearer ${ownerToken}`,
      `users API-Key ${ownerRestKey}`,
    ]) {
      const narrowed = await call("users?limit=100", {
        headers: { authorization },
      });
      expect(narrowed.status).toBe(200);
      expect(
        ((await narrowed.json()) as { docs: { id: number }[] }).docs.map(
          ({ id }) => id,
        ),
      ).toEqual([owner.id]);
      expect(
        (await call(`users/${automation.id}`, { headers: { authorization } }))
          .status,
      ).toBeGreaterThanOrEqual(403);
    }
    for (const [label, authorization] of refusedCredentials().slice(3)) {
      const refused = await call("users?limit=100", {
        headers: { authorization },
      });
      expect([label, refused.status]).toEqual([label, 403]);
    }
    expect((await call("users?limit=100")).status).toBe(403);
  });

  it("keeps /api/users/me for every Owner credential, and nothing for an ai_operator row", async () => {
    for (const [strategy, headers] of [
      ["local-jwt", browser()],
      ["local-jwt", { authorization: `JWT ${ownerToken}` }],
      ["local-jwt", { authorization: `Bearer ${ownerToken}` }],
      ["api-key", { authorization: `users API-Key ${ownerRestKey}` }],
    ] as const) {
      const response = await call("users/me", { headers });
      expect(response.status).toBe(200);
      const me = (await response.json()) as {
        strategy: string;
        user: { id: number };
      };
      expect(me.user.id).toBe(owner.id);
      // The runtime values behind the text pin in the architecture test.
      expect(me.strategy).toBe(strategy);
    }
    for (const authorization of [
      `JWT ${aiOperatorJwt}`,
      `users API-Key ${staleRestKey}`,
    ])
      expect(
        (await call("users/me", { headers: { authorization } })).status,
      ).toBe(403);
  });

  it("refuses every account write except from the browser session", async () => {
    for (const [label, authorization] of refusedCredentials()) {
      const headers = { authorization };
      const created = await call("users", {
        method: "POST",
        headers,
        body: {
          email: email(`refused-${randomUUID()}`),
          password,
          role: "automation",
          scopeCatalogIds: [],
        },
      });
      expect([label, "create", created.status]).toEqual([label, "create", 403]);
      const updated = await call(`users/${automation.id}`, {
        method: "PATCH",
        headers,
        body: { scopeCatalogIds: [`refused-${run}`] },
      });
      expect([label, "update", updated.status]).toEqual([label, "update", 403]);
      const unlocked = await call("users/unlock", {
        method: "POST",
        headers,
        body: { email: email("automation") },
      });
      expect([label, "unlock", unlocked.status]).toEqual([
        label,
        "unlock",
        403,
      ]);
    }
    const created = await call("users", {
      method: "POST",
      headers: browser(),
      body: {
        email: email("by-browser"),
        password,
        role: "automation",
        scopeCatalogIds: [],
      },
    });
    expect(created.status).toBe(201);
    const single = await call(`users/${automation.id}`, {
      method: "PATCH",
      headers: browser(),
      body: { agentPrincipal: "agent-synthetic" },
    });
    expect(single.status).toBe(200);
    const unlocked = await call("users/unlock", {
      method: "POST",
      headers: browser(),
      body: { email: email("automation") },
    });
    expect(unlocked.status).toBe(200);
  });

  it("refuses every key operation except from the browser session", async () => {
    const body = (user: unknown) => ({
      user,
      label: `synthetic-${randomUUID()}`,
    });
    for (const [label, authorization] of refusedCredentials()) {
      const headers = { authorization };
      expect([
        label,
        (await call("payload-mcp-api-keys", { headers })).status,
      ]).toEqual([label, 403]);
      expect([
        label,
        (
          await call("payload-mcp-api-keys", {
            method: "POST",
            headers,
            body: body(automation.id),
          })
        ).status,
      ]).toEqual([label, 403]);
    }
    const created = await call("payload-mcp-api-keys", {
      method: "POST",
      headers: browser(),
      body: body(aiOperator.id),
    });
    expect(created.status).toBe(201);
    const key = ((await created.json()) as { doc: { id: number } }).doc;
    for (const [label, authorization] of refusedCredentials()) {
      const updated = await call(`payload-mcp-api-keys/${key.id}`, {
        method: "PATCH",
        headers: { authorization },
        body: { label: "changed" },
      });
      expect([label, updated.status]).toEqual([label, 403]);
    }
    expect(
      (await call("payload-mcp-api-keys", { headers: browser() })).status,
    ).toBe(200);
    expect(
      (
        await call(`payload-mcp-api-keys/${key.id}`, {
          method: "DELETE",
          headers: browser(),
        })
      ).status,
    ).toBe(403);
  });

  it("binds a key only to ai_operator or automation, named by the Owner", async () => {
    const create = (user?: unknown) =>
      call("payload-mcp-api-keys", {
        method: "POST",
        headers: browser(),
        body: { label: `synthetic-${randomUUID()}`, user },
      });
    expect((await create(owner.id)).status).toBe(400);
    expect((await create()).status).toBe(400);
    expect((await create(automation.id)).status).toBe(201);
    expect((await create(aiOperator.id)).status).toBe(201);
  });

  it("keeps an earlier Owner-bound key editable so the Owner can disable it", async () => {
    const legacy = await payload.db.create({
      collection: "payload-mcp-api-keys",
      data: {
        user: owner.id,
        label: "synthetic-owner-bound",
        enableAPIKey: true,
      },
    });
    const disabled = await call(`payload-mcp-api-keys/${String(legacy.id)}`, {
      method: "PATCH",
      headers: browser(),
      body: { enableAPIKey: false },
    });
    expect(disabled.status).toBe(200);
    expect(
      ((await disabled.json()) as { doc: { enableAPIKey: boolean } }).doc
        .enableAPIKey,
    ).toBe(false);
  });

  it("refuses bulk edit of accounts and keys for every caller, the Owner session included", async () => {
    const where = `where[id][equals]=${String(automation.id)}`;
    for (const collection of ["users", "payload-mcp-api-keys"]) {
      for (const headers of [
        browser(),
        { authorization: `JWT ${ownerToken}` },
        { authorization: `users API-Key ${ownerRestKey}` },
      ]) {
        const response = await call(`${collection}?${where}`, {
          method: "PATCH",
          headers,
          body: { label: "bulk" },
        });
        expect([collection, response.status]).toEqual([collection, 403]);
      }
    }
  });

  it("refuses a password login on an ai_operator row like any wrong password", async () => {
    const correct = await call("users/login", {
      method: "POST",
      body: { email: email("ai"), password },
    });
    const wrong = await call("users/login", {
      method: "POST",
      body: { email: email("ai"), password: `${password}x` },
    });
    expect(correct.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await correct.json()).toEqual(await wrong.json());
    await payload.db.updateOne({
      collection: "users",
      id: aiOperator.id,
      data: { loginAttempts: 0, lockUntil: null },
    });
  });

  it("refuses a REST key on an ai_operator row at create and update", async () => {
    const create = await call("users", {
      method: "POST",
      headers: browser(),
      body: {
        email: email("ai-with-key"),
        password,
        role: "ai_operator",
        scopeCatalogIds: [],
        enableAPIKey: true,
        apiKey: randomBytes(32).toString("hex"),
      },
    });
    expect(create.status).toBe(400);
    expect(JSON.stringify(await create.json())).toContain(
      "AI_OPERATOR_REST_KEY_REFUSED",
    );
    const update = await call(`users/${aiOperator.id}`, {
      method: "PATCH",
      headers: browser(),
      body: { enableAPIKey: true, apiKey: randomBytes(32).toString("hex") },
    });
    expect(update.status).toBe(400);
    const promote = await call(`users/${automation.id}`, {
      method: "PATCH",
      headers: browser(),
      body: { role: "ai_operator" },
    });
    expect(promote.status).toBe(400);
  });
});

describe("the reserved surface matrix", () => {
  /** Every credential the Matrix names, plus the same keys in other schemes. */
  const credentials = () =>
    [
      ["no credential", {}],
      ["an AI MCP key", { authorization: `Bearer ${aiMcpKey}` }],
      [
        "an AI MCP key as a REST key on users",
        { authorization: `users API-Key ${aiMcpKey}` },
      ],
      [
        "an AI MCP key as a REST key on its own collection",
        { authorization: `payload-mcp-api-keys API-Key ${aiMcpKey}` },
      ],
      [
        "an automation MCP key",
        { authorization: `Bearer ${automationMcpKey}` },
      ],
      [
        "an automation MCP key as a REST key on its own collection",
        { authorization: `payload-mcp-api-keys API-Key ${automationMcpKey}` },
      ],
      ["an Owner REST key", { authorization: `users API-Key ${ownerRestKey}` }],
      [
        "an automation REST key",
        { authorization: `users API-Key ${automationRestKey}` },
      ],
      [
        "a REST key on an ai_operator row",
        { authorization: `users API-Key ${staleRestKey}` },
      ],
      ["an ai_operator JWT", { authorization: `JWT ${aiOperatorJwt}` }],
      [
        "an ai_operator JWT as a cookie",
        { cookie: `payload-token=${aiOperatorJwt}` },
      ],
      ["an Authorization JWT", { authorization: `JWT ${ownerToken}` }],
      ["an Authorization Bearer", { authorization: `Bearer ${ownerToken}` }],
      [
        "the Owner cookie beside an MCP key",
        { ...browser(), authorization: `Bearer ${aiMcpKey}` },
      ],
      // Valid twice over, so only the rule on the header itself can refuse them.
      [
        "the Owner cookie beside an Authorization JWT",
        { ...browser(), authorization: `JWT ${ownerToken}` },
      ],
      [
        "the Owner cookie beside an Authorization Bearer",
        { ...browser(), authorization: `Bearer ${ownerToken}` },
      ],
    ] as const;

  /** Every reserved surface in S1, with the answer the Owner session gets. */
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

  it("refuses every other credential on every surface", async () => {
    for (const [label, headers] of credentials())
      for (const [method, route, body] of surfaces()) {
        const answer = await call(route, {
          method,
          headers: { ...headers, origin: ORIGIN },
          ...(body === undefined ? {} : { body }),
        });
        // An Owner credential reads its own row, so another row is simply absent.
        const refused =
          route.startsWith("users/") && method === "GET" ? [403, 404] : [403];
        expect(
          [label, method, route, refused.includes(answer.status)],
          String(answer.status),
        ).toEqual([label, method, route, true]);
      }
  });

  it("lets the Owner cookie session through every surface, as the positive control", async () => {
    for (const [method, route, body, status] of surfaces()) {
      const answer = await call(route, {
        method,
        headers: { ...browser(), origin: ORIGIN },
        ...(body === undefined ? {} : { body }),
      });
      expect([method, route, answer.status]).toEqual([method, route, status]);
    }
  });

  describe("Payload's auth routes on the key collection", () => {
    const db = () =>
      (payload.db as unknown as Pick<PostgresAdapter, "drizzle">).drizzle;
    // Every value a read of a key row could give away.
    const leaks = (text: string, secrets: readonly string[]) =>
      secrets.some((value) => text.includes(value)) ||
      /"apiKey(Index)?"\s*:/u.test(text);

    /**
     * A key row whose id equals the caller's users.id, the one precondition of the
     * read: both ids are serials, so on a real database this overlap is normal. It
     * is forced here by moving a fresh row of each table past both sequences.
     */
    const alignedAccount = async (
      role: "owner" | "automation",
      keySecret: string,
    ) => {
      const created = await payload.create({
        collection: "users",
        overrideAccess: true,
        data: {
          email: email(`aligned-${randomUUID()}`),
          password,
          role,
          scopeCatalogIds: [],
        },
      });
      const key = await payload.create({
        collection: "payload-mcp-api-keys",
        overrideAccess: true,
        data: {
          user: aiOperator.id,
          label: `synthetic-${randomUUID()}`,
          enableAPIKey: true,
          apiKey: keySecret,
        } as never,
      });
      const { rows } = await db().execute(sql`
        SELECT greatest(
          (SELECT max(id) FROM users), (SELECT max(id) FROM payload_mcp_api_keys)
        ) + 1 AS id`);
      const id = Number(rows[0]!.id);
      await db().execute(
        sql`UPDATE users SET id = ${id} WHERE id = ${created.id}`,
      );
      await db().execute(
        sql`UPDATE payload_mcp_api_keys SET id = ${id} WHERE id = ${key.id}`,
      );
      // Past the moved rows, so a later row in either table cannot collide.
      await db().execute(sql`SELECT setval('users_id_seq', ${id})`);
      await db().execute(
        sql`SELECT setval('payload_mcp_api_keys_id_seq', ${id})`,
      );
      return { ...created, id };
    };

    const alignedCredentials = async () => {
      const ownerSecret = randomBytes(32).toString("hex");
      const automationSecret = randomBytes(32).toString("hex");
      const alignedOwner = await alignedAccount("owner", ownerSecret);
      const alignedAutomation = await alignedAccount(
        "automation",
        automationSecret,
      );
      const restKey = (account: { id: number }) => {
        const value = randomBytes(32).toString("hex");
        return payload
          .update({
            collection: "users",
            id: account.id,
            overrideAccess: true,
            data: { enableAPIKey: true, apiKey: value },
          })
          .then(() => value);
      };
      const token = await login(alignedOwner.email);
      return {
        secrets: [ownerSecret, automationSecret],
        owner: alignedOwner,
        credentials: [
          [
            "an automation REST key on the matching id",
            {
              authorization: `users API-Key ${await restKey(alignedAutomation)}`,
            },
          ],
          [
            "an Owner REST key on the matching id",
            { authorization: `users API-Key ${await restKey(alignedOwner)}` },
          ],
          [
            "an Owner JWT in a header on the matching id",
            { authorization: `JWT ${token}` },
          ],
          [
            "an Owner Bearer in a header on the matching id",
            { authorization: `Bearer ${token}` },
          ],
          [
            "an Owner cookie session on the matching id",
            { cookie: `payload-token=${token}` },
          ],
          ["no credential", {}],
        ] as const,
      };
    };

    it("answers refresh-token with no key for any credential, the Owner session included", async () => {
      const { secrets, credentials } = await alignedCredentials();
      for (const [label, headers] of [
        ...credentials,
        ...refusedCredentials().map(
          ([name, authorization]) => [name, { authorization }] as const,
        ),
      ])
        for (const route of [
          "payload-mcp-api-keys/refresh-token",
          "payload-mcp-api-keys/REFRESH-TOKEN",
        ]) {
          const answer = await call(route, { method: "POST", headers });
          expect([label, route, answer.status]).toEqual([label, route, 403]);
          expect(answer.headers.get("set-cookie")).toBeNull();
          const text = await answer.text();
          expect([label, route, leaks(text, secrets)]).toEqual([
            label,
            route,
            false,
          ]);
          expect(JSON.parse(text)).toEqual({ error: "RESERVED_SURFACE" });
        }
    });

    it("keeps every other auth route from returning a row or a key", async () => {
      const { secrets, credentials } = await alignedCredentials();
      const routes = [
        ["POST", "login", { email: email("owner"), password }],
        ["POST", "logout", {}],
        ["POST", "first-register", { email: email("first"), password }],
        ["POST", "forgot-password", { email: email("owner") }],
        ["POST", "reset-password", { token: "synthetic", password }],
        ["POST", "unlock", { email: email("owner") }],
        ["POST", "verify/synthetic", {}],
        ["GET", "me", undefined],
        ["GET", "init", undefined],
      ] as const;
      for (const [label, headers] of credentials)
        for (const [method, route, body] of routes) {
          const answer = await call(`payload-mcp-api-keys/${route}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
          });
          const text = await answer.text();
          expect([label, route, leaks(text, secrets)]).toEqual([
            label,
            route,
            false,
          ]);
          // `me` reads as no user and `init` as one boolean; the rest refuse.
          if (route === "me")
            expect(JSON.parse(text) as unknown).toMatchObject({ user: null });
          else if (route === "init")
            expect(Object.keys(JSON.parse(text) as object)).toEqual([
              "initialized",
            ]);
          else
            expect([label, route, answer.status >= 400]).toEqual([
              label,
              route,
              true,
            ]);
        }
    });

    it("keeps the document routes from answering a key to anything but the Owner session", async () => {
      const { secrets, credentials } = await alignedCredentials();
      const key = await payload.find({
        collection: "payload-mcp-api-keys",
        overrideAccess: true,
        depth: 0,
        limit: 1,
        sort: "-id",
      });
      const id = key.docs[0]!.id;
      const session = "an Owner cookie session on the matching id";
      for (const [label, headers] of credentials) {
        if (label === session) continue;
        for (const [method, route, body] of [
          ["GET", "", undefined],
          ["GET", "count", undefined],
          ["GET", String(id), undefined],
          ["GET", "versions", undefined],
          ["GET", `versions/${id}`, undefined],
          ["POST", `versions/${id}`, {}],
          ["POST", `${id}/duplicate`, {}],
          ["POST", `access/${id}`, {}],
        ] as const) {
          const answer = await call(`payload-mcp-api-keys/${route}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
          });
          const text = await answer.text();
          expect([label, method, route, leaks(text, secrets)]).toEqual([
            label,
            method,
            route,
            false,
          ]);
          // The one answer that is not a refusal is a list of booleans.
          if (route !== `access/${id}`)
            expect([label, method, route, answer.status >= 400]).toEqual([
              label,
              method,
              route,
              true,
            ]);
        }
      }
    });

    it("has reviewed every route this collection carries, so an upgrade adding one fails here", () => {
      const keys = config.collections.find(
        ({ slug }) => slug === "payload-mcp-api-keys",
      );
      expect(
        (keys?.endpoints === false ? [] : (keys?.endpoints ?? [])).map(
          ({ method, path }) => `${method} ${path}`,
        ),
      ).toEqual([
        // The shadow first, because the first match wins.
        "post /refresh-token",
        "post /forgot-password",
        "get /init",
        "post /login",
        "post /logout",
        "get /me",
        "post /refresh-token",
        "post /first-register",
        "post /reset-password",
        "post /unlock",
        "post /verify/:id",
        // Payload's document routes, each behind this collection's access.
        "get /count",
        "post /",
        "delete /",
        "delete /:id",
        "post /access/:id?",
        "get /versions",
        "post /:id/duplicate",
        "get /",
        "get /:id",
        "get /versions/:id",
        "post /versions/:id",
        "patch /",
        "patch /:id",
      ]);
    });

    it("leaves the same route on the users collection as it is today", async () => {
      const { owner: account } = await alignedCredentials();
      const token = await login(account.email);
      for (const [label, headers] of [
        ["a cookie session", { cookie: `payload-token=${token}` }],
        ["a JWT in a header", { authorization: `JWT ${token}` }],
      ] as const) {
        const answer = await call("users/refresh-token", {
          method: "POST",
          headers,
        });
        expect([label, answer.status]).toEqual([label, 200]);
        const body = (await answer.json()) as {
          user: { id: number };
          refreshedToken: string;
        };
        expect(body.user.id).toBe(account.id);
        expect(body.refreshedToken).toEqual(expect.any(String));
      }
      for (const [label, headers] of [
        [
          "an Owner REST key",
          { authorization: `users API-Key ${ownerRestKey}` },
        ],
        [
          "an automation REST key",
          { authorization: `users API-Key ${automationRestKey}` },
        ],
        ["no credential", {}],
      ] as const) {
        const answer = await call("users/refresh-token", {
          method: "POST",
          headers,
        });
        expect([label, answer.status]).toEqual([label, 403]);
      }
    });
  });

  it("leaves an MCP key with no account of its own to read", async () => {
    for (const authorization of [
      `Bearer ${aiMcpKey}`,
      `users API-Key ${aiMcpKey}`,
      `payload-mcp-api-keys API-Key ${aiMcpKey}`,
    ]) {
      const me = await call("users/me", { headers: { authorization } });
      expect(
        me.status === 403 ||
          ((await me.json()) as { user: unknown }).user === null,
        authorization.split(" ")[0],
      ).toBe(true);
    }
  });
});

describe("AI and Owner REST credentials after accounts narrowed", () => {
  it("approves a Catalog batch under an AI key and under an Owner REST key", async () => {
    const save = (suffix: string) =>
      createLocalReq({ user: automation }, payload).then((req) =>
        saveDraft(req, {
          idempotencyKey: `${run}:${suffix}`,
          content: catalogDraft(suffix),
        }),
      );
    const draft = await save("approve");
    const approval = await approveBatch(await aiRequest(), {
      automationUserId: automation.id,
      items: [{ id: draft.id, revision: draft.revision }],
    });
    const row = await payload.findByID({
      collection: "editorial-approvals",
      id: approval.approvalId,
      depth: 0,
      overrideAccess: true,
    });
    expect(row.approvedBy).toBe(aiOperator.id);
    expect(row.automationUser).toBe(automation.id);

    const second = await save("owner-rest");
    const response = await call("editorial/approve-batch", {
      method: "POST",
      headers: { authorization: `users API-Key ${ownerRestKey}` },
      body: {
        automationUserId: automation.id,
        items: [{ id: second.id, revision: second.revision }],
      },
    });
    expect(response.status).toBe(200);
  });

  it("keeps an approval on an account outside the Catalog scope refused", async () => {
    const req = await createLocalReq({ user: owner }, payload);
    const draft = await saveDraft(req, {
      idempotencyKey: `${run}:outside-scope`,
      content: catalogDraft("outside-scope"),
    });
    await expect(
      approveBatch(await aiRequest(), {
        automationUserId: automation.id,
        items: [{ id: draft.id, revision: draft.revision }],
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
  });

  it("approves only automation accounts, for AI as for the Owner", async () => {
    const draft = await saveDraft(await aiRequest(), {
      idempotencyKey: `${run}:not-automation`,
      content: catalogDraft("not-automation"),
    });
    await expect(
      approveBatch(await aiRequest(), {
        automationUserId: aiOperator.id,
        items: [{ id: draft.id, revision: draft.revision }],
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_ACCOUNT_INVALID" });
  });

  it("approves an Article batch and lists owner drafts under an AI key", async () => {
    const article = await saveArticleDraft(await aiRequest(), {
      idempotencyKey: `${run}:article`,
      content: {
        presentation: "news",
        title: `Synthetic article ${run}`,
        summary: "Synthetic summary",
        section: "Synthetic",
        byline: "Synthetic",
        sections: [{ body: "Synthetic body" }],
        citations: [],
      },
    });
    const approval = await approveArticleBatch(await aiRequest(), {
      automationUserId: automation.id,
      items: [{ id: article.id, revision: article.revision }],
    });
    expect(approval.approvalId).toBeDefined();
    const page = await ownerDraftPage(await aiRequest(), {
      page: 1,
      pageSize: 10,
    });
    expect(page.docs.length).toBeGreaterThan(0);
    for (const account of page.automationUsers)
      expect(Object.keys(account).sort()).toEqual(["id", "label"]);
  });

  it("gives an ai_operator JWT or REST key none of the Owner's editorial authority", async () => {
    for (const authorization of [
      `JWT ${aiOperatorJwt}`,
      `users API-Key ${staleRestKey}`,
    ]) {
      const response = await call("editorial/owner-drafts", {
        method: "POST",
        headers: { authorization },
        body: { page: 1, pageSize: 10 },
      });
      expect(response.status).toBe(403);
    }
  });
});
