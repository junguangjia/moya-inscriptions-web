import { afterEach, describe, expect, it, vi } from "vitest";

import {
  toCatalogDetailPresentation,
  toWorkMediaPresentation,
  toWorkAuthorshipPresentation,
} from "./catalog-detail-presentation";

import type { CatalogDetail, CatalogId, MediaId } from "@moya/contracts";

const completeDetail = {
  aliases: ["别名"],
  county: "县",
  contributors: [
    { name: "第二位撰文者", role: "textAuthor" },
    { name: "书者", role: "calligrapher" },
    { name: "第一位撰文者", role: "textAuthor" },
  ],
  currentCustodian: "现藏单位",
  currentLocation: "现址",
  dateText: "某年",
  description: "简介正文",
  dynasty: "某朝",
  historicalContext: "历史背景正文",
  id: "catalog-complete" as CatalogId,
  kind: "inscription",
  media: [
    {
      alt: "详情图像",
      height: 600,
      id: "media-detail" as MediaId,
      kind: "image",
      src: "https://example.test/detail.jpg",
      width: 400,
    },
  ],
  periodLabel: "时期",
  prefecture: "府",
  province: "省",
  scholarlyResearch: "学术研究正文",
  scriptStyle: "碑额篆书，正文楷书",
  sourceCitations: [
    { label: "旧来源" },
    {
      appliesTo: ["transcription", "historicalContext"],
      citation: "多范围引文",
      label: "分区来源",
      url: "https://example.test/source",
    },
  ],
  summary: "摘要",
  title: "完整详情",
  transcription: "第一行释文\n第二行释文",
} satisfies CatalogDetail;

describe("Catalog Detail presentation", () => {
  it("maps Content V1 in fixed order without repeating period chronology", () => {
    const presentation = toCatalogDetailPresentation(completeDetail, "runtime");

    expect(presentation).toMatchObject({
      facts: [
        { label: "撰文者", value: "第二位撰文者" },
        { label: "书者", value: "书者" },
        { label: "撰文者", value: "第一位撰文者" },
        { label: "书体", value: "碑额篆书，正文楷书" },
        { label: "地区", value: "省 · 府 · 县" },
        { label: "现址", value: "现址" },
        { label: "现藏单位", value: "现藏单位" },
      ],
      sections: [
        { key: "description", text: "简介正文", title: "简介" },
        {
          key: "transcription",
          text: "第一行释文\n第二行释文",
          title: "释文",
        },
        {
          key: "historicalContext",
          text: "历史背景正文",
          title: "历史背景",
        },
        {
          key: "scholarlyResearch",
          text: "学术研究正文",
          title: "学术研究",
        },
      ],
      sourceCitations: [
        { label: "旧来源", scopeLabel: "整体资料" },
        {
          citation: "多范围引文",
          label: "分区来源",
          scopeLabel: "释文、历史背景",
          url: "https://example.test/source",
        },
      ],
      source: "runtime",
      summary: "摘要",
    });
    expect(completeDetail.sourceCitations[0]).not.toHaveProperty("appliesTo");
  });

  it("uses dynasty and dateText only when periodLabel is absent", () => {
    const presentation = toCatalogDetailPresentation(
      {
        aliases: [],
        dateText: "某年",
        dynasty: "某朝",
        id: "catalog-partial" as CatalogId,
        kind: "calligraphy",
        media: [],
        representativeMedia: completeDetail.media[0],
        sourceCitations: [],
        title: "部分详情",
      },
      "qa",
    );

    expect(presentation.media).toEqual(completeDetail.media);
    expect(presentation.facts).toEqual([
      { label: "朝代", value: "某朝" },
      { label: "年代", value: "某年" },
    ]);
    expect(presentation.sections).toEqual([]);
    expect(presentation.source).toBe("qa");
    expect(presentation.sourceCitations).toEqual([]);
  });

  it("omits every absent optional fact and content section", () => {
    const presentation = toCatalogDetailPresentation(
      {
        aliases: [],
        id: "catalog-sparse" as CatalogId,
        kind: "inscription",
        media: [],
        sourceCitations: [
          {
            appliesTo: ["historicalContext"],
            label: "缺失正文仍保留的来源",
          },
        ],
        title: "稀疏详情",
      },
      "runtime",
    );

    expect(presentation.facts).toEqual([]);
    expect(presentation.sections).toEqual([]);
    expect(presentation.sourceCitations).toEqual([
      { label: "缺失正文仍保留的来源", scopeLabel: "历史背景" },
    ]);
  });
});

