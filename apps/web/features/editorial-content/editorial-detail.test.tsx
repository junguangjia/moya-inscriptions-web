// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * unified-media-pipeline-v1 (CW13): Article reader figures offer their inline
 * candidates. News figures letterbox (contain), so they reserve the anchor's
 * size without a placeholder colour; academic legacy figures keep their 4:3
 * box and gain only the candidates.
 */
const { fixture, readers } = vi.hoisted(() => ({
  fixture: {
    article: null as object | null,
    collection: null as object | null,
  },
  // The props each ArticleReader render receives (pc-browse-only-v1).
  readers: [] as Record<string, unknown>[],
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openCatalog: vi.fn() }),
}));
vi.mock("../discussion-preview/article-reader", () => ({
  ArticleReader: (props: {
    comments?: ReactNode;
    renderContent: (context: {
      active: boolean;
      scrollElement: null;
      overlayTarget: null;
    }) => ReactNode;
  }) => {
    readers.push(props);
    return (
      <>
        {props.renderContent({
          active: false,
          scrollElement: null,
          overlayTarget: null,
        })}
        {props.comments}
      </>
    );
  },
}));
vi.mock("./use-editorial-content", () => ({
  isArticleId: (id: string) => !id.startsWith("collection-"),
  listedArticlePresentation: () => null,
  useArticles: vi.fn(),
  useArticle: () => ({
    state: { state: "populated", item: fixture.article },
    retry: vi.fn(),
  }),
  useCollection: () => ({
    state: { state: "populated", item: fixture.collection },
    retry: vi.fn(),
  }),
}));
import {
  EditorialDetail,
  LiveArticleReader,
  academicViewFromArticle,
} from "./editorial-detail";
import { MEDIA_SIZES } from "../media/responsive-media";

import type { ArticleDetail } from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const origin = "https://media.example.invalid/article";
const webp = "image/webp" as const;
const image = (name: string) => ({
  id: `media-${name}`,
  kind: "image" as const,
  alt: `${name}图`,
  src: `${origin}/${name}-1600.webp`,
  width: 1600,
  height: 1200,
  placeholderColor: "#47413a",
  renditions: [
    {
      src: `${origin}/${name}-480.webp`,
      width: 480,
      height: 360,
      contentType: webp,
    },
    {
      src: `${origin}/${name}-1600.webp`,
      width: 1600,
      height: 1200,
      contentType: webp,
    },
    {
      src: `${origin}/${name}-3200.webp`,
      width: 3200,
      height: 2400,
      contentType: webp,
    },
  ],
});
const article = (presentation: "news" | "academic") =>
  ({
    id: `article-${"5".repeat(32)}`,
    presentation,
    title: "合成文章",
    subtitle: null,
    summary: null,
    section: null,
    issue: null,
    byline: "合成作者",
    cover: image("cover"),
    firstPublishedAt: "2026-09-30T00:00:00Z",
    publishedAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    intro: null,
    sections: [
      {
        heading: "第一节",
        paragraphs: ["正文"],
        image: image("section"),
        imageCaption: null,
      },
    ],
    citations: [],
  }) as unknown as ArticleDetail;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  readers.length = 0;
  document.body.replaceChildren();
});

describe("News Article figures", () => {
  it("offer inline candidates and reserve the anchor's size without a colour", async () => {
    fixture.article = article("news");
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () => root!.render(<LiveArticleReader id="article" />));
    const figures = [...node.querySelectorAll("figure img")];
    expect(figures).toHaveLength(2);
    for (const [index, name] of ["cover", "section"].entries()) {
      const figure = figures[index]!;
      expect(figure.getAttribute("src")).toBe(`${origin}/${name}-1600.webp`);
      expect(figure.getAttribute("srcset")).toBe(
        `${origin}/${name}-480.webp 480w, ${origin}/${name}-1600.webp 1600w`,
      );
      expect(figure.getAttribute("sizes")).toBe(
        MEDIA_SIZES.newsFigure(image(name)),
      );
      expect(figure.getAttribute("width")).toBe("1600");
      expect(figure.getAttribute("height")).toBe("1200");
      expect((figure as HTMLElement).style.backgroundColor).toBe("");
    }
  });
});

