import { randomUUID } from "node:crypto";

import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresAuthoredArticleCatalogMediaResolver,
  PostgresCompositeEditorialAdapter,
} from "@moya/catalog-postgres";
import { ARTICLE_PAGE_SIZE_MAXIMUM } from "@moya/contracts/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as publishedCatalogViews from "admin/published";
import { createPublishedArticleViewsSql } from "admin/editorial-content";

import type {
  ArticleSummaryRecord,
  EditorialContentReadPort,
  StorageUrlResolver,
} from "@moya/api";
import type { ArticleListQuery } from "@moya/contracts";

/*
 * catalog-scale-v1 S5: the Article Catalog resolver and the composite
 * editorial index keep their PR #320 joins and add one restriction on
 * `catalog_media` alone (the bound media ids; the cover ids gathered once).
 * On cloned Payload tables with the real published views, each statement a
 * reader sends is the frozen #320 text plus that one restriction, byte for
 * byte, and returns exactly the #320 rows (published, draft, withdrawn,
 * duplicate-media and missing rows; before and after the M1 view shape).
 * Before M1 a statement reads `catalogs_media` no more often than #320 did
 * (a LATERAL form read it once per pair or Article); after M1 it reads no
 * `catalogs_media` row by Seq Scan.
 *
 * Both readers name their relations `public.` (and the composite index and
 * the rendition join `community.`). This run's owned schema stands in for
 * both: the recording pool below rewrites only those qualifiers, so shared
 * CMS content is never read and the SQL under test is otherwise unchanged.
 */

const testDatabaseUrl = process.env.CMS_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("CMS_TEST_DATABASE_URL is required for CMS view tests");
}
const baseConfig = parsePostgresConfig({ DATABASE_URL: testDatabaseUrl });
const schema = `cms_article_reads_${randomUUID().replaceAll("-", "")}`;
const schemaConnection = new URL(baseConfig.connectionString);
schemaConnection.searchParams.set("options", `-csearch_path=${schema},public`);
const adminPool = createPostgresPool(baseConfig);
const pool = createPostgresPool({
  ...baseConfig,
  connectionString: schemaConnection.toString(),
});
type Pool = typeof pool;

// Real migrated Payload table definitions, as read-views clones them; every
// table the published Catalog and Article views name.
const sourceTables = [
  "catalogs",
  "catalogs_aliases",
  "catalogs_contributors",
  "catalogs_source_citations",
  "catalogs_source_citations_applies_to",
  "catalogs_media",
  "articles",
  "articles_sections",
  "articles_citations",
  "article_collections",
  "article_collections_members",
] as const;

const redirect = (sql: string): string =>
  sql.replaceAll(/\b(?:public|community)\./gu, `"${schema}".`);

type Row = Readonly<Record<string, unknown>>;
interface Recorded {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly rows: readonly Row[];
}
let recorded: Recorded[] = [];

/** The readers' own pool contract (connect, query, release), recorded. */
const recordingPool = {
  connect: async () => {
    const client = await pool.connect();
    return {
      query: async (sql: string, values: unknown[] = []) => {
        const result = await client.query(redirect(sql), values);
        recorded.push({ sql: redirect(sql), values, rows: result.rows });
        return result;
      },
      release: () => client.release(),
    };
  },
} as unknown as Pool;

