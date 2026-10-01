import { createMailpitCapture } from "./delivery.js";
import { CommunityAuthService } from "./community-auth-service.js";
import type { CommunityAuthPort } from "./auth-port.js";
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

/**
 * Production must not select local capture, simulation, or public registration.
 * Missing real provider configuration fails closed by leaving authentication
 * unmounted; selecting any provider in this task is also refused.
 */
export const assertProductionAuthConfiguration = (
  env: Readonly<Record<string, string | undefined>>,
): void => {
  if (env.NODE_ENV !== "production") return;
  const selected = [
    env.AUTH_PROFILE,
    env.AUTH_PUBLIC_ENABLED,
    env.AUTH_EMAIL_PROVIDER,
    env.AUTH_PHONE_PROVIDER,
    env.AUTH_EMAIL_CAPTURE_URL,
    env.AUTH_PHONE_CAPTURE_URL,
  ].some((value) => value !== undefined && value !== "");
  if (selected)
    throw new Error(
      "Production rejects local authentication providers and public authentication exposure",
    );
};

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
