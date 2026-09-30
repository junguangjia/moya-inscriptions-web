import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv, stripVTControlCharacters } from "node:util";
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { assertSyntheticTestDatabaseUrl } from "../../tests/integration/postgres/synthetic-test-database.ts";
import {
  assertDisposableTestTarget,
  databaseNameFromUrl,
  disposableTestTargetProbeSql,
  isTargetCategory,
} from "../disposable-test-target.mjs";
import {
  VALIDATION_PROFILES,
  effectiveCeiling,
  takeProfileOptions,
} from "../validation-profiles.mjs";

export const verificationRoot = fileURLToPath(
  new URL("../../", import.meta.url),
);

// CMS validation profiles. `quick` keeps the existing 120 s cap for an
// unflagged run in a prepared workspace (an ordinary check, not the FEEDBACK
// plan); `complete` is the explicit CMS COMPLETE profile for integration or
// native Admin browser validation. The session receives the ceiling minus a
// finalization margin for the final summary write; every child receives the
// session's remaining time, never a fresh allowance.
export const CMS_PROFILES = Object.freeze({
  quick: Object.freeze({ ...VALIDATION_PROFILES.cmsQuick, minimumMs: 30_000 }),
  complete: Object.freeze({
    ...VALIDATION_PROFILES.cmsComplete,
    minimumMs: 60_000,
  }),
});
export const CMS_FINALIZATION_MS = 2_000;

export function cmsOptions(argv) {
  const options = takeProfileOptions(argv, CMS_PROFILES);
  if (options.rest.length) throw new Error("INVALID_CMS_ARGUMENTS");
  return {
    profile: options.profile ?? "quick",
    remainingMs: options.remainingMs,
  };
}

export function cmsBudget(profileName, remainingMs = null) {
  const profile = CMS_PROFILES[profileName];
  const ceiling = effectiveCeiling(profile, remainingMs);
  return {
    ...ceiling,
    minimumMs: profile.minimumMs,
    viable: ceiling.ceilingMs >= profile.minimumMs,
    sessionBudgetMs: Math.max(1, ceiling.ceilingMs - CMS_FINALIZATION_MS),
  };
}

/** Resolve the CLI profile or fail fast before any database or child work. */
export function resolveCmsBudget(argv) {
  const options = cmsOptions(argv);
  const budget = cmsBudget(options.profile, options.remainingMs);
  if (!budget.viable) {
    console.log(
      JSON.stringify({
        profile: budget.profile,
        totalMs: budget.totalMs,
        ceilingMs: budget.ceilingMs,
        ceilingSource: budget.ceilingSource,
        minimumMs: budget.minimumMs,
      }),
    );
    throw new Error("INSUFFICIENT_REMAINING_TIME");
  }
  return budget;
}

export const timeCategories = new Set([
  "TIME_BUDGET_EXCEEDED",
  "INSUFFICIENT_REMAINING_TIME",
]);
const remoteSettingNames = [
  "MOYA_CONTENT_SOURCE",
  "CMS_ENVIRONMENT",
  "CMS_STORAGE_MODE",
  "CMS_DATABASE_URL",
  "CMS_TEST_DATABASE_URL",
  "CMS_DATABASE_SSL_CA_FILE",
  "CMS_TEST_REMOTE_TARGET_JSON",
];