/** The one recorded statement that matches, with its values and rows. */
const statement = (pattern: RegExp): Recorded => {
  const matches = recorded.filter(({ sql }) => pattern.test(sql));
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

/*
 * The PR #320 statements (head 4176eed4), frozen as the oracle: the rendition
 * join, the resolver statement, the composite index and its count and page
 * wrappers, exactly as the readers sent them before S5.
 */
const deliveryJoin320 = (media: string): string => `
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'key', d.delivery_key, 'width', d.width, 'height', d.height,
             'contentType', d.content_type, 'level', d.level)
           ORDER BY d.width, d.height,
             array_position(ARRAY['thumb','cover','display','viewer','full'], d.role)
           ) AS renditions,
           min(d.placeholder_color) AS placeholder_color
    FROM community.catalog_media_delivery d
    WHERE d.media_id = ${media}.media_id AND d.object_key = ${media}.object_key
  ) delivery ON TRUE`;
const pairSql320 = (renditions: boolean) => `
        SELECT cm.media_id,cm.catalog_id,cm.position,cm.is_representative,cm.kind,
          cm.alt_text,cm.width,cm.height,cm.object_key${renditions ? ",delivery.renditions,delivery.placeholder_color" : ""}
        FROM jsonb_to_recordset($1::jsonb) AS pair("catalogId" text,"mediaId" text)
        JOIN public.catalog_entries ce ON ce.catalog_id=pair."catalogId"
        JOIN public.catalog_media cm ON cm.catalog_id=ce.catalog_id AND cm.media_id=pair."mediaId"${renditions ? deliveryJoin320("cm") : ""}
        ORDER BY cm.catalog_id,cm.media_id`;
const indexSql320 = (renditions: boolean) => `
SELECT 'staff'::text AS source,a.article_id,a.presentation,a.title,a.subtitle,
  a.summary,a.section,a.issue,a.byline,a.first_published_at,a.published_at,a.updated_at,
  NULL::text AS owner_id,NULL::integer AS version,NULL::text AS cover_ref_id,
  NULL::jsonb AS cover_reference,NULL::text AS fingerprint,
  cm.media_id,cm.object_key,CASE WHEN BTRIM(a.cover_alt)<>'' THEN a.cover_alt ELSE cm.alt_text END AS alt,cm.width,cm.height${renditions ? ",delivery.renditions,delivery.placeholder_color" : ""}
FROM public.article_entries a
LEFT JOIN public.catalog_media cm ON cm.catalog_id=a.cover_catalog_id AND cm.is_representative${renditions ? deliveryJoin320("cm") : ""}
UNION ALL
SELECT 'authored'::text,a.article_id,'academic'::text,a.title,NULL::text,
  NULL::text,NULL::text,NULL::text,a.byline,a.first_published_at,a.published_at,a.updated_at,
  a.owner_id,a.version,a.cover_ref_id,a.cover_reference,a.fingerprint,
  NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer${renditions ? ",NULL::jsonb,NULL::text" : ""}
FROM community.published_authored_articles a`;
const countSql320 = `SELECT COUNT(*)::text AS total FROM (${indexSql320(false)}) a WHERE ($1::text IS NULL OR a.presentation=$1)`;
const pageSql320 = (renditions: boolean) =>
  `SELECT * FROM (${indexSql320(renditions)}) a WHERE ($1::text IS NULL OR a.presentation=$1) ORDER BY a.published_at DESC,a.article_id DESC LIMIT $2::integer OFFSET $3::bigint`;

// The one restriction S5 adds to each statement, as the readers write it.
const pairRestriction = `
          AND cm.media_id=ANY($2::text[])`;
const coverRestriction = `
  AND cm.catalog_id=ANY(ARRAY(SELECT x.cover_catalog_id FROM public.article_entries x WHERE x.cover_catalog_id IS NOT NULL))`;

/** The statement is the frozen #320 text plus exactly one S5 restriction. */
const expectS5Form = (
  captured: Recorded,
  frozen: string,
  restriction: string,
) => {
  const parts = captured.sql.split(redirect(restriction));
  expect(parts).toHaveLength(2);
  expect(parts.join("")).toBe(redirect(frozen));
};

/** Rows of the frozen #320 statement, run on the same data and values. */
const rows320 = async (
  frozen: string,
  values: readonly unknown[],
): Promise<readonly Row[]> =>
  (await pool.query(redirect(frozen), [...values])).rows;

/** A total order for comparing row multisets whose ORDER BY leaves ties. */
const canonical = (rows: readonly Row[]) =>
  rows.map((row) => JSON.stringify(row)).sort();

const expectSameRows = (
  rewritten: readonly Row[],
  original: readonly Row[],
  orderedBy: readonly string[],
) => {
  expect(canonical(rewritten)).toEqual(canonical(original));
  // The statement's own ORDER BY key sequence is identical too.
  const key = (row: Row) =>
    JSON.stringify(orderedBy.map((column) => row[column]));
  expect(rewritten.map(key)).toEqual(original.map(key));
};

const objectKey = (mediaId: string, variant = "") =>
  `synthetic/article-reads/${mediaId}${variant}.webp`;
const storage: StorageUrlResolver = {
  resolveMany: async (locators) =>
    new Map(
      locators.map(({ mediaId, objectKey: key }) => [
        mediaId,
        `https://media.example.invalid/${key}`,
      ]),
    ),
};
const projector = {
  summary: async (value: { readonly id: string }) =>
    ({ id: value.id }) as unknown as ArticleSummaryRecord,
  detail: async () => {
    throw new Error("No Article detail is read here");
  },
};
const compositeOf = (renditions: boolean) =>
  new PostgresCompositeEditorialAdapter(
    recordingPool,
    {} as EditorialContentReadPort,
    projector,
    renditions ? { renditions: true } : {},
  );
const resolverOf = (renditions: boolean) =>
  new PostgresAuthoredArticleCatalogMediaResolver(
    recordingPool,
    storage,
    renditions ? { renditions: true } : {},
  );

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const table of sourceTables) {
    await pool.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  await pool.query(publishedCatalogViews.createPublishedCatalogViewsSql);
  await pool.query(createPublishedArticleViewsSql);
  // Stand-ins for the App relations the composite index and the rendition
  // join name; their shape is what those SQL statements select.
  await pool.query(
    `CREATE TABLE published_authored_articles(
       article_id text PRIMARY KEY, owner_id text, version integer, title text,
       cover_ref_id text, cover_reference jsonb, fingerprint text, byline text,
       first_published_at timestamptz, published_at timestamptz, updated_at timestamptz);
     CREATE TABLE catalog_media_delivery(
       media_id text, object_key text, delivery_key text, width integer,
       height integer, content_type text, level text, role text,
       placeholder_color text)`,
  );
}, 30_000);

