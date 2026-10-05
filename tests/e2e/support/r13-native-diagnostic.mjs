import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const SOURCE = "7a2cba05b8596579fd1fcb6a58ba6ba9c018e8f1";
const TITLE =
  "QA chrome uses only its URL mode and hidden mode survives reload and a copied link";
const API = new Set([
  "browserType.launch",
  "browser.newContext",
  "browserContext.newPage",
  "browserContext.close",
  "browser.close",
]);
const METHODS = new Set([
  "Playwright.enable",
  "Playwright.createContext",
  "Playwright.createPage",
  "Playwright.deleteContext",
  "Playwright.pageProxyCreated",
  "Playwright.pageProxyDestroyed",
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.attachedToTarget",
  "Target.setAutoAttach",
  "Dialog.enable",
  "Emulation.setActiveAndFocused",
  "Emulation.setJavaScriptEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setOrientationOverride",
  "Emulation.setAuthCredentials",
  "Page.enable",
  "Page.getResourceTree",
  "Page.createUserWorld",
  "Page.setScreenSizeOverride",
  "Page.setBootstrapScript",
  "Page.overrideUserAgent",
  "Page.setEmulatedMedia",
  "Page.setForcedColors",
  "Page.setBypassCSP",
  "Page.setTouchEmulationEnabled",
  "Page.setTimeZone",
  "Page.setInterceptFileChooserDialog",
  "Page.overrideSetting",
  "Runtime.enable",
  "Runtime.addBinding",
  "Console.enable",
  "Worker.enable",
  "Network.enable",
  "Network.setInterceptionEnabled",
  "Network.setResourceCachingDisabled",
  "Network.addInterception",
  "Network.setExtraHTTPHeaders",
  "Network.setEmulateOfflineState",
]);
const ENVELOPES = new Set([
  "Target.sendMessageToTarget",
  "Target.dispatchMessageFromTarget",
]);
const MAX_LINE = 131072,
  MAX_ENVELOPE = 65536,
  MAX_EVENTS = 2048,
  MAX_PENDING = 512;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// Nothing from input is written verbatim. Only fixed enums, numeric values and
