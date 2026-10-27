import "server-only";

import { communityAccountLimit } from "./community-accounts-view";
import { fetchCurrentUser } from "./community-session";
import {
  isSecureRequest,
  readCommunitySessionToken,
  serializeClearedCommunitySessionCookie,
  serializeCommunitySessionCookie,
} from "./community-session-cookie";
import {
  readSavedSessions,
  savedSessionsCapacity,
  serializeSavedSessionsCookie,
} from "./saved-sessions-cookie";

import type {
  CommunityAccountListing,
  CommunityAccountRefusalReason,
  CommunityAccountsView,
  CommunityAccountSwitched,
  CommunitySignOutAllPartial,
} from "./community-accounts-view";
import type { SavedSession } from "./saved-sessions-cookie";
import type { PublicUserProfile } from "@moya/contracts";

/**
 * account-switching-v1: up to three signed-in accounts per browser. The active
 * one stays in `yoyi-session`, which every reader keeps using unchanged; the
 * others wait in the HttpOnly `yoyi-saved-sessions`. Every account is still
 * validated by the Backend on each request with its own session, and no token
 * ever reaches a response body.
 *
 * A saved session (or one leaving `yoyi-session` for the saved list) is let go
 * of only once the Backend confirms that it ended: signed out now, or no longer
 * accepted. A sign-in grant that replaces `yoyi-session` (an ordinary sign-in,
 * or re-adding the current account) replaces that cookie as before #352. An
 * older session of an account whose sign-out cannot be confirmed stays saved
 * as a hidden copy, never listed or switched to while the account is current,
 * and a later sign-out through the authentication relay ends it.
 */
export interface CommunityAccountsContext {
  readonly baseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
  /**
   * The trusted source headers a Backend sign-out needs (the Production auth
   * ingress proof); only the authentication relay has them.
   */
  readonly authSource?: Readonly<Record<string, string>>;
  readonly now: number;
}

/**
 * The Backend's default absolute session lifetime. Web never learns a
 * session's own expiry (a browser does not send cookie attributes back), so a
 * session moved into the saved list gets this ceiling as the browser's
 * lifetime for it. Switching never extends the session itself: the Backend
 * refuses it at its real expiry, and the account then reads as
 * `reauth_required`.
 */
const sessionLifetimeCeilingMs = 7 * 24 * 60 * 60 * 1000;

/** The cookies one answer sets: the active session and the saved list. */
export interface SessionCookieUpdates {
  readonly active?: string;
  readonly saved?: string;
}

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
} as const;

export const appendSessionCookies = (
  headers: Headers,
  cookies: SessionCookieUpdates,
): Headers => {
  if (cookies.active !== undefined)
    headers.append("set-cookie", cookies.active);
  if (cookies.saved !== undefined) headers.append("set-cookie", cookies.saved);
  return headers;
};

const answer = (
  status: number,
  body:
    | CommunityAccountsView
    | CommunityAccountSwitched
    | CommunitySignOutAllPartial
    | undefined,
  cookies: SessionCookieUpdates = {},
): Response => {
  const headers = appendSessionCookies(new Headers(privateHeaders), cookies);
  return body === undefined
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
};

const refuse = (
  status: 404 | 409 | 503,
  reason: CommunityAccountRefusalReason,
  cookies: SessionCookieUpdates = {},
): Response =>
  Response.json(
    { reason },
    {
      status,
      headers: appendSessionCookies(new Headers(privateHeaders), cookies),
    },
  );

type SessionCheck =
  | { readonly state: "ready"; readonly profile: PublicUserProfile }
  | { readonly state: "refused" | "unavailable" };

/** `me` with one session: refused only when the Backend refuses that session itself. */
const checkSession = async (
  context: CommunityAccountsContext,
  token: string,
): Promise<SessionCheck> => {
  const result = await fetchCurrentUser(context, token);
  if (result.state === "success")
    return { state: "ready", profile: result.profile };
  return {
    state: result.state === "unauthenticated" ? "refused" : "unavailable",
  };
};

/** The profile a check confirms for `userId`, or null. */
const acceptedAs = (
  check: SessionCheck | undefined,
  userId: string,
): PublicUserProfile | null =>
  check?.state === "ready" && check.profile.id === userId
    ? check.profile
    : null;

/** The account a session belongs to, when `me` accepts it. */
export const accountOfSession = async (
  context: CommunityAccountsContext,
  token: string,
): Promise<string | null> => {
  const check = await checkSession(context, token);
  return check.state === "ready" ? check.profile.id : null;
};

export type SessionRevocation = "revoked" | "refused" | "failed";

