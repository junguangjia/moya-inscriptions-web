import type {
  ArticleCollectionId,
  ArticleCollectionListQuery,
  ArticleId,
  ArticleListQuery,
  ArticlePresentation,
  MediaId,
} from "@moya/contracts";

import type { CatalogListItemProjection } from "../../../catalog/application/catalog-read-projections.js";

/** Approved Catalog media referenced by an Article; resolved to a URL by the service. */
export interface EditorialMediaRecord {
  readonly id: MediaId;
  readonly objectKey: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export interface ArticleSummaryRecord {
  readonly id: ArticleId;
  readonly presentation: ArticlePresentation;
  readonly title: string;
  readonly subtitle: string | null;
  readonly summary: string | null;
  readonly section: string | null;
  readonly issue: string | null;
  readonly byline: string;
  readonly cover: EditorialMediaRecord | null;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export interface ArticleSectionRecord {
  readonly heading: string | null;
  /** Plain text; blank lines separate paragraphs. */
  readonly body: string;
  readonly image: EditorialMediaRecord | null;
  readonly imageCaption: string | null;
}

export interface ArticleCitationRecord {
  readonly text: string;
  readonly url: string | null;
}

export interface ArticleDetailRecord extends ArticleSummaryRecord {
  readonly intro: string | null;
  readonly sections: readonly ArticleSectionRecord[];
  readonly citations: readonly ArticleCitationRecord[];
}

export interface ArticleCollectionSummaryRecord {
  readonly id: ArticleCollectionId;
  readonly title: string;
  readonly subtitle: string | null;
  readonly summary: string | null;
  readonly category: string | null;
  readonly issue: string | null;
  readonly cover: EditorialMediaRecord | null;
  readonly memberTotal: number;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export type ArticleCollectionMemberRecord =
  | {
      readonly kind: "article";
      readonly position: number;
      readonly article: ArticleSummaryRecord;
    }
  | {
      readonly kind: "catalog";
      readonly position: number;
      readonly record: CatalogListItemProjection;
    };

export interface ArticleCollectionDetailRecord extends ArticleCollectionSummaryRecord {
  readonly members: readonly ArticleCollectionMemberRecord[];
}

export interface EditorialPageRecord<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Read port over the Payload published-only editorial views. Only the exact
 * currently published revision is ever returned; drafts, pending replacements
 * and withdrawn documents read as absent. Members that are no longer published
 * are filtered by the adapter without disturbing the remaining order.
 */
export interface EditorialContentReadPort {
  listArticles(
    query: ArticleListQuery,
  ): Promise<EditorialPageRecord<ArticleSummaryRecord>>;
  findArticle(id: ArticleId): Promise<ArticleDetailRecord | null>;
  /** Visibility seam for discussion targets and sibling producers. */
  isArticlePublished(id: string): Promise<boolean>;
  listCollections(
    query: ArticleCollectionListQuery,
  ): Promise<EditorialPageRecord<ArticleCollectionSummaryRecord>>;
  findCollection(
    id: ArticleCollectionId,
  ): Promise<ArticleCollectionDetailRecord | null>;
}
