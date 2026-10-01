import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const profile = process.env.AUTH_UI_PROFILE ?? "full-local";
if (profile !== "full-local" && profile !== "email-first")
  throw new Error("AUTH_UI_PROFILE must select a local Development profile");

const loopbackOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Auth UI acceptance requires an explicit loopback origin");
  return url.origin;
};

export default defineConfig({
  testDir: ".",
  testMatch:
    process.env.AUTH_UI_JOURNEY === "password"
      ? "auth-password.development.ts"
      : "auth-ui.development.ts",
  outputDir: resolve(
    process.env.AUTH_UI_ARTIFACT_DIR ?? `.local/auth-ui-e2e/${profile}`,
  ),
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 105_000,
  globalTimeout: 299_000,
  expect: { timeout: 12_000 },
  reporter: "list",
  metadata: {
    authDevelopment: {
      profile,
      sourceHead: process.env.AUTH_UI_SOURCE_HEAD,
      sourceFingerprint: process.env.AUTH_UI_SOURCE_FINGERPRINT,
    },
  },
  use: {
    baseURL: loopbackOrigin(
      process.env.AUTH_UI_BASE_URL ?? "http://127.0.0.1:3550",
    ),
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "mobile-390-webkit",
      use: {
        ...devices["iPhone 15"],
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "mobile-320-webkit",
      use: {
        ...devices["iPhone SE"],
        browserName: "webkit",
        viewport: { width: 320, height: 568 },
      },
    },
  ],
});
