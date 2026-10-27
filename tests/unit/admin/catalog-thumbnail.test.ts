import { describe, expect, it, vi } from "vitest";
import type { PayloadRequest } from "payload";
import { catalogThumbnailURL } from "admin/media-thumbnail";
import { createCatalogThumbnailEndpoint } from "admin/media-thumbnail-endpoint";
import { CommunityOperatorError } from "admin/community-endpoints";
import type { OperatorMediaCall } from "admin/community-endpoints";

const source = {
  mediaId: "synthetic-small-image",
  objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"c".repeat(64)}.jpg`,
  sourceSha256: "c".repeat(64),
};
const uri = `/api/catalog-media-thumbnail?${new URLSearchParams(source)}`;
const req = (role: string | null, query = uri): PayloadRequest =>
  ({
    url: `http://catalog.example.invalid${query}`,
    user: role ? { collection: "users", role } : null,
    signal: new AbortController().signal,
  }) as PayloadRequest;
const open = () =>
  vi.fn<OperatorMediaCall>(async () => ({
    status: 200,
    contentType: "image/webp",
    contentLength: "3",
    contentRange: null,
    acceptsRanges: false,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    }),
  }));

describe("private existing Catalog thumbnails", () => {
  it("derives the native thumbnail locator synchronously without changing or falling back to the original", () => {
    const doc = {
      ...source,
      sha256: source.sourceSha256,
      url: "/api/media/file/original.jpg",
    };
    expect(catalogThumbnailURL(doc)).toBe(uri);
    expect(catalogThumbnailURL({ url: doc.url })).not.toContain("original");
    expect(doc.url).toBe("/api/media/file/original.jpg");
  });
  it.each([null, "automation"])(
    "refuses %s before reading bytes",
    async (role) => {
      const read = open();
      expect(
        (await createCatalogThumbnailEndpoint(read).handler(req(role))).status,
      ).toBe(403);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each([
    `${uri}&storageKey=other`,
    `${uri}&mediaId=other`,
    "/api/catalog-media-thumbnail",
  ])("rejects malformed or duplicate identity %s", async (url) => {
    const read = open();
    expect(
      (await createCatalogThumbnailEndpoint(read).handler(req("owner", url)))
        .status,
    ).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("relays the bounded derivative with private headers and viewer cancellation", async () => {
    const read = open();
    const request = req("owner");
    const response =
      await createCatalogThumbnailEndpoint(read).handler(request);
    expect(read).toHaveBeenCalledWith(
      `catalog-delivery/thumbnail?${new URLSearchParams(source)}`,
      null,
      request.signal,
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
  it.each([404, 503])(
    "returns %s without redirecting to an original",
    async (status) => {
      const read = open();
      read.mockRejectedValue(new CommunityOperatorError("NOT_FOUND", status));
      const response = await createCatalogThumbnailEndpoint(read).handler(
        req("owner"),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBeNull();
    },
  );
});
