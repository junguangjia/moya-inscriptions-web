// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Area } from "react-easy-crop";

interface CropperProps {
  zoom: number;
  crop: { x: number; y: number };
  keyboardStep: number;
  aspect: number;
  cropperProps: { tabIndex: number; "aria-label"?: string };
  onCropAreaChange: (area: Area, pixels: Area) => void;
  onZoomChange: (zoom: number) => void;
  onCropChange: (crop: { x: number; y: number }) => void;
  onWheelRequest: (event: { ctrlKey: boolean }) => boolean;
  onTouchRequest: () => boolean;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}
const cropper = vi.hoisted(() => ({
  props: null as CropperProps | null,
  mounts: 0,
  keys: 0,
}));
vi.mock("react-easy-crop", async () => {
  const { useEffect } = await import("react");
  return {
    default: (props: CropperProps) => {
      cropper.props = props;
      useEffect(() => {
        cropper.mounts += 1;
      }, []);
      // Stands in for the library's crop area and its arrow-key handler.
      return (
        <div
          data-mock-cropper=""
          tabIndex={props.cropperProps.tabIndex}
          onKeyDown={() => {
            cropper.keys += 1;
          }}
        />
      );
    },
  };
});
import { ProfileCoverStage } from "./profile-cover-stage";
import {
  COVER_ASPECT,
  COVER_SAFE_RECT,
  REFERENCE_HEADERS,
  coverWindow,
} from "./profile-cover";
import type { HeaderBox } from "./profile-cover";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const headers: Record<"phone" | "desktop", HeaderBox> = {
  phone: { ...REFERENCE_HEADERS.phone, height: 544, panelTop: 333.6 },
  desktop: REFERENCE_HEADERS.desktop,
};
let root: Root | null = null;
const onAreaChange = vi.fn();
const view = (locked = false, sourceWidth = 4032, autoFocus = false) => (
  <ProfileCoverStage
    image={{ url: "blob:display" }}
    sourceWidth={sourceWidth}
    headers={headers}
    thisDevice="phone"
    identity={{ name: "作者", avatarSrc: null }}
    locked={locked}
    autoFocus={autoFocus}
    onAreaChange={onAreaChange}
  />
);
const render = async (
  locked = false,
  sourceWidth?: number,
  autoFocus = false,
) => {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () => root!.render(view(locked, sourceWidth, autoFocus)));
};
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) =>
      item.textContent === name || item.getAttribute("aria-label") === name,
  )!;
const guidesSwitch = () =>
  document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const percent = (value: number) => `${value * 100}%`;
const key = async (value: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () =>
    document.querySelector("[data-mock-cropper]")!.dispatchEvent(event),
  );
  return event;
};

beforeEach(() => {
  cropper.props = null;
  cropper.mounts = 0;
  cropper.keys = 0;
  onAreaChange.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("frames the 4:3 master with the measured phone window, the desktop reference and the safe area", async () => {
  await render();
  expect(cropper.props!.aspect).toBe(COVER_ASPECT);
  expect(cropper.props!.keyboardStep).toBe(8);
  const window = document.querySelector<HTMLElement>(
    '[data-cover-window="phone"]',
  )!;
  const expected = coverWindow(390 / 544);
  expect(window.style.left).toBe(percent(expected.x));
  expect(window.style.width).toBe(percent(expected.width));
  expect(window.style.height).toBe("100%");
  const reference = document.querySelector<HTMLElement>(
    '[data-cover-reference="desktop"]',
  )!;
  // A full-height desktop cover (960×800) shows a centred strip too.
  const desktop = coverWindow(960 / 800);
  expect(reference.style.width).toBe(percent(desktop.width));
  expect(reference.style.left).toBe(percent(desktop.x));
  expect(
    document.querySelector<HTMLElement>("[data-cover-safe]")!.style.width,
  ).toBe(percent(COVER_SAFE_RECT.width));
  expect(document.body.textContent).toContain("作者");
});

it("switches the previewed device and can hide the guides", async () => {
  await render();
  await act(async () => button("电脑").click());
  expect(
    document.querySelector('[data-cover-window="desktop"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('[data-cover-reference="phone"]'),
  ).not.toBeNull();
  // The 参考线 switch describes the guides (no legend).
  expect(document.body.textContent).toContain("亮处为电脑显示范围");
  await act(async () => guidesSwitch().click());
  expect(document.querySelector("[data-cover-window]")).toBeNull();
  expect(guidesSwitch().getAttribute("aria-checked")).toBe("false");
});

it("zooms only with a pinch or Ctrl wheel so ordinary scrolling keeps scrolling", async () => {
  await render();
  expect(cropper.props!.onWheelRequest({ ctrlKey: false })).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(true);
  expect(cropper.props!.onTouchRequest()).toBe(true);
});

it("zooms by pinch or keys without a zoom bar, clamped to 1–3, with a reset", async () => {
  await render();
  // Owner decision: no zoom slider or −/+ bar; two-finger gestures zoom.
  expect(document.querySelector('input[type="range"]')).toBeNull();
  expect(button("放大")).toBeUndefined();
  expect(button("还原").getAttribute("aria-disabled")).toBe("true");
  // A pinch arrives from react-easy-crop as a zoom change.
  await act(async () => cropper.props!.onZoomChange(1.5));
  expect(cropper.props!.zoom).toBe(1.5);
  expect(button("还原").getAttribute("aria-disabled")).toBe("false");
  // Keyboard fallback for pointer-only desktops.
  await key("+");
  await key("=");
  expect(cropper.props!.zoom).toBeCloseTo(1.7);
  await key("-");
  expect(cropper.props!.zoom).toBeCloseTo(1.6);
  for (let i = 0; i < 30; i++) await key("+");
  expect(cropper.props!.zoom).toBe(3);
  expect(document.body.textContent).toContain("已放大到最大");
  await act(async () => cropper.props!.onCropChange({ x: 12, y: -4 }));
  await act(async () => button("还原").click());
  expect(cropper.props!.zoom).toBe(1);
  expect(cropper.props!.crop).toEqual({ x: 0, y: 0 });
  await act(async () => cropper.props!.onZoomChange(2));
  await key("0");
  expect(cropper.props!.zoom).toBe(1);
});

it("leaves browser shortcuts with modifiers to the browser", async () => {
  await render();
  await act(async () => cropper.props!.onZoomChange(2));
  await act(async () => cropper.props!.onCropChange({ x: 12, y: -4 }));
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }])
    for (const value of ["=", "+", "-", "0"]) {
      const event = await key(value, init);
      expect(event.defaultPrevented).toBe(false);
    }
  expect(cropper.props!.zoom).toBe(2);
  expect(cropper.props!.crop).toEqual({ x: 12, y: -4 });
});

