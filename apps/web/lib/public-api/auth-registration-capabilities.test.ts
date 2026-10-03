import { describe, expect, it } from "vitest";
import {
  authCapabilitiesSchema,
  authRegistrationAgreementSchema,
  authRegistrationRequestSchema,
} from "@moya/contracts/schemas";

const agreement = {
  version: "synthetic-registration-v1",
  title: "Synthetic agreement fixture",
  body: "Fixture only; not approved legal material.",
};
const capabilities = {
  profile: "email-first",
  email: { available: true, reason: null },
  phone: { available: false, reason: "AUTH_CHANNEL_UNAVAILABLE" },
  developmentOnly: false,
};

describe("shared registration capability boundary", () => {
  it("accepts legacy Development capabilities and consistent registration states", () => {
    expect(authCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      authCapabilitiesSchema.safeParse({
        ...capabilities,
        registration: { available: true, agreement, reason: null },
      }).success,
    ).toBe(true);
    expect(
      authCapabilitiesSchema.safeParse({
        ...capabilities,
        registration: {
          available: false,
          agreement: null,
          reason: "AUTH_NOT_CONFIGURED",
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    { available: true, agreement: null, reason: null },
    { available: false, agreement, reason: null },
    { available: true, agreement, reason: "AUTH_NOT_CONFIGURED" },
  ])("rejects contradictory registration capability %j", (registration) => {
    expect(
      authCapabilitiesSchema.safeParse({ ...capabilities, registration })
        .success,
    ).toBe(false);
  });

  it("bounds actual UTF-8 bytes and rejects missing or oversized agreement fields", () => {
    expect(
      authRegistrationAgreementSchema.safeParse({
        ...agreement,
        body: "界".repeat(10_922) + "ab",
      }).success,
    ).toBe(true);
    expect(
      authRegistrationAgreementSchema.safeParse({
        ...agreement,
        body: "界".repeat(10_923),
      }).success,
    ).toBe(false);
    for (const changed of [
      { version: "" },
      { version: "v".repeat(65) },
      { title: " " },
      { title: "t".repeat(121) },
      { body: " " },
      { body: "contains\u0000null" },
    ])
      expect(
        authRegistrationAgreementSchema.safeParse({ ...agreement, ...changed })
          .success,
      ).toBe(false);
  });

  it("preserves plain text and allows the exact optional request version", () => {
    const plain = {
      ...agreement,
      body: "<b>Literal text</b>\nUnchanged next line.",
    };
    expect(authRegistrationAgreementSchema.parse(plain)).toEqual(plain);
    const command = {
      handoffToken: "SYNTHETIC_REGISTRATION_HANDOFF".padEnd(43, "_"),
      displayName: "Synthetic user",
      agreement: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    };
    expect(authRegistrationRequestSchema.parse(command)).not.toHaveProperty(
      "agreementVersion",
    );
    expect(
      authRegistrationRequestSchema.parse({
        ...command,
        agreementVersion: agreement.version,
      }).agreementVersion,
    ).toBe(agreement.version);
    expect(
      authRegistrationRequestSchema.safeParse({
        ...command,
        agreementVersion: "v".repeat(65),
      }).success,
    ).toBe(false);
  });
});
