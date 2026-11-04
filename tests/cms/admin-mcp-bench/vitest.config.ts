import { defineConfig } from "vitest/config";

// L0 needs its seeded database, which run.mjs makes, so the file carries a name
// `vitest run cms` does not pick up.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["cms/admin-mcp-bench/l0.scale.ts"], maxWorkers: 1 },
});
