// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The phone single-column masonry slot.
vi.mock("./catalog-masonry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./catalog-masonry")>()),
  useFeedPostSlot: () => true,
}));

import { CatalogCardPresentation } from "./catalog-card";
import {
  clearDetailCommentsRequest,
  detailCommentsRequested,
} from "../detail/detail-comments-request";
import { ContentQuickActionsProvider } from "../quick-actions/content-quick-actions";
import { quickActionContentKey } from "../quick-actions/quick-action-types";

import type { Root } from "react-dom/client";
import type {
  CatalogId,
  CatalogSummary,
  MediaId,
  PublicMedia,
} from "@moya/contracts";
import type { ContentQuickActionEnvironment } from "../quick-actions/quick-action-types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  aliases: [],
  id: "runtime-calligraphy" as CatalogId,
  kind: "calligraphy",
  periodLabel: "宋",
  province: "浙江",
  representativeMedia: {
    alt: "书帖册页",
    height: 1200,
    id: "runtime-calligraphy-leaf" as MediaId,
    kind: "image",
    src: "/calligraphy-leaf.svg",
    width: 900,
  } as PublicMedia,
  summary: "用于验证书帖运行时身份。",
  title: "运行时书帖",
} as CatalogSummary;

const roots: Root[] = [];
const render = (
  environment: ContentQuickActionEnvironment | null,
  onOpenCatalog = vi.fn(),
  summary: CatalogSummary = item,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const card = (
    <CatalogCardPresentation
      item={summary}
      onOpenCatalog={onOpenCatalog}
      variant="feed"
    />
  );
  act(() =>
    root.render(
      environment === null ? (
        card
      ) : (
        <ContentQuickActionsProvider environment={environment}>
          {card}
        </ContentQuickActionsProvider>
      ),
    ),
  );
  return container.querySelector<HTMLElement>("article")!;
};
const environment = (
  overrides: Partial<ContentQuickActionEnvironment> = {},
): ContentQuickActionEnvironment => ({
  onAction: vi.fn(),
  likedIds: [],
  favoriteIds: [],
  ready: true,
  ...overrides,
});
const tapImage = (post: HTMLElement) =>
  act(() => {
    post
      .querySelector("[data-feed-slide-image]")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  clearDetailCommentsRequest();
  vi.useRealTimers();
});

describe("CatalogCardPresentation as a phone single-column post", () => {
  it("shows one image, the title, actions and the kind line without author or comments", () => {
    const post = render(environment());
    expect(post.dataset.feedPost).toBe("");
    expect(post.dataset.catalogId).toBe("runtime-calligraphy");
    expect(
      [...post.children].map(
        (child) =>
          [...child.attributes]
            .map((a) => a.name)
            .find((name) => name.startsWith("data-")) ?? child.className,
      ),
    ).toEqual([
      "data-feed-stage-frame",
      "data-feed-post-title",
      "data-feed-post-actions",
      expect.stringMatching(/postDate/),
    ]);
    expect(post.querySelectorAll("[data-feed-slide]")).toHaveLength(1);
    expect(post.querySelector("[data-feed-post-dots]")).toBeNull();
    expect(post.querySelector("[data-feed-stage-comments]")).toBeNull();
    expect(post.querySelector("[data-feed-post-author]")).toBeNull();
    expect(post.querySelector("[data-quick-actions]")).toBeNull();
    expect(post.querySelector("[data-catalog-province]")?.textContent).toBe(
      "浙江",
    );
    expect(post.textContent).toContain("书帖 · 宋");
  });

  it("opens the record from a tap outside a product shell", () => {
    const onOpenCatalog = vi.fn();
    const post = render(environment(), onOpenCatalog);
    tapImage(post);
    expect(onOpenCatalog).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onOpenCatalog).toHaveBeenCalledWith(
      item,
      post.querySelector("[data-feed-slide-image]"),
    );
  });

  it("likes once on a double tap and never un-likes", () => {
    const onAction = vi.fn();
    const post = render(environment({ onAction }));
    tapImage(post);
    tapImage(post);
    expect(onAction).toHaveBeenCalledWith("like", {
      kind: "catalog",
      id: "runtime-calligraphy",
      title: "运行时书帖",
    });
    const liked = vi.fn();
    const already = render(
      environment({
        onAction: liked,
        likedIds: [
          quickActionContentKey({
            kind: "catalog",
            id: "runtime-calligraphy",
            title: "运行时书帖",
          }),
        ],
      }),
    );
    tapImage(already);
    tapImage(already);
    expect(liked).not.toHaveBeenCalled();
  });

  it("opens the record from the title and the detail action, comments on their page", () => {
    const onOpenCatalog = vi.fn();
    const post = render(environment(), onOpenCatalog);
    const title = post.querySelector<HTMLButtonElement>(
      'button[aria-label="打开运行时书帖"]',
    )!;
    act(() => title.click());
    expect(onOpenCatalog).toHaveBeenLastCalledWith(item, title);
    const detail = post.querySelector<HTMLButtonElement>(
      'button[aria-label="查看详情"]',
    )!;
    act(() => detail.click());
    expect(onOpenCatalog).toHaveBeenLastCalledWith(item, detail);
    expect(detailCommentsRequested("runtime-calligraphy")).toBe(false);
    const comment = post.querySelector<HTMLButtonElement>(
      "[data-feed-post-comment]",
    )!;
    act(() => comment.click());
    expect(onOpenCatalog).toHaveBeenLastCalledWith(item, comment);
    expect(detailCommentsRequested("runtime-calligraphy")).toBe(true);
  });

  it("keeps the truthful missing box for a record without an image", () => {
    const post = render(environment(), vi.fn(), {
      ...item,
      representativeMedia: undefined,
    } as CatalogSummary);
    expect(
      post.querySelector('[data-catalog-media-state="missing"]'),
    ).not.toBeNull();
    expect(post.querySelector("[data-feed-stage]")).toBeNull();
  });
});
