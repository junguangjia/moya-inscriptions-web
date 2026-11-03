import { describe, expect, it } from "vitest";
import { validCommentImageOffsets } from "../../lib/public-api/comment-images-client";
import {
  commentImageBoundary,
  commentImageInputs,
  commentImagePositionLabel,
  moveCommentImageToCaret,
  normalizeCommentImageDraft,
  rebaseCommentImageAnchors,
  reorderCommentImageAnchors,
} from "./comment-image-draft";

const image = (digit: string, offset: number) => ({
  itemId: `media-item-${digit.repeat(32)}`,
  offset,
});

describe("comment image draft anchors", () => {
  it("normalizes leading/trailing whitespace and CRLF without splitting an emoji", () => {
    const raw = " \r\n甲😀\r\n乙 \r\n";
    const result = commentImageInputs(raw, [
      image("1", 3),
      image("2", 5),
      image("3", 6),
      image("4", 8),
      image("5", 10),
    ]);
    expect(result).toEqual({
      text: "甲😀\n乙",
      images: [
        image("1", 0),
        image("2", 1),
        image("3", 3),
        image("4", 4),
        image("5", 5),
      ],
    });
    expect(validCommentImageOffsets(result.text, result.images)).toBe(true);
  });

  it("keeps same-position images before text typed after insertion", () => {
    const anchors = [
      { key: "a", offset: 1 },
      { key: "b", offset: 1 },
      { key: "c", offset: 2 },
    ];
    expect(rebaseCommentImageAnchors("甲乙", "甲新乙", anchors)).toEqual([
      { key: "a", offset: 1 },
      { key: "b", offset: 1 },
      { key: "c", offset: 3 },
    ]);
    expect(rebaseCommentImageAnchors("甲乙", "前甲乙", anchors)).toEqual([
      { key: "a", offset: 2 },
      { key: "b", offset: 2 },
      { key: "c", offset: 3 },
    ]);
  });

  it("collapses deleted content and preserves attachment order", () => {
    expect(
      rebaseCommentImageAnchors("abcdef", "abf", [
        { key: "a", offset: 2 },
        { key: "b", offset: 3 },
        { key: "c", offset: 4 },
        { key: "d", offset: 5 },
        { key: "e", offset: 6 },
      ]),
    ).toEqual([
      { key: "a", offset: 2 },
      { key: "b", offset: 2 },
      { key: "c", offset: 2 },
      { key: "d", offset: 2 },
      { key: "e", offset: 3 },
    ]);
  });

  it("expands an edit that shares a high surrogate instead of anchoring inside it", () => {
    const result = rebaseCommentImageAnchors("甲😀乙", "甲😃乙", [
      image("1", 1),
      image("2", 3),
      image("3", 4),
    ]);
    expect(result).toEqual([image("1", 1), image("2", 3), image("3", 4)]);
    expect(validCommentImageOffsets("甲😃乙", result)).toBe(true);
    expect(commentImageBoundary("甲😀乙", 2)).toBe(1);
    expect(commentImageBoundary("甲😀乙", Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("moves to the caret after existing same-position images and reorders only ties", () => {
    const anchors = [
      { key: "a", offset: 0 },
      { key: "b", offset: 1 },
      { key: "c", offset: 1 },
    ];
    const moved = moveCommentImageToCaret("甲乙", anchors, "a", 1);
    expect(moved).toEqual([
      { key: "b", offset: 1 },
      { key: "c", offset: 1 },
      { key: "a", offset: 1 },
    ]);
    expect(
      reorderCommentImageAnchors(moved, "a", -1).map(({ key }) => key),
    ).toEqual(["b", "a", "c"]);
    expect(reorderCommentImageAnchors(anchors, "b", -1)).toEqual(anchors);
  });

  it("supports image-only drafts without invented text and describes human character positions", () => {
    expect(
      normalizeCommentImageDraft(" \r\n ", [{ key: "a", offset: 4 }]),
    ).toEqual({ text: "", images: [{ key: "a", offset: 0 }] });
    expect(commentImagePositionLabel("😀甲乙", 2)).toBe("正文第 1 个字符后");
    expect(commentImagePositionLabel("😀甲乙", 0)).toBe("正文开头");
    expect(commentImagePositionLabel("😀甲乙", 4)).toBe("正文末尾");
  });
});
