import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
// Finite pnpm 11.9 Node-shim bootstrap, reviewed for these two package bins.
// Only installation paths are normalized; changed shell control flow declines.
const staticBins = Object.freeze({
  eslint: "bin/eslint.js",
  prettier: "bin/prettier.cjs",
});
const reviewedStaticShim =
  "eca07d18212f7892b4614119ec40dbcecc43709f2d9b08a8b2932a074c8171bf";
// Reviewed unchanged installed closure: 90 packages, 2503 files, 48,292,474 bytes.
// Unknown versions or changed installed code execute checks without reuse.
const reviewedStaticClosure =
  "778bae93448a712d32ae1ba01b0e206a4bd6c67fb9265eefc509d84024829a99";
const vendorPaths = Object.freeze({
  darwin: {
    dirname: ["/usr/bin/dirname"],
    sed: ["/usr/bin/sed"],
    uname: ["/usr/bin/uname"],
    shell: ["/bin/sh", "/bin/bash"],
  },
  linux: {
    dirname: ["/usr/bin/dirname", "/bin/dirname"],
    sed: ["/usr/bin/sed", "/bin/sed"],
    uname: ["/usr/bin/uname", "/bin/uname"],
    shell: [
      "/usr/bin/dash",
      "/usr/bin/bash",
      "/bin/dash",
      "/bin/bash",
      "/bin/sh",
    ],
  },
});
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

