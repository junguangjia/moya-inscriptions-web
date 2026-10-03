import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommunityEndpoints,
  CommunityOperatorError,
} from "admin/community-endpoints";
import type {
  OperatorCall,
  OperatorMediaCall,
} from "admin/community-endpoints";
import type { Endpoint, PayloadRequest } from "payload";

const id = `article-${"a".repeat(32)}`;
const fingerprint = "b".repeat(64);
const candidate = {
  articleId: id,
  ownerId: `user-${"c".repeat(32)}`,
  expectedVersion: 4,
  candidateVersion: 3,
  fingerprint,
  title: "待审原文",
  publicVersion: null,
  submittedAt: "2026-10-02T00:00:00Z",
  coverRefId: null,
  document: {
    format: "blocknote",
    version: 1,
    blocks: [
      {
        id: "p",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "待审正文", styles: {} }],
        children: [],
      },
    ],
    references: {},
    galleries: {},
  },
  resolvedReferences: {},
};
const command = {
  requestId: "00000000-0000-4000-8000-000000000004",
  expectedVersion: 4,
  candidateVersion: 3,
  fingerprint,
  action: "approve",
};
const req = (body: unknown, role: string | null = "owner"): PayloadRequest =>
  ({
    user: role === null ? null : { collection: "users", id: 1, role },
    json: async () => body,
    payload: { logger: { error: vi.fn() } },
  }) as unknown as PayloadRequest;
const invoke = async (
  endpoints: Endpoint[],
  name: string,
  request: PayloadRequest,
) => {
  const endpoint = endpoints.find(
    (entry) => entry.path === `/community-moderation/${name}`,
  )!;
  return await (
    endpoint.handler as (request: PayloadRequest) => Promise<Response>
  )(request);
};
afterEach(() => vi.unstubAllEnvs());

