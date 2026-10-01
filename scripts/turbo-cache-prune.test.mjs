import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import {
  GIB,
  PLAN_VERSION,
  VERIFICATION_TOOLCHAIN_ENV,
  applyPlan,
  currentTaskHashes,
  parseArgs,
  planPrune,
  resolveCacheDir,
  scanCache,
  verificationToolchain,
} from "./turbo-cache-prune.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const SCRIPT = fileURLToPath(
  new URL("./turbo-cache-prune.mjs", import.meta.url),
);
const read = (rel) =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const h = (n) => n.toString(16).padStart(16, "0");

function makeCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-cache-prune-"));
  const cacheDir = path.join(root, ".turbo", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  return { root: fs.realpathSync(root), cacheDir: fs.realpathSync(cacheDir) };
}

function writeGroup(
  cacheDir,
  hash,
  { sha = null, ageDays = 0, bytes = 1024, paths, archive = true } = {},
) {
  const files = Object.fromEntries(
    (paths ?? ["packages/contracts/dist/index.js"]).map((p) => [p, {}]),
  );
  if (archive)
    fs.writeFileSync(
      path.join(cacheDir, `${hash}.tar.zst`),
      Buffer.alloc(bytes, 1),
    );
  fs.writeFileSync(
    path.join(cacheDir, `${hash}-manifest.json`),
    JSON.stringify({ files }),
  );
  fs.writeFileSync(
    path.join(cacheDir, `${hash}-meta.json`),
    JSON.stringify({ hash, duration: 1, sha, dirty_hash: null }),
  );
  const when = new Date(NOW - ageDays * DAY);
  for (const suffix of [".tar.zst", "-manifest.json", "-meta.json"]) {
    const file = path.join(cacheDir, hash + suffix);
    if (fs.existsSync(file)) fs.utimesSync(file, when, when);
  }
  return when;
}

const deleteAllPlan = (cacheDir, extra = {}) => ({
  cacheDir,
  generatedAt: new Date(NOW).toISOString(),
  complete: true,
  ...planPrune(scanCache(cacheDir).groups, {
    budgetBytes: 0,
    keepDays: 0,
    now: NOW,
  }),
  ...extra,
});
const apply = (plan, cacheDir, options = {}) =>
  applyPlan(plan, cacheDir, { now: NOW, ...options });
const fileOutcome = (result, hash, suffix) =>
  result.results
    .find((r) => r.hash === hash)
    .files.find((f) => f.name === hash + suffix).outcome;

test("scanCache groups files per hash, flags every legacy path, reports orphans and unsafe groups", () => {
  const { cacheDir } = makeCache();
  writeGroup(cacheDir, h(1), {
    sha: "a".repeat(40),
    paths: ["apps/web/.next/cache/turbopack/x"],
  });
  writeGroup(cacheDir, h(2), { paths: ["apps/web/.next/dev/server/app.js"] });
  writeGroup(cacheDir, h(3), { paths: ["apps/admin/dist/dev/x.js"] });
  writeGroup(cacheDir, h(4), { paths: ["apps/admin/dist/cache/x.js"] });
  writeGroup(cacheDir, h(5), {
    paths: [
      "apps/admin/.next/server/app/dev/page.js",
      "apps/admin/.next/standalone/server.js",
    ],
  });
  writeGroup(cacheDir, h(6), { archive: false });
  writeGroup(cacheDir, h(7));
  fs.unlinkSync(path.join(cacheDir, `${h(7)}-meta.json`));
  fs.symlinkSync(
    path.join(cacheDir, `${h(1)}-meta.json`),
    path.join(cacheDir, `${h(7)}-meta.json`),
  );
  fs.writeFileSync(path.join(cacheDir, `${h(8)}-manifest.json.tmp`), "{}");
  const { groups, skipped } = scanCache(cacheDir);
  const by = Object.fromEntries(groups.map((g) => [g.hash, g]));
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((i) => by[h(i)].legacy),
    [true, true, true, true, false],
    ".next/cache, .next/dev, dist/dev and dist/cache are legacy; .next/server/app/dev is not",
  );
  assert.equal(by[h(1)].sha, "a".repeat(40));
  assert.equal(by[h(1)].files.length, 3);
  assert.equal(by[h(6)].orphan, true);
  assert.equal(by[h(6)].files.length, 2);
  assert.equal(
    by[h(7)],
    undefined,
    "a group with a symlinked file is skipped whole",
  );
  assert.deepEqual(
    skipped.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: h(7), reason: "not-a-regular-file" },
      { name: `${h(8)}-manifest.json.tmp`, reason: "unrecognized-name" },
    ],
  );
});

