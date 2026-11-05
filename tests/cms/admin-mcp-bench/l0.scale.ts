import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAiOperatorReader,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityReportingAdapter,
} from "@moya/community-postgres";
import { MappedStorageUrlResolver } from "@moya/image";
import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_VIEW_MEDIA_MAX_BYTES,
  adminExecuteDataSchema,
  adminFindDataSchema,
  adminMcpEnvelopeSchema,
  adminReadRowsDataSchema,
  adminViewMediaDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import {
  approveBatch,
  contentFingerprint,
  publishApproved,
} from "admin/editorial";
import { createLocalReq, getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "../../unit/backend/community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "../../unit/backend/community-identity-fixture.js";
import { connectClient, serveRoutes } from "../admin-mcp-wire.js";
import { CHART, finestSurviving, readStrokes } from "./legibility.ts";
import {
  C1_CALL,
  C3_APPROVALS_CALL,
  c2Candidate,
  c2FindCall,
  c2SaveCall,
  c3PublishCall,
  c4Calls,
  GATE_A_P95_MS,
  gradeC1,
  gradeC2,
  gradeC3,
  gradeC4,
  gradeM1,
  gradeM3,
  gradeTold,
  gradeU1,
  gradeU3,
  M1_CALL,
  M3_REASON,
  m3HideCall,
  m3ListCall,
  u1FindCall,
  u1ReadCall,
  U3_REASON,
  u3FindCall,
  u3Outcome,
  u3SuspendCall,
} from "./paths.ts";
import type { ToldRow, ToolCall } from "./paths.ts";
import {
  BENCH_FIXTURE_RECORDS,
  BENCH_SCALE,
  catalogIdOf,
  catalogSpec,
  holdLock,
  kindOf,
  sourceIdOf,
} from "./seed.ts";
import type { BenchOracle, CommunityOracle } from "./seed.ts";

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
  ownerId: number;
  automationId: number;
};
const { oracle, communityOracle, rows } = JSON.parse(
  await readFile(process.env.ADMIN_MCP_BENCH_ORACLE_FILE!, "utf8"),
) as {
  oracle: BenchOracle;
  communityOracle: CommunityOracle;
  rows: Record<string, number>;
};

/** This bench's own ceiling: the design asks for a check and names no number. */
const DESCRIPTION_MAX_CHARS = 1_024;
/** Enough to read a p95 off, cheap enough for CI. */
const TIMING_SAMPLES = 20;
/** One account's public assets, so a suspension's cost per asset has a ceiling. */
const SUSPENDED_LIVE_ASSETS = 5;

/**
 * Statements one call may run, audit row and transaction control included: reads
 * measured at this scale, pinned so a new read per row or per call fails here.
 * The one statement left out is THROTTLED_DOOR_WRITE.
 */
const STATEMENTS = {
  door_whoami: 5,
  door_tools_list: 3,
  exact_locate: 9,
  exact_locate_miss_to_identity: 13,
  single_read: 10,
  list_page: 7,
  // Its own READ ONLY transaction with a statement timeout: four of these.
  aggregate: 10,
  // The hooks, the receipt and the echo. A publish costs about the same per target.
  single_write: 51,
  batch_write_30: 1_425,
  // The Admin's door and audit row, and the Backend's own transaction beside them.
  m1_count: 10,
  u1_find: 10,
  u1_read: 12,
  m3_list: 23,
  // Per target: the Backend's transaction with its time limit, its case and receipt, a
  // pause read and an audit row.
  m3_hide_12: 275,
  // The same, and a suspension's settlement: a read's own transaction, five statements.
  u3_suspend_14: 360,
  // One target, whose publication sync costs statements per live asset.
  suspend_live_assets_5: 45,
  // The Admin's door and audit row, and the settlement's transaction on the Backend.
  job_read: 10,
} as const;

/**
 * Every publish, the Owner's too, has services/catalog-postgres read one record for its
 * search document through the catalog_entries view, which filters after reading every
 * live record. It breaks the no-scan rule and is outside the Admin MCP's paths, so it is
 * reported on C3's row and named here, and no other statement may join it.
 */
const SEARCH_SYNC_READ =
  /FROM catalog_entries AS entry\s+WHERE entry\.catalog_id/u;

/**
 * The door writes last_used_at once a key's last touch is 60 s old, so whether a call
 * carries this depends on the clock. Counted, it fails a ceiling on a stalled runner
 * with no code at fault, and wall-clock is no gate here. Every other statement counts.
 */
const THROTTLED_DOOR_WRITE =
  /^\s*UPDATE\s+payload_mcp_api_keys\s+SET\s+last_used_at\b/iu;

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

const capturedDrivers = new Set<object>();

