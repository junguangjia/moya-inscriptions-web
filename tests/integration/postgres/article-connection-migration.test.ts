import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = `${root}/database/community-migrations`;
const baseline = "20261002010000";
const forward = "20261002020000";
const target = requireSyntheticTestDatabaseUrl();
const name = `article_env_${randomBytes(6).toString("hex")}_synthetic_test`;
const url = new URL(target);
url.pathname = `/${name}`;
const admin = createPostgresPool(parsePostgresConfig({ DATABASE_URL: target }));
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: url.toString() }),
);
const owner = `user-${"1".repeat(32)}`;
const connection = (n: number) =>
  `article-connection-${String(n).padStart(32, "0")}`;
const insert = `INSERT INTO community.article_authoring_connections
  (id,owner_id,client_id,environment,generation,status,consented_at,updated_at)
  VALUES($1,$2,'synthetic-client',$3,1,'authorized','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')`;
const rows = async () =>
  (
    await pool.query(
      "SELECT * FROM community.article_authoring_connections ORDER BY id",
    )
  ).rows;
const ledger = async () =>
  (
    await pool.query(
      "SELECT * FROM community.schema_migrations ORDER BY migration_id",
    )
  ).rows;
let created = false;

beforeAll(async () => {
  const guard = await import(
    new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
  );
  guard.assertDisposableTestTarget(
    (await admin.query(guard.disposableTestTargetProbeSql)).rows,
    new URL(target).pathname.slice(1),
  );
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  await pool.query(guard.markCurrentDatabaseDisposableSql);
  await runCommunityMigrations(pool, directory, { through: baseline });
  await pool.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,'article-env-synthetic','Synthetic')",
    [owner],
  );
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
});

it("upgrades the Development-only connection constraint without relabelling rows or weakening identity", async () => {
  await pool.query(insert, [connection(1), owner, "development"]);
  const original = await rows();
  const originalLedger = await ledger();
  await expect(
    pool.query(insert, [connection(2), owner, "production"]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "article_authoring_connections_environment_check",
  });
  expect(await rows()).toEqual(original);
  expect(await runCommunityMigrations(pool, directory)).toEqual([
    forward,
    "20261003010000",
    "20261004010000",
    "20261004020000",
    "20261008010000",
  ]);
  expect(await rows()).toEqual(original);
  expect((await ledger()).slice(0, originalLedger.length)).toEqual(
    originalLedger,
  );
  await pool.query(insert, [connection(2), owner, "production"]);
  const upgraded = await rows();
  expect(upgraded.map((row) => row.environment)).toEqual([
    "development",
    "production",
  ]);
  await expect(
    pool.query(insert, [connection(3), owner, "staging"]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    pool.query(insert, [connection(3), owner, "production"]),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    pool.query(
      "UPDATE community.article_authoring_connections SET environment='production' WHERE id=$1",
      [connection(1)],
    ),
  ).rejects.toMatchObject({ code: "23001" });
  expect(await runCommunityMigrations(pool, directory)).toEqual([]);
  expect(await rows()).toEqual(upgraded);
});
