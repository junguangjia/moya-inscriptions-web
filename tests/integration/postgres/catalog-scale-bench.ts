import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createCatalogDeliveryFacts,
  createCatalogPublicationAuthority,
  createCatalogReadiness,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  createCatalogSync,
  listPublishedCatalogSources,
  listPublishedCatalogSourcesSql,
  publishedCatalogPairs,
  publishedCatalogPairsSql,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_SCALE_25K,
  bumpCatalogScaleRecipe,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleIntentId,
  catalogScaleShape,
  clearCatalogScale,
  createCatalogScaleDatabase,
  createQueryRecorder,
  explainCatalogScale,
  seedCatalogScale,
  setCatalogMediaView,
  type CatalogMediaView,
  type CatalogScaleDatabase,
  type CatalogScalePlan,
  type CatalogScaleShape,
  type QueryRecorder,
  type RecordedQuery,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { MediaId } from "@moya/contracts";

/*
 * catalog-scale-v1 (Issue #323) 1B, slice W0: the Catalog scale bench and
 * EXPLAIN baseline. Local only, never part of CI: the file is not a *.test.ts
 * file, so no suite collects it; catalog-scale-bench.config.mts runs it alone
 * (docs/development/catalog-scale-bench.md has the command).
 *
 * For each scenario it seeds the scale fixture and records, per operation,
 * the outcome (ok, null or the thrown message), the best wall time of
 * MOYA_CATALOG_SCALE_BENCH_REPEAT runs for reads (one run for writes and the
 * whole-Catalog plans), statements and connects per role, and the slowest
 * statements; and EXPLAIN plans of the statements that matter at scale. The
 * operations are this head's own code, composed as the worker and Backend
 * compose them:
 * - the read path (1A): the exact pair check at k = 7 and k = 100 on the
 *   fenced and the keyed view, the delivery facts and publishedAssetIds;
 * - the worker: the published listing, the snapshot (both cursors; the
 *   private one over the live prepare projection of CMS migration M2), two
 *   sync passes, plans() (copyRenditionIds), one reconcile pass, one job's
 *   acquire with its fence checks (current, authorized), and the Admin
 *   readiness read.
 * Boundary scenarios put one bound of d51114c5 at its limit and one past it.
 *
 * Environment: TEST_DATABASE_URL (the loopback disposable target, as the
 * PostgreSQL suites), MOYA_CATALOG_SCALE_BENCH_SCENARIOS (comma-separated
 * names, default all), MOYA_CATALOG_SCALE_BENCH_REPEAT (default 5) and
 * MOYA_CATALOG_SCALE_BENCH_OUTPUT (a JSON report path, written with a text
 * summary beside it, <name>.txt; nothing is written without it). The report
 * holds timings, counts, SQL text and plans only, never a connection string.
 */

type Pool = CatalogScaleDatabase["setup"];
type Step = "pairs" | "worker" | "boundary" | "direct";

interface Scenario {
  readonly name: string;
  readonly shape: CatalogScaleShape;
  /** Records whose images get the N3 recipe-bump mid-state. */
  readonly bump?: { readonly first: number; readonly last: number };
  readonly steps: readonly Step[];
  readonly note: string;
}

const bound = (
  publishedImages: number,
  overrides: Partial<CatalogScaleShape>,
): CatalogScaleShape =>
  catalogScaleShape(publishedImages, {
    draftRecords: 0,
    releasedIntents: 0,
    endedIntents: 0,
    recentEndedIntents: 0,
    livePrepares: 0,
    ...overrides,
  });

