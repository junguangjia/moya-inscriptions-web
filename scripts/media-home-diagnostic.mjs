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

export const SOURCE = "97c594d7702794b0ba869d9c86a1c9513f4e727b";
export const TREE = "23fba8310bcab3ab0dd5b9ccc40aa76dbd8446bd";
export const ORIGINAL_SPEC =
  "4b6b8a3b1fc96061cf3c322fc80b041bcdbae5631026c316ce6dc3969a5a7562";
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
export const READINESS_FIELDS = [
  "seq",
  "body_elapsed_ms",
  "call",
  "phase",
  "feed",
  "event",
  "active_feed",
  "layout_ready",
  "layout_retained",
  "image_total",
  "image_loaded",
  "image_pending",
  "image_failed",
  "media_terminal",
  "geometry_ok",
  "geometry_delta",
  "stable_frames",
  "signature_matches_prior_stability_signature",
  "signature_changed_mask",
  "all_guards_ready",
  "scroll_top",
  "client_height",
];
export const READINESS_SIGNATURE_KEYS = [
  "activeFeed",
  "anchorX",
  "anchorY",
  "images",
  "items",
  "layoutReady",
  "layoutRetained",
  "masonryColumns",
  "masonryHeight",
  "masonryHeightMinusMaxItemBottom",
  "masonryWidth",
  "mediaStates",
  "scrollTop",
];
const readinessRoutes = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0, 3],
  [1, 3],
  [2, 0],
  [2, 1],
  [2, 3],
];
export const ACTION_GROUPS = [
  "saved_state_and_discover_settle",
  "swipe_assertions",
  "four_feed_settle_scroll_checks",
  "rebound",
  "settings_round_trip",
  "settings_scroll_check",
  "discussion_home_round_trip",
  "return_scroll_assertion",
  "final_discover_touch_settle",
];
export function sanitizeActions(value) {
  if (
    !value ||
    !Array.isArray(value.rows) ||
    value.rows.length > ACTION_GROUPS.length ||
    !Number.isSafeInteger(value.invalid) ||
    value.invalid < 0 ||
    !Number.isSafeInteger(value.overflow) ||
    value.overflow < 0
  )
    throw new Error("ACTION_SCHEMA_REJECTED");
  let previousEnd = 0;
  const rows = value.rows.map((row, index) => {
    if (
      !Array.isArray(row) ||
      row.length !== 4 ||
      row[0] !== index ||
      typeof row[1] !== "number" ||
      !Number.isFinite(row[1]) ||
      row[1] < previousEnd ||
      row[1] > 1080000 ||
      ![0, 1, 2, 3].includes(row[3]) ||
      (row[2] === null
        ? row[3] === 1 || index !== value.rows.length - 1
        : typeof row[2] !== "number" ||
          !Number.isFinite(row[2]) ||
          row[2] < row[1] ||
          row[2] > 1080000 ||
          row[3] !== 1)
    )
      throw new Error("ACTION_ROW_REJECTED");
    previousEnd = row[2] ?? row[1];
    return [...row];
  });
  return { rows, invalid: value.invalid, overflow: value.overflow };
}
export function sanitizeNativeErrors(attempt) {
  const collectionInvalid =
    attempt != null &&
    Object.hasOwn(attempt, "errors") &&
    !Array.isArray(attempt.errors);
  const candidate =
    Array.isArray(attempt?.errors) && attempt.errors.length
      ? attempt.errors
      : attempt?.error == null
        ? []
        : [attempt.error];
  const indices = [
    ...new Set([
      ...candidate.slice(0, 4).map((_, index) => index),
      ...candidate
        .slice(-4)
        .map((_, index) => Math.max(0, candidate.length - 4) + index),
    ]),
  ];
  const errors = indices.map((index) => {
    const e = candidate[index];
    const valid = e !== null && typeof e === "object" && !Array.isArray(e);
    const oversized =
      valid &&
      [e.message, e.stack].some(
        (x) => typeof x === "string" && Buffer.byteLength(x) > 65536,
      );
    const message =
      valid && !oversized && typeof e.message === "string"
        ? e.message
            .split(String.fromCharCode(27))
            .map((part, index) =>
              index ? part.replace(/^\[[0-9;]*m/, "") : part,
            )
            .join("")
        : "";
    const stack =
      valid && !oversized && typeof e.stack === "string" ? e.stack : "";
    const flags = {
      test_timeout:
        /^(?:Error: )?Test timeout of \d+ms exceeded(?:\.[^\r\n]*)?$/m.test(
          message,
        ),
      poll_timeout:
        /^(?:TimeoutError: )?Timeout \d+ms exceeded while waiting on the predicate\.?$/m.test(
          message,
        ),
      assertion_to_be:
        /^(?:Error: )?expect\([^\r\n]*\)\.toBe\([^\r\n]*\)/m.test(message),
      action_timeout:
        /^(?:[A-Za-z]+Error: )?[a-zA-Z][\w.]*: Timeout \d+ms exceeded\.?$/m.test(
          message,
        ),
      page_closed:
        /^(?:Error: )?(?:[\w.]+: )?Target page, context or browser has been closed\.?$/m.test(
          message,
        ),
      timeout_name: valid && e.name === "TimeoutError",
    };
    const category = !valid
      ? "ERROR_FIELD_INVALID"
      : oversized
        ? "ERROR_TEXT_OVERSIZED"
        : flags.test_timeout
          ? "TEST_TIMEOUT"
          : flags.poll_timeout
            ? "POLL_TIMEOUT"
            : flags.page_closed
              ? "PAGE_CONTEXT_CLOSED"
              : flags.assertion_to_be
                ? "ASSERTION_TO_BE"
                : flags.action_timeout
                  ? "ACTION_TIMEOUT"
                  : flags.timeout_name
                    ? "TIMEOUT_UNCLASSIFIED"
                    : "UNKNOWN";
    let location = null;
    let location_origin = "NOT_RETAINED";
    const assigned = (file) =>
      typeof file === "string" &&
      !file.includes("://") &&
      (file.replaceAll("\\", "/") === SPEC ||
        file.replaceAll("\\", "/").endsWith("/" + SPEC));
    const coordinates = (line, column) =>
      Number.isInteger(line) &&
      line > 0 &&
      line <= 100000 &&
      Number.isInteger(column) &&
      column > 0 &&
      column <= 10000;
    if (
      valid &&
      assigned(e.location?.file) &&
      coordinates(e.location.line, e.location.column)
    ) {
      location = { line: e.location.line, column: e.location.column };
      location_origin = "NATIVE_ERROR_LOCATION";
    } else {
      const match = stack
        .split(/\r?\n/)
        .filter((frame) => !frame.includes("://"))
        .map((frame) =>
          frame.match(
            /(?:^|[/\\])tests[/\\]e2e[/\\]t02p-development-acceptance\.spec\.ts:(\d+):(\d+)(?:\)|\s|$)/,
          ),
        )
        .find((frame) => frame !== null);
      if (match && coordinates(Number(match[1]), Number(match[2]))) {
        location = { line: Number(match[1]), column: Number(match[2]) };
        location_origin = "NATIVE_ERROR_STACK";
      }
    }
    return {
      index,
      category,
      flags,
      location,
      location_origin,
      text_oversized: oversized,
      error_field_invalid: !valid,
    };
  });
  return {
    native_result_present: attempt != null,
    error_fields_present:
      attempt != null &&
      (Object.hasOwn(attempt, "error") || Object.hasOwn(attempt, "errors")),
    error_collection_invalid: collectionInvalid,
    error_present:
      candidate.length > 0 ? true : collectionInvalid ? null : false,
    errors_seen: collectionInvalid ? null : candidate.length,
    errors_retained: errors.length,
    errors_omitted: collectionInvalid ? null : candidate.length - errors.length,
    errors,
    location_basis: "Instrumented assigned spec; not an original-line mapping",
    category_basis:
      "Actual error fields or recognized text only; never duration or native status",
  };
}
export function sanitizeReadiness(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 72 ||
    !Array.isArray(value.slots) ||
    value.slots.length > 9 ||
    !Number.isFinite(value.body_started_epoch_ms) ||
    value.body_started_epoch_ms < 0
  )
    throw new Error("READINESS_SCHEMA_REJECTED");
  for (const key of ["seen", "invalid", "overflow"])
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      throw new Error("READINESS_COUNTER_REJECTED");
  let previous = 0;
  for (const row of value.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== READINESS_FIELDS.length ||
      row.some(
        (x) =>
          x !== null &&
          typeof x !== "boolean" &&
          (typeof x !== "number" || !Number.isFinite(x)),
      )
    )
      throw new Error("READINESS_ROW_REJECTED");
    const route = readinessRoutes[row[2] - 1];
    if (
      !Number.isSafeInteger(row[0]) ||
      row[0] <= previous ||
      row[0] > value.seen ||
      typeof row[1] !== "number" ||
      row[1] < 0 ||
      row[1] > 1080000 ||
      !Number.isInteger(row[2]) ||
      !route ||
      row[3] !== route[0] ||
      row[4] !== route[1] ||
      ![0, 1, 2, 3].includes(row[5])
    )
      throw new Error("READINESS_ROUTE_REJECTED");
    if (row[5] !== 2) {
      if (row.slice(6).some((x) => x !== null))
        throw new Error("READINESS_EVENT_REJECTED");
    } else {
      if (row[6] !== null && ![0, 1, 2, 3].includes(row[6]))
        throw new Error("READINESS_ACTIVE_REJECTED");
      for (const at of [7, 8, 13, 14, 19])
        if (typeof row[at] !== "boolean")
          throw new Error("READINESS_FLAG_REJECTED");
      for (const at of [9, 10, 11, 12])
        if (!Number.isInteger(row[at]) || row[at] < 0 || row[at] > 10000)
          throw new Error("READINESS_IMAGE_COUNT_REJECTED");
      if (
        row[9] !== row[10] + row[11] + row[12] ||
        row[13] !== (row[11] === 0 && row[12] === 0) ||
        (row[15] !== null &&
          (typeof row[15] !== "number" || Math.abs(row[15]) > 10000000)) ||
        row[14] !== (row[15] !== null && Math.abs(row[15]) <= 2) ||
        !Number.isInteger(row[16]) ||
        row[16] < 0 ||
        row[16] > 3 ||
        (row[17] !== null && typeof row[17] !== "boolean") ||
        !Number.isInteger(row[18]) ||
        row[18] < 0 ||
        row[18] > 8191 ||
        row[19] !==
          (row[6] === row[4] && row[7] && !row[8] && row[13] && row[14])
      )
        throw new Error("READINESS_PREDICATE_REJECTED");
      for (const at of [20, 21])
        if (
          row[at] !== null &&
          (typeof row[at] !== "number" || row[at] < 0 || row[at] > 10000000)
        )
          throw new Error("READINESS_GEOMETRY_REJECTED");
    }
    previous = row[0];
  }
  const slots = value.slots.map((slot, index) => {
    const route = readinessRoutes[index];
    const rows = value.rows.filter((row) => row[2] === index + 1);
    if (
      slot.call !== index + 1 ||
      slot.phase !== route[0] ||
      slot.feed !== route[1] ||
      !Number.isSafeInteger(slot.seen) ||
      slot.seen < rows.length ||
      slot.retained !== rows.length ||
      slot.retained < 1 ||
      slot.retained > 8 ||
      slot.omitted !== slot.seen - slot.retained ||
      typeof slot.completed !== "boolean" ||
      slot.completed !== rows.some((row) => row[5] === 3)
    )
      throw new Error("READINESS_SLOT_REJECTED");
    return {
      call: slot.call,
      phase: slot.phase,
      feed: slot.feed,
      seen: slot.seen,
      retained: slot.retained,
      omitted: slot.omitted,
      completed: slot.completed,
    };
  });
  if (
    value.seen !== slots.reduce((sum, slot) => sum + slot.seen, 0) ||
    value.rows.some((row) => row[2] > slots.length)
  )
    throw new Error("READINESS_COUNTS_REJECTED");
  return {
    schema: 1,
    body_started_epoch_ms: value.body_started_epoch_ms,
    rows: value.rows,
    slots,
    seen: value.seen,
    invalid: value.invalid,
    overflow: value.overflow,
    actions: sanitizeActions(value.actions),
  };
}
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
    env.GITHUB_REF !== "refs/heads/codex/media-home97-action-diagnostic" ||
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

