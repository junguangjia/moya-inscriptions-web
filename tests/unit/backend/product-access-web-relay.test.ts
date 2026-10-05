import { CommunitySessionService } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  catalogPageSchema,
  contentStateSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as catalogList } from "../../../apps/web/app/api/catalog/route";
import { GET as catalogSearch } from "../../../apps/web/app/api/catalog-search/route";
import {
  fetchServerProductAccess,
  relayServerAuthorCommunity,
} from "../../../apps/web/lib/public-api/server";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

import type { AuthorCommunityPort, CommunityDiscoveryPort } from "@moya/api";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
import type { Server } from "node:http";

// Mock only Web's compile-time server boundary poison in this Node transport test.
vi.mock("../../../apps/web/node_modules/server-only/index.js", () => ({}));

type Policy = NonNullable<BackendApplicationOptions["productAccess"]>;

const servers = new Set<Server>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers) await stopServer(server);
  servers.clear();
});

const web = "http://web.invalid";
const statePath = "/api/community/content/catalog/catalog-test/state";

/**
 * The real Backend application behind Web's own relays and route handlers, so
 * the two halves of the policy are exercised together: Web forwards the
 * visitor's session cookie and the Backend decides.
 */
const start = async (policy: Policy) => {
  const identity = new InMemoryCommunityIdentityPort();
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      productAccess: policy,
      communityIdentityPort: identity,
      authorCommunityPort: {} as AuthorCommunityPort,
      catalogPublicationPort: {
        isPublished: async () => true,
        readTitle: async () => "Synthetic catalog",
      },
      discoveryPort: {
        state: async () => ({
          favorite: false,
          liked: false,
          favoriteCount: 1,
          likeCount: 2,
        }),
      } as unknown as CommunityDiscoveryPort,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  vi.stubEnv(
    "MOYA_PUBLIC_API_BASE_URL",
    `http://${address.address}:${address.port}`,
  );
  const sessions = new CommunitySessionService(identity);
  /** The browser's cookie header for a synthetic account's real Backend session. */
  const cookieFor = async (handle: string) => {
    const grant = await sessions.signInDevelopmentAccount(handle);
    if (grant === null) throw new Error("Missing synthetic account");
    return { cookie: `yoyi-session=${grant.token}`, token: grant.token };
  };
  const visit = (cookie?: string) => {
    const request = (path: string) =>
      new Request(`${web}${path}`, {
        headers: cookie === undefined ? {} : { cookie },
      });
    return {
      list: () => catalogList(request("/api/catalog")),
      search: () => catalogSearch(request("/api/catalog-search?q=%E7%A2%91")),
      state: () => relayServerAuthorCommunity(request(statePath)),
    };
  };
  return { cookieFor, visit };
};

const closedBeta = (...admitted: string[]) => {
  const accounts = new Set<string>(admitted);
  const policy: Policy = {
    mode: "closed_beta",
    admits: (userId) => accounts.has(userId),
  };
  return { accounts, policy };
};

const expectNeverStored = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
};

describe("Web relays in front of a closed-beta Backend", () => {
  it("gives an anonymous visitor no product data through any relay", async () => {
    const { visit } = await start(closedBeta(fixtureUsers.active.id).policy);
    await expect(fetchServerProductAccess(undefined)).resolves.toEqual({
      state: "success",
      access: { mode: "closed_beta", access: "sign_in_required" },
    });
    const visitor = visit();
    for (const response of [await visitor.list(), await visitor.search()]) {
      expect(response.status).toBe(401);
      expectNeverStored(response);
      expect(await response.text()).toBe("");
    }
    const state = await visitor.state();
    expect(state.status).toBe(401);
    expectNeverStored(state);
    expect(apiErrorSchema.parse(await state.json()).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("refuses a signed-in account that is not approved with 403 and never signs it out", async () => {
    const { cookieFor, visit } = await start(
      closedBeta(fixtureUsers.active.id).policy,
    );
    const { cookie, token } = await cookieFor("dev-user-02");
    await expect(fetchServerProductAccess(token)).resolves.toEqual({
      state: "success",
      access: { mode: "closed_beta", access: "restricted" },
    });
    const visitor = visit(cookie);
    for (const response of [await visitor.list(), await visitor.search()]) {
      expect(response.status).toBe(403);
      expectNeverStored(response);
      expect(await response.text()).toBe("");
    }
    const state = await visitor.state();
    expect(state.status).toBe(403);
    expect(apiErrorSchema.parse(await state.json()).error.code).toBe(
      "ACCESS_RESTRICTED",
    );
    // The session is valid: Web keeps the cookie so the visitor can sign out.
    expect(state.headers.get("set-cookie")).toBeNull();
  });

  it("serves an approved account, then refuses the same cookie once the account is removed", async () => {
    const beta = closedBeta(fixtureUsers.active.id);
    const { cookieFor, visit } = await start(beta.policy);
    const { cookie, token } = await cookieFor("dev-user-01");
    await expect(fetchServerProductAccess(token)).resolves.toMatchObject({
      access: { access: "granted" },
    });
    const visitor = visit(cookie);
    const list = await visitor.list();
    expect(list.status).toBe(200);
    expectNeverStored(list);
    expect(
      catalogPageSchema.parse(await list.json()).items.length,
    ).toBeGreaterThan(0);
    expect((await visitor.search()).status).toBe(200);
    const state = await visitor.state();
    expect(state.status).toBe(200);
    expect(contentStateSchema.parse(await state.json()).likeCount).toBe(2);

    beta.accounts.delete(fixtureUsers.active.id);
    expect((await visitor.list()).status).toBe(403);
    expect((await visitor.search()).status).toBe(403);
    expect((await visitor.state()).status).toBe(403);
    await expect(fetchServerProductAccess(token)).resolves.toMatchObject({
      access: { access: "restricted" },
    });
  });

  it("treats a cookie the Backend no longer accepts as signed out, as before", async () => {
    const { visit } = await start(closedBeta(fixtureUsers.active.id).policy);
    const visitor = visit(`yoyi-session=${"x".repeat(43)}`);
    expect((await visitor.list()).status).toBe(401);
    const state = await visitor.state();
    expect(state.status).toBe(401);
    // The existing relay rule: a refused session's cookie is cleared.
    expect(state.headers.get("set-cookie")).toContain("yoyi-session=;");
  });

  it("adds nothing in public mode", async () => {
    const { cookieFor, visit } = await start({
      mode: "public",
      admits: () => false,
    });
    await expect(fetchServerProductAccess(undefined)).resolves.toEqual({
      state: "success",
      access: { mode: "public", access: "granted" },
    });
    for (const visitor of [
      visit(),
      visit((await cookieFor("dev-user-02")).cookie),
    ]) {
      expect((await visitor.list()).status).toBe(200);
      expect((await visitor.search()).status).toBe(200);
      expect((await visitor.state()).status).toBe(200);
    }
  });
});
