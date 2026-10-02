import { describe, expect, it, vi } from "vitest";
import {
  articleAuthoringDocumentSchema,
  articleDetailSchema,
  articleSummarySchema,
} from "@moya/contracts/schemas";
import { moderateArticlePendingCommandSchema } from "@moya/contracts/internal/community-operator";
import {
  CanonicalAuthoredArticleProjector,
  articleCatalogMediaKey,
} from "@moya/catalog-postgres";
import type { PublishedAuthoredArticle } from "@moya/api";
import type { PublicMedia, WorkMedia } from "@moya/contracts";

const itemA = `media-item-${"1".repeat(32)}`,
  itemB = `media-item-${"2".repeat(32)}`;
const catalogId = `catalog-${"3".repeat(32)}`,
  mediaId = `media-${"4".repeat(32)}`;
const document = articleAuthoringDocumentSchema.parse({
  format: "blocknote",
  version: 1,
  blocks: [
    {
      id: "image-one",
      type: "managedImage",
      props: { refId: "visible", caption: "", alt: "" },
      children: [],
    },
  ],
  references: {
    visible: { type: "managed", itemId: itemA },
    cover: { type: "catalog", catalogId, mediaId },
    unused: { type: "managed", itemId: itemB },
  },
  galleries: {},
});
const publication: PublishedAuthoredArticle = {
  id: `article-${"5".repeat(32)}` as PublishedAuthoredArticle["id"],
  ownerId: `user-${"6".repeat(32)}` as PublishedAuthoredArticle["ownerId"],
  version: 2,
  title: "Test Article",
  coverRefId: "cover",
  document,
  fingerprint: "a".repeat(64),
  byline: "Test author",
  firstPublishedAt: "2026-09-30T00:00:00.000Z",
  publishedAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};
const managed: WorkMedia = {
  id: itemA,
  kind: "live",
  src: `/api/community/publishing/media/${itemA}/display/base`,
  motionSrc: `/api/community/publishing/media/${itemA}/motion/base`,
  width: 100,
  height: 80,
  hasAudio: false,
};
const catalog: PublicMedia = {
  id: mediaId as PublicMedia["id"],
  kind: "image",
  src: "https://example.test/display.webp",
  alt: "Catalog image",
  width: 100,
  height: 80,
};
const dtoOf = (
  record: Awaited<ReturnType<CanonicalAuthoredArticleProjector["detail"]>>,
) => {
  const { resolvedCover, ...rest } = record;
  return { ...rest, cover: resolvedCover ?? null };
};

