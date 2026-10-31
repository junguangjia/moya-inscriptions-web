import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCardFrame, desktopCardTitleParts } from "./desktop-card-frame";
let cropped = false;
vi.mock("./catalog-masonry", () => ({
  useMasonrySlot: () => ({ desktop: { cropped } }),
}));
const media = (
  <div>
    <img alt="原始图片" src="/synthetic.jpg" />
  </div>
);

describe("desktop right-hand vertical caption content", () => {
  it("places the actual image-post summary between its title and metadata without splitting characters", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame
        title="松岩题刻"
        preview="松风入怀，清气满襟。"
        metadata="碑刻 · 福建"
        media={media}
      />,
    );
    expect(markup).toContain('data-card-caption-excerpt=""');
    expect(markup).toContain("松风入怀，清气满襟。");
    expect(markup.indexOf("松岩题刻")).toBeLessThan(markup.indexOf("松风入怀"));
    expect(markup.indexOf("松风入怀")).toBeLessThan(
      markup.indexOf("碑刻 · 福建"),
    );
    expect(markup).not.toContain("data-card-excerpt=");
    const id = markup.match(/id="([^"]+)"[^>]*data-card-caption-excerpt/)!;
    expect(markup).toContain(`aria-describedby="${id[1]}"`);
  });
  it("keeps an untitled image post's actual summary without inventing a visible title", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame
        title=""
        metadata="作品"
        preview="只有正文，没有题名。"
        media={media}
      />,
    );
    expect(markup).not.toContain("<h3");
    expect(markup).toContain("只有正文，没有题名。");
    expect(markup).toContain('data-card-caption-excerpt=""');
  });
  it("does not manufacture a summary when the record supplies none", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame title="松岩题刻" metadata="碑刻" media={media} />,
    );
    expect(markup).not.toContain("data-card-caption-excerpt");
  });
  it("keeps a text-only post as one real body instead of duplicating a fabricated image caption", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame title="" metadata="作品" preview={"第一段\n第二段"} />,
    );
    expect(markup).toContain('data-card-excerpt=""');
    expect(markup).toContain("第一段\n第二段");
    expect(markup).not.toContain("data-card-caption-excerpt");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<h3");
  });
  it("keeps author cover and the original opener without a visible local-preview badge", () => {
    cropped = true;
    const markup = renderToStaticMarkup(
      <DesktopCardFrame
        title="长卷"
        metadata="书帖"
        media={media}
        action={<button>打开长卷</button>}
      />,
    );
    expect(markup).not.toContain("局部预览 · 打开查看全图");
    expect(markup).not.toContain('role="img"');
    expect(markup).toContain("--desktop-media-fit:cover");
    expect(markup).toContain("打开长卷");
    cropped = false;
  });
  it("keeps an uncropped or author-contained image free of a misleading crop indication", () => {
    cropped = false;
    const markup = renderToStaticMarkup(
      <DesktopCardFrame title="长卷" metadata="" media={media} />,
    );
    expect(markup).toContain("--desktop-media-fit:contain");
    expect(markup).not.toContain("局部预览");
  });
  it.each([
    [
      "北宋米芾《行书道祖帖》卷（局部）",
      "北宋米芾《行书道祖帖》",
      "卷（局部）",
    ],
    ["米芾书法局部（“夢”字）", "米芾书法局部", "（“夢”字）"],
    ["上庸长阙（司马孟台阙）题铭", "上庸长阙（司马孟台阙）题铭", ""],
    ["双《卷一》与《卷二》册", "双《卷一》与《卷二》", "册"],
    ["《册》", "《册》", ""],
    ["《册》  ", "《册》", "  "],
    ["", "", ""],
  ])(
    "separates actual title notes without changing canonical text: %s",
    (title, primary, suffix) => {
      const parts = desktopCardTitleParts(title!);
      expect(parts).toEqual({ primary, suffix });
      expect(parts.primary + parts.suffix).toBe(title);
    },
  );
  it("retains canonical 局部 title text while removing only the overlay badge", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame title="长卷（局部）" metadata="书帖" media={media} />,
    );
    expect(markup).toContain('title="长卷（局部）"');
    expect(markup).toContain('data-card-title-primary=""');
    expect(markup).toContain('data-card-title-suffix=""');
    expect(markup).toContain("（局部）");
    expect(markup).not.toContain("局部预览 · 打开查看全图");
  });
  it("preserves a caller's description and styling alongside the real summary", () => {
    const markup = renderToStaticMarkup(
      <DesktopCardFrame
        title="书札"
        metadata="作品"
        media={media}
        preview="真实内容"
        aria-describedby="existing-description"
        style={{ opacity: 0.9 }}
      />,
    );
    expect(markup).toContain('aria-describedby="existing-description ');
    expect(markup).toContain("opacity:0.9");
    expect(markup).toContain("真实内容");
  });
});
