import { describe, expect, it } from "vitest";
import {
  authCapabilitiesSchema,
  authChallengeRequestSchema,
} from "@moya/contracts/schemas";

const request = {
  channel: "email",
  purpose: "register",
  identifier: "synthetic@example.invalid",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};

describe("invitation registration contract", () => {
  it("accepts existing challenge clients and a bounded opaque invitation", () => {
    expect(authChallengeRequestSchema.safeParse(request).success).toBe(true);
    const syntheticCode = "A".repeat(22);
    expect(
      authChallengeRequestSchema.parse({
        ...request,
        invitationCode: ` ${syntheticCode} `,
      }).invitationCode,
    ).toBe(syntheticCode);
    for (const invitationCode of [
      "",
      "A".repeat(21),
      "A".repeat(23),
      "a/".repeat(11),
    ]) {
      expect(
        authChallengeRequestSchema.safeParse({ ...request, invitationCode })
          .success,
      ).toBe(false);
    }
  });

  it("advertises invitation requirements without accepting a code in capabilities", () => {
    const capabilities = {
      profile: "email-first",
      email: { available: true, reason: null },
      phone: { available: false, reason: "Disabled" },
      developmentOnly: false,
      registration: {
        available: true,
        agreement: {
          version: "synthetic-v1",
          title: "Synthetic",
          body: "Test material only.",
        },
        reason: null,
        invitationRequired: true,
      },
    };
    expect(
      authCapabilitiesSchema.parse(capabilities).registration
        ?.invitationRequired,
    ).toBe(true);
    expect(
      authCapabilitiesSchema.safeParse({
        ...capabilities,
        registration: {
          ...capabilities.registration,
          invitationCode: "A".repeat(22),
        },
      }).success,
    ).toBe(false);
    const { invitationRequired: _unused, ...legacy } =
      capabilities.registration;
    expect(_unused).toBe(true);
    expect(
      authCapabilitiesSchema.safeParse({
        ...capabilities,
        registration: legacy,
      }).success,
    ).toBe(true);
  });
});
