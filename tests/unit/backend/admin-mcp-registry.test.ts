import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ADMIN_ACTIONS_MAX_OPS,
  ADMIN_ANALYTICS_REPORTS,
  ADMIN_CMS_RECORD_TYPES,
  ADMIN_COMMUNITY_RECORD_TYPES,
  ADMIN_MCP_NATIVE_TOOLS,
  ADMIN_MCP_RESULT_SCHEMA,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_MCP_TOOL_PROFILES,
  ADMIN_OP_ALIASES,
  ADMIN_OP_NAMES,
  ADMIN_OP_TOOLS,
  AI_FIND_SOURCES,
  AI_LOOKUP_TYPES,
  AI_SETTLEMENT_TYPES,
  ANALYTICS_CANONICAL_DIMENSIONS,
  ANALYTICS_UMAMI_DIMENSIONS,
  adminActionDetailSchema,
  adminCommunityWriteEchoSchema,
  adminMcpEnvelopeSchema,
  adminToolDetailSchema,
  type AdminMcpNativeTool,
  type AdminOpName,
  type AdminToolExample,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ACTIONS_TOOL_NAME,
  ADMIN_ACTIONS_INDEX_ALARM_SHARE,
  ADMIN_MCP_TOOL_RESERVE_BYTES,
  ADMIN_MCP_TOOLS,
  ADMIN_SURFACES,
  ADMIN_TOOL_EXAMPLES,
  actionDetail,
  adminMcpBudgets,
  actionsContinuation,
  actionsEnvelope,
  actionsIndex,
  adminOpMeta,
  built,
  classToolViolations,
  isAdminOpName,
  listingTable,
  lookupOp,
  okEnvelope,
  nearestOps,
  opUnavailable,
  opsOnTool,
  renderAdminMcpCapabilities,
  toolDetail,
  toolFor,
  toolListingFor,
  toolResult,
  type AdminOpEntry,
} from "admin/admin-mcp";
import { agentConnectionEndpoints } from "admin/agent-connections";
import {
  communityOperationDefinitions,
  createCommunityEndpoints,
} from "admin/community-endpoints";
import {
  editorialEndpoints,
  editorialOperationDefinitions,
} from "admin/editorial";
import { workspaces } from "admin/workspace-routes";

import { repositoryRoot } from "../architecture/workspace-scanner.js";

// The registry's drift gate (admin-mcp-completion-v1 section 5). The Record type
// catches an op with no row; this walks what the type cannot see, the real routes,
// collections, views, pages and operator commands, and every one must map to an op,
// a tool, a companion tool, or an exclusion with a reason.

const read = (file: string) =>
  readFile(path.join(repositoryRoot, file), "utf8");
const names = (entries: readonly AdminOpName[]) => [...entries].sort();
const rows = () => Object.entries(adminOpMeta) as [AdminOpName, AdminOpEntry][];
const entryOf = (name: AdminOpName): AdminOpEntry => adminOpMeta[name];

const COMMUNITY_ROUTES = [
  "read-reports",
  "read-report",
  "decide-report",
  "review-report",
  "set-report-metadata",
  "forward-report",
  "read-feedback",
  "read-works",
  "read-users",
  "recommend-user",
  "moderate-work",
  "read-featured",
  "set-featured",
  "set-featured-quantity",
  "delete-body",
  "remove-thread",
  "read-dm-conversation",
  "lookup-dm-conversation",
  "remove-dm-message",
  "read-threads",
  "create-thread",
  "update-thread",
  "read-feature-catalogs",
  "read-policy",
  "set-policy",
  "read-comments",
  "read-comment",
  "moderate-comment",
  "moderate-comments",
  "moderate-user",
  "read-events",
  "read-summary",
  "read-work-publishing-settings",
  "set-work-publishing-settings",
  "read-article-submissions",
  "read-article-submission",
  "moderate-article-submission",
  "read-work-submissions",
  "read-work-submission",
  "moderate-work-submission",
  "read-account-capacity",
  "set-account-capacity",
  "read-publishing-jobs",
  "retry-publishing-job",
  "abandon-publishing-job",
  "read-timeline",
  "read-timeline-summary",
  "create-timeline-entry",
  "update-timeline-entry",
  "reorder-timeline",
];
const EDITORIAL_ROUTES = [
  "owner-drafts",
  "owner-history",
  "read-draft",
  "save-draft",
  "approve-batch",
  "publish-approved",
  "restore-draft",
  "prepare-catalog-delivery",
  "read-catalog-delivery",
  "request-catalog-release",
  "release-catalog-delivery",
  "cancel-catalog-delivery",
  "catalog-delivery-capabilities",
  "catalog-render-backlog",
  "save-article-draft",
  "approve-article-batch",
  "publish-approved-article",
];

describe("op names", () => {
  it("registers exactly the contract's names, each once", () => {
    expect(new Set(ADMIN_OP_NAMES).size).toBe(ADMIN_OP_NAMES.length);
    expect(Object.keys(adminOpMeta).sort()).toEqual(names(ADMIN_OP_NAMES));
  });

  it("keeps every Owner route name and its order", () => {
    expect(Object.keys(communityOperationDefinitions)).toEqual(
      COMMUNITY_ROUTES,
    );
    expect(
      createCommunityEndpoints()
        .map(({ path: route, method }) => `${method} ${route}`)
        .slice(0, COMMUNITY_ROUTES.length),
    ).toEqual(
      COMMUNITY_ROUTES.map((name) => `post /community-moderation/${name}`),
    );
    expect(Object.keys(editorialOperationDefinitions)).toEqual(
      EDITORIAL_ROUTES,
    );
    expect(editorialEndpoints.map(({ path: route }) => route)).toEqual(
      EDITORIAL_ROUTES.map((name) => `/editorial/${name}`),
    );
  });

  it("names each route after itself, and leaves out only the bulk comment route", () => {
    expect(
      ADMIN_OP_NAMES.filter((name) => name.startsWith("community.")).map(
        (name) => name.slice("community.".length),
      ),
    ).toEqual(COMMUNITY_ROUTES.filter((name) => name !== "moderate-comments"));
    expect(
      ADMIN_OP_NAMES.filter((name) => name.startsWith("editorial.")).map(
        (name) => name.slice("editorial.".length),
      ),
    ).toEqual(EDITORIAL_ROUTES);
  });

  it("gives each community and editorial row the schemas its route runs", () => {
    for (const route of COMMUNITY_ROUTES.filter(
      (name) => name !== "moderate-comments",
    )) {
      const definition =
        communityOperationDefinitions[
          route as keyof typeof communityOperationDefinitions
        ];
      const entry = entryOf(`community.${route}` as AdminOpName);
      // A built write answers its own small echo, and takes its key from requestId.
      if (entry.tool === "admin_execute" && entry.run !== undefined) {
        const shapeOf = (schema: unknown) =>
          (schema as { shape: Record<string, unknown> }).shape;
        expect(Object.keys(shapeOf(entry.input)).sort(), route).toEqual(
          Object.keys(shapeOf(definition.input))
            .filter((field) => field !== "requestId")
            .sort(),
        );
        expect(entry.output, route).toEqual({
          ai: adminCommunityWriteEchoSchema,
        });
        continue;
      }
      expect(entry.input, route).toBe(definition.input);
      expect(entry.output, route).toBe(definition.output);
    }
    for (const route of EDITORIAL_ROUTES) {
      const { input } =
        editorialOperationDefinitions[
          route as keyof typeof editorialOperationDefinitions
        ];
      const entry = entryOf(`editorial.${route}` as AdminOpName);
      const routeShape = (input as { shape?: Record<string, unknown> }).shape;
      // A client never sends the route's key: admin_execute derives it per target.
      if (routeShape === undefined || !("idempotencyKey" in routeShape)) {
        expect(entry.input, route).toBe(input);
        continue;
      }
      const { allowRemoving, ...rowFields } = (
        entry.input as unknown as { shape: Record<string, unknown> }
      ).shape;
      expect(Object.keys(rowFields).sort(), route).toEqual(
        Object.keys(routeShape)
          .filter((field) => field !== "idempotencyKey")
          .sort(),
      );
      expect(allowRemoving !== undefined, route).toBe(
        route === "save-draft" || route === "save-article-draft",
      );
    }
  });
});

