import { articleReferences } from "@moya/contracts/schemas";
import type {
  ArticleDetailRecord,
  ArticleSummaryRecord,
  PublishedAuthoredArticle,
  PublishedAuthoredArticleSummary,
} from "@moya/api";
import type {
  ArticleMediaReference,
  ArticleResolvedReference,
  ArticleResolvedReferences,
  PublicMedia,
  PublicUserId,
  WorkMedia,
} from "@moya/contracts";
import type { AuthoredArticleReadProjector } from "./postgres-composite-editorial-adapter.js";

type Managed = Extract<ArticleMediaReference, { type: "managed" }>;
type Catalog = Extract<ArticleMediaReference, { type: "catalog" }>;
/**
 * Existing media bridge supplies owner-scoped ready derivatives, never
 * masters; rendition candidates in the detail context (`summary()` narrows
 * its cover to the card context).
 */
export interface AuthoredArticleMediaResolver {
  resolveManaged(
    owner: PublicUserId,
    itemIds: readonly Managed["itemId"][],
  ): Promise<ReadonlyMap<string, WorkMedia>>;
  resolveCatalog(
    pairs: readonly Omit<Catalog, "type">[],
  ): Promise<ReadonlyMap<string, PublicMedia>>;
}
export const articleCatalogMediaKey = (
  catalogId: string,
  mediaId: string,
): string => JSON.stringify([catalogId, mediaId]);

/**
 * The candidates up to the anchor (`src`) of a detail-context list, or
 * undefined when there is no list or no anchor in it.
 */
const candidatesUpToAnchor = <
  Entry extends {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  },
>(
  src: string,
  renditions: readonly Entry[] | undefined,
): Entry[] | undefined => {
  const anchor = renditions?.find((entry) => entry.src === src);
  return renditions === undefined || anchor === undefined
    ? undefined
    : renditions.filter(
        (entry) => entry.width <= anchor.width && entry.height <= anchor.height,
      );
};

/**
 * A summary is a card context (unified media pipeline CW4): its cover keeps
 * only the candidates up to its anchor, never zoom levels. Resolvers answer
 * in the detail context, so detail reads keep every candidate.
 */
const cardCover = (
  cover: ArticleResolvedReference | undefined,
): ArticleResolvedReference | undefined => {
  if (cover?.type === "managed") {
    const renditions = candidatesUpToAnchor(
      cover.media.src,
      cover.media.renditions,
    );
    return renditions === undefined
      ? cover
      : { type: "managed", media: { ...cover.media, renditions } };
  }
  if (cover?.type === "catalog") {
    const renditions = candidatesUpToAnchor(
      cover.media.src,
      cover.media.renditions,
    );
    return renditions === undefined
      ? cover
      : { type: "catalog", media: { ...cover.media, renditions } };
  }
  return cover;
};

/** Canonical document stays unchanged; URL availability is a typed read overlay. */
export class CanonicalAuthoredArticleProjector implements AuthoredArticleReadProjector {
  constructor(private readonly media: AuthoredArticleMediaResolver) {}
  private async references(
    owner: PublicUserId,
    entries: readonly { refId: string; reference: ArticleMediaReference }[],
  ): Promise<ArticleResolvedReferences> {
    const managedIds = [
      ...new Set(
        entries.flatMap(({ reference }) =>
          reference.type === "managed" ? [reference.itemId] : [],
        ),
      ),
    ];
    const catalogPairs = new Map<string, Omit<Catalog, "type">>();
    for (const { reference } of entries)
      if (reference.type === "catalog")
        catalogPairs.set(
          articleCatalogMediaKey(reference.catalogId, reference.mediaId),
          { catalogId: reference.catalogId, mediaId: reference.mediaId },
        );
    const [managed, catalog] = await Promise.all([
      managedIds.length
        ? this.media.resolveManaged(owner, managedIds)
        : Promise.resolve(new Map<string, WorkMedia>()),
      catalogPairs.size
        ? this.media.resolveCatalog([...catalogPairs.values()])
        : Promise.resolve(new Map<string, PublicMedia>()),
    ]);
    const resolved: ArticleResolvedReferences = Object.create(
      null,
    ) as ArticleResolvedReferences;
    for (const { refId, reference } of entries) {
      let value: ArticleResolvedReference;
      if (reference.type === "managed") {
        const asset = managed.get(reference.itemId);
        value = asset
          ? { type: "managed", media: asset }
          : { type: "unavailable", reason: "media_unavailable" };
      } else {
        const asset = catalog.get(
          articleCatalogMediaKey(reference.catalogId, reference.mediaId),
        );
        value = asset
          ? { type: "catalog", media: asset }
          : { type: "unavailable", reason: "catalog_unavailable" };
      }
      resolved[refId] = value;
    }
    return resolved;
  }
  private record(
    value: PublishedAuthoredArticleSummary | PublishedAuthoredArticle,
    cover: ArticleResolvedReference | undefined,
  ): ArticleSummaryRecord {
    return {
      id: value.id,
      presentation: "academic",
      title: value.title,
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: value.byline,
      cover: null,
      // Internal resolved Catalog cover avoids converting approved URLs into object keys.
      resolvedCover: cover?.type === "catalog" ? cover.media : null,
      managedCover: cover?.type === "managed" ? cover.media : null,
      firstPublishedAt: value.firstPublishedAt,
      publishedAt: value.publishedAt,
      updatedAt: value.updatedAt,
    };
  }
  async summary(
    value: PublishedAuthoredArticleSummary,
  ): Promise<ArticleSummaryRecord> {
    const entries =
      value.coverRefId !== null && value.coverReference !== null
        ? [{ refId: value.coverRefId, reference: value.coverReference }]
        : [];
    const resolved = await this.references(value.ownerId, entries);
    return this.record(
      value,
      cardCover(
        value.coverRefId === null ? undefined : resolved[value.coverRefId],
      ),
    );
  }
  async detail(value: PublishedAuthoredArticle): Promise<ArticleDetailRecord> {
    // Raw reference dictionaries may contain unused/foreign IDs. They are never resolved.
    const resolved = await this.references(
      value.ownerId,
      articleReferences(value.document, value.coverRefId),
    );
    return {
      ...this.record(
        value,
        value.coverRefId === null ? undefined : resolved[value.coverRefId],
      ),
      intro: null,
      sections: [],
      citations: [],
      document: value.document,
      resolvedReferences: resolved,
    };
  }
}
