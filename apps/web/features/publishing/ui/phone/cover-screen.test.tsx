// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { crop, frame } = vi.hoisted(() => ({
  crop: {
    props: null as null | {
      aspect: number;
      rotation: number;
      image: string;
      initialCroppedAreaPercentages?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      onCropAreaChange: (area: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => void;
      onCropChange: (position: { x: number; y: number }) => void;
      onZoomChange: (zoom: number) => void;
      onCropSizeChange?: (size: { width: number; height: number }) => void;
      crop: { x: number; y: number };
      zoom: number;
      maxZoom: number;
    },
    /** Seed while mounting, as react-easy-crop does with a decoded image. */
    seeding: false,
  },
  frame: {
    render: null as null | ((src: string, edit: unknown) => Promise<unknown>),
  },
}));
vi.mock("react-easy-crop", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    default: (props: NonNullable<typeof crop.props>) => {
      crop.props = props;
      useLayoutEffect(() => {
        const seed = props.initialCroppedAreaPercentages;
        if (!crop.seeding || seed === undefined) return;
        props.onCropChange({ x: -5, y: 0 });
        props.onZoomChange(100 / seed.width);
        props.onCropAreaChange(seed);
        // Mounted once: the props of this render are the ones it seeds with.
      }, []);
      return <div data-test-cropper="" />;
    },
  };
});
vi.mock("../media/edited-frame", () => ({
  renderEditedFrame: (src: string, edit: unknown) => frame.render!(src, edit),
}));

import { CoverScreen } from "./cover-screen";
import { cancelPhoneLayer } from "./phone-flow";

import type { CoverScreenProps } from "./cover-screen";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );

let container: HTMLDivElement;
let root: Root;

