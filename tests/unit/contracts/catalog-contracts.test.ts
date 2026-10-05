import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CatalogCitationScope,
  CatalogContributor,
  CatalogContributorRole,
  CatalogDetail,
  CatalogId,
  CatalogKind,
  CatalogListTransportQuery,
  CatalogPage,
  CatalogSummary,
  MediaId,
  MediaRendition,
  PublicMedia,
  PublicSourceCitation,
} from "@moya/contracts";
import {
  catalogCitationScopeJsonSchema,
  catalogContributorJsonSchema,
  catalogContributorRoleJsonSchema,
  catalogDetailJsonSchema,
  catalogIdJsonSchema,
  catalogKindJsonSchema,
  catalogListTransportQueryJsonSchema,
  catalogPageJsonSchema,
  catalogSummaryJsonSchema,
  mediaIdJsonSchema,
  noQueryTransportJsonSchema,
  publicMediaJsonSchema,
  publicSourceCitationJsonSchema,
} from "@moya/contracts/json-schema";
import {
  catalogCitationScopeSchema,
  catalogContributorRoleSchema,
  catalogContributorSchema,
  catalogDetailSchema,
  catalogIdSchema,
  catalogKindSchema,
  catalogListTransportQuerySchema,
  catalogPageSchema,
  catalogSummarySchema,
  mediaIdSchema,
  noQueryTransportSchema,
  publicMediaSchema,
  publicSourceCitationSchema,
} from "@moya/contracts/schemas";

