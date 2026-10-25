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
  readonly emailEnabled?: boolean;
  readonly phoneEnabled: boolean;
  readonly registrationMode?: "closed" | "invite-only";
  readonly allowProvisionedHandleLogin?: boolean;
}

const registrationModeFrom = (
  value: string | undefined,
): "closed" | "invite-only" | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value !== "closed" && value !== "invite-only")
    throw new Error("AUTH_REGISTRATION_MODE must be closed or invite-only");
  return value;
};

const handleLoginFrom = (value: string | undefined): boolean => {
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true")
    throw new Error("AUTH_LEGACY_HANDLE_LOGIN_ENABLED must be true or false");
  return true;
};

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
  } else {
    if (!["disabled", "tencent-ses"].includes(env.AUTH_EMAIL_PROVIDER ?? ""))
      throw new Error(
        "AUTH_EMAIL_PROVIDER must be disabled or tencent-ses when enabled",
      );
    if (
      env.AUTH_EMAIL_PROVIDER !== "tencent-ses" &&
      env.AUTH_PHONE_PROVIDER !== "aliyun-dypns"
    )
      throw new Error(
        "OTP authentication requires at least one enabled provider",
      );
  }
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
    emailEnabled: env.AUTH_EMAIL_PROVIDER === "tencent-ses",
    phoneEnabled: env.AUTH_PHONE_PROVIDER === "aliyun-dypns",
    registrationMode:
      registrationModeFrom(env.AUTH_REGISTRATION_MODE) ?? "closed",
    allowProvisionedHandleLogin: handleLoginFrom(
      env.AUTH_LEGACY_HANDLE_LOGIN_ENABLED,
    ),
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
    emailMode:
      config.profile === "password-only" || config.emailEnabled === false
        ? "disabled"
        : "provider",
    phoneMode: config.phoneEnabled ? "provider" : "disabled",
    delivery,
    registrationAgreement,
    registrationMode: config.registrationMode ?? "closed",
    allowProvisionedHandleLogin: config.allowProvisionedHandleLogin ?? false,
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
  const registrationMode = registrationModeFrom(env.AUTH_REGISTRATION_MODE);
  return new CommunityAuthService(port, {
    environment: "development",
    profile,
    keys,
    emailMode: "local_capture",
    phoneMode: profile === "full-local" ? "simulated" : "disabled",
    ...(registrationMode === undefined ? {} : { registrationMode }),
    allowProvisionedHandleLogin: handleLoginFrom(
      env.AUTH_LEGACY_HANDLE_LOGIN_ENABLED,
    ),
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
