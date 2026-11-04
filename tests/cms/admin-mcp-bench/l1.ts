import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  CHART,
  finestSurviving,
  readStrokes,
  SURVIVES_AT,
} from "./legibility.ts";
import type { StrokeReading } from "./legibility.ts";
import { C1_CALL, c4Calls, GATE_A_P95_MS, gradeC1, gradeC4 } from "./paths.ts";
import { BENCH_SCALE, catalogIdOf, sourceIdOf } from "./seed.ts";
import type { BenchOracle } from "./seed.ts";

// One L1 run against the Next production build over real HTTP, started by run.mjs.
// Sequential, one client, no model. Gate A asks for at least 200 calls per class;
// classes below that say so. The clock is this process's, POST sent to last byte on
// loopback: an upper bound on the design's POST received to last byte, and run.mjs
// adds the server's own clock beside it from the audit rows.

const SAMPLES = 200;
const SLOW_SAMPLES = 30;
const TRIALS = 30;

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error("L1_ENVIRONMENT_REQUIRED");
  return value;
};

const origin = env("ADMIN_MCP_BENCH_ORIGIN");
const endpoint = `${origin}/api/mcp`;
const { secrets, chartMediaId } = JSON.parse(
  await readFile(env("ADMIN_MCP_BENCH_ACCESS_FILE"), "utf8"),
) as { secrets: { read: string; full: string }; chartMediaId: string };
const { oracle, rows, seedMs } = JSON.parse(
  await readFile(env("ADMIN_MCP_BENCH_ORACLE_FILE"), "utf8"),
) as {
  oracle: BenchOracle;
  rows: Record<string, number>;
  seedMs: number;
};

const percentile = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;
const round = (value: number) => Number(value.toFixed(1));

interface Sample {
  readonly ms: number;
  readonly bytes: number;
  readonly variant: string;
}

const summarize = (samples: readonly Sample[]) => {
  const sorted = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  return {
    samples: samples.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)!),
  };
};

let sequence = 0;
const post = async (method: string, params: Record<string, unknown>) => {
  sequence += 1;
  const body = JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params });
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secrets.full}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body,
  });
  const text = await response.text();
  const ms = performance.now() - started;
  return { ms, status: response.status, text };
};

interface Call {
  readonly variant: string;
  readonly method?: string;
  readonly params: Record<string, unknown>;
}

const toolCall = (
  variant: string,
  name: string,
  args: Record<string, unknown>,
): Call => ({ variant, params: { name, arguments: args } });

const classes: Record<string, unknown>[] = [];
const failures: string[] = [];

/** A failed sample never counts as fast: it stops the class and is reported. */
const measure = async (
  name: string,
  budgetMs: number,
  tool: string | undefined,
  count: number,
  callAt: (index: number, previous: unknown) => Call,
) => {
  const samples: Sample[] = [];
  let firstMs: number | undefined;
  let previous: unknown;
  const from = new Date().toISOString();
  for (let index = 0; index <= count; index += 1) {
    const { variant, method, params } = callAt(index, previous);
    const { ms, status, text } = await post(method ?? "tools/call", params);
    const parsed = JSON.parse(text) as {
      result?: { content?: { text?: string }[] };
      error?: unknown;
    };
    const payload = parsed.result?.content?.[0]?.text;
    const envelope = payload === undefined ? undefined : JSON.parse(payload);
    if (
      status !== 200 ||
      parsed.error !== undefined ||
      (method === undefined && envelope?.ok !== true)
    ) {
      failures.push(
        `${name}/${variant}: HTTP ${status}, ${String(envelope?.code)}`,
      );
      break;
    }
    previous = envelope;
    // The first call of a class is reported apart, as the design asks.
    if (index === 0) firstMs = ms;
    else
      samples.push({
        ms,
        bytes: Buffer.byteLength(payload ?? text),
        variant,
      });
  }
  const to = new Date().toISOString();
  if (samples.length === 0) return;
  const stats = summarize(samples);
  const variants = Object.fromEntries(
    [...new Set(samples.map(({ variant }) => variant))].map((variant) => [
      variant,
      summarize(samples.filter((sample) => sample.variant === variant)),
    ]),
  );
  classes.push({
    name,
    tool,
    from,
    to,
    budgetMs,
    withinBudget: stats.p95 <= budgetMs,
    firstMs: round(firstMs!),
    ...stats,
    responseBytesMax: Math.max(...samples.map(({ bytes }) => bytes)),
    variants,
  });
};

/** Walks the whole range, so no class rereads one warm row. */
const recordAt = (index: number) =>
  1 + ((index * 1_543) % BENCH_SCALE.catalogs);

const before = os.loadavg();
const startedAt = new Date().toISOString();