describe("canonical Catalog identity", () => {
  it("keeps CatalogId opaque and source-format-independent", () => {
    const valid = [
      "catalog-001",
      "platform-item-any-format",
      "碑刻-甲",
      "x".repeat(128),
    ];
    const invalid = ["", " ", "catalog item", "catalog\nitem", "x".repeat(129)];

    for (const candidate of valid) {
      expect(catalogIdSchema.safeParse(candidate).success).toBe(true);
    }
    for (const candidate of invalid) {
      expect(catalogIdSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("exports the canonical CatalogId JSON Schema", () => {
    expect(catalogIdJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^\\S+$",
    });
  });
});

describe("CatalogKind", () => {
  it("accepts exactly the two stable top-level values", () => {
    const kinds: CatalogKind[] = ["inscription", "calligraphy"];

    for (const kind of kinds) {
      expect(catalogKindSchema.parse(kind)).toBe(kind);
    }
    for (const kind of [
      "cliff_inscription",
      "seal",
      "painting",
      "sculpture",
      "video",
    ]) {
      expect(catalogKindSchema.safeParse(kind).success).toBe(false);
    }

    expect(catalogKindSchema.options).toEqual(kinds);
    expect(catalogKindJsonSchema).toMatchObject({
      enum: kinds,
      type: "string",
    });
  });
});

describe("Catalog Media public identity and contract", () => {
  it("keeps MediaId distinct and validates the approved strict shape", () => {
    const id: MediaId = mediaIdSchema.parse("media-example-001");
    const media: PublicMedia = {
      id,
      kind: "image",
      src: "https://media.example.invalid/example.jpg",
      alt: "虚构碑刻图像",
      width: 1_200,
      height: 1_600,
    };

    expect(publicMediaSchema.parse(media)).toEqual(media);
    expect(
      publicMediaSchema.parse({
        ...media,
        src: "http://localhost:3000/media/example.jpg",
      }).src,
    ).toBe("http://localhost:3000/media/example.jpg");
    expectTypeOf<MediaId>().not.toEqualTypeOf<CatalogId>();
    expect(mediaIdSchema.safeParse("media id").success).toBe(false);
    expect(mediaIdJsonSchema).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^\\S+$",
    });
    expect(publicMediaJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        src: {
          allOf: [
            { format: "uri", type: "string" },
            {
              pattern: "^[Hh][Tt][Tt][Pp][Ss]?:\\/\\/",
              type: "string",
            },
          ],
        },
      },
      type: "object",
      required: ["id", "kind", "src", "alt", "width", "height"],
    });
  });

  it.each([
    "mailto:noreply@example.com",
    "file:///tmp/media.jpg",
    "data:image/png;base64,iVBORw0KGgo=",
    "javascript:alert('media')",
    "ftp://example.com/media.jpg",
  ])("rejects non-Web Media src scheme: %s", (src) => {
    expect(
      publicMediaSchema.safeParse({
        id: mediaIdSchema.parse("media-invalid-protocol"),
        kind: "image",
        src,
        alt: "无效协议测试图",
        width: 800,
        height: 600,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid display metadata and every storage-private field", () => {
    const valid = {
      id: mediaIdSchema.parse("media-example-002"),
      kind: "image",
      src: "https://media.example.invalid/example-002.jpg",
      alt: "有效替代文字",
      width: 800,
      height: 600,
    };

    for (const invalid of [
      { ...valid, src: "not-a-url" },
      { ...valid, alt: "" },
      { ...valid, alt: " padded " },
      { ...valid, width: 0 },
      { ...valid, height: -1 },
      { ...valid, kind: "video" },
      { ...valid, objectKey: "private/example.jpg" },
      { ...valid, bucket: "private" },
      { ...valid, storageProvider: "provider" },
      { ...valid, resolverConfiguration: "private" },
    ]) {
      expect(publicMediaSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("anchors finite rendition candidates at src with an optional placeholder colour", () => {
    // unified-media-pipeline-v1: resolved candidates may be signed, like src.
    const signed = (name: string) =>
      `https://media.example.invalid/${name}.webp?sign=${"0".repeat(32)}&expires=300`;
    const renditions: MediaRendition[] = [
      {
        src: signed("thumb"),
        width: 480,
        height: 320,
        contentType: "image/webp",
      },
      {
        src: signed("cover"),
        width: 1_080,
        height: 720,
        contentType: "image/webp",
      },
      {
        src: signed("display"),
        width: 2_048,
        height: 1_365,
        contentType: "image/webp",
      },
      {
        src: signed("viewer"),
        width: 4_096,
        height: 2_731,
        contentType: "image/webp",
      },
    ];
    const media: PublicMedia = {
      id: mediaIdSchema.parse("media-example-003"),
      kind: "image",
      src: signed("display"),
      alt: "有候选尺寸的图像",
      width: 2_048,
      height: 1_365,
      renditions,
      placeholderColor: "#5f6f58",
    };
    const legacy = {
      id: media.id,
      kind: media.kind,
      src: "https://media.example.invalid/legacy.webp",
      alt: media.alt,
      width: 4_096,
      height: 2_731,
    };

    expect(publicMediaSchema.parse(media)).toEqual(media);
    // Production keeps the legacy object; its colour needs no candidates.
    expect(publicMediaSchema.parse(legacy)).toEqual(legacy);
    expect(
      publicMediaSchema.safeParse({ ...legacy, placeholderColor: "#000000" })
        .success,
    ).toBe(true);
    expect(
      catalogDetailSchema.safeParse({
        ...catalogDetail,
        representativeMedia: media,
        media: [media, publicRepresentativeMedia],
      }).success,
    ).toBe(true);
    const replaced = (index: number, entry: Record<string, unknown>) =>
      renditions.map((rendition, at) =>
        at === index ? { ...rendition, ...entry } : rendition,
      );
    for (const invalid of [
      // src is not one of the candidates.
      { ...legacy, renditions },
      { ...media, src: signed("full") },
      { ...media, renditions: [] },
      { ...media, renditions: replaced(0, { src: "/media/thumb.webp" }) },
      { ...media, renditions: replaced(1, { contentType: "image/png" }) },
      { ...media, placeholderColor: "#5F6F58" },
      { ...media, placeholderColor: "#abc" },
      // A 1:1 cover crop never shares a full-frame list or a 3:2 parent.
      { ...media, renditions: replaced(0, { width: 480, height: 480 }) },
      {
        ...media,
        renditions: [
          { ...renditions[0]!, width: 480, height: 480 },
          { ...renditions[2]!, width: 1_080, height: 1_080 },
        ],
      },
      { ...media, width: 1_080, height: 1_080 },
      { ...media, renditions: [...renditions].reverse() },
      { ...media, renditions: replaced(2, { objectKey: "display/v1/a.webp" }) },
      { ...media, renditions: replaced(2, { bucket: "private" }) },
      { ...media, renditions: replaced(2, { role: "display" }) },
    ]) {
      expect(
        publicMediaSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    }
  });
});

const catalogId = catalogIdSchema.parse("catalog-example-001");
const publicRepresentativeMedia: PublicMedia = {
  id: mediaIdSchema.parse("media-example-representative"),
  kind: "image",
  src: "https://media.example.invalid/representative.jpg",
  alt: "虚构摩崖甲代表图",
  width: 1_600,
  height: 1_200,
};

const catalogSummary: CatalogSummary = {
  id: catalogId,
  kind: "inscription",
  title: "虚构摩崖甲",
  aliases: ["虚构别名"],
  summary: "公开摘要",
  periodLabel: "唐",
  representativeMedia: publicRepresentativeMedia,
};

const catalogDetail: CatalogDetail = {
  ...catalogSummary,
  description: "公开详情",
  sourceCitations: [
    {
      label: "虚构公开名录",
      citation: "第 1 页",
      url: "https://example.com/catalogue",
    },
  ],
  media: [publicRepresentativeMedia],
};

describe("Catalog public contracts", () => {
  it("accepts the frozen summary and detail fields", () => {
    expect(catalogSummarySchema.parse(catalogSummary)).toEqual(catalogSummary);
    expect(catalogDetailSchema.parse(catalogDetail)).toEqual(catalogDetail);
  });

  it("keeps Media optional on summaries and an empty Gallery valid on details", () => {
    const mediaLessSummary = { ...catalogSummary };
    delete mediaLessSummary.representativeMedia;
    const mediaLessDetail: CatalogDetail = {
      ...mediaLessSummary,
      sourceCitations: [],
      media: [],
    };

    expect(catalogSummarySchema.parse(mediaLessSummary)).toEqual(
      mediaLessSummary,
    );
    expect(catalogDetailSchema.parse(mediaLessDetail)).toEqual(mediaLessDetail);
  });

  it("rejects internal-only fields under the strict public policy", () => {
    for (const field of [
      "sourceId",
      "rawSource",
      "rawRegion",
      "evidence",
      "verificationState",
      "humanDecision",
      "ownerDecision",
      "workflowNotes",
      "adminNotes",
      "objectKey",
      "storagePath",
      "storageProvider",
      "internalRightsNotes",
      "migrationMetadata",
    ]) {
      expect(
        catalogDetailSchema.safeParse({
          ...catalogDetail,
          [field]: "internal-only",
        }).success,
      ).toBe(false);
    }

    expect(
      catalogDetailSchema.safeParse({
        ...catalogDetail,
        sourceCitations: [
          {
            ...catalogDetail.sourceCitations[0],
            sourceId: "source-internal-001",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps transport query values as validated strings", () => {
    const query: CatalogListTransportQuery = {
      kind: "calligraphy",
      page: "2",
      pageSize: "25",
    };

    expect(catalogListTransportQuerySchema.parse(query)).toEqual(query);
    expect(catalogListTransportQuerySchema.parse({})).toEqual({});
    for (const invalid of [
      { page: "0" },
      { page: "01" },
      { page: "1.5" },
      { page: "9007199254740992" },
      { pageSize: "101" },
      { kind: "cliff_inscription" },
      { kind: ["inscription", "calligraphy"] },
      { pageSize: 20 },
      { keyword: "碑" },
    ]) {
      expect(catalogListTransportQuerySchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("rejects every query key for endpoints that declare no query", () => {
    expect(noQueryTransportSchema.parse({})).toEqual({});
    expect(
      noQueryTransportSchema.safeParse({ probe: "readiness" }).success,
    ).toBe(false);
    expect(noQueryTransportJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
  });

  it("uses the existing self-consistent pagination model", () => {
    const page: CatalogPage = {
      items: [catalogSummary],
      total: 2,
      page: 1,
      pageSize: 1,
      totalPages: 2,
    };

    expect(catalogPageSchema.parse(page)).toEqual(page);
    expect(
      catalogPageSchema.safeParse({ ...page, totalPages: 1 }).success,
    ).toBe(false);
    expect(catalogPageSchema.safeParse({ ...page, page: 3 }).success).toBe(
      false,
    );
    expect(
      catalogPageSchema.parse({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
      }),
    ).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
  });

  it("exports strict Draft 2020-12 JSON Schemas", () => {
    for (const schema of [
      catalogSummaryJsonSchema,
      catalogDetailJsonSchema,
      publicMediaJsonSchema,
      catalogListTransportQueryJsonSchema,
      catalogPageJsonSchema,
    ]) {
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
    }
    expect(catalogListTransportQueryJsonSchema).toMatchObject({
      properties: {
        kind: { enum: ["inscription", "calligraphy"], type: "string" },
      },
    });
  });
});

describe("Catalog Content V1 detail contract", () => {
  const legacyDetail = {
    id: catalogId,
    kind: "inscription" as const,
    title: "示例碑刻",
    aliases: [],
    sourceCitations: [{ label: "示例来源" }],
    media: [],
  };

  const contentFields = [
    ["scriptStyle", 2_000],
    ["transcription", 100_000],
    ["historicalContext", 20_000],
    ["scholarlyResearch", 20_000],
  ] as const;

  it("keeps old Detail payloads and citations valid without injecting optional properties", () => {
    const parsed = catalogDetailSchema.parse(legacyDetail);

    expect(parsed).toEqual(legacyDetail);
    for (const property of [
      "contributors",
      "scriptStyle",
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ]) {
      expect(parsed).not.toHaveProperty(property);
      expect(Object.hasOwn(parsed, property)).toBe(false);
    }
    expect(parsed.sourceCitations[0]).not.toHaveProperty("appliesTo");
    expect(Object.hasOwn(parsed.sourceCitations[0] ?? {}, "appliesTo")).toBe(
      false,
    );
  });

  it("accepts a full Detail and preserves curated contributor and text order", () => {
    const fullDetail = {
      ...legacyDetail,
      contributors: [
        { name: "魏徵", role: "textAuthor" as const },
        { name: "欧阳询", role: "calligrapher" as const },
      ],
      scriptStyle: "楷书",
      description: "简介内容",
      transcription: "第一行释文\n第二行释文",
      historicalContext: "第一段历史背景\n第二段历史背景",
      scholarlyResearch: "第一段学术研究\n第二段学术研究",
      sourceCitations: [
        {
          label: "示例著录",
          appliesTo: ["record", "description"] as const,
        },
        {
          label: "示例释文研究",
          citation: "第 10–20 页",
          appliesTo: ["transcription"] as const,
        },
      ],
    };

    const parsed = catalogDetailSchema.parse(fullDetail);

    expect(parsed).toEqual(fullDetail);
    expect(parsed.contributors).toEqual(fullDetail.contributors);
    expect(parsed.transcription).toBe("第一行释文\n第二行释文");
    expect(parsed.historicalContext).toBe("第一段历史背景\n第二段历史背景");
    expect(parsed.scholarlyResearch).toBe("第一段学术研究\n第二段学术研究");
  });

  it("keeps citation applicability independent from content completeness", () => {
    expect(
      catalogDetailSchema.safeParse({
        ...legacyDetail,
        sourceCitations: [
          { label: "仅有范围的来源", appliesTo: ["transcription"] },
        ],
      }).success,
    ).toBe(true);
    expect(
      catalogDetailSchema.safeParse({
        ...legacyDetail,
        transcription: "已有释文但尚无对应范围来源",
        sourceCitations: [],
      }).success,
    ).toBe(true);
  });

  it("exports the exact contributor roles and inferred public types", () => {
    const roles: CatalogContributorRole[] = ["textAuthor", "calligrapher"];
    const contributor: CatalogContributor = {
      name: "欧阳询",
      role: "calligrapher",
    };
    const scopes: CatalogCitationScope[] = [
      "record",
      "description",
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ];

    expect(catalogContributorRoleSchema.options).toEqual(roles);
    expect(catalogCitationScopeSchema.options).toEqual(scopes);
    expect(catalogContributorSchema.parse(contributor)).toEqual(contributor);
    expectTypeOf<CatalogDetail["contributors"]>().toEqualTypeOf<
      CatalogContributor[] | undefined
    >();
    expectTypeOf<PublicSourceCitation["appliesTo"]>().toEqualTypeOf<
      CatalogCitationScope[] | undefined
    >();
  });

  it("accepts both roles and the same name under different roles", () => {
    const contributors: CatalogContributor[] = [
      { name: "同名人物", role: "textAuthor" },
      { name: "同名人物", role: "calligrapher" },
    ];

    expect(
      catalogDetailSchema.parse({ ...legacyDetail, contributors }).contributors,
    ).toEqual(contributors);
  });

  it("enforces contributor name and array boundaries", () => {
    const maximumName = "名".repeat(500);
    const maximumContributors: CatalogContributor[] = Array.from(
      { length: 50 },
      (_, index) => ({ name: `贡献者${index}`, role: "textAuthor" }),
    );

    expect(
      catalogDetailSchema.safeParse({
        ...legacyDetail,
        contributors: [{ name: maximumName, role: "textAuthor" }],
      }).success,
    ).toBe(true);
    expect(
      catalogDetailSchema.safeParse({
        ...legacyDetail,
        contributors: maximumContributors,
      }).success,
    ).toBe(true);

    for (const contributors of [
      [],
      null,
      [null],
      [{ name: "", role: "textAuthor" }],
      [{ name: " 撰者", role: "textAuthor" }],
      [{ name: "撰者 ", role: "textAuthor" }],
      [{ name: "名".repeat(501), role: "textAuthor" }],
      [{ name: "撰者", role: "author" }],
      [{ name: "撰者", role: "textAuthor", biography: "内部字段" }],
      [
        { name: "重复人物", role: "textAuthor" },
        { role: "textAuthor", name: "重复人物" },
      ],
      [
        ...maximumContributors,
        { name: "第 51 位贡献者", role: "calligrapher" },
      ],
    ]) {
      expect(
        catalogDetailSchema.safeParse({ ...legacyDetail, contributors })
          .success,
      ).toBe(false);
    }
  });

  it("rejects generic top-level attribution properties", () => {
    for (const property of ["author", "calligrapher"]) {
      expect(
        catalogDetailSchema.safeParse({
          ...legacyDetail,
          [property]: "未经许可的泛化署名",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts internal newlines in long-form plain text", () => {
    for (const property of [
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ]) {
      const value = "第一行\n第二行";
      expect(
        catalogDetailSchema.parse({ ...legacyDetail, [property]: value }),
      ).toHaveProperty(property, value);
    }
  });

  it.each(contentFields)(
    "enforces the exact %s length limit",
    (property, maximum) => {
      expect(
        catalogDetailSchema.safeParse({
          ...legacyDetail,
          [property]: "文".repeat(maximum),
        }).success,
      ).toBe(true);
      expect(
        catalogDetailSchema.safeParse({
          ...legacyDetail,
          [property]: "文".repeat(maximum + 1),
        }).success,
      ).toBe(false);
    },
  );

  it.each(contentFields)(
    "rejects empty, padded, and null %s values",
    (property) => {
      for (const invalid of ["", " padded", "padded ", null]) {
        expect(
          catalogDetailSchema.safeParse({
            ...legacyDetail,
            [property]: invalid,
          }).success,
        ).toBe(false);
      }
    },
  );

  it("rejects arbitrary extra Detail content fields", () => {
    expect(
      catalogDetailSchema.safeParse({
        ...legacyDetail,
        transcriptionRichText: { type: "document" },
      }).success,
    ).toBe(false);
  });
});

describe("Catalog Content V1 citation scopes", () => {
  const citationScopes = [
    "record",
    "description",
    "transcription",
    "historicalContext",
    "scholarlyResearch",
  ] as const satisfies readonly CatalogCitationScope[];

  it("accepts omission without mutation", () => {
    const legacyCitation = { label: "旧有来源" } satisfies PublicSourceCitation;
    const parsed = publicSourceCitationSchema.parse(legacyCitation);

    expect(parsed).toEqual(legacyCitation);
    expect(parsed).not.toHaveProperty("appliesTo");
    expect(Object.hasOwn(parsed, "appliesTo")).toBe(false);
  });

  it.each(citationScopes)("accepts the exact %s scope", (scope) => {
    expect(
      publicSourceCitationSchema.parse({
        label: "范围来源",
        appliesTo: [scope],
      }).appliesTo,
    ).toEqual([scope]);
  });

  it("accepts all five unique scopes on one citation", () => {
    expect(
      publicSourceCitationSchema.parse({
        label: "全范围来源",
        appliesTo: citationScopes,
      }).appliesTo,
    ).toEqual(citationScopes);
  });

  it("rejects invalid citation scope arrays", () => {
    for (const appliesTo of [
      [],
      null,
      ["unknown"],
      ["record", "record"],
      [...citationScopes, "record"],
    ]) {
      expect(
        publicSourceCitationSchema.safeParse({
          label: "无效范围来源",
          appliesTo,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps internal citation metadata out of the public Contract", () => {
    for (const property of [
      "citationId",
      "sourceId",
      "paragraphAnchor",
      "sentenceAnchor",
      "fieldPath",
      "footnoteNumber",
      "bibliographyId",
    ]) {
      expect(
        publicSourceCitationSchema.safeParse({
          label: "内部字段测试",
          [property]: "internal-only",
        }).success,
      ).toBe(false);
    }
  });
});

describe("Catalog Content V1 summary and JSON Schema boundaries", () => {
  const newDetailFields = [
    "contributors",
    "scriptStyle",
    "transcription",
    "historicalContext",
    "scholarlyResearch",
  ] as const;

  it("keeps every new field out of CatalogSummary", () => {
    expect(catalogSummarySchema.parse(catalogSummary)).toEqual(catalogSummary);

    for (const property of newDetailFields) {
      expect(
        catalogSummarySchema.safeParse({
          ...catalogSummary,
          [property]: property === "contributors" ? [] : "not-summary-data",
        }).success,
      ).toBe(false);
    }
  });

  it("exports strict standalone Draft 2020-12 contributor and scope schemas", () => {
    expect(catalogContributorRoleJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      enum: ["textAuthor", "calligrapher"],
    });
    expect(catalogCitationScopeJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      enum: [
        "record",
        "description",
        "transcription",
        "historicalContext",
        "scholarlyResearch",
      ],
    });
    expect(catalogContributorJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["name", "role"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 500 },
        role: { type: "string", enum: ["textAuthor", "calligrapher"] },
      },
    });
  });

  it("represents all Detail-only fields as optional with exact JSON Schema bounds", () => {
    expect(catalogDetailJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        contributors: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "role"],
          },
        },
        scriptStyle: { type: "string", minLength: 1, maxLength: 2_000 },
        transcription: {
          type: "string",
          minLength: 1,
          maxLength: 100_000,
        },
        historicalContext: {
          type: "string",
          minLength: 1,
          maxLength: 20_000,
        },
        scholarlyResearch: {
          type: "string",
          minLength: 1,
          maxLength: 20_000,
        },
      },
      required: ["id", "kind", "title", "aliases", "sourceCitations", "media"],
    });

    const summaryProperties = Object.keys(
      catalogSummaryJsonSchema.properties ?? {},
    );
    const detailRequired = catalogDetailJsonSchema.required ?? [];
    for (const property of newDetailFields) {
      expect(summaryProperties).not.toContain(property);
      expect(detailRequired).not.toContain(property);
    }
  });

  it("keeps label required and appliesTo optional with exact JSON Schema bounds", () => {
    expect(publicSourceCitationJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        appliesTo: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: {
            type: "string",
            enum: [
              "record",
              "description",
              "transcription",
              "historicalContext",
              "scholarlyResearch",
            ],
          },
        },
      },
    });
    expect(publicSourceCitationJsonSchema.required).not.toContain("appliesTo");
    expect(publicSourceCitationJsonSchema).not.toHaveProperty(
      "properties.appliesTo.default",
    );
  });
});
