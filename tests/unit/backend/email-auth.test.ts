import { randomUUID } from "node:crypto";

import {
  CommunityAuthService,
  assertLoopbackCaptureUrl,
  assertProductionAuthConfiguration,
  createMemoryCommunityAuthPort,
  interpretAliyunCheck,
  interpretAliyunSend,
  interpretTencentSendEmail,
  mapAliyunCheckSmsVerifyCode,
  mapAliyunSendSmsVerifyCode,
  mapTencentSendEmail,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
  trustedRequestSource,
} from "@moya/backend-runtime";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AuthDeliveryPorts,
  CommunityAuthPort,
  CommunityAuthServiceOptions,
} from "@moya/api";
import type { Server } from "node:http";

const keys = {
  version: 1,
  lookupKey: Buffer.alloc(32, 7),
  encryptionKey: Buffer.alloc(32, 8),
  otpKey: Buffer.alloc(32, 9),
};

const codes: string[] = [];
const delivery = (): AuthDeliveryPorts => ({
  sendEmail: async (input) => {
    codes.push(input.code);
    return { state: "accepted", correlation: "mail-1" };
  },
  sendPhone: async (input) => {
    if (input.code !== null) codes.push(input.code);
    return { state: "accepted", correlation: "sms-1" };
  },
  checkPhone: async () => "fail",
});

