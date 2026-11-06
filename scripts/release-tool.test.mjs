import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { env as processEnv } from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { classifyTask } from "./ci-task-scope.mjs";

test("the release tool's own tests pass on a fake host made from the fictional profile", () => {
  const env = { ...processEnv };
  // The private profile is for the operator's machine; CI uses the fixture.
  // The lightweight job runs every script test under the script-tests
  // profile (scripts/validation-profiles.mjs, 120 s for the whole run), so
  // this run's own ceiling stays inside it and a hang is reported here.
  delete env.ARTVENN_RELEASE_PROFILE;
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(new URL("./release/tests/run_all.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 110_000, maxBuffer: 16 * 1024 * 1024, env },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test("new migrations sort after main's latest, only expand, and new CMS ones extract", () => {
  // The release tool applies migrations forward only, before any service
  // starts on the new code, and runs a CMS migration's own SQL: a migration
  // that sorts before main's latest, drops, renames or tightens, or hides its
  // SQL behind sql.raw or ${} cannot be released. CI's lightweight job names
  // the task's base; elsewhere main as last fetched.
  const sha = processEnv.BASE_SHA ?? "";
  const base =
    /^[0-9a-f]{40}$/u.test(sha) && !/^0+$/u.test(sha) ? sha : "origin/main";
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(new URL("./release/release.py", import.meta.url)),
      "check-migrations",
      "--base",
      base,
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"status": "PASS"/u);
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

test("release files never name the App role key the composition root owns", () => {
  // community-v1-freeze test 5 scans these extensions under scripts/, but a
  // scripts-only change runs only the script tests, so the same rule is here.
  const root = fileURLToPath(new URL("./release/", import.meta.url));
  const scanned = /\.(?:[cm]?[jt]sx?|json|sql|md|ya?ml|sh|example)$/u;
  // Joined so this file does not name the key itself.
  const key = ["APP", "DATABASE", "URL"].join("_");
  const offenders = readdirSync(root, { recursive: true })
    .filter((name) => scanned.test(name))
    .filter((name) =>
      readFileSync(path.join(root, name), "utf8").includes(key),
    );
  assert.deepEqual(offenders, []);
});