afterAll(async () => {
  await closePostgresPool(pool);
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await closePostgresPool(adminPool);
  }
});

const clear = async () => {
  for (const table of [
    ...sourceTables,
    "published_authored_articles",
    "catalog_media_delivery",
  ])
    await pool.query(`DELETE FROM "${table}"`);
};

const insertCatalog = (
  id: number,
  catalogId: string,
  status: "draft" | "published",
) =>
  pool.query(
    `INSERT INTO catalogs (id, catalog_id, source_id, kind, title, _status)
     VALUES ($1, $2, $3, 'inscription', $4, $5)`,
    [id, catalogId, `synthetic-source-${id}`, `合成资料${id}`, status],
  );

const insertMedia = (
  row: string,
  parent: number,
  order: number,
  mediaId: string,
  representative: boolean,
  key = objectKey(mediaId),
) =>
  pool.query(
    `INSERT INTO catalogs_media
      (id, _parent_id, _order, media_id, object_key, width, height, alt, position, is_representative)
     VALUES ($1, $2, $3, $4, $5, 4096, 2731, $6, $7, $8)`,
    [
      row,
      parent,
      order,
      mediaId,
      key,
      `合成图片 ${mediaId}`,
      order - 1,
      representative,
    ],
  );

const insertArticle = (
  id: number,
  options: {
    readonly cover?: number | null;
    readonly coverAlt?: string | null;
    readonly status?: "draft" | "published";
    readonly presentation?: "academic" | "news";
    readonly publishedAt?: string;
  } = {},
) =>
  pool.query(
    `INSERT INTO articles
      (id, article_id, presentation, title, byline, cover_catalog_id, cover_alt,
       first_published_at, published_at, updated_at, _status)
     VALUES ($1, $2, $3, $4, '合成编辑室', $5, $6, $7, $7, $7, $8)`,
    [
      id,
      `article-${id.toString(16).padStart(32, "0")}`,
      options.presentation ?? "academic",
      `合成文章${id}`,
      options.cover ?? null,
      options.coverAlt ?? null,
      options.publishedAt ?? `2026-10-${String(id).padStart(2, "0")}T00:00:00Z`,
      options.status ?? "published",
    ],
  );

const deliveryKey = (n: number) =>
  `media-rendition-${n.toString(16).padStart(32, "0")}`;

