import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  hashSessionToken,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthDeliveryPorts, CommunityAuthServiceOptions } from "@moya/api";

/*
 * account-deletion-v1 (Issue #351 r2) deletion core: CommunityAuthService
 * .deleteAccount over the in-memory port, and the Backend route
 * POST /v1/community/auth/account/deletion. Deletion needs the confirmed
 * account's live Session and a fresh single-use re-verification bound to it;
 * it revokes every Session, frees every contact and is final. Every account,
 * contact, code and token here is synthetic and stays in test memory.
 */

const keys = {
  version: 1,
  lookupKey: Buffer.alloc(32, 31),
  encryptionKey: Buffer.alloc(32, 32),
  otpKey: Buffer.alloc(32, 33),
};
const source = "synthetic-deletion-case";
const codes: string[] = [];
const delivery = (): AuthDeliveryPorts => ({
  sendEmail: async (input) => {
    codes.push(input.code);
    return { state: "accepted", correlation: "synthetic-deletion-mail" };
  },
  sendPhone: async (input) => {
    if (input.code !== null) codes.push(input.code);
    return { state: "accepted", correlation: "synthetic-deletion-sms" };
  },
  checkPhone: async () => "fail",
});
const key = () => randomUUID();
const latestCode = () => {
  const code = codes.at(-1);
  if (code === undefined) throw new Error("no synthetic code");
  return code;
};
const foreignToken = () =>
  Buffer.from(randomUUID() + randomUUID())
    .toString("base64url")
    .slice(0, 43);

