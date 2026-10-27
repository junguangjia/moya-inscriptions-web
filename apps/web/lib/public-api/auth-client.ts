import type { AuthCapabilities } from "@moya/contracts";
export type {
  AuthPasswordLoginRequest,
  AuthPasswordResetRequest,
  AuthPasswordResetResult,
  AuthRegistrationRequest,
  AuthChallengeRequest,
} from "@moya/contracts";
export type { AuthChallengeAccepted as AuthChallengeView } from "@moya/contracts";
import {
  authPasswordSchema,
  authCapabilitiesSchema,
  publicUserProfileSchema,
  studioNameSchema,
  studioNameInputSchema,
} from "@moya/contracts/schemas";

import { exclusiveAccountRequest } from "./community-accounts-client";

export type AuthCapabilitiesView = AuthCapabilities;

/**
 * Ordinary steps whose answers rewrite the session cookies: a sign-in (which
 * may also let go of a saved copy), a password reset and a sign-out.
 */
const sessionCookieSteps: ReadonlySet<string> = new Set([
  "passwords/login",
  "challenges/verify",
  "registrations",
  "passwords/reset",
  "sign-out",
]);

export const parseAuthCapabilities = (
  body: unknown,
): AuthCapabilitiesView | null => {
  const parsed = authCapabilitiesSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

export interface AuthFactorView {
  readonly channel: "email" | "phone";
  readonly state: "unbound" | "verified" | "unavailable" | "pending";
  readonly masked: string | null;
  readonly version: number;
  readonly usable: boolean;
}

export interface AuthAccountView {
  readonly userId: string;
  readonly email: AuthFactorView;
  readonly phone: AuthFactorView;
  readonly capabilities: AuthCapabilitiesView;
}

const read = async (response: Response): Promise<unknown> => {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  return response.json();
};

export const authRequest = async (
  path: string,
  init?: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    /**
     * account-switching-v1: the sign-in flow runs for another account; the
     * relay then keeps the current account signed in beside the new one.
     */
    readonly addAccount?: boolean;
    /** The account the page shows; a sign-out for another one is refused. */
    readonly account?: string;
  },
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
  const send = () =>
    fetch(`/api/community/auth/${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init?.addAccount === true
          ? { "x-yoyi-account-intent": "add" }
          : {}),
        ...(init?.account === undefined
          ? {}
          : { "x-author-account": init.account }),
      },
      credentials: "same-origin",
      cache: "no-store",
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  // account-switching-v1: these rewrite the session cookies like the account
  // routes, so they run under the same cross-tab lock.
  const response =
    method === "POST" &&
    (init?.addAccount === true || sessionCookieSteps.has(path))
      ? await exclusiveAccountRequest(send)
      : await send();
  return { status: response.status, body: await read(response) };
};

export const safeReturnPath = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "/";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  )
    return "/";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32) return "/";
  }
  if (value.includes("\\") || value.includes("://")) return "/";
  try {
    const url = new URL(value, "http://return.invalid");
    if (url.origin !== "http://return.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
};

/** A completed auth result must contain the existing public identity metadata. */
export const hasCompletedAuthSession = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return false;
  const session = (body as Record<string, unknown>).session;
  if (typeof session !== "object" || session === null || Array.isArray(session))
    return false;
  const value = session as Record<string, unknown>;
  return (
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    publicUserProfileSchema.safeParse(value.profile).success
  );
};

/** Client-safe validation delegates to the shared public contracts boundary. */
export const validAuthPassword = (value: string): boolean =>
  authPasswordSchema.safeParse(value).success;

export const normalizedStudioName = (value: string): string | null => {
  const parsed = studioNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** New editors share the same paired-name validation as the Backend. */
export const studioNameInput = (name: string, suffix: string) => {
  const base = name.trim();
  const ending = suffix.trim();
  return studioNameInputSchema.safeParse({
    studioName: base ? base + ending : "",
    studioNameSuffix: base ? ending : "",
  });
};
