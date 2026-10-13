#!/usr/bin/env node
/**
 * On-demand smoke of the production Web build on real engines at the
 * supported floors (docs/development/browser-support.md). Never a required
 * check.
 *
 *   node tests/legacy-browsers/run.mjs --output <dir>
 *        [--web-port 3640] [--api-port 3641] [--lane <image>]
 *
 * Input: an existing `apps/web/.next` production build and Docker. The e2e
 * Public API fixture and `apps/web/scripts/start-production.mts` run here, on
 * the repository's Node; each lane in package.json `legacyLanes` runs its
 * pinned Playwright image with the matching @playwright/test on the host
 * network (on macOS through forward-ports.mjs). Output: per-lane logs,
 * Playwright JSON reports, the engine version strings and `summary.json`
 * under --output. A lane that prints nothing for
 * five minutes is stopped and reported as STALLED. Exit 0 only when every
 * floor lane passed; an informational lane (below the floor) never fails the
 * run. No credentials; only loopback ports and the pinned public images.
 */
import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const STALL_MS = 5 * 60_000;
// Docker Desktop for Mac keeps the Mac's loopback out of --network=host; the
// container then relays the two ports itself (forward-ports.mjs).
const relayPorts = process.platform === "darwin";
const READY_MS = 90_000;

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const output = option("--output");
if (!output) {
  console.error("Usage: run.mjs --output <dir> [--web-port n] [--api-port n]");
  process.exit(2);
}
const outputDir = path.resolve(output);
const webPort = Number(option("--web-port", "3640"));
const apiPort = Number(option("--api-port", "3641"));
const onlyLane = option("--lane");
const lanes = JSON.parse(
  fs.readFileSync(path.join(here, "package.json"), "utf8"),
).legacyLanes.filter((lane) => !onlyLane || lane.image === onlyLane);

if (!fs.existsSync(path.join(root, "apps/web/.next/BUILD_ID"))) {
  console.error("No production build in apps/web/.next; build the Web first.");
  process.exit(2);
}
fs.mkdirSync(outputDir, { recursive: true });

const children = [];
const start = (name, args, options) => {
  const log = fs.openSync(path.join(outputDir, `${name}.log`), "a");
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ["ignore", log, log],
  });
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });

const ready = async (url, child, name) => {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${name} exited with ${child.exitCode}`);
    try {
      const response = await globalThis.fetch(url, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await delay(500);
  }
  throw new Error(`${name} was not ready at ${url} within ${READY_MS} ms`);
};

/** Runs one lane; resolves to its exit status, or "STALLED". */
const runLane = (lane, laneDir, container) =>
  new Promise((resolve) => {
    const log = fs.createWriteStream(path.join(laneDir, "lane.log"));
    const projects = lane.projects.map((project) => `--project=${project}`);
    const script = [
      "set -eu",
      "mkdir -p /work && cp -R /smoke-src/. /work && cd /work",
      ...(relayPorts
        ? [`node forward-ports.mjs ${webPort} ${apiPort} &`, "sleep 1"]
        : []),
      `npm install --no-save --no-package-lock --no-audit --no-fund --loglevel=error @playwright/test@${lane.playwright}`,
      `npx playwright test --config playwright.config.ts ${projects.join(" ")} --reporter=line,json`,
    ].join("\n");
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--init",
        "--ipc=host",
        ...(relayPorts ? [] : ["--network=host"]),
        `--name=${container}`,
        "-v",
        `${here}:/smoke-src:ro`,
        "-v",
        `${laneDir}:/out`,
        "-e",
        `LEGACY_BASE_URL=http://127.0.0.1:${webPort}`,
        "-e",
        "LEGACY_OUTPUT_DIR=/out",
        "-e",
        "PLAYWRIGHT_JSON_OUTPUT_NAME=/out/report.json",
        "-e",
        "CI=1",
        "-e",
        "npm_config_update_notifier=false",
        lane.image,
        "bash",
        "-c",
        script,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let lastOutput = Date.now();
    let stalled = false;
    const relay = (chunk) => {
      lastOutput = Date.now();
      log.write(chunk);
      for (const line of chunk.toString().split("\n"))
        if (line.trim()) console.log(`[${lane.projects.join("+")}] ${line}`);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput < STALL_MS) return;
      stalled = true;
      console.log(`[${lane.projects.join("+")}] STALL: no output for 5 min`);
      spawnSync("docker", ["kill", container], { stdio: "ignore" });
    }, 10_000);
    child.on("close", (code) => {
      clearInterval(watchdog);
      log.end();
      resolve(stalled ? "STALLED" : code);
    });
  });

