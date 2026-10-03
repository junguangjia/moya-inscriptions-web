import { defineConfig } from "vitest/config";

// Admin uses Next's preserved JSX in production. Component regressions need
// the automatic React transform when imported into this test workspace.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  // Keep password hashing and child-process budget checks from competing with
  // an unbounded number of workers during the combined application build.
  test: { maxWorkers: 2 },
});