describe("earlier op names", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("point each at a current op, never shadow one, and stay at least 30 days", () => {
    for (const [name, { use, since, until }] of Object.entries(
      ADMIN_OP_ALIASES,
    )) {
      expect(isAdminOpName(name), name).toBe(false);
      expect(isAdminOpName(use), name).toBe(true);
      for (const day of [since, until])
        expect(day, name).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(
        Date.parse(until) - Date.parse(since),
        name,
      ).toBeGreaterThanOrEqual(30 * DAY_MS);
    }
  });

  it("run the op that replaced them through their last day, then answer as retired", () => {
    const aliases = {
      "list.catalog_rows": {
        use: "list.catalogs",
        since: "2026-11-06",
        until: "2026-12-31",
      },
    } as const;
    const on = (day: string, name = "list.catalog_rows") =>
      lookupOp(name, new Date(`${day}T23:59:59Z`), aliases);
    expect(on("2026-12-31")).toEqual({
      op: "list.catalogs",
      deprecated: {
        op: "list.catalog_rows",
        use: "list.catalogs",
        until: "2026-12-31",
      },
    });
    expect(on("2027-01-01")).toEqual({
      retired: { op: "list.catalog_rows", use: "list.catalogs" },
    });
    // The registry's own name, and a typo, are as they always were.
    expect(on("2027-01-01", "list.catalogs")).toEqual({ op: "list.catalogs" });
    expect(on("2027-01-01", "list.catalog")).toEqual({ unknown: true });
    expect(lookupOp("list.catalog_rows")).toEqual({ unknown: true });
  });
});

// The route handlers themselves, with only the loopback transport replaced: what
// the definitions must keep for the Owner, beyond community-admin-endpoints.test.ts.
describe("the Owner routes read and check what they always did", () => {
  const owner = (body: unknown) =>
    ({
      user: { collection: "users", id: 1, role: "owner" },
      json: async () => body,
      payload: { logger: { error: vi.fn() } },
    }) as unknown as PayloadRequest;
  const send = async (name: string, body: unknown, answer: unknown = {}) => {
    const call = vi.fn(async () => answer);
    const endpoint = createCommunityEndpoints(call as never).find(
      ({ path: route }) => route === `/community-moderation/${name}`,
    );
    const response = await (
      endpoint!.handler as (req: PayloadRequest) => Promise<Response>
    )(owner(body));
    return {
      status: response.status,
      body: (await response.json()) as {
        ok: boolean;
        result?: unknown;
        error?: { code: string };
      },
      calls: call.mock.calls as unknown as unknown[][],
    };
  };

  it("ignores any body on read-policy", async () => {
    const answer = await send("read-policy", { anything: true });
    expect(answer.status).toBe(200);
    expect(answer.calls).toEqual([["GET", "publication-policy"]]);
  });

  it.each(["read-comments", "read-events", "read-summary"])(
    "reads no body as empty on %s",
    async (name) => {
      expect((await send(name, null)).status).toBe(200);
    },
  );

  it("refuses no body everywhere else", async () => {
    for (const name of ["read-reports", "read-works", "read-threads"]) {
      const answer = await send(name, null);
      expect(answer.status, name).toBe(400);
      expect(answer.body.error?.code, name).toBe("COMMAND_INVALID");
      expect(answer.calls, name).toEqual([]);
    }
  });

  it("refuses a field on a route that takes none, before any call", async () => {
    const answer = await send("read-work-publishing-settings", { extra: 1 });
    expect(answer.status).toBe(400);
    expect(answer.calls).toEqual([]);
  });

  it("relays an unchecked answer as it stands, and refuses a bad checked one", async () => {
    const odd = { shape: "whatever the Backend said" };
    const relayed = await send("read-works", {}, odd);
    expect(relayed.status).toBe(200);
    expect(relayed.body.result).toEqual(odd);
    const refused = await send("read-users", {}, odd);
    expect(refused.status).toBe(502);
    expect(refused.body.error?.code).toBe("OPERATOR_RESPONSE_INVALID");
  });

  it("still sends the Backend exactly the validated route and command", async () => {
    const id = "comment-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
    const moderate = await send("moderate-comment", {
      id,
      action: "hide",
      reason: "Synthetic",
    });
    expect(moderate.calls).toEqual([
      [
        "POST",
        `comments/${id}/moderation`,
        { action: "hide", reason: "Synthetic" },
      ],
    ]);
    const threads = await send("read-threads", { includeHidden: false });
    expect(threads.calls[0]?.[1]).toBe(
      "threads?page=1&pageSize=20&includeHidden=false",
    );
  });
});

// ---------------------------------------------------------------------------

const uncovered = (
  surfaces: Iterable<string>,
  table: Readonly<Record<string, unknown>>,
  known: Readonly<Record<string, unknown>>,
): string[] =>
  [...surfaces].filter((surface) => {
    if (Object.hasOwn(known, surface)) return false;
    const route =
      /^endpoint POST \/(community-moderation|editorial)\/([^/]+)$/u.exec(
        surface,
      );
    if (route === null) return true;
    const family = route[1] === "editorial" ? "editorial" : "community";
    return !Object.hasOwn(table, `${family}.${route[2]}`);
  });

