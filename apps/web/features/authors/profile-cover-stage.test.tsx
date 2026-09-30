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
  cropperProps: { tabIndex: number };
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
}));
vi.mock("react-easy-crop", async () => {
  const { useEffect } = await import("react");
  return {
    default: (props: CropperProps) => {
      cropper.props = props;
      useEffect(() => {
        cropper.mounts += 1;
      }, []);
      return <div data-mock-cropper="" />;
    },
  };
});
import { ProfileCoverStage } from "./profile-cover-stage";
import { COVER_ASPECT, COVER_SAFE_RECT, coverWindow } from "./profile-cover";
import type { HeaderBox } from "./profile-cover";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const headers: Record<"phone" | "desktop", HeaderBox> = {
  phone: { width: 390, height: 544, identityTop: 330 },
  desktop: { width: 960, height: 556, identityTop: 308 },
};
let root: Root | null = null;
const onAreaChange = vi.fn();
const view = (locked = false, sourceWidth = 4032) => (
  <ProfileCoverStage
    image={{ url: "blob:display" }}
    sourceWidth={sourceWidth}
    headers={headers}
    thisDevice="phone"
    identity={{ name: "作者", avatarSrc: null }}
    locked={locked}
    onAreaChange={onAreaChange}
  />
);
const render = async (locked = false, sourceWidth?: number) => {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () => root!.render(view(locked, sourceWidth)));
};
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) =>
      item.textContent === name || item.getAttribute("aria-label") === name,
  )!;
const slider = () =>
  document.querySelector<HTMLInputElement>('input[type="range"]')!;
const percent = (value: number) => `${value * 100}%`;
const key = async (value: string) =>
  act(async () =>
    document
      .querySelector("[data-cover-stage]")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
  );

beforeEach(() => {
  cropper.props = null;
  cropper.mounts = 0;
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
  expect(reference.style.height).toBe(percent(coverWindow(960 / 556).height));
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
  expect(document.body.textContent).toContain("电脑上看不到");
  await act(async () => button("参考线").click());
  expect(document.querySelector("[data-cover-window]")).toBeNull();
  expect(button("参考线").getAttribute("aria-pressed")).toBe("false");
});

it("zooms only with a pinch or Ctrl wheel so ordinary scrolling keeps scrolling", async () => {
  await render();
  expect(cropper.props!.onWheelRequest({ ctrlKey: false })).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(true);
  expect(cropper.props!.onTouchRequest()).toBe(true);
});

it("offers buttons and keys for zoom, clamped to 1–3, and a reset", async () => {
  await render();
  expect(button("缩小").disabled).toBe(true);
  await act(async () => button("放大").click());
  expect(Number(slider().value)).toBeCloseTo(1.1);
  expect(slider().getAttribute("aria-valuetext")).toBe("110%");
  await key("+");
  await key("=");
  expect(Number(slider().value)).toBeCloseTo(1.3);
  await key("-");
  expect(Number(slider().value)).toBeCloseTo(1.2);
  for (let i = 0; i < 30; i++) await key("+");
  expect(Number(slider().value)).toBe(3);
  expect(button("放大").disabled).toBe(true);
  expect(document.body.textContent).toContain("已放大到最大");
  await act(async () => cropper.props!.onCropChange({ x: 12, y: -4 }));
  await key("0");
  expect(Number(slider().value)).toBe(1);
  expect(cropper.props!.crop).toEqual({ x: 0, y: 0 });
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

it("locks every input while saving", async () => {
  await render(true);
  expect(cropper.props!.onTouchRequest()).toBe(false);
  expect(cropper.props!.onWheelRequest({ ctrlKey: true })).toBe(false);
  expect(cropper.props!.cropperProps.tabIndex).toBe(-1);
  expect(button("放大").disabled).toBe(true);
  expect(slider().disabled).toBe(true);
  await act(async () =>
    cropper.props!.onCropAreaChange(
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  );
  expect(onAreaChange).not.toHaveBeenCalled();
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
