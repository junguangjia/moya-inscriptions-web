#!/usr/bin/env node
/** A private task snapshot is comparison evidence, never authority or a lock. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceFingerprint,
  workspaceFingerprint,
} from "./verification-evidence.mjs";
import { inspectResources } from "./task-resources.mjs";

export const SCRIPT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (category) => {
  throw new Error(category);
};

export function assertTaskId(task) {
  if (
    !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(task ?? "") ||
    ["main", "shared", "default", "yoyi-dev", "yoyi-test"].includes(task)
  )
    fail("UNSAFE_TASK_ID");
  return task;
}

export function gitReader(root) {
  return (...args) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const key of Object.keys(env))
      if (
        /^GIT_(?:CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_|DIR$|WORK_TREE$|INDEX_FILE$|COMMON_DIR$|OBJECT_DIRECTORY$)/u.test(
          key,
        )
      )
        delete env[key];
    try {
      return execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail("TASK_GIT_READ_FAILED");
    }
  };
}

export function taskIdentity(task, root = SCRIPT_ROOT, git = gitReader(root)) {
  assertTaskId(task);
  const top = realpathSync(git("rev-parse", "--show-toplevel").trim());
  if (top !== realpathSync(root)) fail("WRONG_WORKTREE");
  const ref = git("symbolic-ref", "--quiet", "HEAD").trim();
  if (!ref.startsWith("refs/heads/") || !ref.endsWith(`/${task}`))
    fail("TASK_BRANCH_REQUIRED");
  const origin = git("remote", "get-url", "--all", "origin").trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:nontwo|junguangjia)\/moya-inscriptions-web(?:\.git)?$/u.test(
      origin,
    )
  )
    fail("ORIGIN_MISMATCH");
  return { task, worktree: top, branch: ref.slice("refs/heads/".length) };
}

export function defaultArtifacts(task) {
  return join(
    homedir(),
    "Developer/artifacts/moya-inscriptions-web",
    assertTaskId(task),
  );
}

export function privateLocation(file, root, create = false) {
  if (!isAbsolute(file ?? "")) fail("PRIVATE_ABSOLUTE_PATH_REQUIRED");
  const target = resolve(file);
  const rel = relative(realpathSync(root), target);
  if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel)))
    fail("PRIVATE_PATH_OUTSIDE_WORKTREE_REQUIRED");
  for (
    let current = dirname(target);
    current !== dirname(current);
    current = dirname(current)
  )
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      fail("PRIVATE_PATH_SYMLINK");
  if (create) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(dirname(target))) fail("PRIVATE_PARENT_MISSING");
  if ((lstatSync(dirname(target)).mode & 0o077) !== 0)
    fail("PRIVATE_PARENT_PERMISSIONS");
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      fail("PRIVATE_FILE_PERMISSIONS");
  }
  return target;
}

export function privateJson(file, root) {
  try {
    return JSON.parse(readFileSync(privateLocation(file, root), "utf8"));
  } catch (error) {
    if (/^[A-Z_]+$/u.test(error.message)) throw error;
    fail("PRIVATE_JSON_INVALID");
  }
}

export function writePrivateJson(file, value, root) {
  const target = privateLocation(file, root, true);
  if (existsSync(target)) fail("CHECKPOINT_ALREADY_EXISTS");
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(temporary, target);
  } finally {
    unlinkSync(temporary);
  }
  return target;
}

function scopePath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    isAbsolute(value) ||
    /[\u0000-\u001f\\]/u.test(value) ||
    value
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") ||
    value
      .split("/")
      .some((part) => part.startsWith(".env") || part === "private-credentials")
  )
    fail("UNSAFE_SCOPE_PATH");
  return value;
}

export function authorityFingerprint(root, scope) {
  const files = new Set([
    "AGENTS.md",
    "CLAUDE.md",
    "docs/governance/OWNER-DEVELOPMENT-CONSTITUTION.md",
    "docs/development/task-workflow.md",
    ...["yoyi-task", "yoyi-review", "yoyi-handoff"].map(
      (name) => `.agents/skills/${name}/SKILL.md`,
    ),
  ]);
  const amendments = join(root, "docs/governance/amendments");
  if (!existsSync(amendments)) fail("AUTHORITY_MISSING");
  for (const name of readdirSync(amendments))
    if (name.endsWith(".md")) files.add(`docs/governance/amendments/${name}`);
  for (const path of scope) {
    let directory = scopePath(path);
    if (
      !existsSync(join(root, directory)) ||
      !lstatSync(join(root, directory)).isDirectory()
    )
      directory = dirname(directory);
    while (directory !== ".") {
      for (const entry of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"])
        if (existsSync(join(root, directory, entry)))
          files.add(`${directory}/${entry}`);
      directory = dirname(directory);
    }
  }
  if (existsSync(join(root, "AGENTS.override.md")))
    files.add("AGENTS.override.md");
  const entries = [...files].sort().map((path) => {
    const file = join(root, path);
    if (
      !existsSync(file) ||
      !lstatSync(file).isFile() ||
      lstatSync(file).isSymbolicLink()
    )
      fail("AUTHORITY_MISSING");
    return { path, sha256: hash(readFileSync(file)) };
  });
  return { entries, sha256: hash(JSON.stringify(entries)) };
}

function privateFingerprint(file, root, optional = false) {
  if (!file || (optional && !existsSync(file))) return null;
  const target = privateLocation(file, root);
  return { path: target, sha256: hash(readFileSync(target)) };
}

export function contextState(
  request,
  { root = SCRIPT_ROOT, git = gitReader(root) } = {},
) {
  const identity = taskIdentity(request.task, root, git);
  const scope = [...new Set((request.scope ?? []).map(scopePath))].sort();
  if (scope.length === 0) fail("SCOPE_REQUIRED");
  const content = workspaceFingerprint(git);
  const resources = request.resources
    ? privateJson(request.resources, root)
    : null;
  if (
    resources &&
    (resources.task !== request.task ||
      resources.worktree !== identity.worktree ||
      resources.branch !== identity.branch)
  )
    fail("RESOURCE_IDENTITY_MISMATCH");
  if (
    resources &&
    resources.envFile !== join(dirname(request.resources), "resources.env")
  )
    fail("RESOURCE_CONFIG_LOCATION");
  return {
    identity,
    scope,
    content,
    sourceFingerprint: sourceFingerprint(content),
    authority: authorityFingerprint(root, scope),
    writer: privateFingerprint(
      request.handoff ?? join(defaultArtifacts(request.task), "handoff.md"),
      root,
      true,
    ),
    resources: resources
      ? {
          manifest: privateFingerprint(request.resources, root),
          config: privateFingerprint(resources.envFile, root),
        }
      : null,
  };
}

export function snapshotContext(request, options) {
  const state = contextState(request, options);
  const root = options?.root ?? SCRIPT_ROOT;
  if (request.resources)
    (options?.resourceInspector ?? inspectResources)(
      { task: request.task, manifest: request.resources },
      { root, identity: state.identity },
    );
  const checkpoint = writePrivateJson(
    request.checkpoint,
    { version: 1, request, state },
    root,
  );
  return {
    result: "PASS",
    checkpoint,
    task: request.task,
    sourceFingerprint: state.sourceFingerprint,
    authorityFingerprint: state.authority.sha256,
    authorityAdoption: "NOT_CLAIMED",
    writerAcquisition: "NOT_PERFORMED",
  };
}

export function verifyContext(request, options) {
  const previous = privateJson(
    request.checkpoint,
    options?.root ?? SCRIPT_ROOT,
  );
  if (previous.version !== 1 || previous.request?.task !== request.task)
    fail("CHECKPOINT_IDENTITY_MISMATCH");
  const current = contextState(previous.request, options);
  const changes = [];
  for (const [field, category] of [
    ["identity", "IDENTITY"],
    ["scope", "SCOPE"],
    ["content", "CONTENT"],
    ["authority", "AUTHORITY"],
    ["writer", "WRITER"],
    ["resources", "RESOURCES"],
  ])
    if (
      JSON.stringify(previous.state[field]) !== JSON.stringify(current[field])
    )
      changes.push(category);
  if (previous.request.resources && !changes.includes("RESOURCES"))
    (options?.resourceInspector ?? inspectResources)(
      { task: request.task, manifest: previous.request.resources },
      { root: options?.root ?? SCRIPT_ROOT, identity: current.identity },
    );
  return {
    result: changes.length ? "DRIFT" : "PASS",
    task: request.task,
    changed: changes,
    authorityUnchanged: !changes.includes("AUTHORITY"),
    authorityAdoption: "NOT_CLAIMED",
    writerAcquisition: "NOT_PERFORMED",
  };
}

export function parseContextArguments(argv) {
  const [operation, ...rest] = argv;
  if (!["snapshot", "verify"].includes(operation)) fail("USAGE");
  const request = { scope: [] };
  const names = {
    "--task": "task",
    "--checkpoint": "checkpoint",
    "--handoff": "handoff",
    "--resources": "resources",
  };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (!value || value.startsWith("--")) fail("USAGE");
    if (key === "--scope" && operation === "snapshot")
      request.scope.push(value);
    else if (
      names[key] &&
      request[names[key]] === undefined &&
      (operation === "snapshot" || ["--task", "--checkpoint"].includes(key))
    )
      request[names[key]] = value;
    else fail("USAGE");
  }
  assertTaskId(request.task);
  if (!request.checkpoint) fail("USAGE");
  return { operation, request };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { operation, request } = parseContextArguments(process.argv.slice(2));
    const outcome =
      operation === "snapshot"
        ? snapshotContext(request)
        : verifyContext(request);
    console.log(JSON.stringify(outcome));
    if (outcome.result !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "REFUSED",
        category: /^[A-Z_]+$/u.test(error.message)
          ? error.message
          : "TASK_CONTEXT_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
