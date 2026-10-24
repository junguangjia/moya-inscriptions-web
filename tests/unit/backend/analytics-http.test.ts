import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type {
  AnalyticsPort,
  AnalyticsPolicy,
  PublicUserRecord,
} from "@moya/api";
import { publicUserIdSchema } from "@moya/contracts/schemas";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  createTrustedAnalyticsRequestSource,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("analytics HTTP authority", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
    servers.clear();
  });
  const setup = async (userId: string | null = null) => {
    const relay = randomBytes(32).toString("base64url"),
      operator = randomBytes(32).toString("base64url");
    const port: AnalyticsPort = {
      append: vi.fn(async () => 1),
      status: vi.fn(async () => ({
        last24Hours: { events: 0, visitors: 0, users: 0, sessions: 0 },
        outbox: { pending: 0, failed: 0 },
        lastEventAt: null,
        lastForwardedAt: null,
      })),
      recentIps: vi.fn(async () => ({ items: [] })),
      withDeliveryLock: vi.fn(async () => false),
      retain: vi.fn(async () => undefined),
    };
    const identify = vi.fn(async (): Promise<PublicUserRecord | null> =>
      userId === null
        ? null
        : {
            id: publicUserIdSchema.parse(userId),
            handle: "synthetic-user",
            displayName: "Synthetic",
            status: "active",
          },
    );
    const policy: AnalyticsPolicy = {
      enabled: true,
      production: true,
      excludedUserIds: new Set(["synthetic-owner", "synthetic-test"]),
      ownerExclusionConfigured: true,
      hmacKey: randomBytes(32).toString("base64url"),
      forwardingConfigured: false,
      eventRetentionDays: 180,
    };
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "production",
        productAccess: { mode: "closed_beta", admits: async () => false },
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
        analytics: {
          port,
          policy,
          source: createTrustedAnalyticsRequestSource(relay),
        },
        communityOperatorCredential: operator,
        communityIdentityPort: {
          findDevelopmentAccountByHandle: async () => null,
          createSession: async () => undefined,
          findSessionUser: identify,
          revokeSession: async () => false,
          setUserStatus: async () => null,
        },
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      visitorId: randomUUID(),
      sessionId: randomUUID(),
      events: [
        {
          eventId: randomUUID(),
          name: "page_view",
          surface: "home",
          occurredAt: new Date().toISOString(),
        },
      ],
    };
    const send = (
      headers: Record<string, string> = {},
      input: unknown = body,
    ) =>
      fetch(`${origin}/v1/analytics/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0",
          ...headers,
        },
        body: JSON.stringify(input),
      });
    const trusted = {
      "x-moya-analytics-relay": relay,
      "x-moya-analytics-source": "::ffff:192.0.2.1",
    };
    return { port, identify, operator, origin, body, send, trusted };
  };
  it("admits bounded anonymous telemetry through its own relay even in closed beta, with no auth service dependency", async () => {
    const h = await setup();
    const response = await h.send(h.trusted);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, excluded: false });
    expect(vi.mocked(h.port.append).mock.calls[0]![1]).toMatchObject({
      ip: "192.0.2.1",
      userAgent: "Mozilla/5.0",
      userId: null,
    });
    expect(h.identify).not.toHaveBeenCalled();
    expect((await fetch(`${h.origin}/v1/catalog`)).status).toBe(401);
  });
  it("refuses direct, XFF and malformed-source claims, and rejects body identity", async () => {
    const h = await setup();
    for (const headers of [
      {},
      { "x-forwarded-for": "192.0.2.1" },
      { ...h.trusted, "x-moya-analytics-source": "192.0.2.1,192.0.2.2" },
      {
        ...h.trusted,
        "x-moya-analytics-relay": randomBytes(32).toString("base64url"),
      },
    ])
      expect((await h.send(headers)).status).toBe(401);
    expect(
      (await h.send(h.trusted, { ...h.body, userId: "forged" })).status,
    ).toBe(400);
    expect(h.port.append).not.toHaveBeenCalled();
  });
  it("resolves signed-in immutable identity once per batch and excludes owner/test before analytics persistence", async () => {
    for (const userId of [
      "synthetic-owner",
      "synthetic-test",
      "synthetic-reader",
    ]) {
      const h = await setup(userId);
      const response = await h.send({
        ...h.trusted,
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      });
      expect(response.status).toBe(202);
      expect(h.identify).toHaveBeenCalledTimes(1);
      expect(await response.json()).toEqual({
        accepted: userId === "synthetic-reader" ? 1 : 0,
        excluded: userId !== "synthetic-reader",
      });
      expect(h.port.append).toHaveBeenCalledTimes(
        userId === "synthetic-reader" ? 1 : 0,
      );
    }
  });
  it("device opt-out requires trusted relay and avoids session lookup and all writes", async () => {
    const h = await setup("synthetic-reader");
    expect((await h.send({ "x-moya-analytics-excluded": "1" })).status).toBe(
      401,
    );
    const response = await h.send({
      ...h.trusted,
      "x-moya-analytics-excluded": "1",
      authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
    });
    expect(await response.json()).toEqual({ accepted: 0, excluded: true });
    expect(h.identify).not.toHaveBeenCalled();
    expect(h.port.append).not.toHaveBeenCalled();
  });
  it("protects private status and raw-IP access behind separate Owner authority", async () => {
    const h = await setup();
    for (const suffix of ["status", "ips"]) {
      const url = `${h.origin}/internal/community/analytics/${suffix}`;
      expect((await fetch(url)).status).toBe(401);
      expect(
        (
          await fetch(url, {
            headers: {
              authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
            },
          })
        ).status,
      ).toBe(401);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${h.operator}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(h.port.status).toHaveBeenCalledTimes(1);
    expect(h.port.recentIps).toHaveBeenCalledTimes(1);
  });
});
