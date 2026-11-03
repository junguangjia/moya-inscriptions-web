import { describe, expect, it } from "vitest";
import {
  COMMENT_IMAGE_CAPABILITY_HEADER,
  COMMENT_IMAGE_CAPABILITY_VERSION,
  commentImagePayloadFor,
} from "@moya/contracts/comment-images-protocol";
import {
  catalogCommentReplySchema,
  catalogCommentSchema,
  discussionReplySchema,
  discussionCommentSchema,
  discussionPageSchema,
  ownCommentSchema,
} from "@moya/contracts/schemas";
import {
  operatorCommentSchema,
  operatorCommentPageSchema,
  operatorCommentDetailSchema,
} from "@moya/contracts/internal/community-operator";

const hint = "【此条含附图，请刷新页面查看】";
const time = "2026-11-03T00:00:00.000Z";
const user = { id: "user-" + "a".repeat(32), displayName: "合成作者" };
const target = { type: "work" as const, id: "work-" + "d".repeat(32) };
const imageFor = (id: string, operator = false) => ({
  id: "media-item-" + "e".repeat(32),
  offset: 0,
  width: 40,
  height: 20,
  thumbSrc: `${operator ? "/api/community-moderation/comment-media" : "/api/community/discussion/images"}/${id}/media-item-${"e".repeat(32)}/thumb`,
  src: `${operator ? "/api/community-moderation/comment-media" : "/api/community/discussion/images"}/${id}/media-item-${"e".repeat(32)}/display`,
});
const reply = (hex: string, text: string) => {
  const id = "comment-" + hex.repeat(32);
  return {
    id,
    author: user,
    text,
    images: [imageFor(id)],
    createdAt: time,
    likeCount: 0,
    liked: false,
    deleted: false,
  };
};
// Actual pre-image strict shapes: Catalog/Owner required nonempty text;
// Discussion and own-history already allowed empty text before #358.
const exactOldText = catalogCommentReplySchema.shape.text.min(1);
const oldCatalogReply = catalogCommentReplySchema
  .omit({ images: true })
  .extend({ text: exactOldText });
const oldCatalogRoot = catalogCommentSchema
  .omit({ images: true })
  .extend({ text: exactOldText, replies: oldCatalogReply.array() });
const oldReply = discussionReplySchema.omit({ images: true });
const oldRoot = discussionCommentSchema
  .omit({ images: true })
  .extend({ replies: oldReply.array() });
const oldPage = discussionPageSchema.extend({
  hot: oldRoot.array(),
  items: oldRoot.array(),
});
const oldOwn = ownCommentSchema.omit({ images: true });
const oldOperator = operatorCommentSchema
  .omit({ images: true })
  .extend({ text: operatorCommentSchema.shape.text.min(1) });
const oldOperatorPage = operatorCommentPageSchema.extend({
  items: oldOperator.array(),
});
const oldOperatorDetail = operatorCommentDetailSchema.extend({
  item: oldOperator,
  root: oldOperator.nullable(),
  replyTo: oldOperator.nullable(),
});

