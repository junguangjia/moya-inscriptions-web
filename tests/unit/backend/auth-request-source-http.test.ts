import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityAuthService, createMemoryCommunityAuthPort } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  createTrustedAuthRequestSource,
  startServer,
  stopServer,
} from "@moya/backend-runtime";

describe("Production authentication source through its dedicated relay", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
    servers.clear();
  });
  const setup = async (configured = true) => {
    const relay = randomBytes(32).toString("base64url");
    let sends = 0;
    const service = new CommunityAuthService(createMemoryCommunityAuthPort(), {
      environment: "production",
      profile: "email-first",
      keys: {
        version: 1,
        lookupKey: randomBytes(32),
        encryptionKey: randomBytes(32),
        otpKey: randomBytes(32),
      },
      emailMode: "provider",
      phoneMode: "disabled",
      registrationAgreement: {
        version: "synthetic",
        title: "SYNTHETIC",
        body: "NOT APPROVED: test only.",
      },
      delivery: {
        sendEmail: async () => {
          sends++;
          return { state: "accepted", correlation: "synthetic" };
        },
        sendPhone: async () => ({ state: "failed" }),
        checkPhone: async () => "fail",
      },
    });
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "production",
        authService: service,
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
        ...(configured
          ? { authRequestSource: createTrustedAuthRequestSource(relay) }
          : {}),
        communityIdentityPort: {
          findDevelopmentAccountByHandle: async () => null,
          createSession: async () => undefined,
          findSessionUser: async () => null,
          revokeSession: async () => false,
          setUserStatus: async () => null,
        },
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;
    const send = (
      source: string,
      index: number,
      credentials: Record<string, string> = { "x-moya-auth-relay": relay },
    ) =>
      fetch(`${origin}/v1/community/auth/challenges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moya-auth-source": source,
          ...credentials,
        },
        body: JSON.stringify({
          channel: "email",
          purpose: "register",
          identifier: `synthetic-source-${index}@example.invalid`,
          idempotencyKey: randomUUID(),
        }),
      });
    return { origin, relay, send, sends: () => sends };
  };

  it("accepts 21 distinct real ingress IPs through the same Backend peer", async () => {
    const h = await setup();
    for (let i = 1; i <= 21; i++)
      expect((await h.send(`192.0.2.${i}`, i)).status).toBe(200);
    expect(h.sends()).toBe(21);
  });
  it("preserves the 20-attempt limit for one source and canonical IPv4 aliases", async () => {
    const h = await setup();
    for (let i = 1; i <= 20; i++)
      expect(
        (await h.send(i % 2 ? "192.0.2.99" : "::ffff:c000:263", i)).status,
      ).toBe(200);
    const limited = await h.send("::ffff:192.0.2.99", 21);
    expect(limited.status).toBe(409);
    expect((await limited.json()).error.message).toBe("AUTH_RATE_LIMITED");
    expect(h.sends()).toBe(20);
  });
  it("uses the same resolved source for password budgets without allowing XFF rotation", async () => {
    const h = await setup();
    const login = (source: string, index: number) =>
      fetch(`${h.origin}/v1/community/auth/passwords/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-moya-auth-relay": h.relay,
          "x-moya-auth-source": source,
          "x-forwarded-for": `203.0.113.${index}`,
        },
        body: JSON.stringify({
          channel: "email",
          identifier: `synthetic-missing-${index}@example.invalid`,
          password: "SYNTHETIC_password_A1",
          idempotencyKey: randomUUID(),
        }),
      });
    for (let i = 1; i <= 21; i++)
      expect((await login(`198.51.100.${i}`, i)).status).toBe(401);
    for (let i = 1; i <= 20; i++)
      expect((await login("192.0.2.88", i + 30)).status).toBe(401);
    const limited = await login("192.0.2.88", 70);
    expect(limited.status).toBe(409);
    expect((await limited.json()).error.message).toBe("AUTH_RATE_LIMITED");
  }, 30000);
  it("denies direct loopback spoofing, duplicate/folded headers, and malformed IPs before sends", async () => {
    const h = await setup();
    for (const credentials of [
      {},
      { "x-moya-auth-relay": randomBytes(32).toString("base64url") },
      { "x-forwarded-for": "192.0.2.7", forwarded: "for=192.0.2.7" },
    ])
      expect((await h.send("192.0.2.7", 1, credentials)).status).toBe(401);
    for (const source of [
      "192.0.2.7, 192.0.2.8",
      "::1%lo0",
      "192.000.2.7",
      "192.0.2.7:80",
      "unknown",
      "::1 folded",
    ])
      expect((await h.send(source, 1)).status).toBe(401);
    const duplicate = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${h.origin}/v1/community/auth/challenges`,
        {
          method: "POST",
          headers: [
            "host",
            new URL(h.origin).host,
            "content-type",
            "application/json",
            "x-moya-auth-relay",
            h.relay,
            "x-moya-auth-source",
            "192.0.2.7",
            "X-Moya-Auth-Source",
            "192.0.2.8",
          ],
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(duplicate).toBe(401);
    for (const suffix of [
      "challenges/verify",
      "registrations",
      "passwords/reset",
      "passwords/login",
      "factors/complete",
    ])
      expect(
        (
          await fetch(`${h.origin}/v1/community/auth/${suffix}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "192.0.2.7",
            },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    expect(h.sends()).toBe(0);
  });
  it("fails closed without configured forwarding while capabilities remain readable", async () => {
    const h = await setup(false);
    expect((await h.send("192.0.2.7", 1)).status).toBe(401);
    expect(
      (await fetch(`${h.origin}/v1/community/auth/capabilities`)).status,
    ).toBe(200);
    expect(h.sends()).toBe(0);
    for (const value of [undefined, "", "placeholder", "x".repeat(129)])
      expect(() => createTrustedAuthRequestSource(value)).toThrow(
        "AUTH_SOURCE_RELAY_TOKEN",
      );
  });
});
