// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const authJourney = vi.hoisted(() => ({
  returned: undefined as unknown,
  capture: undefined as (() => unknown) | undefined,
}));
vi.mock("../auth/auth-return", () => ({
  useAuthReturnView: (_slot: string, capture: () => unknown) => {
    authJourney.capture = capture;
    return authJourney.returned;
  },
}));
import { CatalogDetailScreen } from "./catalog-detail-screen";
import { DesktopCalligraphyDetailLayout } from "./desktop-calligraphy-detail-layout";
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

describe("desktop calligraphy detail", () => {
  it("separates the image and complete disclosure modules above a below-fold colophon", () => {
    const html = render();
    expect(html).toContain('data-desktop-detail-content="catalog"');
    expect(html).not.toContain(
      'data-detail-reading-variant="desktop-information"',
    );
    expect(html).toContain('data-desktop-detail-information=""');
    expect(html).toContain('data-desktop-detail-image-pane=""');
    expect(html).toContain('data-desktop-information-group="facts"');
    expect(html).toContain('data-desktop-information-group="transcription"');
    expect(html).toContain('data-desktop-information-group="sources"');
    expect(html).toContain('data-desktop-colophon-cue=""');
    expect(html).toContain('aria-label="向左读题跋"');
    expect(html).toContain('data-detail-reading-variant="desktop-comments"');
    expect(html.indexOf("data-desktop-detail-upper")).toBeLessThan(
      html.indexOf("data-test-actions"),
    );
    expect(html.indexOf("data-test-actions")).toBeLessThan(
      html.indexOf("data-desktop-detail-colophon"),
    );
    expect(html.indexOf('data-detail-section="sources"')).toBeLessThan(
      html.indexOf("data-desktop-detail-colophon"),
    );
    expect(html.match(/完整资料。/g)).toHaveLength(120);
    expect(html).toContain("释文原文。");
    expect(html).toContain('href="https://example.org/catalog"');
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
    expect(html).toContain("完整资料。");
  });

  it("leaves normal desktop detail's ordinary discussion and disclosure intact", () => {
    const html = render(catalog, { calligraphy: false });
    expect(html).toContain("data-detail-landscape-layout");
    expect(html).toContain("data-detail-reading-disclosure");
    expect(html).toContain("data-normal-comments");
    expect(html).not.toContain("data-desktop-calligraphy-detail");
  });
});

afterEach(() => {
  authJourney.returned = undefined;
  authJourney.capture = undefined;
});
it("restores only the exact auth journey's disclosure and reading positions into the new account scope", () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = (positionKey: string, key: string) =>
    act(() =>
      root.render(
        <DesktopCalligraphyDetailLayout
          key={key}
          activeMediaIndex={0}
          detail={{ ...work, media: [] }}
          leading={<h1>作品</h1>}
          information={
            <details data-desktop-information-group="work-body" open>
              <summary>正文</summary>
              <div data-desktop-group-content="">全部正文</div>
            </details>
          }
          positionKey={positionKey}
          onActiveMediaIndexChange={vi.fn()}
          onOpenViewer={vi.fn()}
          viewerOpen={false}
        />,
      ),
    );
  try {
    draw("guest:work:auth-test:calligraphy", "guest");
    const information = host.querySelector<HTMLElement>(
      "[data-desktop-detail-information]",
    )!;
    const group = host.querySelector<HTMLDetailsElement>("details")!;
    const body = host.querySelector<HTMLElement>(
      "[data-desktop-group-content]",
    )!;
    information.scrollTop = 90;
    body.scrollLeft = -140;
    group.open = false;
    authJourney.returned = authJourney.capture!();
    draw("account-1:work:auth-test:calligraphy", "returned");
    expect(host.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    expect(
      host.querySelector<HTMLElement>("[data-desktop-detail-information]")!
        .scrollTop,
    ).toBe(90);
    expect(
      host.querySelector<HTMLElement>("[data-desktop-group-content]")!
        .scrollLeft,
    ).toBe(-140);
    authJourney.returned = undefined;
    draw("account-2:work:auth-test:calligraphy", "other-account");
    expect(host.querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
    expect(
      host.querySelector<HTMLElement>("[data-desktop-detail-information]")!
        .scrollTop,
    ).toBe(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
