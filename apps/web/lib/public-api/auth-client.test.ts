import { afterEach, describe, expect, it, vi } from "vitest";

import { authRequest, requestAccountDeletion } from "./auth-client";

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

  it("runs add-account, sign-in, factor-change and sign-out steps under the account cookie lock", async () => {
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
    await authRequest("account");
    await authRequest("challenges", { body: { purpose: "link" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    const adding = authRequest("challenges/verify", {
      body: {},
      addAccount: true,
    });
    const signingIn = authRequest("passwords/login", { body: {} });
    // A factor change reissues the session, so it writes the cookies too.
    const linking = authRequest("factors/complete", { body: {} });
    const unlinking = authRequest("factors/unlink", { body: {} });
    const signingOut = authRequest("sign-out", { method: "POST", body: {} });
    await settle();
    const sentWhileHeld = fetch.mock.calls.length;
    // Released before asserting, so a failure here never strands the lock.
    release();
    await held;
    expect(sentWhileHeld).toBe(3);
    for (const step of [adding, signingIn, linking, unlinking, signingOut])
      await expect(step).resolves.toEqual({ status: 200, body: {} });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(
      fetch.mock.calls
        .slice(3)
        .map((call) => (call as unknown as [string])[0])
        .sort(),
    ).toEqual(
      [
        "challenges/verify",
        "factors/complete",
        "factors/unlink",
        "passwords/login",
        "sign-out",
      ].map((step) => `/api/community/auth/${step}`),
    );
  });

  it("runs an account deletion under the account cookie lock", async () => {
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
    const proof = "R".repeat(43);
    const deleting = requestAccountDeletion(`user-${"a".repeat(32)}`, {
      reauthToken: proof,
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });
    await new Promise((done) => setTimeout(done, 10));
    const sentWhileHeld = fetch.mock.calls.length;
    // Released before asserting, so a failure here never strands the lock.
    release();
    await held;
    expect(sentWhileHeld).toBe(0);
    await expect(deleting).resolves.toEqual({ status: 200, body: {} });
    expect(fetch).toHaveBeenCalledOnce();
    expect(headersOf(fetch)).toEqual(
      expect.objectContaining({ "x-author-account": `user-${"a".repeat(32)}` }),
    );
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
