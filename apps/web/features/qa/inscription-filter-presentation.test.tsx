// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockDestination = "home" | "discussion" | "user";

const { shellState } = vi.hoisted(() => ({
  shellState: {
    activeDestination: "home" as MockDestination,
    platform: "pc" as "phone" | "tablet" | "pc",
    requestSettings: vi.fn(),
  },
}));

vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shellState,
}));

import {
  QaInscriptionFilter,
  QaNavigationSearchAction,
  QaProductUtilities,
  QaUtilitiesProvider,
} from "./inscription-filter-presentation";

import type { Root } from "react-dom/client";
import type { HomeFeed } from "../home/home-feed";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const renderFilter = (
  props: React.ComponentProps<typeof QaInscriptionFilter> = {},
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<QaInscriptionFilter {...props} />));
  return container;
};

const element = <T extends Element>(
  container: ParentNode,
  selector: string,
) => {
  const match = container.querySelector<T>(selector);
  if (match === null) throw new Error(`Missing ${selector}`);
  return match;
};

const buttonNamed = (container: ParentNode, name: string) => {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent === name);
  if (button === undefined) throw new Error(`Missing button ${name}`);
  return button;
};

const click = (target: Element | null) => {
  if (!(target instanceof HTMLElement)) throw new Error("Missing click target");
  act(() => target.click());
};

