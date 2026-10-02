// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { HistoryExtension } from "@blocknote/core/extensions";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blockTypeSelectItems } from "@blocknote/react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleBlock,
  ArticleDocument,
  ArticleInlineContent,
} from "@moya/contracts";
import { parseArticleEditorDocument } from "../../../lib/public-api/article-authoring-client";
import { articleBlockNoteSchema } from "./article-blocknote-schema";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import { ArticleLinkDialog } from "./article-link-dialog";
import {
  ArticleMarkPaletteContext,
  useArticleMarkPalette,
  useArticleMarkPaletteContext,
} from "./article-mark-palette";
import {
  captureArticleSelection,
  restoreArticleSelection,
} from "./article-selection";
import { moveArticleBlock, stepArticleBlock } from "./article-block-move";
import {
  ArticleTools,
  formatArticleBlocks,
  formatArticleLayout,
} from "./article-tools";
import {
  articleImageCropProps,
  getArticleImageCrop,
} from "./article-image-layout";

const mixed = (): ArticleInlineContent[] => [
  { type: "text", text: "ab", styles: { bold: true } },
  { type: "text", text: "cd", styles: { italic: true } },
  { type: "text", text: "ef", styles: {} },
];
const prose = (
  id: string,
  content: ArticleInlineContent[] = mixed(),
): ArticleBlock => ({
  id,
  type: "paragraph",
  props: {},
  content,
  children: [],
});
const envelope = (blocks: ArticleBlock[]): ArticleDocument => ({
  format: "blocknote",
  version: 1,
  blocks,
  references: {},
  galleries: {},
});
const inlineFixture = () =>
  envelope([
    prose("mixed"),
    prose("other", [{ type: "text", text: "Unselected 𠮷 text", styles: {} }]),
  ]);
const url = "https://example.invalid/archive?q=碑";
const linkedMixed = (href = url): ArticleInlineContent[] => [
  { type: "text", text: "a", styles: { bold: true } },
  {
    type: "link",
    href,
    content: [
      { type: "text", text: "b", styles: { bold: true } },
      { type: "text", text: "cd", styles: { italic: true } },
    ],
  },
  { type: "text", text: "ef", styles: {} },
];

const editors: ArticleBlockNoteEditor[] = [];
const mounts: HTMLDivElement[] = [];
const roots: Root[] = [];
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);
const originalAct = Object.getOwnPropertyDescriptor(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);

const makeEditor = (initial: ArticleDocument) => {
  const editor = BlockNoteEditor.create({
    schema: articleBlockNoteSchema,
    initialContent: initial.blocks,
  });
  const mount = document.createElement("div");
  editor.mount(mount);
  editors.push(editor);
  mounts.push(mount);
  return editor;
};
const canonical = (editor: ArticleBlockNoteEditor, initial: ArticleDocument) =>
  parseArticleEditorDocument(editor.document, initial);

/** Use the real installed TextSelection without adding a transitive dependency. */
const selectInline = (
  editor: ArticleBlockNoteEditor,
  id: string,
  anchorOffset: number,
  headOffset = anchorOffset,
) => {
  editor.setTextCursorPosition(id, "start");
  return editor.transact((transaction) => {
    expect(transaction.selection.toJSON()).toMatchObject({ type: "text" });
    const base = transaction.selection.anchor;
    // setTextCursorPosition installs TextSelection for an inline fixture.
    // Calling create as a static method retains its `new this(...)` receiver.
    const TextSelection = transaction.selection.constructor as unknown as {
      create(
        doc: typeof transaction.doc,
        anchor: number,
        head?: number,
      ): typeof transaction.selection;
    };
    const anchor = base + anchorOffset;
    const head = base + headOffset;
    transaction.setSelection(
      TextSelection.create(transaction.doc, anchor, head),
    );
    return { type: "text", anchor, head };
  });
};

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  // The existing native-dialog tests use the same jsdom top-layer shim.
  // It replaces only unavailable platform behavior, never editor commands.
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
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const editor of editors.splice(0)) editor.unmount();
  for (const mount of mounts.splice(0)) mount.remove();
  if (originalShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalShowModal,
    );
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose)
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  if (originalAct)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const choices = [
  { label: "正文", type: "paragraph" },
  { label: "章节标题", type: "heading", level: 2 },
  { label: "小节标题", type: "heading", level: 3 },
  { label: "无序列表", type: "bulletListItem" },
  { label: "有序列表", type: "numberedListItem" },
  { label: "引用", type: "quote" },
] as const;
const nonListChoices = [
  choices[0],
  choices[1],
  choices[2],
  choices[5],
] as const;

