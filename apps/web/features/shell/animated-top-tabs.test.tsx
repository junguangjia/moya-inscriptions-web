// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedTopTabs } from "./animated-top-tabs";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const items = [
  { id: "all", label: "全部", icon: <svg data-test-icon="all" /> },
  {
    id: "inscriptions",
    label: "碑刻",
    icon: <svg data-test-icon="inscriptions" />,
  },
  {
    id: "calligraphy",
    label: "书帖",
    icon: <svg data-test-icon="calligraphy" />,
  },
] as const;
type Key = (typeof items)[number]["id"];
let root: Root;
let host: HTMLDivElement;
const select = vi.fn();
const tab = (key: Key) =>
  host.querySelector<HTMLButtonElement>(`[data-tab-key="${key}"]`)!;
const render = async (activeKey: Key = "all", progress?: number) => {
  await act(async () =>
    root.render(
      <AnimatedTopTabs
        items={items}
        activeKey={activeKey}
        {...(progress === undefined ? {} : { progress })}
        onSelect={select}
        ariaLabel="内容分类"
        idPrefix="catalog"
      />,
    ),
  );
};
beforeEach(() => {
  select.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("AnimatedTopTabs", () => {
  it("uses vertical arrow keys and focus order for the desktop category rail", async () => {
    await act(async () =>
      root.render(
        <AnimatedTopTabs
          items={items}
          activeKey="all"
          onSelect={select}
          ariaLabel="内容分类"
          orientation="vertical"
        />,
      ),
    );
    expect(
      host.querySelector('[role="tablist"]')?.getAttribute("aria-orientation"),
    ).toBe("vertical");
    await act(async () =>
      tab("all").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(select).toHaveBeenLastCalledWith("inscriptions");
    expect(document.activeElement).toBe(tab("inscriptions"));
    await act(async () =>
      tab("inscriptions").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    expect(select).toHaveBeenLastCalledWith("all");
    expect(document.activeElement).toBe(tab("all"));
  });
  it("keeps accessible tab selection distinct from fractional pager progress", async () => {
    await render("all", 0.5);
    expect(
      host.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("内容分类");
    expect(tab("all").getAttribute("aria-selected")).toBe("true");
    expect(tab("inscriptions").getAttribute("aria-selected")).toBe("false");
    expect(tab("all").style.getPropertyValue("--top-tab-activation")).toBe(
      "0.5",
    );
    expect(
      tab("inscriptions").style.getPropertyValue("--top-tab-activation"),
    ).toBe("0.5");
    expect(
      tab("calligraphy").style.getPropertyValue("--top-tab-activation"),
    ).toBe("0");
    expect(tab("all").id).toBe("catalog-tab-all");
    expect(tab("all").getAttribute("aria-controls")).toBe("catalog-panel-all");
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });

  it("supports click and wrapping keyboard navigation without committing scroll progress", async () => {
    await render();
    await act(async () => tab("inscriptions").click());
    expect(select).toHaveBeenCalledExactlyOnceWith("inscriptions");
    select.mockReset();
    await act(async () =>
      tab("all").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(select).toHaveBeenCalledExactlyOnceWith("calligraphy");
    expect(document.activeElement).toBe(tab("calligraphy"));
    await act(async () =>
      tab("calligraphy").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    expect(select).toHaveBeenLastCalledWith("all");
    expect(document.activeElement).toBe(tab("all"));
  });

  it("uses the actual unequal tab geometry to interpolate the underline", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const key = this.dataset.tabKey;
        const rect =
          key === "all"
            ? { x: 20, width: 60 }
            : key === "inscriptions"
              ? { x: 88, width: 100 }
              : { x: 0, width: 400 };
        return {
          left: rect.x,
          right: rect.x + rect.width,
          top: 0,
          bottom: 48,
          x: rect.x,
          y: 0,
          width: rect.width,
          height: 48,
          toJSON() {},
        };
      },
    );
    await render("all", 0.5);
    const indicator = host.querySelector<HTMLElement>(
      "[data-top-tab-indicator]",
    )!;
    expect(indicator.style.width).toBe("80px");
    expect(indicator.style.transform).toBe("translateX(54px)");
    expect(select).not.toHaveBeenCalled();
  });

  it("reveals a newly selected tab by scrolling only the tab viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const key = this.dataset.tabKey;
        const left = key === "calligraphy" ? 220 : 0;
        const width = key ? 100 : 180;
        return {
          left,
          right: left + width,
          top: 0,
          bottom: 48,
          x: left,
          y: 0,
          width,
          height: 48,
          toJSON() {},
        };
      },
    );
    await render();
    await render("calligraphy");
    expect(
      host.querySelector<HTMLElement>("[data-animated-top-tabs]")!.scrollLeft,
    ).toBe(140);
    expect(window.scrollX).toBe(0);
  });

  it("keeps pager-driven transitions in one mode through integer and reversed progress", async () => {
    for (const position of [
      0, 0.25, 0.5, 0.9999, 1, 1.0001, 1, 0.75, 0.25, 0,
    ]) {
      await render("all", position);
      expect(
        host
          .querySelector('[role="tablist"]')
          ?.getAttribute("data-progress-driven"),
      ).toBe("true");
      expect(tab("all").getAttribute("aria-selected")).toBe("true");
    }
    expect(select).not.toHaveBeenCalled();
    await render("all");
    expect(
      host
        .querySelector('[role="tablist"]')
        ?.getAttribute("data-progress-driven"),
    ).toBe("false");
  });

  it("does not reveal the old selected tab during a swipe", async () => {
    await render("all");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const left = this.dataset.tabKey === "all" ? -40 : 0;
        return {
          left,
          right: left + 100,
          width: 100,
          top: 0,
          bottom: 48,
          x: left,
          y: 0,
          height: 48,
          toJSON() {},
        };
      },
    );
    const viewport = host.querySelector<HTMLElement>(
      "[data-animated-top-tabs]",
    )!;
    viewport.scrollLeft = 40;
    for (const position of [0.25, 0.5, 0.75, 1]) {
      await render("all", position);
      expect(viewport.scrollLeft).toBe(40);
    }
  });

  it("clamps stale progress and falls back to the selected tab for non-finite values", async () => {
    await render("all", 40);
    expect(
      tab("calligraphy").style.getPropertyValue("--top-tab-activation"),
    ).toBe("1");
    await render("inscriptions", Number.NaN);
    expect(
      tab("inscriptions").style.getPropertyValue("--top-tab-activation"),
    ).toBe("1");
  });
});
