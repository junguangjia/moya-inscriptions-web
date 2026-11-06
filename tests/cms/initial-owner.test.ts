import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  buildConfig,
  getPayload,
  handleEndpoints,
  type Payload,
} from "payload";
import { postgresAdapter } from "@payloadcms/db-postgres";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { ADMIN_MCP_OPERATOR_ROW_EMAIL } from "@moya/contracts/internal/admin-mcp";
import { McpAuditEvents } from "admin/admin-mcp";
import { Users, initialUserEndpoints } from "admin/users";
import { provisionInitialOwner } from "admin/initial-owner";
import { assertInitialOwnerDatabaseTLS } from "admin/runtime-settings";
import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database";

const source = process.env.CMS_TEST_DATABASE_URL;
if (process.env.CMS_ENVIRONMENT !== "synthetic" || !source)
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");
assertSyntheticTestDatabaseUrl(source);
const admin = createPostgresPool(parsePostgresConfig({ DATABASE_URL: source }));
const database = `initial_owner_${randomBytes(6).toString("hex")}_cms_test`;
const target = new URL(source);
target.pathname = `/${database}`;
assertSyntheticTestDatabaseUrl(target.toString());
const ownerPassword = randomBytes(24).toString("hex");
let payload: Payload;
const nativePool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: target.toString() }),
);
const adapter = postgresAdapter({
  pool: { connectionString: target.toString() },
  push: true,
});
const config = buildConfig({
  secret: randomBytes(32).toString("hex"),
  db: {
    ...adapter,
    init(args) {
      // Own the test pool explicitly. The installed adapter retains a
      // reconnect client and destroy() does not close that pool.
      const db = adapter.init(args);
      db.pool = nativePool;
      return db;
    },
  },
  // Account changes are recorded in the audit ledger, so the two travel together.
  collections: [
    { ...Users, endpoints: initialUserEndpoints("production") },
    McpAuditEvents,
  ],
  graphQL: { disable: true },
});
// What the migrations leave on a new install. This target is pushed from the config
// with no migrations, so the row goes in here, by the migration's own statement.
const seedOperatorRow = () =>
  nativePool.query(
    `INSERT INTO "users" ("role", "email") VALUES ('ai_operator', '${ADMIN_MCP_OPERATOR_ROW_EMAIL}') ON CONFLICT ("email") DO NOTHING`,
  );
const allAccounts = async () =>
  (await payload.count({ collection: "users", overrideAccess: true }))
    .totalDocs;
