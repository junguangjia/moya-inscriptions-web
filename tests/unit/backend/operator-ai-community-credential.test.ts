import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";

import {
  AI_OPERATOR_ROUTES,
  aiOperatorRouteFor,
  aiOperatorRouteId,
} from "@moya/contracts/internal/admin-mcp";
import type { AiOperatorReader } from "@moya/contracts/internal/admin-mcp";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
import {
  callAiOperator,
  openCommunityAiEvidence,
  openCommunityAiMedia,
} from "admin/community-backend";
import { CommunityOperatorError } from "admin/community-endpoints";
import { PostgresAiOperatorReader } from "@moya/community-postgres";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const baseToken = syntheticToken();
const communityToken = syntheticToken();

const id = `report-${"a".repeat(32)}`;
const comment = `comment-${"a".repeat(32)}`;
const item = `media-item-${"a".repeat(32)}`;

const servers = new Set<Server>();
afterEach(async () => {
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
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      operatorAiCommunityCredential: communityToken,
      ...options,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    send: async (method: string, route: string, token: string) => {
      const response = await fetch(`${origin}/internal/community/${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
        },
        ...(method === "GET" ? {} : { body: "{}" }),
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

const reader = (selfOnly: boolean): AiOperatorReader => ({
  find: vi.fn(async () => ({
    items: [],
    sources: {},
    excluded: ["self_only"],
  })),
  count: vi.fn(async () => ({ total: 0, oldestAt: null })),
  settlement: vi.fn(async () => ({ open: 0, failed: 0, failedJobs: [] })),
  isSelfOnly: vi.fn(async () => selfOnly),
});

describe("the route table's community rows", () => {
  it("are all on the community credential, and on no other row's", () => {
    const community = AI_OPERATOR_ROUTES.filter(({ credentials }) =>
      credentials.includes("community"),
    );
    expect(community.length).toBeGreaterThan(25);
    const shared = ({ path, query }: (typeof community)[number]) =>
      path.endsWith("/ai/settlement") && query?.type === "item";
    for (const row of community) {
      expect(row.credentials, row.path).toEqual(
        shared(row) ? ["base", "community"] : ["community"],
      );
      expect(row.path.startsWith("/internal/community/"), row.path).toBe(true);
    }
    expect(
      AI_OPERATOR_ROUTES.filter(({ credentials }) =>
        credentials.includes("base"),
      ).filter(({ credentials }) => credentials.includes("community")),
    ).toHaveLength(1);
  });

  it("holds each reversible write once, and no irreversible one until the run engine", () => {
    const writes = AI_OPERATOR_ROUTES.filter(
      ({ credentials, klass, method }) =>
        credentials.includes("community") &&
        !klass.startsWith("sensitive:") &&
        (klass !== "read" || method !== "GET"),
    );
    expect(
      writes.map(({ method, path, klass, selfOnly }) => [
        method,
        path.slice("/internal/community/".length),
        klass,
        selfOnly,
      ]),
    ).toEqual([
      ["POST", "reports/:id/decisions", "write", "report"],
      ["POST", "reports/:id/review", "write", "report"],
      ["POST", "reports/:id/metadata", "write", "report"],
      ["POST", "comments/:id/moderation", "write", "comment"],
      ["POST", "users/:id/status", "write", undefined],
      ["PUT", "users/recommendation", "write", undefined],
      ["POST", "works/:id/moderation", "write", "work"],
      ["PUT", "featured", "write", undefined],
      ["PUT", "featured/settings", "write", undefined],
      ["PUT", "publication-policy", "write", undefined],
      ["POST", "threads", "write", undefined],
      ["POST", "threads/:id", "write", undefined],
      ["PUT", "publishing/settings", "write", undefined],
      [
        "POST",
        "publishing/submissions/:id/moderation",
        "write",
        "work_revision",
      ],
      ["PUT", "publishing/accounts/:id/capacity", "write", undefined],
      ["POST", "publishing/jobs/:id/retry", "write", undefined],
      ["POST", "articles/:id/moderation", "write", "article"],
    ]);
  });

  it("matches a :name on a whole non-empty segment only", () => {
    const none = new URLSearchParams();
    const reports = "/internal/community/reports";
    expect(aiOperatorRouteFor("GET", `${reports}/${id}`, none)?.path).toBe(
      `${reports}/:id`,
    );
    for (const pathname of [
      `${reports}/`,
      `${reports}/${id}/`,
      `${reports}/${id}/decisions`,
      `${reports}/${id}/evidence`,
      `${reports}/${id}/evidence/x/y`,
      `${reports}//evidence/x`,
    ])
      expect(
        aiOperatorRouteFor("GET", pathname, none),
        pathname,
      ).toBeUndefined();
  });

  it("names the record a route's :id holds", () => {
    const route = aiOperatorRouteFor(
      "GET",
      `/internal/community/comments/${comment}/images/${item}/thumb`,
      new URLSearchParams(),
    )!;
    expect(route.selfOnly).toBe("comment");
    expect(
      aiOperatorRouteId(
        route,
        `/internal/community/comments/${comment}/images/${item}/thumb`,
      ),
    ).toBe(comment);
  });

  it("names a self-only check on every route that can open an item's bytes", () => {
    const bytes = AI_OPERATOR_ROUTES.filter(
      ({ path, klass }) =>
        klass === "read" &&
        /\/(?:media|submission-media|images)\b/u.test(path) &&
        !path.startsWith("/internal/community/feedback/"),
    );
    expect(bytes.map(({ path, selfOnly }) => [path, selfOnly])).toEqual([
      ["/internal/community/comments/:id/images/:itemId/:variant", "comment"],
      [
        "/internal/community/publishing/media/:id/:itemId/:variant/:editKey",
        "work_revision",
      ],
      ["/internal/community/articles/:id/submission-media", "article"],
    ]);
  });
});

