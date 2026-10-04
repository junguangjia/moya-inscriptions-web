import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CatalogQueryUnavailableError } from "@moya/api";
import {
  asPostgresOperationError,
  assertPostgresStartupReady,
  catalogPageOffset,
  mapAliasRows,
  mapCatalogDetailRow,
  mapCatalogEntryRow,
  mapCatalogMediaRow,
  mapCatalogMediaRows,
  mapCitationRows,
  mapRepresentativeMediaRows,
  parseCatalogCount,
  parsePostgresConfig,
  readMigrationFiles,
  requiredMigrations,
} from "@moya/catalog-postgres";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "database", "migrations");

const catalogDetailRow = (overrides: Record<string, unknown> = {}) => ({
  catalog_id: "test-catalog-content",
  kind: "inscription",
  title: "Test content",
  summary: null,
  description: null,
  period_label: null,
  dynasty: null,
  dynasty_state: "UNSUPPLIED",
  date_text: null,
  date_text_state: "UNSUPPLIED",
  province: null,
  province_state: "UNSUPPLIED",
  prefecture: null,
  prefecture_state: "UNSUPPLIED",
  county: null,
  county_state: "UNSUPPLIED",
  current_location: null,
  current_location_state: "UNSUPPLIED",
  current_custodian: null,
  current_custodian_state: "UNSUPPLIED",
  script_style: "楷书",
  script_style_state: "VALUE",
  transcription: "第一行\n第二行",
  transcription_state: "VALUE",
  historical_context: "历史背景",
  historical_context_state: "VALUE",
  scholarly_research: "学术研究",
  scholarly_research_state: "VALUE",
  ...overrides,
});

