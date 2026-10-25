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
      cropperProps: {
        tabIndex: number;
        "aria-label": string;
        "aria-describedby"?: string;
      };
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
    /** Seed while mounting, as react-easy-crop does with a decoded image. */
    seeding: false,
    /** Every zoom a render of the cropper was given, in order. */
    zooms: [] as number[],
  },
}));
vi.mock("react-easy-crop", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    default: (props: NonNullable<typeof cropper.props>) => {
      cropper.props = props;
      cropper.zooms.push(props.zoom);
      useLayoutEffect(() => {
        cropper.mounts += 1;
        const seed = props.initialCroppedAreaPercentages;
        if (!cropper.seeding || seed === undefined) return;
        props.onCropChange({ x: -6, y: 4 });
        props.onZoomChange(100 / seed.width);
        props.onCropAreaChange(seed);
        // Mounted once: the props of this render are the ones it seeds with.
      }, []);
      return <div data-test-cropper="" tabIndex={0} />;
    },
  };
});

import { CropSurface } from "./crop-surface";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import mediaCss from "../publishing/ui/media/media.module.css?raw";

import type { CropSurfaceProps } from "./crop-surface";
import type { Root } from "react-dom/client";
import type { Area } from "react-easy-crop";

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
  cropper.mounts = 0;
  cropper.seeding = false;
  cropper.zooms = [];
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

it("keeps the seed a new cropper applies as it mounts: the new generation starts centred at zoom 1 and is never reset after its seed", async () => {
  cropper.seeding = true;
  await render({ generation: 1 });
  await act(async () => cropper.props!.onZoomChange(1.8));
  const seed = { x: 20, y: 10, width: 50, height: 50 };
  cropper.zooms = [];
  await render({ seed, generation: 2 });
  // The new cropper's first render is already centred at zoom 1 …
  expect(cropper.zooms[0]).toBe(1);
  expect(cropper.zooms).not.toContain(1.8);
  // … and nothing resets it once it has seeded itself.
  expect(cropper.mounts).toBe(2);
  expect(cropper.props!.zoom).toBe(2);
  expect(cropper.props!.crop).toEqual({ x: -6, y: 4 });
});

it("zooms only as far as it is allowed, the shared 3× by default", async () => {
  await render({ maxZoom: 4.5 });
  expect(cropper.props!.maxZoom).toBe(4.5);
  for (let i = 0; i < 60; i++) await key("=");
  expect(cropper.props!.zoom).toBe(4.5);
  await render({ maxZoom: undefined });
  expect(cropper.props!.maxZoom).toBe(3);
});

it("takes no input while frozen, but stays focusable and takes layout re-reports", async () => {
  const onTouched = vi.fn();
  await render({ frozen: true, onTouched });
  expect(cropper.props!.cropperProps.tabIndex).toBe(0);
  expect(
    document.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
  ).toBe(true);
  // The gesture hint no longer describes it.
  expect(cropper.props!.cropperProps["aria-describedby"]).toBe(undefined);
  expect(cropper.props!.onTouchRequest()).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(false);
  await key("+");
  expect(cropper.props!.zoom).toBe(1);
  expect((await key("ArrowLeft")).defaultPrevented).toBe(true);
  // Safari's own pinch never reaches the library.
  const pinch = new Event("gesturestart", { bubbles: true, cancelable: true });
  await act(async () =>
    document.querySelector("[data-test-cropper]")!.dispatchEvent(pinch),
  );
  expect(pinch.defaultPrevented).toBe(true);
  await act(async () => cropper.props!.onZoomChange(1.4));
  expect(cropper.props!.zoom).toBe(1.4);
  await render({ frozen: false, onTouched });
  expect(cropper.props!.onTouchRequest()).toBe(true);
  expect(
    document.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
  ).toBe(false);
  const hint = cropper.props!.cropperProps["aria-describedby"]!;
  expect(document.getElementById(hint)!.textContent).toContain("双指缩放");
});

it("leaves no refused touch behind a hold: the same cropper remounts, a new generation mounts once", async () => {
  await render({ generation: 1 });
  await act(async () => cropper.props!.onZoomChange(1.5));
  const mounts = cropper.mounts;
  // A hold that refused nothing ends as it began.
  await render({ generation: 1, frozen: true });
  await render({ generation: 1, frozen: false });
  expect(cropper.mounts).toBe(mounts);
  // react-easy-crop marks itself touching before it asks: a refused touch
  // would leave its Safari gestures dead, so the cropper remounts, zoom kept.
  await render({ generation: 1, frozen: true });
  expect(cropper.props!.onTouchRequest()).toBe(false);
  await render({ generation: 1, frozen: false });
  expect(cropper.mounts).toBe(mounts + 1);
  expect(cropper.props!.zoom).toBe(1.5);
  // A hold that ends with a new generation (a corner's reframe) mounts once.
  await render({ generation: 1, frozen: true });
  expect(cropper.props!.onTouchRequest()).toBe(false);
  await render({ generation: 2, frozen: false });
  expect(cropper.mounts).toBe(mounts + 2);
  // Nothing refused is carried into the next hold.
  await render({ generation: 2, frozen: true });
  await render({ generation: 2, frozen: false });
  expect(cropper.mounts).toBe(mounts + 2);
});

it("tells its caller what it shows now", async () => {
  const areaRef: { current: (() => Area | null) | null } = { current: null };
  await render({ areaRef, generation: 1 });
  expect(areaRef.current!()).toBe(null);
  const shown = { x: 10, y: 5, width: 60, height: 70 };
  await act(async () => cropper.props!.onCropAreaChange(shown));
  expect(areaRef.current!()).toEqual(shown);
  // A new generation has shown nothing yet.
  await render({ areaRef, generation: 2 });
  expect(areaRef.current!()).toBe(null);
  await act(async () => root.unmount());
  expect(areaRef.current).toBe(null);
  root = createRoot(container);
});

it("leaves focus on a control of the caller's inside the frame only when asked", async () => {
  const overlay = (
    <button data-test-control="" type="button">
      角
    </button>
  );
  const press = async () => {
    const control = document.querySelector<HTMLButtonElement>(
      "[data-test-control]",
    )!;
    await act(async () => control.focus());
    await act(async () =>
      control.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    return control;
  };
  await render({ overlay, tools: "hintOnly" });
  // By default (the avatar, the banner, the article crop) the photo takes it.
  await press();
  expect(document.activeElement).toBe(
    document.querySelector("[data-test-cropper]"),
  );
  await render({ overlay, tools: "hintOnly", keepControlFocus: true });
  const control = await press();
  expect(document.activeElement).toBe(control);
});
