// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ArticleDetail,
  ArticleDocument,
  CatalogId,
  MediaId,
} from "@moya/contracts";
import { AcademicReader } from "../discussion-preview/academic-reader";
import {
  ArticlePublishedBody,
  articleRichChapters,
} from "./article-published-body";

const viewer = vi.hoisted(() => vi.fn<(props: unknown) => null>(() => null));
vi.mock("../detail/catalog-viewer", () => ({ CatalogViewer: viewer }));

const span = (text: string) => ({ type: "text" as const, text, styles: {} });
const document: ArticleDocument = {
  format: "blocknote",
  version: 1,
  blocks: [
    {
      id: "first",
      type: "heading",
      props: { level: 2 },
      content: [span("第一节")],
      children: [],
    },
    {
      id: "copy",
      type: "paragraph",
      props: {},
      content: [
        { type: "text", text: "重点", styles: { bold: true } },
        {
          type: "link",
          href: "https://example.org/source",
          content: [span("来源")],
        },
      ],
      children: [],
    },
    {
      id: "second",
      type: "heading",
      props: { level: 3 },
      content: [span("小节")],
      children: [],
    },
    {
      id: "quote",
      type: "quote",
      props: {},
      content: [span("引用")],
      children: [],
    },
    {
      id: "image",
      type: "managedImage",
      props: { refId: "photo", alt: "测试图片", caption: "图注" },
      children: [],
    },
    {
      id: "gallery",
      type: "imageGallery",
      props: { groupId: "group" },
      children: [],
    },
  ],
  references: {
    photo: { type: "managed", itemId: `media-item-${"2".repeat(32)}` },
    missing: { type: "managed", itemId: `media-item-${"3".repeat(32)}` },
  },
  galleries: { group: { referenceIds: ["photo", "missing"] } },
};
const article: ArticleDetail = {
  id: `article-${"1".repeat(32)}` as ArticleDetail["id"],
  presentation: "academic",
  title: "合成专题",
  subtitle: null,
  summary: null,
  section: null,
  issue: null,
  byline: "合成作者",
  cover: null,
  firstPublishedAt: "2026-09-30T00:00:00Z",
  publishedAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  intro: null,
  sections: [],
  citations: [],
  document,
  resolvedReferences: {
    photo: {
      type: "managed",
      media: {
        id: `media-item-${"2".repeat(32)}`,
        src: `/api/community/publishing/media/media-item-${"2".repeat(32)}/display/base`,
        width: 4,
        height: 3,
      },
    },
    missing: { type: "unavailable", reason: "media_unavailable" },
  },
};

describe("Published canonical Article in accepted readers", () => {
  it("renders saved block-local crop and highlight/layout using public resolved media", () => {
    const cropped: ArticleDocument = {
      ...document,
      blocks: document.blocks.map((block) => {
        if (block.type === "managedImage")
          return {
            ...block,
            props: {
              ...block.props,
              cropX: 0.25,
              cropY: 0.25,
              cropWidth: 0.5,
              cropHeight: 0.5,
            },
          };
        if (block.type === "paragraph")
          return {
            ...block,
            props: {
              textAlignment: "center" as const,
              lineSpacing: "relaxed" as const,
            },
            content: [
              {
                type: "text" as const,
                text: "合成高亮",
                styles: { backgroundColor: "red" as const },
              },
            ],
          };
        return block;
      }),
    };
    const html = renderToStaticMarkup(
      <ArticlePublishedBody
        article={article}
        document={cropped}
        active={false}
      />,
    );
    expect(html).toContain('data-article-background-color="red"');
    expect(html).toContain('data-article-text-alignment="center"');
    expect(html).toContain('data-article-line-spacing="relaxed"');
    expect(html).toContain("left:-50%;top:-50%;width:200%;height:200%");
    expect(html).not.toContain("裁剪范围");
    expect(html).not.toContain("/api/community/media");
    expect(
      document.blocks.find((block) => block.type === "managedImage")!.props,
    ).not.toHaveProperty("cropX");
  });
  it("uses public resolved media while preserving headings, inline styles, citations, galleries and unavailable refs", () => {
    const html = renderToStaticMarkup(
      <ArticlePublishedBody article={article} active={false} />,
    );
    expect(html).toContain('<h3 id="article-block-first"');
    expect(html).toContain('<h4 id="article-block-second"');
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain('href="https://example.org/source"');
    expect(html).toContain("<blockquote");
    expect(html).toContain("<figcaption>图注</figcaption>");
    expect(html).toContain('aria-label="图片组"');
    expect(html).toContain("图片已不可用。");
    expect(html).toContain(
      article.resolvedReferences!.photo!.type === "managed"
        ? article.resolvedReferences!.photo!.media.src
        : "",
    );
  });
  it("keeps the AcademicReader chapter rail and semantic canonical body, with each heading rendered once", () => {
    const chapters = articleRichChapters(document, (chunk) => (
      <ArticlePublishedBody article={article} document={chunk} active={false} />
    ));
    const html = renderToStaticMarkup(
      <AcademicReader
        article={{
          id: article.id,
          category: null,
          title: article.title,
          subtitle: null,
          byline: article.byline,
          meta: "",
          intro: null,
          chapters,
          citation: ["合成引用", null],
        }}
      />,
    );
    expect(chapters).toHaveLength(1);
    expect(html).toContain('aria-controls="' + article.id + '-chapter-1"');
    expect(html).toContain('aria-labelledby="article-block-first"');
    expect(html.match(/id="article-block-first"/gu)).toHaveLength(1);
    expect(html).toContain("<strong>重点</strong>");
  });
});

