import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchServerCatalogDetail,
  fetchServerCatalogPage,
  parsePublicApiBaseUrl,
  relayServerAuthorCommunity,
  relayServerCommunityAuth,
  relayServerLocalEditorialMedia,
} from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Public API server wiring", () => {
  it("accepts the browser Host when Next normalizes its internal development URL", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ saved: true }));
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      new Request("http://localhost:3410/api/community/favorites/merge", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3410",
          origin: "http://127.0.0.1:3410",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it.each(["https://foreign.invalid", "null", "http://127.0.0.1:3410/path"])(
    "rejects foreign or malformed mutation origin %s even with a forwarded host",
    async (origin) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await relayServerAuthorCommunity(
        new Request("http://localhost:3410/api/community/favorites/merge", {
          method: "POST",
          headers: {
            host: "127.0.0.1:3410",
            origin,
            "x-forwarded-host": "foreign.invalid",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    "",
    " https://api.example.invalid",
    "relative/path",
    "ftp://api.example.invalid",
    "https://synthetic:placeholder@api.example.invalid",
    "https://api.example.invalid?tenant=one",
    "https://api.example.invalid#catalog",
  ])("rejects invalid base URL configuration: %s", (value) => {
    expect(() => parsePublicApiBaseUrl(value)).toThrow();
  });

  it("normalizes a root base URL", () => {
    expect(parsePublicApiBaseUrl("http://127.0.0.1:3001").toString()).toBe(
      "http://127.0.0.1:3001/",
    );
  });

  it("preserves and normalizes a fixed gateway path prefix", () => {
    expect(
      parsePublicApiBaseUrl("https://web.example.invalid/api//").toString(),
    ).toBe("https://web.example.invalid/api/");
  });

  it("does not fetch when server configuration is missing", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerCatalogPage()).resolves.toEqual({
      state: "unexpected-error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch Detail when server configuration is missing", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerCatalogDetail("catalog-001")).resolves.toEqual({
      state: "unexpected-error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supplies the validated server base URL and fetch implementation", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "https://web.example.invalid/api");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerCatalogPage()).resolves.toMatchObject({
      state: "success",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://web.example.invalid/api/v1/catalog",
      expect.any(Object),
    );
  });

  it("forwards Detail through the same server-only base URL boundary", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "https://web.example.invalid/api");
    const detail = {
      id: "catalog-001",
      kind: "inscription",
      title: "真实碑刻",
      aliases: [],
      sourceCitations: [],
      media: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(detail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchServerCatalogDetail(detail.id)).resolves.toEqual({
      state: "success",
      detail,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://web.example.invalid/api/v1/catalog/catalog-001",
      expect.any(Object),
    );
  });
});

/*
 * email-auth-v1: a Session the Backend no longer accepts (logged out or
 * factor-replaced on another device, expired, unknown) must not keep the
 * browser from public community reads through the same-origin relay.
 */
describe("Community relay with a Session the Backend no longer accepts", () => {
  const cookie = `yoyi-session=${"B".repeat(43)}`;
  const refused = () =>
    Response.json(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "A valid session is required",
        },
      },
      { status: 401 },
    );
  const read = (path: string) =>
    new Request(`http://127.0.0.1:3410/api/community/${path}`, {
      headers: { host: "127.0.0.1:3410", cookie },
    });
  const authorizationOf = (call: Parameters<typeof fetch>) =>
    new Headers(call[1]?.headers).get("authorization");

  it("clears the cookie and answers a read as for a signed-out browser once `me` refuses the Session", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      read("editorial/articles?page=1&pageSize=12&presentation=news"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(String(upstream.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3411/v1/me",
    );
    expect(authorizationOf(upstream.mock.calls[0]!)).toBe(
      `Bearer ${"B".repeat(43)}`,
    );
    expect(authorizationOf(upstream.mock.calls[2]!)).toBeNull();
    expect(String(upstream.mock.calls[2]![0])).toBe(
      "http://127.0.0.1:3411/v1/community/editorial/articles?page=1&pageSize=12&presentation=news",
    );
  });

  it("clears the cookie of a refused write but never repeats the write", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused());
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      new Request("http://127.0.0.1:3410/api/community/favorites/merge", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3410",
          origin: "http://127.0.0.1:3410",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          cookie,
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3411/v1/me",
    );
  });

  it("keeps a Session the Backend still accepts: a refusal for another reason passes through untouched", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ id: `user-${"1".repeat(32)}` }));
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(read("notifications"));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3411/v1/me",
    );
  });

  it.each([404, 503])(
    "keeps the cookie when the Session check answers %s instead of refusing it",
    async (status) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(refused())
        .mockResolvedValueOnce(new Response(null, { status }));
      vi.stubGlobal("fetch", upstream);
      const response = await relayServerAuthorCommunity(read("threads"));
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it("never asks `me` when no Session was presented", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi.fn<typeof fetch>().mockResolvedValueOnce(refused());
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      new Request("http://127.0.0.1:3410/api/community/notifications", {
        headers: { host: "127.0.0.1:3410" },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledOnce();
  });
});