// hashed routing identifiers leave this collector. Params/results/errors drop.
class Phases {
  constructor() {
    this.started = performance.now();
    this.events = [];
    this.pending = new Map();
    this.api = new Map();
    this.streams = new Map();
    this.counts = {
      discarded: 0,
      oversized: 0,
      malformed: 0,
      collisions: 0,
      capped: 0,
      servicesReady: 0,
      envelopesParsed: 0,
      nestedEnvelopesRejected: 0,
    };
  }
  emit(event) {
    if (this.events.length >= MAX_EVENTS) {
      this.counts.capped++;
      return;
    }
    this.events.push({
      receive_t_ms:
        Math.round((performance.now() - this.started) * 1000) / 1000,
      ...event,
    });
  }
  packet(data, channel, stream, sending, layer) {
    const key = stream + ":" + layer + ":" + channel + ":" + data.id;
    const allowed =
      METHODS.has(data.method) ||
      (layer === "transport" && ENVELOPES.has(data.method));
    if (sending && allowed && number(data.id)) {
      if (this.pending.has(key)) {
        this.counts.collisions++;
        return;
      }
      if (this.pending.size >= MAX_PENDING) {
        this.counts.capped++;
        return;
      }
      this.pending.set(key, { method: data.method, start: performance.now() });
      this.emit({
        kind: "protocol_send",
        layer,
        method: data.method,
        id: data.id,
        channel,
      });
    } else if (!sending && number(data.id) && this.pending.has(key)) {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      this.emit({
        kind: "protocol_reply",
        layer,
        method: pending.method,
        id: data.id,
        channel,
        receive_duration_ms: performance.now() - pending.start,
        error_present: Object.hasOwn(data, "error"),
      });
    } else if (!sending && allowed) {
      this.emit({
        kind: "protocol_event",
        layer,
        method: data.method,
        channel,
      });
    } else this.counts.discarded++;
  }
  line(input, stream) {
    const line = input.replace(/\x1b\[[0-9;]*m/g, "");
    if (Buffer.byteLength(line) > MAX_LINE) {
      this.counts.oversized++;
      return;
    }
    if (/pw:webserver.*WebServer available/.test(line))
      this.counts.servicesReady++;
    const api = line.match(
      /pw:api\s+(=>|<=)\s+([A-Za-z.]+)\s+(started|succeeded|failed)(?:\s+\+\d+(?:ms|s))?\s*$/,
    );
    if (api && API.has(api[2])) {
      const key = stream + ":" + api[2],
        queue = this.api.get(key) || [];
      if (api[3] === "started") {
        if (queue.length >= 32) {
          this.counts.capped++;
          return;
        }
        queue.push(performance.now());
        this.api.set(key, queue);
        this.emit({ kind: "api_start", method: api[2] });
      } else {
        const start = queue.shift();
        this.api.set(key, queue);
        this.emit({
          kind: "api_end",
          method: api[2],
          state: api[3],
          ...(start === undefined
            ? { unmatched: true }
            : { receive_duration_ms: performance.now() - start }),
        });
      }
      return;
    }
    const protocol = line.match(
      /pw:protocol\s+(SEND\s+►|◀\s+RECV)\s+(\{.*\})(?:\s+\+\d+(?:ms|s))?\s*$/,
    );
    if (protocol) {
      let data;
      try {
        data = JSON.parse(protocol[2]);
      } catch {
        this.counts.malformed++;
        return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        this.counts.malformed++;
        return;
      }
      const route = data.sessionId ?? data.pageProxyId ?? "";
      if (!(
        (typeof route === "string" && route.length <= 256) ||
        number(route)
      )) {
        this.counts.malformed++;
        return;
      }
      const channel = hash(JSON.stringify([route])).slice(0, 16),
        sending = protocol[1].startsWith("SEND");
      this.packet(data, channel, stream, sending, "transport");
      if (
        (sending && data.method === "Target.sendMessageToTarget") ||
        (!sending && data.method === "Target.dispatchMessageFromTarget")
      ) {
        const params = data.params,
          target = params?.targetId,
          message = params?.message;
        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params) ||
          !(
            (typeof target === "string" && target.length <= 256) ||
            number(target)
          ) ||
          typeof message !== "string"
        ) {
          this.counts.malformed++;
          return;
        }
        if (Buffer.byteLength(message) > MAX_ENVELOPE) {
          this.counts.oversized++;
          return;
        }
        let inner;
        try {
          inner = JSON.parse(message);
        } catch {
          this.counts.malformed++;
          return;
        }
        if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
          this.counts.malformed++;
          return;
        }
        // Exactly one envelope level. Never recurse or emit message/params/body.
        if (ENVELOPES.has(inner.method)) {
          this.counts.nestedEnvelopesRejected++;
          return;
        }
        this.counts.envelopesParsed++;
        this.packet(
          inner,
          hash(JSON.stringify([route, target])).slice(0, 16),
          stream,
          sending,
          "target",
        );
      }
      return;
    }
    const launched = line.match(
      /pw:browser.*<launched> pid=(\d+)(?:\s+\+\d+(?:ms|s))?\s*$/,
    );
    if (launched && number(Number(launched[1]))) {
      this.emit({ kind: "browser_launched", pid: Number(launched[1]) });
      return;
    }
    if (
      /pw:browser.*<process did exit: exitCode=(-?\d+), signal=([A-Z0-9]+|null)>/.test(
        line,
      )
    ) {
      this.emit({ kind: "browser_exit" });
      return;
    }
    this.counts.discarded++;
  }
  chunk(bytes, stream) {
    let state = this.streams.get(stream);
    if (!state) {
      state = { decoder: new StringDecoder("utf8"), text: "", dropping: false };
      this.streams.set(stream, state);
    }
    for (const segment of state.decoder.write(bytes).split(/(?<=\n)/)) {
      if (!state.dropping) state.text += segment;
      if (Buffer.byteLength(state.text) > MAX_LINE) {
        state.text = "";
        state.dropping = true;
        this.counts.oversized++;
      }
      if (segment.endsWith("\n")) {
        if (!state.dropping) this.line(state.text.trimEnd(), stream);
        state.text = "";
        state.dropping = false;
      }
    }
  }
  finish() {
    for (const [stream, state] of this.streams) {
      const tail = state.text + state.decoder.end();
      if (!state.dropping && tail) this.line(tail, stream);
    }
    return {
      clock: "parent_monotonic_pipe_receive",
      native_clock_preserved: false,
      timing_limit:
        "Pipe buffering and merged child streams can delay or bunch observations. Receive intervals are not browser execution durations.",
      events: this.events,
      counts: this.counts,
      pending_commands: this.pending.size,
      incomplete_capture: Boolean(
        this.counts.oversized ||
        this.counts.malformed ||
        this.counts.collisions ||
        this.counts.capped ||
        this.counts.nestedEnvelopesRejected,
      ),
    };
  }
}

