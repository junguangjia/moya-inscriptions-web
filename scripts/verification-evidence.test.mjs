import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import {
  EVIDENCE_VERSION,
  evidenceToolchain,
  staticCheckFiles,
  checkInputIdentity,
  reuseDecision,
  readReuseSummary,
} from "./verification-evidence.mjs";

import {
  installedStaticToolInputs,
  nodeExecutableInputs,
} from "./verification-tool-inputs.mjs";

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

function installReviewedStaticTool(root, tool) {
  const bin = tool === "eslint" ? "bin/eslint.js" : "bin/prettier.cjs",
    directory = join(root, "node_modules", tool),
    shim = join(root, "node_modules/.bin", tool);
  mkdirSync(join(directory, "bin"), { recursive: true });
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: tool,
      version: "synthetic-1",
      bin: { [tool]: `./${bin}` },
    }),
  );
  writeFileSync(join(directory, bin), "process.exit(0);\n");
  writeFileSync(shim, renderCapturedShim(root, tool, directory));
  chmodSync(shim, 0o700);
}

test("reuse permits only explicit read-only static file checks", () => {
  assert.deepEqual(
    staticCheckFiles(["pnpm", "exec", "prettier", "--check", "docs/a.md"]),
    ["docs/a.md"],
  );
  for (const command of [
    ["pnpm", "exec", "eslint", "--fix", "a.ts"],
    ["pnpm", "exec", "eslint", "../a.ts"],
    ["pnpm", "exec", "eslint", "**/*.ts"],
    ["pnpm", "exec", "vitest", "run", "a.test.ts"],
    ["pnpm", "exec", "prettier", "--write", "a.ts"],
    ["pnpm", "typecheck"],
  ])
    assert.equal(staticCheckFiles(command), null);
});

test("input identity accepts independently known supported installs and otherwise refuses", () => {
  // The raw closure is the original descriptive hash, not the eligibility layer
  // under test. Controlled PATH removes any prerequisite on installed pnpm.
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url))),
    childPath = `${root}/node_modules/.bin:${dirname(process.execPath)}:/usr/bin:/bin`,
    raw = installedStaticToolInputs(root),
    command = ["pnpm", "exec", "eslint", "scripts/verification-evidence.mjs"],
    toolchain = {
      node: "synthetic-v1",
      childPath,
      staticTools: { eligible: true, sha256: "synthetic-installed-closure" },
      pnpmExecutable: { eligible: true, sha256: "synthetic-pnpm-executable" },
      childNode: { eligible: true, sha256: "synthetic-child-node" },
    },
    options = {
      root,
      files: ["scripts/verification-evidence.mjs", "eslint.config.mjs"],
      toolchain,
    };
  let supported =
    raw.eligible === true &&
    raw.sha256 ===
      "778bae93448a712d32ae1ba01b0e206a4bd6c67fb9265eefc509d84024829a99" &&
    ["darwin", "linux"].includes(process.platform) &&
    !(process.env.PATH ?? "")
      .split(":")
      .some((directory) => directory.split("/").includes("..")) &&
    !Object.keys(process.env).some(
      (name) =>
        process.env[name] &&
        (/^(?:LD_|DYLD_|BASH_FUNC_)/u.test(name) ||
          [
            "ENV",
            "BASH_ENV",
            "SHELLOPTS",
            "BASHOPTS",
            "NODE_OPTIONS",
            "NODE_PATH",
          ].includes(name)),
    );
  if (supported) {
    // Independently establish literal fixture/bootstrap facts; never branch on
    // new dispatch/reviewed eligibility, so always-ineligible code fails here.
    try {
      supported =
        nodeExecutableInputs(root, { searchPath: childPath }).eligible === true;
      for (const tool of ["eslint", "prettier"]) {
        const shim = join(root, "node_modules/.bin", tool),
          info = lstatSync(shim),
          directory = realpathSync(join(root, "node_modules", tool));
        supported &&=
          info.isFile() &&
          (info.mode & 0o111) !== 0 &&
          readFileSync(shim, "utf8") ===
            renderCapturedShim(root, tool, directory);
      }
      for (const directory of [
        join(root, "node_modules/.bin"),
        dirname(process.execPath),
      ]) {
        for (const name of ["dirname", "sed", "uname"])
          try {
            if (lstatSync(join(directory, name)).mode & 0o111)
              supported = false;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
      }
      for (const name of ["node", "node.exe"])
        try {
          lstatSync(join(root, "node_modules/.bin", name));
          supported = false;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      const shell = realpathSync("/bin/sh"),
        native = (path) => {
          const info = lstatSync(path);
          return (
            info.isFile() &&
            (info.mode & 0o111) !== 0 &&
            info.size <= 32 * 1024 * 1024 &&
            [
              "7f454c46",
              "cffaedfe",
              "feedfacf",
              "cefaedfe",
              "feedface",
              "cafebabe",
              "bebafeca",
            ].includes(readFileSync(path).subarray(0, 4).toString("hex"))
          );
        };
      supported &&=
        (process.platform === "darwin"
          ? ["/bin/sh", "/bin/bash"]
          : [
              "/usr/bin/dash",
              "/usr/bin/bash",
              "/bin/dash",
              "/bin/bash",
              "/bin/sh",
            ]
        ).includes(shell) && native(shell);
      for (const name of ["dirname", "sed", "uname"])
        supported &&=
          realpathSync(`/usr/bin/${name}`) === `/usr/bin/${name}` &&
          native(`/usr/bin/${name}`);
      if (supported)
        supported = !/(?:CYGWIN|MINGW|MSYS|WSL2)/iu.test(
          execFileSync("/usr/bin/uname", ["-a"], {
            timeout: 2000,
            encoding: "utf8",
          }),
        );
    } catch {
      supported = false;
    }
  }
  const identity = checkInputIdentity(command, options);
  if (!supported) {
    assert.equal(identity.eligible, false);
    return; // Explicit fail-closed assertion for absent/independently unsupported installs.
  }
  assert.equal(identity.eligible, true);
  assert.deepEqual(checkInputIdentity(command, options), identity);
  assert.equal(
    checkInputIdentity(command, {
      ...options,
      toolchain: {
        ...toolchain,
        childNode: {
          eligible: false,
          reason: "unreviewed-child-node-dispatch",
        },
      },
    }).eligible,
    false,
  );
  assert.notEqual(
    checkInputIdentity(command, {
      ...options,
      files: [...options.files, "scripts/verification-tool-inputs.mjs"],
    }).inputSha256,
    identity.inputSha256,
  );
  assert.notEqual(
    checkInputIdentity(
      [...command, "scripts/verification-tool-inputs.mjs"],
      options,
    ).inputSha256,
    identity.inputSha256,
  );
  assert.notEqual(
    checkInputIdentity(command, {
      ...options,
      toolchain: { ...toolchain, node: "synthetic-v2" },
    }).inputSha256,
    identity.inputSha256,
  );
  assert.throws(
    () => checkInputIdentity(command, { ...options, deadline: 0 }),
    /deadline/,
  );
});