const SCENARIOS: readonly Scenario[] = [
  ...(
    [
      [1_001, "1k"],
      [5_005, "5k"],
      [8_001, "8k"],
      [10_003, "10k"],
      [20_006, "20k"],
      [25_200, "25k"],
      [40_005, "40k"],
    ] as const
  ).map(([images, name]): Scenario => ({
    name,
    shape: images === 25_200 ? CATALOG_SCALE_25K : catalogScaleShape(images),
    steps: ["pairs", "worker"],
    note: "the 25k fixture's proportions",
  })),
  /*
   * The boundary scenarios keep their d51114c5 names and shapes, so a report
   * compares with that baseline. W3 replaced the list, union, intent and
   * private-row bounds with the snapshot ceiling (200,000 sources, 400,000
   * live private rows), so at this head both sides of those pairs complete;
   * their ended intents all ended at the epoch, older than R, so the live
   * projection the snapshot reads lists none of them (the -recent variants
   * below list them all).
   */
  {
    name: "list=10000",
    shape: bound(10_000, {}),
    steps: ["boundary"],
    note: "published list at d51114c5's 10,000-row bound, no intents",
  },
  {
    name: "list=10001",
    shape: bound(10_001, {}),
    steps: ["boundary"],
    note: "published list one row past d51114c5's bound",
  },
  {
    name: "union=10000",
    shape: bound(9_993, { draftRecords: 1, livePrepares: 1 }),
    steps: ["boundary"],
    note: "9,993 published + 7 live pairs: d51114c5's sync union at 10,000",
  },
  {
    name: "union=10001",
    shape: bound(9_994, { draftRecords: 1, livePrepares: 1 }),
    steps: ["boundary"],
    note: "9,994 published + 7 live pairs: d51114c5's union one past",
  },
  {
    name: "intents=10000",
    shape: bound(7, { endedIntents: 10_000 }),
    steps: ["boundary"],
    note: "10,000 ended intents, all older than R: d51114c5's mirror sync bound; the live projection lists none",
  },
  {
    name: "intents=10001",
    shape: bound(7, { endedIntents: 10_001 }),
    steps: ["boundary"],
    note: "10,001 ended intents older than R",
  },
  {
    name: "rows=20000",
    shape: bound(7_000, { releasedIntents: 1_000, endedIntents: 13_000 }),
    steps: ["boundary"],
    note: "7,000 released media rows + 13,000 ended headers older than R: d51114c5's private rows at 20,000; the live projection holds the 7,000",
  },
  {
    name: "rows=20001",
    shape: bound(7_000, { releasedIntents: 1_000, endedIntents: 13_001 }),
    steps: ["boundary"],
    note: "d51114c5's private rows one past",
  },
  /*
   * The same two pairs with every ended intent recent (within R), so the
   * live projection lists them all: the snapshot decodes, and the sync reads
   * and keeps, as many ended intents and private rows as d51114c5 read from
   * its full view at those bounds. Stress shapes: the intents pair ends
   * 10,000 intents of one record within 48 hours.
   */
  {
    name: "intents=10000-recent",
    shape: bound(7, { endedIntents: 10_000, recentEndedIntents: 10_000 }),
    steps: ["boundary"],
    note: "10,000 ended intents within R: the live projection lists every one",
  },
  {
    name: "intents=10001-recent",
    shape: bound(7, { endedIntents: 10_001, recentEndedIntents: 10_001 }),
    steps: ["boundary"],
    note: "10,001 ended intents within R",
  },
  {
    name: "rows=20000-recent",
    shape: bound(7_000, {
      releasedIntents: 1_000,
      endedIntents: 13_000,
      recentEndedIntents: 13_000,
    }),
    steps: ["boundary"],
    note: "7,000 released media rows + 13,000 ended headers within R: 20,000 live private rows",
  },
  {
    name: "rows=20001-recent",
    shape: bound(7_000, {
      releasedIntents: 1_000,
      endedIntents: 13_001,
      recentEndedIntents: 13_001,
    }),
    steps: ["boundary"],
    note: "20,001 live private rows",
  },
  {
    name: "selector=40000",
    shape: bound(6_997, {}),
    bump: { first: 1, last: 429 },
    steps: ["boundary"],
    note: "6,997 published, 3,003 mid recipe bump: 40,000 publicReady rows",
  },
  {
    name: "selector=40004",
    shape: bound(6_998, {}),
    bump: { first: 1, last: 429 },
    steps: ["boundary"],
    note: "one more published image: 40,004 publicReady rows",
  },
  {
    name: "direct",
    shape: bound(7, {}),
    steps: ["direct"],
    note: "d51114c5's bounds the worker never reaches first, called directly",
  },
];