const harness = (
  profile: "full-local" | "email-first" = "full-local",
  overrides: Partial<CommunityAuthServiceOptions> = {},
) => {
  let now = new Date("2026-09-22T12:00:00.000Z");
  const port = createMemoryCommunityAuthPort();
  const service = new CommunityAuthService(port, {
    environment: "development",
    profile,
    keys,
    emailMode: "local_capture",
    phoneMode: profile === "full-local" ? "simulated" : "disabled",
    delivery: delivery(),
    clock: () => now,
    ...overrides,
  });
  return {
    port,
    service,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
};

const key = () => randomUUID();
const latestCode = () => {
  const code = codes.at(-1);
  if (code === undefined) throw new Error("no code");
  return code;
};

const registerEmail = async (
  service: CommunityAuthService,
  email = "Owner@Example.com",
  name = "墨雅",
) => {
  const sent = await service.sendChallenge({
    channel: "email",
    purpose: "register",
    identifier: email,
    idempotencyKey: key(),
    source: "127.0.0.1",
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw new Error(sent.ok ? "missing continuation" : sent.reason);
  const verified = await service.verifyChallenge({
    challengeId: sent.value.challengeId,
    code: latestCode(),
    continuationToken: sent.value.continuationToken,
    idempotencyKey: key(),
  });
  if (!verified.ok || verified.value.outcome !== "registration_required")
    throw new Error(verified.ok ? verified.value.outcome : verified.reason);
  const registered = await service.confirmRegistration({
    handoffToken: verified.value.handoffToken,
    displayName: name,
    agreement: true,
    idempotencyKey: key(),
  });
  if (!registered.ok) throw new Error(registered.reason);
  return { sent, verified, registered };
};

describe("email and phone authentication", () => {
  afterEach(() => {
    codes.length = 0;
  });

  it("registers by email, signs in to the same user, and keeps phone off in the email-first profile", async () => {
    const { service, port } = harness("email-first");
    expect(service.capabilities().phone.available).toBe(false);
    expect(
      await service.sendChallenge({
        channel: "phone",
        purpose: "register",
        identifier: "13800138000",
        idempotencyKey: key(),
        source: "127.0.0.1",
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
    const first = await registerEmail(service);
    expect(first.sent.value.maskedTarget).toBe("O***@example.com");
    await service.signOut(first.registered.value.token);
    const again = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "owner@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!again.ok || again.value.continuationToken === undefined)
      throw new Error("sign-in send failed");
    const signed = await service.verifyChallenge({
      challengeId: again.value.challengeId,
      code: latestCode(),
      continuationToken: again.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(
      signed.ok &&
        signed.value.outcome === "signed_in" &&
        signed.value.session.profile.id,
    ).toBe(first.registered.value.profile.id);
    expect(await port.transaction((tx) => tx.countUsers())).toBe(1);
  });

  it("does not create a user until registration is confirmed, and a lost response retries the same account", async () => {
    const { service, port } = harness();
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "new@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("send");
    expect(await port.transaction((tx) => tx.countUsers())).toBe(0);
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: latestCode(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(verified.ok && verified.value.outcome).toBe("registration_required");
    if (!verified.ok || verified.value.outcome !== "registration_required")
      return;
    const idempotencyKey = key();
    const first = await service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName: "新用户",
      agreement: true,
      idempotencyKey,
    });
    const second = await service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName: "新用户",
      agreement: true,
      idempotencyKey,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.profile.id).toBe(first.value.profile.id);
    expect(await service.readAccount(first.value.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    expect((await service.readAccount(second.value.token)).ok).toBe(true);
    expect(await port.transaction((tx) => tx.countUsers())).toBe(1);
  });

  it("rejects wrong, expired, superseded, replayed and exhausted codes", async () => {
    const { service, advance } = harness();
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: "codes@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("send");
    const wrong = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: "000000",
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(wrong).toMatchObject({ ok: false, reason: "AUTH_CODE_INVALID" });
    advance(5 * 60 * 1000 + 1);
    expect(
      await service.verifyChallenge({
        challengeId: sent.value.challengeId,
        code: latestCode(),
        continuationToken: sent.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CODE_EXPIRED" });
    const resent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: "codes@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!resent.ok || resent.value.continuationToken === undefined)
      throw new Error("resend");
    expect(
      await service.verifyChallenge({
        challengeId: sent.value.challengeId,
        code: codes[0] ?? "",
        continuationToken: sent.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CODE_SUPERSEDED" });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      advance(61_000);
      const next = await service.sendChallenge({
        channel: "email",
        purpose: "register",
        identifier: "codes@example.com",
        idempotencyKey: key(),
        source: "127.0.0.1",
      });
      if (!next.ok || next.value.continuationToken === undefined)
        throw new Error("loop");
      await service.verifyChallenge({
        challengeId: next.value.challengeId,
        code: "111111",
        continuationToken: next.value.continuationToken,
        idempotencyKey: key(),
      });
    }
    advance(61_000);
    const blocked = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: "codes@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    expect(blocked).toMatchObject({ ok: false, reason: "AUTH_CODE_EXHAUSTED" });
  });

  it("binds phone and email on one account and refuses the last usable factor", async () => {
    const { service } = harness("full-local");
    const email = await registerEmail(service, "bind@example.com", "绑定");
    const token = email.registered.value.token;
    const userId = email.registered.value.profile.id;
    const reauthSend = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
    });
    if (!reauthSend.ok || reauthSend.value.continuationToken === undefined)
      throw new Error("reauth");
    const reauth = await service.verifyChallenge({
      challengeId: reauthSend.value.challengeId,
      code: latestCode(),
      continuationToken: reauthSend.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw new Error("proof");
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "+86 138 0013 8000",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
      reauthToken: reauth.value.reauthToken,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("link");
    const bound = await service.completeFactor({
      challengeId: link.value.challengeId,
      code: latestCode(),
      continuationToken: link.value.continuationToken,
      reauthToken: reauth.value.reauthToken,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: token,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.value.account.userId).toBe(userId);
    expect(bound.value.account.phone.state).toBe("verified");
    expect(await service.readAccount(token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    await service.signOut(bound.value.session.token);
    const phoneSignIn = await service.sendChallenge({
      channel: "phone",
      purpose: "sign_in",
      identifier: "13800138000",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!phoneSignIn.ok || phoneSignIn.value.continuationToken === undefined)
      throw new Error("phone");
    const signed = await service.verifyChallenge({
      challengeId: phoneSignIn.value.challengeId,
      code: latestCode(),
      continuationToken: phoneSignIn.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(
      signed.ok &&
        signed.value.outcome === "signed_in" &&
        signed.value.session.profile.id,
    ).toBe(userId);
    const account = await service.readAccount(
      signed.ok && signed.value.outcome === "signed_in"
        ? signed.value.session.token
        : "",
    );
    if (!account.ok) throw new Error(account.reason);
    const current =
      signed.ok && signed.value.outcome === "signed_in"
        ? signed.value.session.token
        : "";
    const provePhone = await service.sendChallenge({
      channel: "phone",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: current,
    });
    if (!provePhone.ok || provePhone.value.continuationToken === undefined)
      throw new Error("prove");
    const phoneProof = await service.verifyChallenge({
      challengeId: provePhone.value.challengeId,
      code: latestCode(),
      continuationToken: provePhone.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!phoneProof.ok || phoneProof.value.outcome !== "reauthenticated")
      throw new Error("phone proof");
    const unlinked = await service.unlinkFactor({
      channel: "email",
      reauthToken: phoneProof.value.reauthToken,
      expectedVersion: account.value.email.version,
      idempotencyKey: key(),
      sessionToken: current,
    });
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    const proveRemaining = await service.sendChallenge({
      channel: "phone",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: unlinked.value.session.token,
    });
    if (
      !proveRemaining.ok ||
      proveRemaining.value.continuationToken === undefined
    )
      throw new Error("remaining");
    const remaining = await service.verifyChallenge({
      challengeId: proveRemaining.value.challengeId,
      code: latestCode(),
      continuationToken: proveRemaining.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!remaining.ok || remaining.value.outcome !== "reauthenticated")
      throw new Error("remaining proof");
    expect(
      await service.unlinkFactor({
        channel: "phone",
        reauthToken: remaining.value.reauthToken,
        expectedVersion: unlinked.value.account.phone.version,
        idempotencyKey: key(),
        sessionToken: unlinked.value.session.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_LAST_FACTOR" });
  });

  it("leaves a link proof usable when the verify route rejects that purpose", async () => {
    const { service } = harness();
    const email = await registerEmail(service, "proof@example.com", "证明");
    const token = email.registered.value.token;
    const reauthSend = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
    });
    if (!reauthSend.ok || reauthSend.value.continuationToken === undefined)
      throw new Error("reauth");
    const reauth = await service.verifyChallenge({
      challengeId: reauthSend.value.challengeId,
      code: latestCode(),
      continuationToken: reauthSend.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw new Error("proof");
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138002",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
      reauthToken: reauth.value.reauthToken,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("link");
    const code = latestCode();
    expect(
      await service.verifyChallenge({
        challengeId: link.value.challengeId,
        code,
        continuationToken: link.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    const bound = await service.completeFactor({
      challengeId: link.value.challengeId,
      code,
      continuationToken: link.value.continuationToken,
      reauthToken: reauth.value.reauthToken,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: token,
    });
    expect(bound.ok && bound.value.account.userId).toBe(
      email.registered.value.profile.id,
    );
    expect(bound.ok && bound.value.account.phone.state).toBe("verified");
  });

  it("refuses factor completion after five failures, including the correct code", async () => {
    const { service } = harness();
    const email = await registerEmail(service, "exhaust@example.com", "次数");
    const token = email.registered.value.token;
    const reauthSend = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
    });
    if (!reauthSend.ok || reauthSend.value.continuationToken === undefined)
      throw new Error("reauth");
    const reauth = await service.verifyChallenge({
      challengeId: reauthSend.value.challengeId,
      code: latestCode(),
      continuationToken: reauthSend.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw new Error("proof");
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138003",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
      reauthToken: reauth.value.reauthToken,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("link");
    const code = latestCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await service.completeFactor({
          challengeId: link.value.challengeId,
          code: "000000",
          continuationToken: link.value.continuationToken,
          reauthToken: reauth.value.reauthToken,
          expectedVersion: 0,
          idempotencyKey: key(),
          sessionToken: token,
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_CODE_INVALID" });
    }
    expect(
      await service.completeFactor({
        challengeId: link.value.challengeId,
        code,
        continuationToken: link.value.continuationToken,
        reauthToken: reauth.value.reauthToken,
        expectedVersion: 0,
        idempotencyKey: key(),
        sessionToken: token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CODE_EXHAUSTED" });
    expect((await service.readAccount(token)).ok && true).toBe(true);
    const account = await service.readAccount(token);
    expect(account.ok && account.value.phone.state).toBe("unbound");
    expect(account.ok && account.value.userId).toBe(
      email.registered.value.profile.id,
    );
  });

  it("maps an attempts-bound constraint failure to exhaustion", async () => {
    const memory = createMemoryCommunityAuthPort();
    const now = new Date("2026-09-22T12:00:00.000Z");
    const service = new CommunityAuthService(
      {
        transaction: (work) =>
          memory.transaction(async (tx) =>
            work({
              ...tx,
              saveChallenge: async (row) => {
                if (row.attempts >= 5) {
                  throw Object.assign(
                    new Error(
                      'violates check constraint "auth_challenges_attempts_bounded"',
                    ),
                    {
                      code: "23514",
                      constraint: "auth_challenges_attempts_bounded",
                    },
                  );
                }
                await tx.saveChallenge(row);
              },
            }),
          ),
      },
      {
        environment: "development",
        profile: "full-local",
        keys,
        emailMode: "local_capture",
        phoneMode: "simulated",
        delivery: delivery(),
        clock: () => now,
      },
    );
    const email = await registerEmail(
      service,
      "constraint@example.com",
      "约束",
    );
    const token = email.registered.value.token;
    const reauthSend = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
    });
    if (!reauthSend.ok || reauthSend.value.continuationToken === undefined)
      throw new Error("reauth");
    const reauth = await service.verifyChallenge({
      challengeId: reauthSend.value.challengeId,
      code: latestCode(),
      continuationToken: reauthSend.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw new Error("proof");
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138004",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
      reauthToken: reauth.value.reauthToken,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("link");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        await service.completeFactor({
          challengeId: link.value.challengeId,
          code: "000000",
          continuationToken: link.value.continuationToken,
          reauthToken: reauth.value.reauthToken,
          expectedVersion: 0,
          idempotencyKey: key(),
          sessionToken: token,
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_CODE_INVALID" });
    }
    await expect(
      service.completeFactor({
        challengeId: link.value.challengeId,
        code: "000000",
        continuationToken: link.value.continuationToken,
        reauthToken: reauth.value.reauthToken,
        expectedVersion: 0,
        idempotencyKey: key(),
        sessionToken: token,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "AUTH_CODE_EXHAUSTED" });
  });

  it("refuses a contact owned by someone else and a simulated proof after the provider mode changes", async () => {
    const { service, port } = harness();
    await registerEmail(service, "one@example.com", "甲");
    const other = await registerEmail(service, "two@example.com", "乙");
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: other.registered.value.token,
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("re");
    const proof = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: latestCode(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!proof.ok || proof.value.outcome !== "reauthenticated")
      throw new Error("p");
    const replace = await service.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "one@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: other.registered.value.token,
      reauthToken: proof.value.reauthToken,
    });
    if (!replace.ok || replace.value.continuationToken === undefined)
      throw new Error("rep");
    expect(
      await service.completeFactor({
        challengeId: replace.value.challengeId,
        code: latestCode(),
        continuationToken: replace.value.continuationToken,
        reauthToken: proof.value.reauthToken,
        expectedVersion: 1,
        idempotencyKey: key(),
        sessionToken: other.registered.value.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_IDENTIFIER_CONFLICT" });
    const switched = new CommunityAuthService(port, {
      environment: "development",
      profile: "full-local",
      keys,
      emailMode: "provider",
      phoneMode: "disabled",
      delivery: delivery(),
    });
    const attempt = await switched.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "one@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!attempt.ok || attempt.value.continuationToken === undefined)
      throw new Error("sw");
    expect(
      await switched.verifyChallenge({
        challengeId: attempt.value.challengeId,
        code: latestCode(),
        continuationToken: attempt.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROVENANCE_REJECTED" });
  });

  it("refuses a suspended account at the commit boundary", async () => {
    const { service, port } = harness();
    const account = await registerEmail(service);
    port.setStatus(account.registered.value.profile.id, "suspended");
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "owner@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("send");
    expect(
      await service.verifyChallenge({
        challengeId: sent.value.challengeId,
        code: latestCode(),
        continuationToken: sent.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_ACCOUNT_SUSPENDED" });
  });

  it("maps provider results without treating transport success as verification", () => {
    expect(interpretTencentSendEmail({ MessageId: "msg-1" })).toEqual({
      state: "accepted",
      correlation: "msg-1",
    });
    expect(
      mapTencentSendEmail({
        from: "auth@example.com",
        to: "person@example.com",
        templateId: 42,
        code: "123456",
        minutes: 5,
      }),
    ).toEqual({
      FromEmailAddress: "auth@example.com",
      Destination: ["person@example.com"],
      Subject: "由于艺验证码",
      Template: {
        TemplateID: 42,
        TemplateData: JSON.stringify({ code: "123456", minutes: "5" }),
      },
    });
    expect(
      mapAliyunSendSmsVerifyCode({
        e164: "+8613800138000",
        signName: "由于艺",
        templateCode: "SMS_1",
        schemeName: "artvenn",
        outId: "challenge-1",
      }),
    ).toMatchObject({
      CodeLength: 6,
      CodeType: 1,
      ValidTime: 300,
      ReturnVerifyCode: false,
      TemplateParam: '{"code":"##code##","min":"5"}',
      OutId: "challenge-1",
    });
    expect(
      mapAliyunCheckSmsVerifyCode({
        e164: "+8613800138000",
        schemeName: "artvenn",
        code: "123456",
        outId: "challenge-1",
      }).VerifyCode,
    ).toBe("123456");
    expect(
      interpretAliyunCheck({
        Code: "OK",
        Success: true,
        Model: { VerifyResult: "UNKNOWN" },
      }),
    ).toBe("fail");
    expect(
      interpretAliyunCheck({
        Code: "OK",
        Success: true,
        Model: { VerifyResult: "PASS" },
      }),
    ).toBe("pass");
    expect(
      interpretAliyunSend({
        Code: "OK",
        Success: true,
        Model: { VerifyCode: "123456" },
      }),
    ).toEqual({
      state: "failed",
    });
    expect(() => assertLoopbackCaptureUrl("https://example.com")).toThrow(
      /loopback/u,
    );
    expect(() =>
      assertProductionAuthConfiguration({
        NODE_ENV: "production",
        AUTH_EMAIL_PROVIDER: "local_capture",
      }),
    ).toThrow(/Production rejects/u);
    expect(
      assertProductionAuthConfiguration({ NODE_ENV: "production" }),
    ).toBeUndefined();
  });
});

describe("authentication HTTP", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
    servers.clear();
  });

  it("serves the development profile and leaves production unmounted", async () => {
    const port = createMemoryCommunityAuthPort();
    const auth = harness();
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "development",
        communityIdentityPort: {
          findDevelopmentAccountByHandle: async () => null,
          createSession: async () => undefined,
          findSessionUser: async () => null,
          revokeSession: async () => false,
          setUserStatus: async () => null,
        },
        authService: auth.service,
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const capabilities = await fetch(`${base}/v1/community/auth/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      profile: "full-local",
      phone: { available: true },
    });
    expect(() =>
      createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
        storageUrlResolver: new UnconfiguredStorageUrlResolver(),
        communityIdentityPort: {
          findDevelopmentAccountByHandle: async () => null,
          createSession: async () => undefined,
          findSessionUser: async () => null,
          revokeSession: async () => false,
          setUserStatus: async () => null,
        },
        authService: auth.service,
      }),
    ).toThrow(/not composed in production/u);
    expect(port).toBeDefined();
  });

  it("does not keep an identity change when handoff consumption fails", async () => {
    const memory = createMemoryCommunityAuthPort();
    let armed = false;
    const port: CommunityAuthPort = {
      transaction: (work) =>
        memory.transaction((tx) =>
          work({
            ...tx,
            consumeHandoff: async (id, at) =>
              armed ? "consumed" : tx.consumeHandoff(id, at),
          }),
        ),
    };
    let now = new Date("2026-09-22T12:00:00.000Z");
    const service = new CommunityAuthService(port, {
      environment: "development",
      profile: "full-local",
      keys,
      emailMode: "local_capture",
      phoneMode: "simulated",
      delivery: delivery(),
      clock: () => now,
    });
    const email = await registerEmail(service, "rollback@example.com", "回滚");
    const token = email.registered.value.token;
    const proof = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
    });
    if (!proof.ok || proof.value.continuationToken === undefined)
      throw new Error("reauth");
    const reauth = await service.verifyChallenge({
      challengeId: proof.value.challengeId,
      code: latestCode(),
      continuationToken: proof.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw new Error("proof");
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138009",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: token,
      reauthToken: reauth.value.reauthToken,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("link");
    const phoneCode = latestCode();
    armed = true;
    expect(
      await service.completeFactor({
        challengeId: link.value.challengeId,
        code: phoneCode,
        continuationToken: link.value.continuationToken,
        reauthToken: reauth.value.reauthToken,
        expectedVersion: 0,
        idempotencyKey: key(),
        sessionToken: token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect((await service.readAccount(token)).ok).toBe(true);
    const rejected = await service.readAccount(token);
    expect(rejected.ok && rejected.value.phone.state).toBe("unbound");
    armed = false;
    now = new Date(now.getTime() + 61_000);
    const recovered = await service.completeFactor({
      challengeId: link.value.challengeId,
      code: phoneCode,
      continuationToken: link.value.continuationToken,
      reauthToken: reauth.value.reauthToken,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: token,
    });
    expect(recovered.ok && recovered.value.account.phone.state).toBe(
      "verified",
    );
    if (!recovered.ok) return;
    const replaceProof = await service.sendChallenge({
      channel: "phone",
      purpose: "reauthenticate",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: recovered.value.session.token,
    });
    if (!replaceProof.ok || replaceProof.value.continuationToken === undefined)
      throw new Error("replace reauth");
    const replaceReauth = await service.verifyChallenge({
      challengeId: replaceProof.value.challengeId,
      code: latestCode(),
      continuationToken: replaceProof.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!replaceReauth.ok || replaceReauth.value.outcome !== "reauthenticated")
      throw new Error("replace proof");
    const replacement = await service.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "changed-back@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: recovered.value.session.token,
      reauthToken: replaceReauth.value.reauthToken,
    });
    if (!replacement.ok || replacement.value.continuationToken === undefined)
      throw new Error("replace");
    const replaceCode = latestCode();
    armed = true;
    expect(
      await service.completeFactor({
        challengeId: replacement.value.challengeId,
        code: replaceCode,
        continuationToken: replacement.value.continuationToken,
        reauthToken: replaceReauth.value.reauthToken,
        expectedVersion: recovered.value.account.email.version,
        idempotencyKey: key(),
        sessionToken: recovered.value.session.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    const still = await service.readAccount(recovered.value.session.token);
    expect(still.ok && still.value.email.masked).toBe("r***@example.com");
    expect(
      await service.unlinkFactor({
        channel: "email",
        reauthToken: replaceReauth.value.reauthToken,
        expectedVersion: recovered.value.account.email.version,
        idempotencyKey: key(),
        sessionToken: recovered.value.session.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    const kept = await service.readAccount(recovered.value.session.token);
    expect(kept.ok && kept.value.email.masked).toBe("r***@example.com");
    armed = false;
    const unlinked = await service.unlinkFactor({
      channel: "email",
      reauthToken: replaceReauth.value.reauthToken,
      expectedVersion: recovered.value.account.email.version,
      idempotencyKey: key(),
      sessionToken: recovered.value.session.token,
    });
    expect(unlinked.ok && unlinked.value.account.email.state).toBe("unbound");
    void now;
  });

  it("recovers a lost sign-in response only until logout or expiry", async () => {
    const { service, advance } = harness("full-local", {
      sessionTtlMs: 60_000,
    });
    const email = await registerEmail(service, "receipt@example.com", "回执");
    await service.signOut(email.registered.value.token);
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "receipt@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("send");
    const body = {
      challengeId: sent.value.challengeId,
      code: latestCode(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    };
    const first = await service.verifyChallenge(body);
    const retry = await service.verifyChallenge(body);
    expect(first.ok && first.value.outcome).toBe("signed_in");
    expect(retry.ok && retry.value.outcome).toBe("signed_in");
    if (
      !first.ok ||
      first.value.outcome !== "signed_in" ||
      !retry.ok ||
      retry.value.outcome !== "signed_in"
    )
      return;
    expect((await service.readAccount(retry.value.session.token)).ok).toBe(
      true,
    );
    expect(await service.readAccount(first.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    expect(await service.signOut(retry.value.session.token)).toMatchObject({
      ok: true,
      value: { signedOut: true },
    });
    expect(await service.verifyChallenge(body)).toMatchObject({ ok: false });
    expect(await service.readAccount(retry.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const fresh = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "receipt@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!fresh.ok || fresh.value.continuationToken === undefined)
      throw new Error("fresh");
    const freshBody = {
      challengeId: fresh.value.challengeId,
      code: latestCode(),
      continuationToken: fresh.value.continuationToken,
      idempotencyKey: key(),
    };
    const again = await service.verifyChallenge(freshBody);
    expect(again.ok && again.value.outcome).toBe("signed_in");
    if (!again.ok || again.value.outcome !== "signed_in") return;
    advance(60_001);
    expect(await service.readAccount(again.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    expect(await service.verifyChallenge(freshBody)).toMatchObject({
      ok: false,
    });
    advance(61_000);
    const restored = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "receipt@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!restored.ok || restored.value.continuationToken === undefined)
      throw new Error("restored");
    expect(
      await service.verifyChallenge({
        challengeId: restored.value.challengeId,
        code: latestCode(),
        continuationToken: restored.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true, value: { outcome: "signed_in" } });
  });

  it("ignores forwarded headers when naming the request source", () => {
    const request = {
      headers: { "x-forwarded-for": "203.0.113.5" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(trustedRequestSource(request as never)).toBe("127.0.0.1");
  });
});