/** Every statement of the process, from the driver's own query method. */
const installCapture = async (from: Pool = pool) => {
  const client = await from.connect();
  const proto = Object.getPrototypeOf(client) as {
    query: (...args: unknown[]) => unknown;
  };
  client.release();
  // Packages can hold their own copy of the driver: each is patched, and only once.
  if (capturedDrivers.has(proto)) return () => undefined;
  capturedDrivers.add(proto);
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
      if (!THROTTLED_DOOR_WRITE.test(text)) captured.push({ text, values });
    }
    return original.apply(this, args);
  };
  return () => {
    capturedDrivers.delete(proto);
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
    if (!/^\s*(?:select|with)\b/iu.test(text)) continue;
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
  key: "read" | "full" = "read",
) => {
  const first = await callOn(callAt(0), key);
  expect(first.envelope.ok).toBe(true);
  expect(first.statements.length).toBeLessThanOrEqual(ceiling);
  const seqScans = await largeSeqScans(first.statements);
  expect(seqScans).toEqual([]);
  const ms: number[] = [];
  let bytes = first.bytes;
  let statements = first.statements.length;
  for (let index = 1; index <= TIMING_SAMPLES; index += 1) {
    const sample = await callOn(callAt(index), key);
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

const VERSION_ROWS = [
  "_catalogs_v_version_aliases",
  "_catalogs_v_version_contributors",
  "_catalogs_v_version_media",
  "_catalogs_v_version_provenance",
  "_catalogs_v_version_source_citations",
] as const;

/** A record's latest version as the tables hold it, with the rows under it. */
const latestRowOf = async (id: number) => {
  const { rows: found } = await pool.query(
    `SELECT to_jsonb(v) AS row FROM _catalogs_v v WHERE parent_id = $1 AND latest`,
    [id],
  );
  const version = found[0]!.row as Record<string, unknown>;
  const under: Record<string, unknown> = {};
  for (const table of VERSION_ROWS)
    under[table] = (
      await pool.query(
        `SELECT to_jsonb(c) - '_parent_id' - '_uuid' - 'id' AS row FROM "${table}" c
         WHERE _parent_id = $1 ORDER BY _order`,
        [version.id],
      )
    ).rows.map(({ row }) => row);
  return { ...version, ...under };
};

/** Every other record's rows, short enough to compare before and after a write. */
const restOf = async (ids: readonly number[]) => {
  const { rows: state } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM _catalogs_v) AS versions,
       (SELECT md5(string_agg(concat_ws(':', id, version_revision, version_title, version__status), ',' ORDER BY id))
        FROM _catalogs_v WHERE NOT parent_id = ANY($1::int[])) AS versions_digest,
       (SELECT md5(string_agg(concat_ws(':', id, revision, title, _status), ',' ORDER BY id))
        FROM catalogs WHERE NOT id = ANY($1::int[])) AS live_digest`,
    [ids],
  );
  return state[0]!;
};

const liveRowOf = async (id: number) =>
  (
    await pool.query(
      `SELECT to_jsonb(c) AS row FROM catalogs c WHERE id = $1`,
      [id],
    )
  ).rows[0]!.row as Record<string, unknown>;

const reqOf = async (id: number) =>
  createLocalReq(
    {
      user: {
        ...(await payload.findByID({
          collection: "users",
          id,
          overrideAccess: true,
        })),
        collection: "users",
      } as never,
    },
    payload,
  );

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
     WHERE n.nspname IN ('public', 'community') AND c.relkind = 'r' AND c.reltuples >= 1000`,
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
    const records = BENCH_SCALE.catalogs + BENCH_FIXTURE_RECORDS;
    expect(rows.catalogs).toBe(records);
    expect(rows.catalogVersions).toBeGreaterThan(2 * BENCH_SCALE.catalogs);
    const { rows: latest } = await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT parent_id)::int AS records
       FROM _catalogs_v WHERE latest`,
    );
    expect(latest[0]).toEqual({ n: records, records });
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

describe("the door's throttled write", () => {
  it("still runs and stays out of the count, so a stalled runner fails no ceiling", async () => {
    const stale = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS keys FROM payload_mcp_api_keys
           WHERE last_used_at < now() - interval '60 seconds'`,
        )
      ).rows[0]!.keys;
    await pool.query(
      `UPDATE payload_mcp_api_keys SET last_used_at = now() - interval '61 seconds'`,
    );
    expect(await stale()).toBeGreaterThanOrEqual(2);
    for (const key of ["read", "full"] as const) {
      const { statements } = await measured(() => clients[key]!.listTools());
      expect(statements.length).toBeLessThanOrEqual(STATEMENTS.door_tools_list);
    }
    expect(await stale()).toBe(0);
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

