import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRESET_SCOPES,
  PRESET_TOOLS,
  canonicalScopes,
} from "admin/agent-connections";
import { createResourceRuntime } from "admin/agent-connections-resource";
import { extractModuleReferences } from "../architecture/workspace-scanner.js";
import { agentAdminTools } from "admin/agent-admin-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Agent Connections V1 (Issue #141 r9) — F1, the access boundary, checked at
 * the level the evidence actually supports.
 *
 * The Owner's correction is the point of this file. Three claims must not be
 * confused, and only the first is provable by reading the repository:
 *
 *   1. A configured path WOULD proxy to the Admin if the template were
 *      deployed.
 *   2. The path IS reachable on a named deployed host.
 *   3. Unauthenticated or under-scoped callers CAN obtain or mutate data.
 *
 * These regressions assert (1) and pin the conditions under which it matters.
 * They deliberately assert nothing about (2) or (3): no live host was probed,
 * and this task authorizes none. What they DO assert about (3) is the part
 * that is checkable here — that the NEW connection surface fails closed —
 * which is a statement about our code, not about a deployment.
 */

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const read = (relative: string) =>
  readFileSync(path.join(root, relative), "utf8");

describe("F1: what the repository configuration actually says", () => {
  it("routes /api/ to the Admin upstream with named carve-outs, /api/mcp staying on Admin behind its path limit", () => {
    const template = read("infra/production/nginx/yoyi.conf.template");
    // The general rule.
    expect(template).toMatch(
      /location \/api\/ \{[^}]*proxy_pass http:\/\/yoyi_admin;/u,
    );
    // The carve-outs that exist, which is why the absence of one is meaningful
    // rather than an oversight nobody ever makes.
    expect(template).toContain("location = /api/catalog");
    expect(template).toContain("location ^~ /api/community/");
    // The earlier finding was no carve-out at all. The 2026-11-03 amendment
    // authorizes a key-only path with a limit, still on the Admin upstream.
    expect(template).toMatch(
      /location = \/api\/mcp \{[^}]*limit_req zone=yoyi_mcp[^}]*proxy_pass http:\/\/yoyi_admin;/u,
    );
  });

  it("is a CONDITIONAL finding: this assertion is about the template, not about any deployed host", () => {
    // Recorded as an executable statement of scope so a later reader cannot
    // mistake the test above for evidence of a live exposure. No network call
    // is made by this suite, and none is authorized.
    const template = read("infra/production/nginx/yoyi.conf.template");
    expect(template).toContain("catalog.example.invalid");
  });

  it("keeps the Development-only gate on the artvenn_* tools", () => {
    expect(read("apps/admin/src/agent-admin/mcp-tools.ts")).toContain(
      'process.env.NODE_ENV !== "development"',
    );
  });

  it("records that the editorial tools are a separate policy domain without a NODE_ENV gate", () => {
    // Not a defect assertion: the Owner's decision is that authorized legacy
    // editorial behaviour is preserved and NOT blanket-disabled. This pins the
    // current truth so a future change to it is deliberate and reviewed,
    // rather than silently acquired.
    const mcp = read("apps/admin/src/mcp.ts");
    expect(mcp).toContain("editorial_query");
    expect(mcp).not.toMatch(/editorial_query[\s\S]{0,4000}?NODE_ENV/u);
  });
});

