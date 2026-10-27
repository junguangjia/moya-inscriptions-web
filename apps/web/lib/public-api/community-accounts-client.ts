import {
  parseCommunityAccountRefusal,
  parseCommunityAccountsView,
  parseCommunitySignOutAllPartial,
} from "./community-accounts-view";

import type {
  CommunityAccountHeld,
  CommunityAccountRefusalReason,
  CommunityAccountsView,
} from "./community-accounts-view";

export { communityAccountLimit } from "./community-accounts-view";
export type {
  CommunityAccountHeld,
  CommunityAccountListing,
  CommunityAccountsView,
} from "./community-accounts-view";

/**
 * account-switching-v1: browser transport for the accounts this browser holds.
 * Sessions stay in HttpOnly cookies the same-origin routes swap; these answers
 * name accounts only. Listing and switching read through
 * `/api/community/accounts`; ending a session goes through the auth relay.
 */

export type CommunityAccountsRead =
  | { readonly state: "ready"; readonly view: CommunityAccountsView }
  | { readonly state: "unavailable" };

/** Why an account operation changed nothing; `failed`: no usable answer. */
export type CommunityAccountFailure =
  | {
      readonly state: "refused";
      readonly reason: CommunityAccountRefusalReason;
    }
  | { readonly state: "failed" };

/** A sign-out of every account that ended only some sessions. */
export interface CommunitySignOutAllPartialResult {
  readonly state: "partial";
  /** This browser no longer has a current session. */
  readonly currentCleared: boolean;
  /** Other accounts still held: their sign-out could not be confirmed. */
  readonly remaining: readonly CommunityAccountHeld[];
}

/**
 * Every answer that rewrites the session cookies reads both of them as one
 * snapshot, so two overlapping ones (another tab, or this one) could leave a
 * pair from different snapshots and lose a held account. They therefore run
 * one at a time across this browser's tabs, each holding an exclusive Web Lock
 * until its response (and so its Set-Cookie) has arrived. Without Web Locks
 * the request runs directly.
 */
const accountCookieLock = "yoyi-community-accounts";

export const exclusiveAccountRequest = <T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Partial<Navigator>).locks;
  return locks === undefined
    ? run()
    : locks.request(
        accountCookieLock,
        { mode: "exclusive", ...(signal === undefined ? {} : { signal }) },
        run,
      );
};

const readJson = async (response: Response): Promise<unknown> => {
  if (!(response.headers.get("content-type") ?? "").includes("json"))
    return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const post = (path: string, body: unknown) =>
  exclusiveAccountRequest(() =>
    fetch(path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const refusalOf = async (
  response: Response,
): Promise<CommunityAccountFailure> => {
  const refusal = parseCommunityAccountRefusal(await readJson(response));
  return refusal === null
    ? { state: "failed" }
    : { state: "refused", reason: refusal.reason };
};

export const communityAccountsClient = {
  /** The current account and the others this browser holds. */
  list: async (signal?: AbortSignal): Promise<CommunityAccountsRead> => {
    try {
      // The read changes nothing; it takes the same lock as the writes so it
      // reads what a write in flight in another tab leaves.
      const response = await exclusiveAccountRequest(
        () =>
          fetch("/api/community/accounts", {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            headers: { accept: "application/json" },
            ...(signal === undefined ? {} : { signal }),
          }),
        signal,
      );
      const view =
        response.status === 200
          ? parseCommunityAccountsView(await readJson(response))
          : null;
      return view === null
        ? { state: "unavailable" }
        : { state: "ready", view };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return { state: "unavailable" };
    }
  },
  /**
   * Makes a held account current. A 200 has already swapped the session
   * cookies, whatever its body says, so the caller reloads the page either way.
   */
  switchTo: async (
    accountId: string,
  ): Promise<{ readonly state: "switched" } | CommunityAccountFailure> => {
    try {
      const response = await post("/api/community/accounts/switch", {
        accountId,
      });
      if (response.status === 200) {
        await response.body?.cancel().catch(() => undefined);
        return { state: "switched" };
      }
      return await refusalOf(response);
    } catch {
      return { state: "failed" };
    }
  },
  /** Signs one held account out on this browser and lets it go. */
  remove: async (
    accountId: string,
  ): Promise<{ readonly state: "removed" } | CommunityAccountFailure> => {
    try {
      const response = await post("/api/community/auth/accounts/remove", {
        accountId,
      });
      if (response.status === 204) return { state: "removed" };
      return await refusalOf(response);
    } catch {
      return { state: "failed" };
    }
  },
  /**
   * Signs every account on this browser out. `partial`: some sign-outs could
   * not be confirmed; the answer says whether the current session was cleared
   * and which other accounts are still held. Any other failure leaves the
   * outcome unknown.
   */
  signOutAll: async (): Promise<
    | { readonly state: "signed-out" }
    | CommunitySignOutAllPartialResult
    | CommunityAccountFailure
  > => {
    try {
      const response = await post(
        "/api/community/auth/accounts/sign-out-all",
        {},
      );
      if (response.status === 204) return { state: "signed-out" };
      const body = await readJson(response);
      const partial =
        response.status === 503 ? parseCommunitySignOutAllPartial(body) : null;
      if (partial !== null)
        return {
          state: "partial",
          currentCleared: partial.currentCleared,
          remaining: partial.remaining,
        };
      const refusal = parseCommunityAccountRefusal(body);
      return refusal === null
        ? { state: "failed" }
        : { state: "refused", reason: refusal.reason };
    } catch {
      return { state: "failed" };
    }
  },
};
