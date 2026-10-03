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
  collections: [{ ...Users, endpoints: initialUserEndpoints("production") }],
  graphQL: { disable: true },
});
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  payload = await getPayload({ config, key: database });
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
  expect(
    (await payload.count({ collection: "users", overrideAccess: true }))
      .totalDocs,
  ).toBe(0);
  const results = await Promise.allSettled([
    provisionInitialOwner(payload, {
      email: "synthetic-owner@example.invalid",
      password: ownerPassword,
    }),
    provisionInitialOwner(payload, {
      email: "synthetic-owner@example.invalid",
      password: ownerPassword,
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(
    (await payload.count({ collection: "users", overrideAccess: true }))
      .totalDocs,
  ).toBe(1);
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
