import { parseSessionToken } from "./community-session";

/**
 * The one browser cookie Web owns for Community V1: an opaque session
 * reference, HttpOnly, never readable by browser JavaScript. Its name is
 * distinct from Payload's `payload-token`, which is never forwarded to the
 * Backend.
 */
export const communitySessionCookieName = "yoyi-session";

const cookiePairPattern = /^([^=]+)=(.*)$/;

/** Reads the session credential from a raw Cookie header; malformed values are ignored. */
export const readCommunitySessionToken = (
  cookieHeader: string | null | undefined,
): string | undefined => {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const match = cookiePairPattern.exec(pair.trim());
    if (match?.[1]?.trim() !== communitySessionCookieName) continue;
    const token = parseSessionToken(match[2]?.trim());
    return token === null ? undefined : token;
  }
  return undefined;
};

/** Secure is required except on the plain-HTTP loopback/LAN hosts used for Development device QA. */
export const isSecureRequest = (request: Request): boolean =>
  new URL(request.url).protocol === "https:" ||
  request.headers.get("x-forwarded-proto") === "https";

/** Host-only (no Domain) and HttpOnly; shared by every Web session cookie. */
export const sessionCookieAttributes = (secure: boolean): string =>
  `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
const baseAttributes = sessionCookieAttributes;

export const serializeCommunitySessionCookie = (
  token: string,
  expiresAt: Date,
  secure: boolean,
): string => {
  if (parseSessionToken(token) === null)
    throw new Error("Refusing to store a malformed session credential");
  return `${communitySessionCookieName}=${token}; Expires=${expiresAt.toUTCString()}; ${baseAttributes(secure)}`;
};

export const serializeClearedCommunitySessionCookie = (
  secure: boolean,
): string =>
  `${communitySessionCookieName}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; ${baseAttributes(secure)}`;
