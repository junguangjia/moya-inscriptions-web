// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VIEWER_UPGRADE_SETTLE_MS } from "../media/responsive-media";
import {
  CatalogViewer,
  clampViewerTransform,
  resolveViewerAxis,
  shouldCommitViewerSwipe,
  viewerFit,
  viewerPanBounds,
} from "./catalog-viewer";

import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { MediaId, PublicMedia } from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const media = [1, 2, 3].map((index): PublicMedia => ({
  alt: `查看图像 ${index}`,
  height: index === 1 ? 600 : 400,
  id: `media-${index}` as MediaId,
  kind: "image",
  src: `https://example.test/${index}.jpg`,
  width: index === 1 ? 400 : 600,
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

interface ViewerTestProperties {
  readonly controls?: ReactNode;
  readonly direction?: "ltr" | "rtl";
  readonly index?: number;
  readonly open?: boolean;
  readonly selectedMedia?: readonly PublicMedia[];
}

const renderViewer = (properties?: ViewerTestProperties) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onClose = vi.fn();
  const onIndexChange = vi.fn();
  const rerender = (next: ViewerTestProperties = properties ?? {}) => {
    act(() =>
      root.render(
        <CatalogViewer
          index={next.index ?? 0}
          media={next.selectedMedia ?? media}
          onClose={onClose}
          onIndexChange={onIndexChange}
          open={next.open ?? true}
          platform="phone"
          controls={next.controls}
          {...(next.direction === undefined
            ? {}
            : { direction: next.direction })}
        />,
      ),
    );
  };
  rerender();
  const viewer = container.querySelector<HTMLDialogElement>(
    "[data-detail-viewer]",
  )!;
  const stage = container.querySelector<HTMLElement>("[data-viewer-scale]")!;
  Object.defineProperties(stage, {
    clientHeight: { configurable: true, value: 600 },
    clientWidth: { configurable: true, value: 400 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 600,
        height: 600,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
      }),
    },
  });
  const unmount = () => {
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
  };
  return {
    container,
    onClose,
    onIndexChange,
    rerender,
    stage,
    unmount,
    viewer,
  };
};

/*
 * unified-media-pipeline-v1 (CW14): a 1600 × 900 image whose anchor (`src`)
 * is its 1600 candidate, with smaller card levels and a 3200 zoom level, as
 * in the e2e fixture. On the 400 × 600 test stage it fits 400 CSS pixels
 * wide, so at a pixel ratio of 2 it opens on the 1080 candidate.
 */
const candidateSizes = [
  [480, 270],
  [1080, 608],
  [1600, 900],
  [3200, 1800],
] as const;
const candidateSrc = (index: number, width: number, height: number) =>
  `https://media.example.invalid/${index}/${width}x${height}.webp`;
const renditionMedia = (
  index: number,
  sizes: readonly (readonly [number, number])[] = candidateSizes,
): PublicMedia => ({
  alt: `渐进图像 ${index}`,
  height: 900,
  id: `rendition-media-${index}` as MediaId,
  kind: "image",
  renditions: sizes.map(([width, height]) => ({
    contentType: "image/webp",
    height,
    src: candidateSrc(index, width, height),
    width,
  })),
  src: candidateSrc(index, 1600, 900),
  width: 1600,
});

interface PendingDecode {
  readonly image: HTMLImageElement;
  readonly reject: (reason: unknown) => void;
  readonly resolve: () => void;
}

/** `decode()` of every image waits until the test settles it. */
const mockDecode = (): PendingDecode[] => {
  const decodes: PendingDecode[] = [];
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value(this: HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        decodes.push({ image: this, reject, resolve });
      });
    },
  });
  return decodes;
};

const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "devicePixelRatio",
);
const setPixelRatio = (value: number) =>
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value,
  });

const setStageSize = (stage: HTMLElement, width: number, height: number) =>
  Object.defineProperties(stage, {
    clientHeight: { configurable: true, value: height },
    clientWidth: { configurable: true, value: width },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
      }),
    },
  });

const currentImage = (container: HTMLElement) =>
  container.querySelector<HTMLImageElement>("[data-detail-viewer-image]");

