import process from "node:process";
import console from "node:console";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// A task-owned Umami for the analytics half of L1 (admin-mcp-completion-v1 section 21):
//
//   node tests/cms/admin-mcp-bench/umami-stack.mjs up --dir <private directory> --image <tag> --migrations <prisma migrations> [--events 1000000]
//   node tests/cms/admin-mcp-bench/umami-stack.mjs down
//
// The repository's reviewed image and its own schema, with Production's unit limits, on
// postgres:16.15-alpine, loopback only. Bootstrap and the synthetic seed run through the
// repository's tools and the real collector; the rest of the volume goes straight into
// the tables, because at 0.5 CPU a million events through the collector would take
// hours. A check posts one event through the collector and compares what it wrote with
// what this seed writes for the same event.

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const NAME = "moya-test-admin-mcp-completion-v1-umami";
const DATABASE = `${NAME}-pg`;
const NETWORK = `${NAME}-net`;
const POSTGRES_IMAGE = "postgres:16.15-alpine";
/** infra/production/systemd/yoyi-umami-standalone.service: CPUQuota and MemoryMax. */
const UNIT_LIMITS = ["--cpus", "0.5", "--memory", "768m"];
const BATCH_ROWS = 5_000;
const LOADERS = 4;
const STEP_MS = 120_000;
const HOSTNAME = "localhost";
/** The public default of Umami's first migration. Loopback only, removed with the stack. */
const IMAGE_ADMIN = { username: "admin", password: ["um", "ami"].join("") };

const docker = async (args, timeout = STEP_MS, input) => {
  const child = execute("docker", args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (input !== undefined) child.child.stdin.end(input);
  return (await child).stdout.trim();
};

/** A cold start restarts the container, and the Admin keeps this origin through it. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const stageTimer = () => {
  const started = Date.now();
  const stages = {};
  let mark = started;
  return {
    stages,
    done(name) {
      stages[name] = Date.now() - mark;
      console.log(`stack ${name}: ${stages[name]}ms`);
      mark = Date.now();
    },
  };
};

const waitFor = async (check, deadlineMs, code) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(code);
    await delay(500);
  }
};

const insertRows = (pool, table, columns, rows) => {
  const names = columns.map(([name]) => name).join(",");
  const params = columns
    .map(([, cast], at) => `$${at + 1}::${cast}[]`)
    .join(",");
  return pool.query(
    `INSERT INTO ${table} (${names}) SELECT * FROM unnest(${params})`,
    columns.map((_, at) => rows.map((row) => row[at])),
  );
};

/** At most LOADERS batches in flight, so the generator never runs far ahead of the server. */
const loader = (pool) => {
  const flying = new Set();
  const send = async (table, columns, rows) => {
    const sent = insertRows(pool, table, columns, rows).finally(() =>
      flying.delete(sent),
    );
    flying.add(sent);
    if (flying.size >= LOADERS) await Promise.race(flying);
  };
  return { send, finish: () => Promise.all(flying) };
};

const down = async () => {
  for (const name of [NAME, DATABASE])
    await docker(["rm", "-f", "-v", name]).catch(() => undefined);
  await docker(["network", "rm", NETWORK]).catch(() => undefined);
  const left = await docker([
    "ps",
    "-a",
    "--filter",
    `name=${NAME}`,
    "--format",
    "{{.Names}}",
  ]);
  console.log(
    JSON.stringify({ stack: "down", containersLeft: left ? left : "none" }),
  );
};

const applyMigrations = async (migrations) => {
  for (const name of (await readdir(migrations)).sort()) {
    if (!/^\d+_/u.test(name)) continue;
    const sql = await readFile(
      path.join(migrations, name, "migration.sql"),
      "utf8",
    );
    await docker(
      [
        "exec",
        "-i",
        DATABASE,
        "psql",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "umami_qa",
        "-d",
        "umami",
      ],
      STEP_MS,
      sql,
    );
  }
};

/** The columns a row fills and the shape of its data, so two rows can be compared. */
const shapeOf = async (pool, eventId) => {
  const event = (
    await pool.query("SELECT * FROM website_event WHERE event_id=$1", [eventId])
  ).rows[0];
  const session = (
    await pool.query("SELECT * FROM session WHERE session_id=$1", [
      event.session_id,
    ])
  ).rows[0];
  const data = (
    await pool.query(
      "SELECT data_key,data_type,string_value,number_value IS NOT NULL AS has_number,date_value IS NOT NULL AS has_date FROM event_data WHERE website_event_id=$1 ORDER BY data_key",
      [eventId],
    )
  ).rows;
  const filled = (row) =>
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([name]) => name)
      .sort();
  return {
    event: filled(event),
    session: filled(session),
    eventType: event.event_type,
    eventName: event.event_name,
    urlPath: event.url_path,
    data: data.map((row) => ({
      key: row.data_key,
      type: row.data_type,
      hasString: row.string_value !== null,
      hasNumber: row.has_number,
      hasDate: row.has_date,
    })),
  };
};

