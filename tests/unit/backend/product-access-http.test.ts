import {
  CommunityAuthService,
  CommunitySessionService,
  createMemoryCommunityAuthPort,
  type AuthorCommunityPort,
  type CommunityDiscoveryPort,
  type NotificationPort,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  NotificationSignals,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  catalogPageSchema,
  developmentSessionSchema,
  productAccessSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type { BackendApplicationOptions } from "@moya/backend-runtime";
import type { ApiErrorCode } from "@moya/contracts";
import type { Server } from "node:http";

type Policy = NonNullable<BackendApplicationOptions["productAccess"]>;

const servers = new Set<Server>();
const aborts = new Set<AbortController>();
afterEach(async () => {
  for (const abort of aborts) abort.abort();
  aborts.clear();
  for (const server of servers) await stopServer(server);
  servers.clear();
});

const operatorCredential = "synthetic-operator-credential-for-unit-tests";
const notifications: NotificationPort = {
  read: async () => ({
    highWater: "0",
    items: [],
    unread: { total: 0, likes: 0, comments: 0, mentions: 0 },
    hasMore: false,
  }),
  markRead: async () => {},
  lookup: async () => ({ items: [] }),
};

/** A closed beta whose allowlist the test can change while sessions exist. */
const closedBeta = (...admitted: string[]) => {
  const accounts = new Set<string>(admitted);
  const policy: Policy = {
    mode: "closed_beta",
    admits: (userId) => accounts.has(userId),
  };
  return { accounts, policy };
};

const start = async (
  policy: Policy | undefined,
  { production = false }: { readonly production?: boolean } = {},
) => {
  const comments = new InMemoryCommunityCommentPort();
  const identity = new InMemoryCommunityIdentityPort(
    undefined,
    undefined,
    comments.events,
  );
  const signals = new NotificationSignals();
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: production ? "production" : "development",
      ...(policy === undefined ? {} : { productAccess: policy }),
      communityIdentityPort: identity,
      communityCommentPort: comments,
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      communityOperatorCredential: operatorCredential,
      authorCommunityPort: {} as AuthorCommunityPort,
      discoveryPort: {
        state: async () => ({
          favorite: false,
          liked: false,
          favoriteCount: 1,
          likeCount: 2,
        }),
      } as unknown as CommunityDiscoveryPort,
      notificationPort: notifications,
      notificationSignals: signals,
      ...(production
        ? {
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }
        : {
            authService: new CommunityAuthService(
              createMemoryCommunityAuthPort(),
              {
                environment: "development",
                profile: "full-local",
                keys: {
                  version: 1,
                  lookupKey: Buffer.alloc(32, 21),
                  encryptionKey: Buffer.alloc(32, 22),
                  otpKey: Buffer.alloc(32, 23),
                },
                emailMode: "local_capture",
                phoneMode: "disabled",
                delivery: {
                  sendEmail: async () => ({ state: "failed" }),
                  sendPhone: async () => ({ state: "failed" }),
                  checkPhone: async () => "fail",
                },
              },
            ),
          }),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  /** A real Backend session for a synthetic account, as a previous sign-in left it. */
  const session = async (handle: string) => {
    const grant = await new CommunitySessionService(
      identity,
    ).signInDevelopmentAccount(handle);
    if (grant === null) throw new Error("Missing synthetic account");
    return grant.token;
  };
  const get = (path: string, token?: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return { base, identity, signals, session, get };
};

const expectApiError = async (
  response: Response,
  status: number,
  code: ApiErrorCode,
) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
};

/** Reads that an anonymous visitor can make in public mode, plus private ones. */
const protectedReads = [
  "/v1/catalog",
  `/v1/catalog/${publishedCatalogId}`,
  "/v1/catalog-search?q=%E7%A2%91",
  `/v1/catalog/${publishedCatalogId}/comments`,
  `/v1/community/content/catalog/${publishedCatalogId}/state`,
  "/v1/community/discover",
  "/v1/community/authors/user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  "/v1/community/works/work-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  "/v1/community/media/user-media-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  "/v1/community/publishing/media/media-item-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01/display/base",
  "/v1/community/editorial/articles",
  "/v1/community/threads",
  "/v1/community/notifications",
  "/v1/community/notifications/stream",
  "/v1/community/auth/account",
  "/v1/community/article-authoring",
  "/v1/not-a-route",
] as const;

describe("product access gate", () => {
  it.each([undefined, { mode: "public", admits: () => false } as Policy])(
    "adds no restriction in public mode",
    async (policy) => {
      const backend = await start(policy);
      const catalog = await backend.get("/v1/catalog");
      expect(catalog.status).toBe(200);
      expect(
        catalogPageSchema.parse(await catalog.json()).items.length,
      ).toBeGreaterThan(0);
      expect(
        (
          await backend.get(
            `/v1/community/content/catalog/${publishedCatalogId}/state`,
          )
        ).status,
      ).toBe(200);
      for (const token of [undefined, await backend.session("dev-user-02")]) {
        const access = await backend.get("/v1/community/access", token);
        expect(access.status).toBe(200);
        expect(productAccessSchema.parse(await access.json())).toEqual({
          mode: "public",
          access: "granted",
        });
      }
    },
  );

  it("answers an anonymous caller with 401 JSON on every protected route and serves no content", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy);
    for (const path of protectedReads)
      await expectApiError(await backend.get(path), 401, "UNAUTHENTICATED");
    // A credential that is not a session is anonymous too.
    await expectApiError(
      await backend.get("/v1/catalog", "not-a-session-token"),
      401,
      "UNAUTHENTICATED",
    );
    await expectApiError(
      await backend.get(
        `/v1/catalog/${publishedCatalogId}/comments`,
        undefined,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "synthetic" }),
        },
      ),
      401,
      "UNAUTHENTICATED",
    );
    const access = await backend.get("/v1/community/access");
    expect(productAccessSchema.parse(await access.json())).toEqual({
      mode: "closed_beta",
      access: "sign_in_required",
    });
    expect(access.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps only the named bootstrap operations reachable without an admitted session", async () => {
    const backend = await start(closedBeta().policy);
    expect((await backend.get("/health")).status).toBe(200);
    expect((await backend.get("/v1/community/auth/capabilities")).status).toBe(
      200,
    );
    const signIn = await backend.get("/v1/development/sign-in", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dev-user-02" }),
    });
    expect(signIn.status).toBe(201);
    const { token } = developmentSessionSchema.parse(await signIn.json());
    // The session owner still learns who is signed in, and can sign out.
    const me = await backend.get("/v1/me", token);
    expect(publicUserProfileSchema.parse(await me.json()).id).toBe(
      fixtureUsers.second.id,
    );
    expect(
      (
        await backend.get("/v1/development/sign-out", token, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    await expectApiError(
      await backend.get("/v1/me", token),
      401,
      "UNAUTHENTICATED",
    );
    // Another method on an open auth path is not an open operation.
    await expectApiError(
      await backend.get("/v1/community/auth/capabilities", undefined, {
        method: "POST",
      }),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("refuses a valid session whose account is not approved with 403 and leaves the session intact", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy);
    const token = await backend.session("dev-user-02");
    for (const path of protectedReads)
      await expectApiError(
        await backend.get(path, token),
        403,
        "ACCESS_RESTRICTED",
      );
    const access = await backend.get("/v1/community/access", token);
    expect(productAccessSchema.parse(await access.json())).toEqual({
      mode: "closed_beta",
      access: "restricted",
    });
    expect((await backend.get("/v1/me", token)).status).toBe(200);
    // Claiming another account in a header changes nothing.
    await expectApiError(
      await backend.get("/v1/catalog", token, {
        headers: { "x-author-account": fixtureUsers.active.id },
      }),
      403,
      "ACCESS_RESTRICTED",
    );
  });

  it("serves an approved account normally, including a representative write", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy);
    const token = await backend.session("dev-user-01");
    const access = await backend.get("/v1/community/access", token);
    expect(productAccessSchema.parse(await access.json())).toEqual({
      mode: "closed_beta",
      access: "granted",
    });
    const catalog = await backend.get("/v1/catalog", token);
    expect(catalog.status).toBe(200);
    const [first] = catalogPageSchema.parse(await catalog.json()).items;
    expect(first).toBeDefined();
    expect((await backend.get(`/v1/catalog/${first!.id}`, token)).status).toBe(
      200,
    );
    const comment = await backend.get(
      `/v1/catalog/${publishedCatalogId}/comments`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "内测评论" }),
      },
    );
    expect(comment.status).toBe(201);
    // Admission adds nothing: an unknown route is still unknown.
    expect((await backend.get("/v1/not-a-route", token)).status).toBe(404);
  });

  it("denies the same already-issued session on the next request after the account is removed", async () => {
    const beta = closedBeta(fixtureUsers.active.id);
    const backend = await start(beta.policy);
    const token = await backend.session("dev-user-01");
    expect((await backend.get("/v1/catalog", token)).status).toBe(200);
    beta.accounts.delete(fixtureUsers.active.id);
    await expectApiError(
      await backend.get("/v1/catalog", token),
      403,
      "ACCESS_RESTRICTED",
    );
    beta.accounts.add(fixtureUsers.active.id);
    expect((await backend.get("/v1/catalog", token)).status).toBe(200);
  });

  it("treats a revoked session and a suspended account as anonymous", async () => {
    const backend = await start(
      closedBeta(fixtureUsers.active.id, fixtureUsers.suspended.id).policy,
    );
    const token = await backend.session("dev-user-01");
    await backend.get("/v1/development/sign-out", token, { method: "POST" });
    await expectApiError(
      await backend.get("/v1/catalog", token),
      401,
      "UNAUTHENTICATED",
    );
    await expect(backend.session("dev-user-03")).rejects.toThrow();
  });

  it("ends an open notification stream at its next identity check once the account is removed", async () => {
    const beta = closedBeta(fixtureUsers.active.id);
    const backend = await start(beta.policy);
    const token = await backend.session("dev-user-01");
    const abort = new AbortController();
    aborts.add(abort);
    const stream = await backend.get(
      "/v1/community/notifications/stream",
      token,
      {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      },
    );
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    beta.accounts.delete(fixtureUsers.active.id);
    // The same check runs on the 15 second heartbeat; a signal runs it now.
    backend.signals.publish([fixtureUsers.active.id]);
    let ended = false;
    for (let reads = 0; reads < 5 && !ended; reads += 1)
      ended = (await reader.read()).done;
    expect(ended).toBe(true);
    await expectApiError(
      await backend.get("/v1/community/notifications/stream", token),
      403,
      "ACCESS_RESTRICTED",
    );
  });

  it("answers a streaming upload it refuses without waiting for the body", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy);
    const path =
      "/v1/community/publishing/uploads/media-component-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
    const body = new Uint8Array(256 * 1024);
    const anonymous = await backend.get(path, undefined, {
      method: "POST",
      body,
    });
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    await expectApiError(anonymous, 401, "UNAUTHENTICATED");
    await expectApiError(
      await backend.get(path, await backend.session("dev-user-02"), {
        method: "POST",
        body,
      }),
      403,
      "ACCESS_RESTRICTED",
    );
  });

  it("leaves the operator boundary to its own credential", async () => {
    const backend = await start(closedBeta().policy);
    const summary = await backend.get(
      "/internal/community/summary",
      undefined,
      {
        headers: { authorization: `Bearer ${operatorCredential}` },
      },
    );
    expect(summary.status).toBe(200);
    // A tester's session is not operator authority, admitted or not.
    const tester = await backend.get(
      "/internal/community/summary",
      await backend.session("dev-user-01"),
    );
    expect(tester.status).toBe(401);
    expect(await tester.json()).toEqual({
      error: { status: 401, code: "OPERATOR_UNAUTHORIZED" },
    });
  });

  it("fails closed while the identity store is unavailable", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy);
    const token = await backend.session("dev-user-01");
    backend.identity.unavailable = true;
    await expectApiError(
      await backend.get("/v1/catalog", token),
      503,
      "SERVICE_UNAVAILABLE",
    );
    await expectApiError(
      await backend.get("/v1/community/access", token),
      503,
      "SERVICE_UNAVAILABLE",
    );
  });

  it("applies the same policy in a production composition", async () => {
    const backend = await start(closedBeta(fixtureUsers.active.id).policy, {
      production: true,
    });
    const comments = `/v1/catalog/${publishedCatalogId}/comments`;
    await expectApiError(await backend.get(comments), 401, "UNAUTHENTICATED");
    // No Development sign-in exists to obtain a session from.
    expect(
      (
        await backend.get("/v1/development/sign-in", undefined, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      (await backend.get(comments, await backend.session("dev-user-01")))
        .status,
    ).toBe(200);
    await expectApiError(
      await backend.get(comments, await backend.session("dev-user-02")),
      403,
      "ACCESS_RESTRICTED",
    );
  });

  it("rejects a query or another method on the access answer", async () => {
    const backend = await start(closedBeta().policy);
    await expectApiError(
      await backend.get("/v1/community/access?user=someone"),
      400,
      "INVALID_QUERY",
    );
    const post = await backend.get("/v1/community/access", undefined, {
      method: "POST",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});
