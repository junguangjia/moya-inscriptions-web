import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractModuleReferences,
  repositoryRoot,
} from "./workspace-scanner.js";

const runtimeRoot = path.join(repositoryRoot, "services", "backend-runtime");

const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files.sort();
};

describe("@moya/backend-runtime package boundary", () => {
  it("has only the approved internal runtime dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).toEqual({
      "@moya/api": "workspace:*",
      "@moya/contracts": "workspace:*",
      "@moya/image": "workspace:*",
      "@moya/public-api": "workspace:*",
      "@moya/search": "workspace:*",
    });
  });

  it("exposes only runtime composition and lifecycle values", async () => {
    expect(Object.keys(await import("@moya/backend-runtime")).sort()).toEqual([
      "NotificationSignals",
      "assertProductionAuthConfiguration",
      "createBackendApplication",
      "createBackendServer",
      "createDevelopmentAuthService",
      "createDevelopmentCatalogFixtureQueryPort",
      "createPublishingTransferRegistry",
      "installProcessShutdownHandlers",
      "parseRuntimeConfig",
      "startBackendProcess",
      "startServer",
      "stopServer",
      "trustedRequestSource",
    ]);
  });

  it("keeps runtime workspace imports on the approved application and contract roots", async () => {
    const violations: string[] = [];
    const approvedImports = new Set([
      "@moya/api",
      "@moya/contracts",
      "@moya/contracts/schemas",
      "@moya/image",
      "@moya/public-api",
      "@moya/search",
    ]);
    const sourceFiles = await collectTypeScriptFiles(
      path.join(runtimeRoot, "src"),
    );

    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      for (const reference of extractModuleReferences(source)) {
        if (
          reference.specifier.startsWith("@moya/") &&
          !approvedImports.has(reference.specifier)
        ) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports ${reference.specifier}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps SQL and PostgreSQL implementation details out of the HTTP runtime", async () => {
    const forbidden = [
      /\bDATABASE_URL\b/,
      /\b(?:Pool|PoolClient|QueryResult)\b/,
      /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM)\b/i,
    ];
    const violations: string[] = [];

    for (const file of await collectTypeScriptFiles(
      path.join(runtimeRoot, "src"),
    )) {
      const source = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(path.relative(repositoryRoot, file));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps lower and contract boundaries independent of the runtime", async () => {
    const guardedRoots = [
      path.join(repositoryRoot, "packages", "contracts", "src"),
      path.join(repositoryRoot, "services", "api", "src"),
      path.join(repositoryRoot, "services", "public-api", "src"),
    ];
    const violations: string[] = [];

    for (const root of guardedRoots) {
      for (const file of await collectTypeScriptFiles(root)) {
        const source = await readFile(file, "utf8");
        for (const reference of extractModuleReferences(source)) {
          if (
            reference.specifier === "@moya/backend-runtime" ||
            reference.specifier === "@moya/backend-production" ||
            reference.specifier === "@moya/catalog-postgres"
          ) {
            violations.push(path.relative(repositoryRoot, file));
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
