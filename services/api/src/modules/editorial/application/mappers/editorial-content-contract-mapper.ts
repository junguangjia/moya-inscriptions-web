import {
  articleCollectionDetailSchema,
  articleCollectionPageSchema,
  articleDetailSchema,
  articlePageSchema,
  publicMediaSchema,
} from "@moya/contracts/schemas";

import type {
  ArticleCollectionDetail,
  ArticleCollectionPage,
  ArticleDetail,
  ArticlePage,
} from "@moya/contracts";

/**
 * The editorial read DTOs are validated against the public Contracts at the
 * application boundary; the runtime schemas stay inside this mapper.
 */
export const parseArticlePage = (value: unknown): ArticlePage =>
  articlePageSchema.parse(value);
export const parseArticleDetail = (value: unknown): ArticleDetail =>
  articleDetailSchema.parse(value);
export const parseArticleCollectionPage = (
  value: unknown,
): ArticleCollectionPage => articleCollectionPageSchema.parse(value);
export const parseArticleCollectionDetail = (
  value: unknown,
): ArticleCollectionDetail => articleCollectionDetailSchema.parse(value);
export const safeParsePublicMedia = (value: unknown) =>
  publicMediaSchema.safeParse(value);
