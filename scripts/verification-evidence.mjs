import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  openSync,
  fstatSync,
  closeSync,
  readSync,
  constants,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  installedStaticToolInputs,
  nodeExecutableInputs,
  pnpmExecutableInputs,
  staticConfigurationEligibility,
} from "./verification-tool-inputs.mjs";

export const EVIDENCE_VERSION = 1;
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Only explicit, read-only, file-scoped static checks are reusable. Database,
// browser, build, typecheck and unit-test evidence still executes normally.
export function staticCheckFiles(command) {
  if (command[0] !== "pnpm" || command[1] !== "exec") return null;
  const tool = command[2];
  const offset =
    tool === "prettier" && command[3] === "--check"
      ? 4
      : tool === "eslint"
        ? 3
        : null;
  if (offset === null) return null;
  const files = command.slice(offset);
  if (
    !files.length ||
    files.some(
      (file) =>
        file.startsWith("-") ||
        isAbsolute(file) ||
        /[*?{}[\]]/u.test(file) ||
        file.split(/[\\/]/u).includes(".."),
    )
  )
    return null;
  return files;
}

export function evidenceToolchain(root, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  const staticTools = installedStaticToolInputs(root, { deadline });
  delete staticTools.durationMs;
  const pnpmExecutable = pnpmExecutableInputs(root, { deadline });
  let childNode = { eligible: false, reason: "unbound-pnpm-executable" };
  if (pnpmExecutable.eligible) {
    try {
      // Query the actual pnpm child PATH with this known parent executable.
      // Do not execute a potentially replaced PATH/node during preparation.
      const childPath = execFileSync(
        "pnpm",
        [
          "exec",
          process.execPath,
          "-e",
          "process.stdout.write(process.env.PATH ?? '')",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: Math.max(1, Math.floor(deadline - performance.now())),
          maxBuffer: 128 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      childNode = nodeExecutableInputs(root, {
        deadline,
        searchPath: childPath,
      });
    } catch {
      if (performance.now() >= deadline)
        throw new Error(
          "Evidence preparation reached the original validation deadline",
        );
      childNode = { eligible: false, reason: "unbound-child-node-dispatch" };
    }
  }
  const version = (...args) =>
    execFileSync("pnpm", args, {
      cwd: root,
      encoding: "utf8",
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    staticTools,
    pnpmExecutable,
    childNode,
    pnpm: version("--version"),
    eslint: JSON.parse(
      readFileSync(resolve(root, "node_modules/eslint/package.json")),
    ).version,
    prettier: JSON.parse(
      readFileSync(resolve(root, "node_modules/prettier/package.json")),
    ).version,
    optionsSha256: hash(
      JSON.stringify([
        process.env.NODE_OPTIONS ?? "",
        process.env.ESLINT_USE_FLAT_CONFIG ?? "",
        process.env.LANG ?? "",
        process.env.LC_ALL ?? "",
      ]),
    ),
  };
}

export function checkInputIdentity(
  command,
  { root, files, toolchain, deadline = Infinity },
) {
  const selected = staticCheckFiles(command);
  if (!selected)
    return { eligible: false, reason: "non-static-or-unbounded-check" };
  if (toolchain.staticTools?.eligible !== true)
    return {
      eligible: false,
      reason: toolchain.staticTools?.reason ?? "unbound-static-tool-install",
    };
  if (toolchain.pnpmExecutable?.eligible !== true)
    return {
      eligible: false,
      reason: toolchain.pnpmExecutable?.reason ?? "unbound-pnpm-executable",
    };
  if (toolchain.childNode?.eligible !== true)
    return {
      eligible: false,
      reason: toolchain.childNode?.reason ?? "unbound-child-node-dispatch",
    };
  const configuration = staticConfigurationEligibility(
    root,
    command[2],
    selected,
    deadline,
  );
  if (!configuration.eligible) return configuration;
  const paths = [
    ...new Set([
      ...files,
      ...selected,
      "node_modules/.pnpm/lock.yaml",
      "node_modules/.bin/eslint",
      "node_modules/.bin/prettier",
    ]),
  ].sort();
  const inputs = [];
  for (const file of paths) {
    if (performance.now() >= deadline)
      throw new Error(
        "Evidence preparation reached the original validation deadline",
      );
    const path = resolve(root, file),
      rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Evidence input escapes the worktree");
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      inputs.push({ file, missing: true });
      continue;
    }
    if (!info.isFile() && !info.isSymbolicLink())
      return { eligible: false, reason: "non-file-static-input" };
    if (info.isSymbolicLink())
      return { eligible: false, reason: "symlink-static-input" };
    inputs.push({
      file,
      mode: info.mode,
      sha256: hash(readFileSync(path)),
    });
  }
  // Config modules can import other repository files. Hash the complete source
  // inventory conservatively, rather than guessing that only named targets matter.
  return {
    eligible: true,
    inputSha256: hash(
      JSON.stringify({ version: EVIDENCE_VERSION, command, toolchain, inputs }),
    ),
    inputs,
    command,
  };
}

export function reuseDecision(identity, command, source, sourceIdentity) {
  if (!identity.eligible) return { reused: false, reason: identity.reason };
  if (!source) return { reused: false, reason: "no-source-summary" };
  if (
    source.evidenceVersion !== EVIDENCE_VERSION ||
    source.contentUnchanged !== true ||
    !Array.isArray(source.checkEvidence) ||
    !Array.isArray(source.executed) ||
    !Array.isArray(source.commands) ||
    !source.toolchain ||
    !/^[a-f0-9]{40}$/u.test(source.head ?? "") ||
    source.contentBefore?.head !== source.head ||
    JSON.stringify(source.contentBefore) !==
      JSON.stringify(source.contentAfter) ||
    source.sourceFingerprint !== hash(JSON.stringify(source.contentBefore)) ||
    source.checkEvidence.length !== source.commands.length ||
    source.checkEvidence.some((entry, index) => entry.index !== index) ||
    new Set(source.executed.map((entry) => entry.index)).size !==
      source.executed.length ||
    source.executed.some(
      (entry) =>
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= source.commands.length,
    )
  )
    return { reused: false, reason: "source-incomplete-or-version-mismatch" };
  const previous = source.checkEvidence.find(
    (entry) =>
      entry.eligible === true &&
      entry.inputSha256 === identity.inputSha256 &&
      Array.isArray(entry.inputs) &&
      entry.inputSha256 ===
        hash(
          JSON.stringify({
            version: EVIDENCE_VERSION,
            command: entry.command,
            toolchain: source.toolchain,
            inputs: entry.inputs,
          }),
        ) &&
      JSON.stringify(source.commands[entry.index]) ===
        JSON.stringify(command) &&
      JSON.stringify(entry.command) === JSON.stringify(command),
  );
  if (!previous)
    return { reused: false, reason: "command-toolchain-or-inputs-changed" };
  const execution = source.executed.find(
    (entry) =>
      entry.index === previous.index &&
      entry.code === 0 &&
      Number.isInteger(entry.durationMs) &&
      entry.durationMs >= 0 &&
      JSON.stringify(entry.command) === JSON.stringify(command),
  );
  if (!execution)
    return { reused: false, reason: "source-check-not-executed-successfully" };
  return {
    reused: true,
    reason: "identical-deterministic-inputs",
    source: sourceIdentity,
    sourceHead: source.head,
    sourceCheckIndex: previous.index,
  };
}

export function readReuseSummary(
  path,
  { root = process.cwd(), deadline = Infinity } = {},
) {
  if (!isAbsolute(path))
    throw new Error(
      "--reuse-summary requires an absolute private summary path",
    );
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Reuse summary must be a private regular non-symlink file");
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("Reuse summary must be outside this worktree");
  if (info.size > 16 * 1024 * 1024)
    throw new Error("Reuse summary exceeds the evidence size limit");
  if (performance.now() >= deadline)
    throw new Error("Reuse summary reached the original validation deadline");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes;
  try {
    const current = fstatSync(fd);
    if (
      !current.isFile() ||
      (current.mode & 0o077) !== 0 ||
      current.size > 16 * 1024 * 1024
    )
      throw new Error("Reuse summary changed before its bounded read");
    const buffer = Buffer.alloc(64 * 1024),
      chunks = [];
    let total = 0;
    while (true) {
      if (performance.now() >= deadline)
        throw new Error(
          "Reuse summary reached the original validation deadline",
        );
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size;
      if (total > 16 * 1024 * 1024)
        throw new Error("Reuse summary exceeds the evidence size limit");
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
  let summary;
  try {
    summary = JSON.parse(bytes);
  } catch {
    throw new Error("Reuse summary JSON is invalid");
  }
  return {
    summary,
    identity: { path, sha256: hash(bytes) },
  };
}

export function sourceInventory(git) {
  return [
    ...new Set(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean),
    ),
  ];
}