const pressEscape = () => {
  act(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
};

describe("QaInscriptionFilter", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    shellState.activeDestination = "home";
    shellState.platform = "pc";
    shellState.requestSettings.mockReset();
    vi.restoreAllMocks();
  });

  it("commits PC selections and category removal through both callbacks", () => {
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const container = renderFilter({ onApplyFilter, onFilterIntent });

    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="dynasty"]'));
    click(
      buttonNamed(
        element(container, '[data-filter-popover="dynasty"]'),
        "隋唐",
      ),
    );

    expect(onFilterIntent).toHaveBeenLastCalledWith({ dynasty: "隋唐" });
    expect(onApplyFilter).toHaveBeenLastCalledWith({ dynasty: "隋唐" });
    expect(
      container.querySelector('[data-filter-category="dynasty"]')?.textContent,
    ).toBe("隋唐 ×");

    click(container.querySelector('[data-filter-category="dynasty"]'));
    expect(onFilterIntent).toHaveBeenLastCalledWith({});
    expect(onApplyFilter).toHaveBeenLastCalledWith({});
    expect(container.textContent).toContain("朝代⌄");
  });

  it("commits category-level 全部 through both callbacks", () => {
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const container = renderFilter({ onApplyFilter, onFilterIntent });

    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="script"]'));
    click(
      buttonNamed(element(container, '[data-filter-popover="script"]'), "全部"),
    );

    expect(onFilterIntent).toHaveBeenCalledWith({});
    expect(onApplyFilter).toHaveBeenCalledWith({});
  });

  it("emits the complete full-reset callback contract", () => {
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const onResetFilter = vi.fn();
    const container = renderFilter({
      onApplyFilter,
      onFilterIntent,
      onResetFilter,
    });

    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="inscriptionType"]'));
    click(
      buttonNamed(
        element(container, '[data-filter-popover="inscriptionType"]'),
        "碑刻",
      ),
    );
    click(container.querySelector("[data-filter-reset]"));

    expect(onFilterIntent).toHaveBeenLastCalledWith({});
    expect(onApplyFilter).toHaveBeenLastCalledWith({});
    expect(onResetFilter).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("类型⌄");
  });

  it.each([
    ["dynasty", "秦汉"],
    ["script", "篆书"],
    ["inscriptionType", "摩崖"],
    ["region", "河南"],
  ] as const)("opens the PC %s button group", (category, option) => {
    const container = renderFilter();

    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector(`[data-filter-category="${category}"]`));

    const popover = element(container, `[data-filter-popover="${category}"]`);
    expect(popover.getAttribute("role")).toBe("group");
    expect(popover.querySelector('[role="option"]')).toBeNull();
    expect(popover.querySelector('[role="listbox"]')).toBeNull();
    expect(popover.textContent).toContain(option);
  });

  it("uses meaningful QA-only region options", () => {
    const container = renderFilter();
    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="region"]'));

    const labels = Array.from(
      element(container, '[data-filter-popover="region"]').querySelectorAll(
        "button",
      ),
      (button) => button.textContent,
    );
    expect(labels).toEqual(["全部", "河南", "陕西", "山东", "四川"]);
    expect(labels.slice(1)).not.toContain("地区");
  });

  it.each(["phone", "tablet"] as const)(
    "keeps compact drafts local until Confirm on %s",
    (platform) => {
      shellState.platform = platform;
      const onFilterIntent = vi.fn();
      const onApplyFilter = vi.fn();
      const container = renderFilter({ onApplyFilter, onFilterIntent });

      click(container.querySelector("[data-filter-trigger]"));
      const script = element<HTMLButtonElement>(
        container,
        '[data-filter-category="script"]',
      );
      click(script);
      const sheet = element(container, '[data-filter-sheet="script"]');
      const runningScript = Array.from(
        sheet.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).find((input) => input.parentElement?.textContent?.includes("行书"));
      if (runningScript === undefined) throw new Error("Missing 行书 option");

      act(() => runningScript.click());
      expect(onFilterIntent).not.toHaveBeenCalled();
      expect(onApplyFilter).not.toHaveBeenCalled();
      click(container.querySelector("[data-filter-confirm]"));

      expect(onFilterIntent).toHaveBeenCalledWith({ script: "行书" });
      expect(onApplyFilter).toHaveBeenCalledWith({ script: "行书" });
      expect(container.textContent).toContain("行书 ×");
      expect(script).toBe(document.activeElement);
    },
  );

  it("discards a compact draft on Cancel and restores its category chip", () => {
    shellState.platform = "phone";
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const container = renderFilter({ onApplyFilter, onFilterIntent });

    click(container.querySelector("[data-filter-trigger]"));
    const region = element<HTMLButtonElement>(
      container,
      '[data-filter-category="region"]',
    );
    click(region);
    const sheet = element(container, '[data-filter-sheet="region"]');
    const shaanxi = Array.from(
      sheet.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).find((input) => input.parentElement?.textContent?.includes("陕西"));
    if (shaanxi === undefined) throw new Error("Missing 陕西 option");
    act(() => shaanxi.click());
    click(buttonNamed(sheet, "取消"));

    expect(onFilterIntent).not.toHaveBeenCalled();
    expect(onApplyFilter).not.toHaveBeenCalled();
    expect(container.textContent).toContain("地区⌄");
    expect(region).toBe(document.activeElement);
  });

  it("restores the category chip when Escape closes a compact sheet", () => {
    shellState.platform = "tablet";
    const container = renderFilter();
    click(container.querySelector("[data-filter-trigger]"));
    const dynasty = element<HTMLButtonElement>(
      container,
      '[data-filter-category="dynasty"]',
    );
    click(dynasty);

    pressEscape();

    expect(container.querySelector("[data-filter-sheet]")).toBeNull();
    expect(dynasty).toBe(document.activeElement);
  });

  it("dismisses a compact sheet from its backdrop without committing the draft", () => {
    shellState.platform = "phone";
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const onOpenChange = vi.fn();
    const container = renderFilter({
      onApplyFilter,
      onFilterIntent,
      onOpenChange,
    });
    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="region"]'));
    const sheet = element(container, '[data-filter-sheet="region"]');
    const shandong = Array.from(
      sheet.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).find((input) => input.parentElement?.textContent?.includes("山东"));
    if (shandong === undefined) throw new Error("Missing 山东 option");
    act(() => shandong.click());

    const backdrop = element(container, "[data-filter-sheet-backdrop]");
    act(() =>
      backdrop.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );

    expect(container.querySelector("[data-filter-sheet]")).toBeNull();
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(onFilterIntent).not.toHaveBeenCalled();
    expect(onApplyFilter).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("commits compact Reset and restores the visible 全部 chip", () => {
    shellState.platform = "phone";
    const onFilterIntent = vi.fn();
    const onApplyFilter = vi.fn();
    const onResetFilter = vi.fn();
    const container = renderFilter({
      onApplyFilter,
      onFilterIntent,
      onResetFilter,
    });
    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="dynasty"]'));
    const sheet = element(container, '[data-filter-sheet="dynasty"]');

    click(buttonNamed(sheet, "重置"));

    expect(onFilterIntent).toHaveBeenLastCalledWith({});
    expect(onApplyFilter).toHaveBeenLastCalledWith({});
    expect(onResetFilter).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-filter-sheet]")).toBeNull();
    expect(element(container, "[data-filter-reset]")).toBe(
      document.activeElement,
    );
  });

  it("restores the main trigger when Escape closes only the filter panel", () => {
    const container = renderFilter();
    const trigger = element<HTMLButtonElement>(
      container,
      "[data-filter-trigger]",
    );
    click(trigger);

    pressEscape();

    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  const queueRestoreFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    return {
      frames,
      cancel,
      flush: () =>
        act(() => {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(0);
        }),
    };
  };

  it.each(["before", "after"] as const)(
    "distinguishes external focus moved %s Escape from the queued restore",
    (handoff) => {
      const queued = queueRestoreFrames();
      const container = renderFilter();
      const trigger = element<HTMLButtonElement>(
        container,
        "[data-filter-trigger]",
      );
      click(trigger);
      const outside = document.createElement("button");
      outside.textContent = "User";
      document.body.append(outside);
      if (handoff === "before") outside.focus();

      pressEscape();
      expect(container.querySelector("[data-filter-panel]")).toBeNull();
      expect(queued.frames.size).toBe(1);
      if (handoff === "after") outside.focus();
      expect(document.activeElement).toBe(outside);
      queued.flush();

      expect(document.activeElement).toBe(
        handoff === "after" ? outside : trigger,
      );
    },
  );

  it("restores from a removed panel after the queued Escape frame", () => {
    const queued = queueRestoreFrames();
    const container = renderFilter();
    const trigger = element<HTMLButtonElement>(
      container,
      "[data-filter-trigger]",
    );
    click(trigger);
    element<HTMLButtonElement>(container, "[data-filter-panel] button").focus();

    pressEscape();
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(queued.frames.size).toBe(1);
    queued.flush();

    expect(document.activeElement).toBe(trigger);
  });

  it("cancels the queued close restore when the filter is reopened", () => {
    const queued = queueRestoreFrames();
    const container = renderFilter();
    const trigger = element<HTMLButtonElement>(
      container,
      "[data-filter-trigger]",
    );
    click(trigger);
    pressEscape();
    expect(queued.frames.size).toBe(1);
    click(trigger);
    const chip = element<HTMLButtonElement>(
      container,
      "[data-filter-panel] button",
    );
    chip.focus();

    expect(queued.cancel).toHaveBeenCalledWith(1);
    expect(queued.frames.size).toBe(0);
    queued.flush();
    expect(document.activeElement).toBe(chip);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("cancels the queued close restore when the parent reopens the filter", () => {
    const queued = queueRestoreFrames();
    const container = renderFilter({ open: true });
    const root = roots.at(-1);
    if (root === undefined) throw new Error("Missing filter root");
    pressEscape();
    act(() => root.render(<QaInscriptionFilter open={false} />));
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(queued.frames.size).toBe(1);

    act(() => root.render(<QaInscriptionFilter open />));
    const chip = element<HTMLButtonElement>(
      container,
      "[data-filter-panel] button",
    );
    chip.focus();
    expect(queued.cancel).toHaveBeenCalledWith(1);
    expect(queued.frames.size).toBe(0);
    queued.flush();
    expect(document.activeElement).toBe(chip);
  });

  it("cancels the queued close restore on unmount", () => {
    const queued = queueRestoreFrames();
    const container = renderFilter();
    click(container.querySelector("[data-filter-trigger]"));
    pressEscape();
    expect(queued.frames.size).toBe(1);
    const root = roots.pop();
    if (root === undefined) throw new Error("Missing filter root");
    act(() => root.unmount());

    expect(queued.cancel).toHaveBeenCalledWith(1);
    expect(queued.frames.size).toBe(0);
    queued.flush();
    expect(container.childElementCount).toBe(0);
  });

  it("closes on outside pointer without stealing focus from its target", () => {
    const onOpenChange = vi.fn();
    const container = renderFilter({ onOpenChange });
    click(container.querySelector("[data-filter-trigger]"));
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    outside.focus();

    act(() =>
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );

    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(outside).toBe(document.activeElement);
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("supports a controlled open state through onOpenChange", () => {
    const onOpenChange = vi.fn();
    const container = renderFilter({ onOpenChange, open: false });
    const trigger = container.querySelector("[data-filter-trigger]");

    click(trigger);

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger).toBe(document.activeElement);
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
  });
});

describe("QaProductUtilities", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    document.body.style.overflow = "";
    shellState.activeDestination = "home";
    shellState.platform = "pc";
    shellState.requestSettings.mockReset();
    vi.restoreAllMocks();
  });

  it("coordinates Search, Filter and User as one mutually exclusive state", () => {
    const container = document.createElement("div");
    const harness = document.createElement("main");
    const shell = document.createElement("div");
    const mount = document.createElement("div");
    harness.dataset.t02pQaHarness = "";
    shell.dataset.productShell = "";
    shell.dataset.settingsOpen = "false";
    shell.append(mount);
    harness.append(shell);
    container.append(harness);
    document.body.append(container);
    const root = createRoot(mount);
    roots.push(root);
    act(() => {
      root.render(
        <QaUtilitiesProvider initialSearchOpen={false} resetKey="default">
          <div data-primary-navigation-pager="">
            <QaNavigationSearchAction />
          </div>
          <QaProductUtilities
            activeHomeFeed="inscriptions"
            catalogItems={[]}
            initialKeyword=""
            showEmptyState={false}
            showRecentSearches={false}
            userScenarioName="user-default-published"
          />
        </QaUtilitiesProvider>,
      );
    });

    click(container.querySelector("[data-search-trigger]"));
    expect(container.querySelector("[data-search-panel]")).not.toBeNull();
    expect(
      container
        .querySelector("[data-primary-navigation-pager]")
        ?.hasAttribute("inert"),
    ).toBe(true);
    click(container.querySelector("[data-search-close]"));
    expect(
      container
        .querySelector("[data-primary-navigation-pager]")
        ?.hasAttribute("inert"),
    ).toBe(false);
    click(container.querySelector("[data-user-trigger]"));
    expect(container.querySelector("[data-search-panel]")).toBeNull();
    expect(container.querySelector("[data-user-page]")).not.toBeNull();

    click(container.querySelector("[data-user-close]"));
    expect(container.querySelector("[data-user-page]")).toBeNull();
    expect(container.querySelector("[data-search-panel]")).toBeNull();

    click(container.querySelector("[data-filter-trigger]"));
    expect(container.querySelector("[data-filter-panel]")).not.toBeNull();
    click(container.querySelector("[data-user-trigger]"));
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    expect(container.querySelector("[data-user-page]")).not.toBeNull();

    click(container.querySelector("[data-user-close]"));
    expect(container.querySelector("[data-user-page]")).toBeNull();
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
  });

  it("limits filters to the inscription feed and resets them after leaving", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderFeed = (feed: HomeFeed) => {
      act(() =>
        root.render(
          <QaUtilitiesProvider initialSearchOpen={false} resetKey="default">
            <QaProductUtilities
              activeHomeFeed={feed}
              catalogItems={[]}
              initialKeyword=""
              showEmptyState={false}
              showRecentSearches={false}
              userScenarioName="user-default-published"
            />
          </QaUtilitiesProvider>,
        ),
      );
    };
    for (const feed of ["discover", "timeline", "calligraphy"] as const) {
      renderFeed(feed);
      expect(container.querySelector("[data-filter-trigger]")).toBeNull();
    }
    renderFeed("inscriptions");
    click(container.querySelector("[data-filter-trigger]"));
    click(container.querySelector('[data-filter-category="dynasty"]'));
    click(
      buttonNamed(
        element(container, '[data-filter-popover="dynasty"]'),
        "隋唐",
      ),
    );
    expect(container.textContent).toContain("隋唐 ×");

    renderFeed("calligraphy");
    expect(container.querySelector("[data-filter-trigger]")).toBeNull();
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    renderFeed("inscriptions");
    expect(container.querySelector("[data-filter-panel]")).toBeNull();
    click(container.querySelector("[data-filter-trigger]"));
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(
      container
        .querySelector("[data-filter-reset]")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
