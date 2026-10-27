import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRepliesMock, createReplyMock } = vi.hoisted(() => ({
  fetchRepliesMock: vi.fn(),
  createReplyMock: vi.fn(),
}));

vi.mock("../../../../../../../lib/public-api/server", () => ({
  fetchServerCatalogCommentReplyPage: fetchRepliesMock,
  createServerCatalogCommentReply: createReplyMock,
}));

import { GET, POST } from "./route";

const opaqueSession = "B".repeat(43);
const catalogId = "catalog-001";
const commentId = "comment-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
const context = { params: Promise.resolve({ catalogId, commentId }) };
const url = `http://localhost/api/catalog/${catalogId}/comments/${commentId}/replies`;
const reply = {
  id: "comment-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f02",
  author: {
    id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
    displayName: "拓片爱好者",
  },
  text: "回复正文",
  createdAt: "2026-09-12T06:00:00.000Z",
};

const writeRequest = (
  body: unknown,
  cookie?: string,
  extra: Record<string, string> = {},
) => {
  const payload = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).byteLength),
      ...(cookie === undefined ? {} : { cookie }),
      ...extra,
    },
    body: payload,
  });
};

/**
 * A chunked body declares no content-length, so only the stream bound can stop
 * it. Each chunk is well under the cap; the total is far over it.
 */
const chunkedRequest = (target: string, chunkCount: number, cookie: string) =>
  new Request(target, {
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
  fetchRepliesMock.mockReset();
  createReplyMock.mockReset();
});

describe("same-origin reply bridge", () => {
  it("pages replies anonymously", async () => {
    const page = {
      items: [reply],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    };
    fetchRepliesMock.mockResolvedValue({ state: "success", page });
    const response = await GET(new Request(`${url}?pageSize=10`), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(fetchRepliesMock).toHaveBeenCalledWith(
      catalogId,
      commentId,
      {
        pageSize: "10",
      },
      undefined,
      undefined,
    );
  });

  it("refuses unknown query parameters and unauthenticated writes", async () => {
    expect((await GET(new Request(`${url}?depth=2`), context)).status).toBe(
      400,
    );
    expect(fetchRepliesMock).not.toHaveBeenCalled();
    expect((await POST(writeRequest({ text: "回复" }), context)).status).toBe(
      401,
    );
    expect(createReplyMock).not.toHaveBeenCalled();
  });

  it("relays the credential and the optional sibling pointer", async () => {
    createReplyMock.mockResolvedValue({
      state: "success",
      item: reply,
      awaitingApproval: false,
    });
    const response = await POST(
      writeRequest(
        { text: "回复正文", replyTo: reply.id },
        `yoyi-session=${opaqueSession}`,
      ),
      context,
    );
    expect(response.status).toBe(201);
    expect(createReplyMock).toHaveBeenCalledWith(
      catalogId,
      commentId,
      opaqueSession,
      { text: "回复正文", replyTo: reply.id },
      undefined,
    );
  });

  // account-switching-v1: same-origin writes only, bound to the asserted account.
  it("forwards the asserted account and refuses cross-site or malformed writes", async () => {
    createReplyMock.mockResolvedValue({
      state: "success",
      item: reply,
      awaitingApproval: false,
    });
    const account = `user-${"b".repeat(32)}`;
    const accepted = await POST(
      writeRequest({ text: "回复正文" }, `yoyi-session=${opaqueSession}`, {
        host: "localhost",
        origin: "http://localhost",
        "x-author-account": account,
      }),
      context,
    );
    expect(accepted.status).toBe(201);
    expect(createReplyMock).toHaveBeenCalledWith(
      catalogId,
      commentId,
      opaqueSession,
      { text: "回复正文" },
      account,
    );
    createReplyMock.mockClear();
    for (const headers of [
      { host: "localhost", origin: "https://foreign.invalid" },
      { "sec-fetch-site": "cross-site" },
    ])
      expect(
        (
          await POST(
            writeRequest(
              { text: "回复正文" },
              `yoyi-session=${opaqueSession}`,
              headers,
            ),
            context,
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await POST(
          writeRequest({ text: "回复正文" }, `yoyi-session=${opaqueSession}`, {
            "x-author-account": "not-a-user",
          }),
          context,
        )
      ).status,
    ).toBe(422);
    expect(createReplyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["not-found", 404],
    ["invalid-input", 422],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("maps write state %s", async (state, status) => {
    createReplyMock.mockResolvedValue({ state });
    const response = await POST(
      writeRequest({ text: "回复" }, `yoyi-session=${opaqueSession}`),
      context,
    );
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  it("bounds a chunked body that declares no length", async () => {
    const chunked = chunkedRequest(url, 8, `yoyi-session=${opaqueSession}`);
    expect((await POST(chunked, context)).status).toBe(422);
    expect(createReplyMock).not.toHaveBeenCalled();
  });

  it("answers 202 while a reply awaits approval", async () => {
    createReplyMock.mockResolvedValue({
      state: "success",
      item: reply,
      awaitingApproval: true,
    });
    expect(
      (
        await POST(
          writeRequest({ text: "回复" }, `yoyi-session=${opaqueSession}`),
          context,
        )
      ).status,
    ).toBe(202);
  });
});
