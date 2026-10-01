/** Mocked lifecycle regressions. No Docker, database or process mutation. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicPrivateJSON, privateJSON } from "./adapter.mjs";
import {
  restartDevelopment,
  stopDevelopment,
  validateLifecycleState,
} from "./setup-development.mjs";

const { Response, URL } = globalThis;
const taskId = "0123456789abcdef";
const containerId = "a".repeat(64);
const containerName = `artvenn-curation-pg-${taskId}`;
const volumeName = `${containerName}-data`;
const labels = {
  "artvenn.curation.task": taskId,
  "artvenn.environment": "development",
};

async function fixture({ running = false } = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "artvenn-lifecycle-unit-"),
  );
  const repoRoot = path.join(directory, "fake-repository");
  await mkdir(path.join(repoRoot, "apps/admin"), { recursive: true });
  const databaseName = `artvenn_curation_synthetic_${taskId}`;
  const state = {
    version: 1,
    instance: "development",
    taskOwned: true,
    syntheticOnly: true,
    repoRoot,
    databaseName,
    baseURL: "http://127.0.0.1:43219",
    database: {
      dockerBin: "/synthetic-test-only/docker",
      containerId,
      containerName,
      taskId,
      volumeName,
    },
    admin: { pid: 1111, birth: "synthetic old PID birth" },
    configFile: path.join(directory, "cms-config.json"),
    runtimeEnvironmentFile: path.join(directory, "runtime-environment.json"),
    lifecycle: running ? "running" : "stopped",
  };
  const config = {
    instance: "development",
    targetVerified: true,
    syntheticOnly: true,
    baseURL: state.baseURL,
    apiKey: "SYNTHETIC_TEST_ONLY_NOT_A_REAL_KEY",
    databaseName,
    catalogIds: ["synthetic-only"],
  };
  const env = {
    NODE_ENV: "development",
    CMS_ENVIRONMENT: "synthetic",
    CMS_STORAGE_MODE: "local",
    MOYA_CONTENT_SOURCE: "payload",
    CMS_DATABASE_URL: `postgresql://artvenn_curation_setup@127.0.0.1:43220/${databaseName}`,
    CMS_TEST_DATABASE_URL: `postgresql://artvenn_curation_setup@127.0.0.1:43220/${databaseName}`,
    CMS_SECRET: "SYNTHETIC_TEST_PLACEHOLDER_NOT_A_REAL_SECRET",
    CMS_PUBLIC_URL: state.baseURL,
    CMS_PREVIEW_WEB_URL: state.baseURL,
    CMS_MEDIA_DIR: path.join(directory, "media"),
    ARTVENN_CURATION_REPO_ROOT: repoRoot,
    ARTVENN_CURATION_BOOTSTRAP: "fresh-owned-synthetic",
    ARTVENN_CURATION_PACKAGE_FILE: "/synthetic-test-only/package.json",
  };
  await atomicPrivateJSON(
    path.join(directory, "development-processes.json"),
    state,
  );
  await atomicPrivateJSON(state.configFile, config);
  await atomicPrivateJSON(state.runtimeEnvironmentFile, env);
  const calls = [];
  const births = new Map(running ? [[1111, state.admin.birth]] : []);
  let startedEnv;
  const inspected = {
    Id: containerId,
    Name: `/${containerName}`,
    Labels: { ...labels },
    Mounts: [
      { Type: "volume", Name: volumeName, Destination: "/var/lib/postgresql" },
    ],
    PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "43220" }] },
    Running: running,
  };
  const hooks = {
    async command(file, args) {
      calls.push({ kind: "command", file, args });
      if (args[0] === "inspect")
        return {
          stdout: JSON.stringify(
            args[3] === "{{json .Config.Labels}}"
              ? inspected.Labels
              : inspected,
          ),
        };
      if (args[0] === "volume" && args[1] === "inspect")
        return { stdout: JSON.stringify(labels) };
      if (["start", "stop", "exec"].includes(args[0]))
        return { stdout: "synthetic mocked lifecycle result" };
      throw new Error("UNEXPECTED_MOCKED_DOCKER_OPERATION");
    },
    async birth(pid) {
      calls.push({ kind: "birth", pid });
      return births.get(pid) ?? null;
    },
    async delay() {
      /* All mocked operations settle immediately. */
    },
    kill(pid, signal) {
      calls.push({ kind: "kill", pid, signal });
      births.delete(-pid);
    },
    async guards(root) {
      calls.push({ kind: "guard-loader", root });
      return {
        syntheticDatabase(value) {
          calls.push({ kind: "synthetic-target-check", value });
        },
        async verifyLoopbackDisposableTarget(value) {
          calls.push({
            kind: "marker-check",
            databaseName: new URL(value.CMS_DATABASE_URL).pathname,
          });
        },
      };
    },
    startCMS(root, childEnv, port) {
      startedEnv = childEnv;
      calls.push({ kind: "start-cms", root, port });
      births.set(2222, "synthetic restarted PID birth");
      return {
        pid: 2222,
        exitCode: null,
        unref() {
          calls.push({ kind: "unref" });
        },
      };
    },
    async fetch(url) {
      calls.push({ kind: "readiness", url });
      return Response.json(
        { ok: false, error: { code: "AUTHORIZATION_REQUIRED" } },
        { status: 403 },
      );
    },
    async portAvailable() {
      return true;
    },
  };
  return {
    directory,
    repoRoot,
    state,
    config,
    env,
    hooks,
    calls,
    births,
    inspected,
    startedEnv: () => startedEnv,
  };
}