const nestedFixture = () =>
  envelope([
    prose("outside"),
    {
      id: "parent",
      type: "numberedListItem",
      props: { start: 4 },
      content: [{ type: "text", text: "Parent 𠮷", styles: { bold: true } }],
      children: [
        {
          id: "leaf",
          type: "bulletListItem",
          props: {},
          content: [
            { type: "text", text: "Nested leaf", styles: { italic: true } },
          ],
          children: [],
        },
      ],
    },
    prose("tail"),
  ]);

describe("Article toolbar real in-place formatting", () => {
  it.each(choices)(
    "converts existing text to $label without inserting or rewriting content",
    (choice) => {
      const originalLevel =
        choice.type === "heading" && choice.level === 3 ? 2 : 3;
      const initial = envelope([
        {
          id: "target",
          type: "heading",
          props: { level: originalLevel },
          content: [
            ...mixed(),
            {
              type: "link",
              href: url,
              content: [
                { type: "text", text: " 来源𠮷", styles: { italic: true } },
              ],
            },
          ],
          children: [],
        },
        prose("tail"),
      ]);
      const editor = makeEditor(initial);
      const before = canonical(editor, initial);
      editor.setTextCursorPosition("target", "end");

      expect(formatArticleBlocks(editor, choice)).toBe(true);

      const after = canonical(editor, initial);
      expect(after.blocks.map(({ id }) => id)).toEqual(["target", "tail"]);
      expect(after.blocks[0]).toMatchObject({
        id: "target",
        type: choice.type,
        content:
          before.blocks[0] && "content" in before.blocks[0]
            ? before.blocks[0].content
            : undefined,
        children: [],
      });
      if (choice.type === "heading")
        expect(after.blocks[0]!.props).toMatchObject({ level: choice.level });
      expect(after.blocks[1]).toEqual(before.blocks[1]);
      expect(after.references).toEqual(before.references);
      expect(after.galleries).toEqual(before.galleries);
    },
  );

  it("groups multiple textual conversions into one Undo while preserving a managed image", () => {
    const initial: ArticleDocument = {
      ...envelope([
        prose("first"),
        {
          id: "photo",
          type: "managedImage",
          props: {
            refId: "asset",
            caption: "合成碑面𠮷",
            alt: "Synthetic archive image",
          },
          children: [],
        },
        prose("last"),
      ]),
      references: {
        asset: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
      },
    };
    const editor = makeEditor(initial);
    const before = canonical(editor, initial);
    editor.setSelection("first", "last");
    const history = editor.getExtension(HistoryExtension);
    expect(history).toBeDefined();

    expect(formatArticleBlocks(editor, choices[1])).toBe(true);

    const converted = canonical(editor, initial);
    expect(converted.blocks.map(({ id }) => id)).toEqual(
      before.blocks.map(({ id }) => id),
    );
    for (const index of [0, 2]) {
      expect(converted.blocks[index]).toMatchObject({
        type: "heading",
        props: { level: 2 },
      });
      expect(
        (converted.blocks[index] as Extract<ArticleBlock, { type: "heading" }>)
          .content,
      ).toEqual(
        (before.blocks[index] as Extract<ArticleBlock, { type: "paragraph" }>)
          .content,
      );
    }
    expect(converted.blocks[1]).toEqual(before.blocks[1]);
    expect(converted.references).toEqual(before.references);
    expect(converted.galleries).toEqual(before.galleries);
    const beforeCheck = canonical(editor, initial);
    expect(editor.canExec(history!.undoCommand)).toBe(true);
    expect(canonical(editor, initial)).toEqual(beforeCheck);
    expect(editor.undo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(before);
    expect(editor.canExec(history!.redoCommand)).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(converted);
  });

  it.each(nonListChoices)(
    "refuses parent-list to $label without orphaning children or changing selection",
    (choice) => {
      const initial = nestedFixture();
      const editor = makeEditor(initial);
      editor.setTextCursorPosition("parent", "end");
      const before = canonical(editor, initial);
      const selection = editor.prosemirrorState.selection.toJSON();
      const history = editor.getExtension(HistoryExtension)!;
      const canUndo = editor.canExec(history.undoCommand);

      expect(formatArticleBlocks(editor, choice)).toBe(false);

      expect(canonical(editor, initial)).toEqual(before);
      expect(editor.prosemirrorState.selection.toJSON()).toEqual(selection);
      expect(editor.canExec(history.undoCommand)).toBe(canUndo);
    },
  );

  it.each(nonListChoices)(
    "refuses nested list leaf to $label even when that leaf has no children",
    (choice) => {
      const initial = nestedFixture();
      const editor = makeEditor(initial);
      expect(editor.getParentBlock("leaf")?.id).toBe("parent");
      expect(editor.getBlock("leaf")?.children).toEqual([]);
      editor.setTextCursorPosition("leaf", "end");
      const before = canonical(editor, initial);
      const selection = editor.prosemirrorState.selection.toJSON();

      expect(formatArticleBlocks(editor, choice)).toBe(false);

      expect(canonical(editor, initial)).toEqual(before);
      expect(editor.prosemirrorState.selection.toJSON()).toEqual(selection);
    },
  );

  it("rejects an entire mixed selection before changing its compatible first paragraph", () => {
    const initial = nestedFixture();
    const editor = makeEditor(initial);
    editor.setSelection("outside", "parent");
    expect(
      editor.getSelection()?.blocks.some(({ id }) => id === "outside"),
    ).toBe(true);
    expect(
      editor.getSelection()?.blocks.some(({ id }) => id === "parent"),
    ).toBe(true);
    const before = canonical(editor, initial);
    const selection = editor.prosemirrorState.selection.toJSON();

    expect(formatArticleBlocks(editor, choices[1])).toBe(false);

    expect(canonical(editor, initial)).toEqual(before);
    expect(editor.getBlock("outside")?.type).toBe("paragraph");
    expect(editor.prosemirrorState.selection.toJSON()).toEqual(selection);
  });

  it("still allows list-to-list conversion of a parent and retains its valid subtree", () => {
    const initial = nestedFixture();
    const editor = makeEditor(initial);
    editor.setTextCursorPosition("parent", "end");
    const before = canonical(editor, initial);
    expect(formatArticleBlocks(editor, choices[3])).toBe(true);
    const converted = canonical(editor, initial);
    expect(converted.blocks[1]).toMatchObject({
      id: "parent",
      type: "bulletListItem",
    });
    expect(converted.blocks[1]!.children).toEqual(before.blocks[1]!.children);
    expect(editor.undo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(before);
  });
});

describe("Article exact inline selection and safe link commands", () => {
  it("restores the backward partial range after another cursor selection without changing content", () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    const exact = selectInline(editor, "mixed", 4, 1);
    const captured = captureArticleSelection(editor);
    const before = canonical(editor, initial);
    expect(captured.text).toBe("bcd");
    expect(captured.empty).toBe(false);
    editor.setTextCursorPosition("other", "end");
    expect(editor.prosemirrorState.selection.toJSON()).not.toEqual(exact);

    expect(restoreArticleSelection(editor, captured)).toBe(true);

    expect(editor.prosemirrorState.selection.toJSON()).toEqual(exact);
    expect(editor.getSelectedText()).toBe("bcd");
    expect(canonical(editor, initial)).toEqual(before);
  });

  it("links only the restored partial range and preserves each distinct bold/italic run", () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 4, 1);
    const captured = captureArticleSelection(editor);
    const before = canonical(editor, initial);
    editor.setTextCursorPosition("other", "end");
    expect(restoreArticleSelection(editor, captured)).toBe(true);

    // The optional label is deliberately absent: URL editing must not replace text.
    editor.createLink(url);

    const after = canonical(editor, initial);
    expect(after.blocks[0]).toMatchObject({
      id: "mixed",
      content: linkedMixed(),
      children: [],
    });
    expect(after.blocks[1]).toEqual(before.blocks[1]);
    expect(after.blocks.map(({ id }) => id)).toEqual(["mixed", "other"]);
  });

  it("edits a collapsed existing link then unlinks it without replacing its styled text", () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    const before = canonical(editor, initial);
    selectInline(editor, "mixed", 1, 4);
    editor.createLink(url);
    selectInline(editor, "mixed", 2);
    const captured = captureArticleSelection(editor);
    expect(captured.empty).toBe(true);
    expect(captured.link).toMatchObject({ href: url, text: "bcd" });
    editor.setTextCursorPosition("other", "end");
    expect(restoreArticleSelection(editor, captured)).toBe(true);
    const updated = "https://example.invalid/revised-source";
    editor.editLink(updated, captured.link!.text, captured.link!.from);
    expect(canonical(editor, initial).blocks[0]).toMatchObject({
      content: linkedMixed(updated),
    });

    selectInline(editor, "mixed", 2);
    const removal = captureArticleSelection(editor);
    expect(removal.link?.href).toBe(updated);
    editor.setTextCursorPosition("other", "end");
    expect(restoreArticleSelection(editor, removal)).toBe(true);
    editor.deleteLink(removal.link!.from);
    expect(canonical(editor, initial)).toEqual(before);
  });

  it("refuses a bookmark from an older document and leaves current document and cursor intact", () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 4, 1);
    const captured = captureArticleSelection(editor);
    editor.updateBlock("other", { content: "New committed content 𠮷" });
    selectInline(editor, "mixed", 0);
    const current = canonical(editor, initial);
    const currentSelection = editor.prosemirrorState.selection.toJSON();

    expect(restoreArticleSelection(editor, captured)).toBe(false);

    expect(canonical(editor, initial)).toEqual(current);
    expect(editor.prosemirrorState.selection.toJSON()).toEqual(
      currentSelection,
    );
  });

  it("refuses a different editor lifetime with the complete equivalent native document", () => {
    const initial = inlineFixture();
    const first = makeEditor(initial);
    selectInline(first, "mixed", 4, 1);
    const captured = captureArticleSelection(first);
    // Capture every actual first.document block and ID through the real adapter.
    // The adapter removes only undefined content:none fields; it does not drop
    // blocks. Do not slice the authored content or replace the live PM state.
    const copied = canonical(first, initial);
    const next = makeEditor(copied);
    selectInline(next, "mixed", 0);
    expect(next.getBlock("mixed")?.id).toBe("mixed");
    expect(next.document.map(({ id }) => id)).toEqual(
      first.document.map(({ id }) => id),
    );
    expect(canonical(next, copied)).toEqual(copied);
    expect(next.prosemirrorState.doc.toJSON()).toEqual(
      captured.document.toJSON(),
    );

    // Each real Tiptap editor has its own Schema/NodeType objects. Native eq()
    // requires NodeType identity, so compare the COMPLETE captured document
    // inside the receiving schema without modifying its state or ID caches.
    const comparable = {
      ...captured,
      document: next.pmSchema.nodeFromJSON(captured.document.toJSON()),
    };
    expect(next.prosemirrorState.doc.eq(comparable.document)).toBe(true);
    expect(comparable.editor).toBe(first);
    expect(comparable.editor).not.toBe(next);
    const current = canonical(next, copied);
    const currentSelection = next.prosemirrorState.selection.toJSON();

    expect(restoreArticleSelection(next, captured)).toBe(false);
    // This independently exercises the editor-lifetime guard: if that guard
    // were removed, the already-equal native document would permit restore.
    expect(restoreArticleSelection(next, comparable)).toBe(false);

    expect(canonical(next, copied)).toEqual(current);
    expect(next.prosemirrorState.selection.toJSON()).toEqual(currentSelection);
    // The original captured range remains valid in its original lifetime.
    first.setTextCursorPosition("other", "end");
    expect(restoreArticleSelection(first, captured)).toBe(true);
    expect(first.getSelectedText()).toBe("bcd");
  });
});

