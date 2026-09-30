// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CropTools } from "./crop-tools";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const render = async (props: {
  coarse: boolean;
  pristine: boolean;
  locked: boolean;
  onReset: () => void;
}) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(<CropTools hintId="hint" {...props} />));
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("offers 还原 beside the gesture hint for the pointer in use", async () => {
  const onReset = vi.fn();
  await render({ coarse: true, pristine: false, locked: false, onReset });
  const reset = document.querySelector("button")!;
  expect(reset.textContent).toBe("还原");
  expect(reset.getAttribute("aria-disabled")).toBe("false");
  await act(async () => reset.click());
  expect(onReset).toHaveBeenCalledOnce();
  expect(document.getElementById("hint")!.textContent).toBe(
    "拖动照片调整位置，双指缩放。",
  );
});

it("keeps 还原 focusable when there is nothing to restore, and blocks it while saving", async () => {
  await render({
    coarse: false,
    pristine: true,
    locked: false,
    onReset: vi.fn(),
  });
  const reset = document.querySelector("button")!;
  expect(reset.getAttribute("aria-disabled")).toBe("true");
  expect(reset.disabled).toBe(false);
  expect(document.getElementById("hint")!.textContent).toContain("Ctrl");
  await act(async () => root!.unmount());
  root = null;
  await render({
    coarse: false,
    pristine: false,
    locked: true,
    onReset: vi.fn(),
  });
  expect(document.querySelector("button")!.disabled).toBe(true);
});
