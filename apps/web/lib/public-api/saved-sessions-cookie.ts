import { sessionCookieAttributes } from "./community-session-cookie";

/**
 * account-switching-v1: the other signed-in accounts this browser holds, next
 * to the active one in `yoyi-session`. It carries the same attributes (HttpOnly,
 * host-only, `Path=/`, `SameSite=Lax`, Secure on HTTPS), so no token is ever
 * readable by browser JavaScript. With the active account a browser holds at
 * most three, so this list holds two.
 *
 * Value: one or two entries joined by `~`, each
 * `<user id>.<handle>.<session token>.<expiry in epoch milliseconds>`. The
 * handle only names an entry whose session the Backend no longer accepts.
 */
export const savedSessionsCookieName = "yoyi-saved-sessions";
export const maximumSavedSessions = 2;
/**
 * How long the cookie outlives its latest entry. An entry past its ceiling has
 * certainly lapsed on the Backend, and the browser keeps it this much longer
 * so the account list can still report it as 需重新登录 instead of losing it.
 */
export const savedSessionsRetentionMs = 7 * 24 * 60 * 60 * 1000;

export interface SavedSession {
  readonly userId: string;
  readonly handle: string;
  readonly token: string;
  /** Epoch milliseconds. The Backend still enforces each session's own absolute lifetime. */
  readonly expiresAt: number;
}

export interface SavedSessionsRead {
  /** Entries still inside their ceiling. */
  readonly entries: readonly SavedSession[];
  /**
   * Entries past their ceiling: that session has ended. They stay stored
   * until the account list reports them once as `reauth_required`.
   */
  readonly lapsed: readonly SavedSession[];
  /** The stored cookie is malformed or repeated and must be cleared. */
  readonly stale: boolean;
}

const entryPattern =
  /^(user-[0-9a-f]{32})\.([a-z][a-z0-9-]{2,31})\.([A-Za-z0-9_-]{43})\.(\d{13})$/u;
const cookiePairPattern = /^([^=]+)=(.*)$/u;

const parseEntries = (value: string): SavedSession[] | null => {
  const parts = value.split("~");
  if (parts.length > maximumSavedSessions) return null;
  const entries: SavedSession[] = [];
  for (const part of parts) {
    const match = entryPattern.exec(part);
    if (match === null) return null;
    const expiresAt = Number(match[4]);
    if (!Number.isSafeInteger(expiresAt)) return null;
    entries.push({
      userId: match[1]!,
      handle: match[2]!,
      token: match[3]!,
      expiresAt,
    });
  }
  const users = new Set(entries.map((entry) => entry.userId));
  const tokens = new Set(entries.map((entry) => entry.token));
  return users.size === entries.length && tokens.size === entries.length
    ? entries
    : null;
};

/**
 * Reads the saved list from a raw Cookie header. Anything malformed, including
 * a repeated cookie, fails closed: no entry is trusted and the cookie is to be
 * cleared. Entries past their ceiling are returned apart as `lapsed`.
 */
export const readSavedSessions = (
  cookieHeader: string | null | undefined,
  now: number,
): SavedSessionsRead => {
  const none = { entries: [], lapsed: [] };
  if (!cookieHeader) return { ...none, stale: false };
  const values: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const match = cookiePairPattern.exec(pair.trim());
    if (match?.[1]?.trim() === savedSessionsCookieName)
      values.push(match[2]?.trim() ?? "");
  }
  if (values.length === 0) return { ...none, stale: false };
  const entries = values.length === 1 ? parseEntries(values[0]!) : null;
  if (entries === null) return { ...none, stale: true };
  return {
    entries: entries.filter((entry) => entry.expiresAt > now),
    lapsed: entries.filter((entry) => entry.expiresAt <= now),
    stale: false,
  };
};

export const serializeClearedSavedSessionsCookie = (secure: boolean): string =>
  `${savedSessionsCookieName}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; ${sessionCookieAttributes(secure)}`;

/**
 * An empty list clears the cookie; a malformed entry is refused, never stored.
 * The cookie expires `savedSessionsRetentionMs` after its latest entry.
 */
export const serializeSavedSessionsCookie = (
  entries: readonly SavedSession[],
  secure: boolean,
): string => {
  if (entries.length === 0) return serializeClearedSavedSessionsCookie(secure);
  const value = entries
    .map(
      (entry) =>
        `${entry.userId}.${entry.handle}.${entry.token}.${entry.expiresAt}`,
    )
    .join("~");
  if (parseEntries(value) === null)
    throw new Error("Refusing to store a malformed saved session list");
  const expiresAt =
    Math.max(...entries.map((entry) => entry.expiresAt)) +
    savedSessionsRetentionMs;
  return `${savedSessionsCookieName}=${value}; Expires=${new Date(expiresAt).toUTCString()}; ${sessionCookieAttributes(secure)}`;
};