test("planPrune keeps current hashes, worktree heads and recent groups, fills the budget non-legacy and newest first, and drops old orphans", () => {
  const { cacheDir } = makeCache();
  const bytes = 4096;
  writeGroup(cacheDir, h(1), { ageDays: 30, bytes }); // current hash
  writeGroup(cacheDir, h(2), { ageDays: 30, bytes, sha: "b".repeat(40) }); // worktree head
  writeGroup(cacheDir, h(3), { ageDays: 1, bytes }); // recent
  writeGroup(cacheDir, h(4), {
    ageDays: 10,
    bytes,
    paths: ["apps/web/.next/dev/x"],
  }); // legacy, newer
  writeGroup(cacheDir, h(5), { ageDays: 20, bytes }); // plain, older
  writeGroup(cacheDir, h(6), { ageDays: 40, bytes }); // plain, oldest
  writeGroup(cacheDir, h(7), {
    ageDays: 50,
    archive: false,
    sha: "b".repeat(40),
  }); // old orphan
  writeGroup(cacheDir, h(8), { ageDays: 0, archive: false }); // fresh orphan (maybe in flight)
  const { groups } = scanCache(cacheDir);
  const unit = groups.find((g) => g.hash === h(1)).bytes;
  const plan = planPrune(groups, {
    budgetBytes: unit * 4 + groups.find((g) => g.hash === h(8)).bytes,
    keepDays: 3,
    keepHashes: new Set([h(1), h(7)]),
    keepShas: new Set(["b".repeat(40)]),
    now: NOW,
  });
  assert.equal(plan.version, PLAN_VERSION);
  const reasons = Object.fromEntries(plan.keep.map((g) => [g.hash, g.reasons]));
  assert.deepEqual(reasons[h(1)], ["current-task-hash"]);
  assert.deepEqual(reasons[h(2)], ["worktree-head"]);
  assert.deepEqual(reasons[h(3)], ["newer-than-3d"]);
  assert.deepEqual(reasons[h(5)], ["within-budget"]);
  assert.deepEqual(reasons[h(8)], ["newer-than-3d"]);
  assert.deepEqual(
    plan.delete.map((g) => [g.hash, g.reasons[0]]),
    [
      [h(7), "orphan-metadata"],
      [h(6), "over-budget"],
      [h(4), "over-budget-legacy-dev-cache"],
    ],
    "an orphan is never kept by hash or head; the legacy group loses to an older plain one; oldest first",
  );
  assert.equal(
    plan.totals.keepBytes + plan.totals.deleteBytes,
    plan.totals.bytes,
  );
  assert.ok(plan.delete.every((g) => Array.isArray(g.files) && g.files.length));
});

test("resolveCacheDir refuses anything that is not a real <root>/.turbo/cache", () => {
  const { root, cacheDir } = makeCache();
  assert.equal(resolveCacheDir(cacheDir), cacheDir);
  const other = path.join(root, "not-cache");
  fs.mkdirSync(other);
  assert.throws(() => resolveCacheDir(other), /not <root>\/\.turbo\/cache/u);
  const link = path.join(root, "linked-cache");
  fs.symlinkSync(cacheDir, link);
  assert.throws(() => resolveCacheDir(link), /not a real directory/u);
  assert.throws(() => resolveCacheDir(path.join(root, "missing")), /ENOENT/u);
});

