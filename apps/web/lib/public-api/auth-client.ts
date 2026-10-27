import type {
  AuthAccountDeletionRequest,
  AuthAccountDeletionResult,
  AuthAccountSecurity,
  AuthCapabilities,
} from "@moya/contracts";
export type {
  AuthAccountDeletionResult,
  AuthAccountSecurity,
  AuthPasswordLoginRequest,
  AuthPasswordResetRequest,
  AuthPasswordResetResult,
  AuthRegistrationRequest,
  AuthChallengeRequest,
} from "@moya/contracts";
export type { AuthChallengeAccepted as AuthChallengeView } from "@moya/contracts";
import {
  authAccountDeletionResultSchema,
  authAccountSecuritySchema,
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
 * may also let go of a saved copy), a password reset, a factor change (whose
 * answer reissues the session and lets go of that account's saved copies) and
 * a sign-out.
 */
const sessionCookieSteps: ReadonlySet<string> = new Set([
  "passwords/login",
  "challenges/verify",
  "registrations",
  "passwords/reset",
  "factors/complete",
  "factors/unlink",
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

/** The signed-in account's own security view, or null outside the contract. */
export const parseAuthAccount = (body: unknown): AuthAccountSecurity | null => {
  const parsed = authAccountSecuritySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

/** A completed account deletion, or null for any other answer. */
export const parseAccountDeletionResult = (
  body: unknown,
): AuthAccountDeletionResult | null => {
  const parsed = authAccountDeletionResultSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

/**
 * account-deletion-v1: ends the signed-in account. `x-author-account` binds the
 * request to the account this page confirmed, so a Session another tab has
 * since changed is refused instead of deleting a different account. On the
 * Backend's success the relay clears this browser's Session cookies and lets
 * go of the saved copies of the account (account-switching-v1); like every
 * relay, it also clears the session cookie on a 401 once `/v1/me` refuses that
 * session. It therefore runs under the same cross-tab lock as the other cookie
 * writes.
 */
export const requestAccountDeletion = async (
  accountId: string,
  request: AuthAccountDeletionRequest,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await exclusiveAccountRequest(() =>
    fetch("/api/community/auth/account/deletion", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-author-account": accountId,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(request),
    }),
  );
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
