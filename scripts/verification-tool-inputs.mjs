import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

// These exact, reviewed root configs contain finite rules and known imports.
// A config change still executes its check; reuse awaits another code review.
const reviewedConfigs = Object.freeze({
  "eslint.config.mjs":
    "674edba2d329f686ce6d2d3accbf23431bcefa8592930d31cade9d651b05df61",
  "prettier.config.mjs":
    "2286a12d141d48923656ed82ad93857e31874e65566072295249a7ee3c631141",
  ".editorconfig":
    "1bbe0f47f2f163679851e73b594d121a351b441c0b59eeb1738c1b2ce5a01b4c",
});
const eslintConfigs = ["js", "mjs", "cjs", "ts", "mts", "cts"].map(
  (extension) => `eslint.config.${extension}`,
);
const prettierConfigs = [
  "package.yaml",
  ".prettierrc",
  ...[
    "json",
    "json5",
    "yaml",
    "yml",
    "toml",
    "js",
    "mjs",
    "cjs",
    "ts",
    "mts",
    "cts",
  ].map((extension) => `.prettierrc.${extension}`),
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map(
    (extension) => `prettier.config.${extension}`,
  ),
  ".editorconfig",
];
const roots = [
  "eslint",
  "@eslint/js",
  "globals",
  "typescript-eslint",
  "prettier",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
function deadlineCheck(deadline) {
  if (performance.now() >= deadline)
    throw new Error(
      "Static-tool preparation reached the original validation deadline",
    );
}
function statOrMissing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
function bytes(path, deadline, limit = 32 * 1024 * 1024) {
  deadlineCheck(deadline);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit)
      throw new Error("Unsupported static-tool input");
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(limit + 1, 64 * 1024));
    while (true) {
      deadlineCheck(deadline);
      const size = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, limit + 1 - total),
        null,
      );
      if (size === 0) break;
      total += size;
      if (total > limit) throw new Error("Unsupported static-tool input");
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    deadlineCheck(deadline);
    return { value: Buffer.concat(chunks, total), mode: info.mode };
  } finally {
    closeSync(fd);
  }
}
function manifest(path, deadline) {
  const { value } = bytes(path, deadline, 2 * 1024 * 1024);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid static-tool package manifest");
  }
}

/** Decline unknown/nested configs, including ignored files, without loading code. */
export function staticConfigurationEligibility(
  root,
  tool,
  targets,
  deadline = Infinity,
) {
  try {
    if (!Object.hasOwn({ eslint: true, prettier: true }, tool))
      return { eligible: false, reason: "unknown-static-tool" };
    if (
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      Object.keys(process.env).some(
        (name) =>
          /^(?:ESLINT|PRETTIER)_/u.test(name) &&
          process.env[name] &&
          !(name === "ESLINT_USE_FLAT_CONFIG" && process.env[name] === "true"),
      )
    )
      return { eligible: false, reason: "unknown-static-tool-environment" };
    const names = tool === "eslint" ? eslintConfigs : prettierConfigs;
    const required =
      tool === "eslint"
        ? ["eslint.config.mjs"]
        : ["prettier.config.mjs", ".editorconfig"];
    const directories = new Set([resolve(root)]);
    for (const target of targets) {
      let directory = dirname(resolve(root, target));
      if (!within(root, directory))
        return { eligible: false, reason: "static-target-outside-root" };
      while (within(root, directory)) {
        directories.add(directory);
        if (directory === resolve(root)) break;
        directory = dirname(directory);
      }
    }
    for (const directory of [...directories].sort()) {
      deadlineCheck(deadline);
      const info = statOrMissing(directory);
      if (!info?.isDirectory() || info.isSymbolicLink())
        return {
          eligible: false,
          reason: "unsupported-static-config-directory",
        };
      for (const name of names) {
        const path = join(directory, name);
        if (!statOrMissing(path)) continue;
        if (
          directory !== resolve(root) ||
          !Object.hasOwn(reviewedConfigs, name) ||
          hash(bytes(path, deadline, 128 * 1024).value) !==
            reviewedConfigs[name]
        )
          return { eligible: false, reason: "unreviewed-static-config" };
      }
      const path = join(directory, "package.json");
      if (statOrMissing(path)) {
        const pkg = manifest(path, deadline);
        if (
          Object.hasOwn(pkg, "prettier") ||
          Object.hasOwn(pkg, "eslintConfig")
        )
          return {
            eligible: false,
            reason: "unreviewed-package-static-config",
          };
      }
    }
    for (const name of required)
      if (!statOrMissing(join(root, name)))
        return { eligible: false, reason: "missing-reviewed-static-config" };
    return { eligible: true };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unsupported-static-config" };
  }
}

