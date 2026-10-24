import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import base from "../../vitest.config.mts";

// catalog-scale-v1 W0: runs only the local scale bench
// (catalog-scale-bench.ts), since W6 the 25k index plans
// (catalog-scale-indexes.ts) and since increment 2 (S5b) the sandbox render
// timing (catalog-render-bench.ts), one file at a time and with long budgets.
// No suite includes any of them; see docs/development/catalog-scale-bench.md.
export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    test: {
      include: [
        "integration/postgres/catalog-scale-bench.ts",
        "integration/postgres/catalog-scale-indexes.ts",
        "integration/postgres/catalog-render-bench.ts",
      ],
      fileParallelism: false,
      maxWorkers: 1,
      testTimeout: 60 * 60_000,
      hookTimeout: 10 * 60_000,
    },
  }),
);
