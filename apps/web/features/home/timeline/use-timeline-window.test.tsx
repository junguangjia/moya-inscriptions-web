// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTimelineWindow } from "./use-timeline-window";

import type { Root } from "react-dom/client";
import type { TimelineWindow } from "./use-timeline-window";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_HEIGHT = 100;
const rows = Array.from({ length: 100 }, (_, at) => ({ key: `row-${at}` }));
const estimate = () => ROW_HEIGHT;

let observed: { callback: ResizeObserverCallback; elements: Set<Element> }[];
let container: HTMLDivElement;
let root: Root;
let listTop: number;
let listWidth: number;
let scrollerHeight: number;
let current: TimelineWindow;
const scrollTo = vi.fn();
const settled = vi.fn();

interface HarnessProps {
  readonly enabled?: boolean;
  /** A PC: no scroll surface around the list, so the document scrolls. */
  readonly documentScroller?: boolean;
}

const Harness = ({
  documentScroller = false,
  enabled = true,
}: HarnessProps) => {
  const listRef = useRef<HTMLDivElement>(null);
  const view = useTimelineWindow({
    enabled,
    estimate,
    listRef,
    onScrollSettled: settled,
    resetKey: "phone",
    rows,
    scrollTo,
    stickyTop: 36,
  });
  current = view;
  const rendered = [];
  for (let at = view.start; at < view.end; at += 1)
    rendered.push(
      <div
        data-timeline-row-size={rows[at]!.key}
        key={rows[at]!.key}
        ref={view.observeRow}
      />,
    );
  return (
    <div {...(documentScroller ? {} : { "data-home-feed-scroll-surface": "" })}>
      <div data-list="" ref={listRef}>
        {rendered}
      </div>
    </div>
  );
};

const render = (props: HarnessProps = {}) => {
  act(() => {
    root.render(<Harness {...props} />);
  });
};

const scroller = () =>
  container.querySelector<HTMLElement>("[data-home-feed-scroll-surface]")!;

const fireScroll = () => {
  act(() => {
    scroller().dispatchEvent(new Event("scroll"));
  });
};

const rowElement = (key: string) =>
  container.querySelector<HTMLElement>(`[data-timeline-row-size='${key}']`)!;