test("missing static install toolchain refuses without unconditional manifest reads", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "evidence-without-dependencies-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolchain = evidenceToolchain(root);
  assert.equal(toolchain.staticTools.eligible, false);
  assert.equal(toolchain.eslint, "unbound");
  assert.equal(toolchain.prettier, "unbound");
  assert.equal(
    checkInputIdentity(["pnpm", "exec", "eslint", "src/a.ts"], {
      root,
      files: [],
      toolchain,
    }).eligible,
    false,
  );
});

test("only successful individually executed checks reuse; feedback status never authorizes acceptance", () => {
  const command = ["pnpm", "exec", "eslint", "a.ts"];
  const toolchain = { node: "synthetic-v1" },
    inputs = [{ file: "a.ts", sha256: "synthetic-content" }];
  const inputSha256 = createHash("sha256")
    .update(
      JSON.stringify({ version: EVIDENCE_VERSION, command, toolchain, inputs }),
    )
    .digest("hex");
  const identity = { eligible: true, inputSha256, command, inputs };
  const head = "a".repeat(40),
    contentBefore = { head, stagedDiffSha256: "synthetic" };
  const source = {
    evidenceVersion: EVIDENCE_VERSION,
    contentUnchanged: true,
    mode: "feedback",
    acceptance: false,
    head,
    contentBefore,
    contentAfter: contentBefore,
    toolchain,
    sourceFingerprint: createHash("sha256")
      .update(JSON.stringify(contentBefore))
      .digest("hex"),
    commands: [command],
    checkEvidence: [{ ...identity, index: 0 }],
    executed: [{ index: 0, code: 0, durationMs: 12, command }],
  };
  const decision = reuseDecision(identity, command, source, {
    sha256: "synthetic-summary",
  });
  assert.equal(decision.reused, true);
  assert.equal(
    reuseDecision(identity, command, {
      ...source,
      checkEvidence: [{ ...identity }],
      executed: [{ code: 0, command }],
    }).reused,
    false,
  );
  assert.equal(
    reuseDecision(identity, command, { ...source, sourceFingerprint: "forged" })
      .reused,
    false,
  );
  assert.equal(decision.sourceHead, head);
  assert.equal(
    reuseDecision(identity, command, { ...source, contentUnchanged: false })
      .reused,
    false,
  );
  assert.equal(
    reuseDecision(identity, command, {
      ...source,
      executed: [{ index: 0, code: 1, durationMs: 12, command }],
    }).reused,
    false,
  );
  assert.equal(
    reuseDecision(identity, command, { ...source, executed: [] }).reused,
    false,
  );
  assert.equal(
    reuseDecision({ ...identity, inputSha256: "changed" }, command, source)
      .reason,
    "command-toolchain-or-inputs-changed",
  );
  assert.equal(
    reuseDecision({ eligible: false, reason: "database" }, command, source)
      .reused,
    false,
  );
});

