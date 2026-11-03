import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { MappedStorageUrlResolver } from "@moya/image";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_VIEW_MEDIA_MAX_BYTES,
  adminMcpEnvelopeSchema,
  adminReadRowsDataSchema,
  adminViewMediaDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "../../unit/backend/community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "../../unit/backend/community-identity-fixture.js";
import { connectClient, serveRoutes } from "../admin-mcp-wire.js";
import { CHART, finestSurviving, readStrokes } from "./legibility.ts";
import { C1_CALL, c4Calls, GATE_A_P95_MS, gradeC1, gradeC4 } from "./paths.ts";
import type { ToolCall } from "./paths.ts";
import { BENCH_SCALE, catalogIdOf, sourceIdOf } from "./seed.ts";
import type { BenchOracle } from "./seed.ts";

// L0, the CI floor of admin-mcp-completion-v1 section 21, at seeded scale: tools/list
// sizes, each reference path replayed over real JSON-RPC with the official client and
// graded against the seed's oracle, response caps, SQL statements per call, no
// sequential scan on a large table. Wall-clock is no gate on a shared runner, only an
// alarm at three times the budget. run.mjs seeds and removes the database.

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

const access = JSON.parse(
  await readFile(process.env.ADMIN_MCP_BENCH_ACCESS_FILE!, "utf8"),
) as {
  secrets: Record<"read" | "full", string>;
  chartMediaId: string;
};
const { oracle, rows } = JSON.parse(
  await readFile(process.env.ADMIN_MCP_BENCH_ORACLE_FILE!, "utf8"),
) as { oracle: BenchOracle; rows: Record<string, number> };

/** This bench's own ceiling: the design asks for a check and names no number. */
const DESCRIPTION_MAX_CHARS = 1_024;
/** Enough to read a p95 off, cheap enough for CI. */
const TIMING_SAMPLES = 20;

/**
 * Statements one call may run, audit row and transaction control included: reads
 * measured at this scale, pinned so a new read per row or per call fails here.
 */
const STATEMENTS = {
  door_whoami: 5,
  door_tools_list: 3,
  exact_locate: 9,
  exact_locate_miss_to_identity: 13,
  single_read: 10,
  list_page: 7,
  aggregate: 6,
} as const;

interface Pool {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ release(): void }>;
}

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

let payload: Payload;
let pool: Pool;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let largeTables: ReadonlySet<string>;
let restoreCapture: () => void;
const clients: Record<string, Client> = {};
const captured: Statement[] = [];
let capturing = false;
const reportRows: Record<string, unknown>[] = [];

/** Every statement of the process, from the driver's own query method. */
const installCapture = async () => {
  const client = await pool.connect();
  const proto = Object.getPrototypeOf(client) as {
    query: (...args: unknown[]) => unknown;
  };
  client.release();
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    if (capturing) {
      const first = args[0] as
        string | { text?: string; values?: readonly unknown[] };
      const text = typeof first === "string" ? first : (first.text ?? "");
      const values =
        (Array.isArray(args[1])
          ? (args[1] as readonly unknown[])
          : undefined) ??
        (typeof first === "object" ? first.values : undefined) ??
        [];
      captured.push({ text, values });
    }
    return original.apply(this, args);
  };
  return () => {
    proto.query = original;
  };
};

const percentile = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { text: string }[])[0]!.text;

const measured = async <T>(work: () => Promise<T>) => {
  captured.length = 0;
  capturing = true;
  const started = performance.now();
  const value = await work();
  const ms = performance.now() - started;
  capturing = false;
  return { value, ms, statements: [...captured] };
};

const callOn = async (call: ToolCall, key: "read" | "full" = "read") => {
  const { value, ms, statements } = await measured(() =>
    clients[key]!.callTool(call as never),
  );
  const text = textOf(value);
  const bytes = Buffer.byteLength(text);
  expect(bytes).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(JSON.parse(text));
  return { envelope, bytes, ms, statements };
};

