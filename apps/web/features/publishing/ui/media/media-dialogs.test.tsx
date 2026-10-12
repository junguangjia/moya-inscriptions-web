// @vitest-environment jsdom
import { act, useState } from "react";
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
      onCropAreaChange: (
        area: { x: number; y: number; width: number; height: number },
        pixels: { x: number; y: number; width: number; height: number },
      ) => void;
      onCropChange: (position: { x: number; y: number }) => void;
      onZoomChange?: (zoom: number) => void;
      zoom: number;
    },
  },
  frame: {
    release: null as null | (() => void),
    render: null as null | ((src: string, edit: unknown) => Promise<unknown>),
  },
}));
vi.mock("react-easy-crop", () => ({
  default: (props: NonNullable<typeof crop.props>) => {
    crop.props = props;
    return <div data-test-cropper="" />;
  },
}));
vi.mock("./edited-frame", () => ({
  renderEditedFrame: (src: string, edit: unknown) => frame.render!(src, edit),
}));

import { createPreviewCache } from "./bounded-preview";
import { CoverCropDialog } from "./cover-crop-dialog";
import { CropWorkspace, startCrop } from "./crop-workspace";
import { FeedWindowOverlay } from "./feed-window-overlay";
import { MediaEditDialog } from "./media-edit-dialog";
import { cropFromPercentages, percentagesFromCrop } from "./media-geometry";
import { useBoundedPreview } from "./media-preview";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import mediaCss from "./media.module.css?raw";

import type { PreviewEnvironment } from "./bounded-preview";
import type { CropSession } from "./crop-workspace";
import type { BoundedPreviewState } from "./media-preview";
import type { CoverDraft, EditDraft } from "./media-ui-store";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const buttonByText = (text: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent) === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};

const radio = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((element) => element.textContent === label)!
    .querySelector("input")!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  crop.props = null;
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
  window.history.replaceState({}, "", "/#editor");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MediaEditDialog", () => {
  it("still rotates without a preview and notes that Live motion follows", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={2}
          kind="live"
          onApply={onApply}
          onClose={onClose}
          src={null}
        />,
      ),
    );
    expect(document.body.textContent).toContain(
      "实况照片的动态影像会使用相同的旋转和裁剪。",
    );
    expect(document.body.textContent).toContain("仍可旋转");
    expect(radio("1:1").closest("fieldset")!.disabled).toBe(true);
    await click(buttonByText("向左旋转 90°"));
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({ rotation: 270, crop: null });
    expect(onClose).toHaveBeenCalled();
  });

  it("reopens a stored crop at its preset and keeps it unless changed", async () => {
    const onApply = vi.fn();
    const stored = { x: 0.125, y: 0, width: 0.75, height: 1 };
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: stored }}
          itemKey="item"
          itemNumber={1}
          kind="static"
          knownSize={{ width: 4000, height: 3000 }}
          onApply={onApply}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    expect(radio("1:1").checked).toBe(true);
    expect(crop.props?.aspect).toBe(1);
    expect(crop.props?.initialCroppedAreaPercentages).toEqual({
      x: 12.5,
      y: 0,
      width: 75,
      height: 100,
    });
    expect(document.body.textContent).not.toContain("实况照片的动态影像");
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({ rotation: 0, crop: stored });

    // Choosing 16:9 without dragging stores the centered crop of that shape.
    await click(radio("16:9"));
    expect(crop.props?.aspect).toBeCloseTo(16 / 9);
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenLastCalledWith({
      rotation: 0,
      crop: { x: 0, y: 0.125, width: 1, height: 0.75 },
    });
  });
});

describe("MediaEditDialog zoom input (#244)", () => {
  it("offers no zoom slider; the crop surface zooms by gesture and keys", async () => {
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={1}
          kind="static"
          knownSize={{ width: 4032, height: 3024 }}
          onApply={() => undefined}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    expect(document.querySelector('input[type="range"]')).toBe(null);
    expect(
      [...document.querySelectorAll("label")].some(
        (label) => label.textContent?.trim() === "缩放",
      ),
    ).toBe(false);
    expect(document.body.textContent).toContain("双指缩放");
    expect((crop.props as { maxZoom?: number }).maxZoom).toBe(3);
    // One 还原: the dialog's, which also resets the rotation and preset.
    expect(
      [...document.querySelectorAll("button")].filter(
        (button) => button.textContent === "还原",
      ),
    ).toHaveLength(1);
  });
});