test("applyPlan re-checks inode, size and mtime independently and never follows symlinks", () => {
  const { cacheDir } = makeCache();
  const when = {};
  for (let i = 1; i <= 5; i += 1)
    when[i] = writeGroup(cacheDir, h(i), { ageDays: 30, bytes: 2048 });
  const plan = deleteAllPlan(cacheDir);
  const arch = (i) => path.join(cacheDir, `${h(i)}.tar.zst`);
  // 2: only the inode changes (same bytes and mtime, replaced by rename).
  const tmp = path.join(cacheDir, "..", "replacement");
  fs.writeFileSync(tmp, Buffer.alloc(2048, 1));
  fs.utimesSync(tmp, when[2], when[2]);
  fs.renameSync(tmp, arch(2));
  // 3: only the size changes (same inode, mtime restored).
  fs.writeFileSync(arch(3), Buffer.alloc(4096, 1));
  fs.utimesSync(arch(3), when[3], when[3]);
  // 4: only the mtime changes (same inode and size).
  fs.utimesSync(arch(4), new Date(NOW), new Date(NOW));
  // 5: replaced by a symlink.
  fs.unlinkSync(arch(5));
  fs.symlinkSync(path.join(cacheDir, `${h(1)}-meta.json`), arch(5));
  const first = apply(plan, cacheDir);
  assert.equal(first.results.find((r) => r.hash === h(1)).outcome, "deleted");
  for (const i of [2, 3, 4]) {
    assert.equal(
      fileOutcome(first, h(i), ".tar.zst"),
      "skipped-changed",
      `group ${i}`,
    );
    assert.ok(fs.existsSync(arch(i)), `group ${i} archive kept`);
  }
  assert.equal(fileOutcome(first, h(5), ".tar.zst"), "skipped-not-regular");
  assert.ok(fs.lstatSync(arch(5)).isSymbolicLink());
  const second = apply(plan, cacheDir);
  assert.equal(
    second.results.find((r) => r.hash === h(1)).outcome,
    "already-absent",
  );
  assert.equal(second.deletedBytes, 0);
});

test("applyPlan validates the whole plan before deleting anything", () => {
  const { cacheDir } = makeCache();
  for (let i = 1; i <= 3; i += 1) writeGroup(cacheDir, h(i), { ageDays: 30 });
  const plan = deleteAllPlan(cacheDir);
  const unlinked = [];
  const unlink = (f) => unlinked.push(f);
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(plan));
    fn(copy);
    return copy;
  };
  assert.throws(
    () => apply(plan, path.dirname(cacheDir), { unlink }),
    /Plan is for/u,
  );
  assert.throws(
    () => apply({ version: 1, delete: [] }, cacheDir, { unlink }),
    /Not a v2 prune plan/u,
  );
  assert.throws(
    () =>
      apply(
        mutate((p) => (p.delete[2].hash = "../../etc/passwd")),
        cacheDir,
        { unlink },
      ),
    /Invalid hash in plan/u,
  );
  assert.throws(
    () =>
      apply(
        mutate((p) => (p.delete[2].files[0].name = `${h(1)}.tar.zst`)),
        cacheDir,
        { unlink },
      ),
    /Invalid file in plan/u,
    "a file name must belong to its own group's hash",
  );
  assert.throws(
    () =>
      apply(
        mutate(
          (p) =>
            (p.delete[2].files[0].name = `../${p.delete[2].files[0].name}`),
        ),
        cacheDir,
        { unlink },
      ),
    /Invalid file in plan/u,
  );
  assert.throws(
    () =>
      apply(
        mutate((p) => (p.delete[2].files = [])),
        cacheDir,
        { unlink },
      ),
    /No files/u,
  );
  assert.deepEqual(unlinked, [], "nothing was unlinked by any rejected plan");
});