/*
 * Published records (1-3, 6, 7), a draft (4), a record withdrawn mid-test (5),
 * a media id repeated in one record with two object keys (1), one media id in
 * two records (2, 3), two representative images in one record (3), a record
 * with no representative image (6) and one with no image at all (7).
 */
const seed = async () => {
  await clear();
  await insertCatalog(1, "reads-catalog-a", "published");
  await insertCatalog(2, "reads-catalog-b", "published");
  await insertCatalog(3, "reads-catalog-c", "published");
  await insertCatalog(4, "reads-catalog-draft", "draft");
  await insertCatalog(5, "reads-catalog-withdrawn", "published");
  await insertCatalog(6, "reads-catalog-no-cover", "published");
  await insertCatalog(7, "reads-catalog-empty", "published");
  await insertMedia("row-a1", 1, 1, "reads-media-a1", true);
  await insertMedia("row-a2", 1, 2, "reads-media-a2", false);
  await insertMedia(
    "row-a2-again",
    1,
    3,
    "reads-media-a2",
    false,
    objectKey("reads-media-a2", "-again"),
  );
  await insertMedia("row-b1", 2, 1, "reads-media-b1", true);
  await insertMedia(
    "row-b-shared",
    2,
    2,
    "reads-media-shared",
    false,
    objectKey("reads-media-shared", "-b"),
  );
  await insertMedia("row-c1", 3, 1, "reads-media-c1", true);
  await insertMedia("row-c2", 3, 2, "reads-media-c2", true);
  await insertMedia(
    "row-c-shared",
    3,
    3,
    "reads-media-shared",
    false,
    objectKey("reads-media-shared", "-c"),
  );
  await insertMedia("row-d1", 4, 1, "reads-media-d1", true);
  await insertMedia("row-w1", 5, 1, "reads-media-w1", true);
  await insertMedia("row-n1", 6, 1, "reads-media-n1", false);
  await insertArticle(1, { cover: 1, coverAlt: "文章自定封面说明" });
  await insertArticle(2, { cover: 3, coverAlt: "   " });
  await insertArticle(3, { cover: 4 });
  await insertArticle(4, { cover: null });
  await insertArticle(5, { cover: 6 });
  await insertArticle(6, { cover: 1, status: "draft" });
  await insertArticle(7, { cover: 5 });
  await insertArticle(8, { cover: 2, presentation: "news" });
  await insertArticle(9, { cover: 7, presentation: "news" });
  // Two Articles at one instant: ties of the index order stay ties.
  await insertArticle(10, {
    cover: 3,
    publishedAt: "2026-10-02T00:00:00Z",
  });
  await pool.query(
    `INSERT INTO published_authored_articles VALUES
       ('article-authored-reads', 'user-reads', 1, '合成作者文章', NULL, NULL,
        $1, '合成作者', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')`,
    ["f".repeat(64)],
  );
  for (const [n, mediaId, key, level] of [
    [1, "reads-media-a1", objectKey("reads-media-a1"), "card"],
    [2, "reads-media-a1", objectKey("reads-media-a1"), "display"],
    [3, "reads-media-c1", objectKey("reads-media-c1"), "card"],
    [4, "reads-media-shared", objectKey("reads-media-shared", "-b"), "card"],
    // A fact of another object key never attaches to this media id.
    [5, "reads-media-a2", objectKey("reads-media-a2", "-stale"), "card"],
  ] as const)
    await pool.query(
      `INSERT INTO catalog_media_delivery VALUES
         ($1, $2, $3, $4, $5, 'image/webp', $6, 'thumb', '#3a2f28')`,
      [mediaId, key, deliveryKey(n), 480 * n, 320 * n, level],
    );
};

