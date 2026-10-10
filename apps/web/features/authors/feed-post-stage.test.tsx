// @vitest-environment jsdom
import { act, createRef } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedPostStage } from "./feed-post-stage";
import { useFeedStage } from "./feed-post-stage-context";
import type { FeedStageApi } from "./feed-post-stage-context";
import type {
  FeedPostStageHandle,
  FeedPostStageProps,
} from "./feed-post-stage";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";

import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 300;
const image = (
  id: string,
  width: number,
  height: number,
): DetailMediaPresentation => ({
  id,
  src: `/media/${id}.webp`,
  alt: "九成宫醴泉铭",
  width,
  height,
  renditions: [
    { src: `/media/${id}-half.webp`, width: width / 2, height: height / 2 },
    { src: `/media/${id}.webp`, width, height },
  ],
});
const three = [
  image("first", 600, 800),
  image("second", 800, 600),
  image("third", 600, 1200),
];

const roots: Root[] = [];
const render = (overrides: Partial<FeedPostStageProps> = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const ref = createRef<FeedPostStageHandle>();
  const props: FeedPostStageProps = {
    media: three,
    onOpenViewer: vi.fn(),
    onDoubleTap: vi.fn(),
    burstEnabled: true,
    viewerOpen: false,
    ...overrides,
  };
  const draw = (next: Partial<FeedPostStageProps> = {}) =>
    act(() => root.render(<FeedPostStage ref={ref} {...props} {...next} />));
  draw();
  const strip = container.querySelector<HTMLElement>("[data-feed-stage]")!;
  // A modern RTL scroller: 0 at the right edge, negative towards the end.
  let scrollLeft = 0;
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scrollLeft = options.left ?? scrollLeft;
  });
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, get: () => WIDTH },
    scrollWidth: {
      configurable: true,
      get: () => WIDTH * strip.querySelectorAll("[data-feed-slide]").length,
    },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    },
    scrollTo: { configurable: true, value: scrollTo },
  });
  const slideButton = (index: number) =>
    container.querySelector<HTMLButtonElement>(
      `[data-feed-slide="${index}"] [data-feed-slide-image]`,
    )!;
  /** A pointer tap: React sees `detail >= 1` like a real click. */
  const tap = (index = 0, detail = 1) =>
    act(() => {
      slideButton(index).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
      );
    });
  /** Scrolls the strip to `offset` pixels from its right edge and settles. */
  const scrollToOffset = (offset: number) => {
    scrollLeft = -offset;
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
  };
  return {
    container,
    strip,
    ref,
    props,
    draw,
    tap,
    slideButton,
    scrollTo,
    scrollToOffset,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders inside the comments region and keeps the latest stage context. */
const stageProbe = () => {
  const seen: { current: FeedStageApi | null } = { current: null };
  const Probe = () => {
    seen.current = useFeedStage();
    return (
      <div>
        <p data-colophon-anchor="root-1">题跋</p>
      </div>
    );
  };
  return { seen, comments: <Probe /> };
};

const rightEdge = (element: Element, right: number) => {
  element.getBoundingClientRect = () =>
    ({ right, left: right - WIDTH }) as DOMRect;
};

/** Collects ResizeObserver callbacks so a test can report a resize. */
const stubResizeObserver = () => {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return () =>
    act(() => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    });
};

