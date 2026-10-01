#!/usr/bin/env node
/** Fixed local synthetic resources; no arbitrary command or cleanup operation. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertDisposableTestTarget,
  disposableTestTargetProbeSql,
  markCurrentDatabaseDisposableSql,
} from "./disposable-test-target.mjs";
import {
  SCRIPT_ROOT,
  assertTaskId,
  defaultArtifacts,
  hash,
  privateJson,
  privateLocation,
  taskIdentity,
  writePrivateJson,
} from "./task-context.mjs";

const fail = (category) => {
  throw new Error(category);
};
const USER = "moya_test";
const ENV_KEYS = [
  "MOYA_TEST_DB_PORT",
  "MOYA_TEST_DB_NAME",
  "MOYA_TEST_DB_USER",
  "MOYA_TEST_DB_PASSWORD",
  "MOYA_TEST_TASK_ID",
  "MOYA_TEST_RESOURCE_ID",
  "TEST_DATABASE_URL",
  "CMS_TEST_DATABASE_URL",
  "MOYA_E2E_WEB_PORT",
  "MOYA_E2E_PUBLIC_API_PORT",
  "MOYA_E2E_ARTIFACT_ROOT",
];

function dockerEnvironment() {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
    fail("LOCAL_DOCKER_REQUIRED");
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("COMPOSE_") ||
      key.startsWith("MOYA_TEST_") ||
      ENV_KEYS.includes(key)
    )
      delete env[key];
  return env;
}

export function boundedDockerRunner(budgetMs = 120_000) {
  const deadline = performance.now() + Math.max(0, Math.min(120_000, budgetMs));
  const env = dockerEnvironment();
  return (args) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) fail("RESOURCE_DEADLINE");
    const result = spawnSync("docker", args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remaining,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) fail("TASK_DOCKER_FAILED");
    return result.stdout;
  };
}

export function availablePort() {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("PORT_ALLOCATION_FAILED")));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) =>
        error ? reject(new Error("PORT_ALLOCATION_FAILED")) : accept(port),
      );
    });
  });
}

function composeArgs(root, manifest) {
  return [
    "compose",
    "--project-name",
    manifest.project,
    "--file",
    join(root, "compose.postgres.yml"),
    "--env-file",
    manifest.envFile,
  ];
}

function parseEnv(text) {
  const result = {};
  for (const line of text.trim().split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (
      !match ||
      !ENV_KEYS.includes(match[1]) ||
      Object.hasOwn(result, match[1])
    )
      fail("RESOURCE_CONFIG_INVALID");
    try {
      result[match[1]] = match[2].startsWith('"')
        ? JSON.parse(match[2])
        : match[2];
    } catch {
      fail("RESOURCE_CONFIG_INVALID");
    }
  }
  if (Object.keys(result).length !== ENV_KEYS.length)
    fail("RESOURCE_CONFIG_INVALID");
  return result;
}

export function ownedManifest(
  request,
  root = SCRIPT_ROOT,
  identity = taskIdentity(request.task, root),
) {
  const path = privateLocation(
    request.manifest ??
      join(defaultArtifacts(request.task), "resources/resources.json"),
    root,
  );
  const manifest = privateJson(path, root);
  assertTaskId(manifest.task);
  if (
    manifest.version !== 1 ||
    manifest.task !== request.task ||
    manifest.worktree !== identity.worktree ||
    manifest.branch !== identity.branch ||
    !/^[a-f0-9]{12}$/u.test(manifest.resourceId ?? "")
  )
    fail("RESOURCE_IDENTITY_MISMATCH");
  const suffix = `${request.task.replaceAll("-", "_").slice(0, 30)}_${manifest.resourceId}`;
  if (
    manifest.project !== `moya-test-${request.task}-${manifest.resourceId}` ||
    manifest.database !== `moya_test_${suffix}` ||
    manifest.cmsDatabase !== `moya_test_cms_${suffix}` ||
    manifest.envFile !== join(dirname(path), "resources.env") ||
    manifest.outputRoot !== join(dirname(path), "outputs")
  )
    fail("UNSAFE_RESOURCE_TARGET");
  const ports = Object.values(manifest.ports ?? {});
  if (
    ports.length !== 3 ||
    new Set(ports).size !== 3 ||
    ports.some(
      (port) =>
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        [3100, 3101, 54329, 54330].includes(port),
    )
  )
    fail("UNSAFE_RESOURCE_PORTS");
  const config = readFileSync(privateLocation(manifest.envFile, root), "utf8");
  if (hash(config) !== manifest.envSha256) fail("RESOURCE_CONFIG_CHANGED");
  const env = parseEnv(config);
  if (
    env.MOYA_TEST_DB_NAME !== manifest.database ||
    env.MOYA_TEST_DB_USER !== USER ||
    env.MOYA_TEST_TASK_ID !== manifest.task ||
    env.MOYA_TEST_RESOURCE_ID !== manifest.resourceId ||
    env.MOYA_TEST_DB_PORT !== String(manifest.ports.database) ||
    env.MOYA_E2E_WEB_PORT !== String(manifest.ports.web) ||
    env.MOYA_E2E_PUBLIC_API_PORT !== String(manifest.ports.publicApi) ||
    env.MOYA_E2E_ARTIFACT_ROOT !== manifest.outputRoot ||
    !/^[a-f0-9]{64}$/u.test(env.MOYA_TEST_DB_PASSWORD)
  )
    fail("RESOURCE_CONFIG_INVALID");
  const url = (database) =>
    `postgresql://${USER}:${env.MOYA_TEST_DB_PASSWORD}@127.0.0.1:${manifest.ports.database}/${database}`;
  if (
    env.TEST_DATABASE_URL !== url(manifest.database) ||
    env.CMS_TEST_DATABASE_URL !== url(manifest.cmsDatabase)
  )
    fail("RESOURCE_CONFIG_INVALID");
  return { path, manifest, env };
}

/** Controlled callers may read this approved private config; never print it. */
export function resourceEnvironment(request, options = {}) {
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? taskIdentity(request.task, root);
  return ownedManifest(request, root, identity).env;
}

