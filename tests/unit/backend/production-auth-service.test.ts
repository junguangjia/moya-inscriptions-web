import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  hashSessionToken,
  createProductionAuthService,
} from "@moya/api";
import type {
  AuthDeliveryPorts,
  CommunityAuthPort,
  CommunityAuthServiceOptions,
  StoredSession,
  StoredChallenge,
} from "@moya/api";
import type { AuthRegistrationAgreement } from "@moya/contracts";

const agreement: AuthRegistrationAgreement = {
  version: "synthetic-v1",
  title: "Synthetic agreement",
  body: "Synthetic test material only.",
};
const keys = () => ({
  version: 1,
  lookupKey: randomBytes(32),
  encryptionKey: randomBytes(32),
  otpKey: randomBytes(32),
});
const harness = (overrides: Partial<CommunityAuthServiceOptions> = {}) => {
  const port = createMemoryCommunityAuthPort();
  let code = "",
    sends = 0,
    checks = 0;
  let phoneCheckHook: (() => Promise<void>) | undefined;
  const delivery: AuthDeliveryPorts = {
    sendEmail: async (input) => {
      code = input.code;
      sends++;
      return { state: "accepted", correlation: "synthetic" };
    },
    sendPhone: async () => ({ state: "accepted", correlation: "synthetic" }),
    checkPhone: async () => {
      checks++;
      await phoneCheckHook?.();
      return "pass";
    },
  };
  const options: CommunityAuthServiceOptions = {
    environment: "production",
    profile: "email-first",
    keys: keys(),
    emailMode: "provider",
    phoneMode: "provider",
    delivery,
    registrationAgreement: agreement,
    ...overrides,
  };
  return {
    port,
    options,
    service: new CommunityAuthService(port, options),
    code: () => code,
    sends: () => sends,
    checks: () => checks,
    setPhoneCheckHook: (hook: () => Promise<void>) => {
      phoneCheckHook = hook;
    },
  };
};
const prepare = async (
  h: ReturnType<typeof harness>,
  identifier = "synthetic@example.invalid",
) => {
  const sent = await h.service.sendChallenge({
    channel: "email",
    purpose: "register",
    identifier,
    idempotencyKey: randomUUID(),
    source: "synthetic",
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw Error("Synthetic challenge refused");
  const verified = await h.service.verifyChallenge({
    challengeId: sent.value.challengeId,
    code: h.code(),
    continuationToken: sent.value.continuationToken,
    idempotencyKey: randomUUID(),
  });
  if (!verified.ok || verified.value.outcome !== "registration_required")
    throw Error("Synthetic verification refused");
  return {
    handoffToken: verified.value.handoffToken,
    displayName: "合成",
    agreement: true,
    agreementVersion: agreement.version,
    idempotencyKey: randomUUID(),
  };
};

describe("Production authentication core invariants", () => {
  it("rejects capture, simulation and full-local even when constructed directly", () => {
    for (const overrides of [
      { emailMode: "local_capture" as const },
      { emailMode: "simulated" as const },
      { phoneMode: "simulated" as const },
      { phoneMode: "local_capture" as const },
      { profile: "full-local" as const },
    ])
      expect(() => harness(overrides)).toThrow(/requires real provider/u);
    const h = harness();
    expect(
      createProductionAuthService(
        h.port,
        { keys: h.options.keys, phoneEnabled: true },
        h.options.delivery,
        agreement,
      ).capabilities().developmentOnly,
    ).toBe(false);
  });
  it("blocks missing agreement before registration transaction or provider send", async () => {
    let transactions = 0;
    const h = harness({ registrationAgreement: null });
    const tracked: CommunityAuthPort = {
      transaction: (work) => {
        transactions++;
        return h.port.transaction(work);
      },
    };
    const service = new CommunityAuthService(tracked, h.options);
    expect(service.capabilities().registration?.available).toBe(false);
    expect(
      (
        await service.sendChallenge({
          channel: "email",
          purpose: "register",
          identifier: "synthetic@example.invalid",
          idempotencyKey: randomUUID(),
          source: "synthetic",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await service.confirmRegistration({
          handoffToken: "synthetic-placeholder",
          displayName: "合成",
          agreement: true,
          idempotencyKey: randomUUID(),
        })
      ).ok,
    ).toBe(false);
    expect(transactions).toBe(0);
    expect(h.sends()).toBe(0);
    // Missing agreement does not disable sign-in challenge delivery.
    expect(
      (
        await service.sendChallenge({
          channel: "email",
          purpose: "sign_in",
          identifier: "synthetic@example.invalid",
          idempotencyKey: randomUUID(),
          source: "synthetic",
        })
      ).ok,
    ).toBe(true);
    expect(h.sends()).toBe(1);
  });
  it("requires exact agreement version before registration writes", async () => {
    const h = harness(),
      input = await prepare(h);
    let transactions = 0;
    const service = new CommunityAuthService(
      {
        transaction: (work) => {
          transactions++;
          return h.port.transaction(work);
        },
      },
      h.options,
    );
    for (const version of [undefined, "synthetic-stale"]) {
      const result = await service.confirmRegistration({
        ...input,
        agreementVersion: version,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("AUTH_NOT_CONFIGURED");
    }
    expect(transactions).toBe(0);
    const result = await service.confirmRegistration(input);
    expect(result.ok).toBe(true);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
    const identity = await h.port.transaction(async (tx) =>
      result.ok
        ? (await tx.listIdentities(result.value.profile.id))[0]
        : undefined,
    );
    expect(identity?.environment).toBe("production");
    expect(identity?.verificationMode).toBe("provider");
  });
  it("binds Production receipt replay to agreement version and does not mutate configured material", async () => {
    const supplied = { ...agreement },
      h = harness({ registrationAgreement: supplied }),
      input = await prepare(h);
    supplied.version = "mutated-after-construction";
    const result = await h.service.confirmRegistration(input);
    expect(result.ok).toBe(true);
    const returned = h.service.capabilities().registration?.agreement;
    if (returned) returned.version = "mutated-after-read";
    expect(h.service.capabilities().registration?.agreement?.version).toBe(
      agreement.version,
    );
    expect((await h.service.confirmRegistration(input)).ok).toBe(true);
    const changed = new CommunityAuthService(h.port, {
      ...h.options,
      registrationAgreement: { ...agreement, version: "synthetic-v2" },
    });
    const replay = await changed.confirmRegistration({
      ...input,
      agreementVersion: "synthetic-v2",
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("AUTH_PROOF_REJECTED");
  });
  it("preserves Development registration and receipt bytes without a version", async () => {
    const h = harness({
      environment: "development",
      profile: "full-local",
      emailMode: "local_capture",
      phoneMode: "simulated",
      registrationAgreement: null,
    });
    expect(h.service.capabilities().registration).toBeUndefined();
    const input = await prepare(h);
    delete (input as { agreementVersion?: string }).agreementVersion;
    expect((await h.service.confirmRegistration(input)).ok).toBe(true);
    expect((await h.service.confirmRegistration(input)).ok).toBe(true);
  });
  it("keeps login/account access when registration material is removed, then logout stops replay", async () => {
    const h = harness(),
      input = await prepare(h),
      result = await h.service.confirmRegistration(input);
    if (!result.ok) throw Error("Synthetic registration failed");
    const noRegistration = new CommunityAuthService(h.port, {
      ...h.options,
      registrationAgreement: null,
    });
    expect((await noRegistration.readAccount(result.value.token)).ok).toBe(
      true,
    );
    const sent = await noRegistration.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "synthetic@example.invalid",
      idempotencyKey: randomUUID(),
      source: "synthetic",
    });
    // Existing channel resend policy still applies; the registered account is readable.
    if (sent.ok && sent.value.continuationToken) {
      const verified = await noRegistration.verifyChallenge({
        challengeId: sent.value.challengeId,
        code: h.code(),
        continuationToken: sent.value.continuationToken,
        idempotencyKey: randomUUID(),
      });
      expect(verified.ok).toBe(true);
    }
    expect((await noRegistration.signOut(result.value.token)).ok).toBe(true);
    expect((await noRegistration.readAccount(result.value.token)).ok).toBe(
      false,
    );
  });
  it("rejects Development and legacy sessions for Production account, factor, optional-session and logout operations", async () => {
    const h = harness(),
      input = await prepare(h),
      result = await h.service.confirmRegistration(input);
    if (!result.ok) throw Error("Synthetic registration failed");
    for (const provenance of [
      { issuer: "verified_login", authEnvironment: "development" },
      { issuer: null, authEnvironment: null },
    ]) {
      const token = randomBytes(32).toString("base64url");
      const row = {
        id: `session-${randomBytes(16).toString("hex")}`,
        tokenHash: await hashSessionToken(token),
        userId: result.value.profile.id,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        authChannel: "email",
        ...provenance,
      } as unknown as StoredSession;
      await h.port.transaction((tx) => tx.insertSession(row));
      expect((await h.service.readAccount(token)).ok).toBe(false);
      expect(
        (
          await h.service.sendChallenge({
            channel: "email",
            purpose: "reauthenticate",
            sessionToken: token,
            idempotencyKey: randomUUID(),
            source: "synthetic",
          })
        ).ok,
      ).toBe(false);
      expect((await h.service.signOut(token)).ok).toBe(false);
      const legacy = new CommunityAuthService(h.port, {
        ...h.options,
        environment: "development",
      });
      expect((await legacy.readAccount(token)).ok).toBe(true);
    }
  });
});

const phoneChallenge = async (
  h: ReturnType<typeof harness>,
  purpose: "register" | "sign_in" = "register",
) => {
  const sent = await h.service.sendChallenge({
    channel: "phone",
    purpose,
    identifier: "+8613800138000",
    idempotencyKey: randomUUID(),
    source: "synthetic",
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw Error("Synthetic phone challenge refused");
  return {
    challengeId: sent.value.challengeId,
    continuationToken: sent.value.continuationToken,
    code: "123456",
    idempotencyKey: randomUUID(),
  };
};
const changeChallenge = async (
  h: ReturnType<typeof harness>,
  id: string,
  change: Partial<StoredChallenge>,
) =>
  h.port.transaction(async (tx) => {
    const row = await tx.findChallenge(id);
    if (row === null) throw Error("Synthetic challenge missing");
    await tx.saveChallenge({ ...row, ...change });
  });
const factorChallenge = async (h: ReturnType<typeof harness>) => {
  const registration = await h.service.confirmRegistration(await prepare(h));
  if (!registration.ok) throw Error("Synthetic registration refused");
  const sent = await h.service.sendChallenge({
    channel: "email",
    purpose: "reauthenticate",
    sessionToken: registration.value.token,
    idempotencyKey: randomUUID(),
    source: "synthetic",
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw Error("Synthetic reauth challenge refused");
  const reauth = await h.service.verifyChallenge({
    challengeId: sent.value.challengeId,
    continuationToken: sent.value.continuationToken,
    code: h.code(),
    idempotencyKey: randomUUID(),
  });
  if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
    throw Error("Synthetic reauth refused");
  const linked = await h.service.sendChallenge({
    channel: "phone",
    purpose: "link",
    identifier: "+8613800138000",
    sessionToken: registration.value.token,
    reauthToken: reauth.value.reauthToken,
    idempotencyKey: randomUUID(),
    source: "synthetic",
  });
  if (!linked.ok || linked.value.continuationToken === undefined)
    throw Error("Synthetic factor challenge refused");
  return {
    challengeId: linked.value.challengeId,
    continuationToken: linked.value.continuationToken,
    code: "123456",
    idempotencyKey: randomUUID(),
    sessionToken: registration.value.token,
    reauthToken: reauth.value.reauthToken,
    expectedVersion: 0,
  };
};

describe("Live phone checks follow local authorization", () => {
  const stale: readonly Partial<StoredChallenge>[] = [
    { invalidatedAt: new Date().toISOString() },
    { supersededAt: new Date().toISOString() },
    { completedAt: new Date().toISOString() },
    { expiresAt: new Date(0).toISOString() },
    { attempts: 5 },
    { environment: "development" },
    { providerMode: "simulated" },
    { deliveryState: "unknown" },
  ];
  it("refuses stale, exhausted and foreign-provenance proofs without provider verification", async () => {
    for (const change of stale) {
      const h = harness(),
        input = await phoneChallenge(h);
      await changeChallenge(h, input.challengeId, change);
      expect((await h.service.verifyChallenge(input)).ok).toBe(false);
      expect(h.checks()).toBe(0);
    }
    const h = harness(),
      input = await phoneChallenge(h);
    await h.port.transaction(async (tx) => {
      const row = await tx.findChallenge(input.challengeId);
      if (row === null) throw Error("Synthetic challenge missing");
      for (let i = 0; i < 5; i++)
        await tx.addFailure(
          row.targetDigest,
          row.purpose,
          new Date().toISOString(),
        );
    });
    expect((await h.service.verifyChallenge(input)).ok).toBe(false);
    expect(h.checks()).toBe(0);
  });
  it("preserves sign-in receipt replay without another provider check, including after OTP expiry", async () => {
    const h = harness(),
      registrationProof = await phoneChallenge(h);
    const verified = await h.service.verifyChallenge(registrationProof);
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw Error("Synthetic phone verification refused");
    const registration = await h.service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName: "合成",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    });
    if (!registration.ok) throw Error("Synthetic phone registration refused");
    const input = await phoneChallenge(h, "sign_in");
    expect((await h.service.verifyChallenge(input)).ok).toBe(true);
    expect(h.checks()).toBe(2);
    await changeChallenge(h, input.challengeId, {
      expiresAt: new Date(0).toISOString(),
    });
    const replay = await h.service.verifyChallenge(input);
    expect(replay.ok).toBe(true);
    expect(h.checks()).toBe(2);
    if (!replay.ok || replay.value.outcome !== "signed_in")
      throw Error("Synthetic replay refused");
    await h.service.signOut(replay.value.session.token);
    expect((await h.service.verifyChallenge(input)).ok).toBe(false);
    expect(h.checks()).toBe(2);
  });
  it("keeps final transactional refusal if the challenge changes during the provider call", async () => {
    const h = harness(),
      input = await phoneChallenge(h);
    h.setPhoneCheckHook(() =>
      changeChallenge(h, input.challengeId, {
        invalidatedAt: new Date().toISOString(),
      }),
    );
    expect((await h.service.verifyChallenge(input)).ok).toBe(false);
    expect(h.checks()).toBe(1);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
  });
  it("refuses stale factor challenges before external verification", async () => {
    for (const change of stale) {
      const h = harness(),
        input = await factorChallenge(h);
      await changeChallenge(h, input.challengeId, change);
      expect((await h.service.completeFactor(input)).ok).toBe(false);
      expect(h.checks()).toBe(0);
    }
  });
  it("refuses factor session, reauth and version failures before external verification", async () => {
    for (const invalid of [
      "session",
      "reauth",
      "consumed",
      "expired",
      "development",
      "version",
    ]) {
      const h = harness(),
        input = await factorChallenge(h);
      if (invalid === "session")
        input.sessionToken = "synthetic-invalid-session";
      if (invalid === "reauth") input.reauthToken = "synthetic-invalid-reauth";
      if (invalid === "version") input.expectedVersion = 2;
      const service = new CommunityAuthService(
        {
          transaction: (work) =>
            h.port.transaction((tx) =>
              work({
                ...tx,
                findHandoff: async (hash) => {
                  const row = await tx.findHandoff(hash);
                  if (row === null) return null;
                  return {
                    ...row,
                    ...(invalid === "consumed"
                      ? { consumedAt: new Date().toISOString() }
                      : invalid === "expired"
                        ? { expiresAt: new Date(0).toISOString() }
                        : invalid === "development"
                          ? { environment: "development" as const }
                          : {}),
                  };
                },
              }),
            ),
        },
        h.options,
      );
      expect((await service.completeFactor(input)).ok, invalid).toBe(false);
      expect(h.checks()).toBe(0);
    }
  });
  it("keeps the final reauth guard if it is consumed during the provider call", async () => {
    const h = harness(),
      input = await factorChallenge(h);
    h.setPhoneCheckHook(async () =>
      h.port.transaction(async (tx) => {
        const row = await tx.findHandoff(
          await hashSessionToken(input.reauthToken),
        );
        if (row === null) throw Error("Synthetic reauth missing");
        await tx.consumeHandoff(row.id, new Date().toISOString());
      }),
    );
    expect((await h.service.completeFactor(input)).ok).toBe(false);
    expect(h.checks()).toBe(1);
    const account = await h.service.readAccount(input.sessionToken);
    expect(account.ok && account.value.phone.state === "unbound").toBe(true);
  });
});
