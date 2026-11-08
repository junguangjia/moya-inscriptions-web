import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AI_OPERATOR_REQUEST_ID_HEADER,
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
  callCommunityOperator,
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
    send: async (
      method: string,
      route: string,
      token: string,
      body: unknown = {},
      headers: Readonly<Record<string, string>> = {},
    ) => {
      const response = await fetch(`${origin}/internal/community/${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
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

const reader = (
  selfOnly: boolean,
  { personal = false, receipt = false } = {},
): AiOperatorReader => ({
  find: vi.fn(async () => ({
    items: [],
    sources: {},
    excluded: ["self_only"],
  })),
  count: vi.fn(async () => ({ total: 0, oldestAt: null })),
  select: vi.fn(async () => ({ items: [], excluded: ["self_only"] })),
  settlement: vi.fn(async () => ({ open: 0, failed: 0, failedJobs: [] })),
  isSelfOnly: vi.fn(async () => selfOnly),
  isPersonalInfoRequest: vi.fn(async () => personal),
  hasCommentReceipt: vi.fn(async () => receipt),
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
      ["POST", "publishing/jobs/:id/retry", "write", "publishing_job"],
      ["POST", "articles/:id/moderation", "write", "article"],
      ["POST", "timeline-entries", "write", undefined],
      ["POST", "timeline-entries/:id", "write", undefined],
      ["POST", "timeline-order", "write", undefined],
      ["POST", "timeline-posts/:id", "write", "work"],
    ]);
  });

  it("keeps the timeline's paths apart, so no entry id reaches another row", () => {
    const none = new URLSearchParams();
    const timeline = "/internal/community/timeline";
    // home-timeline-v1: an id that spells another route is still an entry id.
    for (const slug of ["summary", "order", "entries", "reorder"])
      expect(
        aiOperatorRouteFor("POST", `${timeline}-entries/${slug}`, none)?.path,
        slug,
      ).toBe(`${timeline}-entries/:id`);
    expect(aiOperatorRouteFor("GET", `${timeline}-summary`, none)?.klass).toBe(
      "read",
    );
    // timeline-posts-v1: a post's write names its work, which is withheld while self-only.
    const work = `work-${"a".repeat(32)}`;
    expect(
      aiOperatorRouteFor("POST", `${timeline}-posts/${work}`, none),
    ).toMatchObject({ path: `${timeline}-posts/:id`, selfOnly: "work" });
    expect(aiOperatorRouteFor("GET", `${timeline}-posts`, none)).toMatchObject({
      klass: "read",
    });
    expect(
      aiOperatorRouteFor("GET", `${timeline}-posts`, none)?.selfOnly,
    ).toBeUndefined();
    for (const [method, pathname] of [
      ["GET", `${timeline}-entries/tang-a`],
      ["POST", `${timeline}-entries/tang-a/hide`],
      ["POST", `${timeline}-summary`],
      ["GET", `${timeline}-order`],
      ["PUT", `${timeline}-entries/tang-a`],
      ["GET", `${timeline}-posts/${work}`],
      ["POST", `${timeline}-posts`],
      ["POST", `${timeline}-posts/${work}/withhold`],
    ] as const)
      expect(
        aiOperatorRouteFor(method, pathname, none),
        `${method} ${pathname}`,
      ).toBeUndefined();
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
    `ai/select?source=comments&ids=${comment}`,
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
    expect(
      await backend.send(
        "GET",
        `ai/select?source=comments&ids=${comment}`,
        ownerToken,
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    await backend.send("GET", `comments/${comment}`, ownerToken);
    expect(answers.find).not.toHaveBeenCalled();
    expect(answers.select).not.toHaveBeenCalled();
    expect(answers.isSelfOnly).not.toHaveBeenCalled();
  });

  // S8-08: a preview's stamps. A filter and `movable` are the selector's (S8-14), so
  // they are refused by name, never answered as if by ids.
  it("reads ai/select by ids alone, up to 100 distinct ones", async () => {
    const answers = reader(false);
    const backend = await startBackend({ aiOperatorReader: answers });
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `comment-${String(index).padStart(32, "0")}`,
      ).join(",");
    expect(
      await backend.send(
        "GET",
        `ai/select?source=comments&ids=${ids(100)}`,
        communityToken,
      ),
    ).toEqual({ status: 200, code: undefined });
    expect(answers.select).toHaveBeenCalledWith({
      source: "comments",
      ids: ids(100).split(","),
    });
    for (const route of [
      `ai/select?source=comments&ids=${ids(101)}`,
      `ai/select?source=comments&ids=${comment},${comment}`,
      `ai/select?source=comments&ids=${comment}&movable=visible`,
      "ai/select?source=comments&moderation=pending",
      `ai/select?source=reports&ids=${id}&movable=open`,
      `ai/select?source=threads&ids=${id}`,
      `ai/select?source=comments&ids=${comment}&ids=${comment}`,
    ])
      expect(await backend.send("GET", route, communityToken), route).toEqual({
        status: 400,
        code: "INVALID_QUERY",
      });
    expect(answers.select).toHaveBeenCalledTimes(1);
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
      [
        "POST",
        `publishing/jobs/publishing-job-${"a".repeat(32)}/retry`,
        "publishing_job",
        `publishing-job-${"a".repeat(32)}`,
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
    expect(answers.isPersonalInfoRequest).not.toHaveBeenCalled();
    expect(answers.hasCommentReceipt).not.toHaveBeenCalled();
  });

  it("lets the Owner's featuring of a work through, and asks AI's before it runs", async () => {
    const answers = reader(true);
    const setFeatured = vi.fn(async () => ({ version: 2 }));
    const backend = await startBackend({
      aiOperatorReader: answers,
      contentOperatorPort: { setFeatured } as never,
    });
    const command = {
      requestId: randomUUID(),
      target: { type: "work", id: `work-${"a".repeat(32)}` },
      enabled: false,
      position: 1,
      expectedVersion: 1,
    };
    expect(
      await backend.send("PUT", "featured", ownerToken, command),
    ).toMatchObject({ status: 200 });
    expect(setFeatured).toHaveBeenCalledTimes(1);
    expect(answers.isSelfOnly).not.toHaveBeenCalled();
    expect(
      await backend.send("PUT", "featured", communityToken, command),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
    expect(setFeatured).toHaveBeenCalledTimes(1);
    expect(answers.isSelfOnly).toHaveBeenCalledWith("work", command.target.id);
  });

  it("refuses every write on a person's own request, and no read", async () => {
    const answers = reader(false, { personal: true });
    const backend = await startBackend({ aiOperatorReader: answers });
    for (const leaf of ["decisions", "review", "metadata"])
      expect(
        await backend.send("POST", `reports/${id}/${leaf}`, communityToken),
        leaf,
      ).toEqual({ status: 403, code: "PERSONAL_INFO_OWNER_REVIEW" });
    expect(answers.isPersonalInfoRequest).toHaveBeenLastCalledWith(id);
    const reads = vi.mocked(answers.isPersonalInfoRequest).mock.calls.length;
    await backend.send("GET", `reports/${id}`, communityToken);
    expect(answers.isPersonalInfoRequest).toHaveBeenCalledTimes(reads);
  });

  it("refuses to clear urgent by name on the AI credential, before the body reaches a service", async () => {
    const metadata = vi.fn();
    const backend = await startBackend({
      aiOperatorReader: reader(false),
      reportingPort: { metadata } as never,
    });
    expect(
      await backend.send("POST", `reports/${id}/metadata`, communityToken, {
        expectedVersion: 1,
        urgent: false,
      }),
    ).toEqual({ status: 403, code: "URGENT_OWNER_ONLY" });
    expect(metadata).not.toHaveBeenCalled();
  });

  it("releases a legal hold on the AI credential only under a run id", async () => {
    const metadata = vi.fn();
    const backend = await startBackend({
      aiOperatorReader: reader(false),
      reportingPort: { metadata } as never,
    });
    const release = { expectedVersion: 1, legalHold: false };
    for (const header of [{}, { "x-admin-mcp-run": "synthetic" }])
      expect(
        await backend.send(
          "POST",
          `reports/${id}/metadata`,
          communityToken,
          release,
          header,
        ),
        JSON.stringify(header),
      ).toEqual({ status: 403, code: "AI_RUN_REQUIRED" });
    expect(metadata).not.toHaveBeenCalled();
    // Past the check it reaches the service, which has no store here.
    const past = await backend.send(
      "POST",
      `reports/${id}/metadata`,
      communityToken,
      release,
      { "x-admin-mcp-run": randomUUID() },
    );
    expect(past.code).not.toBe("AI_RUN_REQUIRED");
  });

  it("passes a self-only check only for a comment write whose own key has a receipt", async () => {
    const key = randomUUID();
    const header = { [AI_OPERATOR_REQUEST_ID_HEADER]: key };
    const body = { action: "hide", reason: "Synthetic" };
    const held = reader(true, { receipt: true });
    const backend = await startBackend({ aiOperatorReader: held });
    // Past the check it reaches the real route, which has no store here.
    const past = await backend.send(
      "POST",
      `comments/${comment}/moderation`,
      communityToken,
      body,
      header,
    );
    expect(past.code).not.toBe("SELF_ONLY_OWNER_REVIEW");
    expect(held.hasCommentReceipt).toHaveBeenCalledWith(key);
    // A read of that comment, any other write, and a key that is no uuid do not pass.
    expect(
      await backend.send("GET", `comments/${comment}`, communityToken),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
    expect(
      await backend.send(
        "POST",
        `works/work-${"a".repeat(32)}/moderation`,
        communityToken,
        body,
        header,
      ),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
    expect(
      await backend.send(
        "POST",
        `comments/${comment}/moderation`,
        communityToken,
        body,
        { [AI_OPERATOR_REQUEST_ID_HEADER]: "not-a-uuid" },
      ),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
    const none = reader(true);
    const refused = await startBackend({ aiOperatorReader: none });
    expect(
      await refused.send(
        "POST",
        `comments/${comment}/moderation`,
        communityToken,
        body,
        header,
      ),
    ).toEqual({ status: 403, code: "SELF_ONLY_OWNER_REVIEW" });
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

describe("the Owner's Admin client", () => {
  it("narrows any 409 to STATE_CONFLICT, so a changed Backend code never reaches a page", async () => {
    const stub = createServer((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      stub.listen(0, "127.0.0.1", () => resolve()),
    );
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `http://127.0.0.1:${(stub.address() as AddressInfo).port}/`,
    );
    vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
    try {
      const error = await callCommunityOperator("POST", "threads", {
        requestId: randomUUID(),
        title: "Synthetic",
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CommunityOperatorError);
      expect((error as CommunityOperatorError).code).toBe("STATE_CONFLICT");
      expect((error as CommunityOperatorError).status).toBe(409);
    } finally {
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    }
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