describe("F1: the NEW connection surface fails closed", () => {
  it("keeps the closed door in the shipped plugin configuration, now behind the gate", () => {
    // Until r15 this asserted the literal `connectionOverrideAuth(null)`,
    // which was true because NOTHING was wired. The boundary is wired now, so
    // the assertion moves to the property that mattered all along: the
    // argument is the gated factory, and that factory answers `null` — the
    // closed door — whenever the surface is not composed.
    const mcp = read("apps/admin/src/mcp.ts");
    expect(mcp).toMatch(
      /overrideAuth: withKeyDoor\(\s*connectionOverrideAuth\(connectionAuthDependencies\(\)\),?\s*\)/u,
    );
    for (const environment of [
      {},
      { NODE_ENV: "development" },
      { AGENT_CONNECTIONS_ENABLED: "true" },
      { NODE_ENV: "production", AGENT_CONNECTIONS_ENABLED: "true" },
      { NODE_ENV: "test", AGENT_CONNECTIONS_ENABLED: "true" },
    ])
      expect(
        createResourceRuntime(environment as NodeJS.ProcessEnv),
      ).toBeNull();
  });

  it("refuses to compose a resource boundary it cannot configure exactly", () => {
    // With the gate OPEN, every missing or unsafe setting is a refusal at
    // composition rather than a runtime branch inside a handler: the surface
    // is absent rather than present-and-hoping.
    const base = {
      NODE_ENV: "development",
      AGENT_CONNECTIONS_ENABLED: "true",
      AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:34620",
      AGENT_AUTHORIZATION_RESOURCE: "http://admin.localhost:3442/api/mcp",
      AGENT_RESOURCE_DATABASE_URL: "postgresql://x@127.0.0.1:5432/synthetic",
      AGENT_CONNECTION_WRAPPER_INDEX_KEY: "A".repeat(43) + "=",
      AGENT_CONNECTION_WRAPPER_SEAL_KEY: "B".repeat(43) + "=",
    };
    for (const override of [
      { AGENT_RESOURCE_DATABASE_URL: undefined },
      // A resource server reaching a database somewhere else is the first
      // step of exactly the exposure this milestone is fenced against.
      {
        AGENT_RESOURCE_DATABASE_URL:
          "postgresql://x@db.example.invalid:5432/synthetic",
      },
      { AGENT_AUTHORIZATION_ISSUER: undefined },
      // An issuer with a path is a DIFFERENT issuer from the one a token
      // claims, and the mismatch surfaces only as a refused valid token.
      { AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:34620/oauth" },
      { AGENT_AUTHORIZATION_RESOURCE: undefined },
      { AGENT_AUTHORIZATION_RESOURCE: "http://admin.localhost/api/mcp?a=1" },
      // A silently generated key would make every sealed wrapper unreadable,
      // which looks exactly like every connection being revoked at once.
      { AGENT_CONNECTION_WRAPPER_SEAL_KEY: undefined },
    ])
      expect(() =>
        createResourceRuntime({
          ...base,
          ...override,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow();
  });

  it("keeps the admission rule free of the web framework, which is the whole point of the split", () => {
    // r14 split `admitGrant` out of `authorization.ts` for a MEASURED reason,
    // not a tidy one: `authorization.ts` imports `payload` at module scope for
    // one `catch`, so importing the admission rule dragged the framework into
    // the PostgreSQL test lane — 5.78s -> 7.52s of module loading, and 3/3
    // green became 1 failure in 3 as load-sensitive hooks tipped.
    //
    // Until this test existed, the only thing preventing that regression was
    // the comment explaining it. The re-review added a live `payload` import
    // back into `admission.ts` and nothing in 130 architecture tests or 401
    // postgres tests noticed.
    // Carry-forward C1: the r14 guard matched ONE SPELLING, and the review
    // measured two bypasses it stayed silent for -- `payload/shared` in this
    // file, and `payload` imported into `contracts.ts`, the second of which
    // restored the full regression (22.7ms -> 153.5ms) with the guard saying
    // nothing. So the closure is walked instead of one file being pattern
    // matched, and the package NAME is what is matched, not an exact string.
    //
    // Stated honestly, and narrower than my first wording, which an
    // independent review had to ask for TWICE because the edit that was
    // supposed to trim it never landed:
    //
    // this is the STATIC RELATIVE closure from the admission entry. Not the
    // loaded module graph — a plain-Node loader hook cannot walk
    // extensionless TypeScript imports — and NOT the first-party closure: a
    // bare workspace specifier such as `@moya/community-postgres` is neither
    // matched by `framework` nor followed, so a workspace package pulling the
    // framework in would leave this silent. `contracts.ts`, which this test
    // asserts it reaches, imports exactly such a specifier.
    //
    // What it does cover is every relative hop from the entry, which is where
    // both bypasses the r14 review measured actually lived.
    const framework =
      /^(?:payload|next|react|react-dom)(?:\/|$)|^@payloadcms\//u;
    const visited = new Set<string>();
    const pending = ["apps/admin/src/agent-connections/admission.ts"];
    const offenders: string[] = [];
    while (pending.length) {
      const relative = pending.pop();
      if (relative === undefined || visited.has(relative)) continue;
      visited.add(relative);
      const source = read(relative);
      for (const reference of extractModuleReferences(source)) {
        if (reference.typeOnly) continue;
        if (framework.test(reference.specifier)) {
          offenders.push(`${relative}: ${reference.specifier}`);
          continue;
        }
        if (!reference.specifier.startsWith(".")) continue;
        const base = path.posix.join(
          path.posix.dirname(relative),
          reference.specifier,
        );
        // `${base}` is tested AFTER the index forms on purpose: a relative
        // import of a directory would otherwise resolve to the directory
        // itself and `read()` would throw EISDIR. No such import exists
        // today, which is exactly why the order is easy to get wrong.
        const next = [
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
          base,
        ].find(
          (candidate) =>
            existsSync(path.join(root, candidate)) &&
            !statSync(path.join(root, candidate)).isDirectory(),
        );
        if (next !== undefined) pending.push(next);
      }
    }
    expect(offenders).toEqual([]);
    // The closure is real: it reaches past the entry file, which is where the
    // second measured bypass lived.
    expect(visited.size).toBeGreaterThan(1);
    expect(visited).toContain("apps/admin/src/agent-connections/contracts.ts");
    // And it must stay reachable without going through the index, which does
    // import the framework.
    const manifest = JSON.parse(read("apps/admin/package.json")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports["./agent-connections-admission"]).toBe(
      "./src/agent-connections/admission.ts",
    );
  });

  it("requires development AND an explicit opt-in in the composition gate", () => {
    const composition = read("apps/admin/src/agent-connections/composition.ts");
    expect(composition).toContain('environment.NODE_ENV === "development"');
    expect(composition).toContain(
      'environment[CONNECTIONS_ENABLED_SETTING] === "true"',
    );
    // Both, never either.
    expect(composition).toMatch(/development"\s*&&/u);
  });
});

/**
 * r10 §3.4 — the read-only preset checked against the REAL tool registry and
 * the REAL adapter handlers, not against a copy of the tool names.
 *
 * The r9 bug this exists to prevent: a preset advertising a tool whose
 * complete Backend path needs a scope the preset does not hold, so the tool
 * appears in `tools/list` and is then refused when called.
 */
describe("r10 §3.4: read-only advertises only genuinely read-only paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const registry = agentAdminTools(
    (() => (async () => ({ ok: true })) as never) as never,
  );

  const requestsOf = async (toolName: string) => {
    const calls: { method: string; path: string }[] = [];
    const tools = agentAdminTools(
      () =>
        (async (method: string, path: string) => {
          calls.push({ method, path });
          return { ok: true, result: {} };
        }) as never,
    );
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`no tool ${toolName}`);
    return { tool, calls };
  };

  it("advertises only tools that actually exist in the real registry", () => {
    const names = new Set(registry.map((tool) => tool.name));
    for (const preset of ["read-only", "management"] as const)
      for (const advertised of PRESET_TOOLS[preset])
        expect(names.has(advertised)).toBe(true);
  });

  /**
   * The discriminator is the SCOPE the Backend enforces on the path, not the
   * HTTP method: `artvenn_operations_get` is a GET too, so a method-only
   * assertion could not catch the r9 defect it is named for. This table is the
   * Backend's own enforcement, and the test below keeps it honest against the
   * service source rather than trusting the copy.
   */
  const SCOPE_BY_PATH_PREFIX: readonly (readonly [string, string])[] = [
    // Order matters: the two specific operation paths are enforced under
    // different scopes from the rest of the family, and the r10 review caught
    // this table mapping all of `agent/operations` to `operations:execute`.
    ["agent/operations/prepare-comments", "comments:moderate"],
    ["agent/operations/prepare-featured", "featured:write"],
    ["agent/users", "users:read"],
    ["agent/content", "content:read"],
    ["agent/comments", "comments:read"],
    ["agent/operations", "operations:execute"],
  ];

  /** `prepare-undo` is a suffix, not a prefix, so it needs its own rule. */
  const scopeOverride = (path: string): string | null =>
    path.endsWith("/prepare-undo") ? "operations:undo" : null;

  const scopeForPath = (path: string): string => {
    const override = scopeOverride(path);
    if (override !== null) return override;
    for (const [prefix, scope] of SCOPE_BY_PATH_PREFIX)
      if (path.startsWith(prefix)) return scope;
    throw new Error(`no scope mapped for Backend path ${path}`);
  };

  it("calls only Backend paths whose enforced scope the read-only preset actually holds", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const held = new Set(canonicalScopes("read-only"));
    const fixtures: Record<string, Record<string, unknown>> = {
      artvenn_users_find: { handle: "someone", page: 1, pageSize: 20 },
      artvenn_content_search: { search: "ink", page: 1, pageSize: 20 },
      artvenn_comments_query: { page: 1, pageSize: 20 },
      artvenn_comments_read: { id: `comment-${"a".repeat(32)}` },
    };
    for (const name of PRESET_TOOLS["read-only"]) {
      const { tool, calls } = await requestsOf(name);
      await tool.handler(
        fixtures[name] ?? {},
        {
          user: { collection: "users", agentPrincipal: "agent-phone" },
        } as never,
        undefined,
      );
      expect(calls.length, `${name} made no Backend call`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.method, `${name} mutates`).toBe("GET");
        expect(
          held.has(scopeForPath(call.path)),
          `${name} calls ${call.path}, enforced under ${scopeForPath(call.path)}, which read-only does not hold`,
        ).toBe(true);
      }
    }
  });

  it("has teeth: the tool r9 wrongly advertised is caught by that same rule", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const held = new Set(canonicalScopes("read-only"));
    const { tool, calls } = await requestsOf("artvenn_operations_get");
    await tool.handler(
      { operationId: "11111111-1111-4111-8111-111111111111" },
      {
        user: { collection: "users", agentPrincipal: "agent-phone" },
      } as never,
      undefined,
    );
    expect(calls.length).toBeGreaterThan(0);
    // A GET, like the four allowed tools — which is exactly why the method is
    // not the discriminator. The scope is.
    expect(calls[0]!.method).toBe("GET");
    expect(held.has(scopeForPath(calls[0]!.path))).toBe(false);
  });

  it("covers every management tool's Backend path in the scope table, and maps each to the scope the service really enforces", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const held = new Set(canonicalScopes("management"));
    const mapped: Record<string, string> = {};
    const fixtures: Record<string, Record<string, unknown>> = {
      artvenn_users_find: { handle: "someone", page: 1, pageSize: 20 },
      artvenn_content_search: { search: "ink", page: 1, pageSize: 20 },
      artvenn_comments_query: { page: 1, pageSize: 20 },
      artvenn_comments_read: { id: `comment-${"a".repeat(32)}` },
      artvenn_operations_get: {
        operationId: "11111111-1111-4111-8111-111111111111",
      },
      artvenn_comments_prepare: {
        requestId: "11111111-1111-4111-8111-111111111111",
        action: "hide",
        ids: [`comment-${"a".repeat(32)}`],
      },
      artvenn_featured_prepare: {
        requestId: "11111111-1111-4111-8111-111111111111",
        items: [
          {
            target: { type: "work", id: `work-${"a".repeat(32)}` },
            enabled: true,
            position: 0,
          },
        ],
      },
      artvenn_operations_execute: {
        requestId: "11111111-1111-4111-8111-111111111111",
        operationId: "11111111-1111-4111-8111-111111111111",
      },
      artvenn_operations_cancel: {
        requestId: "11111111-1111-4111-8111-111111111111",
        operationId: "11111111-1111-4111-8111-111111111111",
      },
      artvenn_operations_prepare_undo: {
        requestId: "11111111-1111-4111-8111-111111111111",
        operationId: "11111111-1111-4111-8111-111111111111",
      },
    };
    for (const name of PRESET_TOOLS.management) {
      const { tool, calls } = await requestsOf(name);
      await tool.handler(
        fixtures[name] ?? {},
        {
          user: { collection: "users", agentPrincipal: "agent-phone" },
        } as never,
        undefined,
      );
      expect(calls.length, `${name} made no Backend call`).toBeGreaterThan(0);
      for (const call of calls) {
        // `held` is every scope, because management holds all seven — so this
        // alone cannot fail. The assertions that CAN fail are that the table
        // covers the path at all (scopeForPath throws otherwise) and that the
        // specific paths below map where the service actually enforces them.
        expect(
          held.has(scopeForPath(call.path)),
          `${name} calls ${call.path} under ${scopeForPath(call.path)}`,
        ).toBe(true);
        mapped[name] = scopeForPath(call.path);
      }
    }
    expect(mapped.artvenn_comments_prepare).toBe("comments:moderate");
    expect(mapped.artvenn_featured_prepare).toBe("featured:write");
    expect(mapped.artvenn_operations_prepare_undo).toBe("operations:undo");
    expect(mapped.artvenn_operations_execute).toBe("operations:execute");
  });

  it("still finds each mapped scope enforced by the service under that exact name", async () => {
    const source = read(
      "services/api/src/modules/community/application/services/agent-administration-service.ts",
    );
    const mappedScopes = [
      ...SCOPE_BY_PATH_PREFIX.map(([, scope]) => scope),
      // The suffix override's scope, which iterating the prefix table alone
      // would silently leave uncovered.
      "operations:undo",
    ];
    for (const scope of new Set(mappedScopes))
      expect(
        source.includes(`authorize(principal, "${scope}")`),
        `${scope} is no longer enforced by the service under that name`,
      ).toBe(true);
  });

  it("records that prepare-comments enforces a second scope the one-per-path table cannot express", () => {
    // Selector mode additionally authorizes comments:read
    // (agent-administration-service.ts). The fixture above uses `ids` mode, so
    // that branch is never walked — written down rather than left implied.
    const source = read(
      "services/api/src/modules/community/application/services/agent-administration-service.ts",
    );
    expect(source).toContain('authorize(principal, "comments:moderate")');
    expect(source).toContain('authorize(principal, "comments:read")');
    expect(PRESET_SCOPES.management).toContain("comments:read");
    expect(PRESET_SCOPES.management).toContain("comments:moderate");
  });

  it("keeps every management-only tool out of the read-only grant map, so it is absent from tools/list", () => {
    const readOnly = new Set(PRESET_TOOLS["read-only"]);
    const managementOnly = PRESET_TOOLS.management.filter(
      (name) => !readOnly.has(name),
    );
    expect(managementOnly.length).toBeGreaterThan(0);
    // The specific r9 defect, pinned by name.
    expect(managementOnly).toContain("artvenn_operations_get");
  });

  it("covers every tool in the real registry by exactly one preset decision", () => {
    const names = registry.map((tool) => tool.name);
    for (const name of names)
      expect(
        PRESET_TOOLS.management.includes(name),
        `${name} is in the registry but no preset grants it`,
      ).toBe(true);
  });
});
