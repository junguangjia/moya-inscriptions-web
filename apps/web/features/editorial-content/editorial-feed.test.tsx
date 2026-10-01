// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * content-community-completion-v1: the feed's pictures go through
 * editorialMediaSrc, so a loopback Payload cover reaches a phone on the LAN
 * acceptance origin through the Web origin.
 */
const file = `${"a".repeat(64)}-${"b".repeat(64)}.png`;
const id = `article-${"4".repeat(32)}`;
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openTopic: vi.fn() }),
}));
vi.mock("./use-editorial-content", () => ({
  useArticles: () => ({
    state: {
      state: "populated",
      hasMore: false,
      items: [
        {
          id,
          title: "近闻示例（示例）",
          summary: "合成示例",
          section: null,
          byline: "编辑部",
          publishedAt: "2026-09-24T00:00:00.000Z",
          cover: {
            src: `http://127.0.0.1:3522/api/media/file/${file}`,
            alt: "封面",
          },
        },
      ],
    },
    busy: false,
    retry: vi.fn(),
    loadMore: vi.fn(),
  }),
}));
import { EditorialNewsFeed } from "./editorial-feed";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("EditorialNewsFeed pictures", () => {
  it("serves a loopback Payload cover through the Web origin, named by its Article", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () => root!.render(<EditorialNewsFeed />));
    expect(node.querySelector("img")?.getAttribute("src")).toBe(
      `/api/editorial-media/${id}/${file}`,
    );
  });
});
