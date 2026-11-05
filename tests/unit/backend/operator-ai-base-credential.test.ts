import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CommunityNotFoundError } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
import {
  AI_OPERATOR_ROUTES,
  aiOperatorRouteFor,
} from "@moya/contracts/internal/admin-mcp";
import { operatorLabelSchema } from "@moya/contracts/internal/community-operator";
import {
  aiOperatorRefusal,
  resolveOperatorActor,
} from "@moya/backend-runtime/internal/community-operator";
import { MappedStorageUrlResolver } from "@moya/image";
import { parseEnv } from "node:util";
import {
  aiCredentialConfigured,
  openCatalogAiThumbnail,
  openCatalogOperatorThumbnail,
} from "admin/community-backend";
import {
  communityOperationDefinitions,
  CommunityOperatorError,
} from "admin/community-endpoints";
import type { PayloadRequest } from "payload";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const baseToken = syntheticToken();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const source = {
  mediaId: "synthetic-thumb",
  objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.jpg`,
  sourceSha256: "c".repeat(64),
};
const thumbnailPath = `catalog-delivery/thumbnail?${new URLSearchParams(source)}`;
const thumbnailBytes = new Uint8Array([1, 2, 3]);

const servers = new Set<Server>();
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

const startBackend = async (
  options: Partial<BackendApplicationOptions> = {},
) => {
  const catalogThumbnail = vi.fn(async () => ({
    bytes: thumbnailBytes,
    mimeType: "image/webp" as const,
  }));
  let requests = 0;
  const application = createBackendApplication({
    nodeEnv: "development",
    communityIdentityPort: new InMemoryCommunityIdentityPort(),
    storageUrlResolver: new MappedStorageUrlResolver(new Map()),
    communityCommentPort: new InMemoryCommunityCommentPort(),
    communityOperatorCredential: ownerToken,
    operatorAiBaseCredential: baseToken,
    catalogThumbnail,
    ...options,
  });
  const server = createBackendServer((request, response) => {
    requests += 1;
    return application(request, response);
  });
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    catalogThumbnail,
    requests: () => requests,
    send: async (
      method: string,
      route: string,
      headers: Record<string, string>,
    ) => {
      const response = await fetch(`${origin}/internal/community/${route}`, {
        method,
        headers: {
          ...headers,
          ...(method === "POST" || method === "PUT"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
      });
      const text = await response.text();
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      return { status: response.status, code };
    },
  };
};

/** What each Owner operation really calls, so a new operation is covered by itself. */
const definitionRoutes = async (): Promise<(readonly [string, string])[]> => {
  const routes: (readonly [string, string])[] = [];
  const parsed = {
    id: "synthetic",
    accountId: "synthetic",
    action: "synthetic",
    range: "7d",
    ids: ["synthetic"],
    reason: "synthetic",
  };
  // The one operation that answers from the Local API.
  const req = {
    payload: { find: async () => ({ docs: [] }) },
  } as unknown as PayloadRequest;
  for (const [name, definition] of Object.entries(
    communityOperationDefinitions,
  )) {
    const before = routes.length;
    await definition.run(
      parsed,
      (async (method: string, route: string) => {
        routes.push([method, route.split("?")[0]!]);
        return {};
      }) as never,
      req,
    );
    if (name !== "read-feature-catalogs")
      expect(routes.length, name).toBeGreaterThan(before);
  }
  return routes;
};

const id = "synthetic";
/** Everything the operations above do not name, binary routes included. */
const otherCommunityRoutes: readonly (readonly [string, string])[] = [
  // Catalog delivery the Owner's token keeps: metadata and readiness.
  ["POST", "catalog-delivery/readiness"],
  ["POST", "catalog-delivery/published-renditions"],
  ["GET", "catalog-delivery/render-backlog"],
  ["GET", "catalog-delivery/recipe-policy"],
  // Binary relays.
  ["GET", `reports/${id}/evidence/${id}`],
  ["GET", `publishing/media/${id}/${id}/display/${id}`],
  ["GET", `articles/${id}/submission-media`],
  ["GET", `feedback/${id}/images/${id}/thumb`],
  ["GET", `comments/${id}/images/${id}/thumb`],
  ["HEAD", `comments/${id}/images/${id}/thumb`],
  ["GET", `comments/${id}/analysis`],
  ["GET", "analytics/status"],
  // The agent boundary, delegations and principals.
  ["GET", "agent/users"],
  ["GET", "agent/content"],
  ["GET", "agent/comments"],
  ["POST", "agent/operations/prepare-comments"],
  ["POST", `agent/operations/${id}/execute`],
  ["GET", "agent/principals"],
  ["PUT", "agent/principals"],
  ["POST", "agent/principals/revoke"],
  ["GET", "agent/delegations"],
  ["POST", "agent/delegations"],
  // AI routes of the community credential.
  ["GET", "ai/find"],
  ["GET", "ai/settlement"],
  ["GET", "ai/settlement?type=work"],
  ["GET", "ai/settlement?type=article"],
  ["GET", "ai/settlement?type=user"],
  ["GET", "ai/settlement?type=ITEM"],
  ["GET", "ai/settlement?type=item&type=work"],
  ["POST", "ai/settlement?type=item"],
  // Unlisted methods and names on the base routes' own paths.
  ["POST", "catalog-delivery/thumbnail"],
  ["HEAD", "catalog-delivery/thumbnail"],
  ["GET", "catalog-delivery/thumbnail/"],
  ["GET", "ai/catalog-master"],
  ["GET", "ai/catalog-master/attach"],
  ["POST", "ai/catalog-master/status"],
  ["GET", "ai/catalog-master/unlisted"],
  ["GET", "ai/catalog-master/status/extra"],
  ["GET", "unlisted"],
];

describe("OPERATOR_AI_BASE_TOKEN route table", () => {
  it("names exactly the base routes of the credential map, each on the base credential", () => {
    expect(
      AI_OPERATOR_ROUTES.filter(({ credentials }) =>
        credentials.includes("base"),
      ).map(({ method, path: route, klass, credentials, query }) => [
        method,
        route,
        klass,
        credentials,
        query,
      ]),
    ).toEqual(
      (
        [
          ["GET", "community/catalog-delivery/thumbnail", "read"],
          ["GET", "community/ai/settlement", "read", { type: "item" }],
          ["GET", "community/ai/catalog-master/candidates", "read"],
          ["GET", "community/ai/catalog-master/status", "read"],
          ["GET", "community/ai/catalog-master/guard", "read"],
          ["POST", "community/ai/catalog-master/attach", "write"],
          ["POST", "community/ai/catalog-master/attach-existing", "write"],
          ["POST", "community/ai/catalog-master/requeue", "write"],
          ["POST", "community/ai/catalog-master/set-limit", "write"],
          ["POST", "community/ai/catalog-master/detach", "write"],
          ["POST", "community/ai/catalog-master/erase", "irreversible"],
          ...[
            "status",
            "overview",
            "trend",
            "breakdown",
            "compare",
            "funnel",
            "realtime",
            "sessions",
            "session",
            "product",
            "native",
            "reconcile",
            "export",
            "traffic",
          ].map((report) => ["GET", `analytics/insights/${report}`, "read"]),
          ["POST", "analytics/insights/prune", "irreversible"],
          ["GET", "community/analytics/ips", "sensitive:raw_ip"],
        ] as const
      ).map(([method, route, klass, query]) => [
        method,
        `/internal/${route}`,
        klass,
        // Settlement of a job's own subject is the one row the two credentials share.
        route === "community/ai/settlement" ? ["base", "community"] : ["base"],
        query,
      ]),
    );
  });

  it("matches a path exactly, and each query parameter once", () => {
    const none = new URLSearchParams();
    const insights = "/internal/analytics/insights";
    expect(aiOperatorRouteFor("GET", `${insights}/sessions`, none)?.klass).toBe(
      "read",
    );
    for (const pathname of [
      insights,
      `${insights}/`,
      `${insights}//sessions`,
      `${insights}/sessions/`,
      `${insights}/session/abc-1`,
      `${insights}/future`,
      `${insights}/%2e%2e/ips`,
      `${insights}/../ips`,
    ])
      expect(aiOperatorRouteFor("GET", pathname, none), pathname).toBe(
        undefined,
      );
    const settlement = "/internal/community/ai/settlement";
    expect(
      aiOperatorRouteFor("GET", settlement, new URLSearchParams("type=item")),
    ).toBeDefined();
    expect(aiOperatorRouteFor("GET", settlement, none)).toBeUndefined();
    expect(
      aiOperatorRouteFor(
        "GET",
        settlement,
        new URLSearchParams("type=item&type=item"),
      ),
    ).toBeUndefined();
  });
});

