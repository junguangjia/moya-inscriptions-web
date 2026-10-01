import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArticleDetail, ArticleDocument } from "@moya/contracts";
import { AcademicReader } from "../discussion-preview/academic-reader";
import {
  ArticlePublishedBody,
  articleRichChapters,
} from "./article-published-body";

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
  it("uses public resolved media while preserving headings, inline styles, citations, galleries and unavailable refs", () => {
    const html = renderToStaticMarkup(
      <ArticlePublishedBody article={article} active={false} />,
    );
    expect(html).toContain('<h3 id="article-block-first">');
    expect(html).toContain('<h4 id="article-block-second">');
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
