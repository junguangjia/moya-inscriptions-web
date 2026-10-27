import { savedSessionsCapacity } from "./community-accounts-view";
import { sessionCookieAttributes } from "./community-session-cookie";

/**
 * account-switching-v1: the other signed-in accounts this browser holds, next
 * to the active one in `yoyi-session`. It carries the same attributes (HttpOnly,
 * host-only, `Path=/`, `SameSite=Lax`, Secure on HTTPS), so no token is ever
 * readable by browser JavaScript.
 *
 * Value: entries joined by `~`, each
 * `<user id>.<handle>.<session token>.<ceiling in epoch milliseconds>`. A token
 * appears once. A user id may repeat: an older session of an account that this
 * browser let go of stays held, as a hidden copy, until the Backend confirms
 * its sign-out, so the only copy of a session that may still be live is never
 * dropped. The handle only names an account none of whose sessions the Backend
 * accepts any more.
 */
export const savedSessionsCookieName = "yoyi-saved-sessions";
/**
 * At most `savedSessionsCapacity` entries: two other accounts (three with the
 * current one) and the copies whose sign-out could not be confirmed yet. An
 * add-account step that would need more is refused before the Backend is
 * asked.
 */
export { savedSessionsCapacity };
/**
 * How long the cookie outlives its latest entry's ceiling, so an entry whose
 * session has ended is still listed as 需重新登录 instead of disappearing.
 */
export const savedSessionsRetentionMs = 7 * 24 * 60 * 60 * 1000;

export interface SavedSession {
  readonly userId: string;
  readonly handle: string;
  readonly token: string;
  /**
   * Epoch milliseconds: the session's lifetime ceiling counted from when it
   * was saved. It only sets how long the browser keeps the cookie; the
   * Backend alone decides whether the session is still accepted.
   */
  readonly expiresAt: number;
}

export interface SavedSessionsRead {
  readonly entries: readonly SavedSession[];
  /** The stored cookie is malformed or repeated and must be cleared. */
  readonly stale: boolean;
}

const entryPattern =
  /^(user-[0-9a-f]{32})\.([a-z][a-z0-9-]{2,31})\.([A-Za-z0-9_-]{43})\.(\d{13})$/u;
const cookiePairPattern = /^([^=]+)=(.*)$/u;

const parseEntries = (value: string): SavedSession[] | null => {
  const parts = value.split("~");
  if (parts.length > savedSessionsCapacity) return null;
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
  const tokens = new Set(entries.map((entry) => entry.token));
  return tokens.size === entries.length ? entries : null;
};

/**
 * Reads the saved list from a raw Cookie header. Anything malformed, including
 * a repeated cookie or a repeated token, fails closed: no entry is trusted and
 * the cookie is to be cleared. An entry past its ceiling is still returned:
 * only the Backend can say whether its session has ended.
 */
export const readSavedSessions = (
  cookieHeader: string | null | undefined,
): SavedSessionsRead => {
  if (!cookieHeader) return { entries: [], stale: false };
  const values: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const match = cookiePairPattern.exec(pair.trim());
    if (match?.[1]?.trim() === savedSessionsCookieName)
      values.push(match[2]?.trim() ?? "");
  }
  if (values.length === 0) return { entries: [], stale: false };
  const entries = values.length === 1 ? parseEntries(values[0]!) : null;
  return entries === null
    ? { entries: [], stale: true }
    : { entries, stale: false };
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
