import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  createProductionAuthService,
} from "@moya/api";
import type { AuthPurposeName } from "@moya/api";
import {
  createProductionAuthDelivery,
  loadProductionAuthConfiguration,
} from "@moya/backend-production/internal/auth";
import { ProviderTransportError } from "@moya/backend-production/internal/auth-transport";

const agreement = {
  version: "synthetic-pnvs-v1",
  title: "Synthetic agreement",
  body: "Synthetic isolated acceptance only.",
};
const phone = "+8613800138000";
const invitationCode = "S".repeat(22);

const harness = async () => {
  let now = new Date("2026-10-24T12:00:00Z");
  const env = {
    NODE_ENV: "production",
    AUTH_PUBLIC_ENABLED: "true",
    AUTH_PROFILE: "email-first",
    AUTH_EMAIL_PROVIDER: "disabled",
    AUTH_PHONE_PROVIDER: "aliyun-dypns",
    AUTH_REGISTRATION_MODE: "invite-only",
    AUTH_KEY_VERSION: "1",
    AUTH_LOOKUP_KEY: randomBytes(32).toString("base64"),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    AUTH_OTP_KEY: randomBytes(32).toString("base64"),
    ALIYUN_ACCESS_KEY_ID: "synthetic-access-id",
    ALIYUN_ACCESS_KEY_SECRET: "synthetic-access-secret",
    ALIYUN_SMS_SIGN_NAME: "Synthetic",
    ALIYUN_SMS_TEMPLATE_CODE: "100001",
    ALIYUN_SMS_SCHEME_NAME: "synthetic-pnvs",
  };
  const config = await loadProductionAuthConfiguration(env);
  if (config === null) throw Error("Synthetic configuration missing");
  const port = createMemoryCommunityAuthPort();
  port.provisionInvitation({
    id: "invite-" + "0".repeat(32),
    digest: createHash("sha256")
      .update("artvenn:registration-invitation:v1:" + invitationCode)
      .digest("hex"),
    environment: "production",
    maxUses: 20,
    usedCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null,
  });
  const messages: {
    outId: string;
    scheme: string;
    template: string;
    code: string;
  }[] = [];
  // A PNVS-like fixture deliberately ignores OutId: provider verification is
  // keyed by phone and SchemeName, not by the application's correlation field.
  const codes = new Map<string, { code: string; expires: number }>();
  let checks = 0;
  let sends = 0;
  let handoffs = 0;
  let checkBarrier: (() => Promise<void>) | undefined;
  let sendOutcome: "accepted" | "rejected" | "unknown" = "accepted";
  const delivery = createProductionAuthDelivery(config, {
    now: () => now,
    transport: async (request) => {
      const form = new URLSearchParams(request.body);
      const scheme = form.get("SchemeName") ?? "";
      const key = `${form.get("CountryCode")}:${form.get("PhoneNumber")}:${scheme}`;
      if (request.headers["x-acs-action"] === "SendSmsVerifyCode") {
        sends++;
        if (sendOutcome === "unknown")
          throw new ProviderTransportError("unknown");
        if (sendOutcome === "rejected")
          return {
            status: 200,
            body: JSON.stringify({
              Code: "isv.BUSINESS_LIMIT_CONTROL",
              Success: false,
            }),
          };
        const code = String(100000 + messages.length);
        messages.push({
          outId: form.get("OutId") ?? "",
          scheme,
          template: form.get("TemplateCode") ?? "",
          code,
        });
        codes.set(key, { code, expires: now.getTime() + 300000 });
        return {
          status: 200,
          body: JSON.stringify({
            Code: "OK",
            Success: true,
            Model: { BizId: "synthetic-biz-id" },
          }),
        };
      }
      checks++;
      const stored = codes.get(key);
      const pass =
        stored !== undefined &&
        stored.expires > now.getTime() &&
        stored.code === form.get("VerifyCode");
      // The race test pauses both successful checks before either consumes the
      // provider code, so atomicity must be enforced by the application too.
      if (pass) {
        await checkBarrier?.();
        codes.delete(key);
      }
      return {
        status: 200,
        body: JSON.stringify({
          Code: "OK",
          Success: true,
          Model: { VerifyResult: pass ? "PASS" : "UNKNOWN" },
        }),
      };
    },
  });
  const service = new CommunityAuthService(
    {
      transaction: (work) =>
        port.transaction((tx) =>
          work({
            ...tx,
            insertHandoff: async (row) => {
              handoffs++;
              await tx.insertHandoff(row);
            },
          }),
        ),
    },
    {
      environment: "production",
      profile: "email-first",
      keys: config.service.keys,
      emailMode: "disabled",
      phoneMode: "provider",
      registrationMode: "invite-only",
      registrationAgreement: agreement,
      delivery,
      clock: () => now,
    },
  );
  const challenge = async (purpose: AuthPurposeName, extra = {}) => {
    const sent = await service.sendChallenge({
      channel: "phone",
      purpose,
      identifier: phone,
      invitationCode,
      idempotencyKey: randomUUID(),
      source: "synthetic-pnvs",
      ...extra,
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw Error(sent.ok ? "Missing synthetic continuation" : sent.reason);
    const message = messages.find(
      (row) => row.outId === sent.value.challengeId,
    );
    if (message === undefined) throw Error("Missing synthetic message");
    return {
      challengeId: sent.value.challengeId,
      continuationToken: sent.value.continuationToken,
      code: message.code,
      idempotencyKey: randomUUID(),
    };
  };
  const register = async () => {
    const proof = await service.verifyChallenge(await challenge("register"));
    if (!proof.ok || proof.value.outcome !== "registration_required")
      throw Error("Synthetic registration verification refused");
    const registered = await service.confirmRegistration({
      handoffToken: proof.value.handoffToken,
      displayName: "Synthetic PNVS",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    });
    if (!registered.ok) throw Error(registered.reason);
    return registered.value;
  };
  return {
    service,
    config,
    delivery,
    port,
    messages,
    challenge,
    register,
    checks: () => checks,
    sends: () => sends,
    handoffs: () => handoffs,
    synchronizeNextTwoChecks: () => {
      let arrived = 0;
      let release!: () => void;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      checkBarrier = async () => {
        arrived++;
        if (arrived === 2) release();
        await both;
      };
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setSendOutcome: (outcome: typeof sendOutcome) => {
      sendOutcome = outcome;
    },
  };
};

describe("PNVS production-mode isolated authentication", () => {
  it("starts without SES and exposes only enabled OTP/password identifiers", async () => {
    const h = await harness();
    const service = createProductionAuthService(
      h.port,
      h.config.service,
      h.delivery,
      agreement,
    );
    expect(service.capabilities()).toMatchObject({
      profile: "email-first",
      email: { available: false },
      phone: { available: true },
      password: { identifiers: ["phone"] },
      registration: { available: true, invitationRequired: true },
    });
    expect(
      await service.sendChallenge({
        channel: "email",
        purpose: "register",
        identifier: "synthetic@example.invalid",
        idempotencyKey: randomUUID(),
        source: "synthetic",
      }),
    ).toEqual({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
    expect(
      (
        await h.delivery.sendEmail({
          to: "synthetic@example.invalid",
          code: "000000",
          minutes: 5,
        })
      ).state,
    ).toBe("failed");
    expect(h.messages).toHaveLength(0);
  });

  it("keeps invitation/agreement gates and registers and signs in to one verified phone account", async () => {
    const h = await harness();
    expect(
      await h.service.sendChallenge({
        channel: "phone",
        purpose: "register",
        identifier: phone,
        idempotencyKey: randomUUID(),
        source: "synthetic",
      }),
    ).toEqual({ ok: false, reason: "AUTH_INVITATION_REQUIRED" });
    expect(h.messages).toHaveLength(0);
    const proof = await h.service.verifyChallenge(
      await h.challenge("register"),
    );
    if (!proof.ok || proof.value.outcome !== "registration_required")
      throw Error("Synthetic verification refused");
    const confirm = {
      handoffToken: proof.value.handoffToken,
      displayName: "Synthetic PNVS",
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    };
    expect(
      await h.service.confirmRegistration({ ...confirm, agreement: false }),
    ).toEqual({ ok: false, reason: "AUTH_AGREEMENT_REQUIRED" });
    expect(
      await h.service.confirmRegistration({
        ...confirm,
        agreement: true,
        agreementVersion: "stale-synthetic",
      }),
    ).toEqual({ ok: false, reason: "AUTH_NOT_CONFIGURED" });
    const registered = await h.service.confirmRegistration({
      ...confirm,
      agreement: true,
    });
    if (!registered.ok) throw Error(registered.reason);
    const signedIn = await h.service.verifyChallenge(
      await h.challenge("sign_in"),
    );
    if (!signedIn.ok || signedIn.value.outcome !== "signed_in")
      throw Error("Synthetic sign-in refused");
    expect(signedIn.value.session.profile.id).toBe(registered.value.profile.id);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
    const account = await h.service.readAccount(signedIn.value.session.token);
    expect(account.ok && account.value.phone.state === "verified").toBe(true);
    expect(account.ok && account.value.phone.usable).toBe(true);
  });

  it("does not accept a sign-in code for a reauthentication challenge sharing the same phone", async () => {
    const h = await harness();
    const account = await h.register();
    const signIn = await h.challenge("sign_in");
    const reauth = await h.challenge("reauthenticate", {
      sessionToken: account.token,
    });
    expect(
      await h.service.verifyChallenge({ ...reauth, code: signIn.code }),
    ).toEqual({ ok: false, reason: "AUTH_CODE_INVALID" });
    const proof = await h.service.verifyChallenge(reauth);
    expect(proof.ok && proof.value.outcome).toBe("reauthenticated");
    expect(h.messages.at(-1)?.template).toBe("100005");
    expect(new Set(h.messages.map((row) => row.scheme)).size).toBe(
      h.messages.length,
    );
    expect(h.messages.every((row) => row.scheme.length <= 20)).toBe(true);
  });

  it("supersedes a resend and does not accept the previous challenge code", async () => {
    const h = await harness();
    await h.register();
    const first = await h.challenge("sign_in");
    h.advance(60001);
    const second = await h.challenge("sign_in");
    const before = h.checks();
    expect(await h.service.verifyChallenge(first)).toEqual({
      ok: false,
      reason: "AUTH_CODE_SUPERSEDED",
    });
    expect(h.checks()).toBe(before);
    expect(
      await h.service.verifyChallenge({ ...second, code: first.code }),
    ).toEqual({ ok: false, reason: "AUTH_CODE_INVALID" });
    expect((await h.service.verifyChallenge(second)).ok).toBe(true);
  });

  it("bounds invalid attempts and expiry before granting a session", async () => {
    const h = await harness();
    await h.register();
    const proof = await h.challenge("sign_in");
    for (let i = 0; i < 5; i++)
      expect(
        await h.service.verifyChallenge({ ...proof, code: "999999" }),
      ).toEqual({ ok: false, reason: "AUTH_CODE_INVALID" });
    const before = h.checks();
    expect(await h.service.verifyChallenge(proof)).toEqual({
      ok: false,
      reason: "AUTH_CODE_EXHAUSTED",
    });
    expect(h.checks()).toBe(before);
    h.advance(900001);
    const fresh = await h.challenge("sign_in");
    h.advance(300001);
    expect(await h.service.verifyChallenge(fresh)).toEqual({
      ok: false,
      reason: "AUTH_CODE_EXPIRED",
    });
    expect(h.checks()).toBe(before);
  });

  it("atomically consumes concurrent registration and refuses a different-key replay", async () => {
    const h = await harness();
    const input = await h.challenge("register");
    h.synchronizeNextTwoChecks();
    const outcomes = await Promise.all([
      h.service.verifyChallenge(input),
      h.service.verifyChallenge({ ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(h.checks()).toBe(2);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(h.handoffs()).toBe(1);
    const winner = outcomes.find((result) => result.ok);
    if (!winner?.ok || winner.value.outcome !== "registration_required")
      throw Error("Missing synthetic winner");
    const registered = await h.service.confirmRegistration({
      handoffToken: winner.value.handoffToken,
      displayName: "Synthetic race",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    });
    expect(registered.ok).toBe(true);
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(1);
    const before = h.checks();
    expect(
      (
        await h.service.verifyChallenge({
          ...input,
          idempotencyKey: randomUUID(),
        })
      ).ok,
    ).toBe(false);
    expect(h.checks()).toBe(before);
  });

  it("retains the target send budget for provider-generated phone codes", async () => {
    const h = await harness();
    for (let i = 0; i < 8; i++) {
      await h.challenge("register");
      h.advance(60001);
    }
    expect(
      await h.service.sendChallenge({
        channel: "phone",
        purpose: "register",
        identifier: phone,
        invitationCode,
        idempotencyKey: randomUUID(),
        source: "synthetic-pnvs",
      }),
    ).toEqual({ ok: false, reason: "AUTH_RATE_LIMITED" });
    expect(h.sends()).toBe(8);
  });

  it.each(["rejected", "unknown"] as const)(
    "does not retry a %s provider send",
    async (outcome) => {
      const h = await harness();
      h.setSendOutcome(outcome);
      const input = {
        channel: "phone" as const,
        purpose: "register" as const,
        identifier: phone,
        invitationCode,
        idempotencyKey: randomUUID(),
        source: "synthetic",
      };
      const expected = {
        ok: false,
        reason:
          outcome === "unknown"
            ? "AUTH_DELIVERY_UNKNOWN"
            : "AUTH_DELIVERY_FAILED",
      };
      expect(await h.service.sendChallenge(input)).toEqual(expected);
      expect(await h.service.sendChallenge(input)).toEqual(expected);
      expect(h.messages).toHaveLength(0);
      expect(h.checks()).toBe(0);
      expect(h.sends()).toBe(1);
    },
  );

  it("selects each purpose's template and isolates even equal phone/template combinations", async () => {
    const h = await harness();
    const purposes = [
      "sign_in",
      "register",
      "replace",
      "password_reset",
      "link",
      "reauthenticate",
    ] as const;
    for (const purpose of purposes) {
      expect(
        (
          await h.delivery.sendPhone({
            purpose,
            e164: phone,
            code: null,
            outId: `synthetic-${purpose}`,
            minutes: 5,
          })
        ).state,
      ).toBe("accepted");
    }
    expect(h.messages.map((message) => message.template)).toEqual([
      "100001",
      "100001",
      "100002",
      "100003",
      "100004",
      "100005",
    ]);
    const login = h.messages[0]!;
    expect(
      await h.delivery.checkPhone({
        e164: phone,
        code: login.code,
        outId: "synthetic-register",
      }),
    ).toBe("fail");
    expect(
      await h.delivery.checkPhone({
        e164: phone,
        code: login.code,
        outId: "synthetic-sign_in",
      }),
    ).toBe("pass");
  });
});
