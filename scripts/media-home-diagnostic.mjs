import { spawn, execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers";

export const SOURCE = "d9d9b5756a92feb5d446c4c84fd7f77f3a5d2618";
export const TREE = "7d2336e2685a0cd3545d268530ce66d15ff8b164";
export const ORIGINAL_SPEC =
  "bd33a438d2d43db58d2fd6e425616d72de904b095016dfff46989064508f8a03";
export const TITLE =
  "Home preserves independent Discover, Nearby, and Calligraphy scroll positions";
export const PHASES = [
  "init",
  "seed.begin",
  "seed.baseline",
  "initial.before",
  "initial.after",
  "restore.before",
  "matcher",
  "restore.matched",
  "settings.before",
  "settings.after",
  "destination.before",
  "destination.after",
  "final.before",
  "final.after",
  "end",
];
export const FEEDS = ["discover", "nearby", "inscriptions", "calligraphy"];
export const FIELDS = [
  "seq",
  "t_ms",
  "phase",
  "tag",
  "iteration",
  "requested_feed",
  "feed",
  "expected_arg",
  "owner",
  "home_owner",
  "pager_owner",
  "outer_owner",
  "masonry_owner",
  "active_feed",
  "scroll_top",
  "scroll_height",
  "client_height",
  "max_top",
  "pager_left",
  "outer_top",
  "layout_ready",
  "layout_retained",
  "test_marker_matches",
  "connected",
  "active_owner",
  "active_top",
];
const SPEC = "tests/e2e/t02p-development-acceptance.spec.ts";
const SUPPORT = "tests/e2e/support";
const sha = (body) => createHash("sha256").update(body).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });

export function admit(env, currentSha, currentTree) {
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/codex/media-home-d9-diagnostic" ||
    !/^[a-f0-9]{40}$/.test(env.HOME_WORKFLOW_SHA ?? "") ||
    env.GITHUB_SHA !== env.HOME_WORKFLOW_SHA ||
    !/^[a-f0-9-]{36}$/.test(env.HOME_TASK_KEY ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    currentSha !== SOURCE ||
    currentTree !== TREE
  )
    throw new Error("IDENTITY_REJECTED");
  return {
    workflow_sha: env.GITHUB_SHA,
    source_sha: SOURCE,
    source_tree: TREE,
    task: env.HOME_TASK_KEY,
    run: env.GITHUB_RUN_ID,
    attempt: 1,
  };
}

export function selectedTests(native) {
  const found = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        found.push({ title: spec.title, test });
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of native.suites ?? []) walk(suite);
  if (
    found.length !== 1 ||
    found[0].title !== TITLE ||
    found[0].test.projectName !== "tablet-webkit"
  )
    throw new Error("CASE_SELECTION_REJECTED");
  return found[0].test;
}

export function approvedAnonymousIdentity(commitAuthor) {
  const [name, email, ...extra] = commitAuthor.trim().split("\0");
  if (
    extra.length ||
    !name ||
    /[\r\n<>]/.test(name) ||
    !/^[A-Za-z0-9+._-]+@users\.noreply\.github\.com$/.test(email ?? "")
  )
    throw new Error("APPROVED_COMMIT_IDENTITY_REJECTED");
  return { name, email };
}

export function coreCheckCategory(code) {
  return code === 2
    ? "OUTBOUND_CHECK_INCOMPLETE"
    : code === 1
      ? "OUTBOUND_CHECK_BLOCKED"
      : "OUTBOUND_CHECK_EXECUTION_FAILED";
}

