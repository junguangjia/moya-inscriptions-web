import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CatalogCard,
  feedMediaAspectRatio,
  isUltraWideCatalogMedia,
} from "./catalog-card";
import { CatalogBrowseScreen } from "./catalog-screen";
import { HomeScreen } from "./home-screen";
import { ProductShell } from "../product-shell/product-shell";

import type {
  CatalogId,
  CatalogPage,
  CatalogSummary,
  PublicMedia,
} from "@moya/contracts";

const catalogItem = (overrides: Partial<CatalogSummary> = {}): CatalogSummary =>
  ({
    id: "catalog-001",
    kind: "inscription",
    title: "云峰山刻石",
    aliases: [],
    summary: "公开摘要",
    periodLabel: "北魏",
    ...overrides,
  }) as CatalogSummary;

const page = (items: CatalogSummary[], total = items.length): CatalogPage =>
  ({
    items,
    total,
    page: 1,
    pageSize: 20,
    totalPages: total === 0 ? 0 : Math.ceil(total / 20),
  }) as CatalogPage;

describe("isUltraWideCatalogMedia", () => {
  it.each([
    [{ height: 1_000, width: 2_399 }, false],
    [{ height: 1_000, width: 2_400 }, true],
    [{ height: 280, width: 960 }, true],
  ] as const)("classifies %o as %s", (media, expected) => {
    expect(isUltraWideCatalogMedia(media)).toBe(expected);
  });

  it.each([
    undefined,
    { height: 0, width: 960 },
    { height: -1, width: 960 },
    { height: 280, width: 0 },
    { height: 280, width: -1 },
    { height: Number.NaN, width: 960 },
    { height: 280, width: Number.POSITIVE_INFINITY },
  ])("returns false for missing or invalid dimensions: %o", (media) => {
    expect(isUltraWideCatalogMedia(media)).toBe(false);
  });
});

describe("feedMediaAspectRatio", () => {
  it.each([
    [{ width: 3000, height: 300 }, 1.5],
    [{ width: 300, height: 3000 }, 0.75],
    [{ width: 900, height: 900 }, 1],
    [{ width: 1200, height: 900 }, 4 / 3],
    [{ width: 0, height: 0 }, 4 / 3],
  ])(
    "bounds extreme covers while preserving ordinary geometry: %o",
    (media, expected) => {
      expect(feedMediaAspectRatio(media)).toBe(expected);
    },
  );
});

describe("CatalogCard", () => {
  const ultraWideMedia = {
    alt: "合成超宽媒体",
    height: 1_000,
    id: "media-ultra-wide",
    kind: "image",
    src: "/ultra-wide.svg",
    width: 2_400,
  } as PublicMedia;

  it("preserves the accepted ultra-wide marker for feed cards", () => {
    const ultraWideItem = catalogItem({ representativeMedia: ultraWideMedia });
    const regularItem = catalogItem({
      representativeMedia: {
        ...ultraWideMedia,
        id: "media-regular",
        width: 2_399,
      } as PublicMedia,
    });

    expect(isUltraWideCatalogMedia(ultraWideItem.representativeMedia)).toBe(
      true,
    );
    expect(isUltraWideCatalogMedia(regularItem.representativeMedia)).toBe(
      false,
    );
    expect(
      renderToStaticMarkup(<CatalogCard item={ultraWideItem} variant="feed" />),
    ).toContain('data-catalog-feed-span="full"');
  });

  it("does not mark inscription cards even when their media is ultra-wide", () => {
    expect(
      renderToStaticMarkup(
        <CatalogCard
          item={catalogItem({ representativeMedia: ultraWideMedia })}
          variant="inscription"
        />,
      ),
    ).not.toContain("data-catalog-feed-span");
  });

  it("shows the authoritative province without inventing missing metadata", () => {
    const withProvince = renderToStaticMarkup(
      <CatalogCard item={catalogItem({ province: "山东" })} variant="feed" />,
    );
    expect(withProvince).toContain('data-catalog-province=""');
    expect(withProvince).toContain("山东");
    expect(
      renderToStaticMarkup(<CatalogCard item={catalogItem()} variant="feed" />),
    ).not.toContain("data-catalog-province");
  });

  it("uses one whole-card action only when a real callback is composed", () => {
    const withoutAction = renderToStaticMarkup(
      <CatalogCard item={catalogItem()} variant="feed" />,
    );
    const withAction = renderToStaticMarkup(
      <CatalogCard
        item={catalogItem()}
        onOpenCatalog={() => undefined}
        variant="feed"
      />,
    );

    expect(withoutAction).not.toContain("data-open-catalog");
    expect(withAction.match(/data-open-catalog=/g)).toHaveLength(1);
    expect(withAction).toContain('aria-label="打开云峰山刻石"');
    expect(withAction.match(/<button/g)).toHaveLength(1);
  });
});