/**
 * Backend sign-out of one held session. `refused`: it was no longer accepted
 * (already signed out, expired, unknown), which `me` confirms; `failed`: the
 * outcome is unknown and the session must stay held.
 */
export const revokeCommunitySession = async (
  context: CommunityAccountsContext,
  token: string,
  account?: string,
): Promise<SessionRevocation> => {
  try {
    const response = await context.fetch(
      new URL("v1/community/auth/sign-out", context.baseUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...context.authSource,
          // The Backend refuses a token that does not belong to this account.
          ...(account === undefined ? {} : { "x-author-account": account }),
        },
        body: "{}",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "revoked";
    if (
      response.status === 401 &&
      (await checkSession(context, token)).state === "refused"
    )
      return "refused";
    return "failed";
  } catch {
    return "failed";
  }
};

const heldSessions = (request: Request) => {
  const cookie = request.headers.get("cookie");
  const saved = readSavedSessions(cookie);
  return {
    activeToken: readCommunitySessionToken(cookie),
    saved: saved.entries,
    stale: saved.stale,
    secure: isSecureRequest(request),
  };
};

/** Whether this browser holds any saved session at all. */
export const holdsSavedSessions = (request: Request): boolean =>
  heldSessions(request).saved.length > 0;

/** The accounts the saved list names, in order, without `except`. */
const accountsOf = (
  entries: readonly SavedSession[],
  except?: string,
): string[] =>
  [...new Set(entries.map((entry) => entry.userId))].filter(
    (id) => id !== except,
  );

/** The first entry of each token: a later one repeats a session held already. */
const distinctTokens = (entries: readonly SavedSession[]): SavedSession[] =>
  entries.filter(
    (entry, index) =>
      entries.findIndex((other) => other.token === entry.token) === index,
  );

/**
 * Signs out saved sessions this browser lets go of and answers the ones it
 * must keep. An entry leaves once its sign-out is confirmed (`revoked`, or
 * `refused`: no longer accepted) or when it repeats the active session's
 * token, as a duplicate of `yoyi-session` that follows that cookie and is
 * never signed out here. Any other entry stays as a hidden copy. The account
 * routes carry no trusted authentication source, so in Production their
 * sign-out of a copy the Backend still accepts fails and the copy stays until
 * the authentication relay ends it.
 */
const releaseCopies = async (
  context: CommunityAccountsContext,
  copies: readonly SavedSession[],
  activeToken: string | undefined,
): Promise<SavedSession[]> => {
  const outcomes = await Promise.all(
    copies.map((entry) =>
      entry.token === activeToken
        ? null
        : revokeCommunitySession(context, entry.token, entry.userId),
    ),
  );
  return copies.filter((_, index) => outcomes[index] === "failed");
};

const savedEntryFor = (
  profile: PublicUserProfile,
  token: string,
  now: number,
): SavedSession => ({
  userId: profile.id,
  handle: profile.handle,
  token,
  expiresAt: now + sessionLifetimeCeilingMs,
});

/**
 * The active cookie's expiry for a saved session: its ceiling, or a new one
 * when the Backend still accepts it past that ceiling (a longer configured
 * lifetime). The Backend keeps enforcing the session's real expiry.
 */
const activeExpiryOf = (entry: SavedSession, now: number): Date =>
  new Date(
    entry.expiresAt > now ? entry.expiresAt : now + sessionLifetimeCeilingMs,
  );

/** The body of switch and remove: exactly `{ "accountId": "<user id>" }`. */
export const parseAccountTarget = (text: string): string | null => {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      "accountId" in value &&
      typeof value.accountId === "string" &&
      /^user-[0-9a-f]{32}$/u.test(value.accountId)
    )
      return value.accountId;
  } catch {
    /* Not JSON. */
  }
  return null;
};

/**
 * `GET /api/community/accounts`, read-only: it never sets a cookie. Every held
 * session is checked with `me`, whatever its ceiling. A refused active
 * session reads as `current: null` (the relays that use it clear it). Each
 * other account is listed once: `ready` when one of its sessions is accepted
 * as that account, otherwise `reauth_required`, on every read until it is
 * removed, signed in again, or let go (once its sign-out is confirmed) to make
 * room when another account is added while three are held. Saved sessions of
 * the current account are hidden copies. A check the Backend cannot answer for
 * a listed account leaves the answer unknown (503).
 */
