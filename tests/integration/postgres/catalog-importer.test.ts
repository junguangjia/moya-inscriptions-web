import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCatalogImport,
  createCatalogImportDryRun,
  parseCatalogImportCsvBundle as parseVersionedCatalogImportCsvBundle,
  parseCatalogImportXlsxFile as parseVersionedCatalogImportXlsxFile,
} from "@moya/catalog-importer";
import { prepareProductionBackend } from "@moya/backend-production";
import { startBackendProcess } from "@moya/backend-runtime";
import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
  requiredMigrations,
  runMigrations,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import {
  catalogDetailSchema,
  catalogIdSchema,
  catalogPageSchema,
} from "@moya/contracts/schemas";
import {
  CATALOG_IMPORT_ALIAS_HEADERS,
  CATALOG_IMPORT_CATALOG_HEADERS,
  CATALOG_IMPORT_CONTRACT_VERSION,
  CATALOG_IMPORT_PROVENANCE_HEADERS,
  CATALOG_IMPORT_V2_CONTRACT_VERSION,
  canonicalCatalogImportV2EnvelopeSchema,
  dryRunFindingIdSchema,
  serializeCanonicalCatalogImportV2Envelope,
} from "@moya/contracts/internal/catalog-import";
import ExcelJS from "exceljs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  CanonicalCatalogImportV2Envelope,
  CatalogImportV2DryRun,
  VersionedCatalogImportDryRun,
  VersionedImportApproval,
} from "@moya/contracts/internal/catalog-import";
import type {
  CatalogIdAllocator,
  CatalogImportAuthorization,
  ParsedCatalogImportBundle,
  ParsedCatalogImportV1Bundle,
  ParsedCatalogImportV2Bundle,
} from "@moya/catalog-importer";

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
      openProductionPublishingStore: vi.fn(
        () =>
          ({
            writeStream: refuseMediaIo,
            openRead: refuseMediaIo,
            remove: refuseMediaIo,
            listBlobs: refuseMediaIo,
            sweepStaging: refuseMediaIo,
          }) as unknown as ReturnType<
            typeof actual.openProductionPublishingStore
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
const schema = "p5_catalog_importer";
const isolatedUrl = new URL(testDatabaseUrl);
isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
const administrationPool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: isolatedUrl.toString() }),
);
let bundleDirectory = "";
let xlsxDirectory = "";

const requireV1Bundle = (
  parsed: ParsedCatalogImportBundle,
): ParsedCatalogImportV1Bundle => {
  if (
    parsed.envelope.importContractVersion !== CATALOG_IMPORT_CONTRACT_VERSION
  ) {
    throw new Error("Expected a catalog-import/v1 test bundle");
  }
  return parsed as ParsedCatalogImportV1Bundle;
};

const parseCatalogImportCsvBundle = async (
  directory: string,
): Promise<ParsedCatalogImportV1Bundle> =>
  requireV1Bundle(await parseVersionedCatalogImportCsvBundle(directory));

const parseCatalogImportXlsxFile = async (
  file: string,
): Promise<ParsedCatalogImportV1Bundle> =>
  requireV1Bundle(await parseVersionedCatalogImportXlsxFile(file));

const catalogHeaders =
  "catalogImportId,sourceId,catalogId,title,catalogKind,dynasty,dynastyState,dateText,dateTextState,province,provinceState,prefecture,prefectureState,county,countyState,currentLocation,currentLocationState,currentCustodian,currentCustodianState,description,descriptionState,ownerNote";

const writeBundle = async (input?: {
  readonly catalogId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly descriptionState?: "VALUE" | "UNSUPPLIED" | "CLEAR";
  readonly alias?: boolean;
  readonly aliasValue?: string;
  readonly aliasType?: "alternate" | "historical";
  readonly ownerNote?: string;
}) => {
  const description = input?.description ?? "测试说明";
  const descriptionState = input?.descriptionState ?? "VALUE";
  const catalogRow = [
    "item-000001",
    "src_test_p5_001",
    input?.catalogId ?? "",
    input?.title ?? "测试碑刻",
    "inscription",
    "唐",
    "VALUE",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    description,
    descriptionState,
    input?.ownerNote ?? "",
  ].join(",");
  await Promise.all([
    writeFile(
      path.join(bundleDirectory, "00_manifest.csv"),
      "importContractVersion\ncatalog-import/v1\n",
    ),
    writeFile(
      path.join(bundleDirectory, "catalog.csv"),
      `${catalogHeaders}\n${catalogRow}\n`,
    ),
    writeFile(
      path.join(bundleDirectory, "aliases.csv"),
      input?.alias === false
        ? "catalogImportId,alias,aliasType\n"
        : `catalogImportId,alias,aliasType\nitem-000001,${input?.aliasValue ?? "测试旧称"},${input?.aliasType ?? "historical"}\n`,
    ),
    writeFile(
      path.join(bundleDirectory, "provenance.csv"),
      "catalogImportId,sourceId,sourceTitle,sourceTypeRaw,sourceUrl,sourceNote\nitem-000001,src_test_p5_001,测试碑刻,official-test,https://example.invalid/source,\n",
    ),
  ]);
};

const writeXlsxWorkbook = async (input?: {
  readonly catalogId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly descriptionState?: "VALUE" | "UNSUPPLIED" | "CLEAR";
  readonly alias?: boolean;
  readonly aliasValue?: string;
  readonly aliasType?: "alternate" | "historical";
  readonly ownerNote?: string;
}): Promise<string> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Uint8Array.from(
      await readFile(
        path.join(
          repositoryRoot,
          "docs/catalog-import/catalog-import-v1-template.xlsx",
        ),
      ),
    ).buffer,
    { ignoreNodes: ["dataValidations"] },
  );
  const catalog = {
    catalogImportId: "item-000001",
    sourceId: "src_test_p5_001",
    catalogId: input?.catalogId ?? "",
    title: input?.title ?? "测试碑刻",
    catalogKind: "inscription",
    dynasty: "唐",
    dynastyState: "VALUE",
    dateText: "",
    dateTextState: "",
    province: "",
    provinceState: "",
    prefecture: "",
    prefectureState: "",
    county: "",
    countyState: "",
    currentLocation: "",
    currentLocationState: "",
    currentCustodian: "",
    currentCustodianState: "",
    description: input?.description ?? "测试说明",
    descriptionState: input?.descriptionState ?? "VALUE",
    ownerNote: input?.ownerNote ?? "",
  };
  const alias = {
    catalogImportId: "item-000001",
    alias: input?.aliasValue ?? "测试旧称",
    aliasType: input?.aliasType ?? "historical",
  };
  const provenance = {
    catalogImportId: "item-000001",
    sourceId: "src_test_p5_001",
    sourceTitle: "测试碑刻",
    sourceTypeRaw: "official-test",
    sourceUrl: "https://example.invalid/source",
    sourceNote: "",
  };
  for (const [sheetName, headers, rows] of [
    ["01_Catalog", CATALOG_IMPORT_CATALOG_HEADERS, [catalog]],
    [
      "02_Aliases",
      CATALOG_IMPORT_ALIAS_HEADERS,
      input?.alias === false ? [] : [alias],
    ],
    ["03_Provenance", CATALOG_IMPORT_PROVENANCE_HEADERS, [provenance]],
  ] as const) {
    const worksheet = workbook.getWorksheet(sheetName)!;
    for (const [rowIndex, row] of rows.entries()) {
      for (const [columnIndex, header] of headers.entries()) {
        worksheet.getCell(rowIndex + 3, columnIndex + 1).value =
          row[header as keyof typeof row];
      }
    }
  }
  const destination = path.join(xlsxDirectory, "synthetic-import.xlsx");
  await workbook.xlsx.writeFile(destination);
  return destination;
};

const fakeAllocator = (
  catalogId = "catalog-platform-test-001",
): CatalogIdAllocator => ({
  allocateCatalogId: () => catalogIdSchema.parse(catalogId),
});

const SYNTHETIC_AUTHORIZATION = (
  dryRun: VersionedCatalogImportDryRun,
  approvedFindingIds: readonly string[] = [],
  runtime: "VALIDATION" | "PRODUCTION" = "VALIDATION",
): CatalogImportAuthorization => {
  const approval = {
    importContractVersion: dryRun.importContractVersion,
    canonicalInputSha256: dryRun.canonicalInputSha256,
    dryRunResultSha256: dryRun.dryRunResultSha256,
    state: "APPROVED" as const,
    approvedFindingIds: approvedFindingIds.map((id) =>
      dryRunFindingIdSchema.parse(id),
    ),
    decidedBy: "OWNER / owner — supplied test approval",
    decidedAt: "2026-08-15T00:00:00.000Z",
  } as VersionedImportApproval;
  return runtime === "VALIDATION"
    ? {
        runtime: "VALIDATION",
        purpose: "VALIDATION_ONLY",
        nonProduction: true,
        disposableDatabase: true,
        publicationApproval: false,
        reusableForProduction: false,
        ownerInstructionReference: "test owner authorization",
        approval,
      }
    : {
        runtime: "PRODUCTION",
        purpose: "PRODUCTION_IMPORT",
        publicationApproval: false,
        approval,
      };
};

const applyInput = (
  parsed: ParsedCatalogImportBundle,
  dryRun: VersionedCatalogImportDryRun,
  operationId: string,
  overrides: Partial<Parameters<typeof applyCatalogImport>[1]> = {},
) => ({
  operationId,
  parsed,
  dryRun,
  authorization: SYNTHETIC_AUTHORIZATION(dryRun),
  catalogIdAllocator: fakeAllocator(),
  appliedAt: "2026-08-15T00:00:00.000Z",
  ...overrides,
});

type V2CatalogRow = CanonicalCatalogImportV2Envelope["catalogRows"][number];
type V2ScalarFieldName =
  | "summary"
  | "periodLabel"
  | "scriptStyle"
  | "transcription"
  | "historicalContext"
  | "scholarlyResearch";
type V2ContributorInput = Omit<
  CanonicalCatalogImportV2Envelope["contributorRows"][number],
  "catalogImportId"
>;
type V2CitationInput = Omit<
  CanonicalCatalogImportV2Envelope["publicCitationRows"][number],
  "catalogImportId"
>;
type V2ProvenanceInput = Omit<
  CanonicalCatalogImportV2Envelope["provenanceRows"][number],
  "catalogImportId" | "sourceId"
>;

const defaultV2Contributors = [
  { position: 1, name: "欧阳询", role: "calligrapher" },
  { position: 0, name: "魏徵", role: "textAuthor" },
] as const satisfies readonly V2ContributorInput[];

const defaultV2Citations = [
  {
    position: 0,
    label: "未限定公开来源",
    citation: "未限定记录级引文",
    url: "https://example.invalid/public/record",
  },
  {
    position: 2,
    label: "内容公开来源",
    citation: "内容字段引文",
    url: "https://example.invalid/public/content",
    appliesTo: ["scholarlyResearch", "record", "transcription"],
  },
] as const satisfies readonly V2CitationInput[];