describe("Article canonical public read projection", () => {
  it("resolves only used body/cover IDs, under the immutable owner", async () => {
    const resolveManaged = vi.fn(async () => new Map([[itemA, managed]]));
    const resolveCatalog = vi.fn(
      async () =>
        new Map([[articleCatalogMediaKey(catalogId, mediaId), catalog]]),
    );
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged,
      resolveCatalog,
    }).detail(publication);
    expect(resolveManaged).toHaveBeenCalledExactlyOnceWith(
      publication.ownerId,
      [itemA],
    );
    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith([
      { catalogId, mediaId },
    ]);
    expect(Object.keys(record.resolvedReferences!)).toEqual([
      "cover",
      "visible",
    ]);
    expect(record.document).toBe(document);
    expect(record.sections).toEqual([]);
    expect(record.resolvedReferences!.visible).toEqual({
      type: "managed",
      media: managed,
    });
    expect(articleDetailSchema.safeParse(dtoOf(record)).success).toBe(true);
  });
  it("keeps an unavailable placeholder without rewriting the document", async () => {
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map(),
      resolveCatalog: async () => new Map(),
    }).detail(publication);
    expect(record.document).toBe(document);
    expect(record.resolvedReferences).toEqual({
      cover: { type: "unavailable", reason: "catalog_unavailable" },
      visible: { type: "unavailable", reason: "media_unavailable" },
    });
    expect(articleDetailSchema.safeParse(dtoOf(record)).success).toBe(true);
  });
  it("summary resolves only its explicit cover and retains Live Photo motion", async () => {
    const resolveManaged = vi.fn(async () => new Map([[itemA, managed]]));
    const resolveCatalog = vi.fn(async () => new Map<string, PublicMedia>());
    const summary = {
      id: publication.id,
      ownerId: publication.ownerId,
      version: publication.version,
      title: publication.title,
      coverRefId: publication.coverRefId,
      fingerprint: publication.fingerprint,
      byline: publication.byline,
      firstPublishedAt: publication.firstPublishedAt,
      publishedAt: publication.publishedAt,
      updatedAt: publication.updatedAt,
    };
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged,
      resolveCatalog,
    }).summary({
      ...summary,
      coverRefId: "visible",
      coverReference: { type: "managed", itemId: itemA },
    });
    expect(record.managedCover).toEqual(managed);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(record).not.toHaveProperty("document");
    expect(resolveManaged).toHaveBeenCalledExactlyOnceWith(
      publication.ownerId,
      [itemA],
    );
  });
  it("rich readers refuse missing and unrelated reference resolutions", async () => {
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map(),
      resolveCatalog: async () => new Map(),
    }).detail(publication);
    const dto = dtoOf(record);
    expect(
      articleDetailSchema.safeParse({ ...dto, resolvedReferences: {} }).success,
    ).toBe(false);
    expect(
      articleDetailSchema.safeParse({
        ...dto,
        resolvedReferences: {
          ...dto.resolvedReferences,
          unrelated: { type: "unavailable", reason: "media_unavailable" },
        },
      }).success,
    ).toBe(false);
  });
  it("keeps Catalog pairs containing colons distinct in a gallery", async () => {
    const rich = articleAuthoringDocumentSchema.parse({
      format: "blocknote",
      version: 1,
      blocks: [
        {
          id: "gallery-one",
          type: "imageGallery",
          props: { groupId: "gallery" },
          children: [],
        },
      ],
      references: {
        first: { type: "catalog", catalogId: "a:b", mediaId: "c" },
        second: { type: "catalog", catalogId: "a", mediaId: "b:c" },
      },
      galleries: { gallery: { referenceIds: ["first", "second"] } },
    });
    const resolveCatalog = vi.fn(
      async () => new Map([[articleCatalogMediaKey("a", "b:c"), catalog]]),
    );
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map(),
      resolveCatalog,
    }).detail({ ...publication, coverRefId: null, document: rich });
    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith([
      { catalogId: "a:b", mediaId: "c" },
      { catalogId: "a", mediaId: "b:c" },
    ]);
    expect(record.resolvedReferences!.first).toEqual({
      type: "unavailable",
      reason: "catalog_unavailable",
    });
    expect(record.resolvedReferences!.second).toEqual({
      type: "catalog",
      media: catalog,
    });
    expect(articleCatalogMediaKey("a:b", "c")).not.toEqual(
      articleCatalogMediaKey("a", "b:c"),
    );
  });
  it("retains legacy sections without adding a canonical document", () => {
    const dto = {
      id: publication.id,
      presentation: "academic",
      title: "Legacy",
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: "Legacy author",
      cover: null,
      firstPublishedAt: publication.firstPublishedAt,
      publishedAt: publication.publishedAt,
      updatedAt: publication.updatedAt,
      intro: null,
      sections: [
        {
          heading: null,
          paragraphs: ["Legacy body"],
          image: null,
          imageCaption: null,
        },
      ],
      citations: [],
    };
    expect(articleDetailSchema.safeParse(dto).success).toBe(true);
    expect(
      articleDetailSchema.safeParse({ ...dto, sections: [] }).success,
    ).toBe(false);
  });
  it("admits 120 astral code points and rejects 121 in public titles", () => {
    const summary = {
      id: publication.id,
      presentation: "academic",
      title: "😀".repeat(120),
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: publication.byline,
      cover: null,
      firstPublishedAt: publication.firstPublishedAt,
      publishedAt: publication.publishedAt,
      updatedAt: publication.updatedAt,
    };
    expect(articleSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      articleSummarySchema.safeParse({ ...summary, title: "😀".repeat(121) })
        .success,
    ).toBe(false);
  });
});
describe("Internal Article moderation command", () => {
  const command = {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedVersion: 3,
    candidateVersion: 2,
    fingerprint: "b".repeat(64),
    action: "approve",
  };
  it("requires both current document version and exact immutable candidate", () => {
    expect(moderateArticlePendingCommandSchema.safeParse(command).success).toBe(
      true,
    );
    const missing = {
      requestId: command.requestId,
      expectedVersion: command.expectedVersion,
      fingerprint: command.fingerprint,
      action: command.action,
    };
    expect(moderateArticlePendingCommandSchema.safeParse(missing).success).toBe(
      false,
    );
    expect(
      moderateArticlePendingCommandSchema.safeParse({
        ...command,
        ownerId: publication.ownerId,
      }).success,
    ).toBe(false);
  });
  it("cannot receive a model approval ticket as operator authority", () => {
    expect(
      moderateArticlePendingCommandSchema.safeParse({
        ...command,
        approvalId: "model-choice",
      }).success,
    ).toBe(false);
    expect(
      moderateArticlePendingCommandSchema.safeParse({
        ...command,
        action: "publish",
      }).success,
    ).toBe(false);
  });
});
