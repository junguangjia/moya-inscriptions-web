// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AddSheet,
  CaptureInput,
  ORIGINAL_QUALITY_STORAGE_KEY,
  PickInput,
  QualitySwitch,
  readOriginalQuality,
  storeOriginalQuality,
} from "./add-tiles";

import type { AddSheetProps } from "./add-tiles";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const sheet = () =>
  document.querySelector<HTMLDialogElement>('dialog[data-phone-sheet="add"]');
const choice = (name: "photos" | "camera" | "cancel") =>
  document.querySelector<HTMLButtonElement>(`[data-add-option="${name}"]`);

/** A pointer that is (or is not) coarse: 拍照 is drawn only on phones. */
const coarsePointer = () =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia,
  );

const renderSheet = async (overrides: Partial<AddSheetProps> = {}) => {
  const props: AddSheetProps = {
    count: 3,
    maxItems: 50,
    original: false,
    onOriginalChange: vi.fn(),
    onPhotos: vi.fn(),
    onCamera: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  await act(async () => root.render(<AddSheet {...props} />));
  return props;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddSheet (编辑's +)", () => {
  it("offers 原图画质, 选择照片 (focused first) and 取消 under the count", async () => {
    const props = await renderSheet();
    const dialog = sheet()!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("h2")!.textContent).toBe("添加照片");
    expect(dialog.querySelector("small")!.textContent).toBe(
      "已选 3 项 · 最多 50 项",
    );
    expect(
      dialog.querySelector('[data-editor-switch="original"] [role="switch"]'),
    ).not.toBe(null);
    expect(
      [...dialog.querySelectorAll("[data-add-option]")].map((entry) =>
        entry.getAttribute("data-add-option"),
      ),
    ).toEqual(["photos", "cancel"]);
    expect(choice("photos")!.textContent).toBe("选择照片");
    expect(document.activeElement).toBe(choice("photos"));

    await act(async () => choice("cancel")!.click());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onPhotos).not.toHaveBeenCalled();
  });

  it("changes 原图画质 through the screen, one change per tap", async () => {
    const props = await renderSheet();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'dialog [data-editor-switch="original"] [role="switch"]',
        )!
        .click(),
    );
    expect(props.onOriginalChange).toHaveBeenCalledExactlyOnceWith(true);
    // The sheet stays: the pick comes next.
    expect(props.onClose).not.toHaveBeenCalled();
    await renderSheet({
      original: true,
      onOriginalChange: props.onOriginalChange,
    });
    expect(
      document
        .querySelector('dialog [role="switch"]')!
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("closes its dialog before 选择照片 opens the album, then lets the screen drop it", async () => {
    const order: string[] = [];
    const props = await renderSheet({
      onPhotos: vi.fn(() =>
        order.push(
          // The strip's input outside the sheet is not inert at this point.
          `photos:${document.querySelector("dialog[open]") === null}`,
        ),
      ),
      onClose: vi.fn(() => order.push("close")),
    });
    await act(async () => choice("photos")!.click());
    expect(order).toEqual(["photos:true", "close"]);
    expect(props.onCamera).not.toHaveBeenCalled();
  });

  it("offers 拍照 on a phone, opened the same way", async () => {
    coarsePointer();
    const order: string[] = [];
    await renderSheet({
      onCamera: vi.fn(() =>
        order.push(`camera:${document.querySelector("dialog[open]") === null}`),
      ),
      onClose: vi.fn(() => order.push("close")),
    });
    expect(
      [...sheet()!.querySelectorAll("[data-add-option]")].map((entry) =>
        entry.getAttribute("data-add-option"),
      ),
    ).toEqual(["photos", "camera", "cancel"]);
    await act(async () => choice("camera")!.click());
    expect(order).toEqual(["camera:true", "close"]);
  });

  it("lets the picks wait when nothing can be added", async () => {
    coarsePointer();
    await renderSheet({ disabled: true });
    expect(choice("photos")!.disabled).toBe(true);
    expect(choice("camera")!.disabled).toBe(true);
    expect(choice("cancel")!.disabled).toBe(false);
  });
});

describe("the add inputs", () => {
  it("are hidden file inputs: several photos, or one from the rear camera", async () => {
    const pick = createRef<HTMLInputElement>();
    const capture = createRef<HTMLInputElement>();
    const onFiles = vi.fn();
    await act(async () =>
      root.render(
        <>
          <PickInput disabled={false} inputRef={pick} onFiles={onFiles} />
          <CaptureInput disabled inputRef={capture} onFiles={onFiles} />
        </>,
      ),
    );
    expect(pick.current!.hidden).toBe(true);
    expect(pick.current!.multiple).toBe(true);
    expect(pick.current!.accept).toContain("image/heic");
    expect(capture.current!.getAttribute("capture")).toBe("environment");
    expect(capture.current!.multiple).toBe(false);
    expect(capture.current!.disabled).toBe(true);

    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    Object.defineProperty(pick.current!, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () =>
      pick.current!.dispatchEvent(new Event("change", { bubbles: true })),
    );
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });
});

describe("原图画质", () => {
  it("toggles from anywhere on its block and says its effect", async () => {
    const onToggle = vi.fn();
    await act(async () =>
      root.render(<QualitySwitch onToggle={onToggle} original={false} />),
    );
    const control =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(
      document.getElementById(control.getAttribute("aria-describedby")!)!
        .textContent,
    ).toBe("下一批选择的图片先优化为标准画质再上传");
    await act(async () => control.click());
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () =>
      document
        .getElementById(control.getAttribute("aria-labelledby")!)!
        .click(),
    );
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("is remembered for the device, and survives blocked storage", () => {
    expect(readOriginalQuality()).toBe(null);
    storeOriginalQuality(true);
    expect(window.localStorage.getItem(ORIGINAL_QUALITY_STORAGE_KEY)).toBe(
      "original",
    );
    expect(readOriginalQuality()).toBe(true);
    storeOriginalQuality(false);
    expect(readOriginalQuality()).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => storeOriginalQuality(true)).not.toThrow();
    expect(readOriginalQuality()).toBe(null);
  });
});
