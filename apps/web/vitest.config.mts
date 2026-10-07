import { defineConfig } from "vitest/config";

const contractSchemasPath = decodeURIComponent(
  new URL("../../packages/contracts/src/schemas.ts", import.meta.url).pathname,
);
const serverOnlyShimPath = decodeURIComponent(
  new URL("./test/server-only.ts", import.meta.url).pathname,
);

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@moya/contracts/schemas": contractSchemasPath,
      "server-only": serverOnlyShimPath,
    },
  },
  test: {
    // Stylesheets stay unprocessed (CSS modules resolve to class-name
    // proxies); only an explicit `?raw` import keeps the file's own text, so
    // a test can guard CSS rules without a file-system import.
    css: { include: [/\.css\?raw$/u] },
    environment: "node",
  },
});
