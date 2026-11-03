import { CatalogCommentService } from "@moya/api";
import type { DiscussionPort } from "@moya/api";
import type { CatalogCommentId, DiscussionReply } from "@moya/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  FixtureCatalogPublicationPort,
  InMemoryCommunityCommentPort,
  publishedCatalogId,
} from "./community-comment-fixture.js";
import { fixtureUsers } from "./community-identity-fixture.js";
const id = ("comment-" + "a".repeat(32)) as CatalogCommentId;
const itemId = "media-item-" + "b".repeat(32),
  requestId = "10000000-0000-4000-8000-000000000001";
const image = {
  id: itemId,
  offset: 0,
  width: 10,
  height: 10,
  thumbSrc: `/api/community/discussion/images/${id}/${itemId}/thumb`,
  src: `/api/community/discussion/images/${id}/${itemId}/display`,
};
const item: DiscussionReply = {
  id,
  author: fixtureUsers.active,
  text: "",
  images: [image],
  createdAt: "2026-11-02T00:00:00.000Z",
  likeCount: 0,
  liked: false,
  deleted: false,
};
describe("#358 legacy catalog route compatibility", () => {
  it("forwards image submissions and identities to the same canonical discussion path and returns image DTOs", async () => {
    const submit = vi.fn(async () => ({
      id,
      rootId: id,
      item,
      awaitingApproval: false,
    }));
    const discussion = {
      submitDiscussion: submit,
      readDiscussion: async () => ({
        hot: [],
        items: [
          {
            ...item,
            target: { type: "catalog", id: publishedCatalogId },
            replies: [],
            replyTotal: 0,
            replyPageTotal: 0,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        visibleTotal: 1,
      }),
    } as unknown as DiscussionPort;
    const service = new CatalogCommentService(
      new InMemoryCommunityCommentPort(),
      new FixtureCatalogPublicationPort(),
      { discussionPort: discussion },
    );
    const input = { text: "", images: [{ itemId, offset: 0 }], requestId };
    expect(
      (
        await service.createComment(
          publishedCatalogId,
          fixtureUsers.active.id,
          input,
        )
      ).item.images,
    ).toEqual([image]);
    expect(submit).toHaveBeenLastCalledWith(
      { type: "catalog", id: publishedCatalogId },
      fixtureUsers.active.id,
      "",
      undefined,
      undefined,
      undefined,
      input.images,
      requestId,
    );
    expect(
      (
        await service.createReply(
          publishedCatalogId,
          id,
          fixtureUsers.active.id,
          input,
        )
      ).item.images,
    ).toEqual([image]);
    expect(submit).toHaveBeenLastCalledWith(
      { type: "catalog", id: publishedCatalogId },
      fixtureUsers.active.id,
      "",
      id,
      undefined,
      undefined,
      input.images,
      requestId,
    );
    expect(
      (
        await service.readComments(publishedCatalogId, {
          page: 1,
          pageSize: 20,
        })
      ).items[0]?.images,
    ).toEqual([image]);
  });
  it("fails closed instead of dropping images when the legacy-only port is composed", async () => {
    const service = new CatalogCommentService(
      new InMemoryCommunityCommentPort(),
      new FixtureCatalogPublicationPort(),
    );
    await expect(
      service.createComment(publishedCatalogId, fixtureUsers.active.id, {
        text: "Keep this text",
        images: [{ itemId, offset: 0 }],
        requestId,
      }),
    ).rejects.toMatchObject({ name: "CommunityInputError" });
    expect(
      (
        await service.readComments(publishedCatalogId, {
          page: 1,
          pageSize: 20,
        })
      ).items,
    ).toEqual([]);
  });
});
