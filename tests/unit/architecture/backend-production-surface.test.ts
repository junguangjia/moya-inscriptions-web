import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractModuleReferences,
  repositoryRoot,
} from "./workspace-scanner.js";

const productionRoot = path.join(
  repositoryRoot,
  "services",
  "backend-production",
);

const collectTypeScript = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await collectTypeScript(entryPath)));
    else if (entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files.sort();
};

describe("@moya/backend-production composition boundary", () => {
  it("declares exactly the runtime, adapter, Pilot and official COS SDK dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(productionRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).toEqual({
      "@moya/agent-authorization": "workspace:*",
      "@moya/catalog-importer": "workspace:*",
      "@moya/backend-runtime": "workspace:*",
      "@moya/catalog-postgres": "workspace:*",
      "@moya/community-postgres": "workspace:*",
      "@moya/image": "workspace:*",
      "cos-nodejs-sdk-v5": "3.0.0",
      sharp: "0.35.4",
    });
  });

  it("imports approved backend roots and confines the COS SDK to storage", async () => {
    const approved = new Set([
      "@moya/agent-authorization",
      "@moya/catalog-importer",
      "@moya/backend-runtime",
      "@moya/catalog-postgres",
      "@moya/community-postgres",
      "@moya/image",
    ]);
    const violations: string[] = [];
    for (const file of await collectTypeScript(
      path.join(productionRoot, "src"),
    )) {
      const source = await readFile(file, "utf8");
      for (const reference of extractModuleReferences(source)) {
        const isCosSdk =
          reference.specifier === "cos-nodejs-sdk-v5" ||
          reference.specifier.startsWith("cos-nodejs-sdk-v5/");
        const isStorageFile = file.startsWith(
          path.join(productionRoot, "src", "storage") + path.sep,
        );
        if (
          (reference.specifier.startsWith("@moya/") &&
            !approved.has(reference.specifier)) ||
          (isCosSdk &&
            (!isStorageFile || reference.specifier !== "cos-nodejs-sdk-v5"))
        ) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports ${reference.specifier}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
