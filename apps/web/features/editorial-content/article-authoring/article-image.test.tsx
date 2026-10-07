// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ArticleImage } from "./article-image";
import {
  articleImageCropProps,
  getArticleImageCrop,
} from "./article-image-layout";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";

const media: DetailMediaPresentation = {
  id: "synthetic",
  src: "/synthetic/display",
  fullSrc: "/synthetic/full",
  alt: "合成碑面",
  width: 400,
  height: 300,
};
const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const click = (element: HTMLElement) => act(async () => element.click());

describe("Article image source and body crop presentation", () => {
  it("keeps independent regions of one source and roundtrips full-frame defaults", async () => {
    await act(async () =>
      root.render(
        <>
          <ArticleImage media={media} active={false} crop={crop} />
          <ArticleImage media={media} active={false} />
        </>,
      ),
    );
    const [cropped, full] = container.querySelectorAll("img");
    expect(cropped?.style.width).toBe("200%");
    expect(cropped?.style.left).toBe("-50%");
    expect(cropped?.style.height).toBe("200%");
    expect(cropped?.style.top).toBe("-50%");
    expect(full?.style.width).toBe("100%");
    expect(full?.style.left).toBe("0%");
    expect(cropped?.getAttribute("src")).toBe(media.src);
    expect(cropped?.alt).toBe(media.alt);
    expect(media.src).toBe("/synthetic/display");
    const props = {
      refId: "source",
      caption: "",
      alt: "",
      ...articleImageCropProps(crop),
    };
    expect(getArticleImageCrop(props)).toEqual(crop);
    expect(
      getArticleImageCrop({ ...props, ...articleImageCropProps(null) }),
    ).toBeNull();
    expect(
      getArticleImageCrop({ refId: "source", caption: "", alt: "" }),
    ).toBeNull();
  });
  it("directly enters author crop on image click or keyboard while the reader keeps its original viewer", async () => {
    const onCrop = vi.fn();
    await act(async () =>
      root.render(
        <ArticleImage media={media} active crop={crop} onCrop={onCrop} />,
      ),
    );
    await click(container.querySelector<HTMLImageElement>("img")!);
    expect(onCrop).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
    expect(container.querySelector('[aria-label="放大查看原图"]')).toBeNull();
    await act(async () =>
      container
        .querySelector('[aria-label="裁剪图片"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    );
    expect(onCrop).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<ArticleImage media={media} active />));
    await click(container.querySelector<HTMLImageElement>("img")!);
    expect(
      container
        .querySelector("[data-detail-viewer-image]")
        ?.getAttribute("src"),
    ).toBe(media.fullSrc);
    const { fullSrc: omitted, ...display } = media;
    expect(omitted).toBe(media.fullSrc);
    await act(async () => root.render(<ArticleImage media={display} active />));
    await click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="放大查看原图"]',
      )!,
    );
    expect(
      container
        .querySelector("[data-detail-viewer-image]")
        ?.getAttribute("src"),
    ).toBe(media.src);
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "裁剪范围",
      ),
    ).toBe(false);
    await act(async () =>
      root.render(<ArticleImage media={display} active={false} />),
    );
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
    await act(async () => root.render(<ArticleImage media={display} active />));
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
  });
  it("keeps Live motion unloaded until played and applies the same visible still geometry", async () => {
    await act(async () =>
      root.render(
        <ArticleImage
          media={{
            ...media,
            live: { motionSrc: "/synthetic/motion", hasAudio: false },
          }}
          active
          crop={crop}
        />,
      ),
    );
    const video = container.querySelector("[data-live-video]");
    expect(video).not.toBeNull();
    expect(video?.hasAttribute("src")).toBe(false);
    expect(container.querySelector("img")?.style.width).toBe("200%");
    const live = container.querySelector<HTMLButtonElement>(
      "[data-live-photo-play]",
    );
    expect(live).not.toBeNull();
  });
});

/*
 * unified-media-pipeline-v1 (CW13): every candidate shows the same framing,
 * so candidates up to the anchor leave the crop geometry exactly as it is;
 * `sizes` accounts for the crop, and the box (exact crop aspect) carries the
 * asset colour.
 */
describe("Article image candidates", () => {
  const candidate = (width: number, height: number) => ({
    src: `/synthetic/${width}`,
    width,
    height,
  });
  const responsive: DetailMediaPresentation = {
    ...media,
    src: "/synthetic/400",
    placeholderColor: "#6b5d50",
    renditions: [candidate(200, 150), candidate(400, 300), candidate(800, 600)],
  };

  it("keeps the crop geometry and offers candidates up to the anchor", async () => {
    await act(async () =>
      root.render(
        <>
          <ArticleImage media={responsive} active={false} crop={crop} />
          <ArticleImage media={responsive} active={false} />
        </>,
      ),
    );
    const [cropped, full] = container.querySelectorAll("img");
    expect(cropped?.style.width).toBe("200%");
    expect(cropped?.style.left).toBe("-50%");
    expect(cropped?.style.height).toBe("200%");
    expect(cropped?.style.top).toBe("-50%");
    expect(cropped?.style.objectFit).toBe("fill");
    expect(full?.style.width).toBe("100%");
    expect(cropped?.getAttribute("src")).toBe("/synthetic/400");
    expect(cropped?.getAttribute("srcset")).toBe(
      "/synthetic/200 200w, /synthetic/400 400w",
    );
    // A crop of half the width draws the image twice as wide as its box.
    expect(cropped?.getAttribute("sizes")).toBe(
      "(min-width: 760px) 1384px, calc(200vw - 80px)",
    );
    expect(full?.getAttribute("sizes")).toBe(
      "(min-width: 760px) 692px, calc(100vw - 40px)",
    );
    const boxes = [...container.querySelectorAll("img")].map(
      (image) => image.parentElement as HTMLElement,
    );
    expect(boxes[0]?.style.aspectRatio).toBe("1.3333333333333333 / 1");
    for (const box of boxes) {
      expect(box.className).toContain("bodyImage");
      expect(box.style.backgroundColor).toBe("rgb(107, 93, 80)");
    }
    // The image paints it as well, over any figure rule's own background
    // (news managed covers and image blocks); geometry is unchanged.
    for (const image of [cropped, full])
      expect(image?.style.backgroundColor).toBe("rgb(107, 93, 80)");
    expect(cropped?.style.objectFit).toBe("fill");
  });

  it("narrows sizes to a resized block's display share", async () => {
    await act(async () =>
      root.render(
        <ArticleImage media={responsive} active={false} share={0.5} />,
      ),
    );
    expect(container.querySelector("img")?.getAttribute("sizes")).toBe(
      "(min-width: 760px) 346px, calc(50vw - 20px)",
    );
  });

  it("keeps a legacy image without candidates or colour", async () => {
    await act(async () =>
      root.render(<ArticleImage media={media} active={false} crop={crop} />),
    );
    const image = container.querySelector("img")!;
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(image.hasAttribute("sizes")).toBe(false);
    expect(image.parentElement?.style.backgroundColor).toBe("");
    expect(image.style.backgroundColor).toBe("");
  });
});