describe("MediaEditDialog feed window (#244)", () => {
  const renderWithStage = async (
    feedStage: { first: boolean; stageRatio: number | null } | null,
    edit: { rotation: 0 | 90; crop: null } = { rotation: 0, crop: null },
  ) =>
    act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={edit}
          feedStage={feedStage}
          itemKey="item"
          itemNumber={feedStage?.first === false ? 2 : 1}
          kind="static"
          knownSize={{ width: 4000, height: 3000 }}
          onApply={() => undefined}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );

  it("draws the feed window for the first item and says what the stage shows", async () => {
    // A turned 4:3 is a 3:4 frame: the 4:5 stage cuts 3% above and below.
    await renderWithStage(
      { first: true, stageRatio: null },
      { rotation: 90, crop: null },
    );
    const overlay = () =>
      document.querySelector<HTMLElement>("[data-feed-window]")!;
    expect(overlay().getAttribute("data-feed-fit")).toBe("cover");
    expect(overlay().style.getPropertyValue("--feed-band")).toBe("3.125%");
    expect(overlay().hidden).toBe(true);
    expect(document.body.textContent).toContain("上下各裁去 3%");
    expect(document.body.textContent).toContain("由第 1 张决定");
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-editor-switch="feed-window"] [role="switch"]',
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The cropper lays the crop box out: the overlay takes its size.
    await act(async () =>
      (
        crop.props as unknown as {
          onCropSizeChange: (size: { width: number; height: number }) => void;
        }
      ).onCropSizeChange({ width: 240, height: 320 }),
    );
    expect(overlay().hidden).toBe(false);
    expect(overlay().style.width).toBe("240px");
    expect(overlay().querySelectorAll("[data-edge]")).toHaveLength(2);
    await click(radio("4:5"));
    expect(overlay().getAttribute("data-feed-fit")).toBe("fill");
    expect(document.body.textContent).toContain("动态满幅显示");
    await click(radio("4:3"));
    expect(overlay().getAttribute("data-feed-fit")).toBe("contain");
    expect(document.body.textContent).toContain("整张显示，上下留白");
    await click(toggle);
    expect(document.querySelector("[data-feed-window]")).toBe(null);
  });

  it("uses the first item's stage for later items and nothing without a stage", async () => {
    await renderWithStage({ first: false, stageRatio: 1.25 });
    // A 4:3 frame on a 4:5 stage is shown whole.
    expect(
      document
        .querySelector("[data-feed-window]")!
        .getAttribute("data-feed-fit"),
    ).toBe("contain");
    expect(document.body.textContent).toContain("（画幅由第 1 张决定）");
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWithStage({ first: false, stageRatio: null });
    expect(document.querySelector("[data-feed-window]")).toBe(null);
    expect(document.querySelector('[data-editor-switch="feed-window"]')).toBe(
      null,
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWithStage(null);
    expect(document.querySelector("[data-feed-window]")).toBe(null);
  });
});

describe("FeedWindowOverlay (#244)", () => {
  it("dims the cut bands less on a subtle surface", async () => {
    const cover = { fit: "cover", height: 0.8, stageRatio: 1.25 } as const;
    const size = { width: 240, height: 320 };
    const overlay = () =>
      document.querySelector<HTMLElement>("[data-feed-window]")!;
    await act(async () =>
      root.render(<FeedWindowOverlay size={size} window={cover} />),
    );
    expect(overlay().hasAttribute("data-subtle")).toBe(false);
    await act(async () =>
      root.render(<FeedWindowOverlay size={size} subtle window={cover} />),
    );
    expect(overlay().getAttribute("data-subtle")).toBe("true");
    expect(overlay().querySelectorAll("[data-edge]")).toHaveLength(2);
    expect(mediaCss).toMatch(
      /\.feedBand \{[^}]*var\(--yoyi-color-ink-black\) 45%/,
    );
    expect(mediaCss).toMatch(
      /\.feedOverlay\[data-subtle="true"\] \.feedBand \{[^}]*var\(--yoyi-color-ink-black\) 25%/,
    );
  });
});

