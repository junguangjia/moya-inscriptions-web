import { asPostgresOperationError } from "./availability.js";
import type { CatalogReaderOptions } from "./catalog-media-delivery.js";
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

/** What the published read connection serves besides the Catalog readers. */
export interface PostgresStartupOptions extends CatalogReaderOptions {
  /**
   * The Backend's discovery (browse, collection, card, filter options) reads
   * the published `public.catalog_discovery` view through this connection,
   * which needs SELECT on it (`grant-public-read.sql`).
   */
  readonly discovery?: boolean;
}

const unreadableCodes: ReadonlySet<unknown> = new Set([
  "3F000",
  "42P01",
  "42501",
]);

/**
 * Read-only startup validation of the published read connection. Readers
 * composed with `renditions` also require the Catalog rendition delivery
 * view and its SELECT grant (the post-Community public read phase), and
 * `discovery` requires the published discovery view and its SELECT grant, so
 * a missing grant stops startup instead of failing Catalog or discovery reads.
 */
export const assertPostgresStartupReady = async (
  pool: Pool,
  source: "legacy" | "payload" = "legacy",
  options: PostgresStartupOptions = {},
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
    if (options.renditions === true) {
      try {
        await pool.query(
          "SELECT 1 FROM community.catalog_media_delivery LIMIT 0",
        );
      } catch (error) {
        // Missing schema or view, or no SELECT grant for this role.
        const code = (error as { readonly code?: unknown } | null)?.code;
        if (unreadableCodes.has(code))
          throw new PostgresStartupError(
            "Catalog rendition delivery view is not readable",
            error,
          );
        throw error;
      }
    }
    if (options.discovery === true) {
      try {
        await pool.query("SELECT 1 FROM public.catalog_discovery LIMIT 0");
      } catch (error) {
        // Missing view, or no SELECT grant for this role.
        const code = (error as { readonly code?: unknown } | null)?.code;
        if (unreadableCodes.has(code))
          throw new PostgresStartupError(
            "Catalog discovery view is not readable: grant SELECT on public.catalog_discovery to the public read role",
            error,
          );
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof PostgresStartupError) throw error;
    throw new PostgresStartupError(
      "PostgreSQL startup validation failed",
      error,
    );
  }
};

/** A privilege a startup check requires of the connection's own role. */
interface RequiredPrivilege {
  readonly relation: string;
  readonly privilege: "SELECT" | "INSERT" | "UPDATE";
  /** For a column privilege; otherwise the table privilege is required. */
  readonly column?: string;
}

// One boolean per requirement, in input order. A missing relation or column
// reads as not granted rather than raising, so the message can name it.
const requiredPrivilegesSql = `SELECT CASE
  WHEN to_regclass(r.relation) IS NULL THEN false
  WHEN r.column_name = '' THEN has_table_privilege(to_regclass(r.relation), r.privilege)
  WHEN NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(r.relation)
    AND a.attname = r.column_name AND a.attnum > 0 AND NOT a.attisdropped) THEN false
  ELSE has_column_privilege(to_regclass(r.relation), r.column_name, r.privilege)
END AS granted
FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY
  AS r(relation, privilege, column_name, ordinal)
ORDER BY r.ordinal`;

const describePrivilege = ({
  relation,
  privilege,
  column,
}: RequiredPrivilege) =>
  `${privilege}${column === undefined ? "" : ` (${column})`} on ${relation}`;

/** The requirements this role lacks; throws when the answer is incomplete. */
const missingPrivileges = async (
  pool: Pool,
  required: readonly RequiredPrivilege[],
): Promise<readonly RequiredPrivilege[]> => {
  let rows: readonly { readonly granted?: unknown }[];
  try {
    rows = (
      await pool.query<{ granted: unknown }>(requiredPrivilegesSql, [
        required.map(({ relation }) => relation),
        required.map(({ privilege }) => privilege),
        required.map(({ column }) => column ?? ""),
      ])
    ).rows;
  } catch (error) {
    throw new PostgresStartupError(
      "PostgreSQL startup validation failed",
      error,
    );
  }
  // Fail closed: one answer per requirement, each exactly true.
  if (rows.length !== required.length)
    throw new PostgresStartupError("PostgreSQL startup validation failed");
  return required.filter((_, index) => rows[index]?.granted !== true);
};

