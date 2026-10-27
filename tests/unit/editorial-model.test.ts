import { describe, expect, it } from "vitest";
import type { Field } from "payload";

import {
  EDITORIAL_FIELD_NAMES,
  EDITORIAL_STATEFUL_FIELDS,
  editorialApproveBatchSchema,
  editorialContentFromDocument,
  editorialDraftSchema,
  editorialPublishApprovedSchema,
  editorialPublishSchema,
  editorialSaveDraftSchema,
  catalogFilterMetadataSchema,
} from "@moya/contracts/internal/editorial";
import { editorialFields } from "admin/fields";
import { publicSourceCitationSchema } from "@moya/contracts/schemas";

/** Unnamed Payload layout fields do not introduce a persisted property. */
const contentFields = (fields: Field[]): Field[] =>
  fields.flatMap((field) => {
    if (field.type === "tabs")
      return field.tabs.flatMap((tab) => contentFields(tab.fields));
    if (field.type === "collapsible" || field.type === "row")
      return contentFields(field.fields);
    return [field];
  });
const nativeFields = contentFields(editorialFields);

const identity = {
  catalogId: "synthetic-catalog-001",
  sourceId: "synthetic-source-001",
  kind: "inscription" as const,
};
const complete = () => ({
  ...identity,
  title: "合成测试碑",
  ...Object.fromEntries(
    EDITORIAL_STATEFUL_FIELDS.map((name) => [name, { state: "UNSUPPLIED" }]),
  ),
});
const media = (position = 0) => ({
  mediaId: `synthetic-media-${position}`,
  objectKey: `synthetic/editorial/${position}.webp`,
  width: 320,
  height: 480,
  alt: "合成图片说明",
  position,
  isRepresentative: position === 0,
});

