import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import process from "node:process";
import {
  installedStaticToolInputs,
  nodeExecutableInputs,
  pnpmExecutableInputs,
  staticConfigurationEligibility,
  staticToolDispatchInputs,
  reviewedStaticToolInputs,
  staticToolRuntimeEligibility,
} from "./verification-tool-inputs.mjs";

const names = [
  "eslint",
  "@eslint/js",
  "globals",
  "typescript-eslint",
  "prettier",
];
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const toolBins = { eslint: "bin/eslint.js", prettier: "bin/prettier.cjs" };
// Independently captured reviewed pnpm shim text; no installed fixture reads.
const capturedPnpmNodeShim = [
  "#!/bin/sh",
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'basedir_win="$basedir"',
  'exe=""',
  'msys=""',
  "",
  "case `uname -a` in",
  "  *CYGWIN*|*MINGW*|*MSYS*)",
  "    if command -v cygpath > /dev/null 2>&1; then",
  '      basedir_win=`cygpath -w "$basedir"`',
  "    fi",
  '    exe=".exe"',
  '    msys="true"',
  "  ;;",
  "  *WSL2*)",
  "    if command -v wslpath > /dev/null 2>&1; then",
  '      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"',
  '      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then',
  '        basedir_win="$basedir"',
  "      else",
  '        exe=".exe"',
  "      fi",
  "    fi",
  "  ;;",
  "esac",
  "",
  'if [ -z "$NODE_PATH" ]; then',
  '  export NODE_PATH="<reviewed-node-path>"',
  "else",
  '  export NODE_PATH="<reviewed-node-path>:$NODE_PATH"',
  "fi",
  'if [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then',
  '  exec "$basedir/node.exe"  "$basedir_win/<reviewed-relative-target>" "$@"',
  'elif [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/<reviewed-relative-target>" "$@"',
  "elif command -v node >/dev/null 2>&1; then",
  '  exec node  "$basedir/<reviewed-relative-target>" "$@"',
  'elif [ -n "$exe" ] && command -v node.exe >/dev/null 2>&1; then',
  '  exec node.exe  "$basedir_win/<reviewed-relative-target>" "$@"',
  "else",
  '  exec node  "$basedir/<reviewed-relative-target>" "$@"',
  "fi",
  "# cmd-shim-target=<reviewed-absolute-target>",
  "",
].join("\n");
function renderCapturedShim(
  root,
  tool,
  directory = join(root, "node_modules", tool),
) {
  const bin = tool === "eslint" ? "bin/eslint.js" : "bin/prettier.cjs",
    nodePath = [
      join(directory, "node_modules"),
      dirname(directory),
      join(root, "node_modules/.pnpm/node_modules"),
    ].join(":");
  return capturedPnpmNodeShim
    .replaceAll("<reviewed-node-path>", nodePath)
    .replaceAll("<reviewed-relative-target>", `../${tool}/${bin}`)
    .replaceAll(
      "<reviewed-absolute-target>",
      join(root, "node_modules", tool, bin),
    );
}

function writeReviewedShim(
  root,
  tool,
  directory = join(root, "node_modules", tool),
) {
  const path = join(root, "node_modules/.bin", tool);
  write(path, renderCapturedShim(root, tool, directory));
  chmodSync(path, 0o700);
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "static-tool-inputs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) packageAt(root, name, {});
  for (const tool of Object.keys(toolBins)) writeReviewedShim(root, tool);
  for (const name of [
    "eslint.config.mjs",
    "prettier.config.mjs",
    ".editorconfig",
  ])
    write(
      join(root, name),
      readFileSync(new URL(`../${name}`, import.meta.url)),
    );
  write(join(root, "src/a.ts"), "export const a = 1;\n");
  return root;
}
function packageAt(root, name, pkg) {
  write(
    join(root, "node_modules", name, "package.json"),
    JSON.stringify({
      name,
      version: "synthetic-1",
      main: "index.js",
      ...(toolBins[name] ? { bin: { [name]: `./${toolBins[name]}` } } : {}),
      ...pkg,
    }),
  );
  write(join(root, "node_modules", name, "index.js"), "module.exports = {};\n");
  if (toolBins[name])
    write(
      join(root, "node_modules", name, toolBins[name]),
      "process.exit(0);\n",
    );
}

