import { Buffer } from "node:buffer";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

// Observe the official NDJSON protocol without publishing prompt/tool text.
// Silence is unconfirmed activity, never proof of thinking or a stall timer.
export function runCursorStream(bin, args, options = {}) {
  const {
    cwd,
    env,
    input = "",
    progressPath,
    onProgress,
    heartbeatMs = 30000,
    maxBytes = 256 * 1024,
  } = options;
  return new Promise((resolve) => {
    // The official user event echoes stdin in one line. Its admitted input may
    // be larger than the bounded answer; do not confuse echo with answer bytes.
    const echoBytes = Math.min(
      2 * 1024 * 1024,
      Math.max(maxBytes, Buffer.byteLength(input) + 4096),
    );
    const started = Date.now();
    const hash = createHash("sha256");
    const state = {
      version: 1,
      policy: "observable-progress-no-fixed-reasoning-cutoff",
      startedAt: new Date(started).toISOString(),
      processStatus: "starting",
      activity: "unconfirmed",
      eventCounts: {},
      stdoutBytes: 0,
      stderrBytes: 0,
      toolsStarted: 0,
      toolsCompleted: 0,
      lastObservableAt: null,
      hiddenReasoningVerified: false,
    };
    let pending = "";
    let terminal = "";
    let stderr = "";
    let error;
    let lastHeartbeatActivity = null;
    let resultEvents = 0;
    let retentionFailed = false;
    let child;
    const stop = (code) => {
      error ??= Object.assign(new Error(code), { code });
      child?.kill("SIGKILL");
    };
    const save = () => {
      if (progressPath && !retentionFailed) {
        try {
          writeFileSync(progressPath, JSON.stringify(state) + "\n", {
            mode: 0o600,
          });
        } catch {
          retentionFailed = true;
          state.retentionGap = "STREAM_PROGRESS_RETENTION_FAILED";
          stop("STREAM_PROGRESS_RETENTION_FAILED");
        }
      }
    };
    child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const consume = (line) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > echoBytes) {
        stop("STREAM_OUTPUT_LIMIT");
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        stop("INVALID_STREAM_EVENT");
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        stop("INVALID_STREAM_EVENT");
        return;
      }
      const type = [
        "system",
        "user",
        "assistant",
        "tool_call",
        "result",
      ].includes(event.type)
        ? event.type
        : "other";
      if (type !== "user" && Buffer.byteLength(line) > maxBytes) {
        stop("STREAM_OUTPUT_LIMIT");
        return;
      }
      state.eventCounts[type] = (state.eventCounts[type] || 0) + 1;
      if (type === "assistant" || type === "tool_call" || type === "result") {
        state.lastObservableAt = new Date().toISOString();
        state.activity = "observable-event-received";
      }
      if (type === "tool_call" && event.subtype === "started")
        ++state.toolsStarted;
      if (type === "tool_call" && event.subtype === "completed")
        ++state.toolsCompleted;
      if (type === "result") {
        if (++resultEvents !== 1) {
          stop("DUPLICATE_STREAM_RESULT");
          return;
        }
        terminal = line;
      }
      save();
    };
    const timer = setInterval(() => {
      state.activity =
        state.lastObservableAt &&
        state.lastObservableAt !== lastHeartbeatActivity
          ? "observable-event-received"
          : "unconfirmed";
      lastHeartbeatActivity = state.lastObservableAt;
      save();
      try {
        onProgress?.({ ...state });
      } catch {
        stop("STREAM_PROGRESS_CALLBACK_FAILED");
      }
    }, heartbeatMs);
    child.once("spawn", () => {
      state.processStatus = "running";
      save();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      hash.update(chunk);
      state.stdoutBytes += Buffer.byteLength(chunk);
      // Count/hash the whole stream, but bound only retained line/result memory.
      // Echoed prompts and partial-event overhead must not consume answer space.
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (Buffer.byteLength(pending) > echoBytes) stop("STREAM_OUTPUT_LIMIT");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderrBytes += Buffer.byteLength(chunk);
      if (state.stderrBytes > 64 * 1024)
        return stop("STREAM_ERROR_OUTPUT_LIMIT");
      // Only cursorFailure consumes this in memory; never persist/print it.
      stderr += chunk;
    });
    child.on("error", (value) => {
      error ??= value;
    });
    child.stdin.on("error", (value) => {
      error ??= value;
    });
    const cancel = () => stop("HOST_CANCELLED");
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    child.once("close", (status, signal) => {
      clearInterval(timer);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      if (pending.trim()) consume(pending);
      if (!error && status === 0 && !terminal)
        error = Object.assign(new Error("STREAM_TERMINAL_MISSING"), {
          code: "STREAM_TERMINAL_MISSING",
        });
      state.processStatus = "terminated";
      state.finishedAt = new Date().toISOString();
      state.elapsedMs = Date.now() - started;
      state.exitCode = status;
      state.signal = signal;
      state.terminalResultReceived = Boolean(terminal);
      state.transportSha256 = hash.digest("hex");
      // Map arbitrary OS diagnostics to a finite safe category.
      state.transportError = error
        ? [
            "EPIPE",
            "ENOENT",
            "INVALID_STREAM_EVENT",
            "DUPLICATE_STREAM_RESULT",
            "STREAM_OUTPUT_LIMIT",
            "STREAM_ERROR_OUTPUT_LIMIT",
            "HOST_CANCELLED",
            "STREAM_TERMINAL_MISSING",
            "STREAM_PROGRESS_RETENTION_FAILED",
            "STREAM_PROGRESS_CALLBACK_FAILED",
          ].includes(error.code)
          ? error.code
          : "STREAM_TRANSPORT_ERROR"
        : null;
      save();
      resolve({
        status,
        signal,
        error,
        stdout: terminal,
        stderr,
        progress: state,
      });
    });
    save();
    child.stdin.end(input);
  });
}