const env = process.env;
const REPEAT = Math.max(1, Number(env.MOYA_CATALOG_SCALE_BENCH_REPEAT ?? 5));
const ONLY = env.MOYA_CATALOG_SCALE_BENCH_SCENARIOS?.split(",").map((name) =>
  name.trim(),
);
const OUTPUT = env.MOYA_CATALOG_SCALE_BENCH_OUTPUT;
const selected = SCENARIOS.filter(
  (scenario) => !ONLY || ONLY.includes(scenario.name),
);
if (ONLY?.some((name) => !SCENARIOS.some((s) => s.name === name)))
  throw new Error(
    `Unknown scenario; known: ${SCENARIOS.map((s) => s.name).join(",")}`,
  );

const root = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const round = (ms: number) => Math.round(ms * 100) / 100;
const normalized = (sql: string) => sql.replace(/\s+/gu, " ").trim();
const oneLine = (sql: string, length = 160) => normalized(sql).slice(0, length);

/*
 * The details below find this head's statements by their SQL text, compared
 * with whitespace collapsed. A wave that rewrites one of them (W5 on) makes
 * its matcher find nothing: the detail then reads null and its plan
 * `statement not found`, never 0 or a missing entry, so a lost matcher cannot
 * pass for an improvement. Update the matcher with the statement. A found
 * statement's row count can be 0 (an UPDATE that changed no row).
 *
 * The complete snapshot reads both sides through NO SCROLL cursors (W3), so
 * its read statements are `DECLARE <cursor> NO SCROLL CURSOR FOR <select>`
 * followed by FETCHes; their plans are explained as the DECLARE, which plans
 * the select as the cursor does (for fast start, cursor_tuple_fraction), and
 * EXPLAIN ANALYZE runs it to the end.
 */
const firstStatement = (queries: readonly RecordedQuery[], prefix: string) =>
  queries.find((q) => normalized(q.sql).startsWith(prefix));
/** Rows of the first statement starting with `prefix`, or null when none
 * ran. */
const statementRows = (queries: readonly RecordedQuery[], prefix: string) =>
  firstStatement(queries, prefix)?.rows ?? null;
/** Statements starting with `prefix`, or null when none ran. */
const statementCount = (queries: readonly RecordedQuery[], prefix: string) =>
  queries.filter((q) => normalized(q.sql).startsWith(prefix)).length || null;
/** The published list's cursor (backend catalog.ts). */
const PUBLISHED_CURSOR = `DECLARE catalog_published_sources NO SCROLL CURSOR FOR ${normalized(listPublishedCatalogSourcesSql)}`;
/** The live private rows' cursor (backend catalog-delivery-intents.ts). */
const PRIVATE_CURSOR =
  "DECLARE catalog_private_snapshot NO SCROLL CURSOR FOR SELECT * FROM public.catalog_delivery_live_prepare_media ORDER BY";

interface Measured {
  outcome: "ok" | "null" | "throws";
  message?: string;
  detail?: unknown;
  /** Best wall time of the runs, in milliseconds. */
  ms: number;
  runs: number;
  statements: Record<string, number>;
  connects: Record<string, number>;
  rows: Record<string, number>;
  slowest: { pool: string; ms: number; rows: number | null; sql: string }[];
}

/** Runs `operation` over freshly recorded pools `runs` times; keeps the
 * fastest run's record. A throw ends the runs. */