const typeUrl = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const renderLinkDialog = async (editor: ArticleBlockNoteEditor) => {
  selectInline(editor, "mixed", 4, 1);
  const selection = captureArticleSelection(editor);
  const mount = document.createElement("div");
  document.body.append(mount);
  mounts.push(mount);
  const root = createRoot(mount);
  roots.push(root);
  const submit = vi.fn<(url: string | null, label: string) => void>();
  const cancel = vi.fn<() => void>();
  await act(async () =>
    root.render(
      <ArticleLinkDialog
        selection={selection}
        disabled={false}
        onSubmit={submit}
        onCancel={cancel}
      />,
    ),
  );
  const input = mount.querySelector<HTMLInputElement>('input[type="url"]');
  const form = mount.querySelector("form");
  expect(input).not.toBeNull();
  expect(form).not.toBeNull();
  return { mount, input: input!, form: form!, submit, cancel };
};
const submitForm = async (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });

const renderTools = async (
  editor: ArticleBlockNoteEditor,
  canMutate: () => boolean = () => true,
  options: { disabled?: boolean; bodyActive?: boolean } = {},
) => {
  const mount = document.createElement("div");
  document.body.append(mount);
  mounts.push(mount);
  const root = createRoot(mount);
  roots.push(root);
  const noop = () => undefined;
  await act(async () =>
    root.render(
      <ArticleTools
        editor={editor}
        disabled={options.disabled ?? false}
        bodyActive={options.bodyActive ?? true}
        canMutate={canMutate}
        onLink={noop}
        onImage={noop}
        onGallery={noop}
        onCatalog={noop}
        onDivider={noop}
        onSettings={noop}
      />,
    ),
  );
  return mount;
};
const nextEditorFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("Article color selector preserves the selected editing target", () => {
  it("colors only the original partial selection after the dialog moves focus, with native undo", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 1, 4);
    const before = canonical(editor, initial);
    const mount = await renderTools(editor);
    await act(async () =>
      mount
        .querySelector<HTMLButtonElement>('[aria-label="文字颜色"]')!
        .click(),
    );
    editor.setTextCursorPosition("other", "end");
    const red = [
      ...mount.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("朱红"))!;
    await act(async () => red.click());
    await act(async () => nextEditorFrame());
    const after = canonical(editor, initial);
    expect(after.blocks[0]).toMatchObject({
      content: [
        { text: "a", styles: { bold: true } },
        { text: "b", styles: { bold: true, textColor: "red" } },
        { text: "cd", styles: { italic: true, textColor: "red" } },
        { text: "ef", styles: {} },
      ],
    });
    expect(after.blocks[1]).toEqual(before.blocks[1]);
    editor.undo();
    expect(canonical(editor, initial)).toEqual(before);
  });

  it("does not apply a queued color choice after editing authorization changes", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 1, 4);
    const before = canonical(editor, initial);
    let authorized = true;
    const mount = await renderTools(editor, () => authorized);
    await act(async () =>
      mount
        .querySelector<HTMLButtonElement>('[aria-label="文字颜色"]')!
        .click(),
    );
    const red = [
      ...mount.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((button) => button.textContent?.includes("朱红"))!;
    await act(async () => {
      red.click();
      authorized = false;
    });
    await act(async () => nextEditorFrame());
    expect(canonical(editor, initial)).toEqual(before);
  });
});

