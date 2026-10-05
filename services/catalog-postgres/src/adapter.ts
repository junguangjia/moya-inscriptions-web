import { CatalogQueryUnavailableError } from "@moya/api";
import { SEARCH_NORMALIZATION_VERSION } from "@moya/search";

import { asPostgresOperationError } from "./availability.js";
import { catalogPageOffset } from "./pagination.js";
import {
  countCatalogEntriesSql,
  findCatalogEntrySql,
  listCatalogAliasesSql,
  listCatalogCitationScopesSql,
  listCatalogCitationsSql,
  listCatalogContributorsSql,
  listCatalogEntriesSql,
  listCatalogMediaDeliverySql,
  listCatalogMediaSql,
  listRepresentativeCatalogMediaDeliverySql,
  listRepresentativeCatalogMediaSql,
} from "./queries.js";
import {
  mapAliasRows,
  mapCatalogDetailRow,
  mapCatalogEntryRow,
  mapCatalogMediaRows,
  mapCitationRows,
  mapRepresentativeMediaRows,
} from "./row-mapper.js";
import {
  buildCatalogSearchSql,
  catalogSearchReadySql,
} from "./search-queries.js";

import type { CatalogReaderOptions } from "./catalog-media-delivery.js";
import type {
  CatalogAliasRow,
  CatalogCitationScopeRow,
  CatalogCitationRow,
  CatalogContributorRow,
  CatalogEntryRow,
  CatalogMediaRow,
} from "./row-mapper.js";
import type {
  CatalogListPageProjection,
  CatalogListQuery,
  CatalogQueryPort,
  CatalogSearchPageProjection,
  CatalogSearchQuery,
  CatalogSearchQueryPort,
} from "@moya/api";
import type { CatalogId, CatalogSearchMatchKind } from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface CatalogCountRow extends QueryResultRow {
  readonly total: unknown;
}

const searchMatchKinds: readonly CatalogSearchMatchKind[] = [
  "title-exact",
  "alias-exact",
  "normalized-exact",
  "title-alias-partial",
  "structured",
  "body",
];

const mapSearchMatchKind = (value: unknown): CatalogSearchMatchKind => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Invalid PostgreSQL Catalog search rank");
  }
  const matchKind = searchMatchKinds[value];
  if (matchKind === undefined)
    throw new Error("Invalid PostgreSQL Catalog search rank");
  return matchKind;
};

export const parseCatalogCount = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Invalid PostgreSQL Catalog count");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error("PostgreSQL Catalog count exceeds the Public contract");
  }
  return count;
};

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
      // Preserve the originating failure; release removes the broken client.
    }
    throw asPostgresOperationError(error, "query");
  } finally {
    client.release();
  }
};

/**
 * PostgreSQL infrastructure implementation of the frozen Catalog read port.
 * With `renditions`, media rows carry their rendition delivery facts.
 */
