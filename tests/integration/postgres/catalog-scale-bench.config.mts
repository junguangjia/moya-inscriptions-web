import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import base from "../../vitest.config.mts";

// catalog-scale-v1 W0: runs only the local scale bench
// (catalog-scale-bench.ts), alone and with long budgets. No suite includes
// it; see docs/development/catalog-scale-bench.md.
export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    test: {
      include: ["integration/postgres/catalog-scale-bench.ts"],
      fileParallelism: false,
      maxWorkers: 1,
      testTimeout: 60 * 60_000,
      hookTimeout: 10 * 60_000,
    },
  }),
);
