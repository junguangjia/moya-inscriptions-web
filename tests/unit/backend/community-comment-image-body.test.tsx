// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommentImageBody } from "admin/community-comment-image-body";
import type { OperatorComment } from "@moya/contracts/internal/community-operator";

const commentId = "comment-" + "a".repeat(32);
const image = (id: string, offset: number) => ({
  id: "media-item-" + id.repeat(32),
  offset,
  width: 640,
  height: 480,
  thumbSrc: `/api/community-moderation/comment-media/${commentId}/media-item-${id.repeat(32)}/thumb`,
  src: `/api/community-moderation/comment-media/${commentId}/media-item-${id.repeat(32)}/display`,
  fullSrc: `/api/community-moderation/comment-media/${commentId}/media-item-${id.repeat(32)}/full`,
});
afterEach(cleanup);

describe("operator inline comment images", () => {
  it("shows start, middle and end pictures without changing the plain text", () => {
    const images: OperatorComment["images"] = [
      image("b", 0),
      image("c", 3),
      image("d", 5),
    ];
    const { container } = render(
      <p>
        <CommentImageBody text="甲😀乙丙" images={images} />
      </p>,
    );
    const paragraph = container.querySelector("p")!;
    expect(paragraph.textContent).toBe("甲😀乙丙");
    expect(
      [...paragraph.childNodes].map((n) =>
        n.nodeName === "A" ? "image" : n.textContent,
      ),
    ).toEqual(["image", "甲😀", "image", "乙丙", "image"]);
    expect(
      screen.getAllByRole("link").map((n) => n.getAttribute("href")),
    ).toEqual(images.map((n) => n.fullSrc));
    expect(container.querySelector("script")).toBeNull();
  });
  it("makes an image-only body reviewable", () => {
    render(<CommentImageBody text="" images={[image("b", 0)]} />);
    expect(screen.getByRole("img", { name: "评论附图 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看评论附图 1" })).toBeTruthy();
  });
  it("keeps a truthful retry link when an authorized thumbnail no longer loads", () => {
    render(<CommentImageBody text="正文" images={[image("b", 1)]} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("附图 1 暂不可用，点击重试")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      image("b", 1).fullSrc,
    );
  });
});