const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const ratio = (label: string) => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-edit-ratio] [role="radio"]',
    ),
  ].find((element) => element.textContent === label);
  if (!found) throw new Error(`No ratio ${label}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const host = () =>
  document.querySelector<HTMLDialogElement>("dialog[data-phone-cover]");
const discardSheet = () =>
  document.querySelector<HTMLDialogElement>(
    'dialog[data-phone-sheet="cover-discard"]',
  );

const render = async (overrides: Partial<CoverScreenProps> = {}) => {
  const props: CoverScreenProps = {
    itemKey: "a",
    edit: { rotation: 0, crop: null },
    src: "/display/a",
    blob: null,
    coverCrop: null,
    derivativeExpected: true,
    initialDraft: null,
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  await act(async () => root.render(<CoverScreen {...props} />));
  // The edited frame is drawn asynchronously.
  await act(async () => undefined);
  return props;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  crop.props = null;
  crop.seeding = false;
  frame.render = vi.fn(async () => ({
    url: "blob:edited-frame",
    size: { width: 300, height: 400 },
    release: vi.fn(),
  }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CoverScreen", () => {
  it("draws 编辑's idiom: the bar with 完成, the full-bleed stage with 还原, the note and the cover's shapes", async () => {
    await render();
    const dialog = host()!;
    expect(dialog.open).toBe(true);
    expect(names(dialog)).toEqual(["host"]);
    expect(dialog.getAttribute("aria-label")).toBe("封面构图");
    const screen = dialog.querySelector("[data-editor-screen]")!;
    expect(screen.getAttribute("data-editor-screen")).toBe("cover");
    const heading = screen.querySelector("h2")!;
    expect(heading.textContent).toBe("封面构图");
    // The layer opens on its heading, as a screen change does.
    expect(document.activeElement).toBe(heading);
    expect(button("取消封面构图").closest("[data-editor-bar]")).not.toBe(null);
    expect(button("完成").hasAttribute("data-cover-done")).toBe(true);
    expect(names(button("完成"))).toEqual(["textButton", "next"]);

    const stage = dialog.querySelector<HTMLElement>("[data-cover-stage]")!;
    expect(names(stage)).toEqual(["stage"]);
    expect(crop.props!.image).toBe("blob:edited-frame");
    expect(crop.props!.rotation).toBe(0);
    expect(names(button("还原"))).toEqual(["fab"]);
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
    expect(dialog.querySelector("[data-cover-band]")!.textContent).toContain(
      "封面构图只影响作品卡片的显示，不改变图片本身。",
    );
    const group = dialog.querySelector("[data-edit-ratio]")!;
    expect(group.getAttribute("aria-label")).toBe("封面比例");
    expect(group.getAttribute("data-count")).toBe("4");
    expect(
      [...group.querySelectorAll('[role="radio"]')].map(
        (entry) => entry.textContent,
      ),
      // 编辑's order (原始比例 · 4:5 · 3:4 · 1:1 · 4:3) without 4:5.
    ).toEqual(["原始比例", "3:4", "1:1", "4:3"]);
    // No radio pills of the desktop dialog.
    expect(dialog.querySelector('input[type="radio"]')).toBe(null);
  });

  it("keeps a chosen composition with 完成, and 还原 starts again from the whole frame", async () => {
    const props = await render();
    await click(ratio("1:1"));
    expect(ratio("1:1").getAttribute("aria-checked")).toBe("true");
    expect(crop.props!.aspect).toBe(1);
    await act(async () =>
      crop.props!.onCropAreaChange({ x: 0, y: 20, width: 100, height: 75 }),
    );
    expect(button("还原").getAttribute("aria-disabled")).toBe("false");
    await click(button("完成"));
    expect(props.onApply).toHaveBeenCalledWith({
      x: 0,
      y: 0.2,
      width: 1,
      height: 0.75,
    });
    expect(props.onClose).toHaveBeenCalledOnce();

    await click(button("还原"));
    expect(ratio("原始比例").getAttribute("aria-checked")).toBe("true");
    await click(button("完成"));
    expect(props.onApply).toHaveBeenLastCalledWith(null);
  });

  it("leaves at once when nothing changed, and asks first when something did", async () => {
    const props = await render();
    await click(button("取消封面构图"));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(discardSheet()).toBe(null);

    // 3:4 on this 3:4 frame is the whole frame: still nothing changed.
    await click(ratio("3:4"));
    await click(button("取消封面构图"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    await click(ratio("1:1"));
    await click(button("取消封面构图"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    const sheet = discardSheet()!;
    expect(sheet.querySelector("h2")!.textContent).toBe("放弃封面构图的更改？");
    expect(document.activeElement).toBe(button("继续调整"));
    await click(button("继续调整"));
    expect(discardSheet()).toBe(null);
    expect(props.onClose).toHaveBeenCalledTimes(2);

    // Escape asks the same way.
    await act(async () => {
      host()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await click(button("放弃更改"));
    expect(props.onClose).toHaveBeenCalledTimes(3);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("answers the browser's Back as ‹: leaves when nothing changed, asks and stays when something did", async () => {
    const props = await render();
    // Back: the editor gives the topmost phone layer its close request.
    const back = () => act(async () => void cancelPhoneLayer(document.body));
    await back();
    expect(props.onClose).toHaveBeenCalledOnce();

    await click(ratio("1:1"));
    await back();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(host()!.open).toBe(true);
    expect(discardSheet()!.querySelector("h2")!.textContent).toBe(
      "放弃封面构图的更改？",
    );
    // Back again closes the question, keeping the composition.
    await back();
    expect(discardSheet()).toBe(null);
    expect(ratio("1:1").getAttribute("aria-checked")).toBe("true");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("explains when the frame cannot be shown, its ratios off", async () => {
    frame.render = vi.fn(async () => {
      throw new Error("decode failed");
    });
    await render({ derivativeExpected: false });
    expect(host()!.querySelector("[data-cover-fallback]")!.textContent).toBe(
      "这台设备无法显示这张图片，暂时无法调整封面构图。",
    );
    expect(ratio("1:1").disabled).toBe(true);
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps its own stage: the whole stage for the frame, decorative corners, no handles, the shared 3× (#341)", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-cover-stage") ? 390 : 0;
      },
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-cover-stage") ? 600 : 0;
      },
    );
    await render();
    const stage = host()!.querySelector<HTMLElement>("[data-cover-stage]")!;
    // A 3:4 frame of the whole 390 × 600 stage, as before the 编辑 field.
    expect(stage.style.getPropertyValue("--crop-box-width")).toBe("390px");
    expect(stage.style.getPropertyValue("--crop-box-height")).toBe("600px");
    await act(async () =>
      crop.props!.onCropSizeChange!({ width: 390, height: 520 }),
    );
    const frame = host()!.querySelector("[data-cover-frame]")!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(host()!.querySelector("[data-crop-handle]")).toBe(null);
    expect(
      host()!
        .querySelector("[data-edit-ratio]")!
        .querySelectorAll('[role="radio"]'),
    ).toHaveLength(4);
    expect(crop.props!.maxZoom).toBe(3);
  });

  it("keeps a stored composition's seed once the cropper applies it, and starts a new ratio centred", async () => {
    crop.seeding = true;
    const composition = { x: 0, y: 0.25, width: 1, height: 0.5 };
    await render({ coverCrop: composition });
    expect(crop.props!.initialCroppedAreaPercentages).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50,
    });
    expect(crop.props!.zoom).toBe(1);
    expect(crop.props!.crop).toEqual({ x: -5, y: 0 });
    await click(ratio("1:1"));
    expect(crop.props!.zoom).toBe(1);
    expect(crop.props!.crop).toEqual({ x: 0, y: 0 });
  });
});