describe("MediaEditDialog crop intent (D2)", () => {
  /** What react-easy-crop reports by itself for a turned 4:3 image on a wide layout. */
  const mountReport = async () => {
    await act(async () => {
      crop.props!.onCropChange({ x: 0, y: 0 });
      crop.props!.onCropAreaChange(
        { x: 9.375, y: 9.375, width: 81.25, height: 81.25 },
        { x: 375, y: 281, width: 3250, height: 2437 },
      );
    });
  };

  const renderDialog = async (onApply: (edit: unknown) => void) =>
    act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={3}
          kind="static"
          knownSize={{ width: 4032, height: 3024 }}
          onApply={onApply}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );

  it("stores a rotate-only edit without a crop, whatever the cropper reports on its own", async () => {
    const onApply = vi.fn();
    await renderDialog(onApply);
    await mountReport();
    await click(buttonByText("向右旋转 90°"));
    expect(radio("原始比例").checked).toBe(true);
    await mountReport();
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({ rotation: 90, crop: null });
  });

  it("stores the crop once the author moves or zooms it, and a full frame stays null", async () => {
    const onApply = vi.fn();
    await renderDialog(onApply);
    await click(buttonByText("向右旋转 90°"));
    await act(async () => {
      crop.props!.onZoomChange!(2);
      crop.props!.onCropAreaChange(
        { x: 25, y: 25, width: 50, height: 50 },
        { x: 756, y: 1008, width: 1512, height: 2016 },
      );
    });
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenLastCalledWith({
      rotation: 90,
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });

    // Dragged back to the full frame within tolerance: no crop is stored.
    await act(async () => {
      crop.props!.onCropChange({ x: 3, y: 0 });
      crop.props!.onCropAreaChange(
        { x: 0.1, y: 0, width: 99.9, height: 100 },
        { x: 3, y: 0, width: 3021, height: 4032 },
      );
    });
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenLastCalledWith({ rotation: 90, crop: null });
  });
});

describe("CropWorkspace across items (#244)", () => {
  const stored = {
    a: { x: 0.1, y: 0, width: 0.8, height: 1 },
    b: { x: 0, y: 0.25, width: 1, height: 0.5 },
  };
  let sessions: Record<"a" | "b", CropSession>;
  /** A stage that stays mounted and shows one item at a time. */
  const Stage = ({
    itemKey,
    image,
  }: {
    readonly itemKey: "a" | "b";
    readonly image: string;
  }) => {
    const [all, setAll] = useState(() => ({
      a: startCrop("custom", stored.a),
      b: startCrop("custom", stored.b),
    }));
    sessions = all;
    return (
      <CropWorkspace
        image={image}
        itemKey={itemKey}
        label="拖动图片调整裁剪位置"
        onSession={(change) =>
          setAll((current) => ({
            ...current,
            [itemKey]:
              typeof change === "function" ? change(current[itemKey]) : change,
          }))
        }
        ratio={1}
        rotation={0}
        session={all[itemKey]}
      />
    );
  };
  const cropper = () => container.querySelector("[data-test-cropper]");

  it("starts another item on a surface of its own, from that item's crop", async () => {
    await act(async () => root.render(<Stage image="blob:a" itemKey="a" />));
    const first = cropper();
    expect(crop.props!.initialCroppedAreaPercentages).toEqual(
      percentagesFromCrop(stored.a),
    );
    await act(async () => crop.props!.onZoomChange!(1.5));
    expect(sessions.a.touched).toBe(true);

    await act(async () => root.render(<Stage image="blob:b" itemKey="b" />));
    expect(cropper()).not.toBe(first);
    expect(crop.props!.initialCroppedAreaPercentages).toEqual(
      percentagesFromCrop(stored.b),
    );
    expect(crop.props!.zoom).toBe(1);
    // Neither resumed from the other item nor touched by the switch.
    expect(sessions.b).toEqual(startCrop("custom", stored.b));
    expect(sessions.a.touched).toBe(true);
  });

  it("keeps the same item's crop when its source changes", async () => {
    await act(async () => root.render(<Stage image="blob:a" itemKey="a" />));
    const first = cropper();
    const moved = { x: 20, y: 10, width: 60, height: 60 };
    await act(async () => {
      crop.props!.onZoomChange!(1.4);
      crop.props!.onCropAreaChange(moved, moved);
    });
    await act(async () =>
      root.render(
        <Stage
          image="/api/community/publishing/media/example/display/base"
          itemKey="a"
        />,
      ),
    );
    expect(cropper()).toBe(first);
    expect(crop.props!.zoom).toBe(1.4);
    expect(crop.props!.initialCroppedAreaPercentages).toEqual(moved);
    expect(sessions.a.seed).toEqual(
      percentagesFromCrop(cropFromPercentages(moved)!),
    );
  });
});