/** Read only the explicitly named Owner-controlled EnvironmentFile. */
export function protectedRemoteSyntheticSettings(environment = process.env) {
  let file;
  try {
    if (!environment.CMS_TEST_CONFIG_FILE) throw new Error("CONFIG_REQUIRED");
    file = openSync(
      environment.CMS_TEST_CONFIG_FILE,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      ![0, process.getuid?.()].includes(info.uid) ||
      info.size > 64 * 1024
    )
      throw new Error("CONFIG_INVALID");
    const parsed = parseEnv(readFileSync(file, "utf8"));
    if (
      remoteSettingNames.some(
        (name) => !parsed[name] || parsed[name] !== environment[name],
      ) ||
      parsed.MOYA_CONTENT_SOURCE !== "payload" ||
      parsed.CMS_ENVIRONMENT !== "synthetic" ||
      parsed.CMS_STORAGE_MODE !== "local" ||
      parsed.CMS_DATABASE_URL !== parsed.CMS_TEST_DATABASE_URL ||
      environment.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    )
      throw new Error("CONFIG_MISMATCH");
    return Object.fromEntries(
      remoteSettingNames.map((name) => [name, parsed[name]]),
    );
  } catch {
    throw new Error("REMOTE_SYNTHETIC_PROTECTED_CONFIG_REQUIRED");
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export function syntheticDatabase(value, environment = process.env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SYNTHETIC_DATABASE_REQUIRED");
  }
  // node-postgres query parameters can override host/user and load TLS files.
  // A URL-hostname check alone does not constrain the actual connection target.
  const remote = environment.CMS_TEST_REMOTE_TARGET_JSON !== undefined;
  if (remote) {
    const settings = protectedRemoteSyntheticSettings(environment);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      value !== settings.CMS_TEST_DATABASE_URL ||
      !url.username ||
      url.pathname.length <= 1 ||
      url.search !== "?sslmode=verify-full" ||
      url.hash
    )
      throw new Error("REMOTE_SYNTHETIC_TARGET_INVALID");
    return url.toString();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.username ||
    url.pathname.length <= 1 ||
    url.search ||
    url.hash
  )
    throw new Error("SYNTHETIC_LOOPBACK_DATABASE_REQUIRED");
  // The suite name rule applies here too: a loopback host proves nothing, and
  // yoyi_dev is refused by name.
  try {
    assertSyntheticTestDatabaseUrl(value, "CMS_TEST_DATABASE_URL");
  } catch {
    throw new Error("SYNTHETIC_DATABASE_NAME_REQUIRED");
  }
  return url.toString();
}

/**
 * A loopback target must also carry the disposable marker set by
 * infra/test/disposable-test-target.sql; the remote path proves emptiness in
 * verifyRemoteSyntheticDatabase instead. Runs after the library builds and
 * before the first DDL.
 */
export async function verifyLoopbackDisposableTarget(environment, query) {
  if (environment.CMS_TEST_REMOTE_TARGET_JSON) return;
  const expected = databaseNameFromUrl(environment.CMS_TEST_DATABASE_URL).name;
  let pool;
  try {
    if (!query) {
      const { createPostgresPool, parsePostgresConfig } =
        await import("../../services/catalog-postgres/dist/index.js");
      pool = createPostgresPool(
        parsePostgresConfig({
          DATABASE_URL: environment.CMS_TEST_DATABASE_URL,
        }),
      );
      query = (sql) => pool.query(sql);
    }
    const result = await query(disposableTestTargetProbeSql);
    assertDisposableTestTarget(result.rows, expected);
  } catch (error) {
    // Driver errors can echo the connection string; expose a category only.
    throw new Error(
      isTargetCategory(error?.message)
        ? error.message
        : "DISPOSABLE_TARGET_PROBE_FAILED",
      { cause: error },
    );
  } finally {
    await pool?.end();
  }
}

