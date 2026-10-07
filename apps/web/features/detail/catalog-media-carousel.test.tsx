// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogMediaCarousel,
  resolveCarouselAxis,
  shouldCommitCarouselSwipe,
} from "./catalog-media-carousel";

import { MEDIA_SIZES } from "../media/responsive-media";

import type { Root } from "react-dom/client";
import type { MediaId, PublicMedia } from "@moya/contracts";
import type { CatalogMediaCarouselProps } from "./catalog-media-carousel";
import type { DetailMediaPresentation } from "./catalog-detail-presentation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const media = [1, 2, 3].map((index): PublicMedia => ({
  alt: `图像 ${index}`,
  height: 600,
  id: `media-${index}` as MediaId,
  kind: "image",
  src: `https://example.test/${index}.jpg`,
  width: 400,
}));
const roots: Root[] = [];

const pointerEvent = (
  type: string,
  properties: Record<string, number | boolean>,
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
};

const touchEvent = (type: string, activeTouches: number) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: Array.from({ length: activeTouches }, () => ({})),
  });
  return event;
};

const renderCarousel = (activeIndex = 0) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onActiveIndexChange = vi.fn();
  const onOpenViewer = vi.fn();
  act(() =>
    root.render(
      <CatalogMediaCarousel
        activeIndex={activeIndex}
        media={media}
        onActiveIndexChange={onActiveIndexChange}
        onOpenViewer={onOpenViewer}
        platform="phone"
      />,
    ),
  );
  const stage = container.querySelector<HTMLElement>(
    "[data-detail-main-stage]",
  )!;
  Object.defineProperty(stage, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 300 }),
  });
  Object.defineProperty(stage, "clientWidth", {
    configurable: true,
    value: 300,
  });
  return { container, onActiveIndexChange, onOpenViewer, stage };
};

