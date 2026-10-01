import { asPostgresOperationError } from "./availability.js";
import { parseCatalogCount } from "./adapter.js";
import { listCatalogAliasesSql } from "./queries.js";
import {
  mapAliasRows,
  mapCatalogEntryRow,
  mapRepresentativeMediaRows,
} from "./row-mapper.js";

import type {
  CatalogAliasRow,
  CatalogEntryRow,
  CatalogMediaRow,
} from "./row-mapper.js";
import type {
  ArticleCollectionDetailRecord,
  ArticleCollectionMemberRecord,
  ArticleCollectionSummaryRecord,
  ArticleDetailRecord,
  ArticleSummaryRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
  EditorialPageRecord,
} from "@moya/api";
import type {
  ArticleCollectionId,
  ArticleCollectionListQuery,
  ArticleId,
  ArticleListQuery,
  ArticlePresentation,
} from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ArticleEntryRow extends QueryResultRow {
  readonly article_id: string;
  readonly presentation: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly summary: string | null;
  readonly section: string | null;
  readonly issue: string | null;
  readonly byline: string;
  readonly intro: string | null;
  readonly cover_alt: string | null;
  readonly cover_catalog_id: string | null;
  readonly first_published_at: Date | null;
  readonly published_at: Date | null;
  readonly updated_at: Date;
}

interface ArticleSectionRow extends QueryResultRow {
  readonly article_id: string;
  readonly position: number;
  readonly heading: string | null;
  readonly body: string;
  readonly image_catalog_id: string | null;
  readonly image_caption: string | null;
}

interface ArticleCitationRow extends QueryResultRow {
  readonly article_id: string;
  readonly position: number;
  readonly text: string;
  readonly url: string | null;
}

interface CollectionEntryRow extends QueryResultRow {
  readonly collection_id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly summary: string | null;
  readonly category: string | null;
  readonly issue: string | null;
  readonly cover_catalog_id: string | null;
  readonly first_published_at: Date | null;
  readonly published_at: Date | null;
  readonly updated_at: Date;
  readonly member_total: string;
}

interface CollectionMemberRow extends QueryResultRow {
  readonly collection_id: string;
  readonly position: number;
  readonly kind: string;
  readonly article_id: string | null;
  readonly catalog_id: string | null;
}

const articleColumns = `
  article_id, presentation, title, subtitle, summary, section, issue, byline,
  intro, cover_alt, cover_catalog_id, first_published_at, published_at, updated_at`;

const listArticlesSql = `
  SELECT ${articleColumns}
  FROM article_entries
  WHERE ($1::text IS NULL OR presentation = $1::text)
  ORDER BY published_at DESC, article_id DESC
  LIMIT $2::integer OFFSET $3::bigint`;
const countArticlesSql = `
  SELECT COUNT(*)::text AS total FROM article_entries
  WHERE ($1::text IS NULL OR presentation = $1::text)`;
const findArticleSql = `SELECT ${articleColumns} FROM article_entries WHERE article_id = $1`;
const articlesByIdSql = `SELECT ${articleColumns} FROM article_entries WHERE article_id = ANY($1::text[])`;
const isArticlePublishedSql = `SELECT 1 FROM article_entries WHERE article_id = $1`;
const listSectionsSql = `
  SELECT article_id, position, heading, body, image_catalog_id, image_caption
  FROM article_sections WHERE article_id = $1 ORDER BY position ASC`;
const listCitationsSql = `
  SELECT article_id, position, text, url
  FROM article_citations WHERE article_id = $1 ORDER BY position ASC`;
// Eligible members only: an Article member must be published; a Catalog member
// must be a currently published record. Order comes from the editor's array.
const memberEligibility = `
  ((m.kind = 'article' AND m.article_id IS NOT NULL)
   OR (m.kind = 'catalog' AND m.catalog_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM catalog_entries ce WHERE ce.catalog_id = m.catalog_id)))`;
const collectionColumns = `
  k.collection_id, k.title, k.subtitle, k.summary, k.category, k.issue,
  k.cover_catalog_id, k.first_published_at, k.published_at, k.updated_at,
  (SELECT COUNT(*)::text FROM article_collection_members m
    WHERE m.collection_id = k.collection_id AND ${memberEligibility}) AS member_total`;
const listCollectionsSql = `
  SELECT ${collectionColumns} FROM article_collection_entries k
  ORDER BY k.published_at DESC, k.collection_id DESC
  LIMIT $1::integer OFFSET $2::bigint`;
