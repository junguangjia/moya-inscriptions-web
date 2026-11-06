import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { env as processEnv } from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { classifyTask } from "./ci-task-scope.mjs";

test("the release tool's own tests pass on a fake host made from the fictional profile", () => {
  const env = { ...processEnv };
  // The private profile is for the operator's machine; CI uses the fixture.
  delete env.ARTVENN_RELEASE_PROFILE;
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(new URL("./release/tests/run_all.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 100_000, maxBuffer: 16 * 1024 * 1024, env },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test("the release tool routes through the script tests without product jobs", () => {
  const result = classifyTask(
    [
      "scripts/release/release.py",
      "scripts/release/release_host.py",
      "scripts/release/README.md",
      "scripts/release/tests/run_all.py",
      "scripts/release/tests/fixtures/profile.example.json",
      "scripts/release-tool.test.mjs",
    ],
    "local",
  );
  assert.equal(result.lightweight, true);
  assert.equal(result.web, false);
  assert.equal(result.cms, false);
  for (const path of [
    "scripts/release/deploy.sh",
    "scripts/release/tests/fixtures/profile.yaml",
    "scripts/release/vendor/lib.py",
  ])
    assert.throws(
      () => classifyTask([path], "local"),
      /Unmapped changed paths/,
    );
});
