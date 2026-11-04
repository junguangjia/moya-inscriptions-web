/**
 * admin-mcp-completion-v1 section 15: EXPLAIN on the canonical path before any index,
 * and section 21's L1 for it. Makes a disposable database beside TEST_DATABASE_URL,
 * seeds the target scale (an assumption: 1M events over 180 days, 50k works, 20k
 * users), reads every report through the real adapter, and writes plans and timings
 * to --output. Every row is a pure function of its index, so a run is repeatable.
 *
 *   TEST_DATABASE_URL=... node integration/postgres/analytics-insights-explain.mjs --output <dir>
 */
import console from "node:console";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAnalyticsInsights,
  runCommunityMigrations,
} from "@moya/community-postgres";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    events: { type: "string", default: "1000000" },
    samples: { type: "string", default: "30" },
    overviewSamples: { type: "string", default: "200" },
  },
});
if (!values.output) throw new Error("--output is required");
const target = process.env.TEST_DATABASE_URL;
if (!target) throw new Error("TEST_DATABASE_URL is required");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname))
  throw new Error("Loopback synthetic database required");

const root = fileURLToPath(new URL("../../../", import.meta.url));
const guard = await import(`${root}scripts/disposable-test-target.mjs`);
const poolFor = (url) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const admin = poolFor(target);
guard.assertDisposableTestTarget(
  (await admin.query(guard.disposableTestTargetProbeSql)).rows,
  decodeURI(new URL(target).pathname.slice(1)),
);
const version = (await admin.query("SHOW server_version_num")).rows[0]
  .server_version_num;
const database = `insights_explain_${randomBytes(4).toString("hex")}_synthetic_test`;
await admin.query(`CREATE DATABASE ${database}`);
const url = new URL(target);
url.pathname = `/${database}`;
const db = poolFor(url.toString());

const now = new Date("2026-03-11T04:00:00.000Z");
const EVENTS = Number(values.events);
const pad = (expression) => `lpad(to_hex(${expression}), 32, '0')`;

const seed = async () => {
  await runCommunityMigrations(db, `${root}database/community-migrations`);
  await db.query(
    "CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb)",
  );
  await db.query(
    `INSERT INTO public.catalog_discovery(catalog_id,title)
    SELECT 'catalog-' || i, '合成资料' || i FROM generate_series(1, 5000) i`,
  );
  await db.query(
    `INSERT INTO community.public_users(id,handle,display_name)
    SELECT 'user-' || ${pad("i")}, 'bench-' || i, '合成' || i FROM generate_series(1, 20000) i`,
  );
  // created_via publishing skips the legacy bridge; one work in a hundred is self-only.
  await db.query(
    `INSERT INTO community.works(id,author_id,title,text,visibility,created_via)
    SELECT 'work-' || ${pad("i")}, 'user-' || ${pad("1 + i % 20000")}, '合成作品' || i, '',
      CASE WHEN i % 100 = 0 THEN 'self' ELSE 'public' END, 'publishing'
    FROM generate_series(1, 50000) i`,
  );
  await db.query(
    `INSERT INTO community.content_relations(user_id,content_type,content_id,relation,created_at)
    SELECT 'user-' || ${pad("1 + i % 20000")}, 'work', 'work-' || ${pad("1 + i % 50000")},
      CASE WHEN i % 2 = 0 THEN 'like' ELSE 'favorite' END,
      $1::timestamptz - (i % 180) * INTERVAL '1 day'
    FROM generate_series(1, 100000) i ON CONFLICT DO NOTHING`,
    [now],
  );
  await db.query(
    `INSERT INTO community.analytics_events(event_id,visitor_id,session_id,user_id,distinct_id,event_name,target_type,target_id,surface,event_data,occurred_at,received_at)
    SELECT md5('event' || i)::uuid,
      md5('visitor' || (i % 50000))::uuid,
      md5('session' || (i % 200000))::uuid,
      CASE WHEN i % 5 = 0 THEN 'user-' || ${pad("1 + (i % 50000) % 20000")} END,
      substr(md5('distinct' || (i % 50000)) || md5('x' || (i % 50000)), 1, 40),
      e.name,
      CASE WHEN e.targeted THEN 'work' END,
      CASE WHEN e.targeted THEN 'work-' || ${pad("1 + (i * 7) % 50000")} END,
      (ARRAY['home','browse','search','detail','profile','thread','other'])[1 + i % 7],
      jsonb_build_object('name', e.name, 'position', i % 40, 'dwellMs', i % 60000, 'searchQuery', '合成检索' || (i % 500)),
      t.at, t.at + (i % 30) * INTERVAL '1 second'
    FROM generate_series(1, $1::int) i
    CROSS JOIN LATERAL (SELECT $2::timestamptz - (i::float8 / $1::int) * 180 * INTERVAL '1 day' AS at) t
    CROSS JOIN LATERAL (SELECT
      (ARRAY['content_impression','content_impression','content_impression','content_impression','content_impression','content_impression',
        'page_view','page_view','content_open','content_dwell','search','search_click','like','favorite','follow'])[1 + i % 15] AS name,
      i % 15 NOT IN (10) AND i % 40 <> 0 AS targeted) e`,
    [EVENTS, now],
  );
  await db.query("ANALYZE");
};