/** The Viewer opens the way Detail opens it: mounted closed, then opened. */
const openProgressive = ({
  index = 0,
  pixelRatio = 2,
  selectedMedia,
}: {
  readonly index?: number;
  readonly pixelRatio?: number;
  readonly selectedMedia: readonly PublicMedia[];
}) => {
  setPixelRatio(pixelRatio);
  const value = renderViewer({ index, open: false, selectedMedia });
  const closedImage = currentImage(value.container);
  const closedSrc = closedImage?.getAttribute("src");
  const closedLoading = closedImage?.getAttribute("loading");
  value.rerender({ index, selectedMedia });
  return { ...value, closedLoading, closedSrc };
};

/** jsdom loads no image: report the shown one as decoded and painted. */
const markLoaded = (image: HTMLImageElement) => {
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 1 },
  });
  act(() => image.dispatchEvent(new Event("load")));
};

/** Two touch pointers `from` px apart, the second moved until `to` px apart. */
const pinch = (stage: HTMLElement, from: number, to: number) =>
  act(() => {
    stage.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: 100,
        clientY: 300,
        pointerId: 21,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: 100 + from,
        clientY: 300,
        pointerId: 22,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 100 + to,
        clientY: 300,
        pointerId: 22,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 100 + to,
        clientY: 300,
        pointerId: 22,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointerup", { clientX: 100, clientY: 300, pointerId: 21 }),
    );
  });

const settleUpgradeTimer = () =>
  act(() => vi.advanceTimersByTime(VIEWER_UPGRADE_SETTLE_MS));

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  if (pixelRatioDescriptor === undefined)
    Reflect.deleteProperty(window, "devicePixelRatio");
  else Object.defineProperty(window, "devicePixelRatio", pixelRatioDescriptor);
});

describe("CatalogViewer geometry", () => {
  it("keeps optional editor controls outside image pan and tap-to-close gestures", () => {
    const crop = vi.fn();
    const value = renderViewer({
      controls: (
        <div data-detail-viewer-control="">
          <button type="button" onClick={crop}>
            裁剪范围
          </button>
        </div>
      ),
    });
    const button = [...value.container.querySelectorAll("button")].find(
      (button) => button.textContent === "裁剪范围",
    )!;
    act(() => {
      button.dispatchEvent(
        pointerEvent("pointerdown", {
          pointerId: 1,
          clientX: 100,
          clientY: 100,
          button: 0,
        }),
      );
      button.dispatchEvent(
        pointerEvent("pointerup", {
          pointerId: 1,
          clientX: 100,
          clientY: 100,
          button: 0,
        }),
      );
      button.click();
    });
    expect(crop).toHaveBeenCalledOnce();
    expect(value.onClose).not.toHaveBeenCalled();
    expect(value.onIndexChange).not.toHaveBeenCalled();
  });
  it("locks a decisive axis and applies the accepted release threshold", () => {
    expect(resolveViewerAxis(6, 2)).toBeNull();
    expect(resolveViewerAxis(20, 4)).toBe("horizontal");
    expect(resolveViewerAxis(4, 20)).toBe("vertical");
    expect(resolveViewerAxis(20, 18)).toBeNull();
    expect(shouldCommitViewerSwipe(47, 0, 200, 0)).toBe(false);
    expect(shouldCommitViewerSwipe(48, 0, 200, 0)).toBe(true);
    expect(shouldCommitViewerSwipe(4, 0, 300, 0.56)).toBe(true);
    expect(shouldCommitViewerSwipe(60, 80, 200, 1)).toBe(false);
  });

  it("contains media, bounds scale, and clamps pan to the zoomed image", () => {
    const fit = viewerFit(400, 800, 600, 600);
    expect(fit).toMatchObject({ height: 600, width: 300 });
    expect(fit.maxScale).toBe(4);
    expect(viewerPanBounds(fit, 2)).toEqual({ x: 0, y: 300 });
    expect(clampViewerTransform(fit, { scale: 9, x: 500, y: -2_000 })).toEqual({
      scale: 4,
      x: 300,
      y: -900,
    });
  });

  it("sets the zoom ceiling from the widest candidate, between 4x and 8x", () => {
    // A 1600 × 900 image fits 400 CSS pixels wide on a 400 × 600 stage.
    expect(viewerFit(1600, 900, 400, 600).maxScale).toBe(4);
    expect(viewerFit(1600, 900, 400, 600, 1600).maxScale).toBe(4);
    expect(viewerFit(1600, 900, 400, 600, 2400).maxScale).toBe(6);
    expect(viewerFit(1600, 900, 400, 600, 3200).maxScale).toBe(8);
    expect(viewerFit(1600, 900, 400, 600, 12_800).maxScale).toBe(8);
    expect(viewerFit(1600, 900, 400, 600, 3200)).toMatchObject({
      height: 225,
      width: 400,
    });
  });
});

