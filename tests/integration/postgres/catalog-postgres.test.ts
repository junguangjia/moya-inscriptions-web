import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareProductionBackend } from "@moya/backend-production";
import {
  createBackendApplication,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  checkPostgresReadiness,
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
  requiredMigrations,
  runMigrations,
  verifyRequiredMigrationLedger,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import {
  apiErrorSchema,
  catalogDetailSchema,
  catalogPageSchema,
  healthResponseSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";
import {
  MappedStorageUrlResolver,
  UnconfiguredStorageUrlResolver,
} from "@moya/image";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { StorageUrlResolver } from "@moya/api";
import type { BackendProcessHandle } from "@moya/backend-runtime";

// Catalog integration keeps the real Production parser, public resolver, pools
// and read-only startup checks. Only unrelated publishing-media opening I/O is
// replaced; every media operation fails if these Catalog cases invoke it.
vi.mock(
  "@moya/backend-production/internal/publishing-config",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@moya/backend-production/internal/publishing-config")
      >();
    const refuseMediaIo = async (): Promise<never> => {
      throw new Error(
        "Catalog integration must not perform publishing media I/O",
      );
    };
    return {
      ...actual,
      openProductionPublishingMedia: vi.fn(
        async () =>
          ({
            store: {
              writeStream: refuseMediaIo,
              openRead: refuseMediaIo,
              remove: refuseMediaIo,
              listBlobs: refuseMediaIo,
              sweepStaging: refuseMediaIo,
            },
            runner: {
              createJob: refuseMediaIo,
              run: refuseMediaIo,
              sweepJobs: refuseMediaIo,
            },
            processor: { process: refuseMediaIo },
          }) satisfies Awaited<
            ReturnType<typeof actual.openProductionPublishingMedia>
          >,
      ),
    };
  },
);

const productionPublishingEnvironment = {
  WORK_MEDIA_COS_BUCKET: "synthetic-publishing-1250000000",
  WORK_MEDIA_COS_REGION: "ap-guangzhou",
  WORK_MEDIA_COS_PREFIX: "ugc/publishing/synthetic/",
  WORK_MEDIA_COS_SECRET_ID: "synthetic-publishing-id",
  WORK_MEDIA_COS_SECRET_KEY: "synthetic-publishing-secret",
  WORK_MEDIA_TOOLS_IMAGE: "yoyi-work-publishing-media-tools:v1",
  WORK_MEDIA_WORK_DIR: "/Users/synthetic/publishing/work",
} as const;

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "database", "migrations");
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const processes = new Set<BackendProcessHandle>();

const resetCatalog = async (): Promise<void> => {
  await pool.query(
    "TRUNCATE catalog_media, catalog_source_citations, catalog_aliases, catalog_entries CASCADE",
  );
};

const startHttp = async (
  queryPool = pool,
  storageUrlResolver: StorageUrlResolver = new UnconfiguredStorageUrlResolver(),
): Promise<{
  readonly baseUrl: string;
  readonly handle: BackendProcessHandle;
}> => {
  const handle = await startBackendProcess({
    listen: { host: "127.0.0.1", port: 0 },
    requestListener: createBackendApplication({
      nodeEnv: "production",
      catalogQueryPort: new PostgresCatalogQueryAdapter(queryPool),
      storageUrlResolver,
      healthReadinessCheck: async () => checkPostgresReadiness(queryPool),
    }),
  });
  processes.add(handle);
  return {
    baseUrl: `http://${handle.address.address}:${handle.address.port}`,
    handle,
  };
};

const insertFixture = async (): Promise<void> => {
  await pool.query(
    `INSERT INTO catalog_entries
       (catalog_id, kind, title, summary, description, period_label,
        dynasty, dynasty_state, date_text, date_text_state,
        province, province_state, prefecture, prefecture_state,
        county, county_state, current_location, current_location_state,
        current_custodian, current_custodian_state)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20)`,
    [
      "test-catalog-001",
      "calligraphy",
      "Test Calligraphy",
      "First summary",
      "First description",
      "Legacy period",
      "唐",
      "VALUE",
      "贞观十年",
      "VALUE",
      "陕西",
      "VALUE",
      null,
      "CLEAR",
      null,
      "UNSUPPLIED",
      "陕西省碑林区",
      "VALUE",
      "碑林博物馆",
      "VALUE",
    ],
  );
  await pool.query(
    `INSERT INTO catalog_entries
       (catalog_id, kind, title, summary, description, period_label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      "test-catalog-002",
      "inscription",
      "Test Inscription",
      null,
      "Second description",
      "汉",
    ],
  );
  await pool.query(
    `INSERT INTO catalog_entries
       (catalog_id, kind, title, summary, description, period_label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      "test-catalog-003",
      "inscription",
      "Test Cliff Inscription",
      "Third summary",
      null,
      null,
    ],
  );
  await pool.query(
    `INSERT INTO catalog_aliases (catalog_id, position, alias)
     VALUES ($1, $2, $3), ($1, $4, $5)`,
    ["test-catalog-001", 1, "Second alias", 0, "First alias"],
  );
  await pool.query(
    `INSERT INTO catalog_source_citations
       (catalog_id, position, label, citation, url)
     VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $9)`,
    [
      "test-catalog-001",
      1,
      "Second citation",
      null,
      null,
      0,
      "First citation",
      "Test-only public citation",
      "https://example.invalid/catalog-001",
    ],
  );
};

interface MediaFixture {
  readonly mediaId: string;
  readonly catalogId?: string;
  readonly position: number;
  readonly isRepresentative: boolean;
  readonly kind?: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly objectKey?: string;
}

