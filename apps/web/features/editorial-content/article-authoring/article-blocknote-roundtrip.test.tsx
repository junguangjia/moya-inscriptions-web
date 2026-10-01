// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it, vi } from "vitest";
import type { ArticleDocument, CatalogId } from "@moya/contracts";
import { parseArticleEditorDocument } from "../../../lib/public-api/article-authoring-client";
import { articleBlockNoteSchema } from "./article-blocknote-schema";
import { articleSessionAttachments } from "./article-attachments";
import type { ArticleDraft, UpdateArticleDraftCommand } from "@moya/contracts";
import { createArticleAutosave } from "./article-autosave";

const reference = {
  type: "managed",
  itemId: `media-item-${"1".repeat(32)}`,
} as const;
const content: ArticleDocument = {
  format: "blocknote",
  version: 1,
  references: { photo: reference },
  galleries: { photos: { referenceIds: ["photo"] } },
  blocks: [
    {
      id: "section",
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: "繁體𠮷章节", styles: { bold: true } }],
      children: [],
    },
    {
      id: "prose",
      type: "paragraph",
      props: {},
      content: [
        {
          type: "text",
          text: "空格  与换行\n异体𠮷字",
          styles: { italic: true, underline: true, textColor: "red" },
        },
        {
          type: "link",
          href: "https://example.invalid/archive?q=碑",
          content: [{ type: "text", text: "来源", styles: {} }],
        },
      ],
      children: [],
    },
    {
      id: "list",
      type: "numberedListItem",
      props: { start: 4 },
      content: [{ type: "text", text: "第四项", styles: {} }],
      children: [
        {
          id: "nested",
          type: "bulletListItem",
          props: {},
          content: [{ type: "text", text: "子项", styles: {} }],
          children: [],
        },
      ],
    },
    {
      id: "image",
      type: "managedImage",
      props: { refId: "photo", caption: "碑面𠮷", alt: "合成碑面" },
      children: [],
    },
    {
      id: "gallery",
      type: "imageGallery",
      props: { groupId: "photos" },
      children: [],
    },
    {
      id: "catalog",
      type: "catalogReference",
      props: { catalogId: `catalog-${"2".repeat(32)}` as CatalogId },
      children: [],
    },
  ],
};
describe("restricted BlockNote canonical roundtrip", () => {
  it("preserves Unicode, whitespace, styles, links, nested lists and managed identity", () => {
    const editor = BlockNoteEditor.create({
      schema: articleBlockNoteSchema,
      initialContent: content.blocks,
    });
    const canonical = parseArticleEditorDocument(editor.document, content);
    expect(canonical.blocks[0]).toMatchObject(content.blocks[0]!);
    expect(canonical.blocks[1]).toMatchObject(content.blocks[1]!);
    expect(canonical.blocks[2]).toMatchObject(content.blocks[2]!);
    expect(canonical.blocks.slice(3)).toEqual(content.blocks.slice(3));
    expect(canonical.references).toEqual(content.references);
    expect(canonical.galleries).toEqual(content.galleries);
    expect(editor.schema.blockSchema.imageGallery.propSchema).toEqual({
      groupId: { default: "" },
    });
    expect(Object.keys(editor.schema.blockSchema).sort()).toEqual(
      [
        "paragraph",
        "heading",
        "bulletListItem",
        "numberedListItem",
        "quote",
        "divider",
        "managedImage",
        "imageGallery",
        "catalogReference",
      ].sort(),
    );
    expect(Object.keys(editor.schema.styleSchema).sort()).toEqual([
      "bold",
      "italic",
      "textColor",
      "underline",
    ]);
    editor.unmount();
  });
  it("filters arbitrary clipboard colors and preserves supported internal color/underline", async () => {
    const editor = BlockNoteEditor.create({ schema: articleBlockNoteSchema });
    const blocks = await editor.tryParseHTMLToBlocks(
      '<p><span data-style-type="textColor" data-value="rgb(1,2,3)">a</span><span data-style-type="textColor" data-value="brown"><u>𠮷</u></span><span style="color:rgb(1,2,3)">b</span></p>',
    );
    const parsed = parseArticleEditorDocument(blocks, {
      references: {},
      galleries: {},
    });
    expect(parsed.blocks[0]).toMatchObject({
      content: [
        { type: "text", text: "a", styles: {} },
        {
          type: "text",
          text: "𠮷",
          styles: { textColor: "brown", underline: true },
        },
        { type: "text", text: "b", styles: {} },
      ],
    });
    editor.unmount();
  });
  it("starts a new session with reachable maps while keeping cover references", () => {
    const draft = {
      document: {
        ...content,
        references: {
          ...content.references,
          cover: { type: "managed", itemId: `media-item-${"3".repeat(32)}` },
          orphan: { type: "managed", itemId: `media-item-${"4".repeat(32)}` },
        },
        galleries: {
          ...content.galleries,
          historical: { referenceIds: ["orphan"] },
        },
      },
      coverRefId: "cover",
    } satisfies Pick<ArticleDraft, "document" | "coverRefId">;
    const attachments = articleSessionAttachments(draft);
    expect(Object.keys(attachments.references)).toEqual(["photo", "cover"]);
    expect(attachments.galleries).toEqual(content.galleries);
    expect(draft.document.galleries.historical).toBeDefined();
  });
});