// Read only Linux process IDs/start times and cwd, never process environments.
function processTable() {
  const table = new Map();
  for (const name of readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .slice(0, 4096)) {
    try {
      const raw = readFileSync("/proc/" + name + "/stat", "utf8"),
        end = raw.lastIndexOf(")");
      const fields = raw.slice(end + 2).split(" ");
      table.set(Number(name), {
        pid: Number(name),
        state: fields[0],
        ppid: Number(fields[1]),
        start: fields[19],
      });
    } catch {}
  }
  return table;
}
async function bounded(cwd, args, env, budget, collector) {
  const started = performance.now(),
    temps = new Map(),
    known = new Map();
  const child = spawn("pnpm", args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let expired = false,
    interrupted = false,
    rootBound = false;
  let killTimer,
    forceTimer,
    resolveResult,
    forcedClose = false,
    stopDeadline = Infinity;
  const remember = () => {
    const table = processTable(),
      current = new Set();
    for (const [pid, entry] of known)
      if (table.get(pid)?.start === entry.start) current.add(pid);
    if (!rootBound && table.has(child.pid)) {
      known.set(child.pid, table.get(child.pid));
      current.add(child.pid);
      rootBound = true;
    }
    let added = true;
    while (added) {
      added = false;
      for (const entry of table.values())
        if (!current.has(entry.pid) && current.has(entry.ppid)) {
          known.set(entry.pid, entry);
          current.add(entry.pid);
          added = true;
        }
    }
    for (const pid of current) {
      try {
        const path = readlinkSync("/proc/" + pid + "/cwd"),
          relative = path.slice(tmpdir().length + 1),
          leaf = relative.split("/")[0];
        if (
          !path.startsWith(tmpdir() + "/") ||
          !/^moya-t02p01-formal-web-[A-Za-z0-9]+$/.test(leaf)
        )
          continue;
        const root = join(tmpdir(), leaf),
          stat = lstatSync(root);
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.uid === process.getuid()
        )
          temps.set(root, { ino: stat.ino, dev: stat.dev });
      } catch {}
    }
    return [...current].filter((pid) => table.get(pid)?.state !== "Z");
  };
  const signalOwned = (signal) => {
    remember();
    const table = processTable();
    for (const [pid, entry] of [...known].reverse())
      if (
        table.get(pid)?.start === entry.start &&
        table.get(pid)?.state !== "Z"
      ) {
        try {
          process.kill(pid, signal);
        } catch {}
      }
  };
  const stop = () => {
    stopDeadline = Math.min(stopDeadline, performance.now() + 10000);
    signalOwned("SIGTERM");
    if (!killTimer) killTimer = setTimeout(() => signalOwned("SIGKILL"), 5000);
    if (!forceTimer)
      forceTimer = setTimeout(() => {
        forcedClose = true;
        signalOwned("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolveResult?.({
          exit_code: null,
          signal: "CLEANUP_LIMIT",
          spawn_failed: false,
        });
      }, 10000);
  };
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  remember();
  const sampling = setInterval(remember, 200);
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, budget);
  child.stdout.on("data", (bytes) =>
    collector ? collector.chunk(bytes, "stdout") : undefined,
  );
  child.stderr.on("data", (bytes) =>
    collector ? collector.chunk(bytes, "stderr") : undefined,
  );
  const result = await new Promise((done) => {
    resolveResult = done;
    child.once("error", () =>
      done({ exit_code: null, signal: null, spawn_failed: true }),
    );
    child.once("close", (code, signal) =>
      done({ exit_code: code, signal, spawn_failed: false }),
    );
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  clearTimeout(forceTimer);
  clearInterval(sampling);
  signalOwned("SIGTERM");
  const cleanupStart = performance.now();
  const cleanupEnd = Math.min(
    cleanupStart + 10000,
    started + budget + 10000,
    stopDeadline,
  );
  while (
    remember().length &&
    performance.now() < Math.min(cleanupStart + 5000, cleanupEnd)
  )
    await delay(100);
  if (remember().length) signalOwned("SIGKILL");
  while (remember().length && performance.now() < cleanupEnd) await delay(100);
  const remaining = remember().length;
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
  if (!remaining && rootBound && !forcedClose)
    for (const [root, identity] of temps) {
      try {
        const stat = lstatSync(root);
        if (
          stat.ino === identity.ino &&
          stat.dev === identity.dev &&
          stat.uid === process.getuid() &&
          !stat.isSymbolicLink()
        )
          rmSync(root, { recursive: true });
      } catch {}
    }
  return {
    ...result,
    duration_ms: performance.now() - started,
    deadline_ms: budget,
    expired,
    interrupted,
    cleanup_ms: performance.now() - cleanupStart,
    remaining_owned_processes: remaining,
    ownership_confirmed: rootBound,
    forced_close: forcedClose,
    phases: collector?.finish(),
  };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
function identity(sourceRoot) {
  const workflowRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const source = git(sourceRoot, ["rev-parse", "HEAD"]),
    workflow = git(workflowRoot, ["rev-parse", "HEAD"]);
  assert.equal(source, SOURCE);
  assert.match(workflow, /^[0-9a-f]{40}$/);
  assert.equal(workflow, process.env.GITHUB_SHA);
  assert.equal(
    process.env.GITHUB_REF,
    "refs/heads/codex/media-r13-webkit-diagnostic",
  );
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.match(process.env.GITHUB_RUN_ID || "", /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT || "", /^\d+$/);
  git(sourceRoot, ["diff", "--exit-code", "HEAD", "--"]);
  const manager = JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ).packageManager;
  assert.equal(manager, "pnpm@11.9.0");
  return {
    source_head: source,
    source_tree: git(sourceRoot, ["rev-parse", "HEAD^{tree}"]),
    workflow_revision: workflow,
    diagnostic_run_id: Number(process.env.GITHUB_RUN_ID),
    diagnostic_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    historical_ci_run: 37293681711,
    historical_ci_attempt: 1,
    node: process.versions.node,
    runner_selector: "ubuntu-latest",
    runner_os: /^(Linux|macOS|Windows)$/.test(process.env.RUNNER_OS || "")
      ? process.env.RUNNER_OS
      : null,
    runner_arch: /^(X64|ARM64)$/.test(process.env.RUNNER_ARCH || "")
      ? process.env.RUNNER_ARCH
      : null,
    runner_image_os: /^[a-z0-9._-]{1,64}$/.test(process.env.ImageOS || "")
      ? process.env.ImageOS
      : null,
    runner_image_version: /^[0-9.]{1,64}$/.test(process.env.ImageVersion || "")
      ? process.env.ImageVersion
      : null,
    package_manager_selector: manager,
    native_playwright_version: "1.62.1",
    diagnostic_only: true,
    acceptance_pass: false,
  };
}
function nativeSummary(path, expectedIdentity) {
  if (!existsSync(path) || lstatSync(path).size > 4194304)
    return { completed: false, reason: "MISSING_OR_OVERSIZED" };
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { completed: false, reason: "INVALID_JSON" };
  }
  const selected = [];
  const walk = (suites) => {
    assert.ok(Array.isArray(suites) && suites.length <= 100);
    for (const suite of suites) {
      for (const spec of suite.specs || [])
        for (const test of spec.tests || []) {
          if (spec.title !== TITLE || test.projectName !== "desktop-webkit")
            throw new Error("selection");
          selected.push({
            status: ["expected", "unexpected", "flaky", "skipped"].includes(
              test.status,
            )
              ? test.status
              : "unknown",
            attempts: (test.results || []).map((r) => ({
              retry: number(r.retry) ? r.retry : null,
              status: [
                "passed",
                "failed",
                "timedOut",
                "skipped",
                "interrupted",
              ].includes(r.status)
                ? r.status
                : "unknown",
              duration_ms: number(r.duration) ? r.duration : null,
            })),
          });
        }
      walk(suite.suites || []);
    }
  };
  try {
    walk(data.suites);
  } catch {
    return { completed: false, reason: "WRONG_SELECTION_OR_SCHEMA" };
  }
  const meta = data.config?.metadata?.moyaCI;
  if (
    selected.length !== 1 ||
    meta?.sourceHead !== SOURCE ||
    meta?.checkoutSha !== SOURCE ||
    meta?.tree !== expectedIdentity.source_tree ||
    meta?.runId !== process.env.GITHUB_RUN_ID ||
    meta?.runAttempt !== process.env.GITHUB_RUN_ATTEMPT
  )
    return { completed: false, reason: "NATIVE_IDENTITY_MISMATCH" };
  return {
    completed: true,
    selected,
    global_error_count: Array.isArray(data.errors) ? data.errors.length : null,
    native_report_sha256: hash(readFileSync(path)),
  };
}
function save(out, name, data) {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

async function main() {
  const [mode, sourceArgument, outArgument] = process.argv.slice(2);
  if (mode === "--self-check") {
    const phases = new Phases();
    phases.chunk(
      Buffer.from(
        '2026 pw:api => browserContext.newPage started\n2026 pw:protocol SEND ► {"id":1,"method":"Playwright.createPage","params":{"url":"https://example.invalid","Authorization":"SYNTHETIC_UNSAFE_PAYLOAD"}}\n',
      ),
      "stderr",
    );
    phases.chunk(
      Buffer.from(
        '2026 pw:protocol ◀ RECV {"id":1,"result":{"payload":"SYNTHETIC_UNSAFE_PAYLOAD","headers":{"Cookie":"SYNTHETIC_UNSAFE_PAYLOAD"}}}\n2026 pw:api <= browserContext.newPage succeeded\n',
      ),
      "stderr",
    );
    phases.chunk(
      Buffer.from(
        '2026 pw:protocol SEND ► {"id":2,"method":"Network.getResponseBody","params":{"token":"SYNTHETIC_UNSAFE_PAYLOAD"}}\n',
      ),
      "stderr",
    );
    const result = phases.finish(),
      encoded = JSON.stringify(result);
    assert.equal(result.events.length, 4);
    assert.equal(result.pending_commands, 0);
    for (const forbidden of [
      "example.invalid",
      "SYNTHETIC_UNSAFE_PAYLOAD",
      "Authorization",
      "Cookie",
      "headers",
      "params",
      "result",
      "token",
    ])
      assert.ok(!encoded.includes(forbidden));
    const split = new Phases(),
      sample = Buffer.from(
        'pw:protocol SEND ► {"id":3,"method":"Playwright.createPage","params":{"nested":"SYNTHETIC_UNSAFE_PAYLOAD"}}\n',
      );
    const arrow = sample.indexOf(Buffer.from("►"));
    split.chunk(sample.subarray(0, arrow + 1), "stderr");
    split.chunk(sample.subarray(arrow + 1), "stderr");
    assert.equal(split.finish().events.length, 1);
    const enveloped = new Phases();
    const packet = (direction, data) =>
      enveloped.chunk(
        Buffer.from(
          "2026 pw:protocol " + direction + " " + JSON.stringify(data) + "\n",
        ),
        "stderr",
      );
    const sendEnvelope = (id, targetId, method) =>
      packet("SEND ►", {
        id,
        pageProxyId: "DEMO_PROXY_ID",
        method: "Target.sendMessageToTarget",
        params: {
          targetId,
          message: JSON.stringify({
            id: 7,
            method,
            params: {
              url: "https://example.invalid",
              payload: "SYNTHETIC_UNSAFE_PAYLOAD",
              headers: { Authorization: "SYNTHETIC_UNSAFE_PAYLOAD" },
            },
          }),
        },
      });
    sendEnvelope(11, "DEMO_TARGET_A", "Page.getResourceTree");
    sendEnvelope(12, "DEMO_TARGET_B", "Runtime.enable");
    for (const id of [11, 12])
      packet("◀ RECV", {
        id,
        pageProxyId: "DEMO_PROXY_ID",
        result: { body: "SYNTHETIC_UNSAFE_PAYLOAD" },
      });
    for (const targetId of ["DEMO_TARGET_B", "DEMO_TARGET_A"])
      packet("◀ RECV", {
        pageProxyId: "DEMO_PROXY_ID",
        method: "Target.dispatchMessageFromTarget",
        params: {
          targetId,
          message: JSON.stringify({
            id: 7,
            ...(targetId === "DEMO_TARGET_A"
              ? { error: { message: "SYNTHETIC_UNSAFE_PAYLOAD" } }
              : { result: { token: "SYNTHETIC_UNSAFE_PAYLOAD" } }),
          }),
        },
      });
    const envelopeResult = enveloped.finish(),
      envelopeEncoded = JSON.stringify(envelopeResult);
    assert.equal(envelopeResult.events.length, 10);
    assert.equal(envelopeResult.pending_commands, 0);
    assert.equal(envelopeResult.counts.envelopesParsed, 4);
    const replies = envelopeResult.events.filter(
      (e) => e.kind === "protocol_reply" && e.layer === "target",
    );
    assert.equal(replies.length, 2);
    assert.notEqual(replies[0].channel, replies[1].channel);
    assert.deepEqual(
      replies.map((e) => [e.method, e.id, e.error_present]),
      [
        ["Runtime.enable", 7, false],
        ["Page.getResourceTree", 7, true],
      ],
    );
    assert.ok(
      replies.every(
        (e) =>
          Number.isFinite(e.receive_duration_ms) &&
          Number.isFinite(e.receive_t_ms),
      ),
    );
    for (const forbidden of [
      "example.invalid",
      "SYNTHETIC_UNSAFE_PAYLOAD",
      "DEMO_PROXY_ID",
      "DEMO_TARGET_A",
      "DEMO_TARGET_B",
      '"params":',
      '"message":',
      '"headers":',
      '"body":',
      '"token":',
    ])
      assert.ok(!envelopeEncoded.includes(forbidden));
    assert.equal(envelopeResult.clock, "parent_monotonic_pipe_receive");
    assert.equal(envelopeResult.native_clock_preserved, false);
    const refused = new Phases();
    const refusePacket = (message) =>
      refused.chunk(
        Buffer.from(
          "pw:protocol SEND ► " +
            JSON.stringify({
              id: 1,
              pageProxyId: "DEMO_PROXY_ID",
              method: "Target.sendMessageToTarget",
              params: { targetId: "DEMO_TARGET_A", message },
            }) +
            "\n",
        ),
        "stderr",
      );
    refusePacket(
      JSON.stringify({
        id: 2,
        method: "Target.sendMessageToTarget",
        params: { message: "SYNTHETIC_UNSAFE_PAYLOAD" },
      }),
    );
    refusePacket("{");
    refusePacket("x".repeat(MAX_ENVELOPE + 1));
    const refusedResult = refused.finish();
    assert.equal(refusedResult.counts.nestedEnvelopesRejected, 1);
    assert.ok(
      refusedResult.counts.malformed &&
        refusedResult.counts.oversized &&
        refusedResult.incomplete_capture,
    );
    assert.ok(!JSON.stringify(refusedResult).includes("SYNTHETIC_UNSAFE_PAYLOAD"));
    for (const method of [
      "Dialog.enable",
      "Emulation.setActiveAndFocused",
      "Page.getResourceTree",
      "Page.createUserWorld",
      "Worker.enable",
    ])
      assert.ok(METHODS.has(method));
    const invalid = new Phases();
    invalid.chunk(
      Buffer.from(
        "pw:protocol SEND ► {invalid}\n" + "x".repeat(MAX_LINE + 1) + "\n",
      ),
      "stderr",
    );
    assert.equal(invalid.finish().events.length, 0);
    assert.ok(invalid.counts.oversized && invalid.counts.malformed);
    console.log(
      JSON.stringify({
        synthetic_allowlist_checks: "PASS",
        real_execution: false,
      }),
    );
    return;
  }
  assert.ok(["prepare", "run"].includes(mode));
  assert.equal(process.platform, "linux");
  const sourceRoot = resolve(sourceArgument),
    out = resolve(outArgument);
  assert.equal(dirname(out), dirname(sourceRoot));
  assert.equal(basename(out), "diag-evidence");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const id = identity(sourceRoot);
  const env = {
    ...process.env,
    CI: "true",
    MOYA_E2E_SOURCE_HEAD: SOURCE,
    MOYA_E2E_CHECKOUT_SHA: SOURCE,
    MOYA_E2E_CHECKOUT_TREE: id.source_tree,
  };
  if (mode === "prepare") {
    const started = performance.now(),
      stages = [];
    let preparationExhausted = false;
    for (const args of [
      ["install", "--frozen-lockfile"],
      [
        "--filter",
        "@moya/tests",
        "exec",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
        "webkit",
      ],
    ]) {
      const remaining = 600000 - (performance.now() - started);
      if (remaining <= 10000) {
        preparationExhausted = true;
        break;
      }
      const result = await bounded(
        sourceRoot,
        args,
        env,
        Math.floor(remaining - 10000),
        null,
      );
      stages.push(result);
      if (
        result.exit_code !== 0 ||
        result.expired ||
        result.interrupted ||
        result.remaining_owned_processes ||
        !result.ownership_confirmed ||
        result.forced_close
      )
        break;
    }
    const ready =
      stages.length === 2 &&
      stages.every(
        (s) =>
          s.exit_code === 0 &&
          !s.expired &&
          !s.interrupted &&
          !s.remaining_owned_processes &&
          s.ownership_confirmed &&
          !s.forced_close,
      );
    const outcome = ready
      ? "PREPARED_NOT_ACCEPTED"
      : stages.some(
            (s) =>
              s.remaining_owned_processes ||
              !s.ownership_confirmed ||
              s.forced_close,
          )
        ? "CLEANUP_INCOMPLETE"
        : stages.some((s) => s.interrupted)
          ? "INTERRUPTED"
          : preparationExhausted ||
              stages.some((s) => s.expired) ||
              performance.now() - started >= 600000
            ? "PREPARATION_DEADLINE_EXCEEDED"
            : "PREPARATION_FAILED";
    save(out, "preparation.json", {
      identity: id,
      outcome,
      stages,
      ready,
      budget_ms: 600000,
      cleanup_reserve_ms: 10000,
      elapsed_ms: performance.now() - started,
    });
    console.log(JSON.stringify({ phase: "preparation", outcome }));
    process.exitCode = ready ? 0 : 2;
    return;
  }
  const prepared = JSON.parse(
    readFileSync(join(out, "preparation.json"), "utf8"),
  );
  assert.ok(prepared.ready);
  assert.deepEqual(prepared.identity, id);
  const pins = JSON.parse(
    readFileSync(
      join(
        sourceRoot,
        "node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/browsers.json",
      ),
      "utf8",
    ),
  );
  const browsers = pins.browsers
    .filter((b) => ["chromium", "webkit"].includes(b.name))
    .map((b) => ({
      name: b.name,
      revision: String(b.revision).match(/^\d+$/)?.[0] || null,
      browser_version: /^[0-9.]+$/.test(b.browserVersion || "")
        ? b.browserVersion
        : null,
    }));
  assert.equal(browsers.length, 2);
  const raw = mkdtempSync(join(tmpdir(), "r13-native-"));
  let result;
  try {
    const collector = new Phases();
    result = await bounded(
      sourceRoot,
      [
        "--filter",
        "@moya/tests",
        "exec",
        "playwright",
        "test",
        "--config",
        "e2e/playwright.config.ts",
        "e2e/t02p-qa-preview.spec.ts",
        "--project=desktop-webkit",
        "--grep",
        TITLE + "$",
      ],
      {
        ...env,
        MOYA_E2E_ARTIFACT_DIR: raw,
        DEBUG: "pw:api,pw:browser,pw:protocol,pw:webserver",
      },
      110000,
      collector,
    );
    const native = nativeSummary(join(raw, "report.json"), id);
    const zero =
      result.exit_code === 0 &&
      native.completed &&
      native.selected[0].status === "expected" &&
      native.selected[0].attempts.length === 1 &&
      native.selected[0].attempts[0].status === "passed" &&
      native.global_error_count === 0;
    const pageSpans = result.phases.events.filter(
      (e) => e.kind === "api_end" && e.method === "browserContext.newPage",
    );
    const outcome =
      result.remaining_owned_processes ||
      !result.ownership_confirmed ||
      result.forced_close
        ? "CLEANUP_INCOMPLETE"
        : result.expired
          ? "FEEDBACK_DEADLINE_EXCEEDED"
          : result.interrupted
            ? "INTERRUPTED"
            : !native.completed
              ? "NATIVE_RESULT_INCOMPLETE"
              : zero
                ? result.phases.incomplete_capture || pageSpans.length === 0
                  ? "NOT_REPRODUCED_PARTIAL_CAPTURE"
                  : "NOT_REPRODUCED_IN_THIS_RUN"
                : "NATIVE_FAILURE_OBSERVED";
    save(out, "feedback.json", {
      identity: id,
      outcome,
      native,
      browsers,
      ...result,
      constraints: {
        test_ms: 30000,
        global_ms: 1080000,
        feedback_ms: 120000,
        active_capture_limit_ms: 110000,
        cleanup_reserve_ms: 10000,
        workers: 1,
        retries: 1,
        fail_on_flaky: true,
        context_reuse: false,
        trace: "retain-on-failure-and-retries",
      },
      new_page_receive_durations_ms: pageSpans.map(
        (e) => e.receive_duration_ms ?? null,
      ),
      interpretation:
        "Diagnostics only. No cause, performance threshold, media PASS or new correction authority inferred.",
    });
    console.log(
      JSON.stringify({ phase: "feedback", outcome, acceptance_pass: false }),
    );
    process.exitCode =
      outcome === "NOT_REPRODUCED_IN_THIS_RUN" ? 0 : result.expired ? 124 : 2;
  } finally {
    if (
      result?.ownership_confirmed &&
      result.remaining_owned_processes === 0 &&
      !result.forced_close
    )
      rmSync(raw, { recursive: true, force: true });
  }
}
main().catch(() => {
  const record = {
    outcome: "PRECONDITION_OR_CONTROL_FAILURE",
    identity_verified: false,
    acceptance_pass: false,
  };
  // Fixed control record only; exception messages, stack and inputs never leave.
  if (
    process.platform === "linux" &&
    ["prepare", "run"].includes(process.argv[2]) &&
    process.env.GITHUB_WORKSPACE
  ) {
    try {
      const out = join(process.env.GITHUB_WORKSPACE, "diag-evidence");
      mkdirSync(out, { recursive: true, mode: 0o700 });
      save(out, "control.json", record);
    } catch {}
  }
  console.error(JSON.stringify(record));
  process.exitCode = 2;
});