const buildV2ParsedBundle = (
  input: {
    readonly catalogImportId?: string;
    readonly sourceId?: string;
    readonly catalogId?: string;
    readonly title?: string;
    readonly scalarFields?: Partial<Pick<V2CatalogRow, V2ScalarFieldName>>;
    readonly contributorsAction?: "PRESERVE" | "REPLACE" | "CLEAR";
    readonly contributorRows?: readonly V2ContributorInput[];
    readonly publicCitationsAction?: "PRESERVE" | "REPLACE" | "CLEAR";
    readonly publicCitationRows?: readonly V2CitationInput[];
    readonly provenanceFields?: Partial<V2ProvenanceInput>;
  } = {},
): ParsedCatalogImportV2Bundle => {
  const catalogImportId = input.catalogImportId ?? "v2-item-000001";
  const sourceId = input.sourceId ?? "src_test_v2_001";
  const contributorsAction = input.contributorsAction ?? "REPLACE";
  const publicCitationsAction = input.publicCitationsAction ?? "REPLACE";
  const contributorRows =
    input.contributorRows ??
    (contributorsAction === "REPLACE" ? defaultV2Contributors : []);
  const publicCitationRows =
    input.publicCitationRows ??
    (publicCitationsAction === "REPLACE" ? defaultV2Citations : []);
  const envelope = canonicalCatalogImportV2EnvelopeSchema.parse({
    importContractVersion: CATALOG_IMPORT_V2_CONTRACT_VERSION,
    catalogRows: [
      {
        catalogImportId,
        sourceId,
        ...(input.catalogId === undefined
          ? {}
          : { catalogId: input.catalogId }),
        title: input.title ?? "V2 测试碑刻",
        catalogKind: "inscription",
        dynasty: { state: "VALUE", value: "唐" },
        dateText: { state: "UNSUPPLIED" },
        province: { state: "UNSUPPLIED" },
        prefecture: { state: "UNSUPPLIED" },
        county: { state: "UNSUPPLIED" },
        currentLocation: { state: "UNSUPPLIED" },
        currentCustodian: { state: "UNSUPPLIED" },
        description: { state: "VALUE", value: "V2 测试说明" },
        scriptStyle: { state: "VALUE", value: "碑额篆书，正文楷书" },
        transcription: {
          state: "VALUE",
          value: "第一行释文\n第二行释文",
        },
        historicalContext: {
          state: "VALUE",
          value: "第一段历史背景\n第二段历史背景",
        },
        scholarlyResearch: {
          state: "VALUE",
          value: "第一段学术研究\n第二段学术研究",
        },
        ...input.scalarFields,
        contributorsAction,
        publicCitationsAction,
      },
    ],
    aliasRows: [],
    provenanceRows: [
      {
        catalogImportId,
        sourceId,
        sourceTitle: "V2 测试碑刻来源",
        sourceTypeRaw: "official-test",
        sourceUrl: "https://example.invalid/raw-source",
        ...input.provenanceFields,
      },
    ],
    contributorRows: contributorRows.map((row) => ({
      catalogImportId,
      ...row,
    })),
    publicCitationRows: publicCitationRows.map((row) => ({
      catalogImportId,
      ...row,
    })),
  });
  const canonicalJson = serializeCanonicalCatalogImportV2Envelope(envelope);
  return {
    envelope,
    canonicalJson,
    canonicalInputSha256: createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex"),
    rowCounts: {
      catalog: envelope.catalogRows.length,
      aliases: envelope.aliasRows.length,
      provenance: envelope.provenanceRows.length,
      contributors: envelope.contributorRows.length,
      publicCitations: envelope.publicCitationRows.length,
    },
  };
};

const requireV2DryRun = (
  dryRun: VersionedCatalogImportDryRun,
): CatalogImportV2DryRun => {
  if (dryRun.importContractVersion !== CATALOG_IMPORT_V2_CONTRACT_VERSION) {
    throw new Error("Expected a catalog-import/v2 dry-run");
  }
  return dryRun;
};

const createV2DryRun = async (
  parsed: ParsedCatalogImportV2Bundle,
  completedAt: string,
): Promise<CatalogImportV2DryRun> =>
  requireV2DryRun(await createCatalogImportDryRun(pool, parsed, completedAt));

const readContributorRows = async () =>
  (
    await pool.query(
      `SELECT catalog_id, position, name, role, xmin::text AS revision
       FROM catalog_contributors ORDER BY catalog_id, position`,
    )
  ).rows;

const readCitationRows = async () => ({
  citations: (
    await pool.query(
      `SELECT catalog_id, position, label, citation, url, xmin::text AS revision
       FROM catalog_source_citations ORDER BY catalog_id, position`,
    )
  ).rows,
  scopes: (
    await pool.query(
      `SELECT catalog_id, citation_position, scope, xmin::text AS revision
       FROM catalog_source_citation_scopes
       ORDER BY catalog_id, citation_position,
         CASE scope
           WHEN 'record' THEN 1
           WHEN 'description' THEN 2
           WHEN 'transcription' THEN 3
           WHEN 'historicalContext' THEN 4
           WHEN 'scholarlyResearch' THEN 5
         END`,
    )
  ).rows,
});

const omitRevision = <Row extends { readonly revision: unknown }>({
  revision,
  ...row
}: Row): Omit<Row, "revision"> => {
  void revision;
  return row;
};

const v2CatalogId = "catalog-v2-test-001";

const seedV2Catalog = async (operationId: string) => {
  const parsed = buildV2ParsedBundle();
  const dryRun = await createV2DryRun(parsed, "2026-09-03T20:00:00.000Z");
  const result = await applyCatalogImport(pool, {
    ...applyInput(parsed, dryRun, operationId),
    catalogIdAllocator: fakeAllocator(v2CatalogId),
  });
  return { parsed, dryRun, result };
};

const readImporterDatabaseState = async () => {
  const [entries, aliases, sources, operations, operationItems] =
    await Promise.all([
      pool.query("SELECT * FROM catalog_entries ORDER BY catalog_id"),
      pool.query("SELECT * FROM catalog_aliases ORDER BY catalog_id, position"),
      pool.query("SELECT * FROM catalog_import_sources ORDER BY source_id"),
      pool.query(
        "SELECT * FROM catalog_import_operations ORDER BY operation_id",
      ),
      pool.query(
        "SELECT * FROM catalog_import_operation_items ORDER BY operation_id, catalog_import_id",
      ),
    ]);
  return {
    entries: entries.rows,
    aliases: aliases.rows,
    sources: sources.rows,
    operations: operations.rows,
    operationItems: operationItems.rows,
  };
};

beforeAll(async () => {
  await administrationPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await administrationPool.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool, migrationsDirectory);
  // The production composition also verifies the community ledger read-only.
  await runCommunityMigrations(
    pool,
    path.join(repositoryRoot, "database", "community-migrations"),
  );
  bundleDirectory = await mkdtemp(path.join(tmpdir(), "moya-p5-import-"));
  xlsxDirectory = await mkdtemp(path.join(tmpdir(), "moya-xlsx-import-"));
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE catalog_import_operations, catalog_entries CASCADE",
  );
  await writeBundle();
});

afterAll(async () => {
  await closePostgresPool(pool);
  await administrationPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await closePostgresPool(administrationPool);
  await rm(bundleDirectory, { recursive: true, force: true });
  await rm(xlsxDirectory, { recursive: true, force: true });
});

