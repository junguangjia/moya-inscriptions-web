import { afterEach, describe, expect, it, vi } from "vitest";

import { relayServerCommunityAuth } from "./server.js";

// account-deletion-v1. Reviewed synthetic fixtures only: no real Session,
// account or Backend is used.
const account = `user-${"a".repeat(32)}`;
const sessionToken = "SYNTHETIC_DELETION_SESSION".padEnd(43, "_");
const appealToken = "SYNTHETIC_APPEAL_SESSION".padEnd(43, "_");
const body = JSON.stringify({
  reauthToken: "r".repeat(43),
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
});
const result = { outcome: "deleted", deletedAt: "2026-10-27T01:00:00.000Z" };

const deletionRequest = (
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    omitAccount?: boolean;
  } = {},
) =>
  new Request("http://127.0.0.1:3410/api/community/auth/account/deletion", {
    method: init.method ?? "POST",
    headers: {
      host: "127.0.0.1:3410",
      origin: "http://127.0.0.1:3410",
      "sec-fetch-site": "same-origin",
      cookie: `yoyi-session=${sessionToken}; yoyi-appeal-session=${appealToken}`,
      "content-type": "application/json",
      ...(init.omitAccount ? {} : { "x-author-account": account }),
      ...init.headers,
    },
    ...((init.method ?? "POST") === "POST" ? { body } : {}),
  });

const stubUpstream = (...responses: Response[]) => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
  const upstream = vi.fn<typeof fetch>();
  for (const response of responses) upstream.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", upstream);
  return upstream;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("account deletion relay", () => {
  it("forwards the Session, the confirmed account and the body, then clears both Session cookies on success", async () => {
    const upstream = stubUpstream(Response.json(result));

    const response = await relayServerCommunityAuth(deletionRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^yoyi-session=; .*Max-Age=0/u);
    expect(cookies[1]).toMatch(/^yoyi-appeal-session=; .*Max-Age=0/u);
    expect(cookies.join("\n")).not.toContain(sessionToken);
    expect(upstream).toHaveBeenCalledOnce();
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      "http://127.0.0.1:3411/v1/community/auth/account/deletion",
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        body,
        headers: expect.objectContaining({
          authorization: `Bearer ${sessionToken}`,
          "x-author-account": account,
        }),
      }),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed", "user-ABC"],
    ["another identifier kind", `work-${"a".repeat(32)}`],
  ])(
    "refuses a %s account header before the Backend is called",
    async (_label, header) => {
      const upstream = stubUpstream();
      const response = await relayServerCommunityAuth(
        deletionRequest(
          header === undefined
            ? { omitAccount: true }
            : { headers: { "x-author-account": header } },
        ),
      );
      expect(response.status).toBe(422);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("accepts deletion only as a same-origin POST", async () => {
    const upstream = stubUpstream();
    const read = await relayServerCommunityAuth(
      deletionRequest({ method: "GET" }),
    );
    const foreign = await relayServerCommunityAuth(
      deletionRequest({
        headers: {
          origin: "https://foreign.invalid",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    expect(read.status).toBe(405);
    expect(foreign.status).toBe(403);
    expect(read.headers.get("set-cookie")).toBeNull();
    expect(foreign.headers.get("set-cookie")).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [400, "AUTH_PROOF_REJECTED"],
    [403, "AUTH_ACCOUNT_SUSPENDED"],
    [503, "AUTH_CHANNEL_UNAVAILABLE"],
  ])(
    "keeps every cookie and forwards the refusal when the Backend answers %i",
    async (status, reason) => {
      const refusal = { error: { code: "REFUSED", message: reason } };
      stubUpstream(Response.json(refusal, { status }));
      const response = await relayServerCommunityAuth(deletionRequest());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(refusal);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("keeps the cookie when a 401 names an account mismatch but the Session is still accepted", async () => {
    const upstream = stubUpstream(
      Response.json(
        { error: { code: "UNAUTHENTICATED", message: "AUTH_UNAUTHENTICATED" } },
        { status: 401 },
      ),
      Response.json({ id: `user-${"b".repeat(32)}` }),
    );
    const response = await relayServerCommunityAuth(deletionRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(new URL(String(upstream.mock.calls[1]?.[0])).pathname).toBe(
      "/v1/me",
    );
    expect(
      upstream.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each([
    [
      "a body outside the contract",
      () => Response.json({ outcome: "deleted" }),
    ],
    [
      "a body cut off after the commit",
      () =>
        new Response('{"outcome":"del', {
          headers: { "content-type": "application/json" },
        }),
    ],
    ["a body that is not JSON", () => new Response("deleted")],
  ])(
    "keeps both cookies and reports no success for a 200 with %s",
    async (_label, answer) => {
      stubUpstream(answer());
      const response = await relayServerCommunityAuth(deletionRequest());
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("");
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("lets the same-key retry after an unusable 200 present the Session and clear it on the replayed answer", async () => {
    const upstream = stubUpstream(
      Response.json({ outcome: "deleted" }),
      Response.json(result),
    );
    const first = await relayServerCommunityAuth(deletionRequest());
    expect(first.status).toBe(502);
    expect(first.headers.get("set-cookie")).toBeNull();
    // The browser still holds the (now revoked) Session: the retry carries it.
    const retry = await relayServerCommunityAuth(deletionRequest());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect(retry.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^yoyi-session=; .*Max-Age=0/u),
      expect.stringMatching(/^yoyi-appeal-session=; .*Max-Age=0/u),
    ]);
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const [, init] of upstream.mock.calls)
      expect(init).toEqual(
        expect.objectContaining({
          body,
          headers: expect.objectContaining({
            authorization: `Bearer ${sessionToken}`,
          }),
        }),
      );
  });

  it("answers 503 without touching a cookie when the Backend is unreachable", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    const response = await relayServerCommunityAuth(deletionRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still clears only the appeal cookie on appeal sign-out", async () => {
    stubUpstream(new Response(null, { status: 204 }));
    const response = await relayServerCommunityAuth(
      new Request("http://127.0.0.1:3410/api/community/auth/appeals/sign-out", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3410",
          origin: "http://127.0.0.1:3410",
          cookie: `yoyi-appeal-session=${appealToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^yoyi-appeal-session=; .*Max-Age=0/u),
    ]);
  });
});