describe("every surface maps to an op, a tool or a stated exclusion", () => {
  const directory = path.join(
    repositoryRoot,
    `.local/admin-mcp-registry-${randomUUID()}/media`,
  );
  let surfaces: string[];

  const commandsIn = async (
    family: string,
    file: string,
    pattern: RegExp,
    words = /"?([a-z][a-z-]*)"?/gu,
  ) => {
    const match = pattern.exec(await read(file));
    if (match === null) throw new Error(`no command list in ${file}`);
    return [...match[1]!.matchAll(words)].map(
      ([, word]) => `command ${family} ${word}`,
    );
  };

  beforeAll(async () => {
    vi.stubEnv("CMS_SECRET", "synthetic-config-load-secret");
    vi.stubEnv(
      "CMS_DATABASE_URL",
      "postgresql://synthetic@127.0.0.1:1/moya_synthetic_test",
    );
    vi.stubEnv("CMS_ENVIRONMENT", "synthetic");
    vi.stubEnv("CMS_STORAGE_MODE", "local");
    vi.stubEnv("CMS_MEDIA_DIR", directory);
    vi.stubEnv("CMS_CATALOG_INGEST", "on");
    const config = await (await import("admin/config")).default;
    const endpointOf = ({
      method,
      path: route,
    }: {
      readonly method: string;
      readonly path: string;
    }) => `endpoint ${method.toUpperCase()} ${route}`;
    const catalogMaster = await commandsIn(
      "catalog-master",
      "services/backend-production/src/catalog-master/commands.ts",
      /const OPTIONS[^=]*= \{([\s\S]*?)\n\};/u,
      /^\s*"?([a-z][a-z-]*)"?: \[/gmu,
    );
    const invitations = await commandsIn(
      "invitations",
      "scripts/manage-registration-invitations.mjs",
      /!\[([^\]]*)\]\.includes\(\s*action/u,
    );
    const analyticsScripts = (
      await readdir(path.join(repositoryRoot, "scripts/analytics"))
    )
      .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
      .map((file) => `script scripts/analytics/${file}`);
    const scriptsOf = async (file: string) =>
      Object.keys(
        (JSON.parse(await read(file)) as { scripts: Record<string, string> })
          .scripts,
      );
    const importer = (await scriptsOf("services/catalog-importer/package.json"))
      .filter((name) => /^(?:catalog-import|p5):/u.test(name))
      .map((name) => `cli catalog-importer ${name}`);
    const admin = (await scriptsOf("apps/admin/package.json"))
      .filter((name) => name.startsWith("cms:"))
      .map((name) => `cli admin ${name}`);
    const pilot = /\[("prepare", "apply", "media")\]/u.exec(
      await read("services/backend-production/src/pilot-cli.ts"),
    );
    if (pilot === null) throw new Error("no pilot command list");
    surfaces = [
      ...config.endpoints.map(endpointOf),
      ...agentConnectionEndpoints({
        NODE_ENV: "development",
        AGENT_CONNECTIONS_ENABLED: "true",
      } as NodeJS.ProcessEnv).map(endpointOf),
      ...config.collections.map(({ slug }) => `collection ${slug}`),
      ...config.globals.map(({ slug }) => `global ${slug}`),
      ...Object.keys(config.admin.components.views ?? {}).map(
        (view) => `view ${view}`,
      ),
      ...workspaces.flatMap(({ pages }) =>
        pages.map(({ href }) => `page ${href}`),
      ),
      ...catalogMaster,
      ...invitations,
      ...analyticsScripts,
      "script scripts/provision-password-account.mjs",
      ...importer,
      ...admin,
      ...[...pilot[1]!.matchAll(/"([a-z]+)"/gu)].map(
        ([, step]) => `cli pilot ${step}`,
      ),
    ];
  }, 60_000);
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("walks a real, complete set", () => {
    for (const surface of [
      "endpoint POST /community-moderation/read-comments",
      "endpoint POST /editorial/save-draft",
      "endpoint POST /editorial/media-upload/start",
      "endpoint POST /editorial/media-ingest/start",
      "endpoint GET /analytics/ips",
      "endpoint GET /agent-connections",
      "collection catalogs",
      "collection payload-mcp-api-keys",
      "global mcp-control",
      "view communityModeration",
      "page /admin/community-moderation/reports",
      "command catalog-master attach-batch",
      "command invitations revoke-access",
      "script scripts/analytics/prune-umami.mjs",
      "cli catalog-importer p5:validate",
      "cli pilot apply",
      "cli admin cms:legacy",
    ])
      expect(surfaces, surface).toContain(surface);
  });

  it("leaves no surface unclassified", () => {
    expect(uncovered(surfaces, adminOpMeta, ADMIN_SURFACES)).toEqual([]);
  });

  it("keeps no row for a surface that is gone", () => {
    const real = new Set(surfaces);
    expect(Object.keys(ADMIN_SURFACES).filter((row) => !real.has(row))).toEqual(
      [],
    );
  });

  it("fails on a new route, a new page and a lost op, so the gate can close", () => {
    expect(
      uncovered(
        [
          "endpoint POST /community-moderation/brand-new",
          "endpoint POST /editorial/brand-new",
          "endpoint GET /brand-new",
          "collection brand-new",
          "view brandNew",
          "page /admin/brand-new",
          "command catalog-master brand-new",
          "script scripts/analytics/brand-new.mjs",
        ],
        adminOpMeta,
        ADMIN_SURFACES,
      ),
    ).toHaveLength(8);
    const withoutOne = Object.fromEntries(
      rows().filter(([name]) => name !== "community.read-reports"),
    );
    expect(
      uncovered(
        ["endpoint POST /community-moderation/read-reports"],
        withoutOne,
        ADMIN_SURFACES,
      ),
    ).toHaveLength(1);
  });

  it("gives every exclusion a reason from the short list", () => {
    for (const [surface, target] of Object.entries(ADMIN_SURFACES)) {
      if (!("excluded" in target)) continue;
      expect(
        ["reserved", "human-ui", "dev-only", "config", "outside-parity"],
        surface,
      ).toContain(target.excluded);
      expect(target.why, surface).toMatch(/\S/u);
    }
  });

  it("names only real ops and tools", () => {
    for (const [surface, target] of Object.entries(ADMIN_SURFACES)) {
      if ("op" in target)
        for (const name of target.op)
          expect(ADMIN_OP_NAMES, surface).toContain(name);
      if ("tool" in target)
        for (const name of target.tool)
          expect(ADMIN_MCP_NATIVE_TOOLS, surface).toContain(name);
    }
  });

  it("keeps the Owner's reserved surfaces out of every op", () => {
    for (const surface of [
      "collection users",
      "collection payload-mcp-api-keys",
      "collection mcp-audit-events",
      "global mcp-control",
      "view mcpControl",
      "page /admin/mcp-control",
      "page /admin/collections/users",
      "page /admin/collections/payload-mcp-api-keys",
      "page /admin/collections/mcp-audit-events",
      "endpoint POST /mcp-control/keys/:id/renew",
      // S8: past the threshold only the Owner confirms a run, and may cancel any.
      "endpoint POST /mcp-control/runs/:id/confirm",
      "endpoint POST /mcp-control/runs/:id/cancel",
    ])
      expect(ADMIN_SURFACES[surface], surface).toMatchObject({
        excluded: "reserved",
      });
    for (const name of ADMIN_OP_NAMES)
      expect(name).not.toMatch(
        /payload-mcp-api-keys|mcp-control|mcp_control|mcp-audit|audit|\.keys?\b|\.control\b|\.pause\b|\.threshold\b|confirm/u,
      );
  });

  it("keeps the AI connection surfaces reserved, and /start with the Development boundary", () => {
    for (const surface of [
      "endpoint POST /agent-connections/consent",
      "endpoint GET /agent-connections",
      "endpoint POST /agent-connections/disconnect",
      "view agentConnections",
      "view agentConnectionsConsent",
      "page /admin/agent-connections",
    ])
      expect(ADMIN_SURFACES[surface], surface).toMatchObject({
        excluded: "reserved",
      });
    expect(
      ADMIN_SURFACES["endpoint POST /agent-connections/start"],
    ).toMatchObject({ excluded: "dev-only" });
    for (const name of ADMIN_OP_NAMES)
      expect(name).not.toMatch(/connection|consent/u);
  });

  it("composes the reserved routes in Production, without /start", () => {
    const paths = (settings: Record<string, string>) =>
      agentConnectionEndpoints(settings as NodeJS.ProcessEnv)
        .map(
          ({ method, path: route }) =>
            `endpoint ${method.toUpperCase()} ${route}`,
        )
        .sort();
    const production = [
      "endpoint GET /agent-connections",
      "endpoint POST /agent-connections/consent",
      "endpoint POST /agent-connections/disconnect",
    ];
    expect(
      paths({ NODE_ENV: "production", ADMIN_MCP_OAUTH_ENABLED: "true" }),
    ).toEqual(production);
    expect(
      paths({ NODE_ENV: "development", AGENT_CONNECTIONS_ENABLED: "true" }),
    ).toEqual([...production, "endpoint POST /agent-connections/start"].sort());
    expect(paths({ NODE_ENV: "production" })).toEqual([]);
    expect(
      paths({ NODE_ENV: "production", AGENT_CONNECTIONS_ENABLED: "true" }),
    ).toEqual([]);
    expect(
      paths({ NODE_ENV: "development", ADMIN_MCP_OAUTH_ENABLED: "true" }),
    ).toEqual([]);
  });

  it("has no tool for plaintext contact or for hard deletion", () => {
    for (const name of ADMIN_OP_NAMES)
      expect(name).not.toMatch(
        /hard|contact|email|phone|^(?:catalog|article|collection|media)\.delete/u,
      );
  });
});

// ---------------------------------------------------------------------------

describe("class decides the tool", () => {
  it("holds across the whole registry", () => {
    expect(classToolViolations()).toEqual([]);
    for (const [name, entry] of rows())
      expect(entry.tool, name).toBe(
        entry.klass === "read"
          ? entry.sensitive
            ? "admin_sensitive_read"
            : "admin_read"
          : entry.klass === "reversible"
            ? "admin_execute"
            : "admin_execute_irreversible",
      );
  });

  it.each([
    ["a read op on the execute tool", "list.catalogs", "admin_execute"],
    [
      "a read op on the irreversible tool",
      "list.catalogs",
      "admin_execute_irreversible",
    ],
    ["a reversible op on the read tool", "catalog.publish", "admin_read"],
    [
      "an irreversible op on the execute tool",
      "community.delete-body",
      "admin_execute",
    ],
    ["a sensitive read on the plain read tool", "analytics.ips", "admin_read"],
  ] as const)("fails on %s", (_label, op, tool) => {
    expect(
      classToolViolations({ ...adminOpMeta, [op]: { ...entryOf(op), tool } }),
    ).toEqual([op]);
  });

  it("gives a tool only its own class, so its annotations stay true", () => {
    for (const tool of ADMIN_OP_TOOLS) {
      const classes = new Set(opsOnTool(tool).map((op) => entryOf(op).klass));
      expect(classes.size, tool).toBe(1);
      const built = ADMIN_MCP_TOOLS.find(({ name }) => name === tool);
      if (built === undefined) continue;
      expect(built.annotations.readOnlyHint, tool).toBe(classes.has("read"));
      expect(built.annotations.destructiveHint, tool).toBe(
        classes.has("irreversible"),
      );
      expect([...classes], tool).toEqual([built.klass]);
    }
  });

  it("pins the irreversible set by hand", () => {
    expect(
      names(
        ADMIN_OP_NAMES.filter((op) => entryOf(op).klass === "irreversible"),
      ),
    ).toEqual(
      names([
        "community.delete-body",
        "community.remove-thread",
        "community.remove-dm-message",
        "community.abandon-publishing-job",
        "community.forward-report",
        "ops.master.erase",
        "ops.invitation.revoke",
        "ops.upload_gc.run",
        "ops.account.provision",
        "analytics.prune.run",
        "analytics.definition.delete",
        "media.register_upload",
        // A duplicate always binds a new identity.
        "catalog.duplicate",
        "article.duplicate",
        "collection.duplicate",
      ]),
    );
  });

  it("pins the ops whose class rises with the input", () => {
    expect(
      names(ADMIN_OP_NAMES.filter((op) => entryOf(op).risesWhen !== undefined)),
    ).toEqual(
      names([
        "community.set-report-metadata",
        "editorial.save-draft",
        "editorial.save-article-draft",
        "collection.save",
        "media.register_existing",
      ]),
    );
    for (const op of ADMIN_OP_NAMES)
      if (entryOf(op).risesWhen !== undefined)
        expect(entryOf(op).klass, op).toBe("reversible");
  });

  it("pins the sensitive set by hand", () => {
    expect(
      names(ADMIN_OP_NAMES.filter((op) => entryOf(op).sensitive !== undefined)),
    ).toEqual(
      names([
        "community.read-dm-conversation",
        "community.lookup-dm-conversation",
        "community.remove-dm-message",
        "analytics.ips",
      ]),
    );
    expect(entryOf("analytics.ips").sensitive).toBe("rawIp");
    expect(entryOf("community.remove-dm-message").sensitive).toBe("dm");
  });

  it("pins the async set and the two named sync ops", () => {
    expect(
      names(
        ADMIN_OP_NAMES.filter((op) => entryOf(op).completion.kind === "async"),
      ),
    ).toEqual(
      names([
        "community.moderate-work",
        "community.moderate-user",
        "community.moderate-work-submission",
        "community.moderate-article-submission",
        "community.decide-report",
        "community.review-report",
        "community.retry-publishing-job",
        "editorial.prepare-catalog-delivery",
        "editorial.request-catalog-release",
        "catalog.withdraw",
        "ops.master.attach",
        "ops.master.attach_existing",
        "ops.master.set_limit",
        "ops.master.requeue",
        "analytics.prune.run",
        "media.register_upload",
      ]),
    );
    expect(entryOf("editorial.release-catalog-delivery").completion.kind).toBe(
      "sync",
    );
    expect(entryOf("catalog.publish").completion.kind).toBe("sync");
  });

  it("pins which async ops read a real settlement, so accepted never reads as done", () => {
    const settles = (op: AdminOpName) => {
      const { completion } = entryOf(op);
      return completion.kind === "async" && completion.settle !== undefined;
    };
    const built = ADMIN_OP_NAMES.filter(
      (op) => entryOf(op).completion.kind === "async" && entryOf(op).run,
    );
    expect(names(built.filter(settles))).toEqual(
      names([
        "community.moderate-work",
        "community.moderate-user",
        "community.moderate-work-submission",
        "community.moderate-article-submission",
        "community.decide-report",
        "community.review-report",
        "community.retry-publishing-job",
        "editorial.prepare-catalog-delivery",
        "editorial.request-catalog-release",
        "catalog.withdraw",
      ]),
    );
    // Nothing built answers from `accepted`: a new async op has to say how it settles.
    expect(built.filter((op) => !settles(op))).toEqual([]);
  });

  it("never reads a command it cannot place as having moved nothing", async () => {
    const settleOf = (op: AdminOpName) => {
      const { completion } = entryOf(op);
      if (completion.kind !== "async" || completion.settle === undefined)
        throw new Error(`${op} has no settlement`);
      return completion.settle;
    };
    const context = {} as Parameters<ReturnType<typeof settleOf>>[2];
    for (const [op, input, answer] of [
      ["community.moderate-work-submission", { action: "approve" }, undefined],
      ["community.moderate-work-submission", { action: "approve" }, {}],
      ["community.decide-report", { action: "hide" }, undefined],
      ["community.decide-report", { action: "hide" }, { target: null }],
      ["community.decide-report", { action: "suspend" }, {}],
      ["community.review-report", { outcome: "uphold" }, undefined],
      ["community.review-report", { outcome: "uphold" }, { decision: null }],
    ] as const)
      await expect(
        settleOf(op)(input, answer, context),
        JSON.stringify([op, input, answer]),
      ).rejects.toThrow("SETTLEMENT_SUBJECT_UNKNOWN");
  });

  it("pins the credential map of section 2", () => {
    const credential = (op: AdminOpName) => entryOf(op).credential;
    for (const op of ADMIN_OP_NAMES) {
      if (
        op === "community.read-feature-catalogs" ||
        op === "list.feature_catalogs"
      )
        // A Payload read in Admin: it calls no Backend route at all.
        expect(credential(op), op).toBe("none");
      else if (op.startsWith("community."))
        expect(credential(op), op).toBe("community");
      else if (
        op.startsWith("ops.master.") ||
        op === "list.masters" ||
        op === "analytics.ips" ||
        op === "analytics.prune.run"
      )
        expect(credential(op), op).toBe("base");
      else if (
        /^ops\.(?:invitation|access|account)\./u.test(op) ||
        op === "list.invitations"
      )
        expect(credential(op), op).toBe("community");
      else if (
        /^(?:editorial|catalog|catalog_search|article|collection|media|document|approval)\.|^ops\.upload_gc\./u.test(
          op,
        )
      )
        expect(credential(op), op).toBe("none");
    }
    // No Catalog or analytics op may come to need the community token.
    for (const op of ADMIN_OP_NAMES)
      if (/^(?:catalog|catalog_search|analytics|ops\.master)\b/u.test(op))
        expect(credential(op), op).not.toBe("community");
  });
});

describe("op rows", () => {
  it("states each op in fixed English, without content", () => {
    for (const [name, entry] of rows()) {
      expect(entry.summary, name).toMatch(/^[\x20-\x7e]{1,80}$/u);
      expect(entry.summary, name).not.toContain("${");
    }
  });

  it("converts every input and output schema to JSON Schema", () => {
    const open = { dm: true, evidence: true, rawIp: true, selfOnly: true };
    for (const [name, entry] of rows()) {
      const detail = actionDetail(name, [entry.tool], open);
      if (entry.input !== undefined)
        expect(detail.input, name).toBeTypeOf("object");
      if (entry.output?.ai ?? entry.output?.owner)
        expect(detail.output ?? detail.outputOmitted, name).toBeTruthy();
    }
  });

  it("shows an example with every input, and every example parses", () => {
    for (const [name, entry] of rows()) {
      if (entry.input === undefined) continue;
      expect(entry.example, name).toBeDefined();
      const parsed = entry.input.safeParse(entry.example);
      expect(parsed.success ? [] : parsed.error.issues, name).toEqual([]);
    }
  });

  it("holds no credential-shaped value in an example", () => {
    for (const [name, entry] of rows())
      expect(JSON.stringify(entry.example ?? {}), name).not.toMatch(
        /artvenn_|Bearer |https?:\/\//u,
      );
  });

  it("draws selectors only from read list ops", () => {
    for (const [name, entry] of rows())
      for (const source of entry.selectorSources ?? []) {
        expect(source, name).toMatch(/^list\./u);
        expect(entryOf(source as AdminOpName).klass, name).toBe("read");
      }
  });

  // S8 plan 2.5: a preview freezes the state of each record a stamp source reads, so a
  // write on one that forgot to say so would run on state it never froze.
  it("stamps every built community write on a record a stamp source reads", () => {
    const STAMPED_BY: Readonly<Record<string, string>> = {
      comment: "comments",
      work: "works",
      user: "users",
      publishing_job: "jobs",
      report: "reports",
    };
    const stamped: string[] = [];
    for (const [name, entry] of rows()) {
      if (entry.credential !== "community" || entry.run === undefined) continue;
      if (entry.klass === "read") continue;
      const type = entry.target?.(entry.example ?? {})?.type;
      const source = type === undefined ? undefined : STAMPED_BY[type];
      if (source === undefined) continue;
      expect(entry.previewHooks?.stampSource, name).toBe(source);
      stamped.push(name);
    }
    expect(stamped).toEqual(
      expect.arrayContaining([
        "community.moderate-comment",
        "community.moderate-work",
        "community.moderate-user",
        "community.retry-publishing-job",
        "community.decide-report",
      ]),
    );
  });

  it("says why an op cannot run now, in the order a call meets it", () => {
    const entry = entryOf("analytics.ips");
    const run = async () => okEnvelope(null);
    expect(opUnavailable(entry, { rawIp: true })).toBe("not_available");
    expect(opUnavailable({ ...entry, run }, {})).toBe("SENSITIVE_SWITCH_OFF");
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    expect(opUnavailable({ ...entry, run }, { rawIp: true })).toBe(
      "AI_CREDENTIAL_NOT_CONFIGURED",
    );
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "synthetic");
    expect(opUnavailable({ ...entry, run }, { rawIp: true })).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------

// Chinese is 3 bytes a character and dense JSON runs near 3 bytes a token, so this
// counts a little high on purpose: the gate should close before the budget does.
const estimatedTokens = (value: unknown) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3);

describe("size gates", () => {
  const scope = { keyId: 2_000_000, tool: "fixture" };
  const row = (index: number) => ({
    id: `work-${index}`,
    title: `碑刻记录${"石".repeat(40)}`,
  });
  const list = (count: number) => ({
    items: Array.from({ length: count }, (_, index) => row(index)),
    total: count,
  });
  const textOf = (result: ReturnType<typeof toolResult>) =>
    result.content[0]!.text;

  it("leaves a result under the cap untouched", () => {
    const result = toolResult(scope, okEnvelope(list(3)));
    expect(result.structuredContent.meta).toEqual({});
    expect(result.structuredContent.data).toEqual(list(3));
  });

  it("cuts whole records under the cap, in bytes, and stays valid JSON", () => {
    const result = toolResult(scope, okEnvelope(list(500)), (kept) => ({
      tool: "fixture",
      args: { after: (kept.at(-1) as { id: string }).id },
    }));
    const text = textOf(result);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      ADMIN_MCP_TEXT_CAP_BYTES,
    );
    const parsed = adminMcpEnvelopeSchema.parse(JSON.parse(text));
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.ok).toBe(true);
    expect(parsed.meta.truncated).toBe(true);
    const { items, total } = parsed.data as ReturnType<typeof list>;
    expect(total).toBe(500);
    expect(items.length).toBeGreaterThan(10);
    expect(items).toEqual(list(500).items.slice(0, items.length));
    expect(parsed.remaining).toBe(500 - items.length);
    expect(parsed.next).toEqual({
      tool: "fixture",
      args: { after: items.at(-1)!.id },
    });
    // As many as fit: one more record would not.
    expect(
      Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(row(499))),
    ).toBeGreaterThan(ADMIN_MCP_TEXT_CAP_BYTES - 40);
  });

  it("keeps a pointer into a kept record, and drops one into a cut record", () => {
    const envelope = okEnvelope(list(500), [
      "/data/items/0/title",
      "/data/items/400/title",
      "/data/items/*/title",
      "/data/total",
    ]);
    const { untrusted } = toolResult(scope, envelope).structuredContent;
    expect(untrusted).toEqual([
      "/data/items/0/title",
      "/data/items/*/title",
      "/data/total",
    ]);
  });

  it("offers no way on when not one record fits, and says so", () => {
    const giant = { items: [{ text: "石".repeat(4000) }], note: "x" };
    const parsed = adminMcpEnvelopeSchema.parse(
      JSON.parse(
        textOf(
          toolResult(scope, okEnvelope(giant), () => ({
            tool: "fixture",
            args: {},
          })),
        ),
      ),
    );
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.next).toBeUndefined();
    expect(parsed.hint).toMatch(/cannot continue from here/u);
    expect(parsed.data).toEqual({ items: [], note: "x" });
    expect(parsed.remaining).toBe(1);
  });

  it("drops data altogether when what is too large is no array at all", () => {
    const parsed = adminMcpEnvelopeSchema.parse(
      JSON.parse(
        textOf(toolResult(scope, okEnvelope({ text: "石".repeat(4000) }))),
      ),
    );
    expect(parsed.data).toBeUndefined();
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.hint).toMatch(/cannot continue from here/u);
  });

  it("cuts a long issue list too, and keeps isError", () => {
    const result = toolResult(scope, {
      ok: false,
      code: "INPUT_INVALID",
      hint: "fixed",
      issues: Array.from({ length: 2000 }, (_, index) => ({
        path: ["items", index],
        code: "invalid_type",
      })),
      untrusted: [],
      meta: {},
    });
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(
      ADMIN_MCP_TEXT_CAP_BYTES,
    );
    expect(result.structuredContent.meta).toMatchObject({ truncated: true });
    expect(
      (result.structuredContent.issues as unknown[]).length,
    ).toBeGreaterThan(50);
  });

  it.each(ADMIN_MCP_TOOL_PROFILES)(
    "keeps tools/list within its token budget for the %s profile",
    (profile) => {
      const listing = toolListingFor(profile, false);
      expect(listing.length).toBeLessThanOrEqual(15);
      expect(estimatedTokens(listing)).toBeLessThanOrEqual(
        ADMIN_MCP_TOKEN_BUDGET,
      );
    },
  );

  // What grows with the registry: op and tool names, record types, reports and
  // dimensions, and what find, lookup and settlement read.
  const GROWING: ReadonlySet<unknown> = new Set([
    ...ADMIN_OP_NAMES,
    ...ADMIN_OP_TOOLS,
    ...ADMIN_MCP_NATIVE_TOOLS,
    ...ADMIN_CMS_RECORD_TYPES,
    ...ADMIN_COMMUNITY_RECORD_TYPES,
    ...ADMIN_ANALYTICS_REPORTS,
    ...ANALYTICS_CANONICAL_DIMENSIONS,
    ...ANALYTICS_UMAMI_DIMENSIONS,
    ...AI_FIND_SOURCES,
    ...AI_LOOKUP_TYPES,
    ...AI_SETTLEMENT_TYPES,
  ]);
  const ENUM_MAX_VALUES = 8;

  /**
   * Every closed choice in a listed input, wherever it sits, by where: an enum, or a
   * union of constants, which is one by another name.
   */
  const enumsOf = (
    schema: unknown,
    at: string,
  ): { at: string; values: readonly unknown[] }[] => {
    if (schema === null || typeof schema !== "object") return [];
    const { anyOf, oneOf } = schema as { anyOf?: unknown; oneOf?: unknown };
    // Every const option of a union is a listed choice, even beside options
    // that are not: number | "a" | "b" still lists "a" and "b".
    const constants = [anyOf, oneOf].flatMap((options) => {
      const values = Array.isArray(options)
        ? options
            .filter(
              (option) =>
                option !== null &&
                typeof option === "object" &&
                "const" in option,
            )
            .map((option: { const: unknown }) => option.const)
        : [];
      return values.length > 0 ? [{ at, values }] : [];
    });
    return [
      ...constants,
      ...Object.entries(schema).flatMap(([key, value]) =>
        key === "enum" && Array.isArray(value)
          ? [{ at, values: value as readonly unknown[] }]
          : enumsOf(value, `${at}/${key}`),
      ),
    ];
  };

  // Extending guide rule 3: the runtime check holds such a choice, not tools/list.
  it.each(ADMIN_MCP_TOOL_PROFILES)(
    "lists no enum that grows with the registry, nor one past eight values, for the %s profile",
    (profile) => {
      const found = toolListingFor(profile, false).flatMap((listing) =>
        enumsOf(listing.inputSchema, listing.name),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const { at, values } of found) {
        expect(values.length, at).toBeLessThanOrEqual(ENUM_MAX_VALUES);
        expect(
          values.filter((value) => GROWING.has(value)),
          at,
        ).toEqual([]);
      }
    },
  );

  // Section 5: the slice that adds a tool finds its room, and cuts no one else's.
  it("keeps room on the full profile for each native tool still to come", () => {
    const listing = toolListingFor("full", false);
    const toCome = ADMIN_MCP_NATIVE_TOOLS.filter(
      (name) => !listing.some((tool) => tool.name === name),
    );
    const { toolsList } = adminMcpBudgets();
    const wire = Buffer.byteLength(JSON.stringify(listing)) + toolsList.frame;
    expect(toolsList.reserved).toEqual({
      toCome,
      bytes: wire + ADMIN_MCP_TOOL_RESERVE_BYTES * toCome.length,
    });
    expect(toolsList.reserved.bytes).toBeLessThanOrEqual(
      ADMIN_MCP_TOKEN_BUDGET * 3,
    );
    expect(ADMIN_MCP_TOOL_RESERVE_BYTES).toBe(1_000);
  });

  // The tools E1 listed were past this before it came, so the snapshot pins each
  // one's size; a tool added later answers to it.
  const SIZED_BY_SNAPSHOT: ReadonlySet<string> = new Set([
    "admin_whoami",
    "admin_find",
    "admin_get",
    "admin_read",
    "admin_analytics",
    "admin_actions",
    "admin_view_media",
    "admin_job",
    "admin_execute",
  ]);
  const DESCRIPTION_MAX_BYTES = 400;
  const LATER_TOOL_MAX_BYTES = 1_100;
  const listedBytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value));
  const sizeFaults = (
    listing: readonly { readonly name: string; readonly description: string }[],
  ) =>
    listing.flatMap((tool) => [
      ...(listedBytes(tool.description) - 2 > DESCRIPTION_MAX_BYTES
        ? [`${tool.name}: description`]
        : []),
      ...(!SIZED_BY_SNAPSHOT.has(tool.name) &&
      listedBytes(tool) > LATER_TOOL_MAX_BYTES
        ? [`${tool.name}: listed`]
        : []),
    ]);

  it("holds each description to 400 bytes, and each tool added after E1 to 1,100 listed", () => {
    const every = listingTable(ADMIN_MCP_TOOLS).map(({ listing }) => listing);
    expect(sizeFaults(every)).toEqual([]);
    // Every tool to come answers to the cap; none slips into the pinned set.
    for (const name of SIZED_BY_SNAPSHOT)
      expect(every.map((tool) => tool.name)).toContain(name);
    const [whoami] = every;
    const padded = {
      ...whoami!,
      name: "admin_preview",
      inputSchema: { type: "object", description: "x".repeat(800) },
    };
    expect(listedBytes(padded)).toBeGreaterThan(LATER_TOOL_MAX_BYTES);
    expect(sizeFaults([padded])).toEqual(["admin_preview: listed"]);
    expect(sizeFaults([{ ...whoami!, description: "x".repeat(401) }])).toEqual([
      "admin_whoami: description",
    ]);
  });

  it("advertises a result schema true of the whole envelope", () => {
    const fields = Object.keys(adminMcpEnvelopeSchema.shape);
    for (const name of Object.keys(ADMIN_MCP_RESULT_SCHEMA.properties))
      expect(fields).toContain(name);
    expect(ADMIN_MCP_RESULT_SCHEMA).not.toHaveProperty("additionalProperties");
    const minimal = { ok: true, code: "OK", untrusted: [], meta: {} };
    expect(Object.keys(minimal)).toEqual(ADMIN_MCP_RESULT_SCHEMA.required);
    expect(adminMcpEnvelopeSchema.safeParse(minimal).success).toBe(true);
    for (const name of ADMIN_MCP_RESULT_SCHEMA.required) {
      const without = Object.fromEntries(
        Object.entries(minimal).filter(([field]) => field !== name),
      );
      expect(adminMcpEnvelopeSchema.safeParse(without).success, name).toBe(
        false,
      );
    }
  });
});

