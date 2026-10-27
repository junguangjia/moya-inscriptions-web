import { afterEach, describe, expect, it, vi } from "vitest";

import {
  communityAccountsClient,
  exclusiveAccountRequest,
} from "./community-accounts-client";

// A value the client must never surface, standing in for a leaked token.
const leakedToken = "must-not-appear";

// account-switching-v1: synthetic accounts only; no session or Backend.
const current = {
  id: `user-${"a".repeat(32)}`,
  handle: "synthetic-current",
  displayName: "当前账户",
};
const other = {
  id: `user-${"b".repeat(32)}`,
  handle: "synthetic-other",
  displayName: "另一个账户",
};
const view = {
  current,
  others: [
    { ...other, state: "ready" },
    {
      id: `user-${"c".repeat(32)}`,
      handle: "synthetic-expired",
      displayName: null,
      state: "reauth_required",
    },
  ],
  limit: 3,
};
const refusal = (status: number, reason: string) =>
  Response.json({ reason }, { status });

const stub = (...responses: (Response | Error)[]) => {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(null, { status: 500 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const request = (fetch: ReturnType<typeof stub>, index = 0) =>
  fetch.mock.calls[index] as unknown as [string, RequestInit];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
/** Lets queued lock grants and fetch calls run. */
const settle = () => new Promise((done) => setTimeout(done, 10));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("community accounts client", () => {
  it("reads the held accounts and validates the answer", async () => {
    const fetch = stub(Response.json(view));
    await expect(communityAccountsClient.list()).resolves.toEqual({
      state: "ready",
      view,
    });
    const [path, init] = request(fetch);
    expect(path).toBe("/api/community/accounts");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("treats a malformed, refused or missing list as unavailable", async () => {
    stub(
      Response.json({ ...view, token: leakedToken }),
      refusal(503, "unavailable"),
      new TypeError("offline"),
    );
    for (let index = 0; index < 3; index++)
      await expect(communityAccountsClient.list()).resolves.toEqual({
        state: "unavailable",
      });
  });

  it("propagates an aborted list read", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(
      communityAccountsClient.list(controller.signal),
    ).rejects.toThrow("aborted");
  });

  it("switches with the account id only and reports each refusal", async () => {
    const fetch = stub(
      Response.json({ current: other }),
      refusal(409, "reauth_required"),
      refusal(404, "account_not_found"),
      refusal(503, "unavailable"),
      new Response(null, { status: 403 }),
      new TypeError("offline"),
    );
    await expect(communityAccountsClient.switchTo(other.id)).resolves.toEqual({
      state: "switched",
    });
    const [path, init] = request(fetch);
    expect(path).toBe("/api/community/accounts/switch");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ accountId: other.id }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    for (const reason of [
      "reauth_required",
      "account_not_found",
      "unavailable",
    ])
      await expect(communityAccountsClient.switchTo(other.id)).resolves.toEqual(
        { state: "refused", reason },
      );
    await expect(communityAccountsClient.switchTo(other.id)).resolves.toEqual({
      state: "failed",
    });
    await expect(communityAccountsClient.switchTo(other.id)).resolves.toEqual({
      state: "failed",
    });
  });

  it("treats any 200 as a completed switch, since its cookies already changed", async () => {
    stub(new Response("not json", { status: 200 }));
    await expect(communityAccountsClient.switchTo(other.id)).resolves.toEqual({
      state: "switched",
    });
  });

  it("removes one account through the auth relay", async () => {
    const fetch = stub(
      new Response(null, { status: 204 }),
      refusal(404, "account_not_found"),
      refusal(503, "unavailable"),
      new TypeError("offline"),
    );
    await expect(communityAccountsClient.remove(other.id)).resolves.toEqual({
      state: "removed",
    });
    const [path, init] = request(fetch);
    expect(path).toBe("/api/community/auth/accounts/remove");
    expect(init.body).toBe(JSON.stringify({ accountId: other.id }));
    await expect(communityAccountsClient.remove(other.id)).resolves.toEqual({
      state: "refused",
      reason: "account_not_found",
    });
    await expect(communityAccountsClient.remove(other.id)).resolves.toEqual({
      state: "refused",
      reason: "unavailable",
    });
    await expect(communityAccountsClient.remove(other.id)).resolves.toEqual({
      state: "failed",
    });
  });

  it("runs overlapping account requests one after the other, so their cookies never mix snapshots", async () => {
    // Node provides Web Locks, as browsers do.
    expect(typeof navigator.locks.request).toBe("function");
    const answers = [
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
    ];
    const fetch = vi.fn(() => answers[fetch.mock.calls.length - 1]!.promise);
    vi.stubGlobal("fetch", fetch);
    const listing = communityAccountsClient.list();
    const switching = communityAccountsClient.switchTo(other.id);
    const removing = communityAccountsClient.remove(other.id);
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    answers[0]!.resolve(Response.json(view));
    await expect(listing).resolves.toEqual({ state: "ready", view });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(request(fetch as never, 1)[0]).toBe(
      "/api/community/accounts/switch",
    );
    answers[1]!.resolve(Response.json({ current: other }));
    await expect(switching).resolves.toEqual({ state: "switched" });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    answers[2]!.resolve(new Response(null, { status: 204 }));
    await expect(removing).resolves.toEqual({ state: "removed" });
  });

  it("waits for another tab's account request and lets a closed page stop waiting", async () => {
    const held = deferred<void>();
    const otherTab = navigator.locks.request(
      "yoyi-community-accounts",
      () => held.promise,
    );
    const fetch = stub(new Response(null, { status: 204 }));
    const signingOut = communityAccountsClient.signOutAll();
    const controller = new AbortController();
    const listing = communityAccountsClient.list(controller.signal);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    controller.abort();
    await expect(listing).rejects.toThrow();
    held.resolve();
    await otherTab;
    await expect(signingOut).resolves.toEqual({ state: "signed-out" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("runs the request directly where Web Locks are missing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(exclusiveAccountRequest(async () => "ran")).resolves.toBe(
      "ran",
    );
  });

  it("signs every account out and reports a partial sign-out", async () => {
    const held = { id: other.id, handle: other.handle };
    const partial = (body: unknown) => Response.json(body, { status: 503 });
    const fetch = stub(
      new Response(null, { status: 204 }),
      partial({
        reason: "unavailable",
        currentCleared: true,
        remaining: [held],
      }),
      partial({ reason: "unavailable", currentCleared: false, remaining: [] }),
      refusal(503, "unavailable"),
      new Response(null, { status: 403 }),
    );
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "signed-out",
    });
    const [path, init] = request(fetch);
    expect(path).toBe("/api/community/auth/accounts/sign-out-all");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    // The answer itself says whether the current session ended and what is
    // still held.
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "partial",
      currentCleared: true,
      remaining: [held],
    });
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "partial",
      currentCleared: false,
      remaining: [],
    });
    // Without those details the outcome is unknown.
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "refused",
      reason: "unavailable",
    });
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "failed",
    });
  });

  it("never takes a malformed partial answer as what is held", async () => {
    const held = { id: other.id, handle: other.handle };
    const bodies = [
      // A token, or any other extra field.
      {
        reason: "unavailable",
        currentCleared: true,
        remaining: [{ ...held, token: leakedToken }],
      },
      {
        reason: "unavailable",
        currentCleared: true,
        remaining: [held],
        extra: 1,
      },
      { reason: "unavailable", currentCleared: "yes", remaining: [held] },
      { reason: "unavailable", currentCleared: true, remaining: [held, held] },
      {
        reason: "unavailable",
        currentCleared: true,
        remaining: [{ id: "user-x", handle: other.handle }],
      },
      // Nothing left to sign out is no partial result.
      { reason: "unavailable", currentCleared: true, remaining: [] },
    ];
    stub(...bodies.map((body) => Response.json(body, { status: 503 })));
    for (let index = 0; index < bodies.length; index++)
      await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
        state: "refused",
        reason: "unavailable",
      });
    // Only a 503 carries a partial result.
    stub(
      Response.json(
        { reason: "unavailable", currentCleared: true, remaining: [held] },
        { status: 500 },
      ),
    );
    await expect(communityAccountsClient.signOutAll()).resolves.toEqual({
      state: "refused",
      reason: "unavailable",
    });
  });
});