/** Bind only the complete reviewed pnpm shim to its actual in-install bin. */
export function staticToolDispatchInputs(
  root,
  tool,
  { deadline = Infinity } = {},
) {
  try {
    deadlineCheck(deadline);
    if (
      !["darwin", "linux"].includes(process.platform) ||
      !Object.hasOwn(staticBins, tool)
    )
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    const modules = realpathSync(join(root, "node_modules")),
      directory = realpathSync(join(root, "node_modules", tool)),
      bin = staticBins[tool],
      binDirectory = join(root, "node_modules/.bin"),
      binInfo = statOrMissing(binDirectory);
    if (
      !within(realpathSync(root), modules) ||
      !within(modules, directory) ||
      !binInfo?.isDirectory() ||
      binInfo.isSymbolicLink() ||
      statOrMissing(join(binDirectory, "node")) ||
      statOrMissing(join(binDirectory, "node.exe"))
    )
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    const packagePath = join(directory, "package.json"),
      pkg = manifest(packagePath, deadline),
      declaredBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[tool];
    if (pkg.name !== tool || ![bin, `./${bin}`].includes(declaredBin))
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    // Package links into pnpm's local store are supported; links inside its bin
    // path are not. The same package directory is bound by the installed closure.
    let target = directory;
    const components = bin.split("/");
    for (const [index, component] of components.entries()) {
      target = join(target, component);
      const info = statOrMissing(target);
      if (
        !info ||
        info.isSymbolicLink() ||
        (index === components.length - 1 ? !info.isFile() : !info.isDirectory())
      )
        return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    }
    const logicalTarget = join(root, "node_modules", tool, bin);
    if (realpathSync(logicalTarget) !== target)
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    // Paths inserted in double-quoted NODE_PATH and the comment must not add
    // shell interpolation, escaping, another search element, or a new line.
    if (
      [root, modules, directory, logicalTarget].some((path) =>
        /[\\"$`:\r\n]/u.test(path),
      )
    )
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    const nodePath = [
      join(directory, "node_modules"),
      dirname(directory),
      join(modules, ".pnpm/node_modules"),
    ].join(":");
    const shimPath = join(binDirectory, tool),
      shim = bytes(shimPath, deadline, 64 * 1024),
      source = shim.value.toString("utf8");
    // Normalization markers must be introduced here, never supplied by a shim.
    if (
      [
        "<reviewed-node-path>",
        "<reviewed-absolute-target>",
        "<reviewed-relative-target>",
      ].some((token) => source.includes(token))
    )
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    const normalized = source
      .replaceAll(nodePath, "<reviewed-node-path>")
      .replaceAll(logicalTarget, "<reviewed-absolute-target>")
      .replaceAll(`../${tool}/${bin}`, "<reviewed-relative-target>");
    if (!(shim.mode & 0o111) || hash(normalized) !== reviewedStaticShim)
      return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
    const implementation = bytes(target, deadline),
      packageBytes = bytes(packagePath, deadline, 2 * 1024 * 1024);
    return {
      eligible: true,
      packageLocation: relative(root, directory),
      inputs: [
        {
          file: relative(root, shimPath),
          mode: shim.mode,
          sha256: hash(shim.value),
        },
        {
          file: relative(root, target),
          mode: implementation.mode,
          sha256: hash(implementation.value),
        },
        {
          file: relative(root, packagePath),
          mode: packageBytes.mode,
          sha256: hash(packageBytes.value),
        },
      ],
    };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unreviewed-static-tool-dispatch" };
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

/** Refuse native-loader and noninteractive shell/Node injection, without output. */
export function staticToolRuntimeEligibility(environment = process.env) {
  // Never collapse a parent segment before physical shell PATH resolution.
  if (
    typeof environment.PATH === "string" &&
    environment.PATH.split(":").some((directory) =>
      directory.split("/").includes(".."),
    )
  )
    return { eligible: false, reason: "ambiguous-static-runtime-path" };
  if (
    Object.keys(environment).some(
      (name) =>
        environment[name] &&
        (/^(?:LD_|DYLD_|BASH_FUNC_)/u.test(name) ||
          [
            "ENV",
            "BASH_ENV",
            "SHELLOPTS",
            "BASHOPTS",
            "NODE_OPTIONS",
            "NODE_PATH",
          ].includes(name)),
    )
  )
    return { eligible: false, reason: "unknown-static-runtime-environment" };
  return { eligible: true };
}

function firstExecutable(root, name, searchPath, deadline) {
  for (const directory of searchPath.split(":")) {
    deadlineCheck(deadline);
    const candidate = resolve(root, directory, name),
      info = statOrMissing(candidate);
    if (!info) continue;
    const path = realpathSync(candidate),
      target = statOrMissing(path);
    if (target?.isFile() && target.mode & 0o111) return { path, candidate };
  }
  return null;
}

// Trust the OS vendor locations and stable host, not arbitrary PATH programs.
// Bind their native bytes; do not recursively inspect kernel/system libraries.
function staticBootstrapInputs(root, searchPath, deadline) {
  try {
    deadlineCheck(deadline);
    const environment = staticToolRuntimeEligibility();
    if (!environment.eligible) return environment;
    const vendor = vendorPaths[process.platform];
    if (!vendor || typeof searchPath !== "string" || !searchPath)
      return { eligible: false, reason: "missing-supported-pnpm-child-path" };
    if (
      searchPath
        .split(":")
        .some((directory) => directory.split("/").includes(".."))
    )
      return { eligible: false, reason: "ambiguous-static-runtime-path" };
    for (const tool of Object.keys(staticBins)) {
      const selected = firstExecutable(root, tool, searchPath, deadline),
        expected = resolve(root, "node_modules/.bin", tool);
      // A preceding symlink to the same shim changes its $0/basedir; refuse it.
      if (
        selected?.candidate !== expected ||
        selected.path !== realpathSync(expected)
      )
        return { eligible: false, reason: "unreviewed-static-tool-launcher" };
    }
    const node = nodeExecutableInputs(root, { deadline, searchPath });
    if (!node.eligible) return node;
    const inputs = [{ file: node.path, mode: node.mode, sha256: node.sha256 }];
    let unamePath;
    for (const name of ["shell", "dirname", "sed", "uname"]) {
      const selected =
          name === "shell"
            ? { candidate: "/bin/sh", path: realpathSync("/bin/sh") }
            : firstExecutable(root, name, searchPath, deadline),
        path = selected?.path;
      if (
        !path ||
        !vendor[name].includes(selected.candidate) ||
        !vendor[name].includes(path)
      )
        return { eligible: false, reason: "unreviewed-static-tool-bootstrap" };
      const input = bytes(path, deadline);
      if (
        !(input.mode & 0o111) ||
        ![
          "7f454c46",
          "cffaedfe",
          "feedfacf",
          "cefaedfe",
          "feedface",
          "cafebabe",
          "bebafeca",
        ].includes(input.value.subarray(0, 4).toString("hex"))
      )
        return { eligible: false, reason: "unreviewed-static-tool-bootstrap" };
      inputs.push({
        file: path,
        selectedPath: selected.candidate,
        mode: input.mode,
        sha256: hash(input.value),
      });
      if (name === "uname") unamePath = path;
    }
    // This is the already-bound native vendor program, never a PATH wrapper.
    deadlineCheck(deadline);
    const platform = execFileSync(unamePath, ["-a"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: Number.isFinite(deadline)
        ? Math.max(1, Math.floor(deadline - performance.now()))
        : 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    deadlineCheck(deadline);
    if (/(?:CYGWIN|MINGW|MSYS|WSL2)/iu.test(platform))
      return {
        eligible: false,
        reason: "unsupported-static-tool-platform-branch",
      };
    return { eligible: true, inputs };
  } catch (error) {
    if (error.message.includes("original validation deadline")) throw error;
    return { eligible: false, reason: "unreviewed-static-tool-bootstrap" };
  }
}

/** Determinism eligibility is narrower than a descriptive package-closure hash. */
export function reviewedStaticToolInputs(
  root,
  { deadline = Infinity, searchPath } = {},
) {
  const dispatches = [];
  for (const tool of Object.keys(staticBins)) {
    const dispatch = staticToolDispatchInputs(root, tool, { deadline });
    if (!dispatch.eligible) return dispatch;
    dispatches.push({ tool, ...dispatch });
  }
  const bootstrap = staticBootstrapInputs(root, searchPath, deadline);
  if (!bootstrap.eligible) return bootstrap;
  const install = installedStaticToolInputs(root, { deadline });
  if (!install.eligible) return install;
  if (install.sha256 !== reviewedStaticClosure)
    return {
      eligible: false,
      reason: "unreviewed-static-tool-package-closure",
    };
  const inputs = [
    ...dispatches.flatMap((dispatch) => dispatch.inputs),
    ...bootstrap.inputs,
  ];
  return {
    eligible: true,
    closureSha256: install.sha256,
    inputs,
    sha256: hash(
      JSON.stringify({
        version: 1,
        closure: install.sha256,
        searchPath,
        inputs,
      }),
    ),
  };
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