describe("the two AI credentials", () => {
  const reads = [
    "reports",
    `reports/${id}`,
    "works",
    "users",
    "comments",
    "ai/find?text=a",
    "ai/count?source=reports",
    "publishing/jobs",
    "feedback",
    "threads",
  ];

  it("keeps the base token off every community route", async () => {
    const backend = await startBackend({ aiOperatorReader: reader(false) });
    for (const route of [
      ...reads,
      `reports/${id}/evidence/${id}`,
      `comments/${comment}/images/${item}/thumb`,
    ])
      expect(await backend.send("GET", route, baseToken), route).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
    for (const route of ["messages/conversation", "messages/lookup"])
      expect(await backend.send("POST", route, baseToken), route).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
  });

  it("keeps the community token off the base routes", async () => {
    const backend = await startBackend();
    for (const route of [
      "catalog-delivery/thumbnail",
      "ai/catalog-master/status",
    ])
      expect(await backend.send("GET", route, communityToken), route).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
  });

  it("settles a job's own subject on either token, and a record on the community's alone", async () => {
    const known = reader(false);
    const backend = await startBackend({ aiOperatorReader: known });
    const route = (type: string) =>
      `ai/settlement?type=${type}&id=${id}&intent=withdraw`;
    for (const token of [baseToken, communityToken])
      expect((await backend.send("GET", route("item"), token)).status).toBe(
        200,
      );
    for (const type of ["work", "article", "user"]) {
      expect(await backend.send("GET", route(type), baseToken), type).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
      expect(
        (await backend.send("GET", route(type), communityToken)).status,
        type,
      ).toBe(200);
    }
    expect(known.settlement).toHaveBeenCalledTimes(5);
    // No credential of the Owner's reaches it: this is the AI's own read.
    expect((await backend.send("GET", route("item"), ownerToken)).status).toBe(
      404,
    );
    expect(known.settlement).toHaveBeenCalledTimes(5);
  });

  it("names what it cannot answer, and never reads it as settled", async () => {
    const known = reader(false);
    const backend = await startBackend({ aiOperatorReader: known });
    const route = `ai/settlement?type=work&id=${id}&intent=withdraw`;
    for (const [answer, status, code] of [
      ["not_found", 404, "NOT_FOUND"],
      ["self_only", 403, "SELF_ONLY_OWNER_REVIEW"],
      ["timed_out", 503, "READ_TIMED_OUT"],
    ] as const) {
      vi.mocked(known.settlement).mockResolvedValueOnce(answer);
      expect(await backend.send("GET", route, communityToken), answer).toEqual({
        status,
        code,
      });
    }
    for (const bad of [
      `ai/settlement?type=work&id=${id}`,
      `ai/settlement?type=work&id=${id}&intent=erase`,
      `ai/settlement?type=work&id=${id}&intent=withdraw&extra=1`,
      "ai/settlement?type=work&intent=withdraw",
    ])
      expect(await backend.send("GET", bad, communityToken), bad).toEqual({
        status: 400,
        code: "INVALID_QUERY",
      });
    expect(known.settlement).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["GET", "agent/users"],
    ["GET", "agent/content"],
    ["GET", "agent/principals"],
    ["POST", "agent/operations/prepare-comments"],
    ["GET", `comments/${comment}/analysis`],
    ["GET", "catalog-delivery/render-backlog"],
    ["POST", "comments/moderation"],
    ["POST", `reports/${id}/forward`],
    ["POST", `comments/${comment}/delete-body`],
    ["POST", `comments/${comment}/remove-thread`],
    ["POST", `publishing/jobs/publishing-job-${"a".repeat(32)}/abandon`],
    ["PUT", "featured/order"],
    ["GET", "unlisted"],
  ])("refuses both on %s %s", async (method, route) => {
    const backend = await startBackend({ aiOperatorReader: reader(false) });
    for (const token of [baseToken, communityToken])
      expect(await backend.send(method, route, token)).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
  });

  it("answers the switch by name on messages and evidence, for the community token", async () => {
    const backend = await startBackend();
    expect(
      await backend.send("GET", `reports/${id}/evidence/${id}`, communityToken),
    ).toEqual({ status: 403, code: "SENSITIVE_SWITCH_OFF" });
    for (const route of [
      "messages/conversation",
      "messages/lookup",
      `messages/dmsg-${"a".repeat(32)}/remove`,
    ])
      expect(await backend.send("POST", route, communityToken), route).toEqual({
        status: 403,
        code: "SENSITIVE_SWITCH_OFF",
      });
  });

  it("is no credential at all when the Backend does not hold it", async () => {
    const backend = await startBackend({ operatorAiCommunityCredential: "" });
    expect(await backend.send("GET", "reports", communityToken)).toEqual({
      status: 401,
      code: "OPERATOR_UNAUTHORIZED",
    });
    expect((await backend.send("GET", "reports", ownerToken)).status).not.toBe(
      401,
    );
  });

  it("gives the Owner's token no AI read and no AI refusal", async () => {
    const answers = reader(true);
    const backend = await startBackend({ aiOperatorReader: answers });
    expect(await backend.send("GET", "ai/find?text=a", ownerToken)).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    await backend.send("GET", `comments/${comment}`, ownerToken);
    expect(answers.find).not.toHaveBeenCalled();
    expect(answers.isSelfOnly).not.toHaveBeenCalled();
  });

  it("keeps the base token off every community write", async () => {
    const backend = await startBackend({ aiOperatorReader: reader(false) });
    for (const [method, route] of [
      ["POST", `reports/${id}/decisions`],
      ["POST", `comments/${comment}/moderation`],
      ["PUT", "publication-policy"],
      ["PUT", "featured"],
    ] as const)
      expect(await backend.send(method, route, baseToken), route).toEqual({
        status: 403,
        code: "AI_ROUTE_FORBIDDEN",
      });
  });

  it("fails closed when a self-only check on a write has nothing to ask", async () => {
    const backend = await startBackend();
    for (const [method, route] of [
      ["POST", `reports/${id}/decisions`],
      ["POST", `comments/${comment}/moderation`],
      ["POST", `works/work-${"a".repeat(32)}/moderation`],
    ] as const)
      expect(await backend.send(method, route, communityToken), route).toEqual({
        status: 503,
        code: "OPERATOR_UNAVAILABLE",
      });
  });

  it("asks the self-only question of a write's own record before anything runs", async () => {
    const answers = reader(true);
    const backend = await startBackend({ aiOperatorReader: answers });
    for (const [method, route, subject, record] of [
      ["POST", `reports/${id}/decisions`, "report", id],
      ["POST", `reports/${id}/review`, "report", id],
      ["POST", `reports/${id}/metadata`, "report", id],
      ["POST", `comments/${comment}/moderation`, "comment", comment],
      [
        "POST",
        `works/work-${"a".repeat(32)}/moderation`,
        "work",
        `work-${"a".repeat(32)}`,
      ],
    ] as const) {
      expect(await backend.send(method, route, communityToken), route).toEqual({
        status: 403,
        code: "SELF_ONLY_OWNER_REVIEW",
      });
      expect(answers.isSelfOnly).toHaveBeenLastCalledWith(subject, record);
    }
  });

  it("asks it of the Owner's token never, on a write either", async () => {
    const answers = reader(true);
    const backend = await startBackend({ aiOperatorReader: answers });
    await backend.send("POST", `comments/${comment}/moderation`, ownerToken);
    await backend.send("POST", `reports/${id}/decisions`, ownerToken);
    expect(answers.isSelfOnly).not.toHaveBeenCalled();
  });

  it("fails closed when a self-only check has nothing to ask", async () => {
    const backend = await startBackend();
    expect(
      await backend.send("GET", `comments/${comment}`, communityToken),
    ).toEqual({ status: 503, code: "OPERATOR_UNAVAILABLE" });
    expect(await backend.send("GET", "ai/find?text=a", communityToken)).toEqual(
      { status: 503, code: "OPERATOR_UNAVAILABLE" },
    );
  });

  it("names the refusal on a route whose record is self-only", async () => {
    const answers = reader(true);
    const backend = await startBackend({ aiOperatorReader: answers });
    expect(
      await backend.send(
        "GET",
        `comments/${comment}/images/${item}/thumb`,
        communityToken,
      ),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
    expect(answers.isSelfOnly).toHaveBeenCalledWith("comment", comment);
  });
});

describe("ai/find's time", () => {
  it("names the branches it never started, within Admin's call", async () => {
    const started = Date.now();
    const pool = {
      connect: vi.fn(async () => {
        // A pool this slow costs each branch its wait, whatever the statement does.
        vi.spyOn(Date, "now").mockReturnValue(started + 13_000);
        throw new Error("Synthetic pool wait");
      }),
    };
    const answer = await new PostgresAiOperatorReader(pool as never).find({
      text: "synthetic",
      limit: 26,
    });
    vi.restoreAllMocks();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(answer.sources).toEqual({
      users: "failed",
      works: "timed_out",
      comments: "timed_out",
      threads: "timed_out",
      reports: "timed_out",
    });
    expect(answer.items).toEqual([]);
    expect(answer.excluded).toEqual(["self_only"]);
  });
});

describe("the Admin's AI transports", () => {
  const stubbed = (origin: string, withCommunity = true) => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", origin);
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    vi.stubEnv(
      "COMMUNITY_OPERATOR_AI_TOKEN",
      withCommunity ? communityToken : "",
    );
  };
  const refused = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CommunityOperatorError);
    return {
      code: (error as CommunityOperatorError).code,
      status: (error as CommunityOperatorError).status,
    };
  };

  it("has the evidence opener answer 403 at the Backend, with no sensitive env", async () => {
    vi.stubEnv("COMMUNITY_OPERATOR_AI_SENSITIVE", "");
    const backend = await startBackend();
    stubbed(backend.origin);
    expect(
      await refused(
        openCommunityAiEvidence(
          `reports/${id}/evidence/${id}`,
          null,
          undefined,
        ),
      ),
    ).toEqual({ code: "SENSITIVE_SWITCH_OFF", status: 403 });
  });

  it("never falls back to the Owner's token", async () => {
    const backend = await startBackend();
    stubbed(backend.origin, false);
    for (const attempt of [
      callAiOperator("community")("GET", "reports"),
      openCommunityAiEvidence(`reports/${id}/evidence/${id}`, null, undefined),
      openCommunityAiMedia(
        `comments/${comment}/images/${item}/thumb`,
        null,
        undefined,
      ),
    ])
      expect(await refused(attempt)).toEqual({
        code: "AI_CREDENTIAL_NOT_CONFIGURED",
        status: 503,
      });
  });

  it("keeps the Backend's bare code and status on a JSON call", async () => {
    const answers = reader(true);
    const backend = await startBackend({ aiOperatorReader: answers });
    stubbed(backend.origin);
    expect(
      await refused(callAiOperator("community")("GET", `comments/${comment}`)),
    ).toEqual({ code: "SELF_ONLY_OWNER_REVIEW", status: 403 });
    expect(
      await refused(callAiOperator("community")("GET", "agent/users")),
    ).toEqual({ code: "AI_ROUTE_FORBIDDEN", status: 403 });
    expect(
      await callAiOperator("community")("GET", `ai/find?text=${randomUUID()}`),
    ).toEqual({ items: [], sources: {}, excluded: ["self_only"] });
  });

  it("keeps the Backend's code on a byte route whose record is self-only", async () => {
    const backend = await startBackend({ aiOperatorReader: reader(true) });
    stubbed(backend.origin);
    expect(
      await refused(
        openCommunityAiMedia(
          `publishing/media/work-revision-${"a".repeat(32)}/${item}/display/base`,
          null,
          undefined,
        ),
      ),
    ).toEqual({ code: "SELF_ONLY_OWNER_REVIEW", status: 403 });
  });
});
