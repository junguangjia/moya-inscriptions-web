import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMENT_IMAGE_CAPABILITY_HEADER as header,
  commentImagePayloadFor,
} from "@moya/contracts/comment-images-protocol";
import { GET, POST } from "../../app/api/catalog/[catalogId]/comments/route";
import { GET as replies } from "../../app/api/catalog/[catalogId]/comments/[commentId]/replies/route";
import {
  createSameOriginCatalogComment,
  fetchSameOriginCatalogCommentPage,
  fetchSameOriginCatalogCommentReplyPage,
} from "./catalog-comments-client";
import {
  fetchServerCatalogCommentPage,
  relayServerAuthorCommunity,
} from "./server";

const id = "comment-" + "a".repeat(32);
const catalogId = "catalog-synthetic";
const itemId = "media-item-" + "e".repeat(32);
const image = {
  id: itemId,
  offset: 0,
  width: 40,
  height: 20,
  thumbSrc: `/api/community/discussion/images/${id}/${itemId}/thumb`,
  src: `/api/community/discussion/images/${id}/${itemId}/display`,
};
const reply = {
  id,
  author: { id: "user-" + "b".repeat(32), displayName: "合成作者" },
  text: "",
  images: [image],
  createdAt: "2026-11-03T00:00:00.000Z",
};
const comment = { ...reply, catalogId, replies: [], replyTotal: 0 };
const page = {
  hot: [],
  items: [comment],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};
const context = { params: Promise.resolve({ catalogId }) };
const url = `http://localhost/api/catalog/${catalogId}/comments`;
const token = "EXPLICIT_SYNTHETIC_PLACEHOLDER".padEnd(43, "_");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Actual Web clients/routes/SSR against a negotiated authorized Backend DTO. */
const backend = () => {
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "http://127.0.0.1:3411");
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const payload =
      init?.method === "POST"
        ? comment
        : path.endsWith("/replies")
          ? { ...page, hot: undefined, items: [reply] }
          : page;
    // Do not put an unknown hot key into the reply page's strict contract.
    if (path.endsWith("/replies")) delete (payload as { hot?: unknown }).hot;
    return Response.json(
      commentImagePayloadFor(new Headers(init?.headers).get(header), payload),
      { status: init?.method === "POST" ? 201 : 200 },
    );
  });
  vi.stubGlobal("fetch", send);
  return send;
};

describe("comment representation across the actual Web boundaries", () => {
  it.each([undefined, "1", "2"])(
    "keeps a browser marker %j through the Catalog BFF without upgrading old pages",
    async (version) => {
      const upstream = backend();
      const response = await GET(
        new Request(url, {
          headers: version === undefined ? {} : { [header]: version },
        }),
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("vary")).toBe(`Cookie, ${header}`);
      const result = await response.json();
      expect(result.items[0]).toEqual(
        version === "1"
          ? comment
          : {
              ...comment,
              images: undefined,
              text: "【此条含附图，请刷新页面查看】",
            },
      );
      expect(
        new Headers(upstream.mock.calls[0]?.[1]?.headers).get(header),
      ).toBe(version === "1" ? "1" : null);
      expect(comment.text).toBe("");
    },
  );

  it("lets current SSR read image-only comments without a browser marker", async () => {
    const upstream = backend();
    await expect(fetchServerCatalogCommentPage(catalogId)).resolves.toEqual({
      state: "success",
      page,
    });
    expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get(header)).toBe(
      "1",
    );
  });

  it("round-trips current browser reads, replies and image-only writes through actual routes", async () => {
    const upstream = backend();
    const browser = {
      baseUrl: new URL("http://localhost"),
      fetch: vi.fn<typeof fetch>(async (input, init) => {
        const req = new Request(String(input), {
          ...init,
          headers: { ...init?.headers, cookie: `yoyi-session=${token}` },
        });
        if (new URL(req.url).pathname.endsWith("/replies"))
          return replies(req, {
            params: Promise.resolve({ catalogId, commentId: id }),
          });
        return req.method === "POST" ? POST(req, context) : GET(req, context);
      }),
    };
    await expect(
      fetchSameOriginCatalogCommentPage(catalogId, {}, undefined, browser),
    ).resolves.toEqual({ state: "success", page });
    const replyPage = {
      items: [reply],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    };
    await expect(
      fetchSameOriginCatalogCommentReplyPage(
        catalogId,
        id,
        {},
        undefined,
        browser,
      ),
    ).resolves.toEqual({ state: "success", page: replyPage });
    const body = {
      text: "",
      images: [{ itemId, offset: 0 }],
      requestId: "10000000-0000-4000-8000-000000000001",
    };
    await expect(
      createSameOriginCatalogComment(catalogId, body, browser),
    ).resolves.toEqual({
      state: "success",
      item: comment,
      awaitingApproval: false,
    });
    for (const [, init] of upstream.mock.calls) {
      expect(new Headers(init?.headers).get(header)).toBe("1");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
    }
    expect(JSON.parse(String(upstream.mock.calls[2]?.[1]?.body))).toEqual(body);
  });

  it.each([undefined, "1", "2"])(
    "preserves a generic discussion browser marker %j and its private response",
    async (version) => {
      const upstream = backend();
      const response = await relayServerAuthorCommunity(
        new Request(
          "http://localhost/api/community/discussion/comments?type=work&id=work-" +
            "d".repeat(32),
          { headers: version === undefined ? {} : { [header]: version } },
        ),
      );
      expect(response.status).toBe(200);
      expect(
        new Headers(upstream.mock.calls[0]?.[1]?.headers).get(header),
      ).toBe(version === "1" ? "1" : null);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe(`Cookie, ${header}`);
      expect((await response.json()).items[0].text).toBe(
        version === "1" ? "" : "【此条含附图，请刷新页面查看】",
      );
    },
  );
});
