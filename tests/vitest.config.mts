import { defineConfig } from "vitest/config";

// Admin uses Next's preserved JSX in production. Component regressions need
// the automatic React transform when imported into this test workspace.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  // Keep password hashing and child-process budget checks from competing with
  // an unbounded number of workers during the combined application build.
  // Hosted runners are slower than the 5 s default allows for database tests,
  // so these match what verify-cms gives the CMS suite (Owner, 2026-11-04).
  test: { maxWorkers: 2, testTimeout: 30_000, hookTimeout: 60_000 },
});