const requestedPairs = [
  { catalogId: "reads-catalog-a", mediaId: "reads-media-a1" },
  // Two rows: the same media id under two object keys of one record.
  { catalogId: "reads-catalog-a", mediaId: "reads-media-a2" },
  { catalogId: "reads-catalog-b", mediaId: "reads-media-shared" },
  { catalogId: "reads-catalog-c", mediaId: "reads-media-shared" },
  { catalogId: "reads-catalog-c", mediaId: "reads-media-c2" },
  { catalogId: "reads-catalog-draft", mediaId: "reads-media-d1" },
  { catalogId: "reads-catalog-withdrawn", mediaId: "reads-media-w1" },
  // Another record's image is never answered for this record.
  { catalogId: "reads-catalog-a", mediaId: "reads-media-b1" },
  { catalogId: "reads-catalog-missing", mediaId: "reads-media-a1" },
  { catalogId: "reads-catalog-b", mediaId: "reads-media-missing" },
];
const pairKey = (catalogId: string, mediaId: string) =>
  JSON.stringify([catalogId, mediaId]);

/** One Article resolver read: its statement, its rows and the #320 rows. */
const resolverRead = async (
  renditions: boolean,
  pairs: readonly { readonly catalogId: string; readonly mediaId: string }[],
) => {
  recorded = [];
  const resolved = await resolverOf(renditions).resolveCatalog(pairs as never);
  const captured = statement(/jsonb_to_recordset/u);
  const frozen = pairSql320(renditions);
  expectS5Form(captured, frozen, pairRestriction);
  // `$2` is each requested media id once; #320 bound only the pairs.
  expect(captured.values).toEqual([
    JSON.stringify(pairs),
    [...new Set(pairs.map(({ mediaId }) => mediaId))],
  ]);
  return {
    resolved,
    captured,
    frozen,
    original: await rows320(frozen, captured.values.slice(0, 1)),
  };
};

/** One composite index page: count and page statements, and #320's rows. */
const indexRead = async (
  renditions: boolean,
  query: ArticleListQuery = { page: 1, pageSize: ARTICLE_PAGE_SIZE_MAXIMUM },
) => {
  recorded = [];
  const page = await compositeOf(renditions).listArticles(query);
  const count = statement(/COUNT\(\*\)/u);
  const rows = statement(/ORDER BY a\.published_at DESC/u);
  expectS5Form(count, countSql320, coverRestriction);
  expectS5Form(rows, pageSql320(renditions), coverRestriction);
  return {
    page,
    count,
    rows,
    frozenCount: countSql320,
    frozenRows: pageSql320(renditions),
    originalCount: await rows320(countSql320, count.values),
    originalRows: await rows320(pageSql320(renditions), rows.values),
  };
};

