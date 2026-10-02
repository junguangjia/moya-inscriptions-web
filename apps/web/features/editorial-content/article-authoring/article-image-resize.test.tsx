// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteContext } from "@blocknote/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleBlock } from "@moya/contracts";
import { ArticleImageResize } from "./article-image-resize";

type ImageBlock = Pick<
  Extract<ArticleBlock, { type: "managedImage" }>,
  "id" | "props"
>;
const initialImage = (displayWidth = 1): ImageBlock => ({
  id: "image",
  props: { refId: "photo", caption: "", alt: "合成碑面", displayWidth },
});
const editors: BlockNoteEditor[] = [];
const roots: Root[] = [];
const mounts: HTMLElement[] = [];
let columnWidths: WeakMap<HTMLElement, number>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  columnWidths = new WeakMap();
  const getWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  )?.get;
  // jsdom has no layout. Only supply column and native visual-wrapper widths;
  // the installed native wrapper owns every resize event and temporary width.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      const column = columnWidths.get(this);
      if (column !== undefined) return column;
      if (this.classList.contains("bn-visual-media-wrapper")) {
        const wrapper = this.closest<HTMLElement>(
          ".bn-file-block-content-wrapper",
        );
        return Number.parseFloat(wrapper?.style.width ?? "0") || 0;
      }
      return getWidth?.call(this) ?? 0;
    },
  );
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const editor of editors.splice(0)) editor.unmount();
  for (const mount of mounts.splice(0)) mount.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Real editor/upload context and native wrapper; canonical width is the adapter output. */
const renderResize = async (
  options: {
    width?: number;
    disabled?: boolean;
    accept?: boolean;
  } = {},
) => {
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "image", type: "image", props: { url: "/synthetic/source" } },
    ],
  });
  const editorMount = document.createElement("div");
  document.body.append(editorMount);
  mounts.push(editorMount);
  editor.mount(editorMount);
  editors.push(editor);
  const column = editor.domElement?.firstElementChild;
  expect(column).toBeInstanceOf(HTMLElement);
  columnWidths.set(column as HTMLElement, 500);
  const nativeWrite = vi.spyOn(editor, "updateBlock");
  const container = document.createElement("div");
  document.body.append(container);
  mounts.push(container);
  const root = createRoot(container);
  roots.push(root);
  const state = {
    block: initialImage(options.width ?? 1),
    disabled: options.disabled ?? false,
    accept: options.accept ?? true,
  };
  const apply = vi.fn((width: number) => {
    if (!state.accept) return false;
    state.block = {
      ...state.block,
      props: { ...state.block.props, displayWidth: width },
    };
    draw();
    return true;
  });
  const crop = vi.fn();
  const draw = () =>
    root.render(
      <BlockNoteContext.Provider value={{ editor }}>
        <div className="bn-block-outer" data-test-image-outer="">
          <ArticleImageResize
            editor={editor}
            block={state.block}
            disabled={state.disabled}
            onApply={apply}
          >
            <button type="button" onClick={crop}>
              <img src="/synthetic/source" alt="合成碑面" />
            </button>
          </ArticleImageResize>
        </div>
      </BlockNoteContext.Provider>,
    );
  await act(async () => draw());
  const rerender = async (update: {
    block?: ImageBlock;
    disabled?: boolean;
    accept?: boolean;
  }) => {
    Object.assign(state, update);
    await act(async () => draw());
  };
  const wrapper = () =>
    container.querySelector<HTMLElement>(".bn-file-block-content-wrapper")!;
  const handle = (side: "left" | "right" = "right") =>
    container.querySelector<HTMLElement>(
      side === "left"
        ? '[aria-label="从左边调整图片大小"]'
        : '[aria-label="从右边调整图片大小"]',
    )!;
  const outer = () =>
    container.querySelector<HTMLElement>("[data-test-image-outer]")!;
  expect(wrapper()).not.toBeNull();
  expect(handle()).not.toBeNull();
  return {
    editor,
    column: column as HTMLElement,
    container,
    state,
    apply,
    crop,
    nativeWrite,
    rerender,
    wrapper,
    handle,
    outer,
  };
};
const mouse = (target: EventTarget, name: string, x = 100) =>
  act(async () => {
    (target === window ? document.body : target).dispatchEvent(
      new MouseEvent(name, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
      }),
    );
  });
const key = (target: HTMLElement, value: string) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: value,
      }),
    );
  });
const touch = (target: EventTarget, name: string, xs: number[]) =>
  act(async () => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: xs.map((clientX) => ({ clientX })),
    });
    (target === window ? document.body : target).dispatchEvent(event);
  });

