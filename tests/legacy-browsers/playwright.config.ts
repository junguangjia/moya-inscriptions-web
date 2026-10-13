import { defineConfig } from "@playwright/test";

// Runs inside mcr.microsoft.com/playwright:v1.31.2-jammy (Chromium 111, WebKit
// 16.4) and v1.32.3-jammy (Firefox 111) with the matching @playwright/test, so
// only options those versions know appear here. The Web production build and
// its Public API fixture run outside the container (run.mjs).
const baseURL = process.env.LEGACY_BASE_URL;
if (!baseURL) throw new Error("LEGACY_BASE_URL is required");

export default defineConfig({
  testDir: ".",
  testMatch: "*.legacy.ts",
  workers: 1,
  retries: 0,
  // Like the main suite: no test timeout. Every action is preceded by a
  // bounded expectation and run.mjs stops a lane that goes silent.
  timeout: 0,
  expect: { timeout: 10_000 },
  outputDir: `${process.env.LEGACY_OUTPUT_DIR ?? "."}/test-results`,
  use: {
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