const equalityCases = () =>
  describe("rows of the S5 statements against the frozen #320 statements", () => {
    beforeEach(seed);

    for (const renditions of [false, true]) {
      const variant = renditions ? "with renditions" : "without renditions";

      it(`answers the Article resolver's pairs exactly as #320 did (${variant})`, async () => {
        const { resolved, captured, original } = await resolverRead(
          renditions,
          requestedPairs,
        );
        expectSameRows(captured.rows, original, ["catalog_id", "media_id"]);
        // The fixture reaches the duplicate and shared-media cases.
        expect(
          original.filter(({ media_id }) => media_id === "reads-media-a2"),
        ).toHaveLength(2);
        expect(
          original.filter(({ media_id }) => media_id === "reads-media-shared"),
        ).toHaveLength(2);
        expect([...resolved.keys()].sort()).toEqual(
          [
            pairKey("reads-catalog-a", "reads-media-a1"),
            pairKey("reads-catalog-a", "reads-media-a2"),
            pairKey("reads-catalog-b", "reads-media-shared"),
            pairKey("reads-catalog-c", "reads-media-shared"),
            pairKey("reads-catalog-c", "reads-media-c2"),
            pairKey("reads-catalog-withdrawn", "reads-media-w1"),
          ].sort(),
        );
        if (renditions)
          expect(
            captured.rows.find(({ media_id }) => media_id === "reads-media-a1")
              ?.renditions,
          ).toHaveLength(2);
      });

      it(`pages and counts the composite index exactly as #320 did (${variant})`, async () => {
        for (const presentation of [undefined, "news"] as const) {
          const read = await indexRead(renditions, {
            page: 1,
            pageSize: ARTICLE_PAGE_SIZE_MAXIMUM,
            ...(presentation === undefined ? {} : { presentation }),
          });
          expectSameRows(read.count.rows, read.originalCount, ["total"]);
          expectSameRows(read.rows.rows, read.originalRows, [
            "published_at",
            "article_id",
          ]);
          expect(read.page.total).toBe(Number(read.originalCount[0]!.total));
        }
        const { rows, originalRows } = await indexRead(renditions);
        const coverOf = (id: number) =>
          originalRows
            .filter(
              ({ article_id }) =>
                article_id === `article-${id.toString(16).padStart(32, "0")}`,
            )
            .map(({ media_id }) => media_id as string | null)
            .sort();
        // The fixture reaches each cover case: two representative images
        // (duplicate rows), a draft or empty or image-less cover (one NULL
        // row), no cover, and a draft Article (absent).
        expect(coverOf(2)).toEqual(["reads-media-c1", "reads-media-c2"]);
        for (const id of [3, 4, 5, 9]) expect(coverOf(id)).toEqual([null]);
        expect(coverOf(6)).toEqual([]);
        expect(rows.rows.some(({ source }) => source === "authored")).toBe(
          true,
        );
      });
    }

    it("pages the composite index past its first page exactly as #320 did", async () => {
      for (const page of [1, 2, 3]) {
        const read = await indexRead(true, { page, pageSize: 4 });
        expectSameRows(read.rows.rows, read.originalRows, [
          "published_at",
          "article_id",
        ]);
      }
    });

    it("drops a withdrawn record from both reads on the next request, as #320 does", async () => {
      await pool.query(
        "UPDATE catalogs SET _status = 'draft' WHERE catalog_id = 'reads-catalog-withdrawn'",
      );
      const resolver = await resolverRead(false, requestedPairs);
      expectSameRows(resolver.captured.rows, resolver.original, [
        "catalog_id",
        "media_id",
      ]);
      expect(
        resolver.resolved.has(
          pairKey("reads-catalog-withdrawn", "reads-media-w1"),
        ),
      ).toBe(false);
      const index = await indexRead(false);
      expectSameRows(index.rows.rows, index.originalRows, [
        "published_at",
        "article_id",
      ]);
      expect(
        index.rows.rows.find(
          ({ article_id }) =>
            article_id === `article-${(7).toString(16).padStart(32, "0")}`,
        ),
      ).toMatchObject({ media_id: null, object_key: null });
    });
  });

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Loops"?: number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodes),
];
/** The executed plan's nodes on `catalogs_media` (EXPLAIN ANALYZE; a read). */
const mediaScans = async (sql: string, values: readonly unknown[]) => {
  const plan = await pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
    `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`,
    [...values],
  );
  return nodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan).filter(
    (node) => node["Relation Name"] === "catalogs_media",
  );
};
const loops = (scans: readonly PlanNode[]) =>
  scans.reduce((sum, node) => sum + (node["Actual Loops"] ?? 0), 0);
const seqScans = (scans: readonly PlanNode[]) =>
  scans.filter((node) => node["Node Type"].endsWith("Seq Scan"));

/*
 * The plan of each statement on about 20,000 images. On the fenced #320 view
 * a statement reads `catalogs_media` no more often than the frozen #320
 * statement (one pass); after M1 it reads no `catalogs_media` row by Seq
 * Scan, while the #320 statement still does.
 */