describe("PostgreSQL configuration and availability", () => {
  it("parses the minimal DATABASE_URL without exposing it in the result shape", () => {
    const connectionString =
      "postgresql://synthetic-test-role:synthetic-test-password@127.0.0.1:5432/moya_test?sslmode=disable";
    expect(parsePostgresConfig({ DATABASE_URL: connectionString })).toEqual({
      connectionString: connectionString.replace("?sslmode=disable", ""),
      connectionTimeoutMillis: 5_000,
      max: 5,
      idleTimeoutMillis: 10_000,
      ssl: false,
    });
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://synthetic-test-role:synthetic-test-password@private-host/catalog",
    "postgresql://private-host/catalog",
    "postgresql://moya@private-host",
  ])("rejects invalid database config safely", (DATABASE_URL) => {
    let message = "";
    try {
      parsePostgresConfig({ DATABASE_URL });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("private-host");
  });

  it("classifies acquisition and known availability codes without masking programming errors", () => {
    const connectionFailure = new Error("private host");
    expect(
      asPostgresOperationError(connectionFailure, "connect"),
    ).toBeInstanceOf(CatalogQueryUnavailableError);
    expect(
      asPostgresOperationError(
        Object.assign(new Error("shutdown"), { code: "57P01" }),
        "query",
      ),
    ).toBeInstanceOf(CatalogQueryUnavailableError);
    const programmingError = Object.assign(new Error("bad SQL"), {
      code: "42601",
    });
    expect(asPostgresOperationError(programmingError, "query")).toBe(
      programmingError,
    );
  });
});

describe("PostgreSQL Catalog mapping and pagination", () => {
  it("uses exact BigInt arithmetic for the largest frozen safe page", () => {
    expect(catalogPageOffset(Number.MAX_SAFE_INTEGER, 100)).toBe(
      (BigInt(Number.MAX_SAFE_INTEGER) - 1n) * 100n,
    );
  });

  it("maps only explicit projection fields", () => {
    const row = {
      catalog_id: "test-catalog-001",
      kind: "inscription",
      title: "Test inscription",
      summary: "Summary",
      description: "Description",
      period_label: "唐贞观十年（636）",
      dynasty: "唐",
      dynasty_state: "VALUE",
      date_text: "贞观十年",
      date_text_state: "VALUE",
      province: "陕西",
      province_state: "VALUE",
      prefecture: null,
      prefecture_state: "CLEAR",
      county: null,
      county_state: "UNSUPPLIED",
      current_location: "陕西省碑林区",
      current_location_state: "VALUE",
      current_custodian: "碑林博物馆",
      current_custodian_state: "VALUE",
      script_style: "碑额篆书，正文楷书",
      script_style_state: "VALUE",
      transcription: "第一行释文\n第二行释文",
      transcription_state: "VALUE",
      historical_context: "历史背景",
      historical_context_state: "VALUE",
      scholarly_research: "学术研究",
      scholarly_research_state: "VALUE",
      raw_source: "must remain private",
      review_state: "pending",
    };
    const aliases = mapAliasRows([
      { catalog_id: row.catalog_id, position: 0, alias: "Alias" },
    ]);
    const citations = mapCitationRows(
      [
        {
          catalog_id: row.catalog_id,
          position: 0,
          label: "Public citation",
          citation: null,
          url: null,
        },
        {
          catalog_id: row.catalog_id,
          position: 1,
          label: "Scoped citation",
          citation: null,
          url: null,
        },
      ],
      [
        {
          catalog_id: row.catalog_id,
          citation_position: 1,
          scope: "record",
        },
        {
          catalog_id: row.catalog_id,
          citation_position: 1,
          scope: "transcription",
        },
      ],
    );

    expect(mapCatalogEntryRow(row, aliases.get(row.catalog_id) ?? [])).toEqual({
      id: row.catalog_id,
      kind: row.kind,
      title: row.title,
      aliases: ["Alias"],
      summary: row.summary,
      periodLabel: "唐贞观十年（636）",
      province: { state: "VALUE", value: "陕西" },
    });
    const detail = mapCatalogDetailRow(
      row,
      aliases.get(row.catalog_id) ?? [],
      citations,
      [],
      [
        {
          catalog_id: row.catalog_id,
          position: 0,
          name: "魏徵",
          role: "textAuthor",
        },
        {
          catalog_id: row.catalog_id,
          position: 1,
          name: "欧阳询",
          role: "calligrapher",
        },
      ],
    );

    expect(detail).toMatchObject({
      periodLabel: "唐贞观十年（636）",
      dynasty: { state: "VALUE", value: "唐" },
      dateText: { state: "VALUE", value: "贞观十年" },
      province: { state: "VALUE", value: "陕西" },
      prefecture: { state: "CLEAR" },
      county: { state: "UNSUPPLIED" },
      currentLocation: { state: "VALUE", value: "陕西省碑林区" },
      currentCustodian: { state: "VALUE", value: "碑林博物馆" },
      scriptStyle: { state: "VALUE", value: "碑额篆书，正文楷书" },
      transcription: {
        state: "VALUE",
        value: "第一行释文\n第二行释文",
      },
      historicalContext: { state: "VALUE", value: "历史背景" },
      scholarlyResearch: { state: "VALUE", value: "学术研究" },
      contributors: [
        { name: "魏徵", role: "textAuthor" },
        { name: "欧阳询", role: "calligrapher" },
      ],
      sourceCitations: [
        { label: "Public citation" },
        {
          label: "Scoped citation",
          appliesTo: ["record", "transcription"],
        },
      ],
    });
    expect(
      mapCatalogEntryRow({ ...row, period_label: null }, []),
    ).toMatchObject({ periodLabel: "唐 · 贞观十年" });
    const serialized = JSON.stringify(detail);
    for (const databaseField of [
      "raw_source",
      "review_state",
      "script_style",
      "historical_context",
      "scholarly_research",
      "position",
    ]) {
      expect(serialized).not.toContain(databaseField);
    }
  });

  it("keeps every allowed non-VALUE Content V1 state without a renderable value", () => {
    for (const state of [
      "UNSUPPLIED",
      "CLEAR",
      "UNKNOWN",
      "NOT_APPLICABLE",
    ] as const) {
      const detail = mapCatalogDetailRow(
        catalogDetailRow({ script_style: null, script_style_state: state }),
        [],
        [],
      );
      expect(detail.scriptStyle).toEqual({ state });
      expect(detail.scriptStyle).not.toHaveProperty("value");
    }

    for (const state of ["UNSUPPLIED", "CLEAR"] as const) {
      const detail = mapCatalogDetailRow(
        catalogDetailRow({
          transcription: null,
          transcription_state: state,
          historical_context: null,
          historical_context_state: state,
          scholarly_research: null,
          scholarly_research_state: state,
        }),
        [],
        [],
      );
      expect(detail.transcription).toEqual({ state });
      expect(detail.historicalContext).toEqual({ state });
      expect(detail.scholarlyResearch).toEqual({ state });
      expect(detail.transcription).not.toHaveProperty("value");
      expect(detail.historicalContext).not.toHaveProperty("value");
      expect(detail.scholarlyResearch).not.toHaveProperty("value");
    }
  });

  it("fails closed for Content V1 state mismatches and invalid exact text", () => {
    for (const overrides of [
      { script_style: "楷书", script_style_state: "CLEAR" },
      { script_style: null, script_style_state: "VALUE" },
      { transcription: "释文", transcription_state: "UNSUPPLIED" },
      { historical_context: null, historical_context_state: "VALUE" },
      { scholarly_research: null, scholarly_research_state: "UNKNOWN" },
    ]) {
      expect(() =>
        mapCatalogDetailRow(catalogDetailRow(overrides), [], []),
      ).toThrow();
    }

    for (const overrides of [
      { script_style: "", script_style_state: "VALUE" },
      { script_style: " 楷书 ", script_style_state: "VALUE" },
      { transcription: "", transcription_state: "VALUE" },
      { historical_context: " padded ", historical_context_state: "VALUE" },
      { scholarly_research: "x".repeat(20_001) },
    ]) {
      expect(() =>
        mapCatalogDetailRow(catalogDetailRow(overrides), [], []),
      ).toThrow("Invalid PostgreSQL Catalog");
    }
  });

  it("maps contributors in curated order and rejects invalid identities", () => {
    const contributorRows = [
      {
        catalog_id: "test-catalog-content",
        position: 0,
        name: "魏徵",
        role: "textAuthor",
      },
      {
        catalog_id: "test-catalog-content",
        position: 4,
        name: "欧阳询",
        role: "calligrapher",
      },
    ];
    const detail = mapCatalogDetailRow(
      catalogDetailRow(),
      [],
      [],
      [],
      contributorRows,
    );
    expect(detail.contributors).toEqual([
      { name: "魏徵", role: "textAuthor" },
      { name: "欧阳询", role: "calligrapher" },
    ]);

    expect(() =>
      mapCatalogDetailRow(
        catalogDetailRow(),
        [],
        [],
        [],
        [{ ...contributorRows[0]!, role: "editor" }],
      ),
    ).toThrow("contributor role");
    expect(() =>
      mapCatalogDetailRow(
        catalogDetailRow(),
        [],
        [],
        [],
        [contributorRows[0]!, { ...contributorRows[0]!, position: 1 }],
      ),
    ).toThrow("contributor identity");
    expect(() =>
      mapCatalogDetailRow(
        catalogDetailRow(),
        [],
        [],
        [],
        [{ ...contributorRows[0]!, name: " padded " }],
      ),
    ).toThrow("contributor name");
  });

  it("omits legacy citation scopes and validates explicit canonical scopes", () => {
    const citationRows = [
      {
        catalog_id: "test-catalog-content",
        position: 0,
        label: "Legacy citation",
        citation: null,
        url: null,
      },
      {
        catalog_id: "test-catalog-content",
        position: 1,
        label: "Scoped citation",
        citation: null,
        url: null,
      },
    ];
    const citations = mapCitationRows(citationRows, [
      {
        catalog_id: "test-catalog-content",
        citation_position: 1,
        scope: "record",
      },
      {
        catalog_id: "test-catalog-content",
        citation_position: 1,
        scope: "scholarlyResearch",
      },
    ]);

    expect(citations[0]).toEqual({ label: "Legacy citation" });
    expect(citations[0]).not.toHaveProperty("appliesTo");
    expect(citations[1]).toEqual({
      label: "Scoped citation",
      appliesTo: ["record", "scholarlyResearch"],
    });
    expect(() =>
      mapCitationRows(citationRows, [
        {
          catalog_id: "test-catalog-content",
          citation_position: 1,
          scope: "bibliography",
        },
      ]),
    ).toThrow("citation scope");
    expect(() =>
      mapCitationRows(citationRows, [
        {
          catalog_id: "test-catalog-content",
          citation_position: 3,
          scope: "record",
        },
      ]),
    ).toThrow("orphan citation scope");
  });

  it("maps ordered Media projections and explicit representatives only", () => {
    const rows = [
      {
        media_id: "media-postgres-gallery",
        catalog_id: "test-catalog-001",
        position: 0,
        is_representative: false,
        kind: "image",
        alt_text: "图集图",
        width: 800,
        height: 1_200,
        object_key: "private/gallery.jpg",
        storage_provider: "must remain private",
      },
      {
        media_id: "media-postgres-representative",
        catalog_id: "test-catalog-001",
        position: 2,
        is_representative: true,
        kind: "image",
        alt_text: "代表图",
        width: 1_600,
        height: 1_200,
        object_key: "private/representative.jpg",
      },
    ];

    const media = mapCatalogMediaRows(rows);
    const representatives = mapRepresentativeMediaRows([rows[1]!]);

    expect(media.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "media-postgres-gallery", position: 0 },
      { id: "media-postgres-representative", position: 2 },
    ]);
    expect(representatives.get("test-catalog-001")?.id).toBe(
      "media-postgres-representative",
    );
    expect(JSON.stringify(media)).not.toContain("storage_provider");
    expect(() => mapCatalogMediaRow({ ...rows[0]!, width: 0 })).toThrow(
      "width",
    );
    expect(() =>
      mapRepresentativeMediaRows([
        { ...rows[0]!, is_representative: true },
        rows[1]!,
      ]),
    ).toThrow("multiplicity");
  });

  it("accepts only safe PostgreSQL count strings", () => {
    expect(parseCatalogCount("0")).toBe(0);
    expect(parseCatalogCount("1658")).toBe(1658);
    expect(() => parseCatalogCount(1)).toThrow("Invalid PostgreSQL");
    expect(() =>
      parseCatalogCount((BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString()),
    ).toThrow("exceeds the Public contract");
  });
});

