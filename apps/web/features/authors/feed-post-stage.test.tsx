// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedPostStage } from "./feed-post-stage";
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
});

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
});