const seqScansOf = (plan: Record<string, unknown>): string[] => [
  ...(plan["Node Type"] === "Seq Scan" ? [String(plan["Relation Name"])] : []),
  ...((plan.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(
    seqScansOf,
  ),
];

/** The planner's own answer for what a call really ran, with its real parameters. */
const largeSeqScans = async (statements: readonly Statement[]) => {
  const found = new Set<string>();
  for (const { text, values } of statements) {
    if (!/^\s*select/iu.test(text)) continue;
    const { rows: plan } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${text}`,
      values,
    );
    const [{ Plan }] = plan[0]!["QUERY PLAN"] as [
      { Plan: Record<string, unknown> },
    ];
    for (const table of seqScansOf(Plan))
      if (largeTables.has(table)) found.add(table);
  }
  return [...found];
};

const report = (row: {
  name: string;
  budgetMs: number;
  ms: readonly number[];
  statements: number;
  bytes: number;
  seqScans: readonly string[];
}) => {
  const sorted = [...row.ms].sort((a, b) => a - b);
  const p95 = Number(percentile(sorted, 0.95).toFixed(1));
  reportRows.push({
    name: row.name,
    budgetMs: row.budgetMs,
    samples: sorted.length,
    p50: Number(percentile(sorted, 0.5).toFixed(1)),
    p95,
    alarm: p95 > row.budgetMs * 3,
    statements: row.statements,
    bytes: row.bytes,
    seqScans: row.seqScans,
  });
};

/** One class: its statement ceiling and plans on one call, its timing on several. */
const checkClass = async (
  name: string,
  budgetMs: number,
  ceiling: number,
  callAt: (index: number) => ToolCall,
) => {
  const first = await callOn(callAt(0));
  expect(first.envelope.ok).toBe(true);
  expect(first.statements.length).toBeLessThanOrEqual(ceiling);
  const seqScans = await largeSeqScans(first.statements);
  expect(seqScans).toEqual([]);
  const ms: number[] = [];
  let bytes = first.bytes;
  let statements = first.statements.length;
  for (let index = 1; index <= TIMING_SAMPLES; index += 1) {
    const sample = await callOn(callAt(index));
    expect(sample.envelope.ok).toBe(true);
    expect(sample.statements.length).toBeLessThanOrEqual(ceiling);
    bytes = Math.max(bytes, sample.bytes);
    statements = Math.max(statements, sample.statements.length);
    ms.push(sample.ms);
  }
  report({ name, budgetMs, ms, statements, bytes, seqScans });
};

/** Read paths may write only their audit row: this is the rest of the final state. */
const contentState = async () => {
  const { rows: state } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM catalogs) AS catalogs,
       (SELECT count(*)::int FROM _catalogs_v) AS versions,
       (SELECT sum(revision)::int FROM catalogs) AS revisions,
       (SELECT max(updated_at) FROM catalogs) AS updated,
       (SELECT count(*)::int FROM editorial_receipts) AS receipts`,
  );
  return state[0];
};

const recordAt = (index: number) =>
  1 + ((index * 1_543) % BENCH_SCALE.catalogs);

beforeAll(async () => {
  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  pool = payload.db.pool as unknown as Pool;
  server = await serveRoutes(config);
  for (const key of ["read", "full"] as const)
    clients[key] = (
      await connectClient(server.endpoint, {
        authorization: `Bearer ${access.secrets[key]}`,
      })
    ).client;
  const { rows: tables } = await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.reltuples >= 1000`,
  );
  largeTables = new Set(tables.map(({ relname }) => String(relname)));
  restoreCapture = await installCapture();
});

afterAll(async () => {
  restoreCapture?.();
  await Promise.all(Object.values(clients).map((client) => client.close()));
  await server?.close();
  await payload?.db?.destroy?.();
  if (process.env.ADMIN_MCP_BENCH_REPORT_FILE)
    await writeFile(
      process.env.ADMIN_MCP_BENCH_REPORT_FILE,
      JSON.stringify({ rows, classes: reportRows }),
      { mode: 0o600 },
    );
});

describe("the seed", () => {
  it("holds the target scale, one latest version per record", async () => {
    expect(rows.catalogs).toBe(BENCH_SCALE.catalogs);
    expect(rows.catalogVersions).toBeGreaterThan(2 * BENCH_SCALE.catalogs);
    const { rows: latest } = await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT parent_id)::int AS records
       FROM _catalogs_v WHERE latest`,
    );
    expect(latest[0]).toEqual({
      n: BENCH_SCALE.catalogs,
      records: BENCH_SCALE.catalogs,
    });
    expect(largeTables).toContain("_catalogs_v");
    expect(largeTables).toContain("catalogs");
  });

  it("is real to the read path: seeded content parses, so a fingerprint exists", async () => {
    for (const state of [
      "published",
      "draft",
      "draft_over_published",
    ] as const) {
      const { envelope } = await callOn({
        name: "admin_get",
        arguments: { type: "catalog", id: oracle.c4[state].id },
      });
      expect(envelope.ok).toBe(true);
      expect(
        (envelope.data as { fingerprint: string | null }).fingerprint,
      ).toMatch(/^[0-9a-f]{64}$/u);
      expect((envelope.data as { state: string }).state).toBe(state);
    }
  });
});

