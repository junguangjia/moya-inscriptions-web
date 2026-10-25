import { randomUUID } from "node:crypto";

import { CatalogReadService } from "@moya/api";
import {
  assertPostgresStartupReady,
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
  refreshCatalogSearchDocument,
} from "@moya/catalog-postgres";
import {
  catalogDetailSchema,
  catalogIdSchema,
  catalogPageSchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPublishedCatalogViewsSql,
  downgradePublishedCatalogMediaViewSql,
  dropPublishedCatalogViewsSql,
  upgradePublishedCatalogMediaViewSql,
} from "admin/published";
import { upgradePublishedCatalogSearchViewSql } from "admin/published-search";

const testDatabaseUrl = process.env.CMS_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("CMS_TEST_DATABASE_URL is required for CMS view tests");
}
const baseConfig = parsePostgresConfig({ DATABASE_URL: testDatabaseUrl });
const schema = `cms_views_${randomUUID().replaceAll("-", "")}`;
const schemaConnection = new URL(baseConfig.connectionString);
schemaConnection.searchParams.set("options", `-csearch_path=${schema},public`);
const adminPool = createPostgresPool(baseConfig);
const pool = createPostgresPool({
  ...baseConfig,
  connectionString: schemaConnection.toString(),
});
const adapter = new PostgresCatalogQueryAdapter(pool);
const service = new CatalogReadService(
  adapter,
  new MappedStorageUrlResolver(
    new Map([
      ["synthetic/snapshot/first.webp", "https://example.invalid/first.webp"],
      ["synthetic/snapshot/second.webp", "https://example.invalid/second.webp"],
    ]),
  ),
);

// Clone real migrated Payload table definitions into an owned schema. A field
// rename, enum/type difference or missing migration fails here; no hand-written
// substitute schema can make the view pass. Shared CMS content is never read.
const sourceTables = [
  "catalog_search_documents",
  "catalogs",
  "catalogs_aliases",
  "catalogs_contributors",
  "catalogs_source_citations",
  "catalogs_source_citations_applies_to",
  "catalogs_media",
  "_catalogs_v",
  "media",
] as const;

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const table of sourceTables) {
    await pool.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  await pool.query(createPublishedCatalogViewsSql);
  await pool.query(upgradePublishedCatalogSearchViewSql);
  // catalog-scale-v1 (M1): the keyed-read catalog_media every reader now sees.
  await pool.query(upgradePublishedCatalogMediaViewSql);
}, 20_000);

afterAll(async () => {
  await closePostgresPool(pool);
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await closePostgresPool(adminPool);
  }
});