const measure = async <T>(
  fixture: CatalogScaleDatabase,
  runs: number,
  operation: (
    pools: { cms: Pool; prepare: Pool; app: Pool },
    recorder: QueryRecorder,
  ) => Promise<T>,
  detail: (result: T) => unknown = () => undefined,
): Promise<Measured & { recorder: QueryRecorder; result?: T }> => {
  let best: (Measured & { recorder: QueryRecorder; result?: T }) | undefined;
  for (let run = 0; run < runs; run += 1) {
    const recorder = createQueryRecorder();
    const pools = {
      cms: recorder.wrap("cms", fixture.publicRead),
      prepare: recorder.wrap("prepare", fixture.prepare),
      app: recorder.wrap("app", fixture.app),
    };
    const started = performance.now();
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await operation(pools, recorder);
    } catch (error) {
      failure = error;
    }
    const ms = performance.now() - started;
    const { statements, connects } = recorder.counts();
    const rows: Record<string, number> = {};
    for (const query of recorder.queries)
      rows[query.pool] = (rows[query.pool] ?? 0) + (query.rows ?? 0);
    const record = {
      outcome:
        failure !== undefined
          ? ("throws" as const)
          : result === null
            ? ("null" as const)
            : ("ok" as const),
      ...(failure !== undefined
        ? { message: (failure as Error)?.message ?? String(failure) }
        : { detail: detail(result as T) }),
      ms: round(ms),
      runs: run + 1,
      statements,
      connects,
      rows,
      slowest: [...recorder.queries]
        .filter((query) => Number.isFinite(query.ms))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
        .map((query) => ({
          pool: query.pool,
          ms: round(query.ms),
          rows: query.rows,
          sql: oneLine(query.sql),
        })),
      recorder,
      ...(failure === undefined ? { result: result as T } : {}),
    };
    if (!best || record.ms < best.ms) best = { ...record, runs: run + 1 };
    else best.runs = run + 1;
    if (failure !== undefined) break;
  }
  return best!;
};

const strip = ({
  recorder: _recorder,
  result: _result,
  ...measured
}: Measured & { recorder: QueryRecorder; result?: unknown }): Measured => {
  void _recorder;
  void _result;
  return measured;
};

interface ScenarioReport {
  name: string;
  note: string;
  shape: CatalogScaleShape;
  counts: ReturnType<typeof catalogScaleCounts>;
  seed: { ms: Record<string, number>; bumpedAssets?: number };
  ops: Record<string, Measured>;
  explain: Record<string, CatalogScalePlan | { error: string }>;
}

const report = {
  head: "",
  serviceTreeClean: false,
  postgres: "",
  startedAt: new Date().toISOString(),
  repeat: REPEAT,
  scenarios: [] as ScenarioReport[],
};

// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

beforeAll(async () => {
  report.head = git("rev-parse", "--short=8", "HEAD");
  // The measured code is the head's: no change outside the test workspace.
  report.serviceTreeClean =
    git(
      "status",
      "--porcelain",
      "--",
      "services",
      "packages",
      "apps",
      "database",
      "infra",
    ) === "";
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csbench",
  });
  report.postgres = (
    await fixture.setup.query<{ v: string }>("SELECT version() AS v")
  ).rows[0]!.v;
});

afterAll(async () => {
  await fixture?.close();
  if (!OUTPUT) return;
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${OUTPUT.replace(/\.json$/u, "")}.txt`, `${summary()}\n`);
});

const summary = () => {
  const lines = [
    `catalog scale bench @${report.head} (service tree clean: ${report.serviceTreeClean}) ${report.postgres.split(" on ")[0]}`,
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `\n## ${scenario.name}: ${scenario.note}; seed cms=${Math.round(scenario.seed.ms.cms ?? 0)}ms app=${Math.round(scenario.seed.ms.app ?? 0)}ms`,
    );
    for (const [name, op] of Object.entries(scenario.ops))
      lines.push(
        `${name.padEnd(28)} ${op.outcome.padEnd(6)} ${String(op.ms).padStart(10)} ms  ${JSON.stringify(op.statements)}${op.message ? `  ${op.message}` : ""}`,
      );
    for (const [name, plan] of Object.entries(scenario.explain))
      lines.push(
        "error" in plan
          ? `explain ${name}: ${plan.error}`
          : `explain ${name.padEnd(20)} ${String(plan.executionMs ?? "-").padStart(10)} ms  seq=[${plan.seqScans.join(",")}] idx=[${plan.indexes.join(",")}]`,
      );
  }
  return lines.join("\n");
};

