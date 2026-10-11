// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { cropper } = vi.hoisted(() => ({
  cropper: {
    props: null as null | {
      aspect: number;
      rotation: number;
      image: string;
      crop: { x: number; y: number };
      zoom: number;
      minZoom: number;
      maxZoom: number;
      cropShape: string;
      objectFit: string;
      showGrid: boolean;
      initialCroppedAreaPercentages?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      cropperProps: { tabIndex: number; "aria-label": string };
      onCropAreaChange: (area: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => void;
      onCropChange: (position: { x: number; y: number }) => void;
      onZoomChange: (zoom: number) => void;
      onTouchRequest: () => boolean;
      onWheelRequest: (event: { ctrlKey: boolean }) => boolean;
      onInteractionStart: () => void;
    },
    mounts: 0,
  },
}));
vi.mock("react-easy-crop", () => ({
  default: (props: NonNullable<typeof cropper.props>) => {
    cropper.props = props;
    return <div data-test-cropper="" tabIndex={0} />;
  },
}));

import { CropSurface } from "./crop-surface";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import mediaCss from "../publishing/ui/media/media.module.css?raw";

import type { CropSurfaceProps } from "./crop-surface";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = async (props: Partial<CropSurfaceProps> = {}) =>
  act(async () =>
    root.render(
      <CropSurface
        aspect={1}
        generation={0}
        image="blob:photo"
        label="拖动图片调整裁剪位置"
        onArea={() => undefined}
        {...props}
      />,
    ),
  );

const key = async (value: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () =>
    document.querySelector("[data-test-cropper]")!.dispatchEvent(event),
  );
  return event;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cropper.props = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

it("zooms by gesture, Ctrl + wheel or keys between 1 and 3, with no zoom slider", async () => {
  const onTouched = vi.fn();
  await render({ onTouched });
  expect(document.querySelector('input[type="range"]')).toBe(null);
  expect(cropper.props!.minZoom).toBe(1);
  expect(cropper.props!.maxZoom).toBe(3);
  expect(cropper.props!.onTouchRequest()).toBe(true);
  expect(cropper.props!.onWheelRequest({ ctrlKey: false })).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(true);
  expect(cropper.props!.cropperProps["aria-label"]).toBe(
    "拖动图片调整裁剪位置",
  );
  expect(document.body.textContent).toContain("双指缩放");
  // The 还原 pill is the dialog's job by default here.
  expect(document.querySelector("button")!.textContent).toBe("还原");

  await key("+");
  expect(cropper.props!.zoom).toBeCloseTo(1.1);
  expect(onTouched).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 30; i++) await key("=");
  expect(cropper.props!.zoom).toBe(3);
  await key("0");
  expect(cropper.props!.zoom).toBe(1);
  expect(cropper.props!.crop).toEqual({ x: 0, y: 0 });
});

it("tells a mount re-report from the author's own move", async () => {
  const onTouched = vi.fn();
  const onArea = vi.fn();
  await render({ onTouched, onArea });
  await act(async () => {
    cropper.props!.onCropChange({ x: 0, y: 0 });
    cropper.props!.onCropAreaChange({ x: 10, y: 10, width: 80, height: 80 });
  });
  expect(onArea).toHaveBeenCalledWith({ x: 10, y: 10, width: 80, height: 80 });
  expect(onTouched).not.toHaveBeenCalled();
  await act(async () => cropper.props!.onCropChange({ x: 12, y: 0 }));
  expect(onTouched).toHaveBeenCalledTimes(1);
  await act(async () => cropper.props!.onZoomChange(1.6));
  expect(onTouched).toHaveBeenCalledTimes(2);
  expect(cropper.props!.zoom).toBe(1.6);
});

it("seeds the cropper once per generation and keeps the gesture state across a surface remount", async () => {
  const seed = { x: 10, y: 0, width: 80, height: 100 };
  await render({ seed, generation: 1 });
  expect(cropper.props!.initialCroppedAreaPercentages).toEqual(seed);
  await act(async () => cropper.props!.onZoomChange(1.5));
  // An interrupted touch ends the gesture by remounting the cropper.
  await act(async () => cropper.props!.onInteractionStart());
  await act(async () =>
    document.body.dispatchEvent(new Event("touchstart", { bubbles: true })),
  );
  expect(cropper.props!.initialCroppedAreaPercentages).toBeUndefined();
  expect(cropper.props!.zoom).toBe(1.5);
  // A new generation (preset, turn or 还原) seeds again from the new start.
  const next = { x: 0, y: 12.5, width: 100, height: 75 };
  await render({ seed: next, generation: 2 });
  expect(cropper.props!.initialCroppedAreaPercentages).toEqual(next);
  expect(cropper.props!.zoom).toBe(1);
  await render({ seed: undefined, generation: 3 });
  expect(cropper.props!.initialCroppedAreaPercentages).toBeUndefined();
});

it("starts a new source of the same picture where the author left the crop", async () => {
  const seed = { x: 10, y: 0, width: 80, height: 100 };
  await render({ seed, generation: 1 });
  const moved = { x: 20, y: 5, width: 60, height: 75 };
  await act(async () => {
    cropper.props!.onZoomChange(1.3);
    cropper.props!.onCropAreaChange(moved);
  });
  // The account derivative replaces the local bytes of the same picture.
  await render({ seed, generation: 1, image: "blob:derivative" });
  expect(cropper.props!.image).toBe("blob:derivative");
  expect(cropper.props!.initialCroppedAreaPercentages).toEqual(moved);
  expect(cropper.props!.zoom).toBe(1.3);
  // Nothing reported in this generation yet: its own seed still applies.
  await render({ seed, generation: 2 });
  await render({ seed, generation: 2, image: "blob:later" });
  expect(cropper.props!.initialCroppedAreaPercentages).toEqual(seed);
});

it("renders the shape, fit, grid and overlay it is given, and hides 还原 on request", async () => {
  await render({
    shape: "round",
    objectFit: "cover",
    showGrid: true,
    tools: "hintOnly",
    overlay: <div data-test-overlay="" />,
    rotation: 90,
    aspect: 4 / 5,
  });
  expect(cropper.props!.cropShape).toBe("round");
  expect(cropper.props!.objectFit).toBe("cover");
  expect(cropper.props!.showGrid).toBe(true);
  expect(cropper.props!.rotation).toBe(90);
  expect(cropper.props!.aspect).toBeCloseTo(0.8);
  expect(
    document.querySelector("[data-media-crop] [data-test-overlay]"),
  ).not.toBe(null);
  expect(document.querySelector("button")).toBe(null);
});

it("blocks input while locked but still takes layout re-reports", async () => {
  await render({ locked: true });
  expect(cropper.props!.cropperProps.tabIndex).toBe(-1);
  expect(cropper.props!.onTouchRequest()).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(false);
  expect(
    document.querySelector("[data-media-crop]")!.getAttribute("data-saving"),
  ).toBe("true");
  await key("+");
  expect(cropper.props!.zoom).toBe(1);
  await act(async () => cropper.props!.onZoomChange(1.4));
  expect(cropper.props!.zoom).toBe(1.4);
});

it("keeps the viewport gesture-only in CSS and has no slider rule left", () => {
  expect(mediaCss).not.toMatch(/^\.zoom\b/m);
  expect(mediaCss).toMatch(/\.cropViewport\s*\{[^}]*touch-action:\s*none/);
});
