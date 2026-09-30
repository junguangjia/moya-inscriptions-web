import { z } from "zod";

/**
 * Account and authentication DTOs. Masked contacts and capability flags only.
 * Raw email, phone, OTP and Session tokens are not part of these objects.
 * The one-time Session grant lives on the server-only schema below and is
 * removed by the same-origin Web route before it reaches browser JavaScript.
 */

export const authChannelSchema = z.enum(["email", "phone"]);

export const authChannelStateSchema = z.enum([
  "unbound",
  "verified",
  "unavailable",
  "pending",
]);

export const authFactorSchema = z.strictObject({
  channel: authChannelSchema,
  state: authChannelStateSchema,
  /** Null when unbound. Never the full address or number. */
  masked: z.string().min(1).max(80).nullable(),
  /** Zero when unbound. The client sends it back as a stale-write guard. */
  version: z.number().int().nonnegative().max(2147483647),
  usable: z.boolean(),
});

export const authCapabilitiesSchema = z.strictObject({
  profile: z.enum(["full-local", "email-first", "disabled"]),
  email: z.strictObject({
    available: z.boolean(),
    reason: z.string().min(1).max(200).nullable(),
  }),
  phone: z.strictObject({
    available: z.boolean(),
    reason: z.string().min(1).max(200).nullable(),
  }),
  /** Development labeling. Authentication is not identity proofing. */
  developmentOnly: z.boolean(),
});

export const authAccountSecuritySchema = z.strictObject({
  userId: z.string().regex(/^user-[0-9a-f]{32}$/u),
  email: authFactorSchema,
  phone: authFactorSchema,
  capabilities: authCapabilitiesSchema,
});

export const authPasswordSchema = z
  .string()
  .refine((value) => {
    const length = [...value].length;
    return (
      length >= 6 &&
      length <= 20 &&
      /[A-Z]/u.test(value) &&
      /[0-9]/u.test(value) &&
      !value.includes("\u0000") &&
      !/[\uD800-\uDFFF]/u.test(value)
    );
  }, "Password must contain 6–20 Unicode code points, an ASCII uppercase letter and a digit")
  .meta({
    description:
      "6–20 Unicode code points, including an ASCII uppercase letter and digit; do not trim or normalize; no NUL or lone surrogate. Never stored as plaintext.",
    writeOnly: true,
  });
export const studioNameSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      [...value].length <= 6 &&
      !value.includes("\u0000") &&
      !/[\uD800-\uDFFF]/u.test(value),
    "Invalid studio name",
  );

const idempotencyKeySchema = z.string().uuid();
const continuationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const otpSchema = z.string().regex(/^\d{6}$/u);

export const authChallengeRequestSchema = z.strictObject({
  channel: authChannelSchema,
  purpose: z.enum([
    "sign_in",
    "register",
    "link",
    "replace",
    "reauthenticate",
    "password_reset",
  ]),
  identifier: z.string().min(1).max(254).optional(),
  idempotencyKey: idempotencyKeySchema,
  reauthToken: continuationTokenSchema.optional(),
});

export const authChallengeAcceptedSchema = z.strictObject({
  challengeId: z.string().regex(/^challenge-[0-9a-f]{32}$/u),
  resendAvailableAt: z.iso.datetime({ offset: false }),
  maskedTarget: z.string().min(1).max(80),
  /** Present on the first accept only. A replay omits it; the client keeps its copy. */
  continuationToken: continuationTokenSchema.optional(),
});

export const authVerifyRequestSchema = z.strictObject({
  challengeId: z.string().regex(/^challenge-[0-9a-f]{32}$/u),
  code: otpSchema,
  continuationToken: continuationTokenSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const authRegistrationRequestSchema = z.strictObject({
  handoffToken: continuationTokenSchema,
  displayName: z.string().min(1).max(40),
  password: authPasswordSchema.optional(),
  studioName: studioNameSchema.optional(),
  agreement: z.literal(true),
  idempotencyKey: idempotencyKeySchema,
});

export const authPasswordLoginRequestSchema = z.strictObject({
  channel: authChannelSchema,
  identifier: z.string().min(1).max(254),
  // Do not expose composition differences on sign-in; the service verifies generically.
  password: z.string().max(80).meta({
    writeOnly: true,
    description:
      "Password input; missing, unset and invalid credentials have the same sign-in result.",
  }),
  idempotencyKey: idempotencyKeySchema,
});
export const authPasswordResetRequestSchema = z.strictObject({
  handoffToken: continuationTokenSchema,
  password: authPasswordSchema,
  idempotencyKey: idempotencyKeySchema,
});
export const authPasswordResetResultSchema = z.strictObject({
  reset: z.literal(true),
});
export type AuthPasswordLoginRequest = z.infer<
  typeof authPasswordLoginRequestSchema
>;
export type AuthPasswordResetRequest = z.infer<
  typeof authPasswordResetRequestSchema
>;
export type AuthPasswordResetResult = z.infer<
  typeof authPasswordResetResultSchema
>;

export const authFactorCompleteRequestSchema = z.strictObject({
  challengeId: z.string().regex(/^challenge-[0-9a-f]{32}$/u),
  code: otpSchema,
  continuationToken: continuationTokenSchema,
  reauthToken: continuationTokenSchema,
  expectedVersion: z.number().int().nonnegative().max(2147483647),
  idempotencyKey: idempotencyKeySchema,
});

export const authUnlinkRequestSchema = z.strictObject({
  channel: authChannelSchema,
  reauthToken: continuationTokenSchema,
  expectedVersion: z.number().int().positive().max(2147483647),
  idempotencyKey: idempotencyKeySchema,
});

export type AuthChannel = z.infer<typeof authChannelSchema>;
export type AuthChannelState = z.infer<typeof authChannelStateSchema>;
export type AuthFactor = z.infer<typeof authFactorSchema>;
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;
export type AuthAccountSecurity = z.infer<typeof authAccountSecuritySchema>;
export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;
export type AuthChallengeAccepted = z.infer<typeof authChallengeAcceptedSchema>;
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;
export type AuthRegistrationRequest = z.infer<
  typeof authRegistrationRequestSchema
>;
export type AuthFactorCompleteRequest = z.infer<
  typeof authFactorCompleteRequestSchema
>;
export type AuthUnlinkRequest = z.infer<typeof authUnlinkRequestSchema>;
