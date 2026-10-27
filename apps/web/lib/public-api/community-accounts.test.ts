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
      if (token !== undefined && this.signOutFails.has(token))
        return new Response(null, { status: 503 });
      const profile =
        token === undefined ? undefined : this.sessions.get(token);
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
  saved() {
    return readSavedSessions(this.cookie, Date.now()).entries.map(
      (entry) => entry.userId,
    );
  }
  active() {
    return this.jar.get("yoyi-session");
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
  list() {
    return relayServerCommunityAccounts(
      new Request(`${origin}/api/community/accounts`, {
        headers: { host, cookie: this.cookie },
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

    const listed = await browser.list();
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    expect(listed.headers.getSetCookie()).toEqual([]);
    expect(parseCommunityAccountsView(await json(listed))).toEqual({
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
    const listed = parseCommunityAccountsView(await json(await browser.list()));
    expect(listed).toEqual({
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
    // Only `me` checks of the current account were made.
    expect(
      backend.fetch.mock.calls
        .slice(before)
        .every(([input]) => new URL(String(input)).pathname === "/v1/me"),
    ).toBe(true);
    expect(backend.sessions.get(browser.active()!)).toEqual(C);
    expect(browser.saved()).toEqual([B.id, A.id]);
  });

  it("replaces a listed account's stored session instead of duplicating it, even with three held", async () => {
    signedInAsA();
    backend.grants.push(B, C);
    await browser.add("passwords/login", {});
    await browser.add("passwords/login", {});
    const oldB = [...backend.sessions].find(([, value]) => value === B)![0];
    backend.grants.push(B);
    const readded = await browser.add("challenges/verify", {});
    expect(readded.status).toBe(200);
    expect(backend.sessions.get(browser.active()!)).toEqual(B);
    expect(browser.active()).not.toBe(oldB);
    expect(browser.saved()).toEqual([C.id, A.id]);
    // The replaced session was signed out on the Backend.
    expect(backend.sessions.has(oldB)).toBe(false);
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
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: null, others: [], limit: 3 });
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

  it("refuses a target whose session was refused, drops it and changes nothing else", async () => {
    await holdAandB();
    const current = browser.active();
    backend.sessions.delete(tokenA);
    const refused = await browser.switchTo(A.id);
    expect(refused.status).toBe(409);
    expect(parseCommunityAccountRefusal(await json(refused))).toEqual({
      reason: "reauth_required",
    });
    expect(browser.active()).toBe(current);
    expect(browser.saved()).toEqual([]);
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

  it("reports a refused saved account once as needing sign-in, then no longer holds it", async () => {
    await holdAandB();
    backend.sessions.delete(tokenA);
    const first = parseCommunityAccountsView(await json(await browser.list()));
    expect(first).toEqual({
      current: B,
      others: [
        {
          id: A.id,
          handle: A.handle,
          displayName: null,
          state: "reauth_required",
        },
      ],
      limit: 3,
    });
    expect(browser.saved()).toEqual([]);
    expect(
      parseCommunityAccountsView(await json(await browser.list()))?.others,
    ).toEqual([]);
  });

  const tokenA2 = "E".repeat(43);
  /** A is current with a newer session; an older copy of A is still saved. */
  const currentWithSavedCopy = (others = "") => {
    backend.sessions.set(tokenA2, A);
    browser.jar.set("yoyi-session", tokenA2);
    browser.jar.set(
      "yoyi-saved-sessions",
      `${A.id}.${A.handle}.${tokenA}.${Date.now() + 60_000}${others}`,
    );
  };

  it("never lists a saved copy of the current account, refused or not", async () => {
    // The Backend no longer accepts the copy: it is let go without a row.
    currentWithSavedCopy();
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: A, others: [], limit: 3 });
    expect(browser.saved()).toEqual([]);
    expect(backend.callsTo("/v1/community/auth/sign-out")).toEqual([]);
    // A copy the Backend still accepts is signed out as it is let go.
    backend.sessions.set(tokenA, A);
    currentWithSavedCopy();
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: A, others: [], limit: 3 });
    expect(browser.saved()).toEqual([]);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.active()).toBe(tokenA2);
    expect(backend.sessions.get(tokenA2)).toEqual(A);
  });

  it("never signs the current session out when a saved copy carries the same token", async () => {
    signedInAsA();
    browser.jar.set(
      "yoyi-saved-sessions",
      `${A.id}.${A.handle}.${tokenA}.${Date.now() + 60_000}`,
    );
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: A, others: [], limit: 3 });
    expect(backend.callsTo("/v1/community/auth/sign-out")).toEqual([]);
    expect(backend.sessions.get(tokenA)).toEqual(A);
    expect(browser.active()).toBe(tokenA);
    expect(browser.saved()).toEqual([]);
  });

  it("signs a saved copy out when a switch lets it go", async () => {
    backend.sessions.set(tokenB, B);
    currentWithSavedCopy(
      `~${B.id}.${B.handle}.${tokenB}.${Date.now() + 60_000}`,
    );
    backend.sessions.set(tokenA, A);
    // A repeated tap on the current account drops its copy.
    expect((await browser.switchTo(A.id)).status).toBe(200);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.active()).toBe(tokenA2);
    expect(browser.saved()).toEqual([B.id]);
    // Switching away replaces an older copy with the active session.
    backend.sessions.set(tokenA, A);
    currentWithSavedCopy(
      `~${B.id}.${B.handle}.${tokenB}.${Date.now() + 60_000}`,
    );
    expect((await browser.switchTo(B.id)).status).toBe(200);
    expect(backend.sessions.has(tokenA)).toBe(false);
    expect(browser.active()).toBe(tokenB);
    expect(browser.saved()).toEqual([A.id]);
    const saved = readSavedSessions(browser.cookie, Date.now()).entries;
    expect(saved.map((entry) => entry.token)).toEqual([tokenA2]);
  });

  it("clears a refused current session and still lists the others", async () => {
    await holdAandB();
    backend.sessions.delete(browser.active()!);
    const listed = parseCommunityAccountsView(await json(await browser.list()));
    expect(listed?.current).toBeNull();
    expect(listed?.others).toEqual([{ ...A, state: "ready" }]);
    expect(browser.active()).toBeUndefined();
  });

  it("clears a malformed saved list instead of trusting it", async () => {
    signedInAsA();
    browser.jar.set(
      "yoyi-saved-sessions",
      `user-${"b".repeat(32)}.x.${tokenB}`,
    );
    const listed = await browser.list();
    expect(parseCommunityAccountsView(await json(listed))?.others).toEqual([]);
    expect(browser.jar.has("yoyi-saved-sessions")).toBe(false);
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
  const lapsedA = {
    id: A.id,
    handle: A.handle,
    displayName: null,
    state: "reauth_required",
  };
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

  it("reports a lapsed account once while a newer account keeps the list alive", async () => {
    await holdAandB();
    vi.setSystemTime(start + 5 * day);
    backend.grants.push(C);
    await browser.add("passwords/login", {});
    expect(browser.saved()).toEqual([B.id, A.id]);
    // A's absolute session ended on the Backend after seven days.
    vi.setSystemTime(start + 8 * day);
    backend.sessions.delete(tokenA);
    backend.fetch.mockClear();
    const first = parseCommunityAccountsView(await json(await browser.list()));
    expect(first).toEqual({
      current: C,
      others: [{ ...B, state: "ready" }, lapsedA],
      limit: 3,
    });
    // Past its ceiling nothing needs to be asked about A.
    expect(meTokens()).not.toContain(`Bearer ${tokenA}`);
    expect(browser.saved()).toEqual([B.id]);
    expect(readSavedSessions(browser.cookie, Date.now()).lapsed).toEqual([]);
    expect(
      parseCommunityAccountsView(await json(await browser.list()))?.others,
    ).toEqual([{ ...B, state: "ready" }]);
  });

  it("keeps the list past its ceiling, so a lapsed account is still reported after signing in again", async () => {
    await holdAandB();
    vi.setSystemTime(start + day);
    await browser.auth("sign-out", {});
    backend.grants.push(B);
    await browser.auth("passwords/login", {});
    vi.setSystemTime(start + 8 * day);
    backend.sessions.delete(tokenA);
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: B, others: [lapsedA], limit: 3 });
    expect(browser.jar.has("yoyi-saved-sessions")).toBe(false);
  });

  it("refuses a lapsed target without asking the Backend and drops it", async () => {
    await holdAandB();
    const current = browser.active();
    vi.setSystemTime(start + 8 * day);
    backend.fetch.mockClear();
    const refused = await browser.switchTo(A.id);
    expect(refused.status).toBe(409);
    expect(parseCommunityAccountRefusal(await json(refused))).toEqual({
      reason: "reauth_required",
    });
    expect(meTokens()).not.toContain(`Bearer ${tokenA}`);
    expect(browser.active()).toBe(current);
    expect(browser.jar.has("yoyi-saved-sessions")).toBe(false);
  });

  it("keeps a lapsed entry through an addition, so it is still reported", async () => {
    await holdAandB();
    vi.setSystemTime(start + 8 * day);
    backend.grants.push(C);
    expect((await browser.add("passwords/login", {})).status).toBe(200);
    expect(browser.saved()).toEqual([B.id]);
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({
      current: C,
      others: [{ ...B, state: "ready" }, lapsedA],
      limit: 3,
    });
  });

  it("keeps a lapsed entry through a switch, so it is still reported", async () => {
    await holdAandB();
    vi.setSystemTime(start + day);
    backend.sessions.set(tokenC, C);
    browser.jar.set(
      "yoyi-saved-sessions",
      `${A.id}.${A.handle}.${tokenA}.${start + 7 * day}~${C.id}.${C.handle}.${tokenC}.${start + 20 * day}`,
    );
    vi.setSystemTime(start + 8 * day);
    expect((await browser.switchTo(C.id)).status).toBe(200);
    expect(
      readSavedSessions(browser.cookie, Date.now()).lapsed.map(
        (entry) => entry.userId,
      ),
    ).toEqual([A.id]);
    expect(
      parseCommunityAccountsView(await json(await browser.list()))?.others,
    ).toEqual([{ ...B, state: "ready" }, lapsedA]);
  });
});

describe("removing accounts and signing every account out", () => {
  const holdThree = async () => {
    signedInAsA();
    backend.sessions.set(tokenB, B);
    backend.sessions.set(tokenC, C);
    browser.jar.set(
      "yoyi-saved-sessions",
      `${B.id}.${B.handle}.${tokenB}.${Date.now() + 60_000}~${C.id}.${C.handle}.${tokenC}.${Date.now() + 60_000}`,
    );
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
    expect(
      parseCommunityAccountsView(await json(await browser.list())),
    ).toEqual({ current: null, others: [], limit: 3 });
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
    browser.jar.set(
      "yoyi-saved-sessions",
      `${B.id}.${B.handle}.${tokenB}.${Date.now() + 60_000}`,
    );
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
    browser.jar.set(
      "yoyi-saved-sessions",
      `${B.id}.${B.handle}.${tokenB}.${Date.now() + 60_000}`,
    );
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
