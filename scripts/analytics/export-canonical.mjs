import process from "node:process";
import console from "node:console";
import path from "node:path";
import { open, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { URL, pathToFileURL } from "node:url";
import {
  AnalyticsToolError,
  readPrivateConfig,
  requireSetting,
  validateEnvironment,
} from "./common.mjs";

// Explicit public canonical columns only. Never join raw IP/UA, outbox or auth.
export const EXPORT_COLUMNS = Object.freeze([
  "event_id",
  "visitor_id",
  "session_id",
  "user_id",
  "event_name",
  "target_type",
  "target_id",
  "surface",
  "event_data",
  "occurred_at",
  "received_at",
]);
export const EXPORT_QUERY = `
SELECT e.event_id, e.visitor_id, e.session_id, e.user_id, e.event_name,
       e.target_type, e.target_id, e.surface, e.event_data,
       e.occurred_at::text AS occurred_at, e.received_at::text AS received_at
FROM community.analytics_events AS e
WHERE e.received_at >= $1::timestamptz AND e.received_at < $2::timestamptz
  AND ($3::timestamptz IS NULL OR (e.received_at, e.event_id) > ($3::timestamptz, $4::uuid))
ORDER BY e.received_at, e.event_id
LIMIT $5`;

export function exportPlan(environment, selected, values) {
  validateEnvironment(environment, selected);
  let database;
  try {
    database = new URL(
      requireSetting(environment, "ANALYTICS_EXPORT_DATABASE_URL"),
    );
  } catch {
    throw new AnalyticsToolError("EXPLICIT_EXPORT_DATABASE_REQUIRED");
  }
  const expectedName = requireSetting(
    environment,
    "ANALYTICS_EXPORT_DATABASE_NAME",
  );
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.username ||
    !database.hostname ||
    database.hash ||
    decodeURIComponent(database.pathname.slice(1)) !== expectedName ||
    (selected === "synthetic" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname))
  )
    throw new AnalyticsToolError("EXPORT_DATABASE_SCOPE_MISMATCH");
  const instant = (value) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value)
    )
      throw new AnalyticsToolError("EXPLICIT_UTC_RANGE_REQUIRED");
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
      throw new AnalyticsToolError("EXPLICIT_UTC_RANGE_REQUIRED");
    return parsed;
  };
  const start = instant(values.start);
  const end = instant(values.end);
  if (end <= start || end - start > 31 * 86400000)
    throw new AnalyticsToolError("EXPORT_RANGE_MAX_31_DAYS");
  if (
    !values.output ||
    !path.isAbsolute(values.output) ||
    !values.output.endsWith(".jsonl")
  )
    throw new AnalyticsToolError("ABSOLUTE_JSONL_OUTPUT_REQUIRED");
  const maxRows = environment.ANALYTICS_EXPORT_MAX_ROWS ?? "100000";
  if (!/^[1-9]\d{0,6}$/u.test(maxRows) || Number(maxRows) > 1000000)
    throw new AnalyticsToolError("EXPORT_ROW_LIMIT_INVALID");
  return {
    start: values.start,
    end: values.end,
    output: values.output,
    maxRows: Number(maxRows),
  };
}

async function exportPool(environment) {
  // Existing reviewed TLS/pool implementation; no new dependency or env discovery.
  const { createPostgresPool, parsePostgresConfig } =
    await import("../../services/catalog-postgres/dist/index.js");
  return createPostgresPool(
    parsePostgresConfig({
      DATABASE_URL: requireSetting(
        environment,
        "ANALYTICS_EXPORT_DATABASE_URL",
      ),
      DATABASE_SSL_CA_FILE: environment.ANALYTICS_EXPORT_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: "1",
    }),
  );
}

/** Bounded keyset pages in one read-only snapshot; timestamps retain PG microseconds. */
export async function exportCanonical(
  environment,
  selected,
  values,
  options = {},
) {
  const plan = exportPlan(environment, selected, values);
  if (!options.execute)
    return {
      ok: true,
      status: "PLAN_ONLY",
      columns: EXPORT_COLUMNS,
      maxRows: plan.maxRows,
    };
  const deadline = Date.now() + 120000;
  const pool = await (options.poolFactory ?? exportPool)(environment);
  let client;
  let file;
  let createdOutput = false;
  let finished = false;
  let rows = 0;
  try {
    // Exclusive creation refuses an existing file or symlink. No data on stdout.
    file = await open(plan.output, "wx", 0o600);
    createdOutput = true;
    client = await pool.connect();
    const query = (text, parameters) => {
      if (Date.now() >= deadline)
        throw new AnalyticsToolError("EXPORT_DEADLINE");
      return client.query({
        text,
        values: parameters,
        query_timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
      });
    };
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await query("SET LOCAL statement_timeout = '5s'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    await query("SET LOCAL TIME ZONE 'UTC'");
    let cursorAt = null;
    let cursorId = null;
    for (;;) {
      const limit = Math.min(200, plan.maxRows - rows + 1);
      const result = await query(EXPORT_QUERY, [
        plan.start,
        plan.end,
        cursorAt,
        cursorId,
        limit,
      ]);
      if (!Array.isArray(result.rows) || result.rows.length > limit)
        throw new AnalyticsToolError("EXPORT_RESULT_INVALID");
      if (rows + result.rows.length > plan.maxRows)
        throw new AnalyticsToolError("EXPORT_ROW_LIMIT_REACHED");
      const lines = [];
      for (const row of result.rows) {
        if (
          typeof row.received_at !== "string" ||
          typeof row.event_id !== "string"
        )
          throw new AnalyticsToolError("EXPORT_CURSOR_INVALID");
        // Restrict output even if a driver/test accidentally supplies extra fields.
        lines.push(
          JSON.stringify(
            Object.fromEntries(EXPORT_COLUMNS.map((key) => [key, row[key]])),
          ),
        );
      }
      if (lines.length) await file.writeFile(`${lines.join("\n")}\n`);
      rows += lines.length;
      if (result.rows.length < limit) break;
      const last = result.rows.at(-1);
      cursorAt = last.received_at;
      cursorId = last.event_id;
    }
    await query("COMMIT");
    await file.sync();
    finished = true;
    return {
      ok: true,
      status: "EXPORTED",
      rows,
      rawIpIncluded: false,
      distinctIdIncluded: false,
    };
  } finally {
    if (client) client.release(!finished);
    await file?.close();
    await pool.end();
    // Only remove this invocation's incomplete private file, never an older file.
    if (createdOutput && !finished) await unlink(plan.output).catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        environment: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        output: { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const environment = await readPrivateConfig(
      values.config,
      values.environment,
    );
    console.info(
      JSON.stringify(
        await exportCanonical(environment, values.environment, values, {
          execute: values.execute,
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "CANONICAL_EXPORT_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