export const ATTRIBUTION_FIELDS = [
  "seq",
  "t_ms",
  "kind",
  "actor",
  "edge",
  "tag",
  "phase",
  "iteration",
  "context_feed",
  "panel_owner",
  "active_panel_owner",
  "active_feed",
  "expected_arg",
  "intended_top",
  "actual_top",
  "scroll_height",
  "client_height",
  "max_scroll_top",
  "event_is_trusted",
];

export function sanitizeAttribution(value) {
  if (value === undefined) return null;
  if (
    !value ||
    value.schema !== 1 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 49 ||
    !Number.isInteger(value.seen) ||
    value.seen < value.rows.length ||
    !Number.isInteger(value.invalid) ||
    value.invalid < 0 ||
    (value.first900ToZero !== null &&
      (!Number.isInteger(value.first900ToZero) ||
        value.first900ToZero < 1 ||
        value.first900ToZero > value.seen))
  )
    throw new Error("ATTRIBUTION_SCHEMA_REJECTED");
  let previous = 0;
  for (const row of value.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== ATTRIBUTION_FIELDS.length ||
      row.some(
        (x) =>
          x !== null &&
          typeof x !== "boolean" &&
          (typeof x !== "number" || !Number.isFinite(x)),
      )
    )
      throw new Error("ATTRIBUTION_ROW_REJECTED");
    if (
      !Number.isInteger(row[0]) ||
      row[0] <= previous ||
      row[0] > value.seen ||
      row[6] !== 1 ||
      row[7] !== 0 ||
      row[8] !== 0 ||
      ![0, 1, 2].includes(row[2]) ||
      ![0, 1, 2].includes(row[3]) ||
      ![0, 1, 2].includes(row[4]) ||
      !Number.isInteger(row[5]) ||
      row[5] < 0 ||
      row[5] > 7 ||
      (row[11] !== null && ![0, 1, 2, 3].includes(row[11])) ||
      (row[18] !== null && typeof row[18] !== "boolean")
    )
      throw new Error("ATTRIBUTION_ROUTE_REJECTED");
    for (const at of [1, 9, 10, 12, 13, 14, 15, 16, 17])
      if (row[at] !== null && (typeof row[at] !== "number" || row[at] < 0))
        throw new Error("ATTRIBUTION_SCALAR_REJECTED");
    previous = row[0];
  }
  if (
    value.first900ToZero !== null &&
    (!value.rows.some(
      (row) => row[0] === value.first900ToZero && row[14] === 0,
    ) ||
      !value.rows.some(
        (row) => row[0] === value.first900ToZero - 1 && row[14] === 900,
      ))
  )
    throw new Error("ATTRIBUTION_FAILURE_RESERVE_REJECTED");
  return {
    schema: 1,
    rows: value.rows,
    seen: value.seen,
    invalid: value.invalid,
    first_900_to_zero: value.first900ToZero,
    omitted: value.seen - value.rows.length,
  };
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
      [3, 7],
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
    attribution: sanitizeAttribution(value.attribution),
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
      join(c.workflow, SUPPORT, "home-readiness-recorder.ts"),
      join(c.source, SUPPORT, "home-readiness-recorder.ts"),
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
        readFileSync(join(c.workflow, SUPPORT, "home-readiness-recorder.ts")),
      ),
      runtime_files: [
        "apps/web/features/shell/horizontal-pager.tsx",
        "apps/web/features/product-shell/product-shell.tsx",
      ].map((path) => ({
        path,
        observed_sha256: sha(readFileSync(join(c.source, path))),
        untouched: true,
        original_blob: c.git("rev-parse", `${SOURCE}:${path}`),
      })),
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
      planned.config.failOnFlakyTests !== true ||
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
    readiness_fields: READINESS_FIELDS,
    readiness_phase_dictionary: ["pre_seed", "post_seed", "final_restore"],
    readiness_event_dictionary: ["begin", "eager_done", "sample", "settled"],
    readiness_signature_keys: READINESS_SIGNATURE_KEYS,
    action_group_dictionary: ACTION_GROUPS,
    action_row_fields: ["group", "body_begin_ms", "body_end_ms", "status"],
    action_status_dictionary: [
      "unfinished",
      "completed",
      "unfinished_with_native_error",
      "unfinished_with_native_timeout",
    ],
    readiness_coverage:
      "At most9 helper invocations/retry; first2/last2 plus first guard failure and signature change with preceding samples; at most8 rows/invocation. Omitted counts explicit.",
    attempts: [],
    state: "NATIVE_REPORT_MISSING",
    acceptance_pass: false,
    full_context_uploaded: false,
    raw_originals_after_runner_disposal:
      "NOT_RETAINED; only selected sanitized records are published",
    original_source_ranges: {
      helper: [196, 343],
      producer: [1899, 1911],
      final: [2054, 2058],
    },
  };
  packet.identity.workflow_blob = execFileSync(
    "git",
    ["rev-parse", "HEAD:.github/workflows/ci.yml"],
    { cwd: c.workflow, encoding: "utf8", timeout: 5000 },
  ).trim();
  packet.row_clock =
    "Node performance.now relative to this testcase body entry; native startTime versus body Date.now derived separately within this same retry";
  packet.owner_scope =
    "Fixed source helper invocation/phase/feed enums, not browser identities or URLs";
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
      native_errors: sanitizeNativeErrors(attempt),
      capture_available: false,
      capture_state: "MISSING",
    };
    if (existsSync(path)) {
      if (statSync(path).size > 131072) entry.capture_state = "OVERSIZED";
      else {
        try {
          const bytes = readFileSync(path);
          const value = JSON.parse(bytes);
          if (value.project !== "tablet-webkit" || value.retry !== retry)
            throw new Error("RETRY_PACKET_REJECTED");
          const readiness = sanitizeReadiness(value.readiness);
          const nativeStart =
            typeof attempt?.startTime === "string"
              ? Date.parse(attempt.startTime)
              : NaN;
          const bodyDelay = readiness.body_started_epoch_ms - nativeStart;
          Object.assign(entry, {
            readiness,
            body_entered_after_native_start_ms:
              Number.isFinite(bodyDelay) &&
              bodyDelay >= 0 &&
              bodyDelay <= 1080000
                ? bodyDelay
                : null,
            capture_available: true,
            capture_state:
              readiness.invalid ||
              readiness.overflow ||
              readiness.actions.invalid ||
              readiness.actions.overflow
                ? "READINESS_INVALID_OR_OVERFLOW_RECORDED"
                : "READINESS_SCALARS_RECORDED",
            original_packet_sha256: sha(bytes),
            original_file: `retry-${retry}.json`,
            original_rows_pointer: "/readiness/rows",
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
