import { execFile, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { benchVisitorId } from "./analytics-seed.ts";
import type { AnalyticsOracle } from "./analytics-seed.ts";
import {
  A1_CALL,
  A2_CALL,
  A3_CALL,
  A4_CALL,
  ANALYTICS_CEILING_MS,
  GATE_A_P95_MS,
  gradeA1,
  gradeA2,
  gradeA3,
  gradeA4,
} from "./paths.ts";
import type { ToolCall } from "./paths.ts";

// One analytics L1 run, started by run.mjs. First the reference paths A1 to A4 through
// the official client, graded against the oracle summed at seed time. Then sequential
// calls, one client, no model, against section 21's budgets. The clock is this process's,
// POST sent to last byte on loopback, as in l1.ts.
//
// "Cold" in the design's table means the Admin's cache cannot answer: each sample asks
// for a period no earlier sample asked for, of the same length. The databases' own
// caches stay warm there. A cold start is apart: the Umami stack restarted first, so its
// connections and shared buffers are empty. The Docker VM's page cache is not dropped and
// the canonical database is not restarted, so even that flatters a real cold start.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SAMPLES = Number(process.env.ADMIN_MCP_BENCH_SAMPLES ?? 200);
const WIDE_SAMPLES = Math.min(SAMPLES, 30);
const COLD_STARTS = Math.min(SAMPLES, 5);
/** A failing Umami costs seconds a call, and a few say what a hundred would. */
const MAX_FAILURES = 10;
const DAY_MS = 86_400_000;
const STACK = "moya-test-admin-mcp-completion-v1-umami";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error("ANALYTICS_L1_ENVIRONMENT_REQUIRED");
  return value;
};

const origin = env("ADMIN_MCP_BENCH_ORIGIN");
const endpoint = `${origin}/api/mcp`;
const { secrets } = JSON.parse(
  await readFile(env("ADMIN_MCP_BENCH_ACCESS_FILE"), "utf8"),
) as { secrets: { read: string } };
const { analyticsOracle, rows, seedMs } = JSON.parse(
  await readFile(env("ADMIN_MCP_BENCH_ORACLE_FILE"), "utf8"),
) as {
  analyticsOracle: AnalyticsOracle;
  rows: Record<string, number>;
  seedMs: number;
};
const manifest = JSON.parse(
  await readFile(env("ADMIN_MCP_BENCH_UMAMI_MANIFEST"), "utf8"),
) as Json;

const round = (value: number) => Number(value.toFixed(1));
const percentile = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;

const failures: string[] = [];