/** k images spread over the published records (record order). */
const sample = (records: number, k: number, lastImages: number) => {
  if (k === 7)
    return Array.from({ length: 7 }, (_, i) => catalogScaleImage(1, i + 1));
  return Array.from({ length: k }, (_, j) => {
    const n = 1 + Math.floor((j * records) / k);
    const images = n === records ? lastImages : 7;
    return catalogScaleImage(n, 1 + (j % images));
  });
};

const explain = async (
  into: ScenarioReport["explain"],
  name: string,
  pool: Pool,
  sql: string | undefined,
  values: readonly unknown[] | undefined,
) => {
  if (sql === undefined) {
    into[name] = { error: "statement not found" };
    return;
  }
  try {
    into[name] = await explainCatalogScale(pool, sql, values ?? [], {
      analyze: true,
    });
  } catch (error) {
    into[name] = { error: (error as Error).message };
  }
};

const syncOnce = (fixture: CatalogScaleDatabase, now = new Date()) =>
  measure(
    fixture,
    1,
    async ({ cms, prepare, app }) => {
      const passes: unknown[] = [];
      const lines: string[] = [];
      const port = new PostgresWorkPublishingAdapter(app, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      await createCatalogSync({
        listSources: () => listPublishedCatalogSources(cms),
        readSnapshot: () => readCatalogSourceSnapshot(cms, prepare),
        port: {
          syncCatalogAssets: async (sources, now, options) => {
            const result = await port.syncCatalogAssets(
              sources,
              now,
              options as Parameters<typeof port.syncCatalogAssets>[2],
            );
            passes.push(result);
            return result;
          },
        },
        logger: {
          info: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      }).run(now);
      return { passes, lines };
    },
    (result) => result,
  );

/*
 * The mirror sync's statements (community catalog-delivery-intents.ts). Since
 * W4 it reads only the rows a pass can change, without a lock (d51114c5 read
 * and locked every row FOR UPDATE: `mirrorRowsLockedForUpdate`), reads the
 * stored members of every snapshot intent in one statement (d51114c5: one per
 * intent, `mediaRefReads`), and writes each kind of change in one set-based
 * statement that runs only when a row changes (d51114c5: one UPDATE per
 * intent, changed or not, `mirrorRowUpdates`). So each detail is the rows of
 * one statement: null when it did not run (no change of that kind, or no
 * stored member to read) and 0 when it ran and changed nothing.
 */
const syncDetail = (measured: Measured & { recorder: QueryRecorder }) => {
  const queries = measured.recorder.queries;
  return {
    mirrorRowsRead: statementRows(
      queries,
      "SELECT * FROM community.catalog_delivery_prepares WHERE observed_live OR intent_id=ANY(",
    ),
    mediaRefRowsRead: statementRows(
      queries,
      "SELECT intent_id,ordinal,media_id,object_key,source_sha256,width,height FROM community.catalog_delivery_media_refs WHERE intent_id=ANY(",
    ),
    mirrorRowsAdvanced: statementRows(
      queries,
      "UPDATE community.catalog_delivery_prepares p SET source_state=",
    ),
    mirrorRowsAdded: statementRows(
      queries,
      "INSERT INTO community.catalog_delivery_prepares (intent_id,",
    ),
    mirrorRowsTombstoned: statementRows(
      queries,
      "UPDATE community.catalog_delivery_prepares SET observed_live=false",
    ),
  };
};

const inspections = (recorder: QueryRecorder) =>
  statementCount(
    recorder.queries,
    "SELECT * FROM community.catalog_delivery_prepares WHERE intent_id=$1 FOR SHARE",
  );

type CatalogLease = Awaited<
  ReturnType<ReturnType<typeof createCatalogPublicationAuthority>["acquire"]>
>;

/** Times one fence check of a held lease (best of `runs`), counting the
 * statements of its last call from the lease's own recorder. */
const fenceCheck = async (
  recorder: QueryRecorder,
  check: () => Promise<boolean>,
  runs: number,
) => {
  let best = Number.POSITIVE_INFINITY;
  let value: boolean | undefined;
  let failure: unknown;
  let from = recorder.queries.length;
  for (let run = 0; run < runs && failure === undefined; run += 1) {
    from = recorder.queries.length;
    const started = performance.now();
    try {
      value = await check();
    } catch (error) {
      failure = error;
    }
    best = Math.min(best, performance.now() - started);
  }
  const queries = recorder.queries.slice(from);
  const statements: Record<string, number> = {};
  const rows: Record<string, number> = {};
  for (const query of queries) {
    statements[query.pool] = (statements[query.pool] ?? 0) + 1;
    rows[query.pool] = (rows[query.pool] ?? 0) + (query.rows ?? 0);
  }
  const measured: Measured = {
    outcome: failure === undefined ? "ok" : "throws",
    ...(failure === undefined
      ? { detail: { value } }
      : { message: (failure as Error)?.message ?? String(failure) }),
    ms: round(best),
    runs,
    statements,
    connects: {},
    rows,
    slowest: [...queries]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((query) => ({
        pool: query.pool,
        ms: round(query.ms),
        rows: query.rows,
        sql: oneLine(query.sql),
      })),
  };
  return { measured, queries };
};

/**
 * d51114c5's two bounds a worker pass meets only after another: the store's
 * 10,000-source bound (the snapshot's union is null first) and reconcile's
 * 40,000-id selector (the publicReady bound throws first, unless private-B
 * pins add ids), each called at its limit and one past it. At this head the
 * store takes up to the snapshot ceiling (W3) and reconcile binds the ids as
 * one text[] with no count bound (W1), so all four calls complete.
 */
const directStep = async (scenario: ScenarioReport) => {
  const sources = (n: number) =>
    Array.from({ length: n }, (_, k) => {
      const image = catalogScaleImage(100_000 + k, 1);
      return {
        mediaId: image.mediaId,
        objectKey: image.objectKey,
        width: image.width,
        height: image.height,
      };
    });
  for (const n of [10_000, 10_001])
    scenario.ops[`store.sources${n}`] = strip(
      await measure(
        fixture,
        1,
        ({ app }) =>
          new PostgresWorkPublishingAdapter(app, {
            publication: { allowPublish: () => true, isPublic: () => true },
          }).syncCatalogAssets(sources(n), new Date(), {
            limit: 100,
            renditions: [],
          }),
        (counts) => counts,
      ),
    );
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, k) =>
        `media-rendition-${createHash("md5").update(`direct:${k}`).digest("hex")}`,
    );
  for (const n of [40_000, 40_001])
    scenario.ops[`reconcile.selector${n}`] = strip(
      await measure(
        fixture,
        1,
        ({ cms, prepare, app }) =>
          new PostgresMediaPublicationAdapter(app, {
            isPublic: () => true,
            allowPublish: () => true,
            catalogAuthority: {
              ...createCatalogPublicationAuthority(cms, prepare, app),
              copyRenditionIds: async () => ids(n),
            },
          }).reconcile(new Date(), true, 500),
        (counts) => counts,
      ),
    );
};

