// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeScreen } from "./home-screen";
import { ProductShell } from "../product-shell/product-shell";

import type { Root } from "react-dom/client";
import type { HomeSurfaceData } from "./home-feed";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const elementScrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
const emptyHome: HomeSurfaceData = {
  discover: { state: "empty" },
  timeline: { state: "empty" },
  topics: { state: "empty" },
};

const mediaQuery = (): MediaQueryList =>
  ({
    addEventListener: vi.fn(),
    matches: false,
    removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList;

const renderHome = (platform: "phone" | "tablet" | "pc" = "phone") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ProductShell
        user={<p>Calligraphy panel</p>}
        developmentPlatformOverride={platform}
        home={<HomeScreen data={emptyHome} />}
        initialPlatform={platform}
        discussion={<p>Inscriptions panel</p>}
      />,
    );
  });
  return container;
};

const feedTab = (container: ParentNode, feed: string) =>
  container.querySelector<HTMLButtonElement>(`[data-tab-key="${feed}"]`)!;

describe("HomeScreen integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    window.history.replaceState(null, "", "/dev/t02p");
    window.localStorage.clear();
    document.documentElement.dataset.yoyiBootStarted = String(
      performance.now() - 1_000,
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(mediaQuery),
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: null,
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function scrollTo(
        this: HTMLElement,
        options?: ScrollToOptions | number,
        top?: number,
      ) {
        const left =
          typeof options === "number" ? options : (options?.left ?? 0);
        this.scrollLeft = left;
        if (typeof options === "number" && top !== undefined) {
          this.scrollTop = top;
        }
        this.dispatchEvent(new Event("scroll"));
        this.dispatchEvent(new Event("scrollend"));
      },
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => window.clearTimeout(id),
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
      function (this: HTMLElement) {
        const feed = this.dataset.homeFeedPanel;
        return (
          Math.max(
            0,
            ["discover", "timeline", "inscriptions", "calligraphy"].indexOf(
              feed ?? "",
            ),
          ) * 390
        );
      },
    );
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (elementScrollToDescriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    } else {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTo",
        elementScrollToDescriptor,
      );
    }
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders exactly four related tabs and keeps every panel mounted but inert", async () => {
    const container = renderHome();
    await act(async () => vi.runAllTimers());
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-tab-key]"),
    );
    const panels = Array.from(
      container.querySelectorAll<HTMLElement>("[data-home-feed-panel]"),
    );

    expect(tabs.map(({ textContent }) => textContent)).toEqual([
      "发现",
      "时间轴",
      "碑刻",
      "书帖",
    ]);
    expect(
      tabs.filter((tab) => tab.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    expect(panels).toHaveLength(4);
    expect(container.querySelectorAll("[data-top-tab-indicator]")).toHaveLength(
      1,
    );
    for (const tab of tabs) {
      const panel = container.querySelector<HTMLElement>(
        `#${tab.getAttribute("aria-controls")}`,
      )!;
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    expect(panels[0]?.hasAttribute("hidden")).toBe(false);
    expect(panels[1]?.hasAttribute("hidden")).toBe(false);
    expect(panels[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(panels[1]?.hasAttribute("inert")).toBe(true);
    expect(container.querySelectorAll("[data-open-settings]")).toHaveLength(0);
    expect(container.querySelectorAll("h1, h2")).not.toContainEqual(
      expect.objectContaining({ textContent: "发现" }),
    );
  });

  it("keeps four Phone feed scroll positions in their mounted native panels", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const container = renderHome();
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    const shell = container.querySelector<HTMLElement>("[data-product-shell]")!;
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    const panels = {
      discover: container.querySelector<HTMLElement>(
        '[data-home-feed-panel="discover"]',
      )!,
      timeline: container.querySelector<HTMLElement>(
        '[data-home-feed-panel="timeline"]',
      )!,
      inscriptions: container.querySelector<HTMLElement>(
        '[data-home-feed-panel="inscriptions"]',
      )!,
      calligraphy: container.querySelector<HTMLElement>(
        '[data-home-feed-panel="calligraphy"]',
      )!,
    };
    const identities = { ...panels };
    for (const panel of Object.values(panels)) {
      Object.defineProperty(panel, "scrollHeight", {
        configurable: true,
        value: 2_000,
      });
      Object.defineProperty(panel, "clientHeight", {
        configurable: true,
        value: 600,
      });
    }

    panels.discover.scrollTop = 137;
    act(() => feedTab(container, "timeline").click());
    await act(async () => vi.runAllTimers());
    expect(home.scrollTop).toBe(0);
    expect(panels.timeline.scrollTop).toBe(0);
    panels.timeline.scrollTop = 88;
    act(() => feedTab(container, "calligraphy").click());
    await act(async () => vi.runAllTimers());
    panels.calligraphy.scrollTop = 44;
    act(() => feedTab(container, "inscriptions").click());
    await act(async () => vi.runAllTimers());
    panels.inscriptions.scrollTop = 212;

    act(() => feedTab(container, "discover").click());
    await act(async () => vi.runAllTimers());
    expect(panels.discover.scrollTop).toBe(137);
    act(() => feedTab(container, "timeline").click());
    await act(async () => vi.runAllTimers());
    expect(panels.timeline.scrollTop).toBe(88);
    act(() => feedTab(container, "inscriptions").click());
    await act(async () => vi.runAllTimers());
    expect(panels.inscriptions.scrollTop).toBe(212);
    act(() => feedTab(container, "calligraphy").click());
    await act(async () => vi.runAllTimers());
    expect(
      feedTab(container, "calligraphy").getAttribute("aria-selected"),
    ).toBe("true");
    expect(panels.calligraphy.scrollTop).toBe(44);
    expect(home.scrollTop).toBe(0);
    expect(
      Object.fromEntries(
        Object.keys(panels).map((feed) => [
          feed,
          container.querySelector(`[data-home-feed-panel="${feed}"]`) ===
            identities[feed as keyof typeof identities],
        ]),
      ),
    ).toEqual({
      discover: true,
      timeline: true,
      inscriptions: true,
      calligraphy: true,
    });
    expect(shell.dataset.activeDestination).toBe("home");
    expect(replaceState).not.toHaveBeenCalled();

    const primaryButton = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.getAttribute("aria-label") === label,
      )!;
    act(() => primaryButton("讨论").click());
    await act(async () => vi.runAllTimers());
    act(() => primaryButton("首页").click());
    await act(async () => vi.runAllTimers());
    expect(
      feedTab(container, "calligraphy").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      feedTab(container, "calligraphy").getAttribute("aria-selected"),
    ).toBe("true");
    expect(panels.calligraphy.scrollTop).toBe(44);
    expect(home.scrollTop).toBe(0);
  });

  it("keeps PC feed switching on the document scroll model", async () => {
    const container = renderHome("pc");
    await act(async () => vi.runAllTimers());
    const scrollTo = vi.mocked(window.scrollTo);
    const documentScroller = (document.scrollingElement ??
      document.documentElement) as HTMLElement;
    Object.defineProperty(documentScroller, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    Object.defineProperty(documentScroller, "clientHeight", {
      configurable: true,
      value: 600,
    });
    scrollTo.mockClear();

    documentScroller.scrollTop = 137;
    act(() => feedTab(container, "timeline").click());
    await act(async () => vi.runAllTimers());
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 0 });

    documentScroller.scrollTop = 88;
    act(() => feedTab(container, "discover").click());
    await act(async () => vi.runAllTimers());
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 137 });
    expect(
      container
        .querySelector('[data-home-feed-panel="discover"]')
        ?.hasAttribute("data-home-feed-scroll-surface"),
    ).toBe(false);
  });

  it("leaves orientation-time Primary scroll restoration with ProductShell", async () => {
    const container = renderHome();
    await act(async () => vi.runAllTimers());
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    const discover = container.querySelector<HTMLElement>(
      '[data-home-feed-panel="discover"]',
    )!;
    Object.defineProperty(discover, "scrollHeight", {
      configurable: true,
      value: 2_000,
    });
    Object.defineProperty(discover, "clientHeight", {
      configurable: true,
      value: 600,
    });
    const primaryButton = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.getAttribute("aria-label") === label,
      )!;

    discover.scrollTop = 180;
    act(() => primaryButton("讨论").click());
    await act(async () => vi.runAllTimers());
    act(() => primaryButton("首页").click());

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 700,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 390,
    });
    act(() => window.dispatchEvent(new Event("orientationchange")));
    await act(async () => vi.runAllTimers());

    expect(discover.scrollTop).toBe(180);
    expect(home.scrollTop).toBe(0);
  });
});
