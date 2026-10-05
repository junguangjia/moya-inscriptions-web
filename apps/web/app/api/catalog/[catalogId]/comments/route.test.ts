import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPageMock, createMock } = vi.hoisted(() => ({
  fetchPageMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock("../../../../../lib/public-api/server", () => ({
  fetchServerCatalogCommentPage: fetchPageMock,
  createServerCatalogComment: createMock,
}));

import { GET, POST } from "./route";

const opaqueSession = "A".repeat(43);
const catalogId = "catalog-001";
const context = { params: Promise.resolve({ catalogId }) };
const page = {
  hot: [],
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  totalPages: 0,
};
const comment = {
  id: "comment-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  catalogId,
  author: {
    id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
    displayName: "拓片爱好者",
  },
  text: "评论正文",
  createdAt: "2026-09-12T06:00:00.000Z",
  replies: [],
  replyTotal: 0,
};

const readRequest = (query = "") =>
  new Request(`http://localhost/api/catalog/${catalogId}/comments${query}`);

const writeRequest = (body: unknown, cookie?: string) => {
  const payload = JSON.stringify(body);
  return new Request(`http://localhost/api/catalog/${catalogId}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).byteLength),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: payload,
  });
};

/**
 * A chunked body declares no content-length, so only the stream bound can stop
 * it. Each chunk is well under the cap; the total is far over it.
 */
const chunkedRequest = (url: string, chunkCount: number, cookie: string) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkCount-- <= 0) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("x".repeat(1_024)));
      },
    }),
    // @ts-expect-error -- Node requires duplex for a streaming request body.
    duplex: "half",
  });

beforeEach(() => {
  fetchPageMock.mockReset();
  createMock.mockReset();
});

describe("same-origin comment bridge", () => {
  it("reads a page anonymously with no-store caching", async () => {
    fetchPageMock.mockResolvedValue({ state: "success", page });
    const response = await GET(readRequest("?page=2&pageSize=10"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.json()).toEqual(page);
    expect(fetchPageMock).toHaveBeenCalledWith(
      catalogId,
      {
        page: "2",
        pageSize: "10",
      },
      undefined,
      undefined,
    );
  });

  it("forwards the pinned hot ids of a load-more request", async () => {
    fetchPageMock.mockResolvedValue({ state: "success", page });
    const response = await GET(
      readRequest("?page=2&pinned=comment-a,comment-b"),
      context,
    );
    expect(response.status).toBe(200);
    expect(fetchPageMock).toHaveBeenCalledWith(
      catalogId,
      {
        page: "2",
        pinned: "comment-a,comment-b",
      },
      undefined,
      undefined,
    );
  });

  it("rejects unknown or repeated query parameters before calling the Backend", async () => {
    for (const query of [
      "?unknown=1",
      "?page=1&page=2",
      "?sort=hot",
      "?pinned=a&pinned=b",
    ]) {
      const response = await GET(readRequest(query), context);
      expect(response.status).toBe(400);
    }
    expect(fetchPageMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid-query", 400],
    ["not-found", 404],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("maps read state %s", async (state, status) => {
    fetchPageMock.mockResolvedValue({ state });
    const response = await GET(readRequest(), context);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  it("relays the cookie credential on create and answers 201 when visible", async () => {
    createMock.mockResolvedValue({
      state: "success",
      item: comment,
      awaitingApproval: false,
    });
    const response = await POST(
      writeRequest({ text: "评论正文" }, `yoyi-session=${opaqueSession}`),
      context,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(comment);
    expect(createMock).toHaveBeenCalledWith(catalogId, opaqueSession, {
      text: "评论正文",
    });
  });

  it("answers 202 while the submission awaits approval", async () => {
    createMock.mockResolvedValue({
      state: "success",
      item: comment,
      awaitingApproval: true,
    });
    const response = await POST(
      writeRequest({ text: "评论正文" }, `yoyi-session=${opaqueSession}`),
      context,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(comment);
  });

  it("refuses writes without a session credential and never calls the Backend", async () => {
    for (const cookie of [undefined, "payload-token=abc", "yoyi-session=bad"]) {
      const response = await POST(
        writeRequest({ text: "正文" }, cookie),
        context,
      );
      expect(response.status).toBe(401);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("bounds the request body before parsing", async () => {
    const oversized = new Request(
      `http://localhost/api/catalog/${catalogId}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "5000",
          cookie: `yoyi-session=${opaqueSession}`,
        },
        body: JSON.stringify({ text: "x".repeat(4_500) }),
      },
    );
    expect((await POST(oversized, context)).status).toBe(422);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("bounds a chunked body that declares no length", async () => {
    const chunked = chunkedRequest(
      `http://localhost/api/catalog/${catalogId}/comments`,
      8,
      `yoyi-session=${opaqueSession}`,
    );
    expect((await POST(chunked, context)).status).toBe(422);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["not-found", 404],
    ["invalid-input", 422],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)(
    "maps write state %s without exposing internals",
    async (state, status) => {
      createMock.mockResolvedValue({ state });
      const response = await POST(
        writeRequest({ text: "正文" }, `yoyi-session=${opaqueSession}`),
        context,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );
});
