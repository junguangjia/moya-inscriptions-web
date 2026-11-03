import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBackendApplication,
  createBackendServer,
  handleAuthorRequest,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { handleOperatorRequest } from "@moya/backend-runtime/internal/community-operator";
import type {
  AuthorCommunityService,
  CommunitySessionService,
  DiscussionPort,
} from "@moya/api";
import {
  catalogCommentSchema,
  catalogCommentReplySchema,
  discussionReplySchema,
} from "@moya/contracts/schemas";
import { COMMENT_IMAGE_CAPABILITY_HEADER as marker } from "@moya/contracts/comment-images-protocol";
import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import {
  InMemoryCommunityIdentityPort,
  fixtureUsers,
} from "./community-identity-fixture.js";

const id = "comment-" + "a".repeat(32),
  itemId = "media-item-" + "b".repeat(32);
const token = "EXPLICIT_SYNTHETIC_PLACEHOLDER".padEnd(43, "_");
const operatorCredential = "EXPLICIT_SYNTHETIC_PLACEHOLDER";
const item = {
  id,
  author: {
    id: fixtureUsers.active.id,
    displayName: fixtureUsers.active.displayName,
  },
  text: "",
  createdAt: "2026-11-03T00:00:00.000Z",
  images: [
    {
      id: itemId,
      offset: 0,
      width: 20,
      height: 10,
      thumbSrc: `/api/community/discussion/images/${id}/${itemId}/thumb`,
      src: `/api/community/discussion/images/${id}/${itemId}/display`,
    },
  ],
  likeCount: 0,
  liked: false,
  deleted: false,
};
const target = { type: "catalog" as const, id: publishedCatalogId };
const root = {
  ...item,
  target,
  replies: [item],
  replyTotal: 1,
  replyPageTotal: 1,
};
const page = {
  hot: [],
  items: [root],
  total: 1,
  visibleTotal: 2,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};
const oldReply = discussionReplySchema.omit({ images: true });
const oldCatalogReply = catalogCommentReplySchema
  .omit({ images: true })
  .extend({ text: catalogCommentReplySchema.shape.text.min(1) });