/** The caller invokes this after library builds and before the first DDL. */
export async function verifyRemoteSyntheticDatabase(environment, query) {
  if (!environment.CMS_TEST_REMOTE_TARGET_JSON) return;
  const { cmsRemoteSyntheticTarget } =
    await import("../../apps/admin/src/runtime-settings.ts");
  const target = cmsRemoteSyntheticTarget(environment);
  let pool;
  try {
    if (!query) {
      const { createPostgresPool, parsePostgresConfig } =
        await import("../../services/catalog-postgres/dist/index.js");
      pool = createPostgresPool(
        parsePostgresConfig({
          DATABASE_URL: environment.CMS_DATABASE_URL,
          DATABASE_SSL_CA_FILE: environment.CMS_DATABASE_SSL_CA_FILE,
        }),
      );
      pool.options.statement_timeout = 10000;
      pool.options.query_timeout = 15000;
      query = (sql) => pool.query(sql);
    }
    const result = await query(`WITH RECURSIVE allowed_objects AS (
      SELECT d.classid, d.objid FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
      WHERE d.refclassid='pg_extension'::regclass AND d.deptype='e' AND e.extname='pg_trgm'
      UNION
      SELECT d.classid, d.objid FROM pg_depend d JOIN allowed_objects a
        ON d.refclassid=a.classid AND d.refobjid=a.objid WHERE d.deptype IN ('i', 'a')
    ) SELECT
      current_database() AS database,
      current_user AS username,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      current_setting('server_version_num') AS version_num,
      current_setting('server_version') AS server_version,
      COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()), false) AS tls,
      (SELECT count(*)::integer FROM (
        SELECT 'pg_class'::regclass AS classid, c.oid, c.relnamespace AS namespace FROM pg_class c
        UNION ALL
        SELECT 'pg_proc'::regclass, p.oid, p.pronamespace FROM pg_proc p
        UNION ALL
        SELECT 'pg_type'::regclass, t.oid, t.typnamespace FROM pg_type t
        UNION ALL
        SELECT 'pg_operator'::regclass, o.oid, o.oprnamespace FROM pg_operator o
        UNION ALL
        SELECT 'pg_opclass'::regclass, o.oid, o.opcnamespace FROM pg_opclass o
        UNION ALL
        SELECT 'pg_opfamily'::regclass, o.oid, o.opfnamespace FROM pg_opfamily o
        UNION ALL
        SELECT 'pg_collation'::regclass, c.oid, c.collnamespace FROM pg_collation c
        UNION ALL
        SELECT 'pg_conversion'::regclass, c.oid, c.connamespace FROM pg_conversion c
        UNION ALL
        SELECT 'pg_ts_config'::regclass, c.oid, c.cfgnamespace FROM pg_ts_config c
        UNION ALL
        SELECT 'pg_ts_dict'::regclass, d.oid, d.dictnamespace FROM pg_ts_dict d
        UNION ALL
        SELECT 'pg_ts_parser'::regclass, p.oid, p.prsnamespace FROM pg_ts_parser p
        UNION ALL
        SELECT 'pg_ts_template'::regclass, t.oid, t.tmplnamespace FROM pg_ts_template t
      ) objects JOIN pg_namespace n ON n.oid=objects.namespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND NOT EXISTS (
          SELECT 1 FROM allowed_objects a
          WHERE a.classid=objects.classid AND a.objid=objects.oid
        )) AS user_objects,
      (SELECT count(*)::integer FROM pg_namespace
        WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')) AS custom_schemas,
      (SELECT count(*)::integer FROM pg_extension WHERE extname NOT IN ('plpgsql', 'pg_trgm')) AS other_extensions,
      (SELECT count(*)::integer FROM pg_largeobject_metadata) AS large_objects`);
    const row = result.rows?.[0];
    if (
      result.rows?.length !== 1 ||
      row.database !== target.database ||
      row.username !== target.user ||
      row.database_oid !== target.databaseOid ||
      row.version_num !== String(target.serverVersionNum) ||
      !/^18\.6(?:\D|$)/.test(row.server_version ?? "") ||
      row.tls !== true ||
      row.user_objects !== 0 ||
      row.custom_schemas !== 0 ||
      row.other_extensions !== 0 ||
      row.large_objects !== 0
    )
      throw new Error("REMOTE_SYNTHETIC_PREFLIGHT_FAILED");
    return { versionNum: target.serverVersionNum, tls: true, empty: true };
  } catch {
    throw new Error("REMOTE_SYNTHETIC_PREFLIGHT_FAILED");
  } finally {
    await pool?.end();
  }
}

const summaryLines = (output) =>
  stripVTControlCharacters(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:Test Files|Tests)\s+(?:\d+ (?:passed|failed|skipped)(?: \| )?)+\s*\(\d+\)$/.test(
        line,
      ),
    );

