import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

const appRoot = path.join(repositoryRoot, "apps", "web", "app");

const collectRoutes = async (directory: string): Promise<string[]> => {
  const routes: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) routes.push(...(await collectRoutes(entryPath)));
    else if (entry.name === "page.tsx" || entry.name === "route.ts")
      routes.push(path.relative(appRoot, entryPath).split(path.sep).join("/"));
  }
  return routes;
};

/**
 * How each Web entry point is kept behind the product access policy
 * (closed-beta-access-v1, Issue #212). A new page or route handler fails this
 * test until it is placed in one of these groups, each with its own proof:
 *
 * - `page`      decides on the server with `readVisitorAccess` before loading anything;
 * - `content`   serves files of its own and asks `isProductAccessGranted` first;
 * - `session`   relays to the Backend with the visitor's session, and the
 *               Backend's gate decides;
 * - `bootstrap` obtains, reads or ends a session and serves no product content;
 * - `operator`  answers only to a separate Admin session;
 * - `development` does not exist outside NODE_ENV=development;
 * - `asset`     serves design-system styles and brand files only;
 * - `redirect`  carries nothing but a location.
 */
const routes: Readonly<Record<string, string>> = {
  "page.tsx": "page",
  "article-authoring/approval/page.tsx": "page",
  "article-authoring/consent/[uid]/page.tsx": "page",
  "docs/prototypes/mobile-preview/route.ts": "content",
  "docs/prototypes/mobile-preview/[...path]/route.ts": "content",
  "api/catalog/route.ts": "session",
  "api/catalog/[catalogId]/route.ts": "session",
  "api/catalog/[catalogId]/comments/route.ts": "session",
  "api/catalog/[catalogId]/comments/[commentId]/replies/route.ts": "session",
  "api/catalog-search/route.ts": "session",
  "api/community/[...path]/route.ts": "session",
  "api/community/notifications/stream/route.ts": "session",
  "api/community/publishing/media/[itemId]/[variant]/[editKey]/route.ts":
    "session",
  "api/community/publishing/uploads/[componentId]/route.ts": "session",
  "api/community/auth/[...path]/route.ts": "bootstrap",
  "api/community/me/route.ts": "bootstrap",
  "login/page.tsx": "bootstrap",
  "register/page.tsx": "bootstrap",
  "editorial-preview/[id]/page.tsx": "operator",
  "api/catalog/[catalogId]/media/[mediaId]/route.ts": "development",
  "api/community/development/sign-in/route.ts": "development",
  "api/community/development/sign-out/route.ts": "development",
  "api/editorial-media/[owner]/[file]/route.ts": "development",
  "dev/community/page.tsx": "development",
  "dev/community/preview/page.tsx": "development",
  "dev/t02p/page.tsx": "development",
  "dev/t02p/qa/page.tsx": "development",
  "login/agreements/page.tsx": "development",
  "docs/design-system/assets/[[...path]]/route.ts": "asset",
  "packages/design-tokens/src/theme.css/route.ts": "asset",
  "packages/ui/src/assets/[[...path]]/route.ts": "asset",
  "packages/ui/src/brand.css/route.ts": "asset",
  "packages/ui/src/styles.css/route.ts": "asset",
  "catalog/[catalogId]/route.ts": "redirect",
};

const proof: Readonly<Record<string, RegExp>> = {
  page: /\breadVisitorAccess\(\)/u,
  content: /\bisProductAccessGranted\(request\)/u,
  // Either the handler hands the session cookie on itself, or it uses a relay
  // from the server module, each of which does.
  session:
    /\breadCommunitySessionToken\(|\brelay(?:ServerAuthorCommunity|NotificationStream|ServerPublishingMedia|ServerPublishingUpload)\b/u,
  bootstrap:
    /\brelayServerCommunityAuth\b|\bfetchServerCurrentUser\b|<AuthPage\b/u,
  operator: /\bfetchServerEditorialPreview\(/u,
  development: /NODE_ENV\s*!==\s*"development"/u,
  asset: /kind: "(?:demo-assets|design-tokens|ui-styles|ui-assets)"/u,
  redirect: /Response\.redirect\(/u,
};

describe("product access covers every Web entry point", () => {
  it("places each page and route handler in exactly one access group", async () => {
    expect((await collectRoutes(appRoot)).sort()).toEqual(
      Object.keys(routes).sort(),
    );
  });

  it("finds each group's proof in the entry point itself", async () => {
    const missing: string[] = [];
    for (const [route, group] of Object.entries(routes)) {
      const pattern = proof[group];
      if (
        pattern === undefined ||
        !pattern.test(await readFile(path.join(appRoot, route), "utf8"))
      )
        missing.push(`${route} (${group})`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps the Backend gate's unprotected operations at the named bootstrap list", async () => {
    const gate = await readFile(
      path.join(
        repositoryRoot,
        "services/backend-runtime/src/http/product-access-gate.ts",
      ),
      "utf8",
    );
    const listed = (name: string): string[] => {
      const body = new RegExp(
        `const ${name}: ReadonlySet<string> = new Set\\(\\[([\\s\\S]*?)\\]\\)`,
        "u",
      ).exec(gate)?.[1];
      expect(body).toBeDefined();
      return [...body!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    };
    expect(listed("openPaths")).toEqual([
      "/health",
      "/v1/me",
      "/v1/development/sign-in",
      "/v1/development/sign-out",
    ]);
    expect(listed("openAuthOperations")).toEqual([
      "GET capabilities",
      "POST challenges",
      "POST challenges/verify",
      "POST passwords/login",
      "POST passwords/reset",
      "POST registrations",
      "POST sign-out",
    ]);
    // No prefix, method or namespace is open as a whole.
    expect(gate).toContain('const operatorPrefix = "/internal/community/";');
    expect(gate).not.toMatch(/startsWith\("\/v1\/?"\)|startsWith\("\/api/u);
    expect(gate).not.toMatch(/method === "GET"\s*\)\s*return "open"/u);
    // The application always composes the gate in front of the router.
    const application = await readFile(
      path.join(repositoryRoot, "services/backend-runtime/src/application.ts"),
      "utf8",
    );
    expect(application).toMatch(
      /return createProductAccessGate\(\s*\{[\s\S]*?\},\s*createRouter\(/u,
    );
  });

  it("keeps the image optimizer closed, so no cookie-blind cache can hold a protected image", async () => {
    const config = await readFile(
      path.join(repositoryRoot, "apps/web/next.config.ts"),
      "utf8",
    );
    expect(config).toContain(
      "images: { localPatterns: [], remotePatterns: [] }",
    );
  });
});
