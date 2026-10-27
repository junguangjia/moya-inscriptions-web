import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseCommunityAccountRefusal,
  parseCommunityAccountsView,
  parseCommunitySignOutAllPartial,
} from "./community-accounts-view";
import { readSavedSessions } from "./saved-sessions-cookie";
import {
  relayServerCommunityAccounts,
  relayServerCommunityAuth,
} from "./server.js";

/*
 * account-switching-v1: several signed-in accounts per browser, the active one
 * in `yoyi-session` and the others in the HttpOnly `yoyi-saved-sessions`. A
 * small in-memory Backend answers `me`, sign-in and sign-out for synthetic
 * accounts; a cookie jar plays the browser.
 */
interface Account {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}
const account = (letter: string, handle: string, displayName: string) => ({
  id: `user-${letter.repeat(32)}`,
  handle,
  displayName,
});
const A = account("a", "account-a", "账号甲");
const B = account("b", "account-b", "账号乙");
const C = account("c", "account-c", "账号丙");
const D = account("d", "account-d", "账号丁");
const tokenA = "A".repeat(43);
const tokenB = "B".repeat(43);
const tokenC = "C".repeat(43);

const host = "127.0.0.1:3410";
const origin = `http://${host}`;
const grantPaths = new Set([
  "/v1/community/auth/passwords/login",
  "/v1/community/auth/challenges/verify",
  "/v1/community/auth/registrations",
]);

class FakeBackend {
  readonly sessions = new Map<string, Account>();
  readonly unavailable = new Set<string>();
  /** Sessions, or every session of these accounts, whose sign-out fails. */
  readonly signOutFails = new Set<string>();
  readonly grants: Account[] = [];
  private issued = 0;
  readonly fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /u, "");
    if (url.pathname === "/v1/me") {
      if (token !== undefined && this.unavailable.has(token))
        return new Response(null, { status: 503 });
      const profile =
        token === undefined ? undefined : this.sessions.get(token);
      return profile === undefined
        ? new Response(null, { status: 401 })
        : Response.json(profile);
    }
    if (url.pathname === "/v1/community/auth/sign-out") {
      const profile =
        token === undefined ? undefined : this.sessions.get(token);
      if (
        token !== undefined &&
        (this.signOutFails.has(token) ||
          (profile !== undefined && this.signOutFails.has(profile.id)))
      )
        return new Response(null, { status: 503 });
      if (profile === undefined)
        return Response.json(
          {
            error: { code: "UNAUTHENTICATED", message: "AUTH_UNAUTHENTICATED" },
          },
          { status: 401 },
        );
      const asserted = headers.get("x-author-account");
      if (asserted !== null && asserted !== profile.id)
        return Response.json(
          { error: { code: "CONFLICT", message: "AUTH_ACCOUNT_MISMATCH" } },
          { status: 409 },
        );
      this.sessions.delete(token!);
      return new Response(null, { status: 204 });
    }
    if (grantPaths.has(url.pathname)) {
      const profile = this.grants.shift();
      if (profile === undefined)
        return Response.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "AUTH_INVALID_CREDENTIALS",
            },
          },
          { status: 401 },
        );
      const granted = `T${String(++this.issued).padStart(42, "0")}`;
      this.sessions.set(granted, profile);
      return Response.json({
        outcome: "signed_in",
        session: {
          token: granted,
          expiresAt: "2030-01-01T00:00:00.000Z",
          profile,
        },
      });
    }
    if (url.pathname === "/v1/community/auth/challenges")
      return Response.json({
        challengeId: `challenge-${"0".repeat(32)}`,
        resendAvailableAt: "2030-01-01T00:00:00.000Z",
        maskedTarget: "s***@example.invalid",
      });
    if (url.pathname === "/v1/community/auth/passwords/reset")
      return Response.json({ reset: true });
    return new Response(null, { status: 404 });
  });
  callsTo(path: string) {
    return this.fetch.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === path,
    );
  }
  tokenOf(profile: Account) {
    return [...this.sessions].find(([, value]) => value === profile)?.[0];
  }
}

