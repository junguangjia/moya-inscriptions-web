import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityNotFoundError } from "@moya/api";
import type {
  AuthorCommunityService,
  CommunitySessionService,
  WorkPublishingService,
  PublishingOperatorService,
} from "@moya/api";
import { handleAuthorRequest } from "@moya/backend-runtime";
import { handleOperatorRequest } from "@moya/backend-runtime/internal/community-operator";
const syntheticOperator = "EXPLICIT_SYNTHETIC_PLACEHOLDER";
const commentId = "comment-" + "a".repeat(32),
  itemId = "media-item-" + "b".repeat(32);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (s) =>
          new Promise<void>((resolve, reject) =>
            s.close((e) => (e ? reject(e) : resolve())),
          ),
      ),
  );
});
const start = async (handler: RequestListener) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing synthetic listener");
  return `http://127.0.0.1:${address.port}`;
};
const delivery = () => ({
  contentType: "image/webp",
  sha256: "a".repeat(64),
  read: {
    status: "ok",
    byteSize: 3,
    start: 0,
    end: 2,
    contentLength: 3,
    body: (async function* () {
      yield Uint8Array.from([1, 2, 3]);
    })(),
    close: async () => {},
  },
});
describe("#358 private image transport", () => {
  it("checks target and comment before every GET/HEAD, rejects unrelated IDs and queries, never caches bytes", async () => {
    let allowed = true,
      targetAllowed = true;
    const resolve = vi.fn(async () =>
      allowed
        ? {
            storageKey: "synthetic-only",
            contentType: "image/webp",
            byteSize: 3,
            sha256: "a".repeat(64),
          }
        : null,
    );
    const service = {
      discussion: {
        discussionTarget: async () => ({
          type: "work",
          id: "work-" + "a".repeat(32),
        }),
        resolveDiscussionImage: resolve,
      },
      assertTarget: async () => {
        if (!targetAllowed) throw new CommunityNotFoundError();
      },
    } as unknown as AuthorCommunityService;
    const sessions = {
      identify: async () => null,
    } as unknown as CommunitySessionService;
    const publishing = {
      openAuthorizedMedia: async () => delivery(),
    } as unknown as WorkPublishingService;
    const base = await start((req, res) => {
      void handleAuthorRequest(req, res, service, sessions, publishing);
    });
    const url = `${base}/v1/community/discussion/images/${commentId}/${itemId}/display`;
    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(get.headers.get("vary")).toBe("Authorization");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(resolve).toHaveBeenCalledTimes(2);
    allowed = false;
    expect((await fetch(url)).status).toBe(404);
    allowed = true;
    targetAllowed = false;
    expect((await fetch(url)).status).toBe(404);
    targetAllowed = true;
    expect((await fetch(url + "?operator=true")).status).toBe(422);
    expect((await fetch(url.replace(itemId, "invalid"))).status).toBe(422);
    const calls = resolve.mock.calls.length;
    expect((await fetch(url.replace(commentId, "%2e%2e%2fother"))).status).toBe(
      422,
    );
    expect(resolve).toHaveBeenCalledTimes(calls);
  });
  it("keeps the existing operator credential gate before attachment review", async () => {
    const resolve = vi.fn(async () => ({
      storageKey: "synthetic-only",
      contentType: "image/webp",
      byteSize: 3,
      sha256: "a".repeat(64),
    }));
    const dependencies = {
      operatorCredential: syntheticOperator,
      moderationService: {
        readCommentDetail: async () => ({ item: { catalogId: null } }),
      },
      discussionPort: {
        discussionTarget: async () => ({
          type: "work",
          id: "work-" + "a".repeat(32),
        }),
        resolveDiscussionImage: resolve,
      },
      publishingOperatorService: {
        openAuthorizedMedia: async () => delivery(),
      } as unknown as PublishingOperatorService,
    } as unknown as Parameters<typeof handleOperatorRequest>[3];
    const pathname = `/internal/community/comments/${commentId}/images/${itemId}/display`;
    const base = await start((req, res) => {
      void handleOperatorRequest(
        req,
        res,
        new URL(req.url ?? "/", "http://synthetic.invalid").pathname,
        dependencies,
      );
    });
    expect((await fetch(base + pathname)).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    const response = await fetch(base + pathname, {
      headers: { authorization: `Bearer ${syntheticOperator}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await response.arrayBuffer();
    expect(resolve).toHaveBeenCalledWith(
      commentId,
      itemId,
      "display",
      null,
      true,
    );
  });
});
