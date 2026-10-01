// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Owner acceptance (2026-09-25): a 专题 card is one academic Article and opens
 * that Article directly; the overlay is titled 专题 for it and 近闻 for news.
 */
const academic = `article-${"a".repeat(32)}`;
const second = `article-${"b".repeat(32)}`;
const news = `article-${"c".repeat(32)}`;
const openTopic = vi.fn();
const useArticles = vi.fn();
const useArticle = vi.fn();
const listedArticlePresentation = vi.fn();
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openTopic, readActiveScrollTop: () => 0 }),
}));
vi.mock("../discussion-preview/article-reader", () => ({
  ArticleReader: () => null,
}));
vi.mock("../discussion-preview/academic-reader", () => ({
  AcademicReader: () => null,
}));
vi.mock("./use-editorial-content", () => ({
  isArticleId: (id: string | null) => id?.startsWith("article-") ?? false,
  listedArticlePresentation: (id: string) => listedArticlePresentation(id),
  useArticles: (presentation: string) => useArticles(presentation),
  useArticle: (id: string) => useArticle(id),
  useCollection: () => ({ state: { state: "loading" }, retry: vi.fn() }),
}));
import { EditorialTopicsFeed } from "./editorial-feed";
import { EditorialDetail } from "./editorial-detail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let node: HTMLDivElement;
const summary = (id: string, title: string) => ({
  id,
  presentation: "academic",
  title,
  subtitle: "副标题（示例）",
  summary: "摘要（示例）",
  section: "金石学",
  issue: "第 1 期（示例）",
  byline: "研究组（示例）",
  cover: null,
  firstPublishedAt: "2026-09-24T00:00:00.000Z",
  publishedAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
});
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  openTopic.mockReset();
  useArticles.mockReset();
  useArticle.mockReset();
  listedArticlePresentation.mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("EditorialTopicsFeed", () => {
  it("lists academic Articles, one card each, and opens the tapped Article itself", async () => {
    useArticles.mockReturnValue({
      state: {
        state: "populated",
        hasMore: false,
        total: 2,
        items: [summary(academic, "专题文章一"), summary(second, "专题文章二")],
      },
      busy: false,
      retry: vi.fn(),
      loadMore: vi.fn(),
    });
    await act(async () => root!.render(<EditorialTopicsFeed />));
    expect(useArticles).toHaveBeenCalledWith("academic");
    const cards = [
      ...node.querySelectorAll<HTMLButtonElement>("[data-topic-id]"),
    ];
    expect(cards.map((card) => card.dataset.topicId)).toEqual([
      academic,
      second,
    ]);
    expect(cards[0]!.textContent).toContain("第 1 期（示例） / 金石学");
    await act(async () => cards[1]!.click());
    expect(openTopic).toHaveBeenCalledWith(second, cards[1], 0);
  });
});

describe("EditorialDetail title for a directly opened Article", () => {
  const render = async (id: string) => {
    const backButtonRef = { current: null };
    await act(async () =>
      root!.render(
        <EditorialDetail
          id={id}
          backButtonRef={backButtonRef}
          onClose={vi.fn()}
        />,
      ),
    );
    return node.querySelector("h1")?.textContent;
  };

  it("uses the feed's presentation before the detail loads", async () => {
    useArticle.mockReturnValue({ state: { state: "loading" }, retry: vi.fn() });
    listedArticlePresentation.mockReturnValue("academic");
    expect(await render(academic)).toBe("专题");
    listedArticlePresentation.mockReturnValue("news");
    expect(await render(news)).toBe("近闻");
  });

  it("is neutral for a deep link until the Article says which", async () => {
    listedArticlePresentation.mockReturnValue(null);
    useArticle.mockReturnValue({ state: { state: "loading" }, retry: vi.fn() });
    expect(await render(academic)).toBe("文章");
    useArticle.mockReturnValue({
      state: {
        state: "populated",
        item: {
          ...summary(academic, "专题文章一"),
          sections: [],
          citations: [],
        },
      },
      retry: vi.fn(),
    });
    expect(await render(academic)).toBe("专题");
  });
});