export const listCommunityAccounts = async (
  context: CommunityAccountsContext,
  request: Request,
): Promise<Response> => {
  const { activeToken, saved } = heldSessions(request);
  const [active, checks] = await Promise.all([
    activeToken === undefined ? null : checkSession(context, activeToken),
    Promise.all(saved.map((entry) => checkSession(context, entry.token))),
  ]);
  if (active?.state === "unavailable") return refuse(503, "unavailable");
  const current = active?.state === "ready" ? active.profile : null;
  const others: CommunityAccountListing[] = [];
  for (const userId of accountsOf(saved, current?.id)) {
    const own = saved.flatMap((entry, index) =>
      entry.userId === userId ? [{ entry, check: checks[index] }] : [],
    );
    const profile = own
      .map(({ check }) => acceptedAs(check, userId))
      .find((found) => found !== null);
    if (profile) {
      others.push({ ...profile, state: "ready" });
      continue;
    }
    if (own.some(({ check }) => check?.state === "unavailable"))
      return refuse(503, "unavailable");
    others.push({
      id: userId,
      handle: own[0]!.entry.handle,
      displayName: null,
      state: "reauth_required",
    });
  }
  return answer(200, { current, others, limit: communityAccountLimit });
};

/**
 * `POST /api/community/accounts/switch`. The target must be another account
 * this browser holds, with a session `me` confirms is that account; the active
 * and saved sessions are then swapped in one answer's cookies. A target none
 * of whose sessions is accepted answers 409 and stays held, still listed as
 * 需重新登录; an unanswered check changes nothing (503).
 */
export const switchCommunityAccount = async (
  context: CommunityAccountsContext,
  request: Request,
  accountId: string,
): Promise<Response> => {
  const { activeToken, saved, stale, secure } = heldSessions(request);
  const targets = saved.filter((entry) => entry.userId === accountId);
  const [active, checks] = await Promise.all([
    activeToken === undefined ? null : checkSession(context, activeToken),
    Promise.all(targets.map((entry) => checkSession(context, entry.token))),
  ]);
  if (active?.state === "unavailable") return refuse(503, "unavailable");
  const unchanged: SessionCookieUpdates = {
    ...(active?.state === "refused"
      ? { active: serializeClearedCommunitySessionCookie(secure) }
      : {}),
    ...(stale ? { saved: serializeSavedSessionsCookie([], secure) } : {}),
  };
  const previous = active?.state === "ready" ? active.profile : null;
  if (previous?.id === accountId) {
    // A repeated tap after a completed switch: already current. Its saved
    // copies are let go once their sign-out is confirmed.
    const kept = await releaseCopies(context, targets, activeToken);
    return answer(
      200,
      { current: previous },
      kept.length === targets.length
        ? unchanged
        : {
            saved: serializeSavedSessionsCookie(
              [...saved.filter((entry) => entry.userId !== accountId), ...kept],
              secure,
            ),
          },
    );
  }
  if (targets.length === 0) return refuse(404, "account_not_found", unchanged);
  const chosenAt = targets.findIndex(
    (_, index) => acceptedAs(checks[index], accountId) !== null,
  );
  if (chosenAt < 0)
    return checks.some((check) => check.state === "unavailable")
      ? refuse(503, "unavailable")
      : refuse(409, "reauth_required", unchanged);
  const chosen = targets[chosenAt]!;
  const profile = acceptedAs(checks[chosenAt], accountId)!;
  // Older sessions of the account that becomes current, and of the one that
  // leaves `yoyi-session` (replaced by its active session), are let go once
  // their sign-out is confirmed.
  const replaced = (entry: SavedSession) =>
    entry.userId === accountId || entry.userId === previous?.id;
  const kept = await releaseCopies(
    context,
    saved.filter((entry) => entry !== chosen && replaced(entry)),
    activeToken,
  );
  return answer(
    200,
    { current: profile },
    {
      active: serializeCommunitySessionCookie(
        chosen.token,
        activeExpiryOf(chosen, context.now),
        secure,
      ),
      saved: serializeSavedSessionsCookie(
        distinctTokens([
          ...(previous === null
            ? []
            : [savedEntryFor(previous, activeToken!, context.now)]),
          ...saved.filter((entry) => !replaced(entry)),
          ...kept,
        ]),
        secure,
      ),
    },
  );
};

/**
 * `POST /api/community/auth/accounts/remove`: signs out every session this
 * browser holds for another account, a 需重新登录 one included, and lets each
 * go once its sign-out is confirmed or it is no longer accepted. A session
 * whose outcome is unknown stays held (503).
 */