test("installed input digest is stable and binds dependency bytes despite identical versions", (t) => {
  const root = fixture(t);
  packageAt(root, "eslint", { dependencies: { "synthetic-dependency": "1" } });
  packageAt(root, "synthetic-dependency", {});
  const before = installedStaticToolInputs(root);
  assert.equal(before.eligible, true);
  assert.equal(before.packageCount, 6);
  assert.equal(installedStaticToolInputs(root).sha256, before.sha256);
  write(
    join(root, "node_modules/synthetic-dependency/index.js"),
    "module.exports = { changed: true };\n",
  );
  assert.notEqual(installedStaticToolInputs(root).sha256, before.sha256);
});

test("recursive optional/peer closures include installed dependencies and absent optional edges", (t) => {
  const root = fixture(t);
  packageAt(root, "eslint", {
    dependencies: { "synthetic-child": "1" },
    peerDependencies: { "synthetic-peer": "1" },
    optionalDependencies: { "synthetic-optional": "1" },
  });
  packageAt(root, "synthetic-child", {
    dependencies: { "synthetic-grandchild": "1" },
  });
  packageAt(root, "synthetic-grandchild", {});
  packageAt(root, "synthetic-peer", {
    peerDependencies: { eslint: "1", "absent-peer": "1" },
    peerDependenciesMeta: { "absent-peer": { optional: true } },
  });
  const before = installedStaticToolInputs(root);
  assert.equal(before.eligible, true);
  assert.equal(before.packageCount, 8);
  packageAt(root, "synthetic-optional", {});
  assert.notEqual(installedStaticToolInputs(root).sha256, before.sha256);
});

test("package resolution binds the actual nested dependency instance", (t) => {
  const root = fixture(t);
  packageAt(root, "eslint", { dependencies: { "synthetic-child": "1" } });
  packageAt(root, "synthetic-child", {});
  const nested = join(root, "node_modules/eslint/node_modules/synthetic-child");
  write(
    join(nested, "package.json"),
    JSON.stringify({ name: "synthetic-child", version: "synthetic-1" }),
  );
  write(join(nested, "index.js"), "nested-instance\n");
  const before = installedStaticToolInputs(root);
  write(
    join(root, "node_modules/synthetic-child/index.js"),
    "unused-instance-change\n",
  );
  assert.equal(installedStaticToolInputs(root).sha256, before.sha256);
  write(join(nested, "index.js"), "used-instance-change\n");
  assert.notEqual(installedStaticToolInputs(root).sha256, before.sha256);
});

test("missing required dependencies, external installs and package symlinks decline reuse", (t) => {
  const root = fixture(t);
  packageAt(root, "eslint", {
    dependencies: { "absent-static-dependency": "1" },
  });
  assert.equal(installedStaticToolInputs(root).eligible, false);
  packageAt(root, "eslint", {});
  symlinkSync(
    join(root, "src/a.ts"),
    join(root, "node_modules/eslint/linked.js"),
  );
  assert.equal(installedStaticToolInputs(root).eligible, false);
});