describe("C2 reference path", () => {
  it("edits the title of the one draft it names, and nothing else, in three calls", async () => {
    const { id, title, newTitle, nearTwinId, publishedTwinId } = oracle.c2;
    const [before, liveBefore, twins, rest] = [
      await latestRowOf(id),
      await liveRowOf(id),
      [await latestRowOf(nearTwinId), await latestRowOf(publishedTwinId)],
      await restOf([id]),
    ];
    const found = await callOn(c2FindCall(title));
    expect(found.envelope.ok).toBe(true);
    const candidate = c2Candidate(found.envelope.data, title);
    expect(candidate?.id).toBe(id);
    const got = await callOn({
      name: "admin_get",
      arguments: { type: "catalog", id: candidate!.id },
    });
    expect(got.envelope.ok).toBe(true);
    const record = got.envelope.data as { id: number; revision: number | null };
    const saved = await callOn(
      c2SaveCall(randomUUID(), record, candidate!.disambiguators, newTitle),
      "full",
    );
    expect(saved.envelope.ok).toBe(true);
    const answer = saved.envelope.data as {
      applied: number[];
      results: Record<string, unknown>[];
    };
    expect(answer.applied).toEqual([id]);
    expect(answer.results[0]).toMatchObject({
      id,
      title: newTitle,
      changedFields: ["title"],
      noRereadNeeded: true,
    });

    expect(gradeC2(before, await latestRowOf(id), oracle.c2)).toEqual([]);
    // A draft's edit is on its latest version; the public row stays as it was.
    expect(await liveRowOf(id)).toEqual(liveBefore);
    expect([
      await latestRowOf(nearTwinId),
      await latestRowOf(publishedTwinId),
    ]).toEqual(twins);
    expect(await restOf([id])).toEqual({
      ...rest,
      versions: Number(rest.versions) + 1,
    });

    expect(saved.statements.length).toBeLessThanOrEqual(
      STATEMENTS.single_write,
    );
    // This phrase is in a sixth of the seeded records, so the planner reads them all and
    // the branch answers to its own budget. That is reported; one few rows hold is not.
    const seqScans = await largeSeqScans(found.statements);
    const selective = await callOn(c2FindCall(`${title}（拓片）`));
    expect(await largeSeqScans(selective.statements)).toEqual([]);
    expect(
      await largeSeqScans([...got.statements, ...saved.statements]),
    ).toEqual([]);
    report({
      name: "C2",
      budgetMs:
        GATE_A_P95_MS.fuzzy_locate +
        GATE_A_P95_MS.single_read +
        GATE_A_P95_MS.single_write,
      ms: [found.ms + got.ms + saved.ms],
      statements:
        found.statements.length +
        got.statements.length +
        saved.statements.length,
      bytes: Math.max(found.bytes, got.bytes, saved.bytes),
      seqScans,
    });
  });
});

describe("C3 reference path", () => {
  const { targets, locked, missingField, alreadyPublished, publishes } =
    oracle.c3;
  let approvalId: number;

  const published = async () =>
    (
      await pool.query(
        `SELECT id FROM catalogs
         WHERE id = ANY($1::int[]) AND _status = 'published' ORDER BY id`,
        [targets],
      )
    ).rows.map(({ id }) => Number(id));

  const searchable = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM catalog_search_documents
         WHERE catalog_id = ANY($1::text[])`,
        [targets.map(catalogIdOf)],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    // An account can only be approved for what it may edit.
    await payload.update({
      collection: "users",
      id: access.automationId,
      overrideAccess: true,
      data: { scopeCatalogIds: targets.map(catalogIdOf) } as never,
    });
    const owner = await reqOf(access.ownerId);
    const approved = await approveBatch(owner, {
      automationUserId: access.automationId,
      items: targets
        .filter((id) => id !== missingField.id)
        .map((id) => ({ id, revision: 1 })),
    });
    approvalId = Number(approved.approvalId);
    // The approval's own check refuses a record that cannot publish, so only a row can
    // hold this one: an approval from before the rule was tightened, say.
    const incomplete = await payload.findByID({
      collection: "catalogs",
      id: missingField.id,
      draft: true,
      depth: 0,
      overrideAccess: true,
    });
    await pool.query(
      `INSERT INTO editorial_approvals_items (_order, _parent_id, id, catalog_id, revision, fingerprint)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [
        targets.length,
        approvalId,
        randomBytes(12).toString("hex"),
        missingField.id,
        contentFingerprint(incomplete),
      ],
    );
    await publishApproved(owner, {
      approvalId,
      id: alreadyPublished,
      idempotencyKey: randomUUID(),
    });
    // Held from now: a lock lasts 5 minutes, and a slow runner may be past that.
    await holdLock(pool, locked, access.ownerId);
  });

  it("publishes exactly what it can, and names each one it could not and why", async () => {
    expect(await published()).toEqual([alreadyPublished]);
    const lockedBefore = await latestRowOf(locked);
    const missingBefore = await latestRowOf(missingField.id);
    const rest = await restOf(targets);

    const approvals = await callOn(C3_APPROVALS_CALL);
    const { rows: listed } = adminReadRowsDataSchema.parse(
      approvals.envelope.data,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: approvalId,
      itemCount: targets.length,
    });

    const requestId = randomUUID();
    const call = c3PublishCall(requestId, approvalId, targets);
    const first = await callOn(call, "full");
    expect(gradeC3(first.envelope, oracle.c3)).toEqual([]);
    expect(first.envelope).toMatchObject({
      done: targets.length,
      total: targets.length,
    });
    // One way on: the lock's own time, then the same request.
    expect(first.envelope.next?.tool).toBe("admin_execute");
    expect(first.envelope.next?.args.requestId).toBe(requestId);
    expect(first.envelope.next?.afterMs).toBeGreaterThan(0);

    const expected = [...publishes, alreadyPublished].sort((a, b) => a - b);
    expect(await published()).toEqual(expected);
    expect(await searchable()).toBe(expected.length);
    expect(await latestRowOf(locked)).toEqual(lockedBefore);
    expect(await latestRowOf(missingField.id)).toEqual(missingBefore);
    const after = await restOf(targets);
    expect(after).toEqual({
      ...rest,
      versions: Number(rest.versions) + publishes.length,
    });

    // The same request again repeats nothing, and says what each target is now.
    const replay = await callOn(call, "full");
    expect(gradeC3(replay.envelope, oracle.c3, false)).toEqual([]);
    expect(await published()).toEqual(expected);
    expect(await restOf(targets)).toEqual(after);

    expect(first.statements.length).toBeLessThanOrEqual(
      STATEMENTS.batch_write_30,
    );
    const seqScans = await largeSeqScans(first.statements);
    expect(
      await largeSeqScans(
        first.statements.filter(({ text }) => !SEARCH_SYNC_READ.test(text)),
      ),
    ).toEqual([]);
    report({
      name: "C3",
      budgetMs:
        GATE_A_P95_MS.list_page +
        targets.length * GATE_A_P95_MS.batch_write_per_target,
      ms: [approvals.ms + first.ms],
      statements: approvals.statements.length + first.statements.length,
      bytes: Math.max(approvals.bytes, first.bytes),
      seqScans,
    });
  });
});

