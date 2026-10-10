import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  contentStateSchema,
  developmentSessionSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type { AuthorCommunityPort, CommunityDiscoveryPort } from "@moya/api";
import type { Server } from "node:http";

const servers = new Set<Server>();

const fixture = async () => {
  const isPublished = vi.fn(async () => true);
  const state = vi.fn(async () => ({
    favorite: false,
    liked: false,
    favoriteCount: 4,
    likeCount: 7,
    commentCount: 3,
  }));
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      authorCommunityPort: {} as AuthorCommunityPort,
      catalogPublicationPort: {
        isPublished,
        readTitle: async () => "Test catalog",
      },
      discoveryPort: { state } as unknown as CommunityDiscoveryPort,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const baseUrl = `http://${address.address}:${address.port}`;
  return {
    baseUrl,
    stateUrl: `${baseUrl}/v1/community/content/catalog/catalog-test/state`,
    isPublished,
    state,
  };
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("Content state reads", () => {
  it("lets a guest read aggregate totals only after content access is verified", async () => {
    const f = await fixture();
    const response = await fetch(f.stateUrl);
    expect(response.status).toBe(200);
    expect(f.isPublished).toHaveBeenCalledWith("catalog-test");
    expect(f.state).toHaveBeenCalledWith(
      { type: "catalog", id: "catalog-test" },
      null,
    );
    expect(f.isPublished.mock.invocationCallOrder[0]).toBeLessThan(
      f.state.mock.invocationCallOrder[0]!,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(contentStateSchema.parse(await response.json())).toEqual({
      favorite: false,
      liked: false,
      favoriteCount: 4,
      likeCount: 7,
      commentCount: 3,
    });
  });

  it("personalizes a supplied valid session", async () => {
    const f = await fixture();
    const signedIn = await fetch(`${f.baseUrl}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: fixtureUsers.active.handle }),
    });
    expect(signedIn.status).toBe(201);
    const session = developmentSessionSchema.parse(await signedIn.json());
    f.state.mockResolvedValueOnce({
      favorite: true,
      liked: true,
      favoriteCount: 4,
      likeCount: 7,
      commentCount: 3,
    });
    const response = await fetch(f.stateUrl, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(f.state).toHaveBeenCalledWith(
      { type: "catalog", id: "catalog-test" },
      fixtureUsers.active.id,
    );
    expect(contentStateSchema.parse(await response.json())).toEqual({
      favorite: true,
      liked: true,
      favoriteCount: 4,
      likeCount: 7,
      commentCount: 3,
    });
  });

  it("does not query totals for unavailable content", async () => {
    const f = await fixture();
    f.isPublished.mockResolvedValueOnce(false);
    const response = await fetch(f.stateUrl);
    expect(response.status).toBe(404);
    expect(f.isPublished).toHaveBeenCalledWith("catalog-test");
    expect(f.state).not.toHaveBeenCalled();
  });

  it("continues to reject malformed supplied credentials and malformed counts", async () => {
    const f = await fixture();
    const response = await fetch(f.stateUrl, {
      headers: { authorization: "SYNTHETIC_INVALID_AUTHORIZATION" },
    });
    expect(response.status).toBe(401);
    expect(f.isPublished).not.toHaveBeenCalled();
    expect(f.state).not.toHaveBeenCalled();
    expect(
      contentStateSchema.safeParse({
        favorite: false,
        liked: false,
        favoriteCount: -1,
        likeCount: 0,
      }).success,
    ).toBe(false);
    expect(
      contentStateSchema.safeParse({ favorite: false, liked: false }).success,
    ).toBe(false);
  });
});
