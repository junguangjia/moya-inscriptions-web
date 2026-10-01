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
  publicUserProfileSchema,
  studioNameSchema,
  studioNameInputSchema,
} from "@moya/contracts/schemas";

export interface AuthCapabilitiesView {
  readonly profile: "full-local" | "email-first" | "disabled";
  readonly email: {
    readonly available: boolean;
    readonly reason: string | null;
  };
  readonly phone: {
    readonly available: boolean;
    readonly reason: string | null;
  };
  readonly developmentOnly: boolean;
}

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
  init?: { readonly method?: "GET" | "POST"; readonly body?: unknown },
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`/api/community/auth/${path}`, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    credentials: "same-origin",
    cache: "no-store",
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
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
