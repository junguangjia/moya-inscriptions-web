// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * unified-media-pipeline-v1 (CW13): Article reader figures offer their inline
 * candidates. News figures letterbox (contain), so they reserve the anchor's
 * size without a placeholder colour; academic legacy figures keep their 4:3
 * box and gain only the candidates.
 */
const { fixture } = vi.hoisted(() => ({
  fixture: { article: null as object | null },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openCatalog: vi.fn() }),
}));
vi.mock("../discussion-preview/article-reader", () => ({
  ArticleReader: ({
    renderContent,
  }: {
    renderContent: (context: {
      active: boolean;
      scrollElement: null;
      overlayTarget: null;
    }) => ReactNode;
  }) =>
    renderContent({ active: false, scrollElement: null, overlayTarget: null }),
}));
vi.mock("./use-editorial-content", () => ({
  isArticleId: () => true,
  listedArticlePresentation: () => null,
  useArticles: vi.fn(),
  useArticle: () => ({
    state: { state: "populated", item: fixture.article },
    retry: vi.fn(),
  }),
  useCollection: vi.fn(),
}));
import { LiveArticleReader, academicViewFromArticle } from "./editorial-detail";
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