class Browser {
  readonly jar = new Map<string, string>();
  /** A cookie's Expires, which a browser honours by no longer sending it. */
  readonly expiry = new Map<string, number>();
  get cookie() {
    return [...this.jar]
      .filter(([name]) => (this.expiry.get(name) ?? Infinity) > Date.now())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  remember(response: Response): Response {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split("; ");
      const split = pair.indexOf("=");
      const name = pair.slice(0, split);
      const expires = attributes.find((attribute) =>
        attribute.startsWith("Expires="),
      );
      if (attributes.includes("Max-Age=0")) {
        this.jar.delete(name);
        this.expiry.delete(name);
      } else {
        this.jar.set(name, pair.slice(split + 1));
        if (expires === undefined) this.expiry.delete(name);
        else this.expiry.set(name, Date.parse(expires.slice(8)));
      }
    }
    return response;
  }
  savedEntries() {
    return readSavedSessions(this.cookie).entries;
  }
  saved() {
    return this.savedEntries().map((entry) => entry.userId);
  }
  active() {
    return this.jar.get("yoyi-session");
  }
  /** Stores saved entries directly, as earlier answers left them. */
  hold(...entries: readonly (readonly [Account, string, number?])[]) {
    this.jar.set(
      "yoyi-saved-sessions",
      entries
        .map(
          ([held, token, expiresAt = Date.now() + 60_000]) =>
            `${held.id}.${held.handle}.${token}.${expiresAt}`,
        )
        .join("~"),
    );
  }
  auth(path: string, body: unknown, headers: Record<string, string> = {}) {
    return relayServerCommunityAuth(
      new Request(`${origin}/api/community/auth/${path}`, {
        method: "POST",
        headers: {
          host,
          origin,
          "content-type": "application/json",
          cookie: this.cookie,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    ).then((response) => this.remember(response));
  }
  add(path: string, body: unknown = {}) {
    return this.auth(path, body, { "x-yoyi-account-intent": "add" });
  }
  /** A same-origin fetch: browsers send Fetch Metadata and no Origin on a GET. */
  list(headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
    return relayServerCommunityAccounts(
      new Request(`${origin}/api/community/accounts`, {
        headers: { host, cookie: this.cookie, ...headers },
      }),
      "list",
    ).then((response) => this.remember(response));
  }
  switchTo(accountId: string, headers: Record<string, string> = {}) {
    return relayServerCommunityAccounts(
      new Request(`${origin}/api/community/accounts/switch`, {
        method: "POST",
        headers: {
          host,
          origin,
          "content-type": "application/json",
          cookie: this.cookie,
          ...headers,
        },
        body: JSON.stringify({ accountId }),
      }),
      "switch",
    ).then((response) => this.remember(response));
  }
}

let backend: FakeBackend;
let browser: Browser;
const allTokens = () => [tokenA, tokenB, tokenC, ...backend.sessions.keys()];
const expectNoToken = (text: string) => {
  for (const token of allTokens()) expect(text).not.toContain(token);
};
const json = async (response: Response) => {
  const text = await response.text();
  expectNoToken(text);
  return JSON.parse(text) as unknown;
};
const listed = async () => {
  const response = await browser.list();
  expect(response.status).toBe(200);
  // The list never writes a cookie.
  expect(response.headers.getSetCookie()).toEqual([]);
  return parseCommunityAccountsView(await json(response));
};
const reauth = (held: Account) => ({
  id: held.id,
  handle: held.handle,
  displayName: null,
  state: "reauth_required",
});
/** Signs A in as the only account, as an ordinary sign-in leaves it. */
const signedInAsA = () => {
  backend.sessions.set(tokenA, A);
  browser.jar.set("yoyi-session", tokenA);
};

beforeEach(() => {
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
  backend = new FakeBackend();
  browser = new Browser();
  vi.stubGlobal("fetch", backend.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adding accounts through the sign-in flow", () => {
  it("keeps the previous account when another one signs in, and lists both without any token", async () => {
    signedInAsA();
    backend.grants.push(B);
    const added = await browser.add("passwords/login", {
      channel: "handle",
      identifier: B.handle,
      password: "synthetic",
    });
    expect(added.status).toBe(200);
    const body = (await json(added)) as { session: Record<string, unknown> };
    expect(body.session).not.toHaveProperty("token");
    // The sign-in itself never carried the current account's session.
    const login = backend.callsTo("/v1/community/auth/passwords/login")[0]!;
    expect(new Headers(login[1]?.headers).has("authorization")).toBe(false);
    expect(browser.active()).not.toBe(tokenA);
    expect(backend.sessions.get(browser.active()!)).toEqual(B);
    expect(browser.saved()).toEqual([A.id]);
    for (const line of added.headers.getSetCookie())
      expect(line).toContain("HttpOnly; SameSite=Lax");

    const response = await browser.list();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(parseCommunityAccountsView(await json(response))).toEqual({
      current: B,
      others: [{ ...A, state: "ready" }],
      limit: 3,
    });
  });

  it("adds from a signed-out browser that still lists other accounts", async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
    // 退出登录 signs out only the current account; the saved list stays.
    const signedOut = await browser.auth("sign-out", {});
    expect(signedOut.status).toBe(204);
    expect(browser.active()).toBeUndefined();
    expect(browser.saved()).toEqual([A.id]);
    expect(await listed()).toEqual({
      current: null,
      others: [{ ...A, state: "ready" }],
      limit: 3,
    });
    backend.grants.push(C);
    expect((await browser.add("challenges/verify", {})).status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(C);
    expect(browser.saved()).toEqual([A.id]);
  });

  it("refuses a fourth account before the Backend is asked, with a reason the sign-in page can show", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("registrations", {});
    expect(browser.saved()).toEqual([B.id, A.id]);
    const before = backend.fetch.mock.calls.length;
    for (const [path, body] of [
      ["passwords/login", {}],
      ["registrations", {}],
      ["challenges", { purpose: "sign_in" }],
      ["challenges", { purpose: "register" }],
    ] as const) {
      const refused = await browser.add(path, body);
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({
        error: { code: "CONFLICT", message: "AUTH_ACCOUNT_LIMIT" },
      });
    }
    // Only `me` checks of the held sessions were made.
    expect(
      backend.fetch.mock.calls
        .slice(before)
        .every(([input]) => new URL(String(input)).pathname === "/v1/me"),
    ).toBe(true);
    expect(backend.sessions.get(browser.active()!)).toEqual(C);
    expect(browser.saved()).toEqual([B.id, A.id]);
  });

  it("answers unavailable, not the account limit, when a held account cannot be checked", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("registrations", {});
    expect(browser.saved()).toEqual([B.id, A.id]);
    // A's check goes unanswered: A might be the account that makes room.
    backend.unavailable.add(tokenA);
    const refused = await browser.add("passwords/login", {});
    expect(refused.status).toBe(503);
    expect(await json(refused)).toMatchObject({
      error: { message: "AUTH_ACCOUNT_STATE_UNAVAILABLE" },
    });
    expect(backend.sessions.get(browser.active()!)).toEqual(C);
    expect(browser.saved()).toEqual([B.id, A.id]);
  });

  it("lets an account the Backend no longer accepts make room, signing it out first", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    backend.sessions.delete(tokenA);
    backend.grants.push(D);
    const added = await browser.add("passwords/login", {});
    expect(added.status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(D);
    expect(browser.saved()).toEqual([C.id, B.id]);
    const signOut = backend.callsTo("/v1/community/auth/sign-out").at(-1)!;
    const headers = new Headers(signOut[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${tokenA}`);
    expect(headers.get("x-author-account")).toBe(A.id);
  });

  it("does not count a refused account whose sign-out cannot be confirmed, and keeps it listed", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    backend.sessions.delete(tokenA);
    backend.signOutFails.add(tokenA);
    backend.grants.push(D);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(browser.saved()).toEqual([C.id, B.id, A.id]);
    expect(await listed()).toEqual({
      current: D,
      others: [{ ...C, state: "ready" }, { ...B, state: "ready" }, reauth(A)],
      limit: 3,
    });
  });

  it("refuses any step before the Backend while the saved list has no room left", async () => {
    signedInAsA();
    const copies = ["1", "2", "3", "4", "5", "6"].map((digit) =>
      digit.repeat(43),
    );
    for (const token of copies) backend.sessions.set(token, B);
    browser.hold(...copies.map((token) => [B, token] as const));
    backend.grants.push(C);
    const before = new Map(browser.jar);
    for (const path of ["passwords/login", "challenges/verify"]) {
      const refused = await browser.add(path, {});
      expect(refused.status).toBe(503);
      expect(await json(refused)).toMatchObject({
        error: { message: "AUTH_ACCOUNT_STATE_UNAVAILABLE" },
      });
    }
    expect(backend.callsTo("/v1/community/auth/passwords/login")).toEqual([]);
    expect(backend.callsTo("/v1/community/auth/challenges/verify")).toEqual([]);
    expect(browser.jar).toEqual(before);
  });

  it("replaces a listed account's stored session instead of duplicating it, even with three held", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    const oldB = backend.tokenOf(B)!;
    backend.grants.push(B);
    const readded = await browser.add("challenges/verify", {});
    expect(readded.status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(B);
    expect(browser.active()).not.toBe(oldB);
    expect(browser.saved()).toEqual([C.id, A.id]);
    // The replaced session was signed out on the Backend.
    expect(backend.sessions.has(oldB)).toBe(false);
  });

  it("keeps a replaced session whose sign-out cannot be confirmed as a hidden copy, and ends it later", async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
    // A is saved; adding A again cannot sign its older session out.
    backend.signOutFails.add(tokenA);
    backend.grants.push(A);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(A);
    expect(browser.saved()).toEqual([B.id, A.id]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
    // The copy is never another account.
    expect(await listed()).toEqual({
      current: A,
      others: [{ ...B, state: "ready" }],
      limit: 3,
    });
    // 退出登录 of A tries again; still unconfirmed, A is then listed so it
    // can be removed.
    await browser.auth("sign-out", {}, { "x-author-account": A.id });
    expect(browser.active()).toBeUndefined();
    expect(browser.saved()).toEqual([B.id, A.id]);
    expect(await listed()).toEqual({
      current: null,
      others: [
        { ...B, state: "ready" },
        { ...A, state: "ready" },
      ],
      limit: 3,
    });
    backend.signOutFails.delete(tokenA);
    expect(
      (await browser.auth("accounts/remove", { accountId: A.id })).status,
    ).toBe(204);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.saved()).toEqual([B.id]);
  });

  it("signs a new session out again when three accounts were added meanwhile", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    const before = new Map(browser.jar);
    backend.grants.push(D);
    const refused = await browser.add("challenges/verify", {});
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      error: { message: "AUTH_ACCOUNT_LIMIT" },
    });
    expect(browser.jar).toEqual(before);
    expect([...backend.sessions.values()]).not.toContainEqual(D);
  });

  it("keeps a fourth account whose new session cannot be signed out again, rather than lose it", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    backend.signOutFails.add(D.id);
    backend.grants.push(D);
    const kept = await browser.add("challenges/verify", {});
    expect(kept.status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(D);
    expect(browser.saved()).toEqual([C.id, B.id, A.id]);
    // Every held account is still listed, so one can be removed.
    expect(await listed()).toEqual({
      current: D,
      others: [C, B, A].map((held) => ({ ...held, state: "ready" })),
      limit: 3,
    });
  });

  it("re-adding the current account only replaces its cookie", async () => {
    signedInAsA();
    backend.grants.push(A);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(browser.active()).not.toBe(tokenA);
    expect(backend.sessions.get(browser.active()!)).toEqual(A);
    expect(browser.saved()).toEqual([]);
  });

  it("refuses the step while the current account cannot be confirmed, so it is never lost", async () => {
    signedInAsA();
    backend.unavailable.add(tokenA);
    backend.grants.push(B);
    const refused = await browser.add("passwords/login", {});
    expect(refused.status).toBe(503);
    expect(await json(refused)).toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "AUTH_ACCOUNT_STATE_UNAVAILABLE",
      },
    });
    expect(backend.callsTo("/v1/community/auth/passwords/login")).toEqual([]);
    expect(browser.active()).toBe(tokenA);
  });

  it("does not keep a current session the Backend refuses", async () => {
    browser.jar.set("yoyi-session", tokenA);
    backend.grants.push(B);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(B);
    expect(browser.saved()).toEqual([]);
  });

  it("keeps the current session on factor challenges and off identifier challenges", async () => {
    signedInAsA();
    await browser.add("challenges", { purpose: "sign_in" });
    await browser.add("challenges", { purpose: "password_reset" });
    await browser.add("challenges", { purpose: "reauthenticate" });
    const sent = backend
      .callsTo("/v1/community/auth/challenges")
      .map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(sent).toEqual([null, null, `Bearer ${tokenA}`]);
  });

  it("lets a password reset for the added account leave the current one signed in", async () => {
    signedInAsA();
    const reset = await browser.add("passwords/reset", {});
    expect(reset.status).toBe(200);
    expect(reset.headers.getSetCookie()).toEqual([]);
    expect(browser.active()).toBe(tokenA);
    // Without add-account mode a reset still signs this browser out.
    await browser.auth("passwords/reset", {});
    expect(browser.active()).toBeUndefined();
  });

  it("keeps the existing sign-in unchanged without the header", async () => {
    signedInAsA();
    backend.grants.push(B);
    const signedIn = await browser.auth("passwords/login", {});
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.getSetCookie()).toHaveLength(1);
    expect(backend.sessions.get(browser.active()!)).toEqual(B);
    expect(browser.saved()).toEqual([]);
    expect(
      new Headers(
        backend.callsTo("/v1/community/auth/passwords/login")[0]![1]?.headers,
      ).get("authorization"),
    ).toBe(`Bearer ${tokenA}`);
  });

  it("lets go of a saved copy when an ordinary sign-in signs that account in again, so 退出登录 leaves nothing of it", async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
    // 退出登录 keeps A listed; the ordinary 登录 link then signs A in again.
    await browser.auth("sign-out", {});
    expect(browser.saved()).toEqual([A.id]);
    backend.grants.push(A);
    const signedIn = await browser.auth("passwords/login", {});
    expect(signedIn.status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(A);
    expect(browser.active()).not.toBe(tokenA);
    expect(browser.saved()).toEqual([]);
    // The older session was signed out on the Backend, naming its account.
    const signOut = backend.callsTo("/v1/community/auth/sign-out").at(-1)!;
    const headers = new Headers(signOut[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${tokenA}`);
    expect(headers.get("x-author-account")).toBe(A.id);
    expect(backend.sessions.has(tokenA)).toBe(false);
    // Signing A out now leaves nothing of A switchable on this browser.
    expect((await browser.auth("sign-out", {})).status).toBe(204);
    expect(await listed()).toEqual({ current: null, others: [], limit: 3 });
  });

  it("keeps a saved copy an ordinary sign-in cannot sign out, hidden while that account is current", async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
    await browser.auth("sign-out", {});
    backend.signOutFails.add(tokenA);
    backend.grants.push(A);
    expect((await browser.auth("passwords/login", {})).status).toBe(200);
    expect(browser.saved()).toEqual([A.id]);
    expect(await listed()).toEqual({ current: A, others: [], limit: 3 });
    // 退出登录 of A ends the copy too once the Backend confirms it.
    backend.signOutFails.delete(tokenA);
    expect((await browser.auth("sign-out", {})).status).toBe(204);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.saved()).toEqual([]);
  });

  it("refuses an unknown intent instead of guessing", async () => {
    signedInAsA();
    const refused = await browser.auth(
      "passwords/login",
      {},
      { "x-yoyi-account-intent": "replace" },
    );
    expect(refused.status).toBe(422);
    expect(backend.fetch).not.toHaveBeenCalled();
  });
});

describe("signing the current account out", () => {
  const tokenA2 = "E".repeat(43);
  /** A is current with a newer session; an older one and B are saved. */
  const currentWithCopy = () => {
    backend.sessions.set(tokenA2, A);
    backend.sessions.set(tokenA, A);
    backend.sessions.set(tokenB, B);
    browser.jar.set("yoyi-session", tokenA2);
    browser.hold([B, tokenB], [A, tokenA]);
  };

  it.each([
    ["names the account", { "x-author-account": A.id }],
    ["asks `me` which account it is", {}],
  ])(
    "also signs out the saved sessions of the same account when the page %s",
    async (_, headers: Record<string, string>) => {
      currentWithCopy();
      const signedOut = await browser.auth("sign-out", {}, headers);
      expect(signedOut.status).toBe(204);
      expect(browser.active()).toBeUndefined();
      expect(backend.sessions.has(tokenA2)).toBe(false);
      expect(backend.sessions.has(tokenA)).toBe(false);
      expect(backend.sessions.get(tokenB)).toEqual(B);
      expect(browser.saved()).toEqual([B.id]);
    },
  );

  it("also signs out the saved copies when the current session had already ended", async () => {
    currentWithCopy();
    // The current session is gone on the Backend (sign-out and `me` refuse
    // it); the saved copy of the same account still works.
    backend.sessions.delete(tokenA2);
    const signedOut = await browser.auth(
      "sign-out",
      {},
      { "x-author-account": A.id },
    );
    expect(signedOut.status).toBe(204);
    expect(browser.active()).toBeUndefined();
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(backend.sessions.get(tokenB)).toEqual(B);
    expect(browser.saved()).toEqual([B.id]);
  });

  it("leaves the saved sessions alone when the sign-out is refused as another account's", async () => {
    currentWithCopy();
    const before = new Map(browser.jar);
    const refused = await browser.auth(
      "sign-out",
      {},
      { "x-author-account": B.id },
    );
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(browser.jar).toEqual(before);
    expect(backend.sessions.get(tokenA)).toEqual(A);
  });

  it("keeps the current session and every saved session on an unconfirmed answer, so 退出登录 can be retried", async () => {
    currentWithCopy();
    const active = browser.active();
    backend.signOutFails.add(tokenA2);
    const failed = await browser.auth(
      "sign-out",
      {},
      { "x-author-account": A.id },
    );
    expect(failed.status).toBe(503);
    expect(browser.active()).toBe(active);
    expect(browser.saved()).toEqual([B.id, A.id]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
  });
});

describe("listing and switching held accounts", () => {
  const holdAandB = async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
  };

  it("swaps the active and saved sessions after `me` confirms the target", async () => {
    await holdAandB();
    const tokenOfB = browser.active()!;
    const switched = await browser.switchTo(A.id);
    expect(switched.status).toBe(200);
    expect(await json(switched)).toEqual({ current: A });
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([B.id]);
    // Back again: the same sessions, never a new sign-in.
    expect((await browser.switchTo(B.id)).status).toBe(200);
    expect(browser.active()).toBe(tokenOfB);
    expect(browser.saved()).toEqual([A.id]);
    expect(backend.callsTo("/v1/community/auth/sign-out")).toEqual([]);
  });

  it("answers a repeated tap as already current and an unknown account as not held", async () => {
    await holdAandB();
    await browser.switchTo(A.id);
    const again = await browser.switchTo(A.id);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ current: A });
    const unknown = await browser.switchTo(D.id);
    expect(unknown.status).toBe(404);
    expect(parseCommunityAccountRefusal(await json(unknown))).toEqual({
      reason: "account_not_found",
    });
    expect(browser.active()).toBe(tokenA);
  });

