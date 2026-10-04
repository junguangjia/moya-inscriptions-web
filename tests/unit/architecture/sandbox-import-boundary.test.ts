import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractModuleReferences,
  repositoryRoot,
} from "./workspace-scanner.js";

/*
 * The media sandbox boundary (unified media pipeline, W12): `sharp` and every
 * untrusted-byte parser run only inside the sandbox renderer. The Backend and
 * the media worker's coordinator never reach `sharp` at runtime, and the
 * renderer that runs inside the container (with only the release `dist` and
 * the image's `sharp` available) reaches nothing but Node built-ins, `sharp`
 * and the processing and sandbox modules. The media worker does not load the
 * Backend composition either.
 */

const sourceRoot = path.join(
  repositoryRoot,
  "services",
  "backend-production",
  "src",
);

/** Runtime (non type-only) module closure of `entry` inside the package. */
const runtimeClosure = async (entry: string) => {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    files.add(file);
    const source = await readFile(file, "utf8");
    for (const reference of extractModuleReferences(source)) {
      if (reference.typeOnly) continue;
      if (!reference.specifier.startsWith(".")) {
        bare.set(reference.specifier, path.relative(sourceRoot, file));
        continue;
      }
      const target = path
        .resolve(path.dirname(file), reference.specifier)
        .replace(/\.js$/, ".ts");
      await stat(target);
      await visit(target);
    }
  };
  await visit(path.join(sourceRoot, entry));
  return {
    files: [...files].map((file) => path.relative(sourceRoot, file)).sort(),
    bare,
  };
};

describe("media sandbox import boundary", () => {
  it("keeps sharp out of the Backend, the media worker and the coordinator", async () => {
    for (const entry of [
      "main.ts",
      "composition.ts",
      "worker-main.ts",
      "worker-composition.ts",
      "publishing/config.ts",
      "publishing/catalog.ts",
      "publishing/job-handlers.ts",
      "publishing/processing/media-processor.ts",
      "publishing/sandbox/sandbox-runner.ts",
    ]) {
      const closure = await runtimeClosure(entry);
      expect(closure.bare.has("sharp"), entry).toBe(false);
      expect(closure.files, entry).not.toContain(
        "publishing/processing/static-processor.ts",
      );
      expect(closure.files, entry).not.toContain(
        "publishing/sandbox/renderer.ts",
      );
    }
  });

  it("keeps the Backend composition and its HTTP runtime out of the media worker", async () => {
    for (const entry of ["worker-main.ts", "worker-composition.ts"]) {
      const closure = await runtimeClosure(entry);
      // The Community App role parser is the one module both roots share.
      expect(closure.files, entry).toContain("community-postgres-config.ts");
      expect(
        closure.files.filter(
          (file) =>
            file === "main.ts" ||
            file === "composition.ts" ||
            /^(?:article-authoring|auth|notifications)\//u.test(file),
        ),
        entry,
      ).toEqual([]);
    }
    // Only the worker entry uses the runtime's process shutdown helper; the
    // worker composition loads no Backend runtime (HTTP application, sign-in).
    expect(
      (await runtimeClosure("worker-composition.ts")).bare.has(
        "@moya/backend-runtime",
      ),
    ).toBe(false);
    const parser = path.join(sourceRoot, "community-postgres-config.ts");
    const importers: string[] = [];
    for (const name of await readdir(sourceRoot, { recursive: true })) {
      if (!name.endsWith(".ts")) continue;
      const file = path.join(sourceRoot, name);
      const imported = extractModuleReferences(await readFile(file, "utf8"))
        .filter((reference) => reference.specifier.startsWith("."))
        .map((reference) =>
          path
            .resolve(path.dirname(file), reference.specifier)
            .replace(/\.js$/, ".ts"),
        );
      if (imported.includes(parser)) importers.push(name);
    }
    expect(importers.sort()).toEqual([
      "composition.ts",
      "worker-composition.ts",
    ]);
  });

  it("lets the in-container renderer reach only node built-ins, sharp and the processing and sandbox modules", async () => {
    const closure = await runtimeClosure("publishing/sandbox/renderer-main.ts");
    expect(
      [...closure.bare.keys()].filter(
        (specifier) => !specifier.startsWith("node:") && specifier !== "sharp",
      ),
    ).toEqual([]);
    expect(
      closure.files.filter(
        (file) =>
          !file.startsWith("publishing/processing/") &&
          !file.startsWith("publishing/sandbox/"),
      ),
    ).toEqual([]);
    // The renderer never loads the store, the COS SDK, pg or the coordinator.
    for (const file of [
      "publishing/processing/media-processor.ts",
      "publishing/sandbox/sandbox-runner.ts",
    ])
      expect(closure.files).not.toContain(file);
    expect(closure.files).toContain("publishing/processing/recipes.ts");
    expect(closure.bare.has("sharp")).toBe(true);
  });

  it("shares one geometry module between the coordinator and the renderer", async () => {
    const coordinator = await runtimeClosure(
      "publishing/processing/media-processor.ts",
    );
    const renderer = await runtimeClosure("publishing/sandbox/renderer.ts");
    for (const closure of [coordinator, renderer])
      expect(closure.files).toContain("publishing/processing/recipes.ts");
    const sources = await Promise.all(
      ["static-processor.ts", "media-processor.ts", "recipes.ts"].map((name) =>
        readFile(
          path.join(sourceRoot, "publishing", "processing", name),
          "utf8",
        ),
      ),
    );
    // Only the registry computes output sizes.
    expect(
      sources.filter((source) => /Math\.round\(width \* scale\)/.test(source)),
    ).toHaveLength(1);
  });
});