describe("resolveOperatorActor", () => {
  const presenting = (token?: string) =>
    ({
      headers: token === undefined ? {} : bearer(token),
    }) as IncomingMessage;

  it("tells the Owner from an AI credential and labels the AI credential ai-admin", () => {
    expect(
      resolveOperatorActor(presenting(ownerToken), ownerToken, {
        base: baseToken,
      }),
    ).toEqual({ label: "owner" });
    const actor = resolveOperatorActor(presenting(baseToken), ownerToken, {
      base: baseToken,
    });
    expect(actor).toEqual({ label: "ai-admin", credential: "base" });
    expect(operatorLabelSchema.parse(actor?.label)).toBe("ai-admin");
  });

  it("accepts nothing else, and no AI credential that is not configured", () => {
    for (const aiCredentials of [
      undefined,
      {},
      { base: "" },
      { base: syntheticToken() },
    ]) {
      expect(
        resolveOperatorActor(presenting(baseToken), ownerToken, aiCredentials),
      ).toBeNull();
      expect(
        resolveOperatorActor(presenting(), ownerToken, aiCredentials),
      ).toBeNull();
    }
    expect(
      resolveOperatorActor(
        { headers: { authorization: "Bearer " } } as IncomingMessage,
        ownerToken,
        { base: "" },
      ),
    ).toBeNull();
  });
});