describe("admin_actions", () => {
  const allTools = [...ADMIN_OP_TOOLS];
  const open = { dm: true, evidence: true, rawIp: true, selfOnly: true };
  const scope = { keyId: 2_000_001, tool: ACTIONS_TOOL_NAME };
  const allRows = (index: ReturnType<typeof actionsIndex>) =>
    index.groups.flatMap(({ ops, unavailable }) => [
      ...ops,
      ...Object.values(unavailable ?? {}).flat(),
    ]);

  it("is listed on every profile and reads only", () => {
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      expect(toolFor(profile, ACTIONS_TOOL_NAME)?.klass).toBe("read");
  });

  it("keeps the whole index within its budgets", () => {
    const envelope = actionsEnvelope({}, allTools, open);
    const { content, structuredContent } = toolResult(scope, envelope);
    expect(structuredContent.meta).toEqual({});
    expect(Buffer.byteLength(content[0]!.text)).toBeLessThanOrEqual(
      ADMIN_MCP_TEXT_CAP_BYTES,
    );
    expect(estimatedTokens(envelope)).toBeLessThanOrEqual(
      ADMIN_MCP_TOKEN_BUDGET,
    );
  });

  it("raises its alarm at 80% of the text cap, measured in its largest form", () => {
    const { index } = adminMcpBudgets();
    expect(index.alarm).toBe(
      Math.floor(ADMIN_MCP_TEXT_CAP_BYTES * ADMIN_ACTIONS_INDEX_ALARM_SHARE),
    );
    expect(ADMIN_ACTIONS_INDEX_ALARM_SHARE).toBe(0.8);
    // Before it reaches the cap: past this, page the index by family first.
    expect(index.bytes).toBeLessThanOrEqual(index.alarm);
    // The figure is what a client receives with no AI token placed, and the most it gets.
    const answered = () =>
      Buffer.byteLength(
        toolResult(scope, actionsEnvelope({}, allTools, open)).content[0]!.text,
      );
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    try {
      expect(answered()).toBe(index.bytes);
      vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "synthetic-placed");
      vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "synthetic-placed");
      expect(answered()).toBeLessThanOrEqual(index.bytes);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lists every op once, with the fields it requires", () => {
    const index = actionsIndex(allTools, open);
    const listed = allRows(index);
    expect(listed.map((row) => row.split("(")[0]).sort()).toEqual(
      names(ADMIN_OP_NAMES),
    );
    expect(listed).toContain("community.read-report(id)");
    expect(listed).toContain(
      "community.decide-report(expectedVersion,action,reason,id)",
    );
    expect(listed).toContain("community.read-policy");
  });

  it("shows a key only the tools it can call", () => {
    const index = actionsIndex(["admin_whoami", "admin_read"], open);
    expect(index.groups.map(({ tool }) => tool)).toEqual(["admin_read"]);
    expect(actionsIndex(["admin_whoami"], open).groups).toEqual([]);
    expect(actionsIndex(["admin_whoami"], open).count).toBe(0);
  });

  it("files an op nothing has built under not_available, never as callable", () => {
    const index = actionsIndex(["admin_read"], open);
    const [group] = index.groups;
    expect(group?.ops).not.toContain("list.masters");
    expect(group?.unavailable?.not_available).toContain("list.masters");
  });

  it("files a built community read under its missing token, never as callable", () => {
    const [group] = actionsIndex(["admin_read"], open).groups;
    expect(group?.unavailable?.AI_CREDENTIAL_NOT_CONFIGURED).toContain(
      "community.read-comments",
    );
    expect(group?.ops).not.toContain("community.read-comments");
    // A Payload read in Admin, which needs no Backend token.
    expect(group?.ops).toContain("list.feature_catalogs");
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "synthetic-placed");
    try {
      const [placed] = actionsIndex(["admin_read"], open).groups;
      expect(placed?.ops).toContain("community.read-comments");
      expect(placed?.ops).toContain("list.reports");
      expect(placed?.unavailable?.not_available).toContain("list.invitations");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives one op's whole contract, and each fits alone with its input", () => {
    for (const op of ADMIN_OP_NAMES) {
      const detail = adminActionDetailSchema.parse(
        actionDetail(op, allTools, open),
      );
      const entry = entryOf(op);
      expect(detail).toMatchObject({
        op,
        tool: entry.tool,
        class: entry.klass,
        recovery: entry.recovery,
        completion: entry.completion.kind,
      });
      if (entry.input !== undefined) expect(detail.input, op).toBeDefined();
      const { content, structuredContent } = toolResult(
        scope,
        actionsEnvelope({ op }, allTools, open),
      );
      expect(structuredContent.meta, op).toEqual({});
      expect(Buffer.byteLength(content[0]!.text), op).toBeLessThanOrEqual(
        ADMIN_MCP_TEXT_CAP_BYTES,
      );
    }
  });

  it("removes only noise from a schema, not what a client acts on", () => {
    const detail = actionDetail("community.decide-report", allTools, open);
    expect(detail.input).toMatchObject({
      required: ["expectedVersion", "action", "reason", "id"],
      properties: {
        action: {
          enum: expect.arrayContaining(["hide", "suspend"]) as string[],
        },
        reason: { minLength: 1, maxLength: 2000 },
      },
    });
    const text = JSON.stringify(
      actionDetail("community.moderate-work", allTools, open),
    );
    expect(text).not.toContain("9007199254740991");
    expect(text).not.toContain('"$schema"');
    const keyed = JSON.stringify(
      actionDetail("community.delete-body", allTools, open),
    );
    expect(keyed).toContain('"format":"uuid"');
    expect(keyed).not.toContain("0000-0000-0000-000000000000");
  });

  it("says when an op is not on this key", () => {
    expect(actionDetail("catalog.publish", ["admin_read"], open)).toMatchObject(
      {
        available: false,
        unavailable: "tool_not_listed",
      },
    );
  });

  it("answers UNKNOWN_OP with near names, never the caller's text", () => {
    const envelope = actionsEnvelope(
      { op: "community.read-comment-canary" },
      allTools,
      open,
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: "UNKNOWN_OP",
      data: {
        nearest: expect.arrayContaining(["community.read-comment"]) as string[],
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("canary");
    expect(nearestOps("list.catalog")[0]).toBe("list.catalogs");
  });

  it("merges op and ops, and refuses more than the limit", () => {
    const envelope = actionsEnvelope(
      { op: "list.media", ops: ["list.media", "list.catalogs"] },
      allTools,
      open,
    );
    expect(
      (envelope.data as { details: { op: string }[] }).details.map(
        ({ op }) => op,
      ),
    ).toEqual(["list.media", "list.catalogs"]);
    const tooMany = ADMIN_OP_NAMES.slice(0, ADMIN_ACTIONS_MAX_OPS);
    expect(
      actionsEnvelope({ op: "list.media", ops: tooMany }, allTools, open),
    ).toMatchObject({ ok: false, code: "INPUT_INVALID" });
  });

  it("continues a cut detail call with the names it did not reach", () => {
    const ops = ["list.media", "list.catalogs", "list.users"];
    expect(actionsContinuation({ ops }, [{ op: "list.media" }])).toEqual({
      tool: ACTIONS_TOOL_NAME,
      args: { ops: ["list.catalogs", "list.users"] },
    });
    expect(
      actionsContinuation(
        { ops },
        ops.map((op) => ({ op })),
      ),
    ).toBeUndefined();
  });
});

describe("worked examples, by tool", () => {
  const listed = ADMIN_MCP_TOOLS.map(({ name }) => name);
  const open = { dm: true, evidence: true, rawIp: true, selfOnly: true };
  const scope = { keyId: 2_000_002, tool: ACTIONS_TOOL_NAME };
  const examplesOf = (name: string) =>
    built(ADMIN_TOOL_EXAMPLES[name as AdminMcpNativeTool]) ?? [];

  it("gives every tool built its examples, and every tool to come its slice", () => {
    for (const name of ADMIN_MCP_NATIVE_TOOLS) {
      const row = ADMIN_TOOL_EXAMPLES[name];
      if (listed.includes(name))
        expect(built(row)?.length, name).toBeGreaterThan(0);
      else expect(row, name).toHaveProperty("notBuilt");
    }
  });

  it("parses every example on its tool, and on the op it names", () => {
    for (const tool of ADMIN_MCP_TOOLS)
      for (const { args } of examplesOf(tool.name)) {
        const at = `${tool.name} ${JSON.stringify(args)}`;
        const parsed = tool.input.safeParse(args);
        expect(parsed.success ? [] : parsed.error.issues, at).toEqual([]);
        const { op, input, targets } = args as {
          op?: string;
          input?: object;
          targets?: object[];
        };
        // A name that is no op is the next test's to refuse.
        if (tool.name === ACTIONS_TOOL_NAME || !isAdminOpName(op ?? ""))
          continue;
        // As each tool reads it: admin_read the input, admin_execute each target over it.
        const entry = entryOf(op as AdminOpName);
        for (const command of (targets ?? [{}]).map((target) => ({
          ...input,
          ...target,
        }))) {
          const own = entry.input?.safeParse(command);
          expect(own?.success === false ? own.error.issues : [], at).toEqual(
            [],
          );
        }
      }
  });

  // A tool's own ops, but the catalog's, which tells of any, and a preview's, which
  // freezes a write of either execute tool.
  const PREVIEWED: ReadonlySet<string> = new Set([
    "admin_execute",
    "admin_execute_irreversible",
  ]);
  const takesOp = (tool: string, op: string) =>
    isAdminOpName(op) &&
    (tool === ACTIONS_TOOL_NAME ||
      entryOf(op).tool === tool ||
      (tool === "admin_preview" && PREVIEWED.has(entryOf(op).tool)));
  /** Every op and tool a tool's text and examples name, that a call there would miss. */
  const namingFaults = (
    tool: string,
    description: string,
    examples: readonly AdminToolExample[],
  ) => {
    const texts = [description, ...examples.map(({ says }) => says)];
    const ops = [
      ...texts.flatMap((text) =>
        [...text.matchAll(/\bop:"([^"]*)"/gu)].map(([, op]) => op!),
      ),
      ...examples.flatMap(({ args }) => {
        const { op, ops } = args as { op?: unknown; ops?: unknown[] };
        return [op, ...(ops ?? [])].filter(
          (name): name is string => typeof name === "string",
        );
      }),
    ];
    const tools = [
      ...texts.flatMap((text) =>
        [...text.matchAll(/\badmin_[a-z_]+/gu)].map(([name]) => name),
      ),
      ...(tool === ACTIONS_TOOL_NAME
        ? examples.flatMap(({ args }) =>
            typeof args.tool === "string" ? [args.tool] : [],
          )
        : []),
    ];
    return [
      ...ops.filter((op) => !takesOp(tool, op)).map((op) => `op ${op}`),
      ...tools
        .filter((name) => examplesOf(name).length === 0)
        .map((name) => `tool ${name}`),
    ];
  };

  it("names only ops its tool runs and tools that are listed, in descriptions and examples", () => {
    for (const tool of ADMIN_MCP_TOOLS)
      expect(
        namingFaults(tool.name, tool.description, examplesOf(tool.name)),
        tool.name,
      ).toEqual([]);
    // What the check is for: a slip in either place, and a tool not built yet.
    expect(
      namingFaults(
        "admin_read",
        'Read {op:"bogus"} or {op:"catalog.publish"}.',
        [{ args: { op: "list.catalog" }, says: "admin_sensitive_read first." }],
      ),
    ).toEqual([
      "op bogus",
      "op catalog.publish",
      "op list.catalog",
      "tool admin_sensitive_read",
    ]);
    expect(
      namingFaults(ACTIONS_TOOL_NAME, "", [
        {
          args: { ops: ["catalog.publish"], tool: "admin_sensitive_read" },
          says: "x",
        },
      ]),
    ).toEqual(["tool admin_sensitive_read"]);
    // A preview freezes writes of either execute tool, and never a read.
    expect(
      namingFaults("admin_preview", "", [
        { args: { op: "list.catalogs" }, says: "x" },
        { args: { op: "community.delete-body" }, says: "x" },
        { args: { op: "editorial.save-draft" }, says: "x" },
      ]),
    ).toEqual(["op list.catalogs"]);
  });

  it("gives admin_analytics a call for each report it answers", () => {
    const reports = examplesOf("admin_analytics").map(
      ({ args }) => args.report,
    );
    // traffic answers NOT_AVAILABLE until its hourly snapshot is built.
    expect(new Set(reports)).toEqual(
      new Set(ADMIN_ANALYTICS_REPORTS.filter((name) => name !== "traffic")),
    );
  });

  it("answers {tool} with that tool's examples, each within the text cap", () => {
    for (const tool of ADMIN_MCP_TOOLS) {
      const envelope = actionsEnvelope({ tool: tool.name }, listed, open);
      const { content, structuredContent } = toolResult(scope, envelope);
      expect(structuredContent.meta, tool.name).toEqual({});
      expect(
        Buffer.byteLength(content[0]!.text),
        tool.name,
      ).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
      expect(adminToolDetailSchema.parse(envelope.data), tool.name).toEqual({
        tool: tool.name,
        available: true,
        examples: examplesOf(tool.name),
      });
    }
  });

  it("says when a tool is not on this credential, and shows no example of it", () => {
    expect(toolDetail("admin_execute", ["admin_whoami", "admin_read"])).toEqual(
      {
        tool: "admin_execute",
        available: false,
        unavailable: "tool_not_listed",
      },
    );
    // A tool not built yet is on no credential.
    expect(toolDetail("admin_sensitive_read", listed)).toEqual({
      tool: "admin_sensitive_read",
      available: false,
      unavailable: "tool_not_listed",
    });
  });

  it("takes {tool} alone, and checks the name at run time while tools/list shows a string", () => {
    expect(
      actionsEnvelope(
        { tool: "admin_read", ops: ["list.media"] },
        listed,
        open,
      ),
    ).toMatchObject({
      ok: false,
      code: "INPUT_INVALID",
      issues: [{ path: ["tool"], code: "not_with_ops" }],
    });
    const actions = toolFor("read", ACTIONS_TOOL_NAME)!;
    expect(actions.input.safeParse({ tool: "admin_nothing" }).success).toBe(
      false,
    );
    const [listing] = toolListingFor("read", false).filter(
      ({ name }) => name === ACTIONS_TOOL_NAME,
    );
    expect(
      (listing!.inputSchema.properties as Record<string, unknown>).tool,
    ).toEqual({ type: "string" });
  });

  it("returns a copy, so an answer never reaches the table", () => {
    const detail = toolDetail("admin_find", listed);
    (detail.examples![0]!.args as { query: string }).query = "changed";
    expect(toolDetail("admin_find", listed).examples![0]!.args).not.toEqual({
      query: "changed",
    });
  });
});

// ---------------------------------------------------------------------------

const toolScript = (
  relative: string,
  args: readonly string[],
  input: string,
) => {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "node_modules", relative), ...args],
    { cwd: repositoryRoot, input, encoding: "utf8", timeout: 90_000 },
  );
  if (result.error) throw result.error;
  return result;
};

