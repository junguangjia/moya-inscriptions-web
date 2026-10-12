// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeedPostActions } from "./feed-post-actions";
import type { FeedPostTrailingAction } from "./feed-post-actions";
import { quickActionContentKey } from "./quick-action-types";

import type { Root } from "react-dom/client";
import type {
  ContentQuickActionEnvironment,
  QuickActionContent,
} from "./quick-action-types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const content: QuickActionContent = {
  kind: "work",
  id: `work-${"a".repeat(32)}`,
  title: "九成宫醴泉铭",
};
const key = quickActionContentKey(content);

const roots: Root[] = [];
const render = (
  environment: ContentQuickActionEnvironment | null,
  onComment = vi.fn(),
  trailing?: FeedPostTrailingAction,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <FeedPostActions
        content={content}
        environment={environment}
        onComment={onComment}
        trailing={trailing}
      />,
    ),
  );
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
  return { container, button };
};

const environment = (
  overrides: Partial<ContentQuickActionEnvironment> = {},
): ContentQuickActionEnvironment => ({
  onAction: vi.fn(),
  likedIds: [],
  favoriteIds: [],
  ...overrides,
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("FeedPostActions", () => {
  it("orders like, comment, share and favorite and formats counts", () => {
    const { container } = render(
      environment({
        likeCount: 9410,
        favoriteCount: 188,
        commentCount: 12,
        ready: true,
      }),
    );
    expect(
      [...container.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["喜欢", "评论", "分享", "收藏"]);
    expect(
      container.querySelector('[data-feed-post-count="comment"]')?.textContent,
    ).toBe("12");
    expect(
      container.querySelector('[data-feed-post-count="like"]')?.textContent,
    ).toBe("9,410");
    expect(
      container.querySelector('[data-feed-post-count="favorite"]')?.textContent,
    ).toBe("188");
  });

  it("shows no number for a zero or unknown count", () => {
    const { container } = render(
      environment({ likeCount: 0, favoriteCount: null }),
    );
    expect(container.querySelector("[data-feed-post-count]")).toBeNull();
  });

  it("reflects the viewer's like and favorite like the long-press menu", () => {
    const { button } = render(
      environment({ likedIds: [key], favoriteIds: [], ready: true }),
    );
    expect(button("喜欢").getAttribute("aria-pressed")).toBe("true");
    expect(button("喜欢").dataset.active).toBe("true");
    expect(button("收藏").getAttribute("aria-pressed")).toBe("false");
  });

  it("runs the shared environment action with this content", () => {
    const onAction = vi.fn();
    const { button } = render(environment({ onAction, ready: true }));
    act(() => button("喜欢").click());
    act(() => button("收藏").click());
    act(() => button("分享").click());
    expect(onAction.mock.calls).toEqual([
      ["like", content],
      ["favorite", content],
      ["share", content],
    ]);
  });

  it("holds like and favorite until the viewer's state is known; share stays available", () => {
    const onAction = vi.fn();
    const { button } = render(environment({ onAction, ready: false }));
    expect(button("喜欢").disabled).toBe(true);
    expect(button("收藏").disabled).toBe(true);
    expect(button("分享").disabled).toBe(false);
    expect(button("评论").disabled).toBe(false);
  });

  it("opens the content's discussion entry from the comment button", () => {
    const onComment = vi.fn();
    const { button } = render(environment(), onComment);
    act(() => button("评论").click());
    expect(onComment).toHaveBeenCalledWith(button("评论"));
  });

  it("disables everything but comment without an action environment", () => {
    const { button } = render(null);
    expect(button("喜欢").disabled).toBe(true);
    expect(button("收藏").disabled).toBe(true);
    expect(button("分享").disabled).toBe(true);
    expect(button("评论").disabled).toBe(false);
  });

  it("draws every action as one 24px outline glyph", () => {
    const { container } = render(environment(), vi.fn(), {
      kind: "detail",
      onOpen: vi.fn(),
    });
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(5);
    for (const button of buttons)
      expect(button.querySelectorAll("svg")).toHaveLength(1);
  });

  it("expands and collapses a work's body from the trailing action", () => {
    const onToggle = vi.fn();
    const { button, container } = render(environment(), vi.fn(), {
      kind: "expand",
      expanded: false,
      controls: "post-body",
      onToggle,
    });
    const expand = button("展开正文");
    expect(expand.dataset.feedPostTrailing).toBe("expand");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe("post-body");
    act(() => expand.click());
    expect(onToggle).toHaveBeenCalledOnce();
    // The last button of the row is the trailing one.
    expect([...container.querySelectorAll("button")].at(-1)).toBe(expand);
  });

  it("labels an expanded body as collapsible", () => {
    const { button } = render(environment(), vi.fn(), {
      kind: "expand",
      expanded: true,
      onToggle: vi.fn(),
    });
    expect(button("收起正文").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens Detail from the trailing action of official content", () => {
    const onOpen = vi.fn();
    const { button } = render(environment(), vi.fn(), {
      kind: "detail",
      onOpen,
    });
    const detail = button("查看详情");
    expect(detail.dataset.feedPostTrailing).toBe("detail");
    act(() => detail.click());
    expect(onOpen).toHaveBeenCalledWith(detail);
  });
});