const harness = (overrides: Partial<CommunityAuthServiceOptions> = {}) => {
  let now = new Date("2026-10-27T08:00:00.000Z");
  const port = createMemoryCommunityAuthPort();
  const service = new CommunityAuthService(port, {
    environment: "development",
    profile: "full-local",
    keys,
    emailMode: "local_capture",
    phoneMode: "simulated",
    delivery: delivery(),
    clock: () => now,
    ...overrides,
  });
  return {
    port,
    service,
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};
type Harness = ReturnType<typeof harness>;

const proveCode = async (
  h: Harness,
  input: Parameters<CommunityAuthService["sendChallenge"]>[0],
) => {
  const sent = await h.service.sendChallenge(input);
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw new Error(sent.ok ? "missing continuation" : sent.reason);
  const verified = await h.service.verifyChallenge({
    challengeId: sent.value.challengeId,
    code: latestCode(),
    continuationToken: sent.value.continuationToken,
    idempotencyKey: key(),
  });
  if (!verified.ok) throw new Error(verified.reason);
  return verified.value;
};

const register = async (h: Harness, identifier: string, password?: string) => {
  const proof = await proveCode(h, {
    channel: "email",
    purpose: "register",
    identifier,
    idempotencyKey: key(),
    source,
  });
  if (proof.outcome !== "registration_required") throw new Error(proof.outcome);
  const registered = await h.service.confirmRegistration({
    handoffToken: proof.handoffToken,
    displayName: "Synthetic owner",
    studioName: "合成斋",
    agreement: true,
    idempotencyKey: key(),
    ...(password === undefined ? {} : { password }),
  });
  if (!registered.ok) throw new Error(registered.reason);
  return registered.value;
};

const signIn = async (h: Harness, identifier: string) => {
  const proof = await proveCode(h, {
    channel: "email",
    purpose: "sign_in",
    identifier,
    idempotencyKey: key(),
    source,
  });
  if (proof.outcome !== "signed_in") throw new Error(proof.outcome);
  return proof.session;
};

const reauthenticate = async (h: Harness, sessionToken: string) => {
  const proof = await proveCode(h, {
    channel: "email",
    purpose: "reauthenticate",
    idempotencyKey: key(),
    source,
    sessionToken,
  });
  if (proof.outcome !== "reauthenticated") throw new Error(proof.outcome);
  return proof.reauthToken;
};

describe("self-service account deletion", () => {
  afterEach(() => {
    codes.length = 0;
  });

  it("ends the account at once, signs out every device and frees its email", async () => {
    const h = harness();
    const first = await register(h, "deletion-owner@example.invalid");
    const userId = first.profile.id;
    const second = await signIn(h, "deletion-owner@example.invalid");
    const reauthToken = await reauthenticate(h, first.token);
    const deleted = await h.service.deleteAccount({
      sessionToken: first.token,
      reauthToken,
      idempotencyKey: key(),
      expectedAccountId: userId,
    });
    expect(deleted).toEqual({
      ok: true,
      value: { outcome: "deleted", deletedAt: h.now().toISOString() },
    });
    for (const token of [first.token, second.token])
      expect(await h.service.readAccount(token)).toEqual({
        ok: false,
        reason: "AUTH_UNAUTHENTICATED",
      });
    const user = await h.port.transaction((tx) => tx.findUser(userId));
    // Anonymized tombstone; the handle stays reserved and never returns.
    expect(user).toEqual({
      ...first.profile,
      displayName: "已注销用户",
      studioName: "",
      studioNameSuffix: "",
      status: "deleted",
    });
    expect(await h.port.transaction((tx) => tx.listIdentities(userId))).toEqual(
      [],
    );
    expect(
      await h.port.transaction((tx) => tx.findAccountDeletion(userId)),
    ).toMatchObject({ userId, deletedAt: h.now().toISOString() });
    expect(
      await h.port.transaction(
        async (tx) => await tx.findHandoff(await hashSessionToken(reauthToken)),
      ),
    ).toBeNull();
    // The same email starts an unrelated new account.
    const again = await register(h, "deletion-owner@example.invalid");
    expect(again.profile.id).not.toBe(userId);
    expect(again.profile.handle).not.toBe(first.profile.handle);
    expect(await signIn(h, "deletion-owner@example.invalid")).toMatchObject({
      profile: { id: again.profile.id },
    });
  });

  it("returns the first result to an exact retry and refuses every other request for the deleted account", async () => {
    const h = harness();
    const first = await register(h, "deletion-retry@example.invalid");
    const second = await signIn(h, "deletion-retry@example.invalid");
    const userId = first.profile.id;
    const idempotencyKey = key();
    const command = {
      sessionToken: first.token,
      reauthToken: await reauthenticate(h, first.token),
      idempotencyKey,
      expectedAccountId: userId,
    };
    const original = await h.service.deleteAccount(command);
    expect(original.ok).toBe(true);
    h.advance(60_000);
    // The Session is revoked now; the same request still gets its answer.
    expect(await h.service.deleteAccount(command)).toEqual(original);
    for (const retry of [
      { ...command, idempotencyKey: key() },
      { ...command, sessionToken: second.token },
      { ...command, expectedAccountId: `user-${"e".repeat(32)}` },
      { ...command, sessionToken: foreignToken() },
    ])
      expect(await h.service.deleteAccount(retry)).toEqual({
        ok: false,
        reason: "AUTH_UNAUTHENTICATED",
      });
  });

  it("deletes once when the same request arrives twice at the same time", async () => {
    const h = harness();
    const owner = await register(h, "deletion-double@example.invalid");
    const command = {
      sessionToken: owner.token,
      reauthToken: await reauthenticate(h, owner.token),
      idempotencyKey: key(),
      expectedAccountId: owner.profile.id,
    };
    const [left, right] = await Promise.all([
      h.service.deleteAccount(command),
      h.service.deleteAccount(command),
    ]);
    expect(left.ok).toBe(true);
    expect(right).toEqual(left);
    expect(
      await h.port.transaction((tx) =>
        tx.findAccountDeletion(owner.profile.id),
      ),
    ).toMatchObject({
      deletedAt: left.ok ? left.value.deletedAt : "",
    });
  });

  it("changes nothing for a missing, foreign, other-Session, expired or consumed re-verification", async () => {
    const h = harness();
    const owner = await register(h, "deletion-proof@example.invalid");
    const other = await register(h, "deletion-bystander@example.invalid");
    const device = await signIn(h, "deletion-proof@example.invalid");
    const command = (reauthToken: string) => ({
      sessionToken: owner.token,
      reauthToken,
      idempotencyKey: key(),
      expectedAccountId: owner.profile.id,
    });
    const rejected = { ok: false, reason: "AUTH_PROOF_REJECTED" };
    expect(await h.service.deleteAccount(command(foreignToken()))).toEqual(
      rejected,
    );
    // Another account's proof, and a proof issued to another device's Session.
    expect(
      await h.service.deleteAccount(
        command(await reauthenticate(h, other.token)),
      ),
    ).toEqual(rejected);
    expect(
      await h.service.deleteAccount(
        command(await reauthenticate(h, device.token)),
      ),
    ).toEqual(rejected);
    const expiring = await reauthenticate(h, owner.token);
    h.advance(10 * 60 * 1000);
    expect(await h.service.deleteAccount(command(expiring))).toEqual(rejected);
    const consumed = await reauthenticate(h, owner.token);
    await h.port.transaction(async (tx) => {
      const row = await tx.findHandoff(await hashSessionToken(consumed));
      if (row === null) throw new Error("missing synthetic proof");
      await tx.consumeHandoff(row.id, h.now().toISOString());
    });
    expect(await h.service.deleteAccount(command(consumed))).toEqual(rejected);
    // Every refusal left the account, its Sessions and its contact in place.
    expect(await h.service.readAccount(owner.token)).toMatchObject({
      ok: true,
      value: { userId: owner.profile.id, email: { state: "verified" } },
    });
    expect(await h.service.readAccount(device.token)).toMatchObject({
      ok: true,
    });
    expect(
      await h.port.transaction((tx) =>
        tx.findAccountDeletion(owner.profile.id),
      ),
    ).toBeNull();
    expect(
      await h.service.deleteAccount(
        command(await reauthenticate(h, owner.token)),
      ),
    ).toMatchObject({ ok: true });
    expect(await h.service.readAccount(other.token)).toMatchObject({
      ok: true,
      value: { userId: other.profile.id },
    });
  });

  it("refuses a Session the confirmed account does not own, keeping the proof usable", async () => {
    const h = harness();
    const owner = await register(h, "deletion-confirmed@example.invalid");
    const other = await register(h, "deletion-other-tab@example.invalid");
    const reauthToken = await reauthenticate(h, owner.token);
    const command = {
      sessionToken: owner.token,
      reauthToken,
      idempotencyKey: key(),
      expectedAccountId: other.profile.id,
    };
    expect(await h.service.deleteAccount(command)).toEqual({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    expect(
      (
        await h.port.transaction(async (tx) =>
          tx.findHandoff(await hashSessionToken(reauthToken)),
        )
      )?.consumedAt,
    ).toBeNull();
    expect(
      await h.service.deleteAccount({
        ...command,
        expectedAccountId: owner.profile.id,
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await h.port.transaction((tx) => tx.findUser(other.profile.id)))?.status,
    ).toBe("active");
  });

  it("does not delete a suspended account and is unavailable without OTP re-verification", async () => {
    const h = harness();
    const owner = await register(h, "deletion-suspended@example.invalid");
    const reauthToken = await reauthenticate(h, owner.token);
    h.port.setStatus(owner.profile.id, "suspended");
    expect(
      await h.service.deleteAccount({
        sessionToken: owner.token,
        reauthToken,
        idempotencyKey: key(),
        expectedAccountId: owner.profile.id,
      }),
    ).toEqual({ ok: false, reason: "AUTH_ACCOUNT_SUSPENDED" });
    expect(
      await h.port.transaction((tx) => tx.findUser(owner.profile.id)),
    ).toMatchObject({ status: "suspended", displayName: "Synthetic owner" });
    expect(
      await h.port.transaction((tx) => tx.listIdentities(owner.profile.id)),
    ).toHaveLength(1);

    const passwordOnly = harness({
      profile: "password-only",
      emailMode: "disabled",
      phoneMode: "disabled",
    });
    expect(
      await passwordOnly.service.deleteAccount({
        sessionToken: foreignToken(),
        reauthToken: foreignToken(),
        idempotencyKey: key(),
        expectedAccountId: owner.profile.id,
      }),
    ).toEqual({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
  });

  it("never signs the deleted account in again by password or appeal", async () => {
    const h = harness();
    const password = "SYNTHETIC_D1";
    const owner = await register(
      h,
      "deletion-password@example.invalid",
      password,
    );
    const login = (appealOnly: boolean) =>
      h.service.passwordLogin({
        channel: "email",
        identifier: "deletion-password@example.invalid",
        password,
        idempotencyKey: key(),
        source,
        ...(appealOnly ? { appealOnly } : {}),
      });
    expect((await login(false)).ok).toBe(true);
    expect(
      await h.service.deleteAccount({
        sessionToken: owner.token,
        reauthToken: await reauthenticate(h, owner.token),
        idempotencyKey: key(),
        expectedAccountId: owner.profile.id,
      }),
    ).toMatchObject({ ok: true });
    for (const appealOnly of [false, true])
      expect(await login(appealOnly)).toEqual({
        ok: false,
        reason: "AUTH_INVALID_CREDENTIALS",
      });
    expect(
      await h.port.transaction((tx) =>
        tx.findPasswordCredential(owner.profile.id),
      ),
    ).toBeNull();
  });
});

describe("account deletion over HTTP", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
    servers.clear();
    codes.length = 0;
  });

  it("requires the Session and the confirmed account, answers once with no credential, and replays", async () => {
    const h = harness();
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        authService: h.service,
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
    const base = `http://127.0.0.1:${address.port}/v1/community/auth/`;
    const owner = await register(h, "deletion-http@example.invalid");
    const reauthToken = await reauthenticate(h, owner.token);
    const body = { reauthToken, idempotencyKey: key() };
    const post = (headers: Record<string, string>, payload: unknown = body) =>
      fetch(`${base}account/deletion`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });
    const bearer = { authorization: `Bearer ${owner.token}` };
    const account = () =>
      fetch(`${base}account`, { headers: bearer }).then(
        (response) => response.status,
      );
    const refusals = [
      await post({ "x-author-account": owner.profile.id }),
      await post(bearer),
      await post({ ...bearer, "x-author-account": "someone" }),
      await post({ ...bearer, "x-author-account": `user-${"a".repeat(32)}` }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(401);
      expect(await refusal.json()).toMatchObject({
        error: { code: "UNAUTHENTICATED", message: "AUTH_UNAUTHENTICATED" },
      });
    }
    const malformed = await post(
      { ...bearer, "x-author-account": owner.profile.id },
      { ...body, userId: owner.profile.id },
    );
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({
      error: { code: "INVALID_INPUT", message: "AUTH_PROOF_REJECTED" },
    });
    // Nothing changed: the Session still reads its account.
    expect(await account()).toBe(200);

    const confirmed = { ...bearer, "x-author-account": owner.profile.id };
    const deleted = await post(confirmed);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("private, no-store");
    const result = (await deleted.json()) as Record<string, unknown>;
    expect(result).toEqual({
      outcome: "deleted",
      deletedAt: h.now().toISOString(),
    });
    expect(await account()).toBe(401);
    const replay = await post(confirmed);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    const other = await post(confirmed, { ...body, idempotencyKey: key() });
    expect(other.status).toBe(401);
  });
});
