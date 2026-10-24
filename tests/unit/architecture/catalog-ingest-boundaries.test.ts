import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  discoverWorkspaces,
  extractModuleReferences,
  repositoryRoot,
  type WorkspaceInfo,
} from "./workspace-scanner.js";
import { createCatalogIngestEndpoints } from "admin/media-ingest";

/*
 * catalog-scale-v1 increment 2 boundaries. The Admin's ingest signs one
 * staging PUT with one function, never imports the Backend, the worker or
 * the publishing code, composes its dev-only route for the Development store
 * only, logs fixed categories only, and relies on in-process budgets and
 * mutexes that hold only while Production runs a single Admin process.
 */

const media = path.join(repositoryRoot, "apps", "admin", "src", "media");
const INGEST_MODULES = [
  "catalog-ingest.ts",
  "ingest-storage.ts",
  "ingest-dev-put.ts",
  "image-header.ts",
  "ingest-probes.ts",
].map((name) => path.join(media, name));
let admin: WorkspaceInfo;
const sources = new Map<string, string>();
const relative = (file: string) => path.relative(repositoryRoot, file);

beforeAll(async () => {
  admin = (await discoverWorkspaces()).find(
    ({ manifest }) => manifest.name === "admin",
  )!;
  for (const file of admin.sourceFiles)
    sources.set(file, await readFile(file, "utf8"));
});

const importers = (specifier: string) =>
  [...sources]
    .filter(([, source]) =>
      extractModuleReferences(source).some(
        (reference) => reference.specifier === specifier,
      ),
    )
    .map(([file]) => relative(file))
    .sort();

describe("Catalog ingest boundaries", () => {
  it("has exactly one presigner, the staging PUT signer", () => {
    expect(importers("@aws-sdk/s3-request-presigner")).toEqual([
      "apps/admin/src/media/ingest-storage.ts",
    ]);
    expect(importers("@aws-sdk/client-s3")).toEqual([
      "apps/admin/src/media/ingest-storage.ts",
    ]);
    const storage = sources.get(path.join(media, "ingest-storage.ts"))!;
    expect(storage.match(/\bgetSignedUrl\s*\(/g)).toHaveLength(1);
    const signer = storage.slice(
      storage.indexOf("export async function signStagingPut("),
    );
    expect(signer.indexOf("getSignedUrl(")).toBeGreaterThan(0);
    expect(signer.indexOf("getSignedUrl(")).toBeLessThan(
      signer.indexOf("\n}\n"),
    );
    // No other module of the Admin builds a signed URL by any route.
    for (const [file, source] of sources)
      if (!file.endsWith(path.join("media", "ingest-storage.ts")))
        expect(source, relative(file)).not.toMatch(
          /getSignedUrl|S3RequestPresigner|X-Amz-Signature/,
        );
  });

  it("imports no Backend, worker, publishing or App database code", () => {
    for (const file of INGEST_MODULES) {
      const references = extractModuleReferences(sources.get(file)!);
      expect(references.length, relative(file)).toBeGreaterThan(0);
      for (const { specifier } of references)
        expect(specifier, relative(file)).not.toMatch(
          /^@moya\/(?:backend-|community-postgres|catalog-postgres|api|public-api)|services\/|publishing|publication/,
        );
    }
  });

  it("runs the staging dry run only from its Owner-run script, never from a route", () => {
    expect(importers("./ingest-probes")).toEqual([]);
    expect(importers("../src/media/ingest-probes")).toEqual([
      "apps/admin/scripts/catalog-ingest-probes.ts",
    ]);
    const users = [...sources]
      .filter(([, source]) => /\bcreateCosIngestProbeStorage\b/.test(source))
      .map(([file]) => relative(file))
      .sort();
    expect(users).toEqual([
      "apps/admin/scripts/catalog-ingest-probes.ts",
      "apps/admin/src/media/ingest-storage.ts",
    ]);
  });

  it("lets only the ingest endpoint set the verified-ingest marker", () => {
    const users = [...sources]
      .filter(([, source]) => /\bwithVerifiedIngest\b/.test(source))
      .map(([file]) => relative(file))
      .sort();
    expect(users).toEqual([
      "apps/admin/src/media/catalog-ingest.ts",
      "apps/admin/src/media/collection.ts",
    ]);
    const collection = sources.get(path.join(media, "collection.ts"))!;
    expect(collection).toMatch(
      /^const verifiedIngests = new WeakMap<PayloadRequest, VerifiedIngest>\(\);$/m,
    );
    expect(collection).not.toMatch(/export\s+(?:const|let)\s+verifiedIngests/);
  });

  it("composes ingest only behind CMS_CATALOG_INGEST, and the dev PUT never in production", () => {
    const config = sources.get(
      path.join(repositoryRoot, "apps", "admin", "payload.config.ts"),
    )!;
    expect(config.match(/createCatalogIngestEndpoints\(/g)).toHaveLength(1);
    expect(config).toMatch(
      /\.\.\.\(catalogIngestEnabled\(\)\s*\?\s*createCatalogIngestEndpoints\(/,
    );
    expect(importers("./ingest-dev-put")).toEqual([
      "apps/admin/src/media/catalog-ingest.ts",
    ]);
    const routes = (environment: Record<string, string>) =>
      createCatalogIngestEndpoints({
        mediaDirectory: "/synthetic/media",
        stagingDirectory: "/synthetic/editorial-ingest-staging",
        environment,
      }).map(({ method, path: route }) => `${method} ${route}`);
    const devPut = "put /editorial/media-ingest/dev-put/:ingestId";
    for (const environment of [
      { CMS_STORAGE_MODE: "cos", CMS_ENVIRONMENT: "production" },
      { CMS_STORAGE_MODE: "local", CMS_ENVIRONMENT: "production" },
      { CMS_ENVIRONMENT: "production" },
      { CMS_STORAGE_MODE: "cos", CMS_ENVIRONMENT: "synthetic" },
    ])
      expect(routes(environment)).not.toContain(devPut);
    expect(
      routes({ CMS_STORAGE_MODE: "local", CMS_ENVIRONMENT: "synthetic" }),
    ).toContain(devPut);
  });

  it("logs fixed, allow-listed categories only", () => {
    const settings = sources.get(
      path.join(repositoryRoot, "apps", "admin", "src", "runtime-settings.ts"),
    )!;
    for (const file of INGEST_MODULES) {
      const source = sources.get(file)!;
      const calls = [...source.matchAll(/logger\.(\w+)\(([^)]*)\)/g)];
      for (const [, , argument] of calls) {
        const category = /^\s*\{\s*category:\s*"([A-Z_]+)",?\s*\}\s*$/.exec(
          argument!,
        )?.[1];
        expect(category, relative(file)).toMatch(/^EDITORIAL_MEDIA_INGEST_/);
        expect(settings).toContain(`"${category}"`);
      }
      expect(source, relative(file)).not.toMatch(/console\./);
    }
  });

  it("relies on one Admin process, as the Production unit runs it", async () => {
    const unit = await readFile(
      path.join(
        repositoryRoot,
        "infra",
        "production",
        "systemd",
        "yoyi-admin.service",
      ),
      "utf8",
    );
    // In-memory budgets and per-mediaId mutexes are sound for exactly one
    // `next start`; a multi-process Admin would need database leases.
    expect(unit.match(/^ExecStart=.*$/gm)).toEqual([
      "ExecStart=/usr/bin/env NODE_ENV=production node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3002",
    ]);
    expect(unit).not.toMatch(/cluster|pm2|--workers|instances/i);
  });
});
