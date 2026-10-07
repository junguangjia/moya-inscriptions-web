import { createServer, type Server } from "node:http";

import { ArticleAuthoringService, CommunitySessionService } from "@moya/api";
import {
  createArticleMcpHandler,
  createBackendApplication,
  createDevelopmentCatalogFixtureQueryPort,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type { ArticleAuthoringPort } from "@moya/api";
import type {
  ArticleDelegationRuntime,
  ArticleMcpDependencies,
} from "@moya/backend-runtime";

const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.clear();
});

const listen = async (server: Server) => {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("Missing listener");
  return address.port;
};

const unreachable = async (): Promise<never> => {
  throw Error("Not used by this test");
};
const authoring = new ArticleAuthoringService({} as ArticleAuthoringPort);

describe("product access and the Article MCP boundary", () => {
  it("keeps the MCP endpoint and its discovery document reachable while the human Article routes follow the session policy", async () => {
    const identity = new InMemoryCommunityIdentityPort();
    const mcp = vi.fn(
      async (
        _request: Parameters<ReturnType<typeof createArticleMcpHandler>>[0],
        response: Parameters<ReturnType<typeof createArticleMcpHandler>>[1],
      ) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
    );
    const human: ArticleDelegationRuntime = {
      connections: {
        list: async () => [],
        revoke: async () => {},
        prepareApprovalReview: unreachable,
        readApproval: async () => null,
        approveCandidate: unreachable,
      },
      consents: {
        open: unreachable,
        read: async () => null,
        prepareReview: unreachable,
        decide: unreachable,
        finalizeGrant: unreachable,
      },
      issuer: "http://issuer.localhost:44551",
      clients: new Map(),
      authoring,
      readPublished: async () => null,
    };
    const port = await listen(
      createServer(
        createBackendApplication({
          nodeEnv: "development",
          productAccess: {
            mode: "closed_beta",
            admits: (userId) => userId === fixtureUsers.active.id,
          },
          catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
          storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          communityIdentityPort: identity,
          articleDelegation: {
            human,
            mcp,
            environment: "development",
            resource: "http://127.0.0.1:44552/mcp/article-authoring",
          },
        }),
      ),
    );
    const sessions = new CommunitySessionService(identity);
    const send = async (path: string, handle?: string) => {
      const grant =
        handle === undefined
          ? null
          : await sessions.signInDevelopmentAccount(handle);
      return fetch(`http://127.0.0.1:${port}${path}`, {
        headers:
          grant === null
            ? {}
            : {
                authorization: `Bearer ${grant.token}`,
                "x-author-account": grant.profile.id,
              },
      });
    };
    // The delegated grant, not a human session, is this boundary's authority.
    expect((await send("/mcp/article-authoring")).status).toBe(200);
    expect(
      (
        await send(
          "/.well-known/oauth-protected-resource/mcp/article-authoring",
        )
      ).status,
    ).toBe(200);
    expect(mcp).toHaveBeenCalledTimes(2);
    // Any other spelling is an ordinary protected route.
    expect((await send("/mcp/article-authoring/")).status).toBe(401);
    expect((await send("/mcp")).status).toBe(401);
    const connections = "/v1/community/article-authoring/connections";
    expect((await send(connections)).status).toBe(401);
    expect((await send(connections, "dev-user-02")).status).toBe(403);
    expect((await send(connections, "dev-user-01")).status).toBe(200);
  });

  it("refuses content and tool operations for a grant whose account is not approved, without changing the protocol", async () => {
    const admitted = new Set<string>([fixtureUsers.active.id]);
    const admitsAccount = vi.fn((userId: string) => admitted.has(userId));
    const assertCurrent = vi.fn(async () => undefined);
    const tokens = new Map([
      [`artvenn_article_ct_${"a".repeat(43)}`, fixtureUsers.active.id],
      [`artvenn_article_ct_${"b".repeat(43)}`, fixtureUsers.second.id],
    ]);
    // The handler is bound to its own listening address, known only after listen.
    const bound: { handler?: ReturnType<typeof createArticleMcpHandler> } = {};
    const port = await listen(
      createServer((request, response) => {
        void bound.handler!(request, response);
      }),
    );
    const resource = `http://127.0.0.1:${port}/mcp/article-authoring`;
    bound.handler = createArticleMcpHandler({
      resource,
      issuer: "http://issuer.localhost:44551",
      humanWebOrigin: "http://127.0.0.1:3000",
      authoring,
      admitsAccount,
      admit: async (presented) => {
        const userId = tokens.get(presented);
        if (userId === undefined) throw Error("Unknown grant");
        return {
          source: "delegated",
          userId,
          connectionId: `article-connection-${"1".repeat(32)}`,
          generation: 1,
          grantId: "synthetic-grant",
          scopes: ["artvenn:article:draft"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        } as unknown as Awaited<ReturnType<ArticleMcpDependencies["admit"]>>;
      },
      assertCurrent,
      readApproval: async () => null,
      readCatalog: async () => null,
      discoverCatalog: unreachable,
      discoverMedia: unreachable,
      inspectThumbnail: unreachable,
    });
    const call = (token: string | undefined, method = "tools/list") =>
      fetch(resource, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      });
    const [approved, other] = [...tokens.keys()] as [string, string];

    // Discovery stays anonymous and carries no content.
    const metadata = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp/article-authoring`,
    );
    expect(metadata.status).toBe(200);
    expect(Object.keys(await metadata.json()).sort()).toEqual([
      "authorization_servers",
      "bearer_methods_supported",
      "resource",
      "scopes_supported",
    ]);
    // No grant is still an authentication challenge.
    const anonymous = await call(undefined);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );

    // A current grant for an account that is not approved: forbidden, no challenge.
    const refused = await call(other);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBeNull();
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(await refused.text()).toBe("");

    // An approved account keeps the existing tools.
    const listed = await call(approved);
    expect(listed.status).toBe(200);
    const tools = (
      (await listed.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    expect(tools).toContain("artvenn_article_catalog_find");
    expect(tools).toContain("artvenn_article_catalog_read");

    // Removed between admission and the operation: the operation is refused.
    admitsAccount.mockImplementationOnce(() => true);
    admitted.delete(fixtureUsers.active.id);
    const late = await call(approved);
    expect(late.status).toBe(200);
    expect(
      ((await late.json()) as { error: { message: string } }).error.message,
    ).toContain("Access is restricted");
    // And on the next request it is refused at admission.
    expect((await call(approved)).status).toBe(403);
    expect(admitsAccount).toHaveBeenCalledWith(fixtureUsers.active.id);
  });
});
