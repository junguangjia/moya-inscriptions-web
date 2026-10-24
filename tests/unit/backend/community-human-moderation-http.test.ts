import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  articleModerationResultSchema,
  operatorWorkSchema,
  workSubmissionModerationResultSchema,
} from "@moya/contracts/internal/community-operator";
import { developmentSessionSchema } from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
} from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  ArticlePublicationOperatorPort,
  AuthorCommunityPort,
  CommunityContentOperatorPort,
  PublishingOperatorPort,
} from "@moya/api";
import type { Server } from "node:http";

const credential = "synthetic-human-operator-for-http-tests";
const requestId = "00000000-0000-4000-8000-000000000001";
const workId = `work-${"1".repeat(32)}`;
const revisionId = `work-revision-${"2".repeat(32)}`;
const articleId = `article-${"3".repeat(32)}`;
const authorId = `user-${"4".repeat(32)}`;
const now = new Date("2026-10-23T12:00:00.000Z");
const fingerprint = "5".repeat(64);
const servers = new Set<Server>();

/** Unexpected reads/writes fail instead of silently supplying another route. */
const mutationOnlyPort = <Port extends object>(methods: Partial<Port>): Port =>
  new Proxy(methods, {
    get(target, name, receiver) {
      if (name === "then") return undefined;
      if (!Reflect.has(target, name))
        throw new Error(`Unexpected operator port access: ${String(name)}`);
      return Reflect.get(target, name, receiver);
    },
  }) as Port;

const start = async () => {
  const work = vi.fn<CommunityContentOperatorPort["moderateWork"]>(async () =>
    operatorWorkSchema.parse({
      id: workId,
      title: "合成帖子",
      text: "合成内容",
      authorId,
      authorName: "合成作者",
      authorStatus: "active",
      state: "hidden",
      authorDeleted: false,
      version: 4,
      firstPublishedAt: null,
    }),
  );
  const pendingWork = vi.fn<PublishingOperatorPort["moderateSubmission"]>(
    async () =>
      workSubmissionModerationResultSchema.parse({
        revisionId,
        workId,
        disposition: "rejected",
        version: 4,
      }),
  );
  const pendingArticle = vi.fn<
    ArticlePublicationOperatorPort["moderatePending"]
  >(async () =>
    articleModerationResultSchema.parse({
      articleId,
      candidateVersion: 2,
      fingerprint,
      version: 4,
      disposition: "rejected",
      status: "draft",
      publicVersion: null,
    }),
  );
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential: credential,
      authorCommunityPort: {} as AuthorCommunityPort,
      contentOperatorPort: mutationOnlyPort<CommunityContentOperatorPort>({
        moderateWork: work,
      }),
      publishingOperatorPort: mutationOnlyPort<PublishingOperatorPort>({
        moderateSubmission: pendingWork,
      }),
      articlePublicationOperatorPort:
        mutationOnlyPort<ArticlePublicationOperatorPort>({
          moderatePending: pendingArticle,
        }),
      publishingClock: () => now,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const send = (
    path: string,
    body: unknown,
    authorization: string | null = `Bearer ${credential}`,
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    });
  const publicSession = async () => {
    const response = await send("/v1/development/sign-in", {
      handle: "dev-user-01",
    });
    expect(response.status).toBe(201);
    return developmentSessionSchema.parse(await response.json()).token;
  };
  return { send, publicSession, work, pendingWork, pendingArticle };
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

const routes = [
  {
    name: "Work visibility moderation",
    path: `/internal/community/works/${workId}/moderation`,
    command: { requestId, expectedVersion: 3, state: "hidden" },
    mutation: "work",
  },
  {
    name: "pending Work moderation",
    path: `/internal/community/publishing/submissions/${revisionId}/moderation`,
    command: { requestId, expectedVersion: 3, action: "reject" },
    mutation: "pendingWork",
  },
  {
    name: "pending Article moderation",
    path: `/internal/community/articles/${articleId}/moderation`,
    command: {
      requestId,
      expectedVersion: 3,
      candidateVersion: 2,
      fingerprint,
      action: "reject",
    },
    mutation: "pendingArticle",
  },
] as const;

describe.each(routes)("human operator HTTP boundary: $name", (route) => {
  it("requires operator authority even when the caller has a valid public session", async () => {
    const live = await start();
    const userToken = await live.publicSession();
    for (const authorization of [
      null,
      "Bearer SYNTHETIC",
      `Basic ${credential}`,
      `Bearer ${userToken}`,
    ]) {
      const response = await live.send(
        route.path,
        { ...route.command, reason: "合成审核依据" },
        authorization,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { status: 401, code: "OPERATOR_UNAUTHORIZED" },
      });
    }
    expect(live.work).not.toHaveBeenCalled();
    expect(live.pendingWork).not.toHaveBeenCalled();
    expect(live.pendingArticle).not.toHaveBeenCalled();
  });

  it("forwards the trimmed human reason with the fixed operator and original version guards", async () => {
    const live = await start();
    const response = await live.send(route.path, {
      ...route.command,
      reason: "\n  合成审核依据  \t",
    });
    expect(response.status).toBe(200);
    await response.json();
    const command = { ...route.command, reason: "合成审核依据" };
    if (route.mutation === "work")
      expect(live.work).toHaveBeenCalledExactlyOnceWith(
        workId,
        "owner",
        command,
      );
    else if (route.mutation === "pendingWork")
      expect(live.pendingWork).toHaveBeenCalledExactlyOnceWith(
        revisionId,
        "owner",
        command,
        now,
      );
    else
      expect(live.pendingArticle).toHaveBeenCalledExactlyOnceWith(
        "owner",
        articleId,
        command,
        now,
      );
  });

  if (route.mutation === "pendingArticle")
    it("accepts a maximum-length Chinese reason whose UTF-8 request exceeds 4 KiB", async () => {
      const live = await start();
      const reason = "审".repeat(2000);
      const command = { ...route.command, reason };
      expect(
        Buffer.byteLength(JSON.stringify(command), "utf8"),
      ).toBeGreaterThan(4096);
      const response = await live.send(route.path, command);
      expect(response.status).toBe(200);
      await response.json();
      expect(live.pendingArticle).toHaveBeenCalledExactlyOnceWith(
        "owner",
        articleId,
        command,
        now,
      );
      expect(live.work).not.toHaveBeenCalled();
      expect(live.pendingWork).not.toHaveBeenCalled();
    });

  it("rejects missing, blank and oversized reasons before any mutation", async () => {
    const live = await start();
    for (const reason of [undefined, "", " \n\t ", "x".repeat(2001)]) {
      const response = await live.send(route.path, {
        ...route.command,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { status: 400, code: "INVALID_COMMAND" },
      });
      expect(live.work).not.toHaveBeenCalled();
      expect(live.pendingWork).not.toHaveBeenCalled();
      expect(live.pendingArticle).not.toHaveBeenCalled();
    }
  });
});