const pairsStep = async (scenario: ScenarioReport) => {
  const { records, lastRecordImages } = scenario.counts;
  for (const view of ["fenced", "keyed"] as CatalogMediaView[]) {
    await setCatalogMediaView(fixture, view);
    for (const k of [7, 100]) {
      const pairs = sample(records, k, lastRecordImages);
      const measured = await measure(
        fixture,
        REPEAT,
        ({ cms }) => publishedCatalogPairs(cms, pairs),
        (live) => ({ live: live.size }),
      );
      scenario.ops[`pairs.k${k}.${view}`] = strip(measured);
      const check = measured.recorder.queries.find(
        (query) => query.sql === publishedCatalogPairsSql,
      );
      await explain(
        scenario.explain,
        `pairs.k${k}.${view}`,
        fixture.publicRead,
        check?.sql,
        check?.values,
      );
    }
    // The published list's cursor on this view, as the snapshot declares it.
    const listing = createQueryRecorder();
    await listPublishedCatalogSources(listing.wrap("cms", fixture.publicRead));
    const cursor = firstStatement(listing.queries, PUBLISHED_CURSOR);
    await explain(
      scenario.explain,
      `listing.${view}`,
      fixture.publicRead,
      cursor?.sql,
      cursor?.values,
    );
  }
  for (const k of [7, 100]) {
    const pairs = sample(records, k, lastRecordImages);
    scenario.ops[`facts.k${k}`] = strip(
      await measure(
        fixture,
        REPEAT,
        ({ cms, app }) =>
          createCatalogDeliveryFacts(
            cms,
            app,
          )(
            pairs.map(({ mediaId, objectKey }) => ({
              mediaId: mediaId as MediaId,
              objectKey,
            })),
          ),
        (facts) => ({ complete: facts.size }),
      ),
    );
  }
  const ids = sample(records, 100, lastRecordImages).map((i) => i.assetId);
  scenario.ops["publishedAssetIds.k100"] = strip(
    await measure(
      fixture,
      REPEAT,
      ({ cms, prepare, app }) =>
        createCatalogPublicationAuthority(cms, prepare, app).publishedAssetIds(
          ids,
        ),
      (live) => ({ live: live.length }),
    ),
  );
};