/*
 * parallel-community-integration-qa: N binds GET notifications to the UI's
 * confirmed account (x-author-account); A clears a Session the Backend
 * refuses. Together a still-valid Session behind a stale account header keeps
 * its cookie, and a refused one is answered once as signed out.
 */
describe("Combined relay: notifications account binding next to a refused Session", () => {
  const cookie = `yoyi-session=${"D".repeat(43)}`;
  const account = `user-${"2".repeat(32)}`;
  const refused = () =>
    Response.json(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "A valid session is required",
        },
      },
      { status: 401 },
    );
  const inbox = () =>
    new Request("http://127.0.0.1:3410/api/community/notifications", {
      headers: { host: "127.0.0.1:3410", cookie, "x-author-account": account },
    });
  const headerOf = (call: Parameters<typeof fetch>, name: string) =>
    new Headers(call[1]?.headers).get(name);

  it("keeps a still-valid Session whose account header no longer matches", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ id: `user-${"3".repeat(32)}` }));
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(inbox());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(headerOf(upstream.mock.calls[0]!, "x-author-account")).toBe(account);
    expect(String(upstream.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3411/v1/me",
    );
  });

  it("answers a refused Session once as signed out, still bound to the confirmed account", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused());
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(inbox());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(headerOf(upstream.mock.calls[2]!, "authorization")).toBeNull();
    expect(headerOf(upstream.mock.calls[2]!, "x-author-account")).toBe(account);
  });
});

/* content-community-completion-v1: Development editorial images for a phone on the LAN. */

const file = `${"c".repeat(64)}-${"d".repeat(64)}.png`;
const other = `${"e".repeat(64)}-${"f".repeat(64)}.png`;
const article = `article-${"1".repeat(32)}`;
const collection = `collection-${"2".repeat(32)}`;
const local = (name: string) => `http://127.0.0.1:3522/api/media/file/${name}`;
const detail = (src: string) =>
  Response.json({
    id: article,
    cover: { src: local(other), alt: "封面" },
    sections: [{ image: { src, alt: "插图" } }],
  });
const png = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "content-type": "image/png" },
  });

describe("relayServerLocalEditorialMedia (Development)", () => {
  it("serves an image the published Article shows, read anonymously from its loopback URL", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(detail(local(file)))
      .mockResolvedValueOnce(png());
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerLocalEditorialMedia(article, file);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(String(upstream.mock.calls[0]![0])).toBe(
      `http://127.0.0.1:3521/v1/community/editorial/articles/${article}`,
    );
    expect(String(upstream.mock.calls[1]![0])).toBe(local(file));
    for (const call of upstream.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
  });

  it("looks a Collection image up in the published Collection", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: collection, cover: { src: local(file), alt: "" } }),
      )
      .mockResolvedValueOnce(png());
    vi.stubGlobal("fetch", upstream);
    expect(
      (await relayServerLocalEditorialMedia(collection, file)).status,
    ).toBe(200);
    expect(String(upstream.mock.calls[0]![0])).toBe(
      `http://127.0.0.1:3521/v1/community/editorial/collections/${collection}`,
    );
  });

  it("never serves a file the published item does not show", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(detail(local(other)));
    vi.stubGlobal("fetch", upstream);
    expect((await relayServerLocalEditorialMedia(article, file)).status).toBe(
      404,
    );
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("answers 404 when the item is not published", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );
    expect((await relayServerLocalEditorialMedia(article, file)).status).toBe(
      404,
    );
  });

  it("only reads a loopback file the detail names, never a foreign source", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        detail(`https://cdn.example.invalid/api/media/file/${file}`),
      );
    vi.stubGlobal("fetch", upstream);
    expect((await relayServerLocalEditorialMedia(article, file)).status).toBe(
      404,
    );
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    ["user-" + "1".repeat(32), file],
    [article, "x.png"],
    [article, `${"c".repeat(64)}-${"d".repeat(64)}.gif`],
    ["../article", file],
  ])(
    "refuses owner %s / file %s without reading anything",
    async (owner, name) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      expect((await relayServerLocalEditorialMedia(owner, name)).status).toBe(
        404,
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for a file Payload refuses and 502 for another type", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(detail(local(file)))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(detail(local(file)))
        .mockResolvedValueOnce(
          new Response("<html>", { headers: { "content-type": "text/html" } }),
        ),
    );
    expect((await relayServerLocalEditorialMedia(article, file)).status).toBe(
      404,
    );
    expect((await relayServerLocalEditorialMedia(article, file)).status).toBe(
      502,
    );
  });
});