export const removeCommunityAccount = async (
  context: CommunityAccountsContext,
  request: Request,
  accountId: string,
): Promise<Response> => {
  const { activeToken, saved, stale, secure } = heldSessions(request);
  const targets = saved.filter((entry) => entry.userId === accountId);
  if (targets.length === 0)
    return refuse(
      404,
      "account_not_found",
      stale ? { saved: serializeSavedSessionsCookie([], secure) } : {},
    );
  const kept = await releaseCopies(context, targets, activeToken);
  const cookies: SessionCookieUpdates =
    kept.length === targets.length
      ? {}
      : {
          saved: serializeSavedSessionsCookie(
            [...saved.filter((entry) => entry.userId !== accountId), ...kept],
            secure,
          ),
        };
  return kept.length === 0
    ? answer(204, undefined, cookies)
    : refuse(503, "unavailable", cookies);
};

/**
 * `POST /api/community/auth/accounts/sign-out-all`: signs every held session
 * out on the Backend, whatever its ceiling. Whatever was signed out (or was
 * already refused) is cleared; a session whose sign-out could not be confirmed
 * stays held. The 503 then says whether the current session was cleared and
 * names (id and handle only) the accounts still held, so the page can reload
 * as signed out or stay and offer another try without reading the list again.
 */
export const signOutAllCommunityAccounts = async (
  context: CommunityAccountsContext,
  request: Request,
): Promise<Response> => {
  const { activeToken, saved, secure } = heldSessions(request);
  const [activeOutcome, remaining] = await Promise.all([
    activeToken === undefined
      ? ("revoked" as const)
      : revokeCommunitySession(context, activeToken),
    releaseCopies(context, saved, activeToken),
  ]);
  const currentCleared = activeOutcome !== "failed";
  const cookies: SessionCookieUpdates = {
    ...(currentCleared
      ? { active: serializeClearedCommunitySessionCookie(secure) }
      : {}),
    saved: serializeSavedSessionsCookie(remaining, secure),
  };
  return currentCleared && remaining.length === 0
    ? answer(204, undefined, cookies)
    : answer(
        503,
        {
          reason: "unavailable",
          currentCleared,
          remaining: accountsOf(remaining).map((id) => ({
            id,
            handle: remaining.find((entry) => entry.userId === id)!.handle,
          })),
        },
        cookies,
      );
};

/** What the authentication relay knows before an add-account sign-in step. */
export interface AccountAddition {
  readonly activeToken: string | undefined;
  readonly active: PublicUserProfile | null;
  /** The saved list after this step's own clean-up. */
  readonly saved: readonly SavedSession[];
  /**
   * Saved sessions `me` refused whose sign-out could not be confirmed: still
   * held, but not counted toward the limit.
   */
  readonly uncounted: readonly SavedSession[];
  readonly secure: boolean;
  /**
   * A refused active session, a stale saved list and sessions let go to make
   * room are cleaned up by any answer.
   */
  readonly cookies: SessionCookieUpdates;
}

export type AccountAdditionStart =
  | { readonly ok: true; readonly addition: AccountAddition }
  | {
      readonly ok: false;
      readonly status: 409 | 503;
      readonly reason: "AUTH_ACCOUNT_LIMIT" | "AUTH_ACCOUNT_STATE_UNAVAILABLE";
      readonly cookies: SessionCookieUpdates;
    };

/**
 * Before an add-account sign-in step reaches the Backend: confirms which
 * account is current (so it can be kept) and that the new session can be
 * held. At the limit, saved sessions `me` refuses do not count and are let go
 * here, once their sign-out is confirmed, to make room. With `enforceLimit`
 * the step is refused while three accounts are still held; any step is
 * refused when the saved list has no room left without dropping a session.
 * An unconfirmed current account refuses the step rather than risk losing it.
 */