test("mocked restart: same container/volume/key, marker readback, refreshed native PID, no bootstrap", async () => {
  const value = await fixture();
  const beforeConfig = await privateJSON(value.state.configFile);
  const result = await restartDevelopment({
    stateDirectory: value.directory,
    hooks: value.hooks,
    budgetMs: 10_000,
  });
  assert.equal(result.lifecycle, "RESTARTED");
  assert.equal(result.identity, "RETAINED");
  const after = await privateJSON(
    path.join(value.directory, "development-processes.json"),
  );
  assert.equal(after.admin.pid, 2222);
  assert.equal(after.admin.birth, "synthetic restarted PID birth");
  assert.deepEqual(after.database, value.state.database);
  assert.deepEqual(await privateJSON(value.state.configFile), beforeConfig);
  assert.equal(value.startedEnv().NODE_ENV, "development");
  assert.equal(value.startedEnv().CMS_ENVIRONMENT, "synthetic");
  assert.equal(value.startedEnv().ARTVENN_CURATION_BOOTSTRAP, undefined);
  assert.ok(value.calls.some((call) => call.kind === "marker-check"));
  assert.ok(
    value.calls.every(
      (call) =>
        call.kind !== "command" ||
        !["run", "create", "rm", "pull", "volume"].includes(call.args[0]) ||
        (call.args[0] === "volume" && call.args[1] === "inspect"),
    ),
  );
});

test("mocked restart: a live exact owned CMS is stopped before restarting", async () => {
  const value = await fixture({ running: true });
  await restartDevelopment({
    stateDirectory: value.directory,
    hooks: value.hooks,
    budgetMs: 10_000,
  });
  const killed = value.calls.findIndex((call) => call.kind === "kill");
  const started = value.calls.findIndex((call) => call.kind === "start-cms");
  assert.ok(killed >= 0 && killed < started);
  assert.equal(value.calls[killed].pid, -1111);
});

test("mocked lifecycle: stop retains configuration/container/volume and can restart", async () => {
  const value = await fixture({ running: true });
  const stopped = await stopDevelopment(value.directory, {
    hooks: value.hooks,
  });
  assert.equal(stopped.files, "PRESERVED");
  assert.equal(stopped.container, "RETAINED");
  assert.equal(stopped.volume, "RETAINED");
  assert.equal(
    (
      await privateJSON(
        path.join(value.directory, "development-processes.json"),
      )
    ).lifecycle,
    "stopped",
  );
  await restartDevelopment({
    stateDirectory: value.directory,
    hooks: value.hooks,
    budgetMs: 10_000,
  });
  assert.equal(
    (
      await privateJSON(
        path.join(value.directory, "development-processes.json"),
      )
    ).lifecycle,
    "running",
  );
  assert.deepEqual(await privateJSON(value.state.configFile), value.config);
});