test("resolved package symlinks may stay within the install but may not escape it", (t) => {
  const root = fixture(t);
  const internal = join(
    root,
    "node_modules/.pnpm/synthetic-eslint/node_modules/eslint",
  );
  write(
    join(internal, "package.json"),
    JSON.stringify({
      name: "eslint",
      version: "synthetic-1",
      bin: { eslint: "./bin/eslint.js" },
    }),
  );
  write(join(internal, "index.js"), "internal-install\n");
  write(join(internal, "bin/eslint.js"), "process.exit(0);\n");
  rmSync(join(root, "node_modules/eslint"), { recursive: true });
  symlinkSync(internal, join(root, "node_modules/eslint"));
  writeReviewedShim(root, "eslint", internal);
  assert.equal(installedStaticToolInputs(root).eligible, true);
  const external = mkdtempSync(join(tmpdir(), "external-static-tool-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  write(
    join(external, "package.json"),
    JSON.stringify({ name: "eslint", version: "synthetic-1" }),
  );
  rmSync(join(root, "node_modules/eslint"));
  symlinkSync(external, join(root, "node_modules/eslint"));
  assert.equal(installedStaticToolInputs(root).eligible, false);
});

test("installed closure ignores unrelated packages and dev-only dependencies", (t) => {
  const root = fixture(t);
  packageAt(root, "eslint", { devDependencies: { "unused-dependency": "1" } });
  const before = installedStaticToolInputs(root);
  packageAt(root, "unused-dependency", {});
  packageAt(root, "unrelated-browser-package", {});
  assert.equal(installedStaticToolInputs(root).sha256, before.sha256);
});

test("Node binary overrides and the original elapsed deadline fail closed", (t) => {
  const root = fixture(t);
  assert.throws(
    () => installedStaticToolInputs(root, { deadline: 0 }),
    /original validation deadline/u,
  );
  write(join(root, "node_modules/.bin/node"), "synthetic-override\n");
  assert.equal(installedStaticToolInputs(root).eligible, false);
});

test("special package files decline without blocking on a FIFO", (t) => {
  const root = fixture(t);
  execFileSync("mkfifo", [join(root, "node_modules/eslint/synthetic-fifo")]);
  assert.equal(installedStaticToolInputs(root).eligible, false);
});

test("only reviewed root configs qualify; changed imports and nested configs decline", (t) => {
  const root = fixture(t);
  assert.equal(
    staticConfigurationEligibility(root, "eslint", ["src/a.ts"]).eligible,
    true,
  );
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    true,
  );
  write(
    join(root, "eslint.config.mjs"),
    "import extra from 'unknown-plugin'; export default [extra];\n",
  );
  assert.equal(
    staticConfigurationEligibility(root, "eslint", ["src/a.ts"]).eligible,
    false,
  );
  write(join(root, "src/.prettierrc"), "{}\n");
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    false,
  );
});

test("package config/plugin fields, config symlinks and missing root configs decline", (t) => {
  const root = fixture(t);
  write(
    join(root, "src/package.json"),
    JSON.stringify({ prettier: { plugins: ["unknown-plugin"] } }),
  );
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    false,
  );
  rmSync(join(root, "src/package.json"));
  rmSync(join(root, "prettier.config.mjs"));
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    false,
  );
  symlinkSync(join(root, "src/a.ts"), join(root, "prettier.config.mjs"));
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    false,
  );
});

test("YAML package configs and unknown tool environment decline", (t) => {
  const root = fixture(t);
  write(join(root, "src/package.yaml"), "prettier: {}\n");
  assert.equal(
    staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
    false,
  );
  rmSync(join(root, "src/package.yaml"));
  const previous = process.env.PRETTIER_EXPERIMENTAL_CLI;
  try {
    process.env.PRETTIER_EXPERIMENTAL_CLI = "synthetic-enabled";
    assert.equal(
      staticConfigurationEligibility(root, "prettier", ["src/a.ts"]).eligible,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.PRETTIER_EXPERIMENTAL_CLI;
    else process.env.PRETTIER_EXPERIMENTAL_CLI = previous;
  }
});

test("pnpm PATH resolution binds executable bytes and declines unknown dispatchers", (t) => {
  const root = fixture(t),
    executable = join(root, "bin/pnpm");
  write(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  chmodSync(executable, 0o700);
  const before = pnpmExecutableInputs(root, { searchPath: join(root, "bin") });
  assert.equal(before.eligible, true);
  write(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]));
  assert.notEqual(
    pnpmExecutableInputs(root, { searchPath: join(root, "bin") }).sha256,
    before.sha256,
  );
  write(executable, "#!/bin/sh\nexec unknown-target\n");
  assert.equal(
    pnpmExecutableInputs(root, { searchPath: join(root, "bin") }).eligible,
    false,
  );
  assert.throws(
    () =>
      pnpmExecutableInputs(root, {
        deadline: 0,
        searchPath: join(root, "bin"),
      }),
    /deadline/u,
  );
});

test("static child Node dispatch declines a preceding PATH wrapper without invoking it", (t) => {
  const root = fixture(t),
    known = join(root, "known/node"),
    override = join(root, "override/node"),
    marker = join(root, "invoked");
  mkdirSync(dirname(known), { recursive: true });
  symlinkSync(process.execPath, known);
  const searchPath = `${dirname(override)}:${dirname(known)}`;
  const before = nodeExecutableInputs(root, { searchPath });
  assert.equal(before.eligible, true);
  write(override, `#!/bin/sh\ntouch '${marker}'\nexit 17\n`);
  chmodSync(override, 0o700);
  assert.deepEqual(nodeExecutableInputs(root, { searchPath }), {
    eligible: false,
    reason: "unreviewed-child-node-dispatch",
  });
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  assert.equal(
    nodeExecutableInputs(root, { searchPath: join(root, "missing") }).eligible,
    false,
  );
  assert.throws(() => nodeExecutableInputs(root, { deadline: 0 }), /deadline/u);
});