/*
 * unified-media-pipeline-v1: published managed media passes its candidates
 * and colour through to the body image, and a resized block narrows `sizes`
 * by its display width.
 */
describe("Published Article media candidates", () => {
  const item = `media-item-${"2".repeat(32)}`;
  const path = (variant: string) =>
    `/api/community/publishing/media/${item}/${variant}/base`;
  const responsive: ArticleDetail = {
    ...article,
    resolvedReferences: {
      ...article.resolvedReferences,
      photo: {
        type: "managed",
        media: {
          id: item,
          src: path("display"),
          width: 2048,
          height: 1536,
          placeholderColor: "#5a4e44",
          renditions: [
            {
              src: path("thumb"),
              width: 480,
              height: 360,
              contentType: "image/webp",
            },
            {
              src: path("display"),
              width: 2048,
              height: 1536,
              contentType: "image/webp",
            },
            {
              src: path("viewer"),
              width: 4096,
              height: 3072,
              contentType: "image/webp",
            },
          ],
        },
      },
    },
  };
  const withDisplayWidth = (displayWidth: number): ArticleDocument => ({
    ...document,
    blocks: document.blocks.map((block) =>
      block.type === "managedImage"
        ? { ...block, props: { ...block.props, displayWidth } }
        : block,
    ),
  });

  it("offers inline candidates up to the anchor with the colour on the box", () => {
    const html = renderToStaticMarkup(
      <ArticlePublishedBody article={responsive} active={false} />,
    );
    expect(html).toContain(
      `srcSet="${path("thumb")} 480w, ${path("display")} 2048w"`,
    );
    expect(html).not.toContain(`${path("viewer")} 4096w`);
    expect(html).toContain("background-color:#5a4e44");
    expect(html).toContain(
      'sizes="(min-width: 760px) 692px, calc(100vw - 40px)"',
    );
  });

  it("narrows a resized block's sizes to its display width", () => {
    const html = renderToStaticMarkup(
      <ArticlePublishedBody
        article={responsive}
        document={withDisplayWidth(0.5)}
        active={false}
      />,
    );
    expect(html).toContain(
      'sizes="(min-width: 760px) 346px, calc(50vw - 20px)"',
    );
  });

  it("relays Development Catalog anchors and candidates for inline images and Viewer", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const catalogId = `catalog-${"a".repeat(32)}` as CatalogId;
    const mediaId = `media-${"b".repeat(32)}` as MediaId;
    const ids = ["1", "2", "3"].map(
      (hex) => `media-rendition-${hex.repeat(32)}`,
    );
    const local = (id: string) =>
      `http://127.0.0.1:3101/v1/development/catalog-renditions/${id}`;
    const relay = (id: string) => `/api/development/catalog-renditions/${id}`;
    const catalogArticle: ArticleDetail = {
      ...article,
      document: {
        ...document,
        references: {
          ...document.references,
          photo: { type: "catalog", catalogId, mediaId },
        },
      },
      resolvedReferences: {
        ...article.resolvedReferences,
        photo: {
          type: "catalog",
          media: {
            id: mediaId,
            kind: "image",
            src: local(ids[1]!),
            width: 2048,
            height: 1536,
            alt: "合成藏品",
            renditions: [480, 2048, 4096].map((width, index) => ({
              src: local(ids[index]!),
              width,
              height: (width * 3) / 4,
              contentType: "image/webp" as const,
            })),
          },
        },
      },
    };
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<ArticlePublishedBody article={catalogArticle} active />),
      );
      const image = container.querySelector("img")!;
      expect(image.getAttribute("src")).toBe(relay(ids[1]!));
      expect(image.getAttribute("srcset")).toBe(
        `${relay(ids[0]!)} 480w, ${relay(ids[1]!)} 2048w`,
      );
      expect(container.innerHTML).not.toContain("127.0.0.1");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="放大查看原图"]')!
          .click(),
      );
      expect(viewer).toHaveBeenCalled();
      const props = viewer.mock.lastCall?.[0] as
        { media: { src: string; renditions: { src: string }[] }[] } | undefined;
      expect(props?.media[0]?.src).toBe(relay(ids[1]!));
      expect(props?.media[0]?.renditions.map((entry) => entry.src)).toEqual(
        ids.map(relay),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