  it("refuses a target whose session was refused and keeps it listed as 需重新登录 until it is removed", async () => {
    await holdAandB();
    const current = browser.active();
    backend.sessions.delete(tokenA);
    const refused = await browser.switchTo(A.id);
    expect(refused.status).toBe(409);
    expect(parseCommunityAccountRefusal(await json(refused))).toEqual({
      reason: "reauth_required",
    });
    expect(browser.active()).toBe(current);
    expect(browser.saved()).toEqual([A.id]);
    for (let read = 0; read < 2; read++)
      expect((await listed())?.others).toEqual([reauth(A)]);
    // 移除 works for it too: its sign-out is refused, so it is let go.
    const removed = await browser.auth("accounts/remove", { accountId: A.id });
    expect(removed.status).toBe(204);
    expect(browser.saved()).toEqual([]);
    expect((await listed())?.others).toEqual([]);
  });

  it("changes nothing while a session cannot be checked", async () => {
    await holdAandB();
    const before = new Map(browser.jar);
    backend.unavailable.add(tokenA);
    const failed = await browser.switchTo(A.id);
    expect(failed.status).toBe(503);
    expect(parseCommunityAccountRefusal(await json(failed))).toEqual({
      reason: "unavailable",
    });
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect(browser.jar).toEqual(before);
    expect((await browser.list()).status).toBe(503);
    expect(browser.jar).toEqual(before);
  });