/** verify-task calls this once; returned credentials remain in the process. */
export function loadResourceEnvironment(manifestPath, options = {}) {
  const root = options.root ?? SCRIPT_ROOT;
  const recorded = privateJson(manifestPath, root);
  const request = {
    task: options.task ?? recorded.task,
    manifest: manifestPath,
  };
  inspectResources(request, options);
  return resourceEnvironment(request, options);
}

function localDocker(run) {
  let endpoint;
  try {
    endpoint = JSON.parse(
      run([
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]),
    );
  } catch (error) {
    if (/^[A-Z_]+$/u.test(error.message)) throw error;
    fail("LOCAL_DOCKER_REQUIRED");
  }
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix://"))
    fail("LOCAL_DOCKER_REQUIRED");
}

function ownedContainer(root, manifest, run, required = true) {
  const ids = run([
    ...composeArgs(root, manifest),
    "ps",
    "--all",
    "--quiet",
    "postgres",
  ])
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length === 0 && !required) return false;
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(ids[0]))
    fail("RESOURCE_CONTAINER_MISSING");
  let labels;
  try {
    labels = JSON.parse(
      run(["inspect", "--format", "{{json .Config.Labels}}", ids[0]]),
    );
  } catch (error) {
    if (/^[A-Z_]+$/u.test(error.message)) throw error;
    fail("RESOURCE_LABELS_INVALID");
  }
  if (
    labels?.["com.docker.compose.project"] !== manifest.project ||
    labels?.["com.docker.compose.service"] !== "postgres" ||
    labels?.["io.moya.task-id"] !== manifest.task ||
    labels?.["io.moya.resource-id"] !== manifest.resourceId
  )
    fail("RESOURCE_CONTAINER_OWNERSHIP_MISMATCH");
  if (required) {
    let bindings;
    try {
      bindings = JSON.parse(
        run(["inspect", "--format", "{{json .NetworkSettings.Ports}}", ids[0]]),
      );
    } catch (error) {
      if (/^[A-Z_]+$/u.test(error.message)) throw error;
      fail("RESOURCE_PORT_BINDING_MISMATCH");
    }
    const database = bindings?.["5432/tcp"];
    if (
      !Array.isArray(database) ||
      database.length !== 1 ||
      database[0].HostIp !== "127.0.0.1" ||
      database[0].HostPort !== String(manifest.ports.database)
    )
      fail("RESOURCE_PORT_BINDING_MISMATCH");
  }
  return true;
}

function psql(root, manifest, run, database, sql) {
  return run([
    ...composeArgs(root, manifest),
    "exec",
    "-T",
    "postgres",
    "psql",
    "--no-psqlrc",
    "--username",
    USER,
    "--dbname",
    database,
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  ]).trim();
}

function probe(root, manifest, run, database) {
  let row;
  try {
    row = JSON.parse(
      psql(
        root,
        manifest,
        run,
        database,
        `SELECT row_to_json(target) FROM (${disposableTestTargetProbeSql}) AS target`,
      ),
    );
  } catch (error) {
    if (/^[A-Z_]+$/u.test(error.message)) throw error;
    fail("DISPOSABLE_TARGET_PROBE_FAILED");
  }
  assertDisposableTestTarget([row], database);
}

function metadata(path, manifest) {
  return {
    result: "PASS",
    task: manifest.task,
    manifest: path,
    envFile: manifest.envFile,
    project: manifest.project,
    databases: [manifest.database, manifest.cmsDatabase],
    ports: manifest.ports,
    outputRoot: manifest.outputRoot,
  };
}

