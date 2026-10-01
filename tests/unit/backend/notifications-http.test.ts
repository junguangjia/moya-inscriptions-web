import type { NotificationPort } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  NotificationSignals,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { developmentSessionSchema } from "@moya/contracts/schemas";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";
const servers = new Set<Server>();
const aborts = new Set<AbortController>();
afterEach(async () => {
  for (const abort of aborts) abort.abort();
  aborts.clear();
  for (const server of servers) await stopServer(server);
  servers.clear();
});
const store: NotificationPort = {
  read: async () => ({
    highWater: "0",
    items: [],
    unread: { total: 0, likes: 0, comments: 0, mentions: 0 },
    hasMore: false,
  }),
  markRead: async () => {},
  lookup: async () => ({ items: [] }),
};
async function start(production = false) {
  const identity = new InMemoryCommunityIdentityPort(),
    signals = new NotificationSignals();
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: production ? "production" : "development",
      communityIdentityPort: identity,
      notificationPort: store,
      notificationSignals: signals,
      ...(production
        ? {
            catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
            storageUrlResolver: new UnconfiguredStorageUrlResolver(),
          }
        : {}),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 }),
    base = `http://${address.address}:${address.port}`;
  const signIn = async () => {
    const response = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dev-user-01" }),
    });
    return developmentSessionSchema.parse(await response.json()).token;
  };
  return { identity, signals, base, signIn };
}
describe("notification HTTP and actual SSE sockets", () => {
  it("requires session truth, rejects forged cursor/recipient/query/body and is absent in Production", async () => {
    const { base, signIn } = await start(),
      token = await signIn(),
      headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/v1/community/notifications`)).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${base}/v1/community/notifications`, {
          headers: { ...headers, "x-author-account": fixtureUsers.second.id },
        })
      ).status,
    ).toBe(401);
    for (const suffix of [
      "?recipient=someone",
      "?cursor=forged",
      "?limit=51",
      "?limit=1&limit=2",
    ])
      expect(
        (
          await fetch(`${base}/v1/community/notifications${suffix}`, {
            headers,
          })
        ).status,
      ).toBe(422);
    expect(
      (
        await fetch(`${base}/v1/community/notifications/read`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await fetch(`${base}/v1/community/notifications/stream?token=forged`, {
          headers,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await fetch(`${base}/v1/community/notifications/stream`, {
          headers: { ...headers, "last-event-id": "other" },
        })
      ).status,
    ).toBe(422);
    const production = await start(true);
    for (const suffix of [
      "notifications",
      "notifications/stream",
      "mentions?q=dev",
    ])
      expect(
        (await fetch(`${production.base}/v1/community/${suffix}`, { headers }))
          .status,
      ).toBe(404);
  });
  it("streams private refresh only after authentication; scopes fan-out, bounds sockets, and rejects a revoked old socket before its next emit", async () => {
    const { base, signIn, identity, signals } = await start(),
      token = await signIn();
    const streams = [];
    for (let i = 0; i < 4; i++) {
      const abort = new AbortController();
      aborts.add(abort);
      const response = await fetch(
        `${base}/v1/community/notifications/stream`,
        { headers: { authorization: `Bearer ${token}` }, signal: abort.signal },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toBe(
        "event: refresh\ndata: {}\n\n",
      );
      streams.push(reader);
    }
    expect(
      (
        await fetch(`${base}/v1/community/notifications/stream`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(503);
    const first = streams[0]!.read();
    signals.publish([fixtureUsers.second.id]);
    const outcome = await Promise.race([
      first.then(() => "unexpected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("scoped"), 25)),
    ]);
    expect(outcome).toBe("scoped");
    for (const session of identity.sessions.values())
      session.revokedAt = new Date();
    signals.publish([fixtureUsers.active.id]);
    expect((await first).done).toBe(true);
    for (const reader of streams.slice(1))
      expect((await reader.read()).done).toBe(true);
    expect(
      (
        await fetch(`${base}/v1/community/notifications`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });
  it("disconnects a suspended idle session on the 15-second control heartbeat", async () => {
    const { base, signIn, identity } = await start(),
      token = await signIn();
    const abort = new AbortController();
    aborts.add(abort);
    const response = await fetch(`${base}/v1/community/notifications/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      }),
      reader = response.body!.getReader();
    await reader.read();
    const before = performance.now();
    identity.setStatus(fixtureUsers.active.id, "suspended");
    expect((await reader.read()).done).toBe(true);
    expect(performance.now() - before).toBeLessThan(16_500);
  }, 20_000);
});