test("reviewed static shims bind actual bin bytes and reject modified bootstrap", (t) => {
  const root = fixture(t);
  for (const tool of Object.keys(toolBins)) {
    const before = staticToolDispatchInputs(root, tool);
    assert.equal(before.eligible, true);
    const closure = installedStaticToolInputs(root);
    write(
      join(root, "node_modules", tool, toolBins[tool]),
      "process.exit(7);\n",
    );
    assert.notDeepEqual(
      staticToolDispatchInputs(root, tool).inputs,
      before.inputs,
    );
    assert.notEqual(installedStaticToolInputs(root).sha256, closure.sha256);
    const shim = join(root, "node_modules/.bin", tool);
    write(shim, `# changed bootstrap\n${readFileSync(shim, "utf8")}`);
    assert.deepEqual(staticToolDispatchInputs(root, tool), {
      eligible: false,
      reason: "unreviewed-static-tool-dispatch",
    });
    assert.equal(
      reviewedStaticToolInputs(root, {
        searchPath: `${root}/node_modules/.bin:${process.env.PATH}`,
      }).eligible,
      false,
    );
    writeReviewedShim(root, tool);
  }
  assert.throws(
    () => staticToolDispatchInputs(root, "eslint", { deadline: 0 }),
    /deadline/u,
  );
});

test("static shims reject symlink launchers and symlink bin implementations", (t) => {
  const root = fixture(t),
    shim = join(root, "node_modules/.bin/eslint"),
    target = join(root, "node_modules/eslint/bin/eslint.js");
  rmSync(shim);
  symlinkSync(target, shim);
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, false);
  rmSync(shim);
  writeReviewedShim(root, "eslint");
  rmSync(target);
  symlinkSync(join(root, "src/a.ts"), target);
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, false);
  assert.equal(installedStaticToolInputs(root).eligible, false);
});

test("unknown launcher target, nonexecutable shim and changed bin declaration decline", (t) => {
  const root = fixture(t),
    shim = join(root, "node_modules/.bin/eslint");
  write(shim, '#!/bin/sh\nexec unknown-static-implementation "$@"\n');
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, false);
  assert.equal(
    reviewedStaticToolInputs(root, {
      searchPath: `${root}/node_modules/.bin:${process.env.PATH}`,
    }).eligible,
    false,
  );
  writeReviewedShim(root, "eslint");
  chmodSync(shim, 0o600);
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, false);
  chmodSync(shim, 0o700);
  packageAt(root, "eslint", { bin: { eslint: "./unknown.js" } });
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, false);
});

test("literal normalization placeholders cannot launder unknown static shims", (t) => {
  const root = fixture(t),
    tool = "eslint",
    directory = join(root, "node_modules", tool),
    shim = join(root, "node_modules/.bin", tool),
    source = readFileSync(shim, "utf8"),
    nodePath = [
      join(directory, "node_modules"),
      dirname(directory),
      join(root, "node_modules/.pnpm/node_modules"),
    ].join(":"),
    target = join(directory, "bin/eslint.js");
  // Each mutation used to normalize to the reviewed digest while its actual
  // shell dispatch/search path no longer contained the bound installation path.
  for (const [value, token] of [
    [nodePath, "<reviewed-node-path>"],
    ["../eslint/bin/eslint.js", "<reviewed-relative-target>"],
    [target, "<reviewed-absolute-target>"],
  ]) {
    assert.ok(source.includes(value));
    write(shim, source.replaceAll(value, token));
    assert.deepEqual(staticToolDispatchInputs(root, tool), {
      eligible: false,
      reason: "unreviewed-static-tool-dispatch",
    });
    assert.equal(
      reviewedStaticToolInputs(root, {
        searchPath: `${root}/node_modules/.bin:${process.env.PATH}`,
      }).eligible,
      false,
    );
  }
});