/*
 * catalog-scale-v1 (Issue #323) 1B, W6: the App role's privileges on the
 * scoped Catalog reconcile's tables (App migration 20261024010000), exactly
 * as infra/development/work-publishing/grant-runtime.sql grants them. Marks
 * are inserted and advanced, never deleted; the single state row is only
 * updated.
 */
const catalogPublicationScopePrivileges: readonly RequiredPrivilege[] = [
  { relation: "community.catalog_publication_dirty", privilege: "SELECT" },
  { relation: "community.catalog_publication_dirty", privilege: "INSERT" },
  ...["mark_seq", "cleared_seq", "reason", "marked_at"].map((column) => ({
    relation: "community.catalog_publication_dirty",
    privilege: "UPDATE" as const,
    column,
  })),
  { relation: "community.catalog_reconcile_state", privilege: "SELECT" },
  ...[
    "sweep_cursor",
    "policy_digest",
    "public_count",
    "public_sum",
    "public_observed_at",
    "private_count",
    "private_sum",
    "private_observed_at",
    "render_backlog",
    "render_backlog_at",
    "updated_at",
  ].map((column) => ({
    relation: "community.catalog_reconcile_state",
    privilege: "UPDATE" as const,
    column,
  })),
];

/**
 * Read-only startup check of the App connection (worker and Backend): the
 * scoped Catalog reconcile's dirty queue and state row exist and this role
 * holds every privilege the reconcile uses on them. A worker or Backend
 * started before the migration or its grants refuses, naming what is
 * missing (relation, column and privilege names only), instead of failing
 * every reconcile with 42P01 or 42501. The state row itself must exist too:
 * the App role can only update it, so without it (an owner-side truncate, a
 * restore without data) every update of the sweep position and fingerprints
 * would change nothing.
 */
export const assertCatalogPublicationScopeReady = async (
  pool: Pool,
): Promise<void> => {
  const missing = await missingPrivileges(
    pool,
    catalogPublicationScopePrivileges,
  );
  if (missing.length > 0)
    throw new PostgresStartupError(
      `Catalog publication scope is not ready for the App role (missing ${missing.map(describePrivilege).join(", ")}): apply App migration 20261024010000, then infra/development/work-publishing/grant-runtime.sql`,
    );
  let stateRows: unknown;
  try {
    stateRows = (
      await pool.query<{ state_rows: unknown }>(
        "SELECT count(*)::integer AS state_rows FROM community.catalog_reconcile_state",
      )
    ).rows[0]?.state_rows;
  } catch (error) {
    throw new PostgresStartupError(
      "PostgreSQL startup validation failed",
      error,
    );
  }
  if (stateRows !== 1)
    throw new PostgresStartupError(
      "Catalog publication scope is not ready for the App role (missing the community.catalog_reconcile_state row): re-create it with the migration role as App migration 20261024010000 does",
    );
};

/** Both private prepare views the worker and the Backend read (CMS M2). */
const catalogPrepareViews = [
  "public.catalog_delivery_prepare_media",
  "public.catalog_delivery_live_prepare_media",
] as const;

/**
 * Read-only startup check of the Catalog prepare connection, where one is
 * configured: its role can read both private prepare views, the live
 * projection that the snapshot and the publication fence read (CMS migration
 * 20261024_000000) and the full one that readiness reads. Each is probed as
 * a read with LIMIT 0, so schema usage, the view and its grant are all
 * checked and no row is read. Without the grant, startup refuses naming the
 * view instead of every Catalog sync and fence failing with 42501.
 */
export const assertCatalogPrepareReaderReady = async (
  pool: Pool,
): Promise<void> => {
  for (const view of catalogPrepareViews) {
    try {
      await pool.query(`SELECT 1 FROM ${view} LIMIT 0`);
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (unreadableCodes.has(code))
        throw new PostgresStartupError(
          `Catalog prepare reader cannot read ${view}: apply CMS migration 20261024_000000, then re-run infra/development/catalog-media/grant-prepare-read.sql`,
          error,
        );
      throw new PostgresStartupError(
        "PostgreSQL startup validation failed",
        error,
      );
    }
  }
};
