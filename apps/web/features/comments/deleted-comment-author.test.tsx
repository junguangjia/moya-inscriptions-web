// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { CatalogComment, DiscussionComment } from "@moya/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => window.location.pathname,
}));

import { ColophonEntry } from "../authors/feed-colophon-entry";
import type { ColophonInteractions } from "../authors/feed-colophon-entry";
import { rootRow } from "../authors/use-discussion-thread";
import { CommentSection } from "./comment-section";
import { DELETED_AUTHOR_NAME } from "./comment-types";
import type { CommentItem } from "./comment-types";
import { toCommentItemPresentation } from "./live-comments";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// account-deletion-v1. Synthetic authors only.
const deletedAuthor = {
  id: `user-${"d".repeat(32)}`,
  displayName: "已注销用户",
  deleted: true as const,
};
const liveAuthor = {
  id: `user-${"e".repeat(32)}`,
  displayName: "拓片爱好者",
  studioName: "听雨轩",
};
const now = new Date("2026-10-27T12:00:00.000Z");
const catalogComment = {
  id: `comment-${"1".repeat(32)}`,
  catalogId: "catalog-one",
  author: deletedAuthor,
  text: "保留下来的评论文字",
  createdAt: "2026-10-27T11:00:00.000Z",
  replies: [
    {
      id: `comment-${"2".repeat(32)}`,
      author: liveAuthor,
      text: "仍然可见的回复",
      createdAt: "2026-10-27T11:30:00.000Z",
      replyTo: deletedAuthor,
    },
  ],
  replyTotal: 1,
} as CatalogComment;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
const mount = async (element: ReactNode) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(element));
  return node;
};

describe("deleted comment authors", () => {
  it("present the anonymized name, no studio name and the deleted mark", () => {
    const item = toCommentItemPresentation(catalogComment, now);
    expect(item.user).toEqual({
      avatarSrc: null,
      deleted: true,
      id: deletedAuthor.id,
      name: DELETED_AUTHOR_NAME,
    });
    expect(item.text).toBe("保留下来的评论文字");
    expect(item.replies[0]!.user).toMatchObject({
      name: "拓片爱好者",
      studioName: "听雨轩",
    });
    expect(item.replies[0]!.user.deleted).toBeUndefined();
    expect(item.replies[0]!.replyToUser).toMatchObject({
      deleted: true,
      name: DELETED_AUTHOR_NAME,
    });
  });

  it("map the same way in work and article discussions", () => {
    const discussion = {
      id: catalogComment.id,
      author: { ...deletedAuthor, displayName: "旧昵称不应出现" },
      text: "保留",
      createdAt: catalogComment.createdAt,
      likeCount: 0,
      liked: false,
      deleted: false,
      replies: [
        {
          id: `comment-${"3".repeat(32)}`,
          author: liveAuthor,
          text: "回复",
          createdAt: catalogComment.createdAt,
          likeCount: 0,
          liked: false,
          deleted: false,
          replyTo: deletedAuthor,
        },
      ],
      replyTotal: 1,
      replyPageTotal: 1,
    } as unknown as DiscussionComment;
    const row = rootRow(discussion);
    expect(row.user).toEqual({
      id: deletedAuthor.id,
      name: DELETED_AUTHOR_NAME,
      deleted: true,
    });
    expect(row.replies[0]!.user.deleted).toBeUndefined();
    expect(row.replies[0]!.replyToUser).toEqual({
      id: deletedAuthor.id,
      name: DELETED_AUTHOR_NAME,
      deleted: true,
    });
  });

  it("keep the text in a comment section but open no profile", async () => {
    const onOpenAuthor = vi.fn();
    const item = toCommentItemPresentation(catalogComment, now);
    const node = await mount(
      <CommentSection
        presentation="live"
        currentUser={{ id: `user-${"f".repeat(32)}`, name: "读者" }}
        items={[item]}
        hotItems={[]}
        viewer={{ state: "signed-in" }}
        onOpenAuthor={onOpenAuthor}
        onSendComment={() => {}}
        onSendReply={() => {}}
      />,
    );
    expect(node.textContent).toContain("保留下来的评论文字");
    expect(node.textContent).toContain(DELETED_AUTHOR_NAME);
    const labels = Array.from(node.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain(`打开${DELETED_AUTHOR_NAME}的主页`);
    expect(labels).toContain("打开拓片爱好者的主页");
    const names = Array.from(node.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes(DELETED_AUTHOR_NAME),
    );
    expect(names).toEqual([]);
    expect(onOpenAuthor).not.toHaveBeenCalled();
  });

  it("keep the text in a colophon but open no profile", async () => {
    const openAuthor = vi.fn();
    const item: CommentItem = toCommentItemPresentation(catalogComment, now);
    const interactions: ColophonInteractions = {
      actorId: `user-${"f".repeat(32)}`,
      now,
      flashId: null,
      expanded: new Set(),
      repliesLoading: new Set(),
      canReply: true,
      toggleFold: vi.fn(),
      reply: vi.fn(),
      like: vi.fn(),
      remove: vi.fn(),
      moreReplies: vi.fn(),
      openAuthor,
    };
    const node = await mount(
      <ol>
        <ColophonEntry comment={item} interactions={interactions} />
      </ol>,
    );
    expect(node.textContent).toContain("保留下来的评论文字");
    const authors = node.querySelectorAll("[data-colophon-author]");
    expect(authors).toHaveLength(2);
    expect(authors[0]!.tagName).toBe("SPAN");
    expect(authors[0]!.getAttribute("aria-label")).toBeNull();
    expect(authors[1]!.tagName).toBe("BUTTON");
    expect(authors[1]!.getAttribute("aria-label")).toBe("打开拓片爱好者的主页");
    expect(node.textContent).toContain(`回复 ${DELETED_AUTHOR_NAME}：`);
  });
});
