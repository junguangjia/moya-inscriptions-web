// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { HistoryExtension } from "@blocknote/core/extensions";
import { act } from "react";
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
  captureArticleSelection,
  restoreArticleSelection,
} from "./article-selection";
import { formatArticleBlocks } from "./article-tools";

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

  it("refuses a different editor lifetime with the same authored blocks", () => {
    const initial = inlineFixture();
    const first = makeEditor(initial);
    selectInline(first, "mixed", 4, 1);
    const captured = captureArticleSelection(first);
    const next = makeEditor(initial);
    selectInline(next, "mixed", 0);
    // Each native lifetime owns a newly generated trailing block. Compare the
    // authored blocks rather than assuming native UI nodes share those IDs.
    expect(canonical(next, initial).blocks.slice(0, 2)).toEqual(
      canonical(first, initial).blocks.slice(0, 2),
    );
    const current = canonical(next, initial);
    const currentSelection = next.prosemirrorState.selection.toJSON();

    expect(restoreArticleSelection(next, captured)).toBe(false);

    expect(canonical(next, initial)).toEqual(current);
    expect(next.prosemirrorState.selection.toJSON()).toEqual(currentSelection);
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