test("applyPlan refuses incomplete or stale plans unless allowed, and skips groups that became a worktree HEAD", () => {
  const { cacheDir } = makeCache();
  writeGroup(cacheDir, h(1), { ageDays: 30, sha: "c".repeat(40) });
  writeGroup(cacheDir, h(2), { ageDays: 30 });
  const unlink = () => {};
  assert.throws(
    () =>
      apply(
        deleteAllPlan(cacheDir, { complete: false, incompleteReason: "x" }),
        cacheDir,
        { unlink },
      ),
    /incomplete \(x\)/u,
  );
  assert.doesNotThrow(() =>
    apply(deleteAllPlan(cacheDir, { complete: false }), cacheDir, {
      unlink,
      allowIncomplete: true,
    }),
  );
  const stale = deleteAllPlan(cacheDir, {
    generatedAt: new Date(NOW - 2 * DAY).toISOString(),
  });
  assert.throws(() => apply(stale, cacheDir, { unlink }), /older than 24 h/u);
  assert.throws(
    () =>
      apply(deleteAllPlan(cacheDir, { generatedAt: "not a date" }), cacheDir, {
        unlink,
      }),
    /older than/u,
  );
  assert.doesNotThrow(() =>
    apply(stale, cacheDir, { unlink, allowStale: true }),
  );
  const result = apply(deleteAllPlan(cacheDir), cacheDir, {
    protectShas: new Set(["c".repeat(40)]),
  });
  assert.equal(
    result.results.find((r) => r.hash === h(1)).outcome,
    "skipped-now-worktree-head",
  );
  assert.ok(fs.existsSync(path.join(cacheDir, `${h(1)}.tar.zst`)));
  assert.equal(result.results.find((r) => r.hash === h(2)).outcome, "deleted");
});