export function inspectResources(request, options = {}) {
  assertTaskId(request.task);
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? taskIdentity(request.task, root);
  const run = options.run ?? boundedDockerRunner();
  const { path, manifest } = ownedManifest(request, root, identity);
  localDocker(run);
  ownedContainer(root, manifest, run);
  probe(root, manifest, run, manifest.database);
  probe(root, manifest, run, manifest.cmsDatabase);
  return metadata(path, manifest);
}

export async function prepareResources(request, options = {}) {
  assertTaskId(request.task);
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? taskIdentity(request.task, root);
  const run = options.run ?? boundedDockerRunner();
  const path = privateLocation(
    request.manifest ??
      join(defaultArtifacts(request.task), "resources/resources.json"),
    root,
    true,
  );
  localDocker(run);
  let manifest;
  if (existsSync(path))
    manifest = ownedManifest(request, root, identity).manifest;
  else {
    const resourceId = randomBytes(6).toString("hex");
    const suffix = `${request.task.replaceAll("-", "_").slice(0, 30)}_${resourceId}`;
    const allocate = options.allocatePort ?? availablePort;
    const ports = {};
    for (const key of ["database", "web", "publicApi"]) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const port = await allocate();
        if (
          Number.isInteger(port) &&
          port >= 1024 &&
          port <= 65535 &&
          ![3100, 3101, 54329, 54330, ...Object.values(ports)].includes(port)
        ) {
          ports[key] = port;
          break;
        }
      }
      if (!ports[key]) fail("PORT_ALLOCATION_FAILED");
    }
    manifest = {
      version: 1,
      ...identity,
      resourceId,
      project: `moya-test-${request.task}-${resourceId}`,
      database: `moya_test_${suffix}`,
      cmsDatabase: `moya_test_cms_${suffix}`,
      ports,
      envFile: join(dirname(path), "resources.env"),
      outputRoot: join(dirname(path), "outputs"),
    };
    const password = randomBytes(32).toString("hex");
    const url = (database) =>
      `postgresql://${USER}:${password}@127.0.0.1:${ports.database}/${database}`;
    const env = {
      MOYA_TEST_DB_PORT: String(ports.database),
      MOYA_TEST_DB_NAME: manifest.database,
      MOYA_TEST_DB_USER: USER,
      MOYA_TEST_DB_PASSWORD: password,
      MOYA_TEST_TASK_ID: request.task,
      MOYA_TEST_RESOURCE_ID: resourceId,
      TEST_DATABASE_URL: url(manifest.database),
      CMS_TEST_DATABASE_URL: url(manifest.cmsDatabase),
      MOYA_E2E_WEB_PORT: String(ports.web),
      MOYA_E2E_PUBLIC_API_PORT: String(ports.publicApi),
      MOYA_E2E_ARTIFACT_ROOT: manifest.outputRoot,
    };
    const text = `${Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")}\n`;
    writeFileSync(privateLocation(manifest.envFile, root, true), text, {
      flag: "wx",
      mode: 0o600,
    });
    mkdirSync(manifest.outputRoot, { mode: 0o700 });
    manifest.envSha256 = hash(text);
    writePrivateJson(path, manifest, root);
  }
  ownedContainer(root, manifest, run, false);
  run([
    ...composeArgs(root, manifest),
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "60",
    "postgres",
  ]);
  ownedContainer(root, manifest, run);
  probe(root, manifest, run, manifest.database);
  const exists = psql(
    root,
    manifest,
    run,
    manifest.database,
    `SELECT 1 FROM pg_database WHERE datname = '${manifest.cmsDatabase}'`,
  );
  if (exists !== "1") {
    psql(
      root,
      manifest,
      run,
      manifest.database,
      `CREATE DATABASE "${manifest.cmsDatabase}"`,
    );
    psql(
      root,
      manifest,
      run,
      manifest.cmsDatabase,
      markCurrentDatabaseDisposableSql,
    );
  }
  probe(root, manifest, run, manifest.cmsDatabase);
  return metadata(path, manifest);
}

export function parseResourceArguments(argv) {
  const [operation, ...rest] = argv;
  if (!["prepare", "inspect"].includes(operation)) fail("USAGE");
  const request = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    const field = { "--task": "task", "--manifest": "manifest" }[key];
    if (
      !field ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(request, field)
    )
      fail("USAGE");
    request[field] = value;
  }
  assertTaskId(request.task);
  return { operation, request };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { operation, request } = parseResourceArguments(
      process.argv.slice(2),
    );
    console.log(
      JSON.stringify(
        operation === "prepare"
          ? await prepareResources(request)
          : inspectResources(request),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "REFUSED",
        category: /^[A-Z_]+$/u.test(error.message)
          ? error.message
          : "TASK_RESOURCES_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