export function sanitizeSnapshot(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 384 ||
    !Array.isArray(value.slots) ||
    value.slots.length > 128
  )
    throw new Error("SNAPSHOT_SCHEMA_REJECTED");
  for (const row of value.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== FIELDS.length ||
      row.some(
        (x) =>
          x !== null &&
          typeof x !== "boolean" &&
          (typeof x !== "number" || !Number.isFinite(x)),
      )
    )
      throw new Error("ROW_SCHEMA_REJECTED");
    for (const [at, maximum] of [
      [2, 14],
      [3, 5],
      [4, 3],
      [5, 3],
      [6, 3],
    ])
      if (!Number.isInteger(row[at]) || row[at] < 0 || row[at] > maximum)
        throw new Error("ROW_ROUTE_REJECTED");
    if (
      row[13] !== null &&
      (!Number.isInteger(row[13]) || row[13] < 0 || row[13] > 3)
    )
      throw new Error("ROW_ROUTE_REJECTED");
  }
  if (
    !Array.isArray(value.documentLabel) ||
    value.documentLabel.length !== 2 ||
    value.documentLabel.some(
      (n) => !Number.isInteger(n) || n < 0 || n > 4294967295,
    )
  )
    throw new Error("DOCUMENT_LABEL_REJECTED");
  const counters = {};
  for (const key of ["seen", "invalid", "slotOverflow"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0)
      throw new Error("COUNTER_REJECTED");
    counters[key] = value[key];
  }
  const slots = value.slots.map((slot) => {
    if (
      !/^(?:[0-9]|1[0-4])\.[0-3]\.[0-3]\.[0-3]$/.test(slot.key) ||
      !Number.isInteger(slot.samples) ||
      !Number.isInteger(slot.retained) ||
      slot.samples < slot.retained ||
      slot.retained < 1 ||
      slot.retained > 3
    )
      throw new Error("SLOT_REJECTED");
    return {
      key: slot.key,
      samples: slot.samples,
      retained: slot.retained,
      omitted: slot.samples - slot.retained,
    };
  });
  return {
    schema: 1,
    document_label: value.documentLabel,
    rows: value.rows,
    slots,
    ...counters,
  };
}

function procTable() {
  const result = new Map();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z")
        result.set(Number(pid), {
          parent: Number(fields[1]),
          started: fields[19],
        });
    } catch {
      /* Exited between directory/stat observations. */
    }
  }
  return result;
}

async function bounded(command, args, cwd, env, raw, name, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 10000)
    return { state: "DEADLINE_EXCEEDED", code: 124, elapsed_ms: 0 };
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(join(raw, `${name}.log`), "wx", 0o600);
  const start = Date.now();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  const known = new Map();
  let exited = false;
  let code = null;
  let failedStart = false;
  child.on("error", () => {
    failedStart = true;
    exited = true;
  });
  child.on("exit", (value) => {
    code = value;
    exited = true;
  });
  const remember = () => {
    const table = procTable();
    const root = table.get(child.pid);
    if (root && !known.has(child.pid)) known.set(child.pid, root.started);
    for (let more = true; more;) {
      more = false;
      for (const [pid, entry] of table)
        if (
          !known.has(pid) &&
          known.has(entry.parent) &&
          table.get(entry.parent)?.started === known.get(entry.parent)
        ) {
          known.set(pid, entry.started);
          more = true;
        }
    }
    return [...known]
      .filter(([pid, started]) => table.get(pid)?.started === started)
      .map(([pid]) => pid);
  };
  const tick = () => new Promise((done) => setTimeout(done, 100));
  while (!exited && Date.now() < deadline - 10000) {
    remember();
    await tick();
  }
  const expired = !exited;
  const cleanupDeadline = Math.min(deadline, Date.now() + 10000);
  const signal = (value) => {
    for (const pid of remember().reverse())
      try {
        process.kill(pid, value);
      } catch {
        /* Exited or no longer owned. */
      }
  };
  signal("SIGTERM");
  const graceful = Math.min(cleanupDeadline, Date.now() + 5000);
  while (remember().length && Date.now() < graceful) await tick();
  signal("SIGKILL");
  while (remember().length && Date.now() < cleanupDeadline) await tick();
  return {
    state: failedStart
      ? "START_FAILED"
      : expired
        ? "DEADLINE_EXCEEDED"
        : "COMPLETED",
    code: expired ? 124 : code,
    elapsed_ms: Date.now() - start,
    remaining_owned_processes: remember().length,
  };
}

function runtimeContext() {
  if (process.platform !== "linux") throw new Error("LINUX_ONLY");
  const workflow = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = resolve(workflow, "../source");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  const identity = admit(
    process.env,
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
  );
  const privateRoot = join(source, ".local", "media-home", identity.task);
  const raw = join(privateRoot, "raw");
  const publicRoot = join(privateRoot, "sanitized");
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
  const env = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "PNPM_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "XDG_CACHE_HOME",
    "TMPDIR",
  ])
    if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    CI: "true",
    MOYA_E2E_SOURCE_HEAD: SOURCE,
    MOYA_E2E_CHECKOUT_SHA: SOURCE,
    MOYA_E2E_CHECKOUT_TREE: TREE,
    GITHUB_RUN_ID: identity.run,
    GITHUB_RUN_ATTEMPT: "1",
    MOYA_E2E_ARTIFACT_DIR: raw,
    MOYA_HOME_DIAGNOSTIC_DIR: raw,
    MOYA_E2E_WEB_PORT: "37450",
    MOYA_E2E_PUBLIC_API_PORT: "37451",
    MOYA_E2E_PAGING_WEB_PORT: "37452",
  });
  return { workflow, source, identity, raw, publicRoot, env, git };
}