test("applyPlan honours the batch limit oldest first and records unlink failures without aborting", () => {
  const { cacheDir } = makeCache();
  for (let i = 1; i <= 3; i += 1)
    writeGroup(cacheDir, h(i), { ageDays: 30 + i, bytes: 8192 });
  const plan = deleteAllPlan(cacheDir);
  assert.equal(plan.delete[0].hash, h(3), "oldest group first");
  const limited = apply(plan, cacheDir, { maxBytes: 1, unlink: () => {} });
  assert.equal(
    limited.results.filter((r) => r.outcome === "deleted").length,
    1,
  );
  assert.equal(
    limited.results.filter((r) => r.outcome === "deferred-batch-limit").length,
    2,
  );
  let calls = 0;
  const flaky = (file) => {
    calls += 1;
    if (file.endsWith(`${h(3)}.tar.zst`))
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    if (file.endsWith(`${h(2)}.tar.zst`))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  const result = apply(plan, cacheDir, { unlink: flaky });
  assert.equal(calls, 9, "every planned file was attempted");
  assert.equal(fileOutcome(result, h(3), ".tar.zst"), "already-absent");
  assert.equal(fileOutcome(result, h(2), ".tar.zst"), "failed");
  assert.equal(result.results.find((r) => r.hash === h(2)).outcome, "partial");
  assert.equal(result.results.find((r) => r.hash === h(1)).outcome, "deleted");
});

test("currentTaskHashes unions plain and verification dry runs and reports skipped and failed worktrees", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-cache-prune-wt-"));
  const dirs = ["ok", "broken", "no-turbo"].map((n) => path.join(base, n));
  for (const d of dirs.slice(0, 2)) {
    fs.mkdirSync(path.join(d, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules", ".bin", "turbo"), "");
  }
  fs.mkdirSync(dirs[2]);
  const calls = [];
  const run = (bin, dir, tasks, toolchain) => {
    calls.push([path.basename(dir), toolchain]);
    if (dir.endsWith("broken")) throw new Error("turbo exploded\nstack");
    return toolchain ? [h(2), h(3)] : [h(1), h(2)];
  };
  const r = currentTaskHashes(dirs, { run, toolchain: "v0/test/arch" });
  assert.deepEqual([...r.hashes].sort(), [h(1), h(2), h(3)]);
  assert.deepEqual(calls, [
    ["ok", null],
    ["ok", "v0/test/arch"],
    ["broken", null],
  ]);
  assert.deepEqual(r.covered, [dirs[0]]);
  assert.deepEqual(r.skipped, [{ dir: dirs[2], reason: "no-turbo-binary" }]);
  assert.deepEqual(r.failed, [{ dir: dirs[1], error: "turbo exploded" }]);
});

test("the verification toolchain value matches what the verification entries set", () => {
  assert.equal(VERIFICATION_TOOLCHAIN_ENV, "MOYA_VERIFICATION_TOOLCHAIN");
  assert.equal(
    verificationToolchain(),
    `${process.version}/${process.platform}/${process.arch}`,
  );
  const assignment =
    "process.env.MOYA_VERIFICATION_TOOLCHAIN = `${process.version}/${process.platform}/${process.arch}`;";
  for (const file of [
    "./verify.mjs",
    "./verify-task.mjs",
    "./editorial/verify-cms.mjs",
  ])
    assert.ok(
      read(file).includes(assignment),
      `${file} still sets the same toolchain value`,
    );
});

test("turbo.json: build excludes compiler and dev caches, and admin#build is build plus the dist exclusions", () => {
  const { tasks } = JSON.parse(read("../turbo.json"));
  for (const glob of [
    ".next/**",
    "!.next/cache/**",
    "!.next/dev/**",
    "dist/**",
  ])
    assert.ok(tasks.build.outputs.includes(glob), glob);
  assert.deepEqual(tasks["admin#build"], {
    ...tasks.build,
    outputs: [...tasks.build.outputs, "!dist/cache/**", "!dist/dev/**"],
  });
});

test("parseArgs accepts a leading -- and rejects unknown or malformed input", () => {
  assert.deepEqual(
    (({ mode, budgetGib, keepDays, planFile }) => ({
      mode,
      budgetGib,
      keepDays,
      planFile,
    }))(
      parseArgs([
        "--",
        "plan",
        "--budget-gib",
        "5",
        "--keep-days",
        "1",
        "--plan-file",
        "p.json",
      ]),
    ),
    { mode: "plan", budgetGib: 5, keepDays: 1, planFile: "p.json" },
  );
  const a = parseArgs([
    "--",
    "apply",
    "--from-plan",
    "p",
    "--allow-stale",
    "--allow-incomplete",
    "--max-gib",
    "2",
  ]);
  assert.equal(a.mode, "apply");
  assert.equal(a.maxGib, 2);
  assert.ok(a.allowStale && a.allowIncomplete && !a.allowActive);
  assert.equal(parseArgs([]).mode, "plan");
  assert.throws(() => parseArgs(["plan", "--"]), /Unknown argument: --/u);
  assert.throws(() => parseArgs(["plan", "--bogus"]), /Unknown argument/u);
  assert.throws(() => parseArgs(["plan", "--budget-gib"]), /Missing value/u);
  assert.throws(
    () => parseArgs(["plan", "--budget-gib", "-1"]),
    /Invalid numeric/u,
  );
});

test("CLI: pnpm-style `--` works, an incomplete plan is refused, and an explicit override applies it", () => {
  const { root, cacheDir } = makeCache();
  execFileSync("git", ["init", "-q", root]);
  writeGroup(cacheDir, h(1), { ageDays: 30 });
  const planFile = path.join(root, "plan.json");
  const node = (...args) =>
    spawnSync(process.execPath, [SCRIPT, "--", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const plan = node(
    "plan",
    "--cache-dir",
    cacheDir,
    "--skip-dry-run",
    "--budget-gib",
    "0",
    "--plan-file",
    planFile,
  );
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stderr, /INCOMPLETE: dry runs skipped/u);
  const written = JSON.parse(fs.readFileSync(planFile, "utf8"));
  assert.equal(written.complete, false);
  assert.equal(written.totals.deleteGroups, 1);
  const refused = node(
    "apply",
    "--cache-dir",
    cacheDir,
    "--from-plan",
    planFile,
    "--allow-active",
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /incomplete/u);
  assert.ok(fs.existsSync(path.join(cacheDir, `${h(1)}.tar.zst`)));
  const applied = node(
    "apply",
    "--cache-dir",
    cacheDir,
    "--from-plan",
    planFile,
    "--allow-active",
    "--allow-incomplete",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).results[0].outcome, "deleted");
  assert.ok(!fs.existsSync(path.join(cacheDir, `${h(1)}.tar.zst`)));
});

test("GIB is a binary gibibyte", () => {
  assert.equal(GIB, 1073741824);
});
