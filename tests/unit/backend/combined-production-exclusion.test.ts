/** Combined business routing with explicit synthetic ports and real services. */
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  type AuthorCommunityPort,
  type DirectMessagePort,
  type EditorialContentReadPort,
  type NotificationPort,
  type ThreadPort,
} from "@moya/api";
import {
  NotificationSignals,
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all([...servers].map((server) => stopServer(server)));
  servers.clear();
});

// The routes below use the actual runtime services. Only persistence and
// delivery are test injections; the Production composition has no fixture fallback.
const notificationPort: NotificationPort = {
  read: async () => ({
    highWater: "0",
    items: [],
    unread: { total: 0, likes: 0, comments: 0, mentions: 0 },
    hasMore: false,
  }),
  markRead: async () => {},
  lookup: async () => ({ items: [] }),
};
const editorialContentPort: EditorialContentReadPort = {
  listArticles: async (query) => ({
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
  }),
  findArticle: async () => null,
  isArticlePublished: async () => false,
  listCollections: async (query) => ({
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
  }),
  findCollection: async () => null,
};
const unused = async (): Promise<never> => {
  throw new Error("Unexpected fixture operation");
};
const threadPort: ThreadPort = {
  listThreads: async (_viewer, query) => ({
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: 0,
    anchor: "2026-10-02T00:00:00.000Z",
  }),
  readThread: unused,
  listThreadPosts: unused,
  markThreadRead: unused,
  threadOfWork: async () => null,
  operatorListThreads: unused,
  operatorCreateThread: unused,
  operatorUpdateThread: unused,
};
const directMessagePort: DirectMessagePort = {
  send: unused,
  listConversations: unused,
  readConversation: unused,
  findConversationWith: unused,
  setHidden: unused,
  setMuted: unused,
  markRead: unused,
  unread: unused,
  operatorReadConversation: unused,
  operatorFindConversation: unused,
  operatorRemoveMessage: unused,
};
const combined = {
  // Author profile persistence is not touched by editorial/Thread/DM dispatch.
  authorCommunityPort: {} as AuthorCommunityPort,
  notificationPort,
  notificationSignals: new NotificationSignals(),
  editorialContentPort,
  threadPort,
  directMessagePort,
};
const shared = () => ({
  communityIdentityPort: new InMemoryCommunityIdentityPort(),
  catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
  storageUrlResolver: new UnconfiguredStorageUrlResolver(),
});
const developmentAuth = () =>
  new CommunityAuthService(createMemoryCommunityAuthPort(), {
    environment: "development",
    profile: "full-local",
    keys: {
      version: 1,
      lookupKey: Buffer.alloc(32, 1),
      encryptionKey: Buffer.alloc(32, 2),
      otpKey: Buffer.alloc(32, 3),
    },
    emailMode: "local_capture",
    phoneMode: "disabled",
    delivery: { sendEmail: unused, sendPhone: unused, checkPhone: unused },
  });

const start = async (
  options: Parameters<typeof createBackendApplication>[0],
) => {
  const server = createBackendServer(createBackendApplication(options));
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}`;
};

describe("combined Production business services and Development exclusions", () => {
  it("refuses Development authentication and missing capability provenance in Production", () => {
    for (const authService of [
      developmentAuth(),
      { capabilities: () => ({}) } as CommunityAuthService,
    ])
      expect(() =>
        createBackendApplication({
          nodeEnv: "production",
          ...shared(),
          ...combined,
          authService,
        }),
      ).toThrow(/not composed in production/u);
  });

  it.each(["development", "production"] as const)(
    "runs public business services and enforces private sessions in %s",
    async (nodeEnv) => {
      const base = await start({ nodeEnv, ...shared(), ...combined });
      for (const path of [
        "editorial/articles",
        "editorial/collections",
        "threads",
      ]) {
        const response = await fetch(`${base}/v1/community/${path}`);
        expect(response.status, path).toBe(200);
        expect(await response.json()).toMatchObject({ items: [], total: 0 });
      }
      for (const path of [
        "notifications",
        "notifications/stream",
        "mentions?q=dev",
        "messages",
        "messages/unread",
      ])
        expect((await fetch(`${base}/v1/community/${path}`)).status, path).toBe(
          401,
        );
      if (nodeEnv === "production") {
        for (const path of ["capabilities", "account"])
          expect(
            (await fetch(`${base}/v1/community/auth/${path}`)).status,
          ).toBe(404);
        expect(
          (await fetch(`${base}/v1/development/sign-in`, { method: "POST" }))
            .status,
        ).toBe(404);
      }
    },
  );

  it("preserves the Development authentication and sign-in control", async () => {
    const base = await start({
      nodeEnv: "development",
      ...shared(),
      ...combined,
      authService: developmentAuth(),
    });
    const capabilities = await fetch(`${base}/v1/community/auth/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({ developmentOnly: true });
    expect(
      (
        await fetch(`${base}/v1/development/sign-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
});