const oldCatalog = catalogCommentSchema.omit({ images: true }).extend({
  text: catalogCommentReplySchema.shape.text.min(1),
  replies: oldCatalogReply.array(),
});
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopServer(server)));
});
const listen = async (server: Server) => {
  servers.push(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}`;
};
const negotiation = (version?: string) =>
  version === undefined ? {} : { [marker]: version };

describe("comment response capability negotiation", () => {
  it("negotiates author list/replies/submit/history after auth and preserves existing Vary", async () => {
    const submit = vi.fn(async () => ({
      id,
      rootId: id,
      item,
      awaitingApproval: false,
    }));
    const service = {
      discussion: {
        readDiscussion: async () => page,
        readDiscussionReplies: async () => ({ ...page, items: [item] }),
        submitDiscussion: submit,
      },
      assertTarget: async () => {},
      ownComments: async () => ({
        items: [
          {
            id,
            rootId: id,
            text: "",
            images: item.images,
            createdAt: item.createdAt,
            deleted: false,
            target,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
      profile: async () => ({ images: ["unrelated-profile"] }),
    } as unknown as AuthorCommunityService;
    const sessions = {
      identify: async (value: string) =>
        value === token ? fixtureUsers.active : null,
    } as unknown as CommunitySessionService;
    const base = await listen(
      createServer((request, response) => {
        response.setHeader("vary", "Cookie");
        void handleAuthorRequest(request, response, service, sessions);
      }),
    );
    const path = `/v1/community/discussion/catalog/${publishedCatalogId}`;
    for (const version of [undefined, "1"]) {
      const response = await fetch(base + path, {
        headers: negotiation(version),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe(
        `Cookie, Authorization, ${marker}`,
      );
      const body = await response.json();
      expect(body.items[0].text).toBe(
        version === "1" ? "" : "【此条含附图，请刷新页面查看】",
      );
      expect(Object.hasOwn(body.items[0], "images")).toBe(version === "1");
      const replies = await fetch(`${base}${path}/replies/${id}`, {
        headers: negotiation(version),
      });
      const reply = (await replies.json()).items[0];
      if (version !== "1") oldReply.parse(reply);
      else expect(reply.images).toEqual(item.images);
      const submitted = await fetch(base + path, {
        method: "POST",
        headers: {
          ...negotiation(version),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "",
          images: [{ itemId, offset: 0 }],
          requestId: "10000000-0000-4000-8000-000000000001",
        }),
      });
      expect(submitted.status).toBe(201);
      expect((await submitted.json()).item.text).toBe(
        version === "1" ? "" : "【此条含附图，请刷新页面查看】",
      );
      const own = await fetch(`${base}/v1/community/me/comments`, {
        headers: { ...negotiation(version), authorization: `Bearer ${token}` },
      });
      expect(Object.hasOwn((await own.json()).items[0], "images")).toBe(
        version === "1",
      );
    }
    expect(item.text).toBe("");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      (
        await fetch(base + path, {
          method: "POST",
          headers: { [marker]: "1", "content-type": "application/json" },
          body: JSON.stringify({ text: "denied" }),
        })
      ).status,
    ).toBe(401);
    expect(submit).toHaveBeenCalledTimes(2);
    const profile = await fetch(
      `${base}/v1/community/authors/${fixtureUsers.active.id}`,
      { headers: { [marker]: "1" } },
    );
    expect(await profile.json()).toEqual({ images: ["unrelated-profile"] });
    expect(profile.headers.get("vary")).toBe("Authorization");
  });

  it("keeps legacy Catalog GET and POST compatible without requiring the marker on writes", async () => {
    const submit = vi.fn(async () => ({
      id,
      rootId: id,
      item,
      awaitingApproval: false,
    }));
    const app = createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      communityCommentPort: new InMemoryCommunityCommentPort(),
      catalogPublicationPort: new FixtureCatalogPublicationPort(),
      discussionPort: {
        readDiscussion: async () => page,
        readDiscussionReplies: async () => ({ ...page, items: [item] }),
        submitDiscussion: submit,
      } as unknown as DiscussionPort,
    });
    const base = await listen(createBackendServer(app));
    const signIn = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: fixtureUsers.active.handle }),
    });
    const session = await signIn.json();
    const path = `${base}/v1/catalog/${publishedCatalogId}/comments`;
    for (const version of [undefined, "1"]) {
      const list = await fetch(path, { headers: negotiation(version) });
      expect(list.headers.get("vary")).toContain(marker);
      const body = await list.json();
      if (version === "1") expect(body.items[0].images).toEqual(item.images);
      else oldCatalog.parse(body.items[0]);
      for (const url of [path, `${path}/${id}/replies`]) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...negotiation(version),
            authorization: `Bearer ${session.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "",
            images: [{ itemId, offset: 0 }],
            requestId: "10000000-0000-4000-8000-000000000001",
          }),
        });
        expect(response.status).toBe(201);
        const created = await response.json();
        if (version === "1") expect(created.images).toEqual(item.images);
        else expect(created.text).toBe("【此条含附图，请刷新页面查看】");
        expect(response.headers.get("vary")).toContain(marker);
      }
    }
    expect(submit).toHaveBeenCalledTimes(4);
    expect(item.text).toBe("");
  });

  it("negotiates Owner comment JSON only after its existing credential gate", async () => {
    const readComments = vi.fn(async () => ({ items: [item] }));
    const base = await listen(
      createServer((request, response) => {
        void handleOperatorRequest(
          request,
          response,
          new URL(request.url ?? "/", "http://synthetic.invalid").pathname,
          {
            operatorCredential,
            moderationService: {
              readComments,
              readCommentDetail: async () => ({
                item,
                root: item,
                replyTo: item,
              }),
            },
          } as unknown as Parameters<typeof handleOperatorRequest>[3],
        );
      }),
    );
    for (const version of [undefined, "1"]) {
      for (const path of [
        "/internal/community/comments",
        `/internal/community/comments/${id}`,
      ]) {
        const response = await fetch(base + path, {
          headers: {
            ...negotiation(version),
            authorization: `Bearer ${operatorCredential}`,
          },
        });
        expect(response.status).toBe(200);
        const body = await response.json(),
          comment = body.items?.[0] ?? body.item;
        expect(Object.hasOwn(comment, "images")).toBe(version === "1");
        expect(comment.text).toBe(
          version === "1" ? "" : "【此条含附图，请刷新页面查看】",
        );
        expect(response.headers.get("vary")).toContain(marker);
      }
    }
    expect(
      (
        await fetch(`${base}/internal/community/comments`, {
          headers: { [marker]: "1" },
        })
      ).status,
    ).toBe(401);
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(item.text).toBe("");
  });
});