describe("CatalogViewer", () => {
  it("mounts one full-screen modal without the obsolete visible close button", () => {
    const { container, viewer } = renderViewer();
    expect(viewer.hasAttribute("open")).toBe(true);
    expect(viewer.getAttribute("aria-modal")).toBe("true");
    expect(
      container.querySelectorAll("[data-detail-viewer-image]"),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("关闭图像查看");
    expect(
      container.querySelectorAll("[data-detail-viewer-index]"),
    ).toHaveLength(1);
  });

  it("shows the full derivative of publishing media and preloads it, falling back to display", () => {
    const full = `/api/community/publishing/media/media-item-${"1".repeat(32)}/full/base`;
    const display = `/api/community/publishing/media/media-item-${"1".repeat(32)}/display/base`;
    const preloaded: string[] = [];
    // The neighbour preload is an off-DOM Image: record what it asks for.
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(
      function (this: HTMLImageElement, value: string) {
        if (!this.isConnected) preloaded.push(value);
      },
    );
    const { container } = renderViewer({
      selectedMedia: [
        { ...media[0]!, fullSrc: full, src: display },
        { ...media[1]!, src: display },
      ] as readonly PublicMedia[],
    });
    const image = container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    expect(image.getAttribute("src")).toBe(full);
    // Carousel and cards keep display: the neighbour without `full` stays on it.
    expect(preloaded).toEqual([display]);
  });

  it("keeps single media free of pager controls and reports a truthful failure", () => {
    const { container } = renderViewer({ selectedMedia: media.slice(0, 1) });
    expect(container.querySelector("[data-detail-viewer-index]")).toBeNull();
    const image = container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    act(() => image.dispatchEvent(new Event("error", { bubbles: true })));
    expect(
      container.querySelector("[data-detail-viewer-media-state='failed']")
        ?.textContent,
    ).toContain("图像无法加载");
    expect(container.querySelector("[data-detail-viewer-image]")).toBeNull();
  });

  it("retains an image error delivered after DOM commit but before passive media effects", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let delivered = false;
    const Parent = () => {
      useLayoutEffect(() => {
        const image = container.querySelector<HTMLImageElement>(
          "[data-detail-viewer-image]",
        )!;
        expect(image.isConnected).toBe(true);
        delivered = true;
        image.dispatchEvent(new Event("error"));
      }, []);
      return (
        <CatalogViewer
          index={0}
          media={media.slice(0, 1)}
          onClose={() => undefined}
          onIndexChange={() => undefined}
          open
          platform="phone"
        />
      );
    };
    act(() => root.render(<Parent />));
    expect(delivered).toBe(true);
    expect(container.querySelector("[data-detail-viewer-image]")).toBeNull();
    expect(
      container.querySelector("[data-detail-viewer-media-state='failed']")
        ?.textContent,
    ).toBe("图像无法加载");
  });

  it("preserves a known failure when a parent rebuilds equivalent media data", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (selectedMedia: readonly PublicMedia[]) =>
      act(() =>
        root.render(
          <CatalogViewer
            index={0}
            media={selectedMedia}
            onClose={() => undefined}
            onIndexChange={() => undefined}
            open
            platform="phone"
          />,
        ),
      );
    render(media.slice(0, 1));
    const image = container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    act(() => image.dispatchEvent(new Event("error")));
    expect(container.querySelector("[data-detail-viewer-image]")).toBeNull();
    render(media.slice(0, 1).map((item) => ({ ...item })));
    expect(container.querySelector("[data-detail-viewer-image]")).toBeNull();
    expect(
      container.querySelector("[data-detail-viewer-media-state='failed']")
        ?.textContent,
    ).toBe("图像无法加载");
  });

  it.each([
    { complete: false, naturalWidth: 0, label: "pending" },
    { complete: true, naturalWidth: 320, label: "healthy" },
  ])(
    "does not invent failure for a $label resource",
    ({ complete, naturalWidth }) => {
      const selectedMedia = media.slice(0, 1);
      const v = renderViewer({ selectedMedia });
      const image = v.container.querySelector<HTMLImageElement>(
        "[data-detail-viewer-image]",
      )!;
      Object.defineProperties(image, {
        complete: { configurable: true, value: complete },
        naturalWidth: { configurable: true, value: naturalWidth },
      });
      v.rerender({ selectedMedia: selectedMedia.map((item) => ({ ...item })) });
      expect(v.container.querySelector("[data-detail-viewer-image]")).toBe(
        image,
      );
      expect(
        v.container.querySelector("[data-detail-viewer-media-state='failed']"),
      ).toBeNull();
    },
  );

  it("does not carry failed identity across changed resources, IDs or removal", () => {
    const original = media[0]!;
    const v = renderViewer({ selectedMedia: [original] });
    const failCurrent = () =>
      act(() =>
        v.container
          .querySelector("[data-detail-viewer-image]")!
          .dispatchEvent(new Event("error")),
      );
    const replacement = {
      ...original,
      src: "https://example.test/replacement.jpg",
    };
    failCurrent();
    expect(v.container.querySelector("[data-detail-viewer-image]")).toBeNull();
    v.rerender({ selectedMedia: [replacement] });
    expect(
      v.container
        .querySelector("[data-detail-viewer-image]")
        ?.getAttribute("src"),
    ).toBe(replacement.src);
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
    failCurrent();
    v.rerender({
      selectedMedia: [{ ...replacement, id: "new-media" as MediaId }],
    });
    expect(
      v.container.querySelector("[data-detail-viewer-image]"),
    ).not.toBeNull();
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
    v.rerender({ selectedMedia: [original] });
    expect(
      v.container.querySelector("[data-detail-viewer-image]"),
    ).not.toBeNull();
    failCurrent();
    v.rerender({ selectedMedia: [] });
    v.rerender({ selectedMedia: [original] });
    expect(
      v.container.querySelector("[data-detail-viewer-image]"),
    ).not.toBeNull();
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
  });

  it("ignores late errors from replaced resource nodes and after unmount", () => {
    const original = media[0]!;
    const v = renderViewer({ selectedMedia: [original] });
    const oldImage = v.container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    const replacement = {
      ...original,
      src: "https://example.test/new-resource.jpg",
    };
    v.rerender({ selectedMedia: [replacement] });
    const currentImage = v.container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    expect(oldImage.isConnected).toBe(false);
    expect(currentImage).not.toBe(oldImage);
    act(() => oldImage.dispatchEvent(new Event("error")));
    expect(v.container.querySelector("[data-detail-viewer-image]")).toBe(
      currentImage,
    );
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
    v.unmount();
    act(() => {
      oldImage.dispatchEvent(new Event("error"));
      currentImage.dispatchEvent(new Event("error"));
    });
    expect(v.container.childElementCount).toBe(0);
    expect(v.onClose).not.toHaveBeenCalled();
    expect(v.onIndexChange).not.toHaveBeenCalled();
  });

  it("keeps peer failures scoped while switching, closing and reopening", () => {
    const v = renderViewer({ index: 1 });
    const activeSlide = () =>
      v.container.querySelector(
        "[data-detail-viewer-track] > [aria-hidden='false']",
      )!;
    const peer =
      v.container.querySelector<HTMLImageElement>('img[alt="查看图像 1"]')!;
    act(() => peer.dispatchEvent(new Event("error")));
    expect(
      activeSlide().querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
    expect(activeSlide().querySelector("img")?.getAttribute("src")).toBe(
      media[1]!.src,
    );
    v.rerender({ index: 0 });
    expect(activeSlide().querySelector("img")).toBeNull();
    expect(activeSlide().textContent).toBe("图像无法加载");
    v.rerender({ index: 0, open: false });
    expect(v.viewer.open).toBe(false);
    v.rerender({ index: 0 });
    expect(v.viewer.open).toBe(true);
    expect(activeSlide().querySelector("img")).toBeNull();
    expect(activeSlide().textContent).toBe("图像无法加载");
    v.rerender({ index: 1 });
    expect(activeSlide().querySelector("img")?.getAttribute("src")).toBe(
      media[1]!.src,
    );
    expect(v.onClose).not.toHaveBeenCalled();
    expect(v.onIndexChange).not.toHaveBeenCalled();
  });

  it("does not apply an old closed resource error after reopening new media", () => {
    const original = media[0]!;
    const v = renderViewer({ selectedMedia: [original] });
    const oldImage = v.container.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    v.rerender({ selectedMedia: [original], open: false });
    v.rerender({
      selectedMedia: [
        { ...original, src: "https://example.test/reopened.jpg" },
      ],
      open: false,
    });
    act(() => oldImage.dispatchEvent(new Event("error")));
    v.rerender({
      selectedMedia: [
        { ...original, src: "https://example.test/reopened.jpg" },
      ],
    });
    expect(
      v.container
        .querySelector("[data-detail-viewer-image]")
        ?.getAttribute("src"),
    ).toBe("https://example.test/reopened.jpg");
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
  });

  it("cancels interrupted paging without changing media or closing", () => {
    const { onClose, onIndexChange, stage } = renderViewer();
    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          clientX: 320,
          clientY: 300,
          pointerId: 1,
          timeStamp: 0,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 80,
          clientY: 300,
          pointerId: 1,
          timeStamp: 20,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointercancel", {
          clientX: 80,
          clientY: 300,
          pointerId: 1,
          timeStamp: 30,
        }),
      );
    });
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      stage
        .querySelector("[data-detail-viewer-track]")
        ?.getAttribute("data-dragging"),
    ).toBeNull();
  });

  it("supports pinch zoom, bounded paging, keyboard, and unmoved tap close", () => {
    const { onClose, onIndexChange, stage, viewer } = renderViewer();
    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          clientX: 150,
          clientY: 300,
          pointerId: 1,
          timeStamp: 0,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          clientX: 250,
          clientY: 300,
          pointerId: 2,
          timeStamp: 1,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointermove", {
          clientX: 350,
          clientY: 300,
          pointerId: 2,
          timeStamp: 10,
        }),
      );
    });
    expect(stage.dataset.viewerScale).toBe("zoomed");
    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 350,
          clientY: 300,
          pointerId: 2,
          timeStamp: 20,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 150,
          clientY: 300,
          pointerId: 1,
          timeStamp: 21,
        }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
      vi.advanceTimersByTime(220);
    });
    expect(onIndexChange).toHaveBeenCalledWith(1);

    act(() => {
      stage.dispatchEvent(
        pointerEvent("pointerdown", {
          clientX: 200,
          clientY: 300,
          pointerId: 3,
          timeStamp: 30,
        }),
      );
      stage.dispatchEvent(
        pointerEvent("pointerup", {
          clientX: 200,
          clientY: 300,
          pointerId: 3,
          timeStamp: 31,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/** One horizontal single-pointer swipe across the stage. */
const swipe = (stage: HTMLElement, fromX: number, toX: number) =>
  act(() => {
    stage.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: fromX,
        clientY: 300,
        pointerId: 7,
        timeStamp: 0,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: (fromX + toX) / 2,
        clientY: 300,
        pointerId: 7,
        timeStamp: 40,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: toX,
        clientY: 300,
        pointerId: 7,
        timeStamp: 80,
      }),
    );
    stage.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: toX,
        clientY: 300,
        pointerId: 7,
        timeStamp: 100,
      }),
    );
  });