describe("tools/list", () => {
  it.each(["read", "full"] as const)(
    "keeps the %s profile within its token budget and its descriptions short",
    async (key) => {
      const { value, ms, statements } = await measured(() =>
        clients[key]!.listTools(),
      );
      const bytes = Buffer.byteLength(JSON.stringify(value.tools));
      expect(bytes / 3).toBeLessThanOrEqual(ADMIN_MCP_TOKEN_BUDGET);
      for (const tool of value.tools)
        expect(tool.description?.length ?? 0).toBeLessThanOrEqual(
          DESCRIPTION_MAX_CHARS,
        );
      expect(statements.length).toBeLessThanOrEqual(STATEMENTS.door_tools_list);
      expect(await largeSeqScans(statements)).toEqual([]);
      report({
        name: `tools_list_${key}`,
        budgetMs: GATE_A_P95_MS.door_floor,
        ms: [ms],
        statements: statements.length,
        bytes,
        seqScans: [],
      });
    },
  );
});

describe("the door floor", () => {
  it("answers admin_whoami within its statements, with no large scan", async () => {
    await checkClass(
      "door_whoami",
      GATE_A_P95_MS.door_floor,
      STATEMENTS.door_whoami,
      () => ({ name: "admin_whoami", arguments: {} }),
    );
  });
});

describe("C1 reference path", () => {
  it("counts drafts missing a transcription, by dynasty, exactly", async () => {
    const state = await contentState();
    const { envelope, statements, bytes, ms } = await callOn(C1_CALL);
    expect(envelope.ok).toBe(true);
    expect(gradeC1(envelope.data, oracle.c1)).toEqual([]);
    expect(oracle.c1.total).toBeGreaterThan(0);
    expect(oracle.c1.groups.length).toBeGreaterThan(3);
    expect(await contentState()).toEqual(state);
    expect(statements.length).toBeLessThanOrEqual(STATEMENTS.aggregate);
    const seqScans = await largeSeqScans(statements);
    report({
      name: "C1",
      budgetMs: GATE_A_P95_MS.aggregate,
      ms: [ms],
      statements: statements.length,
      bytes,
      seqScans,
    });
    expect(seqScans).toEqual([]);
  });
});

describe("C4 reference path", () => {
  it.each(["published", "draft", "draft_over_published"] as const)(
    "resolves the link of a %s record and says its state, in two calls",
    async (state) => {
      const before = await contentState();
      const { id, catalogId } = oracle.c4[state];
      const { find, get } = c4Calls(catalogId, id);
      const found = await callOn(find);
      const got = await callOn(get);
      expect(
        gradeC4(found.envelope.data, got.envelope.data, { id, state }),
      ).toEqual([]);
      expect(await contentState()).toEqual(before);
      const seqScans = await largeSeqScans([
        ...found.statements,
        ...got.statements,
      ]);
      report({
        name: `C4_${state}`,
        budgetMs: GATE_A_P95_MS.exact_locate + GATE_A_P95_MS.single_read,
        ms: [found.ms + got.ms],
        statements: found.statements.length + got.statements.length,
        bytes: Math.max(found.bytes, got.bytes),
        seqScans,
      });
      expect(seqScans).toEqual([]);
    },
  );
});

