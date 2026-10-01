import { describe, expect, it } from "vitest";
import {
  articleAuthoringJsonSchema,
  articleAuthoringJsonSchemas,
} from "@moya/contracts/json-schema";
import {
  ARTICLE_DOCUMENT_LIMITS,
  applyArticleBlockEdits,
  articleBlockEditsCommandSchema,
  articleCodePointLength,
  articleDocumentSchema,
  articleDraftSchema,
  articleDraftPageSchema,
  articleReferences,
  articleSafeLinkSchema,
  createArticleAuthoringGrantCommandSchema,
  createArticleDraftCommandSchema,
  emptyArticleDocument,
  extractArticleText,
  legacyArticleToDocument,
  publishArticleCommandSchema,
  updateArticleDraftCommandSchema,
} from "@moya/contracts/schemas";
import type {
  ArticleBlock,
  ArticleDocument,
  LegacyArticleInput,
} from "@moya/contracts";

const requestId = "10000000-0000-4000-8000-000000000001";
const paragraph = (id: string, text = "碑刻𠮷﨑\n傳統字形"): ArticleBlock => ({
  id,
  type: "paragraph",
  props: {
    textAlignment: "left",
    textColor: "default",
    backgroundColor: "default",
  },
  content: [{ type: "text", text, styles: { bold: true, italic: true } }],
  children: [],
});
const fixture = (): ArticleDocument => ({
  ...emptyArticleDocument(),
  blocks: [
    {
      id: "heading",
      type: "heading",
      props: { level: 2 },
      content: [],
      children: [],
    },
    paragraph("text"),
    {
      id: "list",
      type: "bulletListItem",
      props: {},
      content: [],
      children: [
        {
          id: "sublist",
          type: "numberedListItem",
          props: { start: 2 },
          content: [],
          children: [],
        },
      ],
    },
    { id: "quote", type: "quote", props: {}, content: [], children: [] },
    { id: "divider", type: "divider", props: {}, children: [] },
    {
      id: "photo",
      type: "managedImage",
      props: { refId: "own", caption: "圖說𠮷", alt: "拓片" },
      children: [],
    },
    {
      id: "gallery",
      type: "imageGallery",
      props: { groupId: "images" },
      children: [],
    },
    {
      id: "reference",
      type: "catalogReference",
      props: { catalogId: "catalog-synthetic" as never },
      children: [],
    },
  ],
  references: {
    own: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
    catalog: {
      type: "catalog",
      catalogId: "catalog-synthetic" as never,
      mediaId: "catalog-media-synthetic" as never,
    },
  },
  galleries: { images: { referenceIds: ["catalog", "own"] } },
});