const countCollectionsSql = `SELECT COUNT(*)::text AS total FROM article_collection_entries`;
const findCollectionSql = `SELECT ${collectionColumns} FROM article_collection_entries k WHERE k.collection_id = $1`;
const listMembersSql = `
  SELECT m.collection_id, m.position, m.kind, m.article_id, m.catalog_id
  FROM article_collection_members m
  WHERE m.collection_id = $1 AND ${memberEligibility}
  ORDER BY m.position ASC`;
const representativeMediaSql = `
  SELECT media_id, catalog_id, position, is_representative, kind,
         alt_text, width, height, object_key
  FROM catalog_media
  WHERE catalog_id = ANY($1::text[]) AND is_representative
  ORDER BY catalog_id ASC`;
const catalogEntriesByIdSql = `
  SELECT catalog_id, kind, title, summary, period_label,
         dynasty, dynasty_state, date_text, date_text_state,
         province, province_state, prefecture, prefecture_state,
         county, county_state, current_location, current_location_state,
         current_custodian, current_custodian_state
  FROM catalog_entries WHERE catalog_id = ANY($1::text[])`;

const instant = (value: Date | null, fallback: Date): string =>
  (value ?? fallback).toISOString();

const text = (value: string | null): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const withReadTransaction = async <Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> => {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw asPostgresOperationError(error, "connect");
  }
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the originating failure.
    }
    throw asPostgresOperationError(error, "query");
  } finally {
    client.release();
  }
};

/**
 * PostgreSQL read adapter over the published-only editorial views, using the
 * same public read role as the Catalog adapter. Cover and section images are
 * the representative media of the referenced published Catalog record; a
 * reference to a record that is no longer published reads as no image.
 */
export class PostgresEditorialContentAdapter implements EditorialContentReadPort {
  constructor(private readonly pool: Pool) {}

