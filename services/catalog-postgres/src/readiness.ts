import { asPostgresOperationError } from "./availability.js";
import { verifyRequiredMigrationLedger } from "./migrations/runner.js";
import { catalogSearchReadySql } from "./search-queries.js";
import { SEARCH_NORMALIZATION_VERSION } from "@moya/search";

import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ServerVersionRow extends QueryResultRow {
  readonly server_version_num: unknown;
}

// PostgreSQL majors the migrations, grants and runtime queries are validated
// against: 16 is the minimum supported Production major and 18 the newer one.
// CI runs both; any other major, including the unvalidated 17, is refused.
const SUPPORTED_POSTGRES_MAJORS: readonly number[] = [16, 18];

export class PostgresStartupError extends Error {
  override readonly name = "PostgresStartupError";

  constructor(
    message = "PostgreSQL startup validation failed",
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

const acquireClient = async (pool: Pool): Promise<PoolClient> => {
  try {
    return await pool.connect();
  } catch (error) {
    throw asPostgresOperationError(error, "connect");
  }
};

export const checkPostgresReadiness = async (pool: Pool): Promise<void> => {
  const client = await acquireClient(pool);
  try {
    await client.query("SELECT 1");
  } catch (error) {
    throw asPostgresOperationError(error, "query");
  } finally {
    client.release();
  }
};

export const assertPostgresStartupReady = async (
  pool: Pool,
  source: "legacy" | "payload" = "legacy",
): Promise<void> => {
  try {
    const client = await acquireClient(pool);
    try {
      const result = await client.query<ServerVersionRow>(
        "SHOW server_version_num",
      );
      const value = result.rows[0]?.server_version_num;
      const versionNumber =
        typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (
        !Number.isSafeInteger(versionNumber) ||
        !SUPPORTED_POSTGRES_MAJORS.includes(Math.floor(versionNumber / 10_000))
      ) {
        throw new PostgresStartupError(
          "PostgreSQL major version 16 or 18 is required",
        );
      }
    } finally {
      client.release();
    }
    if (source === "legacy") await verifyRequiredMigrationLedger(pool);
    else if (source === "payload") {
      const views = [
        "catalog_entries",
        "catalog_aliases",
        "catalog_source_citations",
        "catalog_contributors",
        "catalog_source_citation_scopes",
        "catalog_media",
      ];
      const result = await pool.query<{
        view_count: string;
        view_migration: boolean;
        search_migration: boolean;
      }>(`
        SELECT (SELECT count(*)::text FROM pg_class WHERE oid = ANY(ARRAY[
          to_regclass('catalog_entries'), to_regclass('catalog_aliases'),
          to_regclass('catalog_source_citations'), to_regclass('catalog_contributors'),
          to_regclass('catalog_source_citation_scopes'), to_regclass('catalog_media')
        ]) AND relkind = 'v') AS view_count,
        EXISTS(SELECT 1 FROM payload_migrations WHERE name = '20260908_031500_published_views') AS view_migration,
        EXISTS(SELECT 1 FROM payload_migrations WHERE name = '20260908_120000_published_search') AS search_migration
      `);
      if (
        Number(result.rows[0]?.view_count) !== views.length ||
        result.rows[0]?.view_migration !== true ||
        result.rows[0]?.search_migration !== true
      ) {
        throw new PostgresStartupError(
          "Payload published read views are not migration-ready",
        );
      }
      // Require the derived table and its public SELECT grant at startup too.
      const search = await pool.query<{ incomplete: boolean }>(
        catalogSearchReadySql,
        [SEARCH_NORMALIZATION_VERSION],
      );
      if (search.rows[0]?.incomplete !== false)
        throw new PostgresStartupError(
          "Payload published search is not migration-ready",
        );
    }
  } catch (error) {
    if (error instanceof PostgresStartupError) throw error;
    throw new PostgresStartupError(
      "PostgreSQL startup validation failed",
      error,
    );
  }
};