/** One bounded session; only its own descendant process groups may be stopped. */
export async function createVerificationSession(
  database,
  prefix,
  budgetMs = cmsBudget("quick").sessionBudgetMs,
) {
  database = syntheticDatabase(database);
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(directory, "media"), { mode: 0o700 });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("CMS_") &&
        !key.startsWith("PG") &&
        !["DATABASE_URL", "TEST_DATABASE_URL"].includes(key),
    ),
  );
  const env = {
    ...inherited,
    MOYA_CONTENT_SOURCE: "payload",
    CMS_DATABASE_URL: database,
    CMS_TEST_DATABASE_URL: database,
    CMS_SECRET: randomBytes(48).toString("hex"),
    CMS_ENVIRONMENT: "synthetic",
    CMS_STORAGE_MODE: "local",
    CMS_MEDIA_DIR: path.join(directory, "media"),
  };
  if (process.env.CMS_TEST_REMOTE_TARGET_JSON) {
    Object.assign(env, protectedRemoteSyntheticSettings(), {
      NODE_EXTRA_CA_CERTS: process.env.CMS_DATABASE_SSL_CA_FILE,
    });
  }
  const started = Date.now();
  const groups = new Set();
  const processes = new Set();
  const controller = new globalThis.AbortController();
  let failure;
  let abortHard;
  const captureGroups = (timeoutMs = 1000) => {
    if (!groups.size) return;
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent, group] of rows) {
        if (
          !descendants.has(pid) &&
          (groups.has(group) || descendants.has(parent))
        ) {
          descendants.add(pid);
          groups.add(group);
          changed = true;
        }
      }
    }
  };
  const signalGroups = (signal) => {
    for (const group of groups) {
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= "PROCESS_CLEANUP_FAILED";
      }
    }
  };
  const rememberGroups = (timeoutMs = 1000) => {
    try {
      captureGroups(timeoutMs);
    } catch {
      failure ??= "PROCESS_CLEANUP_DISCOVERY_FAILED";
    }
  };
  const stop = (category) => {
    failure ??= category;
    rememberGroups();
    controller.abort();
    signalGroups("SIGTERM");
    abortHard ??= setTimeout(() => signalGroups("SIGKILL"), 8000);
  };
  const interrupt = () => stop("INTERRUPTED");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const soft = setTimeout(
    () => stop("TIME_BUDGET_EXCEEDED"),
    Math.max(1, budgetMs - 8000),
  );
  const hard = setTimeout(() => {
    failure ??= "TIME_BUDGET_EXCEEDED";
    controller.abort();
    signalGroups("SIGKILL");
  }, budgetMs);
  const monitor = setInterval(rememberGroups, 1000);
  const assertActive = () => {
    if (Date.now() - started >= budgetMs) stop("TIME_BUDGET_EXCEEDED");
    if (failure) throw new Error(failure);
  };
  const start = (args, cwd, childEnv = env, capture = true) => {
    assertActive();
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: [
        "ignore",
        capture ? "pipe" : "ignore",
        capture ? "pipe" : "ignore",
      ],
    });
    if (child.pid) groups.add(child.pid);
    const chunks = [];
    let bytes = 0;
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
      else stop("OUTPUT_LIMIT_EXCEEDED");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const closed = new Promise((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
    const managed = {
      child,
      closed,
      output: () => Buffer.concat(chunks).toString("utf8"),
    };
    processes.add(managed);
    return managed;
  };
  const run = async (args, cwd, label, childEnv = env) => {
    const managed = start(args, cwd, childEnv);
    const code = await managed.closed;
    const output = managed.output();
    const lines = summaryLines(output);
    // Child diagnostics can contain credentials, URLs or response objects.
    // Persist only fixed status/count projections; never retain raw output.
    await writeFile(
      path.join(directory, `${label}.log`),
      JSON.stringify({
        stage: label,
        exitCode: code,
        category: failure ?? (code ? "CHILD_FAILED" : "PASS"),
        summaries: lines,
      }) + "\n",
      { mode: 0o600 },
    );
    assertActive();
    if (code !== 0) throw new Error("VERIFICATION_CHILD_FAILED");
    return { output, lines };
  };
  const dispose = async () => {
    const remaining = () => Math.max(0, started + budgetMs + 1000 - Date.now());
    if (remaining()) rememberGroups(Math.min(1000, remaining()));
    controller.abort();
    signalGroups("SIGTERM");
    if (remaining()) await delay(Math.min(300, remaining()));
    signalGroups("SIGKILL");
    let closeTimer;
    await Promise.race([
      Promise.all([...processes].map((item) => item.closed)),
      new Promise((resolve) => {
        closeTimer = setTimeout(resolve, Math.min(1000, remaining()));
      }),
    ]);
    clearTimeout(closeTimer);
    clearTimeout(soft);
    clearTimeout(hard);
    clearTimeout(abortHard);
    clearInterval(monitor);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  };
  return {
    directory,
    env,
    budgetMs,
    start,
    run,
    assertActive,
    dispose,
    signal: controller.signal,
    get failure() {
      return failure;
    },
    elapsed: () => Date.now() - started,
    // Time left before this session's own deadline; children derive their
    // limits from it instead of fixed values that could outlive the session.
    remaining: () => Math.max(0, started + budgetMs - Date.now()),
  };
}