describe("actual Article link dialog validation", () => {
  it.each([
    "javascript:alert(1)",
    "ftp://example.invalid/archive",
    "https://example.invalid/archive with spaces",
  ])(
    "refuses unsafe %s before submitting a command and permits correcting the same input",
    async (unsafe) => {
      const editor = makeEditor(inlineFixture());
      const dialog = await renderLinkDialog(editor);
      await typeUrl(dialog.input, unsafe);
      await submitForm(dialog.form);
      expect(dialog.submit).not.toHaveBeenCalled();
      expect(
        dialog.mount.querySelector('[role="alert"]')?.textContent,
      ).toContain("http 或 https");
      expect(dialog.mount.querySelector("dialog")?.hasAttribute("open")).toBe(
        true,
      );
      expect(dialog.input.value).toBe(unsafe);

      await typeUrl(dialog.input, url);
      await submitForm(dialog.form);
      expect(dialog.submit).toHaveBeenCalledTimes(1);
      expect(dialog.submit).toHaveBeenCalledWith(url, "");
      expect(dialog.cancel).not.toHaveBeenCalled();
    },
  );
});

describe("r4 native styles and media reorder", () => {
  it("applies underline and color to the captured mixed selection only, with real undo", () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 1, 4);
    const before = canonical(editor, initial);
    const captured = captureArticleSelection(editor);
    editor.setTextCursorPosition("other", "start");
    expect(restoreArticleSelection(editor, captured)).toBe(true);
    editor.transact(() => {
      editor.toggleStyles({ underline: true });
      editor.addStyles({ textColor: "red" });
    });
    expect(canonical(editor, initial).blocks[0]).toMatchObject({
      content: [
        { text: "a", styles: { bold: true } },
        {
          text: "b",
          styles: { bold: true, underline: true, textColor: "red" },
        },
        {
          text: "cd",
          styles: { italic: true, underline: true, textColor: "red" },
        },
        { text: "ef", styles: {} },
      ],
    });
    expect(canonical(editor, initial).blocks[1]).toEqual(before.blocks[1]);
    editor.undo();
    expect(canonical(editor, initial).blocks[0]).toMatchObject({
      content: [
        { text: "a", styles: { bold: true } },
        { text: "b", styles: { bold: true, underline: true } },
        { text: "cd", styles: { italic: true, underline: true } },
        { text: "ef", styles: {} },
      ],
    });
    editor.undo();
    expect(canonical(editor, initial).blocks[0]).toEqual(
      canonical(makeEditor(initial), initial).blocks[0],
    );
  });
  it("moves media around a nested list without nesting, changing IDs or dropping references; one undo", () => {
    const initial: ArticleDocument = {
      ...nestedFixture(),
      references: {
        asset: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
      },
    };
    initial.blocks.splice(1, 0, {
      id: "photo",
      type: "managedImage",
      props: { refId: "asset", caption: "𠮷", alt: "碑" },
      children: [],
    });
    const editor = makeEditor(initial);
    const before = canonical(editor, initial);
    expect(stepArticleBlock(editor, "photo", 1)).toBe(true);
    const after = canonical(editor, initial);
    expect(after.blocks.map((block) => block.id)).toEqual([
      "outside",
      "parent",
      "photo",
      "tail",
    ]);
    expect(after.blocks.find((block) => block.id === "photo")).toEqual(
      before.blocks.find((block) => block.id === "photo"),
    );
    expect(after.references).toEqual(before.references);
    expect(after.blocks.find((block) => block.id === "parent")).toEqual(
      before.blocks.find((block) => block.id === "parent"),
    );
    editor.undo();
    expect(canonical(editor, initial)).toEqual(before);
    expect(moveArticleBlock(editor, "photo", "leaf", "before")).toBe(false);
    expect(stepArticleBlock(editor, "outside", -1)).toBe(false);
  });
});