async function execute(mode) {
  const c = runtimeContext();
  if (mode === "prepare") {
    const deadline = Number(process.env.HOME_PREP_DEADLINE_MS);
    if (!Number.isFinite(deadline) || deadline > Date.now() + 600000)
      throw new Error("PREPARATION_DEADLINE_REJECTED");
    save(join(c.raw, "identity.json"), c.identity);
    // A fresh disposable source clone reuses the author of this controlled,
    // reviewed commit. It does not choose an identity or change global config.
    const author = approvedAnonymousIdentity(
      execFileSync(
        "git",
        ["show", "-s", "--format=%an%x00%ae", c.identity.workflow_sha],
        { cwd: c.workflow, encoding: "utf8", timeout: 5000 },
      ),
    );
    c.git("config", "--local", "user.name", author.name);
    c.git("config", "--local", "user.email", author.email);
    c.git("config", "--local", "user.useConfigOnly", "true");
    const installed = await bounded(
      "node",
      [
        "scripts/install-confidentiality-hooks.mjs",
        "--confirm-current-identity-approved",
      ],
      c.source,
      c.env,
      c.raw,
      "core-install",
      Math.min(deadline, Date.now() + 40000),
    );
    save(join(c.raw, "core-install-result.json"), installed);
    if (installed.code !== 0 || installed.remaining_owned_processes)
      throw new Error("CONTROLLED_CHECKER_PROVISION_FAILED");
    const probePath = join(c.raw, "synthetic-outbound-probe.json");
    save(probePath, {
      kind: "SYNTHETIC_TOOLING_PREFLIGHT_ONLY",
      acceptance_pass: false,
    });
    const probe = await bounded(
      "node",
      ["scripts/confidentiality-scan.mjs", "outbound", probePath],
      c.source,
      {
        ...c.env,
        CONFIDENTIALITY_BATCH_ID: `home-diagnostic-${c.identity.run}-1`,
      },
      c.raw,
      "core-probe",
      Math.min(deadline, Date.now() + 30000),
    );
    save(join(c.raw, "core-probe-result.json"), probe);
    if (probe.code !== 0 || probe.remaining_owned_processes)
      throw new Error(coreCheckCategory(probe.code));
    console.log(
      JSON.stringify({
        state: "CHECKED_SYNTHETIC_PREFLIGHT_PASSED",
        acceptance_pass: false,
      }),
    );
    for (const [name, args] of [
      ["install", ["install", "--frozen-lockfile"]],
      [
        "browser",
        [
          "--filter",
          "@moya/tests",
          "exec",
          "playwright",
          "install",
          "--with-deps",
          "webkit",
        ],
      ],
    ]) {
      const outcome = await bounded(
        "pnpm",
        args,
        c.source,
        c.env,
        c.raw,
        name,
        deadline,
      );
      save(join(c.raw, `${name}-result.json`), outcome);
      if (outcome.code !== 0 || outcome.remaining_owned_processes)
        return outcome.code || 1;
    }
    return 0;
  }
  if (mode === "run") {
    if (
      JSON.stringify(json(join(c.raw, "identity.json"))) !==
        JSON.stringify(c.identity) ||
      json(join(c.raw, "browser-result.json")).code !== 0
    )
      throw new Error("PREPARATION_NOT_COMPLETE");
    if (
      sha(readFileSync(join(c.source, SPEC))) !== ORIGINAL_SPEC ||
      c.git("status", "--porcelain")
    )
      throw new Error("SOURCE_PREIMAGE_REJECTED");
    const patch = join(c.workflow, SUPPORT, "home-causal-spec.patch");
    execFileSync("git", ["apply", "--check", patch], {
      cwd: c.source,
      timeout: 5000,
    });
    execFileSync("git", ["apply", patch], { cwd: c.source, timeout: 5000 });
    copyFileSync(
      join(c.workflow, SUPPORT, "home-causal-recorder.ts"),
      join(c.source, SUPPORT, "home-causal-recorder.ts"),
    );
    const config = join(c.source, SUPPORT, "home-causal.config.mts");
    writeFileSync(
      config,
      `import base from '../playwright.config';\nexport default {...base, projects:base.projects.filter(p=>p.name==='tablet-webkit').map(p=>({...p,testMatch:'t02p-development-acceptance.spec.ts',grep:/Home preserves independent Discover, Nearby, and Calligraphy scroll positions$/}))};\n`,
    );
    save(join(c.raw, "overlay.json"), {
      source_file_sha256: sha(readFileSync(join(c.source, SPEC))),
      patch_sha256: sha(readFileSync(patch)),
      recorder_sha256: sha(
        readFileSync(join(c.workflow, SUPPORT, "home-causal-recorder.ts")),
      ),
    });
    const args = [
      "--filter",
      "@moya/tests",
      "exec",
      "playwright",
      "test",
      "--config",
      "e2e/support/home-causal.config.mts",
      "--reporter=json",
    ];
    const deadline = Date.now() + 300000;
    const list = await bounded(
      "pnpm",
      [...args, "--list"],
      c.source,
      { ...c.env, PLAYWRIGHT_JSON_OUTPUT_FILE: join(c.raw, "selected.json") },
      c.raw,
      "list",
      Math.min(deadline, Date.now() + 40000),
    );
    if (list.code !== 0) return list.code || 1;
    const planned = json(join(c.raw, "selected.json"));
    selectedTests(planned);
    if (
      planned.config.workers !== 1 ||
      planned.config.globalTimeout !== 1080000 ||
      planned.config.projects[0].timeout !== 30000 ||
      planned.config.projects[0].retries !== 1
    )
      throw new Error("NATIVE_CONFIG_REJECTED");
    const outcome = await bounded(
      "pnpm",
      args,
      c.source,
      { ...c.env, PLAYWRIGHT_JSON_OUTPUT_FILE: join(c.raw, "native.json") },
      c.raw,
      "native",
      deadline,
    );
    save(join(c.raw, "execution.json"), outcome);
    console.log(
      JSON.stringify({
        state: "NATIVE_WRAPPER_TERMINAL",
        execution: outcome,
        acceptance_pass: false,
      }),
    );
    return outcome.code || (outcome.remaining_owned_processes ? 1 : 0);
  }
  if (mode !== "publish") throw new Error("OPERATION_REJECTED");
  const packet = {
    kind: "SANITIZED_DIAGNOSTIC_ONLY_NOT_ACCEPTANCE",
    identity: c.identity,
    platform: "GitHub Linux hosted runner",
    source_file: SPEC,
    source_file_sha256: ORIGINAL_SPEC,
    case: TITLE,
    project: "tablet-webkit",
    row_fields: FIELDS,
    phase_dictionary: PHASES,
    feed_dictionary: FEEDS,
    tag_dictionary: [
      "checkpoint",
      "write",
      "read",
      "scroll",
      "active.change",
      "aligned",
    ],
    attempts: [],
    state: "NATIVE_REPORT_MISSING",
    acceptance_pass: false,
    full_context_uploaded: false,
    raw_originals_after_runner_disposal:
      "NOT_RETAINED; only selected sanitized records are published",
    original_source_ranges: {
      helper: [121, 286],
      producer: [1898, 1918],
      matcher: [1979, 1991],
    },
  };
  packet.identity.workflow_blob = execFileSync(
    "git",
    ["rev-parse", "HEAD:.github/workflows/ci.yml"],
    { cwd: c.workflow, encoding: "utf8", timeout: 5000 },
  ).trim();
  packet.row_clock =
    "browser performance.now within document_label, not hosted wall-clock or another attempt";
  packet.owner_scope =
    "non-authorizing document_label plus per-document WeakMap owner";
  if (existsSync(join(c.raw, "overlay.json")))
    packet.overlay = json(join(c.raw, "overlay.json"));
  if (existsSync(join(c.raw, "execution.json")))
    packet.execution = json(join(c.raw, "execution.json"));
  let nativeAttempts = [];
  const reportPath = join(c.raw, "native.json");
  if (existsSync(reportPath)) {
    if (statSync(reportPath).size > 16777216)
      packet.state = "NATIVE_REPORT_OVERSIZED";
    else {
      try {
        const rawReport = readFileSync(reportPath);
        packet.native_report_sha256 = sha(rawReport);
        const test = selectedTests(JSON.parse(rawReport));
        if (
          !["passed", "failed", "skipped"].includes(test.expectedStatus) ||
          !["expected", "unexpected", "flaky", "skipped"].includes(
            test.status,
          ) ||
          !Array.isArray(test.results) ||
          test.results.length > 2 ||
          test.results.some(
            (attempt) =>
              ![0, 1].includes(attempt.retry) ||
              !Number.isFinite(attempt.duration) ||
              attempt.duration < 0 ||
              ![
                "passed",
                "failed",
                "timedOut",
                "skipped",
                "interrupted",
              ].includes(attempt.status),
          )
        )
          throw new Error("NATIVE_RESULT_REJECTED");
        packet.expected_status = test.expectedStatus;
        packet.native_status = test.status;
        packet.state = "NATIVE_RESULT_RECORDED";
        nativeAttempts = test.results;
      } catch {
        packet.state = "NATIVE_REPORT_INVALID_OR_SELECTION_REJECTED";
      }
    }
  }
  // A missing or incomplete native footer must not discard already saved scalars.
  for (const retry of [0, 1]) {
    const attempt = nativeAttempts.find((result) => result.retry === retry);
    const path = join(c.raw, `retry-${retry}.json`);
    if (!attempt && !existsSync(path)) continue;
    const entry = {
      retry,
      status: attempt?.status ?? "NATIVE_STATUS_MISSING",
      duration_ms: attempt?.duration ?? null,
      capture_available: false,
      capture_state: "MISSING",
    };
    if (existsSync(path)) {
      if (statSync(path).size > 131072) entry.capture_state = "OVERSIZED";
      else {
        try {
          const bytes = readFileSync(path);
          const value = JSON.parse(bytes);
          if (
            value.project !== "tablet-webkit" ||
            value.retry !== retry ||
            typeof value.finalSnapshot !== "boolean"
          )
            throw new Error("RETRY_PACKET_REJECTED");
          if (
            !Array.isArray(value.writeReturns) ||
            value.writeReturns.length > 3 ||
            value.writeReturns.some(
              (r) =>
                !Array.isArray(r) ||
                r.length !== 4 ||
                ![0, 1, 3].includes(r[0]) ||
                !Number.isFinite(r[1]) ||
                r
                  .slice(2)
                  .some((n) => !Number.isInteger(n) || n < 0 || n > 4294967295),
            )
          )
            throw new Error("WRITE_RETURN_REJECTED");
          if (
            !Number.isInteger(value.documentChanges) ||
            value.documentChanges < 0
          )
            throw new Error("DOCUMENT_CHANGE_REJECTED");
          const snapshot =
            value.snapshot === null ? null : sanitizeSnapshot(value.snapshot);
          Object.assign(entry, {
            write_return_fields: [
              "feed",
              "test_helper_returned_top",
              "document_label_0",
              "document_label_1",
            ],
            write_returns: value.writeReturns,
            snapshot,
            final_snapshot: value.finalSnapshot,
            document_changes: value.documentChanges,
            capture_available: snapshot !== null,
            capture_state:
              snapshot === null
                ? "NO_SNAPSHOT"
                : "RECORDED_FIRST_LAST_AND_FIRST_DIVERGENCE",
            original_packet_sha256: sha(bytes),
            original_file: `retry-${retry}.json`,
            original_rows_pointer: "/snapshot/rows",
          });
        } catch {
          entry.capture_state = "INVALID";
        }
      }
    }
    packet.attempts.push(entry);
  }
  const body = `${JSON.stringify(packet)}\n`;
  if (Buffer.byteLength(body) > 131072)
    throw new Error("SANITIZED_PACKET_TOO_LARGE");
  const destination = join(c.publicRoot, "packet.json");
  const staged = join(c.raw, "packet-to-check.json");
  writeFileSync(staged, body, { mode: 0o600 });
  const scan = await bounded(
    "node",
    ["scripts/confidentiality-scan.mjs", "outbound", staged],
    c.source,
    {
      ...c.env,
      CONFIDENTIALITY_BATCH_ID: `home-diagnostic-${c.identity.run}-1`,
    },
    c.raw,
    "core-outbound",
    Date.now() + 30000,
  );
  if (scan.code !== 0) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(staged);
    throw new Error(coreCheckCategory(scan.code));
  }
  renameSync(staged, destination);
  console.log(
    JSON.stringify({
      state: packet.state,
      run: c.identity.run,
      attempt: 1,
      packet_sha256: sha(body),
      packet_bytes: Buffer.byteLength(body),
      acceptance_pass: false,
    }),
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await execute(process.argv[2]);
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "DIAGNOSTIC_REJECTED",
        category: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "INTERNAL_FAILURE_NO_RAW_OUTPUT",
        acceptance_pass: false,
      }),
    );
    process.exitCode = 1;
  }
}
