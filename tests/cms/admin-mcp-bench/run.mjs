import process from "node:process";
import console from "node:console";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL, pathToFileURL } from "node:url";

import {
  boundedChildLimit,
  cmsLibraryBuildArgs,
  createVerificationSession,
  resolveCmsBudget,
  syntheticDatabase,
  timeCategories,
  verificationRoot as root,
  verifyLoopbackDisposableTarget,
} from "../../../scripts/editorial/verify-cms.mjs";

// The Admin MCP bench of admin-mcp-completion-v1 section 21, on a database of its own:
//
//   node tests/cms/admin-mcp-bench/run.mjs l0 --profile complete
//   node tests/cms/admin-mcp-bench/run.mjs l1 --output <private directory>
//   node tests/cms/admin-mcp-bench/run.mjs analytics --output <private directory> --umami <manifest from umami-stack.mjs>
//
// L0 is the CI floor: the reference paths in-process over real JSON-RPC, graded, with
// statement counts and plans, and timing only as an alarm. L1 is evidence for a quiet
// machine: the Next production build over real HTTP, p50 and p95 against the budgets.
// Analytics is the same L1 for admin_analytics, against a real Umami and a real Backend,
// with known answers on the reference paths A1 to A4 and budgets from section 21.
// Everything it uses it makes and removes, and the database the CMS checks share is
// never written, so a run leaves nothing for the browser checks after it to meet.

const L1_SESSION_MS = 600_000;
const ANALYTICS_SESSION_MS = 3_600_000;
const ANALYTICS_BATCH_ROWS = 5_000;
const NATIVE_SERVER_START_MS = 45_000;
const EXPECTED_VERSION_NUM =
  process.env.TEST_DATABASE_EXPECTED_VERSION_NUM ?? "160015";

const here = "tests/cms/admin-mcp-bench";

let stage = "configuration";