const dialogChoice = (mount: HTMLElement, label: string) => {
  const button = [
    ...mount.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeDefined();
  return button!;
};
const toolButton = (mount: HTMLElement, label: string) => {
  const button = mount.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(button).not.toBeNull();
  return button!;
};
const cropFixture = (): ArticleDocument => ({
  ...envelope([
    prose("first"),
    {
      id: "photo",
      type: "managedImage",
      props: { refId: "asset", caption: "原图𠮷", alt: "碑面" },
      children: [],
    },
    { id: "last", type: "quote", props: {}, content: mixed(), children: [] },
  ]),
  references: {
    asset: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
  },
});

describe("r9 native background and paragraph controls", () => {
  it("restores the original partial selection when applying highlight, retaining marks and one native Undo", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 4, 1);
    const before = canonical(editor, initial);
    const mount = await renderTools(editor);
    await act(async () => toolButton(mount, "文字背景色").click());
    editor.setTextCursorPosition("other", "end");
    await act(async () => dialogChoice(mount, "朱红").click());
    await act(async () => nextEditorFrame());
    const after = canonical(editor, initial);
    expect(after.blocks[0]).toMatchObject({
      content: [
        { text: "a", styles: { bold: true } },
        { text: "b", styles: { bold: true, backgroundColor: "red" } },
        { text: "cd", styles: { italic: true, backgroundColor: "red" } },
        { text: "ef", styles: {} },
      ],
    });
    expect(after.blocks[1]).toEqual(before.blocks[1]);
    await act(async () => {
      expect(editor.undo()).toBe(true);
    });
    expect(canonical(editor, initial)).toEqual(before);
  });

  it("uses exported BlockNote bullet/numbered icons and executes their real commands", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    editor.setTextCursorPosition("mixed", "end");
    const before = canonical(editor, initial);
    const mount = await renderTools(editor);
    for (const [type, label] of [
      ["bulletListItem", "无序列表"],
      ["numberedListItem", "有序列表"],
    ] as const) {
      const native = blockTypeSelectItems(editor.dictionary).find(
        (item) => item.type === type,
      )!;
      expect(native).toBeDefined();
      const Icon = native.icon;
      const expected = document.createElement("div");
      expected.innerHTML = renderToStaticMarkup(<Icon />);
      const button = toolButton(mount, label);
      expect(button.querySelector("svg")?.outerHTML).toBe(
        expected.querySelector("svg")?.outerHTML,
      );
      await act(async () => button.click());
      expect(editor.getBlock("mixed")).toMatchObject({ type });
      expect(canonical(editor, initial).blocks[1]).toEqual(before.blocks[1]);
      await act(async () => {
        expect(editor.undo()).toBe(true);
      });
      expect(canonical(editor, initial)).toEqual(before);
    }
  });

  it("updates a mixed multi-block selection in one native transaction while preserving media and content", () => {
    const initial = cropFixture();
    const editor = makeEditor(initial);
    const before = canonical(editor, initial);
    editor.setSelection("first", "last");
    expect(
      formatArticleLayout(editor, {
        textAlignment: "justify",
        lineSpacing: "relaxed",
      }),
    ).toBe(true);
    const after = canonical(editor, initial);
    expect(after.blocks.map((block) => block.id)).toEqual(
      before.blocks.map((block) => block.id),
    );
    for (const index of [0, 2]) {
      expect(after.blocks[index]).toMatchObject({
        props: { textAlignment: "justify", lineSpacing: "relaxed" },
      });
      expect(
        (
          after.blocks[index] as Extract<
            ArticleBlock,
            { type: "paragraph" | "quote" }
          >
        ).content,
      ).toEqual(
        (
          before.blocks[index] as Extract<
            ArticleBlock,
            { type: "paragraph" | "quote" }
          >
        ).content,
      );
    }
    expect(after.blocks[1]).toEqual(before.blocks[1]);
    expect(after.references).toEqual(before.references);
    expect(after.galleries).toEqual(before.galleries);
    expect(editor.undo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(before);
    expect(editor.redo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(after);
  });

  it.each([
    { tool: "对齐方式", choice: "居中", props: { textAlignment: "center" } },
    { tool: "行间距", choice: "宽松", props: { lineSpacing: "relaxed" } },
  ])(
    "restores the selected paragraphs through the $tool dialog",
    async ({ tool, choice, props }) => {
      const initial = envelope([
        prose("first"),
        prose("last"),
        prose("unselected"),
      ]);
      const editor = makeEditor(initial);
      editor.setSelection("first", "last");
      const before = canonical(editor, initial);
      const mount = await renderTools(editor);
      await act(async () => toolButton(mount, tool).click());
      editor.setTextCursorPosition("unselected", "end");
      await act(async () => dialogChoice(mount, choice).click());
      await act(async () => nextEditorFrame());
      const after = canonical(editor, initial);
      expect(after.blocks[0]).toMatchObject({ props });
      expect(after.blocks[1]).toMatchObject({ props });
      expect(after.blocks[2]).toEqual(before.blocks[2]);
      await act(async () => {
        expect(editor.undo()).toBe(true);
      });
      expect(canonical(editor, initial)).toEqual(before);
    },
  );

  it.each([
    { tool: "文字背景色", choice: "朱红" },
    { tool: "对齐方式", choice: "居中" },
    { tool: "行间距", choice: "宽松" },
  ])(
    "refuses a queued $tool choice after authorization changes",
    async ({ tool, choice }) => {
      const initial = inlineFixture();
      const editor = makeEditor(initial);
      selectInline(editor, "mixed", 1, 4);
      const before = canonical(editor, initial);
      let authorized = true;
      const mount = await renderTools(editor, () => authorized);
      await act(async () => toolButton(mount, tool).click());
      await act(async () => {
        dialogChoice(mount, choice).click();
        authorized = false;
      });
      await act(async () => nextEditorFrame());
      expect(canonical(editor, initial)).toEqual(before);
    },
  );

  it.each([
    { tool: "文字背景色", choice: "朱红" },
    { tool: "对齐方式", choice: "居中" },
    { tool: "行间距", choice: "宽松" },
  ])(
    "refuses a stale $tool selection after a real document mutation",
    async ({ tool, choice }) => {
      const initial = inlineFixture();
      const editor = makeEditor(initial);
      selectInline(editor, "mixed", 1, 4);
      const mount = await renderTools(editor);
      await act(async () => toolButton(mount, tool).click());
      await act(async () =>
        editor.updateBlock("other", { content: "更新后的正文𠮷" }),
      );
      editor.setTextCursorPosition("other", "end");
      const current = canonical(editor, initial);
      await act(async () => dialogChoice(mount, choice).click());
      await act(async () => nextEditorFrame());
      expect(canonical(editor, initial)).toEqual(current);
    },
  );

  it.each([{ disabled: true }, { bodyActive: false }])(
    "keeps all new controls inert when disabled or outside the body",
    async (options) => {
      const initial = inlineFixture();
      const editor = makeEditor(initial);
      selectInline(editor, "mixed", 1, 4);
      const before = canonical(editor, initial);
      const mount = await renderTools(editor, () => true, options);
      for (const label of [
        "文字背景色",
        "对齐方式",
        "行间距",
        "无序列表",
        "有序列表",
      ]) {
        const button = toolButton(mount, label);
        expect(button.disabled).toBe(true);
        await act(async () => button.click());
      }
      await act(async () => nextEditorFrame());
      expect(mount.querySelector("dialog")).toBeNull();
      expect(canonical(editor, initial)).toEqual(before);
    },
  );
});

