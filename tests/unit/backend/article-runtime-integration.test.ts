import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleAuthoringService, CommunitySessionService } from "@moya/api";
import type { ArticleAuthoringPort } from "@moya/api";
import {
  articleDraftSchema,
  emptyArticleDocument,
} from "@moya/contracts/schemas";
import { createBackendApplication } from "@moya/backend-runtime";
import type { ArticleDelegationRuntime } from "@moya/backend-runtime";
import {
  readBoundedArticleThumbnail,
  ARTICLE_THUMBNAIL_MAX_BYTES,
} from "@moya/backend-runtime";
import { articleBackendConfigurationFrom } from "@moya/backend-production";
import {
  parseRuntimeConfig,
  createDevelopmentCatalogFixtureQueryPort,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import type { PublishingMediaStorePort } from "@moya/api";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";
const draft = articleDraftSchema.parse({
  id: `article-${"1".repeat(32)}`,
  ownerId: fixtureUsers.active.id,
  version: 1,
  title: "合成",
  coverRefId: null,
  document: emptyArticleDocument(),
  status: "draft",
  publicVersion: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "a".repeat(64),
});
const makePort = () =>
  ({
    create: vi.fn(async () => draft),
    read: vi.fn(async () => draft),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    listOwnMedia: vi.fn(async () => ({ items: [], nextCursor: null })),
    save: vi.fn(async () => draft),
    editBlocks: vi.fn(async () => draft),
    publish: vi.fn(async () => draft),
    withdraw: vi.fn(async () => draft),
    deleteDraft: vi.fn(async () => ({
      id: draft.id,
      deleted: true as const,
      publicVersion: null,
    })),
    validate: async () => ({
      id: draft.id,
      version: 1,
      fingerprint: draft.fingerprint,
      valid: true,
      issues: [],
    }),
    preview: async () => ({
      draft,
      validation: {
        id: draft.id,
        version: 1,
        fingerprint: draft.fingerprint,
        valid: true,
        issues: [],
      },
    }),
    readPublished: async () => null,
    listPublished: async () => ({ items: [], total: 0 }),
  }) satisfies ArticleAuthoringPort;
const servers = new Set<Server>();
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            servers.delete(server);
            if (error) reject(error);
            else resolve();
          }),
        ),
    ),
  );
});
const start = async (
  nodeEnv: "development" | "production" | "test" = "development",
) => {
  const identity = new InMemoryCommunityIdentityPort();
  const sessions = new CommunitySessionService(identity);
  const grant = await sessions.signInDevelopmentAccount(
    fixtureUsers.active.handle,
  );
  if (grant === null) throw Error("Missing synthetic account");
  const shared = makePort(),
    fallback = makePort();
  const unreachable = async () => {
    throw Error("Not used by routing test");
  };
  const connections = {
    list: vi.fn(async () => []),
    revoke: async () => {},
    prepareApprovalReview: unreachable,
    readApproval: async () => null,
    approveCandidate: unreachable,
  };
  const human: ArticleDelegationRuntime = {
    connections,
    consents: {
      open: unreachable,
      read: async () => null,
      prepareReview: unreachable,
      decide: unreachable,
      finalizeGrant: unreachable,
    },
    issuer: "http://issuer.localhost:44551",
    clients: new Map(),
    authoring: new ArticleAuthoringService(shared),
    readPublished: async () => null,
  };
  const mcp = vi.fn(
    async (
      _request: Parameters<
        NonNullable<
          Parameters<typeof createBackendApplication>[0]["articleDelegation"]
        >["mcp"]
      >[0],
      response: Parameters<
        NonNullable<
          Parameters<typeof createBackendApplication>[0]["articleDelegation"]
        >["mcp"]
      >[1],
    ) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
  );
  const server = createServer(
    createBackendApplication({
      nodeEnv,
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
      communityIdentityPort: identity,
      articleAuthoringPort: fallback,
      articleDelegation: {
        human,
        mcp,
        resource: "http://127.0.0.1:44552/mcp/article-authoring",
      },
    }),
  );
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("Missing listener");
  const headers = {
    authorization: `Bearer ${grant.token}`,
    "x-author-account": grant.profile.id,
  };
  const send = (path: string, authenticated = true) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: authenticated ? headers : {},
    });
  return { send, shared, fallback, connections, mcp };
};
describe("Development Article dispatch and identity", () => {
  it("uses the exact same service for human documents and the delegated runtime", async () => {
    const { send, shared, fallback } = await start();
    expect((await send("/v1/community/article-authoring")).status).toBe(200);
    expect(shared.list).toHaveBeenCalledOnce();
    expect(fallback.list).not.toHaveBeenCalled();
  });
  it("dispatches human connections ahead of generic Article IDs and fences anonymous access", async () => {
    const { send, connections } = await start();
    expect(
      (await send("/v1/community/article-authoring/connections", false)).status,
    ).toBe(401);
    expect(connections.list).not.toHaveBeenCalled();
    expect(
      (await send("/v1/community/article-authoring/connections")).status,
    ).toBe(200);
    expect(connections.list).toHaveBeenCalledWith(fixtureUsers.active.id);
  });
  it("dispatches MCP and its exact metadata path without a human session", async () => {
    const { send, mcp } = await start();
    expect((await send("/mcp/article-authoring", false)).status).toBe(200);
    expect(
      (
        await send(
          "/.well-known/oauth-protected-resource/mcp/article-authoring",
          false,
        )
      ).status,
    ).toBe(200);
    expect(mcp).toHaveBeenCalledTimes(2);
  });
  it.each(["test", "production"] as const)(
    "keeps all composed delegation routes absent in %s",
    async (env) => {
      const { send, mcp, connections, shared } = await start(env);
      for (const path of [
        "/mcp/article-authoring",
        "/.well-known/oauth-protected-resource/mcp/article-authoring",
        "/v1/community/article-authoring/connections",
        "/v1/community/article-authoring",
      ])
        expect((await send(path)).status).toBe(404);
      expect(mcp).not.toHaveBeenCalled();
      expect(connections.list).not.toHaveBeenCalled();
      expect(shared.list).not.toHaveBeenCalled();
    },
  );
  it("Production and disabled Development read no Article configuration", () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw Error("Protected setting must remain unread");
        },
      },
    );
    expect(
      articleBackendConfigurationFrom(
        env,
        parseRuntimeConfig({
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: "44552",
        }),
      ),
    ).toBe(null);
    expect(
      articleBackendConfigurationFrom(
        {},
        parseRuntimeConfig({ NODE_ENV: "development", PORT: "44552" }),
      ),
    ).toBe(null);
  });
});
const webp = () => {
  const bytes = Buffer.alloc(16);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(8, 4);
  bytes.write("WEBP", 8);
  return bytes;
};
const thumbnailFixture = (bytes = webp()) => {
  const close = vi.fn(async () => {}),
    openRead = vi.fn(async () => ({
      status: "ok" as const,
      byteSize: bytes.length,
      start: 0,
      end: bytes.length - 1,
      contentLength: bytes.length,
      body: (async function* () {
        yield bytes;
      })(),
      close,
    }));
  const store = { openRead } as unknown as PublishingMediaStorePort;
  const target = {
    storageKey: "blobs/aa/bb/" + "1".repeat(32),
    contentType: "image/webp" as const,
    byteSize: bytes.length,
    sha256: "a".repeat(64),
  };
  return { store, target, openRead, close };
};
describe("bounded committed Article thumbnail bytes", () => {
  it("returns only a bounded WebP derivative and closes its read", async () => {
    const { store, target, close } = thumbnailFixture();
    expect(
      await readBoundedArticleThumbnail(store, async () => target),
    ).toEqual({ bytes: webp(), mimeType: "image/webp" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("refuses missing store/target, non-thumbnail MIME and oversized target before opening", async () => {
    const { store, target, openRead } = thumbnailFixture();
    await expect(
      readBoundedArticleThumbnail(undefined, async () => target),
    ).rejects.toThrow();
    for (const candidate of [
      null,
      { ...target, contentType: "video/mp4" as const },
      { ...target, byteSize: ARTICLE_THUMBNAIL_MAX_BYTES + 1 },
    ])
      await expect(
        readBoundedArticleThumbnail(store, async () => candidate),
      ).rejects.toThrow();
    expect(openRead).not.toHaveBeenCalled();
  });
  it("refuses invalid bytes and releases the stored stream", async () => {
    const { store, target, close } = thumbnailFixture(Buffer.from("not webp"));
    await expect(
      readBoundedArticleThumbnail(store, async () => target),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
  it("refuses streams that exceed the declared committed blob size", async () => {
    const { store, target, close } = thumbnailFixture();
    await expect(
      readBoundedArticleThumbnail(store, async () => ({
        ...target,
        byteSize: target.byteSize - 1,
      })),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});

const configuredEnvironment = () => ({
  NODE_ENV: "development",
  ARTICLE_AUTHORING_ENABLED: "true",
  ARTICLE_AUTHORING_ISSUER: "http://article-issuer.localhost:44551",
  ARTICLE_AUTHORING_RESOURCE: "http://127.0.0.1:44552/mcp/article-authoring",
  ARTICLE_AUTHORING_CONSENT_ORIGIN: "http://localhost:44550",
  ARTICLE_AUTHORIZATION_PORT: "44551",
  ARTICLE_AUTHORIZATION_DATABASE_URL:
    "postgres://article_issuer@127.0.0.1:5432/yoyi_dev?sslmode=disable",
  ARTICLE_AUTHORING_CONTROL_DATABASE_URL:
    "postgres://article_control@127.0.0.1:5432/yoyi_dev?sslmode=disable",
  APP_DATABASE_URL:
    "postgres://article_resource@127.0.0.1:5432/yoyi_dev?sslmode=disable",
  ARTICLE_AUTHORING_CLIENTS: JSON.stringify([
    {
      clientId: "synthetic-article-client",
      family: "claude",
      label: "Synthetic test client",
      redirectUris: ["http://127.0.0.1:44553/callback"],
    },
  ]),
  ARTICLE_AUTHORING_WRAPPER_INDEX_KEY: Buffer.alloc(32, 1).toString("base64"),
  ARTICLE_AUTHORING_WRAPPER_SEAL_KEY: Buffer.alloc(32, 2).toString("base64"),
});
describe("Article backend role configuration before any resource opens", () => {
  const runtime = parseRuntimeConfig({
    NODE_ENV: "development",
    PORT: "44552",
  });
  it("reuses the issuer registry with direct loopback same-target distinct roles", () => {
    const value = articleBackendConfigurationFrom(
      configuredEnvironment(),
      runtime,
    );
    expect(value?.authorization.resource).toBe(
      "http://127.0.0.1:44552/mcp/article-authoring",
    );
    expect(value?.authorization.clients.size).toBe(1);
    expect(value?.controlPostgres.ssl).toBe(false);
  });
  it("refuses a conflated resource/control role, foreign target and connection override", () => {
    const original = configuredEnvironment();
    for (const override of [
      { ARTICLE_AUTHORING_CONTROL_DATABASE_URL: original.APP_DATABASE_URL },
      {
        ARTICLE_AUTHORING_CONTROL_DATABASE_URL:
          "postgres://article_control@127.0.0.1:5432/foreign_dev",
      },
      {
        ARTICLE_AUTHORING_CONTROL_DATABASE_URL:
          "postgres://article_control@127.0.0.1:5432/yoyi_dev?user=article_resource",
      },
    ])
      expect(() =>
        articleBackendConfigurationFrom({ ...original, ...override }, runtime),
      ).toThrow();
  });
  it("refuses a wrong backend resource and any fallback to the Admin role", () => {
    const original = configuredEnvironment();
    expect(() =>
      articleBackendConfigurationFrom(
        {
          ...original,
          ARTICLE_AUTHORING_RESOURCE:
            "http://127.0.0.1:44554/mcp/article-authoring",
        },
        runtime,
      ),
    ).toThrow();
    expect(() =>
      articleBackendConfigurationFrom(
        {
          ...original,
          CMS_DATABASE_URL: original.ARTICLE_AUTHORING_CONTROL_DATABASE_URL,
        },
        runtime,
      ),
    ).toThrow();
  });
});
