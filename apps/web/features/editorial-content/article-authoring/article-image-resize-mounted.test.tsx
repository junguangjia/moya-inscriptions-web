// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/ariakit";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleDocument } from "@moya/contracts";
import { articleBlockNoteSchema } from "./article-blocknote-schema";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import { ArticleAttachmentContext } from "./article-attachments";
import type { ArticleAttachmentContextValue } from "./article-attachments";
import { parseArticleEditorDocument } from "../../../lib/public-api/article-authoring-client";

const initial: ArticleDocument = {
  format: "blocknote",
  version: 1,
  references: {
    photo: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
  },
  galleries: {},
  blocks: [
    {
      id: "before",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "繁體𠮷前文", styles: { bold: true } }],
      children: [],
    },
    {
      id: "image",
      type: "managedImage",
      props: { refId: "photo", caption: "", alt: "合成碑面", displayWidth: 1 },
      children: [],
    },
    {
      id: "after",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "图片后的正文", styles: {} }],
      children: [],
    },
  ],
};
let root: Root;
let container: HTMLDivElement;
let editor: ArticleBlockNoteEditor | null;
let observer: MutationObserver | null;
let unsubscribe: (() => void) | null;
let restoreElementsFromPoint: () => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
  editor = null;
  observer = null;
  unsubscribe = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // jsdom omits this browser API used by BlockNote's native side controls.
  // Preserve hit testing: offscreen coordinates and zero-size boxes do not hit.
  const descriptor = Object.getOwnPropertyDescriptor(
    document,
    "elementsFromPoint",
  );
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: (x: number, y: number) =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            x >= rect.left &&
            x < rect.right &&
            y >= rect.top &&
            y < rect.bottom
          );
        })
        .reverse(),
  });
  restoreElementsFromPoint = () => {
    if (descriptor)
      Object.defineProperty(document, "elementsFromPoint", descriptor);
    else Reflect.deleteProperty(document, "elementsFromPoint");
  };
  const getWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  )?.get;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      if (
        this.classList.contains("bn-block-group") &&
        this.parentElement?.classList.contains("bn-editor")
      )
        return 500;
      if (this.classList.contains("bn-visual-media-wrapper"))
        return (
          Number.parseFloat(
            this.closest<HTMLElement>(".bn-file-block-content-wrapper")?.style
              .width ?? "0",
          ) || 0
        );
      return getWidth?.call(this) ?? 0;
    },
  );
});
afterEach(async () => {
  observer?.disconnect();
  unsubscribe?.();
  await act(async () => root.unmount());
  editor?.unmount();
  container.remove();
  restoreElementsFromPoint();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
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

describe("image resizing inside the actual mounted Article editor", () => {
  it("settles without mutating PM ancestor layout, commits one release and restores the complete canonical document with Undo", async () => {
    const forbiddenWrites: string[] = [];
    // A tripwire blocks/records only the old forbidden ancestor writes, so
    // a regression fails promptly instead of starving the test event loop.
    // Native MutationObserver, native React NodeView and transactions stay real.
    const datasetGetter = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "dataset",
    )!.get!;
    vi.spyOn(HTMLElement.prototype, "dataset", "get").mockImplementation(
      function (this: HTMLElement) {
        const dataset: DOMStringMap = datasetGetter.call(this);
        if (!this.classList.contains("bn-block-outer")) return dataset;
        const forbidden = (property: PropertyKey) =>
          property === "articleImageLayout" || property === "articleImageWrap";
        return new Proxy(dataset, {
          set(target, property, value) {
            if (forbidden(property)) {
              forbiddenWrites.push(String(property));
              return true;
            }
            return Reflect.set(target, property, value, target);
          },
          deleteProperty(target, property) {
            if (forbidden(property)) {
              forbiddenWrites.push(String(property));
              return true;
            }
            return Reflect.deleteProperty(target, property);
          },
        });
      },
    );
    const ancestorStyle = (style: CSSStyleDeclaration) =>
      [...container.querySelectorAll<HTMLElement>(".bn-block-outer")].some(
        (node) => node.style === style,
      );
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(
      function (
        this: CSSStyleDeclaration,
        property: string,
        value: string | null,
        priority?: string,
      ) {
        if (property === "--article-image-width" && ancestorStyle(this)) {
          forbiddenWrites.push(property);
          return;
        }
        setProperty.call(this, property, value, priority);
      },
    );
    const removeProperty = CSSStyleDeclaration.prototype.removeProperty;
    vi.spyOn(
      CSSStyleDeclaration.prototype,
      "removeProperty",
    ).mockImplementation(function (
      this: CSSStyleDeclaration,
      property: string,
    ) {
      if (property === "--article-image-width" && ancestorStyle(this)) {
        forbiddenWrites.push(property);
        return "";
      }
      return removeProperty.call(this, property);
    });
    const ancestorMutations: string[] = [];
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.target instanceof HTMLElement &&
          record.target.classList.contains("bn-block-outer") &&
          (record.attributeName === "style" ||
            record.attributeName?.startsWith("data-article-image"))
        )
          ancestorMutations.push(record.attributeName!);
      }
    });
    observer.observe(container, { attributes: true, subtree: true });
    const instance = BlockNoteEditor.create({
      schema: articleBlockNoteSchema,
      initialContent: initial.blocks,
    });
    editor = instance;
    const changed = vi.fn();
    unsubscribe = instance.onChange((_editor, context) => {
      if (context.getChanges().length > 0) changed();
    });
    const apply = vi.fn((id: string, refId: string, width: number) => {
      const block = instance.getBlock(id);
      if (block?.type !== "managedImage" || block.props.refId !== refId)
        return false;
      instance.updateBlock(block, { props: { displayWidth: width } });
      return true;
    });
    const noop = () => undefined;
    const context: ArticleAttachmentContextValue = {
      attachments: initial,
      disabled: false,
      media: {
        choose: async () => [],
        chooseCatalog: async () => null,
        render: (_reference, options) => (
          <img src="/synthetic/source" alt={options.alt} />
        ),
        renderCatalog: () => null,
      },
      applyImageWidth: apply,
      editImage: noop,
      editGallery: noop,
      editLink: noop,
      moveGalleryImage: noop,
    };
    await act(async () =>
      root.render(
        <ArticleAttachmentContext.Provider value={context}>
          <BlockNoteView
            editor={instance}
            theme="light"
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            filePanel={false}
            emojiPicker={false}
            tableHandles={false}
          />
        </ArticleAttachmentContext.Provider>,
      ),
    );
    await settle();
    expect(
      container.querySelector(".bn-editor [data-article-image-resizable]"),
    ).not.toBeNull();
    expect(forbiddenWrites).toEqual([]);
    expect(ancestorMutations).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    const canonical = () =>
      parseArticleEditorDocument(instance.document, initial);
    const before = canonical();
    const imageOuter = () =>
      container.querySelector<HTMLElement>('.bn-block-outer[data-id="image"]')!;
    const handle = () =>
      imageOuter().querySelector<HTMLElement>(
        '[aria-label="从右边调整图片大小"]',
      )!;
    const wrapper = () =>
      imageOuter().querySelector<HTMLElement>(
        ".bn-file-block-content-wrapper",
      )!;
    expect(handle()).not.toBeNull();
    expect(wrapper().style.width).toBe("500px");
    await mouse(handle(), "mousedown", 100);
    await mouse(window, "mousemove", -200);
    await settle();
    expect(wrapper().style.width).toBe("200px");
    expect(changed).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(canonical()).toEqual(before);
    await mouse(window, "mouseup", -200);
    await settle();
    expect(apply).toHaveBeenCalledExactlyOnceWith("image", "photo", 0.4);
    expect(changed).toHaveBeenCalledTimes(1);
    const after = canonical();
    expect(after.blocks[1]).toMatchObject({
      type: "managedImage",
      props: { refId: "photo", displayWidth: 0.4 },
    });
    expect(after.blocks[0]).toEqual(before.blocks[0]);
    expect(after.blocks[2]).toEqual(before.blocks[2]);
    expect(after.references).toEqual(before.references);
    await act(async () => instance.undo());
    await settle();
    expect(canonical()).toEqual(before);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(wrapper().style.width).toBe("500px");
    expect(forbiddenWrites).toEqual([]);
    expect(ancestorMutations).toEqual([]);
    await settle();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