test("source summaries reject special files, excessive size and malformed data without exposing contents", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reuse-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "summary.json");
  writeFileSync(file, "synthetic malformed private prefix", { mode: 0o600 });
  assert.throws(() => readReuseSummary(file), {
    message: "Reuse summary JSON is invalid",
  });
  const linked = join(directory, "linked");
  symlinkSync(file, linked);
  assert.throws(() => readReuseSummary(linked), /non-symlink/);
  truncateSync(file, 17 * 1024 * 1024);
  assert.throws(() => readReuseSummary(file), /size limit/);
  const fifo = join(directory, "fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => readReuseSummary(fifo), /regular/);
  writeFileSync(file, "{}", { mode: 0o600 });
  assert.throws(() => readReuseSummary(file, { deadline: 0 }), /deadline/);
});

test("unchanged custom launcher and changed external implementation never reuse", (t) => {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "verification-custom-shim-")),
    ),
    external = realpathSync(
      mkdtempSync(join(tmpdir(), "verification-external-tool-")),
    );
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(root, "eslint.config.mjs"),
    readFileSync(new URL("../eslint.config.mjs", import.meta.url)),
  );
  installReviewedStaticTool(root, "eslint");
  const command = ["pnpm", "exec", "eslint", "src/a.ts"],
    toolchain = {
      node: "synthetic-v1",
      staticTools: { eligible: true, sha256: "synthetic-installed-closure" },
      pnpmExecutable: { eligible: true, sha256: "synthetic-pnpm-executable" },
      childNode: { eligible: true, sha256: "synthetic-child-node" },
    },
    options = { root, files: ["src/a.ts", "eslint.config.mjs"], toolchain },
    target = join(external, "implementation.cjs"),
    shim = join(root, "node_modules/.bin/eslint"),
    shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(target, "process.exit(0);\n");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`,
  );
  const unchangedShim = readFileSync(shim);
  assert.equal(
    spawnSync("/bin/sh", [shim, "src/a.ts"], { cwd: root, timeout: 2000 })
      .status,
    0,
  );
  // A valid old summary describes the actual successful check. Its old identity
  // did not bind the external target, even with an eligible synthetic toolchain.
  const inputs = [
    ...new Set([
      ...options.files,
      "node_modules/.pnpm/lock.yaml",
      "node_modules/.bin/eslint",
      "node_modules/.bin/prettier",
    ]),
  ]
    .sort()
    .map((file) => {
      const path = join(root, file);
      try {
        return {
          file,
          mode: lstatSync(path).mode,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { file, missing: true };
      }
    });
  const inputSha256 = createHash("sha256")
      .update(
        JSON.stringify({
          version: EVIDENCE_VERSION,
          command,
          toolchain,
          inputs,
        }),
      )
      .digest("hex"),
    head = "a".repeat(40),
    contentBefore = { head, stagedDiffSha256: "synthetic" },
    source = {
      evidenceVersion: EVIDENCE_VERSION,
      contentUnchanged: true,
      head,
      contentBefore,
      contentAfter: contentBefore,
      toolchain,
      sourceFingerprint: createHash("sha256")
        .update(JSON.stringify(contentBefore))
        .digest("hex"),
      commands: [command],
      checkEvidence: [
        { eligible: true, inputSha256, command, inputs, index: 0 },
      ],
      executed: [{ index: 0, code: 0, durationMs: 1, command }],
    };
  assert.deepEqual(checkInputIdentity(command, options), {
    eligible: false,
    reason: "unreviewed-static-tool-dispatch",
  });
  writeFileSync(target, "process.exit(7);\n");
  assert.equal(
    spawnSync("/bin/sh", [shim, "src/a.ts"], { cwd: root, timeout: 2000 })
      .status,
    7,
  );
  assert.deepEqual(readFileSync(shim), unchangedShim);
  const identity = checkInputIdentity(command, options);
  assert.equal(identity.eligible, false);
  assert.deepEqual(reuseDecision(identity, command, source), {
    reused: false,
    reason: "unreviewed-static-tool-dispatch",
  });
});
