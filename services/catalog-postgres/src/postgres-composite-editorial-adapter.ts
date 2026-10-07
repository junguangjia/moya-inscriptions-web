import {
  articleAuthoringDocumentSchema,
  articleMediaReferenceSchema,
} from "@moya/contracts/schemas";
import type {
  ArticleCollectionDetailRecord,
  ArticleCollectionSummaryRecord,
  ArticleDetailRecord,
  ArticleSummaryRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
  EditorialPageRecord,
  PublishedAuthoredArticle,
  PublishedAuthoredArticleSummary,
} from "@moya/api";
import type {
  ArticleCollectionId,
  ArticleCollectionListQuery,
  ArticleId,
  ArticleListQuery,
  ArticlePresentation,
  MediaId,
  PublicUserId,
} from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { asPostgresOperationError } from "./availability.js";
import { parseCatalogCount } from "./adapter.js";
import {
  catalogMediaDeliveryJoinSql,
  mapCatalogMediaDelivery,
} from "./catalog-media-delivery.js";
import type { CatalogReaderOptions } from "./catalog-media-delivery.js";

/** The resolver uses only effective references and owner-authorized derivatives. */
export interface AuthoredArticleReadProjector {
  summary(
    value: PublishedAuthoredArticleSummary,
  ): Promise<ArticleSummaryRecord>;
  detail(value: PublishedAuthoredArticle): Promise<ArticleDetailRecord>;
}

interface IndexRow extends QueryResultRow {
  source: "staff" | "authored";
  article_id: string;
  presentation: string;
  title: string;
  subtitle: string | null;
  summary: string | null;
  section: string | null;
  issue: string | null;
  byline: string;
  first_published_at: Date | null;
  published_at: Date | null;
  updated_at: Date;
  owner_id: string | null;
  version: number | null;
  cover_ref_id: string | null;
  cover_reference: unknown;
  fingerprint: string | null;
  media_id: string | null;
  object_key: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  /** Staff cover delivery facts; present only with renditions. */
  renditions?: unknown;
  placeholder_color?: unknown;
}
interface AuthoredDetailRow extends QueryResultRow {
  article_id: string;
  owner_id: string;
  version: number;
  title: string;
  cover_ref_id: string | null;
  document: unknown;
  fingerprint: string;
  byline: string;
  first_published_at: Date | null;
  published_at: Date;
  updated_at: Date;
}

// Both sources are ordered and paged together. No full body is selected here.
// With renditions, a staff cover also carries its rendition delivery facts.
const indexSqlOf = (renditions: boolean) => `
SELECT 'staff'::text AS source,a.article_id,a.presentation,a.title,a.subtitle,
  a.summary,a.section,a.issue,a.byline,a.first_published_at,a.published_at,a.updated_at,
  NULL::text AS owner_id,NULL::integer AS version,NULL::text AS cover_ref_id,
  NULL::jsonb AS cover_reference,NULL::text AS fingerprint,
  cm.media_id,cm.object_key,CASE WHEN BTRIM(a.cover_alt)<>'' THEN a.cover_alt ELSE cm.alt_text END AS alt,cm.width,cm.height${renditions ? ",delivery.renditions,delivery.placeholder_color" : ""}
FROM public.article_entries a
LEFT JOIN public.catalog_media cm ON cm.catalog_id=a.cover_catalog_id AND cm.is_representative${renditions ? catalogMediaDeliveryJoinSql("cm") : ""}
UNION ALL
SELECT 'authored'::text,a.article_id,'academic'::text,a.title,NULL::text,
  NULL::text,NULL::text,NULL::text,a.byline,a.first_published_at,a.published_at,a.updated_at,
  a.owner_id,a.version,a.cover_ref_id,a.cover_reference,a.fingerprint,
  NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer${renditions ? ",NULL::jsonb,NULL::text" : ""}
FROM community.published_authored_articles a`;
const indexSql = indexSqlOf(false);
const nullText = (value: string | null): string | null =>
  value?.trim() ? value : null;