const report = (key: string, height: number) => {
  const element = rowElement(key);
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    value: height,
  });
  const owner = observed.find(({ elements }) => elements.has(element));
  act(() => {
    owner?.callback(
      [{ target: element } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
};

beforeEach(() => {
  observed = [];
  listTop = 53;
  listWidth = 390;
  scrollerHeight = 800;
  scrollTo.mockClear();
  settled.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly record;
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, elements: new Set<Element>() };
        observed.push(this.record);
      }
      observe(element: Element) {
        this.record.elements.add(element);
      }
      unobserve(element: Element) {
        this.record.elements.delete(element);
      }
      disconnect() {
        this.record.elements.clear();
      }
    },
  );
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function mock(this: HTMLElement) {
      if (this.hasAttribute("data-list"))
        return { top: listTop, width: listWidth } as DOMRect;
      if (this.hasAttribute("data-home-feed-scroll-surface"))
        return { top: 53, width: listWidth } as DOMRect;
      return original.call(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function mock(this: HTMLElement) {
      return this.hasAttribute("data-home-feed-scroll-surface")
        ? scrollerHeight
        : 0;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useTimelineWindow", () => {
  it("renders the viewport plus an overscan of about 600 px", () => {
    render();
    expect(current.start).toBe(0);
    expect(current.end).toBe(15);
    expect(current.totalHeight).toBe(10_000);
    expect(current.offsets[50]).toBe(5_000);
  });

  it("moves the window as the list scrolls and reports the row under the bar", () => {
    render();
    listTop = 53 - 3_000;
    fireScroll();
    expect(current.start).toBeLessThanOrEqual(24);
    expect(current.start).toBeGreaterThanOrEqual(23);
    expect(current.end).toBeGreaterThanOrEqual(44);
    expect(current.topIndex).toBe(30);
  });

  it("keeps the window while the scroll stays well inside it", () => {
    render();
    listTop = 53 - 3_000;
    fireScroll();
    const start = current.start;
    listTop = 53 - 3_100;
    fireScroll();
    expect(current.start).toBe(start);
    expect(current.topIndex).toBe(31);
  });

  it("ignores zero sizes while hidden", () => {
    render();
    listTop = 53 - 2_000;
    fireScroll();
    const { start, topIndex, width } = current;
    listWidth = 0;
    listTop = 53;
    fireScroll();
    expect(current.start).toBe(start);
    expect(current.topIndex).toBe(topIndex);
    expect(current.width).toBe(width);
    listWidth = 390;
    scrollerHeight = 0;
    fireScroll();
    expect(current.start).toBe(start);
  });

  it("does not subscribe until enabled", () => {
    render({ enabled: false });
    listTop = 53 - 3_000;
    fireScroll();
    expect(current.topIndex).toBe(0);
    render();
    expect(current.topIndex).toBe(30);
  });

  it("corrects a rendered row's height and the offsets after it", () => {
    render();
    report("row-5", 150);
    expect(current.offsets[5]).toBe(500);
    expect(current.offsets[6]).toBe(650);
    expect(current.totalHeight).toBe(10_050);
    report("row-5", 150);
    expect(current.totalHeight).toBe(10_050);
    // A hidden or unmeasured row reports 0, and its estimate stands.
    report("row-6", 0);
    expect(current.offsets[7]).toBe(750);
  });

  it("holds the reader's place when a row above the viewport changes", () => {
    render();
    listTop = 53 - 2_000;
    fireScroll();
    scroller().scrollTop = 2_000;
    const row = `row-${current.start}`;
    report(row, 130);
    expect(scroller().scrollTop).toBe(2_030);
  });

  it("does not move the reader for a row at or below the line", () => {
    render();
    listTop = 53 - 2_000;
    fireScroll();
    scroller().scrollTop = 2_000;
    report("row-25", 130);
    expect(scroller().scrollTop).toBe(2_000);
  });

  it("jumps through the shell under the sticky chrome", () => {
    render();
    listTop = 89;
    current.scrollToIndex(20);
    expect(scrollTo).toHaveBeenCalledWith(2_000);
    expect(current.scrollTopForIndex(0)).toBe(0);
  });

  it("rate-limits drag jumps and always lands the last target", () => {
    vi.useFakeTimers();
    render();
    listTop = 89;
    current.scrollToIndexDuringDrag(10);
    current.scrollToIndexDuringDrag(11);
    current.scrollToIndexDuringDrag(12);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(1_000);
    vi.advanceTimersByTime(64);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith(1_200);
    vi.advanceTimersByTime(64);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    current.scrollToIndexDuringDrag(13);
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it("reports a settled scroll after 300 ms of quiet", () => {
    vi.useFakeTimers();
    render();
    fireScroll();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    fireScroll();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(settled).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  describe("with the document as the scroller", () => {
    const fireWindowScroll = () => {
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
    };

    it("reads the window's scroll relative to the list's top", () => {
      vi.stubGlobal("innerHeight", 900);
      render({ documentScroller: true });
      expect(current.viewportHeight).toBe(900);
      listTop = 164 - 5_000;
      fireWindowScroll();
      expect(current.start).toBeGreaterThan(40);
      // The line is the sticky 36 under the viewport's top.
      expect(current.topIndex).toBe(Math.floor((5_000 - 164 + 36) / 100));
    });

    it("jumps in document coordinates under the sticky chrome", () => {
      vi.stubGlobal("scrollY", 5_000);
      render({ documentScroller: true });
      listTop = 164 - 5_000;
      current.scrollToIndex(20);
      expect(scrollTo).toHaveBeenCalledWith(164 + 2_000 - 36);
    });

    it("holds the reader's place through the window", () => {
      const scrollBy = vi.fn();
      vi.stubGlobal("scrollBy", scrollBy);
      render({ documentScroller: true });
      listTop = 164 - 2_000;
      fireWindowScroll();
      report(`row-${current.start}`, 130);
      expect(scrollBy).toHaveBeenCalledWith(0, 30);
    });

    it("leaves the document alone once disabled", () => {
      const scrollBy = vi.fn();
      vi.stubGlobal("scrollBy", scrollBy);
      render({ documentScroller: true });
      listTop = 164 - 2_000;
      fireWindowScroll();
      const { start } = current;
      render({ documentScroller: true, enabled: false });
      listTop = 164 - 9_000;
      fireWindowScroll();
      expect(current.start).toBe(start);
      report(`row-${start}`, 130);
      expect(current.totalHeight).toBe(10_030);
      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  it("drops measured heights when the width changes", () => {
    render();
    report("row-5", 150);
    expect(current.totalHeight).toBe(10_050);
    listWidth = 430;
    fireScroll();
    expect(current.totalHeight).toBe(10_000);
    expect(current.width).toBe(430);
  });
});