const statements = [];
const recording = new Proxy(db, {
  get(pool, property) {
    if (property !== "connect") return Reflect.get(pool, property);
    return async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return new Proxy(client, {
        get(inner, name) {
          if (name !== "query") return Reflect.get(inner, name);
          return (text, parameters) => {
            statements.push({ text, parameters });
            return query(text, parameters);
          };
        },
      });
    };
  },
});
const reader = new PostgresAnalyticsInsights(recording, {
  retentionDays: 180,
  now: () => now,
});

const cases = (subject) => [
  ["overview", "overview", { range: "last_7_days" }, true],
  ["overview this_week", "overview", { range: "this_week" }],
  ["overview 30 days", "overview", { range: "last_30_days" }],
  // The whole retention window, in two compared halves: the most one call can scan.
  ["overview 88 days", "overview", { from: "2025-12-13", to: "2026-03-10" }],
  ["trend 30 days by day", "trend", { range: "last_30_days", groupBy: "day" }],
  [
    "breakdown content",
    "breakdown",
    { range: "last_7_days", dimension: "content" },
  ],
  [
    "breakdown surface",
    "breakdown",
    { range: "last_7_days", dimension: "surface" },
  ],
  [
    "compare down",
    "compare",
    { range: "last_week", dimension: "content", direction: "down" },
  ],
  [
    "funnel sameTarget",
    "funnel",
    {
      range: "last_7_days",
      steps: ["content_impression", "content_open"],
      sameTarget: "true",
    },
  ],
  [
    "funnel visit",
    "funnel",
    {
      range: "last_7_days",
      steps: ["content_impression", "content_open", "favorite"],
    },
  ],
  ["realtime", "realtime", {}],
  ["sessions by range", "sessions", { range: "yesterday" }],
  [
    "sessions by visitor",
    "sessions",
    { range: "last_7_days", visitorId: subject },
  ],
  [
    "session by visitor",
    "session",
    { range: "last_7_days", visitorId: subject },
  ],
  ["product", "product", { range: "last_7_days" }],
  ["reconcile 30 days", "reconcile", { range: "last_30_days" }],
  ["native", "native", { range: "last_7_days" }],
];

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

const measure = async () => {
  const lines = [];
  const plans = [];
  const visitor = (
    await db.query(
      "SELECT visitor_id FROM community.analytics_events WHERE occurred_at < $1::timestamptz - INTERVAL '1 day' ORDER BY received_at DESC LIMIT 1",
      [now],
    )
  ).rows[0]?.visitor_id;
  for (const [label, report, query, long] of cases(visitor)) {
    statements.length = 0;
    const firstStart = performance.now();
    let failure = null;
    try {
      await reader.read(report, query);
    } catch (error) {
      failure = error.name ?? "error";
    }
    const first = performance.now() - firstStart;
    const planned = statements.filter(({ text }) =>
      /^\s*(?:SELECT|WITH)/u.test(text),
    );
    plans.push(`\n===== ${label} =====`);
    for (const { text, parameters } of planned) {
      const client = await db.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const plan = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS) ${text}`,
          parameters,
        );
        plans.push(
          `\n--- statement\n${text.replace(/\s+/gu, " ").slice(0, 400)}\n${plan.rows.map((row) => row["QUERY PLAN"]).join("\n")}`,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    const samples = [];
    const count = long
      ? Number(values.overviewSamples)
      : Number(values.samples);
    for (let index = 0; index < count && failure === null; index += 1) {
      const start = performance.now();
      await reader.read(report, query);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    lines.push({
      label,
      statements: planned.length,
      failure,
      firstMs: Math.round(first),
      samples: samples.length,
      p50Ms: samples.length ? Math.round(percentile(samples, 50)) : null,
      p95Ms: samples.length ? Math.round(percentile(samples, 95)) : null,
    });
    console.info(JSON.stringify(lines.at(-1)));
  }
  return { lines, plans };
};

try {
  const seedStart = performance.now();
  await seed();
  const seededMs = Math.round(performance.now() - seedStart);
  const size = (
    await db.query(
      "SELECT pg_size_pretty(pg_total_relation_size('community.analytics_events')) AS size",
    )
  ).rows[0].size;
  const { lines, plans } = await measure();
  await mkdir(values.output, { recursive: true });
  const seqScans =
    plans.join("\n").match(/Seq Scan on analytics_events/gu)?.length ?? 0;
  await writeFile(
    `${values.output}/analytics-insights-l1.json`,
    `${JSON.stringify({ serverVersionNum: version, events: EVENTS, tableSize: size, seededMs, seqScansOnEvents: seqScans, lines }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${values.output}/analytics-insights-explain.txt`,
    plans.join("\n"),
    { mode: 0o600 },
  );
  console.info(JSON.stringify({ size, seededMs, seqScansOnEvents: seqScans }));
} finally {
  await db.end();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