  it("lists a refused saved account as 需重新登录 on every read and keeps holding it", async () => {
    await holdAandB();
    backend.sessions.delete(tokenA);
    for (let read = 0; read < 2; read++)
      expect(await listed()).toEqual({
        current: B,
        others: [reauth(A)],
        limit: 3,
      });
    expect(browser.saved()).toEqual([A.id]);
  });

  const tokenA2 = "E".repeat(43);
  /** A is current with a newer session; an older copy of A is still saved. */
  const currentWithSavedCopy = (...others: (readonly [Account, string])[]) => {
    backend.sessions.set(tokenA2, A);
    browser.jar.set("yoyi-session", tokenA2);
    browser.hold([A, tokenA], ...others);
  };

  it("never lists a saved copy of the current account and never lets it go on a read", async () => {
    for (const accepted of [false, true]) {
      if (accepted) backend.sessions.set(tokenA, A);
      currentWithSavedCopy();
      expect(await listed()).toEqual({ current: A, others: [], limit: 3 });
      expect(browser.saved()).toEqual([A.id]);
    }
    expect(backend.callsTo("/v1/community/auth/sign-out")).toEqual([]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
    expect(browser.active()).toBe(tokenA2);
  });

  it("never signs the current session out when a saved copy carries the same token", async () => {
    signedInAsA();
    browser.hold([A, tokenA]);
    expect(await listed()).toEqual({ current: A, others: [], limit: 3 });
    // A repeated tap lets the duplicate go without ending the session.
    expect((await browser.switchTo(A.id)).status).toBe(200);
    expect(backend.callsTo("/v1/community/auth/sign-out")).toEqual([]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([]);
  });

  it("signs a saved copy out when a switch lets it go", async () => {
    backend.sessions.set(tokenB, B);
    currentWithSavedCopy([B, tokenB]);
    backend.sessions.set(tokenA, A);
    // A repeated tap on the current account drops its copy.
    expect((await browser.switchTo(A.id)).status).toBe(200);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.active()).toBe(tokenA2);
    expect(browser.saved()).toEqual([B.id]);
    // Switching away replaces an older copy with the active session.
    backend.sessions.set(tokenA, A);
    currentWithSavedCopy([B, tokenB]);
    expect((await browser.switchTo(B.id)).status).toBe(200);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.active()).toBe(tokenB);
    expect(browser.saved()).toEqual([A.id]);
    expect(browser.savedEntries().map((entry) => entry.token)).toEqual([
      tokenA2,
    ]);
  });