const renderControlledCarousel = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const changes = vi.fn();
  const Controlled = (props: Partial<CatalogMediaCarouselProps>) => {
    const [index, setIndex] = useState(0);
    return (
      <CatalogMediaCarousel
        activeIndex={index}
        media={media}
        onActiveIndexChange={(value) => {
          changes(value);
          setIndex(value);
        }}
        onOpenViewer={vi.fn()}
        platform="phone"
        {...props}
      />
    );
  };
  const render = (props: Partial<CatalogMediaCarouselProps> = {}) =>
    act(() => root.render(<Controlled {...props} />));
  render();
  const stage = container.querySelector<HTMLElement>(
    "[data-detail-main-stage]",
  )!;
  let width = 300;
  let left = 0;
  const writes = vi.fn((value: number) => {
    left = value;
  });
  Object.defineProperty(stage, "clientWidth", { get: () => width });
  Object.defineProperty(stage, "scrollLeft", { get: () => left, set: writes });
  Object.defineProperty(stage, "getBoundingClientRect", {
    value: () => ({ width }),
  });
  const smooth = vi.fn();
  Object.defineProperty(stage, "scrollTo", { value: smooth });
  const position = (value: number) =>
    act(() => {
      left = value;
      stage.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  const select = (index: number) =>
    act(() => {
      const dots = container.querySelectorAll<HTMLButtonElement>(
        "[data-detail-media-dot]",
      );
      dots[index]!.click();
    });
  return {
    container,
    stage,
    root,
    changes,
    writes,
    smooth,
    position,
    select,
    render,
    resize: (value: number) => {
      width = value;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("CatalogMediaCarousel", () => {
  it("moves indicator weights with native drag before the selected image commits", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    act(() => view.stage.dispatchEvent(touchEvent("touchstart", 1)));
    view.position(150);
    const dots = view.container.querySelectorAll<HTMLElement>(
      "[data-detail-media-dot] > span",
    );
    expect(dots[0]!.style.getPropertyValue("--media-dot-size")).toBe("7px");
    expect(dots[1]!.style.getPropertyValue("--media-dot-size")).toBe("7px");
    expect(dots[0]!.style.getPropertyValue("--media-dot-weight")).toBe("50%");
    expect(view.changes).not.toHaveBeenCalled();
    view.position(225);
    expect(dots[0]!.style.getPropertyValue("--media-dot-size")).toBe("6.5px");
    expect(dots[1]!.style.getPropertyValue("--media-dot-size")).toBe("7.5px");
    act(() => view.stage.dispatchEvent(touchEvent("touchcancel", 0)));
    expect(dots[0]!.style.getPropertyValue("--media-dot-weight")).toBe("100%");
  });

  it("accepts normal smooth completion without corrective writes", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(300);
    act(() => vi.runAllTimers());
    expect(view.changes.mock.calls).toEqual([[1]]);
    expect(view.writes).not.toHaveBeenCalled();
  });

  it("clears a late native compositor offset during the bounded PC realignment", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(300);
    act(() => vi.runAllTimers());
    view.render({ platform: "pc" });
    expect(view.stage.scrollLeft).toBe(0);
    // A native compositor can publish its final fractional offset after the
    // synchronous platform layout effect but before the existing frame handoff.
    view.position(1);
    act(() => vi.runAllTimers());
    expect(view.stage.scrollLeft).toBe(0);
    expect(view.changes.mock.calls).toEqual([[1]]);
  });

  it.each(["unmount", "return-native"])(
    "cancels the PC handoff before %s",
    (next) => {
      vi.useFakeTimers();
      const view = renderControlledCarousel();
      view.select(1);
      view.position(300);
      act(() => vi.runAllTimers());
      view.render({ platform: "pc" });
      if (next === "unmount") act(() => view.root.render(null));
      else view.render({ platform: "phone" });
      view.writes.mockClear();
      act(() => vi.runAllTimers());
      expect(view.writes).not.toHaveBeenCalled();
      if (next === "return-native") expect(view.stage.scrollLeft).toBe(300);
    },
  );

  it("does not restart a canceled programmatic request on native touch cancel", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    act(() => view.stage.dispatchEvent(touchEvent("touchstart", 1)));
    view.position(150);
    act(() => view.stage.dispatchEvent(touchEvent("touchcancel", 0)));
    act(() => vi.runAllTimers());
    expect(view.stage.scrollLeft).toBe(0);
    expect(view.changes.mock.calls).toEqual([[1], [0]]);
  });

  it("never repeatedly corrects a target if the compositor remains short of it", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    // Simulate a compositor that rejects the corrective write itself.
    view.writes.mockImplementation(() => {});
    act(() => vi.runAllTimers());
    view.position(108);
    act(() => vi.runAllTimers());
    view.position(108);
    act(() => vi.runAllTimers());
    expect(view.writes.mock.calls).toEqual([[300]]);
    expect(view.changes.mock.calls).toEqual([[1]]);
  });

  it("delivers a current dot selected by a real pointer sequence during smooth paging", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    const dot = view.container.querySelectorAll<HTMLButtonElement>(
      "[data-detail-media-dot]",
    )[1]!;
    act(() => {
      dot.dispatchEvent(
        pointerEvent("pointerdown", {
          isPrimary: true,
          button: 0,
          pointerId: 1,
        }),
      );
      dot.click();
      vi.runAllTimers();
    });
    expect(view.stage.scrollLeft).toBe(300);
    expect(view.changes.mock.calls).toEqual([[1]]);
  });

  it("realigns after a corrective landing followed immediately by resize", () => {
    vi.useFakeTimers();
    let resized = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    act(() => vi.advanceTimersByTime(121));
    view.resize(450);
    act(() => {
      resized();
      vi.runAllTimers();
    });
    expect(view.stage.scrollLeft).toBe(450);
  });

  it.each(["wheel", "touchcancel"])(
    "does not let a completed page's %s disable later resize",
    (kind) => {
      vi.useFakeTimers();
      let resized = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            resized = callback;
          }
          observe() {}
          disconnect() {}
        },
      );
      const view = renderControlledCarousel();
      view.select(1);
      view.position(300);
      act(() => vi.runAllTimers());
      act(() => {
        if (kind === "touchcancel") {
          view.stage.dispatchEvent(touchEvent("touchstart", 1));
          view.stage.dispatchEvent(touchEvent("touchcancel", 0));
        } else view.stage.dispatchEvent(new Event("wheel", { bubbles: true }));
        vi.runAllTimers();
      });
      view.resize(450);
      act(() => {
        resized();
        vi.runAllTimers();
      });
      expect(view.stage.scrollLeft).toBe(450);
    },
  );

  it("cancels an old request when navigation supplies a different active index", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    view.render({ activeIndex: 0 });
    view.writes.mockClear();
    act(() => vi.runAllTimers());
    expect(view.stage.scrollLeft).toBe(0);
    expect(view.writes).not.toHaveBeenCalled();
  });

  it.each(["wheel", "keydown", "pointerdown", "touchstart"])(
    "yields an unfinished request to %s",
    (kind) => {
      vi.useFakeTimers();
      const view = renderControlledCarousel();
      view.select(1);
      view.position(108);
      const event =
        kind === "keydown"
          ? new KeyboardEvent(kind, { bubbles: true, key: "ArrowRight" })
          : kind === "pointerdown"
            ? pointerEvent(kind, { isPrimary: true, button: 0, pointerId: 1 })
            : kind === "touchstart"
              ? touchEvent(kind, 1)
              : new Event(kind, { bubbles: true });
      act(() => view.stage.dispatchEvent(event));
      view.writes.mockClear();
      act(() => vi.runAllTimers());
      // A released input can settle to the native nearest page, never the old target.
      expect(view.stage.scrollLeft).toBe(kind === "touchstart" ? 108 : 0);
      expect(view.writes).not.toHaveBeenCalledWith(300);
      if (kind === "touchstart")
        act(() => view.stage.dispatchEvent(touchEvent("touchend", 0)));
      view.position(0);
      act(() => vi.runAllTimers());
      expect(view.changes.mock.calls).toEqual([[1], [0]]);
    },
  );

  it("replaces old requests when selecting another image", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    view.select(2);
    act(() => vi.runAllTimers());
    expect(view.stage.scrollLeft).toBe(600);
    expect(view.changes.mock.calls).toEqual([[1], [2]]);
    expect(view.writes.mock.calls).toEqual([[600]]);
  });

  it("uses the current viewport for a pending target but does not revive user-canceled requests", () => {
    vi.useFakeTimers();
    let resized = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const view = renderControlledCarousel();
    view.select(1);
    view.position(108);
    view.resize(450);
    act(() => {
      resized();
      vi.runAllTimers();
    });
    expect(view.stage.scrollLeft).toBe(450);
    view.position(450);
    act(() => vi.runAllTimers());
    view.select(2);
    view.position(500);
    act(() => view.stage.dispatchEvent(new Event("wheel", { bubbles: true })));
    view.writes.mockClear();
    view.resize(600);
    act(() => {
      view.stage.dispatchEvent(new Event("wheel", { bubbles: true }));
      resized();
      vi.runAllTimers();
    });
    expect(view.writes.mock.calls).toEqual([[600]]);
    expect(view.changes.mock.calls).toEqual([[1], [2], [1]]);
  });

  it.each(["media", "platform", "unmount"])(
    "clears old work on %s changes",
    (kind) => {
      vi.useFakeTimers();
      const view = renderControlledCarousel();
      view.select(1);
      view.position(108);
      if (kind === "media")
        view.render({
          media: media.map((item) => ({
            ...item,
            id: `${item.id}-new` as MediaId,
          })),
        });
      else if (kind === "platform") view.render({ platform: "pc" });
      else act(() => view.root.render(null));
      view.writes.mockClear();
      act(() => vi.runAllTimers());
      expect(view.writes).not.toHaveBeenCalled();
      expect(view.changes.mock.calls).toEqual([[1]]);
    },
  );

  it("keeps reduced-motion navigation immediate and free of delayed corrections", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const view = renderControlledCarousel();
    view.select(1);
    act(() => vi.runAllTimers());
    expect(view.smooth).not.toHaveBeenCalled();
    expect(view.writes.mock.calls).toEqual([[300]]);
    expect(view.changes.mock.calls).toEqual([[1]]);
  });
  it("does not round an unfinished programmatic page back to the previous image", () => {
    vi.useFakeTimers();
    const view = renderControlledCarousel();
    view.select(1);
    expect(view.smooth).toHaveBeenCalledWith({ behavior: "smooth", left: 300 });
    view.position(108);
    act(() => vi.advanceTimersByTime(121));
    expect(view.changes.mock.calls).toEqual([[1]]);
    expect(view.stage.scrollLeft).toBe(300);
    expect(view.writes).toHaveBeenCalledTimes(1);
    view.position(300);
    act(() => vi.runAllTimers());
    expect(view.writes).toHaveBeenCalledTimes(1);
  });
  it("keeps the single-media state free of inactive Carousel controls", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogMediaCarousel
          activeIndex={0}
          media={media.slice(0, 1)}
          onActiveIndexChange={vi.fn()}
          onOpenViewer={vi.fn()}
          platform="phone"
        />,
      ),
    );
    expect(container.querySelectorAll("[data-detail-media-dot]")).toHaveLength(
      0,
    );
    expect(container.querySelector("[data-detail-media-index]")).toBeNull();
  });

  it("locks only decisive horizontal gestures and applies the bounded threshold", () => {
    expect(resolveCarouselAxis(6, 2)).toBeNull();
    expect(resolveCarouselAxis(20, 4)).toBe("horizontal");
    expect(resolveCarouselAxis(12, 20)).toBe("vertical");
    expect(shouldCommitCarouselSwipe(47, 200, 0)).toBe(false);
    expect(shouldCommitCarouselSwipe(48, 200, 0)).toBe(true);
    expect(shouldCommitCarouselSwipe(4, 300, 0.56)).toBe(true);
  });

  it("commits one direct swipe, while pointer cancel and lost capture commit zero", () => {
    const { onActiveIndexChange, stage } = renderCarousel();
    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          button: 0,
          clientX: 180,
          clientY: 80,
          isPrimary: true,
          pointerId: 1,
          timeStamp: 0,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 100,
          clientY: 82,
          pointerId: 1,
          timeStamp: 20,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 100,
          clientY: 82,
          pointerId: 1,
          timeStamp: 40,
        }),
      );
    });
    expect(onActiveIndexChange).toHaveBeenCalledOnce();
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);

    onActiveIndexChange.mockClear();
    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          button: 0,
          clientX: 180,
          clientY: 80,
          isPrimary: true,
          pointerId: 2,
          timeStamp: 50,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 90,
          clientY: 82,
          pointerId: 2,
          timeStamp: 70,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointercancel", { pointerId: 2, timeStamp: 80 }),
      );
      stage.dispatchEvent(
        pointerEvent("lostpointercapture", { pointerId: 2, timeStamp: 81 }),
      );
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();

    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          button: 0,
          clientX: 180,
          clientY: 80,
          isPrimary: true,
          pointerId: 3,
          timeStamp: 90,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 90,
          clientY: 82,
          pointerId: 3,
          timeStamp: 110,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("lostpointercapture", {
          pointerId: 3,
          timeStamp: 120,
        }),
      );
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it("ignores a child capture-transfer loss and commits the pointer swipe", () => {
    const { container, onActiveIndexChange } = renderCarousel();
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-detail-main-image]",
    )!;

    act(() => {
      opener.dispatchEvent(
        pointerEvent("pointerdown", {
          button: 0,
          clientX: 180,
          clientY: 80,
          isPrimary: true,
          pointerId: 4,
          timeStamp: 0,
        }),
      );
      opener.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 150,
          clientY: 82,
          pointerId: 4,
          timeStamp: 10,
        }),
      );
      opener.dispatchEvent(
        pointerEvent("lostpointercapture", {
          clientX: 150,
          clientY: 82,
          pointerId: 4,
          timeStamp: 11,
        }),
      );
      opener.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 100,
          clientY: 82,
          pointerId: 4,
          timeStamp: 20,
        }),
      );
      opener.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 100,
          clientY: 82,
          pointerId: 4,
          timeStamp: 30,
        }),
      );
    });

    expect(onActiveIndexChange).toHaveBeenCalledOnce();
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });

  it("commits native touch paging only after release and rolls back cancel", () => {
    vi.useFakeTimers();
    const first = renderCarousel();
    expect(first.stage.dataset.nativePaging).toBe("true");

    act(() => {
      first.stage.dispatchEvent(touchEvent("touchstart", 1));
      first.stage.scrollLeft = 300;
      first.stage.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(first.onActiveIndexChange).not.toHaveBeenCalled();

    act(() => {
      first.stage.dispatchEvent(touchEvent("touchend", 0));
      vi.advanceTimersByTime(121);
    });
    expect(first.onActiveIndexChange).toHaveBeenCalledOnce();
    expect(first.onActiveIndexChange).toHaveBeenCalledWith(1);

    const canceled = renderCarousel(1);
    act(() => {
      canceled.stage.scrollLeft = 300;
      canceled.stage.dispatchEvent(touchEvent("touchstart", 1));
      canceled.stage.scrollLeft = 450;
      canceled.stage.dispatchEvent(new Event("scroll", { bubbles: true }));
      canceled.stage.dispatchEvent(touchEvent("touchcancel", 0));
      // Native compositors can publish one final partial offset after cancel.
      canceled.stage.scrollLeft = 150;
      canceled.stage.dispatchEvent(new Event("scroll", { bubbles: true }));
      vi.advanceTimersByTime(121);
    });
    expect(canceled.stage.scrollLeft).toBe(300);
    expect(canceled.onActiveIndexChange).not.toHaveBeenCalled();
  });

  it("opens only the active image and suppresses a drag-generated click", () => {
    const { container, onOpenViewer, stage } = renderCarousel();
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-detail-main-image]",
    )!;
    act(() => opener.click());
    expect(onOpenViewer).toHaveBeenCalledWith(0, opener);
    onOpenViewer.mockClear();

    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          button: 0,
          clientX: 180,
          clientY: 80,
          isPrimary: true,
          pointerId: 10,
          timeStamp: 0,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 100,
          clientY: 82,
          pointerId: 10,
          timeStamp: 20,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 100,
          clientY: 82,
          pointerId: 10,
          timeStamp: 40,
        }),
      );
      opener.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(onOpenViewer).not.toHaveBeenCalled();

    act(() => opener.click());
    expect(onOpenViewer).toHaveBeenCalledWith(0, opener);
  });

  it("keeps edge controls bounded and exposes dots, counter, and failed media", () => {
    const { container, onActiveIndexChange } = renderCarousel();
    expect(container.querySelectorAll("[data-detail-media-dot]")).toHaveLength(
      3,
    );
    expect(
      container.querySelector("[data-detail-media-index]")?.textContent,
    ).toContain("1 / 3");
    act(() =>
      (
        container.querySelector(
          "[data-detail-media-previous]",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector("img")
        ?.dispatchEvent(new Event("error", { bubbles: true })),
    );
    expect(
      container.querySelector('[data-detail-media-state="failed"]'),
    ).not.toBeNull();
  });
});

