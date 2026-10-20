import process from "node:process";
import console from "node:console";
import { parseArgs } from "node:util";
import { URL, pathToFileURL } from "node:url";
import {
  AnalyticsToolError,
  readPrivateConfig,
  requireSetting,
  uuid,
  validateEnvironment,
  UMAMI_VERSION,
  UMAMI_SOURCE_COMMIT,
} from "./common.mjs";

const retentionDays = 180;
const tables = Object.freeze([
  "event_data",
  "revenue",
  "session_data",
  "session_link",
  "heatmap_event",
  "session_replay",
  "session_replay_saved",
]);
export const MAINTENANCE_TABLES = Object.freeze([
  ...tables,
  "website_event",
  "session",
]);

export function prunePlan(environment, selected, now = Date.now()) {
  validateEnvironment(environment, selected);
  let database;
  try {
    database = new URL(
      requireSetting(environment, "UMAMI_MAINTENANCE_DATABASE_URL"),
    );
  } catch {
    throw new AnalyticsToolError(
      "EXPLICIT_UMAMI_MAINTENANCE_DATABASE_REQUIRED",
    );
  }
  const expectedName = requireSetting(
    environment,
    "UMAMI_MAINTENANCE_DATABASE_NAME",
  );
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.username ||
    !database.hostname ||
    database.hash ||
    decodeURIComponent(database.pathname.slice(1)) !== expectedName ||
    (database.searchParams.has("schema") &&
      database.searchParams.get("schema") !== "public") ||
    (selected === "synthetic" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname))
  )
    throw new AnalyticsToolError("UMAMI_MAINTENANCE_DATABASE_SCOPE_MISMATCH");
  const maxBatches = environment.UMAMI_MAINTENANCE_MAX_BATCHES ?? "20";
  if (!/^[1-9]\d?$/u.test(maxBatches) || Number(maxBatches) > 50)
    throw new AnalyticsToolError("UMAMI_MAINTENANCE_BATCH_LIMIT_INVALID");
  return {
    websiteId: uuid(requireSetting(environment, "UMAMI_WEBSITE_ID")),
    domain: requireSetting(environment, "UMAMI_WEBSITE_DOMAIN"),
    cutoff: new Date(now - retentionDays * 86400000).toISOString(),
    batchSize: 1000,
    maxBatches: Number(maxBatches),
  };
}

async function maintenancePool(environment) {
  const { createPostgresPool, parsePostgresConfig } =
    await import("../../services/catalog-postgres/dist/index.js");
  return createPostgresPool(
    parsePostgresConfig({
      DATABASE_URL: requireSetting(
        environment,
        "UMAMI_MAINTENANCE_DATABASE_URL",
      ),
      DATABASE_SSL_CA_FILE: environment.UMAMI_MAINTENANCE_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: "1",
    }),
  );
}

export function ageDeleteQuery(table) {
  if (!tables.includes(table))
    throw new AnalyticsToolError("UMAMI_MAINTENANCE_TABLE_INVALID");
  // Identifiers only come from the pinned schema's fixed allowlist, never config.
  return `WITH batch AS (SELECT ctid FROM public.${table} WHERE website_id = $1::uuid AND created_at < $2::timestamptz ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
DELETE FROM public.${table} AS target USING batch WHERE target.ctid = batch.ctid`;
}

export const EVENT_PRUNE_QUERY = `WITH batch AS MATERIALIZED (
 SELECT event_id FROM public.website_event WHERE website_id = $1::uuid AND created_at < $2::timestamptz ORDER BY created_at, event_id LIMIT 1000 FOR UPDATE SKIP LOCKED
), removed_data AS (
 DELETE FROM public.event_data AS target USING batch WHERE target.website_id = $1::uuid AND target.website_event_id = batch.event_id RETURNING 1
), removed_revenue AS (
 DELETE FROM public.revenue AS target USING batch WHERE target.website_id = $1::uuid AND target.event_id = batch.event_id RETURNING 1
), removed_events AS (
 DELETE FROM public.website_event AS target USING batch WHERE target.website_id = $1::uuid AND target.event_id = batch.event_id
 AND (SELECT count(*) FROM removed_data) >= 0 AND (SELECT count(*) FROM removed_revenue) >= 0 RETURNING 1
)
SELECT (SELECT count(*) FROM removed_events)::integer AS deleted,
 (SELECT count(*) FROM removed_data)::integer AS event_data,
 (SELECT count(*) FROM removed_revenue)::integer AS revenue`;

