import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import {
  EVIDENCE_VERSION,
  staticCheckFiles,
  checkInputIdentity,
  reuseDecision,
  readReuseSummary,
} from "./verification-evidence.mjs";

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

test("input identities invalidate on source inventory, config, command and toolchain changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "verification-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(root, "eslint.config.mjs"),
    readFileSync(new URL("../eslint.config.mjs", import.meta.url)),
  );
  const command = ["pnpm", "exec", "eslint", "src/a.ts"];
  const options = {
    root,
    files: ["src/a.ts", "eslint.config.mjs"],
    toolchain: {
      node: "synthetic-v1",
      staticTools: { eligible: true, sha256: "synthetic-installed-closure" },
      pnpmExecutable: { eligible: true, sha256: "synthetic-pnpm-executable" },
      childNode: { eligible: true, sha256: "synthetic-child-node" },
    },
  };
  const identity = checkInputIdentity(command, options);
  assert.equal(identity.eligible, true);
  assert.deepEqual(checkInputIdentity(command, options), identity);
  assert.equal(
    checkInputIdentity(command, {
      ...options,
      toolchain: {
        ...options.toolchain,
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
      toolchain: { ...options.toolchain, node: "synthetic-v2" },
    }).inputSha256,
    identity.inputSha256,
  );
  writeFileSync(join(root, "eslint.config.mjs"), "export default [{}];\n");
  assert.notEqual(
    checkInputIdentity(command, options).inputSha256,
    identity.inputSha256,
  );
  assert.throws(
    () => checkInputIdentity(command, { ...options, deadline: 0 }),
    /deadline/,
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
