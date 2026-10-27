import { CommunitySessionService } from "@moya/api";
import {
  developmentSessionSchema,
  publicUserProfileSchema,
} from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

import {
  fixtureUsers,
  InMemoryCommunityIdentityPort,
} from "./community-identity-fixture.js";

const hour = 60 * 60 * 1_000;

const createService = (
  options: {
    readonly now?: Date;
    readonly ttlMs?: number;
    readonly port?: InMemoryCommunityIdentityPort;
  } = {},
) => {
  const port = options.port ?? new InMemoryCommunityIdentityPort();
  let now = options.now ?? new Date("2026-09-12T03:00:00.000Z");
  const service = new CommunitySessionService(port, {
    clock: () => now,
    sessionTtlMs: options.ttlMs ?? 24 * hour,
  });
  return {
    port,
    service,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};

describe("CommunitySessionService", () => {
  it("issues a Backend session for an active Development account and identifies its owner", async () => {
    const { port, service } = createService();
    const session = await service.signInDevelopmentAccount("dev-user-01");
    expect(session).not.toBeNull();
    expect(developmentSessionSchema.parse(session)).toEqual(session);
    expect(session?.profile).toEqual({
      id: fixtureUsers.active.id,
      handle: "dev-user-01",
      displayName: "拓片爱好者",
    });
    expect(session?.expiresAt).toBe("2026-09-13T03:00:00.000Z");
    expect(Object.keys(session?.profile ?? {})).not.toContain("status");

    const stored = [...port.sessions.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.tokenHash).not.toBe(session?.token);
    expect(stored[0]?.id).toMatch(/^session-[0-9a-f]{32}$/);
    expect(stored[0]?.userId).toBe(fixtureUsers.active.id);
    expect(JSON.stringify(stored)).not.toContain(session!.token);

    const profile = await service.identify(session!.token);
    expect(publicUserProfileSchema.parse(profile)).toEqual(session?.profile);
  });

  it("issues distinct opaque tokens for repeated sign-ins", async () => {
    const { service } = createService();
    const first = await service.signInDevelopmentAccount("dev-user-01");
    const second = await service.signInDevelopmentAccount("dev-user-01");
    expect(first?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second?.token).not.toBe(first?.token);
    expect(await service.identify(first!.token)).not.toBeNull();
    expect(await service.identify(second!.token)).not.toBeNull();
  });

  it("refuses unknown handles, ordinary users and suspended accounts", async () => {
    const { service } = createService();
    expect(await service.signInDevelopmentAccount("nobody-99")).toBeNull();
    expect(await service.signInDevelopmentAccount("member-04")).toBeNull();
    expect(await service.signInDevelopmentAccount("dev-user-03")).toBeNull();
  });

  it("expires sessions absolutely at the issued lifetime", async () => {
    const { service, advance } = createService({ ttlMs: 2 * hour });
    const session = await service.signInDevelopmentAccount("dev-user-01");
    advance(2 * hour - 1);
    expect(await service.identify(session!.token)).not.toBeNull();
    advance(1);
    expect(await service.identify(session!.token)).toBeNull();
    expect(await service.signOut(session!.token)).toBe(false);
  });

  it("revokes on sign-out and never revives a revoked session", async () => {
    const { service } = createService();
    const session = await service.signInDevelopmentAccount("dev-user-01");
    expect(await service.signOut(session!.token)).toBe(true);
    expect(await service.identify(session!.token)).toBeNull();
    expect(await service.signOut(session!.token)).toBe(false);
  });

  it("keeps accounts isolated: a token identifies only its owner and forged tokens identify nobody", async () => {
    const { service, port } = createService();
    const first = await service.signInDevelopmentAccount("dev-user-01");
    const second = await service.signInDevelopmentAccount("dev-user-02");
    expect((await service.identify(first!.token))?.id).toBe(
      fixtureUsers.active.id,
    );
    expect((await service.identify(second!.token))?.id).toBe(
      fixtureUsers.second.id,
    );
    expect(await service.signOut(first!.token)).toBe(true);
    expect(await service.identify(second!.token)).not.toBeNull();

    const forged = `${first!.token.slice(0, 42)}${first!.token.endsWith("A") ? "B" : "A"}`;
    expect(await service.identify(forged)).toBeNull();
    for (const malformed of ["", "short", `${second!.token}x`, "Bearer x"])
      expect(await service.identify(malformed)).toBeNull();
    expect(port.sessions.size).toBe(2);
  });

  it("stops identifying a user who is suspended after issuance", async () => {
    const { service, port } = createService();
    const session = await service.signInDevelopmentAccount("dev-user-01");
    port.setStatus(fixtureUsers.active.id, "suspended");
    expect(await service.identify(session!.token)).toBeNull();
  });

  it("treats a deleted account's unrevoked session as signed out", async () => {
    const { service, port } = createService();
    const session = await service.signInDevelopmentAccount("dev-user-01");
    port.setStatus(fixtureUsers.active.id, "deleted");
    expect(await service.identify(session!.token)).toBeNull();
    expect(await service.signInDevelopmentAccount("dev-user-01")).toBeNull();
  });

  it("bounds the session lifetime", () => {
    const port = new InMemoryCommunityIdentityPort();
    for (const sessionTtlMs of [0, -1, 1.5, 31 * 24 * hour])
      expect(() => new CommunitySessionService(port, { sessionTtlMs })).toThrow(
        "Session lifetime",
      );
  });
});