const insertMediaFixture = async ({
  mediaId,
  catalogId = "test-catalog-001",
  position,
  isRepresentative,
  kind = "image",
  alt = "Synthetic Catalog Media",
  width = 1_200,
  height = 1_600,
  objectKey = `private/${mediaId}.jpg`,
}: MediaFixture) =>
  pool.query(
    `INSERT INTO catalog_media
       (media_id, catalog_id, position, is_representative, kind,
        alt_text, width, height, object_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      mediaId,
      catalogId,
      position,
      isRepresentative,
      kind,
      alt,
      width,
      height,
      objectKey,
    ],
  );

beforeAll(async () => {
  await runMigrations(pool, migrationsDirectory);
  // The production composition also verifies the community ledger read-only.
  await runCommunityMigrations(
    pool,
    path.join(repositoryRoot, "database", "community-migrations"),
  );
  await resetCatalog();
});

afterEach(async () => {
  await Promise.all(
    [...processes].map(async (handle) => {
      await handle.shutdown();
      processes.delete(handle);
    }),
  );
  await resetCatalog();
});

afterAll(async () => {
  await closePostgresPool(pool);
});

describe.sequential("PostgreSQL Catalog HTTP integration", () => {
  it("runs the explicitly required PostgreSQL minor version", async () => {
    const expected = process.env.TEST_DATABASE_EXPECTED_VERSION_NUM ?? "180004";
    expect(["180004", "180006"]).toContain(expected);
    const version = await pool.query("SHOW server_version_num");
    expect(String(version.rows[0]?.server_version_num)).toBe(expected);
  });

  it("applies the full migration set once on a fresh empty schema", async () => {
    const schema = "t09_b1a_fresh_catalog_content";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const freshPool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: isolatedUrl.toString() }),
    );

    try {
      expect(await runMigrations(freshPool, migrationsDirectory)).toEqual(
        requiredMigrations.map(({ migrationId }) => migrationId),
      );
      expect(await runMigrations(freshPool, migrationsDirectory)).toEqual([]);
      await expect(
        verifyRequiredMigrationLedger(freshPool),
      ).resolves.toBeUndefined();

      const kindConstraint = await freshPool.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'catalog_entries'::regclass
           AND conname = 'catalog_entries_kind_valid'`,
      );
      const contentTables = await freshPool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name = ANY($2::text[])
         ORDER BY table_name`,
        [schema, ["catalog_contributors", "catalog_source_citation_scopes"]],
      );
      const contentColumns = await freshPool.query(
        `SELECT column_name, data_type, character_maximum_length,
                is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'catalog_entries'
           AND column_name = ANY($2::text[])
         ORDER BY ordinal_position`,
        [
          schema,
          [
            "script_style",
            "script_style_state",
            "transcription",
            "transcription_state",
            "historical_context",
            "historical_context_state",
            "scholarly_research",
            "scholarly_research_state",
          ],
        ],
      );
      const contentConstraints = await freshPool.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = ANY($1::regclass[])
           AND conname = ANY($2::text[])
         ORDER BY conname`,
        [
          [
            "catalog_entries",
            "catalog_contributors",
            "catalog_source_citation_scopes",
          ],
          [
            "catalog_entries_script_style_state_valid",
            "catalog_entries_transcription_state_valid",
            "catalog_entries_historical_context_state_valid",
            "catalog_entries_scholarly_research_state_valid",
            "catalog_contributors_catalog_id_fkey",
            "catalog_contributors_identity_unique",
            "catalog_contributors_position_valid",
            "catalog_contributors_name_valid",
            "catalog_contributors_role_valid",
            "catalog_source_citation_scopes_citation_fkey",
            "catalog_source_citation_scopes_scope_valid",
          ],
        ],
      );
      const counts = await freshPool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM catalog_entries) AS entries,
           (SELECT COUNT(*)::integer FROM catalog_contributors) AS contributors,
           (SELECT COUNT(*)::integer FROM catalog_source_citation_scopes) AS citation_scopes`,
      );

      expect(kindConstraint.rows).toHaveLength(1);
      expect(String(kindConstraint.rows[0]?.definition)).toContain(
        "inscription",
      );
      expect(String(kindConstraint.rows[0]?.definition)).toContain(
        "calligraphy",
      );
      expect(String(kindConstraint.rows[0]?.definition)).not.toContain(
        "cliff_inscription",
      );
      expect(contentTables.rows.map(({ table_name }) => table_name)).toEqual([
        "catalog_contributors",
        "catalog_source_citation_scopes",
      ]);
      expect(contentColumns.rows).toEqual([
        {
          column_name: "script_style",
          data_type: "character varying",
          character_maximum_length: 2_000,
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "script_style_state",
          data_type: "text",
          character_maximum_length: null,
          is_nullable: "NO",
          column_default: "'UNSUPPLIED'::text",
        },
        {
          column_name: "transcription",
          data_type: "character varying",
          character_maximum_length: 100_000,
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "transcription_state",
          data_type: "text",
          character_maximum_length: null,
          is_nullable: "NO",
          column_default: "'UNSUPPLIED'::text",
        },
        {
          column_name: "historical_context",
          data_type: "character varying",
          character_maximum_length: 20_000,
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "historical_context_state",
          data_type: "text",
          character_maximum_length: null,
          is_nullable: "NO",
          column_default: "'UNSUPPLIED'::text",
        },
        {
          column_name: "scholarly_research",
          data_type: "character varying",
          character_maximum_length: 20_000,
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "scholarly_research_state",
          data_type: "text",
          character_maximum_length: null,
          is_nullable: "NO",
          column_default: "'UNSUPPLIED'::text",
        },
      ]);
      expect(contentConstraints.rows).toHaveLength(11);
      const constraintDefinitions = new Map(
        contentConstraints.rows.map(({ conname, definition }) => [
          conname,
          String(definition),
        ]),
      );
      expect(
        constraintDefinitions.get("catalog_entries_script_style_state_valid"),
      ).toContain("NOT_APPLICABLE");
      expect(
        constraintDefinitions.get("catalog_entries_transcription_state_valid"),
      ).not.toContain("UNKNOWN");
      expect(
        constraintDefinitions.get("catalog_entries_transcription_state_valid"),
      ).not.toContain("NOT_APPLICABLE");
      expect(
        constraintDefinitions.get(
          "catalog_entries_historical_context_state_valid",
        ),
      ).not.toContain("UNKNOWN");
      expect(
        constraintDefinitions.get(
          "catalog_entries_scholarly_research_state_valid",
        ),
      ).not.toContain("UNKNOWN");
      expect(
        constraintDefinitions.get("catalog_contributors_role_valid"),
      ).toContain("textAuthor");
      expect(
        constraintDefinitions.get("catalog_contributors_role_valid"),
      ).toContain("calligrapher");
      expect(
        constraintDefinitions.get("catalog_contributors_catalog_id_fkey"),
      ).toContain("ON DELETE CASCADE");
      expect(
        constraintDefinitions.get(
          "catalog_source_citation_scopes_citation_fkey",
        ),
      ).toContain("ON DELETE CASCADE");
      expect(
        constraintDefinitions.get("catalog_source_citation_scopes_scope_valid"),
      ).toContain("scholarlyResearch");
      expect(counts.rows).toEqual([
        { citation_scopes: 0, contributors: 0, entries: 0 },
      ]);
    } finally {
      await closePostgresPool(freshPool);
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("has an immutable applied migration and an empty first-class database", async () => {
    expect(await runMigrations(pool, migrationsDirectory)).toEqual([]);
    const ledger = await pool.query(
      `SELECT migration_id, filename, checksum
       FROM schema_migrations
       WHERE migration_id = ANY($1::text[])
       ORDER BY migration_id`,
      [requiredMigrations.map(({ migrationId }) => migrationId)],
    );
    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [
        [
          "catalog_aliases",
          "catalog_contributors",
          "catalog_entries",
          "catalog_media",
          "catalog_source_citation_scopes",
          "catalog_source_citations",
        ],
      ],
    );
    const constraints = await pool.query(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY constraint_name`,
      [
        [
          "catalog_aliases",
          "catalog_contributors",
          "catalog_entries",
          "catalog_media",
          "catalog_source_citation_scopes",
          "catalog_source_citations",
        ],
      ],
    );
    const indexes = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])
       ORDER BY indexname`,
      [
        [
          "catalog_aliases",
          "catalog_contributors",
          "catalog_entries",
          "catalog_media",
          "catalog_source_citation_scopes",
          "catalog_source_citations",
        ],
      ],
    );
    const mediaColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'catalog_media'
       ORDER BY ordinal_position`,
    );
    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM catalog_entries) AS entries,
         (SELECT COUNT(*)::integer FROM catalog_aliases) AS aliases,
         (SELECT COUNT(*)::integer FROM catalog_contributors) AS contributors,
         (SELECT COUNT(*)::integer FROM catalog_media) AS media,
         (SELECT COUNT(*)::integer FROM catalog_source_citations) AS citations,
         (SELECT COUNT(*)::integer FROM catalog_source_citation_scopes) AS citation_scopes`,
    );
    const { baseUrl } = await startHttp();
    const listResponse = await fetch(`${baseUrl}/v1/catalog`);
    const detailResponse = await fetch(
      `${baseUrl}/v1/catalog/test-catalog-missing`,
    );
    const healthResponse = await fetch(`${baseUrl}/health`);

    expect(ledger.rows).toEqual(
      requiredMigrations.map(({ migrationId, filename, checksum }) => ({
        migration_id: migrationId,
        filename,
        checksum,
      })),
    );
    await expect(verifyRequiredMigrationLedger(pool)).resolves.toBeUndefined();
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "catalog_aliases",
      "catalog_contributors",
      "catalog_entries",
      "catalog_media",
      "catalog_source_citation_scopes",
      "catalog_source_citations",
    ]);
    expect(
      constraints.rows.map(({ constraint_name }) => constraint_name),
    ).toEqual(
      expect.arrayContaining([
        "catalog_aliases_catalog_id_fkey",
        "catalog_aliases_pkey",
        "catalog_contributors_catalog_id_fkey",
        "catalog_contributors_identity_unique",
        "catalog_contributors_name_valid",
        "catalog_contributors_pkey",
        "catalog_contributors_position_valid",
        "catalog_contributors_role_valid",
        "catalog_entries_catalog_id_valid",
        "catalog_entries_historical_context_state_valid",
        "catalog_entries_historical_context_valid",
        "catalog_entries_kind_valid",
        "catalog_entries_pkey",
        "catalog_entries_scholarly_research_state_valid",
        "catalog_entries_scholarly_research_valid",
        "catalog_entries_script_style_state_valid",
        "catalog_entries_script_style_valid",
        "catalog_entries_transcription_state_valid",
        "catalog_entries_transcription_valid",
        "catalog_media_catalog_id_fkey",
        "catalog_media_catalog_position_unique",
        "catalog_media_alt_text_valid",
        "catalog_media_height_valid",
        "catalog_media_kind_valid",
        "catalog_media_media_id_valid",
        "catalog_media_object_key_valid",
        "catalog_media_pkey",
        "catalog_media_position_valid",
        "catalog_media_width_valid",
        "catalog_source_citation_scopes_citation_fkey",
        "catalog_source_citation_scopes_pkey",
        "catalog_source_citation_scopes_scope_valid",
        "catalog_source_citations_catalog_id_fkey",
        "catalog_source_citations_pkey",
      ]),
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "catalog_aliases_pkey",
      "catalog_contributors_identity_unique",
      "catalog_contributors_pkey",
      "catalog_entries_pkey",
      "catalog_media_catalog_position_unique",
      "catalog_media_one_representative_per_catalog",
      "catalog_media_pkey",
      "catalog_source_citation_scopes_pkey",
      "catalog_source_citations_pkey",
    ]);
    expect(mediaColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "media_id",
      "catalog_id",
      "position",
      "is_representative",
      "kind",
      "alt_text",
      "width",
      "height",
      "object_key",
    ]);
    expect(counts.rows).toEqual([
      {
        aliases: 0,
        citation_scopes: 0,
        citations: 0,
        contributors: 0,
        entries: 0,
        media: 0,
      },
    ]);
    expect(listResponse.status).toBe(200);
    expect(catalogPageSchema.parse(await listResponse.json())).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    });
    expect(detailResponse.status).toBe(404);
    expect(apiErrorSchema.parse(await detailResponse.json()).error.code).toBe(
      "ITEM_NOT_FOUND",
    );
    expect(healthResponse.status).toBe(200);
    expect(healthResponseSchema.parse(await healthResponse.json())).toEqual({
      status: "ok",
    });
  });

  it("rejects the retired top-level CatalogKind at the database boundary", async () => {
    await expect(
      pool.query(
        `INSERT INTO catalog_entries (catalog_id, kind, title)
         VALUES ($1, $2, $3)`,
        [
          "test-catalog-retired-kind",
          "cliff_inscription",
          "Retired kind fixture",
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const result = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM catalog_entries
       WHERE catalog_id = $1`,
      ["test-catalog-retired-kind"],
    );
    expect(result.rows).toEqual([{ count: 0 }]);
  });

  it("enforces Content V1 contributor, citation-scope and state constraints", async () => {
    await insertFixture();

    await pool.query(
      `INSERT INTO catalog_contributors (catalog_id, position, name, role)
       VALUES ($1, 0, $2, 'textAuthor')`,
      ["test-catalog-001", "Constraint contributor"],
    );
    await expect(
      pool.query(
        `INSERT INTO catalog_contributors (catalog_id, position, name, role)
         VALUES ($1, 1, $2, 'patron')`,
        ["test-catalog-001", "Invalid role"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO catalog_contributors (catalog_id, position, name, role)
         VALUES ($1, 1, $2, 'textAuthor')`,
        ["test-catalog-001", "Constraint contributor"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO catalog_contributors (catalog_id, position, name, role)
         VALUES ($1, 0, $2, 'calligrapher')`,
        ["test-catalog-001", "Duplicate position"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO catalog_contributors (catalog_id, position, name, role)
         VALUES ($1, -1, $2, 'calligrapher')`,
        ["test-catalog-001", "Negative position"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    for (const name of ["", " padded", "padded "]) {
      await expect(
        pool.query(
          `INSERT INTO catalog_contributors (catalog_id, position, name, role)
           VALUES ($1, 2, $2, 'calligrapher')`,
          ["test-catalog-001", name],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }

    await pool.query(
      `INSERT INTO catalog_source_citation_scopes
         (catalog_id, citation_position, scope)
       VALUES ($1, 0, 'record')`,
      ["test-catalog-001"],
    );
    await expect(
      pool.query(
        `INSERT INTO catalog_source_citation_scopes
           (catalog_id, citation_position, scope)
         VALUES ($1, 0, 'unknown')`,
        ["test-catalog-001"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO catalog_source_citation_scopes
           (catalog_id, citation_position, scope)
         VALUES ($1, 0, 'record')`,
        ["test-catalog-001"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO catalog_source_citation_scopes
           (catalog_id, citation_position, scope)
         VALUES ($1, 99, 'description')`,
        ["test-catalog-001"],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const contentColumns = [
      ["script_style", "script_style_state", 2_000],
      ["transcription", "transcription_state", 100_000],
      ["historical_context", "historical_context_state", 20_000],
      ["scholarly_research", "scholarly_research_state", 20_000],
    ] as const;
    for (const [valueColumn, stateColumn, maximum] of contentColumns) {
      await expect(
        pool.query(
          `UPDATE catalog_entries
           SET ${valueColumn} = $1, ${stateColumn} = 'UNSUPPLIED'
           WHERE catalog_id = $2`,
          ["value with non-VALUE state", "test-catalog-001"],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `UPDATE catalog_entries
           SET ${valueColumn} = NULL, ${stateColumn} = 'VALUE'
           WHERE catalog_id = $1`,
          ["test-catalog-001"],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `UPDATE catalog_entries
           SET ${valueColumn} = $1, ${stateColumn} = 'VALUE'
           WHERE catalog_id = $2`,
          ["文".repeat(maximum + 1), "test-catalog-001"],
        ),
      ).rejects.toMatchObject({ code: "22001" });
      for (const value of ["", " padded", "padded "]) {
        await expect(
          pool.query(
            `UPDATE catalog_entries
             SET ${valueColumn} = $1, ${stateColumn} = 'VALUE'
             WHERE catalog_id = $2`,
            [value, "test-catalog-001"],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
    }

    for (const state of ["UNSUPPLIED", "UNKNOWN", "NOT_APPLICABLE", "CLEAR"]) {
      await expect(
        pool.query(
          `UPDATE catalog_entries
           SET script_style = NULL, script_style_state = $1
           WHERE catalog_id = $2`,
          [state, "test-catalog-001"],
        ),
      ).resolves.toBeDefined();
    }
    for (const stateColumn of [
      "transcription_state",
      "historical_context_state",
      "scholarly_research_state",
    ]) {
      for (const invalidState of ["UNKNOWN", "NOT_APPLICABLE"]) {
        await expect(
          pool.query(
            `UPDATE catalog_entries
             SET ${stateColumn} = $1
             WHERE catalog_id = $2`,
            [invalidState, "test-catalog-001"],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
    }
  });

  it("persists Catalog Media and enforces every database invariant", async () => {
    await insertFixture();
    await insertMediaFixture({
      mediaId: "media-db-gallery",
      position: 0,
      isRepresentative: false,
    });
    await insertMediaFixture({
      mediaId: "media-db-representative",
      position: 1,
      isRepresentative: true,
      alt: "Synthetic representative Media",
      width: 1_600,
      height: 1_200,
    });

    const persisted = await pool.query(
      `SELECT media_id, catalog_id, position, is_representative, kind,
              alt_text, width, height, object_key
       FROM catalog_media
       WHERE catalog_id = $1
       ORDER BY position`,
      ["test-catalog-001"],
    );
    expect(persisted.rows).toEqual([
      {
        media_id: "media-db-gallery",
        catalog_id: "test-catalog-001",
        position: 0,
        is_representative: false,
        kind: "image",
        alt_text: "Synthetic Catalog Media",
        width: 1_200,
        height: 1_600,
        object_key: "private/media-db-gallery.jpg",
      },
      {
        media_id: "media-db-representative",
        catalog_id: "test-catalog-001",
        position: 1,
        is_representative: true,
        kind: "image",
        alt_text: "Synthetic representative Media",
        width: 1_600,
        height: 1_200,
        object_key: "private/media-db-representative.jpg",
      },
    ]);

    const rejected = [
      () =>
        insertMediaFixture({
          mediaId: "media-db-fk",
          catalogId: "missing-catalog",
          position: 0,
          isRepresentative: false,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-duplicate-position",
          position: 0,
          isRepresentative: false,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-negative-position",
          position: -1,
          isRepresentative: false,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-second-representative",
          position: 2,
          isRepresentative: true,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-zero-width",
          position: 3,
          isRepresentative: false,
          width: 0,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-zero-height",
          position: 4,
          isRepresentative: false,
          height: 0,
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-video",
          position: 5,
          isRepresentative: false,
          kind: "video",
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-empty-alt",
          position: 6,
          isRepresentative: false,
          alt: "",
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-padded-alt",
          position: 7,
          isRepresentative: false,
          alt: " padded ",
        }),
      () =>
        insertMediaFixture({
          mediaId: "media-db-empty-key",
          position: 8,
          isRepresentative: false,
          objectKey: "",
        }),
      () =>
        insertMediaFixture({
          mediaId: "invalid media id",
          position: 9,
          isRepresentative: false,
        }),
    ];
    const expectedCodes = [
      "23503",
      "23505",
      "23514",
      "23505",
      "23514",
      "23514",
      "23514",
      "23514",
      "23514",
      "23514",
      "23514",
    ];
    for (const [index, insertion] of rejected.entries()) {
      await expect(insertion()).rejects.toMatchObject({
        code: expectedCodes[index],
      });
    }

    await pool.query("DELETE FROM catalog_entries WHERE catalog_id = $1", [
      "test-catalog-001",
    ]);
    const afterDelete = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM catalog_media WHERE catalog_id = $1",
      ["test-catalog-001"],
    );
    expect(afterDelete.rows).toEqual([{ count: 0 }]);
  });

  it("rolls back the kind evolution before replacing the legacy constraint", async () => {
    const schema = "t043_legacy_catalog_kind";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const legacyPool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: isolatedUrl.toString() }),
    );

    try {
      const legacyMigration = requiredMigrations[0];
      const evolutionMigration = requiredMigrations[1];
      if (legacyMigration === undefined || evolutionMigration === undefined) {
        throw new Error("T05.2 and T04.3 migrations are required");
      }
      const legacySql = await readFile(
        path.join(migrationsDirectory, legacyMigration.filename),
        "utf8",
      );
      await legacyPool.query(legacySql);
      await legacyPool.query(`
        CREATE TABLE schema_migrations (
          migration_id VARCHAR(14) PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          checksum VARCHAR(64) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT schema_migrations_id_valid CHECK (
            migration_id ~ '^[0-9]{14}$'
          ),
          CONSTRAINT schema_migrations_checksum_valid CHECK (
            checksum ~ '^[0-9a-f]{64}$'
          )
        )
      `);
      await legacyPool.query(
        `INSERT INTO schema_migrations (migration_id, filename, checksum)
         VALUES ($1, $2, $3)`,
        [
          legacyMigration.migrationId,
          legacyMigration.filename,
          legacyMigration.checksum,
        ],
      );
      const legacyRow = {
        catalog_id: "legacy-cliff-inscription",
        kind: "cliff_inscription",
        title: "Legacy row must remain unchanged",
        summary: "Legacy summary",
        description: "Legacy description",
        period_label: "Legacy period",
      };
      await legacyPool.query(
        `INSERT INTO catalog_entries
           (catalog_id, kind, title, summary, description, period_label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        Object.values(legacyRow),
      );
      const constraintBefore = await legacyPool.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'catalog_entries'::regclass
           AND conname = 'catalog_entries_kind_valid'`,
      );

      await expect(
        runMigrations(legacyPool, migrationsDirectory),
      ).rejects.toThrow(`Migration ${evolutionMigration.migrationId} failed`);

      const [row, constraint, ledger] = await Promise.all([
        legacyPool.query(
          `SELECT catalog_id, kind, title, summary, description, period_label
           FROM catalog_entries
           WHERE catalog_id = $1`,
          [legacyRow.catalog_id],
        ),
        legacyPool.query(
          `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
           WHERE conrelid = 'catalog_entries'::regclass
             AND conname = 'catalog_entries_kind_valid'`,
        ),
        legacyPool.query(
          `SELECT migration_id, filename, checksum
           FROM schema_migrations
           ORDER BY migration_id`,
        ),
      ]);

      expect(row.rows).toEqual([legacyRow]);
      expect(constraint.rows).toEqual(constraintBefore.rows);
      expect(String(constraint.rows[0]?.definition)).toContain(
        "cliff_inscription",
      );
      expect(ledger.rows).toEqual([
        {
          migration_id: legacyMigration.migrationId,
          filename: legacyMigration.filename,
          checksum: legacyMigration.checksum,
        },
      ]);
    } finally {
      await closePostgresPool(legacyPool);
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("upgrades the exact four-migration schema without fabricating Content V1 data", async () => {
    const schema = "t09_b1a_previous_four_migrations";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const upgradePool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: isolatedUrl.toString() }),
    );
    const previousMigrations = requiredMigrations.slice(0, 4);
    const contentMigration = requiredMigrations[4];
    const importV2Migration = requiredMigrations[5];
    let upgradeHandle: BackendProcessHandle | undefined;

    try {
      expect(previousMigrations).toHaveLength(4);
      if (contentMigration === undefined) {
        throw new Error("T09-B1A Content V1 migration is required");
      }
      if (importV2Migration === undefined) {
        throw new Error("T09-B1B Catalog Import V2 migration is required");
      }
      expect(contentMigration.migrationId).toBe("20260903173554");
      expect(importV2Migration.migrationId).toBe("20260903193318");

      for (const migration of previousMigrations) {
        await upgradePool.query(
          await readFile(
            path.join(migrationsDirectory, migration.filename),
            "utf8",
          ),
        );
      }
      await upgradePool.query(`
        CREATE TABLE schema_migrations (
          migration_id VARCHAR(14) PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          checksum VARCHAR(64) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT schema_migrations_id_valid CHECK (
            migration_id ~ '^[0-9]{14}$'
          ),
          CONSTRAINT schema_migrations_checksum_valid CHECK (
            checksum ~ '^[0-9a-f]{64}$'
          )
        )
      `);
      for (const migration of previousMigrations) {
        await upgradePool.query(
          `INSERT INTO schema_migrations (migration_id, filename, checksum)
           VALUES ($1, $2, $3)`,
          [migration.migrationId, migration.filename, migration.checksum],
        );
      }

      await upgradePool.query(
        `INSERT INTO catalog_entries
           (catalog_id, kind, title, summary, description, period_label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          "legacy-content-record",
          "inscription",
          "Legacy Content Record",
          "Legacy summary",
          "Legacy description",
          "宋",
        ],
      );
      await upgradePool.query(
        `INSERT INTO catalog_aliases
           (catalog_id, position, alias, alias_type)
         VALUES ($1, 0, $2, 'historical')`,
        ["legacy-content-record", "Legacy alias"],
      );
      await upgradePool.query(
        `INSERT INTO catalog_source_citations
           (catalog_id, position, label, citation, url)
         VALUES ($1, 0, $2, $3, $4)`,
        [
          "legacy-content-record",
          "Legacy citation",
          "Legacy citation text",
          "https://example.invalid/legacy-content",
        ],
      );
      await upgradePool.query(
        `INSERT INTO catalog_media
           (media_id, catalog_id, position, is_representative, kind,
            alt_text, width, height, object_key)
         VALUES ($1, $2, 0, TRUE, 'image', $3, 800, 600, $4)`,
        [
          "legacy-content-media",
          "legacy-content-record",
          "Legacy media",
          "private/legacy-content.jpg",
        ],
      );
      await upgradePool.query(
        `INSERT INTO catalog_import_sources
           (source_id, catalog_id, source_title, source_type_raw, source_url, source_note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          "legacy-content-source",
          "legacy-content-record",
          "Legacy source title",
          "legacy-type",
          "https://example.invalid/legacy-source",
          "Legacy source note",
        ],
      );
      await upgradePool.query(
        `INSERT INTO catalog_import_operations
           (operation_id, import_contract_version, canonical_input_sha256,
            dry_run_result_sha256, approval_sha256, validation_context,
            status, result_json, created_at, applied_at)
         VALUES
           ($1, 'catalog-import/v1', $2, $3, $4, '{}'::jsonb,
            'APPLIED', '{}'::jsonb, $5, $5)`,
        [
          "legacy-content-operation",
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          new Date("2026-08-15T00:00:00.000Z"),
        ],
      );

      const beforeUpgrade = await Promise.all([
        upgradePool.query(
          `SELECT catalog_id, kind, title, summary, description, period_label,
                  description_state
           FROM catalog_entries
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT catalog_id, position, alias, alias_type
           FROM catalog_aliases
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT catalog_id, position, label, citation, url
           FROM catalog_source_citations
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT media_id, catalog_id, position, is_representative, kind,
                  alt_text, width, height, object_key
           FROM catalog_media
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT source_id, catalog_id, source_title, source_type_raw,
                  source_url, source_note
           FROM catalog_import_sources
           WHERE source_id = 'legacy-content-source'`,
        ),
        upgradePool.query(
          `SELECT operation_id, import_contract_version,
                  canonical_input_sha256, dry_run_result_sha256,
                  approval_sha256, validation_context, status, result_json,
                  created_at, applied_at
           FROM catalog_import_operations
           WHERE operation_id = 'legacy-content-operation'`,
        ),
      ]);

      expect(await runMigrations(upgradePool, migrationsDirectory)).toEqual(
        requiredMigrations.slice(4).map(({ migrationId }) => migrationId),
      );
      expect(await runMigrations(upgradePool, migrationsDirectory)).toEqual([]);
      await expect(
        verifyRequiredMigrationLedger(upgradePool),
      ).resolves.toBeUndefined();

      const afterUpgrade = await Promise.all([
        upgradePool.query(
          `SELECT catalog_id, kind, title, summary, description, period_label,
                  description_state
           FROM catalog_entries
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT catalog_id, position, alias, alias_type
           FROM catalog_aliases
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT catalog_id, position, label, citation, url
           FROM catalog_source_citations
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT media_id, catalog_id, position, is_representative, kind,
                  alt_text, width, height, object_key
           FROM catalog_media
           WHERE catalog_id = 'legacy-content-record'`,
        ),
        upgradePool.query(
          `SELECT source_id, catalog_id, source_title, source_type_raw,
                  source_url, source_note
           FROM catalog_import_sources
           WHERE source_id = 'legacy-content-source'`,
        ),
        upgradePool.query(
          `SELECT operation_id, import_contract_version,
                  canonical_input_sha256, dry_run_result_sha256,
                  approval_sha256, validation_context, status, result_json,
                  created_at, applied_at
           FROM catalog_import_operations
           WHERE operation_id = 'legacy-content-operation'`,
        ),
      ]);
      expect(afterUpgrade.map(({ rows }) => rows)).toEqual(
        beforeUpgrade.map(({ rows }) => rows),
      );

      const contentState = await upgradePool.query(
        `SELECT script_style, script_style_state,
                transcription, transcription_state,
                historical_context, historical_context_state,
                scholarly_research, scholarly_research_state
         FROM catalog_entries
         WHERE catalog_id = 'legacy-content-record'`,
      );
      const fabricated = await upgradePool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM catalog_contributors) AS contributors,
           (SELECT COUNT(*)::integer FROM catalog_source_citation_scopes) AS citation_scopes`,
      );
      expect(contentState.rows).toEqual([
        {
          historical_context: null,
          historical_context_state: "UNSUPPLIED",
          scholarly_research: null,
          scholarly_research_state: "UNSUPPLIED",
          script_style: null,
          script_style_state: "UNSUPPLIED",
          transcription: null,
          transcription_state: "UNSUPPLIED",
        },
      ]);
      expect(fabricated.rows).toEqual([
        { citation_scopes: 0, contributors: 0 },
      ]);

      const { baseUrl, handle } = await startHttp(
        upgradePool,
        new MappedStorageUrlResolver(
          new Map([
            [
              "private/legacy-content.jpg",
              "https://media.example.invalid/legacy-content.jpg",
            ],
          ]),
        ),
      );
      upgradeHandle = handle;
      const response = await fetch(
        `${baseUrl}/v1/catalog/legacy-content-record`,
      );
      const detail = catalogDetailSchema.parse(await response.json());
      expect(response.status).toBe(200);
      expect(detail.sourceCitations).toEqual([
        {
          label: "Legacy citation",
          citation: "Legacy citation text",
          url: "https://example.invalid/legacy-content",
        },
      ]);
      expect(detail.sourceCitations[0]).not.toHaveProperty("appliesTo");
      for (const property of [
        "contributors",
        "scriptStyle",
        "transcription",
        "historicalContext",
        "scholarlyResearch",
      ]) {
        expect(detail).not.toHaveProperty(property);
      }
    } finally {
      if (upgradeHandle !== undefined) {
        await upgradeHandle.shutdown();
        processes.delete(upgradeHandle);
      }
      await closePostgresPool(upgradePool);
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("serves seeded list, detail, ordering and frozen pagination semantics", async () => {
    await insertFixture();
    const { baseUrl } = await startHttp();
    const first = await fetch(`${baseUrl}/v1/catalog?page=1&pageSize=2`);
    const second = await fetch(`${baseUrl}/v1/catalog?page=2&pageSize=2`);
    const beyond = await fetch(`${baseUrl}/v1/catalog?page=100&pageSize=2`);
    const inscriptions = await fetch(
      `${baseUrl}/v1/catalog?kind=inscription&page=1&pageSize=1`,
    );
    const secondInscription = await fetch(
      `${baseUrl}/v1/catalog?kind=inscription&page=2&pageSize=1`,
    );
    const calligraphy = await fetch(`${baseUrl}/v1/catalog?kind=calligraphy`);
    const retiredKind = await fetch(
      `${baseUrl}/v1/catalog?kind=cliff_inscription`,
    );
    const detail = await fetch(`${baseUrl}/v1/catalog/test-catalog-001`);

    expect(catalogPageSchema.parse(await first.json())).toMatchObject({
      items: [
        {
          id: "test-catalog-001",
          aliases: ["First alias", "Second alias"],
          periodLabel: "Legacy period",
        },
        { id: "test-catalog-002", aliases: [] },
      ],
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    expect(
      catalogPageSchema.parse(await second.json()).items.map(({ id }) => id),
    ).toEqual(["test-catalog-003"]);
    expect(catalogPageSchema.parse(await beyond.json())).toMatchObject({
      items: [],
      page: 100,
      total: 3,
      totalPages: 2,
    });
    expect(catalogPageSchema.parse(await inscriptions.json())).toMatchObject({
      items: [{ id: "test-catalog-002", kind: "inscription" }],
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
    expect(
      catalogPageSchema
        .parse(await secondInscription.json())
        .items.map(({ id }) => id),
    ).toEqual(["test-catalog-003"]);
    expect(catalogPageSchema.parse(await calligraphy.json())).toMatchObject({
      items: [
        {
          id: "test-catalog-001",
          kind: "calligraphy",
          periodLabel: "Legacy period",
        },
      ],
      total: 1,
      totalPages: 1,
    });
    expect(retiredKind.status).toBe(400);
    expect(apiErrorSchema.parse(await retiredKind.json()).error.code).toBe(
      "INVALID_QUERY",
    );
    expect(catalogDetailSchema.parse(await detail.json())).toMatchObject({
      id: "test-catalog-001",
      aliases: ["First alias", "Second alias"],
      periodLabel: "Legacy period",
      dynasty: "唐",
      dateText: "贞观十年",
      province: "陕西",
      currentLocation: "陕西省碑林区",
      currentCustodian: "碑林博物馆",
      sourceCitations: [
        {
          label: "First citation",
          citation: "Test-only public citation",
          url: "https://example.invalid/catalog-001",
        },
        { label: "Second citation" },
      ],
    });
  });

  it("serves an exact full Content V1 Detail while keeping CatalogSummary unchanged", async () => {
    await insertFixture();
    await pool.query(
      `UPDATE catalog_entries
       SET script_style = $1,
           script_style_state = 'VALUE',
           transcription = $2,
           transcription_state = 'VALUE',
           historical_context = $3,
           historical_context_state = 'VALUE',
           scholarly_research = $4,
           scholarly_research_state = 'VALUE'
       WHERE catalog_id = $5`,
      [
        "碑额篆书，正文楷书",
        "第一行释文\n第二行释文",
        "第一段历史背景\n第二段历史背景",
        "第一段学术研究\n第二段学术研究",
        "test-catalog-001",
      ],
    );
    await pool.query(
      `INSERT INTO catalog_contributors (catalog_id, position, name, role)
       VALUES
         ($1, 1, $2, 'calligrapher'),
         ($1, 0, $3, 'textAuthor')`,
      ["test-catalog-001", "欧阳询", "魏徵"],
    );
    await pool.query(
      `INSERT INTO catalog_source_citations
         (catalog_id, position, label, citation, url)
       VALUES ($1, 2, $2, NULL, NULL)`,
      ["test-catalog-001", "Third citation"],
    );
    await pool.query(
      `INSERT INTO catalog_source_citation_scopes
         (catalog_id, citation_position, scope)
       VALUES
         ($1, 0, 'scholarlyResearch'),
         ($1, 2, 'historicalContext'),
         ($1, 0, 'record'),
         ($1, 2, 'description'),
         ($1, 0, 'transcription')`,
      ["test-catalog-001"],
    );

    const { baseUrl } = await startHttp();
    const detailResponse = await fetch(
      `${baseUrl}/v1/catalog/test-catalog-001`,
    );
    const listResponse = await fetch(`${baseUrl}/v1/catalog`);
    const detail = catalogDetailSchema.parse(await detailResponse.json());
    const list = catalogPageSchema.parse(await listResponse.json());

    expect(detailResponse.status).toBe(200);
    expect(detail).toEqual({
      id: "test-catalog-001",
      kind: "calligraphy",
      title: "Test Calligraphy",
      aliases: ["First alias", "Second alias"],
      summary: "First summary",
      periodLabel: "Legacy period",
      dynasty: "唐",
      dateText: "贞观十年",
      contributors: [
        { name: "魏徵", role: "textAuthor" },
        { name: "欧阳询", role: "calligrapher" },
      ],
      scriptStyle: "碑额篆书，正文楷书",
      province: "陕西",
      currentLocation: "陕西省碑林区",
      currentCustodian: "碑林博物馆",
      description: "First description",
      transcription: "第一行释文\n第二行释文",
      historicalContext: "第一段历史背景\n第二段历史背景",
      scholarlyResearch: "第一段学术研究\n第二段学术研究",
      sourceCitations: [
        {
          label: "First citation",
          citation: "Test-only public citation",
          url: "https://example.invalid/catalog-001",
          appliesTo: ["record", "transcription", "scholarlyResearch"],
        },
        { label: "Second citation" },
        {
          label: "Third citation",
          appliesTo: ["description", "historicalContext"],
        },
      ],
      media: [],
    });
    expect(listResponse.status).toBe(200);
    const summary = list.items.find(({ id }) => id === "test-catalog-001");
    expect(summary).toEqual({
      id: "test-catalog-001",
      kind: "calligraphy",
      title: "Test Calligraphy",
      aliases: ["First alias", "Second alias"],
      summary: "First summary",
      periodLabel: "Legacy period",
      province: "陕西",
    });
    for (const property of [
      "contributors",
      "scriptStyle",
      "transcription",
      "historicalContext",
      "scholarlyResearch",
    ]) {
      expect(summary).not.toHaveProperty(property);
    }
    const serialized = JSON.stringify(detail);
    for (const privateTerm of [
      "script_style_state",
      "transcription_state",
      "historical_context_state",
      "scholarly_research_state",
      "citation_position",
      "position",
      "sourceId",
      "objectKey",
    ]) {
      expect(serialized).not.toContain(privateTerm);
    }
  });

  it("loads only representative Media for list and the full ordered Gallery for detail", async () => {
    await insertFixture();
    for (const media of [
      {
        mediaId: "media-http-gallery-zero",
        position: 0,
        isRepresentative: false,
      },
      {
        mediaId: "media-http-gallery-one",
        position: 1,
        isRepresentative: false,
      },
      {
        mediaId: "media-http-representative",
        position: 2,
        isRepresentative: true,
      },
    ] as const) {
      await insertMediaFixture(media);
    }

    const locatorBatches: string[][] = [];
    const mappedResolver = new MappedStorageUrlResolver(
      new Map([
        [
          "private/media-http-gallery-zero.jpg",
          "https://media.example.invalid/gallery-zero.jpg",
        ],
        [
          "private/media-http-gallery-one.jpg",
          "https://media.example.invalid/gallery-one.jpg",
        ],
        [
          "private/media-http-representative.jpg",
          "https://media.example.invalid/representative.jpg",
        ],
      ]),
    );
    const resolver: StorageUrlResolver = {
      async resolveMany(locators) {
        locatorBatches.push(locators.map(({ mediaId }) => String(mediaId)));
        return mappedResolver.resolveMany(locators);
      },
    };
    const { baseUrl } = await startHttp(pool, resolver);

    const listResponse = await fetch(`${baseUrl}/v1/catalog`);
    const list = catalogPageSchema.parse(await listResponse.json());
    expect(listResponse.status).toBe(200);
    expect(locatorBatches).toEqual([["media-http-representative"]]);
    expect(list.items[0]?.representativeMedia).toMatchObject({
      id: mediaIdSchema.parse("media-http-representative"),
      src: "https://media.example.invalid/representative.jpg",
    });
    expect(list.items[0]).not.toHaveProperty("media");
    expect(JSON.stringify(list)).not.toContain("objectKey");
    expect(JSON.stringify(list)).not.toContain("private/media-http");

    locatorBatches.length = 0;
    const detailResponse = await fetch(
      `${baseUrl}/v1/catalog/test-catalog-001`,
    );
    const detail = catalogDetailSchema.parse(await detailResponse.json());
    expect(detailResponse.status).toBe(200);
    expect(locatorBatches).toEqual([
      [
        "media-http-gallery-zero",
        "media-http-gallery-one",
        "media-http-representative",
      ],
    ]);
    expect(detail.media.map(({ id }) => id)).toEqual([
      "media-http-gallery-zero",
      "media-http-gallery-one",
      "media-http-representative",
    ]);
    expect(detail.representativeMedia?.id).toBe("media-http-representative");
    expect(JSON.stringify(detail)).not.toContain("objectKey");
    expect(JSON.stringify(detail)).not.toContain("private/media-http");
  });

  it("keeps a Gallery without representative Media as an explicit valid state", async () => {
    await insertFixture();
    await insertMediaFixture({
      mediaId: "media-http-gallery-only",
      position: 0,
      isRepresentative: false,
    });
    let resolverCalls = 0;
    const resolver: StorageUrlResolver = {
      async resolveMany(locators) {
        resolverCalls += 1;
        return new MappedStorageUrlResolver(
          new Map([
            [
              "private/media-http-gallery-only.jpg",
              "https://media.example.invalid/gallery-only.jpg",
            ],
          ]),
        ).resolveMany(locators);
      },
    };
    const { baseUrl } = await startHttp(pool, resolver);

    const listResponse = await fetch(`${baseUrl}/v1/catalog`);
    const list = catalogPageSchema.parse(await listResponse.json());
    expect(listResponse.status).toBe(200);
    expect(list.items[0]).not.toHaveProperty("representativeMedia");
    expect(resolverCalls).toBe(0);

    const detailResponse = await fetch(
      `${baseUrl}/v1/catalog/test-catalog-001`,
    );
    const detail = catalogDetailSchema.parse(await detailResponse.json());
    expect(detailResponse.status).toBe(200);
    expect(detail).not.toHaveProperty("representativeMedia");
    expect(detail.media.map(({ id }) => id)).toEqual([
      "media-http-gallery-only",
    ]);
    expect(resolverCalls).toBe(1);
  });

  it("fails Media reads closed when required resolver output is missing", async () => {
    await insertFixture();
    await insertMediaFixture({
      mediaId: "media-http-unresolved",
      position: 0,
      isRepresentative: true,
    });
    const { baseUrl } = await startHttp(
      pool,
      new UnconfiguredStorageUrlResolver(),
    );

    for (const path of ["/v1/catalog", "/v1/catalog/test-catalog-001"]) {
      const response = await fetch(`${baseUrl}${path}`);
      const error = apiErrorSchema.parse(await response.json());
      expect(response.status).toBe(503);
      expect(error.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(JSON.stringify(error)).not.toContain("private/media-http");
    }
  });

  it("does not serialize an adapter-private database column", async () => {
    await pool.query(
      "ALTER TABLE catalog_entries ADD COLUMN IF NOT EXISTS test_private_metadata TEXT",
    );
    await insertFixture();
    await pool.query(
      `UPDATE catalog_entries
       SET test_private_metadata = $1
       WHERE catalog_id = $2`,
      [
        "raw evidence review objectKey /Users/SYNTHETIC/catalog-internal-note",
        "test-catalog-001",
      ],
    );
    const { baseUrl } = await startHttp();
    const response = await fetch(`${baseUrl}/v1/catalog/test-catalog-001`);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).not.toContain("test_private_metadata");
    expect(serialized).not.toContain("raw evidence");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("/Users/SYNTHETIC/catalog-internal-note");
  });

  it("accepts newer unknown ledger rows without claiming rollback safety", async () => {
    const futureMigrationId = "99991231235959";
    await pool.query("DELETE FROM schema_migrations WHERE migration_id = $1", [
      futureMigrationId,
    ]);
    try {
      await pool.query(
        `INSERT INTO schema_migrations
           (migration_id, filename, checksum)
         VALUES ($1, $2, $3)`,
        [futureMigrationId, "99991231235959_future_expand.sql", "0".repeat(64)],
      );

      await expect(
        verifyRequiredMigrationLedger(pool),
      ).resolves.toBeUndefined();
    } finally {
      await pool.query(
        "DELETE FROM schema_migrations WHERE migration_id = $1",
        [futureMigrationId],
      );
    }
  });

  it("fails production startup on an unmigrated schema without creating its ledger", async () => {
    const schema = "t052_startup_read_only";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);

    try {
      await expect(
        prepareProductionBackend({
          ...productionPublishingEnvironment,
          // Synthetic signing only; these tests never contact COS.
          COS_BUCKET: "synthetic-example-1250000000",
          COS_REGION: "ap-guangzhou",
          COS_MEDIA_ORIGIN: "https://media.example.invalid",
          COS_SECRET_ID: "synthetic-unit-id",
          COS_SECRET_KEY: "synthetic-unit-secret",
          DATABASE_URL: isolatedUrl.toString(),
          APP_DATABASE_URL: isolatedUrl.toString(),
          HOST: "127.0.0.1",
          NODE_ENV: "production",
          PORT: "3001",
        }),
      ).rejects.toThrow("PostgreSQL startup validation failed");
      const ledger = await pool.query("SELECT to_regclass($1) AS relation", [
        `${schema}.schema_migrations`,
      ]);
      expect(ledger.rows).toEqual([{ relation: null }]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("maps a real unavailable PostgreSQL connection to safe Catalog and health 503", async () => {
    const unavailablePool = createPostgresPool({
      connectionString:
        "postgresql://127.0.0.1:1/SYNTHETIC_UNAVAILABLE_CATALOG",
      connectionTimeoutMillis: 100,
      max: 5,
      idleTimeoutMillis: 10_000,
      ssl: false,
    });
    const { baseUrl } = await startHttp(unavailablePool);
    const [catalogResponse, healthResponse] = await Promise.all([
      fetch(`${baseUrl}/v1/catalog`),
      fetch(`${baseUrl}/health`),
    ]);
    const catalogError = apiErrorSchema.parse(await catalogResponse.json());
    const healthError = apiErrorSchema.parse(await healthResponse.json());

    expect(catalogResponse.status).toBe(503);
    expect(catalogError.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(healthResponse.status).toBe(503);
    expect(healthError.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify([catalogError, healthError])).not.toContain("secret");
    await closePostgresPool(unavailablePool);
  });

  it("composes production only after read-only migration validation and closes its pool", async () => {
    await insertFixture();
    const prepared = await prepareProductionBackend({
      ...productionPublishingEnvironment,
      // Synthetic signing only; these tests never contact COS.
      COS_BUCKET: "synthetic-example-1250000000",
      COS_REGION: "ap-guangzhou",
      COS_MEDIA_ORIGIN: "https://media.example.invalid",
      COS_SECRET_ID: "synthetic-unit-id",
      COS_SECRET_KEY: "synthetic-unit-secret",
      DATABASE_URL: testDatabaseUrl,
      APP_DATABASE_URL: testDatabaseUrl,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: "3001",
    });
    const handle = await startBackendProcess({
      closeResources: prepared.closeResources,
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: prepared.requestListener,
    });
    processes.add(handle);
    const baseUrl = `http://${handle.address.address}:${handle.address.port}`;
    const [response, listResponse, detailResponse] = await Promise.all([
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/v1/catalog`),
      fetch(`${baseUrl}/v1/catalog/test-catalog-001`),
    ]);

    expect(response.status).toBe(200);
    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(
      catalogPageSchema.parse(await listResponse.json()).items,
    ).toHaveLength(3);
    expect(
      catalogDetailSchema.parse(await detailResponse.json()),
    ).toMatchObject({ media: [] });
    await handle.shutdown();
    processes.delete(handle);
    await expect(prepared.readinessCheck()).rejects.toThrow();
  });
});