describe("migration manifest", () => {
  it("matches the immutable SQL file and SHA-256 checksum", async () => {
    const files = await readMigrationFiles(migrationsDirectory);
    expect(
      files.map((file) => ({
        migrationId: file.migrationId,
        filename: file.filename,
        checksum: file.checksum,
      })),
    ).toEqual(requiredMigrations);
  });

  it("rejects a changed applied migration source", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moya-migration-"));
    const changedMigration = requiredMigrations[0];
    if (changedMigration === undefined) {
      throw new Error("Required migration missing");
    }
    await Promise.all(
      requiredMigrations.map(async (required) => {
        const original = await readFile(
          path.join(migrationsDirectory, required.filename),
          "utf8",
        );
        await writeFile(
          path.join(directory, required.filename),
          required === changedMigration
            ? `${original}\n-- forbidden mutation\n`
            : original,
          "utf8",
        );
      }),
    );

    await expect(readMigrationFiles(directory)).rejects.toThrow(
      "manifest mismatch",
    );
  });
});

describe("PostgreSQL startup major version", () => {
  // Every query answers with the version row, so the ledger read that follows
  // an accepted major finds no migrations and fails startup validation, while
  // a refused major stops at the version check.
  const poolReporting = (serverVersionNum: string) =>
    ({
      connect: async () => ({
        query: async () => ({
          rows: [{ server_version_num: serverVersionNum }],
        }),
        release: () => undefined,
      }),
      query: async () => {
        throw new Error("synthetic ledger probe");
      },
    }) as unknown as Parameters<typeof assertPostgresStartupReady>[0];

  it.each(["160000", "160015", "180004", "180006"])(
    "accepts validated major %s and continues to the ledger check",
    async (version) => {
      await expect(
        assertPostgresStartupReady(poolReporting(version)),
      ).rejects.toThrow(/^PostgreSQL startup validation failed$/);
    },
  );

  it.each(["150013", "170006", "190000", "16.15", ""])(
    "refuses unvalidated server_version_num %j before any ledger read",
    async (version) => {
      await expect(
        assertPostgresStartupReady(poolReporting(version)),
      ).rejects.toThrow(/^PostgreSQL major version 16 or 18 is required$/);
    },
  );
});