describe.sequential("catalog-import/v1 PostgreSQL apply", () => {
  it("converges CSV and XLSX through the same dry-run, apply, and PostgreSQL state", async () => {
    const csv = await parseCatalogImportCsvBundle(bundleDirectory);
    const xlsx = await parseCatalogImportXlsxFile(await writeXlsxWorkbook());
    expect(xlsx.envelope).toEqual(csv.envelope);
    expect(xlsx.canonicalInputSha256).toBe(csv.canonicalInputSha256);

    const completedAt = "2026-08-15T00:00:00.000Z";
    const csvDryRun = await createCatalogImportDryRun(pool, csv, completedAt);
    const xlsxDryRun = await createCatalogImportDryRun(pool, xlsx, completedAt);
    expect(xlsxDryRun).toEqual(csvDryRun);
    await applyCatalogImport(
      pool,
      applyInput(csv, csvDryRun, "cross-format-csv"),
    );
    const csvState = await readImporterDatabaseState();
    const csvSemanticState = {
      entries: csvState.entries,
      aliases: csvState.aliases,
      sources: csvState.sources,
    };

    await pool.query(
      "TRUNCATE catalog_import_operations, catalog_entries CASCADE",
    );
    const freshXlsxDryRun = await createCatalogImportDryRun(
      pool,
      xlsx,
      completedAt,
    );
    expect(freshXlsxDryRun.dryRunResultSha256).toBe(
      csvDryRun.dryRunResultSha256,
    );
    await applyCatalogImport(
      pool,
      applyInput(xlsx, freshXlsxDryRun, "cross-format-xlsx"),
    );
    const xlsxState = await readImporterDatabaseState();
    expect({
      entries: xlsxState.entries,
      aliases: xlsxState.aliases,
      sources: xlsxState.sources,
    }).toEqual(csvSemanticState);
  });

  it("keeps XLSX ownerNote fail-closed for CREATE and UPDATE with zero mutation", async () => {
    const create = await parseCatalogImportXlsxFile(
      await writeXlsxWorkbook({ ownerNote: "仅供 Owner 审核" }),
    );
    const createDryRun = await createCatalogImportDryRun(
      pool,
      create,
      "2026-08-15T00:00:00.100Z",
    );
    expect(createDryRun).toMatchObject({
      state: "FAILED",
      applyReady: false,
      applyBlockers: ["DEFERRED_FIELD_NOT_PRESERVED"],
      findings: [
        {
          field: "ownerNote",
          persistenceDisposition: "RAW_ONLY",
          applyBlocker: "DEFERRED_FIELD_NOT_PRESERVED",
        },
      ],
    });
    const beforeCreate = await readImporterDatabaseState();
    let allocations = 0;
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(create, createDryRun, "xlsx-owner-note-create"),
        catalogIdAllocator: {
          allocateCatalogId: () => {
            allocations += 1;
            return "catalog-never-allocated";
          },
        },
      }),
    ).rejects.toThrow("Import dry-run is not apply-ready");
    expect(allocations).toBe(0);
    await expect(readImporterDatabaseState()).resolves.toEqual(beforeCreate);

    await writeBundle({ alias: false });
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:00.200Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "xlsx-owner-note-seed"),
    );
    const beforeUpdate = await readImporterDatabaseState();
    const update = await parseCatalogImportXlsxFile(
      await writeXlsxWorkbook({
        catalogId: "catalog-platform-test-001",
        alias: false,
        ownerNote: "仅供 Owner 审核",
      }),
    );
    const updateDryRun = await createCatalogImportDryRun(
      pool,
      update,
      "2026-08-15T00:00:00.300Z",
    );
    expect(updateDryRun).toMatchObject({
      state: "FAILED",
      applyReady: false,
      applyBlockers: ["DEFERRED_FIELD_NOT_PRESERVED"],
      findings: [{ field: "ownerNote" }],
    });
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(update, updateDryRun, "xlsx-owner-note-update"),
        authorization: SYNTHETIC_AUTHORIZATION(updateDryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("Import dry-run is not apply-ready");
    await expect(readImporterDatabaseState()).resolves.toEqual(beforeUpdate);
  });

  it("keeps XLSX alias collection UPDATE fail-closed before mutation", async () => {
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:00.400Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "xlsx-alias-seed"),
    );
    const before = await readImporterDatabaseState();
    const update = await parseCatalogImportXlsxFile(
      await writeXlsxWorkbook({
        catalogId: "catalog-platform-test-001",
        aliasValue: "测试新别名",
        aliasType: "alternate",
      }),
    );
    await expect(
      createCatalogImportDryRun(pool, update, "2026-08-15T00:00:00.500Z"),
    ).rejects.toThrow("does not define alias merge/replace semantics");
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("requires a caller allocator, rolls back atomically, applies, and replays", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:00.000Z",
    );
    expect(dryRun).toMatchObject({
      state: "PASSED",
      applyReady: true,
      findings: [],
      resultCounts: { add: 1, update: 0, conflict: 0, error: 0 },
    });

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-no-allocator"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("explicitly supplied platform CatalogIdAllocator");
    await expect(
      pool.query(
        "SELECT COUNT(*)::integer AS count FROM catalog_import_operations",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-rollback"),
        failureAfterCatalogRows: 1,
      }),
    ).rejects.toThrow("Synthetic mid-transaction failure");
    await expect(
      pool.query("SELECT COUNT(*)::integer AS count FROM catalog_entries"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        "SELECT COUNT(*)::integer AS count FROM catalog_search_documents",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const input = applyInput(parsed, dryRun, "p5-applied");
    const first = await applyCatalogImport(pool, input);
    const searchBeforeReplay = await pool.query(
      "SELECT xmin::text AS revision FROM catalog_search_documents ORDER BY catalog_id",
    );
    const replay = await applyCatalogImport(pool, input);
    expect(
      (
        await pool.query(
          "SELECT xmin::text AS revision FROM catalog_search_documents ORDER BY catalog_id",
        )
      ).rows,
    ).toEqual(searchBeforeReplay.rows);
    expect(
      (
        await new PostgresCatalogQueryAdapter(pool).search({
          q: "测试旧称",
          page: 1,
          pageSize: 20,
        })
      ).items,
    ).toMatchObject([
      { id: "catalog-platform-test-001", matchKind: "alias-exact" },
    ]);
    expect(first).toMatchObject({
      status: "APPLIED",
      created: 1,
      updated: 0,
      catalogIdMap: [{ catalogId: "catalog-platform-test-001" }],
    });
    expect(replay).toMatchObject({ status: "ALREADY_APPLIED", created: 1 });
    expect(first.catalogIdMap[0]?.catalogId).not.toContain("src_test_p5_001");
    const persisted = await readImporterDatabaseState();
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      catalog_id: "catalog-platform-test-001",
      kind: "inscription",
      title: "测试碑刻",
      dynasty: "唐",
      dynasty_state: "VALUE",
      date_text: null,
      date_text_state: "UNSUPPLIED",
      description: "测试说明",
      description_state: "VALUE",
    });
    expect(persisted.aliases).toEqual([
      expect.objectContaining({
        catalog_id: "catalog-platform-test-001",
        alias: "测试旧称",
        alias_type: "historical",
      }),
    ]);
    expect(persisted.sources).toEqual([
      expect.objectContaining({
        source_id: "src_test_p5_001",
        catalog_id: "catalog-platform-test-001",
        source_title: "测试碑刻",
        source_type_raw: "official-test",
        source_url: "https://example.invalid/source",
      }),
    ]);
    expect(persisted.operations).toEqual([
      expect.objectContaining({
        operation_id: "p5-applied",
        status: "APPLIED",
        canonical_input_sha256: first.canonicalInputSha256,
      }),
    ]);
    expect(persisted.operationItems).toEqual([
      expect.objectContaining({
        operation_id: "p5-applied",
        catalog_import_id: "item-000001",
        source_id: "src_test_p5_001",
        catalog_id: "catalog-platform-test-001",
        result: "CREATED",
      }),
    ]);
  });

  it("updates the same CatalogId through the importer and preserves identity", async () => {
    await writeBundle({ alias: false });
    const createParsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const createDryRun = await createCatalogImportDryRun(
      pool,
      createParsed,
      "2026-08-15T00:00:01.000Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(createParsed, createDryRun, "p5-update-seed"),
    );

    await writeBundle({
      catalogId: "catalog-platform-test-001",
      title: "测试碑刻修订",
      alias: false,
    });
    const updateParsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const updateDryRun = await createCatalogImportDryRun(
      pool,
      updateParsed,
      "2026-08-15T00:00:02.000Z",
    );
    expect(updateDryRun).toMatchObject({
      state: "PASSED",
      resultCounts: { add: 0, update: 1, unchanged: 0 },
      findings: [{ field: "title", requiresFieldApproval: true }],
    });
    const findingIds = updateDryRun.findings.map(({ findingId }) =>
      String(findingId),
    );
    const result = await applyCatalogImport(pool, {
      ...applyInput(updateParsed, updateDryRun, "p5-update"),
      authorization: SYNTHETIC_AUTHORIZATION(
        updateDryRun,
        findingIds,
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const persisted = await pool.query(
      "SELECT catalog_id, title FROM catalog_entries",
    );
    expect(persisted.rows).toEqual([
      { catalog_id: "catalog-platform-test-001", title: "测试碑刻修订" },
    ]);
    expect(
      (
        await new PostgresCatalogQueryAdapter(pool).search({
          q: "测试碑刻修订",
          page: 1,
          pageSize: 20,
        })
      ).items,
    ).toMatchObject([
      {
        id: "catalog-platform-test-001",
        title: "测试碑刻修订",
        matchKind: "title-exact",
      },
    ]);
  });

  it("keeps supported alias storage separate from undefined alias update semantics", async () => {
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:02.010Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "p5-alias-update-seed"),
    );
    const before = await readImporterDatabaseState();

    await writeBundle({
      catalogId: "catalog-platform-test-001",
      aliasValue: "测试新别名",
      aliasType: "alternate",
    });
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    await expect(
      createCatalogImportDryRun(pool, parsed, "2026-08-15T00:00:02.020Z"),
    ).rejects.toThrow("does not define alias merge/replace semantics");
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("fails closed on supplied ownerNote for CREATE before any persistence mutation", async () => {
    await writeBundle({ ownerNote: "仅供 Owner 审核" });
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:02.100Z",
    );
    expect(dryRun).toMatchObject({
      state: "FAILED",
      applyReady: false,
      applyBlockers: ["DEFERRED_FIELD_NOT_PRESERVED"],
      resultCounts: { add: 0, update: 0, unchanged: 0, error: 1 },
      findings: [
        {
          field: "ownerNote",
          category: "ERROR",
          persistenceDisposition: "RAW_ONLY",
          applyBlocker: "DEFERRED_FIELD_NOT_PRESERVED",
          approvable: false,
          requiresFieldApproval: false,
          operation: "SET",
          message: "ownerNote cannot be silently discarded by apply",
        },
      ],
    });

    const before = await readImporterDatabaseState();
    let allocations = 0;
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-owner-note-create"),
        catalogIdAllocator: {
          allocateCatalogId: () => {
            allocations += 1;
            return "catalog-never-allocated";
          },
        },
      }),
    ).rejects.toThrow("Import dry-run is not apply-ready");
    expect(allocations).toBe(0);
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("fails closed on supplied ownerNote for UPDATE before any persistence mutation", async () => {
    await writeBundle({ alias: false });
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:02.200Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "p5-owner-note-update-seed"),
    );
    const before = await readImporterDatabaseState();

    await writeBundle({
      catalogId: "catalog-platform-test-001",
      alias: false,
      ownerNote: "仅供 Owner 审核",
    });
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:02.300Z",
    );
    expect(dryRun).toMatchObject({
      state: "FAILED",
      applyReady: false,
      applyBlockers: ["DEFERRED_FIELD_NOT_PRESERVED"],
      resultCounts: { add: 0, update: 0, unchanged: 0, error: 1 },
      findings: [
        {
          catalogId: "catalog-platform-test-001",
          field: "ownerNote",
          category: "ERROR",
          persistenceDisposition: "RAW_ONLY",
          applyBlocker: "DEFERRED_FIELD_NOT_PRESERVED",
          approvable: false,
          requiresFieldApproval: false,
          operation: "SET",
          message: "ownerNote cannot be silently discarded by apply",
        },
      ],
    });

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-owner-note-update"),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("Import dry-run is not apply-ready");
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("surfaces CLEAR and requires its exact field approval", async () => {
    await writeBundle({ alias: false });
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:03.000Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "p5-clear-seed"),
    );
    await writeBundle({
      catalogId: "catalog-platform-test-001",
      description: "",
      descriptionState: "CLEAR",
      alias: false,
    });
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:04.000Z",
    );
    expect(dryRun.findings).toEqual([
      expect.objectContaining({
        field: "description",
        operation: "CLEAR",
        requiresFieldApproval: true,
      }),
    ]);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-clear-unapproved"),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("required field-level finding");
    const clearFinding = String(dryRun.findings[0]?.findingId);
    await applyCatalogImport(pool, {
      ...applyInput(parsed, dryRun, "p5-clear-approved"),
      authorization: SYNTHETIC_AUTHORIZATION(
        dryRun,
        [clearFinding],
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    await expect(
      pool.query("SELECT description, description_state FROM catalog_entries"),
    ).resolves.toMatchObject({
      rows: [{ description: null, description_state: "CLEAR" }],
    });
  });

  it("rejects envelope, dry-run, and approval tampering before allocation", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.000Z",
    );
    let allocations = 0;
    const allocator: CatalogIdAllocator = {
      allocateCatalogId: () => {
        allocations += 1;
        return "catalog-never-allocated";
      },
    };
    const tampered = {
      ...parsed,
      envelope: {
        ...parsed.envelope,
        catalogRows: parsed.envelope.catalogRows.map((row) => ({
          ...row,
          title: "篡改标题",
        })),
      },
    };
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(tampered, dryRun, "p5-tampered-envelope"),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("metadata does not match its envelope");
    expect(allocations).toBe(0);

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          parsed,
          {
            ...dryRun,
            resultCounts: {
              ...dryRun.resultCounts,
              add: 0,
              unchanged: 1,
            },
          },
          "p5-tampered-dry-run",
        ),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("dry-run result hash is invalid");
    expect(allocations).toBe(0);

    const stateTampered = {
      ...parsed,
      envelope: {
        ...parsed.envelope,
        catalogRows: parsed.envelope.catalogRows.map((row) => ({
          ...row,
          dynasty: { state: "UNKNOWN" as const },
        })),
      },
    };
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(stateTampered, dryRun, "p5-tampered-state"),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("metadata does not match its envelope");
    expect(allocations).toBe(0);

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-tampered-approval"),
        authorization: {
          ...SYNTHETIC_AUTHORIZATION(dryRun),
          approval: {
            ...SYNTHETIC_AUTHORIZATION(dryRun).approval,
            canonicalInputSha256:
              "0000000000000000000000000000000000000000000000000000000000000000",
          },
        } as CatalogImportAuthorization,
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("does not bind");
    expect(allocations).toBe(0);

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-validation-in-production"),
        authorization: {
          ...SYNTHETIC_AUTHORIZATION(dryRun),
          runtime: "PRODUCTION",
        } as unknown as CatalogImportAuthorization,
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("Validation-only authorization is not accepted");
    expect(allocations).toBe(0);
  });

  it("rejects stale dry-runs and operation IDs reused with different hashes", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.050Z",
    );
    await pool.query(
      "INSERT INTO catalog_entries(catalog_id, kind, title) VALUES ($1, $2, $3)",
      ["catalog-concurrent", "inscription", "测试碑刻"],
    );
    await expect(
      applyCatalogImport(pool, applyInput(parsed, dryRun, "p5-stale-dry-run")),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT COUNT(*)::integer AS count FROM catalog_import_operations",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await pool.query("TRUNCATE catalog_entries CASCADE");
    const freshDryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.060Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(parsed, freshDryRun, "p5-operation-reuse"),
    );
    await writeBundle({ title: "测试碑刻修订" });
    const changed = await parseCatalogImportCsvBundle(bundleDirectory);
    const changedDryRun = await createCatalogImportDryRun(
      pool,
      changed,
      "2026-08-15T00:00:05.070Z",
    );
    const beforeReuse = await readImporterDatabaseState();
    await expect(
      applyCatalogImport(
        pool,
        applyInput(changed, changedDryRun, "p5-operation-reuse"),
      ),
    ).rejects.toThrow("operation identity was reused with different hashes");
    await expect(readImporterDatabaseState()).resolves.toEqual(beforeReuse);
  });

  it("rejects scalar factual VALUE tampering before allocation or mutation", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.100Z",
    );
    const before = await readImporterDatabaseState();
    let allocations = 0;
    const allocator: CatalogIdAllocator = {
      allocateCatalogId: () => {
        allocations += 1;
        return "catalog-never-allocated";
      },
    };
    const factualValueTampered = {
      ...parsed,
      envelope: {
        ...parsed.envelope,
        catalogRows: parsed.envelope.catalogRows.map((row) => ({
          ...row,
          description: {
            state: "VALUE" as const,
            value: "篡改后的事实值",
          },
        })),
      },
    };

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          factualValueTampered,
          dryRun,
          "p5-tampered-factual-value",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun, [], "PRODUCTION"),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("metadata does not match its envelope");
    expect(allocations).toBe(0);
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("rejects a standalone canonical input hash mismatch before allocation or mutation", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.200Z",
    );
    const before = await readImporterDatabaseState();
    let allocations = 0;
    const allocator: CatalogIdAllocator = {
      allocateCatalogId: () => {
        allocations += 1;
        return "catalog-never-allocated";
      },
    };
    const canonicalHashMismatched = {
      ...parsed,
      canonicalInputSha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          canonicalHashMismatched,
          dryRun,
          "p5-canonical-hash-mismatch",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun, [], "PRODUCTION"),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("metadata does not match its envelope");
    expect(allocations).toBe(0);
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("rejects an unknown finding approval before allocation or mutation", async () => {
    await writeBundle({ alias: false });
    const seed = await parseCatalogImportCsvBundle(bundleDirectory);
    const seedDryRun = await createCatalogImportDryRun(
      pool,
      seed,
      "2026-08-15T00:00:05.300Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(seed, seedDryRun, "p5-unknown-finding-seed"),
    );
    await writeBundle({
      catalogId: "catalog-platform-test-001",
      description: "",
      descriptionState: "CLEAR",
      alias: false,
    });
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:05.400Z",
    );
    const legitimateFinding = String(dryRun.findings[0]?.findingId);
    const unknownFinding = "finding-well-formed-but-absent";
    expect(dryRun.findings).toEqual([
      expect.objectContaining({
        findingId: legitimateFinding,
        operation: "CLEAR",
        requiresFieldApproval: true,
      }),
    ]);
    const before = await readImporterDatabaseState();
    let allocations = 0;
    const allocator: CatalogIdAllocator = {
      allocateCatalogId: () => {
        allocations += 1;
        return "catalog-never-allocated";
      },
    };

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "p5-unknown-finding-approval"),
        authorization: SYNTHETIC_AUTHORIZATION(
          dryRun,
          [legitimateFinding, unknownFinding],
          "PRODUCTION",
        ),
        catalogIdAllocator: allocator,
      }),
    ).rejects.toThrow("unknown or non-approvable finding");
    expect(allocations).toBe(0);
    await expect(readImporterDatabaseState()).resolves.toEqual(before);
  });

  it("rejects malformed CSV and unsupported kinds before dry-run", async () => {
    await writeFile(
      path.join(bundleDirectory, "catalog.csv"),
      `${catalogHeaders}\nitem-000001,src_test_p5_001,,测试碑刻,unsupported-kind,,,,,,,,,,,,,,,,,\n`,
    );
    await expect(
      parseCatalogImportCsvBundle(bundleDirectory),
    ).rejects.toThrow();

    await writeFile(
      path.join(bundleDirectory, "catalog.csv"),
      `${catalogHeaders}\n"unterminated\n`,
    );
    await expect(parseCatalogImportCsvBundle(bundleDirectory)).rejects.toThrow(
      "Unterminated quoted CSV field",
    );
  });

  it("fails closed on an existing SourceId rebound", async () => {
    const parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const dryRun = await createCatalogImportDryRun(
      pool,
      parsed,
      "2026-08-15T00:00:06.000Z",
    );
    await applyCatalogImport(
      pool,
      applyInput(parsed, dryRun, "p5-conflict-seed"),
    );
    await writeBundle({ catalogId: "catalog-other", alias: false });
    const conflictParsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const conflictDryRun = await createCatalogImportDryRun(
      pool,
      conflictParsed,
      "2026-08-15T00:00:07.000Z",
    );
    expect(conflictDryRun).toMatchObject({
      state: "FAILED",
      applyReady: false,
      resultCounts: { identityConflict: 1 },
      applyBlockers: ["IDENTITY_CONFLICT"],
    });
  });

  it.runIf(process.env.P5_RESEARCH_EXPORT_DIR !== undefined)(
    "applies, replays, and reads back the actual 28-record Research bundle",
    async () => {
      const actual = await parseCatalogImportCsvBundle(
        process.env.P5_RESEARCH_EXPORT_DIR!,
      );
      const dryRun = await createCatalogImportDryRun(
        pool,
        actual,
        "2026-08-15T00:00:08.000Z",
      );
      expect(actual.canonicalInputSha256).toBe(
        "adb139588625a9447aadfa242efbd1bfd35de00befa99338ba265b7a9511d3ed",
      );
      expect(dryRun).toMatchObject({
        state: "PASSED",
        applyReady: true,
        findings: [],
        resultCounts: {
          add: 28,
          update: 0,
          unchanged: 0,
          conflict: 0,
          error: 0,
        },
      });
      const result = await applyCatalogImport(pool, {
        ...applyInput(actual, dryRun, "p5-actual-28"),
        catalogIdAllocator: {
          allocateCatalogId: ({ catalogImportId }) =>
            catalogIdSchema.parse(`catalog-platform-${catalogImportId}`),
        },
      });
      const replay = await applyCatalogImport(pool, {
        ...applyInput(actual, dryRun, "p5-actual-28"),
        catalogIdAllocator: {
          allocateCatalogId: ({ catalogImportId }) =>
            catalogIdSchema.parse(`catalog-platform-${catalogImportId}`),
        },
      });
      expect(result).toMatchObject({ status: "APPLIED", created: 28 });
      expect(replay).toMatchObject({ status: "ALREADY_APPLIED", created: 28 });

      const prepared = await prepareProductionBackend({
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
        PRODUCT_ACCESS_MODE: "public",
      });
      const backend = await startBackendProcess({
        closeResources: prepared.closeResources,
        listen: { host: "127.0.0.1", port: 0 },
        requestListener: prepared.requestListener,
      });
      try {
        const baseUrl = `http://${backend.address.address}:${backend.address.port}`;
        const health = await fetch(`${baseUrl}/health`);
        const pageResponse = await fetch(
          `${baseUrl}/v1/catalog?page=1&pageSize=100`,
        );
        const page = (await pageResponse.json()) as {
          readonly items: readonly { readonly id: string }[];
          readonly total: number;
        };
        expect(health.status).toBe(200);
        expect(pageResponse.status).toBe(200);
        expect(page.total).toBe(28);
        expect(page.items).toHaveLength(28);
        for (const mapping of result.catalogIdMap) {
          const detail = await fetch(
            `${baseUrl}/v1/catalog/${mapping.catalogId}`,
          );
          expect(detail.status).toBe(200);
          const actualDetail = (await detail.json()) as {
            id: string;
            title: string;
            kind: string;
          };
          const expected = actual.envelope.catalogRows.find(
            ({ catalogImportId }) =>
              String(catalogImportId) === mapping.catalogImportId,
          );
          expect(expected).toBeDefined();
          expect(actualDetail).toMatchObject({
            id: mapping.catalogId,
            title: expected!.title,
            kind: expected!.catalogKind,
          });
        }
      } finally {
        await backend.shutdown();
      }
    },
  );
});