describe("Article native image resize adapter", () => {
  it("previews multiple drag moves and commits exactly once on release as normalized width", async () => {
    const view = await renderResize();
    await mouse(view.wrapper(), "mouseover");
    expect(view.handle().getAttribute("role")).toBe("slider");
    expect(view.handle().getAttribute("aria-valuenow")).toBe("100");
    await mouse(view.handle(), "mousedown", 100);
    await mouse(window, "mousemove", 0);
    expect(view.wrapper().style.width).toBe("400px");
    await mouse(window, "mousemove", -200);
    expect(view.wrapper().style.width).toBe("200px");
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.container.querySelector("style")?.textContent).toContain(
      "width: 40%; float: inline-start;",
    );
    expect(view.outer().hasAttribute("data-article-image-layout")).toBe(false);
    expect(view.outer().hasAttribute("style")).toBe(false);
    await mouse(window, "mouseup", -200);
    expect(view.apply).toHaveBeenCalledExactlyOnceWith(0.4);
    expect(view.state.block.props.displayWidth).toBe(0.4);
    expect(view.nativeWrite).not.toHaveBeenCalled();
    expect(view.wrapper().style.width).toBe("200px");
    await mouse(window, "mouseup", -200);
    expect(view.apply).toHaveBeenCalledTimes(1);
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(view.crop).not.toHaveBeenCalled();
  });

  it.each([
    { x: -1000, normalized: 0.15 },
    { x: 2000, normalized: 1 },
  ])(
    "bounds a native drag to $normalized of the body column",
    async ({ x, normalized }) => {
      const view = await renderResize();
      await mouse(view.handle(), "mousedown", 100);
      await mouse(window, "mousemove", x);
      await mouse(window, "mouseup", x);
      expect(view.apply).toHaveBeenCalledExactlyOnceWith(normalized);
      expect(view.state.block.props.displayWidth).toBe(normalized);
      expect(view.nativeWrite).not.toHaveBeenCalled();
    },
  );

  it("keeps width proportional when the column changes without a document write", async () => {
    const view = await renderResize({ width: 0.4 });
    expect(view.wrapper().style.width).toBe("200px");
    columnWidths.set(view.column, 250);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(view.wrapper().style.width).toBe("100px");
    expect(view.state.block.props.displayWidth).toBe(0.4);
    expect(view.container.querySelector("style")?.textContent).toContain(
      "width: 40%;",
    );
    expect(view.outer().hasAttribute("style")).toBe(false);
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.nativeWrite).not.toHaveBeenCalled();
  });

  it("offers bounded keyboard adjustment and ignores unrelated keys", async () => {
    const view = await renderResize({ width: 0.5 });
    await key(view.handle(), "ArrowLeft");
    expect(view.apply).toHaveBeenLastCalledWith(0.45);
    await key(view.handle(), "ArrowRight");
    expect(view.apply).toHaveBeenLastCalledWith(0.5);
    await key(view.handle(), "Home");
    expect(view.apply).toHaveBeenLastCalledWith(0.15);
    expect(view.handle().getAttribute("aria-valuenow")).toBe("15");
    await key(view.handle(), "ArrowLeft");
    expect(view.apply).toHaveBeenLastCalledWith(0.15);
    await key(view.handle(), "End");
    expect(view.apply).toHaveBeenLastCalledWith(1);
    expect(view.handle().getAttribute("aria-valuenow")).toBe("100");
    const writes = view.apply.mock.calls.length;
    await key(view.handle(), "Enter");
    expect(view.apply).toHaveBeenCalledTimes(writes);
    expect(view.nativeWrite).not.toHaveBeenCalled();
  });

  it("refuses a drag released after block props change", async () => {
    const view = await renderResize();
    await mouse(view.handle(), "mousedown", 100);
    await mouse(window, "mousemove", -200);
    await view.rerender({
      block: {
        ...view.state.block,
        props: { ...view.state.block.props, alt: "Updated alt" },
      },
    });
    await mouse(window, "mouseup", -200);
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.state.block.props.alt).toBe("Updated alt");
    expect(view.wrapper().style.width).toBe("500px");
  });

  it("interrupts a drag when disabled and rejects keyboard commands", async () => {
    const view = await renderResize();
    await mouse(view.handle(), "mousedown", 100);
    await mouse(window, "mousemove", -200);
    await view.rerender({ disabled: true });
    await mouse(window, "mouseup", -200);
    await key(view.handle(), "Home");
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.handle().tabIndex).toBe(-1);
    expect(view.wrapper().style.width).toBe("500px");
  });

  it.each(["pointercancel", "touchcancel", "blur"])(
    "cancels a native drag on %s and drops its later mouseup",
    async (name) => {
      const view = await renderResize();
      await mouse(view.handle(), "mousedown", 100);
      await mouse(window, "mousemove", -200);
      await act(async () => window.dispatchEvent(new Event(name)));
      await mouse(window, "mouseup", -200);
      expect(view.apply).not.toHaveBeenCalled();
      expect(view.wrapper().style.width).toBe("500px");
      expect(view.outer().hasAttribute("data-article-image-wrap")).toBe(false);
      expect(view.container.querySelector("style")?.textContent).toContain(
        "float: none;",
      );
    },
  );

  it("restores source width if the current owner rejects the release", async () => {
    const view = await renderResize({ accept: false });
    await mouse(view.handle(), "mousedown", 100);
    await mouse(window, "mousemove", -200);
    await mouse(window, "mouseup", -200);
    expect(view.apply).toHaveBeenCalledExactlyOnceWith(0.4);
    expect(view.state.block.props.displayWidth).toBe(1);
    expect(view.wrapper().style.width).toBe("500px");
    expect(view.outer().hasAttribute("data-article-image-wrap")).toBe(false);
    expect(view.container.querySelector("style")?.textContent).toContain(
      "float: none;",
    );
    expect(view.nativeWrite).not.toHaveBeenCalled();
  });

  it("uses one-finger native resizing but cancels when another touch interrupts", async () => {
    const view = await renderResize();
    await touch(view.handle(), "touchstart", [100]);
    await touch(window, "touchmove", [0]);
    expect(view.wrapper().style.width).toBe("400px");
    await touch(window, "touchend", []);
    expect(view.apply).toHaveBeenCalledExactlyOnceWith(0.8);
    view.apply.mockClear();
    await touch(view.handle(), "touchstart", [100]);
    await touch(window, "touchmove", [0]);
    await touch(window, "touchstart", [0, 40]);
    await touch(window, "touchend", []);
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.wrapper().style.width).toBe("400px");
  });
});