it("leaves ⌘/Alt/Ctrl + arrows to the browser and keeps shortcuts on the photo", async () => {
  await render();
  // The keys are announced in the crop area's label.
  expect(cropper.props!.cropperProps["aria-label"]).toContain("+ − 键缩放");
  const back = await key("ArrowLeft", { altKey: true });
  expect(back.defaultPrevented).toBe(false);
  await key("ArrowLeft", { metaKey: true });
  expect(cropper.keys).toBe(0);
  await key("ArrowLeft");
  expect(cropper.keys).toBe(1);
  // "0" on a toolbar button is not a reset.
  await act(async () => cropper.props!.onZoomChange(2));
  await act(async () =>
    guidesSwitch().dispatchEvent(
      new KeyboardEvent("keydown", { key: "0", bubbles: true }),
    ),
  );
  expect(cropper.props!.zoom).toBe(2);
});

it("ends a pinch whose second finger lands outside the frame", async () => {
  await render();
  await act(async () => cropper.props!.onInteractionStart());
  await act(async () =>
    document.body.dispatchEvent(new Event("touchstart", { bubbles: true })),
  );
  expect(cropper.mounts).toBe(2);
  // Touches inside the frame are the gesture itself.
  await act(async () => cropper.props!.onInteractionStart());
  await act(async () =>
    document
      .querySelector("[data-mock-cropper]")!
      .dispatchEvent(new Event("touchstart", { bubbles: true })),
  );
  expect(cropper.mounts).toBe(2);
});

it("ends an interrupted gesture by remounting the cropper, keeping crop and zoom", async () => {
  await render();
  await act(async () => cropper.props!.onZoomChange(2));
  await act(async () => cropper.props!.onCropChange({ x: 30, y: 10 }));
  expect(cropper.mounts).toBe(1);
  // Not interacting: a cancel is ignored.
  await act(async () =>
    document
      .querySelector("[data-cover-stage]")!
      .dispatchEvent(new Event("touchcancel", { bubbles: true })),
  );
  expect(cropper.mounts).toBe(1);
  await act(async () => cropper.props!.onInteractionStart());
  await act(async () =>
    document
      .querySelector("[data-cover-stage]")!
      .dispatchEvent(new Event("touchcancel", { bubbles: true })),
  );
  expect(cropper.mounts).toBe(2);
  expect(cropper.props!.zoom).toBe(2);
  expect(cropper.props!.crop).toEqual({ x: 30, y: 10 });
  await act(async () => cropper.props!.onInteractionStart());
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(cropper.mounts).toBe(3);
  await act(async () => cropper.props!.onInteractionEnd());
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(cropper.mounts).toBe(3);
});

it("locks every user input while saving but keeps layout re-reports", async () => {
  await render(true);
  expect(cropper.props!.onTouchRequest()).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(false);
  expect(cropper.props!.cropperProps.tabIndex).toBe(-1);
  expect(button("还原").disabled).toBe(true);
  // A focused crop area's arrow keys are swallowed while saving.
  expect((await key("ArrowLeft")).defaultPrevented).toBe(true);
  expect((await key("+")).defaultPrevented).toBe(false);
  expect(cropper.props!.zoom).toBe(1);
  // Rotation or resize re-layout still reaches the stage and the editor.
  await act(async () => cropper.props!.onCropChange({ x: 3, y: 1 }));
  expect(cropper.props!.crop).toEqual({ x: 3, y: 1 });
  await act(async () =>
    cropper.props!.onCropAreaChange(
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  );
  expect(onAreaChange).toHaveBeenCalledOnce();
});

it("reports the chosen area and warns when it has too few source pixels", async () => {
  await render(false, 1600);
  await act(async () =>
    cropper.props!.onCropAreaChange(
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: 800, height: 600 },
    ),
  );
  expect(onAreaChange).toHaveBeenCalledWith({
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  });
  expect(document.body.textContent).toContain("照片分辨率较低");
});

it("focuses the crop area once the photo is laid out", async () => {
  await render(false, 4032, true);
  const area = document.querySelector("[data-mock-cropper]");
  expect(document.activeElement).not.toBe(area);
  await act(async () =>
    cropper.props!.onCropAreaChange(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  );
  expect(document.activeElement).toBe(area);
});