describe.sequential("catalog-import/v2 PostgreSQL apply", () => {
  it("keeps the first five migrations and widens only the sixth operation-version constraint", async () => {
    expect(requiredMigrations.slice(0, 6)).toHaveLength(6);
    expect(requiredMigrations[5]).toMatchObject({
      migrationId: "20260903193318",
      filename: "20260903193318_catalog_import_v2.sql",
    });
    const ledger = await pool.query(
      `SELECT migration_id, filename, checksum
       FROM schema_migrations ORDER BY migration_id`,
    );
    expect(ledger.rows).toEqual(
      requiredMigrations.map(({ migrationId, filename, checksum }) => ({
        migration_id: migrationId,
        filename,
        checksum,
      })),
    );
    const constraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'catalog_import_operations'::regclass
         AND conname = 'catalog_import_operations_contract_valid'`,
    );
    expect(constraint.rows).toHaveLength(1);
    const definition = String(constraint.rows[0]?.definition);
    expect(definition).toContain("catalog-import/v1");
    expect(definition).toContain("catalog-import/v2");
    expect(definition).not.toContain("catalog-import/v3");

    const insertOperation = (
      operationId: string,
      version: string,
      digit: string,
    ) =>
      pool.query(
        `INSERT INTO catalog_import_operations(
           operation_id, import_contract_version, canonical_input_sha256,
           dry_run_result_sha256, approval_sha256, validation_context,
           status, result_json, created_at, applied_at
         ) VALUES ($1,$2,$3,$3,$3,'{}'::jsonb,'APPLYING',NULL,NOW(),NULL)`,
        [operationId, version, digit.repeat(64)],
      );
    await insertOperation("constraint-v1", "catalog-import/v1", "1");
    await insertOperation("constraint-v2", "catalog-import/v2", "2");
    await expect(
      insertOperation("constraint-v3", "catalog-import/v3", "3"),
    ).rejects.toMatchObject({ code: "23514" });
    const operationVersions = async () =>
      (
        await pool.query(
          `SELECT operation_id, import_contract_version
           FROM catalog_import_operations ORDER BY operation_id`,
        )
      ).rows;
    const beforeMigrationReplay = await operationVersions();
    expect(beforeMigrationReplay).toEqual([
      {
        operation_id: "constraint-v1",
        import_contract_version: "catalog-import/v1",
      },
      {
        operation_id: "constraint-v2",
        import_contract_version: "catalog-import/v2",
      },
    ]);
    expect(await runMigrations(pool, migrationsDirectory)).toEqual([]);
    await expect(operationVersions()).resolves.toEqual(beforeMigrationReplay);
  });

  it("runs V2 recomputation and writes at serializable isolation", async () => {
    await pool.query(`
      CREATE FUNCTION assert_v2_catalog_import_serializable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.import_contract_version = 'catalog-import/v2'
           AND current_setting('transaction_isolation') <> 'serializable' THEN
          RAISE EXCEPTION 'catalog-import/v2 apply must be serializable';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER assert_v2_catalog_import_serializable
      BEFORE INSERT ON catalog_import_operations
      FOR EACH ROW
      EXECUTE FUNCTION assert_v2_catalog_import_serializable()
    `);
    try {
      const parsed = buildV2ParsedBundle({
        contributorsAction: "PRESERVE",
        publicCitationsAction: "PRESERVE",
      });
      const dryRun = await createV2DryRun(parsed, "2026-09-03T20:00:10.000Z");
      await expect(
        applyCatalogImport(pool, {
          ...applyInput(parsed, dryRun, "v2-serializable-apply"),
          catalogIdAllocator: fakeAllocator(v2CatalogId),
        }),
      ).resolves.toMatchObject({
        status: "APPLIED",
        created: 1,
        updated: 0,
        unchanged: 0,
      });
    } finally {
      await pool.query(
        "DROP TRIGGER assert_v2_catalog_import_serializable ON catalog_import_operations",
      );
      await pool.query("DROP FUNCTION assert_v2_catalog_import_serializable()");
    }
  });

  it("fails concurrent V2 overwrites and duplicate-title creates closed", async () => {
    type ApplyPool = Parameters<typeof applyCatalogImport>[0];
    type ApplyResult = Awaited<ReturnType<typeof applyCatalogImport>>;

    const runAtOperationInsertBarrier = async (
      left: (barrierPool: ApplyPool) => Promise<ApplyResult>,
      right: (barrierPool: ApplyPool) => Promise<ApplyResult>,
    ) => {
      let arrivals = 0;
      let resolveAllArrived!: () => void;
      const allArrived = new Promise<void>((resolve) => {
        resolveAllArrived = resolve;
      });
      let releaseBarrier!: () => void;
      const barrierReleased = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const barrierPool = {
        connect: async () => {
          const client = await pool.connect();
          let waited = false;
          return {
            query: async (text: string, values?: unknown[]) => {
              if (
                !waited &&
                text.includes("INSERT INTO catalog_import_operations(")
              ) {
                waited = true;
                arrivals += 1;
                if (arrivals === 2) resolveAllArrived();
                await barrierReleased;
              }
              return values === undefined
                ? client.query(text)
                : client.query(text, values);
            },
            release: () => client.release(),
          };
        },
      } as unknown as ApplyPool;
      const attempts = [left(barrierPool), right(barrierPool)] as const;
      const prematureSettlement = new Promise<never>((_resolve, reject) => {
        for (const [index, attempt] of attempts.entries()) {
          void attempt.then(
            () =>
              reject(
                new Error(
                  `Concurrent V2 apply ${index} settled before both plans reached the write barrier`,
                ),
              ),
            reject,
          );
        }
      });
      let barrierError: unknown;
      try {
        await Promise.race([allArrived, prematureSettlement]);
        expect(arrivals).toBe(2);
      } catch (error) {
        barrierError = error;
      } finally {
        releaseBarrier();
      }
      const outcomes = await Promise.allSettled(attempts);
      if (barrierError !== undefined) throw barrierError;
      return outcomes;
    };

    const expectOneSerializableWinner = (
      outcomes: readonly PromiseSettledResult<ApplyResult>[],
    ) => {
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<ApplyResult> =>
          outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "40001" });
      const winner = fulfilled[0];
      if (winner === undefined) {
        throw new Error("Expected one concurrent V2 apply to commit");
      }
      return winner.value;
    };

    await seedV2Catalog("v2-concurrent-update-seed");
    const updatePlans = [
      {
        operationId: "v2-concurrent-update-a",
        transcription: "并发更新 A",
      },
      {
        operationId: "v2-concurrent-update-b",
        transcription: "并发更新 B",
      },
    ] as const;
    const preparedUpdates = await Promise.all(
      updatePlans.map(async ({ operationId, transcription }, index) => {
        const parsed = buildV2ParsedBundle({
          catalogId: v2CatalogId,
          contributorsAction: "PRESERVE",
          publicCitationsAction: "PRESERVE",
          scalarFields: {
            transcription: { state: "VALUE", value: transcription },
          },
        });
        const dryRun = await createV2DryRun(
          parsed,
          `2026-09-03T20:00:2${index}.000Z`,
        );
        expect(dryRun.findings).toEqual([
          expect.objectContaining({
            field: "transcription",
            operation: "SET",
            requiresFieldApproval: true,
          }),
        ]);
        return { operationId, transcription, parsed, dryRun };
      }),
    );
    const updateAttempts = preparedUpdates.map(
      ({ operationId, parsed, dryRun }) =>
        (barrierPool: ApplyPool) =>
          applyCatalogImport(barrierPool, {
            ...applyInput(parsed, dryRun, operationId),
            authorization: SYNTHETIC_AUTHORIZATION(
              dryRun,
              [String(dryRun.findings[0]?.findingId)],
              "PRODUCTION",
            ),
            catalogIdAllocator: undefined,
          }),
    );
    const leftUpdateAttempt = updateAttempts[0];
    const rightUpdateAttempt = updateAttempts[1];
    if (leftUpdateAttempt === undefined || rightUpdateAttempt === undefined) {
      throw new Error("Expected exactly two concurrent V2 update plans");
    }
    const updateOutcomes = await runAtOperationInsertBarrier(
      leftUpdateAttempt,
      rightUpdateAttempt,
    );
    const updateWinner = expectOneSerializableWinner(updateOutcomes);
    const expectedTranscription = preparedUpdates.find(
      ({ operationId }) => operationId === updateWinner.operationId,
    )?.transcription;
    expect(expectedTranscription).toBeDefined();
    await expect(
      pool.query(
        "SELECT transcription FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [{ transcription: expectedTranscription }],
    });
    await expect(
      pool.query(
        `SELECT operation_id FROM catalog_import_operations
          WHERE operation_id = ANY($1::text[]) ORDER BY operation_id`,
        [updatePlans.map(({ operationId }) => operationId)],
      ),
    ).resolves.toMatchObject({
      rows: [{ operation_id: updateWinner.operationId }],
    });

    await pool.query(
      "TRUNCATE catalog_import_operations, catalog_entries CASCADE",
    );
    const duplicateTitle = "并发同名目录";
    const createPlans = [
      {
        operationId: "v2-concurrent-create-a",
        catalogImportId: "v2-concurrent-item-a",
        sourceId: "v2-concurrent-source-a",
        catalogId: "v2-concurrent-catalog-a",
      },
      {
        operationId: "v2-concurrent-create-b",
        catalogImportId: "v2-concurrent-item-b",
        sourceId: "v2-concurrent-source-b",
        catalogId: "v2-concurrent-catalog-b",
      },
    ] as const;
    const preparedCreates = await Promise.all(
      createPlans.map(async (plan, index) => {
        const parsed = buildV2ParsedBundle({
          catalogImportId: plan.catalogImportId,
          sourceId: plan.sourceId,
          title: duplicateTitle,
          contributorsAction: "PRESERVE",
          publicCitationsAction: "PRESERVE",
        });
        const dryRun = await createV2DryRun(
          parsed,
          `2026-09-03T20:00:4${index}.000Z`,
        );
        expect(dryRun).toMatchObject({
          state: "PASSED",
          findings: [],
          duplicateCandidates: [],
          applyReady: true,
        });
        return { ...plan, parsed, dryRun };
      }),
    );
    const createAttempts = preparedCreates.map(
      ({ operationId, catalogId, parsed, dryRun }) =>
        (barrierPool: ApplyPool) =>
          applyCatalogImport(barrierPool, {
            ...applyInput(parsed, dryRun, operationId),
            catalogIdAllocator: fakeAllocator(catalogId),
          }),
    );
    const leftCreateAttempt = createAttempts[0];
    const rightCreateAttempt = createAttempts[1];
    if (leftCreateAttempt === undefined || rightCreateAttempt === undefined) {
      throw new Error("Expected exactly two concurrent V2 create plans");
    }
    const createOutcomes = await runAtOperationInsertBarrier(
      leftCreateAttempt,
      rightCreateAttempt,
    );
    const createWinner = expectOneSerializableWinner(createOutcomes);
    const winningCreate = preparedCreates.find(
      ({ operationId }) => operationId === createWinner.operationId,
    );
    expect(winningCreate).toBeDefined();
    await expect(
      pool.query(
        `SELECT catalog_id, title FROM catalog_entries
          WHERE title=$1 ORDER BY catalog_id`,
        [duplicateTitle],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          catalog_id: winningCreate?.catalogId,
          title: duplicateTitle,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT source_id, catalog_id FROM catalog_import_sources
          ORDER BY source_id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          source_id: winningCreate?.sourceId,
          catalog_id: winningCreate?.catalogId,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT operation_id FROM catalog_import_operations
          WHERE operation_id = ANY($1::text[]) ORDER BY operation_id`,
        [createPlans.map(({ operationId }) => operationId)],
      ),
    ).resolves.toMatchObject({
      rows: [{ operation_id: createWinner.operationId }],
    });
  });

  it("rejects oversized child positions before dry-run or apply mutation", async () => {
    const valid = buildV2ParsedBundle();
    const validDryRun = await createV2DryRun(valid, "2026-09-03T20:00:30.000Z");
    const oversized = [
      {
        ...valid,
        envelope: {
          ...valid.envelope,
          contributorRows: valid.envelope.contributorRows.map((row, index) =>
            index === 0 ? { ...row, position: 2_147_483_648 } : row,
          ),
        },
      },
      {
        ...valid,
        envelope: {
          ...valid.envelope,
          publicCitationRows: valid.envelope.publicCitationRows.map(
            (row, index) =>
              index === 0 ? { ...row, position: 2_147_483_648 } : row,
          ),
        },
      },
    ] as unknown as readonly ParsedCatalogImportV2Bundle[];

    for (const [index, parsed] of oversized.entries()) {
      await expect(
        createV2DryRun(parsed, `2026-09-03T20:00:3${index + 1}.000Z`),
      ).rejects.toThrow(/2147483647/);
      await expect(
        applyCatalogImport(pool, {
          ...applyInput(parsed, validDryRun, `v2-oversized-position-${index}`),
          catalogIdAllocator: fakeAllocator(v2CatalogId),
        }),
      ).rejects.toThrow(/2147483647/);
    }

    await expect(
      pool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM catalog_entries) AS entries,
           (SELECT COUNT(*)::integer FROM catalog_import_operations) AS operations,
           (SELECT COUNT(*)::integer FROM catalog_contributors) AS contributors,
           (SELECT COUNT(*)::integer FROM catalog_source_citations) AS citations`,
      ),
    ).resolves.toMatchObject({
      rows: [{ entries: 0, operations: 0, contributors: 0, citations: 0 }],
    });
  });

  it("creates the full V2 content graph and exposes only the approved Detail projection", async () => {
    const parsed = buildV2ParsedBundle({
      scalarFields: {
        summary: "用于目录列表的公开摘要",
        periodLabel: "唐贞观十年（636）",
      },
      contributorRows: [
        defaultV2Contributors[1],
        { ...defaultV2Contributors[0], position: 2_147_483_647 },
      ],
      publicCitationRows: [
        defaultV2Citations[0],
        { ...defaultV2Citations[1], position: 2_147_483_647 },
      ],
    });
    expect(
      parsed.envelope.contributorRows.map(({ position }) => position),
    ).toEqual([0, 2_147_483_647]);
    expect(
      parsed.envelope.publicCitationRows.map(({ position }) => position),
    ).toEqual([0, 2_147_483_647]);
    const dryRun = await createV2DryRun(parsed, "2026-09-03T20:01:00.000Z");
    expect(dryRun).toMatchObject({
      importContractVersion: "catalog-import/v2",
      state: "PASSED",
      applyReady: true,
      rowCounts: {
        catalog: 1,
        aliases: 0,
        provenance: 1,
        contributors: 2,
        publicCitations: 2,
      },
      resultCounts: {
        add: 1,
        update: 0,
        unchanged: 0,
        conflict: 0,
        error: 0,
      },
      findings: [],
    });
    const result = await applyCatalogImport(pool, {
      ...applyInput(parsed, dryRun, "v2-full-create"),
      catalogIdAllocator: fakeAllocator(v2CatalogId),
    });
    expect(result).toMatchObject({
      status: "APPLIED",
      created: 1,
      updated: 0,
      unchanged: 0,
      catalogIdMap: [
        {
          catalogImportId: "v2-item-000001",
          sourceId: "src_test_v2_001",
          catalogId: v2CatalogId,
        },
      ],
    });

    const entry = await pool.query(
      `SELECT catalog_id, kind, title, summary, period_label,
              dynasty, dynasty_state, description, description_state,
              script_style, script_style_state,
              transcription, transcription_state,
              historical_context, historical_context_state,
              scholarly_research, scholarly_research_state
       FROM catalog_entries`,
    );
    expect(entry.rows).toEqual([
      {
        catalog_id: v2CatalogId,
        kind: "inscription",
        title: "V2 测试碑刻",
        summary: "用于目录列表的公开摘要",
        period_label: "唐贞观十年（636）",
        dynasty: "唐",
        dynasty_state: "VALUE",
        description: "V2 测试说明",
        description_state: "VALUE",
        script_style: "碑额篆书，正文楷书",
        script_style_state: "VALUE",
        transcription: "第一行释文\n第二行释文",
        transcription_state: "VALUE",
        historical_context: "第一段历史背景\n第二段历史背景",
        historical_context_state: "VALUE",
        scholarly_research: "第一段学术研究\n第二段学术研究",
        scholarly_research_state: "VALUE",
      },
    ]);
    expect((await readContributorRows()).map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        position: 0,
        name: "魏徵",
        role: "textAuthor",
      },
      {
        catalog_id: v2CatalogId,
        position: 2_147_483_647,
        name: "欧阳询",
        role: "calligrapher",
      },
    ]);
    const citationState = await readCitationRows();
    expect(citationState.citations.map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        position: 0,
        label: "未限定公开来源",
        citation: "未限定记录级引文",
        url: "https://example.invalid/public/record",
      },
      {
        catalog_id: v2CatalogId,
        position: 2_147_483_647,
        label: "内容公开来源",
        citation: "内容字段引文",
        url: "https://example.invalid/public/content",
      },
    ]);
    expect(citationState.scopes.map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        citation_position: 2_147_483_647,
        scope: "record",
      },
      {
        catalog_id: v2CatalogId,
        citation_position: 2_147_483_647,
        scope: "transcription",
      },
      {
        catalog_id: v2CatalogId,
        citation_position: 2_147_483_647,
        scope: "scholarlyResearch",
      },
    ]);
    await expect(
      pool.query(
        `SELECT source_id, catalog_id, source_title, source_type_raw, source_url
         FROM catalog_import_sources`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          source_id: "src_test_v2_001",
          catalog_id: v2CatalogId,
          source_title: "V2 测试碑刻来源",
          source_type_raw: "official-test",
          source_url: "https://example.invalid/raw-source",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT operation_id, import_contract_version
         FROM catalog_import_operations`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_id: "v2-full-create",
          import_contract_version: "catalog-import/v2",
        },
      ],
    });

    const prepared = await prepareProductionBackend({
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
      PRODUCT_ACCESS_MODE: "public",
    });
    const backend = await startBackendProcess({
      closeResources: prepared.closeResources,
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: prepared.requestListener,
    });
    try {
      const baseUrl = `http://${backend.address.address}:${backend.address.port}`;
      const detailResponse = await fetch(
        `${baseUrl}/v1/catalog/${v2CatalogId}`,
      );
      const listResponse = await fetch(`${baseUrl}/v1/catalog`);
      expect(detailResponse.status).toBe(200);
      expect(listResponse.status).toBe(200);
      const detail = catalogDetailSchema.parse(await detailResponse.json());
      const list = catalogPageSchema.parse(await listResponse.json());
      expect(detail).toEqual({
        id: v2CatalogId,
        kind: "inscription",
        title: "V2 测试碑刻",
        aliases: [],
        summary: "用于目录列表的公开摘要",
        periodLabel: "唐贞观十年（636）",
        dynasty: "唐",
        contributors: [
          { name: "魏徵", role: "textAuthor" },
          { name: "欧阳询", role: "calligrapher" },
        ],
        scriptStyle: "碑额篆书，正文楷书",
        description: "V2 测试说明",
        transcription: "第一行释文\n第二行释文",
        historicalContext: "第一段历史背景\n第二段历史背景",
        scholarlyResearch: "第一段学术研究\n第二段学术研究",
        sourceCitations: [
          {
            label: "未限定公开来源",
            citation: "未限定记录级引文",
            url: "https://example.invalid/public/record",
          },
          {
            label: "内容公开来源",
            citation: "内容字段引文",
            url: "https://example.invalid/public/content",
            appliesTo: ["record", "transcription", "scholarlyResearch"],
          },
        ],
        media: [],
      });
      expect(list).toEqual({
        items: [
          {
            id: v2CatalogId,
            kind: "inscription",
            title: "V2 测试碑刻",
            aliases: [],
            summary: "用于目录列表的公开摘要",
            periodLabel: "唐贞观十年（636）",
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      });
      for (const privateTerm of [
        "catalogImportId",
        "sourceId",
        "sourceTypeRaw",
        "position",
        "script_style_state",
        "transcription_state",
        "historical_context_state",
        "scholarly_research_state",
      ]) {
        expect(JSON.stringify(detail)).not.toContain(privateTerm);
        expect(JSON.stringify(list)).not.toContain(privateTerm);
      }
      for (const detailOnlyField of [
        "contributors",
        "scriptStyle",
        "description",
        "transcription",
        "historicalContext",
        "scholarlyResearch",
        "sourceCitations",
      ]) {
        expect(list.items[0]).not.toHaveProperty(detailOnlyField);
      }
    } finally {
      await backend.shutdown();
    }
  });

  it("stores omitted V2 display fields as NULL on create", async () => {
    const parsed = buildV2ParsedBundle();
    const dryRun = await createV2DryRun(parsed, "2026-09-03T20:01:05.000Z");
    await applyCatalogImport(pool, {
      ...applyInput(parsed, dryRun, "v2-display-omitted-create"),
      catalogIdAllocator: fakeAllocator(v2CatalogId),
    });
    await expect(
      pool.query(
        "SELECT summary, period_label FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [{ summary: null, period_label: null }],
    });
  });

  it("preserves, classifies, stale-checks, rolls back, and replays V2 display fields", async () => {
    const initialSummary = "初始公开摘要";
    const initialPeriodLabel = "唐代（初始标签）";
    const seed = buildV2ParsedBundle({
      scalarFields: {
        summary: initialSummary,
        periodLabel: initialPeriodLabel,
      },
    });
    const seedDryRun = await createV2DryRun(seed, "2026-09-03T20:01:10.000Z");
    await applyCatalogImport(pool, {
      ...applyInput(seed, seedDryRun, "v2-display-seed"),
      catalogIdAllocator: fakeAllocator(v2CatalogId),
    });

    const omitted = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const omittedDryRun = await createV2DryRun(
      omitted,
      "2026-09-03T20:01:11.000Z",
    );
    expect(omittedDryRun).toMatchObject({
      findings: [],
      resultCounts: { update: 0, unchanged: 1 },
    });
    await applyCatalogImport(
      pool,
      applyInput(omitted, omittedDryRun, "v2-display-omitted"),
    );
    await expect(
      pool.query(
        "SELECT summary, period_label FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [{ summary: initialSummary, period_label: initialPeriodLabel }],
    });

    const identical = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      scalarFields: {
        summary: initialSummary,
        periodLabel: initialPeriodLabel,
      },
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const identicalDryRun = await createV2DryRun(
      identical,
      "2026-09-03T20:01:12.000Z",
    );
    expect(identicalDryRun).toMatchObject({
      findings: [],
      resultCounts: { update: 0, unchanged: 1 },
    });

    const summaryOnly = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      scalarFields: { summary: "无需字段级批准的摘要修订" },
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const summaryDryRun = await createV2DryRun(
      summaryOnly,
      "2026-09-03T20:01:13.000Z",
    );
    expect(summaryDryRun.findings).toEqual([
      expect.objectContaining({
        field: "summary",
        category: "ORDINARY_CHANGE",
        protectionLevel: "LEVEL_C",
        operation: "SET",
        requiresFieldApproval: false,
      }),
    ]);
    await applyCatalogImport(pool, {
      ...applyInput(summaryOnly, summaryDryRun, "v2-display-summary"),
      authorization: SYNTHETIC_AUTHORIZATION(summaryDryRun, [], "PRODUCTION"),
      catalogIdAllocator: undefined,
    });

    const changed = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      scalarFields: {
        summary: "最终公开摘要",
        periodLabel: "唐贞观十年（636）",
      },
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const staleDryRun = await createV2DryRun(
      changed,
      "2026-09-03T20:01:14.000Z",
    );
    expect(staleDryRun.findings).toEqual([
      expect.objectContaining({
        field: "summary",
        category: "ORDINARY_CHANGE",
        protectionLevel: "LEVEL_C",
        requiresFieldApproval: false,
      }),
      expect.objectContaining({
        field: "periodLabel",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        requiresFieldApproval: true,
      }),
    ]);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, staleDryRun, "v2-display-unapproved"),
        authorization: SYNTHETIC_AUTHORIZATION(staleDryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("required field-level finding");
    await expect(
      pool.query(
        "SELECT summary, period_label FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          summary: "无需字段级批准的摘要修订",
          period_label: initialPeriodLabel,
        },
      ],
    });

    await pool.query(
      `UPDATE catalog_entries
          SET summary=$2, period_label=$3
        WHERE catalog_id=$1`,
      [v2CatalogId, "并发摘要", "并发年代标签"],
    );
    const recomputed = await createV2DryRun(changed, staleDryRun.completedAt);
    for (const field of ["summary", "periodLabel"] as const) {
      expect(
        recomputed.findings.find((finding) => finding.field === field)
          ?.findingId,
      ).not.toBe(
        staleDryRun.findings.find((finding) => finding.field === field)
          ?.findingId,
      );
    }
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, staleDryRun, "v2-display-stale"),
        authorization: SYNTHETIC_AUTHORIZATION(
          staleDryRun,
          staleDryRun.findings
            .filter(({ requiresFieldApproval }) => requiresFieldApproval)
            .map(({ findingId }) => String(findingId)),
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT summary, period_label FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [{ summary: "并发摘要", period_label: "并发年代标签" }],
    });

    await pool.query(
      `UPDATE catalog_entries
          SET summary=$2, period_label=$3
        WHERE catalog_id=$1`,
      [v2CatalogId, "无需字段级批准的摘要修订", initialPeriodLabel],
    );
    const dryRun = await createV2DryRun(changed, "2026-09-03T20:01:15.000Z");
    const approvedFindingIds = dryRun.findings
      .filter(({ requiresFieldApproval }) => requiresFieldApproval)
      .map(({ findingId }) => String(findingId));
    const approvedInput = {
      ...applyInput(changed, dryRun, "v2-display-approved"),
      authorization: SYNTHETIC_AUTHORIZATION(
        dryRun,
        approvedFindingIds,
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    };
    await expect(
      applyCatalogImport(pool, {
        ...approvedInput,
        operationId: "v2-display-rollback",
        failureAfterCatalogRows: 1,
      }),
    ).rejects.toThrow("Synthetic mid-transaction failure");
    await expect(
      pool.query(
        "SELECT summary, period_label FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          summary: "无需字段级批准的摘要修订",
          period_label: initialPeriodLabel,
        },
      ],
    });
    await expect(
      pool.query(
        "SELECT operation_id FROM catalog_import_operations WHERE operation_id=$1",
        ["v2-display-rollback"],
      ),
    ).resolves.toMatchObject({ rows: [] });

    const applied = await applyCatalogImport(pool, approvedInput);
    const beforeReplay = await pool.query(
      `SELECT summary, period_label, xmin::text AS revision
         FROM catalog_entries WHERE catalog_id=$1`,
      [v2CatalogId],
    );
    const replay = await applyCatalogImport(pool, approvedInput);
    expect(applied).toMatchObject({ status: "APPLIED", updated: 1 });
    expect(replay).toMatchObject({ status: "ALREADY_APPLIED", updated: 1 });
    await expect(
      pool.query(
        `SELECT summary, period_label, xmin::text AS revision
           FROM catalog_entries WHERE catalog_id=$1`,
        [v2CatalogId],
      ),
    ).resolves.toEqual(beforeReplay);
    expect(beforeReplay.rows).toMatchObject([
      { summary: "最终公开摘要", period_label: "唐贞观十年（636）" },
    ]);
  });

  it("preserves UNSUPPLIED scalars and enforces VALUE/CLEAR protection levels", async () => {
    await seedV2Catalog("v2-scalar-seed");
    const parsed = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
      scalarFields: {
        scriptStyle: { state: "UNSUPPLIED" },
        transcription: {
          state: "VALUE",
          value: "修订第一行\n修订第二行",
        },
        historicalContext: {
          state: "VALUE",
          value: "修订后的历史背景",
        },
        scholarlyResearch: { state: "CLEAR" },
      },
    });
    const dryRun = await createV2DryRun(parsed, "2026-09-03T20:02:00.000Z");
    expect(dryRun.resultCounts).toMatchObject({ update: 1, unchanged: 0 });
    expect(dryRun.findings).toEqual([
      expect.objectContaining({
        field: "transcription",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        operation: "SET",
        requiresFieldApproval: true,
      }),
      expect.objectContaining({
        field: "historicalContext",
        category: "ORDINARY_CHANGE",
        protectionLevel: "LEVEL_C",
        operation: "SET",
        requiresFieldApproval: false,
      }),
      expect.objectContaining({
        field: "scholarlyResearch",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_C",
        operation: "CLEAR",
        requiresFieldApproval: true,
      }),
    ]);
    const before = await pool.query(
      `SELECT script_style, script_style_state, transcription,
              historical_context, scholarly_research, scholarly_research_state
       FROM catalog_entries`,
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "v2-scalar-unapproved"),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("required field-level finding");
    await expect(
      pool.query(
        `SELECT script_style, script_style_state, transcription,
                historical_context, scholarly_research, scholarly_research_state
         FROM catalog_entries`,
      ),
    ).resolves.toEqual(before);

    const requiredApprovals = dryRun.findings
      .filter(({ requiresFieldApproval }) => requiresFieldApproval)
      .map(({ findingId }) => String(findingId));
    await applyCatalogImport(pool, {
      ...applyInput(parsed, dryRun, "v2-scalar-approved"),
      authorization: SYNTHETIC_AUTHORIZATION(
        dryRun,
        requiredApprovals,
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    await expect(
      pool.query(
        `SELECT script_style, script_style_state, transcription,
                transcription_state, historical_context,
                historical_context_state, scholarly_research,
                scholarly_research_state
         FROM catalog_entries`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          script_style: "碑额篆书，正文楷书",
          script_style_state: "VALUE",
          transcription: "修订第一行\n修订第二行",
          transcription_state: "VALUE",
          historical_context: "修订后的历史背景",
          historical_context_state: "VALUE",
          scholarly_research: null,
          scholarly_research_state: "CLEAR",
        },
      ],
    });
  });

  it("binds approved V2 mutations to the existing scalar and collection state", async () => {
    await seedV2Catalog("v2-stale-state-seed");

    const scalarUpdate = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
      scalarFields: {
        transcription: {
          state: "VALUE",
          value: "Owner 批准的释文修订",
        },
      },
    });
    const scalarDryRun = await createV2DryRun(
      scalarUpdate,
      "2026-09-03T20:02:10.000Z",
    );
    expect(scalarDryRun.findings).toEqual([
      expect.objectContaining({ field: "transcription", operation: "SET" }),
    ]);
    await pool.query(
      `UPDATE catalog_entries
          SET transcription=$2, transcription_state='VALUE'
        WHERE catalog_id=$1`,
      [v2CatalogId, "dry-run 后写入的较新释文"],
    );
    const recomputedScalarDryRun = await createV2DryRun(
      scalarUpdate,
      scalarDryRun.completedAt,
    );
    expect(recomputedScalarDryRun.findings[0]?.findingId).not.toBe(
      scalarDryRun.findings[0]?.findingId,
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(scalarUpdate, scalarDryRun, "v2-stale-scalar-state"),
        authorization: SYNTHETIC_AUTHORIZATION(
          scalarDryRun,
          [String(scalarDryRun.findings[0]?.findingId)],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT transcription FROM catalog_entries WHERE catalog_id=$1",
        [v2CatalogId],
      ),
    ).resolves.toMatchObject({
      rows: [{ transcription: "dry-run 后写入的较新释文" }],
    });

    const contributorUpdate = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      scalarFields: { transcription: { state: "UNSUPPLIED" } },
      contributorsAction: "REPLACE",
      contributorRows: [
        { position: 0, name: "韩愈", role: "textAuthor" },
        { position: 4, name: "颜真卿", role: "calligrapher" },
      ],
      publicCitationsAction: "PRESERVE",
    });
    const contributorDryRun = await createV2DryRun(
      contributorUpdate,
      "2026-09-03T20:02:11.000Z",
    );
    expect(contributorDryRun.findings).toEqual([
      expect.objectContaining({ field: "contributors", operation: "SET" }),
    ]);
    await pool.query(
      `UPDATE catalog_contributors
          SET name=$3
        WHERE catalog_id=$1 AND position=$2`,
      [v2CatalogId, 0, "dry-run 后写入的较新作者"],
    );
    const recomputedContributorDryRun = await createV2DryRun(
      contributorUpdate,
      contributorDryRun.completedAt,
    );
    expect(recomputedContributorDryRun.findings[0]?.findingId).not.toBe(
      contributorDryRun.findings[0]?.findingId,
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          contributorUpdate,
          contributorDryRun,
          "v2-stale-contributor-state",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(
          contributorDryRun,
          [String(contributorDryRun.findings[0]?.findingId)],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        `SELECT name FROM catalog_contributors
          WHERE catalog_id=$1 AND position=$2`,
        [v2CatalogId, 0],
      ),
    ).resolves.toMatchObject({
      rows: [{ name: "dry-run 后写入的较新作者" }],
    });
    await expect(
      pool.query(
        `SELECT operation_id FROM catalog_import_operations
          WHERE operation_id = ANY($1::text[])`,
        [["v2-stale-scalar-state", "v2-stale-contributor-state"]],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("binds approved V2 provenance and citation mutations to their full existing state", async () => {
    await seedV2Catalog("v2-stale-related-state-seed");

    const citationUpdate = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "REPLACE",
      publicCitationRows: [
        defaultV2Citations[0],
        { ...defaultV2Citations[1], label: "Owner 批准的修订来源" },
      ],
    });
    const citationDryRun = await createV2DryRun(
      citationUpdate,
      "2026-09-03T20:02:20.000Z",
    );
    expect(citationDryRun.findings).toEqual([
      expect.objectContaining({ field: "publicCitations", operation: "SET" }),
    ]);
    await pool.query(
      `UPDATE catalog_source_citation_scopes
          SET scope='description'
        WHERE catalog_id=$1 AND citation_position=$2 AND scope='transcription'`,
      [v2CatalogId, 2],
    );
    const recomputedCitationDryRun = await createV2DryRun(
      citationUpdate,
      citationDryRun.completedAt,
    );
    expect(recomputedCitationDryRun.findings[0]?.findingId).not.toBe(
      citationDryRun.findings[0]?.findingId,
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          citationUpdate,
          citationDryRun,
          "v2-stale-citation-state",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(
          citationDryRun,
          [String(citationDryRun.findings[0]?.findingId)],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        `SELECT scope FROM catalog_source_citation_scopes
          WHERE catalog_id=$1 AND citation_position=$2 ORDER BY scope`,
        [v2CatalogId, 2],
      ),
    ).resolves.toMatchObject({
      rows: [
        { scope: "description" },
        { scope: "record" },
        { scope: "scholarlyResearch" },
      ],
    });

    const provenanceUpdate = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
      provenanceFields: { sourceTitle: "Owner 批准的来源名称" },
    });
    const provenanceDryRun = await createV2DryRun(
      provenanceUpdate,
      "2026-09-03T20:02:21.000Z",
    );
    expect(provenanceDryRun.findings).toEqual([
      expect.objectContaining({ field: "sourceTitle", operation: "SET" }),
    ]);
    await pool.query(
      `UPDATE catalog_import_sources
          SET source_title=$2
        WHERE source_id=$1`,
      ["src_test_v2_001", "dry-run 后写入的较新来源名称"],
    );
    const recomputedProvenanceDryRun = await createV2DryRun(
      provenanceUpdate,
      provenanceDryRun.completedAt,
    );
    expect(recomputedProvenanceDryRun.findings[0]?.findingId).not.toBe(
      provenanceDryRun.findings[0]?.findingId,
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          provenanceUpdate,
          provenanceDryRun,
          "v2-stale-provenance-state",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(
          provenanceDryRun,
          [String(provenanceDryRun.findings[0]?.findingId)],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT source_title FROM catalog_import_sources WHERE source_id=$1",
        ["src_test_v2_001"],
      ),
    ).resolves.toMatchObject({
      rows: [{ source_title: "dry-run 后写入的较新来源名称" }],
    });

    const identicalProvenance = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
      provenanceFields: { sourceTitle: "dry-run 后写入的较新来源名称" },
    });
    const identicalProvenanceDryRun = await createV2DryRun(
      identicalProvenance,
      "2026-09-03T20:02:22.000Z",
    );
    expect(identicalProvenanceDryRun).toMatchObject({
      findings: [],
      resultCounts: { unchanged: 1, update: 0 },
      applyReady: true,
    });
    await pool.query(
      "DELETE FROM catalog_import_operation_items WHERE operation_id=$1",
      ["v2-stale-related-state-seed"],
    );
    await pool.query(
      "DELETE FROM catalog_import_operations WHERE operation_id=$1",
      ["v2-stale-related-state-seed"],
    );
    await pool.query("DELETE FROM catalog_import_sources WHERE source_id=$1", [
      "src_test_v2_001",
    ]);
    const missingProvenanceDryRun = await createV2DryRun(
      identicalProvenance,
      identicalProvenanceDryRun.completedAt,
    );
    expect(missingProvenanceDryRun.findings).toEqual([
      expect.objectContaining({
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        operation: "SET",
        requiresFieldApproval: true,
        message: "The update creates a provenance source mapping",
      }),
    ]);
    expect(missingProvenanceDryRun.dryRunResultSha256).not.toBe(
      identicalProvenanceDryRun.dryRunResultSha256,
    );
    await expect(
      applyCatalogImport(
        pool,
        applyInput(
          identicalProvenance,
          identicalProvenanceDryRun,
          "v2-stale-provenance-existence",
        ),
      ),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT source_id FROM catalog_import_sources WHERE source_id=$1",
        ["src_test_v2_001"],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await pool.query(
      `INSERT INTO catalog_import_sources(
         source_id, catalog_id, source_title, source_type_raw, source_url, source_note
       ) VALUES ($1,$2,$3,$4,$5,NULL)`,
      [
        "src_test_v2_001",
        v2CatalogId,
        "dry-run 后写入的较新来源名称",
        "official-test",
        "https://example.invalid/raw-source",
      ],
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          identicalProvenance,
          missingProvenanceDryRun,
          "v2-stale-provenance-created",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(
          missingProvenanceDryRun,
          [String(missingProvenanceDryRun.findings[0]?.findingId)],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("transactionally recomputed plan");
    await expect(
      pool.query(
        "SELECT source_title FROM catalog_import_sources WHERE source_id=$1",
        ["src_test_v2_001"],
      ),
    ).resolves.toMatchObject({
      rows: [{ source_title: "dry-run 后写入的较新来源名称" }],
    });
    await expect(
      pool.query(
        `SELECT operation_id FROM catalog_import_operations
          WHERE operation_id = ANY($1::text[])`,
        [
          [
            "v2-stale-citation-state",
            "v2-stale-provenance-state",
            "v2-stale-provenance-existence",
            "v2-stale-provenance-created",
          ],
        ],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("applies contributor PRESERVE, no-op REPLACE, approved replacement/CLEAR, and rollback atomically", async () => {
    await seedV2Catalog("v2-contributor-seed");
    const initial = await readContributorRows();

    const preserve = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const preserveDryRun = await createV2DryRun(
      preserve,
      "2026-09-03T20:03:00.000Z",
    );
    expect(preserveDryRun).toMatchObject({
      findings: [],
      resultCounts: { unchanged: 1, update: 0 },
    });
    await applyCatalogImport(
      pool,
      applyInput(preserve, preserveDryRun, "v2-contributor-preserve"),
    );
    await expect(readContributorRows()).resolves.toEqual(initial);

    const identical = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "REPLACE",
      contributorRows: [...defaultV2Contributors].reverse(),
      publicCitationsAction: "PRESERVE",
    });
    const identicalDryRun = await createV2DryRun(
      identical,
      "2026-09-03T20:03:01.000Z",
    );
    expect(identicalDryRun).toMatchObject({
      findings: [],
      resultCounts: { unchanged: 1, update: 0 },
    });
    await applyCatalogImport(
      pool,
      applyInput(identical, identicalDryRun, "v2-contributor-identical"),
    );
    await expect(readContributorRows()).resolves.toEqual(initial);

    const changedRows = [
      { position: 4, name: "颜真卿", role: "calligrapher" },
      { position: 0, name: "韩愈", role: "textAuthor" },
    ] as const satisfies readonly V2ContributorInput[];
    const changed = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "REPLACE",
      contributorRows: changedRows,
      publicCitationsAction: "PRESERVE",
    });
    const changedDryRun = await createV2DryRun(
      changed,
      "2026-09-03T20:03:02.000Z",
    );
    expect(changedDryRun.findings).toEqual([
      expect.objectContaining({
        field: "contributors",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        operation: "SET",
        requiresFieldApproval: true,
      }),
    ]);
    const findingId = String(changedDryRun.findings[0]?.findingId);
    const databaseBeforeReplacement = await readImporterDatabaseState();
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, changedDryRun, "v2-contributor-unapproved"),
        authorization: SYNTHETIC_AUTHORIZATION(changedDryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("required field-level finding");
    await expect(readContributorRows()).resolves.toEqual(initial);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, changedDryRun, "v2-contributor-rollback"),
        authorization: SYNTHETIC_AUTHORIZATION(
          changedDryRun,
          [findingId],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
        failureAfterCatalogRows: 1,
      }),
    ).rejects.toThrow("Synthetic mid-transaction failure");
    await expect(readContributorRows()).resolves.toEqual(initial);
    await expect(readImporterDatabaseState()).resolves.toEqual(
      databaseBeforeReplacement,
    );
    await applyCatalogImport(pool, {
      ...applyInput(changed, changedDryRun, "v2-contributor-approved"),
      authorization: SYNTHETIC_AUTHORIZATION(
        changedDryRun,
        [findingId],
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    expect((await readContributorRows()).map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        position: 0,
        name: "韩愈",
        role: "textAuthor",
      },
      {
        catalog_id: v2CatalogId,
        position: 4,
        name: "颜真卿",
        role: "calligrapher",
      },
    ]);

    const clear = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "CLEAR",
      publicCitationsAction: "PRESERVE",
    });
    const clearDryRun = await createV2DryRun(clear, "2026-09-03T20:03:03.000Z");
    expect(clearDryRun.findings).toEqual([
      expect.objectContaining({
        field: "contributors",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        persistenceDisposition: "SUPPORTED_NOW",
        operation: "CLEAR",
        approvable: true,
        requiresFieldApproval: true,
      }),
    ]);
    await applyCatalogImport(pool, {
      ...applyInput(clear, clearDryRun, "v2-contributor-clear"),
      authorization: SYNTHETIC_AUTHORIZATION(
        clearDryRun,
        [String(clearDryRun.findings[0]?.findingId)],
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    await expect(readContributorRows()).resolves.toEqual([]);
  });

  it("applies citation PRESERVE, semantic no-op, replacement/CLEAR, provenance separation, and rollback", async () => {
    await seedV2Catalog("v2-citation-seed");
    const initial = await readCitationRows();

    const preserve = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "PRESERVE",
    });
    const preserveDryRun = await createV2DryRun(
      preserve,
      "2026-09-03T20:04:00.000Z",
    );
    expect(preserveDryRun).toMatchObject({
      findings: [],
      resultCounts: { unchanged: 1, update: 0 },
    });
    await applyCatalogImport(
      pool,
      applyInput(preserve, preserveDryRun, "v2-citation-preserve"),
    );
    await expect(readCitationRows()).resolves.toEqual(initial);

    const semanticallyIdentical = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "REPLACE",
      publicCitationRows: [
        { ...defaultV2Citations[0], appliesTo: ["record"] },
        {
          ...defaultV2Citations[1],
          appliesTo: ["transcription", "scholarlyResearch", "record"],
        },
      ],
    });
    const identicalDryRun = await createV2DryRun(
      semanticallyIdentical,
      "2026-09-03T20:04:01.000Z",
    );
    expect(identicalDryRun).toMatchObject({
      findings: [],
      resultCounts: { unchanged: 1, update: 0 },
    });
    await applyCatalogImport(
      pool,
      applyInput(
        semanticallyIdentical,
        identicalDryRun,
        "v2-citation-semantic-noop",
      ),
    );
    await expect(readCitationRows()).resolves.toEqual(initial);
    expect(
      initial.scopes.some(({ citation_position }) => citation_position === 0),
    ).toBe(false);

    const changedRows = [
      {
        position: 3,
        label: "修订公开来源",
        citation: "修订引文",
        url: "https://example.invalid/public/revised",
        appliesTo: ["historicalContext", "description"],
      },
    ] as const satisfies readonly V2CitationInput[];
    const changed = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "REPLACE",
      publicCitationRows: changedRows,
    });
    const changedDryRun = await createV2DryRun(
      changed,
      "2026-09-03T20:04:02.000Z",
    );
    expect(changedDryRun.findings).toEqual([
      expect.objectContaining({
        field: "publicCitations",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        operation: "SET",
        requiresFieldApproval: true,
      }),
    ]);
    const findingId = String(changedDryRun.findings[0]?.findingId);
    const databaseBeforeReplacement = await readImporterDatabaseState();
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, changedDryRun, "v2-citation-unapproved"),
        authorization: SYNTHETIC_AUTHORIZATION(changedDryRun, [], "PRODUCTION"),
        catalogIdAllocator: undefined,
      }),
    ).rejects.toThrow("required field-level finding");
    await expect(readCitationRows()).resolves.toEqual(initial);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, changedDryRun, "v2-citation-rollback"),
        authorization: SYNTHETIC_AUTHORIZATION(
          changedDryRun,
          [findingId],
          "PRODUCTION",
        ),
        catalogIdAllocator: undefined,
        failureAfterCatalogRows: 1,
      }),
    ).rejects.toThrow("Synthetic mid-transaction failure");
    await expect(readCitationRows()).resolves.toEqual(initial);
    await expect(readImporterDatabaseState()).resolves.toEqual(
      databaseBeforeReplacement,
    );
    await applyCatalogImport(pool, {
      ...applyInput(changed, changedDryRun, "v2-citation-approved"),
      authorization: SYNTHETIC_AUTHORIZATION(
        changedDryRun,
        [findingId],
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    const replaced = await readCitationRows();
    expect(replaced.citations.map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        position: 3,
        label: "修订公开来源",
        citation: "修订引文",
        url: "https://example.invalid/public/revised",
      },
    ]);
    expect(replaced.scopes.map(omitRevision)).toEqual([
      {
        catalog_id: v2CatalogId,
        citation_position: 3,
        scope: "description",
      },
      {
        catalog_id: v2CatalogId,
        citation_position: 3,
        scope: "historicalContext",
      },
    ]);
    await expect(
      pool.query(
        "SELECT source_id, source_url FROM catalog_import_sources ORDER BY source_id",
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          source_id: "src_test_v2_001",
          source_url: "https://example.invalid/raw-source",
        },
      ],
    });

    const clear = buildV2ParsedBundle({
      catalogId: v2CatalogId,
      contributorsAction: "PRESERVE",
      publicCitationsAction: "CLEAR",
    });
    const clearDryRun = await createV2DryRun(clear, "2026-09-03T20:04:03.000Z");
    expect(clearDryRun.findings).toEqual([
      expect.objectContaining({
        field: "publicCitations",
        category: "CRITICAL_CHANGE",
        protectionLevel: "LEVEL_B",
        persistenceDisposition: "SUPPORTED_NOW",
        operation: "CLEAR",
        approvable: true,
        requiresFieldApproval: true,
      }),
    ]);
    await applyCatalogImport(pool, {
      ...applyInput(clear, clearDryRun, "v2-citation-clear"),
      authorization: SYNTHETIC_AUTHORIZATION(
        clearDryRun,
        [String(clearDryRun.findings[0]?.findingId)],
        "PRODUCTION",
      ),
      catalogIdAllocator: undefined,
    });
    await expect(readCitationRows()).resolves.toEqual({
      citations: [],
      scopes: [],
    });
    await expect(
      pool.query("SELECT source_id FROM catalog_import_sources"),
    ).resolves.toMatchObject({ rows: [{ source_id: "src_test_v2_001" }] });
  });

  it("rejects version/hash mismatches and replays one exact V2 operation without duplicates", async () => {
    const parsed = buildV2ParsedBundle();
    const dryRun = await createV2DryRun(parsed, "2026-09-03T20:05:00.000Z");
    const v1Parsed = await parseCatalogImportCsvBundle(bundleDirectory);
    const v1DryRun = await createCatalogImportDryRun(
      pool,
      v1Parsed,
      "2026-09-03T20:05:00.100Z",
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, v1DryRun, "v2-version-mismatch-dry-run"),
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("versions must match");

    const mismatchedAuthorization = SYNTHETIC_AUTHORIZATION(dryRun);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "v2-version-mismatch-approval"),
        authorization: {
          ...mismatchedAuthorization,
          approval: {
            ...mismatchedAuthorization.approval,
            importContractVersion: CATALOG_IMPORT_CONTRACT_VERSION,
          },
        } as CatalogImportAuthorization,
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("versions must match");

    const crossBoundParsed = buildV2ParsedBundle({
      title: "V2 测试碑刻修订",
    });
    const crossBoundDryRun = await createV2DryRun(
      crossBoundParsed,
      "2026-09-03T20:05:00.200Z",
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          crossBoundParsed,
          crossBoundDryRun,
          "v2-cross-input-approval",
        ),
        authorization: SYNTHETIC_AUTHORIZATION(dryRun),
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("does not bind");

    await pool.query(
      "INSERT INTO catalog_entries(catalog_id, kind, title) VALUES ($1,$2,$3)",
      ["catalog-v2-concurrent", "inscription", "V2 测试碑刻"],
    );
    try {
      await expect(
        applyCatalogImport(pool, {
          ...applyInput(parsed, dryRun, "v2-recomputed-plan-mismatch"),
          catalogIdAllocator: fakeAllocator(v2CatalogId),
        }),
      ).rejects.toThrow("transactionally recomputed plan");
    } finally {
      await pool.query(
        "DELETE FROM catalog_entries WHERE catalog_id='catalog-v2-concurrent'",
      );
    }

    await expect(
      applyCatalogImport(pool, {
        ...applyInput(
          {
            ...parsed,
            canonicalInputSha256: "0".repeat(64),
          },
          dryRun,
          "v2-input-hash-mismatch",
        ),
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("metadata does not match its envelope");
    const invalidDryRun = {
      ...dryRun,
      dryRunResultSha256: "0".repeat(64),
    } as CatalogImportV2DryRun;
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, invalidDryRun, "v2-dry-run-hash-mismatch"),
        authorization: SYNTHETIC_AUTHORIZATION(invalidDryRun),
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("dry-run result hash is invalid");
    const mismatchedHashAuthorization = SYNTHETIC_AUTHORIZATION(dryRun);
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(parsed, dryRun, "v2-approval-hash-mismatch"),
        authorization: {
          ...mismatchedHashAuthorization,
          approval: {
            ...mismatchedHashAuthorization.approval,
            canonicalInputSha256: "0".repeat(64),
          },
        } as CatalogImportAuthorization,
        catalogIdAllocator: fakeAllocator(v2CatalogId),
      }),
    ).rejects.toThrow("does not bind");
    await expect(
      pool.query(
        "SELECT COUNT(*)::integer AS count FROM catalog_import_operations",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const input = {
      ...applyInput(parsed, dryRun, "v2-exact-replay"),
      catalogIdAllocator: fakeAllocator(v2CatalogId),
    };
    const first = await applyCatalogImport(pool, input);
    const replay = await applyCatalogImport(pool, input);
    expect(first).toMatchObject({
      status: "APPLIED",
      created: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(replay).toMatchObject({
      status: "ALREADY_APPLIED",
      created: 1,
      updated: 0,
      unchanged: 0,
    });
    await expect(
      pool.query(
        `SELECT import_contract_version, canonical_input_sha256,
                dry_run_result_sha256
         FROM catalog_import_operations WHERE operation_id=$1`,
        ["v2-exact-replay"],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          import_contract_version: "catalog-import/v2",
          canonical_input_sha256: parsed.canonicalInputSha256,
          dry_run_result_sha256: dryRun.dryRunResultSha256,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM catalog_import_operations) AS operations,
           (SELECT COUNT(*)::integer FROM catalog_import_operation_items) AS operation_items,
           (SELECT COUNT(*)::integer FROM catalog_entries) AS entries,
           (SELECT COUNT(*)::integer FROM catalog_contributors) AS contributors,
           (SELECT COUNT(*)::integer FROM catalog_source_citations) AS citations,
           (SELECT COUNT(*)::integer FROM catalog_source_citation_scopes) AS scopes,
           (SELECT COUNT(*)::integer FROM catalog_import_sources) AS sources`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operations: 1,
          operation_items: 1,
          entries: 1,
          contributors: 2,
          citations: 2,
          scopes: 3,
          sources: 1,
        },
      ],
    });

    const changed = buildV2ParsedBundle({ title: "V2 测试碑刻修订" });
    const changedDryRun = await createV2DryRun(
      changed,
      "2026-09-03T20:05:01.000Z",
    );
    await expect(
      applyCatalogImport(pool, {
        ...applyInput(changed, changedDryRun, "v2-exact-replay"),
        catalogIdAllocator: fakeAllocator("catalog-v2-never-allocated"),
      }),
    ).rejects.toThrow("operation identity was reused with different hashes");
  });
});
