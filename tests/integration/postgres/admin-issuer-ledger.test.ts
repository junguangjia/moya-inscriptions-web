import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/**
 * Issue #355, login door: the Admin issuer checks the migration ledger at start,
 * as the Backend does. The real entry point, on a real database that really is
 * behind, because the failure this replaces was an issuer that started happily
 * and stopped a person on the error page after they had clicked allow.
 *
 * Its own database, made and dropped here, so it passes on any cluster.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = `${root}database/community-migrations`;
const main = `${root}services/agent-authorization/dist/main.js`;
// The last migration before the login door's own two.
const baseline = "20261105010000";
const target = requireSyntheticTestDatabaseUrl();
const name = `admin_issuer_${randomBytes(6).toString("hex")}_synthetic_test`;
const url = new URL(target);
url.pathname = `/${name}`;
const admin = createPostgresPool(parsePostgresConfig({ DATABASE_URL: target }));
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: url.toString() }),
);
let created = false;

const freePort = async () => {
  const reservation = http.createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const { port } = reservation.address() as { port: number };
  await new Promise<void>((done) => reservation.close(() => done()));
  return port;
};

/** The entry point under the operator profile, stopped once it says it is ready. */
const start = async () => {
  const port = await freePort();
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done, reject) => {
      const child = spawn(process.execPath, [main], {
        stdio: "pipe",
        env: {
          NODE_ENV: "development",
          AGENT_AUTHORIZATION_ENABLED: "true",
          AGENT_AUTHORIZATION_PROFILE: "operator",
          AGENT_AUTHORIZATION_ISSUER: `http://127.0.0.1:${port}`,
          AGENT_AUTHORIZATION_RESOURCE: "http://admin.localhost:3442/api/mcp",
          AGENT_AUTHORIZATION_CONSENT_URL: "http://admin.localhost:3442",
          AGENT_AUTHORIZATION_PORT: String(port),
          AGENT_AUTHORIZATION_ENVIRONMENT: "development",
          AGENT_AUTHORIZATION_CLIENTS: JSON.stringify([
            {
              clientId: "synthetic-loopback",
              family: "codex",
              label: "Local synthetic tool",
              redirectUris: ["http://127.0.0.1:44563/callback"],
            },
          ]),
          AGENT_AUTHORIZATION_DATABASE_URL: url.toString(),
          AGENT_AUTHORIZATION_COOKIE_KEY: randomBytes(32).toString("base64url"),
          AGENT_CONNECTION_PROVIDER_INDEX_KEY:
            randomBytes(32).toString("base64"),
          AGENT_CONNECTION_PROVIDER_SEAL_KEY:
            randomBytes(32).toString("base64"),
          AGENT_CONNECTION_WRAPPER_INDEX_KEY:
            randomBytes(32).toString("base64"),
          AGENT_CONNECTION_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
        },
      });
      let out = "";
      let err = "";
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`TEST_DEADLINE: ${err}`));
      }, 20_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("listeners ready")) child.kill("SIGTERM");
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        done({ code, out, err });
      });
    },
  );
};

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
});

afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
});

it("refuses by name until every migration has run, and then starts", async () => {
  const empty = await start();
  expect(empty.code).toBe(78);
  expect(empty.out).not.toContain("listeners ready");
  expect(empty.err).toContain("startup refused ADMIN_SCHEMA_NOT_READY");

  await runCommunityMigrations(pool, directory, { through: baseline });
  const behind = await start();
  expect(behind.code).toBe(78);
  expect(behind.out).not.toContain("listeners ready");
  expect(behind.err).toContain("startup refused ADMIN_SCHEMA_NOT_READY");

  await runCommunityMigrations(pool, directory);
  const ready = await start();
  expect(ready.err).not.toContain("refused");
  expect(ready.out).toContain("listeners ready");
  expect(ready.code).toBe(0);
}, 60_000);
