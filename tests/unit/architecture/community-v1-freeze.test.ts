import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

// Freeze guard for docs/governance/amendments/2026-09-11-community-v1-scope.md
// section 9. Each assertion pins a repository fact that is true on main today;
// the mission named in that section replaces the pinned value in the same pull
// request that changes it. Mission 2A replaced rows 2, 3, 4 and 5 with the
// identity/session values below; 2B owns the next change to rows 1, 2 and 3.

const read = (file: string) =>
  readFile(path.join(repositoryRoot, file), "utf8");
const visibleEntries = async (directory: string) =>
  (await readdir(path.join(repositoryRoot, directory)))
    .filter((name) => !name.startsWith("."))
    .sort();

const walkFiles = async (
  directory: string,
  files: string[] = [],
): Promise<string[]> => {
  const entries = await readdir(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (
      (entry.name.startsWith(".") && !/^\.env(?:\.|$)/u.test(entry.name)) ||
      ["node_modules", "dist", "coverage", "playwright-report"].includes(
        entry.name,
      )
    )
      continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(relative, files);
    else if (
      /\.(?:[cm]?[jt]sx?|json|sql|md|ya?ml|sh|example)$/u.test(entry.name)
    )
      files.push(relative);
  }
  return files;
};

describe("Community V1 freeze (amendment 2026-09-11, section 9)", () => {
  it("1. keeps the internal contracts subpaths at catalog-import, community-operator and editorial (2B)", async () => {
    expect(await visibleEntries("packages/contracts/src/internal")).toEqual([
      "catalog-import",
      "community-operator",
      "editorial",
    ]);
    // The operator shapes stay server-only: never a root export, never OpenAPI.
    const rootExports = await read("packages/contracts/src/index.ts");
    expect(rootExports).not.toMatch(
      /PublicationPolicy|OperatorComment|Moderation/u,
    );
    const openapi = await read("services/public-api/src/openapi-document.ts");
    expect(openapi).not.toContain("community-operator");
  });

  it("2. keeps ApiErrorCode at the four existing codes plus UNAUTHENTICATED (2A) and INVALID_INPUT (2B)", async () => {
    const schemas = await read("packages/contracts/src/schemas.ts");
    const enumBody = /apiErrorCodeSchema = z\.enum\(\[([\s\S]*?)\]\)/u.exec(
      schemas,
    );
    expect(enumBody).not.toBeNull();
    expect(
      [...enumBody![1]!.matchAll(/"([A-Z_]+)"/gu)].map((m) => m[1]),
    ).toEqual([
      "CONFLICT",
      "INVALID_QUERY",
      "INVALID_INPUT",
      "ITEM_NOT_FOUND",
      "UNAUTHENTICATED",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_ERROR",
    ]);
  });

  it("3. keeps the Backend router at the Catalog routes, /v1/me, the Development session lifecycle (2A) and the comment paths (2B)", async () => {
    const router = await read("services/backend-runtime/src/http/router.ts");
    expect(
      [...router.matchAll(/pathname === "([^"]+)"/gu)].map((m) => m[1]),
    ).toEqual([
      "/health",
      "/v1/catalog",
      "/v1/catalog-search",
      "/v1/me",
      "/v1/development/sign-in",
      "/v1/development/sign-out",
      // Owner r2 notification scope; composition remains Development-only.
      "/v1/community/mentions",
      "/v1/community/notifications",
    ]);
    // One Catalog detail route plus the two comment routes of Mission 2B.
    expect(router.match(/\.exec\(pathname\)/gu)).toHaveLength(3);
    expect(router).toContain("/^\\/v1\\/catalog\\/([^/]+)$/");
    expect(router).toContain("/^\\/v1\\/catalog\\/([^/]+)\\/comments$/");
    expect(router).toContain(
      "/^\\/v1\\/catalog\\/([^/]+)\\/comments\\/([^/]+)\\/replies$/",
    );
    // The Development entry is composed only behind the explicit flag.
    expect(router).toContain("community?.developmentEntry === true");
    // The operator boundary is an internal subpath, never a /v1 Public API path.
    expect(router).toContain('pathname.startsWith("/internal/community/")');
    expect(router).not.toMatch(/"\/v1\/[^"]*(?:moderation|operator|internal)/u);
  });

  it("4. keeps the application modules at catalog and community (2A)", async () => {
    // content-community-completion-v1 (2026-09-22 amendment) adds the
    // published editorial content read module.
    expect(await visibleEntries("services/api/src/modules")).toEqual([
      "catalog",
      "community",
      "editorial",
    ]);
  });

  it("5. keeps legacy/payload migrations apart from the community family and the App role in the composition root only (2A)", async () => {
    const migrate = await read("scripts/migrate.mjs");
    expect(migrate).toContain('source !== "legacy" && source !== "payload"');
    expect(migrate).not.toMatch(/community|APP_DATABASE_URL/u);
    const communityMigrate = await read("scripts/migrate-community.mjs");
    // The community family is never selected by the content source switch.
    expect(communityMigrate).not.toMatch(
      /environment\.MOYA_CONTENT_SOURCE|\[["']MOYA_CONTENT_SOURCE["']\]/u,
    );
    expect(communityMigrate).toContain('"APP_MIGRATION_DATABASE_URL"');
    const files = (
      await Promise.all(
        ["apps", "services", "packages", "scripts"].map((root) =>
          walkFiles(root),
        ),
      )
    ).flat();
    const offenders: string[] = [];
    for (const file of files) {
      if ((await read(file)).includes("APP_DATABASE_URL")) offenders.push(file);
    }
    expect(offenders).toEqual([
      "services/backend-production/src/composition.ts",
    ]);
  });

  it("6. keeps Payload users limited to owner and automation roles", async () => {
    const users = await read("apps/admin/src/users.ts");
    expect([...users.matchAll(/value: "([a-z]+)"/gu)].map((m) => m[1])).toEqual(
      ["owner", "automation"],
    );
  });

  it("keeps Payload free of community collections and community database access (2B)", async () => {
    const config = await read("apps/admin/payload.config.ts");
    const slugs = [...config.matchAll(/slug: "([a-z-]+)"/gu)].map((m) => m[1]);
    for (const forbidden of [
      "comments",
      "catalog-comments",
      "public-users",
      "community",
    ])
      expect(slugs).not.toContain(forbidden);
    // Admin reaches community data only through the Backend operator boundary.
    const adminFiles = await walkFiles("apps/admin");
    const offenders: string[] = [];
    for (const file of adminFiles) {
      const source = await read(file);
      if (
        /APP_DATABASE_URL|community\.(?:catalog_comments|public_users|sessions|publication_setting|moderation_events)/u.test(
          source,
        )
      )
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
    expect(await read("apps/admin/src/community/backend.ts")).toContain(
      "internal/community/",
    );
  });

  it("keeps the live comment client behind one plain loader module (2B preview)", async () => {
    // Client Components never touch the Web Public API boundary; the one
    // plain module that imports the same-origin comment client is the loader
    // that carries the DTO -> presentation mapper beside it.
    const importers: string[] = [];
    for (const file of await walkFiles("apps/web")) {
      if (/\.test\.[cm]?[jt]sx?$/u.test(file)) continue;
      const source = await read(file);
      if (
        /from\s+["'][^"']*public-api\/catalog-comments-client["']/u.test(source)
      )
        importers.push(file);
    }
    expect(importers).toEqual(["apps/web/features/comments/live-comments.ts"]);
  });

  it("keeps every Payload endpoint path clear of the public community prefix (2B)", async () => {
    // Payload mounts its endpoints under /api, so a Payload path of
    // /community/... would land on /api/community/..., which is the public
    // Community read surface. The moderation endpoints carry their own prefix.
    const paths: string[] = [];
    for (const file of await walkFiles("apps/admin")) {
      const source = await read(file);
      for (const match of source.matchAll(
        /\bpath: [`"](\/[^`"$]*)(\$\{[^}]+\})?/gu,
      ))
        paths.push(match[1] ?? "");
    }
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/community/")).toBe(false);
      expect(path).not.toBe("/community");
    }
    expect(paths).toContain("/community-moderation/");
  });
});