const insertCatalog = async (
  id: number,
  kind: "inscription" | "calligraphy",
  status: "draft" | "published",
) => {
  await pool.query(
    `INSERT INTO catalogs
      (id, catalog_id, source_id, kind, title, _status, owner_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      `synthetic-catalog-${id}`,
      `synthetic-source-${id}`,
      kind,
      `合成资料${id}`,
      status,
      "内部合成备注",
    ],
  );
};

beforeEach(async () => {
  for (const table of sourceTables) await pool.query(`DELETE FROM "${table}"`);
  await insertCatalog(1, "inscription", "published");
  await insertCatalog(2, "calligraphy", "published");
  await insertCatalog(3, "inscription", "draft");
  await pool.query(
    `UPDATE catalogs SET
      summary = $1,
      dynasty_state = 'VALUE', dynasty_value = $2,
      date_text_state = 'VALUE', date_text_value = $3,
      province_state = 'UNKNOWN', county_state = 'CLEAR',
      description_state = 'VALUE', description_value = $4,
      script_style_state = 'VALUE', script_style_value = $5,
      transcription_state = 'VALUE', transcription_value = $6,
      historical_context_state = 'VALUE', historical_context_value = $7,
      scholarly_research_state = 'CLEAR'
     WHERE id = 1`,
    [
      "合成列表摘要",
      "合成朝代",
      "合成年份",
      "原文簡介",
      "原文書體",
      "傳統字形，𠮷。\r\n甲  乙",
      "合成历史背景",
    ],
  );
  await pool.query(
    `INSERT INTO catalogs_aliases (id, _parent_id, _order, alias, alias_type)
     VALUES ('synthetic-alias-2', 1, 2, '后列異名', 'historical'),
            ('synthetic-alias-1', 1, 1, '首列異名', 'alternate'),
            ('synthetic-alias-draft', 3, 1, '草稿異名', 'alternate')`,
  );
  await pool.query(
    `INSERT INTO catalogs_contributors (id, _parent_id, _order, name, role)
     VALUES ('synthetic-contributor-2', 1, 2, '合成书者', 'calligrapher'),
            ('synthetic-contributor-1', 1, 1, '合成作者', 'textAuthor'),
            ('synthetic-contributor-draft', 3, 1, '草稿作者', 'textAuthor')`,
  );
  await pool.query(
    `INSERT INTO catalogs_source_citations (id, _parent_id, _order, label, citation, url)
     VALUES ('synthetic-citation-1', 1, 1, '合成来源', '合成引用原文', 'https://example.invalid/source'),
            ('synthetic-citation-draft', 3, 1, '草稿来源', NULL, NULL)`,
  );
  await pool.query(
    `INSERT INTO catalogs_source_citations_applies_to (id, parent_id, "order", value)
     VALUES (1, 'synthetic-citation-1', 1, 'transcription'),
            (2, 'synthetic-citation-1', 2, 'record'),
            (3, 'synthetic-citation-draft', 1, 'record')`,
  );
  await pool.query(
    `INSERT INTO catalogs_media
      (id, _parent_id, _order, media_id, object_key, width, height, alt, position, is_representative, rights, order_confidence)
     VALUES ('synthetic-media-row-2', 1, 2, 'synthetic-media-2', 'synthetic/snapshot/second.webp', 480, 320, '第二幅合成图片', 5, false, '合成权利说明', 'LOW'),
            ('synthetic-media-row-1', 1, 1, 'synthetic-media-1', 'synthetic/snapshot/first.webp', 320, 480, '首幅合成图片', 0, true, '合成权利说明', 'HIGH'),
            ('synthetic-media-row-draft', 3, 1, 'synthetic-media-draft', 'synthetic/draft/private.webp', 100, 100, '草稿图片', 0, true, NULL, NULL)`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of ["synthetic-catalog-1", "synthetic-catalog-2"])
      await refreshCatalogSearchDocument(client, id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

describe("Payload published views through the unchanged Public read adapter", () => {
  it("searches the same published Catalog set without exposing drafts", async () => {
    const result = await adapter.search({
      q: "合成资料",
      page: 1,
      pageSize: 10,
    });
    expect(result.total).toBe(2);
    expect(result.items.map(({ id }) => id)).toEqual([
      "synthetic-catalog-1",
      "synthetic-catalog-2",
    ]);
  });

  it("excludes drafts consistently from list counts, kind filters and detail", async () => {
    const all = await service.list({ page: 1, pageSize: 10 });
    expect(catalogPageSchema.parse(all).total).toBe(2);
    expect(all.items.map(({ id }) => id)).toEqual([
      "synthetic-catalog-1",
      "synthetic-catalog-2",
    ]);
    expect(
      (await service.list({ kind: "inscription", page: 1, pageSize: 10 }))
        .total,
    ).toBe(1);
    expect(
      (await service.list({ kind: "calligraphy", page: 1, pageSize: 10 }))
        .items[0]?.id,
    ).toBe("synthetic-catalog-2");
    expect(
      await service.getById(catalogIdSchema.parse("synthetic-catalog-3")),
    ).toBeNull();
    for (const view of [
      "catalog_aliases",
      "catalog_contributors",
      "catalog_source_citations",
      "catalog_source_citation_scopes",
      "catalog_media",
    ]) {
      expect(
        (
          await pool.query(`SELECT * FROM ${view} WHERE catalog_id = $1`, [
            "synthetic-catalog-3",
          ])
        ).rows,
      ).toEqual([]);
    }
  });

  it("preserves original text, semantic states, relation order and existing Public DTO", async () => {
    const detail = catalogDetailSchema.parse(
      await service.getById(catalogIdSchema.parse("synthetic-catalog-1")),
    );
    expect(detail).toMatchObject({
      title: "合成资料1",
      summary: "合成列表摘要",
      periodLabel: "合成朝代 · 合成年份",
      aliases: ["首列異名", "后列異名"],
      description: "原文簡介",
      scriptStyle: "原文書體",
      transcription: "傳統字形，𠮷。\r\n甲  乙",
      historicalContext: "合成历史背景",
      contributors: [
        { name: "合成作者", role: "textAuthor" },
        { name: "合成书者", role: "calligrapher" },
      ],
      sourceCitations: [
        {
          label: "合成来源",
          citation: "合成引用原文",
          url: "https://example.invalid/source",
          appliesTo: ["record", "transcription"],
        },
      ],
      representativeMedia: { id: "synthetic-media-1", width: 320, height: 480 },
    });
    expect(detail.media.map(({ id }) => id)).toEqual([
      "synthetic-media-1",
      "synthetic-media-2",
    ]);
    for (const field of [
      "province",
      "county",
      "scholarlyResearch",
      "ownerNote",
      "sourceId",
      "provenance",
    ]) {
      expect(detail).not.toHaveProperty(field);
    }
    expect(detail.media[0]).not.toHaveProperty("objectKey");
    expect(detail.media[1]).not.toHaveProperty("rights");
    const projection = await adapter.getById(
      catalogIdSchema.parse("synthetic-catalog-1"),
    );
    expect(projection?.province).toEqual({ state: "UNKNOWN" });
    expect(projection?.county).toEqual({ state: "CLEAR" });
    expect(projection?.media.map(({ position }) => position)).toEqual([0, 5]);
  });

  it("retains truthful missing-image and absent-section behavior", async () => {
    const detail = catalogDetailSchema.parse(
      await service.getById(catalogIdSchema.parse("synthetic-catalog-2")),
    );
    expect(detail.media).toEqual([]);
    expect(detail.sourceCitations).toEqual([]);
    expect(detail).not.toHaveProperty("representativeMedia");
    expect(detail).not.toHaveProperty("description");
    expect(detail).not.toHaveProperty("transcription");
  });

  it("reads embedded published metadata even when drafts and media-master metadata differ", async () => {
    await pool.query(
      `INSERT INTO _catalogs_v (id, parent_id, version_catalog_id, version_title, version__status, latest)
       VALUES (1, 1, 'synthetic-catalog-1', '尚未发布的新标题', 'draft', true)`,
    );
    await pool.query(
      `INSERT INTO media (id, media_id, catalog_id, object_key, sha256, alt, width, height)
       VALUES (1, 'synthetic-media-1', 'synthetic-catalog-1', 'synthetic/master/changed.webp', $1, '媒体库尚未发布的新说明', 999, 999)`,
      ["0".repeat(64)],
    );
    const detail = catalogDetailSchema.parse(
      await service.getById(catalogIdSchema.parse("synthetic-catalog-1")),
    );
    expect(detail.title).toBe("合成资料1");
    expect(detail.media[0]).toMatchObject({
      alt: "首幅合成图片",
      width: 320,
      height: 480,
      src: "https://example.invalid/first.webp",
    });
  });

  it("withdraws every public relation on future reads while preserving stored identity", async () => {
    await pool.query("UPDATE catalogs SET _status = 'draft' WHERE id = 1");
    expect(
      await service.getById(catalogIdSchema.parse("synthetic-catalog-1")),
    ).toBeNull();
    expect((await service.list({ page: 1, pageSize: 10 })).total).toBe(1);
    expect(
      (await service.list({ kind: "inscription", page: 1, pageSize: 10 }))
        .total,
    ).toBe(0);
    for (const view of [
      "catalog_entries",
      "catalog_aliases",
      "catalog_contributors",
      "catalog_source_citations",
      "catalog_source_citation_scopes",
      "catalog_media",
    ]) {
      expect(
        (
          await pool.query(`SELECT * FROM ${view} WHERE catalog_id = $1`, [
            "synthetic-catalog-1",
          ])
        ).rows,
      ).toEqual([]);
    }
    expect(
      (await pool.query("SELECT catalog_id FROM catalogs WHERE id = 1")).rows,
    ).toEqual([{ catalog_id: "synthetic-catalog-1" }]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS count FROM catalogs_media WHERE _parent_id = 1",
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });

  it("makes the complete public view surface non-updatable and removable without dropping source data", async () => {
    const metadata = await pool.query(
      "SELECT table_name, is_updatable FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    expect(metadata.rows).toHaveLength(6);
    expect(metadata.rows.every((row) => row.is_updatable === "NO")).toBe(true);
    await expect(
      pool.query(
        "UPDATE catalog_entries SET title = '不能写入' WHERE catalog_id = 'synthetic-catalog-1'",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        "UPDATE catalog_media SET alt_text = '不能写入' WHERE catalog_id = 'synthetic-catalog-1'",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    // Migrations unwind in reverse: M1's down runs before the views' down.
    await pool.query(downgradePublishedCatalogMediaViewSql);
    await pool.query(dropPublishedCatalogViewsSql);
    expect(
      (await pool.query("SELECT COUNT(*)::integer AS count FROM catalogs"))
        .rows,
    ).toEqual([{ count: 3 }]);
    await pool.query(createPublishedCatalogViewsSql);
    await pool.query(upgradePublishedCatalogSearchViewSql);
    await pool.query(upgradePublishedCatalogMediaViewSql);
  });

  it("starts with a restricted public role while denying native drafts and all writes", async () => {
    const role = `cms_read_${randomUUID().replaceAll("-", "")}`;
    const publicViews = [
      "catalog_search_documents",
      "catalog_entries",
      "catalog_aliases",
      "catalog_contributors",
      "catalog_source_citations",
      "catalog_source_citation_scopes",
      "catalog_media",
    ];
    await pool.query(
      "CREATE TABLE payload_migrations (name text NOT NULL, private_probe text)",
    );
    await pool.query(
      "INSERT INTO payload_migrations (name, private_probe) VALUES ($1, $2)",
      [
        "20260908_031500_published_views",
        "Fictional nonpublic migration metadata",
      ],
    );
    await adminPool.query(`CREATE ROLE "${role}" NOLOGIN`);
    await pool.query("INSERT INTO payload_migrations (name) VALUES ($1)", [
      "20260908_120000_published_search",
    ]);
    const restrictedConnection = new URL(schemaConnection);
    restrictedConnection.searchParams.set(
      "options",
      `-csearch_path=${schema},public -crole=${role}`,
    );
    const restricted = createPostgresPool({
      ...baseConfig,
      connectionString: restrictedConnection.toString(),
    });
    // pg discards sessions after query errors. Every replacement must also
    // start with the restricted role, including after intentional denial tests.
    restricted.options.max = 1;
    restricted.options.idleTimeoutMillis = 0;
    try {
      await adminPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      for (const view of publicViews)
        await adminPool.query(
          `GRANT SELECT ON "${schema}"."${view}" TO "${role}"`,
        );
      await expect(
        assertPostgresStartupReady(restricted, "payload"),
      ).rejects.toThrow("PostgreSQL startup validation failed");
      await adminPool.query(
        `GRANT SELECT (name) ON "${schema}".payload_migrations TO "${role}"`,
      );
      await expect(
        assertPostgresStartupReady(restricted, "payload"),
      ).resolves.toBeUndefined();
      expect(
        (
          await restricted.query(
            "SELECT count(*)::integer AS count FROM catalog_entries",
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      const restrictedAdapter = new PostgresCatalogQueryAdapter(restricted);
      expect(
        (
          await restrictedAdapter.search({
            q: "合成资料",
            page: 1,
            pageSize: 10,
          })
        ).items.map(({ id }) => id),
      ).toEqual(["synthetic-catalog-1", "synthetic-catalog-2"]);
      for (const nativeTable of [
        "catalogs",
        "_catalogs_v",
        "catalogs_media",
        "media",
        "payload_migrations",
      ])
        await expect(
          restricted.query(`SELECT * FROM "${nativeTable}" LIMIT 1`),
        ).rejects.toMatchObject({ code: "42501" });
      for (const view of publicViews)
        await expect(
          restricted.query(`DELETE FROM "${view}"`),
        ).rejects.toBeDefined();
      await expect(
        restricted.query(
          "INSERT INTO catalogs (catalog_id) VALUES ('fictional-forbidden-write')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closePostgresPool(restricted);
      await adminPool.query(`DROP OWNED BY "${role}"`);
      await adminPool.query(`DROP ROLE "${role}"`);
    }
  });
});