test("mocked lifecycle: reused PID blocks all mutations", async () => {
  const value = await fixture({ running: true });
  value.births.set(1111, "another process birth");
  await assert.rejects(
    restartDevelopment({ stateDirectory: value.directory, hooks: value.hooks }),
    /OWNED_PROCESS_IDENTITY_CHANGED/u,
  );
  assert.ok(
    value.calls.every(
      (call) =>
        call.kind !== "kill" &&
        call.kind !== "start-cms" &&
        call.kind !== "command",
    ),
  );
});

test("mocked restart: wrong container label, volume and published port each block start", async () => {
  for (const corrupt of [
    (value) => {
      value.inspected.Labels["artvenn.curation.task"] = "different";
    },
    (value) => {
      value.inspected.Mounts[0].Name = "another-volume";
    },
    (value) => {
      value.inspected.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0";
    },
    (value) => {
      value.inspected.PortBindings["5432/tcp"][0].HostPort = "5432";
    },
  ]) {
    const value = await fixture();
    corrupt(value);
    await assert.rejects(
      restartDevelopment({
        stateDirectory: value.directory,
        hooks: value.hooks,
      }),
      /OWNED_DATABASE_(IDENTITY|VOLUME|PORT)_CHANGED/u,
    );
    assert.ok(
      !value.calls.some(
        (call) =>
          call.kind === "command" && ["start", "stop"].includes(call.args[0]),
      ),
    );
  }
});

test("offline lifecycle: Production/remote/override configuration is rejected before mutation", async () => {
  const value = await fixture();
  for (const patch of [
    { NODE_ENV: "production" },
    { CMS_STORAGE_MODE: "cos" },
    { CMS_ENVIRONMENT: "production" },
    { CMS_DATABASE_URL: "postgresql://role@203.0.113.7:5432/production" },
    { CMS_DATABASE_URL: `${value.env.CMS_DATABASE_URL}?host=203.0.113.7` },
    { CMS_TEST_REMOTE_TARGET_JSON: "{}" },
    { CMS_COS_SECRET_ACCESS_KEY: "EXPLICIT_SYNTHETIC_PLACEHOLDER" },
  ])
    assert.throws(() =>
      validateLifecycleState(
        value.state,
        { ...value.env, ...patch },
        value.config,
        value.directory,
      ),
    );
  await atomicPrivateJSON(value.state.runtimeEnvironmentFile, {
    ...value.env,
    NODE_ENV: "production",
  });
  await assert.rejects(
    restartDevelopment({ stateDirectory: value.directory, hooks: value.hooks }),
    /OWNED_RUNTIME_CONFIGURATION_INVALID/u,
  );
  assert.equal(value.calls.length, 0);
});

test("offline lifecycle: ambient .env is refused without reading or changing it", async () => {
  const value = await fixture();
  const file = path.join(value.repoRoot, "apps/admin/.env.local");
  await writeFile(file, "EXPLICIT_SYNTHETIC_PLACEHOLDER=true\n", {
    mode: 0o600,
  });
  await assert.rejects(
    restartDevelopment({ stateDirectory: value.directory, hooks: value.hooks }),
    /AMBIENT_RUNTIME_CONFIGURATION_REFUSED/u,
  );
  assert.equal(value.calls.length, 0);
});

test("mocked restart: actual-marker rejection prevents native CMS start and restores stopped DB", async () => {
  const value = await fixture();
  value.hooks.guards = async () => ({
    syntheticDatabase() {},
    async verifyLoopbackDisposableTarget() {
      throw new Error("DISPOSABLE_TEST_TARGET_MARKER_MISSING");
    },
  });
  await assert.rejects(
    restartDevelopment({ stateDirectory: value.directory, hooks: value.hooks }),
    /DISPOSABLE_TEST_TARGET_MARKER_MISSING/u,
  );
  assert.ok(!value.calls.some((call) => call.kind === "start-cms"));
  assert.ok(
    value.calls.some(
      (call) => call.kind === "command" && call.args[0] === "stop",
    ),
  );
});