// The real Backend's AI routes in this process, so their statements count on the same
// row as the Admin's. As the owner of the tables here: the App role's grants have their
// own suite, tests/cms/admin-mcp-community.test.ts.
const md5 = (text: string) => createHash("md5").update(text).digest("hex");

describe("the community reference paths", () => {
  const communityToken = randomBytes(32).toString("base64url");
  const baseToken = randomBytes(32).toString("base64url");
  let backend: Server;
  let communityPool: ReturnType<typeof createPostgresPool>;
  let restoreBackendCapture: () => void;

  beforeAll(async () => {
    communityPool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: process.env.CMS_TEST_DATABASE_URL! }),
    );
    restoreBackendCapture = await installCapture(communityPool as never);
    backend = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: new PostgresCommunityIdentityAdapter(
          communityPool,
        ),
        communityCommentPort: new PostgresCommunityCommentAdapter(
          communityPool,
        ),
        contentOperatorPort: new PostgresCommunityContentOperatorAdapter(
          communityPool,
        ),
        reportingPort: new PostgresCommunityReportingAdapter(communityPool),
        aiOperatorReader: new PostgresAiOperatorReader(communityPool),
        operatorAiBaseCredential: baseToken,
        operatorAiCommunityCredential: communityToken,
        storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      }),
    );
    const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `http://127.0.0.1:${address.port}/`,
    );
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    restoreBackendCapture?.();
    backend?.closeAllConnections();
    if (backend) await stopServer(backend);
    await communityPool?.end();
  });

  it("reads a settlement on any subject at scale, with no scan of a large table", async () => {
    expect(largeTables).toContain("publishing_jobs");
    expect(largeTables).toContain("media_items");
    const refs = [
      (at: number) => ({
        type: "user",
        id: `user-${md5(`bench-user-${1 + (at % BENCH_SCALE.users)}`)}`,
        intent: "withdraw",
      }),
      (at: number) => ({
        type: "work",
        id: `work-${md5(`bench-work-${1 + (at % 49)}`)}`,
        intent: "withdraw",
      }),
      (at: number) => ({
        type: "item",
        id: `media-item-${md5(`bench-item-${1 + at}`)}`,
        intent: "withdraw",
      }),
    ];
    await checkClass(
      "job_read",
      GATE_A_P95_MS.job_read,
      STATEMENTS.job_read,
      (index) => ({
        name: "admin_job",
        arguments: {
          kind: "settlement",
          refs: [refs[index % refs.length]!(index)],
        },
      }),
    );
  });

  it("reads past a stop on the state index, one statement more", async () => {
    const item = `media-item-${md5("bench-item-1")}`;
    const job = `publishing-job-${md5(`bench-stop-${randomUUID()}`)}`;
    await communityPool.query(
      "INSERT INTO community.media_public_assets (id, item_id, desired_at, created_at, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [md5(job), item],
    );
    await communityPool.query(
      "INSERT INTO community.publishing_jobs (id, kind, subject_id, state, run_after, created_at, updated_at, finished_at) VALUES ($1, 'withdraw_media', $2, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [job, item],
    );
    const { envelope, statements } = await callOn({
      name: "admin_job",
      arguments: {
        kind: "settlement",
        refs: [{ type: "item", id: item, intent: "withdraw" }],
      },
    });
    expect(envelope).toMatchObject({
      code: "MEDIA_JOB_FAILED",
      data: { refs: [{ state: "failed", failed: 1, jobs: [job] }] },
    });
    expect(statements.length).toBeLessThanOrEqual(STATEMENTS.job_read + 1);
    expect(await largeSeqScans(statements)).toEqual([]);
    await communityPool.query(
      "DELETE FROM community.publishing_jobs WHERE id = $1",
      [job],
    );
    await communityPool.query(
      "DELETE FROM community.media_public_assets WHERE item_id = $1",
      [item],
    );
  });

  it("M1: counts what still waits, by kind, and how long the oldest has, in one read", async () => {
    const state = await contentState();
    const { envelope, statements, bytes, ms } = await callOn(M1_CALL);
    expect(envelope.ok).toBe(true);
    expect(gradeM1(envelope.data, communityOracle.m1)).toEqual([]);
    expect(communityOracle.m1.groups.length).toBeGreaterThan(1);
    expect(await contentState()).toEqual(state);
    expect(statements.length).toBeLessThanOrEqual(STATEMENTS.m1_count);
    const seqScans = await largeSeqScans(statements);
    report({
      name: "M1",
      budgetMs: GATE_A_P95_MS.aggregate,
      ms: [ms],
      statements: statements.length,
      bytes,
      seqScans,
    });
    // Most of the cases are waiting, so the planner reads them all, and a count of them
    // is what was asked for. Reported above; no other table may join it.
    expect(seqScans.filter((table) => table !== "report_cases")).toEqual([]);
  });

  it("U1: answers registration, state and the three counts within two calls", async () => {
    const state = await contentState();
    const u1 = communityOracle.u1;
    const found = await callOn(u1FindCall(u1.handle));
    expect(found.envelope.ok).toBe(true);
    const { resolution } = adminFindDataSchema.parse(found.envelope.data);
    const listed = await callOn(u1ReadCall(resolution.ref!));
    expect(listed.envelope.ok).toBe(true);
    expect(gradeU1(found.envelope.data, listed.envelope.data, u1)).toEqual([]);
    for (const { text } of [found, listed].map(({ envelope }) => ({
      text: JSON.stringify(envelope),
    })))
      expect(text).not.toContain(u1.canary);
    expect(await contentState()).toEqual(state);
    expect(found.statements.length).toBeLessThanOrEqual(STATEMENTS.u1_find);
    expect(listed.statements.length).toBeLessThanOrEqual(STATEMENTS.u1_read);
    const seqScans = await largeSeqScans([
      ...found.statements,
      ...listed.statements,
    ]);
    report({
      name: "U1",
      budgetMs: GATE_A_P95_MS.exact_locate + GATE_A_P95_MS.list_page,
      ms: [found.ms + listed.ms],
      statements: found.statements.length + listed.statements.length,
      bytes: Math.max(found.bytes, listed.bytes),
      seqScans,
    });
    expect(seqScans).toEqual([]);
  });

  const moderationStates = async (ids: readonly string[]) =>
    Object.fromEntries(
      (
        await pool.query(
          "SELECT id,moderation FROM community.catalog_comments WHERE id=ANY($1)",
          [[...ids]],
        )
      ).rows.map(({ id, moderation }) => [id, moderation]),
    );
  const toldOf = async (subjects: readonly string[]) =>
    (
      await pool.query(
        `SELECT c.target_id, c.kind, c.status, d.reason, d.operator_label,
           m.recipient_id, m.kind AS message_kind, m.text
         FROM community.report_cases c
         JOIN community.report_decisions d ON d.id = c.decision_id
         LEFT JOIN community.report_messages m ON m.case_id = c.id
         WHERE c.target_id = ANY($1)`,
        [[...subjects]],
      )
    ).rows as ToldRow[];

  it("M3: hides exactly what the request names, and a repeat moves nothing", async () => {
    const m3 = communityOracle.m3;
    const found = await callOn(u1FindCall(m3.handle));
    const { resolution } = adminFindDataSchema.parse(found.envelope.data);
    expect(resolution).toEqual({
      status: "exact",
      uniqueIdentity: true,
      ref: { type: "user", id: m3.id },
    });
    const list = await callOn(m3ListCall(resolution.ref!.id, m3.phrase));
    expect(list.envelope.ok).toBe(true);
    const { rows: listed, filter } = adminReadRowsDataSchema.parse(
      list.envelope.data,
    );
    expect(filter).toMatchObject({
      authorId: m3.id,
      search: m3.phrase,
      range: "last_7_days",
      tz: "Asia/Shanghai",
    });
    const ids = listed.map((row) => String(row.id));
    expect(await moderationStates(ids)).toEqual(
      Object.fromEntries(m3.matching.map((id) => [id, "visible"])),
    );
    const untouched = await moderationStates(m3.untouched);
    expect(Object.keys(untouched)).toHaveLength(m3.untouched.length);
    // Any extra row is a hard failure, wherever it is: every comment in the seed counts.
    const movedAnywhere = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community.catalog_comments WHERE moderation <> 'visible'",
          )
        ).rows[0]!.n,
      );
    const movedBefore = await movedAnywhere();

    const requestId = randomUUID();
    const hide = await callOn(m3HideCall(requestId, ids), "full");
    expect(hide.envelope).toMatchObject({ ok: true, code: "OK" });
    expect(await movedAnywhere()).toBe(movedBefore + m3.matching.length);
    expect(
      gradeM3(ids, adminExecuteDataSchema.parse(hide.envelope.data), m3),
    ).toEqual([]);
    expect(await moderationStates(m3.matching)).toEqual(
      Object.fromEntries(m3.matching.map((id) => [id, "hidden"])),
    );
    expect(await moderationStates(m3.untouched)).toEqual(untouched);
    expect(
      gradeTold(await toldOf(m3.matching), m3.matching, M3_REASON, () => m3.id),
    ).toEqual([]);
    expect(await toldOf(m3.untouched)).toEqual([]);

    const eventsOf = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community.moderation_events WHERE subject_id=ANY($1) AND operator_label='ai-admin'",
            [[...m3.matching]],
          )
        ).rows[0]!.n,
      );
    expect(await eventsOf()).toBe(m3.matching.length);
    const replay = await callOn(m3HideCall(requestId, ids), "full");
    expect(replay.envelope).toMatchObject({
      ok: true,
      meta: { replayed: true },
    });
    expect(
      [
        ...(adminExecuteDataSchema.parse(replay.envelope.data)
          .already_applied ?? []),
      ].sort(),
    ).toEqual([...m3.matching].sort());
    expect(await eventsOf()).toBe(m3.matching.length);
    expect(await moderationStates(m3.untouched)).toEqual(untouched);
    expect(await movedAnywhere()).toBe(movedBefore + m3.matching.length);
    expect(await toldOf(m3.matching)).toHaveLength(m3.matching.length);

    expect(list.statements.length).toBeLessThanOrEqual(STATEMENTS.m3_list);
    expect(hide.statements.length).toBeLessThanOrEqual(STATEMENTS.m3_hide_12);
    const seqScans = await largeSeqScans([
      ...found.statements,
      ...list.statements,
      ...hide.statements,
    ]);
    report({
      name: "M3",
      budgetMs:
        GATE_A_P95_MS.exact_locate +
        GATE_A_P95_MS.list_page +
        m3.matching.length * GATE_A_P95_MS.batch_write_per_target,
      ms: [found.ms + list.ms + hide.ms],
      statements:
        found.statements.length +
        list.statements.length +
        hide.statements.length,
      bytes: Math.max(found.bytes, list.bytes, hide.bytes),
      seqScans,
    });
    // list.comments leaves out what a self-only work withholds through one hashed set
    // of them, read once per statement. Reported above; nothing else may join it, and
    // the writes themselves go by id.
    expect(seqScans.filter((table) => table !== "works")).toEqual([]);
    expect(await largeSeqScans(hide.statements)).toEqual([]);
  });

  it("prices a read past a stop days old, over every finished job since", async () => {
    // Before every seeded job, so the bound on the state index holds the whole range.
    const { before } = (
      await communityPool.query<{ before: Date }>(
        "SELECT min(updated_at) - interval '6 days' AS before FROM community.publishing_jobs",
      )
    ).rows[0]!;
    const item = `media-item-${md5(`bench-old-stop-${randomUUID()}`)}`;
    const job = `publishing-job-${md5(`bench-old-stop-${randomUUID()}`)}`;
    await communityPool.query(
      "INSERT INTO community.media_items (id, owner_id, kind, quality_mode, source, state, presentation, ready_at) VALUES ($1, $2, 'static', 'standard', 'upload', 'ready', '{\"width\":512,\"height\":384}', CURRENT_TIMESTAMP)",
      [item, `user-${md5("bench-user-1")}`],
    );
    await communityPool.query(
      "INSERT INTO community.media_public_assets (id, item_id, desired_at, created_at, updated_at) VALUES ($1, $2, $3, $3, $3)",
      [md5(job), item, before],
    );
    await communityPool.query(
      "INSERT INTO community.publishing_jobs (id, kind, subject_id, state, run_after, created_at, updated_at, finished_at) VALUES ($1, 'withdraw_media', $2, 'failed', $3, $3, $3, $3)",
      [job, item, before],
    );
    const { envelope, statements, ms, bytes } = await callOn({
      name: "admin_job",
      arguments: {
        kind: "settlement",
        refs: [{ type: "item", id: item, intent: "withdraw" }],
      },
    });
    expect(envelope).toMatchObject({
      code: "MEDIA_JOB_FAILED",
      data: { refs: [{ state: "failed", failed: 1, jobs: [job] }] },
    });
    expect(statements.length).toBeLessThanOrEqual(STATEMENTS.job_read + 1);
    const seqScans = await largeSeqScans(statements);
    report({
      name: "job_read_old_stop",
      budgetMs: GATE_A_P95_MS.job_read,
      ms: [ms],
      statements: statements.length,
      bytes,
      seqScans,
    });
    // A range this wide reads the whole table, within its branch's 2 s statement limit
    // (section 17). Nothing else may join it, and a read past a recent stop has none.
    expect(seqScans.filter((name) => name !== "publishing_jobs")).toEqual([]);
    expect(ms).toBeLessThan(2_000);
    await communityPool.query(
      "DELETE FROM community.publishing_jobs WHERE id = $1",
      [job],
    );
    await communityPool.query(
      "DELETE FROM community.media_public_assets WHERE item_id = $1",
      [item],
    );
    await communityPool.query(
      "DELETE FROM community.media_items WHERE id = $1",
      [item],
    );
  });

  it("prices a suspension of an account with live assets, per asset", async () => {
    const user = `user-${md5(`bench-media-user-${randomUUID()}`)}`;
    await communityPool.query(
      "INSERT INTO community.public_users (id, handle, display_name) VALUES ($1, $2, 'Bench media account')",
      [user, `bench-media-${md5(user).slice(0, 12)}`],
    );
    const hex = () => randomUUID().replaceAll("-", "");
    for (let index = 0; index < SUSPENDED_LIVE_ASSETS; index += 1) {
      const item = `media-item-${md5(`${user}-${index}`)}`;
      const blob = `media-blob-${md5(`${user}-${index}`)}`;
      const rendition = `media-rendition-${md5(`${user}-${index}`)}`;
      const asset = hex();
      const token = hex();
      const key = hex();
      const hash = randomBytes(32).toString("hex");
      await communityPool.query(
        "INSERT INTO community.media_items (id, owner_id, kind, quality_mode, source, state, presentation, ready_at) VALUES ($1, $2, 'static', 'standard', 'upload', 'ready', '{\"width\":512,\"height\":384}', CURRENT_TIMESTAMP)",
        [item, user],
      );
      await communityPool.query(
        "INSERT INTO community.media_blobs (id, owner_id, purpose, storage_key, byte_size, sha256, content_type, created_at) VALUES ($1, $2, 'derivative', $3, 128, $4, 'image/webp', CURRENT_TIMESTAMP)",
        [
          blob,
          user,
          `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
          hash,
        ],
      );
      await communityPool.query(
        "INSERT INTO community.media_renditions (id, item_id, edit_key, role, recipe_version, recipe_digest, blob_id, width, height, content_type, created_at) VALUES ($1, $2, 'base', 'display', 1, '1111111111111111', $3, 512, 384, 'image/webp', CURRENT_TIMESTAMP)",
        [rendition, item, blob],
      );
      await communityPool.query(
        "INSERT INTO community.media_public_assets (id, item_id, desired_at, created_at, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [asset, item],
      );
      await communityPool.query(
        `INSERT INTO community.media_publications (id, public_asset_id, rendition_id, generation_token, object_key, storage_key, content_type, purpose, byte_size, sha256, role, edit_key, state, created_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'image/webp', 'derivative', 128, $7, 'display', 'base', 'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          `media-publication-${md5(`${user}-${index}`)}`,
          asset,
          rendition,
          token,
          `v1/${asset}/${token}/base/display.r1.webp`,
          `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
          hash,
        ],
      );
    }
    const { envelope, statements, ms, bytes } = await callOn(
      {
        name: "admin_execute",
        arguments: {
          requestId: randomUUID(),
          op: "community.moderate-user",
          input: { id: user, action: "suspend", reason: U3_REASON },
        },
      },
      "full",
    );
    expect(envelope).toMatchObject({
      code: "QUEUED",
      state: "media_jobs_open",
    });
    expect(statements.length).toBeLessThanOrEqual(
      STATEMENTS.suspend_live_assets_5,
    );
    const seqScans = await largeSeqScans(statements);
    report({
      name: "suspend_live_assets",
      budgetMs: GATE_A_P95_MS.batch_write_per_target,
      ms: [ms],
      statements: statements.length,
      bytes,
      seqScans,
    });
    expect(seqScans).toEqual([]);
  });

  it("U3: suspends the ones it can, and says which it changed, skipped and could not find", async () => {
    const u3 = communityOracle.u3;
    const statusOf = async (ids: readonly string[]) =>
      Object.fromEntries(
        (
          await pool.query(
            "SELECT id,status FROM community.public_users WHERE id=ANY($1)",
            [[...ids]],
          )
        ).rows.map(({ id, status }) => [id, status]),
      );
    const finds: Awaited<ReturnType<typeof callOn>>[] = [];
    for (const handle of u3.handles)
      finds.push(await callOn(u3FindCall(handle)));
    const resolved = finds.map(
      ({ envelope }) => adminFindDataSchema.parse(envelope.data).resolution,
    );
    const known = resolved.flatMap(({ ref }) =>
      ref === undefined ? [] : [ref.id],
    );
    // One handle names no account, and the locate says so before anything runs: every
    // source answered, because one that did not is never a miss.
    expect(
      u3.handles.filter((_, at) => resolved[at]!.status === "none"),
    ).toEqual([u3.missingHandle]);
    expect(
      u3.handles.filter((_, at) => resolved[at]!.ref === undefined),
    ).toEqual([u3.missingHandle]);
    const sourcesOfTheMiss = Object.values(
      finds[u3.handles.indexOf(u3.missingHandle)]!.envelope.meta?.sources ?? {},
    );
    expect(sourcesOfTheMiss.length).toBeGreaterThan(0);
    expect(sourcesOfTheMiss.filter((status) => status !== "ok")).toEqual([]);
    const all = [...u3.changed, ...u3.skipped];
    expect([...known].map(String).sort()).toEqual([...all].sort());

    const requestId = randomUUID();
    const suspend = await callOn(u3SuspendCall(requestId, known), "full");
    const first = adminExecuteDataSchema.parse(suspend.envelope.data);
    expect(gradeU3(first, u3)).toEqual([]);
    // No account here has media, so nothing is left to wait for.
    expect(suspend.envelope).toMatchObject({ ok: true, code: "OK" });
    expect(first.queued).toBeUndefined();
    expect(await statusOf(all)).toEqual(
      Object.fromEntries(all.map((id) => [id, "suspended"])),
    );
    expect(
      gradeTold(await toldOf(u3.changed), u3.changed, U3_REASON, (id) => id),
    ).toEqual([]);
    expect(await toldOf(u3.skipped)).toEqual([]);
    const eventsOf = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community.moderation_events WHERE subject_id=ANY($1) AND operator_label='ai-admin'",
            [[...all]],
          )
        ).rows[0]!.n,
      );
    const casesOf = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community.report_cases WHERE target_id=ANY($1)",
            [[...all]],
          )
        ).rows[0]!.n,
      );
    expect(await eventsOf()).toBe(u3.changed.length);
    expect(await casesOf()).toBe(u3.changed.length);

    const replay = await callOn(u3SuspendCall(requestId, known), "full");
    const again = adminExecuteDataSchema.parse(replay.envelope.data);
    expect(u3Outcome(again).changed).toEqual([]);
    expect(u3Outcome(again).skipped).toEqual([...all].sort());
    expect(again.moderationCases).toBeUndefined();
    expect(await eventsOf()).toBe(u3.changed.length);
    expect(await casesOf()).toBe(u3.changed.length);

    expect(suspend.statements.length).toBeLessThanOrEqual(
      STATEMENTS.u3_suspend_14,
    );
    const seqScans = await largeSeqScans([
      ...finds.flatMap(({ statements }) => statements),
      ...suspend.statements,
    ]);
    report({
      name: "U3",
      budgetMs:
        u3.handles.length * GATE_A_P95_MS.exact_locate +
        known.length * GATE_A_P95_MS.batch_write_per_target,
      ms: [finds.reduce((sum, { ms }) => sum + ms, 0) + suspend.ms],
      statements:
        finds.reduce((sum, { statements }) => sum + statements.length, 0) +
        suspend.statements.length,
      bytes: Math.max(...finds.map(({ bytes }) => bytes), suspend.bytes),
      seqScans,
    });
    expect(seqScans).toEqual([]);
  });
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

  it("saves one draft", async () => {
    // Past the three the seed holds locks on.
    const drafts = Array.from(
      { length: BENCH_SCALE.catalogs },
      (_, at) => at + 1,
    )
      .filter((index) => index > 13 && catalogSpec(index).status === "draft")
      .slice(0, TIMING_SAMPLES + 1)
      .map(catalogSpec);
    await checkClass(
      "single_write",
      GATE_A_P95_MS.single_write,
      STATEMENTS.single_write,
      (index) => {
        const spec = drafts[index]!;
        const latest = spec.versions.at(-1)!;
        return {
          name: "admin_execute",
          arguments: {
            requestId: randomUUID(),
            op: "editorial.save-draft",
            input: {
              id: spec.index,
              expectedRevision: latest.revision,
              content: {
                catalogId: spec.catalogId,
                sourceId: spec.sourceId,
                kind: kindOf(spec.index),
                title: `${latest.title}（改）`,
              },
            },
          },
        };
      },
      "full",
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
