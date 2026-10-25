import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { classifyTask } from "./ci-task-scope.mjs";

test("runtime artifact and retention use real Python stdlib filesystem regressions", () => {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("./operations/test-runtime-tools.py", import.meta.url),
      ),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test("exact runtime tooling routes through script tests without unrelated product jobs", () => {
  const result = classifyTask(
    [
      "scripts/operations/runtime-artifact.py",
      "scripts/operations/runtime-retention.py",
      "scripts/operations/test-runtime-tools.py",
      "scripts/runtime-artifact.test.mjs",
      "docs/deployment/runtime-artifact-retention.md",
    ],
    "local",
  );
  assert.equal(result.lightweight, true);
  assert.equal(result.web, false);
  assert.equal(result.cms, false);
});
