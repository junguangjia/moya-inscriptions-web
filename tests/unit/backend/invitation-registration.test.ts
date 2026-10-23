import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  createProductionAuthService,
  hashPassword,
  hashSessionToken,
  productionAuthConfigurationFrom,
} from "@moya/api";
import type {
  AuthUnitOfWork,
  CommunityAuthPort,
  CommunityAuthServiceOptions,
  StoredInvitation,
} from "@moya/api";
import { authCapabilitiesSchema } from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

// All invitation codes, keys, credentials and contacts in this suite are synthetic.
const syntheticCode = "i".repeat(22);
const otherSyntheticCode = "j".repeat(22);
const syntheticPassword = "Synthetic7";
const agreement = {
  version: "synthetic-invitation-v1",
  title: "Synthetic agreement",
  body: "Synthetic acceptance material only.",
};
const digest = (code: string) =>
  createHash("sha256")
    .update(`artvenn:registration-invitation:v1:${code.trim()}`)
    .digest("hex");

const harness = (overrides: Partial<CommunityAuthServiceOptions> = {}) => {
  const port = createMemoryCommunityAuthPort();
  let now = new Date("2026-10-22T12:00:00Z");
  const deliveries = new Map<string, string>();
  let sends = 0;
  const options: CommunityAuthServiceOptions = {
    environment: "production",
    profile: "email-first",
    registrationMode: "invite-only",
    allowProvisionedHandleLogin: true,
    registrationAgreement: agreement,
    emailMode: "provider",
    phoneMode: "disabled",
    keys: {
      version: 1,
      lookupKey: Buffer.alloc(32, 71),
      encryptionKey: Buffer.alloc(32, 72),
      otpKey: Buffer.alloc(32, 73),
    },
    clock: () => now,
    delivery: {
      sendEmail: async (input) => {
        sends++;
        deliveries.set(input.to, input.code);
        return { state: "accepted", correlation: "synthetic-invitation" };
      },
      sendPhone: async () => ({ state: "failed" }),
      checkPhone: async () => "fail",
    },
    ...overrides,
  };
  const service = new CommunityAuthService(port, options);
  const seed = (
    changes: Partial<StoredInvitation> = {},
    code = syntheticCode,
  ) => {
    const invitation: StoredInvitation = {
      id: `invite-${"1".repeat(32)}`,
      digest: digest(code),
      environment: options.environment,
      maxUses: 20,
      usedCount: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      revokedAt: null,
      ...changes,
    };
    port.provisionInvitation(invitation);
    return invitation;
  };
  const send = (
    identifier = "first@example.invalid",
    invitationCode: string | undefined = syntheticCode,
    idempotencyKey = randomUUID(),
  ) =>
    service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier,
      ...(invitationCode === undefined ? {} : { invitationCode }),
      source: "synthetic-source",
      idempotencyKey,
    });
  const prepare = async (
    identifier = "first@example.invalid",
    invitationCode = syntheticCode,
  ) => {
    const sent = await send(identifier, invitationCode);
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("Synthetic invitation send refused");
    const code = deliveries.get(identifier);
    if (code === undefined) throw new Error("Synthetic delivery missing");
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      continuationToken: sent.value.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    });
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw new Error("Synthetic invitation verification refused");
    return {
      sent: sent.value,
      request: {
        handoffToken: verified.value.handoffToken,
        displayName: "邀请测试",
        agreement: true,
        agreementVersion: agreement.version,
        idempotencyKey: randomUUID(),
      },
    };
  };
  return {
    port,
    service,
    options,
    seed,
    send,
    prepare,
    sends: () => sends,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};

const withTransactionOverride = (
  port: CommunityAuthPort,
  override: (tx: AuthUnitOfWork) => AuthUnitOfWork,
): CommunityAuthPort => ({
  transaction: (work) => port.transaction((tx) => work(override(tx))),
});

