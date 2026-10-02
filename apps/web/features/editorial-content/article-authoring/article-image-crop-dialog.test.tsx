// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaCrop } from "@moya/contracts";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";

const cropper = vi.hoisted(() => ({
  props: null as null | {
    image: string;
    rotation: number;
    aspect: number;
    maxZoom: number;
    zoom: number;
    cropSize?: { width: number; height: number };
    onInteractionStart: () => void;
    onInteractionEnd: () => void;
    initialCroppedAreaPercentages?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    onCropChange: (position: { x: number; y: number }) => void;
    onZoomChange: (zoom: number) => void;
    onCropAreaChange: (
      area: { x: number; y: number; width: number; height: number },
      pixels: { x: number; y: number; width: number; height: number },
    ) => void;
  },
}));
vi.mock("react-easy-crop", () => ({
  default: (props: NonNullable<typeof cropper.props>) => {
    cropper.props = props;
    return <div data-test-cropper="" />;
  },
}));
import { ArticleImageCropDialog } from "./article-image-crop-dialog";

const media: DetailMediaPresentation = {
  id: "synthetic-image",
  src: "/synthetic/display",
  fullSrc: "/synthetic/full",
  alt: "合成图片",
  width: 4000,
  height: 3000,
};
let root: Root;
let container: HTMLDivElement;
const originals = {
  showModal: Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  ),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
  act: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};
const restore = (
  target: object,
  key: string,
  value: PropertyDescriptor | undefined,
) => {
  if (value) Object.defineProperty(target, key, value);
  else Reflect.deleteProperty(target, key);
};
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cropper.props = null;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 300),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restore(HTMLDialogElement.prototype, "showModal", originals.showModal);
  restore(HTMLDialogElement.prototype, "close", originals.close);
  restore(globalThis, "IS_REACT_ACT_ENVIRONMENT", originals.act);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: RegExp) => {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) =>
    label.test(item.getAttribute("aria-label") ?? item.textContent ?? ""),
  );
  if (!found) throw new Error("missing test control");
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const mount = async (
  crop: MediaCrop | null,
  apply: (next: MediaCrop | null) => boolean,
  cancel = vi.fn(),
) =>
  act(async () =>
    root.render(
      <ArticleImageCropDialog
        media={media}
        crop={crop}
        onApply={apply}
        onCancel={cancel}
      />,
    ),
  );
const report = (x: number, y: number, width: number, height: number) => {
  cropper.props!.onCropAreaChange(
    { x, y, width, height },
    { x: x * 40, y: y * 30, width: width * 40, height: height * 30 },
  );
};

