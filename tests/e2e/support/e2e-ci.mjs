import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertAggregate, assertRunIdentity } from "./e2e-report-integrity.ts";

// Small CI entry point; Playwright owns collection, execution and report merging.
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidenceRoot = join(repositoryRoot, ".local/e2e-ci");
const [mode, shardArgument] = process.argv.slice(2);
const git = (...args) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const identity = {
  sourceHead: process.env.MOYA_E2E_SOURCE_HEAD,
  checkoutSha: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
};
assertRunIdentity(identity);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const nativeEnvironment = {
  ...process.env,
  CI: "true",
  MOYA_E2E_SOURCE_HEAD: identity.sourceHead,
  MOYA_E2E_CHECKOUT_SHA: identity.checkoutSha,
  MOYA_E2E_CHECKOUT_TREE: identity.tree,
};

async function command(directory, name, args, environment = nativeEnvironment) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const log = join(directory, `${name}.log`);
  writeFileSync(log, "", { flag: "wx" });
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  let servicesAvailable = 0;
  let servicesReadyMs = null;
  const record = (bytes, output) => {
    appendFileSync(log, bytes);
    output.write(bytes);
    const lines = `${tail}${bytes.toString()}`.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      if (
        line.includes("pw:webserver") &&
        line.includes("WebServer available")
      ) {
        servicesAvailable += 1;
        if (servicesAvailable === 3) servicesReadyMs = Date.now() - start;
      }
    }
  };
  child.stdout.on("data", (bytes) => record(bytes, process.stdout));
  child.stderr.on("data", (bytes) => record(bytes, process.stderr));
  const interrupt = () => child.kill("SIGTERM");
  process.on("SIGTERM", interrupt);
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolveResult({ exitCode, signal }),
    );
  });
  process.off("SIGTERM", interrupt);
  const durationMs = Date.now() - start;
  const timing = {
    command: ["pnpm", ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    servicesAvailable,
    servicesReadyMs,
    afterServicesReadyMs:
      servicesReadyMs === null ? null : durationMs - servicesReadyMs,
    ...result,
  };
  writeJson(join(directory, `${name}.json`), timing);
  return timing;
}

async function runShard(shard) {
  const directory = join(evidenceRoot, `shard-${shard}`);
  mkdirSync(directory, { recursive: true });
  if (mode === "prepare") {
    writeJson(join(directory, "identity.json"), identity);
    const install = await command(directory, "install", [
      "install",
      "--frozen-lockfile",
    ]);
    if (install.exitCode !== 0) return install.exitCode ?? 1;
    const browsers = await command(directory, "browser-install", [
      "--filter",
      "@moya/tests",
      "exec",
      "playwright",
      "install",
      "--with-deps",
      "chromium",
      "webkit",
    ]);
    return browsers.exitCode ?? 1;
  }
  const storedIdentity = readJson(join(directory, "identity.json"));
  if (JSON.stringify(storedIdentity) !== JSON.stringify(identity))
    throw new Error("Checkout changed after prepare");
  const environment = {
    ...nativeEnvironment,
    MOYA_E2E_ARTIFACT_DIR: directory,
  };
  const test = [
    "--filter",
    "@moya/tests",
    "exec",
    "playwright",
    "test",
    "--config",
    "e2e/playwright.config.ts",
  ];
  for (const [label, extra] of [
    ["full-list", []],
    ["shard-list", [`--shard=${shard}/3`]],
  ]) {
    const list = await command(
      directory,
      label,
      [...test, "--list", "--reporter=json", ...extra],
      {
        ...environment,
        PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, `${label}-report.json`),
      },
    );
    if (list.exitCode !== 0) return list.exitCode ?? 1;
  }
  const run = await command(
    directory,
    "test",
    [...test, `--shard=${shard}/3`],
    {
      ...environment,
      DEBUG: [process.env.DEBUG, "pw:webserver"].filter(Boolean).join(","),
    },
  );
  writeJson(join(directory, "shard-result.json"), {
    identity,
    shard,
    total: 3,
    completed: run.signal === null && run.exitCode !== null,
    exitCode: run.exitCode,
    timingNote:
      "test.durationMs includes services, tests, teardown and report flush; afterServicesReadyMs is not pure test time. Job wall time, including setup/upload, comes from GitHub.",
  });
  return run.exitCode ?? 1;
}

async function merge() {
  const directory = join(evidenceRoot, "aggregate");
  const blobs = join(directory, "blobs");
  mkdirSync(blobs, { recursive: true });
  const inputs = [];
  const problems = [];
  const downloaded = join(evidenceRoot, "downloaded");
  let directories = [];
  try {
    directories = readdirSync(downloaded, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );
  } catch (error) {
    problems.push(`Missing downloaded shard artifacts: ${String(error)}`);
  }
  for (const entry of directories) {
    const source = join(downloaded, entry.name);
    // Copy available native blobs even when execution failed; diagnostics remain useful.
    try {
      for (const file of readdirSync(join(source, "blob")).filter((name) =>
        name.endsWith(".zip"),
      )) {
        copyFileSync(
          join(source, "blob", file),
          join(blobs, `${entry.name}-${file}`),
        );
      }
      inputs.push({
        ...readJson(join(source, "shard-result.json")),
        full: readJson(join(source, "full-list-report.json")),
        planned: readJson(join(source, "shard-list-report.json")),
        report: readJson(join(source, "report.json")),
      });
    } catch (error) {
      problems.push(`${entry.name}: ${String(error)}`);
    }
  }
  let summary = null;
  if (readdirSync(blobs).length > 0) {
    const merged = await command(
      directory,
      "merge",
      [
        "--filter",
        "@moya/tests",
        "exec",
        "playwright",
        "merge-reports",
        "--reporter=json,html",
        blobs,
      ],
      {
        ...nativeEnvironment,
        PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, "merged-report.json"),
        PLAYWRIGHT_HTML_OUTPUT_DIR: join(directory, "html"),
        PLAYWRIGHT_HTML_OPEN: "never",
      },
    );
    if (merged.exitCode !== 0)
      problems.push(`Native report merge exited ${merged.exitCode}`);
  } else problems.push("No native blob reports available");
  try {
    summary = assertAggregate(
      process.env.MOYA_E2E_SHARD_JOB_RESULT,
      identity,
      inputs,
      readJson(join(directory, "merged-report.json")),
    );
  } catch (error) {
    problems.push(String(error));
  }
  writeJson(join(directory, "aggregate.json"), {
    identity,
    requiredShardJobResult: process.env.MOYA_E2E_SHARD_JOB_RESULT,
    artifactDirectories: directories.map((entry) => entry.name),
    summary,
    problems,
    passed: problems.length === 0,
  });
  return problems.length === 0 ? 0 : 1;
}

try {
  if (mode === "merge") process.exitCode = await merge();
  else if (
    ["prepare", "run"].includes(mode) &&
    /^[1-3]$/u.test(shardArgument ?? "")
  ) {
    process.exitCode = await runShard(Number(shardArgument));
  } else throw new Error("Usage: e2e-ci.mjs prepare|run <1|2|3>, or merge");
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