describe("installed BlockNote content-event boundary", () => {
  it("ignores editable/selection updates while retaining every supported content operation", async () => {
    const editor = BlockNoteEditor.create({
      schema: articleBlockNoteSchema,
      initialContent: content.blocks,
    });
    const mount = document.createElement("div");
    editor.mount(mount);
    const initial: ArticleDraft = {
      id: `article-${"1".repeat(32)}` as ArticleDraft["id"],
      ownerId: `user-${"1".repeat(32)}` as ArticleDraft["ownerId"],
      title: "合成事件回归𠮷",
      coverRefId: null,
      document: parseArticleEditorDocument(editor.document, content),
      version: 1,
      status: "draft",
      publicVersion: null,
      updatedAt: "2026-09-30T00:00:00.000Z",
      fingerprint: "0".repeat(64),
    };
    const save = vi.fn(
      async (_id: ArticleDraft["id"], command: UpdateArticleDraftCommand) => ({
        ...initial,
        title: command.title,
        coverRefId: command.coverRefId,
        document: command.document,
        version: command.expectedVersion + 1,
      }),
    );
    const auto = createArticleAutosave({
      initial,
      client: { save, read: async () => initial },
      currentAccount: () => initial.ownerId,
      accountEpoch: () => 1,
      capture: () => ({
        title: initial.title,
        coverRefId: null,
        document: parseArticleEditorDocument(editor.document, content),
      }),
      requestId: () => crypto.randomUUID(),
      classifyFailure: () => ({
        status: 422,
        reason: null,
        outcomeUnknown: false,
      }),
      timers: { set: () => null, clear: () => undefined },
    });
    const events: Array<Array<{ type: string; source: { type: string } }>> = [];
    const unsubscribe = editor.onChange((_editor, context) => {
      // This is the real installed EventManager + getChanges implementation;
      // no mocked event payload or serialized full-document comparison.
      const changes = context.getChanges();
      events.push(changes.map(({ type, source }) => ({ type, source })));
      if (changes.length > 0) auto.changed();
    });
    const changed = async (operation: () => void) => {
      const beginning = events.length;
      operation();
      expect(events.slice(beginning).flat().length).toBeGreaterThan(0);
      expect(auto.isDirty()).toBe(true);
      await auto.flush();
      expect(auto.isDirty()).toBe(false);
      expect(auto.store.get().draft.document).toEqual(
        parseArticleEditorDocument(editor.document, content),
      );
    };
    try {
      const before = structuredClone(editor.document);
      editor.isEditable = false;
      editor.isEditable = true;
      expect(events).toEqual([[], []]);
      editor.setTextCursorPosition("prose", "end");
      expect(events).toEqual([[], []]);
      expect(editor.document).toEqual(before);
      expect(auto.store.get()).toMatchObject({
        status: "saved",
        editGeneration: 0,
        acknowledgedGeneration: 0,
      });
      await auto.flush();
      expect(save).not.toHaveBeenCalled();

      await changed(() => editor.insertInlineContent("输入𠮷"));
      editor.setSelection("section", "prose");
      await changed(() => editor.addStyles({ bold: true }));
      await changed(() =>
        editor.updateBlock("section", { props: { level: 3 } }),
      );
      expect(editor.getBlock("section")).toMatchObject({ props: { level: 3 } });
      expect(
        auto.store
          .get()
          .draft.document.blocks.find(({ id }) => id === "section"),
      ).toMatchObject({ props: { level: 3 } });
      await changed(() =>
        editor.updateBlock("image", { props: { caption: "更新说明𠮷" } }),
      );
      const order = editor.document.map(({ id }) => id);
      await changed(() => editor.moveBlocksDown("image"));
      expect(editor.document.map(({ id }) => id)).not.toEqual(order);
      await changed(() => {
        editor.undo();
      });
      expect(events.flat()).toContainEqual({
        type: "move",
        source: { type: "undo" },
      });
      await changed(() => {
        editor.redo();
      });
      expect(events.flat()).toContainEqual({
        type: "move",
        source: { type: "redo" },
      });
      expect(save).toHaveBeenCalledTimes(7);
      expect(auto.store.get().draft.version).toBe(8);
      const canonical = auto.store.get().draft.document;
      expect(canonical.blocks.find(({ id }) => id === "section")).toMatchObject(
        {
          props: { level: 3 },
        },
      );
      expect(canonical.blocks.find(({ id }) => id === "image")).toMatchObject({
        props: { caption: "更新说明𠮷", refId: "photo" },
      });
    } finally {
      unsubscribe();
      auto.dispose();
      editor.unmount();
    }
  });
});
