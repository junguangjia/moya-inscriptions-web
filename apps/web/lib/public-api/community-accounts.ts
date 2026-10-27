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
  maximumSavedSessions,
  readSavedSessions,
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
 * The Backend's absolute session lifetime. Web never learns an active
 * session's own expiry (a browser does not send cookie attributes back), so an
 * account moved from `yoyi-session` into the saved list gets this ceiling.
 * Switching never extends the session itself: the Backend refuses it at its
 * real expiry, and the entry then reads as `reauth_required`. Past the ceiling
 * the entry is `lapsed`; the cookie keeps it a while longer so the list can
 * still report it.
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

const heldSessions = (request: Request, now: number) => {
  const cookie = request.headers.get("cookie");
  return {
    activeToken: readCommunitySessionToken(cookie),
    saved: readSavedSessions(cookie, now),
    secure: isSecureRequest(request),
  };
};

/**
 * Best-effort Backend sign-out of saved sessions this browser lets go: an
 * older copy of an account whose newer session it keeps. Only the active
 * session is ever forwarded on requests, so ending these is safe; the active
 * one itself is never touched. Their entries are dropped whatever the outcome.
 * The account routes carry no trusted authentication source, so in Production
 * the Backend refuses their sign-out and such a copy lapses at its expiry; the
 * auth relay (sign-in, add-account) ends it for real.
 */