describe("r9 native managed-image crop persistence", () => {
  it("roundtrips normalized crop command props with stable media identity and one native Undo", () => {
    const initial = cropFixture();
    const editor = makeEditor(initial);
    const before = canonical(editor, initial);
    const crop = { x: 0.125, y: 0.25, width: 0.5, height: 0.5 };
    editor.updateBlock("photo", { props: articleImageCropProps(crop) });
    const saved = canonical(editor, initial);
    const photo = saved.blocks.find((block) => block.type === "managedImage")!;
    expect(getArticleImageCrop(photo.props)).toEqual(crop);
    expect(photo).toMatchObject({
      id: "photo",
      props: {
        refId: "asset",
        caption: "原图𠮷",
        alt: "碑面",
        cropX: 0.125,
        cropY: 0.25,
        cropWidth: 0.5,
        cropHeight: 0.5,
      },
    });
    expect(saved.references).toEqual(before.references);
    expect(saved.blocks[0]).toEqual(before.blocks[0]);
    expect(saved.blocks[2]).toEqual(before.blocks[2]);
    const reopened = makeEditor(saved);
    expect(canonical(reopened, saved)).toEqual(saved);
    expect(editor.undo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(before);
    expect(editor.redo()).toBe(true);
    expect(canonical(editor, initial)).toEqual(saved);
    reopened.updateBlock("photo", { props: articleImageCropProps(null) });
    expect(
      canonical(reopened, saved).blocks.find(
        (block) => block.type === "managedImage",
      ),
    ).toMatchObject({
      props: {
        refId: "asset",
        cropX: 0,
        cropY: 0,
        cropWidth: 1,
        cropHeight: 1,
      },
    });
  });
});

const SelectionPaletteTrigger = ({
  dismiss,
}: {
  readonly dismiss: () => void;
}) => {
  const palette = useArticleMarkPaletteContext();
  return (
    <div data-selection-palette-popup="">
      <button
        type="button"
        onClick={() => {
          palette.open("textColor");
          dismiss();
        }}
      >
        选择文字颜色
      </button>
      <button
        type="button"
        onClick={() => {
          palette.open("backgroundColor");
          dismiss();
        }}
      >
        选择文字背景色
      </button>
    </div>
  );
};

const SharedPaletteHarness = ({
  editor,
  canMutate,
}: {
  readonly editor: ArticleBlockNoteEditor;
  readonly canMutate: () => boolean;
}) => {
  const [selectionVisible, setSelectionVisible] = useState(true);
  const palette = useArticleMarkPalette({
    editor,
    disabled: false,
    canMutate,
    selectedIcon: <span aria-hidden="true">✓</span>,
  });
  const noop = () => undefined;
  return (
    <ArticleMarkPaletteContext.Provider value={palette}>
      <ArticleTools
        editor={editor}
        disabled={palette.isOpen}
        bodyActive={true}
        canMutate={canMutate}
        markPalette={palette}
        onLink={noop}
        onImage={noop}
        onGallery={noop}
        onCatalog={noop}
        onDivider={noop}
        onSettings={noop}
      />
      {selectionVisible ? (
        <SelectionPaletteTrigger dismiss={() => setSelectionVisible(false)} />
      ) : null}
      {palette.dialog}
    </ArticleMarkPaletteContext.Provider>
  );
};
const renderSharedPalette = async (
  editor: ArticleBlockNoteEditor,
  canMutate: () => boolean = () => true,
) => {
  const mount = document.createElement("div");
  document.body.append(mount);
  mounts.push(mount);
  const root = createRoot(mount);
  roots.push(root);
  await act(async () =>
    root.render(<SharedPaletteHarness editor={editor} canMutate={canMutate} />),
  );
  return mount;
};
const paletteChoice = (mount: HTMLElement, label: string) => {
  const button = [
    ...mount.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((item) => item.textContent?.includes(label));
  expect(button).toBeDefined();
  return button!;
};

describe("shared selected-text palette lifetime", () => {
  it.each([
    { trigger: "选择文字颜色", mark: "textColor" },
    { trigger: "选择文字背景色", mark: "backgroundColor" },
  ] as const)(
    "keeps $mark open after the selection toolbar disappears, restores its exact range and supports native Undo",
    async ({ trigger, mark }) => {
      const initial = inlineFixture();
      const editor = makeEditor(initial);
      selectInline(editor, "mixed", 4, 1);
      const before = canonical(editor, initial);
      const mount = await renderSharedPalette(editor);
      const source = [
        ...mount.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === trigger)!;
      await act(async () => source.click());
      expect(mount.querySelector("[data-selection-palette-popup]")).toBeNull();
      expect(mount.querySelectorAll("dialog[open]")).toHaveLength(1);
      expect(mount.querySelectorAll("dialog button")).toHaveLength(5);
      editor.setTextCursorPosition("other", "end");
      await act(async () => paletteChoice(mount, "朱红").click());
      await act(async () => nextEditorFrame());
      const updated = canonical(editor, initial);
      expect(updated.blocks[0]).toMatchObject({
        content: [
          { text: "a", styles: { bold: true } },
          { text: "b", styles: { bold: true, [mark]: "red" } },
          { text: "cd", styles: { italic: true, [mark]: "red" } },
          { text: "ef", styles: {} },
        ],
      });
      expect(updated.blocks[1]).toEqual(before.blocks[1]);
      expect(mount.querySelector("dialog")).toBeNull();
      editor.undo();
      expect(canonical(editor, initial)).toEqual(before);
    },
  );

  it("uses the same bounded foreground and background dialog from persistent tools", async () => {
    const editor = makeEditor(inlineFixture());
    selectInline(editor, "mixed", 1, 4);
    const mount = await renderSharedPalette(editor);
    await act(async () => toolButton(mount, "文字颜色").click());
    expect(mount.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(mount.querySelector("dialog")?.textContent).toContain("默认墨色");
    await act(async () => paletteChoice(mount, "取消").click());
    await act(async () => toolButton(mount, "文字背景色").click());
    expect(mount.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(mount.querySelector("dialog")?.textContent).toContain("无背景");
    expect(mount.querySelector("dialog")?.textContent).not.toContain("黄色");
  });

  it("refuses an already queued palette choice when the account loses authorization", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 1, 4);
    const before = canonical(editor, initial);
    let authorized = true;
    const mount = await renderSharedPalette(editor, () => authorized);
    const trigger = [
      ...mount.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "选择文字背景色")!;
    await act(async () => trigger.click());
    await act(async () => {
      paletteChoice(mount, "朱红").click();
      authorized = false;
    });
    await act(async () => nextEditorFrame());
    expect(canonical(editor, initial)).toEqual(before);
  });

  it("refuses the captured range after a real document mutation without reverting it", async () => {
    const initial = inlineFixture();
    const editor = makeEditor(initial);
    selectInline(editor, "mixed", 1, 4);
    const mount = await renderSharedPalette(editor);
    const trigger = [
      ...mount.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "选择文字颜色")!;
    await act(async () => trigger.click());
    editor.updateBlock("other", {
      content: [{ type: "text", text: "New edit", styles: {} }],
    });
    const changed = canonical(editor, initial);
    await act(async () => paletteChoice(mount, "朱红").click());
    await act(async () => nextEditorFrame());
    expect(canonical(editor, initial)).toEqual(changed);
  });
});