describe("Article authoring relay preserves existing Work boundaries", () => {
  const account = `user-${"7".repeat(32)}`;
  const write = (path: string, body: string, method = "PUT") =>
    new Request(`http://localhost:3410/api/community/${path}`, {
      method,
      headers: {
        host: "localhost:3410",
        origin: "http://localhost:3410",
        "content-type": "application/json",
        "x-author-account": account,
      },
      body,
    });
  it("forwards PUT and a document above the ordinary Work cap through the bounded Article namespace", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ saved: true }));
    vi.stubGlobal("fetch", upstream);
    expect(
      (
        await relayServerAuthorCommunity(
          write(
            `article-authoring/article-${"1".repeat(32)}`,
            "x".repeat(110000),
          ),
        )
      ).status,
    ).toBe(200);
    expect(upstream.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).get("x-author-account"),
    ).toBe(account);
    expect(
      (await relayServerAuthorCommunity(write("works/example", "{}"))).status,
    ).toBe(405);
    expect(
      (
        await relayServerAuthorCommunity(
          write("works", "x".repeat(110000), "POST"),
        )
      ).status,
    ).toBe(413);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("forwards the current account fence on private GET and passes no-content revocation", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstream);
    await relayServerAuthorCommunity(
      new Request(
        "http://localhost:3410/api/community/article-authoring/connections",
        { headers: { "x-author-account": account } },
      ),
    );
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).get("x-author-account"),
    ).toBe(account);
    const revoked = await relayServerAuthorCommunity(
      write("article-authoring/connections/example/revoke", "{}", "POST"),
    );
    expect(revoked.status).toBe(204);
    expect(await revoked.text()).toBe("");
    expect(revoked.headers.get("cache-control")).toContain("no-store");
  });
  it("refuses an over-limit streamed Article body before contacting Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(
      (
        await relayServerAuthorCommunity(
          write("article-authoring/example", "x".repeat(1048576 + 16385)),
        )
      ).status,
    ).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Password reset and stale authentication cookie recovery", () => {
  // Reviewed synthetic fixtures only; no real Session or password is used.
  const request = (suffix: string) =>
    new Request(`http://127.0.0.1:3410/api/community/auth/${suffix}`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3410",
        origin: "http://127.0.0.1:3410",
        cookie: `yoyi-session=${"S".repeat(43)}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  it("clears the signed browser cookie after successful reset without creating a Session", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ reset: true }));
    vi.stubGlobal("fetch", fetcher);
    const result = await relayServerCommunityAuth(request("passwords/reset"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ reset: true });
    expect(result.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("clears a refused stale cookie once without replaying the challenge POST", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: { code: "SESSION_INVALID", message: "AUTH_UNAUTHENTICATED" },
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await relayServerCommunityAuth(request("challenges"));
    expect(result.status).toBe(401);
    expect(result.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).pathname).toBe("/v1/me");
  });
  it("keeps the cookie when the identity check is unavailable", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: { code: "SESSION_INVALID", message: "AUTH_UNAUTHENTICATED" },
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await relayServerCommunityAuth(request("challenges"));
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });
});
