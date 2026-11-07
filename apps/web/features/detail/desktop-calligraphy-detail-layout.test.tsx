// @vitest-environment jsdom
import { act, createRef } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogDetailScreen } from "./catalog-detail-screen";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import { DetailBand } from "./detail-band";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";

const catalog: CatalogDetailPresentation = {
  id: "desktop-catalog",
  source: "qa",
  kind: "inscription",
  title: "松岩题刻",
  aliases: ["松岩石刻"],
  facts: [{ label: "时代", value: "明代" }],
  sections: [
    { key: "description", title: "简介", text: "完整资料。".repeat(120) },
    { key: "transcription", title: "释文", text: "释文原文。" },
  ],
  sourceCitations: [
    {
      label: "图录来源",
      scopeLabel: "整体",
      url: "https://example.org/catalog",
    },
  ],
  media: [
    {
      id: "landscape",
      src: "/landscape.jpg",
      alt: "完整横图",
      width: 1600,
      height: 1000,
    },
  ],
};
const work: CatalogDetailPresentation = {
  id: "desktop-work",
  source: "qa",
  contentType: "work",
  title: "听雨斋临帖",
  authorId: "author",
  authorName: "听雨斋",
  canEdit: false,
  available: true,
  aliases: [],
  facts: [],
  sections: [
    { key: "description", title: "正文", text: "雨歇窗明，试写小楷数行。" },
  ],
  sourceCitations: [],
  media: [
    {
      id: "portrait",
      src: "/portrait.jpg",
      alt: "完整竖图",
      width: 300,
      height: 1000,
    },
  ],
};
const render = (
  detail: CatalogDetailPresentation = catalog,
  {
    calligraphy = true,
    colophon = <section data-colophon-head="">题跋正文</section>,
  }: { calligraphy?: boolean; colophon?: ReactNode } = {},
) =>
  renderToStaticMarkup(
    <CatalogDetailScreen
      activeMediaIndex={0}
      backButtonRef={createRef()}
      calligraphy={calligraphy}
      colophon={colophon}
      commentSection={<section data-normal-comments="">普通评论</section>}
      desktop
      detailActions={<div data-test-actions="">操作</div>}
      onActiveMediaIndexChange={vi.fn()}
      onBack={vi.fn()}
      onOpenViewer={vi.fn()}
      orientation="landscape"
      platform="pc"
      state={{ state: "loaded", detail }}
    />,
  );

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("desktop calligraphy detail", () => {
  it("renders a band section under the first screen, out of the actions slot, and keeps the reader's place as it grows (timeline-posts-v1)", () => {
    let notify: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    const shift = vi.fn();
    const scroll = {
      read: () => 0,
      restore: vi.fn(),
      collapseTop: () => 640,
      shift,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CatalogDetailScrollContext.Provider value={scroll}>
          <CatalogDetailScreen
            activeMediaIndex={0}
            backButtonRef={createRef()}
            calligraphy
            colophon={<section data-colophon-head="">题跋正文</section>}
            commentSection={null}
            desktop
            detailActions={
              <div data-test-actions="">
                <DetailBand>
                  <section data-test-band-child="">帖子</section>
                </DetailBand>
              </div>
            }
            onActiveMediaIndexChange={vi.fn()}
            onBack={vi.fn()}
            onOpenViewer={vi.fn()}
            orientation="landscape"
            platform="pc"
            state={{ state: "loaded", detail: catalog }}
          />
        </CatalogDetailScrollContext.Provider>,
      ),
    );
    const band = container.querySelector<HTMLElement>(
      "[data-desktop-detail-band]",
    )!;
    const child = container.querySelector("[data-test-band-child]");
    expect(child?.parentElement).toBe(band);
    expect(child?.closest("[data-desktop-detail-actions]")).toBeNull();
    expect(
      container.querySelector("[data-test-actions]")?.children,
    ).toHaveLength(0);
    // Under the first screen, before the 题跋 below it.
    const first = container.querySelector(
      "[data-desktop-detail-first-screen]",
    )!;
    const colophon = container.querySelector("[data-desktop-detail-colophon]")!;
    expect(
      first.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      band.compareDocumentPosition(colophon) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The band fills after paint: from 0 to 400, then 400 to 460.
    let height = 400;
    Object.defineProperty(band, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
    act(() => notify?.([], {} as ResizeObserver));
    expect(shift).toHaveBeenLastCalledWith(640, 400);
    height = 460;
    act(() => notify?.([], {} as ResizeObserver));
    expect(shift).toHaveBeenLastCalledWith(1040, 60);
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("separates the image and full-height archive reader above a below-fold colophon", () => {
    const html = render();
    expect(html).toContain('data-desktop-detail-content="catalog"');
    expect(html).toContain('data-detail-reading-variant="desktop-information"');
    expect(html).not.toContain("data-desktop-information-group");
    expect(html).toContain('data-desktop-detail-information=""');
    expect(html).toContain('data-desktop-detail-image-pane=""');
    expect(html).toContain('data-desktop-colophon-cue=""');
    expect(html).toContain('aria-label="向左读题跋"');
    expect(html).toContain('data-detail-reading-variant="desktop-comments"');
    expect(html.indexOf("data-desktop-detail-upper")).toBeLessThan(
      html.indexOf("data-test-actions"),
    );
    expect(html.indexOf("data-test-actions")).toBeLessThan(
      html.indexOf("data-desktop-detail-colophon"),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="资料分类"');
    expect(html).toContain("释文");
    expect(html).toContain("来源");
    expect(html).toContain("松岩题刻");
    expect(html).toContain("明代");
    expect(html).toContain('data-fit="contain"');
    expect(html).not.toContain("data-normal-comments");
    expect(html).toContain('aria-label="前往图片"');
    expect(html).toContain('aria-label="前往资料"');
    expect(html).toContain('aria-label="前往题跋"');
    expect(html).toContain('aria-label="返回"');
  });

  it("keeps a work's author and body above its colophons without catalog labels", () => {
    const html = render(work);
    expect(html).toContain('data-desktop-detail-content="work"');
    expect(html).toContain("听雨斋");
    expect(html).toContain("雨歇窗明，试写小楷数行。");
    expect(html.indexOf("雨歇窗明")).toBeLessThan(
      html.indexOf("data-desktop-detail-colophon"),
    );
    expect(html).not.toContain("基本资料");
    expect(html).not.toContain("资料来源");
    expect(html).toContain('aria-label="前往正文"');
  });

  it("never invents a media box or image shortcut for text-only works", () => {
    const html = render({ ...work, media: [], title: "" });
    expect(html).toContain("data-detail-text-only");
    expect(html).toContain("data-detail-untitled");
    expect(html).not.toContain("data-detail-calligraphy-media");
    expect(html).not.toContain("暂无公开图像");
    expect(html).not.toContain('aria-label="前往图片"');
    expect(html).toContain("雨歇窗明");
  });

  it("omits discussion and its shortcut when the policy offers no colophon", () => {
    const html = render(catalog, { colophon: null });
    expect(html).not.toContain("data-desktop-detail-colophon");
    expect(html).not.toContain('aria-label="前往题跋"');
    expect(html).not.toContain('data-desktop-colophon-cue=""');
    expect(html).toContain("松岩题刻");
  });

  it("leaves normal desktop detail's ordinary discussion and disclosure intact", () => {
    const html = render(catalog, { calligraphy: false });
    expect(html).toContain("data-detail-landscape-layout");
    expect(html).toContain("data-detail-reading-disclosure");
    expect(html).toContain("data-normal-comments");
    expect(html).not.toContain("data-desktop-calligraphy-detail");
  });
});
