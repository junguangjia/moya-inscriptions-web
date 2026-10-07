import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { readE2ePorts, readPagingWebPort } from "./support/e2e-ports";

const e2eRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(e2eRoot, "../..");
const ports = readE2ePorts();
const webBaseUrl = `http://127.0.0.1:${ports.web}`;
const publicApiBaseUrl = `http://127.0.0.1:${ports.publicApi}`;
const pagingPort = readPagingWebPort();
const defaultArtifactParent = resolve(
  process.env.MOYA_E2E_ARTIFACT_ROOT ?? tmpdir(),
);
if (!process.env.MOYA_E2E_ARTIFACT_DIR)
  mkdirSync(defaultArtifactParent, { recursive: true, mode: 0o700 });
const artifactRoot = resolve(
  process.env.MOYA_E2E_ARTIFACT_DIR ??
    mkdtempSync(resolve(defaultArtifactParent, "moya-e2e-")),
);
// The daily smoke (scripts/ci-e2e-smoke.mjs) passes the fixture startup
// timeout it derived from its BROWSER SMOKE ceiling and the parent's remaining
// time, so no server timeout can outlive the run. The explicitly selected
// full cross-browser regression has no test/suite execution deadline.
// Playwright 1.62.1 treats webServer timeout 0 as its 60 s default; its
// availability wait therefore uses the unavoidable hosted-job ceiling.
const hostedJobCeilingMs = 6 * 60 * 60 * 1000;
const webServerTimeoutMs = (() => {
  const value = process.env.MOYA_E2E_WEBSERVER_TIMEOUT_MS;
  return value && /^[1-9]\d*$/u.test(value)
    ? Number(value)
    : hostedJobCeilingMs;
})();

export default defineConfig({
  ...(process.env.CI ? { workers: 1 } : {}),
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  fullyParallel: false,
  globalTimeout: 0,
  metadata: {
    moyaCI: {
      sourceHead: process.env.MOYA_E2E_SOURCE_HEAD,
      checkoutSha: process.env.MOYA_E2E_CHECKOUT_SHA,
      tree: process.env.MOYA_E2E_CHECKOUT_TREE,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    },
  },
  outputDir: resolve(artifactRoot, "test-results"),
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "desktop-webkit",
      use: { ...devices["Desktop Safari"], browserName: "webkit" },
    },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      name: "tablet-webkit",
      use: { ...devices["iPad Pro 11"], browserName: "webkit" },
    },
    {
      name: "tablet-landscape-webkit",
      use: {
        ...devices["iPad Pro 11"],
        browserName: "webkit",
        viewport: { height: 834, width: 1194 },
      },
    },
  ],
  reporter: process.env.CI
    ? [
        ["github"],
        ["blob", { outputDir: resolve(artifactRoot, "blob") }],
        ["json", { outputFile: resolve(artifactRoot, "report.json") }],
      ]
    : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: e2eRoot,
  testIgnore: ["support/**"],
  testMatch: "*.spec.ts",
  timeout: 0,
  use: {
    baseURL: webBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure-and-retries",
  },
  webServer: [
    {
      command: "node tests/e2e/support/public-api.ts",
      name: "Public API fixture",
      stdout: "pipe",
      stderr: "pipe",
      cwd: repositoryRoot,
      timeout: webServerTimeoutMs,
      url: `${publicApiBaseUrl}/health`,
    },
    {
      command: "node tests/e2e/support/start-formal-web.ts",
      name: "Formal Web fixture",
      stdout: "pipe",
      stderr: "pipe",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AI_AGENT: "",
        CODEX_CI: "",
        CODEX_SANDBOX: "",
        CODEX_THREAD_ID: "",
        MOYA_PUBLIC_API_BASE_URL: `${publicApiBaseUrl}/`,
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: webServerTimeoutMs,
      url: webBaseUrl,
    },
    {
      // Cold process/library preparation belongs to service startup before
      // the paging hook. The immutable
      // paging dataset is shared; each test still owns its browser and faults.
      command: "node tests/e2e/support/start-formal-web.ts",
      name: "Paging Web fixture",
      stdout: "pipe",
      stderr: "pipe",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AI_AGENT: "",
        CODEX_CI: "",
        CODEX_SANDBOX: "",
        CODEX_THREAD_ID: "",
        MOYA_E2E_WEB_PORT: String(pagingPort),
        MOYA_PUBLIC_API_BASE_URL: `${publicApiBaseUrl}/paging/`,
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: webServerTimeoutMs,
      url: `http://127.0.0.1:${pagingPort}`,
    },
  ],
});
