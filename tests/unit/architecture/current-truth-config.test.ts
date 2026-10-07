import { ARTICLE_DOCUMENT_LIMITS } from "@moya/contracts/schemas";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnv } from "node:util";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const readJson = async (filePath: string) =>
  JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

describe("current repository truth and local configuration", () => {
  it("keeps native OpenCC external in the standalone Admin server", async () => {
    const config = await readFile(
      path.join(repositoryRoot, "apps/admin/next.config.ts"),
      "utf8",
    );
    expect(config).toMatch(/serverExternalPackages:\s*\["opencc"\]/);
    expect(config).toContain('output: "standalone"');
    expect(config).toContain("export default withPayload(nextConfig)");
    expect(config).toContain("outputFileTracingIncludes:");
    for (const file of ["index.js", "package.json", "prebuilds/**/*.node"])
      expect(config).toContain(
        `../../node_modules/.pnpm/opencc@*/node_modules/@opencc/opencc-*/${file}`,
      );
  });

  it("keeps root development commands and port ownership explicit", async () => {
    const rootManifest = await readJson(
      path.join(repositoryRoot, "package.json"),
    );
    const adminManifest = await readJson(
      path.join(repositoryRoot, "apps", "admin", "package.json"),
    );

    expect(rootManifest.scripts).toMatchObject({
      dev: "pnpm dev:web",
      "dev:admin": "pnpm --filter admin dev",

      "dev:web": "pnpm --filter web dev",
    });
    const scripts = rootManifest.scripts as Record<string, string>;
    for (const command of ["dev:all", "dev:backend"]) {
      expect(scripts[command]).toContain("--env-file=.env.local");
      expect(scripts[command]).toContain("turbo watch dev");
      expect(scripts[command]).toContain("--filter=@moya/backend-production");
    }
    expect(scripts["dev:all"]).toContain("--filter=web");
    expect(scripts["dev:all"]).toContain("--filter=admin");
    expect(scripts["dev:migrate"]).toContain(
      "scripts/migrate.mjs --development",
    );
    // Community V1 (Mission 2A): the separate family, App-role grants and the
    // Development test accounts follow the Payload migrations, never precede them.
    // The Phase 4/publishing runtime grant follows the bootstrap grant and
    // precedes the test accounts (data-admin-hardening-v1).
    expect(scripts["dev:migrate"]).toMatch(
      /migrate\.mjs --development.*migrate-community\.mjs --development.*grant-community-app\.sql -f \/opt\/yoyi\/grant-runtime\.sql -f \/opt\/yoyi\/community-development-accounts\.sql/,
    );
    expect(scripts["db:migrate:community"]).toBe(
      "node scripts/migrate-community.mjs",
    );
    expect(scripts["dev:db:up"]).toContain("compose.dev.yml");
    expect(scripts["dev:db:down"]).not.toContain("--volumes");
    expect(adminManifest.scripts).toMatchObject({
      dev: "next dev --port 3002",
      start: "next start --port 3002",
    });
  });

  it("separates local, test and production runtime environment contracts", async () => {
    const template = async (name: string) =>
      parseEnv(await readFile(path.join(repositoryRoot, name), "utf8"));
    const local = await template("infra/env/local.env.example");
    const testing = await template("infra/env/test.env.example");
    const web = await template("infra/production/env/web.env.example");
    const backend = await template("infra/production/env/backend.env.example");
    const admin = await template("infra/production/env/admin.env.example");
    const staging = await template("infra/env/staging.env.example");
    expect(local).toMatchObject({
      MOYA_CONTENT_SOURCE: "payload",
      CMS_STORAGE_MODE: "local",
      CMS_INTERNAL_URL: "http://127.0.0.1:3002",
      DATABASE_POOL_MAX: "5",
    });
    const cms = new URL(local.CMS_DATABASE_URL!);
    const published = new URL(local.DATABASE_URL!);
    expect(cms.pathname).toBe("/yoyi_dev");
    expect(published.pathname).toBe(cms.pathname);
    expect(published.host).toBe(cms.host);
    expect(published.username).not.toBe(cms.username);
    expect(local.TEST_DATABASE_URL).toBeUndefined();
    expect(
      Object.keys(local).some((name) => /^(COS_|CMS_COS_)/.test(name)),
    ).toBe(false);
    expect(testing.TEST_DATABASE_URL).not.toBe(testing.CMS_TEST_DATABASE_URL);
    expect(new URL(testing.CMS_TEST_DATABASE_URL!).pathname).not.toBe(
      "/yoyi_dev",
    );
    expect(Object.keys(web).sort()).toEqual([
      "AUTH_INGRESS_TOKEN",
      "AUTH_SOURCE_RELAY_TOKEN",
      "CMS_INTERNAL_URL",
      "MOYA_PUBLIC_API_BASE_URL",
      "NODE_ENV",
    ]);
    expect(backend).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "3001",
      DATABASE_POOL_MAX: "5",
      CMS_STORAGE_MODE: "cos",
    });
    for (const name of [
      "COS_BUCKET",
      "COS_REGION",
      "COS_MEDIA_ORIGIN",
      "COS_SECRET_ID",
      "COS_SECRET_KEY",
    ])
      expect(backend[name]).toBeTruthy();
    expect(admin.CMS_PUBLIC_URL).toBe(admin.CMS_PREVIEW_WEB_URL);
    expect(staging.CMS_PUBLIC_URL).toBe(staging.CMS_PREVIEW_WEB_URL);
    expect(new URL(backend.DATABASE_URL!).searchParams.get("sslmode")).toBe(
      "verify-full",
    );
    expect(new URL(admin.CMS_DATABASE_URL!).searchParams.get("sslmode")).toBe(
      "verify-full",
    );
  });

  it("keeps development PostgreSQL isolated and production listeners hardened", async () => {
    const compose = await readFile(
      path.join(repositoryRoot, "compose.dev.yml"),
      "utf8",
    );
    expect(compose).toContain("postgres:18.4-alpine");
    expect(compose).toContain('"127.0.0.1:54330:5432"');
    expect(compose).toContain("POSTGRES_DB: yoyi_dev");
    expect(compose).toContain("yoyi_dev_data:/var/lib/postgresql");
    expect(compose).not.toContain("TEST_DATABASE_URL");
    for (const [service, port] of [
      ["web", 3000],
      ["backend", 3001],
      ["admin", 3002],
    ] as const) {
      const unit = await readFile(
        path.join(
          repositoryRoot,
          `infra/production/systemd/yoyi-${service}.service`,
        ),
        "utf8",
      );
      expect(unit).toContain(`User=yoyi-${service}`);
      expect(unit).toContain(`EnvironmentFile=/etc/yoyi/${service}.env`);
      expect(unit).toContain(
        service === "backend"
          ? `HOST=127.0.0.1 PORT=${port}`
          : `--hostname 127.0.0.1 --port ${port}`,
      );
      for (const setting of [
        "Restart=on-failure",
        "KillSignal=SIGTERM",
        service === "backend" ? "TimeoutStopSec=90" : "TimeoutStopSec=30",
        "NoNewPrivileges=true",
        "ProtectSystem=strict",
      ])
        expect(unit).toContain(setting);
      expect(unit).not.toContain("migrate");
    }
    const grants = await readFile(
      path.join(repositoryRoot, "infra/development/grant-public-read.sql"),
      "utf8",
    );
    expect(grants).toContain(
      "SELECT (name) ON TABLE public.payload_migrations",
    );
    expect(grants).not.toContain("ALL TABLES");
    const communityGrants = await readFile(
      path.join(repositoryRoot, "infra/development/grant-community-app.sql"),
      "utf8",
    );
    expect(communityGrants).toContain("GRANT USAGE ON SCHEMA community");
    expect(communityGrants).not.toMatch(/ALL TABLES|CREATE ON SCHEMA|public\./);
    for (const file of [
      "grant-community-app.sql",
      "community-development-accounts.sql",
    ])
      expect(compose).toContain(
        `./infra/development/${file}:/opt/yoyi/${file}`,
      );
    // The Phase 4/publishing runtime grant converges the App role after the
    // Mission 2A/2B set on the documented `dev:migrate` path: it is mounted, it
    // follows grant-community-app.sql in the same psql command, and it revokes
    // the table-level UPDATEs the earlier set granted before re-granting the
    // column lists (GRANT alone never narrows).
    expect(compose).toContain(
      "./infra/development/work-publishing/grant-runtime.sql:/opt/yoyi/grant-runtime.sql:ro",
    );
    const devMigrate = (
      JSON.parse(
        await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> }
    ).scripts["dev:migrate"]!;
    expect(devMigrate).toContain("-v app_role=yoyi_dev_app");
    expect(
      devMigrate.indexOf("/opt/yoyi/grant-community-app.sql"),
    ).toBeLessThan(devMigrate.indexOf("/opt/yoyi/grant-runtime.sql"));
    // The runtime plan revokes before it grants; the supported invocation runs
    // the whole psql pass as one transaction so a failure between the two
    // leaves the previous effective privileges untouched.
    expect(devMigrate).toMatch(
      /psql -v ON_ERROR_STOP=1 --single-transaction [^&]*-f \/opt\/yoyi\/grant-community-app\.sql -f \/opt\/yoyi\/grant-runtime\.sql/,
    );
    const runtimeGrants = await readFile(
      path.join(
        repositoryRoot,
        "infra/development/work-publishing/grant-runtime.sql",
      ),
      "utf8",
    );
    expect(runtimeGrants).not.toMatch(/ALL TABLES|CREATE ON SCHEMA|REVOKE ALL/);
    for (const table of [
      "community.sessions",
      "community.catalog_comments",
      "community.catalog_comment_replies",
      "community.publication_setting",
    ])
      expect(runtimeGrants.indexOf("REVOKE UPDATE ON TABLE")).toBeLessThan(
        runtimeGrants.indexOf(`GRANT UPDATE (`, runtimeGrants.indexOf(table)),
      );
  });

  it("allows the existing PNG and Article body bounds only at their own ingress paths", async () => {
    const nginx = await readFile(
      path.join(repositoryRoot, "infra/production/nginx/yoyi.conf.template"),
      "utf8",
    );
    const locationBody = (header: string) => {
      const marker = `${header} {`;
      const start = nginx.indexOf(marker);
      expect(start, header).toBeGreaterThanOrEqual(0);
      return nginx.slice(start + marker.length, nginx.indexOf("}", start));
    };
    expect(nginx.match(/client_max_body_size 1m;/g)).toHaveLength(1);
    expect(nginx).not.toMatch(/client_max_body_size\s+0\s*;/);
    expect(locationBody("location = /api/community/media")).toContain(
      "client_max_body_size 4m;",
    );
    const articleKilobytes =
      (ARTICLE_DOCUMENT_LIMITS.documentBytes + 16_384) / 1024;
    for (const header of [
      "location = /api/community/article-authoring",
      "location ^~ /api/community/article-authoring/",
    ]) {
      expect(locationBody(header)).toContain(
        `client_max_body_size ${articleKilobytes}k;`,
      );
      expect(locationBody(header)).toContain("proxy_pass http://yoyi_web;");
    }
    expect(locationBody("location /api/community/")).not.toContain(
      "client_max_body_size",
    );
    expect(locationBody("location /api/")).toContain(
      "client_max_body_size 50m;",
    );
  });

  it("keeps media streaming and Article issuer boundaries explicit", async () => {
    const nginx = await readFile(
      path.join(repositoryRoot, "infra/production/nginx/yoyi.conf.template"),
      "utf8",
    );
    const upload = nginx.slice(
      nginx.indexOf('location ~ "^/api/community/publishing/uploads/'),
      nginx.indexOf("    # Private derivative bytes"),
    );
    for (const directive of [
      "client_max_body_size 8g;",
      "client_body_timeout 130s;",
      "proxy_request_buffering off;",
      "proxy_buffering off;",
      "proxy_cache off;",
      "proxy_next_upstream off;",
      "proxy_send_timeout 130s;",
      "proxy_read_timeout 75s;",
    ])
      expect(upload).toContain(directive);
    expect(nginx.match(/client_max_body_size 8g;/g)).toHaveLength(1);
    for (const exact of [
      "/mcp/article-authoring",
      "/.well-known/oauth-protected-resource/mcp/article-authoring",
    ])
      expect(nginx).toMatch(
        new RegExp(
          `location = ${exact.replaceAll(".", "\\.")} \\{[^}]*proxy_pass http://yoyi_backend;`,
        ),
      );
    expect(nginx).toContain("server_name article-auth.example.invalid;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(nginx).toContain(
      "proxy_set_header X-Forwarded-Host article-auth.example.invalid;",
    );
    const unit = await readFile(
      path.join(
        repositoryRoot,
        "infra/production/systemd/yoyi-backend.service",
      ),
      "utf8",
    );
    // Media processing and its job workspace belong to the media worker.
    expect(unit).not.toContain("ReadWritePaths");
    expect(unit).toContain("ProtectSystem=strict");
    const worker = await readFile(
      path.join(
        repositoryRoot,
        "infra/production/systemd/yoyi-media-worker.service",
      ),
      "utf8",
    );
    // A dedicated user: the Backend user cannot reach the worker's container
    // daemon socket or its job workspace.
    for (const setting of [
      "User=yoyi-media",
      "Group=yoyi-media",
      "EnvironmentFile=/etc/yoyi/media-worker.env",
      "services/backend-production/dist/worker-main.js",
      "TimeoutStopSec=90",
      "MemoryMax=512M",
      "TasksMax=64",
      "RestartPreventExitStatus=78",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "ReadWritePaths=/var/lib/yoyi-media/publishing-work",
      "CapabilityBoundingSet=",
      "StartLimitIntervalSec=0",
      "Requires=REPLACE_ME_CONTAINER_DAEMON_READY.service REPLACE_ME_METADATA_GUARD.service",
    ])
      expect(worker).toContain(setting);
    expect(worker).not.toContain("yoyi-backend");
    expect(worker).not.toMatch(/\/run\/user\/\d|migrate|HOST=|PORT=/);
    const mediaWorker = parseEnv(
      await readFile(
        path.join(
          repositoryRoot,
          "infra/production/env/media-worker.env.example",
        ),
        "utf8",
      ),
    );
    expect(mediaWorker).toMatchObject({
      NODE_ENV: "production",
      DATABASE_POOL_MAX: "3",
      WORK_MEDIA_WORKER_CONCURRENCY: "1",
      WORK_MEDIA_WORK_DIR: "/var/lib/yoyi-media/publishing-work",
    });
    expect(mediaWorker.WORK_MEDIA_STORE_DIR).toBeUndefined();
    for (const [name, value] of Object.entries(mediaWorker))
      if (/SECRET|PASSWORD|_URL$|BUCKET|IMAGE|DOCKER_HOST/.test(name))
        expect(value, name).toMatch(/REPLACE_ME|example\.invalid/);
    const backend = parseEnv(
      await readFile(
        path.join(repositoryRoot, "infra/production/env/backend.env.example"),
        "utf8",
      ),
    );
    const issuer = parseEnv(
      await readFile(
        path.join(
          repositoryRoot,
          "infra/production/env/article-authorization.env.example",
        ),
        "utf8",
      ),
    );
    expect(backend.ARTICLE_AUTHORIZATION_DATABASE_URL).toBeUndefined();
    expect(backend.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE).toBeUndefined();
    expect(issuer.APP_DATABASE_URL).toBeUndefined();
    expect(issuer.ARTICLE_AUTHORING_CONTROL_DATABASE_URL).toBeUndefined();
    expect(issuer.CMS_DATABASE_URL).toBeUndefined();
    expect(backend.AUTH_PHONE_PROVIDER).toBe("disabled");
    expect(backend.WORK_MEDIA_STORE_DIR).toBeUndefined();
    expect(backend.WORK_MEDIA_WORKER).toBe("external");
    // Rollback-retained for the previous release, ignored by this one.
    expect(backend.WORK_MEDIA_WORK_DIR).toBe(
      "/var/lib/yoyi-backend/publishing-work",
    );
    expect(backend.WORK_MEDIA_TOOLS_IMAGE).toMatch(/REPLACE_ME/);
    expect(backend.WORK_MEDIA_WORKER_CONCURRENCY).toBe("1");
    for (const name of [
      "ARTICLE_AUTHORING_ISSUER",
      "ARTICLE_AUTHORING_RESOURCE",
      "ARTICLE_AUTHORING_CONSENT_ORIGIN",
      "ARTICLE_AUTHORING_CLIENTS",
      "ARTICLE_AUTHORING_WRAPPER_INDEX_KEY",
      "ARTICLE_AUTHORING_WRAPPER_SEAL_KEY",
    ])
      expect(issuer[name]).toBe(backend[name]);
  });

  it("routes Community V1 same-origin paths to Web, never to Payload", async () => {
    const nginx = await readFile(
      path.join(repositoryRoot, "infra/production/nginx/yoyi.conf.template"),
      "utf8",
    );
    const communityLocations = [
      ...nginx.matchAll(/location\s+\/api\/community\/\s*\{([^}]*)\}/g),
    ];
    expect(communityLocations).toHaveLength(1);
    expect(communityLocations[0]?.[1]).toContain("proxy_pass http://yoyi_web;");
    expect(nginx).not.toContain("location ^~ /api/community/ {");
    expect(nginx).not.toMatch(/community[^\n]*yoyi_admin/);
    const local = parseEnv(
      await readFile(
        path.join(repositoryRoot, "infra/env/local.env.example"),
        "utf8",
      ),
    );
    const app = new URL(local.APP_DATABASE_URL!);
    const migration = new URL(local.APP_MIGRATION_DATABASE_URL!);
    for (const url of [app, migration]) {
      expect(url.pathname).toBe("/yoyi_dev");
      expect(url.host).toBe(new URL(local.DATABASE_URL!).host);
    }
    expect(
      new Set([
        app.username,
        migration.username,
        new URL(local.DATABASE_URL!).username,
        new URL(local.CMS_DATABASE_URL!).username,
      ]).size,
    ).toBe(4);
    const backend = parseEnv(
      await readFile(
        path.join(repositoryRoot, "infra/production/env/backend.env.example"),
        "utf8",
      ),
    );
    expect(new URL(backend.APP_DATABASE_URL!).searchParams.get("sslmode")).toBe(
      "verify-full",
    );
    expect(new URL(backend.APP_DATABASE_URL!).username).not.toBe(
      new URL(backend.DATABASE_URL!).username,
    );
    expect(backend.APP_MIGRATION_DATABASE_URL).toBeUndefined();
  });

  it("uses current Yoyi branding in Web and Admin metadata", async () => {
    const [
      webLayout,
      adminLayout,
      adminPage,
      adminHome,
      adminConfig,
      adminTsconfig,
    ] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "apps", "web", "app", "layout.tsx"),
        "utf8",
      ),
      readFile(
        path.join(repositoryRoot, "apps/admin/app/(payload)/layout.tsx"),
        "utf8",
      ),
      readFile(
        path.join(
          repositoryRoot,
          "apps/admin/app/(payload)/admin/[[...segments]]/page.tsx",
        ),
        "utf8",
      ),
      readFile(
        path.join(repositoryRoot, "apps/admin/app/(payload)/page.tsx"),
        "utf8",
      ),
      readFile(
        path.join(repositoryRoot, "apps/admin/payload.config.ts"),
        "utf8",
      ),
      readJson(path.join(repositoryRoot, "apps/admin/tsconfig.json")),
    ]);

    expect(webLayout).toContain('title: "由于艺"');
    expect(adminConfig).toContain('titleSuffix: "— 由于艺管理端"');
    expect(adminTsconfig.compilerOptions).toMatchObject({
      paths: { "@payload-config": ["./payload.config.ts"] },
    });
    expect(adminHome).toContain('redirect("/admin")');
    for (const source of [adminLayout, adminPage])
      expect(source).toContain('import config from "@payload-config"');
    expect(adminLayout).toMatch(/<RootLayout\s+config=\{config\}/);
    expect(adminPage).toContain(
      'import { RootPage, generatePageMetadata } from "@payloadcms/next/views"',
    );
    expect(adminPage).toMatch(
      /export const generateMetadata\s*=[\s\S]*?generatePageMetadata\(\{ config, params, searchParams \}\)/,
    );
    expect(adminPage).toContain(
      "return RootPage({ config, importMap, params, searchParams })",
    );
    expect(adminConfig).toMatch(/importMap:\s*\{[^}]*autoGenerate:\s*false/);
  });

  it("keeps CloudBase examples archived and UI URL guidance resolved", async () => {
    const archiveRoot = path.join(
      repositoryRoot,
      "docs",
      "archive",
      "deployment",
      "cloudbase-t03-candidate",
    );
    await Promise.all([
      access(path.join(archiveRoot, "README.md")),
      access(path.join(archiveRoot, "cloudbase-mainland-architecture.md")),
      access(
        path.join(archiveRoot, "infra", "cloudbase", "deployment.example.yaml"),
      ),
      access(
        path.join(archiveRoot, "infra", "cloudbase", "runtime.env.example"),
      ),
    ]);

    const uiReadme = await readFile(
      path.join(repositoryRoot, "packages", "ui", "README.md"),
      "utf8",
    );
    expect(uiReadme).toContain("PublicMedia.src");
    expect(uiReadme).not.toContain("从对象 key 派生");
  });

  it("pins the Formal root and current documents to the React Product Shell", async () => {
    const [
      formalPage,
      rootReadme,
      webReadme,
      architecture,
      projectStatus,
      milestones,
      agents,
      currentAuthorityAmendment,
    ] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "apps", "web", "app", "page.tsx"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(repositoryRoot, "apps", "web", "README.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs", "architecture.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs", "project-status.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, "docs", "history", "milestones.md"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8"),
      readFile(
        path.join(
          repositoryRoot,
          "docs",
          "governance",
          "amendments",
          "2026-09-04-react-product-current-authority.md",
        ),
        "utf8",
      ),
    ]);

    expect(formalPage).toContain("loadProductionProductStates");
    // Mission 2C: the accepted preview is reached through the Product
    // application shell, which composes the live comment section on the client.
    expect(formalPage).toContain("<ProductApplication");
    expect(
      await readFile(
        path.join(
          repositoryRoot,
          "apps/web/features/product-application/product-application.tsx",
        ),
        "utf8",
      ),
    ).toContain("<T02pProductPreview");
    expect(
      await fileExists(
        path.join(repositoryRoot, "apps", "web", "app", "route.ts"),
      ),
    ).toBe(false);

    for (const currentDocument of [
      rootReadme,
      webReadme,
      architecture,
      projectStatus,
    ]) {
      expect(currentDocument).toContain("apps/web/app/page.tsx");
      expect(currentDocument).not.toContain("apps/web/app/route.ts");
    }

    expect(projectStatus).toContain("T09-C0:  CLOSED / PASS");
    expect(projectStatus).toContain("T09-B1A: CLOSED / PASS");
    expect(projectStatus).toContain("T09-B1B: CLOSED / PASS");
    expect(projectStatus).toContain("T09-F1:  CLOSED / PASS");
    expect(projectStatus).not.toContain("T09-F1:  PENDING");
    expect(projectStatus).not.toContain("Current verified commit:");
    expect(projectStatus).not.toContain("Current verified tree:");
    expect(projectStatus).not.toContain(
      "02de3c1f1d1baeb5eb938d88030c56bc37a2cadc",
    );
    expect(projectStatus).not.toContain("Next backend task after P2-00");

    expect(milestones).toContain("MIG-CUTOVER");
    expect(milestones).toContain("T09-B1B");
    expect(milestones).not.toContain("Production T02 bridge 仍保留");

    expect(agents).toContain("2026-09-04-react-product-current-authority.md");
    expect(currentAuthorityAmendment).toContain("apps/web/app/page.tsx");
    expect(currentAuthorityAmendment).toContain("T09-F1");
  });

  it("keeps current authority on the single main trunk", async () => {
    const currentAuthorityPaths = [
      "AGENTS.md",
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      ".github/workflows/ci.yml",
      "docs/README.md",
      "docs/project-status.md",
      "docs/branching-strategy.md",
      "docs/module-ownership.md",
      "docs/architecture.md",
      "docs/governance/amendments/2026-08-24-machine-verified-review-and-merge.md",
      "docs/governance/amendments/2026-09-04-react-product-current-authority.md",
    ];
    const currentAuthorityDocuments = await Promise.all(
      currentAuthorityPaths.map((relativePath) =>
        readFile(path.join(repositoryRoot, relativePath), "utf8"),
      ),
    );

    for (const currentDocument of currentAuthorityDocuments) {
      expect(currentDocument).not.toContain("integration/mvp");
      expect(currentDocument).not.toContain("origin/integration/mvp");
    }

    const [
      rootReadme,
      security,
      contributing,
      workflow,
      projectStatus,
      branchingStrategy,
      architecture,
      singleMainAmendment,
      historicalContractAdr,
      historicalLineageAudit,
    ] = await Promise.all([
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(repositoryRoot, "SECURITY.md"), "utf8"),
      readFile(path.join(repositoryRoot, "CONTRIBUTING.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "docs", "project-status.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, "docs", "branching-strategy.md"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, "docs", "architecture.md"), "utf8"),
      readFile(
        path.join(
          repositoryRoot,
          "docs",
          "governance",
          "amendments",
          "2026-09-04-single-main-trunk-unification.md",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          repositoryRoot,
          "docs",
          "adr",
          "0004-catalog-contract-design-freeze.md",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          repositoryRoot,
          "docs",
          "governance",
          "history",
          "2026-09-04-status-and-lineage-reset-rule-audit.md",
        ),
        "utf8",
      ),
    ]);

    expect(rootReadme).toMatch(/最新\s+`origin\/main`/);
    expect(security).toContain("current default branch, `main`");
    expect(contributing).toContain("Sync `main`");
    expect(contributing).toContain("Draft PR to `main`");
    expect(workflow.match(/^\s+- main$/gm)).toHaveLength(2);
    expect(projectStatus).toContain("Shared development branch:\nmain");
    expect(projectStatus).toContain("fresh latest origin/main");
    expect(branchingStrategy).toContain("verified `main` commit");
    expect(branchingStrategy).toContain("annotated tag");
    expect(branchingStrategy).toContain("GitHub Release");
    expect(architecture).toContain("latest `origin/main`");

    expect(singleMainAmendment).toContain(
      "The following are no longer current operations:",
    );
    expect(singleMainAmendment).toContain(
      "`integration/mvp` as a live shared branch",
    );
    expect(singleMainAmendment).toContain(
      "`origin/integration/mvp` as a task baseline",
    );

    expect(historicalContractAdr).toContain(
      "integration/mvp@9e99bb6d01afe3e4f7d7778a5cd2975787fd53bc",
    );
    expect(historicalLineageAudit).toContain("latest `origin/integration/mvp`");
  });
});