  it("keeps a copy whose sign-out cannot be confirmed, hidden behind its account's newer session", async () => {
    backend.sessions.set(tokenA, A);
    backend.sessions.set(tokenB, B);
    backend.signOutFails.add(tokenA);
    currentWithSavedCopy([B, tokenB]);
    // A repeated tap cannot end the copy: it stays.
    expect((await browser.switchTo(A.id)).status).toBe(200);
    expect(browser.savedEntries().map((entry) => entry.token)).toEqual([
      tokenA,
      tokenB,
    ]);
    // Switching away keeps it beside A's newer session; A is listed once.
    expect((await browser.switchTo(B.id)).status).toBe(200);
    expect(browser.active()).toBe(tokenB);
    expect(browser.savedEntries().map((entry) => entry.token)).toEqual([
      tokenA2,
      tokenA,
    ]);
    expect(await listed()).toEqual({
      current: B,
      others: [{ ...A, state: "ready" }],
      limit: 3,
    });
    // Back to A: its newer session becomes current again, the copy stays.
    expect((await browser.switchTo(A.id)).status).toBe(200);
    expect(browser.active()).toBe(tokenA2);
    expect(browser.savedEntries().map((entry) => entry.token)).toEqual([
      tokenB,
      tokenA,
    ]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
  });

  it("reports a refused current session as signed out without clearing it, and still lists the others", async () => {
    await holdAandB();
    const refusedToken = browser.active()!;
    backend.sessions.delete(refusedToken);
    expect(await listed()).toEqual({
      current: null,
      others: [{ ...A, state: "ready" }],
      limit: 3,
    });
    expect(browser.active()).toBe(refusedToken);
  });

  it("reads past a malformed saved list without clearing it; the next change clears it", async () => {
    signedInAsA();
    browser.jar.set(
      "yoyi-saved-sessions",
      `user-${"b".repeat(32)}.x.${tokenB}`,
    );
    expect((await listed())?.others).toEqual([]);
    expect(browser.jar.has("yoyi-saved-sessions")).toBe(true);
    expect((await browser.switchTo(B.id)).status).toBe(404);
    expect(browser.jar.has("yoyi-saved-sessions")).toBe(false);
  });

  it("answers only this origin's own pages, before any check", async () => {
    await holdAandB();
    backend.fetch.mockClear();
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "same-origin", origin: "https://foreign.invalid" },
      { origin: "https://foreign.invalid" },
    ]) {
      const refused = await browser.list(headers);
      expect(refused.status).toBe(403);
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    expect(backend.fetch).not.toHaveBeenCalled();
    // A same-origin fetch, with or without Origin; a browser without Fetch
    // Metadata sends neither header on a same-origin GET.
    for (const headers of [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-origin", origin },
      {},
    ])
      expect((await browser.list(headers)).status).toBe(200);
  });

  it("refuses cross-site, non-JSON, oversized and malformed switch requests before any check", async () => {
    await holdAandB();
    backend.fetch.mockClear();
    const send = (init: RequestInit) =>
      relayServerCommunityAccounts(
        new Request(`${origin}/api/community/accounts/switch`, {
          method: "POST",
          ...init,
          headers: {
            host,
            origin,
            "content-type": "application/json",
            cookie: browser.cookie,
            ...(init.headers as Record<string, string>),
          },
        }),
        "switch",
      );
    expect(
      (
        await send({
          headers: { origin: "https://foreign.invalid" },
          body: JSON.stringify({ accountId: A.id }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send({
          headers: { "sec-fetch-site": "cross-site" },
          body: JSON.stringify({ accountId: A.id }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send({
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ accountId: A.id }),
        })
      ).status,
    ).toBe(422);
    expect(
      (await send({ body: JSON.stringify({ accountId: "x".repeat(2_000) }) }))
        .status,
    ).toBe(413);
    for (const body of [
      "{",
      JSON.stringify({ accountId: "user-1" }),
      JSON.stringify({ accountId: A.id, extra: true }),
    ])
      expect((await send({ body })).status).toBe(422);
    expect(
      (
        await relayServerCommunityAccounts(
          new Request(`${origin}/api/community/accounts`, { method: "POST" }),
          "list",
        )
      ).status,
    ).toBe(405);
    expect(backend.fetch).not.toHaveBeenCalled();
  });
});

describe("saved sessions past their ceiling", () => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse("2026-10-27T00:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** A is saved when B is added; its ceiling runs from that moment. */
  const holdAandB = async () => {
    signedInAsA();
    backend.grants.push(B);
    await browser.add("passwords/login", {});
  };
  const meTokens = () =>
    backend
      .callsTo("/v1/me")
      .map(([, init]) => new Headers(init?.headers).get("authorization"));

  it("still asks the Backend about an account past its ceiling, and lists what it answers", async () => {
    await holdAandB();
    vi.setSystemTime(start + 8 * day);
    backend.fetch.mockClear();
    // A longer configured lifetime: the Backend still accepts A.
    expect(await listed()).toEqual({
      current: B,
      others: [{ ...A, state: "ready" }],
      limit: 3,
    });
    expect(meTokens()).toContain(`Bearer ${tokenA}`);
    // A's session ended: 需重新登录 on every read, still held.
    backend.sessions.delete(tokenA);
    for (let read = 0; read < 2; read++)
      expect((await listed())?.others).toEqual([reauth(A)]);
    expect(browser.saved()).toEqual([A.id]);
  });

  it("switches to an account past its ceiling that the Backend still accepts, with a new cookie lifetime", async () => {
    await holdAandB();
    vi.setSystemTime(start + 8 * day);
    const switched = await browser.switchTo(A.id);
    expect(switched.status).toBe(200);
    expect(browser.active()).toBe(tokenA);
    expect(browser.expiry.get("yoyi-session")).toBe(start + 15 * day);
    // One the Backend refused stays held and is refused, never switched to.
    vi.setSystemTime(start + 9 * day);
    backend.sessions.delete(browser.savedEntries()[0]!.token);
    const refused = await browser.switchTo(B.id);
    expect(refused.status).toBe(409);
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([B.id]);
  });

  it("keeps the list past its ceiling, so an account whose session ended is still listed after signing in again", async () => {
    await holdAandB();
    vi.setSystemTime(start + day);
    await browser.auth("sign-out", {});
    backend.grants.push(B);
    await browser.auth("passwords/login", {});
    vi.setSystemTime(start + 8 * day);
    backend.sessions.delete(tokenA);
    expect(await listed()).toEqual({
      current: B,
      others: [reauth(A)],
      limit: 3,
    });
    expect(browser.saved()).toEqual([A.id]);
  });

  it("keeps an ended account through an addition and a switch, so it is still listed", async () => {
    await holdAandB();
    vi.setSystemTime(start + 8 * day);
    backend.sessions.delete(tokenA);
    backend.grants.push(C);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(browser.saved()).toEqual([B.id, A.id]);
    expect((await listed())?.others).toEqual([
      { ...B, state: "ready" },
      reauth(A),
    ]);
    expect((await browser.switchTo(B.id)).status).toBe(200);
    expect(browser.saved()).toEqual([C.id, A.id]);
    expect((await listed())?.others).toEqual([
      { ...C, state: "ready" },
      reauth(A),
    ]);
  });
});

describe("removing accounts and signing every account out", () => {
  const holdThree = async () => {
    signedInAsA();
    backend.sessions.set(tokenB, B);
    backend.sessions.set(tokenC, C);
    browser.hold([B, tokenB], [C, tokenC]);
  };

  it("signs a removed account out on the Backend, naming that account", async () => {
    await holdThree();
    const removed = await browser.auth("accounts/remove", { accountId: B.id });
    expect(removed.status).toBe(204);
    expect(backend.sessions.has(tokenB)).toBe(false);
    const signOut = backend.callsTo("/v1/community/auth/sign-out")[0]!;
    const headers = new Headers(signOut[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${tokenB}`);
    expect(headers.get("x-author-account")).toBe(B.id);
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([C.id]);
    const again = await browser.auth("accounts/remove", { accountId: B.id });
    expect(again.status).toBe(404);
    expect(parseCommunityAccountRefusal(await json(again))).toEqual({
      reason: "account_not_found",
    });
  });

  it("just drops an account whose session is already refused, and keeps one whose sign-out is unconfirmed", async () => {
    await holdThree();
    backend.sessions.delete(tokenB);
    expect(
      (await browser.auth("accounts/remove", { accountId: B.id })).status,
    ).toBe(204);
    expect(browser.saved()).toEqual([C.id]);
    backend.signOutFails.add(tokenC);
    const failed = await browser.auth("accounts/remove", { accountId: C.id });
    expect(failed.status).toBe(503);
    expect(parseCommunityAccountRefusal(await json(failed))).toEqual({
      reason: "unavailable",
    });
    expect(browser.saved()).toEqual([C.id]);
  });

  it("removes every saved session of the account, keeping only an unconfirmed one", async () => {
    signedInAsA();
    const olderB = "F".repeat(43);
    backend.sessions.set(tokenB, B);
    backend.sessions.set(olderB, B);
    browser.hold([B, tokenB], [C, tokenC], [B, olderB]);
    backend.signOutFails.add(olderB);
    const partial = await browser.auth("accounts/remove", { accountId: B.id });
    expect(partial.status).toBe(503);
    expect(backend.sessions.has(tokenB)).toBe(false);
    expect(browser.savedEntries().map((entry) => entry.token)).toEqual([
      tokenC,
      olderB,
    ]);
    backend.signOutFails.delete(olderB);
    expect(
      (await browser.auth("accounts/remove", { accountId: B.id })).status,
    ).toBe(204);
    expect(browser.saved()).toEqual([C.id]);
  });

  it("refuses a malformed remove request and a GET before reaching the Backend", async () => {
    await holdThree();
    for (const body of [{}, { accountId: "user-x" }, { accountId: B.id, x: 1 }])
      expect((await browser.auth("accounts/remove", body)).status).toBe(422);
    expect(
      (
        await relayServerCommunityAuth(
          new Request(`${origin}/api/community/auth/accounts/sign-out-all`, {
            headers: { host, cookie: browser.cookie },
          }),
        )
      ).status,
    ).toBe(405);
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it("signs every held account out and clears both cookies", async () => {
    await holdThree();
    const all = await browser.auth("accounts/sign-out-all", {});
    expect(all.status).toBe(204);
    expect(backend.sessions.size).toBe(0);
    expect(browser.jar.size).toBe(0);
    expect(await listed()).toEqual({ current: null, others: [], limit: 3 });
  });

  it("signs out sessions past their ceiling too, instead of dropping them", async () => {
    signedInAsA();
    backend.sessions.set(tokenB, B);
    browser.hold([B, tokenB, Date.now() - 1]);
    expect((await browser.auth("accounts/sign-out-all", {})).status).toBe(204);
    expect(backend.sessions.has(tokenB)).toBe(false);
  });

  it("keeps exactly the sessions whose sign-out could not be confirmed", async () => {
    await holdThree();
    backend.signOutFails.add(tokenC);
    backend.sessions.delete(tokenB);
    const partial = await browser.auth("accounts/sign-out-all", {});
    expect(partial.status).toBe(503);
    expect(partial.headers.get("cache-control")).toBe("private, no-store");
    // The answer says the current session ended and names (never with its
    // session) the account still held, so the page needs no second read.
    const body = await json(partial);
    expect(body).toEqual({
      reason: "unavailable",
      currentCleared: true,
      remaining: [{ id: C.id, handle: C.handle }],
    });
    expect(parseCommunitySignOutAllPartial(body)).toEqual(body);
    expect(parseCommunityAccountRefusal(body)).toEqual({
      reason: "unavailable",
    });
    expect(browser.active()).toBeUndefined();
    expect(browser.saved()).toEqual([C.id]);
    backend.signOutFails.delete(tokenC);
    expect((await browser.auth("accounts/sign-out-all", {})).status).toBe(204);
    expect(browser.jar.size).toBe(0);
  });

  it("says when the current session could not be signed out and stays current", async () => {
    await holdThree();
    backend.signOutFails.add(tokenA);
    const partial = await browser.auth("accounts/sign-out-all", {});
    expect(partial.status).toBe(503);
    expect(await json(partial)).toEqual({
      reason: "unavailable",
      currentCleared: false,
      remaining: [],
    });
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([]);
    expect(backend.sessions.has(tokenB)).toBe(false);
    expect(backend.sessions.has(tokenC)).toBe(false);
    // Both at once: the current session and another account are still held.
    backend.sessions.set(tokenB, B);
    browser.hold([B, tokenB]);
    backend.signOutFails.add(tokenB);
    expect(await json(await browser.auth("accounts/sign-out-all", {}))).toEqual(
      {
        reason: "unavailable",
        currentCleared: false,
        remaining: [{ id: B.id, handle: B.handle }],
      },
    );
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([B.id]);
  });

  it("counts a browser with no current session as cleared", async () => {
    backend.sessions.set(tokenB, B);
    browser.hold([B, tokenB]);
    backend.signOutFails.add(tokenB);
    expect(await json(await browser.auth("accounts/sign-out-all", {}))).toEqual(
      {
        reason: "unavailable",
        currentCleared: true,
        remaining: [{ id: B.id, handle: B.handle }],
      },
    );
    expect(browser.saved()).toEqual([B.id]);
  });

  it("carries the trusted authentication source to every Backend sign-out in Production", async () => {
    const ingress =
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    const relay =
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_INGRESS_TOKEN", ingress);
    vi.stubEnv("AUTH_SOURCE_RELAY_TOKEN", relay);
    await holdThree();
    expect((await browser.auth("accounts/sign-out-all", {})).status).toBe(403);
    expect(backend.fetch).not.toHaveBeenCalled();
    const all = await browser.auth(
      "accounts/sign-out-all",
      {},
      { "x-moya-auth-ingress": ingress, "x-moya-client-ip": "192.0.2.7" },
    );
    expect(all.status).toBe(204);
    const signOuts = backend.callsTo("/v1/community/auth/sign-out");
    expect(signOuts).toHaveLength(3);
    for (const [, init] of signOuts) {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-moya-auth-relay")).toBe(relay);
      expect(headers.get("x-moya-auth-source")).toBe("192.0.2.7");
    }
  });
});

describe("answer parsers", () => {
  const others = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      reauth(account(index.toString(16), `held-${index}`, "")),
    );

  it("accept every account the saved list can hold, and no more", () => {
    // More than two other accounts only when a session could not be signed
    // out and is kept rather than lost.
    expect(
      parseCommunityAccountsView({ current: A, others: others(6), limit: 3 })
        ?.others,
    ).toHaveLength(6);
    expect(
      parseCommunityAccountsView({ current: A, others: others(7), limit: 3 }),
    ).toBeNull();
    const remaining = (count: number) =>
      others(count).map(({ id, handle }) => ({ id, handle }));
    expect(
      parseCommunitySignOutAllPartial({
        reason: "unavailable",
        currentCleared: true,
        remaining: remaining(6),
      })?.remaining,
    ).toHaveLength(6);
    expect(
      parseCommunitySignOutAllPartial({
        reason: "unavailable",
        currentCleared: true,
        remaining: remaining(7),
      }),
    ).toBeNull();
  });
});