await measure(
  "door_whoami",
  GATE_A_P95_MS.door_floor,
  "admin_whoami",
  SAMPLES,
  () => toolCall("whoami", "admin_whoami", {}),
);
await measure(
  "door_tools_list",
  GATE_A_P95_MS.door_floor,
  undefined,
  SAMPLES,
  () => ({
    variant: "tools/list",
    method: "tools/list",
    params: {},
  }),
);

const EXACT = [
  (at: number) =>
    toolCall("catalogId", "admin_find", { query: catalogIdOf(at) }),
  (at: number) => toolCall("sourceId", "admin_find", { query: sourceIdOf(at) }),
  (at: number) =>
    toolCall("catalog_link", "admin_find", {
      query: `/catalog/${catalogIdOf(at)}`,
    }),
  (at: number) =>
    toolCall("provenance_sourceId", "admin_find", {
      query: `bench-provenance-${String(4 * (1 + (at % 1_250))).padStart(5, "0")}`,
    }),
  (at: number) =>
    toolCall("row_id_typed", "admin_find", {
      query: String(at),
      type: "catalog",
    }),
];
await measure(
  "exact_locate",
  GATE_A_P95_MS.exact_locate,
  "admin_find",
  SAMPLES,
  (index) => EXACT[index % EXACT.length]!(recordAt(index)),
);

await measure(
  "single_read_outline",
  GATE_A_P95_MS.single_read,
  "admin_get",
  SAMPLES,
  (index) =>
    toolCall("outline", "admin_get", { type: "catalog", id: recordAt(index) }),
);
await measure(
  "single_read_window",
  GATE_A_P95_MS.single_read,
  "admin_get",
  SAMPLES,
  (index) =>
    toolCall("field_window_90k", "admin_get", {
      type: "catalog",
      id: oracle.longTextIds[index % oracle.longTextIds.length],
      field: "transcription",
      offset: (index * 997) % 80_000,
      maxChars: 2_000,
    }),
);

const LIST_VARIANTS: readonly [string, Record<string, unknown>][] = [
  ["drafts", { op: "list.catalogs", pageSize: 25 }],
  [
    "missing_transcription",
    {
      op: "list.catalogs",
      pageSize: 25,
      input: { filter: { missing: ["transcription"] } },
    },
  ],
  [
    "all_with_fields",
    {
      op: "list.catalogs",
      pageSize: 25,
      fields: ["dynasty", "transcription", "mediaCount"],
      input: { filter: { status: "all" } },
    },
  ],
];
await measure(
  "list_page_25",
  GATE_A_P95_MS.list_page,
  "admin_read",
  SAMPLES,
  (index, previous) => {
    const [variant, args] =
      LIST_VARIANTS[Math.floor(index / 20) % LIST_VARIANTS.length]!;
    // Twenty pages deep along `next`, as a client goes, then the next variant.
    const next = (
      previous as { next?: { args?: Record<string, unknown> } } | undefined
    )?.next?.args;
    return toolCall(
      variant,
      "admin_read",
      index % 20 === 0 || !next ? args : next,
    );
  },
);

const AGGREGATES: readonly [string, Record<string, unknown>][] = [
  ["c1_missing_by_dynasty", C1_CALL.arguments],
  [
    "all_by_province",
    {
      op: "list.catalogs",
      view: "count",
      groupBy: "province",
      input: { filter: { status: "all" } },
    },
  ],
  [
    "total_only",
    {
      op: "list.catalogs",
      view: "count",
      input: { filter: { status: "all" } },
    },
  ],
];
await measure(
  "aggregate",
  GATE_A_P95_MS.aggregate,
  "admin_read",
  SAMPLES,
  (index) => {
    const [variant, args] = AGGREGATES[index % AGGREGATES.length]!;
    return toolCall(variant, "admin_read", args);
  },
);

const FUZZY = ["造像记", "經石峪", "张迁碑", "合成1234", "没有这样的碑文记载"];
await measure(
  "fuzzy_locate",
  GATE_A_P95_MS.fuzzy_locate,
  "admin_find",
  SAMPLES,
  (index) =>
    toolCall(`q${index % FUZZY.length}`, "admin_find", {
      query: FUZZY[index % FUZZY.length],
    }),
);