describe("CoverCropDialog", () => {
  it("keeps the full frame as the composition when the author leaves 原始比例 alone", async () => {
    frame.render = vi.fn(async () => ({
      url: "blob:edited-frame",
      size: { width: 300, height: 400 },
      release: vi.fn(),
    }));
    const onApply = vi.fn();
    await act(async () =>
      root.render(
        <CoverCropDialog
          blob={null}
          coverCrop={null}
          edit={{ rotation: 90, crop: null }}
          itemKey="item"
          itemNumber={1}
          onApply={onApply}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    await act(async () => undefined);
    await act(async () => {
      crop.props!.onCropChange({ x: 0, y: 0 });
      crop.props!.onCropAreaChange(
        { x: 9.375, y: 9.375, width: 81.25, height: 81.25 },
        { x: 28, y: 37, width: 244, height: 325 },
      );
    });
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("composes the card cover inside the edited frame and releases the preview", async () => {
    const release = vi.fn();
    frame.render = vi.fn(async () => ({
      url: "blob:edited-frame",
      size: { width: 300, height: 400 },
      release,
    }));
    const onApply = vi.fn();
    const edit = { rotation: 90 as const, crop: null };
    await act(async () =>
      root.render(
        <CoverCropDialog
          blob={null}
          coverCrop={null}
          edit={edit}
          itemKey="item"
          itemNumber={3}
          onApply={onApply}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    await act(async () => undefined);
    expect(frame.render).toHaveBeenCalledWith(
      "/api/community/publishing/media/example/display/base",
      edit,
    );
    expect(crop.props?.image).toBe("blob:edited-frame");
    expect(crop.props?.rotation).toBe(0);
    expect(document.body.textContent).toContain("封面构图只影响作品卡片的显示");
    await click(radio("1:1"));
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 0, y: 20, width: 100, height: 75 },
        { x: 0, y: 80, width: 300, height: 300 },
      ),
    );
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({
      x: 0,
      y: 0.2,
      width: 1,
      height: 0.75,
    });
    await click(buttonByText("还原"));
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenLastCalledWith(null);

    expect(release).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(release).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("explains when the frame cannot be shown", async () => {
    frame.render = vi.fn(async () => {
      throw new Error("decode failed");
    });
    await act(async () =>
      root.render(
        <CoverCropDialog
          blob={null}
          coverCrop={null}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={1}
          onApply={() => undefined}
          onClose={() => undefined}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    await act(async () => undefined);
    expect(document.body.textContent).toContain("暂时无法显示这张图片");
  });
});

describe("unfinished dialog work", () => {
  it("continues a crop after the edit dialog remounts, and reports its work", async () => {
    const drafts: EditDraft[] = [];
    const props = {
      blob: null,
      edit: { rotation: 0 as const, crop: null },
      itemKey: "item",
      itemNumber: 1,
      kind: "static" as const,
      knownSize: { width: 4000, height: 3000 },
      onApply: vi.fn(),
      onClose: () => undefined,
      onDraftChange: (draft: EditDraft) => drafts.push(draft),
      src: "/api/community/publishing/media/example/display/base",
    };
    await act(async () => root.render(<MediaEditDialog {...props} />));
    await click(buttonByText("向右旋转 90°"));
    await click(radio("1:1"));
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 0, y: 12.5, width: 100, height: 75 },
        { x: 0, y: 1, width: 3, height: 3 },
      ),
    );
    const saved = drafts.at(-1)!;
    expect(saved.rotation).toBe(90);

    // The layout swap: a new dialog with the saved work.
    await act(async () => root.unmount());
    root = createRoot(container);
    Object.assign(crop, { props: null });
    await act(async () =>
      root.render(<MediaEditDialog {...props} initialDraft={saved} />),
    );
    expect(crop.props?.rotation).toBe(90);
    expect(radio("1:1").checked).toBe(true);
    expect(crop.props?.initialCroppedAreaPercentages).toEqual({
      x: 0,
      y: 12.5,
      width: 100,
      height: 75,
    });
    await click(buttonByText("完成"));
    expect(props.onApply).toHaveBeenCalledWith({
      rotation: 90,
      crop: { x: 0, y: 0.125, width: 1, height: 0.75 },
    });
  });

  it("drops saved work made for a different edit", async () => {
    const stale: EditDraft = {
      basis: { rotation: 180, crop: null },
      rotation: 270,
      stored: null,
    };
    const onApply = vi.fn();
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: null }}
          initialDraft={stale}
          itemKey="item"
          itemNumber={1}
          kind="static"
          onApply={onApply}
          onClose={() => undefined}
          src={null}
        />,
      ),
    );
    expect(document.body.textContent).toContain("未旋转");
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({ rotation: 0, crop: null });
  });

  it("does not count the cropper's re-report of a stored crop as a change", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const stored = { x: 0.125, y: 0, width: 0.75, height: 1 };
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          edit={{ rotation: 0, crop: stored }}
          itemKey="item"
          itemNumber={1}
          kind="static"
          knownSize={{ width: 4000, height: 3000 }}
          onApply={onApply}
          onClose={onClose}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    // Pixel rounding inside the cropper.
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 12.49, y: 0, width: 75.02, height: 100 },
        { x: 500, y: 0, width: 3001, height: 3000 },
      ),
    );
    await click(buttonByText("完成"));
    expect(onApply).toHaveBeenCalledWith({ rotation: 0, crop: stored });
    await act(async () => root.unmount());
    root = createRoot(container);

    const onCover = vi.fn();
    const closeCover = vi.fn();
    frame.render = vi.fn(async () => ({
      url: "blob:edited-frame",
      size: { width: 400, height: 300 },
      release: () => undefined,
    }));
    const composition = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const drafts: CoverDraft[] = [];
    await act(async () =>
      root.render(
        <CoverCropDialog
          blob={null}
          coverCrop={composition}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={1}
          onApply={onCover}
          onClose={closeCover}
          onDraftChange={(draft) => drafts.push(draft)}
          src="/api/community/publishing/media/example/display/base"
        />,
      ),
    );
    await act(async () => undefined);
    await act(async () =>
      crop.props!.onCropAreaChange(
        { x: 12.51, y: 0, width: 74.98, height: 100 },
        { x: 50, y: 0, width: 300, height: 300 },
      ),
    );
    // 返回 closes without asking: nothing changed.
    await click(buttonByText("返回"));
    expect(confirm).not.toHaveBeenCalled();
    expect(drafts.at(-1)?.basisCrop).toEqual(composition);
  });

  it("says when no preview will come for an item waiting on the author", async () => {
    await act(async () =>
      root.render(
        <MediaEditDialog
          blob={null}
          derivativeExpected={false}
          edit={{ rotation: 0, crop: null }}
          itemKey="item"
          itemNumber={1}
          kind="static"
          onApply={() => undefined}
          onClose={() => undefined}
          src={null}
        />,
      ),
    );
    expect(document.body.textContent).toContain(
      "这台设备无法预览这张图片，仍可旋转。",
    );
    expect(document.body.textContent).not.toContain("处理完成后");
  });
});