export const startAccountAddition = async (
  context: CommunityAccountsContext,
  request: Request,
  enforceLimit: boolean,
): Promise<AccountAdditionStart> => {
  const { activeToken, saved, stale, secure } = heldSessions(request);
  const check =
    activeToken === undefined ? null : await checkSession(context, activeToken);
  if (check?.state === "unavailable")
    return {
      ok: false,
      status: 503,
      reason: "AUTH_ACCOUNT_STATE_UNAVAILABLE",
      cookies: {},
    };
  const active = check?.state === "ready" ? check.profile : null;
  const held = (entries: readonly SavedSession[]) =>
    accountsOf(entries, active?.id).length + (active === null ? 0 : 1);
  let entries = saved;
  let uncounted: SavedSession[] = [];
  let unanswered = false;
  if (
    held(entries) >= communityAccountLimit ||
    entries.length >= savedSessionsCapacity
  ) {
    const checks = await Promise.all(
      entries.map((entry) => checkSession(context, entry.token)),
    );
    const refused = entries.filter(
      (_, index) => checks[index]!.state === "refused",
    );
    unanswered = checks.some((result) => result.state === "unavailable");
    uncounted = await releaseCopies(context, refused, activeToken);
    entries = entries.filter(
      (entry) => !refused.includes(entry) || uncounted.includes(entry),
    );
  }
  const cookies: SessionCookieUpdates = {
    ...(check?.state === "refused"
      ? { active: serializeClearedCommunitySessionCookie(secure) }
      : {}),
    ...(stale || entries.length < saved.length
      ? { saved: serializeSavedSessionsCookie(entries, secure) }
      : {}),
  };
  if (
    enforceLimit &&
    held(entries.filter((entry) => !uncounted.includes(entry))) >=
      communityAccountLimit
  )
    // A held account whose check went unanswered may be the one that would
    // make room: that is a transient state, not the account limit.
    return unanswered
      ? {
          ok: false,
          status: 503,
          reason: "AUTH_ACCOUNT_STATE_UNAVAILABLE",
          cookies,
        }
      : { ok: false, status: 409, reason: "AUTH_ACCOUNT_LIMIT", cookies };
  if (entries.length >= savedSessionsCapacity)
    return {
      ok: false,
      status: 503,
      reason: "AUTH_ACCOUNT_STATE_UNAVAILABLE",
      cookies,
    };
  return {
    ok: true,
    addition: {
      activeToken,
      active,
      saved: entries,
      uncounted,
      secure,
      cookies,
    },
  };
};

/**
 * After the Backend granted a session for `userId` in add-account mode: the
 * new account becomes current and the previous one joins the saved list.
 * Older sessions of the new account, and of the previous one (replaced by its
 * active session), are let go once their sign-out is confirmed, never
 * duplicated as accounts. If this browser meanwhile holds three other
 * accounts, the new session is signed out again and nothing changes
 * (`accepted: false`). When that sign-out cannot be confirmed the account is
 * kept instead, a fourth one until the reader removes one, so a session that
 * may be live is never lost.
 */
export const completeAccountAddition = async (
  context: CommunityAccountsContext,
  addition: AccountAddition,
  grant: { readonly token: string; readonly expiresAt: Date },
  userId: string,
): Promise<{
  readonly accepted: boolean;
  readonly cookies: SessionCookieUpdates;
}> => {
  const { active, activeToken, saved, uncounted, secure } = addition;
  // Re-adding the current account only replaces its cookie. The older session
  // is not signed out: a request still in flight with it would otherwise read
  // as a refused session and clear the new cookie.
  const leaving =
    active !== null && active.id !== userId && activeToken !== undefined
      ? active
      : null;
  const replaced = (entry: SavedSession) =>
    entry.userId === userId || entry.userId === leaving?.id;
  const others = new Set([
    ...(leaving === null ? [] : [leaving.id]),
    ...accountsOf(
      saved.filter((entry) => !uncounted.includes(entry)),
      userId,
    ),
  ]);
  if (
    others.size >= communityAccountLimit &&
    (await revokeCommunitySession(context, grant.token, userId)) !== "failed"
  )
    return { accepted: false, cookies: addition.cookies };
  const kept = await releaseCopies(
    context,
    saved.filter(replaced),
    activeToken,
  );
  return {
    accepted: true,
    cookies: {
      active: serializeCommunitySessionCookie(
        grant.token,
        grant.expiresAt,
        secure,
      ),
      saved: serializeSavedSessionsCookie(
        distinctTokens([
          ...(leaving === null
            ? []
            : [savedEntryFor(leaving, activeToken!, context.now)]),
          ...saved.filter((entry) => !replaced(entry)),
          ...kept,
        ]),
        secure,
      ),
    },
  };
};

/**
 * Lets go of this browser's saved sessions of `userId`, signing each out
 * first: after an ordinary sign-in of that account (its new session is now
 * current) and after 退出登录 of it, so nothing of it stays switchable. A
 * session whose sign-out cannot be confirmed stays held: a hidden copy while
 * the account is current, otherwise listed under that account, where 移除
 * ends it. Without such a session nothing is written, so a browser that holds
 * no other account gets exactly the answer it got before.
 */
export const releaseSavedSessionsOf = async (
  context: CommunityAccountsContext,
  request: Request,
  userId: string,
): Promise<SessionCookieUpdates> => {
  const { activeToken, saved, secure } = heldSessions(request);
  const copies = saved.filter((entry) => entry.userId === userId);
  if (copies.length === 0) return {};
  const kept = await releaseCopies(context, copies, activeToken);
  return kept.length === copies.length
    ? {}
    : {
        saved: serializeSavedSessionsCookie(
          [...saved.filter((entry) => entry.userId !== userId), ...kept],
          secure,
        ),
      };
};
