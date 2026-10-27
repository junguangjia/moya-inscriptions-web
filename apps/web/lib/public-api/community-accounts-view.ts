import { publicUserProfileSchema } from "@moya/contracts/schemas";

import type { PublicUserProfile } from "@moya/contracts";

/**
 * account-switching-v1: the browser-visible answers of the same-origin account
 * routes. They name accounts only; a session token never appears in them.
 */

/** At most three signed-in accounts per browser, the current one included. */
export const communityAccountLimit = 3;
/**
 * The saved list holds at most this many sessions: two other accounts and the
 * older copies whose sign-out is not confirmed yet. No answer names more other
 * accounts than that (more than two only in the rare cases where a session
 * could not be signed out and is kept rather than lost).
 */
export const savedSessionsCapacity = 6;

/**
 * Another account this browser holds. `reauth_required`: the Backend no longer
 * accepts its session (expired, signed out elsewhere, suspended or deleted).
 * Such an account stays held and is listed so on every read until it is
 * removed, signed in again, or let go (once its sign-out is confirmed) to make
 * room when another account is added while three are held; only its id and
 * handle are known.
 */
export type CommunityAccountListing =
  | (PublicUserProfile & { readonly state: "ready" })
  | {
      readonly id: string;
      readonly handle: string;
      readonly displayName: null;
      readonly state: "reauth_required";
    };

/** `GET /api/community/accounts`. */
export interface CommunityAccountsView {
  readonly current: PublicUserProfile | null;
  readonly others: readonly CommunityAccountListing[];
  readonly limit: typeof communityAccountLimit;
}

/** `POST /api/community/accounts/switch`: the account that is now current. */
export interface CommunityAccountSwitched {
  readonly current: PublicUserProfile;
}

/**
 * Why an account operation changed nothing (or, for `unavailable` after
 * signing out every account, not everything):
 * - `reauth_required` (409): the target's session is no longer accepted; it
 *   stays listed as 需重新登录 until it is signed in again or removed;
 * - `account_not_found` (404): this browser does not hold that account;
 * - `unavailable` (503): the Backend could not confirm the outcome.
 */
export type CommunityAccountRefusalReason =
  "reauth_required" | "account_not_found" | "unavailable";

export interface CommunityAccountRefusal {
  readonly reason: CommunityAccountRefusalReason;
}

/** An account this browser still holds, named without its session. */
export interface CommunityAccountHeld {
  readonly id: string;
  readonly handle: string;
}

/**
 * `POST /api/community/auth/accounts/sign-out-all` 503: some sign-outs could
 * not be confirmed. The answer itself says what this browser still holds, so
 * the page decides without reading the list again.
 */
export interface CommunitySignOutAllPartial {
  readonly reason: "unavailable";
  /**
   * True when this browser no longer has a current session: it was signed
   * out, was already refused, or there was none. False: the current session's
   * sign-out could not be confirmed and it stays current.
   */
  readonly currentCleared: boolean;
  /**
   * The accounts whose sign-out could not be confirmed; still held. While the
   * current session stays, a saved copy of its own account may be named too.
   */
  readonly remaining: readonly CommunityAccountHeld[];
}

const userIdPattern = /^user-[0-9a-f]{32}$/u;
const handlePattern = /^[a-z][a-z0-9-]{2,31}$/u;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const profileOf = (value: unknown): PublicUserProfile | null => {
  const parsed = publicUserProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const listingOf = (value: unknown): CommunityAccountListing | null => {
  const record = recordOf(value);
  if (record?.state === "ready") {
    const { state, ...rest } = record;
    void state;
    const profile = profileOf(rest);
    return profile === null ? null : { ...profile, state: "ready" };
  }
  if (
    record?.state === "reauth_required" &&
    Object.keys(record).length === 4 &&
    typeof record.id === "string" &&
    userIdPattern.test(record.id) &&
    typeof record.handle === "string" &&
    handlePattern.test(record.handle) &&
    record.displayName === null
  )
    return {
      id: record.id,
      handle: record.handle,
      displayName: null,
      state: "reauth_required",
    };
  return null;
};

export const parseCommunityAccountsView = (
  body: unknown,
): CommunityAccountsView | null => {
  const record = recordOf(body);
  if (
    record === null ||
    Object.keys(record).length !== 3 ||
    record.limit !== communityAccountLimit ||
    !Array.isArray(record.others) ||
    record.others.length > savedSessionsCapacity
  )
    return null;
  const current = record.current === null ? null : profileOf(record.current);
  if (record.current !== null && current === null) return null;
  const others: CommunityAccountListing[] = [];
  for (const item of record.others) {
    const listing = listingOf(item);
    if (listing === null) return null;
    others.push(listing);
  }
  return { current, others, limit: communityAccountLimit };
};

const heldOf = (value: unknown): CommunityAccountHeld | null => {
  const record = recordOf(value);
  return record !== null &&
    Object.keys(record).length === 2 &&
    typeof record.id === "string" &&
    userIdPattern.test(record.id) &&
    typeof record.handle === "string" &&
    handlePattern.test(record.handle)
    ? { id: record.id, handle: record.handle }
    : null;
};

/**
 * A partial sign-out-all answer, or null. An answer that would mean nothing
 * is left to sign out is no partial result (that answer is a 204).
 */
export const parseCommunitySignOutAllPartial = (
  body: unknown,
): CommunitySignOutAllPartial | null => {
  const record = recordOf(body);
  if (
    record === null ||
    Object.keys(record).length !== 3 ||
    record.reason !== "unavailable" ||
    typeof record.currentCleared !== "boolean" ||
    !Array.isArray(record.remaining) ||
    record.remaining.length > savedSessionsCapacity
  )
    return null;
  const remaining: CommunityAccountHeld[] = [];
  for (const item of record.remaining) {
    const held = heldOf(item);
    if (held === null || remaining.some((other) => other.id === held.id))
      return null;
    remaining.push(held);
  }
  if (record.currentCleared && remaining.length === 0) return null;
  return {
    reason: "unavailable",
    currentCleared: record.currentCleared,
    remaining,
  };
};

export const parseCommunityAccountRefusal = (
  body: unknown,
): CommunityAccountRefusal | null => {
  const reason = recordOf(body)?.reason;
  return reason === "reauth_required" ||
    reason === "account_not_found" ||
    reason === "unavailable"
    ? { reason }
    : null;
};