/** Hash installed package bytes and actual recursive dependency/peer resolution. */
export function installedStaticToolInputs(root, { deadline = Infinity } = {}) {
  const started = performance.now();
  try {
    deadlineCheck(deadline);
    const modules = realpathSync(join(root, "node_modules"));
    if (!within(realpathSync(root), modules))
      return { eligible: false, reason: "external-static-tool-install" };
    if (
      statOrMissing(join(modules, ".bin/node")) ||
      statOrMissing(join(modules, ".bin/node.exe"))
    )
      return { eligible: false, reason: "unreviewed-static-node-override" };
    const resolvePackage = (name, from) => {
      if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u.test(name))
        throw new Error("Unsupported static-tool dependency");
      // The package.json subpath also gives lookup paths for names such as
      // punycode that are Node builtins as well as installed dependencies.
      const locations = createRequire(join(from, "package.json")).resolve.paths(
        `${name}/package.json`,
      );
      for (const location of locations ?? []) {
        deadlineCheck(deadline);
        const directory = join(location, name);
        if (!statOrMissing(join(directory, "package.json"))) continue;
        const resolved = realpathSync(directory);
        if (!within(modules, resolved))
          throw new Error("External static-tool dependency");
        return resolved;
      }
      return null;
    };
    const queue = roots.map((name) => ({
      name,
      from: resolve(root),
      optional: false,
    }));
    const packages = new Map();
    const edges = [];
    let fileCount = 0;
    let byteCount = 0;
    while (queue.length) {
      deadlineCheck(deadline);
      const { name, from, optional } = queue.shift();
      const directory = resolvePackage(name, from);
      edges.push({
        from: relative(root, from),
        name,
        location: directory ? relative(root, directory) : null,
      });
      if (!directory) {
        if (optional) continue;
        return { eligible: false, reason: "missing-static-tool-dependency" };
      }
      if (packages.has(directory)) continue;
      const pkg = manifest(join(directory, "package.json"), deadline);
      const inputs = [];
      const visit = (current) => {
        deadlineCheck(deadline);
        for (const name of readdirSync(current).sort()) {
          if (name === "node_modules") continue;
          const path = join(current, name);
          const info = lstatSync(path);
          if (info.isSymbolicLink())
            throw new Error("Symlink inside static-tool package");
          if (info.isDirectory()) {
            visit(path);
            continue;
          }
          const { value, mode } = bytes(path, deadline);
          fileCount += 1;
          byteCount += value.length;
          if (fileCount > 25000 || byteCount > 256 * 1024 * 1024)
            throw new Error(
              "Static-tool dependency closure exceeds its size limit",
            );
          inputs.push({
            file: relative(directory, path),
            mode,
            sha256: hash(value),
          });
        }
      };
      visit(directory);
      packages.set(directory, {
        location: relative(root, directory),
        name: pkg.name,
        sha256: hash(JSON.stringify(inputs)),
      });
      const dependencies = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]);
      for (const dependency of [...dependencies].sort())
        queue.push({
          name: dependency,
          from: directory,
          optional:
            Object.hasOwn(pkg.optionalDependencies ?? {}, dependency) ||
            (!Object.hasOwn(pkg.dependencies ?? {}, dependency) &&
              pkg.peerDependenciesMeta?.[dependency]?.optional === true),
        });
    }
    deadlineCheck(deadline);
    const inputs = [...packages.values()].sort((a, b) =>
      a.location.localeCompare(b.location),
    );
    return {
      eligible: true,
      sha256: hash(JSON.stringify({ inputs, edges })),
      packageCount: inputs.length,
      fileCount,
      byteCount,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unsupported-static-tool-install" };
  }
}

