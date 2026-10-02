// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { HistoryExtension } from "@blocknote/core/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArticleDocument, ArticleMediaReference } from "@moya/contracts";
import { parseArticleEditorDocument } from "../../../lib/public-api/article-authoring-client";
import { articleBlockNoteSchema } from "./article-blocknote-schema";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import { createArticleFileDrop } from "./article-file-drop";

const editors: ArticleBlockNoteEditor[] = [];
const mounts: HTMLElement[] = [];
const adapters: ReturnType<typeof createArticleFileDrop>[] = [];
afterEach(() => {
  adapters.splice(0).forEach((adapter) => adapter.dispose());
  editors.splice(0).forEach((editor) => editor.unmount());
  mounts.splice(0).forEach((mount) => mount.remove());
  vi.restoreAllMocks();
});
const setup = (empty = false) => {
  let drop: ReturnType<typeof createArticleFileDrop> | null = null;
  const editor = BlockNoteEditor.create({
    schema: articleBlockNoteSchema,
    initialContent: (empty ? ["first"] : ["first", "last"]).map((id) => ({
      id,
      type: "paragraph",
      content: empty ? "" : id,
    })),
    _tiptapOptions: {
      editorProps: {
        handleDOMEvents: {
          drop: (view, event) => drop?.handleDrop(view, event) ?? false,
        },
      },
    },
  });
  const surface = document.createElement("div");
  const mount = document.createElement("div");
  surface.append(mount);
  document.body.append(surface);
  editor.mount(mount);
  // Native SideMenu clamps outside-editor drops; jsdom has zero-size geometry.
  const bounds = {
    x: 0,
    y: 0,
    left: 0,
    right: 500,
    top: 0,
    bottom: 500,
    width: 500,
    height: 500,
    toJSON: () => ({}),
  };
  for (const node of new Set([
    editor.prosemirrorView.dom,
    editor.prosemirrorView.dom.firstElementChild!,
    ...editor.domElement!.querySelectorAll<HTMLElement>(".bn-block-group"),
  ]))
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(bounds);
  editors.push(editor);
  mounts.push(surface);
  editor.setTextCursorPosition("first", "start");
  const position = editor.prosemirrorState.selection.anchor;
  vi.spyOn(editor.prosemirrorView, "posAtCoords").mockReturnValue({
    pos: position,
    inside: position,
  });
  const element =
    editor.domElement!.querySelector<HTMLElement>('[data-id="first"]')!;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 200,
  } as DOMRect);
  const last =
    editor.domElement!.querySelector<HTMLElement>('[data-id="last"]');
  if (last)
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue({
      top: 300,
      bottom: 400,
    } as DOMRect);
  let finish!: (refs: readonly ArticleMediaReference[]) => void;
  let allowed = true;
  let sequence = 0;
  let attachments: Pick<ArticleDocument, "references" | "galleries"> = {
    references: {},
    galleries: {},
  };
  const importFiles = vi.fn(
    () =>
      new Promise<readonly ArticleMediaReference[]>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = vi.fn();
  const notice = vi.fn();
  drop = createArticleFileDrop({
    editor,
    surface,
    canImport: () => allowed,
    importFiles,
    attachments: () => attachments,
    setAttachments: (value) => {
      attachments = value;
    },
    nextId: () => `drop-${++sequence}`,
    pending,
    notice,
    changed: vi.fn(),
  });
  adapters.push(drop);
  const event = (y = 125, types = ["Files"], kind = "drop", x = 20) => {
    const value = new MouseEvent(kind, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(value, "dataTransfer", {
      value: {
        types,
        files: [new File(["synthetic"], "one.png", { type: "image/png" })],
        dropEffect: "none",
      },
    });
    return value as DragEvent;
  };
  const refs: ArticleMediaReference[] = ["1", "2"].map((id) => ({
    type: "managed",
    itemId: `media-item-${id.repeat(32)}`,
  }));
  const complete = async () => {
    finish(refs);
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    editor,
    drop,
    event,
    complete,
    refs,
    importFiles,
    pending,
    notice,
    surface,
    firstElement: element,
    missText: () =>
      vi.mocked(editor.prosemirrorView.posAtCoords).mockReturnValue(null),
    deny: () => {
      allowed = false;
    },
    canonical: () => parseArticleEditorDocument(editor.document, attachments),
  };
};
describe("Native-position managed image drops", () => {
  it.each([
    [-200, 125, "first", "before"],
    [900, 175, "first", "after"],
    [900, 225, "first", "after"],
    [-200, 275, "last", "before"],
    [20, 50, "first", "before"],
    [20, 900, "last", "after"],
  ] as const)(
    "accepts body whitespace at (%s,%s) with matching %s/%s indicator and one import",
    async (x, y, target, placement) => {
      const value = setup();
      expect(value.surface).not.toBe(value.editor.prosemirrorView.dom);
      expect(value.editor.prosemirrorView.dom.contains(value.surface)).toBe(
        false,
      );
      value.missText();
      const over = value.event(y, ["Files"], "dragover", x);
      value.surface.dispatchEvent(over);
      const marked = value.editor.domElement!.querySelector<HTMLElement>(
        `[data-id="${target}"]`,
      )!;
      expect(over.defaultPrevented).toBe(true);
      expect(over.dataTransfer!.dropEffect).toBe("copy");
      expect(marked.dataset.articleFileDrop).toBe(placement);
      const drop = value.event(y, ["Files"], "drop", x);
      value.surface.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(true);
      expect(marked.dataset.articleFileDrop).toBeUndefined();
      expect(value.importFiles).toHaveBeenCalledTimes(1);
      value.editor.setTextCursorPosition("first", "start");
      await value.complete();
      const expected = ["first", "last"];
      const index = expected.indexOf(target) + (placement === "after" ? 1 : 0);
      expected.splice(index, 0, "drop-3", "drop-4");
      expect(value.canonical().blocks.map((block) => block.id)).toEqual(
        expected,
      );
      value.editor.exec(
        value.editor.getExtension(HistoryExtension)!.undoCommand,
      );
      expect(value.editor.document.map((block) => block.id)).toEqual([
        "first",
        "last",
      ]);
    },
  );
  it("uses body geometry when a native hit points at a distant block", async () => {
    const value = setup();
    value.surface.dispatchEvent(value.event(900));
    await value.complete();
    expect(value.canonical().blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
      "managedImage",
      "managedImage",
    ]);
  });
  it("blocks new external file drops while an image modal owns the body", () => {
    const value = setup();
    value.missText();
    value.surface.dispatchEvent(value.event(225, ["Files"], "dragover"));
    expect(value.firstElement.dataset.articleFileDrop).toBe("after");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    value.surface.append(dialog);
    const over = value.event(225, ["Files"], "dragover");
    dialog.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe("none");
    expect(value.firstElement.dataset.articleFileDrop).toBeUndefined();
    const drop = value.event(225);
    dialog.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(
      value.drop.cursorPosition(value.editor.prosemirrorView, drop),
    ).toBeNull();
    expect(value.drop.handleDrop(value.editor.prosemirrorView, drop)).toBe(
      true,
    );
    expect(value.importFiles).not.toHaveBeenCalled();
    dialog.remove();
    value.surface.dispatchEvent(value.event(225, ["Files"], "dragover"));
    expect(value.firstElement.dataset.articleFileDrop).toBe("after");
  });
  it("accepts an empty body without a text hit", async () => {
    const value = setup(true);
    value.missText();
    value.surface.dispatchEvent(value.event(250));
    await value.complete();
    expect(value.canonical().blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "managedImage",
      "managedImage",
    ]);
  });
  it("handles a PM whitespace drop once and clears the body indicator", async () => {
    const value = setup();
    value.missText();
    value.editor.prosemirrorView.dom.dispatchEvent(
      value.event(225, ["Files"], "dragover"),
    );
    expect(value.firstElement.dataset.articleFileDrop).toBe("after");
    value.editor.prosemirrorView.dom.dispatchEvent(value.event(225));
    expect(value.importFiles).toHaveBeenCalledTimes(1);
    expect(value.firstElement.dataset.articleFileDrop).toBeUndefined();
    await value.complete();
    expect(value.canonical().blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "managedImage",
      "managedImage",
      "paragraph",
    ]);
  });
  it.each(["dragleave", "dragend", "dispose"])(
    "clears only its external-file indicator on %s",
    (reason) => {
      const value = setup();
      value.missText();
      value.firstElement.dataset.articleDrop = "before";
      value.surface.dispatchEvent(value.event(175, ["Files"], "dragover"));
      expect(value.firstElement.dataset.articleFileDrop).toBe("after");
      if (reason === "dispose") value.drop.dispose();
      else value.surface.dispatchEvent(value.event(175, ["Files"], reason));
      expect(value.firstElement.dataset.articleFileDrop).toBeUndefined();
      expect(value.firstElement.dataset.articleDrop).toBe("before");
      expect(value.importFiles).not.toHaveBeenCalled();
    },
  );
  it.each(["permission", "readonly"])(
    "rejects whitespace files after %s without an insertion indicator",
    (reason) => {
      const value = setup();
      value.missText();
      if (reason === "permission") value.deny();
      else value.editor.isEditable = false;
      const over = value.event(175, ["Files"], "dragover");
      value.surface.dispatchEvent(over);
      expect(over.dataTransfer!.dropEffect).toBe("none");
      expect(value.firstElement.dataset.articleFileDrop).toBeUndefined();
      const drop = value.event(175);
      value.surface.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(true);
      expect(value.importFiles).not.toHaveBeenCalled();
    },
  );
  it("does not claim internal drags or files outside the task body", () => {
    const value = setup();
    value.missText();
    const internal = value.event(175, ["blocknote/html", "Files"], "dragover");
    value.surface.dispatchEvent(internal);
    const outside = value.event(175);
    document.body.dispatchEvent(outside);
    // BlockNote may prevent its own internal drag; this adapter adds no marker.
    expect(value.firstElement.dataset.articleFileDrop).toBeUndefined();
    expect(outside.defaultPrevented).toBe(false);
    expect(value.importFiles).not.toHaveBeenCalled();
  });
  it.each([
    [125, "before"],
    [175, "after"],
  ] as const)(
    "inserts at native y=%s (%s), preserves order and undoes in one step",
    async (y, placement) => {
      const value = setup();
      const event = value.event(y);
      expect(
        value.drop.cursorPosition(value.editor.prosemirrorView, event),
      ).toMatchObject({ orientation: "block-horizontal" });
      value.editor.prosemirrorView.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      value.editor.setTextCursorPosition("last", "start");
      await value.complete();
      const blocks = value.canonical().blocks;
      expect(blocks.map((block) => block.type)).toEqual(
        placement === "before"
          ? ["managedImage", "managedImage", "paragraph", "paragraph"]
          : ["paragraph", "managedImage", "managedImage", "paragraph"],
      );
      const images = blocks.filter((block) => block.type === "managedImage");
      expect(
        images.map((block) => value.canonical().references[block.props.refId]),
      ).toEqual(value.refs);
      value.editor.exec(
        value.editor.getExtension(HistoryExtension)!.undoCommand,
      );
      expect(value.editor.document.map((block) => block.id)).toEqual([
        "first",
        "last",
      ]);
      expect(value.pending.mock.calls).toEqual([[true], [false]]);
    },
  );
  it("leaves internal block drags to BlockNote", () => {
    const value = setup();
    const event = value.event(125, ["blocknote/html", "Files"]);
    expect(value.drop.handleDrop(value.editor.prosemirrorView, event)).toBe(
      false,
    );
    expect(event.defaultPrevented).toBe(false);
    expect(value.importFiles).not.toHaveBeenCalled();
  });
  it.each(["permission", "dispose", "deleted-target"])(
    "rejects delayed results after %s without invalid document content",
    async (reason) => {
      const value = setup();
      value.drop.handleDrop(value.editor.prosemirrorView, value.event());
      if (reason === "permission") value.deny();
      else if (reason === "dispose") value.drop.dispose();
      else value.editor.removeBlocks(["first"]);
      await value.complete();
      expect(
        value.canonical().blocks.every((block) => block.type === "paragraph"),
      ).toBe(true);
      if (reason === "deleted-target")
        expect(value.notice).toHaveBeenCalledWith(
          expect.stringContaining("位置已被删除"),
        );
    },
  );
});