await measure(
  "media_view_thumb",
  GATE_A_P95_MS.media_view,
  "admin_view_media",
  SLOW_SAMPLES,
  () =>
    toolCall("catalog_thumb", "admin_view_media", {
      kind: "catalog_thumb",
      mediaId: chartMediaId,
    }),
);
interface Region {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
const NATIVE_REGION: Region = {
  left: CHART.left,
  top: CHART.top,
  width: 3 * CHART.patch + 2 * CHART.gap,
  height: CHART.patch,
};
const WHOLE: Region = {
  left: 0,
  top: 0,
  width: CHART.width,
  height: CHART.height,
};
// A JPEG decodes from the top, so a passage at the bottom costs the most.
const ORIGINAL_REGIONS: readonly [string, Region][] = [
  ["passage_top", NATIVE_REGION],
  ["passage_bottom", { ...NATIVE_REGION, top: CHART.height - CHART.patch }],
  ["whole", WHOLE],
];
await measure(
  "media_view_original",
  GATE_A_P95_MS.media_view,
  "admin_view_media",
  SLOW_SAMPLES,
  (index) => {
    const [variant, region] =
      ORIGINAL_REGIONS[index % ORIGINAL_REGIONS.length]!;
    return toolCall(variant, "admin_view_media", {
      kind: "catalog_original",
      mediaId: chartMediaId,
      region,
    });
  },
);

// The reference paths, through the official client a real agent uses.
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${secrets.read}` } },
});
const client = new Client({ name: "synthetic-l1", version: "1.0.0" });
const connectStarted = performance.now();
await client.connect(transport as Parameters<Client["connect"]>[0]);
const connectMs = round(performance.now() - connectStarted);

const dataOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const { text } = (result.content as { text: string }[])[0]!;
  return {
    bytes: Buffer.byteLength(text),
    data: (JSON.parse(text) as { data?: unknown }).data,
  };
};

const trial = async (
  name: string,
  run: (
    index: number,
  ) => Promise<{ calls: number; bytes: number; failures: readonly string[] }>,
) => {
  const samples: number[] = [];
  let calls = 0;
  let bytes = 0;
  const graded: string[] = [];
  for (let index = 0; index < TRIALS; index += 1) {
    const started = performance.now();
    const outcome = await run(index);
    samples.push(performance.now() - started);
    calls = outcome.calls;
    bytes = Math.max(bytes, outcome.bytes);
    graded.push(...outcome.failures);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  failures.push(...graded.map((failure) => `${name}: ${failure}`));
  const row = {
    trials: samples.length,
    toolCalls: calls,
    pass: graded.length === 0,
    firstMs: round(samples[0]!),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    responseBytesMax: bytes,
  };
  return row;
};

const c1 = await trial("C1", async () => {
  const answer = dataOf(await client.callTool(C1_CALL));
  return {
    calls: 1,
    bytes: answer.bytes,
    failures: gradeC1(answer.data, oracle.c1),
  };
});

const C4_STATES = ["published", "draft", "draft_over_published"] as const;
const c4 = await trial("C4_id_and_state", async (index) => {
  const state = C4_STATES[index % C4_STATES.length]!;
  const { id, catalogId } = oracle.c4[state];
  const { find, get } = c4Calls(catalogId, id);
  const found = dataOf(await client.callTool(find));
  const got = dataOf(await client.callTool(get));
  return {
    calls: 2,
    bytes: Math.max(found.bytes, got.bytes),
    failures: gradeC4(found.data, got.data, { id, state }),
  };
});

// What each way of viewing a high-detail original keeps. The mechanism only.
const viewed = async (args: Record<string, unknown>) => {
  const result = await client.callTool({
    name: "admin_view_media",
    arguments: { mediaId: chartMediaId, ...args },
  });
  const content = result.content as {
    text?: string;
    data?: string;
  }[];
  const { data } = JSON.parse(content[0]!.text!) as {
    data: { rendered: { width: number; height: number; bytes: number } };
  };
  return {
    rendered: data.rendered,
    webp: Buffer.from(content[1]!.data!, "base64"),
  };
};
const legibilityRow = async (
  label: string,
  args: Record<string, unknown>,
  region: Region,
) => {
  const { rendered, webp } = await viewed(args);
  const readings: readonly StrokeReading[] = await readStrokes(webp, region);
  return { label, rendered, finestStroke: finestSurviving(readings), readings };
};
const legibility = {
  survivesAt: SURVIVES_AT,
  realRubbing: "NOT TESTED",
  source: { width: CHART.width, height: CHART.height, synthetic: true },
  views: [
    await legibilityRow("catalog_thumb", { kind: "catalog_thumb" }, WHOLE),
    await legibilityRow(
      "catalog_original whole, default edge",
      { kind: "catalog_original", region: WHOLE },
      WHOLE,
    ),
    await legibilityRow(
      "catalog_original passage, native pixels",
      { kind: "catalog_original", region: NATIVE_REGION },
      NATIVE_REGION,
    ),
  ],
};

await client.close();

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
      seededRows: rows,
      seedMs,
      connectMs,
      notSeeded:
        "1M Umami events (no S3 tool reads them; see design section 21)",
    },
    failures,
    classes,
    trials: { C1: c1, C4_id_and_state: c4 },
    legibility,
  }),
  { mode: 0o600 },
);
if (failures.length > 0) process.exitCode = 1;