describe("Academic legacy figures", () => {
  it("carry inline candidates and the figure sizes", () => {
    const [chapter] = academicViewFromArticle(article("academic")).chapters;
    expect(chapter?.figures).toEqual([
      {
        afterParagraph: 0,
        src: `${origin}/section-1600.webp`,
        srcSet: `${origin}/section-480.webp 480w, ${origin}/section-1600.webp 1600w`,
        sizes: MEDIA_SIZES.academicFigure(image("section")),
        alt: "section图",
        caption: "section图",
      },
    ]);
  });
});

/*
 * pc-browse-only-v1: browse-only Articles ask the reader for no comments at
 * all. They never build the live discussion or the pending note, and never
 * pass an empty comment slot (that would select the preview's comments).
 */
describe("Browse-only Articles", () => {
  const renderComments = vi.fn((articleId: string) => (
    <p data-live-discussion={articleId}>评论区</p>
  ));
  const mount = async (element: ReactNode) => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () => root!.render(element));
    return node;
  };
  const hidden = (node: HTMLElement) => {
    const props = readers.at(-1)!;
    expect(props.commentsHidden).toBe(true);
    expect("comments" in props).toBe(false);
    expect(renderComments).not.toHaveBeenCalled();
    expect(node.querySelector("[data-live-discussion]")).toBeNull();
    expect(node.querySelector("[data-editorial-comments]")).toBeNull();
    expect(node.textContent).not.toContain("评论功能尚未接入此文章。");
  };
  beforeEach(() => {
    renderComments.mockClear();
    fixture.article = article("news");
  });

  it("keeps the live discussion or the pending note by default", async () => {
    const node = await mount(
      <LiveArticleReader id="article" renderComments={renderComments} />,
    );
    expect("commentsHidden" in readers.at(-1)!).toBe(false);
    expect(renderComments).toHaveBeenCalledWith(article("news").id);
    expect(node.querySelector("[data-live-discussion]")).not.toBeNull();
    await act(async () => root!.render(<LiveArticleReader id="article" />));
    expect(
      node.querySelector('[data-editorial-comments="pending"]')?.textContent,
    ).toBe("评论功能尚未接入此文章。");
  });

  it("passes the reader no comments, live or pending", async () => {
    hidden(
      await mount(
        <LiveArticleReader
          id="article"
          commentsHidden
          renderComments={renderComments}
        />,
      ),
    );
    await act(async () =>
      root!.render(<LiveArticleReader id="article" commentsHidden />),
    );
    hidden(document.body);
  });

  it("forwards the mode from EditorialDetail to an Article", async () => {
    const node = await mount(
      <EditorialDetail
        id="article-direct"
        backButtonRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
        commentsHidden
        renderComments={renderComments}
      />,
    );
    hidden(node);
  });

  it("forwards the mode to an Article opened from its Collection", async () => {
    fixture.collection = {
      id: "collection-1",
      title: "合成专题",
      issue: null,
      category: null,
      subtitle: null,
      cover: null,
      summary: null,
      memberTotal: 1,
      publishedAt: "2026-09-30T00:00:00Z",
      members: [
        {
          kind: "article",
          position: 0,
          article: { id: "article-child", title: "子文章", byline: "合成作者" },
        },
      ],
    };
    const node = await mount(
      <EditorialDetail
        id="collection-1"
        backButtonRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
        commentsHidden
        renderComments={renderComments}
      />,
    );
    expect(readers).toHaveLength(0);
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>('[aria-label="阅读文章 子文章"]')!
        .click(),
    );
    hidden(node);
  });
});