describe("invitation-only registration", () => {
  it("does not turn an enabled phone login channel into invitation registration", async () => {
    const h = harness({ phoneMode: "provider" });
    h.seed();
    expect(
      await h.service.sendChallenge({
        channel: "phone",
        purpose: "register",
        identifier: "+8613800138000",
        invitationCode: syntheticCode,
        idempotencyKey: randomUUID(),
        source: "synthetic-source",
      }),
    ).toEqual({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
    expect(h.sends()).toBe(0);
  });

  it("keeps Production registration closed by default and validates explicit configuration", () => {
    const h = harness();
    const defaultOptions = { ...h.options };
    delete defaultOptions.registrationMode;
    expect(
      new CommunityAuthService(h.port, defaultOptions).capabilities()
        .registration?.available,
    ).toBe(false);
    const env = {
      NODE_ENV: "production",
      AUTH_PUBLIC_ENABLED: "true",
      AUTH_EMAIL_PROVIDER: "tencent-ses",
      AUTH_KEY_VERSION: "1",
      AUTH_LOOKUP_KEY: Buffer.alloc(32, 1).toString("base64"),
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
      AUTH_OTP_KEY: Buffer.alloc(32, 3).toString("base64"),
    };
    expect(productionAuthConfigurationFrom(env)?.registrationMode).toBe(
      "closed",
    );
    const configured = productionAuthConfigurationFrom({
      ...env,
      AUTH_REGISTRATION_MODE: "invite-only",
      AUTH_LEGACY_HANDLE_LOGIN_ENABLED: "true",
    });
    expect(configured?.allowProvisionedHandleLogin).toBe(true);
    if (configured === null) throw new Error("Synthetic configuration missing");
    expect(
      createProductionAuthService(
        h.port,
        configured,
        h.options.delivery,
        agreement,
      ).capabilities().registration?.invitationRequired,
    ).toBe(true);
    expect(() =>
      productionAuthConfigurationFrom({
        ...env,
        AUTH_REGISTRATION_MODE: "public",
      }),
    ).toThrow();
    expect(() =>
      productionAuthConfigurationFrom({
        ...env,
        AUTH_LEGACY_HANDLE_LOGIN_ENABLED: "yes",
      }),
    ).toThrow();
  });

  it("advertises a labeled Development draft without weakening Production agreement requirements", () => {
    const local = harness({
      environment: "development",
      emailMode: "local_capture",
      registrationAgreement: null,
    });
    const capabilities = authCapabilitiesSchema.parse(
      local.service.capabilities(),
    );
    expect(capabilities.registration?.available).toBe(true);
    expect(capabilities.registration?.agreement?.title).toContain("开发环境");
    const production = harness({ registrationAgreement: null });
    expect(production.service.capabilities().registration?.available).toBe(
      false,
    );
  });

  it("refuses missing, malformed, expired, revoked, full and foreign invitations before delivery", async () => {
    for (const changes of [
      { expiresAt: "2026-10-21T00:00:00Z" },
      { revokedAt: "2026-10-22T00:00:00Z" },
      { maxUses: 1, usedCount: 1 },
      { environment: "development" as const },
    ]) {
      const h = harness();
      h.seed(changes);
      expect(await h.send()).toMatchObject({
        ok: false,
        reason: "AUTH_INVITATION_INVALID",
      });
      expect(h.sends()).toBe(0);
      expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
    }
    const h = harness();
    expect(await h.send("first@example.invalid", "")).toMatchObject({
      ok: false,
      reason: "AUTH_INVITATION_REQUIRED",
    });
    expect(
      await h.send("first@example.invalid", "synthetic-invalid-format"),
    ).toMatchObject({ ok: false, reason: "AUTH_INVITATION_INVALID" });
    expect(await h.send()).toMatchObject({
      ok: false,
      reason: "AUTH_INVITATION_INVALID",
    });
    expect(h.sends()).toBe(0);
  });

  it("rate limits invalid invitation attempts without making a provider request", async () => {
    const h = harness();
    for (let attempt = 0; attempt < 8; attempt++)
      expect((await h.send()).ok).toBe(false);
    expect(await h.send()).toMatchObject({
      ok: false,
      reason: "AUTH_RATE_LIMITED",
    });
    expect(h.sends()).toBe(0);
  });

  it("binds invitation to challenge and handoff, and resends never redeem quota", async () => {
    const h = harness();
    const invitation = h.seed();
    const prepared = await h.prepare();
    const challenge = await h.port.transaction((tx) =>
      tx.findChallenge(prepared.sent.challengeId),
    );
    expect(challenge?.invitationId).toBe(invitation.id);
    const handoff = await h.port.transaction(async (tx) =>
      tx.findHandoff(await hashSessionToken(prepared.request.handoffToken)),
    );
    expect(handoff?.invitationId).toBe(invitation.id);
    h.advance(61_000);
    expect((await h.send()).ok).toBe(true);
    expect(
      (await h.port.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(0);
    expect(h.sends()).toBe(2);
  });

  it("cannot change the invitation on an idempotent or cooling-down challenge", async () => {
    const h = harness();
    h.seed();
    h.seed({ id: `invite-${"2".repeat(32)}` }, otherSyntheticCode);
    const requestKey = randomUUID();
    expect(
      (await h.send("first@example.invalid", syntheticCode, requestKey)).ok,
    ).toBe(true);
    expect(
      await h.send("first@example.invalid", otherSyntheticCode, requestKey),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(
      await h.send("first@example.invalid", otherSyntheticCode),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(h.sends()).toBe(1);
  });

  it("grants beta access atomically and allows exactly one contender for the last quota", async () => {
    const h = harness();
    const invitation = h.seed({ maxUses: 1 });
    const first = await h.prepare("first@example.invalid");
    const second = await h.prepare("second@example.invalid");
    const results = await Promise.all([
      h.service.confirmRegistration(first.request),
      h.service.confirmRegistration(second.request),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { reason: "AUTH_INVITATION_INVALID" },
    ]);
    const success = results.find((result) => result.ok);
    if (!success?.ok) throw new Error("Synthetic registration missing");
    expect(await h.port.readBetaAccess(success.value.profile.id)).toBe(
      "granted",
    );
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
    expect(
      (await h.port.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(1);
  });

  it("recovers the last successful slot after expiry/revocation without consuming again, until logout", async () => {
    const h = harness();
    const invitation = h.seed({ maxUses: 1 });
    const prepared = await h.prepare();
    const first = await h.service.confirmRegistration(prepared.request);
    expect(first.ok).toBe(true);
    h.port.revokeInvitation(invitation.id, "2026-10-22T12:01:00Z");
    h.advance(11 * 60 * 1000);
    const replay = await h.service.confirmRegistration(prepared.request);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.profile.id).toBe(first.value.profile.id);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
    expect(
      (await h.port.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(1);
    expect((await h.service.signOut(replay.value.token)).ok).toBe(true);
    expect((await h.service.confirmRegistration(prepared.request)).ok).toBe(
      false,
    );
  });

  it("rejects a revoked or newly expired invitation at final registration", async () => {
    for (const revoke of [true, false]) {
      const h = harness();
      const invitation = h.seed({ expiresAt: "2026-10-22T12:01:00Z" });
      const prepared = await h.prepare();
      if (revoke)
        h.port.revokeInvitation(invitation.id, "2026-10-22T12:00:30Z");
      else h.advance(61_000);
      expect(
        await h.service.confirmRegistration(prepared.request),
      ).toMatchObject({ ok: false, reason: "AUTH_INVITATION_INVALID" });
      expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
      expect(
        (await h.port.transaction((tx) => tx.lockInvitation(invitation.id)))
          ?.usedCount,
      ).toBe(0);
    }
  });

  it("rolls back the new user, quota and beta grant if handoff consumption fails", async () => {
    const h = harness();
    const invitation = h.seed();
    const prepared = await h.prepare();
    let candidateUser = "";
    const failingPort = withTransactionOverride(h.port, (tx) => ({
      ...tx,
      insertUser: async (user) => {
        candidateUser = user.id;
        return tx.insertUser(user);
      },
      consumeHandoff: async () => "consumed",
    }));
    const failing = new CommunityAuthService(failingPort, h.options);
    expect(await failing.confirmRegistration(prepared.request)).toMatchObject({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
    expect(await h.port.readBetaAccess(candidateUser)).toBe("none");
    expect(
      (await h.port.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(0);
    expect((await h.service.confirmRegistration(prepared.request)).ok).toBe(
      true,
    );
  });

  it("refuses receipt replay through a handoff bound to a different invitation", async () => {
    const h = harness();
    h.seed();
    h.seed({ id: `invite-${"2".repeat(32)}` }, otherSyntheticCode);
    const first = await h.prepare();
    h.advance(61_000);
    const second = await h.prepare("first@example.invalid", otherSyntheticCode);
    expect((await h.service.confirmRegistration(first.request)).ok).toBe(true);
    expect(
      await h.service.confirmRegistration({
        ...second.request,
        idempotencyKey: first.request.idempotencyKey,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
  });

  it("does not send unknown sign-in email and cannot turn even a valid synthetic proof into registration", async () => {
    const h = harness();
    const request = {
      channel: "email" as const,
      purpose: "sign_in" as const,
      identifier: "unknown@example.invalid",
      source: "synthetic-source",
      idempotencyKey: randomUUID(),
    };
    const sent = await h.service.sendChallenge(request);
    expect(sent.ok).toBe(true);
    expect(h.sends()).toBe(0);
    if (!sent.ok || sent.value.continuationToken === undefined) return;
    const challenge = await h.port.transaction((tx) =>
      tx.findChallenge(sent.value.challengeId),
    );
    if (challenge === null) throw new Error("Synthetic challenge missing");
    const verifier = createHmac("sha256", h.options.keys.otpKey)
      .update(
        `${challenge.id}\0sign_in\0${challenge.targetDigest}\0${"0".repeat(6)}`,
      )
      .digest("hex");
    await h.port.transaction((tx) =>
      tx.saveChallenge({ ...challenge, verifier }),
    );
    expect(
      await h.service.verifyChallenge({
        challengeId: sent.value.challengeId,
        continuationToken: sent.value.continuationToken,
        code: "0".repeat(6),
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_INVITATION_REQUIRED" });
    const replay = await h.service.sendChallenge(request);
    expect(
      replay.ok && replay.value.challengeId === sent.value.challengeId,
    ).toBe(true);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
    expect(h.sends()).toBe(0);
  });

  it("keeps existing email and provisioned handle/password logins when registration closes", async () => {
    const h = harness();
    h.seed();
    const prepared = await h.prepare();
    const created = await h.service.confirmRegistration({
      ...prepared.request,
      password: syntheticPassword,
    });
    expect(created.ok).toBe(true);
    const legacy = {
      id: `user-${"f".repeat(32)}`,
      handle: "synthetic-legacy",
      displayName: "旧测试",
      status: "active" as const,
    };
    h.port.provisionPasswordAccount(
      legacy,
      {
        userId: legacy.id,
        verifier: await hashPassword(syntheticPassword),
        version: 1,
        updatedAt: "2026-10-22T12:00:00Z",
      },
      "production",
    );
    const closed = new CommunityAuthService(h.port, {
      ...h.options,
      registrationMode: "closed",
    });
    expect(closed.capabilities().password?.identifiers).toEqual([
      "email",
      "handle",
    ]);
    expect(
      (
        await closed.passwordLogin({
          channel: "handle",
          identifier: legacy.handle,
          password: syntheticPassword,
          idempotencyKey: randomUUID(),
          source: "synthetic-source",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await closed.passwordLogin({
          channel: "email",
          identifier: "first@example.invalid",
          password: syntheticPassword,
          idempotencyKey: randomUUID(),
          source: "synthetic-source",
        })
      ).ok,
    ).toBe(true);
    const sent = await closed.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "first@example.invalid",
      idempotencyKey: randomUUID(),
      source: "synthetic-source",
    });
    expect(sent.ok).toBe(true);
    expect(h.sends()).toBe(2);
    expect(
      await closed.sendChallenge({
        channel: "email",
        purpose: "register",
        identifier: "new@example.invalid",
        invitationCode: syntheticCode,
        idempotencyKey: randomUUID(),
        source: "synthetic-source",
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_NOT_CONFIGURED" });
    const disabled = new CommunityAuthService(h.port, {
      ...h.options,
      allowProvisionedHandleLogin: false,
    });
    expect(
      await disabled.passwordLogin({
        channel: "handle",
        identifier: legacy.handle,
        password: syntheticPassword,
        idempotencyKey: randomUUID(),
        source: "synthetic-source",
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
  });
});