describe("the capability document", () => {
  it("is generated from the registry and current", async () => {
    const formatted = toolScript(
      "prettier/bin/prettier.cjs",
      ["--stdin-filepath", "docs/community/admin-mcp-capabilities.md"],
      renderAdminMcpCapabilities(),
    );
    expect(formatted.status, formatted.stderr).toBe(0);
    await expect(formatted.stdout).toMatchFileSnapshot(
      "../../../docs/community/admin-mcp-capabilities.md",
    );
  }, 90_000);

  it("names every op and every surface row", () => {
    const text = renderAdminMcpCapabilities();
    for (const name of ADMIN_OP_NAMES) expect(text).toContain(`\`${name}\``);
    for (const surface of Object.keys(ADMIN_SURFACES))
      expect(text).toContain(surface);
  });
});

describe("the Owner's transport is closed under admin-mcp", () => {
  const lint = (
    code: string,
    file = "apps/admin/src/admin-mcp/ops/fixture.ts",
  ) => {
    const result = toolScript(
      "eslint/bin/eslint.js",
      ["--stdin", "--stdin-filename", file, "--format", "json"],
      code,
    );
    const [report] = JSON.parse(result.stdout) as {
      messages: { ruleId: string | null; message: string }[];
    }[];
    return report!.messages.filter(
      ({ ruleId }) => ruleId === "no-restricted-imports",
    );
  };

  it.each([
    ['import { callCommunityOperator } from "../../community/backend";'],
    ['import { openCommunityOperatorMedia } from "../../community/backend";'],
    [
      'import { openCommunityOperatorEvidence } from "../../community/backend";',
    ],
    ['import { openCatalogOperatorThumbnail } from "../../community/backend";'],
    ['import { openCommunityOperatorMedia } from "../../community/endpoints";'],
    [
      'import { openCommunityOperatorEvidence } from "../../community/endpoints";',
    ],
    ['import { createCommunityEndpoints } from "../../community/endpoints";'],
    ['import { communityEndpoints } from "../../community/endpoints";'],
    ['export { callCommunityOperator } from "../../community/backend";'],
  ])(
    "refuses %s",
    (code) => {
      expect(lint(code)).toHaveLength(1);
    },
    90_000,
  );

  it("allows the definitions, which take their transport as a parameter", () => {
    expect(
      lint(
        'import { communityOperationDefinitions } from "../../community/endpoints";\nimport { catalogRenderBacklog } from "../../editorial/catalog-delivery-backend";\nimport { openCatalogAiThumbnail } from "../../community/backend";\n',
      ),
    ).toEqual([]);
  }, 90_000);

  it("still applies the Admin's own import rules in that directory", () => {
    expect(lint('import pg from "pg";')).toHaveLength(1);
  }, 90_000);

  it("leaves the same import alone outside that directory", () => {
    expect(
      lint(
        'import { callCommunityOperator } from "../community/backend";',
        "apps/admin/src/analytics/fixture.ts",
      ),
    ).toEqual([]);
  }, 90_000);
});