describe("Article image crop intent", () => {
  it("restores a stored region and ignores the cropper's mount report", async () => {
    const crop = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const apply = vi.fn(() => true);
    await mount(crop, apply);
    expect(cropper.props?.rotation).toBe(0);
    expect(cropper.props?.initialCroppedAreaPercentages).toEqual({
      x: 12.5,
      y: 0,
      width: 75,
      height: 100,
    });
    await act(async () => report(12.5, 0, 75, 100));
    await click(button(/^应用裁剪$|^完成$/u));
    expect(apply).toHaveBeenCalledWith(crop);
  });

  it("does not infer a crop from layout before the author moves or zooms", async () => {
    const apply = vi.fn(() => true);
    await mount(null, apply);
    await act(async () => report(10, 10, 80, 80));
    await click(button(/^应用裁剪$|^完成$/u));
    expect(apply).toHaveBeenCalledWith(null);
  });

  it("normalizes the region chosen by dragging or zooming", async () => {
    const apply = vi.fn(() => true);
    await mount(null, apply);
    await act(async () => {
      cropper.props!.onInteractionStart();
      cropper.props!.onZoomChange(2);
      report(25, 25, 50, 50);
    });
    await click(button(/^应用裁剪$|^完成$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });

  it("cancel never persists a changed region", async () => {
    const apply = vi.fn(() => true);
    const cancel = vi.fn();
    await mount(null, apply, cancel);
    await act(async () => {
      cropper.props!.onInteractionStart();
      cropper.props!.onZoomChange(2);
      report(25, 25, 50, 50);
    });
    await click(button(/^取消$/u));
    expect(cancel).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("reset returns to the original frame without changing the source", async () => {
    const apply = vi.fn(() => true);
    await mount({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, apply);
    await click(button(/^恢复完整图片$/u));
    await click(button(/^应用裁剪$|^完成$/u));
    expect(apply).toHaveBeenCalledWith(null);
    expect(media.src).toBe("/synthetic/display");
    expect(media.fullSrc).toBe("/synthetic/full");
  });

  it("does not close or claim success if the owning block rejects the apply", async () => {
    const apply = vi.fn(() => false);
    const cancel = vi.fn();
    await mount(null, apply, cancel);
    await click(button(/^应用裁剪$|^完成$/u));
    expect(apply).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("dialog[open]")).not.toBeNull();
  });
});

const pointer = async (target: Element, name: string, x: number, y: number) => {
  const event = new MouseEvent(name, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  await act(async () => target.dispatchEvent(event));
};

describe("Desktop free rectangle crop", () => {
  beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: false })));

  it("draws directly anywhere on the original with a mouse and persists only on apply", async () => {
    const apply = vi.fn(() => true);
    await mount(null, apply);
    const frame = container.querySelector("[data-article-pointer-crop]")!;
    await pointer(frame, "pointerdown", 100, 75);
    await pointer(frame, "pointermove", 300, 225);
    await pointer(frame, "pointerup", 300, 225);
    expect(apply).not.toHaveBeenCalled();
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
    expect(cropper.props).toBeNull();
  });

  it("clicking without dragging leaves the existing crop intact", async () => {
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const apply = vi.fn(() => true);
    await mount(crop, apply);
    const frame = container.querySelector("[data-article-pointer-crop]")!;
    await pointer(frame, "pointerdown", 50, 50);
    await pointer(frame, "pointerup", 50, 50);
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith(crop);
  });

  it("moves the selection within the original and resizes its corners freely", async () => {
    const apply = vi.fn(() => true);
    await mount({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, apply);
    const frame = container.querySelector("[data-article-pointer-crop]")!;
    const rectangle = container.querySelector("[data-article-crop-rectangle]")!;
    await pointer(rectangle, "pointerdown", 150, 100);
    await pointer(frame, "pointermove", 550, 400);
    await pointer(frame, "pointerup", 550, 400);
    const corner = button(/^调整裁剪左上角$/u);
    await pointer(corner, "pointerdown", 200, 150);
    await pointer(frame, "pointermove", 100, 180);
    await pointer(frame, "pointerup", 100, 180);
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.6,
      width: 0.75,
      height: 0.4,
    });
  });

  it("rolls back a cancelled or interrupted pointer without persisting", async () => {
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const apply = vi.fn(() => true);
    await mount(crop, apply);
    const frame = container.querySelector("[data-article-pointer-crop]")!;
    await pointer(frame, "pointerdown", 0, 0);
    await pointer(frame, "pointermove", 200, 200);
    await pointer(frame, "pointercancel", 200, 200);
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith(crop);
  });

  it("provides keyboard corner adjustments and browser modifier shortcuts stay untouched", async () => {
    const apply = vi.fn(() => true);
    await mount({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, apply);
    const corner = button(/^调整裁剪右下角$/u);
    const shortcut = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => corner.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(false);
    await act(async () =>
      corner.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () =>
      corner.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.25,
      width: 0.49,
      height: 0.45,
    });
  });
});

describe("Mobile flexible crop reuse", () => {
  it("changes the viewport window ratio with corner handles, then uses the same normalized crop contract", async () => {
    const apply = vi.fn(() => true);
    await mount(null, apply);
    expect(cropper.props?.cropSize).toEqual({ width: 400, height: 300 });
    const frame = container.querySelector("[data-article-touch-crop]")!;
    await pointer(button(/^调整裁剪右下角$/u), "pointerdown", 400, 300);
    await pointer(frame, "pointermove", 270, 200);
    expect(cropper.props?.cropSize?.width).toBeCloseTo(140);
    expect(cropper.props?.cropSize?.height).toBeCloseTo(100);
    await act(async () => report(32.5, 33.3333, 35, 33.3333));
    await pointer(frame, "pointerup", 270, 200);
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.325,
      y: 0.333333,
      width: 0.35,
      height: 0.333333,
    });
  });

  it("preserves small seeded regions and ignores unrelated later layout reports", async () => {
    const crop = { x: 0.5, y: 0.5, width: 0.05, height: 0.1 };
    const apply = vi.fn(() => true);
    await mount(crop, apply);
    expect(cropper.props?.maxZoom).toBe(20);
    await act(async () => report(10, 10, 80, 80));
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith(crop);
  });

  it("retains a seeded zoom above 3 through the reused gesture hook", async () => {
    const apply = vi.fn(() => true);
    await mount({ x: 0.5, y: 0.5, width: 0.05, height: 0.1 }, apply);
    await act(async () => cropper.props!.onZoomChange(10));
    expect(cropper.props?.zoom).toBe(10);
    expect(cropper.props?.maxZoom).toBe(20);
    // Library reseeding and the corresponding area report remain inert.
    await act(async () => report(50, 50, 5, 10));
    expect(apply).not.toHaveBeenCalled();
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.5,
      y: 0.5,
      width: 0.05,
      height: 0.1,
    });
  });

  it("keeps viewport measurement inert after a completed user gesture", async () => {
    const apply = vi.fn(() => true);
    await mount(null, apply);
    await act(async () => {
      cropper.props!.onInteractionStart();
      cropper.props!.onZoomChange(2);
      report(25, 25, 50, 50);
      cropper.props!.onInteractionEnd();
      report(10, 10, 80, 80);
    });
    await click(button(/^应用裁剪$/u));
    expect(apply).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });
});