/** A child limit bounded by the session's remaining time and a soft margin. */
export function boundedChildLimit(limitMs, remainingMs, marginMs = 8_000) {
  return Math.max(1, Math.min(limitMs, remainingMs - marginMs));
}

// Original library build tasks and their declared dependency closure only.
export const CMS_LIBRARY_WORKSPACES = Object.freeze([
  "@moya/contracts",
  "@moya/search",
  "@moya/api",
  "@moya/catalog-postgres",
  "@moya/image",
  "@moya/community-postgres",
]);
export function cmsLibraryBuildArgs() {
  return [
    "node_modules/turbo/bin/turbo",
    "run",
    "build",
    ...CMS_LIBRARY_WORKSPACES.map((name) => `--filter=${name}...`),
    "--cache-dir=.turbo/library-cache",
    "--no-daemon",
  ];
}

async function main() {
  process.env.MOYA_VERIFICATION_TOOLCHAIN = `${process.version}/${process.platform}/${process.arch}`;
  const budget = resolveCmsBudget(process.argv.slice(2));
  const database = syntheticDatabase(process.env.CMS_TEST_DATABASE_URL);
  const session = await createVerificationSession(
    database,
    "moya-cms-check-",
    budget.sessionBudgetMs,
  );
  console.log(
    `CMS profile ${budget.profile}: ceiling ${budget.ceilingMs}ms (${budget.ceilingSource}); session ${budget.sessionBudgetMs}ms`,
  );
  let operationError;
  try {
    for (const [name, cwd, args] of [
      ["library-build", ".", cmsLibraryBuildArgs()],
      ["migrations", "apps/admin", ["node_modules/payload/bin.js", "migrate"]],
      [
        "integration",
        "tests",
        // Vitest's per-test and hook limits are bounded by the session's
        // remaining time so no child limit can outlive the session.
        () => [
          "../node_modules/vitest/vitest.mjs",
          "run",
          "cms",
          "--no-file-parallelism",
          `--testTimeout=${boundedChildLimit(30_000, session.remaining())}`,
          `--hookTimeout=${boundedChildLimit(60_000, session.remaining())}`,
        ],
      ],
    ]) {
      if (name === "migrations") {
        await verifyRemoteSyntheticDatabase(session.env);
        await verifyLoopbackDisposableTarget(session.env);
        session.assertActive();
      }
      const result = await session.run(
        typeof args === "function" ? args() : args,
        path.join(verificationRoot, cwd),
        name,
      );
      console.log(`CMS ${name}: PASS`);
      for (const line of result.lines) console.log(line);
    }
  } catch (error) {
    operationError = error;
  } finally {
    await session.dispose();
  }
  if (session.failure) throw new Error(session.failure);
  if (operationError) throw operationError;
  console.log(
    `CMS elapsed: ${session.elapsed()}ms of ${budget.ceilingMs}ms (${budget.profile}); safe status summaries retained privately`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    const category =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "CMS_VERIFICATION_FAILED";
    console.log(JSON.stringify({ syntheticCMS: "FAIL", category }));
    process.exitCode = timeCategories.has(category) ? 124 : 1;
  });