describe("the base token on the Backend", () => {
  it("is refused on every community route, where the Owner's token still reaches the handler", async () => {
    const backend = await startBackend();
    const routes = [...(await definitionRoutes()), ...otherCommunityRoutes];
    expect(routes.length).toBeGreaterThan(70);
    for (const [method, route] of routes) {
      const label = `${method} ${route}`;
      const refused = await backend.send(method, route, bearer(baseToken));
      expect(refused.status, label).toBe(403);
      if (method !== "HEAD")
        expect(refused.code, label).toBe("AI_ROUTE_FORBIDDEN");
      const owner = await backend.send(method, route, bearer(ownerToken));
      expect(owner.status, label).not.toBe(401);
      expect(owner.code ?? "", label).not.toMatch(/^AI_/u);
    }
    expect(backend.catalogThumbnail).not.toHaveBeenCalled();
  }, 60_000);

  it("is not a credential at all when the Backend does not hold it", async () => {
    const backend = await startBackend({ operatorAiBaseCredential: "" });
    expect(await backend.send("GET", thumbnailPath, bearer(baseToken))).toEqual(
      { status: 401, code: "OPERATOR_UNAUTHORIZED" },
    );
    expect(backend.catalogThumbnail).not.toHaveBeenCalled();
    expect(
      (await backend.send("GET", thumbnailPath, bearer(ownerToken))).status,
    ).toBe(200);
  });

  it("passes the table's rows, and an irreversible row only with the run header", async () => {
    const backend = await startBackend();
    const master = "ai/catalog-master";
    // Past the table with no reader to ask: refused for that, and not by the table.
    expect(
      await backend.send(
        "GET",
        "ai/settlement?type=item&id=x&intent=withdraw",
        bearer(baseToken),
      ),
    ).toEqual({ status: 503, code: "OPERATOR_UNAVAILABLE" });
    // No handler yet behind these: past the table they are ordinary unknown routes.
    for (const [method, route] of [
      ["GET", `${master}/status`],
      ["POST", `${master}/attach`],
      ["POST", `${master}/detach`],
    ] as const)
      expect(
        await backend.send(method, route, bearer(baseToken)),
        route,
      ).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(
      await backend.send("POST", `${master}/erase`, bearer(baseToken)),
    ).toEqual({ status: 403, code: "AI_RUN_REQUIRED" });
    expect(
      await backend.send("POST", `${master}/erase`, {
        ...bearer(baseToken),
        "x-admin-mcp-run": "synthetic",
      }),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("refuses the analytics rows the same way when the analytics handler asks", () => {
    const asking = (
      method: string,
      url: string,
      headers: Record<string, string> = {},
    ) => ({ method, url, headers }) as unknown as IncomingMessage;
    const refusal = (request: IncomingMessage) =>
      aiOperatorRefusal(
        request,
        new URL(request.url!, "http://request.invalid").pathname,
        "base",
      );
    const insights = "/internal/analytics/insights";
    expect(refusal(asking("GET", `${insights}/sessions`))).toBeNull();
    expect(refusal(asking("GET", `${insights}/prune`))).toBe(
      "AI_ROUTE_FORBIDDEN",
    );
    expect(refusal(asking("POST", `${insights}/prune`))).toBe(
      "AI_RUN_REQUIRED",
    );
    expect(
      refusal(
        asking("POST", `${insights}/prune`, { "x-admin-mcp-run": "synthetic" }),
      ),
    ).toBeNull();
    expect(refusal(asking("GET", "/internal/community/analytics/ips"))).toBe(
      "SENSITIVE_SWITCH_OFF",
    );
    expect(refusal(asking("GET", "/internal/community/analytics/status"))).toBe(
      "AI_ROUTE_FORBIDDEN",
    );
    expect(
      aiOperatorRefusal(
        asking("GET", "/internal/community/catalog-delivery/thumbnail"),
        "/internal/community/catalog-delivery/thumbnail",
        "community",
      ),
    ).toBe("AI_ROUTE_FORBIDDEN");
  });
});

describe("the analytics routes behind the table", () => {
  it("refuse the base token by name, so raw IP records stay out of reach", async () => {
    const port = {
      status: vi.fn(async () => ({
        last24Hours: { events: 0, visitors: 0, users: 0, sessions: 0 },
        outbox: { pending: 0, failed: 0 },
        lastEventAt: null,
        lastForwardedAt: null,
      })),
      recentIps: vi.fn(async () => ({ items: [] })),
    };
    const backend = await startBackend({
      analytics: {
        port: port as never,
        policy: {
          enabled: false,
          production: false,
          excludedUserIds: new Set(),
          ownerExclusionConfigured: false,
          hmacKey: "",
          forwardingConfigured: false,
          eventRetentionDays: 180,
        },
      },
    });
    for (const [route, code] of [
      ["analytics/status", "AI_ROUTE_FORBIDDEN"],
      ["analytics/ips", "SENSITIVE_SWITCH_OFF"],
    ] as const) {
      expect(
        await backend.send("GET", route, bearer(baseToken)),
        route,
      ).toEqual({ status: 403, code });
      expect(
        (await backend.send("GET", route, bearer(ownerToken))).status,
        route,
      ).toBe(200);
      expect(
        (await backend.send("GET", route, bearer(syntheticToken()))).status,
        route,
      ).toBe(401);
    }
    expect(port.status).toHaveBeenCalledTimes(1);
    expect(port.recentIps).toHaveBeenCalledTimes(1);
  });
});

describe("the AI thumbnail opener", () => {
  const stubAdmin = (origin: string, tokens: Record<string, string>) => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", origin);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
    for (const [name, value] of Object.entries(tokens)) vi.stubEnv(name, value);
  };
  const failure = async (open: Promise<unknown>) => {
    const error = await open.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CommunityOperatorError);
    const { code, status } = error as CommunityOperatorError;
    return { code, status };
  };

  it("relays catalog_thumb on the base token with the community and Owner tokens absent", async () => {
    const backend = await startBackend();
    stubAdmin(backend.origin, { OPERATOR_AI_BASE_TOKEN: baseToken });
    const media = await openCatalogAiThumbnail(thumbnailPath, null);
    expect(media.contentType).toBe("image/webp");
    expect(
      new Uint8Array(await new Response(media.body).arrayBuffer()),
    ).toEqual(thumbnailBytes);
    expect(backend.catalogThumbnail).toHaveBeenCalledWith(source);
    expect(aiCredentialConfigured("base")).toBe(true);
    expect(aiCredentialConfigured("community")).toBe(false);
  });

  it("answers AI_CREDENTIAL_NOT_CONFIGURED without the base token, whatever else is held, and calls nothing", async () => {
    const backend = await startBackend();
    stubAdmin(backend.origin, {
      COMMUNITY_OPERATOR_TOKEN: ownerToken,
      COMMUNITY_OPERATOR_AI_TOKEN: syntheticToken(),
    });
    expect(await failure(openCatalogAiThumbnail(thumbnailPath, null))).toEqual({
      code: "AI_CREDENTIAL_NOT_CONFIGURED",
      status: 503,
    });
    expect(backend.requests()).toBe(0);
    expect(aiCredentialConfigured("base")).toBe(false);
  });

  it("keeps the Backend's status and bare code", async () => {
    const backend = await startBackend();
    stubAdmin(backend.origin, { OPERATOR_AI_BASE_TOKEN: baseToken });
    backend.catalogThumbnail.mockRejectedValueOnce(
      new CommunityNotFoundError(),
    );
    expect(await failure(openCatalogAiThumbnail(thumbnailPath, null))).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(
      await failure(openCatalogAiThumbnail("reports/synthetic", null)),
    ).toEqual({ code: "AI_ROUTE_FORBIDDEN", status: 403 });
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", syntheticToken());
    expect(await failure(openCatalogAiThumbnail(thumbnailPath, null))).toEqual({
      code: "OPERATOR_UNAUTHORIZED",
      status: 401,
    });
    const unconfigured = await startBackend({
      catalogThumbnail: undefined as never,
    });
    stubAdmin(unconfigured.origin, { OPERATOR_AI_BASE_TOKEN: baseToken });
    expect(await failure(openCatalogAiThumbnail(thumbnailPath, null))).toEqual({
      code: "CATALOG_DELIVERY_NOT_CONFIGURED",
      status: 503,
    });
  });

  it("cuts off a refusal whose body stalls, rather than waiting on it", async () => {
    let answered = () => {};
    const reached = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.write('{"error":');
      answered();
    });
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    stubAdmin(`http://127.0.0.1:${address.port}`, {
      OPERATOR_AI_BASE_TOKEN: baseToken,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = failure(openCatalogAiThumbnail(thumbnailPath, null));
    await reached;
    await sleep(200);
    await vi.advanceTimersByTimeAsync(15_000);
    // Only the stall timer can end it: the connection stays open until afterwards.
    const settled = await Promise.race([
      outcome,
      sleep(2_000).then(() => "still waiting"),
    ]);
    server.closeAllConnections();
    expect(settled).toEqual({ code: "OPERATION_FAILED", status: 500 });
  });

  it("leaves the Owner's relay on the Owner's token, with its narrowed codes", async () => {
    const backend = await startBackend({
      catalogThumbnail: undefined as never,
    });
    stubAdmin(backend.origin, { OPERATOR_AI_BASE_TOKEN: baseToken });
    expect(
      await failure(openCatalogOperatorThumbnail(thumbnailPath, null)),
    ).toEqual({ code: "OPERATOR_NOT_CONFIGURED", status: 503 });
    expect(backend.requests()).toBe(0);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    expect(
      await failure(openCatalogOperatorThumbnail(thumbnailPath, null)),
    ).toEqual({ code: "OPERATOR_UNAVAILABLE", status: 503 });
    expect(
      await failure(openCatalogOperatorThumbnail("agent/users", null)),
    ).toEqual({ code: "NOT_FOUND", status: 404 });
  });
});

describe("the base token's templates", () => {
  const template = async (name: string) => {
    const text = await readFile(path.join(repositoryRoot, name), "utf8");
    return { text, values: parseEnv(text) };
  };

  it.each([
    "infra/production/env/backend.env.example",
    "infra/production/env/admin.env.example",
  ])(
    "%s documents it without placing it, since it follows the policy text",
    async (name) => {
      const { text, values } = await template(name);
      expect(values.OPERATOR_AI_BASE_TOKEN).toBeUndefined();
      expect(text).toContain(
        "# OPERATOR_AI_BASE_TOKEN=REPLACE_ME_OPERATOR_AI_BASE_TOKEN",
      );
    },
  );

  it("gives local development its own synthetic value, passed through to both processes", async () => {
    const { values } = await template("infra/env/local.env.example");
    expect(values.OPERATOR_AI_BASE_TOKEN).toMatch(/^synthetic-/u);
    expect(values.OPERATOR_AI_BASE_TOKEN).not.toBe(
      values.COMMUNITY_OPERATOR_TOKEN,
    );
    const turbo = JSON.parse(
      await readFile(path.join(repositoryRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, { passThroughEnv?: string[] }> };
    for (const task of ["admin#dev", "@moya/backend-production#dev"])
      expect(turbo.tasks[task]?.passThroughEnv, task).toContain(
        "OPERATOR_AI_BASE_TOKEN",
      );
  });
});
