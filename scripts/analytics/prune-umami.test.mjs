import { URL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAINTENANCE_TABLES,
  EVENT_PRUNE_QUERY,
  SESSION_PRUNE_QUERY,
  ageDeleteQuery,
  prunePlan,
  pruneUmami,
} from "./prune-umami.mjs";
import { rotateBootstrapPassword } from "./rotate-umami-password.mjs";

const websiteId = "10000000-0000-4000-8000-000000000004";
const environment = {
  ANALYTICS_TASK_ENV: "synthetic",
  UMAMI_MAINTENANCE_DATABASE_URL:
    "postgresql://synthetic:synthetic-not-valid@127.0.0.1:1/umami_synthetic",
  UMAMI_MAINTENANCE_DATABASE_NAME: "umami_synthetic",
  UMAMI_WEBSITE_ID: websiteId,
  UMAMI_WEBSITE_DOMAIN: "localhost",
};
function fakeDatabase({
  migration = "26_add_api_key",
  domain = "localhost",
  foreignKeys = false,
} = {}) {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (query.text.startsWith("SELECT migration_name"))
        return { rows: [{ migration_name: migration }] };
      if (query.text.startsWith("SELECT website_id, domain"))
        return { rows: [{ website_id: websiteId, domain }] };
      if (query.text.startsWith("SELECT 1 FROM pg_constraint"))
        return { rows: foreignKeys ? [{}] : [] };
      if (query.text === EVENT_PRUNE_QUERY)
        return { rows: [{ deleted: 2, event_data: 4, revenue: 0 }] };
      return {
        rows: [],
        rowCount: query.text.includes("DELETE FROM public.") ? 1 : 0,
      };
    },
    release() {
      calls.push("release");
    },
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      async end() {
        calls.push("end");
      },
    },
  };
}

test("maintenance dry run is offline and requires explicit dedicated database/website", async () => {
  const plan = await pruneUmami(environment, "synthetic", {
    now: 1792368000000,
  });
  assert.equal(plan.status, "PLAN_ONLY");
  assert.equal(plan.retentionDays, 180);
  assert.equal(plan.batchSize, 1000);
  assert.throws(() => prunePlan(environment, "production"), /ENVIRONMENT/);
  assert.throws(
    () =>
      prunePlan(
        { ...environment, UMAMI_MAINTENANCE_DATABASE_NAME: "other" },
        "synthetic",
      ),
    /SCOPE/,
  );
  assert.throws(() => ageDeleteQuery("website"), /TABLE/);
});

test("maintenance validates pin, website and real FK semantics before any bounded activity delete", async () => {
  const fake = fakeDatabase();
  const result = await pruneUmami(environment, "synthetic", {
    execute: true,
    poolFactory: async () => fake.pool,
  });
  assert.equal(result.status, "PRUNED");
  assert.equal(result.deleted.website_event, 2);
  assert.equal(result.deleted.event_data, 5);
  for (const query of fake.calls.filter((call) =>
    call.text?.includes("DELETE FROM public."),
  )) {
    assert.match(query.text, /LIMIT 1000/u);
    assert.match(query.text, /SKIP LOCKED/u);
    assert.equal(query.values[0], websiteId);
    assert.ok(
      !/DELETE FROM public\.(website|board|user|team)\s/u.test(query.text),
    );
  }
  assert.ok(
    fake.calls.some((query) => query.text === "SET lock_timeout = '250ms'"),
  );
  assert.ok(SESSION_PRUNE_QUERY.includes("NOT EXISTS"));
  assert.deepEqual(MAINTENANCE_TABLES.includes("website"), false);
});

test("maintenance refuses schema drift, unknown FKs and a mismatched website before mutation", async () => {
  for (const settings of [
    { migration: "future_version" },
    { domain: "other.invalid" },
    { foreignKeys: true },
  ]) {
    const fake = fakeDatabase(settings);
    await assert.rejects(
      pruneUmami(environment, "synthetic", {
        execute: true,
        poolFactory: async () => fake.pool,
      }),
    );
    assert.equal(
      fake.calls.filter((call) => call.text?.includes("DELETE FROM")).length,
      0,
    );
  }
});

test("password rotation uses native current/new API and is idempotent without outputting credentials", async () => {
  const settings = {
    ANALYTICS_TASK_ENV: "synthetic",
    UMAMI_ORIGIN: "http://127.0.0.1:3010",
    UMAMI_BOOTSTRAP_USERNAME: "synthetic-admin",
    UMAMI_BOOTSTRAP_PASSWORD: "synthetic-not-valid-current",
    UMAMI_BOOTSTRAP_NEW_PASSWORD: "synthetic-not-valid-random-new-password",
  };
  let rotated = false;
  const calls = [];
  const fetchImpl = async (url, request) => {
    const route = new URL(url).pathname.split("/api/")[1];
    const body = JSON.parse(request.body);
    calls.push(route);
    if (route === "auth/login") {
      if (body.password === settings.UMAMI_BOOTSTRAP_NEW_PASSWORD && !rotated)
        return globalThis.Response.json({}, { status: 401 });
      return globalThis.Response.json({
        token: "synthetic-private-token",
        user: { id: websiteId, role: "admin", isAdmin: true },
      });
    }
    assert.equal(route, "me/password");
    assert.deepEqual(body, {
      currentPassword: settings.UMAMI_BOOTSTRAP_PASSWORD,
      newPassword: settings.UMAMI_BOOTSTRAP_NEW_PASSWORD,
    });
    rotated = true;
    return globalThis.Response.json({ id: websiteId });
  };
  const first = await rotateBootstrapPassword(settings, "synthetic", {
    execute: true,
    fetchImpl,
  });
  assert.equal(first.status, "ROTATED");
  const second = await rotateBootstrapPassword(settings, "synthetic", {
    execute: true,
    fetchImpl,
  });
  assert.equal(second.status, "ALREADY_ROTATED");
  assert.equal(calls.filter((route) => route === "me/password").length, 1);
  assert.ok(!JSON.stringify(first).includes("password"));
  assert.ok(!JSON.stringify(second).includes("private-token"));
});
