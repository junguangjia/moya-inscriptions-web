// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { CROP_MAX_ZOOM, useCropGestures } from "./crop-gestures";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let latest: ReturnType<typeof useCropGestures> | null = null;
const Harness = ({ locked }: { locked: boolean }) => {
  const gestures = useCropGestures({ locked });
  latest = gestures;
  return (
    <div {...gestures.wrapperProps}>
      <button type="button" data-toolbar="">
        参考线
      </button>
      <div data-frame="" {...gestures.frameProps}>
        <div data-area="" tabIndex={0} />
      </div>
    </div>
  );
};
const render = async (locked = false) => {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () => root!.render(<Harness locked={locked} />));
};
const key = async (
  target: string,
  value: string,
  init: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => document.querySelector(target)!.dispatchEvent(event));
  return event;
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  latest = null;
  document.body.replaceChildren();
});

it("zooms with + − on the photo only, within 1–3, and 0 restores", async () => {
  await render();
  await key("[data-area]", "+");
  expect(latest!.zoom).toBeCloseTo(1.1);
  await key("[data-toolbar]", "+");
  expect(latest!.zoom).toBeCloseTo(1.1);
  for (let i = 0; i < 30; i++) await key("[data-area]", "=");
  expect(latest!.zoom).toBe(CROP_MAX_ZOOM);
  await key("[data-area]", "0");
  expect(latest!.zoom).toBe(1);
  expect(latest!.pristine).toBe(true);
});

it("leaves browser shortcuts and modifier arrows to the browser", async () => {
  await render();
  expect(
    (await key("[data-area]", "=", { ctrlKey: true })).defaultPrevented,
  ).toBe(false);
  expect(latest!.zoom).toBe(1);
  expect(
    (await key("[data-area]", "ArrowLeft", { altKey: true })).defaultPrevented,
  ).toBe(false);
});

it("takes only layout re-reports while saving", async () => {
  await render(true);
  expect(latest!.cropperProps.onTouchRequest()).toBe(false);
  expect(
    latest!.cropperProps.onWheelRequest({ ctrlKey: true } as WheelEvent),
  ).toBe(false);
  expect((await key("[data-area]", "ArrowLeft")).defaultPrevented).toBe(true);
  // Arrows elsewhere (the device tabs) keep working.
  expect((await key("[data-toolbar]", "ArrowLeft")).defaultPrevented).toBe(
    false,
  );
  await key("[data-area]", "+");
  expect(latest!.zoom).toBe(1);
  await act(async () => latest!.cropperProps.onZoomChange(1.4));
  expect(latest!.zoom).toBe(1.4);
});

it("gives the photo focus on pointer down and ends interrupted gestures", async () => {
  await render();
  await act(async () =>
    document
      .querySelector("[data-frame]")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  expect(document.activeElement).toBe(document.querySelector("[data-area]"));
  const before = latest!.surface;
  await act(async () => latest!.cropperProps.onInteractionStart());
  await act(async () =>
    document.body.dispatchEvent(new Event("touchstart", { bubbles: true })),
  );
  expect(latest!.surface).toBe(before + 1);
  await act(async () => latest!.cropperProps.onInteractionStart());
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(latest!.surface).toBe(before + 2);
});
