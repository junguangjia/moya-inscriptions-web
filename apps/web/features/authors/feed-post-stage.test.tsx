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
    act(() =>
      root.render(
        <section data-test-feed-port="" style={{ overflowY: "auto" }}>
          <article data-feed-post="">
            <FeedPostStage ref={ref} {...props} {...next} />
            <p>Expanded post body</p>
          </article>
        </section>,
      ),
    );
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
  vi.restoreAllMocks();
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

const stubPostVisibility = () => {
  const observers: {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        observers.push({
          callback,
          options,
          observe: this.observe,
          disconnect: this.disconnect,
        });
      }
    },
  );
  const notify = (top: number, isIntersecting: boolean, height = 600) =>
    act(() => {
      const observer = observers.at(-1)!;
      observer.callback(
        [
          {
            isIntersecting,
            boundingClientRect: new DOMRect(0, top, WIDTH, height),
            rootBounds: new DOMRect(0, 100, WIDTH, 600),
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });
  return { observers, notify };
};

describe("FeedPostStage", () => {
  it.each([-600, 701])(
    "returns to the first image after the whole post exits at y=%s",
    (top) => {
      const { observers, notify } = stubPostVisibility();
      const onActiveMediaIndexChange = vi.fn();
      const view = render({ resetOnExit: true, onActiveMediaIndexChange });
      expect(observers).toHaveLength(1);
      expect(observers[0]!.options?.root).toBe(
        view.container.querySelector("[data-test-feed-port]"),
      );
      expect(observers[0]!.observe).toHaveBeenCalledExactlyOnceWith(
        view.container.querySelector("[data-feed-post]"),
      );
      notify(100, true);
      view.scrollToOffset(WIDTH * 2);
      expect(view.strip.dataset.feedStageIndex).toBe("2");
      notify(top, false);
      notify(100, true);
      expect(Math.abs(view.strip.scrollLeft)).toBe(0);
      expect(view.strip.dataset.feedStageIndex).toBe("0");
      expect(view.strip.dataset.feedStageRegion).toBe("media");
      expect(
        view.container
          .querySelector("[data-feed-post-dots]")
          ?.getAttribute("data-feed-post-progress"),
      ).toBe("0");
      expect(view.slideButton(0).tabIndex).toBe(0);
      expect(onActiveMediaIndexChange).toHaveBeenLastCalledWith(0);
    },
  );

  it("preserves the image while any of the post remains visible or a tab moves horizontally", () => {
    const { notify } = stubPostVisibility();
    const view = render({ resetOnExit: true });
    notify(100, true);
    view.scrollToOffset(WIDTH);
    notify(-200, true);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
    notify(100, false);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
    // Hidden layout has no readable geometry; it is not a vertical exit.
    notify(-100, false, 0);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
  });

  it("ignores an initial offscreen post and disconnects its observer on unmount", () => {
    const { observers, notify } = stubPostVisibility();
    const view = render({ resetOnExit: true });
    view.scrollToOffset(WIDTH);
    notify(-600, false);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
    act(() => roots.pop()!.unmount());
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves a hidden profile tab when switching also restores a different vertical position", () => {
    const { notify } = stubPostVisibility();
    const view = render({ resetOnExit: true });
    const panel = view.container.querySelector("[data-test-feed-port]")!;
    notify(100, true);
    view.scrollToOffset(WIDTH);
    panel.setAttribute("aria-hidden", "true");
    panel.setAttribute("inert", "");
    notify(701, false);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
    panel.removeAttribute("aria-hidden");
    panel.removeAttribute("inert");
    notify(100, true);
    expect(view.strip.dataset.feedStageIndex).toBe("1");
    notify(-600, false);
    expect(view.strip.dataset.feedStageIndex).toBe("0");
  });

  it("resets on the first vertical exit after revealing a tab without a new intersection entry", () => {
    const { notify } = stubPostVisibility();
    const view = render({ resetOnExit: true });
    const panel = view.container.querySelector("[data-test-feed-port]")!;
    panel.setAttribute("aria-hidden", "true");
    panel.setAttribute("inert", "");
    view.scrollToOffset(WIDTH);
    notify(100, true);
    panel.removeAttribute("aria-hidden");
    panel.removeAttribute("inert");
    // Explicit-root observers need not report the horizontal reveal.
    notify(-600, false);
    expect(view.strip.dataset.feedStageIndex).toBe("0");
  });

  it("resets comments, held snapping and pending scrolling without reviving a tap", () => {
    const { notify } = stubPostVisibility();
    const probe = stageProbe();
    const onRegionChange = vi.fn();
    const view = render({
      resetOnExit: true,
      comments: probe.comments,
      onRegionChange,
    });
    notify(100, true);
    view.scrollToOffset(WIDTH * 3);
    expect(view.strip.dataset.feedStageRegion).toBe("comments");
    act(() => probe.seen.current!.holdSnap?.());
    expect(view.strip.style.scrollSnapType).toBe("none");
    act(() => view.ref.current!.scrollToIndex(1));
    view.tap(1);
    notify(-600, false);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.strip.dataset.feedStageRegion).toBe("media");
    expect(view.strip.dataset.feedStageIndex).toBe("0");
    expect(Math.abs(view.strip.scrollLeft)).toBe(0);
    expect(view.strip.style.scrollSnapType).toBe("");
    expect(probe.seen.current!.isSettled()).toBe(true);
    expect(onRegionChange).toHaveBeenLastCalledWith("media");
    expect(view.props.onOpenViewer).not.toHaveBeenCalled();
  });

  it("leaves Detail selection and an open Viewer outside the exit-reset behavior", () => {
    const { observers } = stubPostVisibility();
    const detail = render({ activeMediaIndex: 1 });
    expect(detail.strip.dataset.feedStageIndex).toBe("1");
    expect(observers).toHaveLength(0);
    const feed = render({ resetOnExit: true, viewerOpen: true });
    expect(observers).toHaveLength(0);
    feed.draw({ viewerOpen: false });
    expect(observers).toHaveLength(1);
    feed.draw({ viewerOpen: true });
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

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

  it("contains every image when Detail requests an uncropped stage", () => {
    const { container } = render({ imageFit: "contain" });
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-feed-slide]")].map(
        (slide) => slide.dataset.fit,
      ),
    ).toEqual(["contain", "contain", "contain"]);
    expect(container.querySelectorAll("img")).toHaveLength(3);
  });

  it("reports a changed image after settling, without reporting the comments", () => {
    const onActiveMediaIndexChange = vi.fn();
    const { strip, scrollToOffset } = render({
      onActiveMediaIndexChange,
      comments: <p>题跋</p>,
    });
    strip.scrollLeft = -WIDTH;
    act(() => strip.dispatchEvent(new Event("scroll")));
    act(() => vi.advanceTimersByTime(60));
    expect(onActiveMediaIndexChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(140));
    expect(onActiveMediaIndexChange).toHaveBeenCalledExactlyOnceWith(1);
    scrollToOffset(WIDTH);
    expect(onActiveMediaIndexChange).toHaveBeenCalledTimes(1);
    scrollToOffset(WIDTH * 3);
    expect(onActiveMediaIndexChange).toHaveBeenCalledTimes(1);
    scrollToOffset(WIDTH * 2);
    expect(onActiveMediaIndexChange).toHaveBeenLastCalledWith(2);
  });

  it("restores an externally selected Viewer image without echoing a change", () => {
    const onActiveMediaIndexChange = vi.fn();
    const { strip, draw } = render({
      activeMediaIndex: 0,
      onActiveMediaIndexChange,
    });
    draw({ activeMediaIndex: 2, viewerOpen: true });
    expect(strip.scrollLeft).toBe(-WIDTH * 2);
    expect(strip.dataset.feedStageIndex).toBe("2");
    draw({ activeMediaIndex: 2, viewerOpen: false });
    expect(strip.scrollLeft).toBe(-WIDTH * 2);
    expect(strip.dataset.feedStageIndex).toBe("2");
    expect(onActiveMediaIndexChange).not.toHaveBeenCalled();
    // Media can disappear while the Detail remains mounted.
    draw({ activeMediaIndex: 2, media: [three[0]!] });
    expect(Math.abs(strip.scrollLeft)).toBe(0);
    expect(strip.dataset.feedStageIndex).toBe("0");
  });

  it("pins an initial external index when stage geometry becomes available", () => {
    const resize = stubResizeObserver();
    const { strip } = render({ activeMediaIndex: 2 });
    resize();
    expect(strip.scrollLeft).toBe(-WIDTH * 2);
    expect(strip.dataset.feedStageIndex).toBe("2");
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

  describe("opt-in Live Photo playback", () => {
    const liveMedia = three.map((item) => ({
      ...item,
      live: { motionSrc: `/media/${item.id}.mp4`, hasAudio: true },
    }));
    let play: ReturnType<typeof vi.spyOn>;
    let pause: ReturnType<typeof vi.spyOn>;
    let load: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      pause = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => {});
      load = vi
        .spyOn(HTMLMediaElement.prototype, "load")
        .mockImplementation(() => {});
    });

    it("keeps the default feed as stills even when motion is available", () => {
      const { container } = render({ media: liveMedia, live: true });
      expect(container.querySelector("[data-live-photo]")).toBeNull();
      expect(container.querySelector("video")).toBeNull();
      expect(
        container.querySelectorAll('[aria-label="实况照片"]'),
      ).toHaveLength(1);
      expect(play).not.toHaveBeenCalled();
    });

    it("loads motion only on explicit play and isolates controls from image taps and gestures", async () => {
      const probe = stageProbe();
      const onOpenViewer = vi.fn();
      const onDoubleTap = vi.fn();
      const { container, tap, strip } = render({
        media: liveMedia,
        enableLivePlayback: true,
        comments: probe.comments,
        onOpenViewer,
        onDoubleTap,
      });
      const control = container.querySelector<HTMLButtonElement>(
        '[data-feed-slide="0"] [data-live-photo-play]',
      )!;
      const video = container.querySelector<HTMLVideoElement>("video")!;
      expect(container.querySelectorAll("video")).toHaveLength(1);
      expect(video.hasAttribute("src")).toBe(false);
      expect(play).not.toHaveBeenCalled();
      // A playback control also cancels the preceding image's delayed tap.
      tap();
      act(() => {
        control.dispatchEvent(
          new TouchEvent("touchstart", {
            bubbles: true,
            touches: [{ clientX: 20, clientY: 20, identifier: 0 } as Touch],
          }),
        );
        control.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
      });
      expect(probe.seen.current!.isSettled()).toBe(true);
      await act(async () => {
        control.dispatchEvent(
          new MouseEvent("click", { bubbles: true, detail: 1 }),
        );
      });
      act(() => vi.advanceTimersByTime(1000));
      expect(play).toHaveBeenCalledOnce();
      expect(video.getAttribute("src")).toBe(liveMedia[0]!.live.motionSrc);
      expect(video.muted).toBe(true);
      expect(strip.scrollLeft).toBe(0);
      expect(onOpenViewer).not.toHaveBeenCalled();
      expect(onDoubleTap).not.toHaveBeenCalled();
      act(() => video.dispatchEvent(new Event("playing")));
      const sound = container.querySelector<HTMLButtonElement>(
        '[data-feed-slide="0"] [data-live-photo-sound]',
      )!;
      act(() => sound.click());
      expect(video.muted).toBe(false);
      expect(onOpenViewer).not.toHaveBeenCalled();
      expect(onDoubleTap).not.toHaveBeenCalled();
    });

    it("releases a playing slide on image change and while the Viewer covers it", async () => {
      const { container, scrollToOffset, draw } = render({
        media: liveMedia,
        enableLivePlayback: true,
      });
      const first = container.querySelector<HTMLVideoElement>("video")!;
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-feed-slide="0"] [data-live-photo-play]',
          )!
          .click();
      });
      act(() => first.dispatchEvent(new Event("playing")));
      scrollToOffset(WIDTH);
      expect(first.hasAttribute("src")).toBe(false);
      expect(pause).toHaveBeenCalled();
      expect(load).toHaveBeenCalled();
      expect(container.querySelector('[data-feed-slide="0"] video')).toBeNull();
      const second = container.querySelector<HTMLVideoElement>(
        '[data-feed-slide="1"] video',
      )!;
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-feed-slide="1"] [data-live-photo-play]',
          )!
          .click();
      });
      draw({ viewerOpen: true });
      expect(second.hasAttribute("src")).toBe(false);
      expect(container.querySelector("video")).toBeNull();
      draw({ viewerOpen: false });
      expect(container.querySelectorAll("video")).toHaveLength(1);
      expect(container.querySelector("video")!.hasAttribute("src")).toBe(false);
      expect(play).toHaveBeenCalledTimes(2);
    });

    it("stops motion when its frame leaves view and keeps the original still", async () => {
      const callbacks: IntersectionObserverCallback[] = [];
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(callback: IntersectionObserverCallback) {
            callbacks.push(callback);
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const { container } = render({
        media: [liveMedia[0]!],
        enableLivePlayback: true,
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-live-photo-play]")!
          .click();
      });
      const video = container.querySelector<HTMLVideoElement>("video")!;
      act(() => video.dispatchEvent(new Event("playing")));
      act(() =>
        callbacks.forEach((callback) =>
          callback(
            [
              {
                isIntersecting: false,
                intersectionRatio: 0,
              } as IntersectionObserverEntry,
            ],
            {} as IntersectionObserver,
          ),
        ),
      );
      expect(video.hasAttribute("src")).toBe(false);
      expect(
        container.querySelector<HTMLElement>("[data-live-photo]")!.dataset
          .livePlayback,
      ).toBe("idle");
      expect(container.querySelector("img")!.getAttribute("src")).toBe(
        liveMedia[0]!.src,
      );
    });
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