const optionsOf = (argv) => {
  const [mode, ...rest] = argv;
  if (!["l0", "l1", "analytics"].includes(mode))
    throw new Error("INVALID_BENCH_ARGUMENTS");
  const at = rest.indexOf("--output");
  const output = at === -1 ? undefined : rest[at + 1];
  if (at !== -1 && !output) throw new Error("INVALID_BENCH_ARGUMENTS");
  if (mode !== "l0" && !output) throw new Error("BENCH_OUTPUT_REQUIRED");
  const manifestAt = rest.indexOf("--umami");
  const umamiManifest = manifestAt === -1 ? undefined : rest[manifestAt + 1];
  if (mode === "analytics" && !umamiManifest)
    throw new Error("BENCH_UMAMI_MANIFEST_REQUIRED");
  return {
    mode,
    output,
    umamiManifest,
    profileArgs: at === -1 ? rest : rest.toSpliced(at, 2),
  };
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const socket = createNetServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

/** The route catalog_thumb calls on the Backend, answering the token it was given. */
const startThumbnailStub = async (token, bytes) => {
  const stub = createServer((incoming, outgoing) => {
    if (
      incoming.headers.authorization !== `Bearer ${token}` ||
      !incoming.url?.startsWith(
        "/internal/community/catalog-delivery/thumbnail",
      )
    ) {
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "image/webp",
      "content-length": String(bytes.length),
    });
    outgoing.end(bytes);
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${stub.address().port}`,
    close: async () => {
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    },
  };
};

/** The server's own clock per class: POST seen to answer built, from its audit rows. */
const auditDurations = async (pool, classes) => {
  const { rows } = await pool.query(
    `SELECT w.name,
       count(e.id)::int AS samples,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY e.duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_ms) AS p95
     FROM jsonb_to_recordset($1::jsonb) AS w(name text, tool text, "from" timestamptz, "to" timestamptz)
     JOIN mcp_audit_events e ON e.tool = w.tool AND e.at BETWEEN w."from" AND w."to"
     GROUP BY w.name`,
    [
      JSON.stringify(
        classes
          .filter(({ tool }) => tool !== undefined)
          .map(({ name, tool, from, to }) => ({ name, tool, from, to })),
      ),
    ],
  );
  return Object.fromEntries(
    rows.map(({ name, samples, p50, p95 }) => [
      name,
      {
        samples,
        p50: Number(Number(p50).toFixed(1)),
        p95: Number(Number(p95).toFixed(1)),
      },
    ]),
  );
};

const runL0 = async (session, env) => {
  const reportFile = path.join(session.directory, "l0-report.json");
  const resultsFile = path.join(session.directory, "l0-results.json");
  let failure;
  try {
    await session.run(
      [
        "../node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "cms/admin-mcp-bench/vitest.config.ts",
        "--no-file-parallelism",
        "--reporter=json",
        `--outputFile=${resultsFile}`,
        `--testTimeout=${boundedChildLimit(60_000, session.remaining())}`,
        `--hookTimeout=${boundedChildLimit(120_000, session.remaining())}`,
      ],
      path.join(root, "tests"),
      "l0",
      { ...env, ADMIN_MCP_BENCH_REPORT_FILE: reportFile },
    );
  } catch (error) {
    failure = error;
  }
  const results = await readFile(resultsFile, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  const report = await readFile(reportFile, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (results) {
    const tests = results.testResults.flatMap((file) => file.assertionResults);
    console.log(
      `L0 tests: ${tests.filter((test) => test.status === "passed").length} passed, ${tests.filter((test) => test.status === "failed").length} failed`,
    );
    // Names only: an assertion's message can carry a response object.
    for (const test of tests.filter((row) => row.status === "failed"))
      console.log(`L0 FAILED: ${test.fullName}`);
  }
  if (report) {
    console.log(JSON.stringify(report));
    for (const row of report.classes ?? [])
      if (row.alarm)
        console.log(
          `::warning::Admin MCP L0 alarm: ${row.name} p95 ${row.p95}ms is over 3x its ${row.budgetMs}ms budget (no gate on shared runners)`,
        );
  }
  if (failure) throw failure;
  return { report };
};

/** Numbers and fixed words only: nothing a response said. */
const l1Summary = ({ classes, trials, legibility, failures, serverClock }) => [
  ...classes.map(
    ({ name, firstMs, p50, p95, budgetMs, withinBudget, samples }) =>
      `L1 ${name}: first ${firstMs}ms, p50 ${p50}ms, p95 ${p95}ms, budget ${budgetMs}ms, ${withinBudget ? "within" : "OVER"} (n=${samples})${serverClock[name] ? `; server clock p95 ${serverClock[name].p95}ms` : ""}`,
  ),
  ...Object.entries(trials).map(
    ([name, { pass, toolCalls, p50, p95, trials: count }]) =>
      `L1 ${name}: ${pass ? "PASS" : "FAIL"}, ${toolCalls} calls, p50 ${p50}ms, p95 ${p95}ms (n=${count})`,
  ),
  ...legibility.views.map(
    ({ label, rendered, finestStroke }) =>
      `L1 legibility ${label}: ${rendered.width}x${rendered.height}, ${rendered.bytes} bytes, finest bar kept ${finestStroke} px`,
  ),
  ...failures.slice(0, 20).map((failure) => `L1 failure: ${failure}`),
];

const runL1 = async (session, env, pool, output, thumbnail) => {
  const admin = path.join(root, "apps/admin");
  const standalone = path.join(admin, ".next/standalone/apps/admin");
  await access(path.join(standalone, "server.js")).catch(() => {
    throw new Error("BENCH_ADMIN_BUILD_REQUIRED");
  });
  const baseToken = randomBytes(32).toString("base64url");
  const stub = await startThumbnailStub(baseToken, thumbnail);
  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const serverEnv = {
      ...env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CMS_PUBLIC_URL: origin,
      CMS_PREVIEW_WEB_URL: origin,
      COMMUNITY_OPERATOR_BASE_URL: stub.origin,
      OPERATOR_AI_BASE_TOKEN: baseToken,
    };
    stage = "native-server";
    const server = session.start(["server.js"], standalone, serverEnv, false);
    const deadline =
      Date.now() +
      boundedChildLimit(NATIVE_SERVER_START_MS, session.remaining());
    for (;;) {
      session.assertActive();
      try {
        const response = await globalThis.fetch(`${origin}/admin/login`, {
          redirect: "error",
          cache: "no-store",
          signal: globalThis.AbortSignal.timeout(3_000),
        });
        if (response.ok) break;
      } catch {
        /* bounded startup */
      }
      if (
        Date.now() >= deadline ||
        server.child.exitCode !== null ||
        server.child.signalCode !== null
      )
        throw new Error("NATIVE_SERVER_START_FAILED");
      await delay(200, undefined, { signal: session.signal });
    }
    stage = "l1-driver";
    const resultFile = path.join(session.directory, "l1-result.json");
    let driverFailure;
    await session
      .run([path.join(here, "l1.ts")], root, "l1", {
        ...env,
        ADMIN_MCP_BENCH_ORIGIN: origin,
        ADMIN_MCP_BENCH_RESULT_FILE: resultFile,
      })
      .catch((error) => {
        driverFailure = error;
      });
    // A failed run is evidence too, so it is kept before the failure is raised.
    const result = await readFile(resultFile, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (result) {
      result.serverClock = await auditDurations(pool, result.classes);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
      const file = path.join(output, `admin-mcp-l1-${stamp}.json`);
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, {
        mode: 0o600,
      });
      console.log(`L1 evidence: ${file}`);
      for (const line of l1Summary(result)) console.log(line);
    }
    if (driverFailure) throw driverFailure;
  } finally {
    await stub.close();
  }
};

const waitUntilAnswered = async (session, url, headers, ready, code) => {
  const deadline =
    Date.now() + boundedChildLimit(NATIVE_SERVER_START_MS, session.remaining());
  for (;;) {
    session.assertActive();
    try {
      const response = await globalThis.fetch(url, {
        headers,
        redirect: "error",
        cache: "no-store",
        signal: globalThis.AbortSignal.timeout(3_000),
      });
      if (response.ok) return;
    } catch {
      /* bounded startup */
    }
    if (Date.now() >= deadline || ready.child.exitCode !== null)
      throw new Error(code);
    await delay(200, undefined, { signal: session.signal });
  }
};

const analyticsSummary = ({
  classes,
  knownAnswers,
  everyReport,
  wideFollowUp,
  failures,
  coldStart,
}) => [
  ...knownAnswers.map(
    ({ task, pass, ms, bytes }) =>
      `known answer ${task}: ${pass ? "PASS" : "FAIL"}, ${ms}ms, ${bytes} bytes`,
  ),
  ...everyReport.map(
    ({ name, ok, code, ms, bytes }) =>
      `report ${name}: ${ok ? "ok" : `refused ${code}`}, ${ms}ms, ${bytes} bytes`,
  ),
  ...classes.map(
    ({
      name,
      firstMs,
      p50,
      p95,
      max,
      budgetMs,
      withinBudget,
      samples,
      failed,
      umamiNotFresh,
    }) =>
      `analytics ${name}: first ${firstMs}ms, p50 ${p50}ms, p95 ${p95}ms, max ${max}ms, budget ${budgetMs}ms, ${withinBudget ? "within" : "OVER"} (n=${samples}, failed=${failed}, umami not fresh=${umamiNotFresh})`,
  ),
  `analytics wide overview: first ${wideFollowUp.first.ms}ms, umami ${wideFollowUp.first.umami}; again ${wideFollowUp.again.ms}ms, umami ${wideFollowUp.again.umami}`,
  ...coldStart.map(
    ({ name, ms, umami }) =>
      `analytics cold start ${name}: ${ms}ms, umami ${umami}`,
  ),
  ...failures.slice(0, 20).map((failure) => `analytics failure: ${failure}`),
];

/** The events and the oracle come from one pass of the generator, at the stack's clock. */
const seedCanonical = async (pool, manifest) => {
  const seedModule = await import(
    pathToFileURL(path.join(root, here, "analytics-seed.ts")).href
  );
  const clock = manifest.clock;
  if (seedModule.seedClock(Date.now()).day !== clock.day)
    throw new Error("BENCH_DAY_ROLLED_OVER");
  const generator = seedModule.analyticsGenerator(clock, manifest.events);
  const oracle = seedModule.createOracle(clock);
  oracle.addCollected(manifest.collected);
  const columns = seedModule.CANONICAL_COLUMNS;
  const names = columns.map(([name]) => name).join(",");
  const params = columns
    .map(([, cast], at) => `$${at + 1}::${cast}[]`)
    .join(",");
  const send = (rows) =>
    pool.query(
      `INSERT INTO community.analytics_events (${names}) SELECT * FROM unnest(${params})`,
      columns.map((_, at) => rows.map((row) => row[at])),
    );
  let rows = [];
  for (let index = 0; index < generator.total; index += 1) {
    const event = generator.eventAt(index);
    oracle.add(event);
    rows.push(seedModule.canonicalRowOf(event));
    if (rows.length >= ANALYTICS_BATCH_ROWS) {
      await send(rows);
      rows = [];
    }
  }
  if (rows.length > 0) await send(rows);
  await seedModule.seedAnalyticsTargets(pool);
  return oracle.result();
};

const runAnalytics = async (
  session,
  env,
  pool,
  { control, target, owned, output, manifest, manifestFile, afterDatabase },
) => {
  const admin = path.join(root, "apps/admin");
  const standalone = path.join(admin, ".next/standalone/apps/admin");
  await access(path.join(standalone, "server.js")).catch(() => {
    throw new Error("BENCH_ADMIN_BUILD_REQUIRED");
  });
  // The Backend reads as the real App role, not as the owner of the tables.
  const appRole = `${owned}_app`;
  const appPassword = randomBytes(24).toString("hex");
  await control.query(
    `CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  const grants = await readFile(
    path.join(root, "infra/development/work-publishing/grant-runtime.sql"),
    "utf8",
  );
  await pool.query(grants.replaceAll(':"app_role"', `"${appRole}"`));
  const appUrl = new URL(target.href);
  appUrl.username = appRole;
  appUrl.password = appPassword;
  // The owner's grants go with the database; the role outlives it otherwise.
  afterDatabase.push(() =>
    control.query(`DROP ROLE IF EXISTS "${appRole}"`).catch(() => {
      console.log("Admin MCP bench: role not removed");
    }),
  );

  const baseToken = randomBytes(32).toString("base64url");
  stage = "analytics-backend";
  const backendPort = await freePort();
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const backend = session.start(
    [path.join(root, here, "analytics-backend.ts")],
    root,
    {
      ...env,
      ADMIN_MCP_BENCH_BACKEND_PORT: String(backendPort),
      ADMIN_MCP_BENCH_BACKEND_DATABASE: appUrl.href,
      ADMIN_MCP_BENCH_BASE_TOKEN: baseToken,
    },
    false,
  );
  await waitUntilAnswered(
    session,
    `${backendOrigin}/internal/analytics/insights/status`,
    { authorization: `Bearer ${baseToken}` },
    backend,
    "BENCH_BACKEND_START_FAILED",
  );

  stage = "native-server";
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = session.start(
    ["server.js"],
    standalone,
    {
      ...env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CMS_PUBLIC_URL: origin,
      CMS_PREVIEW_WEB_URL: origin,
      COMMUNITY_OPERATOR_BASE_URL: `${backendOrigin}/`,
      OPERATOR_AI_BASE_TOKEN: baseToken,
      UMAMI_ORIGIN: manifest.origin,
      UMAMI_WEBSITE_ID: manifest.websiteId,
      UMAMI_VIEWER_USERNAME: manifest.viewerUsername,
      UMAMI_VIEWER_PASSWORD: manifest.viewerPassword,
    },
    false,
  );
  await waitUntilAnswered(
    session,
    `${origin}/admin/login`,
    {},
    server,
    "NATIVE_SERVER_START_FAILED",
  );

  stage = "analytics-driver";
  const resultFile = path.join(session.directory, "analytics-result.json");
  let driverFailure;
  await session
    .run([path.join(here, "analytics-l1.ts")], root, "analytics", {
      ...env,
      ADMIN_MCP_BENCH_ORIGIN: origin,
      ADMIN_MCP_BENCH_RESULT_FILE: resultFile,
      ADMIN_MCP_BENCH_UMAMI_MANIFEST: manifestFile,
    })
    .catch((error) => {
      driverFailure = error;
    });
  // A failed run is evidence too, so it is kept before the failure is raised.
  const result = await readFile(resultFile, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (result) {
    result.serverClock = await auditDurations(pool, result.classes);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const file = path.join(output, `admin-mcp-analytics-l1-${stamp}.json`);
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Analytics L1 evidence: ${file}`);
    for (const line of analyticsSummary(result)) console.log(line);
  }
  if (driverFailure) throw driverFailure;
};

async function main() {
  const { mode, output, profileArgs, umamiManifest } = optionsOf(
    process.argv.slice(2),
  );
  const sessionBudgetMs =
    mode === "l0"
      ? resolveCmsBudget(profileArgs).sessionBudgetMs
      : mode === "analytics"
        ? ANALYTICS_SESSION_MS
        : L1_SESSION_MS;
  // It issues CREATE DATABASE, which the remote synthetic target never allows.
  if (process.env.CMS_TEST_REMOTE_TARGET_JSON)
    throw new Error("BENCH_LOOPBACK_ONLY");
  const parent = new URL(syntheticDatabase(process.env.CMS_TEST_DATABASE_URL));
  const owned = `${parent.pathname.slice(1)}_bench_${randomBytes(4).toString("hex")}`;
  // PostgreSQL has no bind parameter for an identifier, so this is checked.
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(owned))
    throw new Error("BENCH_DATABASE_NAME_INVALID");
  const adminUrl = new URL(parent.href);
  adminUrl.pathname = "/postgres";
  const target = new URL(parent.href);
  target.pathname = `/${owned}`;
  const session = await createVerificationSession(
    target.href,
    "moya-admin-mcp-bench-",
    sessionBudgetMs,
  );
  console.log(`Admin MCP bench ${mode}: session ${sessionBudgetMs}ms`);
  let control;
  let pool;
  let created = false;
  let closePool;
  let operationError;
  const afterDatabase = [];
  try {
    stage = "library-build";
    await session.run(cmsLibraryBuildArgs(), root, "library-build");
    const { closePostgresPool, createPostgresPool, parsePostgresConfig } =
      await import(path.join(root, "services/catalog-postgres/dist/index.js"));
    closePool = closePostgresPool;

    stage = "database";
    await verifyLoopbackDisposableTarget(process.env);
    control = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: adminUrl.href }),
    );
    await control.query(`CREATE DATABASE "${owned}"`);
    created = true;
    pool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: target.href }),
    );
    await pool.query(
      await readFile(
        path.join(root, "infra/test/disposable-test-target.sql"),
        "utf8",
      ),
    );
    await verifyLoopbackDisposableTarget(session.env);
    const version = (
      await pool.query("SELECT current_setting('server_version_num') AS num")
    ).rows[0].num;
    if (version !== EXPECTED_VERSION_NUM)
      throw new Error("BENCH_POSTGRES_VERSION_MISMATCH");

    stage = "migrations";
    await session.run(
      ["node_modules/payload/bin.js", "migrate"],
      path.join(root, "apps/admin"),
      "migrations",
    );
    const { runCommunityMigrations } = await import(
      path.join(root, "services/community-postgres/dist/index.js")
    );
    await runCommunityMigrations(
      pool,
      path.join(root, "database/community-migrations"),
    );

    stage = "provision";
    const started = Date.now();
    const { syntheticChart, syntheticThumbnail } = await import(
      pathToFileURL(path.join(root, here, "legibility.ts")).href
    );
    const chart = await syntheticChart();
    const chartFile = path.join(session.directory, "chart.jpg");
    await writeFile(chartFile, chart, { mode: 0o600 });
    const thumbnail = await syntheticThumbnail(chart);
    const thumbnailFile = path.join(session.directory, "thumbnail.webp");
    await writeFile(thumbnailFile, thumbnail, { mode: 0o600 });
    const accessFile = path.join(session.directory, "access.json");
    await session.run(
      [
        "node_modules/payload/bin.js",
        "run",
        path.join(root, here, "provision.ts"),
      ],
      path.join(root, "apps/admin"),
      "provision",
      {
        ...session.env,
        ADMIN_MCP_BENCH_ACCESS_FILE: accessFile,
        ADMIN_MCP_BENCH_CHART_FILE: chartFile,
      },
    );
    const { ownerId } = JSON.parse(await readFile(accessFile, "utf8"));

    stage = "seed";
    const { finishSeed, seedCms, seedCommunity } = await import(
      pathToFileURL(path.join(root, here, "seed.ts")).href
    );
    const oracle = await seedCms(pool, ownerId);
    const communityOracle = await seedCommunity(pool);
    const manifest =
      mode === "analytics"
        ? JSON.parse(await readFile(umamiManifest, "utf8"))
        : undefined;
    const analyticsOracle =
      mode === "analytics" ? await seedCanonical(pool, manifest) : undefined;
    const rows = await finishSeed(pool);
    const seedMs = Date.now() - started;
    const oracleFile = path.join(session.directory, "oracle.json");
    await writeFile(
      oracleFile,
      JSON.stringify({
        oracle,
        communityOracle,
        analyticsOracle,
        rows,
        seedMs,
      }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ seededRows: rows, seedMs }));
    session.assertActive();

    const env = {
      ...session.env,
      ADMIN_MCP_BENCH_ACCESS_FILE: accessFile,
      ADMIN_MCP_BENCH_ORACLE_FILE: oracleFile,
      ADMIN_MCP_BENCH_THUMBNAIL_FILE: thumbnailFile,
    };
    stage = mode;
    if (mode === "l0") await runL0(session, env);
    else if (mode === "l1") await runL1(session, env, pool, output, thumbnail);
    else
      await runAnalytics(session, env, pool, {
        control,
        target,
        owned,
        output,
        manifest,
        manifestFile: path.resolve(umamiManifest),
        afterDatabase,
      });
  } catch (error) {
    operationError = error;
  } finally {
    await session.dispose();
    await pool?.end();
    if (created)
      await control
        .query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`)
        .catch(() => {
          console.log("Admin MCP bench: database not removed");
        });
    for (const cleanup of afterDatabase) await cleanup();
    if (control) await closePool(control);
  }
  if (session.failure) throw new Error(session.failure);
  if (operationError) throw operationError;
  console.log(`Admin MCP bench ${mode}: PASS in ${session.elapsed()}ms`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    const category =
      error instanceof Error && /^[A-Z_]+$/u.test(error.message)
        ? error.message
        : "ADMIN_MCP_BENCH_FAILED";
    console.log(JSON.stringify({ adminMcpBench: "FAIL", stage, category }));
    process.exitCode = timeCategories.has(category) ? 124 : 1;
  });