/** Static shims use child PATH, which may differ from this parent Node. */
export function nodeExecutableInputs(
  root,
  {
    deadline = Infinity,
    searchPath = process.env.PATH ?? "",
    parentExecutable = process.execPath,
  } = {},
) {
  try {
    deadlineCheck(deadline);
    if (!["darwin", "linux"].includes(process.platform))
      return { eligible: false, reason: "unsupported-static-node-platform" };
    const parent = realpathSync(parentExecutable);
    for (const directory of searchPath.split(":")) {
      const candidate = resolve(root, directory, "node"),
        info = statOrMissing(candidate);
      if (!info) continue;
      const resolved = realpathSync(candidate),
        target = statOrMissing(resolved);
      if (!target?.isFile() || !(target.mode & 0o111)) continue;
      if (resolved !== parent)
        return { eligible: false, reason: "unreviewed-child-node-dispatch" };
      const { value, mode } = bytes(resolved, deadline, 256 * 1024 * 1024);
      return {
        eligible: true,
        path: resolved,
        mode,
        sha256: hash(value),
      };
    }
    return { eligible: false, reason: "missing-child-node-executable" };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unsupported-child-node-executable" };
  }
}

/** Bind PATH dispatch and native standalone pnpm bytes, never execute a shell. */
export function pnpmExecutableInputs(
  root,
  { deadline = Infinity, searchPath = process.env.PATH ?? "" } = {},
) {
  try {
    const digest = (path) => {
      deadlineCheck(deadline);
      const resolved = realpathSync(path);
      const fd = openSync(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          !(info.mode & 0o111) ||
          info.size > 256 * 1024 * 1024
        )
          throw new Error("Unsupported pnpm executable");
        const hasher = createHash("sha256"),
          buffer = Buffer.alloc(64 * 1024);
        let prefix,
          total = 0;
        while (true) {
          deadlineCheck(deadline);
          const size = readSync(fd, buffer, 0, buffer.length, null);
          if (!size) break;
          prefix ??= Buffer.from(buffer.subarray(0, size));
          total += size;
          if (total > 256 * 1024 * 1024)
            throw new Error("Unsupported pnpm executable");
          hasher.update(buffer.subarray(0, size));
        }
        deadlineCheck(deadline);
        const magic = prefix?.subarray(0, 4).toString("hex");
        const native = [
          "7f454c46",
          "cffaedfe",
          "feedfacf",
          "cefaedfe",
          "feedface",
          "cafebabe",
          "bebafeca",
        ].includes(magic);
        return {
          path: resolved,
          mode: info.mode,
          sha256: hasher.digest("hex"),
          native,
          text: !native && total <= 64 * 1024 ? prefix?.toString("utf8") : null,
        };
      } finally {
        closeSync(fd);
      }
    };
    let path;
    for (const directory of searchPath.split(":")) {
      const candidate = resolve(root, directory, "pnpm"),
        info = statOrMissing(candidate);
      if (
        info &&
        (info.isSymbolicLink() || (info.isFile() && info.mode & 0o111))
      ) {
        path = candidate;
        break;
      }
    }
    if (!path) return { eligible: false, reason: "missing-pnpm-executable" };
    const first = digest(path),
      inputs = [{ path: first.path, mode: first.mode, sha256: first.sha256 }];
    if (!first.native) {
      const tail =
        /^exec "\$basedir\/([^"$`\n]+)" +"\$@"\nexit \$\?\n# cmd-shim-target=([^\n]+)\n?$/mu;
      const match = first.text?.match(tail);
      if (
        !match ||
        hash(first.text.replace(tail, "<reviewed-standalone-dispatch>\n")) !==
          "01c831b270551bb837b90e8af46863d48a45a563a45b3df91cec6b0c85e05387"
      )
        return { eligible: false, reason: "unreviewed-pnpm-dispatch" };
      const target = resolve(dirname(path), match[1]);
      if (realpathSync(target) !== realpathSync(match[2]))
        return { eligible: false, reason: "ambiguous-pnpm-dispatch" };
      const actual = digest(target);
      if (!actual.native)
        return { eligible: false, reason: "unreviewed-pnpm-implementation" };
      inputs.push({
        path: actual.path,
        mode: actual.mode,
        sha256: actual.sha256,
      });
    }
    return { eligible: true, sha256: hash(JSON.stringify(inputs)) };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unsupported-pnpm-executable" };
  }
}
