import { randomBytes } from "node:crypto";
import process from "node:process";
import { spawn, execFile } from "node:child_process";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  atomicPrivateJSON,
  privateJSON,
  validatePublicationPackage,
  developmentOrigin,
} from "./adapter.mjs";

const { fetch, AbortSignal } = globalThis;

const execute = promisify(execFile);
const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const fail = (code) => {
  throw new Error(code);
};
const cleanEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );

async function assertPrivateDirectory(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077
  )
    fail("PRIVATE_DEVELOPMENT_DIRECTORY_REQUIRED");
}

async function assertNoAmbientConfiguration(repoRoot) {
  for (const directory of [repoRoot, path.join(repoRoot, "apps/admin")]) {
    for (const name of [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
    ]) {
      try {
        await access(path.join(directory, name));
        fail("AMBIENT_RUNTIME_CONFIGURATION_REFUSED");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

export async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function birth(pid) {
  const result = await execute(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { timeout: 1000, maxBuffer: 64 * 1024 },
  );
  return result.stdout.trim();
}

async function currentBirth(pid) {
  try {
    return await birth(pid);
  } catch (error) {
    if (
      error.code === 1 &&
      error.stdout?.trim() === "" &&
      error.stderr?.trim() === ""
    )
      return null;
    fail("OWNED_PROCESS_IDENTITY_UNREADABLE");
  }
}

async function command(
  file,
  args,
  { deadline, cwd, env = cleanEnvironment() },
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail("TIME_BUDGET_EXCEEDED");
  try {
    return await execute(file, args, {
      cwd,
      env,
      timeout: remaining,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    fail("DEVELOPMENT_SETUP_CHILD_FAILED");
  }
}

/** The only Docker component is a new task-owned PostgreSQL database. */
export async function setupDevelopment({
  repoRoot,
  packageFile,
  stateDirectory,
  dockerImage,
  dockerBin = "/Users/jia/.local/bin/docker",
  budgetMs = 300_000,
}) {
  const deadline = Date.now() + budgetMs;
  const stateFile = path.join(stateDirectory, "development-processes.json");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(stateDirectory);
  try {
    await access(stateFile);
    fail("DEVELOPMENT_ALREADY_CONFIGURED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const input = await privateJSON(packageFile);
  if (input.synthetic !== true) fail("REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED");
  await validatePublicationPackage(input, {
    repoRoot,
    packageDirectory: path.dirname(packageFile),
  });
  // Native Next/Payload load these files themselves. Refuse ambient local
  // configuration before starting either tool; do not read or alter it.
  await assertNoAmbientConfiguration(repoRoot);
  if (
    typeof dockerImage !== "string" ||
    !/^(postgres:[A-Za-z0-9_.-]+|sha256:[a-f0-9]{64})$/u.test(dockerImage)
  )
    fail("EXISTING_POSTGRES_IMAGE_REQUIRED");
  // Inspection and --pull=never make the no-download boundary concrete.
  await command(
    dockerBin,
    ["image", "inspect", dockerImage, "--format", "{{.Id}}"],
    { deadline },
  );
  const postgresPort = await unusedLoopbackPort();
  const adminPort = await unusedLoopbackPort();
  const taskId = randomBytes(8).toString("hex");
  const containerName = `artvenn-curation-pg-${taskId}`;
  const volumeName = `${containerName}-data`;
  const databaseName = `artvenn_curation_synthetic_${taskId}`;
  const databaseURL = `postgresql://artvenn_curation_setup@127.0.0.1:${postgresPort}/${databaseName}`;
  await mkdir(path.join(stateDirectory, "media"), { mode: 0o700 });
  await command(
    dockerBin,
    [
      "volume",
      "create",
      "--label",
      `artvenn.curation.task=${taskId}`,
      "--label",
      "artvenn.environment=development",
      volumeName,
    ],
    { deadline },
  );
  const started = await command(
    dockerBin,
    [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--label",
      `artvenn.curation.task=${taskId}`,
      "--label",
      "artvenn.environment=development",
      "--publish",
      `127.0.0.1:${postgresPort}:5432`,
      "--mount",
      `type=volume,source=${volumeName},target=/var/lib/postgresql`,
      "--env",
      "PGDATA=/var/lib/postgresql/data",
      "--env",
      "POSTGRES_USER=artvenn_curation_setup",
      "--env",
      `POSTGRES_DB=${databaseName}`,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      dockerImage,
    ],
    { deadline },
  );
  const containerId = started.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) fail("OWNED_CONTAINER_ID_INVALID");
  const owned = { dockerBin, containerName, containerId, volumeName, taskId };
  await atomicPrivateJSON(path.join(stateDirectory, "owned-database.json"), {
    version: 1,
    instance: "development",
    taskOwned: true,
    ...owned,
  });
  let next;
  let session;
  try {
    let ready = false;
    while (Date.now() < deadline - 15_000) {
      try {
        await command(
          dockerBin,
          [
            "exec",
            containerId,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            "artvenn_curation_setup",
            "-d",
            databaseName,
          ],
          { deadline: Math.min(deadline, Date.now() + 1500) },
        );
        ready = true;
        break;
      } catch {
        /* Startup may still be in progress; retry only within this one deadline. */
      }
      await delay(200);
    }
    if (!ready) fail("POSTGRES_READINESS_TIMEOUT");
    const { createPostgresPool, parsePostgresConfig } = await import(
      pathToFileURL(
        path.join(repoRoot, "services/catalog-postgres/dist/index.js"),
      ).href
    );
    const pool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: databaseURL }),
    );
    try {
      await pool.query(
        await readFile(
          path.join(repoRoot, "infra/test/disposable-test-target.sql"),
          "utf8",
        ),
      );
    } finally {
      await pool.end();
    }
    const guards = await import(
      pathToFileURL(path.join(repoRoot, "scripts/editorial/verify-cms.mjs"))
        .href
    );
    session = await guards.createVerificationSession(
      databaseURL,
      "artvenn-curation-migrations-",
      Math.max(1, deadline - Date.now()),
    );
    const env = {
      ...cleanEnvironment(),
      ...Object.fromEntries(
        Object.entries(session.env).filter(
          ([key]) => key.startsWith("CMS_") || key === "MOYA_CONTENT_SOURCE",
        ),
      ),
      NODE_ENV: "development",
      CMS_MEDIA_DIR: path.join(stateDirectory, "media"),
      CMS_PUBLIC_URL: `http://127.0.0.1:${adminPort}`,
      CMS_PREVIEW_WEB_URL: `http://127.0.0.1:${adminPort}`,
      ARTVENN_CURATION_BOOTSTRAP: "fresh-owned-synthetic",
      ARTVENN_CURATION_REPO_ROOT: repoRoot,
      ARTVENN_CURATION_PACKAGE_FILE: packageFile,
      ARTVENN_CURATION_CONFIG_FILE: path.join(
        stateDirectory,
        "cms-config.json",
      ),
    };
    await guards.verifyLoopbackDisposableTarget(env);
    await session.run(
      ["node_modules/payload/bin.js", "migrate"],
      path.join(repoRoot, "apps/admin"),
      "curation-native-migrations",
      env,
    );
    await session.run(
      [
        "node_modules/payload/bin.js",
        "run",
        path.join(ownDirectory, "bootstrap-development.mjs"),
      ],
      path.join(repoRoot, "apps/admin"),
      "curation-native-bootstrap",
      env,
    );
    await atomicPrivateJSON(
      path.join(stateDirectory, "runtime-environment.json"),
      env,
    );
    await session.dispose();
    session = null;
    next = spawn(
      process.execPath,
      [
        path.join(repoRoot, "apps/admin/node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(adminPort),
      ],
      {
        cwd: path.join(repoRoot, "apps/admin"),
        detached: true,
        stdio: "ignore",
        env,
      },
    );
    next.on("error", () => {});
    if (!next.pid) fail("CMS_START_FAILED");
    const baseURL = `http://127.0.0.1:${adminPort}`;
    ready = false;
    while (Date.now() < deadline - 1000) {
      try {
        const response = await fetch(`${baseURL}/api/editorial/read-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: 1 }),
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.min(5000, Math.max(1, deadline - Date.now())),
          ),
        });
        if ([401, 403].includes(response.status)) {
          const value = await response.json();
          if (value.ok === false) {
            ready = true;
            break;
          }
        }
      } catch {
        /* Wait only for the owned native CMS within this setup deadline. */
      }
      if (next.exitCode !== null) fail("CMS_START_FAILED");
      await delay(300);
    }
    if (!ready) fail("CMS_READINESS_TIMEOUT");
    const state = {
      version: 1,
      instance: "development",
      taskOwned: true,
      syntheticOnly: true,
      repoRoot: path.resolve(repoRoot),
      databaseName,
      database: owned,
      baseURL,
      admin: { pid: next.pid, birth: await birth(next.pid) },
      configFile: path.join(stateDirectory, "cms-config.json"),
      runtimeEnvironmentFile: path.join(
        stateDirectory,
        "runtime-environment.json",
      ),
      lifecycle: "running",
    };
    await atomicPrivateJSON(stateFile, state);
    next.unref();
    return {
      localDevelopment: "READY",
      baseURL,
      stateFile,
      configFile: state.configFile,
      databaseName,
      containerName,
      volumeName,
      ownerApproval: "NOT_RUN",
      productionPublication: "NOT_RUN",
    };
  } catch (error) {
    await session?.dispose().catch(() => {});
    if (next?.pid) {
      try {
        process.kill(-next.pid, "SIGTERM");
      } catch {
        /* The owned child may already have exited. */
      }
    }
    await stopOwnedDatabase(owned).catch(() => {});
    throw error;
  }
}

export async function stopOwnedDatabase(owned) {
  if (
    !owned ||
    !/^[a-f0-9]{64}$/u.test(owned.containerId) ||
    !/^[a-f0-9]{16}$/u.test(owned.taskId)
  )
    fail("OWNED_DATABASE_IDENTITY_INVALID");
  const inspected = await command(
    owned.dockerBin,
    ["inspect", owned.containerId, "--format", "{{json .Config.Labels}}"],
    { deadline: Date.now() + 10_000 },
  );
  let labels;
  try {
    labels = JSON.parse(inspected.stdout);
  } catch {
    fail("OWNED_DATABASE_IDENTITY_INVALID");
  }
  if (
    labels["artvenn.curation.task"] !== owned.taskId ||
    labels["artvenn.environment"] !== "development"
  )
    fail("OWNED_DATABASE_IDENTITY_CHANGED");
  await command(owned.dockerBin, ["stop", "--time", "5", owned.containerId], {
    deadline: Date.now() + 10_000,
  });
}

const inspectTemplate =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"Mounts":{{json .Mounts}},"PortBindings":{{json .HostConfig.PortBindings}},"Running":{{json .State.Running}}}';

function lifecycleHooks(overrides = {}) {
  return {
    command,
    birth: currentBirth,
    delay,
    kill: (pid, signal) => process.kill(pid, signal),
    fetch,
    portAvailable: (port) =>
      new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(Number(port), "127.0.0.1", () =>
          probe.close(() => resolve(true)),
        );
      }),
    startCMS: (repoRoot, env, port) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, "apps/admin/node_modules/next/dist/bin/next"),
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: path.join(repoRoot, "apps/admin"),
          detached: true,
          stdio: "ignore",
          env,
        },
      );
      child.on("error", () => {});
      return child;
    },
    guards: (repoRoot) =>
      import(
        pathToFileURL(path.join(repoRoot, "scripts/editorial/verify-cms.mjs"))
          .href
      ),
    ...overrides,
  };
}

/** Protected lifecycle metadata is bound to one exact local target. */
export function validateLifecycleState(
  state,
  storedEnvironment,
  config,
  stateDirectory,
) {
  if (
    state.version !== 1 ||
    state.instance !== "development" ||
    state.taskOwned !== true ||
    state.syntheticOnly !== true
  )
    fail("OWNED_DEVELOPMENT_REQUIRED");
  const owned = state.database;
  if (
    !owned ||
    !/^[a-f0-9]{64}$/u.test(owned.containerId) ||
    !/^[a-f0-9]{16}$/u.test(owned.taskId) ||
    owned.containerName !== `artvenn-curation-pg-${owned.taskId}` ||
    owned.volumeName !== `${owned.containerName}-data` ||
    typeof owned.dockerBin !== "string" ||
    !path.isAbsolute(owned.dockerBin)
  )
    fail("OWNED_DATABASE_IDENTITY_INVALID");
  if (
    state.configFile !== path.join(stateDirectory, "cms-config.json") ||
    state.runtimeEnvironmentFile !==
      path.join(stateDirectory, "runtime-environment.json")
  )
    fail("OWNED_CONFIGURATION_PATH_CHANGED");
  const repoRoot =
    state.repoRoot ?? storedEnvironment.ARTVENN_CURATION_REPO_ROOT;
  if (
    typeof repoRoot !== "string" ||
    !path.isAbsolute(repoRoot) ||
    (storedEnvironment.ARTVENN_CURATION_REPO_ROOT !== undefined &&
      path.resolve(storedEnvironment.ARTVENN_CURATION_REPO_ROOT) !==
        path.resolve(repoRoot))
  )
    fail("OWNED_WORKTREE_CHANGED");
  if (
    !Number.isSafeInteger(state.admin?.pid) ||
    state.admin.pid < 1 ||
    typeof state.admin.birth !== "string" ||
    !state.admin.birth
  )
    fail("OWNED_PROCESS_IDENTITY_INVALID");
  if (
    developmentOrigin(config) !== state.baseURL ||
    config.databaseName !== state.databaseName
  )
    fail("OWNED_CONFIGURATION_TARGET_CHANGED");
  let database;
  try {
    database = new URL(storedEnvironment.CMS_DATABASE_URL);
  } catch {
    fail("OWNED_DATABASE_TARGET_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname !== "127.0.0.1" ||
    !database.port ||
    database.username !== "artvenn_curation_setup" ||
    database.password ||
    database.search ||
    database.hash ||
    database.pathname !== `/${state.databaseName}` ||
    state.databaseName !== `artvenn_curation_synthetic_${owned.taskId}`
  )
    fail("OWNED_DATABASE_TARGET_INVALID");
  if (
    storedEnvironment.NODE_ENV !== "development" ||
    storedEnvironment.CMS_ENVIRONMENT !== "synthetic" ||
    storedEnvironment.CMS_STORAGE_MODE !== "local" ||
    storedEnvironment.MOYA_CONTENT_SOURCE !== "payload" ||
    storedEnvironment.CMS_DATABASE_URL !==
      storedEnvironment.CMS_TEST_DATABASE_URL ||
    storedEnvironment.CMS_PUBLIC_URL !== state.baseURL ||
    storedEnvironment.CMS_PREVIEW_WEB_URL !== state.baseURL ||
    storedEnvironment.CMS_MEDIA_DIR !== path.join(stateDirectory, "media") ||
    typeof storedEnvironment.CMS_SECRET !== "string" ||
    storedEnvironment.CMS_SECRET.length < 32 ||
    Object.keys(storedEnvironment).some(
      (key) =>
        key.startsWith("CMS_COS_") ||
        key === "CMS_TEST_REMOTE_TARGET_JSON" ||
        key === "NODE_TLS_REJECT_UNAUTHORIZED",
    )
  )
    fail("OWNED_RUNTIME_CONFIGURATION_INVALID");
  const env = { ...cleanEnvironment() };
  for (const key of [
    "CMS_SECRET",
    "CMS_DATABASE_URL",
    "CMS_TEST_DATABASE_URL",
    "CMS_ENVIRONMENT",
    "CMS_STORAGE_MODE",
    "CMS_MEDIA_DIR",
    "CMS_PUBLIC_URL",
    "CMS_PREVIEW_WEB_URL",
    "MOYA_CONTENT_SOURCE",
  ])
    env[key] = storedEnvironment[key];
  env.NODE_ENV = "development";
  // Restart never carries bootstrap flags, another service's keys, or a
  // Production composition flag. Existing automation identity/key is retained.
  return {
    repoRoot: path.resolve(repoRoot),
    env,
    databasePort: database.port,
    adminPort: new URL(state.baseURL).port,
  };
}

async function inspectOwnedLifecycleDatabase(
  state,
  databasePort,
  hooks,
  deadline,
) {
  const owned = state.database;
  const result = await hooks.command(
    owned.dockerBin,
    ["inspect", owned.containerId, "--format", inspectTemplate],
    { deadline },
  );
  let inspected;
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    fail("OWNED_DATABASE_IDENTITY_INVALID");
  }
  if (
    inspected.Id !== owned.containerId ||
    inspected.Name !== `/${owned.containerName}` ||
    inspected.Labels?.["artvenn.curation.task"] !== owned.taskId ||
    inspected.Labels?.["artvenn.environment"] !== "development"
  )
    fail("OWNED_DATABASE_IDENTITY_CHANGED");
  if (
    !Array.isArray(inspected.Mounts) ||
    !inspected.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === owned.volumeName &&
        mount.Destination === "/var/lib/postgresql",
    )
  )
    fail("OWNED_DATABASE_VOLUME_CHANGED");
  const ports = inspected.PortBindings?.["5432/tcp"];
  if (
    Object.keys(inspected.PortBindings ?? {}).length !== 1 ||
    !Array.isArray(ports) ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== databasePort
  )
    fail("OWNED_DATABASE_PORT_CHANGED");
  const volumeResult = await hooks.command(
    owned.dockerBin,
    ["volume", "inspect", owned.volumeName, "--format", "{{json .Labels}}"],
    { deadline },
  );
  let labels;
  try {
    labels = JSON.parse(volumeResult.stdout);
  } catch {
    fail("OWNED_DATABASE_VOLUME_CHANGED");
  }
  if (
    labels?.["artvenn.curation.task"] !== owned.taskId ||
    labels?.["artvenn.environment"] !== "development"
  )
    fail("OWNED_DATABASE_VOLUME_CHANGED");
  return inspected;
}

async function waitForCMSExit(owned, hooks, deadline) {
  while (Date.now() < deadline) {
    const identity = await hooks.birth(owned.pid);
    if (identity === null) return;
    if (identity !== owned.birth) fail("OWNED_PROCESS_IDENTITY_CHANGED");
    await hooks.delay(100);
  }
  fail("OWNED_CMS_STOP_TIMEOUT");
}

/** Resume the same retained DB and scoped key; no migration or bootstrap. */
export async function restartDevelopment({
  stateDirectory,
  budgetMs = 180_000,
  hooks: overrides = {},
}) {
  const hooks = lifecycleHooks(overrides);
  const deadline = Date.now() + budgetMs;
  await assertPrivateDirectory(stateDirectory);
  const stateFile = path.join(stateDirectory, "development-processes.json");
  const state = await privateJSON(stateFile);
  const storedEnvironment = await privateJSON(
    path.join(stateDirectory, "runtime-environment.json"),
  );
  const config = await privateJSON(
    path.join(stateDirectory, "cms-config.json"),
  );
  const target = validateLifecycleState(
    state,
    storedEnvironment,
    config,
    stateDirectory,
  );
  await assertNoAmbientConfiguration(target.repoRoot);
  const priorBirth = await hooks.birth(state.admin.pid);
  if (priorBirth !== null && priorBirth !== state.admin.birth)
    fail("OWNED_PROCESS_IDENTITY_CHANGED");
  const priorDatabase = await inspectOwnedLifecycleDatabase(
    state,
    target.databasePort,
    hooks,
    deadline,
  );
  const owned = state.database;
  let child;
  let databaseStarted = false;
  try {
    await hooks.command(owned.dockerBin, ["start", owned.containerId], {
      deadline,
    });
    databaseStarted = true;
    let ready = false;
    while (Date.now() < deadline - 1000) {
      try {
        await hooks.command(
          owned.dockerBin,
          [
            "exec",
            owned.containerId,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            "artvenn_curation_setup",
            "-d",
            state.databaseName,
          ],
          { deadline: Math.min(deadline, Date.now() + 1500) },
        );
        ready = true;
        break;
      } catch {
        /* Poll only this retained owned container within the one deadline. */
      }
      await hooks.delay(200);
    }
    if (!ready) fail("POSTGRES_READINESS_TIMEOUT");
    const guards = await hooks.guards(target.repoRoot);
    guards.syntheticDatabase(target.env.CMS_DATABASE_URL, target.env);
    await guards.verifyLoopbackDisposableTarget(target.env);
    if (priorBirth !== null) {
      // The identity is rechecked immediately before touching the process.
      if ((await hooks.birth(state.admin.pid)) !== state.admin.birth)
        fail("OWNED_PROCESS_IDENTITY_CHANGED");
      hooks.kill(-state.admin.pid, "SIGTERM");
      await waitForCMSExit(
        state.admin,
        hooks,
        Math.min(deadline, Date.now() + 10_000),
      );
    }
    const portDeadline = Math.min(deadline, Date.now() + 10_000);
    while (!(await hooks.portAvailable(target.adminPort))) {
      if (Date.now() >= portDeadline) fail("OWNED_CMS_PORT_BUSY");
      await hooks.delay(100);
    }
    child = hooks.startCMS(target.repoRoot, target.env, target.adminPort);
    if (!child?.pid) fail("CMS_START_FAILED");
    ready = false;
    while (Date.now() < deadline - 1000) {
      try {
        const response = await hooks.fetch(
          `${state.baseURL}/api/editorial/read-draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: 1 }),
            redirect: "error",
            signal: AbortSignal.timeout(
              Math.min(5000, Math.max(1, deadline - Date.now())),
            ),
          },
        );
        if (
          [401, 403].includes(response.status) &&
          (await response.json()).ok === false
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Await only the restarted owned CMS, never another URL. */
      }
      if (child.exitCode !== null) fail("CMS_START_FAILED");
      await hooks.delay(300);
    }
    if (!ready) fail("CMS_READINESS_TIMEOUT");
    const actualBirth = await hooks.birth(child.pid);
    if (typeof actualBirth !== "string" || !actualBirth)
      fail("OWNED_PROCESS_IDENTITY_UNREADABLE");
    state.admin = { pid: child.pid, birth: actualBirth };
    state.repoRoot = target.repoRoot;
    state.lifecycle = "running";
    state.restartedAt = new Date().toISOString();
    delete state.stoppedAt;
    await atomicPrivateJSON(stateFile, state);
    child.unref();
    return {
      localDevelopment: "READY",
      lifecycle: "RESTARTED",
      baseURL: state.baseURL,
      configFile: state.configFile,
      databaseName: state.databaseName,
      containerName: owned.containerName,
      volumeName: owned.volumeName,
      identity: "RETAINED",
      ownerApproval: "NOT_RUN",
      productionPublication: "NOT_RUN",
    };
  } catch (error) {
    if (child?.pid) {
      try {
        hooks.kill(-child.pid, "SIGTERM");
      } catch {
        /* Owned child may already have exited. */
      }
    }
    // A failed restart restores a previously stopped DB to stopped state;
    // a previously running DB stays running. Nothing is removed.
    if (databaseStarted && priorDatabase.Running === false)
      await hooks
        .command(owned.dockerBin, ["stop", "--time", "5", owned.containerId], {
          deadline: Math.max(deadline, Date.now() + 10_000),
        })
        .catch(() => {});
    throw error;
  }
}

/** Stop only the exact processes this setup created; preserves all files. */
export async function stopDevelopment(
  stateDirectory,
  { hooks: overrides = {}, budgetMs = 30_000 } = {},
) {
  const hooks = lifecycleHooks(overrides);
  const deadline = Date.now() + budgetMs;
  await assertPrivateDirectory(stateDirectory);
  const state = await privateJSON(
    path.join(stateDirectory, "development-processes.json"),
  );
  const storedEnvironment = await privateJSON(
    path.join(stateDirectory, "runtime-environment.json"),
  );
  const config = await privateJSON(
    path.join(stateDirectory, "cms-config.json"),
  );
  const target = validateLifecycleState(
    state,
    storedEnvironment,
    config,
    stateDirectory,
  );
  await inspectOwnedLifecycleDatabase(
    state,
    target.databasePort,
    hooks,
    deadline,
  );
  for (const owned of [state.admin]) {
    const identity = await hooks.birth(owned.pid);
    if (identity === null) continue;
    if (identity !== owned.birth) fail("OWNED_PROCESS_IDENTITY_CHANGED");
    hooks.kill(-owned.pid, "SIGTERM");
    await waitForCMSExit(owned, hooks, Math.min(deadline, Date.now() + 10_000));
  }
  // All target/container/volume identity checks completed before the first
  // mutation. No configuration, volume, container or file is removed.
  await hooks.command(
    state.database.dockerBin,
    ["stop", "--time", "5", state.database.containerId],
    { deadline },
  );
  state.lifecycle = "stopped";
  state.stoppedAt = new Date().toISOString();
  await atomicPrivateJSON(
    path.join(stateDirectory, "development-processes.json"),
    state,
  );
  return {
    ownedDevelopment: "STOP_REQUESTED",
    files: "PRESERVED",
    container: "RETAINED",
    volume: "RETAINED",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [operation, repoRoot, packageFile, stateDirectory, dockerImage] =
    process.argv.slice(2);
  try {
    const result =
      operation === "setup"
        ? await setupDevelopment({
            repoRoot,
            packageFile,
            stateDirectory,
            dockerImage,
          })
        : operation === "stop"
          ? await stopDevelopment(repoRoot)
          : operation === "restart"
            ? await restartDevelopment({ stateDirectory: repoRoot })
            : fail("OPERATION_NOT_AUTHORIZED");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ localDevelopment: "FAIL", category: /^[A-Z_]{3,64}$/u.test(error.message) ? error.message : "DEVELOPMENT_SETUP_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}