describe("the other classes at scale", () => {
  it("locates exactly by catalogId, sourceId and link", async () => {
    const variants = [
      (at: number) => ({ query: catalogIdOf(at) }),
      (at: number) => ({ query: sourceIdOf(at) }),
      (at: number) => ({ query: `/catalog/${catalogIdOf(at)}` }),
    ];
    await checkClass(
      "exact_locate",
      GATE_A_P95_MS.exact_locate,
      STATEMENTS.exact_locate,
      (index) => ({
        name: "admin_find",
        arguments: variants[index % variants.length]!(recordAt(index)),
      }),
    );
  });

  it("locates a sourceId bound only in provenance, through the claim table", async () => {
    await checkClass(
      "exact_locate_provenance",
      GATE_A_P95_MS.exact_locate,
      STATEMENTS.exact_locate_miss_to_identity,
      (index) => ({
        name: "admin_find",
        arguments: {
          query: `bench-provenance-${String(4 * (1 + index)).padStart(5, "0")}`,
        },
      }),
    );
  });

  it("reads one record's outline", async () => {
    await checkClass(
      "single_read",
      GATE_A_P95_MS.single_read,
      STATEMENTS.single_read,
      (index) => ({
        name: "admin_get",
        arguments: { type: "catalog", id: recordAt(index) },
      }),
    );
  });

  it("pages 25 rows", async () => {
    await checkClass(
      "list_page",
      GATE_A_P95_MS.list_page,
      STATEMENTS.list_page,
      () => ({
        name: "admin_read",
        arguments: {
          op: "list.catalogs",
          pageSize: 25,
          input: { filter: { missing: ["transcription"] } },
        },
      }),
    );
  });

  it("costs no extra read per row: 25 rows run what one row runs", async () => {
    const page = (pageSize: number) =>
      callOn({
        name: "admin_read",
        arguments: {
          op: "list.catalogs",
          pageSize,
          fields: ["dynasty", "transcription", "mediaCount"],
          input: { filter: { status: "all" } },
        },
      });
    const one = await page(1);
    const many = await page(25);
    expect(adminReadRowsDataSchema.parse(one.envelope.data).rows).toHaveLength(
      1,
    );
    expect(adminReadRowsDataSchema.parse(many.envelope.data).rows).toHaveLength(
      25,
    );
    expect(many.statements.length).toBe(one.statements.length);
  });

  it("cuts an oversized page at a whole row, under the cap, and says where to go on", async () => {
    const { envelope } = await callOn({
      name: "admin_read",
      arguments: {
        op: "list.catalogs",
        pageSize: 100,
        view: "full",
        input: { filter: { status: "all" } },
      },
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.truncated).toBe(true);
    expect(envelope.next?.tool).toBe("admin_read");
    expect(
      adminReadRowsDataSchema.parse(envelope.data).rows.length,
    ).toBeGreaterThan(0);
  });

  it("counts in SQL", async () => {
    await checkClass(
      "aggregate",
      GATE_A_P95_MS.aggregate,
      STATEMENTS.aggregate,
      () => C1_CALL,
    );
  });
});

// Synthetic only, so it proves the mechanism and nothing about a real rubbing.
describe("what each view of a high-detail original keeps", () => {
  const baseToken = randomBytes(32).toString("base64url");
  let backend: Server;
  let backendOrigin: string;
  let thumbnail: Buffer;

  beforeAll(async () => {
    thumbnail = await readFile(process.env.ADMIN_MCP_BENCH_THUMBNAIL_FILE!);
    backend = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: new InMemoryCommunityIdentityPort(),
        storageUrlResolver: new MappedStorageUrlResolver(new Map()),
        communityCommentPort: new InMemoryCommunityCommentPort(),
        operatorAiBaseCredential: baseToken,
        catalogThumbnail: async () => ({
          bytes: thumbnail,
          mimeType: "image/webp",
        }),
      }),
    );
    const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
    backendOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await stopServer(backend);
  });

  const view = async (args: Record<string, unknown>) => {
    const result = await clients.read!.callTool({
      name: "admin_view_media",
      arguments: { mediaId: access.chartMediaId, ...args },
    });
    expect(result.structuredContent).toBeUndefined();
    const content = result.content as { text?: string; data?: string }[];
    const envelope = adminMcpEnvelopeSchema.parse(
      JSON.parse(content[0]!.text!),
    );
    expect(envelope.ok).toBe(true);
    const data = adminViewMediaDataSchema.parse(envelope.data);
    const webp = Buffer.from(content[1]!.data!, "base64");
    expect(webp.byteLength).toBe(data.rendered.bytes);
    expect(webp.byteLength).toBeLessThanOrEqual(ADMIN_VIEW_MEDIA_MAX_BYTES);
    expect(data.original).toEqual({
      width: CHART.width,
      height: CHART.height,
    });
    return { data, webp };
  };

  const WHOLE = { left: 0, top: 0, width: CHART.width, height: CHART.height };

  it("loses fine strokes in the thumbnail on the base token, and says how small it is", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
    try {
      const { data, webp } = await view({ kind: "catalog_thumb" });
      expect(
        Math.max(data.rendered.width, data.rendered.height),
      ).toBeLessThanOrEqual(480);
      const finest = finestSurviving(await readStrokes(webp, WHOLE));
      // One thumbnail pixel spans about 19 original pixels here, so a 2 px bar is gone.
      expect(finest === null || finest > 8).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the finest strokes in a native passage of the original, within the bound", async () => {
    const region = {
      left: CHART.left,
      top: CHART.top,
      width: 3 * CHART.patch + 2 * CHART.gap,
      height: CHART.patch,
    };
    const { data, webp } = await view({ kind: "catalog_original", region });
    expect(data.rendered.width).toBe(region.width);
    expect(finestSurviving(await readStrokes(webp, region))).toBe(
      CHART.strokes[0],
    );
  });

  it("keeps the bound on the whole high-detail original, and reports the size it used", async () => {
    const { data } = await view({ kind: "catalog_original", region: WHOLE });
    expect(
      Math.max(data.rendered.width, data.rendered.height),
    ).toBeLessThanOrEqual(1_600);
  });
});