describe("comment image response representation", () => {
  it("exports one opt-in marker and returns version 1 canonical data unchanged", () => {
    expect(COMMENT_IMAGE_CAPABILITY_HEADER).toBe("x-yoyi-comment-images");
    expect(COMMENT_IMAGE_CAPABILITY_VERSION).toBe("1");
    const canonical = Object.freeze(reply("a", ""));
    expect(commentImagePayloadFor("1", canonical)).toBe(canonical);
    expect(canonical.text).toBe("");
  });
  it.each([undefined, null, 1, "2", ["1"], "1, 1"])(
    "uses legacy display-only image text for marker %j",
    (version) => {
      const canonical = reply("a", "");
      Object.freeze(canonical.images);
      Object.freeze(canonical);
      const legacy = commentImagePayloadFor(version, canonical);
      expect(oldReply.parse(legacy)).toMatchObject({ text: hint });
      expect(legacy).not.toHaveProperty("images");
      expect(canonical.text).toBe("");
      expect(canonical.images).toHaveLength(1);
    },
  );
  it("preserves original nonempty text and mentions while removing even empty image arrays", () => {
    const canonical = {
      ...reply("a", "甲 @乙 😀\n丙"),
      images: [],
      mentions: [{ userId: user.id, start: 2, end: 4 }],
    };
    const projected = commentImagePayloadFor(undefined, canonical);
    expect(projected).toEqual({
      id: canonical.id,
      author: user,
      text: canonical.text,
      mentions: canonical.mentions,
      createdAt: time,
      likeCount: 0,
      liked: false,
      deleted: false,
    });
    expect(canonical).toHaveProperty("images");
  });
  it("retains page membership, hot order, reply order and exact totals for historical strict readers", () => {
    const hot = {
      ...reply("a", "热评"),
      target,
      images: [],
      replies: [],
      replyTotal: 0,
      replyPageTotal: 0,
    };
    const item = {
      ...reply("b", ""),
      target,
      replies: [reply("c", ""), reply("d", "原文")],
      replyTotal: 2,
      replyPageTotal: 2,
    };
    const page = {
      hot: [hot],
      items: [item],
      visibleTotal: 4,
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    };
    expect(oldPage.safeParse(page).success).toBe(false);
    const old = oldPage.parse(commentImagePayloadFor(undefined, page));
    expect(old.hot.map((item) => item.id)).toEqual([hot.id]);
    expect(old.items.map((item) => item.id)).toEqual([item.id]);
    expect(old.items[0]!.replies.map((item) => item.text)).toEqual([
      hint,
      "原文",
    ]);
    expect(old).toMatchObject({
      visibleTotal: 4,
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    expect(
      discussionPageSchema.parse(commentImagePayloadFor("1", page)),
    ).toEqual(page);
    expect(page.items[0]!.text).toBe("");
  });
  it("projects direct legacy Catalog bodies and empty deleted history without storing placeholders", () => {
    const base = reply("a", ""),
      nested = reply("b", "");
    const catalog = {
      id: base.id,
      catalogId: "catalog-synthetic",
      author: user,
      text: "",
      images: base.images,
      createdAt: time,
      replies: [
        {
          id: nested.id,
          author: user,
          text: "",
          images: nested.images,
          createdAt: time,
        },
      ],
      replyTotal: 1,
    };
    expect(
      oldCatalogRoot.parse(commentImagePayloadFor(undefined, catalog)),
    ).toMatchObject({ text: hint, replies: [{ text: hint }] });
    const own = {
      id: base.id,
      rootId: base.id,
      text: "",
      images: [],
      createdAt: time,
      deleted: true,
      target: null,
    };
    expect(oldOwn.parse(commentImagePayloadFor(undefined, own))).toMatchObject({
      text: "This comment has been deleted",
      deleted: true,
    });
    expect(own.text).toBe("");
    expect(commentImagePayloadFor("1", own)).toBe(own);
  });
  it("keeps Owner list and item/root/replyTo detail compatible with the old strict DTO", () => {
    const base = reply("a", "");
    const item = {
      id: base.id,
      kind: "comment",
      catalogId: null,
      target,
      catalogTitle: null,
      text: "",
      images: [imageFor(base.id, true)],
      author: { ...user, handle: "synthetic-author", status: "active" },
      createdAt: time,
      moderation: "hidden",
    };
    const page = {
      items: [item],
      counts: { pending: 0, visible: 0, hidden: 1, all: 1 },
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    };
    expect(
      oldOperatorPage.parse(commentImagePayloadFor(undefined, page)).items[0]!
        .text,
    ).toBe(hint);
    const detail = {
      item,
      root: item,
      replyTo: item,
      parentRestriction: "root_hidden",
      history: [],
      analysis: { status: "not_connected" },
    };
    const projected = oldOperatorDetail.parse(
      commentImagePayloadFor(undefined, detail),
    );
    expect([
      projected.item.text,
      projected.root?.text,
      projected.replyTo?.text,
    ]).toEqual([hint, hint, hint]);
    expect(item.text).toBe("");
  });
  it("walks only comment containers and does not strip unrelated images or retained snapshots", () => {
    const comment = reply("a", "");
    const media = {
      id: "media-item-" + "e".repeat(32),
      text: "caption",
      images: [{ src: "unrelated" }],
    };
    const payload = {
      result: { comment },
      data: { item: comment },
      items: [media],
      auth: { images: ["unchanged"] },
      snapshot: comment,
      metadata: { comment },
      images: ["not-a-comment-body"],
    };
    const result = commentImagePayloadFor(undefined, payload) as typeof payload;
    expect(result.result.comment.text).toBe(hint);
    expect(result.data.item.text).toBe(hint);
    expect(result.items[0]).toBe(media);
    expect(result.auth).toBe(payload.auth);
    expect(result.snapshot).toBe(comment);
    expect(result.metadata).toBe(payload.metadata);
    expect(result.images).toBe(payload.images);
    expect(
      commentImagePayloadFor(undefined, { text: "", images: ["unrelated"] }),
    ).toEqual({ text: "", images: ["unrelated"] });
  });
});
