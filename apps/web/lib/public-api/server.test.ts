import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServerCatalogComment,
  fetchServerCatalogCommentPage,
  fetchServerCatalogDetail,
  fetchServerCatalogPage,
  fetchServerCatalogSearchPage,
  fetchServerProductAccess,
  parsePublicApiBaseUrl,
  relayServerLocalCatalogMedia,
  relayServerAuthorCommunity,
  relayServerCommunityAuth,
  relayServerDevelopmentCatalogRendition,
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
 * profile-media-startup-relief-v1: a user-media id names one immutable upload,
 * so its PNG may stay in the viewer's private cache, revalidated on each normal
 * load; back/forward may reuse it while the cookie is unchanged. The Backend
 * still authorizes each revalidation; only an unchanged body is skipped. Every
 * other answer keeps `private, no-store`.
 */
describe("Community relay revalidates immutable user media", () => {
  const cookie = `yoyi-session=${"C".repeat(43)}`;
  const mediaId = `user-media-${"a".repeat(32)}`;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const expectedTag = async () =>
    `"${Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", png)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}"`;
  const image = () =>
    new Response(png, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  const read = (path: string, extra: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1:3410/api/community/${path}`, {
      headers: { host: "127.0.0.1:3410", cookie, ...extra },
    });
  const upstreamOnce = (...answers: Response[]) => {
    const upstream = vi.fn<typeof fetch>();
    for (const answer of answers) upstream.mockResolvedValueOnce(answer);
    vi.stubGlobal("fetch", upstream);
    return upstream;
  };

  it("answers a 200 PNG with a strong ETag and private revalidation", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    upstreamOnce(image());
    const response = await relayServerAuthorCommunity(read(`media/${mediaId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toBe(await expectedTag());
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it.each([
    ["the exact tag", (tag: string) => tag],
    ["a tag in a list", (tag: string) => `"other", ${tag}`],
    ["the weak form", (tag: string) => `W/${tag}`],
    ["any representation", () => "*"],
  ])(
    "answers 304 without a body for %s, after the Backend authorized the read",
    async (_, header) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = upstreamOnce(image());
      const tag = await expectedTag();
      const response = await relayServerAuthorCommunity(
        read(`media/${mediaId}`, { "if-none-match": header(tag) }),
      );
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(upstream).toHaveBeenCalledOnce();
      // The validator stays in Web: the Backend always decides on a full read.
      const sent = new Headers(upstream.mock.calls[0]![1]?.headers);
      expect(sent.get("if-none-match")).toBeNull();
      expect(sent.get("authorization")).toBe(`Bearer ${"C".repeat(43)}`);
    },
  );

  it.each([
    ["another tag", () => `"${"0".repeat(64)}"`],
    ["a lowercase weak prefix", (tag: string) => `w/${tag}`],
    ["an unquoted tag", (tag: string) => tag.slice(1, -1)],
  ])("returns the body for %s", async (_, header) => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    upstreamOnce(image());
    const response = await relayServerAuthorCommunity(
      read(`media/${mediaId}`, {
        "if-none-match": header(await expectedTag()),
      }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("still refuses HEAD before asking the Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = upstreamOnce();
    const response = await relayServerAuthorCommunity(
      new Request(`http://127.0.0.1:3410/api/community/media/${mediaId}`, {
        method: "HEAD",
        headers: { host: "127.0.0.1:3410", cookie, "if-none-match": "*" },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing or no longer visible id", 404],
    ["a refused read", 403],
  ])("keeps %s uncacheable even with a stored tag", async (_, status) => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    upstreamOnce(Response.json({ error: { code: "NOT_FOUND" } }, { status }));
    const response = await relayServerAuthorCommunity(
      read(`media/${mediaId}`, { "if-none-match": "*" }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it.each([
    [
      "JSON reads",
      "editorial/articles?page=1&pageSize=12&presentation=news",
      () => Response.json({ items: [] }),
    ],
    ["a PNG outside user media", `works/${mediaId}`, image],
  ])("keeps %s private, no-store and untagged", async (_, path, answer) => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    upstreamOnce(answer());
    const response = await relayServerAuthorCommunity(
      read(path, { "if-none-match": "*" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("revalidates after a refused Session too, and still clears its cookie", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const refused = () =>
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    const upstream = upstreamOnce(refused(), refused(), image());
    const response = await relayServerAuthorCommunity(
      read(`media/${mediaId}`, { "if-none-match": await expectedTag() }),
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(
      new Headers(upstream.mock.calls[2]![1]?.headers).get("authorization"),
    ).toBeNull();
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

/* unified-media-pipeline-v1: Development Catalog renditions for a phone on the LAN. */

const renditionId = `media-rendition-${"9".repeat(32)}`;
const image = (type: string, size = 4) =>
  new Response(new Uint8Array(size), { headers: { "content-type": type } });

describe("relayServerDevelopmentCatalogRendition (Development)", () => {
  it.each(["image/webp", "image/jpeg"])(
    "serves a %s rendition read anonymously from the Backend Development route",
    async (type) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(image(type));
      vi.stubGlobal("fetch", upstream);
      const response =
        await relayServerDevelopmentCatalogRendition(renditionId);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await response.arrayBuffer()).byteLength).toBe(4);
      expect(String(upstream.mock.calls[0]![0])).toBe(
        `http://127.0.0.1:3521/v1/development/catalog-renditions/${renditionId}`,
      );
      const headers = new Headers(upstream.mock.calls[0]![1]?.headers);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(upstream.mock.calls[0]![1]?.redirect).toBe("error");
    },
  );

  it.each([
    `media-rendition-${"9".repeat(31)}`,
    `media-rendition-${"G".repeat(32)}`,
    `media-item-${"9".repeat(32)}`,
    `../media-rendition-${"9".repeat(32)}`,
    `media-rendition-${"9".repeat(32)}/extra`,
  ])("refuses %s without reading anything", async (id) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await relayServerDevelopmentCatalogRendition(id)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("passes only still WebP or JPEG bytes within the size bound", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(image("image/png"))
        .mockResolvedValueOnce(image("text/html"))
        .mockResolvedValueOnce(new Response(new Uint8Array(4)))
        .mockResolvedValueOnce(image("image/webp", 12 * 1024 * 1024 + 1)),
    );
    for (let attempt = 0; attempt < 4; attempt++)
      expect(
        (await relayServerDevelopmentCatalogRendition(renditionId)).status,
      ).toBe(502);
  });

  it("answers 404 for a rendition the Backend does not serve and 503 otherwise", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockRejectedValueOnce(new TypeError("unreachable")),
    );
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++)
      statuses.push(
        (await relayServerDevelopmentCatalogRendition(renditionId)).status,
      );
    expect(statuses).toEqual([404, 404, 503, 503]);
  });

  it("answers 503 without a configured Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(
      (await relayServerDevelopmentCatalogRendition(renditionId)).status,
    ).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("hands the visitor's session to the access gate and retries a refused session once without it", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3521");
    const current = "C".repeat(43);
    const stale = "S".repeat(43);
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(image("image/webp"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(image("image/jpeg"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", upstream);
    const authorization = (call: number) =>
      new Headers(upstream.mock.calls[call]![1]?.headers).get("authorization");

    expect(
      (await relayServerDevelopmentCatalogRendition(renditionId, current))
        .status,
    ).toBe(200);
    expect(authorization(0)).toBe(`Bearer ${current}`);

    // A session the Backend refuses must not block a read that needs none.
    const retried = await relayServerDevelopmentCatalogRendition(
      renditionId,
      stale,
    );
    expect(retried.status).toBe(200);
    expect(retried.headers.get("content-type")).toBe("image/jpeg");
    expect(authorization(1)).toBe(`Bearer ${stale}`);
    expect(authorization(2)).toBeNull();

    // A closed beta refuses the signed-out read as well; that answer stands
    // and is reported as the gate's 401, not hidden as unavailable.
    expect(
      (await relayServerDevelopmentCatalogRendition(renditionId, stale)).status,
    ).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(5);
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
  it("forwards the invitation registration challenge in the request body without adding it to a URL or cookie", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ accepted: true }));
    vi.stubGlobal("fetch", fetcher);
    const syntheticInvitation = "j".repeat(22);
    const payload = {
      channel: "email",
      purpose: "register",
      identifier: "tester@example.com",
      invitationCode: syntheticInvitation,
      idempotencyKey: "synthetic-invite-registration",
    };
    const response = await relayServerCommunityAuth(
      new Request("http://127.0.0.1:3410/api/community/auth/challenges", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3410",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      payload,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(
      syntheticInvitation,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
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

describe.each(["development", "production"] as const)(
  "Community sign-out relay in %s",
  (environment) => {
    const sessionToken = "SYNTHETIC_SIGNOUT_SESSION_TOKEN".padEnd(43, "_");
    const signOutRequest = (
      method: "GET" | "POST",
      requestHeaders: Record<string, string>,
    ) =>
      new Request("http://127.0.0.1:3410/api/community/auth/sign-out", {
        method,
        headers: {
          host: "127.0.0.1:3410",
          cookie: `yoyi-session=${sessionToken}`,
          ...requestHeaders,
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });

    it.each([undefined, "https://foreign.invalid"])(
      "rejects cross-site GET with origin %s before forwarding or changing the cookie",
      async (origin) => {
        vi.stubEnv("NODE_ENV", environment);
        vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
        const upstream = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 400 }));
        vi.stubGlobal("fetch", upstream);

        const response = await relayServerCommunityAuth(
          signOutRequest("GET", {
            "sec-fetch-site": "cross-site",
            ...(origin === undefined ? {} : { origin }),
          }),
        );

        expect(response.status).toBe(405);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(upstream).not.toHaveBeenCalled();
      },
    );

    it("rejects cross-site POST before forwarding or changing the cookie", async () => {
      vi.stubEnv("NODE_ENV", environment);
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);

      const response = await relayServerCommunityAuth(
        signOutRequest("POST", {
          origin: "https://foreign.invalid",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(upstream).not.toHaveBeenCalled();
    });

    it("forwards same-origin POST to the real logout API and clears the cookie", async () => {
      const ingress =
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "");
      vi.stubEnv("AUTH_INGRESS_TOKEN", ingress);
      vi.stubEnv(
        "AUTH_SOURCE_RELAY_TOKEN",
        crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", ""),
      );
      vi.stubEnv("NODE_ENV", environment);
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", upstream);

      const response = await relayServerCommunityAuth(
        signOutRequest("POST", {
          origin: "http://127.0.0.1:3410",
          "sec-fetch-site": "same-origin",
          "x-moya-auth-ingress": ingress,
          "x-moya-client-ip": "192.0.2.9",
          "content-type": "application/json",
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(upstream).toHaveBeenCalledOnce();
      expect(String(upstream.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3411/v1/community/auth/sign-out",
      );
      expect(upstream.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: "{}",
          headers: expect.objectContaining({
            authorization: `Bearer ${sessionToken}`,
          }),
        }),
      );
    });
  },
);

/*
 * closed-beta-access-v1: the Backend decides product access on every request,
 * so each content read Web makes for a visitor carries that visitor's session,
 * is never stored, and reports the Backend's refusal as a refusal.
 */
describe("Content reads carry the visitor's session to the Backend", () => {
  const session = "s".repeat(43);
  const emptyPage = {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
  };
  const stub = (...responses: Response[]) => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://backend.invalid");
    const upstream = vi.fn<typeof fetch>();
    for (const response of responses) upstream.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", upstream);
    return upstream;
  };
  const sent = (upstream: ReturnType<typeof stub>, call = 0) => {
    const [url, init] = upstream.mock.calls[call]!;
    return { url: String(url), init, headers: new Headers(init?.headers) };
  };

  it("sends the session and forbids storing the answer on Catalog list, detail and search", async () => {
    const upstream = stub(
      Response.json(emptyPage),
      new Response(null, { status: 404 }),
      Response.json(emptyPage),
    );
    await expect(
      fetchServerCatalogPage({ kind: "inscription" }, session),
    ).resolves.toMatchObject({ state: "success" });
    await expect(
      fetchServerCatalogDetail("catalog-001", session),
    ).resolves.toEqual({ state: "not-found" });
    await expect(
      fetchServerCatalogSearchPage({ q: "碑" }, undefined, session),
    ).resolves.toMatchObject({ state: "success" });
    for (const call of [0, 1, 2]) {
      expect(sent(upstream, call).headers.get("authorization")).toBe(
        `Bearer ${session}`,
      );
      expect(sent(upstream, call).init?.cache).toBe("no-store");
    }
    expect(sent(upstream, 0).url).toBe(
      "http://backend.invalid/v1/catalog?kind=inscription",
    );
  });

  it("sends no credential for a visitor without a session, and still never stores the answer", async () => {
    const upstream = stub(Response.json(emptyPage));
    await fetchServerCatalogPage();
    expect(sent(upstream).headers.has("authorization")).toBe(false);
    expect(sent(upstream).init?.cache).toBe("no-store");
  });

  it.each([401, 403] as const)(
    "reports the Backend's %s as an access refusal on every read",
    async (status) => {
      const refused = () => new Response(null, { status });
      stub(refused(), refused(), refused(), refused());
      const denied = { state: "access-denied", status };
      await expect(fetchServerCatalogPage({}, session)).resolves.toEqual(
        denied,
      );
      await expect(
        fetchServerCatalogDetail("catalog-001", session),
      ).resolves.toEqual(denied);
      await expect(
        fetchServerCatalogSearchPage({ q: "碑" }, undefined, session),
      ).resolves.toEqual(denied);
      await expect(
        fetchServerCatalogCommentPage("catalog-001", {}, undefined, session),
      ).resolves.toEqual(denied);
    },
  );

  it("keeps a write's own missing-session answer and adds only the 403 refusal", async () => {
    stub(
      new Response(null, { status: 401 }),
      new Response(null, { status: 403 }),
    );
    await expect(
      createServerCatalogComment("catalog-001", session, { text: "文" }),
    ).resolves.toEqual({ state: "unauthenticated" });
    await expect(
      createServerCatalogComment("catalog-001", session, { text: "文" }),
    ).resolves.toEqual({ state: "access-denied", status: 403 });
  });

  it("asks for product access with the session and treats a missing configuration as unavailable", async () => {
    const upstream = stub(
      Response.json({ mode: "closed_beta", access: "granted" }),
    );
    await expect(fetchServerProductAccess(session)).resolves.toEqual({
      state: "success",
      access: { mode: "closed_beta", access: "granted" },
    });
    expect(sent(upstream).url).toBe(
      "http://backend.invalid/v1/community/access",
    );
    expect(sent(upstream).headers.get("authorization")).toBe(
      `Bearer ${session}`,
    );
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    await expect(fetchServerProductAccess(session)).resolves.toEqual({
      state: "unavailable",
    });
  });

  it("refuses the Development Catalog media relay with the Backend's status before reading any file", async () => {
    const upstream = stub(new Response(null, { status: 403 }));
    const response = await relayServerLocalCatalogMedia(
      "catalog-001",
      "media-001",
      session,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream).toHaveBeenCalledOnce();
    expect(sent(upstream).headers.get("authorization")).toBe(
      `Bearer ${session}`,
    );
  });

  it("refuses the Development editorial media relay with the Backend's status before reading any file", async () => {
    const owner = `article-${"3".repeat(32)}`;
    const file = `${"e".repeat(64)}-${"f".repeat(64)}.png`;
    const anonymous = stub(new Response(null, { status: 401 }));
    expect((await relayServerLocalEditorialMedia(owner, file)).status).toBe(
      401,
    );
    expect(anonymous).toHaveBeenCalledOnce();

    // A valid session whose account is not approved: refused once, as is.
    const restricted = stub(new Response(null, { status: 403 }));
    expect(
      (await relayServerLocalEditorialMedia(owner, file, session)).status,
    ).toBe(403);
    expect(restricted).toHaveBeenCalledOnce();
    expect(sent(restricted).headers.get("authorization")).toBe(
      `Bearer ${session}`,
    );
  });

  it("reads a Development editorial image as signed out when the Backend no longer accepts the session", async () => {
    const upstream = stub(
      new Response(null, { status: 401 }),
      new Response(null, { status: 404 }),
    );
    const response = await relayServerLocalEditorialMedia(
      `article-${"3".repeat(32)}`,
      `${"e".repeat(64)}-${"f".repeat(64)}.png`,
      session,
    );
    // Public mode: the signed-out lookup answers for itself (here: not published).
    expect(response.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(sent(upstream, 0).headers.get("authorization")).toBe(
      `Bearer ${session}`,
    );
    expect(sent(upstream, 1).headers.has("authorization")).toBe(false);
  });
});

/*
 * account-switching-v1: a sign-out names the account the page shows, so a
 * stale tab never signs out the account another tab made current; and an
 * appeal-login refusal never signs the ordinary account out.
 */
describe("Sign-out and appeal relay account fences", () => {
  const normal = "N".repeat(43);
  const appeal = "P".repeat(43);
  const account = `user-${"1".repeat(32)}`;
  // What `me` answers while the session still works (synthetic).
  const profile = { id: account, handle: "signed-in", displayName: "当前账户" };
  const post = (suffix: string, headers: Record<string, string> = {}) =>
    relayServerCommunityAuth(
      new Request(`http://127.0.0.1:3410/api/community/auth/${suffix}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3410",
          origin: "http://127.0.0.1:3410",
          "content-type": "application/json",
          cookie: `yoyi-session=${normal}; yoyi-appeal-session=${appeal}`,
          ...headers,
        },
        body: "{}",
      }),
    );
  const refused = () =>
    Response.json(
      {
        error: { code: "UNAUTHENTICATED", message: "AUTH_INVALID_CREDENTIALS" },
      },
      { status: 401 },
    );

  it.each(["appeals/login", "appeals/verify", "appeals/challenges"])(
    "keeps the ordinary session when %s is refused",
    async (suffix) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(refused())
        .mockResolvedValue(new Response(null, { status: 401 }));
      vi.stubGlobal("fetch", upstream);
      const response = await post(suffix);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it("forwards the page's account on sign-out and clears the cookie once it is confirmed", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstream);
    const response = await post("sign-out", { "x-author-account": account });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-author-account")).toBe(account);
    expect(headers.get("authorization")).toBe(`Bearer ${normal}`);
  });

  it("keeps the session only when the Backend refuses the sign-out as another account's", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: "CONFLICT", message: "AUTH_ACCOUNT_MISMATCH" } },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", upstream);
    const response = await post("sign-out", { "x-author-account": account });
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledOnce();
  });

  // The current session leaves this browser only once it has really ended:
  // any other answer keeps it, so 退出登录 can be retried. That includes a
  // sign-out 401 for a session `me` still accepts, such as a Backend that
  // does not trust the request's authentication source.
  it.each([
    [
      503,
      {
        error: { code: "SERVICE_UNAVAILABLE", message: "AUTH_NOT_CONFIGURED" },
      },
    ],
    [500, { error: { code: "INTERNAL_ERROR", message: "Internal error" } }],
    [409, { error: { code: "CONFLICT", message: "AUTH_RATE_LIMITED" } }],
    [409, { error: { code: "CONFLICT", message: "AUTH_ACCOUNT_MISMATCH" } }],
    [
      401,
      { error: { code: "UNAUTHENTICATED", message: "AUTH_SOURCE_UNTRUSTED" } },
    ],
  ])(
    "keeps the session when the Backend answers sign-out with %s and the session still works",
    async (status, body) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi.fn<typeof fetch>(async (input) =>
        new URL(String(input)).pathname === "/v1/me"
          ? Response.json(profile)
          : Response.json(body, { status }),
      );
      vi.stubGlobal("fetch", upstream);
      for (const headers of [{ "x-author-account": account }, {}]) {
        const response = await post("sign-out", headers);
        expect(response.status).toBe(status);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    },
  );

  // A session `me` refuses too (revoked, expired, or a suspended account,
  // whose sessions the suspension revoked) is already over: the browser lets
  // it go and the page leaves as on a confirmed sign-out.
  it.each(["AUTH_UNAUTHENTICATED", "AUTH_ACCOUNT_SUSPENDED"])(
    "clears the session and answers success once the Backend no longer accepts it (%s)",
    async (reason) => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const refused = (message: string) =>
        Response.json(
          { error: { code: "UNAUTHENTICATED", message } },
          { status: 401 },
        );
      const upstream = vi.fn<typeof fetch>(async (input) =>
        new URL(String(input)).pathname === "/v1/me"
          ? refused("Authentication required")
          : refused(reason),
      );
      vi.stubGlobal("fetch", upstream);
      for (const headers of [{ "x-author-account": account }, {}]) {
        const response = await post("sign-out", headers);
        expect(response.status).toBe(204);
        expect(response.headers.getSetCookie()).toEqual([
          expect.stringMatching(/^yoyi-session=; .*Max-Age=0/u),
        ]);
      }
    },
  );

  it("keeps the session when the sign-out never reached the Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    const response = await post("sign-out");
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a malformed account assertion before the Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await post("sign-out", { "x-author-account": "user-x" });
    expect(response.status).toBe(422);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never touches the saved accounts on an ordinary sign-out", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    const response = await post("sign-out");
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^yoyi-session=; /u),
    ]);
  });
});

/*
 * account-switching-v1: direct-message reads are bound to the account the page
 * shows, like notification reads, so a tab that missed a switch never reads
 * the other account's conversations.
 */
describe("Direct-message reads carry the confirmed account", () => {
  it("forwards a well-formed account on every messages read and refuses a malformed one", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ items: [] }));
    vi.stubGlobal("fetch", upstream);
    const account = `user-${"2".repeat(32)}`;
    const read = (path: string, expected: string) =>
      relayServerAuthorCommunity(
        new Request(`http://127.0.0.1:3410/api/community/${path}`, {
          headers: {
            host: "127.0.0.1:3410",
            cookie: `yoyi-session=${"M".repeat(43)}`,
            "x-author-account": expected,
          },
        }),
      );
    for (const path of [
      "messages?pageSize=20",
      "messages/unread",
      `messages/dm-${"c".repeat(32)}?pageSize=30`,
    ]) {
      upstream.mockClear();
      expect((await read(path, account)).status).toBe(200);
      expect(
        new Headers(upstream.mock.calls[0]?.[1]?.headers).get(
          "x-author-account",
        ),
      ).toBe(account);
      expect((await read(path, "user-x")).status).toBe(422);
      expect(upstream).toHaveBeenCalledOnce();
    }
    // Other public reads still carry no account.
    upstream.mockClear();
    expect((await read("editorial/articles", account)).status).toBe(200);
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).has("x-author-account"),
    ).toBe(false);
  });
});

describe("Issue #326 reporting relay", () => {
  const normal = Buffer.alloc(32, 1).toString("base64url"),
    appeal = Buffer.alloc(32, 2).toString("base64url");
  describe("reporting credential and evidence relay", () => {
    it("does not let an old appeal cookie replace ordinary account requests", async () => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ items: [] }));
      vi.stubGlobal("fetch", upstream);
      await relayServerAuthorCommunity(
        new Request("http://localhost/api/community/decisions", {
          headers: {
            cookie: `yoyi-session=${normal}; yoyi-appeal-session=${appeal}`,
          },
        }),
      );
      expect(
        new Headers(upstream.mock.calls[0]?.[1]?.headers).get(
          "authorization",
        ) === `Bearer ${normal}`,
      ).toBe(true);
    });
    it("uses restricted credentials only for an explicit allowed case operation", async () => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ items: [] }));
      vi.stubGlobal("fetch", upstream);
      await relayServerAuthorCommunity(
        new Request("http://localhost/api/community/decisions", {
          headers: {
            cookie: `yoyi-session=${normal}; yoyi-appeal-session=${appeal}`,
            "x-reporting-session": "appeal",
            "x-author-account": "user-" + "1".repeat(32),
          },
        }),
      );
      const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization") === `Bearer ${appeal}`).toBe(true);
      expect(headers.get("x-author-account")).toBe("user-" + "1".repeat(32));
    });
    it("never forwards a stale normal cookie to restricted OTP challenge issuance", async () => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ accepted: true }));
      vi.stubGlobal("fetch", upstream);
      const result = await relayServerCommunityAuth(
        new Request("http://localhost/api/community/auth/appeals/challenges", {
          method: "POST",
          headers: {
            cookie: `yoyi-session=${normal}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ purpose: "sign_in" }),
        }),
      );
      expect(result.status).toBe(200);
      expect(
        new Headers(upstream.mock.calls[0]?.[1]?.headers).has("authorization"),
      ).toBe(false);
    });
    it("keeps restricted session material in its own HttpOnly cookie", async () => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            outcome: "appeal_signed_in",
            session: {
              token: appeal,
              expiresAt: "2030-01-01T00:00:00.000Z",
              profile: { id: "synthetic" },
            },
          }),
        ),
      );
      const result = await relayServerCommunityAuth(
        new Request("http://localhost/api/community/auth/appeals/login", {
          method: "POST",
          body: "{}",
        }),
      );
      const body = await result.json();
      expect(body.session).not.toHaveProperty("token");
      expect(
        result.headers.get("set-cookie")?.startsWith("yoyi-appeal-session="),
      ).toBe(true);
      expect(result.headers.get("set-cookie")).toContain("HttpOnly");
    });
    it("delivers private PDF evidence only as an uncached attachment", async () => {
      vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response("%PDF-synthetic", {
            headers: { "content-type": "application/pdf" },
          }),
        ),
      );
      const result = await relayServerAuthorCommunity(
        new Request(
          "http://localhost/api/community/reports/report-synthetic/evidence/evidence-synthetic",
          { headers: { cookie: `yoyi-session=${normal}` } },
        ),
      );
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("content-disposition")).toBe("attachment");
    });
  });
});

describe("feedback uses the ordinary same-origin community relay", () => {
  it("forwards the session/account and confirmed receipt without auth-service relay configuration", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
    const receipt = {
      id: "feedback-" + "a".repeat(32),
      createdAt: "2026-10-23T12:00:00.000Z",
    };
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(receipt, { status: 201 }));
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      new Request("http://127.0.0.1:3410/api/community/feedback", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3410",
          "content-type": "application/json",
          cookie:
            "yoyi-session=" +
            "synthetic-feedback-session-value-".padEnd(43, "x"),
          "x-author-account": "user-" + "b".repeat(32),
        },
        body: JSON.stringify({
          submissionId: "00000000-0000-4000-8000-000000000001",
          message: "Synthetic feedback",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(receipt);
    expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-author-account": "user-" + "b".repeat(32),
      Authorization:
        "Bearer " + "synthetic-feedback-session-value-".padEnd(43, "x"),
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("refuses a foreign-origin feedback write before calling the Backend", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await relayServerAuthorCommunity(
      new Request("http://127.0.0.1:3410/api/community/feedback", {
        method: "POST",
        headers: {
          origin: "https://foreign.invalid",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