const releaseCopies = async (
  context: CommunityAccountsContext,
  copies: readonly SavedSession[],
  activeToken: string | undefined,
): Promise<void> => {
  await Promise.all(
    copies
      .filter((entry) => entry.token !== activeToken)
      .map((entry) =>
        revokeCommunitySession(context, entry.token, entry.userId),
      ),
  );
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
 * `GET /api/community/accounts`. Every held session is checked with `me`. A
 * refused current session is cleared as `/api/community/me` does; a refused
 * or lapsed saved one is dropped and reported once as `reauth_required`. A
 * saved copy of the current account is never another account: it is let go
 * (and signed out when still accepted) without a row. Any check the Backend
 * cannot answer for another account leaves everything as it is (503).
 */
export const listCommunityAccounts = async (
  context: CommunityAccountsContext,
  request: Request,
): Promise<Response> => {
  const { activeToken, saved, secure } = heldSessions(request, context.now);
  const [active, checks] = await Promise.all([
    activeToken === undefined ? null : checkSession(context, activeToken),
    Promise.all(
      saved.entries.map((entry) => checkSession(context, entry.token)),
    ),
  ]);
  if (active?.state === "unavailable") return refuse(503, "unavailable");
  const current = active?.state === "ready" ? active.profile : null;
  const copyOfCurrent = (entry: SavedSession) => entry.userId === current?.id;
  if (
    checks.some(
      (check, index) =>
        check.state === "unavailable" && !copyOfCurrent(saved.entries[index]!),
    )
  )
    return refuse(503, "unavailable");
  const kept: SavedSession[] = [];
  const others: CommunityAccountListing[] = [];
  const copies: SavedSession[] = [];
  let changed = saved.stale;
  saved.entries.forEach((entry, index) => {
    const check = checks[index]!;
    // An older saved session of the current account (an ordinary sign-in
    // into a saved account, or answers that overlapped) is no other account,
    // accepted or not.
    if (copyOfCurrent(entry)) {
      changed = true;
      if (check.state !== "refused") copies.push(entry);
      return;
    }
    if (check.state === "ready" && check.profile.id === entry.userId) {
      if (check.profile.handle !== entry.handle) changed = true;
      kept.push({ ...entry, handle: check.profile.handle });
      others.push({ ...check.profile, state: "ready" });
      return;
    }
    changed = true;
    others.push({
      id: entry.userId,
      handle: entry.handle,
      displayName: null,
      state: "reauth_required",
    });
  });
  // A session past its ceiling has ended: reported once, without asking.
  for (const entry of saved.lapsed) {
    changed = true;
    if (copyOfCurrent(entry)) continue;
    others.push({
      id: entry.userId,
      handle: entry.handle,
      displayName: null,
      state: "reauth_required",
    });
  }
  await releaseCopies(context, copies, activeToken);
  return answer(
    200,
    { current, others, limit: communityAccountLimit },
    {
      ...(active?.state === "refused"
        ? { active: serializeClearedCommunitySessionCookie(secure) }
        : {}),
      ...(changed ? { saved: serializeSavedSessionsCookie(kept, secure) } : {}),
    },
  );
};

/**
 * `POST /api/community/accounts/switch`. The target must be a saved account
 * whose session `me` confirms is that account; the active and saved sessions
 * are then swapped in one answer's cookies. A refused or lapsed target is
 * dropped and nothing else changes (409); an unanswered check changes nothing
 * (503).
 */
export const switchCommunityAccount = async (
  context: CommunityAccountsContext,
  request: Request,
  accountId: string,
): Promise<Response> => {
  const { activeToken, saved, secure } = heldSessions(request, context.now);
  const target = saved.entries.find((entry) => entry.userId === accountId);
  const lapsedTarget = saved.lapsed.find((entry) => entry.userId === accountId);
  // Everything else this browser holds, lapsed entries included, so they are
  // still reported later.
  const rest = [...saved.entries, ...saved.lapsed].filter(
    (entry) => entry !== target && entry !== lapsedTarget,
  );
  const [active, checked] = await Promise.all([
    activeToken === undefined ? null : checkSession(context, activeToken),
    target === undefined ? null : checkSession(context, target.token),
  ]);
  if (active?.state === "unavailable" || checked?.state === "unavailable")
    return refuse(503, "unavailable");
  const unchanged: SessionCookieUpdates = {
    ...(active?.state === "refused"
      ? { active: serializeClearedCommunitySessionCookie(secure) }
      : {}),
    ...(saved.stale ? { saved: serializeSavedSessionsCookie([], secure) } : {}),
  };
  if (active?.state === "ready" && active.profile.id === accountId) {
    // A repeated tap after a completed switch: already current. A saved copy
    // of the same account is let go.
    if (target === undefined && lapsedTarget === undefined)
      return answer(200, { current: active.profile }, unchanged);
    await releaseCopies(
      context,
      target === undefined ? [] : [target],
      activeToken,
    );
    return answer(
      200,
      { current: active.profile },
      { saved: serializeSavedSessionsCookie(rest, secure) },
    );
  }
  if (lapsedTarget !== undefined)
    return refuse(409, "reauth_required", {
      ...unchanged,
      saved: serializeSavedSessionsCookie(rest, secure),
    });
  if (target === undefined || checked === null)
    return refuse(404, "account_not_found", unchanged);
  if (checked.state !== "ready" || checked.profile.id !== accountId)
    return refuse(409, "reauth_required", {
      ...unchanged,
      saved: serializeSavedSessionsCookie(rest, secure),
    });
  const previous = active?.state === "ready" ? active.profile : null;
  const next =
    previous === null
      ? rest
      : [
          savedEntryFor(previous, activeToken!, context.now),
          ...rest.filter((entry) => entry.userId !== previous.id),
        ];
  // An older saved copy of the account that now leaves `yoyi-session` is
  // replaced by its active session.
  await releaseCopies(
    context,
    saved.entries.filter((entry) => entry.userId === previous?.id),
    activeToken,
  );
  return answer(
    200,
    { current: checked.profile },
    {
      active: serializeCommunitySessionCookie(
        target.token,
        new Date(target.expiresAt),
        secure,
      ),
      saved: serializeSavedSessionsCookie(next, secure),
    },
  );
};

/**
 * `POST /api/community/auth/accounts/remove`: signs one saved account out on
 * the Backend and lets it go. An already refused session is just dropped; an
 * unknown outcome keeps it (503).
 */
export const removeCommunityAccount = async (
  context: CommunityAccountsContext,
  request: Request,
  accountId: string,
): Promise<Response> => {
  const { saved, secure } = heldSessions(request, context.now);
  const target = saved.entries.find((entry) => entry.userId === accountId);
  const cleared: SessionCookieUpdates = saved.stale
    ? { saved: serializeSavedSessionsCookie([], secure) }
    : {};
  if (target === undefined) return refuse(404, "account_not_found", cleared);
  const outcome = await revokeCommunitySession(
    context,
    target.token,
    target.userId,
  );
  if (outcome === "failed") return refuse(503, "unavailable", cleared);
  return answer(204, undefined, {
    saved: serializeSavedSessionsCookie(
      [...saved.entries, ...saved.lapsed].filter((entry) => entry !== target),
      secure,
    ),
  });
};

/**
 * `POST /api/community/auth/accounts/sign-out-all`: signs every held session
 * out on the Backend. Whatever was signed out (or already refused or lapsed)
 * is cleared; a session whose sign-out could not be confirmed stays held. The
 * 503 then says whether the current session was cleared and names (id and
 * handle only) the other accounts still held, so the page can reload as
 * signed out or stay and offer another try without reading the list again.
 */
export const signOutAllCommunityAccounts = async (
  context: CommunityAccountsContext,
  request: Request,
): Promise<Response> => {
  const { activeToken, saved, secure } = heldSessions(request, context.now);
  const [activeOutcome, savedOutcomes] = await Promise.all([
    activeToken === undefined
      ? ("revoked" as const)
      : revokeCommunitySession(context, activeToken),
    Promise.all(
      saved.entries.map((entry) =>
        revokeCommunitySession(context, entry.token, entry.userId),
      ),
    ),
  ]);
  const remaining = saved.entries.filter(
    (_, index) => savedOutcomes[index] === "failed",
  );
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
          remaining: remaining.map((entry) => ({
            id: entry.userId,
            handle: entry.handle,
          })),
        },
        cookies,
      );
};