describe("editorial draft and publication boundaries", () => {
  it("keeps legacy omitted filters absent after native defaults, preserving explicit unknown and values", () => {
    const filters = catalogFilterMetadataSchema.parse({});
    expect(
      editorialContentFromDocument({ ...identity, filterMetadata: filters }),
    ).toEqual(identity);
    filters.dynasty = { state: "UNKNOWN", tokens: "" };
    expect(
      editorialContentFromDocument({ ...identity, filterMetadata: filters })
        .filterMetadata,
    ).toEqual(filters);
    filters.dynasty = { state: "VALUE", tokens: "合成朝代" };
    expect(
      editorialContentFromDocument({ ...identity, filterMetadata: filters })
        .filterMetadata,
    ).toEqual(filters);
  });
  it("accepts an incomplete legal draft while requiring publication completeness", () => {
    expect(editorialDraftSchema.parse(identity)).toEqual({
      ...identity,
      aliases: [],
      provenance: [],
      contributors: [],
      sourceCitations: [],
      media: [],
    });
    expect(editorialPublishSchema.safeParse(identity).success).toBe(false);
    expect(editorialPublishSchema.safeParse(complete()).success).toBe(true);
  });

  it("preserves Chinese original text, internal whitespace, punctuation and newline sequences", () => {
    const original = "傳統字形，𠮷。\r\n甲  乙\n【原文】";
    const candidate = {
      ...complete(),
      transcription: { state: "VALUE", value: original },
      aliases: [{ alias: "傳統異名", aliasType: "historical" }],
      summary: "原文摘要，保留標點。",
    };
    const parsed = editorialPublishSchema.parse(candidate);
    expect(parsed.transcription).toEqual({ state: "VALUE", value: original });
    expect(parsed.aliases).toEqual(candidate.aliases);
    expect(parsed.summary).toBe(candidate.summary);
  });

  it.each([" title", "title ", "\n释文", "释文\n", "\t内容"])(
    "rejects the existing trim boundary without modifying %j",
    (value) => {
      expect(
        editorialDraftSchema.safeParse({ ...identity, title: value }).success,
      ).toBe(false);
      expect(
        editorialPublishSchema.safeParse({
          ...complete(),
          transcription: { state: "VALUE", value },
        }).success,
      ).toBe(false);
    },
  );

  it.each(["\u0000", "\ud800", "\udfff", "甲\ud800乙", "甲\udfff乙"])(
    "rejects NUL and malformed UTF-16 throughout both draft and publication",
    (value) => {
      const candidates = [
        { title: `甲${value}乙` },
        { catalogId: `synthetic${value}id` },
        { ownerNote: `甲${value}乙` },
        { dynasty: { state: "VALUE", value: `甲${value}乙` } },
        { aliases: [{ alias: `甲${value}乙`, aliasType: "alternate" }] },
        {
          provenance: [
            { sourceId: "synthetic-source-002", sourceNote: `甲${value}乙` },
          ],
        },
        { contributors: [{ name: `甲${value}乙`, role: "textAuthor" }] },
        { sourceCitations: [{ label: `甲${value}乙` }] },
        { media: [{ ...media(), rights: `甲${value}乙` }] },
      ];
      for (const candidate of candidates) {
        expect(
          editorialDraftSchema.safeParse({ ...identity, ...candidate }).success,
        ).toBe(false);
        expect(
          editorialPublishSchema.safeParse({ ...complete(), ...candidate })
            .success,
        ).toBe(false);
      }
    },
  );

  it("retains canonical field state combinations and rejects incompatible content", () => {
    for (const state of ["UNSUPPLIED", "UNKNOWN", "NOT_APPLICABLE", "CLEAR"]) {
      const parsed = editorialPublishSchema.parse({
        ...complete(),
        dynasty: { state },
      });
      expect(parsed.dynasty).toEqual({ state });
    }
    for (const field of [
      "description",
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ]) {
      for (const state of ["UNKNOWN", "NOT_APPLICABLE"]) {
        expect(
          editorialDraftSchema.safeParse({ ...identity, [field]: { state } })
            .success,
        ).toBe(false);
      }
    }
    for (const dynasty of [
      { state: "VALUE" },
      { state: "VALUE", value: "" },
      { state: "UNKNOWN", value: "某朝" },
      { state: "UNSET" },
    ]) {
      expect(
        editorialDraftSchema.safeParse({ ...identity, dynasty }).success,
      ).toBe(false);
    }
  });

  it("preserves canonical text limits", () => {
    for (const [field, maximum] of [
      ["dynasty", 500],
      ["scriptStyle", 2_000],
      ["description", 20_000],
      ["transcription", 100_000],
      ["historicalContext", 20_000],
      ["scholarlyResearch", 20_000],
    ] as const) {
      expect(
        editorialPublishSchema.safeParse({
          ...complete(),
          [field]: { state: "VALUE", value: "甲".repeat(maximum) },
        }).success,
      ).toBe(true);
      expect(
        editorialDraftSchema.safeParse({
          ...identity,
          [field]: { state: "VALUE", value: "甲".repeat(maximum + 1) },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects mixed identity, invalid kind and unexpected public or system fields", () => {
    for (const patch of [
      { sourceId: identity.catalogId },
      { kind: "painting" },
      { catalogId: "identity with whitespace" },
      { sourceId: "" },
      { provenance: [{ sourceId: identity.catalogId }] },
      { role: "owner" },
      { _status: "published" },
      { src: "https://example.invalid/image.webp" },
    ]) {
      expect(
        editorialDraftSchema.safeParse({ ...identity, ...patch }).success,
      ).toBe(false);
    }
  });

  it("validates embedded relationship uniqueness and contributor roles", () => {
    for (const patch of [
      {
        aliases: [
          { alias: "重名", aliasType: "alternate" },
          { alias: "重名", aliasType: "historical" },
        ],
      },
      {
        provenance: [
          { sourceId: "synthetic-source-002" },
          { sourceId: "synthetic-source-002" },
        ],
      },
      {
        contributors: [
          { name: "合成作者", role: "textAuthor" },
          { name: "合成作者", role: "textAuthor" },
        ],
      },
      { contributors: [{ name: "合成作者", role: "institution" }] },
      {
        sourceCitations: [
          { label: "合成来源", appliesTo: ["record", "record"] },
        ],
      },
      {
        contributors: Array.from({ length: 51 }, (_, index) => ({
          name: `合成作者${index}`,
          role: "textAuthor",
        })),
      },
    ]) {
      expect(
        editorialDraftSchema.safeParse({ ...identity, ...patch }).success,
      ).toBe(false);
    }
    expect(
      editorialPublishSchema.safeParse({
        ...complete(),
        contributors: [
          { name: "合成作者", role: "textAuthor" },
          { name: "合成作者", role: "calligrapher" },
        ],
      }).success,
    ).toBe(true);
  });

  it("allows missing images and enforces publication media uniqueness, order and representative", () => {
    expect(editorialPublishSchema.parse(complete()).media).toEqual([]);
    expect(
      editorialPublishSchema.parse({
        ...complete(),
        media: [
          media(),
          { ...media(2), orderConfidence: "LOW", rights: "合成权利说明" },
        ],
      }).media[1]?.orderConfidence,
    ).toBe("LOW");
    for (const images of [
      [media(), { ...media(1), mediaId: media().mediaId }],
      [media(), { ...media(1), objectKey: media().objectKey }],
      [media(), { ...media(1), position: 0 }],
      [media(1), media()],
      [{ ...media(), isRepresentative: false }],
      [media(), { ...media(1), isRepresentative: true }],
      [{ ...media(), width: 0 }],
      [{ ...media(), width: 2_147_483_648 }],
      [{ ...media(), height: 2_147_483_648 }],
      [{ ...media(), position: 0.5 }],
      [{ ...media(), orderConfidence: "CERTAIN" }],
    ]) {
      expect(
        editorialPublishSchema.safeParse({ ...complete(), media: images })
          .success,
      ).toBe(false);
    }
    expect(
      editorialDraftSchema.safeParse({
        ...identity,
        media: [{ ...media(), isRepresentative: false }],
      }).success,
    ).toBe(true);
  });

  it("extracts Payload content without carrying metadata or mutating original text", () => {
    const original = {
      ...identity,
      id: 123,
      _status: "draft",
      revision: 4,
      summary: null,
      aliases: [
        { id: "synthetic-row-001", alias: "原文異名", aliasType: "alternate" },
      ],
      dynasty: { state: "UNSUPPLIED", value: null },
      ownerNote: "内部合成备注",
    };
    const input = editorialContentFromDocument(original);
    expect(input).toEqual({
      ...identity,
      aliases: [{ alias: "原文異名", aliasType: "alternate" }],
      dynasty: { state: "UNSUPPLIED" },
      ownerNote: "内部合成备注",
    });
    expect(editorialDraftSchema.safeParse(input).success).toBe(true);
    expect(original.aliases[0]?.id).toBe("synthetic-row-001");
    expect(
      editorialContentFromDocument({ ...identity, title: " 原文 " }).title,
    ).toBe(" 原文 ");
  });

  it("adapts only empty native citation scopes while preserving text and order", () => {
    const unscoped = {
      label: "合成無範圍引用",
      citation: "異體字𠮷\r\n甲  乙",
    };
    const scoped = {
      label: "合成指定範圍引用",
      citation: "第二條\n〔闕〕",
      url: "https://example.invalid/synthetic-citation",
      appliesTo: ["scholarlyResearch", "record"],
    };
    const original = {
      ...identity,
      aliases: [],
      sourceCitations: [
        { ...unscoped, id: "synthetic-citation-001", appliesTo: [] },
        { ...scoped, id: "synthetic-citation-002" },
        { label: "合成已省略範圍引用" },
      ],
    };
    const unchanged = structuredClone(original);
    const content = editorialContentFromDocument(original);
    expect(content).toEqual({
      ...identity,
      aliases: [],
      sourceCitations: [unscoped, scoped, { label: "合成已省略範圍引用" }],
    });
    expect(editorialDraftSchema.safeParse(content).success).toBe(true);
    expect(original).toEqual(unchanged);
    expect(
      publicSourceCitationSchema.safeParse({ ...unscoped, appliesTo: [] })
        .success,
    ).toBe(false);
    expect(
      editorialSaveDraftSchema.safeParse({
        idempotencyKey: "synthetic-explicit-empty-scopes",
        content: {
          ...identity,
          sourceCitations: [{ ...unscoped, appliesTo: [] }],
        },
      }).success,
    ).toBe(false);
  });
});

describe("native Chinese Payload fields and bounded automation input", () => {
  it("provides independently allocated valid identities for native new-record forms", async () => {
    const defaults: Record<string, unknown> = {};
    for (const name of ["catalogId", "sourceId"]) {
      const field = nativeFields.find(
        (candidate) => "name" in candidate && candidate.name === name,
      );
      expect(
        field &&
          "defaultValue" in field &&
          typeof field.defaultValue === "function",
      ).toBe(true);
      if (
        !field ||
        !("defaultValue" in field) ||
        typeof field.defaultValue !== "function"
      ) {
        throw new Error("Missing native identity allocation");
      }
      defaults[name] = await Reflect.apply(field.defaultValue, undefined, []);
      const nextIdentity = await Reflect.apply(
        field.defaultValue,
        undefined,
        [],
      );
      expect(defaults[name]).not.toBe(nextIdentity);
    }
    expect(defaults.catalogId).not.toBe(defaults.sourceId);
    expect(
      editorialDraftSchema.safeParse({ ...defaults, kind: "inscription" })
        .success,
    ).toBe(true);
  });

  it("covers every content field with native controls and Chinese labels", () => {
    const names = nativeFields.flatMap((field) =>
      "name" in field && field.type !== "ui" ? [field.name] : [],
    );
    expect(new Set(names)).toEqual(new Set(EDITORIAL_FIELD_NAMES));
    expect(names).toHaveLength(EDITORIAL_FIELD_NAMES.length);
    expect(
      nativeFields.find(
        (field) => "name" in field && field.name === "mediaPicker",
      ),
    ).toMatchObject({
      type: "ui",
      label: expect.stringMatching(/[\u3400-\u9fff]/),
      admin: {
        components: {
          Field: "./src/media/MediaSnapshotPicker#MediaSnapshotPicker",
        },
      },
    });
    for (const field of nativeFields) {
      expect(field.type).not.toBe("json");
      expect(field.type).not.toBe("richText");
      if (!("label" in field)) throw new Error("Missing native field label");
      expect(typeof field.label).toBe("string");
      expect(field.label).toMatch(/[\u3400-\u9fff]/);
    }
    const transcription = nativeFields.find(
      (field) => "name" in field && field.name === "transcription",
    );
    expect(transcription).toMatchObject({
      type: "group",
      fields: [
        { name: "state", type: "select" },
        { name: "value", type: "textarea", maxLength: 100_000 },
      ],
    });
  });

  it("requires bounded idempotency and explicit unchanged revision publication", () => {
    expect(
      editorialSaveDraftSchema.safeParse({
        content: identity,
        idempotencyKey: "synthetic-batch:item-001",
      }).success,
    ).toBe(true);
    expect(
      editorialSaveDraftSchema.safeParse({
        content: identity,
        idempotencyKey: "bad key",
      }).success,
    ).toBe(false);
    expect(
      editorialSaveDraftSchema.safeParse({
        content: identity,
        idempotencyKey: "synthetic-batch-001",
        publish: true,
      }).success,
    ).toBe(false);
    expect(
      editorialApproveBatchSchema.safeParse({
        automationUserId: 2,
        items: [{ id: 1, revision: 3 }],
      }).success,
    ).toBe(true);
    expect(
      editorialApproveBatchSchema.safeParse({
        automationUserId: 2,
        items: [
          { id: 1, revision: 3 },
          { id: "1", revision: 3 },
        ],
      }).success,
    ).toBe(false);
    expect(
      editorialPublishApprovedSchema.safeParse({
        approvalId: 1,
        id: 2,
        idempotencyKey: "synthetic-publish-001",
        content: complete(),
      }).success,
    ).toBe(false);
  });
});