const trackOf = (stage: HTMLElement) =>
  stage.querySelector<HTMLElement>("[data-detail-viewer-track]")!;

describe("CatalogViewer direction", () => {
  it("pages left-to-right by default", () => {
    const { onClose, onIndexChange, stage, viewer } = renderViewer();
    expect(viewer.dataset.viewerDirection).toBe("ltr");
    // The first item has no previous peer: a rightward swipe only rubber-bands.
    swipe(stage, 80, 320);
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).not.toHaveBeenCalled();
    swipe(stage, 320, 80);
    expect(trackOf(stage).style.getPropertyValue("--viewer-carousel-x")).toBe(
      "-400px",
    );
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("places the next item on the left and advances on a rightward swipe in rtl", () => {
    const { onClose, onIndexChange, stage, viewer } = renderViewer({
      direction: "rtl",
    });
    expect(viewer.dataset.viewerDirection).toBe("rtl");
    // A leftward swipe at the first item reaches past its start.
    swipe(stage, 320, 80);
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).not.toHaveBeenCalled();
    swipe(stage, 80, 320);
    expect(trackOf(stage).style.getPropertyValue("--viewer-carousel-x")).toBe(
      "400px",
    );
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("orders rtl peers next-current-previous and maps arrow keys", () => {
    const { onIndexChange, stage, viewer } = renderViewer({
      direction: "rtl",
      index: 1,
    });
    const slides = [...trackOf(stage).children];
    expect(slides.map((slide) => slide.querySelector("img")?.alt)).toEqual([
      "查看图像 3",
      "查看图像 2",
      "查看图像 1",
    ]);
    expect(slides.map((slide) => slide.getAttribute("aria-hidden"))).toEqual([
      "true",
      "false",
      "true",
    ]);
    act(() => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      vi.advanceTimersByTime(220);
    });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    act(() => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
      vi.advanceTimersByTime(220);
    });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    // A rightward swipe from the middle advances to the item on the left.
    swipe(stage, 80, 320);
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    swipe(stage, 320, 80);
    act(() => vi.advanceTimersByTime(220));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });
});

