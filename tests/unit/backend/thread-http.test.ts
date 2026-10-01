import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  developmentSessionSchema,
  threadPageSchema,
  threadReadResultSchema,
  threadSummarySchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type { AuthorCommunityPort, ThreadPort } from "@moya/api";
import type { ThreadId, ThreadSummary } from "@moya/contracts";
import type { Server } from "node:http";

const servers = new Set<Server>();
const threadId = `thread-${"a".repeat(32)}` as ThreadId;
const summary = (unread: boolean | null): ThreadSummary => ({
  id: threadId,
  title: "初次访碑，除了拍照还应该记录什么？",
  description: "",
  tags: ["田野观察"],
  status: "open",
  heat: 6,
  postCount: 1,
  latestActivityAt: "2026-09-22T00:00:00.000Z",
  createdAt: "2026-09-21T00:00:00.000Z",
  unread,
});

/** Synthetic operator credential for this unit test only. */
const operatorCredential = "synthetic-operator-credential-0123456789";

class FixturePort implements ThreadPort {
  readonly marked: string[] = [];
  readonly anchors: (string | undefined)[] = [];
  async listThreads(
    viewer: string | null,
    query: { page: number; pageSize: number; anchor?: string },
  ) {
    this.anchors.push(query.anchor);
    return {
      items: [summary(viewer === null ? null : true)],
      total: 1,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: 1,
      anchor: query.anchor ?? "2026-09-22T01:00:00.000Z",
    };
  }
  async readThread(id: ThreadId, viewer: string | null) {
    if (id !== threadId)
      throw new (await import("@moya/api")).CommunityNotFoundError();
    return summary(viewer === null ? null : true);
  }
  async listThreadPosts(
    _id: ThreadId,
    _viewer: string | null,
    query: { page: number; pageSize: number },
  ) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }
  async markThreadRead(id: ThreadId, actor: string) {
    this.marked.push(`${actor}:${id}`);
    return { observedActivityAt: "2026-09-22T00:00:00.000Z" };
  }
  async threadOfWork() {
    return null;
  }
  async operatorListThreads(query: { page: number; pageSize: number }) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }
  async operatorCreateThread(): Promise<never> {
    throw new Error("not exercised");
  }
  async operatorUpdateThread(): Promise<never> {
    throw new Error("not exercised");
  }
}

const start = async (
  nodeEnv: "development" | "production",
  port?: ThreadPort,
) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      authorCommunityPort: {} as unknown as AuthorCommunityPort,
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      ...(port ? { threadPort: port } : {}),
      ...(nodeEnv === "production"
        ? {
            catalogQueryPort: {
              list: async () => ({
                items: [],
                total: 0,
                page: 1,
                pageSize: 1,
                totalPages: 0,
              }),
              getById: async () => null,
            },
          }
        : {}),
      communityOperatorCredential: operatorCredential,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}`;
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("Thread HTTP surface (content-community-completion-v1)", () => {
  it("lists at an anchor, reads one Thread and answers 404 for unknown or malformed ids", async () => {
    const port = new FixturePort();
    const base = await start("development", port);
    const first = threadPageSchema.parse(
      await (await fetch(`${base}/v1/community/threads`)).json(),
    );
    expect(first.items[0]?.unread).toBeNull();
    const second = await fetch(
      `${base}/v1/community/threads?page=2&anchor=${encodeURIComponent(first.anchor)}`,
    );
    expect(second.status).toBe(200);
    expect(port.anchors).toEqual([undefined, first.anchor]);
    const one = threadSummarySchema.parse(
      await (await fetch(`${base}/v1/community/threads/${threadId}`)).json(),
    );
    expect(one.id).toBe(threadId);
    const missing = await fetch(
      `${base}/v1/community/threads/thread-${"f".repeat(32)}`,
    );
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json()).error.code).toBe(
      "ITEM_NOT_FOUND",
    );
    expect(
      (await fetch(`${base}/v1/community/threads/not-a-thread`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/v1/community/threads?pageSize=999`)).status,
    ).toBe(400);
  });

  it("records the read marker only for a session and never from a client instant", async () => {
    const port = new FixturePort();
    const base = await start("development", port);
    const anonymous = await fetch(
      `${base}/v1/community/threads/${threadId}/read`,
      { method: "POST" },
    );
    expect(anonymous.status).toBe(401);
    const signedIn = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dev-user-01" }),
    });
    const session = developmentSessionSchema.parse(await signedIn.json());
    const marked = await fetch(
      `${base}/v1/community/threads/${threadId}/read`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
          "x-author-account": session.profile.id,
        },
        body: JSON.stringify({
          observedActivityAt: "2999-01-01T00:00:00.000Z",
        }),
      },
    );
    expect(marked.status).toBe(200);
    expect(
      threadReadResultSchema.parse(await marked.json()).observedActivityAt,
    ).toBe("2026-09-22T00:00:00.000Z");
    expect(port.marked).toEqual([`${session.profile.id}:${threadId}`]);
    const listed = threadPageSchema.parse(
      await (
        await fetch(`${base}/v1/community/threads`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).json(),
    );
    expect(listed.items[0]?.unread).toBe(true);
  });

  it("is absent without a Thread port and outside Development, including the operator routes", async () => {
    const withoutPort = await start("development");
    expect((await fetch(`${withoutPort}/v1/community/threads`)).status).toBe(
      404,
    );
    const production = await start("production", new FixturePort());
    expect((await fetch(`${production}/v1/community/threads`)).status).toBe(
      404,
    );
    const operator = await fetch(`${production}/internal/community/threads`, {
      headers: { authorization: `Bearer ${operatorCredential}` },
    });
    expect(operator.status).toBe(404);
  });
});
