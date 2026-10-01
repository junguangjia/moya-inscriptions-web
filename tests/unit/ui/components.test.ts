// @vitest-environment jsdom
/// <reference lib="dom" />

import { createElement, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Button,
  CalligraphyCategoryTabs,
  DesktopTopNavigation,
  Dialog,
  DiscoverNearbyTabs,
  Drawer,
  Icon,
  LoadingScreen,
  MobileBottomNavigation,
  SearchInput,
  Sheet,
  Tabs,
  ThemeCycleButton,
} from "@moya/ui";

afterEach(() => cleanup());

beforeAll(() => {
  if (!("showModal" in HTMLDialogElement.prototype)) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  }
  if (!("close" in HTMLDialogElement.prototype)) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      },
    });
  }
});

describe("public controls", () => {
  it("renders native disabled and accessible states", () => {
    render(
      createElement(
        "div",
        null,
        createElement(Button, { disabled: true }, "保存"),
        createElement(SearchInput, {
          label: "搜索碑刻",
          placeholder: "输入关键词",
        }),
        createElement(Icon, { label: "搜索", name: "search" }),
        createElement(Icon, { label: "设置", name: "settings" }),
      ),
    );

    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("searchbox", { name: "搜索碑刻" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "搜索" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "设置" })).toBeTruthy();
  });

  it("marks the active mobile navigation item", () => {
    render(
      createElement(MobileBottomNavigation, {
        activeId: "inscriptions",
        items: [
          {
            id: "home",
            label: "首页",
            labelMark: "nav-home",
            href: "/",
            icon: "home",
          },
          {
            id: "inscriptions",
            label: "碑刻",
            labelMark: "nav-inscriptions",
            href: "/inscriptions",
            icon: "inscriptions",
          },
          {
            id: "calligraphy",
            label: "书帖",
            labelMark: "nav-calligraphy",
            href: "/calligraphy",
            icon: "calligraphy",
          },
        ],
      }),
    );

    expect(
      screen.getByRole("link", { name: "碑刻" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "碑刻" })
        .querySelector('[data-label="nav-inscriptions"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("navigation")
        .classList.contains("yoyi-functional-glass"),
    ).toBe(true);
  });

  it("minimizes phone navigation on downward scroll and restores it", () => {
    function NavigationHarness() {
      const scrollContainerRef = useRef<HTMLDivElement>(null);
      return createElement(
        "div",
        null,
        createElement("div", {
          "data-testid": "scroll-container",
          ref: scrollContainerRef,
        }),
        createElement(MobileBottomNavigation, {
          activeId: "home",
          items: [
            { id: "home", label: "首页", icon: "home" },
            {
              id: "inscriptions",
              label: "碑刻",
              icon: "inscriptions",
            },
            { id: "calligraphy", label: "书帖", icon: "calligraphy" },
          ],
          minimizeBehavior: "on-scroll-down",
          scrollContainerRef,
        }),
      );
    }

    render(createElement(NavigationHarness));
    const navigation = screen.getByRole("navigation");
    const scrollContainer = screen.getByTestId("scroll-container");

    scrollContainer.scrollTop = 13;
    fireEvent.scroll(scrollContainer);
    expect(navigation.getAttribute("data-minimized")).toBe("true");

    scrollContainer.scrollTop = 4;
    fireEvent.scroll(scrollContainer);
    expect(navigation.hasAttribute("data-minimized")).toBe(false);

    scrollContainer.scrollTop = 20;
    fireEvent.scroll(scrollContainer);
    fireEvent.click(screen.getByRole("button", { name: "首页" }));
    expect(navigation.hasAttribute("data-minimized")).toBe(false);
  });

  it("only creates a desktop brand link when the caller supplies one", () => {
    render(
      createElement(
        "div",
        null,
        createElement(DesktopTopNavigation, {
          brandLabel: "由艺",
          items: [],
          searchLabel: "搜索一",
        }),
        createElement(DesktopTopNavigation, {
          brandHref: "/home",
          brandLabel: "由艺入口",
          items: [],
          searchLabel: "搜索二",
        }),
      ),
    );

    expect(screen.queryByRole("link", { name: "由艺" })).toBeNull();
    expect(screen.getByRole("img", { name: "由艺" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "由艺入口" }).getAttribute("href"),
    ).toBe("/home");
  });

  it("cycles the controlled theme preference in the documented order", () => {
    function ThemeHarness() {
      const [value, setValue] = useState<"system" | "light" | "dark">("system");
      return createElement(ThemeCycleButton, {
        onValueChange: setValue,
        value,
      });
    }

    render(createElement(ThemeHarness));
    fireEvent.click(
      screen.getByRole("button", {
        name: "当前主题：跟随系统，切换为浅色",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "当前主题：浅色，切换为深色" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "当前主题：深色，切换为跟随系统",
      }),
    );
    expect(
      screen
        .getByRole("button", {
          name: "当前主题：跟随系统，切换为浅色",
        })
        .getAttribute("data-theme-preference"),
    ).toBe("system");
  });
});

describe("tabs and categories", () => {
  it("uses system text for the discover and nearby navigation labels", () => {
    const onValueChange = vi.fn();
    render(
      createElement(DiscoverNearbyTabs, {
        onValueChange,
        value: "discover",
      }),
    );

    expect(screen.getByRole("tab", { name: "发现" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "附近" })).toBeTruthy();
    expect(document.querySelector(".yoyi-fixed-label")).toBeNull();
  });
  function TabsHarness() {
    const [value, setValue] = useState("all");
    return createElement(CalligraphyCategoryTabs, {
      ariaLabel: "书帖分类",
      onValueChange: setValue,
      options: [
        { id: "all", label: "全部" },
        { id: "ink", label: "墨迹" },
        { id: "rubbing", label: "拓本" },
        { id: "album", label: "册页", disabled: true },
      ],
      value,
    });
  }

  it("supports dynamic category counts and arrow-key selection", () => {
    render(createElement(TabsHarness));
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);

    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(
      screen.getByRole("tab", { name: "墨迹" }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "墨迹" }), {
      key: "End",
    });
    expect(
      screen.getByRole("tab", { name: "拓本" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("supports manual activation", () => {
    const onValueChange = vi.fn();
    render(
      createElement(Tabs, {
        activationMode: "manual",
        ariaLabel: "示例标签",
        items: [
          { id: "one", label: "一" },
          { id: "two", label: "二" },
        ],
        onValueChange,
        value: "one",
      }),
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "二" }), {
      key: "Enter",
    });
    expect(onValueChange).toHaveBeenCalledWith("two");
  });
});

describe("overlays and loading", () => {
  for (const [name, Component] of [
    ["Dialog", Dialog],
    ["Drawer", Drawer],
    ["Sheet", Sheet],
  ] as const) {
    it(`renders and closes ${name}`, () => {
      const onOpenChange = vi.fn();
      render(
        createElement(Component, {
          children: "浮层内容",
          onOpenChange,
          open: true,
          title: `${name} 标题`,
        }),
      );
      expect(screen.getByText("浮层内容")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  }

  it("delays LoadingScreen to avoid short flashes", () => {
    vi.useFakeTimers();
    render(createElement(LoadingScreen, { delay: 160 }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(160));
    expect(screen.getByRole("status", { name: "由于艺正在加载" })).toBeTruthy();
    expect(screen.getByText("志于道，据于德，依于仁，游于艺")).toBeTruthy();
    vi.useRealTimers();
  });
});
