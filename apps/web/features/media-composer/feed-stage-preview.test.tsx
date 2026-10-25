// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedStagePreview } from "./feed-stage-preview";

import type {
  FeedStagePreviewProps,
  FeedStagePreviewSlide,
} from "./feed-stage-preview";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 300;
const slide = (
  key: string,
  width: number,
  height: number,
  extra: Partial<FeedStagePreviewSlide> = {},
): FeedStagePreviewSlide => ({
  key,
  alt: `第 ${key} 项`,
  src: `blob:${key}`,
  size: { width, height },
  status: "ready",
  ...extra,
});
const three = [
  slide("a", 600, 800),
  slide("b", 800, 600),
  slide("c", 600, 1200),
];

const roots: Root[] = [];
const render = (overrides: Partial<FeedStagePreviewProps> = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props: FeedStagePreviewProps = {
    slides: three,
    total: three.length,
    activeIndex: 0,
    onActiveIndexChange: vi.fn(),
    layout: "phone",
    ...overrides,
  };
  const draw = (next: Partial<FeedStagePreviewProps> = {}) =>
    act(() => root.render(<FeedStagePreview {...props} {...next} />));
  draw();
  const strip = container.querySelector<HTMLElement>(
    "[data-feed-preview-stage]",
  )!;
  let scrollLeft = 0;
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scrollLeft = options.left ?? scrollLeft;
  });
  if (strip !== null)
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
  /** Scrolls the strip `offset` pixels from its right edge and settles. */
  const scrollToOffset = (offset: number) => {
    scrollLeft = -offset;
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
  };
  return { container, strip, props, draw, scrollTo, scrollToOffset };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FeedStagePreview", () => {
  it("sizes the stage from the first slide's edited frame, between square and 4:5", () => {
    const frame = (container: HTMLElement) =>
      container
        .querySelector<HTMLElement>("[data-feed-preview-frame]")!
        .style.getPropertyValue("--feed-stage-aspect");
    expect(frame(render().container)).toBe("1 / 1.25");
    expect(frame(render({ slides: [slide("w", 1600, 900)] }).container)).toBe(
      "1 / 1",
    );
    expect(frame(render({ slides: [slide("t", 1000, 1200)] }).container)).toBe(
      "1 / 1.2",
    );
    expect(
      frame(render({ slides: [slide("u", 0, 0, { size: null })] }).container),
    ).toBe("1 / 1");
  });

  it("lays slides out in content order inside the feed's rtl strip and fits each to the stage", () => {
    const { container, strip } = render();
    expect(strip.className).toContain("postStrip");
    expect(strip.getAttribute("data-local-horizontal")).toBe("");
    expect(strip.getAttribute("data-feed-stage-count")).toBe("3");
    const slides = [...container.querySelectorAll("[data-feed-slide]")];
    expect(slides.map((node) => node.getAttribute("data-feed-slide"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    // 3:4 first → 4:5 stage: the first and the 1:2 third are centre-cropped,
    // the 4:3 second is shown whole, exactly as the feed fits them.
    expect(slides.map((node) => node.getAttribute("data-fit"))).toEqual([
      "cover",
      "contain",
      "cover",
    ]);
    expect(container.querySelectorAll("[data-feed-post-dot]")).toHaveLength(3);
    expect(
      container.querySelector("[data-feed-preview-caption]")!.textContent,
    ).toBe("第 1 张在最右，向右滑看下一张");
  });

  // #341: the author's feed framing, exactly as the feed draws it.
  it("crops a taller slide at the author's region or keeps it whole on the first slide's stage", () => {
    const { container } = render({
      slides: [
        slide("a", 600, 1800, {
          feed: { fit: "contain" },
          placeholderColor: "#4a4038",
        }),
        slide("b", 600, 1800, {
          feed: { fit: "cover", y: 1 },
          placeholderColor: "#4a4038",
        }),
        slide("c", 800, 600, { feed: { fit: "cover", y: 0 } }),
      ],
    });
    // A first slide kept whole still sets the 4:5 stage.
    expect(
      container
        .querySelector<HTMLElement>("[data-feed-preview-frame]")!
        .style.getPropertyValue("--feed-stage-aspect"),
    ).toBe("1 / 1.25");
    const slides = [
      ...container.querySelectorAll<HTMLElement>("[data-feed-slide]"),
    ];
    expect(
      slides.map((node) => [
        node.getAttribute("data-fit"),
        node.getAttribute("data-feed-framing"),
        node.style.getPropertyValue("--feed-slide-y"),
      ]),
    ).toEqual([
      ["contain", "whole", ""],
      ["cover", "region", "100%"],
      ["contain", null, ""],
    ]);
    // The asset colour only behind a covering picture.
    expect(
      slides.map((node) => node.querySelector("img")!.style.backgroundColor),
    ).toEqual(["", "rgb(74, 64, 56)", ""]);
  });

  it("says how many images stay off the feed and shows nothing for an empty post", () => {
    const { container } = render({ total: 12 });
    expect(
      container.querySelector("[data-feed-preview-caption]")!.textContent,
    ).toContain("其余 9 张仅在作品页显示");
    expect(render({ slides: [], total: 0 }).container.innerHTML).toBe("");
    // One image: no dots and no caption.
    const single = render({ slides: [three[0]!], total: 1 }).container;
    expect(single.querySelector("[data-feed-post-dots]")).toBe(null);
    expect(single.querySelector("[data-feed-preview-caption]")).toBe(null);
  });

  it("shows a placeholder until a picture exists and the fallback when it fails", () => {
    const { container } = render({
      slides: [
        slide("a", 600, 800),
        slide("b", 800, 600, { src: null, status: "loading" }),
        slide("c", 0, 0, { src: null, size: null, status: "unavailable" }),
      ],
    });
    expect(
      container
        .querySelector('[data-feed-slide="1"] [data-feed-preview-placeholder]')!
        .getAttribute("data-feed-preview-placeholder"),
    ).toBe("loading");
    expect(
      container.querySelector('[data-feed-slide="2"] [role="img"]')!
        .textContent,
    ).toBe("无法预览");
    act(() => {
      container
        .querySelector('[data-feed-slide="0"] img')!
        .dispatchEvent(new Event("error"));
    });
    const fallback = container.querySelector(
      '[data-feed-slide="0"] [data-catalog-media-state="failed"]',
    )!;
    expect(fallback.textContent).toContain("图像无法加载");
  });

  it("follows the controlled index, honours reduced motion and reports where a swipe settles", () => {
    const onActiveIndexChange = vi.fn();
    const { draw, scrollTo, scrollToOffset, strip } = render({
      onActiveIndexChange,
    });
    draw({ activeIndex: 2 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -600,
      behavior: "smooth",
    });
    expect(strip.getAttribute("data-feed-stage-index")).toBe("2");

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    draw({ activeIndex: 1 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: -300, behavior: "auto" });

    scrollToOffset(0);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("moves with the arrow keys the way the viewer does and by its dots", () => {
    const onActiveIndexChange = vi.fn();
    const { container, strip, scrollTo } = render({ onActiveIndexChange });
    const key = (value: string) =>
      act(() => {
        strip.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    key("ArrowLeft");
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -300,
      behavior: "smooth",
    });
    key("ArrowRight");
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
    key("End");
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    act(() => {
      container
        .querySelectorAll<HTMLButtonElement>("[data-feed-post-dot]")[1]!
        .click();
    });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("makes each shown picture an edit button only when the owner asks", () => {
    const plain = render().container;
    expect(plain.querySelector("[data-feed-slide] button")).toBe(null);
    expect(plain.querySelector('[data-feed-slide="0"] > img')).not.toBe(null);

    const onSlideActivate = vi.fn();
    const onActiveIndexChange = vi.fn();
    const { container } = render({
      onSlideActivate,
      onActiveIndexChange,
      slides: [
        slide("a", 600, 800),
        slide("b", 800, 600, { src: null, status: "loading" }),
        slide("c", 600, 1200),
      ],
    });
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "[data-feed-slide] button",
      ),
    ];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "编辑第 1 张",
      "编辑第 3 张",
    ]);
    expect(buttons.map((button) => button.type)).toEqual(["button", "button"]);
    expect(buttons[0]!.querySelector("img")!.getAttribute("src")).toBe(
      "blob:a",
    );
    // Only the shown slide's button is in the tab order, as in the feed.
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1]);
    expect(
      container
        .querySelector("[data-feed-preview-placeholder]")!
        .closest("button"),
    ).toBe(null);
    act(() => buttons[1]!.click());
    expect(onSlideActivate).toHaveBeenCalledExactlyOnceWith(2);
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it("guards the edit buttons like the feed: off-stage slides are inert, a swipe is no tap", () => {
    const inert = (container: HTMLElement) =>
      [...container.querySelectorAll("[data-feed-slide]")].map((node) =>
        node.hasAttribute("inert"),
      );
    expect(inert(render().container)).toEqual([false, false, false]);

    const onSlideActivate = vi.fn();
    const { container, strip } = render({ onSlideActivate });
    expect(inert(container)).toEqual([false, true, true]);
    const tap = (detail: number) =>
      act(() => {
        container.querySelector('[data-feed-slide-edit="0"]')!.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail,
          }),
        );
      });
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
    tap(1);
    expect(onSlideActivate).not.toHaveBeenCalled();
    // Keyboard and assistive activation are never part of a swipe.
    tap(0);
    expect(onSlideActivate).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("clamps an index past the last slide so the last slide stays active and tappable", () => {
    const onSlideActivate = vi.fn();
    const onActiveIndexChange = vi.fn();
    const { container, strip, scrollTo } = render({
      activeIndex: 11,
      onSlideActivate,
      onActiveIndexChange,
    });
    expect(strip.getAttribute("data-feed-stage-index")).toBe("2");
    const slides = [...container.querySelectorAll("[data-feed-slide]")];
    expect(slides.map((node) => node.hasAttribute("inert"))).toEqual([
      true,
      true,
      false,
    ]);
    expect(slides[2]!.getAttribute("aria-hidden")).toBe("false");
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-feed-slide-edit="2"]',
    )!;
    expect(edit.tabIndex).toBe(0);
    const dots = [
      ...container.querySelectorAll<HTMLButtonElement>("[data-feed-post-dot]"),
    ];
    expect(dots.map((dot) => dot.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "true",
    ]);
    act(() => edit.click());
    expect(onSlideActivate).toHaveBeenCalledExactlyOnceWith(2);
    // Keyboard paging starts from the clamped slide, not from the raw index.
    act(() => {
      strip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: -300,
      behavior: "smooth",
    });
  });

  it("keeps focus on the shown slide when the arrow keys page from an edit button", () => {
    const onActiveIndexChange = vi.fn();
    const { container, strip, draw } = render({
      onSlideActivate: vi.fn(),
      onActiveIndexChange,
      slides: [
        slide("a", 600, 800),
        slide("b", 800, 600),
        slide("c", 600, 1200, { src: null, status: "loading" }),
      ],
    });
    const edit = (index: number) =>
      container.querySelector<HTMLElement>(`[data-feed-slide-edit="${index}"]`);
    const key = (value: string) =>
      act(() => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    act(() => edit(0)!.focus());
    key("ArrowLeft");
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    draw({ activeIndex: 1 });
    expect(document.activeElement).toBe(edit(1));
    // A slide without a picture has no button: the strip keeps focus.
    key("ArrowLeft");
    draw({ activeIndex: 2 });
    expect(document.activeElement).toBe(strip);
  });
});
