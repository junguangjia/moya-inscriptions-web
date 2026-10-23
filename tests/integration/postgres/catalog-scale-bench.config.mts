import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import base from "../../vitest.config.mts";

// catalog-scale-v1 W0: runs only the local scale bench
// (catalog-scale-bench.ts) and, since W6, the 25k index plans
// (catalog-scale-indexes.ts), one file at a time and with long budgets. No
// suite includes either; see docs/development/catalog-scale-bench.md.
export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    test: {
      include: [
        "integration/postgres/catalog-scale-bench.ts",
        "integration/postgres/catalog-scale-indexes.ts",
      ],
      fileParallelism: false,
      maxWorkers: 1,
      testTimeout: 60 * 60_000,
      hookTimeout: 10 * 60_000,
    },
  }),
);