  private async representativeMedia(
    client: PoolClient,
    catalogIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, EditorialMediaRecord>> {
    const ids = [...new Set(catalogIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await client.query<CatalogMediaRow>(representativeMediaSql, [
      ids,
    ]);
    const media = mapRepresentativeMediaRows(rows.rows);
    return new Map(
      [...media.entries()].map(([catalogId, projection]) => [
        catalogId,
        {
          id: projection.id,
          objectKey: projection.objectKey,
          alt: projection.alt,
          width: projection.width,
          height: projection.height,
        },
      ]),
    );
  }

  private summaries(
    rows: readonly ArticleEntryRow[],
    media: ReadonlyMap<string, EditorialMediaRecord>,
  ): ArticleSummaryRecord[] {
    return rows.map((row) => {
      const cover = row.cover_catalog_id
        ? media.get(row.cover_catalog_id)
        : undefined;
      return {
        id: row.article_id as ArticleId,
        presentation: row.presentation as ArticlePresentation,
        title: row.title,
        subtitle: text(row.subtitle),
        summary: text(row.summary),
        section: text(row.section),
        issue: text(row.issue),
        byline: row.byline,
        cover: cover
          ? { ...cover, alt: text(row.cover_alt) ?? cover.alt }
          : null,
        firstPublishedAt: instant(
          row.first_published_at,
          row.published_at ?? row.updated_at,
        ),
        publishedAt: instant(row.published_at, row.updated_at),
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }

  async listArticles(
    query: ArticleListQuery,
  ): Promise<EditorialPageRecord<ArticleSummaryRecord>> {
    return withReadTransaction(this.pool, async (client) => {
      const presentation = query.presentation ?? null;
      const count = await client.query<{ total: unknown }>(countArticlesSql, [
        presentation,
      ]);
      const total = parseCatalogCount(count.rows[0]?.total);
      const rows = await client.query<ArticleEntryRow>(listArticlesSql, [
        presentation,
        query.pageSize,
        String((query.page - 1) * query.pageSize),
      ]);
      const media = await this.representativeMedia(
        client,
        rows.rows.map((row) => row.cover_catalog_id),
      );
      return {
        items: this.summaries(rows.rows, media),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async findArticle(id: ArticleId): Promise<ArticleDetailRecord | null> {
    return withReadTransaction(this.pool, async (client) => {
      const entry = await client.query<ArticleEntryRow>(findArticleSql, [id]);
      const row = entry.rows[0];
      if (!row) return null;
      const [sections, citations] = await Promise.all([
        client.query<ArticleSectionRow>(listSectionsSql, [id]),
        client.query<ArticleCitationRow>(listCitationsSql, [id]),
      ]);
      const media = await this.representativeMedia(client, [
        row.cover_catalog_id,
        ...sections.rows.map((section) => section.image_catalog_id),
      ]);
      const [summary] = this.summaries([row], media);
      return {
        ...summary!,
        intro: text(row.intro),
        sections: sections.rows.map((section) => ({
          heading: text(section.heading),
          body: section.body,
          image: section.image_catalog_id
            ? (media.get(section.image_catalog_id) ?? null)
            : null,
          imageCaption: text(section.image_caption),
        })),
        citations: citations.rows.map((citation) => ({
          text: citation.text,
          url: text(citation.url),
        })),
      };
    });
  }

  async isArticlePublished(id: string): Promise<boolean> {
    try {
      const result = await this.pool.query(isArticlePublishedSql, [id]);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw asPostgresOperationError(error, "query");
    }
  }

  private collectionSummaries(
    rows: readonly CollectionEntryRow[],
    media: ReadonlyMap<string, EditorialMediaRecord>,
  ): ArticleCollectionSummaryRecord[] {
    return rows.map((row) => ({
      id: row.collection_id as ArticleCollectionId,
      title: row.title,
      subtitle: text(row.subtitle),
      summary: text(row.summary),
      category: text(row.category),
      issue: text(row.issue),
      cover:
        (row.cover_catalog_id ? media.get(row.cover_catalog_id) : undefined) ??
        null,
      memberTotal: parseCatalogCount(row.member_total),
      firstPublishedAt: instant(
        row.first_published_at,
        row.published_at ?? row.updated_at,
      ),
      publishedAt: instant(row.published_at, row.updated_at),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async listCollections(
    query: ArticleCollectionListQuery,
  ): Promise<EditorialPageRecord<ArticleCollectionSummaryRecord>> {
    return withReadTransaction(this.pool, async (client) => {
      const count = await client.query<{ total: unknown }>(countCollectionsSql);
      const total = parseCatalogCount(count.rows[0]?.total);
      const rows = await client.query<CollectionEntryRow>(listCollectionsSql, [
        query.pageSize,
        String((query.page - 1) * query.pageSize),
      ]);
      const media = await this.representativeMedia(
        client,
        rows.rows.map((row) => row.cover_catalog_id),
      );
      return {
        items: this.collectionSummaries(rows.rows, media),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async findCollection(
    id: ArticleCollectionId,
  ): Promise<ArticleCollectionDetailRecord | null> {
    return withReadTransaction(this.pool, async (client) => {
      const entry = await client.query<CollectionEntryRow>(findCollectionSql, [
        id,
      ]);
      const row = entry.rows[0];
      if (!row) return null;
      const members = await client.query<CollectionMemberRow>(listMembersSql, [
        id,
      ]);
      const articleIds = members.rows.flatMap((m) =>
        m.kind === "article" && m.article_id ? [m.article_id] : [],
      );
      const catalogIds = members.rows.flatMap((m) =>
        m.kind === "catalog" && m.catalog_id ? [m.catalog_id] : [],
      );
      const [articles, catalogs, aliases] = await Promise.all([
        articleIds.length
          ? client.query<ArticleEntryRow>(articlesByIdSql, [articleIds])
          : { rows: [] as ArticleEntryRow[] },
        catalogIds.length
          ? client.query<CatalogEntryRow>(catalogEntriesByIdSql, [catalogIds])
          : { rows: [] as CatalogEntryRow[] },
        catalogIds.length
          ? client.query<CatalogAliasRow>(listCatalogAliasesSql, [catalogIds])
          : { rows: [] as CatalogAliasRow[] },
      ]);
      const media = await this.representativeMedia(client, [
        row.cover_catalog_id,
        ...articles.rows.map((a) => a.cover_catalog_id),
        ...catalogIds,
      ]);
      const articleById = new Map(
        this.summaries(articles.rows, media).map((a) => [a.id as string, a]),
      );
      const aliasMap = mapAliasRows(aliases.rows);
      const catalogMedia = await client.query<CatalogMediaRow>(
        representativeMediaSql,
        [catalogIds.length ? catalogIds : ["-"]],
      );
      const representative = mapRepresentativeMediaRows(catalogMedia.rows);
      const catalogById = new Map(
        catalogs.rows.map((entry) => [
          String(entry.catalog_id),
          mapCatalogEntryRow(
            entry,
            aliasMap.get(String(entry.catalog_id)) ?? [],
            representative.get(String(entry.catalog_id)),
          ),
        ]),
      );
      const resolvedMembers: ArticleCollectionMemberRecord[] = [];
      for (const member of members.rows) {
        if (member.kind === "article" && member.article_id) {
          const article = articleById.get(member.article_id);
          if (article)
            resolvedMembers.push({
              kind: "article",
              position: member.position,
              article,
            });
        } else if (member.kind === "catalog" && member.catalog_id) {
          const record = catalogById.get(member.catalog_id);
          if (record)
            resolvedMembers.push({
              kind: "catalog",
              position: member.position,
              record,
            });
        }
      }
      const [summary] = this.collectionSummaries([row], media);
      return { ...summary!, members: resolvedMembers };
    });
  }
}