// ---- Known answers, through the official client ----

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${secrets.read}` } },
});
const client = new Client({ name: "synthetic-analytics-l1", version: "1.0.0" });
await client.connect(transport as Parameters<Client["connect"]>[0]);

const KNOWN: readonly {
  readonly task: string;
  readonly call: ToolCall;
  readonly grade: (data: Json) => readonly string[];
}[] = [
  {
    task: "A1",
    call: A1_CALL,
    grade: (data) => gradeA1(data, analyticsOracle.a1),
  },
  {
    task: "A2",
    call: A2_CALL,
    grade: (data) => gradeA2(data, analyticsOracle.a2),
  },
  {
    task: "A3",
    call: A3_CALL,
    grade: (data) => gradeA3(data, analyticsOracle.a3),
  },
  {
    task: "A4",
    call: A4_CALL,
    grade: (data) => gradeA4(data, analyticsOracle.a4),
  },
];

const knownAnswers: Json[] = [];
const answerTexts: string[] = [];
for (const { task, call, grade } of KNOWN) {
  const started = performance.now();
  const result = await client.callTool(call);
  const ms = round(performance.now() - started);
  const text = (result.content as { text: string }[])[0]!.text;
  answerTexts.push(text);
  const envelope = JSON.parse(text) as Json;
  const graded =
    envelope.ok === true
      ? grade(envelope.data as Json)
      : [`refused: ${String(envelope.code)}`];
  failures.push(...graded.map((failure) => `${task}: ${failure}`));
  knownAnswers.push({
    task,
    pass: graded.length === 0,
    ms,
    bytes: Buffer.byteLength(text),
    source: envelope.data?.source,
    sources: envelope.meta?.sources,
    failures: graded,
  });
}
// A self-only work is the most viewed in the seed, so a leak would be in these answers.
const selfOnlyTitle = new RegExp(
  `合成作品(?:${analyticsOracle.selfOnlyWorks.join("|")})(?!\\d)`,
  "u",
);
const leaked = (text: string, { idsToo }: { idsToo: boolean }) =>
  selfOnlyTitle.test(text) ||
  (idsToo && analyticsOracle.selfOnlyIds.some((id) => text.includes(id)));
if (answerTexts.some((text) => leaked(text, { idsToo: true })))
  failures.push("a self-only work in a known answer");

// Every report once, so a real Umami has answered the tool's own queries at this scale.
const everyReport: Json[] = [];
/** The Matrix: a native path carries a work's id and no title, and the id resolves to nothing. */
const once = async (
  name: string,
  args: Json,
  { nativePaths }: { readonly nativePaths: boolean } = { nativePaths: false },
) => {
  const started = performance.now();
  const result = await client.callTool({
    name: "admin_analytics",
    arguments: args,
  });
  const ms = round(performance.now() - started);
  const text = (result.content as { text: string }[])[0]!.text;
  const envelope = JSON.parse(text) as Json;
  everyReport.push({
    name,
    ok: envelope.ok,
    code: envelope.code,
    issues: envelope.issues,
    sources: envelope.meta?.sources,
    partial: envelope.meta?.partial,
    ms,
    bytes: Buffer.byteLength(text),
  });
  if (envelope.ok !== true || envelope.meta?.partial === true)
    failures.push(`${name}: ${String(envelope.code ?? "partial")}`);
  if (leaked(text, { idsToo: !nativePaths }))
    failures.push(`${name}: a self-only work in the answer`);
  return envelope;
};
const WEEK = { range: "last_7_days" };
await once("status", { report: "status" });
await once("overview_today", { report: "overview", range: "today" });
for (const dimension of ["province", "city", "device"])
  await once(`breakdown_${dimension}`, {
    report: "breakdown",
    dimension,
    ...WEEK,
  });
for (const dimension of ["surface", "event"])
  await once(`breakdown_${dimension}`, {
    report: "breakdown",
    dimension,
    ...WEEK,
  });
await once("compare_dropped_most", {
  report: "compare",
  dimension: "content",
  direction: "down",
  range: "last_week",
});
const STEPS = ["content_impression", "content_open"];
await once("funnel_same_target", {
  report: "funnel",
  steps: STEPS,
  sameTarget: true,
  ...WEEK,
});
await once("funnel_same_visit", {
  report: "funnel",
  steps: STEPS,
  sameTarget: false,
  ...WEEK,
});
const saved = await once("native_funnels", {
  report: "native",
  kind: "funnel",
  ...WEEK,
});
const savedFunnel = saved.data?.rows?.[0]?.id as string | undefined;
if (savedFunnel === undefined) failures.push("no saved funnel from bootstrap");
else
  await once("funnel_saved", {
    report: "funnel",
    funnelId: savedFunnel,
    ...WEEK,
  });
await once("realtime_with_places", { report: "realtime", include: "umami" });
await once("sessions", { report: "sessions", ...WEEK });
const umamiSessions = await once("sessions_umami", {
  report: "sessions",
  include: "umami",
  ...WEEK,
});
await once("session_visitor", {
  report: "session",
  visitorId: benchVisitorId(0),
});
const umamiSession = umamiSessions.data?.rows?.[0]?.umamiSessionId as
  string | undefined;
if (umamiSession === undefined) failures.push("no Umami session in the answer");
else
  await once("session_umami", {
    report: "session",
    umamiSessionId: umamiSession,
    ...WEEK,
  });
await once("product", { report: "product", ...WEEK });
for (const kind of ["retention", "weekly", "goal", "segment", "cohort"])
  await once(`native_${kind}`, { report: "native", kind, ...WEEK });
await once(
  "native_journey",
  { report: "native", kind: "journey", ...WEEK },
  { nativePaths: true },
);
await once("native_attribution", {
  report: "native",
  kind: "attribution",
  step: "/",
  ...WEEK,
});
await once("reconcile", { report: "reconcile", ...WEEK });

// Both stores hold one generated run, so a finished day differs only by what the
// repository's seed posted to Umami alone. Anything else is a wrong day or a wrong count.
const reconciled = (await once("reconcile_30", {
  report: "reconcile",
  range: "last_30_days",
})) as Json;
const postedPerDay = new Map<string, number>();
for (const row of manifest.collected as Json[])
  if (row.eventType === 1) {
    const day = new Date(Date.parse(row.at as string) + 8 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    postedPerDay.set(day, (postedPerDay.get(day) ?? 0) + 1);
  }
for (const day of (reconciled.data?.days ?? []) as Json[])
  if (day.diff?.pageViews !== -(postedPerDay.get(day.day as string) ?? 0))
    failures.push(
      `reconcile ${String(day.day)}: difference ${String(day.diff?.pageViews)}, expected ${-(postedPerDay.get(day.day as string) ?? 0)}`,
    );
await client.close();

// ---- Latency ----

interface Sample {
  readonly ms: number;
  readonly bytes: number;
  readonly fresh: boolean;
}

let sequence = 0;
const post = async (args: Json) => {
  sequence += 1;
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secrets.read}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: sequence,
      method: "tools/call",
      params: { name: "admin_analytics", arguments: args },
    }),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  const parsed = JSON.parse(text) as {
    result?: { content?: { text?: string }[] };
  };
  const payload = parsed.result?.content?.[0]?.text;
  return {
    ms,
    bytes: Buffer.byteLength(payload ?? text),
    envelope: payload === undefined ? undefined : (JSON.parse(payload) as Json),
  };
};

/** Did Umami's part answer, freshly? A fast answer without it is not the same answer. */
const umamiFresh = (envelope: Json) => {
  const sources = envelope.meta?.sources as Json | undefined;
  return sources?.umami === undefined || sources.umami === "ok";
};

const cacheHit = (envelope: Json) => envelope.data?.cache?.hit === true;

const classes: Json[] = [];

const measure = async (
  name: string,
  budgetMs: number,
  tool: string,
  count: number,
  argsAt: (index: number) => Json,
  options: { readonly expectHit?: boolean } = {},
) => {
  const samples: Sample[] = [];
  let firstMs: number | undefined;
  let failed = 0;
  const codes = new Map<string, number>();
  const statuses = new Map<string, number>();
  const from = new Date().toISOString();
  for (let index = 0; index <= count; index += 1) {
    const { ms, bytes, envelope } = await post(argsAt(index));
    if (envelope?.ok !== true) {
      failed += 1;
      const code = String(envelope?.code);
      codes.set(code, (codes.get(code) ?? 0) + 1);
      if (failed >= MAX_FAILURES) {
        failures.push(`${name}: stopped after ${failed} failed calls`);
        break;
      }
      continue;
    }
    const umami = String(envelope.meta?.sources?.umami ?? "not_read");
    statuses.set(umami, (statuses.get(umami) ?? 0) + 1);
    if (options.expectHit === true && index > 0 && !cacheHit(envelope))
      failures.push(`${name}: sample ${index} was not a cache hit`);
    if (options.expectHit === false && cacheHit(envelope))
      failures.push(`${name}: sample ${index} was a cache hit`);
    // The first call of a class is reported apart, as the design asks.
    if (index === 0) firstMs = ms;
    else samples.push({ ms, bytes, fresh: umamiFresh(envelope) });
  }
  const to = new Date().toISOString();
  const sorted = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  if (sorted.length === 0) {
    classes.push({
      name,
      tool,
      from,
      to,
      budgetMs,
      withinBudget: false,
      samples: 0,
      failed,
      codes: Object.fromEntries(codes),
    });
    return;
  }
  const umamiNotFresh = samples.filter(({ fresh }) => !fresh).length;
  const p95 = round(percentile(sorted, 0.95));
  classes.push({
    name,
    tool,
    from,
    to,
    budgetMs,
    // A failure or a part that did not answer never counts as fast.
    withinBudget: p95 <= budgetMs && failed === 0 && umamiNotFresh === 0,
    overCeiling: p95 > ANALYTICS_CEILING_MS,
    firstMs: firstMs === undefined ? null : round(firstMs),
    samples: samples.length,
    p50: round(percentile(sorted, 0.5)),
    p95,
    max: round(sorted.at(-1)!),
    failed,
    umamiNotFresh,
    umamiStatuses: Object.fromEntries(statuses),
    codes: Object.fromEntries(codes),
    responseBytesMax: Math.max(...samples.map(({ bytes }) => bytes)),
  });
};

/** A finished period of `days` days no other sample asks for: it moves by a minute. */
const clock = manifest.clock as { today: number };
const period = (days: number, index: number) => {
  const end = clock.today - DAY_MS - index * 60_000;
  const wall = (at: number) =>
    `${new Date(at + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
  return { from: wall(end - days * DAY_MS), to: wall(end) };
};

const before = os.loadavg();
const startedAt = new Date().toISOString();

await measure(
  "overview_cached",
  GATE_A_P95_MS.analytics_cached,
  "admin_analytics",
  SAMPLES,
  () => ({ report: "overview", range: "last_7_days" }),
  { expectHit: true },
);
for (const [label, days, count] of [
  ["7d", 7, SAMPLES],
  ["30d", 30, WIDE_SAMPLES],
  ["85d", 85, WIDE_SAMPLES],
] as const)
  await measure(
    `overview_cold_${label}`,
    GATE_A_P95_MS.analytics_canonical_cold,
    "admin_analytics",
    count,
    (index) => ({ report: "overview", ...period(days, index + 1) }),
    { expectHit: false },
  );

const UMAMI_DIMENSIONS = ["province", "city", "device"];
await measure(
  "breakdown_umami_cached",
  GATE_A_P95_MS.analytics_cached,
  "admin_analytics",
  SAMPLES,
  () => ({
    report: "breakdown",
    range: "last_7_days",
    dimension: "province",
  }),
  { expectHit: true },
);
for (const [label, days, count] of [
  ["7d", 7, SAMPLES],
  ["30d", 30, WIDE_SAMPLES],
  ["170d", 170, WIDE_SAMPLES],
] as const)
  await measure(
    `breakdown_umami_cold_${label}`,
    GATE_A_P95_MS.analytics_umami_cold,
    "admin_analytics",
    count,
    (index) => ({
      report: "breakdown",
      dimension: UMAMI_DIMENSIONS[index % UMAMI_DIMENSIONS.length],
      // A longer range than 170 days would pass the store's first row.
      ...period(days, index + 1 + 2_000),
    }),
  );
// The canonical dimensions of the same report, against the canonical class's budget.
await measure(
  "breakdown_content_cold_7d",
  GATE_A_P95_MS.analytics_canonical_cold,
  "admin_analytics",
  SAMPLES,
  (index) => ({
    report: "breakdown",
    dimension: "content",
    ...period(7, index + 1 + 4_000),
  }),
  { expectHit: false },
);

// A wide overview answers at the soft budget without Umami. The read it gave up on runs
// on and fills the cache, so the same question asked again has Umami's part.
const widePeriod = period(30, 8_000);
const gaveUp = await post({ report: "overview", ...widePeriod });
await delay(10_000);
const askedAgain = await post({ report: "overview", ...widePeriod });
const wideFollowUp = {
  first: {
    ms: round(gaveUp.ms),
    umami: gaveUp.envelope?.meta?.sources?.umami ?? "not_read",
  },
  again: {
    ms: round(askedAgain.ms),
    umami: askedAgain.envelope?.meta?.sources?.umami ?? "not_read",
  },
};
if (wideFollowUp.again.umami !== "ok")
  failures.push(`the same wide overview again: ${wideFollowUp.again.umami}`);

// ---- Cold starts ----

const exec = promisify(execFile);
const coldStart: Json[] = [];
const restartUmami = async () => {
  await exec("docker", ["restart", `${STACK}-pg`], { timeout: 60_000 });
  await exec("docker", ["restart", STACK], { timeout: 60_000 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const database = await exec("docker", [
      "exec",
      `${STACK}-pg`,
      "pg_isready",
      "-U",
      "umami_qa",
      "-d",
      "umami",
    ]).catch(() => undefined);
    const response = await fetch(
      `${manifest.origin as string}/admin/analytics-workspace/api/heartbeat`,
      { signal: AbortSignal.timeout(2_000) },
    ).catch(() => undefined);
    if (database !== undefined && response?.ok) return;
    if (Date.now() > deadline) throw new Error("UMAMI_DID_NOT_RESTART");
    await delay(250);
  }
};
for (let round2 = 0; round2 < COLD_STARTS; round2 += 1) {
  await restartUmami();
  const overview = await post({
    report: "overview",
    ...period(7, 6_000 + round2),
  });
  coldStart.push({
    name: `overview_7d_${round2}`,
    ms: round(overview.ms),
    ok: overview.envelope?.ok === true,
    umami: overview.envelope?.meta?.sources?.umami ?? "not_read",
  });
  await restartUmami();
  const breakdown = await post({
    report: "breakdown",
    dimension: "province",
    ...period(7, 7_000 + round2),
  });
  coldStart.push({
    name: `breakdown_province_7d_${round2}`,
    ms: round(breakdown.ms),
    ok: breakdown.envelope?.ok === true,
    umami: breakdown.envelope?.meta?.sources?.umami ?? "not_read",
  });
}

await writeFile(
  env("ADMIN_MCP_BENCH_RESULT_FILE"),
  JSON.stringify({
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      worktreeDirty:
        execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }) !==
        "",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0]?.model,
      cpus: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      loadBefore: before,
      loadAfter: os.loadavg(),
      clock: "client, POST sent to last byte, loopback",
      server: "Next standalone production build",
      backend: "backend-runtime analytics routes on the App role, own process",
      umami: {
        image: manifest.image,
        imageId: manifest.imageId,
        limits: manifest.limits,
        counts: manifest.counts,
        collectorParity: manifest.collectorParity,
      },
      canonicalEvents: manifest.events,
      seededRows: rows,
      seedMs,
    },
    failures,
    knownAnswers,
    everyReport,
    classes,
    wideFollowUp,
    coldStart,
  }),
  { mode: 0o600 },
);
if (failures.length > 0) process.exitCode = 1;
