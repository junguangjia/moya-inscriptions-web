// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVisualCatalogItems } from "../../../qa/home-catalog-scenarios";
import { createTimelineFixture } from "../../../qa/home/timeline-fixture";
import { TimelineFeed } from "./timeline-feed";
import {
  shouldFocusTimelineJump,
  timelineRulerMetrics,
  timelineWideFrameBox,
} from "./timeline-wide";

import type { TimelineEntry } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { HomeFeedState } from "../home-feed";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A history step lands on a later task, which a loaded machine can delay. */
const waitForHistory = <T,>(check: () => T) =>
  vi.waitFor(check, { timeout: 5000 });

const shell = vi.hoisted(() => ({
  browseOnly: false,
  openCatalog: vi.fn(),
  platform: "pc" as "phone" | "tablet" | "pc",
  readActiveScrollTop: vi.fn(() => 0),
  restoreActiveScrollTop: vi.fn(),
}));
vi.mock("../../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));

const origin = "http://localhost:3100";
const populated: HomeFeedState<TimelineEntry> = {
  state: "populated",
  items: createTimelineFixture(origin, createVisualCatalogItems(origin)),
};

const entry = (overrides: Partial<TimelineEntry>): TimelineEntry =>
  ({
    id: `row-${Math.random().toString(36).slice(2, 10)}`,
    title: "虚构南寺碑",
    fullTitle: "唐虚构南寺碑",
    startYear: 700,
    endYear: 700,
    precision: "year",
    dateLabel: "虚元八年",
    onAxis: true,
    chapter: "唐",
    polity: "唐",
    disputed: false,
    groupId: null,
    groupTitle: null,
    province: "虚构西州",
    holder: "虚构碑林",
    catalogId: null,
    media: null,
    ...overrides,
  }) as TimelineEntry;
const small = (
  items: readonly TimelineEntry[],
): HomeFeedState<TimelineEntry> => ({ state: "populated", items });

let surface: HTMLDivElement;
let panel: HTMLDivElement;
let root: Root;

const render = (
  active: boolean,
  state: HomeFeedState<TimelineEntry> = populated,
) => {
  act(() => {
    root.render(<TimelineFeed active={active} state={state} />);
  });
};
const chrome = () => surface.querySelector("[data-timeline-wide]");
const jumpInput = () =>
  surface.querySelector<HTMLInputElement>("[data-timeline-jump]");
const eras = () => [
  ...surface.querySelectorAll<HTMLButtonElement>("[data-timeline-eras] button"),
];
const rows = () => [
  ...panel.querySelectorAll<HTMLElement>("[data-timeline-row]"),
];
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const press = (key: string, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const typeIntoJump = (value: string) => {
  const input = jumpInput()!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submitJump = () => {
  act(() => {
    jumpInput()!.form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
};
/** Puts the list's top at `top` in the viewport and tells the feed it moved. */
const scrollListTo = (top: number) => {
  HTMLElement.prototype.getBoundingClientRect = function stub() {
    return (
      this.hasAttribute("data-timeline-list")
        ? { top, width: 900 }
        : { top: 0, width: 0 }
    ) as DOMRect;
  };
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
};

const originalRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  shell.platform = "pc";
  shell.browseOnly = false;
  shell.openCatalog.mockClear();
  shell.restoreActiveScrollTop.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.history.replaceState(null, "", "/");
  surface = document.createElement("div");
  surface.setAttribute("data-home-surface", "");
  surface.append(document.createElement("header"));
  panel = document.createElement("div");
  panel.setAttribute("data-home-feed-panel", "timeline");
  surface.append(panel);
  document.body.append(surface);
  root = createRoot(panel);
});

afterEach(async () => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  act(() => root.unmount());
  surface.remove();
  // Unmounting an open modal steps history back from a microtask; that step
  // must land here, or it closes the next case's modal.
  await Promise.resolve();
  await waitForHistory(() =>
    expect(window.history.state?.phase4Dialog).toBeUndefined(),
  );
});

describe("geometry", () => {
  it("finds the content column on a 1440 px PC", () => {
    expect(
      timelineWideFrameBox({
        headerHeight: 88,
        paddingLeft: 32,
        paddingRight: 32,
        paddingTop: 8,
        surfaceLeft: 0,
        surfaceWidth: 1248,
        viewportWidth: 1440,
      }),
    ).toEqual({ top: 88, left: 32, width: 1184, end: 224, panelTop: 8 });
  });

  it("gives the 时代尺 the frame's 780 and shrinks cells only when short", () => {
    expect(timelineRulerMetrics(900, 88, 24)).toEqual({
      height: 780,
      eraCell: 32,
    });
    expect(timelineRulerMetrics(600, 88, 24)).toEqual({
      height: 480,
      eraCell: 25,
    });
    expect(timelineRulerMetrics(400, 88, 24).eraCell).toBe(22);
    expect(timelineRulerMetrics(40, 88, 24).height).toBe(0);
  });
});

describe("the / key", () => {
  const key = (overrides: Partial<KeyboardEvent>) =>
    ({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      isComposing: false,
      key: "/",
      metaKey: false,
      target: document.body,
      ...overrides,
    }) as KeyboardEvent;

  it("takes a plain slash outside any field", () => {
    expect(shouldFocusTimelineJump(key({}))).toBe(true);
    expect(shouldFocusTimelineJump(key({ key: "a" }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ metaKey: true }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ ctrlKey: true }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ altKey: true }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ isComposing: true }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ defaultPrevented: true }))).toBe(
      false,
    );
  });

  it("leaves every kind of typing alone", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const nested = document.createElement("span");
    editable.append(nested);
    const plain = document.createElement("div");
    plain.setAttribute("contenteditable", "false");
    for (const target of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      editable,
      nested,
    ])
      expect(shouldFocusTimelineJump(key({ target }))).toBe(false);
    expect(shouldFocusTimelineJump(key({ target: plain }))).toBe(true);
  });

  it("focuses 跳到年份 only while the feed is active", () => {
    render(true);
    const event = press("/");
    expect(document.activeElement).toBe(jumpInput());
    // The slash itself must not land in the field.
    expect(event.defaultPrevented).toBe(true);
    (document.activeElement as HTMLElement).blur();
    render(false);
    expect(press("/").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps out of another field and of an inert page", () => {
    render(true);
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    expect(press("/", other).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(other);
    other.remove();
    surface.setAttribute("inert", "");
    expect(press("/").defaultPrevented).toBe(false);
    surface.removeAttribute("inert");
  });

  it("keeps out while a drawer is open", () => {
    render(true);
    click(surface.querySelector("[data-timeline-position]"));
    expect(panel.querySelector("dialog[open]")).not.toBeNull();
    expect(press("/").defaultPrevented).toBe(false);
  });

  it("takes focus back out with Escape", () => {
    render(true);
    press("/");
    press("Escape", jumpInput()!);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("the PC chrome", () => {
  it("portals into the surface while active and leaves when it is not", () => {
    render(true);
    expect(chrome()?.getAttribute("data-timeline-wide")).toBe("fixed");
    expect(chrome()?.parentElement).toBe(surface);
    expect(panel.querySelector("[data-timeline-wide]")).toBeNull();
    expect(
      panel
        .querySelector("[data-timeline-feed]")
        ?.getAttribute("data-timeline-layout"),
    ).toBe("wide");
    render(false);
    expect(chrome()).toBeNull();
    expect(rows().length).toBeGreaterThan(0);
  });

  it("stays out until the feed is active, with the rows", () => {
    render(false);
    expect(chrome()).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("replaces the rail and the phone bar", () => {
    render(true);
    expect(surface.querySelector("[data-timeline-rail]")).toBeNull();
    expect(surface.querySelectorAll("[data-timeline-position]")).toHaveLength(
      1,
    );
    expect(chrome()?.textContent).toContain("名称");
    expect(chrome()?.textContent).toContain("保管");
    expect(chrome()?.textContent).toContain("/");
    expect(surface.querySelector("[data-timeline-scale]")).not.toBeNull();
  });

  it("prints the data columns in the row, with the date alone as meta", () => {
    render(true, small([entry({})]));
    const button = panel.querySelector(
      "[data-timeline-row='entry'] button",
    ) as HTMLElement;
    expect(button.textContent).toContain("虚构碑林");
    expect(button.textContent).not.toContain("虚元八年 · 虚构西州");
  });

  it("lists every chapter and jumps from those that hold rows", () => {
    render(true, small([entry({})]));
    const cells = eras();
    expect(cells).toHaveLength(19);
    expect(cells[0]?.textContent).toBe("晚商");
    expect(cells[0]?.disabled).toBe(true);
    const tang = cells.find((cell) => cell.textContent?.startsWith("唐"));
    expect(tang?.textContent).toBe("唐1");
    expect(tang?.disabled).toBe(false);
    shell.restoreActiveScrollTop.mockClear();
    click(tang);
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("marks the chapter under the sticky line", () => {
    render(true, small([entry({})]));
    expect(
      surface.querySelector("[data-timeline-eras] [aria-current='true']")
        ?.textContent,
    ).toBe("晚商");
  });

  it("jumps to a typed year, and ignores what is no year", () => {
    render(true, small([entry({})]));
    typeIntoJump("开元");
    submitJump();
    expect(shell.restoreActiveScrollTop).not.toHaveBeenCalled();
    expect(jumpInput()?.value).toBe("开元");
    typeIntoJump("-475");
    submitJump();
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
    expect(jumpInput()?.value).toBe("");
  });

  it("opens 凡例 and 纪年 as drawers and closes them", async () => {
    render(true);
    const legend = [...surface.querySelectorAll("button")].find(
      (button) => button.textContent === "凡例",
    );
    click(legend);
    expect(panel.querySelector("[data-timeline-legend]")).not.toBeNull();
    expect(panel.querySelector("[data-timeline-era]")).toBeNull();
    const close = panel.querySelector("dialog button[aria-label='关闭']");
    click(close);
    await waitForHistory(() =>
      expect(panel.querySelector("dialog")).toBeNull(),
    );
    click(surface.querySelector("[data-timeline-position]"));
    expect(panel.querySelector("[data-timeline-era]")).not.toBeNull();
  });

  it("offers neither controls nor heads when the feed failed", () => {
    render(true, { state: "unavailable" });
    expect(surface.querySelector("[data-timeline-position]")?.textContent).toBe(
      "时间轴",
    );
    expect(jumpInput()).toBeNull();
    expect(surface.querySelector("[data-timeline-eras]")).toBeNull();
    expect(chrome()?.textContent).not.toContain("名称");
    expect(panel.textContent).toContain("时间轴暂时不可用");
  });

  it("shows the 时代尺 with nothing to tap while loading", () => {
    render(true, { state: "loading" });
    expect(surface.querySelector("[data-timeline-position]")?.textContent).toBe(
      "正在载入",
    );
    expect(jumpInput()).toBeNull();
    expect(eras().every((cell) => cell.disabled)).toBe(true);
  });

  it("holds the opened group's head once its own has scrolled away", () => {
    const members = Array.from({ length: 3 }, (_, at) =>
      entry({
        groupId: "yunfeng",
        groupTitle: "虚构云峰诸刻",
        title: `虚构题记${at}`,
      }),
    );
    render(true, small(members));
    const pinned = () => surface.querySelector("[data-timeline-pinned]");
    expect(pinned()).toBeNull();
    click(panel.querySelector("[data-timeline-group]"));
    expect(pinned()).toBeNull();
    // 11 empty chapters and the 唐 head take 597, and the sticky line is 164
    // under the viewport's top, so this puts the line inside the group.
    scrollListTo(-500);
    expect(pinned()?.textContent).toContain("收起");
    expect(pinned()?.querySelector("[data-timeline-group]")).toBeNull();
    shell.readActiveScrollTop.mockReturnValue(500);
    click(pinned()?.querySelector("button"));
    shell.readActiveScrollTop.mockReturnValue(0);
    expect(pinned()).toBeNull();
    expect(
      panel
        .querySelector("[data-timeline-group]")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    // Collapsing from far below returns to the fold row.
    expect(shell.restoreActiveScrollTop).toHaveBeenCalled();
  });

  it("does not follow the document's scroll while another feed owns it", () => {
    render(true);
    const firstRow = () => rows()[0]?.dataset.timelineRowSize;
    const start = firstRow();
    render(false);
    scrollListTo(-20000);
    expect(firstRow()).toBe(start);
    render(true);
    expect(firstRow()).not.toBe(start);
  });
});

describe("a wide tablet", () => {
  beforeEach(() => {
    shell.platform = "tablet";
    vi.stubGlobal("innerWidth", 1024);
  });

  it("keeps the chrome in its panel, where sticky works", () => {
    render(true);
    expect(chrome()?.getAttribute("data-timeline-wide")).toBe("sticky");
    expect(panel.querySelector("[data-timeline-wide]")).toBe(chrome());
    // No hardware key to hint at.
    expect(chrome()?.querySelector("kbd")).toBeNull();
    render(false);
    expect(chrome()).not.toBeNull();
  });

  it("does not take the key while another feed is showing", () => {
    render(true);
    render(false);
    expect(press("/").defaultPrevented).toBe(false);
  });

  it("follows the viewport across the wide width, not the list's width", () => {
    render(true);
    const feed = () => panel.querySelector("[data-timeline-feed]");
    expect(feed()?.getAttribute("data-timeline-layout")).toBe("wide");
    vi.stubGlobal("innerWidth", 834);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(feed()?.getAttribute("data-timeline-layout")).toBe("tablet");
    expect(chrome()).toBeNull();
    expect(panel.querySelector("[data-timeline-rail]")).not.toBeNull();
  });
});