describe("restricted Article document", () => {
  it("advertises the same Unicode code-point limits that the server enforces", () => {
    const schema = articleAuthoringJsonSchemas.CreateArticleDraftCommand;
    const title = schema.properties?.title;
    const titleObject = typeof title === "object" ? title : undefined;
    const referenceName = titleObject?.$ref?.replace("#/$defs/", "");
    const resolvedTitle = referenceName
      ? schema.$defs?.[referenceName]
      : titleObject;
    expect(resolvedTitle).toMatchObject({ type: "string", maxLength: 120 });
    for (const character of ["碑", "𠮷"]) {
      expect(
        createArticleDraftCommandSchema.safeParse({
          requestId,
          title: character.repeat(120),
          coverRefId: null,
          document: emptyArticleDocument(),
        }).success,
      ).toBe(true);
      expect(
        createArticleDraftCommandSchema.safeParse({
          requestId,
          title: character.repeat(121),
          coverRefId: null,
          document: emptyArticleDocument(),
        }).success,
      ).toBe(false);
    }
    const exported = JSON.stringify(
      articleAuthoringJsonSchemas.ArticleAuthoringDocument,
    );
    expect(exported).toContain('"maxLength":200');
    expect(exported).toContain('"maxLength":40000');
    expect(exported).not.toContain('"maxLength":80000');
  });
  it.each(["references", "galleries"])(
    "explicitly refuses an owned reserved key in %s without losing input",
    (field) => {
      const document = emptyArticleDocument();
      const record =
        field === "references"
          ? { type: "managed", itemId: `media-item-${"1".repeat(32)}` }
          : { referenceIds: ["unused"] };
      const input = JSON.parse(JSON.stringify(document));
      input[field] = JSON.parse('{"__proto__":' + JSON.stringify(record) + "}");
      const before = JSON.stringify(input);
      const result = articleDocumentSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(JSON.stringify(input)).toBe(before);
      expect(Object.hasOwn(input[field], "__proto__")).toBe(true);
    },
  );
  it("exports bounded object-root MCP shapes with reusable definitions", () => {
    for (const schema of Object.values(articleAuthoringJsonSchemas)) {
      expect(schema.type).toBe("object");
      expect(schema.$ref).toBeUndefined();
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify(articleAuthoringJsonSchemas.ArticleAuthoringDocument),
    ).byteLength;
    expect(bytes).toBeLessThan(20_000);
  });
  it("exports schema JSON without a runtime editor or an unbounded recursive shape", () => {
    const exported = articleAuthoringJsonSchema(articleDocumentSchema);
    const root = exported;
    expect(root?.type).toBe("object");
    expect(JSON.stringify(exported)).toContain("managedImage");
    expect(JSON.stringify(exported).length).toBeLessThan(20_000);
  });
  it("round trips allowed native/custom blocks, stable IDs, breaks and Unicode exactly", () => {
    const input = fixture();
    const output = articleDocumentSchema.parse(input);
    expect(output).toEqual(input);
    expect(JSON.parse(JSON.stringify(output))).toEqual(input);
    expect(extractArticleText(output)).toContain("碑刻𠮷﨑\n傳統字形");
    expect(articleCodePointLength("𠮷﨑")).toBe(2);
  });
  it.each([
    "table",
    "codeBlock",
    "audio",
    "video",
    "file",
    "columns",
    "image",
    "iframe",
  ])("refuses forbidden block %s", (type) =>
    expect(
      articleDocumentSchema.safeParse({
        ...emptyArticleDocument(),
        blocks: [{ ...paragraph("bad"), type }],
      }).success,
    ).toBe(false),
  );
  it("refuses unsupported marks, native formatting, properties and headings", () => {
    for (const props of [
      { textColor: "red" },
      { backgroundColor: "yellow" },
      { textAlignment: "center" },
      { fontSize: 50 },
    ]) {
      expect(
        articleDocumentSchema.safeParse({
          ...emptyArticleDocument(),
          blocks: [{ ...paragraph("bad"), props }],
        }).success,
      ).toBe(false);
    }
    expect(
      articleDocumentSchema.safeParse({
        ...emptyArticleDocument(),
        blocks: [
          {
            ...paragraph("bad"),
            content: [{ type: "text", text: "字", styles: { strike: true } }],
          },
        ],
      }).success,
    ).toBe(false);
    for (const level of [1, 4, 5, 6])
      expect(
        articleDocumentSchema.safeParse({
          ...emptyArticleDocument(),
          blocks: [{ ...paragraph("bad"), type: "heading", props: { level } }],
        }).success,
      ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...fixture(),
        arbitraryMetadata: "hidden",
      }).success,
    ).toBe(false);
  });
  it("persists underline and only the finite inline text palette, including links", () => {
    for (const textColor of ["default", "gray", "red", "brown"]) {
      const input = {
        ...fixture(),
        blocks: [
          {
            ...paragraph("styled"),
            content: [
              {
                type: "link",
                href: "https://example.invalid",
                content: [
                  {
                    type: "text",
                    text: "繁體𠮷",
                    styles: {
                      bold: true,
                      italic: true,
                      underline: true,
                      textColor,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(articleDocumentSchema.parse(input)).toEqual(input);
    }
    for (const textColor of [
      "#123456",
      "rgb(1, 2, 3)",
      "blue",
      "var(--unreviewed)",
      "RED",
    ]) {
      expect(
        articleDocumentSchema.safeParse({
          ...fixture(),
          blocks: [
            {
              ...paragraph("bad"),
              content: [{ type: "text", text: "碑", styles: { textColor } }],
            },
          ],
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "blob:https://example.invalid/x",
    "file:///tmp/a",
    "ftp://example.invalid/a",
    "https://synthetic-user@example.invalid/a",
    "https://example.invalid/\n",
  ])("refuses unsafe link %s", (url) =>
    expect(articleSafeLinkSchema.safeParse(url).success).toBe(false),
  );
  it("accepts only ordinary HTTP(S) links", () => {
    expect(
      articleSafeLinkSchema.safeParse("https://example.invalid/研究?q=碑刻")
        .success,
    ).toBe(true);
    expect(
      articleSafeLinkSchema.safeParse("http://localhost:3000/catalog").success,
    ).toBe(true);
  });
  it("refuses malformed reference/gallery identities and missing references", () => {
    const doc = fixture();
    expect(
      articleDocumentSchema.safeParse({ ...doc, references: {} }).success,
    ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({ ...doc, galleries: {} }).success,
    ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...doc,
        references: {
          ...doc.references,
          own: { type: "managed", itemId: "invented" },
        },
      }).success,
    ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...doc,
        galleries: { images: { referenceIds: ["own", "own"] } },
      }).success,
    ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...doc,
        references: {
          ...doc.references,
          own: {
            type: "managed",
            itemId: `media-item-${"1".repeat(32)}`,
            src: "https://example.invalid/image",
          },
        },
      }).success,
    ).toBe(false);
  });
  it.each(["constructor", "__proto__", "toString"])(
    "refuses absent inherited reference %s",
    (refId) => {
      const document = {
        ...emptyArticleDocument(),
        blocks: [
          {
            id: "photo",
            type: "managedImage",
            props: { refId, caption: "", alt: "" },
            children: [],
          },
        ],
      };
      expect(articleDocumentSchema.safeParse(document).success).toBe(false);
      expect(
        createArticleDraftCommandSchema.safeParse({
          requestId,
          title: "",
          coverRefId: refId,
          document: emptyArticleDocument(),
        }).success,
      ).toBe(false);
      const gallery = {
        ...emptyArticleDocument(),
        blocks: [
          {
            id: "gallery",
            type: "imageGallery",
            props: { groupId: refId },
            children: [],
          },
        ],
      };
      expect(articleDocumentSchema.safeParse(gallery).success).toBe(false);
      const group = {
        ...emptyArticleDocument(),
        galleries: { group: { referenceIds: [refId] } },
      };
      expect(articleDocumentSchema.safeParse(group).success).toBe(false);
    },
  );
  it("detects duplicate IDs including nested blocks and forbids unrelated nesting", () => {
    const doc = fixture();
    doc.blocks.push(paragraph("sublist"));
    expect(articleDocumentSchema.safeParse(doc).success).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...emptyArticleDocument(),
        blocks: [{ ...paragraph("parent"), children: [paragraph("child")] }],
      }).success,
    ).toBe(false);
  });
  it("returns structured failure for 1000 nested blocks without recursion failure", () => {
    let current: ArticleBlock = {
      id: "last",
      type: "bulletListItem",
      props: {},
      content: [],
      children: [],
    };
    for (let i = 0; i < 1000; i++)
      current = { ...current, id: `deep-${i}`, children: [current] };
    const result = articleDocumentSchema.safeParse({
      ...emptyArticleDocument(),
      blocks: [current],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe("article_block_limit");
    expect(
      articleBlockEditsCommandSchema.safeParse({
        requestId,
        expectedVersion: 1,
        edits: [{ type: "insert", afterBlockId: null, block: current }],
      }).success,
    ).toBe(false);
  });
  it("bounds aggregate block edit count and bytes before parsing individual operations", () => {
    const list: ArticleBlock = {
      id: "list",
      type: "bulletListItem",
      props: {},
      content: [],
      children: Array.from({ length: 300 }, (_, i) => ({
        id: `nested-${i}`,
        type: "bulletListItem",
        props: {},
        content: [],
        children: [],
      })),
    };
    const result = articleBlockEditsCommandSchema.safeParse({
      requestId,
      expectedVersion: 1,
      edits: [
        { type: "insert", afterBlockId: null, block: list },
        { type: "replace", block: { ...list, id: "other-list" } },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe("article_block_limit");
    const content = Array.from({ length: 600 }, () => ({
      type: "link",
      href: `https://example.invalid/${"a".repeat(1800)}`,
      content: [{ type: "text", text: "字", styles: {} }],
    }));
    const bytes = articleBlockEditsCommandSchema.safeParse({
      requestId,
      expectedVersion: 1,
      edits: [
        {
          type: "insert",
          afterBlockId: null,
          block: { ...paragraph("bytes"), content },
        },
      ],
    });
    expect(bytes.success).toBe(false);
    if (!bytes.success)
      expect(bytes.error.issues[0]?.message).toBe(
        "article_document_bytes_limit",
      );
  });
  it("accepts declared maximum and rejects cumulative text, blocks, gallery and reference limits", () => {
    const exact = {
      ...emptyArticleDocument(),
      blocks: [
        paragraph("max", "𠮷".repeat(ARTICLE_DOCUMENT_LIMITS.textCodePoints)),
      ],
    };
    expect(articleDocumentSchema.safeParse(exact).success).toBe(true);
    expect(
      articleDocumentSchema.safeParse({
        ...exact,
        blocks: [...exact.blocks, paragraph("over", "一")],
      }).success,
    ).toBe(false);
    expect(
      articleDocumentSchema.safeParse({
        ...emptyArticleDocument(),
        blocks: Array.from({ length: 401 }, (_, i) => paragraph(`b-${i}`, "")),
      }).success,
    ).toBe(false);
    const doc = fixture();
    doc.galleries.images = {
      referenceIds: Array.from({ length: 21 }, (_, i) => `img-${i}`),
    };
    expect(articleDocumentSchema.safeParse(doc).success).toBe(false);
    const imageLimit = fixture();
    for (let i = 0; i < 61; i++)
      imageLimit.references[`extra-${i}`] = {
        type: "managed",
        itemId: `media-item-${i.toString(16).padStart(32, "0")}`,
      };
    expect(articleDocumentSchema.safeParse(imageLimit).success).toBe(false);
    const catalogLimit = emptyArticleDocument();
    catalogLimit.blocks = Array.from({ length: 31 }, (_, i) => ({
      id: `c-${i}`,
      type: "catalogReference",
      props: { catalogId: `catalog-${i}` as never },
      children: [],
    }));
    expect(articleDocumentSchema.safeParse(catalogLimit).success).toBe(false);
  });
  it("rejects UTF8 byte overflow even when text is short", () => {
    const content = Array.from({ length: 600 }, () => ({
      type: "link",
      href: `https://example.invalid/${"a".repeat(1800)}`,
      content: [{ type: "text", text: "字", styles: {} }],
    }));
    expect(
      articleDocumentSchema.safeParse({
        ...emptyArticleDocument(),
        blocks: [{ ...paragraph("bytes"), content }],
      }).success,
    ).toBe(false);
  });
  it("refuses future version without modifying the supplied object", () => {
    const future = { ...fixture(), version: 2, futureProperty: ["保留", "𠮷"] };
    const before = JSON.stringify(future);
    expect(articleDocumentSchema.safeParse(future).success).toBe(false);
    expect(JSON.stringify(future)).toBe(before);
  });
  it("resolves used media once in gallery order and ignores retained unused definitions", () => {
    const doc = fixture();
    doc.blocks = doc.blocks.filter((block) => block.type !== "managedImage");
    doc.references.unused = {
      type: "managed",
      itemId: `media-item-${"f".repeat(32)}`,
    };
    expect(articleReferences(doc).map((item) => item.refId)).toEqual([
      "catalog",
      "own",
    ]);
    expect(articleReferences(doc, "own").map((item) => item.refId)).toEqual([
      "own",
      "catalog",
    ]);
    doc.blocks = doc.blocks.filter((block) => block.type !== "imageGallery");
    expect(articleReferences(doc)).toEqual([]);
  });
});

describe("Article command and delegation boundary", () => {
  const create = {
    requestId,
    title: "題刻𠮷",
    coverRefId: null,
    document: fixture(),
  };
  it("binds ownership outside commands and requires expected version on writes", () => {
    expect(createArticleDraftCommandSchema.safeParse(create).success).toBe(
      true,
    );
    expect(
      createArticleDraftCommandSchema.safeParse({
        ...create,
        ownerId: "another",
      }).success,
    ).toBe(false);
    expect(updateArticleDraftCommandSchema.safeParse(create).success).toBe(
      false,
    );
    expect(
      updateArticleDraftCommandSchema.safeParse({
        ...create,
        expectedVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      createArticleDraftCommandSchema.safeParse({
        ...create,
        coverRefId: "unknown",
      }).success,
    ).toBe(false);
  });
  it("requires exact candidate fingerprint and refuses model confirmation/self approval", () => {
    const candidate = {
      requestId,
      expectedVersion: 2,
      fingerprint: "f".repeat(64),
    };
    expect(publishArticleCommandSchema.safeParse(candidate).success).toBe(true);
    expect(
      publishArticleCommandSchema.safeParse({ ...candidate, confirmed: true })
        .success,
    ).toBe(false);
    expect(
      publishArticleCommandSchema.safeParse({ requestId, expectedVersion: 2 })
        .success,
    ).toBe(false);
  });
  it("defaults consent to draft permission and refuses Admin scopes/client identity claims", () => {
    const consent = {
      requestId,
      interactionUid: "synthetic-interaction",
      consentTicket: "synthetic-consent-ticket-placeholder-32",
    };
    expect(
      createArticleAuthoringGrantCommandSchema.parse(consent).scopes,
    ).toEqual(["artvenn:article:draft"]);
    expect(
      createArticleAuthoringGrantCommandSchema.safeParse({
        ...consent,
        scopes: ["management"],
      }).success,
    ).toBe(false);
    expect(
      createArticleAuthoringGrantCommandSchema.safeParse({
        ...consent,
        scopes: ["artvenn:article:publish"],
      }).success,
    ).toBe(false);
    expect(
      createArticleAuthoringGrantCommandSchema.safeParse({
        ...consent,
        clientId: "agent-picked-client",
      }).success,
    ).toBe(false);
  });
  it("keeps immutable public snapshot version distinct from editable version", () => {
    const draft = articleDraftSchema.parse({
      title: create.title,
      coverRefId: create.coverRefId,
      document: create.document,
      id: `article-${"1".repeat(32)}`,
      ownerId: `user-${"2".repeat(32)}`,
      version: 4,
      publicVersion: 2,
      status: "published",
      updatedAt: "2026-09-30T12:00:00.000Z",
      fingerprint: "a".repeat(64),
    });
    expect(draft).toMatchObject({ version: 4, publicVersion: 2 });
    const { document, ...summary } = draft;
    expect(document.blocks.length).toBeGreaterThan(0);
    expect(
      articleDraftPageSchema.parse({ items: [summary], nextCursor: null })
        .items[0],
    ).not.toHaveProperty("document");
    expect(
      articleDraftPageSchema.safeParse({ items: [draft], nextCursor: null })
        .success,
    ).toBe(false);
  });
});

describe("transactional bounded block edit helper", () => {
  it("inserts, replaces, moves and removes with stable IDs and exact order", () => {
    const original = {
      ...emptyArticleDocument(),
      blocks: [
        paragraph("a", "甲"),
        paragraph("b", "乙"),
        paragraph("c", "丙"),
      ],
    };
    const before = JSON.stringify(original);
    const edits = [
      {
        type: "insert" as const,
        afterBlockId: "a",
        block: paragraph("d", "丁"),
      },
      { type: "replace" as const, block: paragraph("b", "乙修訂") },
      { type: "move" as const, blockId: "c", afterBlockId: null },
      { type: "remove" as const, blockId: "a" },
    ];
    const editsBefore = JSON.stringify(edits);
    const result = applyArticleBlockEdits(original, edits);
    expect(result.blocks.map((block) => block.id)).toEqual(["c", "d", "b"]);
    expect(extractArticleText(result)).toBe("丙\n丁\n乙修訂");
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(edits)).toBe(editsBefore);
  });
  it("supports sibling list movement and root-start extraction", () => {
    const original = fixture();
    const parent = original.blocks.find(
      (block) => block.type === "bulletListItem",
    )!;
    parent.children.push({
      id: "second",
      type: "bulletListItem",
      props: {},
      content: [],
      children: [],
    });
    const result = applyArticleBlockEdits(original, [
      { type: "move", blockId: "sublist", afterBlockId: "second" },
    ]);
    expect(
      result.blocks
        .find((block) => block.id === "list")
        ?.children.map((block) => block.id),
    ).toEqual(["second", "sublist"]);
    const root = applyArticleBlockEdits(result, [
      { type: "move", blockId: "sublist", afterBlockId: null },
    ]);
    expect(root.blocks[0]?.id).toBe("sublist");
    expect(
      root.blocks
        .find((block) => block.id === "list")
        ?.children.map((block) => block.id),
    ).toEqual(["second"]);
  });
  it("refuses missing slots, self/descendant moves, duplicate IDs and invalid final body", () => {
    const original = fixture();
    const before = JSON.stringify(original);
    expect(() =>
      applyArticleBlockEdits(original, [
        { type: "insert", afterBlockId: "missing", block: paragraph("new") },
      ]),
    ).toThrow("article_block_unavailable");
    expect(() =>
      applyArticleBlockEdits(original, [
        { type: "move", blockId: "text", afterBlockId: "text" },
      ]),
    ).toThrow("article_invalid_block_move");
    expect(() =>
      applyArticleBlockEdits(original, [
        { type: "move", blockId: "list", afterBlockId: "sublist" },
      ]),
    ).toThrow("article_invalid_block_move");
    expect(() =>
      applyArticleBlockEdits(original, [
        { type: "move", blockId: "sublist", afterBlockId: "text" },
      ]),
    ).toThrow("article_invalid_move_slot");
    expect(() =>
      applyArticleBlockEdits(original, [
        { type: "insert", afterBlockId: null, block: paragraph("text") },
      ]),
    ).toThrow("article_duplicate_block_id");
    expect(() =>
      applyArticleBlockEdits(emptyArticleDocument(), [
        { type: "remove", blockId: "start" },
      ]),
    ).toThrow("article_invalid_block_result");
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("deterministic legacy Article adapter", () => {
  const legacy = (): LegacyArticleInput => ({
    title: "舊文𠮷",
    intro: "導言\n𠮷",
    cover: { id: "cover", alt: "封面" },
    sections: [
      {
        heading: "章節﨑",
        paragraphs: ["第一段", "第二段\n換行"],
        image: { id: "image", alt: "拓片" },
        imageCaption: "圖說",
      },
    ],
    citations: [
      { text: "完整引文一", url: "https://example.invalid/source" },
      { text: "完整引文二", url: null },
    ],
  });
  const resolve = (image: { id: string }) => ({
    type: "catalog" as const,
    catalogId: "catalog-synthetic" as never,
    mediaId: `media-${image.id}` as never,
  });
  it("preserves all paragraphs, headings, images, caption, citation text and URL", () => {
    const output = legacyArticleToDocument(legacy(), resolve);
    expect(legacyArticleToDocument(legacy(), resolve)).toEqual(output);
    expect(extractArticleText(output.document)).toContain("完整引文二");
    expect(extractArticleText(output.document)).toContain("第二段\n換行");
    expect(output.document.references["legacy-section-0-image"]).toMatchObject({
      mediaId: "media-image",
    });
    expect(output.coverRefId).toBe("legacy-cover");
    expect(output.document.blocks.at(-2)).toMatchObject({
      content: [{ type: "link", href: "https://example.invalid/source" }],
    });
  });
  it("refuses unknown image identity, unsafe citation URL and oversized retained content", () => {
    expect(() => legacyArticleToDocument(legacy(), () => null)).toThrow(
      "article_legacy_reference_unresolved",
    );
    const unsafe = legacy();
    expect(() =>
      legacyArticleToDocument(
        {
          ...unsafe,
          citations: [{ text: "引文", url: "javascript:alert(1)" }],
        },
        resolve,
      ),
    ).toThrow();
    expect(() =>
      legacyArticleToDocument(
        {
          ...unsafe,
          sections: [
            { ...unsafe.sections[0]!, paragraphs: ["字".repeat(40_001)] },
          ],
        },
        resolve,
      ),
    ).toThrow();
    expect(unsafe.sections[0]?.paragraphs).toEqual(["第一段", "第二段\n換行"]);
  });
});