const up = async ({ directory, image, migrations, events }) => {
  const timer = stageTimer();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const clockNow = Date.now();
  const seedModule = await import(
    pathToFileURL(path.join(here, "analytics-seed.ts")).href
  );
  const clock = seedModule.seedClock(clockNow);
  const databasePassword = randomBytes(24).toString("hex");
  const appSecret = randomBytes(32).toString("hex");
  await docker(["network", "create", NETWORK]);
  await docker([
    "run",
    "-d",
    "--name",
    DATABASE,
    "--network",
    NETWORK,
    // Parallel index builds and VACUUM need more than Docker's 64 MiB of /dev/shm.
    "--shm-size=1g",
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_USER=umami_qa",
    "-e",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "-e",
    "POSTGRES_DB=umami",
    POSTGRES_IMAGE,
  ]);
  await waitFor(
    () =>
      docker(["exec", DATABASE, "pg_isready", "-U", "umami_qa", "-d", "umami"])
        // The image restarts its server once after initdb.
        .then(() => delay(1500))
        .then(() =>
          docker([
            "exec",
            DATABASE,
            "psql",
            "-U",
            "umami_qa",
            "-d",
            "umami",
            "-c",
            "SELECT 1",
          ]),
        )
        .then(() => true),
    60_000,
    "UMAMI_DATABASE_NOT_READY",
  );
  const versionNum = await docker([
    "exec",
    DATABASE,
    "psql",
    "-At",
    "-U",
    "umami_qa",
    "-d",
    "umami",
    "-c",
    "SHOW server_version_num",
  ]);
  if (versionNum !== "160015") throw new Error("UMAMI_POSTGRES_VERSION");
  await applyMigrations(migrations);
  timer.done("database");

  const websiteId = randomUUID();
  const umamiPort = await freePort();
  await docker([
    "run",
    "-d",
    "--name",
    NAME,
    "--network",
    NETWORK,
    ...UNIT_LIMITS,
    "-p",
    `127.0.0.1:${umamiPort}:3000`,
    "-e",
    "HOSTNAME=0.0.0.0",
    "-e",
    "PORT=3000",
    "-e",
    "DATABASE_TYPE=postgresql",
    "-e",
    `DATABASE_URL=postgresql://umami_qa:${databasePassword}@${DATABASE}:5432/umami`,
    "-e",
    `APP_SECRET=${appSecret}`,
    "-e",
    "CLIENT_IP_HEADER=x-moya-analytics-ip",
    "-e",
    "DISABLE_TELEMETRY=1",
    "-e",
    "DISABLE_UPDATES=1",
    image,
  ]);
  const origin = `http://127.0.0.1:${umamiPort}`;
  await waitFor(
    async () =>
      (
        await globalThis.fetch(
          `${origin}/admin/analytics-workspace/api/heartbeat`,
          { signal: globalThis.AbortSignal.timeout(2_000) },
        )
      ).ok,
    90_000,
    "UMAMI_NOT_READY",
  );
  timer.done("umami");

  const environment = {
    ANALYTICS_TASK_ENV: "synthetic",
    UMAMI_ORIGIN: origin,
    UMAMI_WEBSITE_ID: websiteId,
    UMAMI_WEBSITE_DOMAIN: HOSTNAME,
    UMAMI_BOOTSTRAP_USERNAME: IMAGE_ADMIN.username,
    UMAMI_BOOTSTRAP_PASSWORD: IMAGE_ADMIN.password,
    UMAMI_VIEWER_USERNAME: `synthetic-viewer-${randomBytes(4).toString("hex")}`,
    UMAMI_VIEWER_PASSWORD: randomBytes(24).toString("hex"),
    UMAMI_SYNTHETIC_RUN_ID: randomUUID(),
  };
  const { bootstrapUmami } = await import(
    pathToFileURL(path.join(root, "scripts/analytics/bootstrap-umami.mjs")).href
  );
  const { seedSyntheticUmami } = await import(
    pathToFileURL(path.join(root, "scripts/analytics/seed-synthetic-umami.mjs"))
      .href
  );
  const bootstrap = await bootstrapUmami(environment, "synthetic", {
    execute: true,
  });
  const seeded = await seedSyntheticUmami(environment, {
    execute: true,
    now: clockNow,
  });
  timer.done("repository-seed");

  const { closePostgresPool, createPostgresPool, parsePostgresConfig } =
    await import(
      pathToFileURL(path.join(root, "services/catalog-postgres/dist/index.js"))
        .href
    );
  const databaseOrigin = await docker(["port", DATABASE, "5432/tcp"]);
  const pool = createPostgresPool(
    parsePostgresConfig({
      DATABASE_URL: `postgresql://umami_qa:${databasePassword}@${databaseOrigin}/umami`,
    }),
  );
  try {
    const collected = (
      await pool.query(
        `SELECT e.session_id AS "sessionId", e.visit_id AS "visitId", e.created_at AS at, e.event_type AS "eventType", s.region, s.country
         FROM website_event e JOIN session s USING (session_id) ORDER BY e.created_at`,
      )
    ).rows.map((row) => ({ ...row, at: row.at.toISOString() }));
    if (collected.length !== seeded.acceptedEvents)
      throw new Error("UMAMI_COLLECTED_MISMATCH");

    const generator = seedModule.analyticsGenerator(clock, events);
    // The event the collector check posts: it stands outside the generated run.
    const probe = generator.eventAt(events - 1);
    const probeEvent = {
      ...probe,
      eventId: randomUUID(),
      at: clockNow - 175 * 86_400_000,
    };
    const accepted = await globalThis.fetch(
      `${origin}/admin/analytics-workspace/api/batch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Moya analytics relay",
        },
        body: JSON.stringify([
          seedModule.forwardedPayloadOf(probeEvent, websiteId, HOSTNAME),
        ]),
        signal: globalThis.AbortSignal.timeout(10_000),
      },
    );
    if (!accepted.ok) throw new Error("UMAMI_COLLECTOR_REFUSED");
    const realRow = (
      await pool.query(
        "SELECT event_id FROM website_event WHERE url_path=$1 AND created_at<now()-interval '100 days'",
        [seedModule.forwardedPathOf(probeEvent)],
      )
    ).rows[0];
    if (!realRow) throw new Error("UMAMI_COLLECTOR_WROTE_NOTHING");
    const real = await shapeOf(pool, realRow.event_id);
    const realSession = (
      await pool.query(
        "SELECT session_id FROM website_event WHERE event_id=$1",
        [realRow.event_id],
      )
    ).rows[0].session_id;
    await pool.query("DELETE FROM event_data WHERE website_event_id=$1", [
      realRow.event_id,
    ]);
    await pool.query("DELETE FROM website_event WHERE event_id=$1", [
      realRow.event_id,
    ]);
    await pool.query("DELETE FROM session WHERE session_id=$1", [realSession]);
    timer.done("collector-probe");

    // Only the indexes go, and the same definitions come back after the load.
    const tables = ["website_event", "event_data", "session"];
    const indexes = (
      await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname='public' AND tablename=ANY($1::text[]) AND indexname NOT LIKE '%_pkey'`,
        [tables],
      )
    ).rows;
    for (const { indexname } of indexes)
      await pool.query(`DROP INDEX "${indexname}"`);

    const sessions = new Set();
    const load = loader(pool);
    let eventRows = [];
    let dataRows = [];
    let sessionRows = [];
    let nextDataId = 0;
    for (let index = 0; index < events; index += 1) {
      const event = generator.eventAt(index);
      eventRows.push(seedModule.umamiEventRowOf(event, websiteId, HOSTNAME));
      if (!sessions.has(event.umamiSession)) {
        sessions.add(event.umamiSession);
        sessionRows.push(seedModule.umamiSessionRowOf(event, websiteId));
      }
      const rows = seedModule.umamiDataRowsOf(event, websiteId, nextDataId);
      nextDataId += rows.length;
      dataRows.push(...rows);
      if (eventRows.length >= BATCH_ROWS) {
        await load.send(
          "website_event",
          seedModule.UMAMI_EVENT_COLUMNS,
          eventRows,
        );
        eventRows = [];
      }
      if (dataRows.length >= BATCH_ROWS) {
        await load.send("event_data", seedModule.UMAMI_DATA_COLUMNS, dataRows);
        dataRows = [];
      }
      if (sessionRows.length >= BATCH_ROWS) {
        await load.send(
          "session",
          seedModule.UMAMI_SESSION_COLUMNS,
          sessionRows,
        );
        sessionRows = [];
      }
    }
    await load.send("website_event", seedModule.UMAMI_EVENT_COLUMNS, eventRows);
    await load.send("event_data", seedModule.UMAMI_DATA_COLUMNS, dataRows);
    await load.send("session", seedModule.UMAMI_SESSION_COLUMNS, sessionRows);
    await load.finish();
    timer.done("bulk-rows");

    await pool.query("SET maintenance_work_mem='512MB'");
    for (const { indexdef } of indexes) await pool.query(indexdef);
    await pool.query("VACUUM (ANALYZE)");
    timer.done("indexes-and-analyze");

    const written = await shapeOf(pool, generator.eventAt(events - 1).eventId);
    const differences = ["event", "session", "eventType", "eventName", "data"]
      .filter(
        (field) =>
          JSON.stringify(real[field]) !== JSON.stringify(written[field]),
      )
      .map((field) => ({
        field,
        collector: real[field],
        seed: written[field],
      }));
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM website_event) AS events,
           (SELECT count(*)::int FROM event_data) AS data,
           (SELECT count(*)::int FROM session) AS sessions,
           pg_size_pretty(pg_database_size(current_database())) AS size`,
      )
    ).rows[0];
    const manifest = {
      clock,
      events,
      websiteId,
      hostname: HOSTNAME,
      origin,
      viewerUsername: environment.UMAMI_VIEWER_USERNAME,
      viewerPassword: environment.UMAMI_VIEWER_PASSWORD,
      image,
      imageId: await docker(["inspect", image, "--format", "{{.Id}}"]),
      limits: UNIT_LIMITS,
      collected,
      counts,
      collectorParity: differences,
      bootstrap: { status: bootstrap.status, sharing: bootstrap.sharing },
      seed: { status: seeded.status, acceptedEvents: seeded.acceptedEvents },
      stages: timer.stages,
    };
    const file = path.join(directory, "umami-manifest.json");
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    console.log(
      JSON.stringify({
        stack: "up",
        manifest: file,
        counts,
        collectorParity: differences,
        stages: timer.stages,
      }),
    );
    if (differences.length > 0) process.exitCode = 1;
  } finally {
    await closePostgresPool(pool);
  }
};

const argument = (args, name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const main = async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "down") return down();
  if (mode !== "up") throw new Error("INVALID_STACK_ARGUMENTS");
  const directory = argument(args, "--dir");
  const image = argument(args, "--image");
  const migrations = argument(args, "--migrations");
  if (!directory || !image || !migrations)
    throw new Error("INVALID_STACK_ARGUMENTS");
  return up({
    directory: path.resolve(directory),
    image,
    migrations: path.resolve(migrations),
    events: Number(argument(args, "--events") ?? 1_000_000),
  });
};

main().catch((error) => {
  const category =
    error instanceof Error && /^[A-Z_0-9]+$/u.test(error.message)
      ? error.message
      : "UMAMI_STACK_FAILED";
  console.log(JSON.stringify({ stack: "FAIL", category }));
  // A driver or Docker message can carry a connection string: never printed.
  process.exitCode = 1;
});
