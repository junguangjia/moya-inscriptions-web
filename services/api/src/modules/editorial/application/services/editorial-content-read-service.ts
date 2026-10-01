import { CatalogMediaResolutionError } from "../../../catalog/application/errors/catalog-media-resolution-error.js";
import { mapCatalogSummary } from "../../../catalog/application/mappers/catalog-public-contract-mapper.js";
import {
  parseArticleCollectionDetail,
  parseArticleCollectionPage,
  parseArticleDetail,
  parseArticlePage,
  safeParsePublicMedia,
} from "../mappers/editorial-content-contract-mapper.js";

import type {
  StorageMediaLocator,
  StorageUrlResolver,
  ResolvedMediaUrl,
} from "../../../catalog/application/ports/storage-url-resolver.js";
import type {
  ArticleCollectionDetailRecord,
  ArticleCollectionMemberRecord,
  ArticleCollectionSummaryRecord,
  ArticleDetailRecord,
  ArticleSummaryRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
} from "../ports/editorial-content-read-port.js";
import type {
  ArticleCollectionDetail,
  ArticleCollectionId,
  ArticleCollectionListQuery,
  ArticleCollectionPage,
  ArticleDetail,
  ArticleId,
  ArticleListQuery,
  ArticlePage,
  MediaId,
  PublicMedia,
} from "@moya/contracts";

type Resolved = ReadonlyMap<MediaId, ResolvedMediaUrl>;

const noResolvedMedia: Resolved = new Map();

/** Blank lines separate paragraphs; surrounding whitespace never becomes content. */
export const splitParagraphs = (body: string): string[] =>
  body
    .split(/\n[ \t]*\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

const totalPages = (total: number, pageSize: number) =>
  total === 0 ? 0 : Math.ceil(total / pageSize);

/**
 * Application boundary for the public editorial reads: resolves approved
 * Catalog media through the same storage resolver the Catalog uses (object
 * keys never leave the Backend) and validates every response against the
 * public contract before it is sent.
 */
export class EditorialContentReadService {
  constructor(
    private readonly port: EditorialContentReadPort,
    private readonly storageUrlResolver: StorageUrlResolver,
  ) {}

  private collectLocators(media: readonly (EditorialMediaRecord | null)[]) {
    const seen = new Map<MediaId, StorageMediaLocator>();
    for (const item of media)
      if (item && !seen.has(item.id))
        seen.set(item.id, { mediaId: item.id, objectKey: item.objectKey });
    return [...seen.values()];
  }

  private async resolve(
    locators: readonly StorageMediaLocator[],
  ): Promise<Resolved> {
    if (locators.length === 0) return noResolvedMedia;
    try {
      return await this.storageUrlResolver.resolveMany(locators);
    } catch (error) {
      if (error instanceof CatalogMediaResolutionError) throw error;
      throw new CatalogMediaResolutionError({ cause: error });
    }
  }

  private media(
    record: EditorialMediaRecord | null,
    resolved: Resolved,
  ): PublicMedia | null {
    if (record === null) return null;
    const src = resolved.get(record.id);
    if (src === undefined)
      throw new CatalogMediaResolutionError({
        cause: new Error(`Missing resolved URL for MediaId ${record.id}`),
      });
    const media = safeParsePublicMedia({
      id: record.id,
      kind: "image",
      src,
      alt: record.alt,
      width: record.width,
      height: record.height,
    });
    if (!media.success)
      throw new CatalogMediaResolutionError({ cause: media.error });
    return media.data;
  }

  private summary(record: ArticleSummaryRecord, resolved: Resolved) {
    return {
      id: record.id,
      presentation: record.presentation,
      title: record.title,
      subtitle: record.subtitle,
      summary: record.summary,
      section: record.section,
      issue: record.issue,
      byline: record.byline,
      cover: this.media(record.cover, resolved),
      firstPublishedAt: record.firstPublishedAt,
      publishedAt: record.publishedAt,
      updatedAt: record.updatedAt,
    };
  }

  private collectionSummary(
    record: ArticleCollectionSummaryRecord,
    resolved: Resolved,
  ) {
    return {
      id: record.id,
      title: record.title,
      subtitle: record.subtitle,
      summary: record.summary,
      category: record.category,
      issue: record.issue,
      cover: this.media(record.cover, resolved),
      memberTotal: record.memberTotal,
      firstPublishedAt: record.firstPublishedAt,
      publishedAt: record.publishedAt,
      updatedAt: record.updatedAt,
    };
  }

  async listArticles(query: ArticleListQuery): Promise<ArticlePage> {
    const page = await this.port.listArticles(query);
    const resolved = await this.resolve(
      this.collectLocators(page.items.map((item) => item.cover)),
    );
    return parseArticlePage({
      items: page.items.map((item) => this.summary(item, resolved)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: totalPages(page.total, page.pageSize),
    });
  }

  async readArticle(id: ArticleId): Promise<ArticleDetail | null> {
    const record = await this.port.findArticle(id);
    if (record === null) return null;
    return this.detail(record);
  }

  private async detail(record: ArticleDetailRecord): Promise<ArticleDetail> {
    const resolved = await this.resolve(
      this.collectLocators([
        record.cover,
        ...record.sections.map((section) => section.image),
      ]),
    );
    return parseArticleDetail({
      ...this.summary(record, resolved),
      intro: record.intro,
      sections: record.sections.map((section) => ({
        heading: section.heading,
        paragraphs: splitParagraphs(section.body),
        image: this.media(section.image, resolved),
        imageCaption: section.imageCaption,
      })),
      citations: record.citations.map((citation) => ({
        text: citation.text,
        url: citation.url,
      })),
    });
  }

  isArticlePublished(id: string): Promise<boolean> {
    return this.port.isArticlePublished(id);
  }

  async listCollections(
    query: ArticleCollectionListQuery,
  ): Promise<ArticleCollectionPage> {
    const page = await this.port.listCollections(query);
    const resolved = await this.resolve(
      this.collectLocators(page.items.map((item) => item.cover)),
    );
    return parseArticleCollectionPage({
      items: page.items.map((item) => this.collectionSummary(item, resolved)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: totalPages(page.total, page.pageSize),
    });
  }

  async readCollection(
    id: ArticleCollectionId,
  ): Promise<ArticleCollectionDetail | null> {
    const record = await this.port.findCollection(id);
    if (record === null) return null;
    return this.collectionDetail(record);
  }

  private async collectionDetail(record: ArticleCollectionDetailRecord) {
    const memberMedia = record.members.map((member) =>
      member.kind === "article"
        ? member.article.cover
        : member.record.representativeMedia
          ? {
              id: member.record.representativeMedia.id,
              objectKey: member.record.representativeMedia.objectKey,
              alt: member.record.representativeMedia.alt,
              width: member.record.representativeMedia.width,
              height: member.record.representativeMedia.height,
            }
          : null,
    );
    const resolved = await this.resolve(
      this.collectLocators([record.cover, ...memberMedia]),
    );
    const members = record.members.map(
      (member: ArticleCollectionMemberRecord) =>
        member.kind === "article"
          ? {
              kind: "article" as const,
              position: member.position,
              article: this.summary(member.article, resolved),
            }
          : {
              kind: "catalog" as const,
              position: member.position,
              record: mapCatalogSummary(member.record, resolved),
            },
    );
    return parseArticleCollectionDetail({
      ...this.collectionSummary(record, resolved),
      members,
    });
  }
}