describe("the driven strip (Chromium)", () => {
  /**
   * An unfolded colophon from offset 1000 (its start at the right gutter)
   * whose 30 px 落款 snaps at 2000 (its left edge at the stage's left edge):
   * Chromium rests inside it up to 1970. Its driven zone includes one
   * readable view before it, clipped to the images' end at 900.
   */
  const driven = ({ input = false } = {}) => {
    const seen: { current: FeedStageApi | null } = { current: null };
    const Grab = () => {
      seen.current = useFeedStage();
      return null;
    };
    const comments = (
      <section data-feed-colophon="">
        <Grab />
        {input && (
          <form data-colophon-input="guest">
            <textarea />
          </form>
        )}
        <div data-colophon-anchor="long">
          <div data-expanded="true">
            <p data-colophon-text="">题跋</p>
            <span data-colophon-signature="root" />
          </div>
        </div>
      </section>
    );
    const view = render({ comments });
    const { strip, container } = view;
    const offset = () => -strip.scrollLeft;
    const box = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 300, width: right - left }) as DOMRect;
    strip.getBoundingClientRect = () => box(0, WIDTH);
    const row = container.querySelector<HTMLElement>(
      '[data-colophon-anchor="long"]',
    )!;
    const body = row.querySelector<HTMLElement>("[data-expanded]")!;
    const column = container.querySelector<HTMLElement>(
      "[data-colophon-input]",
    );
    if (column !== null) column.getBoundingClientRect = () => box(0, 48);
    row.getBoundingClientRect = () =>
      box(offset() + WIDTH - 1000 - 1330, offset() + WIDTH - 1000);
    container.querySelector<HTMLElement>(
      "[data-colophon-signature]",
    )!.getBoundingClientRect = () => box(offset() - 2000, offset() - 1970);
    Object.defineProperty(strip, "scrollWidth", {
      configurable: true,
      get: () => 6000,
    });
    let clock = 0;
    const fire = (
      type: "touchstart" | "touchmove" | "touchend",
      x = 100,
      y = 150,
      fingers = 1,
      target: HTMLElement = strip,
    ) =>
      act(() => {
        target.dispatchEvent(
          Object.assign(new Event(type, { bubbles: true }), {
            touches:
              type === "touchend"
                ? []
                : Array.from({ length: fingers }, () => ({
                    clientX: x,
                    clientY: y,
                  })),
          }),
        );
      });
    const wait = (ms: number) =>
      act(() => {
        clock += ms;
        vi.advanceTimersByTime(ms);
      });
    /** Rests the strip at `to` (a scroll that settles). */
    const restAt = (to: number) => {
      strip.scrollLeft = -to;
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      wait(200);
    };
    /** A finger from x 50, moved by `moves` px every 16 ms, then lifted. */
    const swipe = (
      moves: readonly number[],
      holdMs = 0,
      target: HTMLElement = strip,
    ) => {
      let x = 50;
      fire("touchstart", x, 150, 1, target);
      for (const move of moves) {
        x += move;
        fire("touchmove", x, 150, 1, target);
        wait(16);
      }
      if (holdMs > 0) wait(holdMs);
      fire("touchend", x, 150, 1, target);
    };
    return {
      ...view,
      body,
      column,
      seen,
      offset,
      fire,
      wait,
      restAt,
      swipe,
      clock,
    };
  };

  it("hands the strip's horizontal pan over only up to the 落款", () => {
    const { strip, restAt } = driven();
    restAt(1200);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    restAt(2000);
    expect(strip.style.touchAction).toBe("");
    restAt(1500);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
  });

  it("leaves the strip native before the colophon", () => {
    const { strip, restAt } = driven();
    restAt(500);
    expect(strip.style.touchAction).toBe("");
    restAt(1000);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
  });

  it("drives the whole entry view, including its preceding background", () => {
    const { strip, body, column, restAt } = driven({
      input: true,
    });
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(body.style.touchAction).toBe("");
    expect(column!.style.touchAction).toBe("");
  });

  it("keeps the image boundary and distant folded region native", () => {
    const { strip, restAt, swipe, wait, offset } = driven({ input: true });
    restAt(899);
    expect(strip.style.touchAction).toBe("");
    swipe([20, 350, 700]);
    wait(800);
    expect(offset()).toBe(899);
    restAt(900);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    restAt(500);
    expect(strip.style.touchAction).toBe("");
  });

  it.each(["body", "column", "strip"] as const)(
    "pins a fling begun before the row on its %s at the 落款",
    (surface) => {
      const view = driven({ input: true });
      const { restAt, swipe, wait, offset } = view;
      restAt(950);
      swipe([20, 350, 700], 0, view[surface]!);
      expect(offset()).toBe(2000);
      for (let frame = 0; frame < 60; frame += 1) {
        wait(16);
        expect(offset()).toBe(2000);
      }
      expect(view.strip.style.touchAction).toBe("");
      expect(view.body.style.touchAction).toBe("");
      expect(view.column!.style.touchAction).toBe("");
    },
  );

  it("does not overwrite the body's prior touch action in its entry view", () => {
    const { strip, body, column, restAt } = driven({ input: true });
    body.style.touchAction = "manipulation";
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(body.style.touchAction).toBe("manipulation");
    restAt(500);
    expect(body.style.touchAction).toBe("manipulation");
    expect(column!.style.touchAction).toBe("");
  });

  it("paces a fast entry glide without a jump after the finger lifts", () => {
    const { column, restAt, swipe, wait, offset } = driven({ input: true });
    restAt(950);
    swipe([20, 118, 118], 0, column!);
    let last = offset();
    for (let frame = 0; frame < 60; frame += 1) {
      wait(16);
      const next = offset();
      expect(next).toBeGreaterThanOrEqual(last);
      expect(next - last).toBeLessThanOrEqual(40);
      last = next;
    }
    expect(offset()).toBeGreaterThan(1186);
    expect(offset()).toBeLessThanOrEqual(2000);
  });

  it("leaves the focused input's own inline action untouched on entry", () => {
    const { strip, body, column, restAt } = driven({ input: true });
    column!.setAttribute("data-colophon-input-focused", "");
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(body.style.touchAction).toBe("");
    expect(column!.style.touchAction).toBe("");
  });

  it("does not write an input action when its textarea is focused", () => {
    const { strip, column, restAt } = driven({ input: true });
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(column!.style.touchAction).toBe("");
    act(() => column!.querySelector("textarea")!.focus());
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(column!.style.touchAction).toBe("");
  });

  it("does not drive the strip for a touch on an overflowing textarea", () => {
    const { strip, column, restAt, swipe, wait, offset } = driven({
      input: true,
    });
    const field = column!.querySelector("textarea")!;
    field.style.overflowX = "auto";
    Object.defineProperties(field, {
      clientWidth: { value: 30 },
      scrollWidth: { value: 80 },
    });
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    expect(column!.style.touchAction).toBe("");
    swipe([20, 350, 700], 0, field);
    wait(800);
    expect(offset()).toBe(950);
  });

  it("restores the native strip when the entering colophon is folded", async () => {
    const { strip, body, column, restAt, wait } = driven({ input: true });
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    await act(async () => {
      body.removeAttribute("data-expanded");
      await Promise.resolve();
    });
    wait(32);
    expect(strip.style.touchAction).toBe("");
    expect(body.style.touchAction).toBe("");
    expect(column!.style.touchAction).toBe("");
  });

  it("restores the native strip when a resize moves entry out of view", () => {
    const resize = stubResizeObserver();
    const { strip, body, column, restAt, wait } = driven({ input: true });
    restAt(950);
    expect(strip.style.touchAction).toBe("pan-y pinch-zoom");
    body.parentElement!.getBoundingClientRect = () =>
      ({ left: -500, right: -10, width: 490 }) as DOMRect;
    resize();
    wait(32);
    expect(strip.style.touchAction).toBe("");
    expect(body.style.touchAction).toBe("");
    expect(column!.style.touchAction).toBe("");
  });

  it("prepares no entry surface in WebKit", () => {
    vi.stubGlobal("GestureEvent", class {});
    const { strip, body, column, restAt, swipe, wait, offset } = driven({
      input: true,
    });
    restAt(950);
    expect(strip.style.touchAction).toBe("");
    expect(body.style.touchAction).toBe("");
    expect(column!.style.touchAction).toBe("");
    swipe([20, 350, 700], 0, column!);
    wait(800);
    expect(offset()).toBe(950);
  });

  it("follows the finger with snapping off, and holds at the 落款 ahead", () => {
    const { strip, restAt, fire, wait, offset } = driven();
    restAt(1900);
    fire("touchstart", 50);
    // The first 8 px are the touch's slop.
    fire("touchmove", 60);
    wait(16);
    fire("touchmove", 90);
    expect(offset()).toBe(1930);
    expect(strip.style.scrollSnapType).toBe("none");
    fire("touchmove", 250);
    expect(offset()).toBe(2000);
    wait(100);
    fire("touchend");
    wait(800);
    expect(offset()).toBe(2000);
    expect(strip.style.scrollSnapType).toBe("");
  });

  it("glides on from a fling to the 落款, eased, never past it nor back", () => {
    const { strip, restAt, swipe, wait, offset } = driven();
    restAt(1800);
    swipe([20, 30, 30, 30, 30]);
    const lift = offset();
    const frames: number[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      wait(16);
      frames.push(offset());
    }
    expect(offset()).toBe(2000);
    expect(Math.max(...frames)).toBeLessThanOrEqual(2000);
    frames.reduce((last, at) => {
      expect(at).toBeGreaterThanOrEqual(last);
      return at;
    }, lift);
    expect(strip.style.scrollSnapType).toBe("");
    expect(strip.style.touchAction).toBe("");
  });

  it("throws nothing back from a finger that rolls back as it lifts", () => {
    const { restAt, swipe, wait, offset } = driven();
    // Held at the 落款, the finger rolls back 6 px: the strip stays.
    restAt(1900);
    swipe([20, 30, 30, 30, 30, -3, -3]);
    expect(offset()).toBe(2000);
    wait(1000);
    expect(offset()).toBe(2000);
    // Inside the colophon: it rests where the finger lifted, never back.
    restAt(1100);
    swipe([20, 30, 30, 30, -2, -2]);
    const lift = offset();
    for (let frame = 0; frame < 60; frame += 1) {
      wait(16);
      expect(offset()).toBeGreaterThanOrEqual(lift);
    }
  });

  it("moves on one readable view at most inside the colophon", () => {
    const { restAt, swipe, wait, offset } = driven();
    restAt(1000);
    swipe([20, 30, 30, 30, 30]);
    wait(1000);
    // A view on from 1000 at the most (the stage less no gutter or column).
    expect(offset()).toBeGreaterThan(1100);
    expect(offset()).toBeLessThanOrEqual(1000 + WIDTH - 64);
  });

  it("keeps the stage unsettled while it glides, and settles once it rests", () => {
    const { seen, restAt, swipe, wait } = driven();
    restAt(1800);
    const settled = vi.fn();
    seen.current!.subscribeSettle(settled);
    swipe([20, 30, 30, 30, 30]);
    wait(32);
    expect(seen.current!.isSettled()).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    wait(1000);
    expect(seen.current!.isSettled()).toBe(true);
    expect(settled).toHaveBeenCalled();
  });

  it("catches a glide under a touch, and a tap lets it rest on its way", () => {
    const { restAt, swipe, fire, wait, offset } = driven();
    restAt(1800);
    swipe([20, 30, 30, 30, 30]);
    wait(48);
    fire("touchstart", 120);
    const caught = offset();
    wait(200);
    expect(offset()).toBe(caught);
    fire("touchend");
    wait(800);
    // On to the 落款 the glide was heading for, never back.
    expect(offset()).toBe(2000);
  });

  it("ends a glide for a scroll of its own", () => {
    const { seen, strip, restAt, swipe, wait, offset } = driven();
    restAt(1800);
    swipe([20, 30, 30, 30, 30]);
    wait(32);
    act(() => {
      seen.current!.scrollToOffset(900, "instant");
    });
    wait(400);
    expect(offset()).toBe(900);
    expect(strip.style.scrollSnapType).toBe("");
  });

  it("leaves a vertical swipe to the feed", () => {
    const { strip, restAt, fire, wait, offset } = driven();
    restAt(1200);
    fire("touchstart", 100, 100);
    fire("touchmove", 103, 140);
    wait(16);
    fire("touchmove", 140, 200);
    fire("touchend");
    wait(400);
    expect(offset()).toBe(1200);
    expect(strip.style.scrollSnapType).toBe("");
  });

  it("brings a second finger's pinch to rest", () => {
    const { restAt, fire, wait, offset } = driven();
    restAt(1950);
    fire("touchstart", 50);
    fire("touchmove", 60);
    fire("touchmove", 90);
    wait(16);
    // In the 落款's dead zone (past 1970): a pinch lets it rest on it.
    fire("touchstart", 90, 150, 2);
    wait(800);
    expect(offset()).toBe(2000);
  });

  it("drives nothing in WebKit", () => {
    vi.stubGlobal("GestureEvent", class {});
    const { strip, restAt, swipe, wait, offset } = driven();
    restAt(1200);
    expect(strip.style.touchAction).toBe("");
    swipe([20, 30, 30]);
    wait(400);
    expect(offset()).toBe(1200);
  });

  it("holds snapping off for a selection until the strip settles", () => {
    const { seen, strip, restAt, wait } = driven();
    restAt(2400);
    act(() => seen.current!.holdSnap!());
    expect(strip.style.scrollSnapType).toBe("none");
    act(() => {
      seen.current!.scrollToOffset(2500);
    });
    wait(60);
    expect(strip.style.scrollSnapType).toBe("none");
    wait(200);
    expect(strip.style.scrollSnapType).toBe("");
  });
});