/*
 * unified-media-pipeline-v1 (CW4/CW13): the carousel loads candidates up to
 * the display anchor only; zoom levels stay for the Viewer. The stage
 * letterboxes, so no placeholder colour is painted.
 */
describe("CatalogMediaCarousel responsive media", () => {
  const origin = "https://media.example.invalid/detail";
  const candidate = (width: number, height: number) => ({
    src: `${origin}/${width}.webp`,
    width,
    height,
    contentType: "image/webp" as const,
  });
  const responsive: DetailMediaPresentation = {
    id: "media-responsive",
    alt: "局部",
    src: candidate(1600, 900).src,
    width: 1600,
    height: 900,
    placeholderColor: "#8b735f",
    renditions: [
      candidate(480, 270),
      candidate(1080, 608),
      candidate(1600, 900),
      candidate(3200, 1800),
    ],
  };
  const render = (platform: "phone" | "tablet" | "pc") => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogMediaCarousel
          activeIndex={0}
          media={[responsive, media[1]!]}
          onActiveIndexChange={vi.fn()}
          onOpenViewer={vi.fn()}
          platform={platform}
        />,
      ),
    );
    return container;
  };

  it("offers candidates up to the anchor with sizes for the platform's stage", () => {
    for (const platform of ["phone", "tablet", "pc"] as const) {
      const [active, legacy] = render(platform).querySelectorAll("img");
      expect(active?.getAttribute("src")).toBe(responsive.src);
      expect(active?.getAttribute("srcset")).toBe(
        `${origin}/480.webp 480w, ${origin}/1080.webp 1080w, ${origin}/1600.webp 1600w`,
      );
      expect(active?.getAttribute("sizes")).toBe(
        MEDIA_SIZES.detailCarousel(responsive, platform),
      );
      expect(active?.getAttribute("fetchpriority")).toBe("high");
      expect(active?.getAttribute("loading")).toBe("eager");
      expect(active?.getAttribute("width")).toBe("1600");
      expect(legacy?.hasAttribute("srcset")).toBe(false);
      expect(legacy?.getAttribute("loading")).toBe("lazy");
    }
  });

  it("never tints the letterboxed stage", () => {
    const container = render("phone");
    for (const node of container.querySelectorAll<HTMLElement>(
      "[data-detail-main-stage], [data-media-id], img, button",
    ))
      expect(node.style.backgroundColor).toBe("");
  });
});
