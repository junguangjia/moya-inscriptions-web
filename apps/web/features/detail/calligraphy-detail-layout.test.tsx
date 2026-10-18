import { createRef } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogDetailScreen } from "./catalog-detail-screen";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";

const record: CatalogDetailPresentation = {
  id: "vertical-record",
  kind: "inscription",
  title: "题名“山川”12",
  aliases: ["别名"],
  summary: "简介完整显示。",
  facts: [{ label: "年代", value: "2026 年" }],
  sections: [
    { key: "description", title: "简介", text: "完整正文。\n\n".repeat(80) },
    { key: "transcription", title: "释文", text: "释文原文。" },
    { key: "historicalContext", title: "历史背景", text: "历史背景原文。" },
    { key: "scholarlyResearch", title: "学术研究", text: "学术研究原文。" },
  ],
  source: "qa",
  sourceCitations: [
    { label: "来源", url: "https://example.org/source", scopeLabel: "整体" },
  ],
  media: [
    {
      id: "portrait",
      src: "/portrait.jpg",
      alt: "完整竖图",
      width: 300,
      height: 1200,
    },
  ],
};

const render = (
  detail: CatalogDetailPresentation = record,
  calligraphy = true,
  colophon: ReactNode = <section data-test-colophon="">题跋</section>,
) =>
  renderToStaticMarkup(
    <CatalogDetailScreen
      activeMediaIndex={0}
      backButtonRef={createRef()}
      calligraphy={calligraphy}
      colophon={colophon}
      commentSection={<section data-test-normal-comments="">普通评论</section>}
      detailActions={<div data-test-actions="">操作</div>}
      onActiveMediaIndexChange={vi.fn()}
      onBack={vi.fn()}
      onOpenViewer={vi.fn()}
      orientation="portrait"
      platform="phone"
      state={{ state: "loaded", detail }}
    />,
  );

describe("calligraphy Detail composition", () => {
  it("separates the images from one complete title/content/colophon reading strip", () => {
    const markup = render();
    expect(markup).toContain('data-detail-mode="calligraphy"');
    expect(markup.indexOf("data-detail-calligraphy-media")).toBeLessThan(
      markup.indexOf("data-test-actions"),
    );
    expect(markup.indexOf("data-test-actions")).toBeLessThan(
      markup.indexOf("data-detail-reading-strip"),
    );
    expect(markup.indexOf("data-detail-title")).toBeLessThan(
      markup.indexOf('data-detail-section="description"'),
    );
    expect(markup.indexOf('data-detail-section="sources"')).toBeLessThan(
      markup.indexOf("data-test-colophon"),
    );
    expect(markup).not.toContain("data-test-normal-comments");
    expect(markup).not.toContain("data-detail-content-pager");
    expect(markup).not.toContain("data-feed-stage-comments");
    expect(markup).toContain('aria-label="详情与评论"');
    expect(markup.indexOf("data-detail-calligraphy-media")).toBeLessThan(
      markup.indexOf("data-detail-reading-navigation"),
    );
    expect(markup.indexOf("data-detail-reading-navigation")).toBeLessThan(
      markup.indexOf("data-detail-reading-strip"),
    );
    const controls = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(controls).toHaveLength(2);
    expect(controls[0]).toBe(controls[1]);
    expect(markup).toContain(`id="${controls[0]}"`);
    expect(markup).toContain('data-fit="contain"');
    expect(markup).toContain("题名「山川」");
    expect(markup.match(/完整正文。/g)).toHaveLength(80);
    expect(markup).toContain('href="https://example.org/source"');
    for (const anchor of ["aliases", "fact-0", "source-0"])
      expect(markup).toContain(`data-detail-reading-anchor="${anchor}"`);
    for (const text of ["释文原文", "历史背景原文", "学术研究原文", "基本资料"])
      expect(markup).toContain(text);
  });

  it("keeps normal Detail's pager and ordinary discussion", () => {
    const markup = render(record, false);
    expect(markup).toContain('data-detail-mode="normal"');
    expect(markup).toContain("data-detail-content-pager");
    expect(markup).toContain("data-test-normal-comments");
    expect(markup).not.toContain("data-detail-reading-strip");
    expect(markup).not.toContain("data-test-colophon");
    expect(markup).not.toContain("data-detail-reading-navigation");
  });

  it("disables the comments shortcut when this reader has no discussion", () => {
    const markup = render(record, true, null);
    const button = markup.match(
      /<button[^>]*data-detail-reading-target="comments"[^>]*>/,
    )?.[0];
    expect(button).toContain('disabled=""');
    expect(markup).toContain("data-detail-reading-navigation");
  });

  it("reads an untitled text-only work in the same strip without inventing an image or title", () => {
    const markup = render({
      ...record,
      contentType: "work",
      title: "",
      media: [],
      authorId: "writer",
      authorName: "作者",
      canEdit: false,
      available: true,
    });
    expect(markup).toContain("data-detail-untitled");
    expect(markup).not.toContain("data-detail-calligraphy-media");
    expect(markup).not.toContain("暂无公开图像");
    expect(markup).toContain("data-detail-reading-strip");
    expect(markup).toContain("data-test-colophon");
  });
});
