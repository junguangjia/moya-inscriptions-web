#!/usr/bin/env node
/**
 * Budgeted, dry-run-by-default maintenance for the shared local Turborepo
 * cache (`<repo>/.turbo/cache`, shared by every linked worktree).
 *
 *   node scripts/turbo-cache-prune.mjs plan  [--budget-gib 10] [--keep-days 3]
 *        [--plan-file <path>] [--hashes-file <path>] [--skip-dry-run] [--json]
 *   node scripts/turbo-cache-prune.mjs apply --from-plan <plan.json>
 *        [--max-gib <n>] [--result-file <path>] [--allow-active]
 *        [--allow-stale] [--allow-incomplete]
 *
 * A leading `--` (as `pnpm cache:prune -- plan …` passes it) is ignored.
 *
 * `plan` never deletes. It keeps an archive group when any existing registered
 * worktree currently produces its task hash (read-only `turbo --dry-run`, run
 * once plainly and once with the verification toolchain variable that
 * `scripts/verify.mjs` sets), when its meta records a worktree's current HEAD,
 * or when it is newer than the retention window. Remaining groups are then
 * kept newest first while they fit the size budget, non-legacy before legacy
 * (legacy = archives holding compiler or development caches). A plan is
 * marked incomplete when a worktree that has Turbo fails its dry run.
 *
 * `apply` deletes exactly the reviewed plan. It refuses an incomplete plan or
 * one older than 24 hours without an explicit flag, validates every planned
 * name before deleting anything, skips any group whose commit has since become
 * a worktree HEAD, re-checks each file's identity, and is idempotent.
 *
 * Recovery for a deleted archive is a rebuild; nothing here is source.
 * This is a workstation policy, not a Turbo requirement, and it is not a lock:
 * a concurrent `turbo run` is refused by a best-effort check only.
 */
import { execFileSync } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GIB = 1024 ** 3;
export const PLAN_VERSION = 2;
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const HASH_RE = /^[0-9a-f]{16}$/u;
export const SUFFIXES = Object.freeze([
  ".tar.zst",
  "-manifest.json",
  "-meta.json",
]);
export const DEV_CACHE_RE = /(?:^|\/)(?:\.next|dist)\/(?:cache|dev)\//u;
export const TASKS = Object.freeze(["build", "lint", "typecheck", "test"]);
export const VERIFICATION_TOOLCHAIN_ENV = "MOYA_VERIFICATION_TOOLCHAIN";
const ENTRY_RE = /^([0-9a-f]{16})(\.tar\.zst|-manifest\.json|-meta\.json)$/u;

/**
 * The value scripts/verify.mjs, scripts/verify-task.mjs and
 * scripts/editorial/verify-cms.mjs assign before running Turbo. It is a
 * Turbo `globalEnv`, so it changes every task hash; the test file asserts the
 * three scripts still use this exact expression.
 */
export const verificationToolchain = () =>
  `${process.version}/${process.platform}/${process.arch}`;

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

/** The main checkout that owns `.turbo/cache` for every linked worktree. */
export function repoRootFrom(cwd = process.cwd()) {
  const common = git(cwd, "rev-parse", "--git-common-dir").trim();
  return path.dirname(fs.realpathSync(path.resolve(cwd, common)));
}

/** Resolves and guards the cache directory: a real `.turbo/cache` directory. */
export function resolveCacheDir(explicit, cwd = process.cwd()) {
  const candidate = explicit
    ? path.resolve(cwd, explicit)
    : path.join(repoRootFrom(cwd), ".turbo", "cache");
  const st = fs.lstatSync(candidate);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`Cache directory is not a real directory: ${candidate}`);
  const real = fs.realpathSync(candidate);
  if (
    path.basename(real) !== "cache" ||
    path.basename(path.dirname(real)) !== ".turbo"
  )
    throw new Error(
      `Refusing a directory that is not <root>/.turbo/cache: ${real}`,
    );
  return real;
}

/** HEAD of every registered worktree whose directory still exists. */
export function worktreeHeads(repoRoot) {
  const heads = new Set();
  const dirs = [];
  let current = null;
  const flush = () => {
    if (current?.head && fs.existsSync(current.dir)) {
      heads.add(current.head);
      dirs.push(current.dir);
    }
    current = null;
  };
  for (const line of git(repoRoot, "worktree", "list", "--porcelain").split(
    "\n",
  )) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { dir: line.slice(9), head: null };
    } else if (line.startsWith("HEAD ") && current)
      current.head = line.slice(5);
    else if (line === "") flush();
  }
  flush();
  return { heads, dirs };
}