export const SESSION_PRUNE_QUERY = `WITH batch AS (
 SELECT target.ctid FROM public.session AS target WHERE target.website_id = $1::uuid AND target.created_at < $2::timestamptz
 AND NOT EXISTS (SELECT 1 FROM public.website_event AS e WHERE e.website_id = target.website_id AND e.session_id = target.session_id)
 AND NOT EXISTS (SELECT 1 FROM public.session_data AS d WHERE d.website_id = target.website_id AND d.session_id = target.session_id)
 AND NOT EXISTS (SELECT 1 FROM public.revenue AS r WHERE r.website_id = target.website_id AND r.session_id = target.session_id)
 AND NOT EXISTS (SELECT 1 FROM public.session_link AS l WHERE l.website_id = target.website_id AND l.session_id = target.session_id)
 AND NOT EXISTS (SELECT 1 FROM public.session_replay AS p WHERE p.website_id = target.website_id AND p.session_id = target.session_id)
 AND NOT EXISTS (SELECT 1 FROM public.heatmap_event AS h WHERE h.website_id = target.website_id AND h.session_id = target.session_id)
 ORDER BY target.created_at LIMIT 1000 FOR UPDATE SKIP LOCKED
) DELETE FROM public.session AS target USING batch WHERE target.ctid = batch.ctid`;

/** Explicit native 3.4.0 tables only; never reset a website or delete configuration. */
export async function pruneUmami(environment, selected, options = {}) {
  const plan = prunePlan(environment, selected, options.now);
  if (!options.execute)
    return {
      ok: true,
      status: "PLAN_ONLY",
      version: UMAMI_VERSION,
      sourceCommit: UMAMI_SOURCE_COMMIT,
      websiteId: plan.websiteId,
      retentionDays,
      cutoff: plan.cutoff,
      batchSize: plan.batchSize,
      maxBatchesPerTable: plan.maxBatches,
      tables: MAINTENANCE_TABLES,
    };
  const deadline = Date.now() + 120000;
  const pool = await (options.poolFactory ?? maintenancePool)(environment);
  let client;
  let inTransaction = false;
  const deleted = Object.fromEntries(
    MAINTENANCE_TABLES.map((table) => [table, 0]),
  );
  const exhaustedTables = [];
  try {
    client = await pool.connect();
    const query = (text, values) => {
      if (Date.now() >= deadline)
        throw new AnalyticsToolError("UMAMI_MAINTENANCE_DEADLINE");
      return client.query({
        text,
        values,
        query_timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
      });
    };
    await query("SET statement_timeout = '5s'");
    await query("SET lock_timeout = '250ms'");
    await query("SET idle_in_transaction_session_timeout = '10s'");
    const version = await query(
      "SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, started_at DESC LIMIT 1",
    );
    if (version.rows[0]?.migration_name !== "26_add_api_key")
      throw new AnalyticsToolError("UMAMI_PINNED_SCHEMA_REQUIRED");
    const website = await query(
      "SELECT website_id, domain FROM public.website WHERE website_id = $1::uuid AND deleted_at IS NULL",
      [plan.websiteId],
    );
    if (website.rows.length !== 1 || website.rows[0].domain !== plan.domain)
      throw new AnalyticsToolError("UMAMI_MAINTENANCE_WEBSITE_MISMATCH");
    // v3.4.0 uses relationMode=prisma: activity tables have no DB FK/cascade.
    // Refuse unknown added FKs rather than guessing their delete effects.
    const foreignKeys = await query(
      "SELECT 1 FROM pg_constraint AS c JOIN pg_class AS t ON t.oid = c.conrelid JOIN pg_namespace AS n ON n.oid = t.relnamespace WHERE c.contype = 'f' AND n.nspname = 'public' AND (t.relname = ANY($1::text[]) OR c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]))) LIMIT 1",
      [MAINTENANCE_TABLES],
    );
    if (foreignKeys.rows.length)
      throw new AnalyticsToolError("UMAMI_UNREVIEWED_ACTIVITY_FOREIGN_KEYS");
    // Verify all activity identifiers before the first delete.
    for (const table of MAINTENANCE_TABLES)
      await query(`SELECT website_id, created_at FROM public.${table} LIMIT 0`);
    const parameters = [plan.websiteId, plan.cutoff];
    const runBatches = async (table, sql, eventBatch = false) => {
      for (let batch = 0; batch < plan.maxBatches; batch++) {
        await query("BEGIN");
        inTransaction = true;
        const result = await query(sql, parameters);
        const count = eventBatch ? result.rows[0]?.deleted : result.rowCount;
        if (!Number.isSafeInteger(count) || count < 0 || count > plan.batchSize)
          throw new AnalyticsToolError("UMAMI_MAINTENANCE_RESULT_INVALID");
        await query("COMMIT");
        inTransaction = false;
        deleted[table] += count;
        if (eventBatch) {
          deleted.event_data += result.rows[0].event_data;
          deleted.revenue += result.rows[0].revenue;
        }
        if (count < plan.batchSize) return;
      }
      exhaustedTables.push(table);
    };
    for (const table of tables) await runBatches(table, ageDeleteQuery(table));
    await runBatches("website_event", EVENT_PRUNE_QUERY, true);
    await runBatches("session", SESSION_PRUNE_QUERY);
    return {
      ok: true,
      status: exhaustedTables.length ? "BATCH_LIMIT_REACHED" : "PRUNED",
      websiteId: plan.websiteId,
      retentionDays,
      deleted,
      exhaustedTables,
      skippedLocksPossible: true,
    };
  } finally {
    if (client) client.release(inTransaction || Date.now() >= deadline);
    await pool.end();
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
        await pruneUmami(environment, values.environment, {
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
            : "UMAMI_MAINTENANCE_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