const authoredSummary = (row: IndexRow): PublishedAuthoredArticleSummary => {
  if (row.owner_id === null || row.version === null || row.fingerprint === null)
    throw new Error("Invalid published Article projection");
  return {
    id: row.article_id as ArticleId,
    ownerId: row.owner_id as PublicUserId,
    version: row.version,
    title: row.title,
    coverRefId: row.cover_ref_id,
    coverReference:
      row.cover_reference === null
        ? null
        : articleMediaReferenceSchema.parse(row.cover_reference),
    fingerprint: row.fingerprint,
    byline: row.byline,
    firstPublishedAt: (
      row.first_published_at ??
      row.published_at ??
      row.updated_at
    ).toISOString(),
    publishedAt: (row.published_at ?? row.updated_at).toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
};
const staffSummary = (row: IndexRow): ArticleSummaryRecord => {
  let cover: EditorialMediaRecord | null = null;
  if (
    row.media_id !== null &&
    row.object_key !== null &&
    row.width !== null &&
    row.height !== null
  )
    cover = {
      id: row.media_id as MediaId,
      objectKey: row.object_key,
      alt: row.alt ?? "",
      width: row.width,
      height: row.height,
      ...mapCatalogMediaDelivery(row.renditions, row.placeholder_color),
    };
  return {
    id: row.article_id as ArticleId,
    presentation: row.presentation as ArticlePresentation,
    title: row.title,
    subtitle: nullText(row.subtitle),
    summary: nullText(row.summary),
    section: nullText(row.section),
    issue: nullText(row.issue),
    byline: row.byline,
    cover,
    firstPublishedAt: (
      row.first_published_at ??
      row.published_at ??
      row.updated_at
    ).toISOString(),
    publishedAt: (row.published_at ?? row.updated_at).toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
};

/**
 * Same Article read port: staff CMS and authored immutable snapshots compose.
 * With `renditions`, staff covers carry their rendition delivery facts.
 */
export class PostgresCompositeEditorialAdapter implements EditorialContentReadPort {
  private readonly pageSql: string;

  constructor(
    private readonly pool: Pool,
    private readonly staff: EditorialContentReadPort,
    private readonly authored: AuthoredArticleReadProjector,
    options: CatalogReaderOptions = {},
  ) {
    this.pageSql = options.renditions === true ? indexSqlOf(true) : indexSql;
  }

  private async read<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asPostgresOperationError(error, "connect");
    });
    try {
      await db.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asPostgresOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  async listArticles(
    query: ArticleListQuery,
  ): Promise<EditorialPageRecord<ArticleSummaryRecord>> {
    const raw = await this.read(async (db) => {
      const filter = query.presentation ?? null;
      const count = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM (${indexSql}) a WHERE ($1::text IS NULL OR a.presentation=$1)`,
        [filter],
      );
      const rows = await db.query<IndexRow>(
        `SELECT * FROM (${this.pageSql}) a WHERE ($1::text IS NULL OR a.presentation=$1) ORDER BY a.published_at DESC,a.article_id DESC LIMIT $2::integer OFFSET $3::bigint`,
        [filter, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        rows: rows.rows,
        total: parseCatalogCount(count.rows[0]?.total),
      };
    });
    const items = await Promise.all(
      raw.rows.map((row) =>
        row.source === "authored"
          ? this.authored.summary(authoredSummary(row))
          : staffSummary(row),
      ),
    );
    return {
      items,
      total: raw.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findArticle(id: ArticleId): Promise<ArticleDetailRecord | null> {
    const row = await this.read(
      async (db) =>
        (
          await db.query<AuthoredDetailRow>(
            "SELECT article_id,owner_id,version,title,cover_ref_id,document,fingerprint,byline,first_published_at,published_at,updated_at FROM community.published_authored_articles WHERE article_id=$1",
            [id],
          )
        ).rows[0],
    );
    if (!row) return this.staff.findArticle(id);
    const publication: PublishedAuthoredArticle = {
      id: row.article_id as ArticleId,
      ownerId: row.owner_id as PublicUserId,
      version: row.version,
      title: row.title,
      coverRefId: row.cover_ref_id,
      document: articleAuthoringDocumentSchema.parse(row.document),
      fingerprint: row.fingerprint,
      byline: row.byline,
      firstPublishedAt: (
        row.first_published_at ??
        row.published_at ??
        row.updated_at
      ).toISOString(),
      publishedAt: (row.published_at ?? row.updated_at).toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
    return this.authored.detail(publication);
  }

  isArticlePublished(id: string): Promise<boolean> {
    return this.read(
      async (db) =>
        (
          await db.query(
            `SELECT 1 FROM public.article_entries WHERE article_id=$1 UNION ALL SELECT 1 FROM community.published_authored_articles WHERE article_id=$1 LIMIT 1`,
            [id],
          )
        ).rowCount !== 0,
    );
  }
  listCollections(
    query: ArticleCollectionListQuery,
  ): Promise<EditorialPageRecord<ArticleCollectionSummaryRecord>> {
    return this.staff.listCollections(query);
  }
  findCollection(
    id: ArticleCollectionId,
  ): Promise<ArticleCollectionDetailRecord | null> {
    return this.staff.findCollection(id);
  }
}
