import { createCommunityEndpoints } from "admin/community-endpoints";
import type {
  OperatorMediaCall,
  OperatorMediaResponse,
} from "admin/community-endpoints";
import type { PayloadRequest } from "payload";
import { describe, expect, it, vi } from "vitest";

const commentId = "comment-" + "a".repeat(32);
const itemId = "media-item-" + "b".repeat(32);
const route = "/community-moderation/comment-media/:commentId/:itemId/:variant";
const request = (
  role: "owner" | "automation" | null = "owner",
  changes: Record<string, unknown> = {},
) =>
  ({
    user: role === null ? null : { collection: "users", id: 1, role },
    routeParams: { commentId, itemId, variant: "display" },
    url: `http://admin.test/api/community-moderation/comment-media/${commentId}/${itemId}/display`,
    headers: new Headers(),
    signal: new AbortController().signal,
    payload: { logger: { error: vi.fn() } },
    ...changes,
  }) as unknown as PayloadRequest;
const invoke = async (open: OperatorMediaCall, req: PayloadRequest) => {
  const endpoint = createCommunityEndpoints(undefined, open).find(
    (e) => e.path === route,
  )!;
  return await endpoint.handler(req);
};
const media = (type = "image/webp"): OperatorMediaResponse => ({
  status: 200,
  contentType: type,
  contentLength: "4",
  contentRange: null,
  acceptsRanges: false,
  body: new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array([1, 2, 3, 4]));
      stream.close();
    },
  }),
});

describe("Operator comment media boundary", () => {
  it("requires Owner before parsing or transport", async () => {
    const open = vi.fn<OperatorMediaCall>();
    for (const role of [null, "automation"] as const)
      expect((await invoke(open, request(role))).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });
  it("refuses malformed associations, queries, source variants and invalid ranges", async () => {
    const open = vi.fn<OperatorMediaCall>();
    for (const params of [
      { commentId: "../other", itemId, variant: "display" },
      { commentId, itemId: "source-object", variant: "display" },
      { commentId, itemId, variant: "original" },
      { commentId, itemId, variant: "motion" },
    ])
      expect(
        (await invoke(open, request("owner", { routeParams: params }))).status,
      ).toBe(400);
    expect(
      (
        await invoke(
          open,
          request("owner", { url: "http://admin.test/?source=other" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invoke(
          open,
          request("owner", {
            headers: new Headers({ range: "bytes=0-1,4-5" }),
          }),
        )
      ).status,
    ).toBe(416);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["thumb", "display", "full"])(
    "relays the exact authorized %s association",
    async (variant) => {
      const open = vi.fn<OperatorMediaCall>().mockResolvedValue(media());
      const req = request("owner", {
        routeParams: { commentId, itemId, variant },
      });
      const result = await invoke(open, req);
      expect(open).toHaveBeenCalledWith(
        `comments/${commentId}/images/${itemId}/${variant}`,
        null,
        req.signal,
      );
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(result.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      expect((await result.arrayBuffer()).byteLength).toBe(4);
    },
  );
  it("never embeds an unexpected document type", async () => {
    const open = vi
      .fn<OperatorMediaCall>()
      .mockResolvedValue(media("image/svg+xml"));
    expect((await invoke(open, request())).status).toBe(502);
  });
});