describe("HomeScreen", () => {
  const renderHome = (
    discover:
      | {
          readonly items: readonly CatalogSummary[];
          readonly state: "populated";
        }
      | { readonly state: "empty" | "unavailable" | "unexpected-error" },
  ) =>
    renderToStaticMarkup(
      <ProductShell
        user={<div>书帖测试面板</div>}
        home={
          <HomeScreen
            data={{
              discover,
              nearby: { state: "empty" },
              topics: { state: "empty" },
            }}
          />
        }
        initialPlatform="phone"
        discussion={<div>碑刻测试面板</div>}
      />,
    );

  it("renders populated Catalog content and only the PublicMedia runtime URL", () => {
    const markup = renderHome({
      state: "populated",
      items: [
        catalogItem({
          representativeMedia: {
            id: "media-001",
            kind: "image",
            src: "https://media.example.invalid/catalog-001.jpg",
            alt: "云峰山刻石公开图像",
            width: 1200,
            height: 1600,
          } as PublicMedia,
        }),
      ],
    });

    expect(markup).toContain('data-home-surface=""');
    expect(markup.match(/data-tab-key=/g)).toHaveLength(4);
    expect(markup).toContain(">发现<");
    expect(markup).toContain(">附近<");
    expect(markup).toContain(">碑刻<");
    expect(markup).toContain(">书帖<");
    expect(markup).not.toContain(">专题<");
    expect(markup).toContain("云峰山刻石");
    expect(markup).toContain(
      'src="https://media.example.invalid/catalog-001.jpg"',
    );
    // Phone opens on the single-column feed: the image is a post's stage.
    expect(markup).toContain('data-feed-slide-image=""');
    expect(markup).not.toContain("objectKey");
    expect(markup).not.toContain("object_key");
    expect(markup).toContain('data-open-catalog=""');
    expect(markup).toContain('aria-label="打开云峰山刻石"');
  });

  it("keeps the Catalog total out of presentation", () => {
    const markup = renderHome({
      items: [catalogItem()],
      state: "populated",
    });

    expect(markup).toContain("云峰山刻石");
  });

  it("renders semantic no-media fallback and sparse metadata", () => {
    const markup = renderHome({
      items: [
        catalogItem({
          aliases: [],
          periodLabel: undefined,
          representativeMedia: undefined,
          summary: undefined,
        }),
      ],
      state: "populated",
    });

    expect(markup).toContain('data-catalog-media-state="missing"');
    expect(markup).toContain("暂无公开图像");
    expect(markup).toContain("碑刻");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("<img");
  });

  it("renders a very long synthetic title without truncating content", () => {
    const longTitle =
      "合成长题名用于验证多行排版与稀疏元数据时卡片仍然保持完整可读且不暗示真实文物身份";
    const markup = renderHome({
      items: [catalogItem({ title: longTitle })],
      state: "populated",
    });

    expect(markup).toContain(longTitle);
  });

  it.each([
    [{ state: "empty" }, "暂无公开档案"],
    [{ state: "unavailable" }, "档案服务暂时不可用"],
    [{ state: "unexpected-error" }, "无法加载公开档案"],
  ] as const)("renders the %s state", (state, expectedText) => {
    expect(renderHome(state)).toContain(expectedText);
  });
});

describe("CatalogBrowseScreen", () => {
  const mixedState = {
    state: "populated",
    page: page([
      catalogItem({
        id: "inscription-001" as CatalogId,
        title: "合成碑刻",
      }),
      catalogItem({
        id: "calligraphy-001" as CatalogId,
        kind: "calligraphy",
        title: "合成书帖",
      }),
    ]),
  } as const;

  it("filters the shared Catalog state to inscription list rows", () => {
    const markup = renderToStaticMarkup(
      <CatalogBrowseScreen
        feedLayout="double"
        kind="inscription"
        onOpenCatalog={() => {}}
        state={mixedState}
      />,
    );

    expect(markup).toContain('data-catalog-presentation="inscription"');
    expect(markup).toContain('data-catalog-item-count="1"');
    expect(markup).toContain('data-catalog-card-variant="inscription"');
    expect(markup).toContain("合成碑刻");
    expect(markup).toContain('data-open-catalog=""');
    expect(markup).not.toContain("合成书帖");
  });

  it("filters the shared Catalog state to calligraphy feed cards", () => {
    const markup = renderToStaticMarkup(
      <CatalogBrowseScreen
        feedLayout="single"
        kind="calligraphy"
        onOpenCatalog={() => {}}
        state={mixedState}
      />,
    );

    expect(markup).toContain('data-catalog-presentation="calligraphy"');
    expect(markup).toContain('data-catalog-item-count="1"');
    expect(markup).toContain('data-catalog-card-variant="feed"');
    expect(markup).toContain('data-feed-layout="single"');
    expect(markup).toContain("合成书帖");
    expect(markup).toContain('data-open-catalog=""');
    expect(markup).not.toContain("合成碑刻");
  });
});
