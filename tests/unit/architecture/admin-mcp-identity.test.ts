import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

// Identity guard for docs/development/admin-mcp-completion-v1.md section 2.
// isOwner does not change, so any gate not explicitly converted stays closed to
// AI; these inventories fail on a reference nobody has classified.

const adminRoot = path.join(repositoryRoot, "apps/admin");
const ignored = new Set(["node_modules", "dist", ".next", ".turbo"]);

const adminSources = async (directory = ""): Promise<string[]> => {
  const entries = await readdir(path.join(adminRoot, directory), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory())
        return ignored.has(entry.name) ? [] : adminSources(relative);
      return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [relative] : [];
    }),
  );
  return files.flat();
};

const read = (file: string) => readFile(path.join(adminRoot, file), "utf8");
const withoutModuleLists = (source: string) =>
  source.replace(/^(?:import|export) \{[^}]*\} from "[^"]+";$/gmu, "");
const occurrences = (source: string, pattern: RegExp) =>
  (source.match(pattern) ?? []).length;

/**
 * Every `isOwner` reference under apps/admin, by-reference uses and literal role
 * checks included, because each is an Owner gate MCP never passes through. A new
 * one must be classified here or converted below.
 */
const ownerGates: Record<string, { count: number; why: string }> = {
  "app/(payload)/admin/analytics-workspace/[[...path]]/route.ts": {
    count: 2,
    why: "Owner analytics session, cookie only",
  },
  "src/admin-mcp/door.ts": {
    count: 1,
    why: "refuses a key bound to the Owner; grants nothing",
  },
  "src/agent-connections/View.tsx": { count: 3, why: "human UI" },
  "src/agent-connections/endpoints.ts": {
    count: 2,
    why: "Owner consent screen route",
  },
  "src/analytics/View.tsx": { count: 4, why: "human UI" },
  "src/analytics/endpoints.ts": {
    count: 3,
    why: "Owner analytics route; AI reads go through the analytics tools",
  },
  "src/analytics/proxy.ts": { count: 3, why: "Owner analytics proxy" },
  "src/community/DashboardCard.tsx": { count: 1, why: "human UI" },
  "src/community/View.tsx": { count: 3, why: "human UI" },
  "src/community/endpoints.ts": {
    count: 2,
    why: "requireOwner of the HTTP wrapper; AI calls the operations directly",
  },
  "src/editorial/access.ts": {
    count: 4,
    why: "the definition, plus actsAsOwner and isHumanOwner",
  },
  "src/editorial/index.ts": { count: 1, why: "re-export" },
  "src/media/thumbnail-endpoint.ts": {
    count: 2,
    why: "Owner thumbnail route; AI views use their own credential",
  },
  "src/migration/run.ts": { count: 1, why: "operator CLI identity probe" },
  "src/owner-workflow/OwnerWithdrawButton.tsx": { count: 1, why: "human UI" },
  "src/owner-workflow/View.tsx": { count: 2, why: "human UI" },
  "src/users.ts": {
    count: 3,
    why: "Admin entry, and an Owner credential reading its own row",
  },
  "src/workspace/Navigation.tsx": { count: 3, why: "human UI" },
};

/** The gates converted to `actsAsOwner`, 39 references, import lists aside. */
const convertedGates: Record<string, number> = {
  "payload.config.ts": 1,
  "src/editorial-content/approvals.ts": 5,
  "src/editorial-content/hooks.ts": 9,
  "src/editorial-content/operations.ts": 1,
  "src/editorial/catalog-delivery.ts": 4,
  "src/editorial/collections.ts": 6,
  "src/editorial/hooks.ts": 5,
  "src/editorial/operations.ts": 2,
  "src/editorial/owner.ts": 1,
  "src/media/catalog-ingest.ts": 1,
};