describe("FeedPostStage", () => {
  it("sizes the stage from the first image within square and 4:5", () => {
    const { container } = render();
    const frame = container.querySelector<HTMLElement>(
      "[data-feed-stage-frame]",
    )!;
    // 3:4 portrait is taller than 4:5, so the stage stops at 4:5.
    expect(frame.style.getPropertyValue("--feed-stage-aspect")).toBe(
      "1 / 1.25",
    );
    const landscape = render({ media: [image("wide", 1600, 900)] });
    expect(
      landscape.container
        .querySelector<HTMLElement>("[data-feed-stage-frame]")!
        .style.getPropertyValue("--feed-stage-aspect"),
    ).toBe("1 / 1");
  });

  it("contains shorter images and crops taller ones", () => {
    const { container } = render();
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-feed-slide]")].map(
        (slide) => slide.dataset.fit,
      ),
    ).toEqual(["cover", "contain", "cover"]);
  });

  it("keeps every swipe on the stage away from the outer pagers", () => {
    const { strip } = render();
    expect(strip.hasAttribute("data-local-horizontal")).toBe(true);
    expect(strip.dataset.feedStageIndex).toBe("0");
    expect(strip.dataset.feedStageRegion).toBe("media");
    expect(strip.dataset.feedStageCount).toBe("3");
  });

  it("loads the first image by priority, the rest lazily, at full width", () => {
    const { container } = render({ priority: "high" });
    const images = [...container.querySelectorAll("img")];
    expect(images.map((img) => img.getAttribute("sizes"))).toEqual([
      "100vw",
      "100vw",
      "100vw",
    ]);
    expect(images.slice(1).map((img) => img.getAttribute("loading"))).toEqual([
      "lazy",
      "lazy",
    ]);
    expect(images[0]!.getAttribute("loading")).not.toBe("lazy");
  });

  it("opens the viewer after the double-tap window on a single tap", () => {
    const onOpenViewer = vi.fn();
    const { tap, slideButton } = render({ onOpenViewer });
    tap();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onOpenViewer).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onOpenViewer).toHaveBeenCalledWith(0, slideButton(0));
  });

  it("opens the viewer at once from the keyboard", () => {
    const onOpenViewer = vi.fn();
    const { tap, slideButton } = render({ onOpenViewer });
    tap(0, 0);
    expect(onOpenViewer).toHaveBeenCalledWith(0, slideButton(0));
  });

  it("likes on a double tap with a heart and never opens the viewer", () => {
    const onOpenViewer = vi.fn();
    const onDoubleTap = vi.fn();
    const { container, tap } = render({ onOpenViewer, onDoubleTap });
    tap();
    tap();
    // A third tap of the same burst is still the double tap.
    tap();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDoubleTap).toHaveBeenCalledOnce();
    expect(onOpenViewer).not.toHaveBeenCalled();
    const burst = container.querySelector("[data-feed-post-burst]")!;
    expect(burst).not.toBeNull();
    act(() => {
      // jsdom has no AnimationEvent, so React may listen for either name.
      for (const name of ["animationend", "webkitAnimationEnd"])
        burst.dispatchEvent(new Event(name, { bubbles: true }));
    });
    expect(container.querySelector("[data-feed-post-burst]")).toBeNull();
  });

  it("plays no heart for a reader who cannot like", () => {
    const onDoubleTap = vi.fn();
    const { container, tap } = render({ onDoubleTap, burstEnabled: false });
    tap();
    tap();
    expect(onDoubleTap).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-feed-post-burst]")).toBeNull();
  });

  it("settles on the image a swipe stopped at and reports the comments region", () => {
    const onRegionChange = vi.fn();
    const { strip, container, scrollToOffset } = render({
      comments: <p data-test-comments="">题跋</p>,
      onRegionChange,
    });
    scrollToOffset(WIDTH);
    expect(strip.dataset.feedStageIndex).toBe("1");
    expect(
      container
        .querySelector('[data-feed-slide="1"]')!
        .getAttribute("aria-hidden"),
    ).toBe("false");
    expect(
      container
        .querySelector('[data-feed-slide="0"]')!
        .getAttribute("aria-hidden"),
    ).toBe("true");
    scrollToOffset(WIDTH * 3);
    expect(strip.dataset.feedStageRegion).toBe("comments");
    expect(onRegionChange).toHaveBeenLastCalledWith("comments");
    // The last image stays the active one behind the comments.
    expect(strip.dataset.feedStageIndex).toBe("1");
    scrollToOffset(WIDTH * 2);
    expect(strip.dataset.feedStageRegion).toBe("media");
    expect(strip.dataset.feedStageIndex).toBe("2");
  });

  it("treats a tap that moved the strip as part of the swipe", () => {
    const onOpenViewer = vi.fn();
    const { strip, tap } = render({ onOpenViewer });
    act(() => {
      strip.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [{ identifier: 0 } as Touch],
        }),
      );
    });
    strip.scrollLeft = -40;
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });
    tap();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onOpenViewer).not.toHaveBeenCalled();
  });

  it("scrolls to an image or the comments without touching the page", () => {
    const { ref, scrollTo } = render({ comments: <p>题跋</p> });
    act(() => ref.current!.scrollToIndex(2));
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -WIDTH * 2,
      behavior: "smooth",
    });
    let shown = false;
    act(() => {
      shown = ref.current!.scrollToComments();
    });
    expect(shown).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -WIDTH * 3,
      behavior: "smooth",
    });
  });

  it("has no comments region to scroll to without comments", () => {
    const { ref, scrollTo, container } = render();
    expect(container.querySelector("[data-feed-stage-comments]")).toBeNull();
    expect(container.querySelector("[data-feed-post-dot-comments]")).toBeNull();
    expect(ref.current!.scrollToComments()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("moves the strip from the dots, the seal leading to the comments", () => {
    const { container, scrollTo } = render({ comments: <p>题跋</p> });
    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>("[data-feed-post-dot]")[1]!
        .click(),
    );
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -WIDTH,
      behavior: "smooth",
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-feed-post-dot-comments]")!
        .click(),
    );
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -WIDTH * 3,
      behavior: "smooth",
    });
  });

  it("ignores the tap that closed the viewer", () => {
    const onOpenViewer = vi.fn();
    const { draw, tap } = render({ onOpenViewer, viewerOpen: true });
    draw({ viewerOpen: false });
    tap();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onOpenViewer).not.toHaveBeenCalled();
  });

  it("leaves taps in a portal rendered from the comments to their target", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onSend = vi.fn();
    const { draw } = render({
      viewerOpen: true,
      comments: createPortal(
        <button data-portal-send="" onClick={onSend} type="button">
          发送
        </button>,
        outside,
      ),
    });
    // Closing the viewer arms the stage's tap suppression.
    draw({ viewerOpen: false });
    act(() => {
      outside
        .querySelector("[data-portal-send]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(onSend).toHaveBeenCalledOnce();
    outside.remove();
  });

  it("replaces an image that fails with the truthful fallback", () => {
    const onMediaSettled = vi.fn();
    const { container } = render({ onMediaSettled });
    act(() => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    const fallback = container.querySelector(
      '[data-feed-slide="0"] [data-catalog-media-state="failed"]',
    );
    expect(fallback).not.toBeNull();
    expect(
      container.querySelector('[data-feed-slide="0"] [data-feed-slide-image]'),
    ).toBeNull();
    expect(onMediaSettled).toHaveBeenCalledOnce();
  });

  it("shows the fallback for a first image that failed before hydration", () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const onMediaSettled = vi.fn();
    const { container } = render({ onMediaSettled });
    complete.mockRestore();
    expect(
      container.querySelector(
        '[data-feed-slide="0"] [data-catalog-media-state="failed"]',
      ),
    ).not.toBeNull();
    // Later images load lazily and report their own errors.
    expect(
      container.querySelector('[data-feed-slide="1"] [data-feed-slide-image]'),
    ).not.toBeNull();
    expect(onMediaSettled).toHaveBeenCalled();
  });

  it("badges a Live Photo still on the first image only", () => {
    const { container } = render({ live: true });
    expect(
      container.querySelectorAll(
        '[data-feed-slide="0"] [aria-label="实况照片"]',
      ),
    ).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="实况照片"]')).toHaveLength(
      1,
    );
  });

  describe("stage context", () => {
    it("exposes the strip and the settled region to the comments", () => {
      const { seen, comments } = stageProbe();
      const { strip, scrollToOffset } = render({ comments });
      expect(seen.current?.strip).toBe(strip);
      expect(seen.current?.region).toBe("media");
      const settled = vi.fn();
      let unsubscribe = () => {};
      act(() => {
        unsubscribe = seen.current!.subscribeSettle(settled);
      });
      scrollToOffset(WIDTH * 3);
      expect(seen.current?.region).toBe("comments");
      expect(seen.current?.readOffset()).toBe(WIDTH * 3);
      expect(settled).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith({ resized: false });
      expect(seen.current?.count).toBe(3);
      unsubscribe();
      scrollToOffset(WIDTH * 4);
      expect(settled).toHaveBeenCalledOnce();
    });

    it("is unsettled while a finger is down or a scroll has not settled", () => {
      const { seen, comments } = stageProbe();
      const { strip } = render({ comments });
      const settledNow = () => seen.current!.isSettled();
      expect(settledNow()).toBe(true);
      act(() => {
        strip.dispatchEvent(
          Object.assign(new Event("touchstart", { bubbles: true }), {
            touches: [{}],
          }),
        );
      });
      expect(settledNow()).toBe(false);
      act(() => {
        strip.dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      // Momentum and snapping still to come.
      expect(settledNow()).toBe(false);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(settledNow()).toBe(true);
      // A smooth scroll, even one that goes nowhere, settles.
      act(() => seen.current!.scrollToOffset(0));
      expect(settledNow()).toBe(false);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(settledNow()).toBe(true);
    });

    it("counts a sideways wheel or a scrolling key as moving before it scrolls", () => {
      const { seen, comments } = stageProbe();
      const { strip, container } = render({ comments });
      const settledNow = () => seen.current!.isSettled();
      // A vertical wheel scrolls the page, not the strip.
      act(() => {
        strip.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: 80 }),
        );
      });
      expect(settledNow()).toBe(true);
      act(() => {
        strip.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaX: -70 }),
        );
      });
      expect(settledNow()).toBe(false);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(settledNow()).toBe(true);
      const anchor = container.querySelector<HTMLElement>(
        "[data-colophon-anchor]",
      )!;
      act(() => {
        anchor.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      expect(settledNow()).toBe(true);
      act(() => {
        anchor.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
        );
      });
      expect(settledNow()).toBe(false);
    });

    it("undoes a running scroll carried on by the width the comments added", async () => {
      const { comments } = stageProbe();
      const { strip, scrollTo, scrollToOffset, container } = render({
        comments,
      });
      let width = WIDTH * 3;
      Object.defineProperty(strip, "scrollWidth", {
        configurable: true,
        get: () => width,
      });
      scrollToOffset(WIDTH * 2);
      const part = container.querySelector("[data-feed-stage-comments]")!;
      // Committed rows by default; else the region widening for another
      // reason (an expanded fold, a selected comment's actions).
      const grow = async (added: number, row = true) => {
        width += added;
        const node = document.createElement(row ? "li" : "div");
        if (row) node.dataset.colophonAnchor = `row-${width}`;
        await act(async () => {
          part.append(node);
          await Promise.resolve();
        });
      };
      const scrollEvent = (offset: number) => {
        strip.scrollLeft = -offset;
        act(() => {
          strip.dispatchEvent(new Event("scroll"));
        });
      };
      // The strip's width as laid out (jsdom had none at mount).
      await grow(0);
      act(() => {
        vi.advanceTimersByTime(800);
      });
      await grow(600);
      // A scroll that was already running reports itself...
      scrollEvent(WIDTH * 2 + 40);
      expect(scrollTo).not.toHaveBeenCalled();
      // ...then jumps on by the added width: back to where it really is,
      // and on from there.
      scrollEvent(WIDTH * 2 + 80 + 600);
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -(WIDTH * 2 + 80),
        behavior: "smooth",
      });
      act(() => {
        vi.advanceTimersByTime(800);
      });
      // The reader's own steps are never taken for a carry.
      scrollTo.mockClear();
      await grow(600);
      scrollEvent(WIDTH * 2 + 80 + 70);
      scrollEvent(WIDTH * 2 + 80 + 140);
      expect(scrollTo).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(800);
      });
      // Nor is a jump once the watch is over, or one under a finger.
      await grow(600);
      act(() => {
        vi.advanceTimersByTime(800);
      });
      scrollEvent(WIDTH * 2 + 80 + 140 + 600);
      await grow(600);
      act(() => {
        strip.dispatchEvent(
          Object.assign(new Event("touchstart", { bubbles: true }), {
            touches: [{}],
          }),
        );
      });
      scrollEvent(WIDTH * 2 + 80 + 140 + 1200);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("leaves a reader's step after 全文 or a selection alone", async () => {
      const { comments } = stageProbe();
      const { strip, scrollTo, scrollToOffset, container } = render({
        comments,
      });
      let width = WIDTH * 3;
      Object.defineProperty(strip, "scrollWidth", {
        configurable: true,
        get: () => width,
      });
      scrollToOffset(WIDTH * 2);
      act(() => {
        vi.advanceTimersByTime(800);
      });
      scrollTo.mockClear();
      const part = container.querySelector("[data-feed-stage-comments]")!;
      const widen = async (added: number) => {
        width += added;
        await act(async () => {
          // 收起 or the action column: no comment row is committed.
          part.append(document.createElement("button"));
          await Promise.resolve();
        });
      };
      const scrollEvent = (offset: number) => {
        strip.scrollLeft = -offset;
        act(() => {
          strip.dispatchEvent(new Event("scroll"));
        });
      };
      // The strip's width as laid out (jsdom had none at mount).
      await widen(0);
      act(() => {
        vi.advanceTimersByTime(800);
      });
      // 全文 adds about 51 px; a wheel notch of 70 px or an arrow key's
      // 40 px right after it is the reader's step, in either direction.
      await widen(51);
      scrollEvent(WIDTH * 2 + 70);
      await widen(52);
      scrollEvent(WIDTH * 2 + 70 - 40);
      scrollEvent(WIDTH * 2 + 70 - 40 + 52);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(strip.scrollLeft).toBe(-(WIDTH * 2 + 82));
    });

    it("tells the comments when a settle only follows a resize re-pin", () => {
      const resize = stubResizeObserver();
      const { seen, comments } = stageProbe();
      const { strip, scrollToOffset } = render({ comments });
      const settled = vi.fn();
      act(() => {
        seen.current!.subscribeSettle(settled);
      });
      scrollToOffset(WIDTH * 3 + 40);
      expect(settled).toHaveBeenLastCalledWith({ resized: false });
      resize();
      expect(strip.scrollLeft).toBe(-WIDTH * 3);
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(settled).toHaveBeenLastCalledWith({ resized: true });
      scrollToOffset(WIDTH * 3 + 80);
      expect(settled).toHaveBeenLastCalledWith({ resized: false });
    });

    it("scrolls by offset, smoothly or at once", () => {
      const { seen, comments } = stageProbe();
      const { strip, scrollTo } = render({ comments });
      act(() => seen.current!.scrollToOffset(WIDTH * 4));
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -WIDTH * 4,
        behavior: "smooth",
      });
      scrollTo.mockClear();
      act(() => seen.current!.scrollToOffset(WIDTH * 5, "instant"));
      expect(scrollTo).not.toHaveBeenCalled();
      expect(strip.scrollLeft).toBe(-WIDTH * 5);
    });

    it("never scrolls smoothly under reduced motion", () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("reduce"),
      }));
      const { seen, comments } = stageProbe();
      const { scrollTo } = render({ comments });
      act(() => seen.current!.scrollToOffset(WIDTH * 4, "smooth"));
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -WIDTH * 4,
        behavior: "auto",
      });
    });

    it("brings a comment's right edge to the strip's right edge", () => {
      const { seen, comments } = stageProbe();
      const { strip, ref, scrollTo, scrollToOffset, container } = render({
        comments,
      });
      scrollToOffset(WIDTH * 3);
      rightEdge(strip, WIDTH);
      // 150px left of the view: the strip goes 150px + its width further.
      rightEdge(
        container.querySelector('[data-colophon-anchor="root-1"]')!,
        -150,
      );
      let shown = false;
      act(() => {
        shown = ref.current!.scrollToComment("root-1");
      });
      expect(shown).toBe(true);
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -(WIDTH * 3 + WIDTH + 150),
        behavior: "smooth",
      });
      expect(ref.current!.scrollToComment("missing")).toBe(false);
      // The rectangles are fixed, so return to where they were measured.
      strip.scrollLeft = -WIDTH * 3;
      act(() =>
        seen.current!.scrollToElement(
          container.querySelector("[data-colophon-anchor]")!,
          "auto",
        ),
      );
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -(WIDTH * 3 + WIDTH + 150),
        behavior: "auto",
      });
    });

    it("re-pins a resize in the comments to the anchor, else their start", () => {
      const resize = stubResizeObserver();
      const { seen, comments } = stageProbe();
      const { strip, scrollToOffset } = render({ comments });
      scrollToOffset(WIDTH * 3 + 40);
      expect(strip.dataset.feedStageRegion).toBe("comments");
      resize();
      expect(strip.scrollLeft).toBe(-WIDTH * 3);
      const anchor = vi.fn<() => number | null>(() => WIDTH * 5 + 12);
      act(() => seen.current!.setCommentsAnchor(anchor));
      resize();
      expect(strip.scrollLeft).toBe(-(WIDTH * 5 + 12));
      anchor.mockReturnValue(null);
      resize();
      expect(strip.scrollLeft).toBe(-WIDTH * 3);
      act(() => seen.current!.setCommentsAnchor(null));
      anchor.mockClear();
      resize();
      expect(anchor).not.toHaveBeenCalled();
    });

    it("keeps re-pinning media resizes to the shown image", () => {
      const resize = stubResizeObserver();
      const { seen, comments } = stageProbe();
      const { strip, scrollToOffset } = render({ comments });
      const anchor = vi.fn(() => WIDTH * 7);
      act(() => seen.current!.setCommentsAnchor(anchor));
      scrollToOffset(WIDTH);
      strip.scrollLeft = -WIDTH - 30;
      resize();
      expect(strip.scrollLeft).toBe(-WIDTH);
      expect(anchor).not.toHaveBeenCalled();
    });

    it("re-aims a smooth scroll to the comments when they grow under it", () => {
      const resize = stubResizeObserver();
      const { comments } = stageProbe();
      const { ref, strip, scrollTo } = render({ comments });
      act(() => {
        ref.current!.scrollToComments();
      });
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: -WIDTH * 3,
        behavior: "smooth",
      });
      // The first page lands mid-way: aim again in the grown strip.
      strip.scrollLeft = -WIDTH * 2 - 50;
      scrollTo.mockClear();
      resize();
      expect(scrollTo).toHaveBeenCalledWith({
        left: -WIDTH * 3,
        behavior: "smooth",
      });
      // Once the strip settles, later growth leaves it where it is.
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      scrollTo.mockClear();
      resize();
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });
});
