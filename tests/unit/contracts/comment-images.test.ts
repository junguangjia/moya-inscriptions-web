import { operatorCommentMediaRequestSchema } from "@moya/contracts/internal/community-operator";
import { describe, expect, it } from "vitest";
import {
  COMMENT_IMAGE_LIMITS,
  createCatalogCommentRequestSchema,
  createCatalogCommentReplyRequestSchema,
  registerMediaItemCommandSchema,
  validCommentImageOffsets,
  commentImageSchema,
} from "@moya/contracts/schemas";
const requestId = "10000000-0000-4000-8000-000000000001";
const itemId = "media-item-" + "a".repeat(32);
describe("#358 managed inline comment images", () => {
  it("keeps legacy text calls, requires an identity for image-only submissions, and validates normalized UTF16 boundaries", () => {
    expect(createCatalogCommentRequestSchema.parse({ text: "旧评论" })).toEqual(
      { text: "旧评论" },
    );
    expect(
      createCatalogCommentRequestSchema.safeParse({ text: "" }).success,
    ).toBe(false);
    expect(
      createCatalogCommentRequestSchema.safeParse({
        text: "",
        images: [{ itemId, offset: 0 }],
      }).success,
    ).toBe(false);
    expect(
      createCatalogCommentRequestSchema.parse({
        text: "",
        requestId,
        images: [{ itemId, offset: 0 }],
      }).images,
    ).toHaveLength(1);
    for (const schema of [
      createCatalogCommentRequestSchema,
      createCatalogCommentReplyRequestSchema,
    ]) {
      expect(
        schema.safeParse({
          text: "甲😀乙",
          requestId,
          images: [{ itemId, offset: 2 }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          text: "甲😀乙",
          requestId,
          images: [{ itemId, offset: 3 }],
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          text: "甲",
          requestId,
          images: [{ itemId, offset: 2 }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          text: "甲",
          requestId,
          images: [
            { itemId, offset: 1 },
            { itemId, offset: 1 },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      validCommentImageOffsets(" 甲\r\n😀 ", [{ itemId, offset: 4 }]),
    ).toBe(true);
    expect(
      validCommentImageOffsets("甲", [
        { itemId, offset: 1 },
        { itemId: "media-item-" + "b".repeat(32), offset: 0 },
      ]),
    ).toBe(false);
  });
  it("bounds static comment uploads independently of Work and disallows provider URLs", () => {
    const base = {
      requestId,
      purpose: "comment",
      holder: { sessionId: "publishing-session-" + "a".repeat(32) },
      kind: "static",
      qualityMode: "original",
      components: [
        {
          role: "still",
          byteSize: COMMENT_IMAGE_LIMITS.maxBytes,
          contentType: "image/png",
        },
      ],
    };
    expect(registerMediaItemCommandSchema.safeParse(base).success).toBe(true);
    expect(
      registerMediaItemCommandSchema.safeParse({
        ...base,
        components: [
          {
            ...base.components[0],
            byteSize: COMMENT_IMAGE_LIMITS.maxBytes + 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      registerMediaItemCommandSchema.safeParse({ ...base, kind: "live" })
        .success,
    ).toBe(false);
    expect(
      registerMediaItemCommandSchema.safeParse({
        ...base,
        holder: { draftId: "work-draft-" + "a".repeat(32) },
      }).success,
    ).toBe(false);
    expect(
      createCatalogCommentRequestSchema.safeParse({
        text: "甲",
        requestId,
        images: Array.from({ length: 7 }, (_, i) => ({
          itemId: `media-item-${String(i).padStart(32, "0")}`,
          offset: 0,
        })),
      }).success,
    ).toBe(false);
    expect(
      commentImageSchema.safeParse({
        id: itemId,
        offset: 0,
        width: 1,
        height: 1,
        thumbSrc: "https://example.test/image",
        src: "https://example.test/image",
      }).success,
    ).toBe(false);
  });
});

it("rejects traversal-shaped operator comment subjects before constructing a media path", () => {
  const itemId = "media-item-" + "a".repeat(32);
  for (const commentId of [
    "../other",
    "comment-abc",
    "%2e%2e%2fother",
    "comment-" + "a".repeat(32) + "/tail",
  ]) {
    expect(
      operatorCommentMediaRequestSchema.safeParse({
        commentId,
        itemId,
        variant: "display",
      }).success,
    ).toBe(false);
  }
  expect(
    operatorCommentMediaRequestSchema.safeParse({
      commentId: "comment-" + "b".repeat(32),
      itemId,
      variant: "display",
    }).success,
  ).toBe(true);
});
