// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchSameOriginCatalogPageMock } = vi.hoisted(() => ({
  fetchSameOriginCatalogPageMock: vi.fn(),
}));

vi.mock("../../lib/public-api/catalog-list-client", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchSameOriginCatalogPage: fetchSameOriginCatalogPageMock,
}));

import { createRuntimeCalligraphyCategorySurface } from "./calligraphy-category";
import {
  AllCalligraphyFeed,
  CalligraphyCategoryScreen,
} from "./calligraphy-category-screen";

import type { Root } from "react-dom/client";
import type { CatalogId, CatalogPage, CatalogSummary } from "@moya/contracts";
import type { ReactNode } from "react";
import type { CalligraphyCategorySurfaceData } from "./calligraphy-category";

const openCatalog = vi.fn();
const shellLayout = {
  feedLayout: "double" as "single" | "double",
  platform: "phone" as "phone" | "tablet" | "pc",
};
const readActiveScrollTop = vi.fn(() => 0);
const restoreActiveScrollTop = vi.fn();

vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    activeCatalogId: null,
    activeDestination: "home",
    feedLayout: shellLayout.feedLayout,
    openCatalog,
    platform: shellLayout.platform,
    readActiveScrollTop,
    restoreActiveScrollTop,
  }),
}));

vi.mock("../home/catalog-masonry", () => ({
  CatalogMasonry: ({
    items,
    renderItem,
  }: {
    readonly items: readonly CatalogSummary[];
    readonly renderItem: (
      item: CatalogSummary,
      settled: () => void,
    ) => ReactNode;
  }) => (
    <div data-test-masonry="">
      {items.map((item) => (
        <div key={item.id}>{renderItem(item, vi.fn())}</div>
      ))}
    </div>
  ),
}));

vi.mock("../home/catalog-card", () => ({
  CatalogCard: ({
    item,
    onOpenCatalog,
  }: {
    readonly item: CatalogSummary;
    readonly onOpenCatalog?: (
      item: CatalogSummary,
      opener: HTMLButtonElement,
    ) => void;
  }) => (
    <button
      type="button"
      data-catalog-id={item.id}
      onClick={(event) => onOpenCatalog?.(item, event.currentTarget)}
    >
      {item.title}
    </button>
  ),
  isUltraWideCatalogMedia: () => false,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let scrollToCalls: ScrollToOptions[] = [];
let viewportHeight = 800;
let viewportWidth = 400;

const page = (
  items: readonly CatalogSummary[],
  options: Partial<Pick<CatalogPage, "page" | "total" | "totalPages">> = {},
): CatalogPage => ({
  items: [...items],
  page: options.page ?? 1,
  pageSize: 24,
  total: options.total ?? items.length,
  totalPages: options.totalPages ?? (items.length === 0 ? 0 : 1),
});

const item = (id: string, title: string): CatalogSummary => ({
  aliases: [],
  id: id as CatalogId,
  kind: "calligraphy",
  title,
});

const renderScreen = (
  data: CalligraphyCategorySurfaceData,
  initialScrollTop?: number,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <section data-primary-destination="home">
        <CalligraphyCategoryScreen data={data} />
      </section>,
    ),
  );
  const frame = container.querySelector<HTMLElement>(
    "[data-calligraphy-category-pager]",
  )!;
  const destination = container.querySelector<HTMLElement>(
    '[data-primary-destination="home"]',
  )!;
  let top = initialScrollTop ?? 0;
  const scrollWrites: number[] = [];
  Object.defineProperties(destination, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: {
      configurable: true,
      get: () => Math.max(200, Number.parseFloat(frame.style.height)),
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (requested: number) => {
        top = Math.max(
          0,
          Math.min(
            requested,
            destination.scrollHeight - destination.clientHeight,
          ),
        );
        scrollWrites.push(top);
      },
    },
  });
  if (initialScrollTop !== undefined) {
    // Reads describe actual owner state, independent of how many consumers
    // inspect it before a category commit.
    readActiveScrollTop.mockImplementation(() => destination.scrollTop);
  }
  return {
    container,
    frame,
    destination,
    scrollWrites,
    nativeScrollTo: (value: number) =>
      act(() => {
        top = value;
        destination.dispatchEvent(new Event("scroll"));
      }),
  };
};