describe("Admin authored Article moderation", () => {
  it.each(["development", "production"])(
    "lists, reads and forwards exact decisions in %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      const call = vi.fn(
        async (_method: string, path: string): Promise<unknown> =>
          path.startsWith("articles/submissions")
            ? {
                items: [
                  {
                    ...candidate,
                    coverRefId: undefined,
                    document: undefined,
                    resolvedReferences: undefined,
                  },
                ],
                nextCursor: null,
              }
            : path.endsWith("/moderation")
              ? {
                  articleId: id,
                  candidateVersion: 3,
                  fingerprint,
                  version: 5,
                  disposition: "approved",
                  status: "published",
                  publicVersion: 3,
                }
              : candidate,
      );
      // Summary is deliberately separate: strict response schemas reject extra fields.
      call.mockImplementationOnce(async () => {
        const { document, coverRefId, resolvedReferences, ...summary } =
          candidate;
        void document;
        void coverRefId;
        void resolvedReferences;
        return { items: [summary], nextCursor: null };
      });
      const endpoints = createCommunityEndpoints(call as OperatorCall);
      expect(
        (
          await invoke(
            endpoints,
            "read-article-submissions",
            req({ pageSize: 20 }),
          )
        ).status,
      ).toBe(200);
      expect(
        (await invoke(endpoints, "read-article-submission", req({ id })))
          .status,
      ).toBe(200);
      expect(
        (
          await invoke(
            endpoints,
            "moderate-article-submission",
            req({ id, ...command }),
          )
        ).status,
      ).toBe(200);
      expect(call.mock.calls).toEqual([
        ["GET", "articles/submissions?pageSize=20"],
        ["GET", `articles/${id}/submission`],
        ["POST", `articles/${id}/moderation`, command],
      ]);
    },
  );
  it("refuses anonymous, automation and editor requests before any Backend call", async () => {
    const call = vi.fn();
    for (const role of [null, "automation", "editor"])
      for (const [name, body] of [
        ["read-article-submissions", {}],
        ["read-article-submission", { id }],
        ["moderate-article-submission", { id, ...command }],
      ] as const)
        expect(
          (await invoke(createCommunityEndpoints(call), name, req(body, role)))
            .status,
        ).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });
  it("strictly validates identity, candidate and action without actor spoofing", async () => {
    const call = vi.fn();
    for (const body of [
      { id, ...command, ownerId: candidate.ownerId },
      { id, ...command, actor: "owner" },
      { id, ...command, fingerprint: "x" },
      { id, ...command, candidateVersion: 0 },
      { id, ...command, expectedVersion: 0 },
      { id: "article-x", ...command },
      { id, ...command, action: "publish" },
    ])
      expect(
        (
          await invoke(
            createCommunityEndpoints(call),
            "moderate-article-submission",
            req(body),
          )
        ).status,
      ).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
  it("preserves a stale-candidate refusal and never retries a decision", async () => {
    const call = vi.fn(async () => {
      throw new CommunityOperatorError("STATE_CONFLICT", 409);
    });
    const response = await invoke(
      createCommunityEndpoints(call),
      "moderate-article-submission",
      req({ id, ...command }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "STATE_CONFLICT" },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("refuses a malformed preview instead of exposing unchecked content", async () => {
    const response = await invoke(
      createCommunityEndpoints(
        vi.fn(async () => ({
          ...candidate,
          resolvedReferences: {
            extra: { type: "unavailable", reason: "media_unavailable" },
          },
        })) as OperatorCall,
      ),
      "read-article-submission",
      req({ id }),
    );
    expect(response.status).toBe(502);
  });
});

describe("Admin exact Article candidate media relay", () => {
  const query = new URLSearchParams({
    expectedVersion: "4",
    candidateVersion: "3",
    fingerprint,
    refId: "cover",
    variant: "display",
  }).toString();
  const mediaReq = (search = query, role: string | null = "owner") =>
    Object.assign(req({}, role), {
      routeParams: { id },
      url: `http://admin.invalid/api/community-moderation/article-submission-media/${id}?${search}`,
      headers: new Headers({ Range: "bytes=0-1" }),
      signal: new AbortController().signal,
    });
  const open = () =>
    vi.fn(async () => ({
      status: 206 as const,
      contentType: "image/webp",
      contentLength: "2",
      contentRange: "bytes 0-1/4",
      acceptsRanges: true,
      body: new Response(new Uint8Array([1, 2])).body!,
    }));
  it("keeps the exact candidate query, Range and cancellation while streaming privately", async () => {
    const openMedia = open();
    const request = mediaReq();
    const response = await invoke(
      createCommunityEndpoints(vi.fn(), openMedia as OperatorMediaCall),
      "article-submission-media/:id",
      request,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBe("bytes 0-1/4");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(openMedia).toHaveBeenCalledExactlyOnceWith(
      `articles/${id}/submission-media?${query}`,
      "bytes=0-1",
      request.signal,
    );
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
  });
  it("refuses all non-Owner and arbitrary/malformed/duplicate fields without reading bytes", async () => {
    const openMedia = open();
    const endpoints = createCommunityEndpoints(
      vi.fn(),
      openMedia as OperatorMediaCall,
    );
    for (const role of [null, "automation", "editor"])
      expect(
        (
          await invoke(
            endpoints,
            "article-submission-media/:id",
            mediaReq(query, role),
          )
        ).status,
      ).toBe(403);
    for (const search of [
      `${query}&itemId=media-item-${"1".repeat(32)}`,
      `${query}&refId=other`,
      query.replace("variant=display", "variant=original"),
      query.replace("expectedVersion=4", "expectedVersion=1e1"),
    ])
      expect(
        (
          await invoke(
            endpoints,
            "article-submission-media/:id",
            mediaReq(search),
          )
        ).status,
      ).toBe(400);
    expect(openMedia).not.toHaveBeenCalled();
  });
  it("preserves a range refusal without buffering bytes", async () => {
    const openMedia = vi.fn(async () => {
      throw new CommunityOperatorError("RANGE_NOT_SATISFIABLE", 416);
    });
    expect(
      (
        await invoke(
          createCommunityEndpoints(vi.fn(), openMedia),
          "article-submission-media/:id",
          mediaReq(),
        )
      ).status,
    ).toBe(416);
  });
});
