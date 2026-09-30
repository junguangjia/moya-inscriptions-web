import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  pnpmExecutableInputs,
  staticConfigurationEligibility,
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
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "static-tool-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    const pkg = join(root, "node_modules", name);
    write(
      join(pkg, "package.json"),
      JSON.stringify({ name, version: "synthetic-1", main: "index.js" }),
    );
    write(join(pkg, "index.js"), "module.exports = {};\n");
  }
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
    JSON.stringify({ name, version: "synthetic-1", main: "index.js", ...pkg }),
  );
  write(join(root, "node_modules", name, "index.js"), "module.exports = {};\n");
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
    JSON.stringify({ name: "eslint", version: "synthetic-1" }),
  );
  write(join(internal, "index.js"), "internal-install\n");
  rmSync(join(root, "node_modules/eslint"), { recursive: true });
  symlinkSync(internal, join(root, "node_modules/eslint"));
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