describe("bounded previews in components", () => {
  it("show the bounded copy, report loading until it exists, and release it on replacement and unmount", async () => {
    let sequence = 0;
    const revoked: string[] = [];
    const timers: (() => void)[] = [];
    const decode = vi.fn(async () => ({
      width: 384,
      height: 288,
      close: vi.fn(),
    }));
    const environment: PreviewEnvironment = {
      decoder: () => decode as never,
      createCanvas: () =>
        ({
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (callback: (blob: Blob | null) => void) =>
            callback(new Blob(["small"], { type: "image/jpeg" })),
        }) as unknown as HTMLCanvasElement,
      createObjectURL: () => `blob:preview-${(sequence += 1)}`,
      revokeObjectURL: (url) => revoked.push(url),
      setTimeout: (callback) => timers.push(callback),
      clearTimeout: () => undefined,
    };
    const cache = createPreviewCache(environment);
    const seen: BoundedPreviewState[] = [];
    const Probe = ({ blob }: { readonly blob: Blob | null }) => {
      seen.push(useBoundedPreview(blob, 384, cache));
      return null;
    };
    const first = new Blob(["a"], { type: "image/jpeg" });
    const second = new Blob(["b"], { type: "image/jpeg" });
    await act(async () => root.render(<Probe blob={first} />));
    expect(seen[0]).toEqual({ status: "loading", url: null, size: null });
    await act(async () => undefined);
    expect(seen.at(-1)).toEqual({
      status: "ready",
      url: "blob:preview-1",
      size: { width: 384, height: 288 },
    });
    await act(async () => root.render(<Probe blob={second} />));
    await act(async () => undefined);
    expect(seen.at(-1)?.url).toBe("blob:preview-2");
    // Released after a moment (a remount of the same tile keeps it).
    for (const run of timers.splice(0)) run();
    expect(revoked).toEqual(["blob:preview-1"]);
    await act(async () => root.render(<Probe blob={null} />));
    expect(seen.at(-1)).toEqual({ status: "idle", url: null, size: null });
    for (const run of timers.splice(0)) run();
    expect(revoked).toEqual(["blob:preview-1", "blob:preview-2"]);
  });
});
