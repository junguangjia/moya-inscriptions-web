import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EXPORT_COLUMNS,
  EXPORT_QUERY,
  exportCanonical,
  exportPlan,
} from "./export-canonical.mjs";

// Explicitly synthetic and intentionally unusable connection string.
const environment = {
  ANALYTICS_TASK_ENV: "synthetic",
  ANALYTICS_EXPORT_DATABASE_URL:
    "postgresql://synthetic:synthetic-not-valid@127.0.0.1:1/analytics_synthetic",
  ANALYTICS_EXPORT_DATABASE_NAME: "analytics_synthetic",
};
const range = {
  start: "2026-10-01T00:00:00Z",
  end: "2026-10-02T00:00:00Z",
  output: "/tmp/synthetic-export.jsonl",
};
function fakePool(pages) {
  const calls = [];
  let page = 0;
  const client = {
    async query(query) {
      calls.push(query);
      return { rows: query.text === EXPORT_QUERY ? (pages[page++] ?? []) : [] };
    },
    release(destroy) {
      calls.push({ release: destroy });
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {
      calls.push("end");
    },
  };
  return { calls, pool };
}
function row(index) {
  return {
    event_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    visitor_id: "synthetic",
    session_id: "synthetic",
    user_id: null,
    event_name: "content_impression",
    target_type: "work",
    target_id: "synthetic-work",
    surface: "home",
    event_data: { card_position: 1 },
    occurred_at: "2026-10-01 00:00:00.123456+00",
    received_at: "2026-10-01 00:00:00.123456+00",
    ip: "192.0.2.1",
    distinct_id: "synthetic-implementation-detail",
  };
}

test("export requires explicit task database, bounded UTC range and private output", async () => {
  const plan = await exportCanonical(environment, "synthetic", range);
  assert.equal(plan.status, "PLAN_ONLY");
  assert.deepEqual(plan.columns, EXPORT_COLUMNS);
  assert.throws(
    () => exportPlan(environment, "production", range),
    /ENVIRONMENT/,
  );
  assert.throws(
    () =>
      exportPlan(
        { ...environment, ANALYTICS_EXPORT_DATABASE_NAME: "other" },
        "synthetic",
        range,
      ),
    /SCOPE/,
  );
  assert.throws(
    () =>
      exportPlan(
        {
          ...environment,
          ANALYTICS_EXPORT_DATABASE_URL:
            "postgresql://synthetic:synthetic-not-valid@example.invalid/synthetic",
        },
        "synthetic",
        range,
      ),
    /SCOPE/,
  );
  assert.throws(
    () =>
      exportPlan(environment, "synthetic", {
        ...range,
        end: "2027-01-01T00:00:00Z",
      }),
    /31_DAYS/,
  );
  assert.throws(
    () =>
      exportPlan(environment, "synthetic", {
        ...range,
        output: "relative.jsonl",
      }),
    /OUTPUT/,
  );
});

test("export streams explicit canonical columns and microsecond-safe keyset pages in readonly transaction", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "analytics-export-test-"),
  );
  const output = path.join(directory, "canonical.jsonl");
  const fake = fakePool([
    Array.from({ length: 200 }, (_, i) => row(i)),
    [row(200)],
  ]);
  try {
    const result = await exportCanonical(
      environment,
      "synthetic",
      { ...range, output },
      { execute: true, poolFactory: async () => fake.pool },
    );
    assert.equal(result.rows, 201);
    assert.equal((await stat(output)).mode & 0o077, 0);
    const data = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(Object.keys(data[0]), EXPORT_COLUMNS);
    assert.equal(data[0].received_at, "2026-10-01 00:00:00.123456+00");
    assert.ok(!("ip" in data[0]));
    assert.ok(!("distinct_id" in data[0]));
    const queries = fake.calls.filter((call) => call.text === EXPORT_QUERY);
    assert.equal(queries[1].values[2], "2026-10-01 00:00:00.123456+00");
    assert.equal(queries[1].values[3], row(199).event_id);
    assert.match(fake.calls[0].text, /READ ONLY/u);
    assert.ok(fake.calls.some((call) => call.text === "COMMIT"));
    assert.ok(!EXPORT_QUERY.includes("SELECT *"));
    assert.ok(!EXPORT_QUERY.includes("analytics_ip_observations"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("export refuses overwrites and removes only its own incomplete output on row limit", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "analytics-export-test-"),
  );
  const output = path.join(directory, "canonical.jsonl");
  try {
    const limited = fakePool([[row(0), row(1)]]);
    await assert.rejects(
      exportCanonical(
        { ...environment, ANALYTICS_EXPORT_MAX_ROWS: "1" },
        "synthetic",
        { ...range, output },
        { execute: true, poolFactory: async () => limited.pool },
      ),
      /ROW_LIMIT/,
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
    assert.ok(limited.calls.some((call) => call.release === true));
    await writeFile(output, "keep-existing", { mode: 0o600 });
    const duplicate = fakePool([]);
    await assert.rejects(
      exportCanonical(
        environment,
        "synthetic",
        { ...range, output },
        { execute: true, poolFactory: async () => duplicate.pool },
      ),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(output, "utf8"), "keep-existing");
    assert.equal(duplicate.calls.filter((call) => call.text).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
