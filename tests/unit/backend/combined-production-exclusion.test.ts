/**
 * parallel-community-integration-qa: each track proves that Production omits its
 * own routes with its own port in isolation. This proves it for the COMBINED
 * composition, where application.ts wires A's authentication, N's notifications
 * and C's editorial reads, Threads and direct messages together.
 *
 * The Development control composes the same options and must mount every probe,
 * so a wrong path cannot make the Production assertions pass vacuously.
 */
import type {
  AuthorCommunityPort,
  CommunityAuthService,
  DirectMessagePort,
  EditorialContentReadPort,
  NotificationPort,
  ThreadPort,
} from "@moya/api";
import {
  NotificationSignals,
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

// Never called in Production: those ports are not composed there. C's editorial,
// Thread and direct-message routes are dispatched through the author handler,
// so the author port is part of the combined composition, as in Development.
const combined = {
  authorCommunityPort: {} as unknown as AuthorCommunityPort,
  notificationPort: {} as unknown as NotificationPort,
  notificationSignals: new NotificationSignals(),
  editorialContentPort: {} as unknown as EditorialContentReadPort,
  threadPort: {} as unknown as ThreadPort,
  directMessagePort: {} as unknown as DirectMessagePort,
};
const shared = {
  communityIdentityPort: new InMemoryCommunityIdentityPort(),
  catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
  storageUrlResolver: new UnconfiguredStorageUrlResolver(),
};

// Every Development-only route the three tracks added, plus the sign-in entry.
const probes: readonly (readonly [method: string, path: string])[] = [
  ["GET", "/v1/community/auth/capabilities"],
  ["GET", "/v1/community/auth/account"],
  ["POST", "/v1/community/auth/challenges"],
  ["GET", "/v1/community/notifications"],
  ["GET", "/v1/community/notifications/stream"],
  ["GET", "/v1/community/mentions?q=dev"],
  ["GET", "/v1/community/editorial/articles"],
  ["GET", "/v1/community/editorial/collections"],
  ["GET", "/v1/community/threads"],
  ["GET", "/v1/community/messages"],
  ["GET", "/v1/community/messages/unread"],
  ["POST", "/v1/development/sign-in"],
];

const statusesOf = async (
  options: Parameters<typeof createBackendApplication>[0],
) => {
  const server = createBackendServer(createBackendApplication(options));
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const statuses: Record<string, number> = {};
  for (const [method, path] of probes) {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(2000),
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    }).catch(() => null);
    statuses[`${method} ${path}`] = response?.status ?? 0;
    await response?.body?.cancel().catch(() => undefined);
  }
  return statuses;
};

describe("combined A/N/C Production exclusion", () => {
  it("refuses Track A authentication in a Production composition", () => {
    expect(() =>
      createBackendApplication({
        nodeEnv: "production",
        ...shared,
        ...combined,
        authService: {} as unknown as CommunityAuthService,
      }),
    ).toThrow(/not composed in production/u);
  });

  it("mounts every combined route in Development (control) and none in Production", async () => {
    const development = await statusesOf({
      nodeEnv: "development",
      ...shared,
      ...combined,
      authService: {} as unknown as CommunityAuthService,
    });
    for (const [probe, status] of Object.entries(development))
      expect(status, `Development should mount ${probe}`).not.toBe(404);

    const production = await statusesOf({
      nodeEnv: "production",
      ...shared,
      ...combined,
    });
    for (const [probe, status] of Object.entries(production))
      expect(status, `Production must not expose ${probe}`).toBe(404);
  });
});