/** What the authentication relay knows before an add-account sign-in step. */
export interface AccountAddition {
  readonly activeToken: string | undefined;
  readonly active: PublicUserProfile | null;
  readonly saved: readonly SavedSession[];
  /** Kept when there is room, so the list still reports them. */
  readonly lapsed: readonly SavedSession[];
  readonly secure: boolean;
  /** A refused active session or a stale saved list is cleaned up by any answer. */
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
 * account is current (so it can be kept) and, with `enforceLimit`, refuses
 * when this browser already holds three accounts. An unconfirmed current
 * account refuses the step rather than risk losing it.
 */
export const startAccountAddition = async (
  context: CommunityAccountsContext,
  request: Request,
  enforceLimit: boolean,
): Promise<AccountAdditionStart> => {
  const { activeToken, saved, secure } = heldSessions(request, context.now);
  const check =
    activeToken === undefined ? null : await checkSession(context, activeToken);
  const cookies: SessionCookieUpdates = {
    ...(check?.state === "refused"
      ? { active: serializeClearedCommunitySessionCookie(secure) }
      : {}),
    ...(saved.stale ? { saved: serializeSavedSessionsCookie([], secure) } : {}),
  };
  if (check?.state === "unavailable")
    return {
      ok: false,
      status: 503,
      reason: "AUTH_ACCOUNT_STATE_UNAVAILABLE",
      cookies: {},
    };
  const active = check?.state === "ready" ? check.profile : null;
  const held =
    saved.entries.filter((entry) => entry.userId !== active?.id).length +
    (active === null ? 0 : 1);
  if (enforceLimit && held >= communityAccountLimit)
    return { ok: false, status: 409, reason: "AUTH_ACCOUNT_LIMIT", cookies };
  return {
    ok: true,
    addition: {
      activeToken,
      active,
      saved: saved.entries,
      lapsed: saved.lapsed,
      secure,
      cookies,
    },
  };
};

/**
 * After the Backend granted a session for `userId` in add-account mode: the
 * new account becomes current and the previous one joins the saved list. A
 * saved older session of the same account, or of the previous one, is
 * replaced (and signed out), never duplicated. If this browser meanwhile
 * holds three other accounts, the new session is signed out again and nothing
 * changes (`accepted: false`).
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
  const { active, activeToken, saved, lapsed, secure } = addition;
  const previous = saved.find((entry) => entry.userId === userId);
  const replaced = (entry: SavedSession) =>
    entry.userId === userId || entry.userId === active?.id;
  const others = saved.filter((entry) => !replaced(entry));
  // Re-adding the current account only replaces its cookie. The older session
  // is not signed out: a request still in flight with it would otherwise read
  // as a refused session and clear the new cookie.
  const next =
    active !== null && active.id !== userId && activeToken !== undefined
      ? [savedEntryFor(active, activeToken, context.now), ...others]
      : others;
  if (next.length > maximumSavedSessions) {
    await revokeCommunitySession(context, grant.token, userId);
    return { accepted: false, cookies: addition.cookies };
  }
  if (previous !== undefined)
    await revokeCommunitySession(context, previous.token, userId);
  // An older saved copy of the previous account is replaced by its active
  // session.
  await releaseCopies(
    context,
    saved.filter((entry) => entry !== previous && entry.userId === active?.id),
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
        [...next, ...lapsed.filter((entry) => !replaced(entry))].slice(
          0,
          maximumSavedSessions,
        ),
        secure,
      ),
    },
  };
};

/**
 * After an ordinary sign-in (no add-account mode) granted a session for
 * `userId`: an older saved session of the same account is no other account
 * any more. It is signed out on the Backend (best effort) and let go in the
 * same answer, so a later 退出登录 leaves nothing of this account switchable.
 * Without such a copy nothing is written: a browser that holds no other
 * account gets exactly the answer it got before.
 */
export const settleOrdinarySignIn = async (
  context: CommunityAccountsContext,
  request: Request,
  userId: string,
): Promise<SessionCookieUpdates> => {
  const { activeToken, saved, secure } = heldSessions(request, context.now);
  const held = [...saved.entries, ...saved.lapsed];
  if (!held.some((entry) => entry.userId === userId)) return {};
  await releaseCopies(
    context,
    saved.entries.filter((entry) => entry.userId === userId),
    activeToken,
  );
  return {
    saved: serializeSavedSessionsCookie(
      held.filter((entry) => entry.userId !== userId),
      secure,
    ),
  };
};
