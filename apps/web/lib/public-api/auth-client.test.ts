import { afterEach, describe, expect, it, vi } from "vitest";

import { authRequest } from "./auth-client";

const headersOf = (fetch: ReturnType<typeof vi.fn>) =>
  (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    .headers as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth relay request (account-switching-v1)", () => {
  it("sends no account headers unless asked", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await authRequest("passwords/login", { body: {} });
    expect(headersOf(fetch)).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
  });

  it("names the add-account mode on every step it is used for", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await authRequest("capabilities", { addAccount: true });
    expect(headersOf(fetch)).toEqual({
      accept: "application/json",
      "x-yoyi-account-intent": "add",
    });
    expect(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method,
    ).toBe("GET");
  });

  it("runs add-account, sign-in and sign-out steps under the account cookie lock", async () => {
    let release!: () => void;
    const held = navigator.locks.request(
      "yoyi-community-accounts",
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const settle = () => new Promise((done) => setTimeout(done, 10));
    // Reads and steps that never rewrite the session cookies do not wait.
    await authRequest("capabilities", { addAccount: true });
    await authRequest("challenges", { body: { purpose: "link" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    const adding = authRequest("challenges/verify", {
      body: {},
      addAccount: true,
    });
    const signingIn = authRequest("passwords/login", { body: {} });
    const signingOut = authRequest("sign-out", { method: "POST", body: {} });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    release();
    await held;
    await expect(adding).resolves.toEqual({ status: 200, body: {} });
    await expect(signingIn).resolves.toEqual({ status: 200, body: {} });
    await expect(signingOut).resolves.toEqual({ status: 200, body: {} });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("names the account a sign-out is meant for", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const account = `user-${"a".repeat(32)}`;
    await expect(
      authRequest("sign-out", { method: "POST", body: {}, account }),
    ).resolves.toEqual({ status: 204, body: null });
    expect(headersOf(fetch)).toMatchObject({ "x-author-account": account });
  });
});