describe("CatalogViewer progressive renditions", () => {
  const trackSources = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLImageElement>(
        "[data-detail-viewer-track] img",
      ),
    ].map((image) => image.getAttribute("src"));

  it("opens on the measured fit candidate without fetching while closed", () => {
    const item = renditionMedia(1);
    const v = openProgressive({ selectedMedia: [item] });
    // A hidden Viewer leaves the image source unset and defers it:
    // the carousel picks its own candidate, so a hidden eager anchor would
    // download every image twice.
    expect(v.closedSrc).toBeNull();
    expect(v.closedLoading).toBe("lazy");
    const image = currentImage(v.container)!;
    expect(image.getAttribute("alt")).toBe(item.alt);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1080, 608));
    expect(image.hasAttribute("loading")).toBe(false);
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "1080",
    );

    // Reopened at a pixel ratio of 3: 400 × 3 = 1200 → the 1600 anchor.
    v.rerender({ open: false, selectedMedia: [item] });
    expect(image.getAttribute("src")).toBeNull();
    expect(image.getAttribute("loading")).toBe("lazy");
    setPixelRatio(3);
    v.rerender({ selectedMedia: [item] });
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1600, 900));
    expect(image.hasAttribute("loading")).toBe(false);
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "1600",
    );
    v.unmount();

    // The initial image stays within 4096² pixels: 6400 × 3600 is a zoom level only.
    const bounded = openProgressive({
      pixelRatio: 10,
      selectedMedia: [renditionMedia(2, [...candidateSizes, [6400, 3600]])],
    });
    expect(currentImage(bounded.container)?.getAttribute("src")).toBe(
      candidateSrc(2, 3200, 1800),
    );
    bounded.unmount();

    // Media without candidates keep their source, its loading and no width.
    const legacy = openProgressive({ selectedMedia: media.slice(0, 1) });
    expect(legacy.closedLoading).toBeNull();
    const legacyImage = currentImage(legacy.container)!;
    expect(legacyImage.getAttribute("src")).toBe(media[0]!.src);
    expect(legacyImage.hasAttribute("loading")).toBe(false);
    expect(legacyImage.hasAttribute("data-detail-viewer-rendition-width")).toBe(
      false,
    );
  });

  it("upgrades once the transform rests and swaps only after the decode resolves", async () => {
    const decodes = mockDecode();
    const v = openProgressive({ selectedMedia: [renditionMedia(1)] });
    const image = currentImage(v.container)!;
    markLoaded(image);

    // 2x: 400 × 2 × 2 = 1600 demanded > 1080 × 1.15 → the 1600 candidate.
    pinch(v.stage, 100, 200);
    expect(v.stage.dataset.viewerScale).toBe("zoomed");
    act(() => vi.advanceTimersByTime(VIEWER_UPGRADE_SETTLE_MS - 20));
    // Moving again (a 1% zoom-out, 1584 demanded) restarts the rest period.
    pinch(v.stage, 101, 100);
    act(() => vi.advanceTimersByTime(VIEWER_UPGRADE_SETTLE_MS - 1));
    expect(decodes).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(decodes).toHaveLength(1);
    const [first] = decodes;
    expect(first!.image.isConnected).toBe(false);
    expect(first!.image.getAttribute("src")).toBe(candidateSrc(1, 1600, 900));
    // Loading and decoding happen off-DOM: the shown image is untouched.
    act(() => vi.advanceTimersByTime(1_000));
    expect(decodes).toHaveLength(1);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1080, 608));
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "1080",
    );

    await act(async () => first!.resolve());
    // The same element takes the decoded source: no remount, no blank frame.
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1600, 900));
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "1600",
    );

    // 4x: 3200 demanded > 1600 × 1.15 → the 3200 zoom level.
    pinch(v.stage, 100, 200);
    settleUpgradeTimer();
    expect(decodes).toHaveLength(2);
    expect(decodes[1]!.image.getAttribute("src")).toBe(
      candidateSrc(1, 3200, 1800),
    );
    await act(async () => decodes[1]!.resolve());
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 3200, 1800));
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "3200",
    );
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']"),
    ).toBeNull();
  });

  it("never shrinks the current image on zoom-out, reset or resize", async () => {
    const decodes = mockDecode();
    const v = openProgressive({ selectedMedia: [renditionMedia(1)] });
    const image = currentImage(v.container)!;
    markLoaded(image);
    pinch(v.stage, 100, 400);
    settleUpgradeTimer();
    expect(decodes).toHaveLength(1);
    await act(async () => decodes[0]!.resolve());
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 3200, 1800));

    pinch(v.stage, 400, 100);
    expect(v.stage.dataset.viewerScale).toBe("fit");
    act(() => vi.advanceTimersByTime(1_000));
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 3200, 1800));

    // A smaller stage resets the transform; its fit (480) would be narrower.
    setStageSize(v.stage, 200, 300);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    act(() => vi.advanceTimersByTime(1_000));
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 3200, 1800));
    expect(image.getAttribute("data-detail-viewer-rendition-width")).toBe(
      "3200",
    );
    expect(decodes).toHaveLength(1);
  });

  it("keeps peers and the neighbour preload on their fit candidate and drops an upgrade when its item becomes a peer", async () => {
    const decodes = mockDecode();
    const preloaded: string[] = [];
    // Off-DOM images (preloads and upgrade loads) record what they request.
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(
      function (this: HTMLImageElement, value: string) {
        if (!this.isConnected) preloaded.push(value);
        this.setAttribute("src", value);
      },
    );
    const selectedMedia = [1, 2, 3].map((index) => renditionMedia(index));
    const v = openProgressive({ index: 1, selectedMedia });
    expect(trackSources(v.container)).toEqual([
      candidateSrc(1, 1080, 608),
      candidateSrc(2, 1080, 608),
      candidateSrc(3, 1080, 608),
    ]);
    expect(preloaded).toEqual([
      candidateSrc(1, 1080, 608),
      candidateSrc(3, 1080, 608),
    ]);
    expect(
      v.container.querySelectorAll("[data-detail-viewer-rendition-width]"),
    ).toHaveLength(1);

    markLoaded(currentImage(v.container)!);
    pinch(v.stage, 100, 400);
    settleUpgradeTimer();
    await act(async () => decodes[0]!.resolve());
    expect(trackSources(v.container)).toEqual([
      candidateSrc(1, 1080, 608),
      candidateSrc(2, 3200, 1800),
      candidateSrc(3, 1080, 608),
    ]);
    // Only the current item's upgrade asked for a zoom level.
    expect(preloaded).toEqual([
      candidateSrc(1, 1080, 608),
      candidateSrc(3, 1080, 608),
      candidateSrc(2, 3200, 1800),
    ]);

    pinch(v.stage, 400, 100);
    act(() => {
      v.viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
      vi.advanceTimersByTime(220);
    });
    expect(v.onIndexChange).toHaveBeenCalledWith(2);
    v.rerender({ index: 2, selectedMedia });
    // The paged-away item is a peer at its fit: one upgraded bitmap at most.
    expect(trackSources(v.container)).toEqual([
      candidateSrc(2, 1080, 608),
      candidateSrc(3, 1080, 608),
    ]);
    expect(currentImage(v.container)?.getAttribute("src")).toBe(
      candidateSrc(3, 1080, 608),
    );

    // Back on it, the item opens on its fit candidate again.
    v.rerender({ index: 1, selectedMedia });
    expect(currentImage(v.container)?.getAttribute("src")).toBe(
      candidateSrc(2, 1080, 608),
    );
    expect(
      currentImage(v.container)?.getAttribute(
        "data-detail-viewer-rendition-width",
      ),
    ).toBe("1080");
    expect(decodes).toHaveLength(1);
  });

  it("keeps the current image without a failure when an upgrade fails and never requests that candidate again", async () => {
    const decodes = mockDecode();
    const v = openProgressive({ selectedMedia: [renditionMedia(1)] });
    const image = currentImage(v.container)!;
    markLoaded(image);
    const failedState = () =>
      v.container.querySelector("[data-detail-viewer-media-state='failed']");

    // 4x: 3200 demanded; its decode fails.
    pinch(v.stage, 100, 400);
    settleUpgradeTimer();
    expect(decodes[0]!.image.getAttribute("src")).toBe(
      candidateSrc(1, 3200, 1800),
    );
    await act(async () => decodes[0]!.reject(new Error("decode")));
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1080, 608));
    expect(failedState()).toBeNull();

    // The next wider candidate still serves part of the demand.
    settleUpgradeTimer();
    expect(decodes).toHaveLength(2);
    expect(decodes[1]!.image.getAttribute("src")).toBe(
      candidateSrc(1, 1600, 900),
    );
    await act(async () => decodes[1]!.resolve());
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1600, 900));

    // More zoom never asks for the refused candidate again.
    pinch(v.stage, 100, 400);
    act(() => vi.advanceTimersByTime(1_000));
    expect(decodes).toHaveLength(2);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1600, 900));

    // A decoded upgrade that breaks on screen falls back to the fit candidate.
    act(() => image.dispatchEvent(new Event("error")));
    expect(currentImage(v.container)).toBe(image);
    expect(image.getAttribute("src")).toBe(candidateSrc(1, 1080, 608));
    expect(failedState()).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(decodes).toHaveLength(2);
  });

  it("reports a failure of the initial candidate truthfully", () => {
    const v = openProgressive({ selectedMedia: [renditionMedia(1)] });
    act(() => currentImage(v.container)!.dispatchEvent(new Event("error")));
    expect(currentImage(v.container)).toBeNull();
    expect(
      v.container.querySelector("[data-detail-viewer-media-state='failed']")
        ?.textContent,
    ).toBe("图像无法加载");
  });

  it("zooms up to the widest candidate's detail", () => {
    const zoomedScale = (selected: PublicMedia) => {
      const v = openProgressive({ selectedMedia: [selected] });
      pinch(v.stage, 10, 400);
      const scale = currentImage(v.container)!.style.getPropertyValue(
        "--viewer-scale",
      );
      v.unmount();
      return scale;
    };
    // 3200 / 400 fitted pixels → 8x; without candidates 1600 / 400 → 4x.
    expect(zoomedScale(renditionMedia(1))).toBe("8");
    expect(
      zoomedScale({
        alt: "无候选图像",
        height: 900,
        id: "legacy-media" as MediaId,
        kind: "image",
        src: "https://media.example.invalid/legacy/1600x900.webp",
        width: 1600,
      }),
    ).toBe("4");
  });
});