const planCases = (phase: "fenced" | "M1") =>
  describe("plans at about 20,000 images", () => {
    beforeAll(async () => {
      await clear();
      // 3,000 records (every 30th a draft) × 7 images = 21,000 media rows,
      // and 50 Articles with covers, as R7 sizes the Payload clone.
      await pool.query(
        `INSERT INTO catalogs (id, catalog_id, source_id, kind, title, _status)
         SELECT n, 'scale-catalog-' || n, 'scale-source-' || n, 'inscription',
           '合成资料' || n,
           (CASE WHEN n % 30 = 0 THEN 'draft' ELSE 'published' END)::enum_catalogs_status
         FROM generate_series(1, 3000) AS n`,
      );
      await pool.query(
        `INSERT INTO catalogs_media
           (id, _parent_id, _order, media_id, object_key, width, height, alt, position, is_representative)
         SELECT 'scale-row-' || c || '-' || k, c, k, 'scale-media-' || c || '-' || k,
           'synthetic/scale/' || md5(c || ':' || k) || '.webp', 4096, 2731,
           '合成图片', k - 1, k = 1
         FROM generate_series(1, 3000) AS c CROSS JOIN generate_series(1, 7) AS k`,
      );
      await pool.query(
        `INSERT INTO articles
           (id, article_id, presentation, title, byline, cover_catalog_id,
            first_published_at, published_at, updated_at, _status)
         SELECT n, 'article-' || lpad(to_hex(n), 32, '0'), 'academic', '合成文章' || n,
           '合成编辑室', n * 37, now() - n * interval '1 hour',
           now() - n * interval '1 hour', now(), 'published'
         FROM generate_series(1, 50) AS n`,
      );
      await pool.query(
        "ANALYZE catalogs, catalogs_media, articles, published_authored_articles, catalog_media_delivery",
      );
    }, 60_000);

    const expectPlan = async (
      captured: Recorded,
      frozen: string,
      frozenValues: readonly unknown[],
    ) => {
      const scans = await mediaScans(captured.sql, captured.values);
      const scans320 = await mediaScans(redirect(frozen), frozenValues);
      expect(loops(scans)).toBeGreaterThan(0);
      if (phase === "fenced") {
        // One pass over the fenced view, as #320 (LATERAL: once per row).
        expect(loops(seqScans(scans))).toBeLessThanOrEqual(
          loops(seqScans(scans320)),
        );
        expect(loops(scans)).toBeLessThanOrEqual(loops(scans320));
      } else {
        expect(seqScans(scans)).toEqual([]);
        // The #320 join qual cannot enter the view: it is read whole.
        expect(seqScans(scans320)).not.toEqual([]);
      }
    };

    for (const renditions of [false, true]) {
      const variant = renditions ? "with renditions" : "without renditions";

      it(`reads catalogs_media for the requested pairs (k = 7 and 60, ${phase}, ${variant})`, async () => {
        for (const pairs of [
          Array.from({ length: 7 }, (_, k) => ({
            catalogId: "scale-catalog-1234",
            mediaId: `scale-media-1234-${k + 1}`,
          })),
          // Records 1, 31, 61, …: published (every 30th record is a draft).
          Array.from({ length: 60 }, (_, n) => ({
            catalogId: `scale-catalog-${n * 30 + 1}`,
            mediaId: `scale-media-${n * 30 + 1}-${(n % 7) + 1}`,
          })),
        ]) {
          const { resolved, captured, frozen } = await resolverRead(
            renditions,
            pairs,
          );
          expect(resolved.size).toBe(pairs.length);
          await expectPlan(captured, frozen, captured.values.slice(0, 1));
        }
      });

      it(`reads catalogs_media for the index covers (${phase}, ${variant})`, async () => {
        const read = await indexRead(renditions, { page: 1, pageSize: 24 });
        expect(read.page.total).toBe(50);
        await expectPlan(read.count, read.frozenCount, read.count.values);
        await expectPlan(read.rows, read.frozenRows, read.rows.values);
      });
    }
  });

/*
 * M1 (S4) exports its upgrade SQL from `admin/published`; this run applies
 * that export, redirected to its own schema.
 */
const m1 = {
  source: "admin/published upgradePublishedCatalogMediaViewSql",
  sql: publishedCatalogViews.upgradePublishedCatalogMediaViewSql,
};

describe("S5 reads on the fenced #320 published views (OFFSET 0)", () => {
  equalityCases();
  planCases("fenced");
});

describe(`S5 reads after the M1 view shape, from ${m1.source}`, () => {
  beforeAll(async () => {
    const sql = redirect(m1.sql);
    // Applied to this run's schema only; no other qualifier is left.
    expect(sql).not.toMatch(/\b(?:public|community)"?\s*\./iu);
    await pool.query(sql);
    const view = await pool.query<{ options: string[] | null }>(
      `SELECT c.reloptions AS options FROM pg_class c
       WHERE c.oid = to_regclass($1)`,
      [`"${schema}".catalog_media`],
    );
    expect(view.rows[0]?.options).toContain("security_barrier=true");
  });

  equalityCases();
  planCases("M1");
});
