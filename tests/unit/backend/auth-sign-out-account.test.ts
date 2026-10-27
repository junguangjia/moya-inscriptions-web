import { randomUUID } from "node:crypto";

import { CommunityAuthService, createMemoryCommunityAuthPort } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { apiErrorSchema } from "@moya/contracts/schemas";
import { afterEach, describe, expect, it } from "vitest";

import type { Server } from "node:http";

/*
 * account-switching-v1: a sign-out names the account the page shows. When
 * another tab has made a different account current, the presented session
 * belongs to that account and must not be signed out from the stale page.
 * Synthetic accounts and local-capture codes only.
 */
const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all([...servers].map((server) => stopServer(server)));
  servers.clear();
});

const start = async () => {
  const codes: string[] = [];
  const port = createMemoryCommunityAuthPort();
  const service = new CommunityAuthService(port, {
    environment: "development",
    profile: "full-local",
    keys: {
      version: 1,
      lookupKey: Buffer.alloc(32, 31),
      encryptionKey: Buffer.alloc(32, 32),
      otpKey: Buffer.alloc(32, 33),
    },
    emailMode: "local_capture",
    phoneMode: "disabled",
    delivery: {
      sendEmail: async (input) => {
        codes.push(input.code);
        return { state: "accepted", correlation: "synthetic-sign-out" };
      },
      sendPhone: async () => ({ state: "failed" }),
      checkPhone: async () => "fail",
    },
  });
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      authService: service,
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
  const register = async (identifier: string, displayName: string) => {
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier,
      idempotencyKey: randomUUID(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("challenge refused");
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: codes.at(-1)!,
      continuationToken: sent.value.continuationToken,
      idempotencyKey: randomUUID(),
    });
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw new Error("verification refused");
    const registered = await service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName,
      agreement: true,
      idempotencyKey: randomUUID(),
    });
    if (!registered.ok) throw new Error(registered.reason);
    return registered.value;
  };
  const signOut = (token: string, account?: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/community/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(account === undefined ? {} : { "x-author-account": account }),
      },
      body: "{}",
    });
  return { service, port, register, signOut };
};

describe("Backend sign-out with an account assertion (account-switching-v1)", () => {
  it("refuses a session of another account with a distinct conflict and keeps it signed in", async () => {
    const { service, register, signOut } = await start();
    const current = await register("switch-a@example.invalid", "账号甲");
    const other = await register("switch-b@example.invalid", "账号乙");

    const refused = await signOut(current.token, other.profile.id);
    expect(refused.status).toBe(409);
    const body = apiErrorSchema.parse(await refused.json());
    expect(body.error).toMatchObject({
      code: "CONFLICT",
      message: "AUTH_ACCOUNT_MISMATCH",
    });
    expect((await service.readAccount(current.token)).ok).toBe(true);

    expect((await signOut(current.token, current.profile.id)).status).toBe(204);
    expect(await service.readAccount(current.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
  });

  it("keeps the existing sign-out without an assertion and answers a revoked session as before", async () => {
    const { service, register, signOut } = await start();
    const session = await register("switch-c@example.invalid", "账号丙");
    expect((await signOut(session.token)).status).toBe(204);
    expect((await service.readAccount(session.token)).ok).toBe(false);
    // A session that is no longer accepted reads as unauthenticated, with or
    // without an assertion; the mismatch check never hides that answer.
    const again = await signOut(session.token, `user-${"e".repeat(32)}`);
    expect(again.status).toBe(401);
    expect(apiErrorSchema.parse(await again.json()).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("answers an asserted sign-out of a suspended account's session with that refusal and signs nothing out", async () => {
    const { service, port, register, signOut } = await start();
    const session = await register("switch-d@example.invalid", "账号丁");
    port.setStatus(session.profile.id, "suspended");
    const refused = await signOut(session.token, session.profile.id);
    expect(refused.status).toBe(401);
    expect(apiErrorSchema.parse(await refused.json()).error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "AUTH_ACCOUNT_SUSPENDED",
    });
    // The session itself was not ended: reinstated, it is accepted again.
    port.setStatus(session.profile.id, "active");
    expect((await service.readAccount(session.token)).ok).toBe(true);
    // Without an assertion the existing sign-out is unchanged.
    port.setStatus(session.profile.id, "suspended");
    expect((await signOut(session.token)).status).toBe(204);
    port.setStatus(session.profile.id, "active");
    expect(await service.readAccount(session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
  });
});