describe("Work media presentation", () => {
  it("carries the full derivative for the Viewer only when the work names one", () => {
    const id = `media-item-${"2".repeat(32)}`;
    const base = {
      id,
      src: `/api/community/publishing/media/${id}/display/base`,
      width: 3024,
      height: 4032,
    };
    expect(toWorkMediaPresentation(base, "春日临帖")).toEqual({
      ...base,
      alt: "春日临帖",
    });
    expect(
      toWorkMediaPresentation(
        { ...base, fullSrc: `/api/community/publishing/media/${id}/full/base` },
        "春日临帖",
      ).fullSrc,
    ).toBe(`/api/community/publishing/media/${id}/full/base`);
  });

  // unified-media-pipeline-v1: the candidates and colour reach the carousel
  // and the Viewer unchanged.
  it("passes the rendition candidates and the placeholder colour through", () => {
    const id = `media-item-${"4".repeat(32)}`;
    const path = (variant: string) =>
      `/api/community/publishing/media/${id}/${variant}/base`;
    const renditions = [
      {
        src: path("thumb"),
        width: 360,
        height: 480,
        contentType: "image/webp",
      },
      {
        src: path("display"),
        width: 1536,
        height: 2048,
        contentType: "image/webp",
      },
      {
        src: path("viewer"),
        width: 3072,
        height: 4096,
        contentType: "image/webp",
      },
    ] as const;
    expect(
      toWorkMediaPresentation(
        {
          id,
          src: path("display"),
          width: 1536,
          height: 2048,
          renditions: [...renditions],
          placeholderColor: "#2f2a26",
        },
        "春日临帖",
      ),
    ).toEqual({
      id,
      src: path("display"),
      alt: "春日临帖",
      width: 1536,
      height: 2048,
      renditions: [...renditions],
      placeholderColor: "#2f2a26",
    });
  });
});

describe("Catalog media presentation (unified-media-pipeline-v1)", () => {
  const id = (hex: string) => `media-rendition-${hex.repeat(32)}`;
  const loopback = (hex: string) =>
    `http://127.0.0.1:3411/v1/development/catalog-renditions/${id(hex)}`;
  const detailWith = (src: (hex: string) => string): CatalogDetail => ({
    ...completeDetail,
    media: [
      {
        alt: "详情图像",
        height: 900,
        id: "media-detail" as MediaId,
        kind: "image",
        src: src("b"),
        width: 1600,
        placeholderColor: "#8b735f",
        renditions: [
          { src: src("a"), width: 480, height: 270, contentType: "image/webp" },
          {
            src: src("b"),
            width: 1600,
            height: 900,
            contentType: "image/webp",
          },
          {
            src: src("c"),
            width: 3200,
            height: 1800,
            contentType: "image/webp",
          },
        ],
      },
    ],
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes every candidate, zoom levels included, and the colour through", () => {
    const remote = (hex: string) => `https://media.example.invalid/${hex}.webp`;
    const detail = detailWith(remote);
    expect(toCatalogDetailPresentation(detail, "runtime").media).toEqual(
      detail.media,
    );
  });

  it("serves Development renditions through the Web origin, anchor included", () => {
    vi.stubEnv("NODE_ENV", "development");
    const [media] = toCatalogDetailPresentation(
      detailWith(loopback),
      "runtime",
    ).media;
    const relay = (hex: string) =>
      `/api/development/catalog-renditions/${id(hex)}`;
    expect(media?.src).toBe(relay("b"));
    expect(media?.renditions?.map(({ src }) => src)).toEqual([
      relay("a"),
      relay("b"),
      relay("c"),
    ]);
    expect(media?.placeholderColor).toBe("#8b735f");
  });
});

describe("Work authorship presentation", () => {
  it("names the kind and only the references the author named, in order", () => {
    expect(toWorkAuthorshipPresentation({ kind: "original" })).toEqual({
      kind: "original",
      label: "原创",
      references: [],
    });
    expect(
      toWorkAuthorshipPresentation({
        kind: "copy_practice",
        sourceNote: "  碑帖拓本\n第二行 ",
        referenceTitle: "兰亭序",
        originalAuthor: "王羲之",
      }),
    ).toEqual({
      kind: "copy_practice",
      label: "临摹或练习",
      references: [
        { label: "参考作品", value: "兰亭序" },
        { label: "原作者", value: "王羲之" },
        { label: "来源", value: "碑帖拓本\n第二行" },
      ],
    });
    expect(
      toWorkAuthorshipPresentation({
        kind: "material_sharing",
        referenceTitle: " ",
        sourceNote: "自摄",
      }),
    ).toEqual({
      kind: "material_sharing",
      label: "素材分享",
      references: [{ label: "来源", value: "自摄" }],
    });
  });
});