/** One read-only `turbo run --dry-run=json`; returns that run's task hashes. */
export function turboDryRun(bin, dir, tasks, toolchain) {
  const env = { ...process.env };
  if (toolchain) env[VERIFICATION_TOOLCHAIN_ENV] = toolchain;
  else delete env[VERIFICATION_TOOLCHAIN_ENV];
  const out = execFileSync(
    bin,
    [
      "run",
      ...tasks,
      "--dry-run=json",
      "--cache=local:r",
      "--no-update-notifier",
    ],
    {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const json = JSON.parse(out.slice(out.indexOf("{")));
  const hashes = (json.tasks ?? [])
    .map((task) => task.hash)
    .filter((hash) => HASH_RE.test(hash));
  if (!hashes.length) throw new Error("dry run reported no task hashes");
  return hashes;
}

/**
 * Task hashes each existing worktree would use today, for an ordinary run and
 * for a verification run. Worktrees without Turbo are reported as skipped; a
 * failing dry run is reported as failed and makes the plan incomplete.
 */
export function currentTaskHashes(
  dirs,
  {
    tasks = TASKS,
    run = turboDryRun,
    toolchain = verificationToolchain(),
  } = {},
) {
  const hashes = new Set();
  const covered = [];
  const skipped = [];
  const failed = [];
  for (const dir of dirs) {
    const bin = path.join(dir, "node_modules", ".bin", "turbo");
    if (!fs.existsSync(bin)) {
      skipped.push({ dir, reason: "no-turbo-binary" });
      continue;
    }
    try {
      const found = [
        ...run(bin, dir, tasks, null),
        ...run(bin, dir, tasks, toolchain),
      ];
      for (const hash of found) hashes.add(hash);
      covered.push(dir);
    } catch (error) {
      failed.push({ dir, error: String(error.message).split("\n")[0] });
    }
  }
  return { hashes, covered, skipped, failed };
}

const lstatFile = (dir, name) => {
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir || !ENTRY_RE.test(name)) return null;
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return { name, unsafe: true };
  return {
    name,
    size: st.size,
    allocated: st.blocks * 512,
    ino: st.ino,
    dev: st.dev,
    mtimeMs: st.mtimeMs,
  };
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Groups `<hash>.tar.zst` + `-manifest.json` + `-meta.json`. Metadata left
 * without its archive is reported as an orphan group. Any group with a
 * non-regular file (for example a symlink) is skipped as a whole.
 */
export function scanCache(cacheDir) {
  const groups = [];
  const skipped = [];
  const hashes = new Set();
  for (const name of fs.readdirSync(cacheDir).sort()) {
    const match = ENTRY_RE.exec(name);
    if (match) hashes.add(match[1]);
    else skipped.push({ name, reason: "unrecognized-name" });
  }
  for (const hash of [...hashes].sort()) {
    const files = SUFFIXES.map((suffix) =>
      lstatFile(cacheDir, hash + suffix),
    ).filter(Boolean);
    if (files.some((f) => f.unsafe)) {
      skipped.push({ name: hash, reason: "not-a-regular-file" });
      continue;
    }
    const archive = files.find((f) => f.name.endsWith(".tar.zst"));
    const meta = readJson(path.join(cacheDir, `${hash}-meta.json`));
    const manifest = archive
      ? readJson(path.join(cacheDir, `${hash}-manifest.json`))
      : null;
    groups.push({
      hash,
      sha: typeof meta?.sha === "string" ? meta.sha : null,
      legacy: Object.keys(manifest?.files ?? {}).some((p) =>
        DEV_CACHE_RE.test(p),
      ),
      orphan: !archive,
      mtimeMs: archive
        ? archive.mtimeMs
        : Math.max(...files.map((f) => f.mtimeMs)),
      bytes: files.reduce((sum, f) => sum + f.allocated, 0),
      files,
    });
  }
  return { groups, skipped };
}

/** Pure retention decision. */
export function planPrune(groups, policy) {
  const {
    budgetBytes,
    keepDays,
    keepHashes = new Set(),
    keepShas = new Set(),
    now = Date.now(),
  } = policy;
  const cutoff = now - keepDays * 86_400_000;
  const keep = [];
  const rest = [];
  const del = [];
  for (const g of groups) {
    const reasons = [];
    if (!g.orphan && keepHashes.has(g.hash)) reasons.push("current-task-hash");
    if (!g.orphan && g.sha && keepShas.has(g.sha))
      reasons.push("worktree-head");
    if (g.mtimeMs >= cutoff) reasons.push(`newer-than-${keepDays}d`);
    if (reasons.length) keep.push({ ...g, reasons });
    else if (g.orphan) del.push({ ...g, reasons: ["orphan-metadata"] });
    else rest.push(g);
  }
  let used = keep.reduce((s, g) => s + g.bytes, 0);
  // Newest first, non-legacy before legacy. A group that does not fit is
  // skipped, so a smaller, older group may still fill the remainder.
  rest.sort(
    (a, b) => Number(a.legacy) - Number(b.legacy) || b.mtimeMs - a.mtimeMs,
  );
  for (const g of rest) {
    if (used + g.bytes <= budgetBytes) {
      used += g.bytes;
      keep.push({ ...g, reasons: ["within-budget"] });
    } else
      del.push({
        ...g,
        reasons: [g.legacy ? "over-budget-legacy-dev-cache" : "over-budget"],
      });
  }
  del.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const total = groups.reduce((s, g) => s + g.bytes, 0);
  const deleteBytes = del.reduce((s, g) => s + g.bytes, 0);
  const summary = (g) => ({
    hash: g.hash,
    sha: g.sha,
    legacy: g.legacy,
    orphan: g.orphan,
    bytes: g.bytes,
    reasons: g.reasons,
    mtimeMs: g.mtimeMs,
    mtime: new Date(g.mtimeMs).toISOString(),
  });
  return {
    version: PLAN_VERSION,
    policy: {
      budgetBytes,
      keepDays,
      keepHashes: keepHashes.size,
      keepShas: keepShas.size,
    },
    totals: {
      groups: groups.length,
      bytes: total,
      keepGroups: keep.length,
      keepBytes: total - deleteBytes,
      deleteGroups: del.length,
      deleteBytes,
    },
    keep: keep.map(summary),
    delete: del.map((g) => ({ ...summary(g), files: g.files })),
  };
}

/** Best-effort quiescence signal; documented as a check, not a proof. */
export function activeWriters(
  cacheDir,
  { windowMs = 30_000, now = Date.now() } = {},
) {
  const signals = [];
  try {
    const pids = execFileSync("pgrep", ["-x", "turbo"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (pids) signals.push(`turbo processes: ${pids.split("\n").join(",")}`);
  } catch {
    /* no matching process */
  }
  for (const name of fs.readdirSync(cacheDir)) {
    const st = fs.lstatSync(path.join(cacheDir, name));
    if (now - st.mtimeMs < windowMs) {
      signals.push(`recent write: ${name}`);
      break;
    }
  }
  return signals;
}

/** Throws unless every planned group and file name is well formed. */
function assertPlanShape(plan, cacheDir) {
  if (plan?.version !== PLAN_VERSION || !Array.isArray(plan.delete))
    throw new Error(`Not a v${PLAN_VERSION} prune plan`);
  if (plan.cacheDir !== cacheDir)
    throw new Error(`Plan is for ${plan.cacheDir}, not ${cacheDir}`);
  for (const group of plan.delete) {
    if (typeof group?.hash !== "string" || !HASH_RE.test(group.hash))
      throw new Error(`Invalid hash in plan: ${group?.hash}`);
    if (!Array.isArray(group.files) || !group.files.length)
      throw new Error(`No files for ${group.hash} in plan`);
    for (const planned of group.files) {
      const match = ENTRY_RE.exec(planned?.name ?? "");
      if (!match || match[1] !== group.hash)
        throw new Error(`Invalid file in plan: ${planned?.name}`);
      if (path.dirname(path.join(cacheDir, planned.name)) !== cacheDir)
        throw new Error(`Escapes cache dir: ${planned.name}`);
    }
  }
}

/**
 * Deletes exactly the reviewed groups; re-checks identity; idempotent.
 * `maxBytes` stops after the group that crosses the limit, so one batch can
 * exceed it by at most one group.
 */
export function applyPlan(
  plan,
  cacheDir,
  {
    maxBytes = Infinity,
    unlink = fs.unlinkSync,
    now = Date.now(),
    maxAgeMs = PLAN_MAX_AGE_MS,
    allowStale = false,
    allowIncomplete = false,
    protectShas = new Set(),
  } = {},
) {
  assertPlanShape(plan, cacheDir);
  if (plan.complete !== true && !allowIncomplete)
    throw new Error(
      `Plan is incomplete (${plan.incompleteReason ?? "unknown"}); review it and pass --allow-incomplete to apply anyway`,
    );
  const generated = Date.parse(plan.generatedAt);
  if (!allowStale && !(now - generated <= maxAgeMs))
    throw new Error(
      `Plan generated at ${plan.generatedAt} is older than ${maxAgeMs / 3_600_000} h; plan again or pass --allow-stale`,
    );
  const results = [];
  let deletedBytes = 0;
  let deletedLogicalBytes = 0;
  for (const group of plan.delete) {
    if (deletedBytes >= maxBytes) {
      results.push({ hash: group.hash, outcome: "deferred-batch-limit" });
      continue;
    }
    if (group.sha && protectShas.has(group.sha)) {
      results.push({ hash: group.hash, outcome: "skipped-now-worktree-head" });
      continue;
    }
    const outcomes = [];
    for (const planned of group.files) {
      const file = path.join(cacheDir, planned.name);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (error) {
        outcomes.push({
          name: planned.name,
          outcome: error.code === "ENOENT" ? "already-absent" : "failed",
          ...(error.code === "ENOENT" ? {} : { code: error.code }),
        });
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        outcomes.push({ name: planned.name, outcome: "skipped-not-regular" });
        continue;
      }
      if (
        st.ino !== planned.ino ||
        st.dev !== planned.dev ||
        st.size !== planned.size ||
        st.mtimeMs !== planned.mtimeMs
      ) {
        outcomes.push({ name: planned.name, outcome: "skipped-changed" });
        continue;
      }
      try {
        unlink(file);
      } catch (error) {
        outcomes.push({
          name: planned.name,
          outcome: error.code === "ENOENT" ? "already-absent" : "failed",
          ...(error.code === "ENOENT" ? {} : { code: error.code }),
        });
        continue;
      }
      deletedBytes += planned.allocated;
      deletedLogicalBytes += planned.size;
      outcomes.push({
        name: planned.name,
        outcome: "deleted",
        bytes: planned.allocated,
      });
    }
    results.push({
      hash: group.hash,
      outcome: outcomes.every((o) => o.outcome === "deleted")
        ? "deleted"
        : outcomes.every((o) => o.outcome === "already-absent")
          ? "already-absent"
          : "partial",
      files: outcomes,
    });
  }
  return { deletedBytes, deletedLogicalBytes, results };
}

export function parseArgs(argv) {
  const opts = {
    mode: "plan",
    budgetGib: 10,
    keepDays: 3,
    json: false,
    skipDryRun: false,
    allowActive: false,
    allowStale: false,
    allowIncomplete: false,
    maxGib: Infinity,
  };
  const rest = [...argv];
  if (rest[0] === "--") rest.shift();
  if (rest[0] === "plan" || rest[0] === "apply") opts.mode = rest.shift();
  while (rest.length) {
    const arg = rest.shift();
    const value = () => {
      const v = rest.shift();
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    if (arg === "--budget-gib") opts.budgetGib = Number(value());
    else if (arg === "--keep-days") opts.keepDays = Number(value());
    else if (arg === "--max-gib") opts.maxGib = Number(value());
    else if (arg === "--cache-dir") opts.cacheDir = value();
    else if (arg === "--plan-file") opts.planFile = value();
    else if (arg === "--from-plan") opts.fromPlan = value();
    else if (arg === "--result-file") opts.resultFile = value();
    else if (arg === "--hashes-file") opts.hashesFile = value();
    else if (arg === "--skip-dry-run") opts.skipDryRun = true;
    else if (arg === "--allow-active") opts.allowActive = true;
    else if (arg === "--allow-stale") opts.allowStale = true;
    else if (arg === "--allow-incomplete") opts.allowIncomplete = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const [k, v] of Object.entries({
    budgetGib: opts.budgetGib,
    keepDays: opts.keepDays,
    maxGib: opts.maxGib,
  }))
    if (!(v >= 0)) throw new Error(`Invalid numeric option ${k}`);
  return opts;
}

const fmt = (bytes) => `${(bytes / GIB).toFixed(3)} GiB`;

export function main(argv) {
  const opts = parseArgs(argv);
  const cacheDir = resolveCacheDir(opts.cacheDir);
  const repoRoot = path.dirname(path.dirname(cacheDir));
  const warn = (m) => console.error(`turbo-cache-prune: ${m}`);
  if (opts.mode === "plan") {
    const { heads, dirs } = worktreeHeads(repoRoot);
    const keepHashes = new Set();
    if (opts.hashesFile)
      for (const h of fs.readFileSync(opts.hashesFile, "utf8").split("\n"))
        if (HASH_RE.test(h.trim())) keepHashes.add(h.trim());
    let coverage = { covered: [], skipped: [], failed: [] };
    if (!opts.skipDryRun) {
      const r = currentTaskHashes(dirs);
      for (const h of r.hashes) keepHashes.add(h);
      coverage = r;
    }
    const incompleteReason = opts.skipDryRun
      ? "dry runs skipped"
      : coverage.failed.length
        ? `${coverage.failed.length} worktree dry run(s) failed`
        : null;
    const { groups, skipped } = scanCache(cacheDir);
    const plan = {
      generatedAt: new Date().toISOString(),
      cacheDir,
      complete: incompleteReason === null,
      incompleteReason,
      worktrees: {
        registeredExisting: dirs.length,
        dryRunCovered: coverage.covered.length,
        heads: heads.size,
        verificationToolchain: verificationToolchain(),
        covered: coverage.covered,
        skipped: coverage.skipped,
        failed: coverage.failed,
      },
      ...planPrune(groups, {
        budgetBytes: opts.budgetGib * GIB,
        keepDays: opts.keepDays,
        keepHashes,
        keepShas: heads,
      }),
      skipped,
    };
    if (opts.planFile)
      fs.writeFileSync(opts.planFile, JSON.stringify(plan, null, 2), {
        mode: 0o600,
      });
    for (const f of coverage.failed)
      warn(`dry run failed in ${f.dir}: ${f.error}`);
    if (!plan.complete) warn(`plan is INCOMPLETE: ${incompleteReason}`);
    if (opts.json) console.log(JSON.stringify(plan));
    else {
      const t = plan.totals;
      console.log(`turbo cache ${cacheDir}`);
      console.log(
        `groups ${t.groups} (${fmt(t.bytes)}) · keep ${t.keepGroups} (${fmt(t.keepBytes)}) · delete ${t.deleteGroups} (${fmt(t.deleteBytes)})`,
      );
      console.log(
        `keep reasons: current task hashes ${keepHashes.size} from ${coverage.covered.length} worktree dry runs (${coverage.skipped.length} without Turbo, ${coverage.failed.length} failed); ${heads.size} worktree HEADs; newer than ${opts.keepDays}d; budget ${opts.budgetGib} GiB`,
      );
      if (skipped.length)
        console.log(
          `skipped entries: ${skipped.length} (${skipped
            .map((s) => s.name)
            .slice(0, 5)
            .join(", ")}${skipped.length > 5 ? ", …" : ""})`,
        );
      console.log(
        opts.planFile
          ? `plan written: ${opts.planFile}`
          : "dry run only; pass --plan-file to write a reviewable plan, then apply --from-plan",
      );
    }
    return 0;
  }
  if (!opts.fromPlan) throw new Error("apply requires --from-plan <plan.json>");
  const plan = JSON.parse(fs.readFileSync(opts.fromPlan, "utf8"));
  const signals = activeWriters(cacheDir);
  if (signals.length && !opts.allowActive)
    throw new Error(
      `Cache may be in use (${signals.join("; ")}); rerun when quiet or pass --allow-active`,
    );
  const result = {
    appliedAt: new Date().toISOString(),
    cacheDir,
    fromPlan: path.resolve(opts.fromPlan),
    maxBytes: opts.maxGib * GIB,
    ...applyPlan(plan, cacheDir, {
      maxBytes: opts.maxGib * GIB,
      allowStale: opts.allowStale,
      allowIncomplete: opts.allowIncomplete,
      protectShas: worktreeHeads(repoRoot).heads,
    }),
  };
  if (opts.resultFile)
    fs.writeFileSync(opts.resultFile, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
  const counts = {};
  for (const r of result.results)
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  if (opts.json) console.log(JSON.stringify(result));
  else
    console.log(
      `applied: ${JSON.stringify(counts)} · freed ${fmt(result.deletedBytes)} allocated (${fmt(result.deletedLogicalBytes)} logical)${opts.resultFile ? ` · result ${opts.resultFile}` : ""}`,
    );
  return result.results.some((r) =>
    r.files?.some((f) => f.outcome === "failed"),
  )
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`turbo-cache-prune: ${error.message}`);
    process.exitCode = 1;
  }
}