const workerStep = async (scenario: ScenarioReport, full: boolean) => {
  const reads = Math.min(REPEAT, 3);
  scenario.ops.listing = strip(
    await measure(
      fixture,
      reads,
      ({ cms }) => listPublishedCatalogSources(cms),
      (rows) => ({ rows: rows?.length }),
    ),
  );
  const snapshot = await measure(
    fixture,
    reads,
    ({ cms, prepare }) => readCatalogSourceSnapshot(cms, prepare),
    (snapshot) =>
      snapshot && {
        sources: snapshot.sources.length,
        publishedSources: snapshot.publishedSources.length,
        // Rows of the live projection, and the intents decoded from them.
        privateRows: snapshot.privateRows,
        preparations: snapshot.preparations?.length,
        undecodable: snapshot.undecodableIntentIds?.length ?? 0,
      },
  );
  scenario.ops.snapshot = strip(snapshot);
  const privateRows = firstStatement(snapshot.recorder.queries, PRIVATE_CURSOR);
  await explain(
    scenario.explain,
    "snapshot.privateRows",
    fixture.prepare,
    privateRows?.sql,
    privateRows?.values,
  );
  const first = await syncOnce(fixture);
  scenario.ops["sync.pass1"] = {
    ...strip(first),
    detail: { ...(first.detail as object), ...syncDetail(first) },
  };
  if (full) {
    const second = await syncOnce(fixture);
    scenario.ops["sync.pass2"] = {
      ...strip(second),
      detail: { ...(second.detail as object), ...syncDetail(second) },
    };
  }
  const plans = await measure(
    fixture,
    1,
    ({ cms, prepare, app }) =>
      createCatalogPublicationAuthority(cms, prepare, app).copyRenditionIds(),
    (ids) => ({ renditionIds: ids.length }),
  );
  scenario.ops.plans = {
    ...strip(plans),
    detail: {
      ...(plans.detail as object),
      inspections: inspections(plans.recorder),
    },
  };
  const publicReady = firstStatement(
    plans.recorder.queries,
    "SELECT DISTINCT r.id,a.media_id,a.source_object_key",
  );
  await explain(
    scenario.explain,
    "plans.publicReady",
    fixture.app,
    publicReady?.sql,
    publicReady?.values,
  );
  if (!full) return;
  const reconcile = await measure(
    fixture,
    1,
    ({ cms, prepare, app }) =>
      new PostgresMediaPublicationAdapter(app, {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: createCatalogPublicationAuthority(cms, prepare, app),
      }).reconcile(new Date(), true, 500),
    (counts) => counts,
  );
  scenario.ops.reconcile = strip(reconcile);
  const candidates = firstStatement(
    reconcile.recorder.queries,
    "WITH desired AS (",
  );
  if (reconcile.outcome === "ok")
    scenario.ops.reconcile.detail = {
      ...(scenario.ops.reconcile.detail as object),
      candidatesSqlBytes: candidates?.sql.length ?? null,
      candidatesMs: candidates ? round(candidates.ms) : null,
    };
  await explain(
    scenario.explain,
    "reconcile.candidates",
    fixture.app,
    candidates?.sql,
    candidates?.values,
  );

  const readiness = await measure(
    fixture,
    Math.min(REPEAT, 3),
    ({ prepare, app }) =>
      createCatalogReadiness(prepare, app)(catalogScaleIntentId("released", 1)),
    (facts) => facts && { privateReady: facts.privateReady },
  );
  scenario.ops.readiness = strip(readiness);
  const readinessRead = firstStatement(
    readiness.recorder.queries,
    "SELECT * FROM public.catalog_delivery_prepare_media",
  );
  await explain(
    scenario.explain,
    "readiness",
    fixture.prepare,
    readinessRead?.sql,
    readinessRead?.values,
  );

  // One publish job's capture and fence, on a released record's image. The
  // lease keeps its recorded pools, so its checks are counted per call.
  const asset = catalogScaleImage(1, 1).assetId;
  let lease = undefined as CatalogLease | undefined;
  const acquired = await measure(
    fixture,
    1,
    async ({ cms, prepare, app }) => {
      lease = await createCatalogPublicationAuthority(
        cms,
        prepare,
        app,
      ).acquire(asset);
      return { renditionIds: lease.renditionIds.length };
    },
    (result) => result,
  );
  scenario.ops.acquire = strip(acquired);
  if (!lease) return;
  const held = lease;
  try {
    const current = await fenceCheck(
      acquired.recorder,
      () => held.current(),
      REPEAT,
    );
    scenario.ops["fence.current"] = current.measured;
    const check = firstStatement(
      current.queries,
      "SELECT DISTINCT intent_id,catalog_document_id,state,state_version",
    );
    await explain(
      scenario.explain,
      "fence.current",
      fixture.prepare,
      check?.sql,
      check?.values,
    );
    scenario.ops["fence.authorized"] = (
      await fenceCheck(acquired.recorder, () => held.authorized(), 1)
    ).measured;
  } finally {
    await held.release();
  }
};