describe("Admin MCP identity (admin-mcp-completion-v1, section 2)", () => {
  it("classifies every isOwner reference", async () => {
    const found: Record<string, number> = {};
    for (const file of await adminSources()) {
      const count = occurrences(
        await read(file),
        /\bisOwner\b|\brole\s*[!=]==\s*"owner"/gu,
      );
      if (count) found[file] = count;
    }
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(ownerGates).map(([file, { count }]) => [file, count]),
      ),
    );
  });

  it("leaves isOwner itself unchanged", async () => {
    expect(await read("src/editorial/access.ts")).toContain(
      'export const isOwner = (req: PayloadRequest): boolean =>\n  req.user?.collection === "users" && req.user.role === "owner";',
    );
  });

  it("converts exactly the listed gates", async () => {
    for (const [file, count] of Object.entries(convertedGates))
      expect([
        file,
        occurrences(withoutModuleLists(await read(file)), /\bactsAsOwner\b/gu),
      ]).toEqual([file, count]);
    const access = await read("src/editorial/access.ts");
    // canEditCatalog, requireActor, catalogScopeAccess and catalogAccess.create.
    const definition = "export const actsAsOwner";
    expect(access).toContain(definition);
    expect(occurrences(access, /\bactsAsOwner\(req\)/gu)).toBe(4);
    expect(access).not.toContain('["owner", "automation"]');
    expect(
      Object.values(convertedGates).reduce((sum, count) => sum + count, 4),
    ).toBe(39);
  });

  it("never lets a reserved surface import actsAsOwner", async () => {
    const sources = await adminSources();
    const reserved = sources.filter(
      (file) =>
        file === "src/users.ts" ||
        file === "src/mcp.ts" ||
        file.startsWith("src/admin-mcp/control/") ||
        file.startsWith("src/admin-mcp/audit"),
    );
    expect(reserved).toEqual(
      expect.arrayContaining(["src/users.ts", "src/mcp.ts"]),
    );
    for (const file of reserved)
      expect([file, await read(file)]).toEqual([
        file,
        expect.not.stringMatching(/\bactsAsOwner\b/u),
      ]);
    for (const file of ["src/users.ts", "src/mcp.ts"]) {
      expect(await read(file)).toContain("isHumanOwner");
      expect(await read(file)).toContain("disableBulkEdit: true");
    }
  });

  it("pins the strategy names the predicates read to payload 3.88.0", async () => {
    const dependency = (package_: string, file: string) =>
      readFile(path.join(adminRoot, "node_modules", package_, file), "utf8");
    for (const package_ of ["payload", "@payloadcms/plugin-mcp"])
      expect(
        (
          JSON.parse(await dependency(package_, "package.json")) as {
            version: string;
          }
        ).version,
      ).toBe("3.88.0");
    expect(await dependency("payload", "dist/index.js")).toContain(
      "name: 'local-jwt'",
    );
    expect(
      await dependency("payload", "dist/auth/strategies/jwt.js"),
    ).toContain("user._strategy = strategyName");
    expect(
      await dependency("payload", "dist/auth/strategies/apiKey.js"),
    ).toContain("user._strategy = 'api-key'");
    expect(
      await dependency(
        "@payloadcms/plugin-mcp",
        "dist/endpoints/resolveAccessSettings.js",
      ),
    ).toContain("user._strategy = 'mcp-api-key'");
    const extractJWT = await dependency("payload", "dist/auth/extractJWT.js");
    expect(extractJWT).toContain("`${payload.config.cookiePrefix}-token`");
    expect(extractJWT).toContain("headers.get('Authorization')");
    expect(
      await dependency("payload", "dist/collections/operations/update.js"),
    ).toContain(
      "args.collection.config.disableBulkEdit && !args.overrideAccess",
    );
  });

  it("adds the role value alone in its own migration", async () => {
    const migration = await read(
      "src/migrations/20261103_143652_ai_operator_role.ts",
    );
    const up = /function up[\s\S]*?\n\}/u.exec(migration)?.[0] ?? "";
    expect(up.match(/;\s*`/gu)).toHaveLength(1);
    expect(up).toContain(
      `ALTER TYPE "public"."enum_users_role" ADD VALUE 'ai_operator';`,
    );
    expect(await read("src/migrations/index.ts")).toContain(
      'name: "20261103_143652_ai_operator_role"',
    );
    expect(
      (
        await stat(
          path.join(
            adminRoot,
            "src/migrations/20261103_143652_ai_operator_role.json",
          ),
        )
      ).isFile(),
    ).toBe(true);
    expect(await read("src/payload-types.ts")).toContain(
      'role: "owner" | "automation" | "ai_operator";',
    );
  });

  it("carries this slice's schema in the amendment's migrations, in order", async () => {
    const names = [
      "20261103_143652_ai_operator_role",
      "20261103_150451_mcp_key_lifecycle",
      "20261103_153046_mcp_control",
      "20261103_153057_mcp_audit_events",
    ];
    const index = await read("src/migrations/index.ts");
    const positions = names.map((name) => index.indexOf(`name: "${name}"`));
    expect(positions.every((at) => at > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const keys = await read(`src/migrations/${names[1]}.ts`);
    expect(keys).toContain(
      `UPDATE "payload_mcp_api_keys" SET "expires_at" = now() + interval '30 days';`,
    );
    const control = await read(`src/migrations/${names[2]}.ts`);
    for (const column of ["dm", "evidence", "raw_ip", "self_only"])
      expect(control).toContain(`"${column}" boolean DEFAULT false`);
    expect(control).toContain('"threshold" numeric DEFAULT 20 NOT NULL');
    const audit = await read(`src/migrations/${names[3]}.ts`);
    expect(audit).toContain("BEFORE UPDATE OR DELETE ON");
    expect(audit).toContain("MCP_AUDIT_APPEND_ONLY");
  });
});