const activateCategory = (
  container: HTMLElement,
  frame: HTMLElement,
  category: "all" | "ink" | "rubbing",
) => {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        `[data-calligraphy-category-tab="${category}"]`,
      )
      ?.click(),
  );
  expect(frame.scrollLeft).toBe(0);
};

const touch = (frame: HTMLElement, type: string, x = 300) => {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: (type === "touchend"
      ? []
      : [{ clientX: x, clientY: 300 }]) as Touch[],
  });
  Object.defineProperty(event, "timeStamp", { value: performance.now() });
  act(() => frame.dispatchEvent(event));
};

describe("CalligraphyCategoryScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    scrollToCalls = [];
    shellLayout.feedLayout = "double";
    shellLayout.platform = "phone";
    fetchSameOriginCatalogPageMock.mockReset();
    openCatalog.mockReset();
    readActiveScrollTop.mockReset();
    readActiveScrollTop.mockReturnValue(0);
    restoreActiveScrollTop.mockReset();
    viewportHeight = 800;
    viewportWidth = 400;
    vi.spyOn(window, "innerHeight", "get").mockImplementation(
      () => viewportHeight,
    );
    vi.spyOn(window, "innerWidth", "get").mockImplementation(
      () => viewportWidth,
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
      function (this: HTMLElement) {
        return (
          { all: 0, ink: 400, rubbing: 800 }[
            this.dataset.calligraphyCategoryPanel ?? "all"
          ] ?? 0
        );
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        bottom: 600,
        height: 600,
        left: 0,
        right: 400,
        toJSON: () => undefined,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
      }),
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        scrollToCalls.push(options);
        this.scrollLeft = Number(options.left ?? 0);
        this.dispatchEvent(new Event("scroll"));
      },
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 16),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => window.clearTimeout(id),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLElement.prototype, "onscrollend", {
      configurable: true,
      value: null,
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("shows the frozen tabs with continuous progress and truthful runtime states", () => {
    const data = createRuntimeCalligraphyCategorySurface({
      page: page([item("runtime-calligraphy", "运行时书帖")]),
      state: "populated",
    });
    const { container, frame } = renderScreen(data);
    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["全部", "墨迹", "拓本"]);
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(
      container
        .querySelector('[data-calligraphy-category-panel="all"]')
        ?.getAttribute("data-catalog-presentation"),
    ).toBe("calligraphy");
    expect(
      container
        .querySelector('[data-calligraphy-category-panel="all"]')
        ?.getAttribute("data-catalog-presentation-state"),
    ).toBe("populated");
    expect(
      container.querySelector(
        '[data-calligraphy-category-panel="all"] [data-feed-layout="double"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector("[data-test-masonry]")?.textContent).toBe(
      "运行时书帖",
    );

    touch(frame, "touchstart");
    touch(frame, "touchmove", 100);
    act(() => vi.advanceTimersByTime(32));
    const track = frame.firstElementChild as HTMLElement;
    const translatedLeft = Number(
      track.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1],
    );
    expect(translatedLeft).toBeLessThan(-100);
    expect(translatedLeft).toBeGreaterThan(-200);
    // The indicator follows the rendered track during Embla's physical
    // response, instead of assuming an immediate native scrollLeft write.
    expect(
      Number(
        container
          .querySelector("[data-calligraphy-category-indicator]")
          ?.getAttribute("data-calligraphy-category-progress"),
      ),
    ).toBe(-translatedLeft / 400);
    touch(frame, "touchend");

    activateCategory(container, frame, "ink");
    expect(
      container
        .querySelector("[data-calligraphy-category-surface]")
        ?.getAttribute("data-active-calligraphy-category"),
    ).toBe("ink");
    expect(container.textContent).toContain("墨迹分类数据尚未接入");
    expect(container.textContent).toContain("当前公开目录尚未提供规范分类");
  });

  it("preserves accepted all-category state copy", () => {
    const states = [
      [{ page: page([]), state: "empty" }, "暂无公开书帖"],
      [{ state: "unavailable" }, "档案服务暂时不可用"],
      [{ state: "unexpected-error" }, "无法加载公开档案"],
    ] as const;

    for (const [catalogState, copy] of states) {
      const { container } = renderScreen(
        createRuntimeCalligraphyCategorySurface(catalogState),
      );
      const activePanel = container.querySelector(
        '[data-calligraphy-category-panel="all"]',
      );
      expect(activePanel?.getAttribute("data-catalog-presentation-state")).toBe(
        catalogState.state,
      );
      expect(activePanel?.textContent).toContain(copy);
    }
  });

  it("preserves independent category scroll and opens the unchanged Catalog identity", () => {
    const allItems = [
      item("qa-ink", "墨迹（视觉 QA 合成）"),
      item("qa-rubbing", "拓本（视觉 QA 合成）"),
    ];
    const data: CalligraphyCategorySurfaceData = {
      categories: {
        all: { page: page(allItems), state: "populated" },
        ink: { page: page([allItems[0]!]), state: "populated" },
        rubbing: { page: page([allItems[1]!]), state: "populated" },
      },
      classificationSource: "qa-synthetic",
    };
    const { container, frame, destination, nativeScrollTo } = renderScreen(
      data,
      137,
    );

    activateCategory(container, frame, "ink");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(0);
    expect(destination.scrollTop).toBe(0);
    nativeScrollTo(88);
    activateCategory(container, frame, "rubbing");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(0);
    expect(destination.scrollTop).toBe(0);
    activateCategory(container, frame, "ink");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(88);
    expect(destination.scrollTop).toBe(88);
    activateCategory(container, frame, "all");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(137);
    expect(destination.scrollTop).toBe(137);

    const opener = container.querySelector<HTMLButtonElement>(
      '[data-calligraphy-category-panel="all"] [data-catalog-id="qa-ink"]',
    )!;
    act(() => opener.click());
    expect(openCatalog).toHaveBeenCalledWith("qa-ink", opener);
  });

  it("keeps appended all-category records across category switches and opens a page-2 identity", async () => {
    const firstPageItems = Array.from({ length: 24 }, (_, index) =>
      item(
        `runtime-calligraphy-${String(index + 1).padStart(2, "0")}`,
        `运行时书帖 ${index + 1}`,
      ),
    );
    const secondPageItems = Array.from({ length: 24 }, (_, index) =>
      item(
        `runtime-calligraphy-${String(index + 25).padStart(2, "0")}`,
        `运行时书帖 ${index + 25}`,
      ),
    );
    fetchSameOriginCatalogPageMock.mockResolvedValue({
      page: page(secondPageItems, { page: 2, total: 55, totalPages: 3 }),
      state: "success",
    });
    const { container, frame } = renderScreen(
      createRuntimeCalligraphyCategorySurface({
        page: page(firstPageItems, { total: 55, totalPages: 3 }),
        state: "populated",
      }),
      184,
    );

    expect(
      container.querySelectorAll(
        '[data-calligraphy-category-panel="all"] [data-catalog-id]',
      ),
    ).toHaveLength(24);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-catalog-paging-control]")
        ?.click();
    });

    expect(fetchSameOriginCatalogPageMock).toHaveBeenCalledWith(
      { kind: "calligraphy", page: "2", pageSize: "24" },
      expect.any(AbortSignal),
    );
    expect(
      container.querySelectorAll(
        '[data-calligraphy-category-panel="all"] [data-catalog-id]',
      ),
    ).toHaveLength(48);
    expect(
      container.querySelectorAll("[data-catalog-paging-control]"),
    ).toHaveLength(1);

    activateCategory(container, frame, "ink");
    expect(container.textContent).toContain("墨迹分类数据尚未接入");
    activateCategory(container, frame, "rubbing");
    expect(container.textContent).toContain("拓本分类数据尚未接入");
    activateCategory(container, frame, "all");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(184);
    expect(
      container.querySelectorAll(
        '[data-calligraphy-category-panel="all"] [data-catalog-id]',
      ),
    ).toHaveLength(48);

    const pageTwoOpener = container.querySelector<HTMLButtonElement>(
      '[data-calligraphy-category-panel="all"] [data-catalog-id="runtime-calligraphy-25"]',
    )!;
    act(() => pageTwoOpener.click());
    expect(openCatalog).toHaveBeenCalledWith(
      "runtime-calligraphy-25",
      pageTwoOpener,
    );
  });

  it("passes existing category snapshots to the entering panel without rebuilding Catalog cards", () => {
    const allItems = [
      item("qa-ink", "墨迹（视觉 QA 合成）"),
      item("qa-rubbing", "拓本（视觉 QA 合成）"),
    ];
    const data: CalligraphyCategorySurfaceData = {
      categories: {
        all: { page: page(allItems), state: "populated" },
        ink: { page: page([allItems[0]!]), state: "populated" },
        rubbing: { page: page([allItems[1]!]), state: "populated" },
      },
      classificationSource: "qa-synthetic",
    };
    const { container, frame, destination, nativeScrollTo } = renderScreen(
      data,
      137,
    );
    activateCategory(container, frame, "ink");
    nativeScrollTo(88);
    activateCategory(container, frame, "rubbing");
    act(() => vi.advanceTimersByTime(3000));
    nativeScrollTo(225);
    const inkPanel = container.querySelector<HTMLElement>(
      '[data-calligraphy-category-panel="ink"]',
    )!;
    const rubbingPanel = container.querySelector<HTMLElement>(
      '[data-calligraphy-category-panel="rubbing"]',
    )!;
    const oldCards = [...container.querySelectorAll("[data-catalog-id]")];
    touch(frame, "touchstart");
    for (let index = 1; index <= 10; index++) {
      act(() => vi.advanceTimersByTime(16));
      touch(frame, "touchmove", 300 + index * 22);
    }
    const incomingOffset = Number(
      inkPanel.style.transform.match(/translate3d\(0,\s*([-\d.]+)px/)?.[1] ?? 0,
    );
    expect(incomingOffset - destination.scrollTop).toBe(-88);
    touch(frame, "touchend");
    expect(destination.scrollTop).toBe(88);
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(88);
    expect(inkPanel.hasAttribute("inert")).toBe(false);
    expect(rubbingPanel.hasAttribute("inert")).toBe(true);
    expect([...container.querySelectorAll("[data-catalog-id]")]).toEqual(
      oldCards,
    );
    activateCategory(container, frame, "rubbing");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(225);
    expect(destination.scrollTop).toBe(225);
    activateCategory(container, frame, "all");
    expect(restoreActiveScrollTop).toHaveBeenLastCalledWith(137);
    expect(destination.scrollTop).toBe(137);
  });

  it("reapplies the active category scroll after resize and orientation", () => {
    readActiveScrollTop.mockReturnValue(146);
    const data = createRuntimeCalligraphyCategorySurface({
      page: page([item("runtime-calligraphy", "运行时书帖")]),
      state: "populated",
    });
    const { container } = renderScreen(data);
    const destination = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;

    act(() => destination.dispatchEvent(new Event("scroll")));
    readActiveScrollTop.mockReturnValue(0);
    viewportHeight = 400;
    viewportWidth = 800;
    act(() => {
      destination.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    });
    act(() => vi.runAllTimers());

    expect(restoreActiveScrollTop).toHaveBeenCalledWith(146);
  });

  // single-column-feed-v2: the Home 书帖 tab is two-column on phone and
  // tablet whatever the single-column setting says; PC follows the setting.
  it.each([
    ["phone", "single", "double"],
    ["tablet", "single", "double"],
    ["phone", "double", "double"],
    ["pc", "single", "single"],
    ["pc", "double", "double"],
  ] as const)(
    "lays the all-calligraphy feed out on %s with a %s setting as %s",
    (platform, setting, expected) => {
      shellLayout.platform = platform;
      shellLayout.feedLayout = setting;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      act(() =>
        root.render(
          <AllCalligraphyFeed
            data={createRuntimeCalligraphyCategorySurface({
              page: page([item("runtime-calligraphy", "运行时书帖")]),
              state: "populated",
            })}
          />,
        ),
      );
      expect(
        container
          .querySelector("[data-calligraphy-all] [data-feed-layout]")
          ?.getAttribute("data-feed-layout"),
      ).toBe(expected);
      expect(container.querySelector("[data-test-masonry]")?.textContent).toBe(
        "运行时书帖",
      );
    },
  );
});
