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

/** Runtime-supplied approved material, rendered as plain text without HTML parsing. */
export const authRegistrationAgreementSchema = z.strictObject({
  version: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0),
  title: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => value.trim().length > 0),
  body: z
    .string()
    .min(1)
    .max(32_768)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\u0000") &&
        new TextEncoder().encode(value).byteLength <= 32_768,
      "Registration agreement must be nonempty plain text of at most 32768 UTF-8 bytes",
    ),
});

const authRegistrationCapabilitySchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    agreement: authRegistrationAgreementSchema,
    reason: z.null(),
  }),
  z.strictObject({
    available: z.literal(false),
    agreement: z.null(),
    reason: z.string().min(1).max(200).nullable(),
  }),
]);

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
  /** Absent on legacy Development responses; Production registration fails closed. */
  registration: authRegistrationCapabilitySchema.optional(),
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

/** Combined display value; legacy unpaired writes retain their six-code-point limit. */
export const studioNameDisplaySchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      [...value].length <= 7 &&
      !value.includes("\u0000") &&
      !/[\uD800-\uDFFF]/u.test(value),
    "Invalid studio name",
  );
export const studioNameSuffixSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      [...value].length <= 2 &&
      !value.includes("\u0000") &&
      !/[\uD800-\uDFFF]/u.test(value),
    "Invalid studio name suffix",
  );

const validStudioNamePair = (name: string, suffix: string): boolean => {
  if (name === "" && suffix === "") return true;
  if (suffix === "" || !name.endsWith(suffix)) return false;
  const base = name.slice(0, -suffix.length);
  return base === base.trim() && [...base].length >= 1 && [...base].length <= 5;
};
/** New editors send the full combined name and the independently chosen suffix. */
export const studioNameInputSchema = z
  .strictObject({
    studioName: studioNameDisplaySchema,
    studioNameSuffix: studioNameSuffixSchema,
  })
  .refine(
    (input) => validStudioNamePair(input.studioName, input.studioNameSuffix),
    {
      path: ["studioName"],
      message:
        "Use a 1–5 character name and a 1–2 character suffix, or clear both",
    },
  );
/** Omitted fields preserve existing profiles; an unpaired value is a legacy write. */
export const refineStudioNameWrite = (
  input: {
    studioName?: string | undefined;
    studioNameSuffix?: string | undefined;
  },
  context: z.RefinementCtx,
): void => {
  const valid =
    input.studioNameSuffix === undefined
      ? input.studioName === undefined ||
        studioNameSchema.safeParse(input.studioName).success
      : input.studioName !== undefined &&
        validStudioNamePair(input.studioName, input.studioNameSuffix);
  if (!valid)
    context.addIssue({
      code: "custom",
      path: ["studioName"],
      message: "Invalid studio name and suffix",
    });
};

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

export const authRegistrationRequestSchema = z
  .strictObject({
    handoffToken: continuationTokenSchema,
    displayName: z.string().min(1).max(40),
    password: authPasswordSchema.optional(),
    studioName: studioNameDisplaySchema.optional(),
    studioNameSuffix: studioNameSuffixSchema.optional(),
    agreement: z.literal(true),
    /** Production must match the currently configured approved material. */
    agreementVersion: z.string().min(1).max(64).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(refineStudioNameWrite);

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
export type AuthRegistrationAgreement = z.infer<
  typeof authRegistrationAgreementSchema
>;
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