describe.sequential("catalog-scale-v1 W0: scale bench (local only)", () => {
  for (const scenario of selected)
    it(
      scenario.name,
      async () => {
        await clearCatalogScale(fixture);
        await setCatalogMediaView(fixture, "keyed");
        const seeded = await seedCatalogScale(fixture, scenario.shape);
        const current: ScenarioReport = {
          name: scenario.name,
          note: scenario.note,
          shape: scenario.shape,
          counts: seeded.counts,
          seed: {
            ms: Object.fromEntries(
              Object.entries(seeded.ms).map(([k, v]) => [k, round(v)]),
            ),
          },
          ops: {},
          explain: {},
        };
        if (scenario.bump) {
          current.seed.bumpedAssets = await bumpCatalogScaleRecipe(
            fixture,
            scenario.bump,
          );
          await fixture.setup.query("ANALYZE community.media_renditions");
        }
        report.scenarios.push(current);
        expect(
          Number(
            (
              await fixture.publicRead.query<{ n: string }>(
                "SELECT count(*) AS n FROM catalog_media",
              )
            ).rows[0]!.n,
          ),
        ).toBe(scenario.shape.publishedImages);
        if (scenario.steps.includes("pairs")) await pairsStep(current);
        await setCatalogMediaView(fixture, "keyed");
        if (scenario.steps.includes("worker")) await workerStep(current, true);
        if (scenario.steps.includes("boundary"))
          await workerStep(current, false);
        if (scenario.steps.includes("direct")) await directStep(current);
      },
      60 * 60_000,
    );
});
