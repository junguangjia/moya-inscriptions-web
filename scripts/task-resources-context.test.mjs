import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertTaskId,
  authorityFingerprint,
  contextState,
  parseContextArguments,
  privateLocation,
  snapshotContext,
  taskIdentity,
  verifyContext,
} from "./task-context.mjs";
import {
  inspectResources,
  loadResourceEnvironment,
  parseResourceArguments,
  prepareResources,
} from "./task-resources.mjs";
import { DISPOSABLE_TEST_TARGET_MARKER } from "./disposable-test-target.mjs";

test("verify-task CLI can load resource helpers and report invalid manifests without a module cycle", (t) => {
  const privateRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "task-resource-cli-")),
  );
  t.after(() => rmSync(privateRoot, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./verify-task.mjs", import.meta.url)),
      "--mode",
      "lightweight",
      "--resources",
      join(privateRoot, "missing.json"),
      "--output",
      join(privateRoot, "validation"),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Task validation unavailable: PRIVATE_JSON_INVALID/u,
  );
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
});

function fixture(t, task = "parallel-a") {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "moya-task-helper-test-")),
  );
  chmodSync(base, 0o700);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repository");
  const artifacts = join(base, "artifacts");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(artifacts, { mode: 0o700 });
  for (const file of [
    "AGENTS.md",
    "CLAUDE.md",
    "docs/governance/OWNER-DEVELOPMENT-CONSTITUTION.md",
    "docs/governance/amendments/active.md",
    "docs/development/task-workflow.md",
    ...["yoyi-task", "yoyi-review", "yoyi-handoff"].map(
      (name) => `.agents/skills/${name}/SKILL.md`,
    ),
    "apps/web/AGENTS.md",
    "apps/web/example.ts",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "Synthetic instruction or source\n");
  }
  const identity = { task, worktree: root, branch: `codex/${task}` };
  const state = {
    head: "a".repeat(40),
    staged: "",
    working: "",
    untracked: [],
  };
  const git = (...args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${root}\n`;
    if (command === "symbolic-ref --quiet HEAD")
      return `refs/heads/${identity.branch}\n`;
    if (command === "remote get-url --all origin")
      return "https://github.com/junguangjia/moya-inscriptions-web.git\n";
    if (command === "rev-parse HEAD") return `${state.head}\n`;
    if (command === "diff --cached --binary HEAD --") return state.staged;
    if (command === "diff --binary --") return state.working;
    if (command === "ls-files --others --exclude-standard -z")
      return state.untracked.map((name) => `${name}\0`).join("");
    throw Error("UNEXPECTED_FAKE_GIT");
  };
  return { base, root, artifacts, identity, state, git, task };
}

function fakeDocker(
  f,
  {
    wrongOwner = false,
    marker = DISPOSABLE_TEST_TARGET_MARKER,
    remote = false,
  } = {},
) {
  const calls = [];
  let running = false,
    cms = false;
  const run = (args) => {
    calls.push(args);
    if (args[0] === "context")
      return JSON.stringify(
        remote ? "tcp://remote.invalid:2375" : "unix:///synthetic/docker.sock",
      );
    if (args[0] === "inspect") {
      const m = JSON.parse(readFileSync(f.manifest, "utf8"));
      if (args[2] === "{{json .NetworkSettings.Ports}}")
        return JSON.stringify({
          "5432/tcp": [
            { HostIp: "127.0.0.1", HostPort: String(m.ports.database) },
          ],
        });
      return JSON.stringify({
        "com.docker.compose.project": m.project,
        "com.docker.compose.service": "postgres",
        "io.moya.task-id": wrongOwner ? "another-task" : m.task,
        "io.moya.resource-id": m.resourceId,
      });
    }
    assert.equal(args[0], "compose");
    const command = args[7];
    if (command === "ps") return running ? "c".repeat(64) : "";
    if (command === "up") {
      running = true;
      return "";
    }
    assert.equal(command, "exec");
    const database = args[args.indexOf("--dbname") + 1];
    const sql = args.at(-1);
    if (sql.startsWith("SELECT 1")) return cms ? "1\n" : "";
    if (sql.startsWith("CREATE DATABASE")) {
      cms = true;
      return "";
    }
    if (sql.startsWith("DO $$")) return "";
    return JSON.stringify({ database, comment: marker });
  };
  return {
    run,
    calls,
    stop: () => {
      running = false;
    },
  };
}

test("fixed CLI grammar rejects main/shared IDs and arbitrary operations", () => {
  for (const task of [
    "main",
    "shared",
    "default",
    "yoyi-dev",
    "../escape",
    "unsafe/id",
    "x;command",
  ])
    assert.throws(() => assertTaskId(task), /UNSAFE_TASK_ID/u);
  assert.throws(
    () => parseResourceArguments(["cleanup", "--task", "parallel-a"]),
    /USAGE/u,
  );
  assert.throws(
    () =>
      parseResourceArguments([
        "prepare",
        "--task",
        "parallel-a",
        "--command",
        "anything",
      ]),
    /USAGE/u,
  );
  assert.throws(
    () =>
      parseContextArguments([
        "verify",
        "--task",
        "parallel-a",
        "--checkpoint",
        "/tmp/private.json",
        "--scope",
        "apps/web",
      ]),
    /USAGE/u,
  );
  assert.equal(
    parseResourceArguments(["inspect", "--task", "parallel-a"]).operation,
    "inspect",
  );
});

test("task context validates real task identity and refuses private files inside source or via symlink", (t) => {
  const f = fixture(t);
  assert.deepEqual(taskIdentity(f.task, f.root, f.git), f.identity);
  f.identity.branch = "main";
  assert.throws(
    () => taskIdentity(f.task, f.root, f.git),
    /TASK_BRANCH_REQUIRED/u,
  );
  assert.throws(
    () => privateLocation(join(f.root, "checkpoint.json"), f.root),
    /OUTSIDE_WORKTREE/u,
  );
  symlinkSync(f.artifacts, join(f.base, "linked-artifacts"));
  assert.throws(
    () =>
      privateLocation(
        join(f.base, "linked-artifacts/checkpoint.json"),
        f.root,
        true,
      ),
    /SYMLINK/u,
  );
});

test("snapshot reuse is read-only and detects staged/unstaged/untracked, authority and writer drift", (t) => {
  const f = fixture(t);
  const checkpoint = join(f.artifacts, "context.json"),
    handoff = join(f.artifacts, "handoff.md");
  writeFileSync(handoff, "Writer: held by implementer\n", { mode: 0o600 });
  const request = {
    task: f.task,
    checkpoint,
    handoff,
    scope: ["apps/web/example.ts"],
  };
  const options = { root: f.root, git: f.git };
  snapshotContext(request, options);
  assert.equal(statSync(checkpoint).mode & 0o777, 0o600);
  const before = readFileSync(checkpoint);
  assert.equal(
    verifyContext({ task: f.task, checkpoint }, options).result,
    "PASS",
  );
  f.state.staged = "staged change";
  assert.deepEqual(
    verifyContext({ task: f.task, checkpoint }, options).changed,
    ["CONTENT"],
  );
  f.state.staged = "";
  f.state.working = "unstaged change";
  assert.deepEqual(
    verifyContext({ task: f.task, checkpoint }, options).changed,
    ["CONTENT"],
  );
  f.state.working = "";
  f.state.untracked = ["untracked.ts"];
  writeFileSync(join(f.root, "untracked.ts"), "first bytes");
  assert.deepEqual(
    verifyContext({ task: f.task, checkpoint }, options).changed,
    ["CONTENT"],
  );
  f.state.untracked = [];
  writeFileSync(join(f.root, "apps/web/AGENTS.md"), "New explicit authority\n");
  const changed = verifyContext({ task: f.task, checkpoint }, options);
  assert.equal(changed.authorityUnchanged, false);
  assert.deepEqual(changed.changed, ["AUTHORITY"]);
  writeFileSync(handoff, "Writer: held by another actor\n", { mode: 0o600 });
  assert.ok(
    verifyContext({ task: f.task, checkpoint }, options).changed.includes(
      "WRITER",
    ),
  );
  assert.deepEqual(readFileSync(checkpoint), before);
  assert.throws(
    () => snapshotContext(request, options),
    /CHECKPOINT_ALREADY_EXISTS/u,
  );
});

test("authority fingerprint finds new amendment/local instruction files without reading .env", (t) => {
  const f = fixture(t);
  const first = authorityFingerprint(f.root, ["apps/web/example.ts"]);
  writeFileSync(
    join(f.root, "docs/governance/amendments/new.md"),
    "New authority\n",
  );
  assert.notEqual(
    authorityFingerprint(f.root, ["apps/web/example.ts"]).sha256,
    first.sha256,
  );
  const second = authorityFingerprint(f.root, ["apps/web/example.ts"]);
  writeFileSync(join(f.root, "apps/web/CLAUDE.md"), "New local instruction\n");
  assert.notEqual(
    authorityFingerprint(f.root, ["apps/web/example.ts"]).sha256,
    second.sha256,
  );
  assert.throws(
    () =>
      contextState(
        { task: f.task, scope: [".env"] },
        { root: f.root, git: f.git },
      ),
    /UNSAFE_SCOPE_PATH/u,
  );
});

test("two fake task preparations own separate targets and never expose connection credentials", async (t) => {
  const a = fixture(t, "parallel-a"),
    b = fixture(t, "parallel-b");
  for (const [f, firstPort] of [
    [a, 41000],
    [b, 42000],
  ]) {
    f.manifest = join(f.artifacts, "resources.json");
    const docker = fakeDocker(f);
    let nextPort = firstPort;
    const options = {
      root: f.root,
      identity: f.identity,
      run: docker.run,
      allocatePort: async () => nextPort++,
    };
    const result = await prepareResources(
      { task: f.task, manifest: f.manifest },
      options,
    );
    assert.equal(result.result, "PASS");
    assert.equal(statSync(result.envFile).mode & 0o777, 0o600);
    assert.equal(statSync(f.manifest).mode & 0o777, 0o600);
    const env = loadResourceEnvironment(f.manifest, options);
    assert.equal(typeof env.TEST_DATABASE_URL, "string");
    assert.ok(env.TEST_DATABASE_URL !== env.CMS_TEST_DATABASE_URL);
    const published = JSON.stringify(result);
    assert.ok(!published.includes(env.MOYA_TEST_DB_PASSWORD));
    assert.ok(!published.includes("postgresql://"));
    const original = readFileSync(f.manifest);
    await prepareResources(
      { task: f.task, manifest: f.manifest },
      {
        ...options,
        allocatePort: async () => {
          throw Error("UNNECESSARY_REALLOCATION");
        },
      },
    );
    assert.deepEqual(readFileSync(f.manifest), original);
    assert.equal(
      inspectResources({ task: f.task, manifest: f.manifest }, options).result,
      "PASS",
    );
    assert.ok(
      docker.calls.every(
        (args) =>
          !args.includes("down") &&
          !args.includes("rm") &&
          !args.includes("prune"),
      ),
    );
    f.result = result;
  }
  assert.notEqual(a.result.project, b.result.project);
  assert.notEqual(a.result.ports.database, b.result.ports.database);
  assert.notEqual(a.result.databases[0], b.result.databases[0]);
});

test("resource loaders refuse remote Docker, foreign container, unmarked targets and changed config", async (t) => {
  const f = fixture(t);
  f.manifest = join(f.artifacts, "resources.json");
  const docker = fakeDocker(f);
  let port = 43000;
  const options = {
    root: f.root,
    identity: f.identity,
    run: docker.run,
    allocatePort: async () => port++,
  };
  await prepareResources({ task: f.task, manifest: f.manifest }, options);
  const remote = fakeDocker(f, { remote: true });
  assert.throws(
    () =>
      inspectResources(
        { task: f.task, manifest: f.manifest },
        { ...options, run: remote.run },
      ),
    /LOCAL_DOCKER_REQUIRED/u,
  );
  assert.equal(remote.calls.length, 1);
  const foreign = fakeDocker(f, { wrongOwner: true });
  // Keep the driver in its running state without issuing a real Docker command.
  foreign.run([
    "compose",
    "--project-name",
    "unused",
    "--file",
    "unused",
    "--env-file",
    "unused",
    "up",
  ]);
  assert.throws(
    () =>
      inspectResources(
        { task: f.task, manifest: f.manifest },
        { ...options, run: foreign.run },
      ),
    /OWNERSHIP_MISMATCH/u,
  );
  const unmarked = fakeDocker(f, { marker: null });
  unmarked.run([
    "compose",
    "--project-name",
    "unused",
    "--file",
    "unused",
    "--env-file",
    "unused",
    "up",
  ]);
  assert.throws(
    () =>
      inspectResources(
        { task: f.task, manifest: f.manifest },
        { ...options, run: unmarked.run },
      ),
    /DISPOSABLE_TEST_TARGET_REQUIRED/u,
  );
  const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
  writeFileSync(manifest.envFile, "changed private configuration\n", {
    mode: 0o600,
  });
  assert.throws(
    () => loadResourceEnvironment(f.manifest, options),
    /RESOURCE_CONFIG_CHANGED/u,
  );
});

test("context detects resource manifest and private configuration drift", async (t) => {
  const f = fixture(t);
  f.manifest = join(f.artifacts, "resources.json");
  const docker = fakeDocker(f);
  let port = 44000;
  await prepareResources(
    { task: f.task, manifest: f.manifest },
    {
      root: f.root,
      identity: f.identity,
      run: docker.run,
      allocatePort: async () => port++,
    },
  );
  const request = {
    task: f.task,
    scope: ["apps/web/example.ts"],
    resources: f.manifest,
    checkpoint: join(f.artifacts, "context.json"),
  };
  const options = {
    root: f.root,
    git: f.git,
    resourceInspector: (request, options) =>
      inspectResources(request, { ...options, run: docker.run }),
  };
  snapshotContext(request, options);
  docker.stop();
  assert.throws(
    () =>
      verifyContext({ task: f.task, checkpoint: request.checkpoint }, options),
    /RESOURCE_CONTAINER_MISSING/u,
  );
  const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
  writeFileSync(manifest.envFile, "changed private configuration\n", {
    mode: 0o600,
  });
  assert.deepEqual(
    verifyContext({ task: f.task, checkpoint: request.checkpoint }, options)
      .changed,
    ["RESOURCES"],
  );
});