test("bootstrap refuses earlier custom launchers and helpers without executing them", (t) => {
  const root = fixture(t),
    directory = join(root, "bootstrap-override"),
    marker = join(root, "unknown-helper-invoked"),
    path = `${directory}:${root}/node_modules/.bin:${process.env.PATH}`;
  for (const name of ["eslint", "dirname", "sed", "uname"]) {
    const program = join(directory, name);
    write(program, `#!/bin/sh\ntouch '${marker}'\nexit 7\n`);
    chmodSync(program, 0o700);
    const result = reviewedStaticToolInputs(root, { searchPath: path });
    assert.equal(result.eligible, false);
    assert.equal(
      result.reason,
      name === "eslint"
        ? "unreviewed-static-tool-launcher"
        : "unreviewed-static-tool-bootstrap",
    );
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    rmSync(program);
  }
  const alias = join(directory, "eslint");
  symlinkSync(join(root, "node_modules/.bin/eslint"), alias);
  assert.deepEqual(reviewedStaticToolInputs(root, { searchPath: path }), {
    eligible: false,
    reason: "unreviewed-static-tool-launcher",
  });
  rmSync(alias);
});

test("known shim and arbitrary correctly named bin code do not establish determinism", (t) => {
  const root = fixture(t),
    external = realpathSync(
      mkdtempSync(join(tmpdir(), "static-bin-external-")),
    );
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const input = join(external, "exit-code"),
    target = join(root, "node_modules/eslint/bin/eslint.js"),
    shim = join(root, "node_modules/.bin/eslint"),
    searchPath = `${root}/node_modules/.bin:${process.env.PATH}`;
  write(input, "0");
  write(
    target,
    `const fs = require('node:fs'); process.exit(Number(fs.readFileSync(${JSON.stringify(input)}, 'utf8')));\n`,
  );
  // The finite Bash/dash bootstrap does not autoload zsh/Korn FPATH functions.
  const functions = join(external, "functions"),
    marker = join(external, "fpath-invoked");
  write(join(functions, "dirname"), `touch '${marker}'; exit 7\n`);
  const runtime = { ...process.env, PATH: searchPath, FPATH: functions };
  const before = installedStaticToolInputs(root);
  assert.equal(staticToolDispatchInputs(root, "eslint").eligible, true);
  assert.equal(
    execFileSync("/bin/sh", [shim], {
      cwd: root,
      env: runtime,
      timeout: 2000,
    }).length,
    0,
  );
  assert.deepEqual(reviewedStaticToolInputs(root, { searchPath }), {
    eligible: false,
    reason: "unreviewed-static-tool-package-closure",
  });
  write(input, "7");
  assert.throws(
    () =>
      execFileSync("/bin/sh", [shim], {
        cwd: root,
        env: runtime,
        timeout: 2000,
      }),
    (error) => error.status === 7,
  );
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  assert.equal(installedStaticToolInputs(root).sha256, before.sha256);
  assert.equal(reviewedStaticToolInputs(root, { searchPath }).eligible, false);
});

test("unknown shell, Node and native loader environment declines without output", () => {
  for (const name of [
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "ENV",
    "BASH_ENV",
    "SHELLOPTS",
    "BASH_FUNC_dirname%%",
    "NODE_OPTIONS",
  ]) {
    assert.deepEqual(
      staticToolRuntimeEligibility({ [name]: "synthetic-override" }),
      {
        eligible: false,
        reason: "unknown-static-runtime-environment",
      },
    );
  }
  assert.deepEqual(
    staticToolRuntimeEligibility({
      PATH: "synthetic-path",
      FPATH: "synthetic-zsh-functions",
      LD_PRELOAD: "",
    }),
    { eligible: true },
  );
});

test("parent and child PATH refuse symlink parent traversal before normalization", (t) => {
  const root = fixture(t),
    external = realpathSync(
      mkdtempSync(join(tmpdir(), "path-binding-external-")),
    ),
    link = join(root, "path-link");
  t.after(() => rmSync(external, { recursive: true, force: true }));
  symlinkSync(external, link);
  const path = `${link}/../usr/bin:${root}/node_modules/.bin:${process.env.PATH}`;
  assert.deepEqual(staticToolRuntimeEligibility({ PATH: path }), {
    eligible: false,
    reason: "ambiguous-static-runtime-path",
  });
  assert.deepEqual(reviewedStaticToolInputs(root, { searchPath: path }), {
    eligible: false,
    reason: "ambiguous-static-runtime-path",
  });
});