const accountsBesideTheOperatorRow = async () => (await allAccounts()) - 1;
const provision = () =>
  provisionInitialOwner(payload, {
    email: "synthetic-owner@example.invalid",
    password: ownerPassword,
  });
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  payload = await getPayload({ config, key: database });
  await seedOperatorRow();
});
afterAll(async () => {
  await payload?.destroy();
  await nativePool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.end();
});
it("denies native public bootstrap on an empty target, serializes operator setup, and permits native Owner login", async () => {
  const request = () =>
    new Request("http://localhost/api/users/first-register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "synthetic-owner@example.invalid",
        password: ownerPassword,
      }),
    });
  const denied = await handleEndpoints({
    config,
    payloadInstanceCacheKey: database,
    request: request(),
  });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("set-cookie")).toBeNull();
  expect(await accountsBesideTheOperatorRow()).toBe(0);
  const results = await Promise.allSettled([provision(), provision()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await accountsBesideTheOperatorRow()).toBe(1);
  const logged = await payload.login({
    collection: "users",
    data: { email: "synthetic-owner@example.invalid", password: ownerPassword },
  });
  expect(logged.user?.role).toBe("owner");
  expect(logged.token).toEqual(expect.any(String));
  await expect(
    provisionInitialOwner(payload, {
      email: "other-owner@example.invalid",
      password: ownerPassword,
    }),
  ).rejects.toThrow("INITIAL_OWNER_ALREADY_EXISTS");
  await expect(
    payload.create({
      collection: "users",
      overrideAccess: false,
      data: {
        email: "anonymous@example.invalid",
        password: ownerPassword,
        role: "owner",
      },
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(initialUserEndpoints("synthetic")).toEqual([]);
});

it("refuses on every account but the seeded row itself", async () => {
  const start = async () => {
    await nativePool.query(`DELETE FROM "users"`);
    await seedOperatorRow();
  };
  const insert = (email: string, role: string) =>
    nativePool.query(`INSERT INTO "users" ("role", "email") VALUES ($1, $2)`, [
      role,
      email,
    ]);
  for (const [label, arrange] of [
    ["an automation account", () => insert("a@example.invalid", "automation")],
    ["another ai_operator", () => insert("b@example.invalid", "ai_operator")],
    ["another Owner", () => insert("c@example.invalid", "owner")],
    [
      "the seeded address moved to the Owner role",
      () =>
        nativePool.query(
          `UPDATE "users" SET "role" = 'owner' WHERE "email" = $1`,
          [ADMIN_MCP_OPERATOR_ROW_EMAIL],
        ),
    ],
    [
      "the seeded address moved to the automation role",
      () =>
        nativePool.query(
          `UPDATE "users" SET "role" = 'automation' WHERE "email" = $1`,
          [ADMIN_MCP_OPERATOR_ROW_EMAIL],
        ),
    ],
    [
      "the seeded row renamed",
      () =>
        nativePool.query(`UPDATE "users" SET "email" = $1 WHERE "email" = $2`, [
          "renamed@example.invalid",
          ADMIN_MCP_OPERATOR_ROW_EMAIL,
        ]),
    ],
  ] as const) {
    await start();
    await arrange();
    await expect(provision(), label).rejects.toThrow(
      "INITIAL_OWNER_ALREADY_EXISTS",
    );
  }
  // And with nothing beside it, on a target with no seed at all as well.
  await nativePool.query(`DELETE FROM "users"`);
  expect(await allAccounts()).toBe(0);
  await expect(provision()).resolves.toMatchObject({ id: expect.anything() });
});

it("lets nobody sign in with the seeded row, whatever password is tried", async () => {
  await seedOperatorRow();
  const { rows } = await nativePool.query<{
    role: string;
    salt: string | null;
    hash: string | null;
    enable_a_p_i_key: boolean | null;
  }>(
    `SELECT "role", "salt", "hash", "enable_a_p_i_key" FROM "users" WHERE "email" = $1`,
    [ADMIN_MCP_OPERATOR_ROW_EMAIL],
  );
  expect(rows).toEqual([
    { role: "ai_operator", salt: null, hash: null, enable_a_p_i_key: null },
  ]);
  for (const password of [ownerPassword, "", "null", "undefined"]) {
    await expect(
      payload.login({
        collection: "users",
        data: { email: ADMIN_MCP_OPERATOR_ROW_EMAIL, password },
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    const answer = await handleEndpoints({
      config,
      payloadInstanceCacheKey: database,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ADMIN_MCP_OPERATOR_ROW_EMAIL, password }),
      }),
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    expect(answer.headers.get("set-cookie")).toBeNull();
  }
});

it("requires verified Production TLS before initial Owner setup loads Payload", () => {
  for (const query of [
    "",
    "?sslmode=disable",
    "?sslmode=require",
    "?sslmode=verify-full&sslmode=disable",
  ]) {
    expect(() =>
      assertInitialOwnerDatabaseTLS({
        CMS_DATABASE_URL: `postgres://operator@db.example.invalid/fixture${query}`,
      }),
    ).toThrow("INITIAL_OWNER_DATABASE_TLS_REFUSED");
  }
  expect(() =>
    assertInitialOwnerDatabaseTLS({
      CMS_DATABASE_URL:
        "postgres://operator@db.example.invalid/fixture?sslmode=verify-full",
    }),
  ).not.toThrow();
});