export class PostgresCatalogQueryAdapter
  implements CatalogQueryPort, CatalogSearchQueryPort
{
  private readonly representativeMediaSql: string;
  private readonly mediaSql: string;

  constructor(
    private readonly pool: Pool,
    options: CatalogReaderOptions = {},
  ) {
    this.representativeMediaSql = options.renditions
      ? listRepresentativeCatalogMediaDeliverySql
      : listRepresentativeCatalogMediaSql;
    this.mediaSql = options.renditions
      ? listCatalogMediaDeliverySql
      : listCatalogMediaSql;
  }

  async search(
    query: CatalogSearchQuery,
  ): Promise<CatalogSearchPageProjection> {
    const sql = buildCatalogSearchSql(query);
    return withReadTransaction(this.pool, async (client) => {
      const readiness = await client.query(catalogSearchReadySql, [
        SEARCH_NORMALIZATION_VERSION,
      ]);
      if (readiness.rows[0]?.incomplete !== false) {
        throw new CatalogQueryUnavailableError();
      }
      const count = await client.query<CatalogCountRow>(
        sql.countSql,
        sql.countValues,
      );
      const total = parseCatalogCount(count.rows[0]?.total);
      const entries = await client.query<CatalogEntryRow>(
        sql.listSql,
        sql.listValues,
      );
      const catalogIds = entries.rows.map((row) => String(row.catalog_id));
      const [aliasRows, mediaRows] =
        catalogIds.length === 0
          ? [
              { rows: [] as CatalogAliasRow[] },
              { rows: [] as CatalogMediaRow[] },
            ]
          : await Promise.all([
              client.query<CatalogAliasRow>(listCatalogAliasesSql, [
                catalogIds,
              ]),
              client.query<CatalogMediaRow>(this.representativeMediaSql, [
                catalogIds,
              ]),
            ]);
      const aliases = mapAliasRows(aliasRows.rows);
      const representativeMedia = mapRepresentativeMediaRows(mediaRows.rows);
      return {
        items: entries.rows.map((row) => ({
          ...mapCatalogEntryRow(
            row,
            aliases.get(String(row.catalog_id)) ?? [],
            representativeMedia.get(String(row.catalog_id)),
          ),
          matchKind: mapSearchMatchKind(row.search_rank),
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      };
    });
  }

  async list({
    kind,
    page,
    pageSize,
  }: CatalogListQuery): Promise<CatalogListPageProjection> {
    return withReadTransaction(this.pool, async (client) => {
      const countResult = await client.query<CatalogCountRow>(
        countCatalogEntriesSql,
        [kind ?? null],
      );
      const total = parseCatalogCount(countResult.rows[0]?.total);
      const entriesResult = await client.query<CatalogEntryRow>(
        listCatalogEntriesSql,
        [kind ?? null, pageSize, catalogPageOffset(page, pageSize).toString()],
      );
      const catalogIds = entriesResult.rows.map((row) =>
        String(row.catalog_id),
      );
      const [aliasesResult, representativeMediaResult] =
        catalogIds.length === 0
          ? [
              { rows: [] as CatalogAliasRow[] },
              { rows: [] as CatalogMediaRow[] },
            ]
          : await Promise.all([
              client.query<CatalogAliasRow>(listCatalogAliasesSql, [
                catalogIds,
              ]),
              client.query<CatalogMediaRow>(this.representativeMediaSql, [
                catalogIds,
              ]),
            ]);
      const aliases = mapAliasRows(aliasesResult.rows);
      const representativeMedia = mapRepresentativeMediaRows(
        representativeMediaResult.rows,
      );

      return {
        items: entriesResult.rows.map((row) =>
          mapCatalogEntryRow(
            row,
            aliases.get(String(row.catalog_id)) ?? [],
            representativeMedia.get(String(row.catalog_id)),
          ),
        ),
        total,
        page,
        pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      };
    });
  }

  async getById(id: CatalogId) {
    return withReadTransaction(this.pool, async (client) => {
      const entryResult = await client.query<CatalogEntryRow>(
        findCatalogEntrySql,
        [id],
      );
      const entry = entryResult.rows[0];
      if (entry === undefined) return null;

      const [
        aliasesResult,
        contributorsResult,
        citationsResult,
        citationScopesResult,
        mediaResult,
      ] = await Promise.all([
        client.query<CatalogAliasRow>(listCatalogAliasesSql, [[id]]),
        client.query<CatalogContributorRow>(listCatalogContributorsSql, [id]),
        client.query<CatalogCitationRow>(listCatalogCitationsSql, [id]),
        client.query<CatalogCitationScopeRow>(listCatalogCitationScopesSql, [
          id,
        ]),
        client.query<CatalogMediaRow>(this.mediaSql, [id]),
      ]);
      const aliases = mapAliasRows(aliasesResult.rows);

      return mapCatalogDetailRow(
        entry,
        aliases.get(id) ?? [],
        mapCitationRows(citationsResult.rows, citationScopesResult.rows),
        mapCatalogMediaRows(mediaResult.rows),
        contributorsResult.rows,
      );
    });
  }
}