const summarize = (lane, laneDir, status) => {
  const engines = lane.projects.map((project) => {
    const file = path.join(laneDir, `engine-${project}.json`);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { project, version: null };
  });
  const tests = [];
  const reportFile = path.join(laneDir, "report.json");
  if (fs.existsSync(reportFile)) {
    const visit = (suite) => {
      for (const spec of suite.specs ?? [])
        for (const entry of spec.tests ?? [])
          tests.push({
            project: entry.projectName,
            title: spec.title,
            status: entry.results?.at(-1)?.status ?? "unknown",
            error:
              entry.results
                ?.at(-1)
                ?.error?.message?.split("\n")
                .slice(0, 6)
                .join("\n") ?? null,
          });
      for (const child of suite.suites ?? []) visit(child);
    };
    for (const suite of JSON.parse(fs.readFileSync(reportFile, "utf8"))
      .suites ?? [])
      visit(suite);
  }
  const passed =
    status === 0 &&
    tests.length > 0 &&
    tests.every((entry) => entry.status === "passed");
  return {
    image: lane.image,
    playwright: lane.playwright,
    projects: lane.projects,
    informational: lane.informational === true,
    result: passed ? "PASS" : status === "STALLED" ? "STALLED" : "FAIL",
    exitStatus: status,
    engines,
    tests,
  };
};

const results = [];
try {
  const api = start("public-api", ["tests/e2e/support/public-api.ts"], {
    cwd: root,
    env: { ...process.env, MOYA_E2E_PUBLIC_API_PORT: String(apiPort) },
  });
  await ready(`http://127.0.0.1:${apiPort}/health`, api, "Public API fixture");
  const web = start(
    "web",
    [
      "scripts/start-production.mts",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webPort),
    ],
    {
      cwd: path.join(root, "apps/web"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        MOYA_PUBLIC_API_BASE_URL: `http://127.0.0.1:${apiPort}/`,
      },
    },
  );
  await ready(`http://127.0.0.1:${webPort}/`, web, "Web production server");
  for (const [index, lane] of lanes.entries()) {
    const laneDir = path.join(outputDir, `lane-${index + 1}`);
    fs.mkdirSync(laneDir, { recursive: true });
    console.log(`Lane ${index + 1}: ${lane.image} (${lane.projects})`);
    const status = await runLane(
      lane,
      laneDir,
      `legacy-smoke-${process.pid}-${index + 1}`,
    );
    results.push(summarize(lane, laneDir, status));
  }
} catch (error) {
  console.error(`Legacy browser smoke could not run: ${error.message}`);
  results.push({ result: "NOT RUN", reason: error.message });
} finally {
  stopAll();
}

fs.writeFileSync(
  path.join(outputDir, "summary.json"),
  `${JSON.stringify({ webPort, apiPort, results }, null, 2)}\n`,
);
for (const entry of results)
  console.log(
    entry.result === "NOT RUN"
      ? `NOT RUN: ${entry.reason}`
      : `${entry.result}${entry.informational ? " (informational, below the floor)" : ""}: ${entry.image} ${entry.engines
          .map((engine) => `${engine.project} ${engine.version ?? "?"}`)
          .join(", ")}`,
  );
process.exitCode = results.every(
  (entry) => entry.result === "PASS" || entry.informational,
)
  ? 0
  : 1;
