import { CatalogMediaResolutionError } from "../../../catalog/application/errors/catalog-media-resolution-error.js";
import {
  catalogMediaRenditionKeys,
  mapCatalogPublicMedia,
  mapCatalogSummary,
} from "../../../catalog/application/mappers/catalog-public-contract-mapper.js";
import {
  parseArticleCollectionDetail,
  parseArticleCollectionPage,
  parseArticleDetail,
  parseArticlePage,
} from "../mappers/editorial-content-contract-mapper.js";

import type {
  CatalogMediaContext,
  CatalogRenditionUrls,
} from "../../../catalog/application/mappers/catalog-public-contract-mapper.js";
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

/** Approved image URLs by MediaId and rendition delivery URLs by key. */
interface Resolved {
  readonly media: ReadonlyMap<MediaId, ResolvedMediaUrl>;
  readonly renditions: CatalogRenditionUrls;
}

const noRenditionUrls: CatalogRenditionUrls = new Map();
const nothingResolved: Resolved = {
  media: new Map(),
  renditions: noRenditionUrls,
};

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
 * public contract before it is sent. Article and Collection lists and
 * Collection pages show their images as cards; an Article page shows its
 * cover and section images in the detail context (unified media pipeline,
 * CW4).
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

  /**
   * Approved image URLs and the rendition delivery URLs of one context; either
   * batch failing fails the read, as before renditions.
   */
  private async resolve(
    media: readonly (EditorialMediaRecord | null)[],
    context: CatalogMediaContext,
  ): Promise<Resolved> {
    const locators = this.collectLocators(media);
    if (locators.length === 0) return nothingResolved;
    const keys = [
      ...new Set(
        media.flatMap((item) =>
          item === null ? [] : catalogMediaRenditionKeys(item, context),
        ),
      ),
    ];
    try {
      const [urls, renditions] = await Promise.all([
        this.storageUrlResolver.resolveMany(locators),
        keys.length === 0 || this.storageUrlResolver.resolveKeys === undefined
          ? noRenditionUrls
          : this.storageUrlResolver.resolveKeys(keys),
      ]);
      return { media: urls, renditions };
    } catch (error) {
      if (error instanceof CatalogMediaResolutionError) throw error;
      throw new CatalogMediaResolutionError({ cause: error });
    }
  }

  private media(
    record: EditorialMediaRecord | null,
    resolved: Resolved,
    context: CatalogMediaContext,
  ): PublicMedia | null {
    return record === null
      ? null
      : mapCatalogPublicMedia(
          record,
          resolved.media,
          resolved.renditions,
          context,
        );
  }

  private summary(
    record: ArticleSummaryRecord,
    resolved: Resolved,
    context: CatalogMediaContext,
  ) {
    return {
      id: record.id,
      presentation: record.presentation,
      title: record.title,
      subtitle: record.subtitle,
      summary: record.summary,
      section: record.section,
      issue: record.issue,
      byline: record.byline,
      cover:
        record.resolvedCover !== undefined
          ? record.resolvedCover
          : this.media(record.cover, resolved, context),
      ...(record.managedCover !== undefined
        ? { managedCover: record.managedCover }
        : {}),
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
      cover: this.media(record.cover, resolved, "card"),
      memberTotal: record.memberTotal,
      firstPublishedAt: record.firstPublishedAt,
      publishedAt: record.publishedAt,
      updatedAt: record.updatedAt,
    };
  }

  async listArticles(query: ArticleListQuery): Promise<ArticlePage> {
    const page = await this.port.listArticles(query);
    const resolved = await this.resolve(
      page.items.map((item) => item.cover),
      "card",
    );
    return parseArticlePage({
      items: page.items.map((item) => this.summary(item, resolved, "card")),
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
      [record.cover, ...record.sections.map((section) => section.image)],
      "detail",
    );
    return parseArticleDetail({
      ...this.summary(record, resolved, "detail"),
      intro: record.intro,
      ...(record.document !== undefined ? { document: record.document } : {}),
      ...(record.resolvedReferences !== undefined
        ? { resolvedReferences: record.resolvedReferences }
        : {}),
      sections: record.sections.map((section) => ({
        heading: section.heading,
        paragraphs: splitParagraphs(section.body),
        image: this.media(section.image, resolved, "detail"),
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
      page.items.map((item) => item.cover),
      "card",
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
        : (member.record.representativeMedia ?? null),
    );
    const resolved = await this.resolve([record.cover, ...memberMedia], "card");
    const members = record.members.map(
      (member: ArticleCollectionMemberRecord) =>
        member.kind === "article"
          ? {
              kind: "article" as const,
              position: member.position,
              article: this.summary(member.article, resolved, "card"),
            }
          : {
              kind: "catalog" as const,
              position: member.position,
              record: mapCatalogSummary(
                member.record,
                resolved.media,
                resolved.renditions,
              ),
            },
    );
    return parseArticleCollectionDetail({
      ...this.collectionSummary(record, resolved),
      members,
    });
  }
}
