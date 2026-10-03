import { createMailpitCapture } from "./delivery.js";
import { CommunityAuthService } from "./community-auth-service.js";
import type { CommunityAuthPort } from "./auth-port.js";
import type { AuthRegistrationAgreement } from "@moya/contracts";
import type { AuthDeliveryPorts } from "./community-auth-service.js";
import type { AuthKeys } from "./contact-crypto.js";

const keyFrom = (value: string | undefined, name: string): Uint8Array => {
  if (value === undefined || value.trim() === "")
    throw new Error(`${name} is required for the authentication profile`);
  const binary = atob(value);
  const key = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (key.byteLength !== 32)
    throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
};

export interface ProductionAuthConfiguration {
  readonly keys: AuthKeys;
  readonly profile?: "email-first" | "password-only";
  readonly phoneEnabled: boolean;
}

/** Explicit Production configuration only; no local-provider fallback. */
export const productionAuthConfigurationFrom = (
  env: Readonly<Record<string, string | undefined>>,
): ProductionAuthConfiguration | null => {
  if (env.NODE_ENV !== "production") return null;
  if (
    (env.AUTH_PROFILE !== undefined &&
      env.AUTH_PROFILE !== "" &&
      !["email-first", "password-only"].includes(env.AUTH_PROFILE)) ||
    [env.AUTH_EMAIL_CAPTURE_URL, env.AUTH_PHONE_CAPTURE_URL].some(
      (value) => value !== undefined && value !== "",
    ) ||
    (env.AUTH_EMAIL_PROVIDER !== undefined &&
      env.AUTH_EMAIL_PROVIDER !== "" &&
      !["disabled", "tencent-ses"].includes(env.AUTH_EMAIL_PROVIDER)) ||
    (env.AUTH_PHONE_PROVIDER !== undefined &&
      env.AUTH_PHONE_PROVIDER !== "" &&
      !["disabled", "aliyun-dypns"].includes(env.AUTH_PHONE_PROVIDER))
  )
    throw new Error(
      "Production rejects local authentication providers and unsupported profiles",
    );
  if (
    env.AUTH_PUBLIC_ENABLED === undefined ||
    env.AUTH_PUBLIC_ENABLED === "" ||
    env.AUTH_PUBLIC_ENABLED === "false"
  )
    return null;
  if (env.AUTH_PUBLIC_ENABLED !== "true")
    throw new Error("AUTH_PUBLIC_ENABLED must be true or false");
  const passwordOnly = env.AUTH_PROFILE === "password-only";
  if (passwordOnly) {
    if (
      env.AUTH_EMAIL_PROVIDER !== "disabled" ||
      env.AUTH_PHONE_PROVIDER !== "disabled" ||
      Object.entries(env).some(
        ([name, value]) =>
          /^(TENCENT_SES_|ALIYUN_)/u.test(name) &&
          value !== undefined &&
          value !== "",
      )
    )
      throw new Error(
        "password-only requires disabled OTP providers and no delivery configuration",
      );
  } else if (env.AUTH_EMAIL_PROVIDER !== "tencent-ses")
    throw new Error("AUTH_EMAIL_PROVIDER must be tencent-ses when enabled");
  const version = env.AUTH_KEY_VERSION;
  if (
    version === undefined ||
    !/^[1-9][0-9]*$/u.test(version) ||
    !Number.isSafeInteger(Number(version))
  )
    throw new Error("AUTH_KEY_VERSION must be a positive safe integer");
  return {
    profile: passwordOnly ? "password-only" : "email-first",
    keys: {
      version: Number(version),
      lookupKey: keyFrom(env.AUTH_LOOKUP_KEY, "AUTH_LOOKUP_KEY"),
      encryptionKey: keyFrom(env.AUTH_ENCRYPTION_KEY, "AUTH_ENCRYPTION_KEY"),
      otpKey: keyFrom(env.AUTH_OTP_KEY, "AUTH_OTP_KEY"),
    },
    phoneEnabled: env.AUTH_PHONE_PROVIDER === "aliyun-dypns",
  };
};

export const assertProductionAuthConfiguration = (
  env: Readonly<Record<string, string | undefined>>,
): void => {
  productionAuthConfigurationFrom(env);
};

/** The existing service owns proofs, identities and Sessions in both environments. */
export const createProductionAuthService = (
  port: CommunityAuthPort,
  config: ProductionAuthConfiguration,
  delivery: AuthDeliveryPorts,
  registrationAgreement: AuthRegistrationAgreement | null,
): CommunityAuthService =>
  new CommunityAuthService(port, {
    environment: "production",
    profile: config.profile ?? "email-first",
    keys: config.keys,
    emailMode: config.profile === "password-only" ? "disabled" : "provider",
    phoneMode: config.phoneEnabled ? "provider" : "disabled",
    delivery,
    registrationAgreement,
  });

/** Development acceptance profiles. Unset AUTH_PROFILE leaves authentication unmounted. */
export const createDevelopmentAuthService = (
  port: CommunityAuthPort,
  env: Readonly<Record<string, string | undefined>>,
): CommunityAuthService | null => {
  const profile = env.AUTH_PROFILE;
  if (profile === undefined || profile === "") return null;
  if (profile !== "full-local" && profile !== "email-first")
    throw new Error("AUTH_PROFILE must be full-local or email-first");
  const keys: AuthKeys = {
    version: Number(env.AUTH_KEY_VERSION ?? "1"),
    lookupKey: keyFrom(env.AUTH_LOOKUP_KEY, "AUTH_LOOKUP_KEY"),
    encryptionKey: keyFrom(env.AUTH_ENCRYPTION_KEY, "AUTH_ENCRYPTION_KEY"),
    otpKey: keyFrom(env.AUTH_OTP_KEY, "AUTH_OTP_KEY"),
  };
  const captureUrl = env.AUTH_EMAIL_CAPTURE_URL ?? "http://127.0.0.1:3463";
  const mailpit = createMailpitCapture(captureUrl);
  return new CommunityAuthService(port, {
    environment: "development",
    profile,
    keys,
    emailMode: "local_capture",
    phoneMode: profile === "full-local" ? "simulated" : "disabled",
    delivery: {
      sendEmail: (input) => mailpit.sendEmail(input),
      sendPhone: async (input) => {
        if (input.code === null) return { state: "failed" };
        return mailpit.sendSimulatedSms({
          e164: input.e164,
          code: input.code,
          minutes: input.minutes,
        });
      },
      checkPhone: async () => "fail",
    },
  });
};
