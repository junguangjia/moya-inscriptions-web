/*
 * catalog-scale-v1 (W3): the one ceiling of a complete Catalog snapshot. The
 * worker's sync reads the whole published Catalog media list and the live
 * private prepare rows under one REPEATABLE READ snapshot, in cursor batches,
 * and hands them to the App store in one transaction. Above the ceiling the
 * read returns null and the sync writes nothing: nothing is marked
 * unreferenced, tombstoned or queued from a partial list. Every other bound on
 * the sync path (the store's source and intent bounds, the private decoder)
 * derives from this module, so a list the reader accepts is never refused
 * further on. Per-request read batches (`CATALOG_PUBLISHED_PAIRS_MAX`, one
 * Detail's images) and per-intent bounds are not Catalog ceilings and stay
 * where they are.
 */

/**
 * The most Catalog media sources one complete snapshot holds: published
 * `catalog_media` rows, and the union of those with the members of live
 * prepared or requested intents. Ten times the 20,000-image scale the Catalog
 * is planned for; the sync logs a warning from 80% on.
 */
export const CATALOG_SNAPSHOT_MAX_SOURCES = 200_000;

/**
 * The most rows of the live private prepare projection one snapshot reads (a
 * member row per image of a live intent, a header row per other intent). The
 * same bound, counted in rows, caps decoded and undecodable intents.
 */
export const CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS =
  2 * CATALOG_SNAPSHOT_MAX_SOURCES;

/** Rows per cursor FETCH: bounded memory per round trip. */
export const CATALOG_SNAPSHOT_FETCH_ROWS = 5_000;

/** The share of a ceiling from which a sync logs that it is near. */
export const CATALOG_SNAPSHOT_WARN_RATIO = 0.8;

const CURSOR_NAME = /^[a-z][a-z0-9_]{0,62}$/u;

/** Whether `count` is at or above the warning share of `ceiling`. */
export const nearCatalogSnapshotCeiling = (count: number, ceiling: number) =>
  count >= Math.ceil(ceiling * CATALOG_SNAPSHOT_WARN_RATIO);

/**
 * Reads `sql` completely through a NO SCROLL cursor on `client`, which must
 * already be inside the snapshot's transaction, in batches of at most
 * `CATALOG_SNAPSHOT_FETCH_ROWS`. Never reads more than `max + 1` rows: at
 * `max + 1` it closes the cursor and returns null, never a partial list. Any
 * error propagates; the caller's ROLLBACK closes the cursor.
 */
export const readCatalogSnapshotCursor = async <Row>(
  client: {
    query(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
  },
  cursor: string,
  sql: string,
  max: number,
): Promise<Row[] | null> => {
  if (!CURSOR_NAME.test(cursor))
    throw new TypeError("Catalog snapshot cursor name invalid");
  if (!Number.isSafeInteger(max) || max < 0)
    throw new TypeError("Catalog snapshot ceiling invalid");
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`);
  const rows: Row[] = [];
  for (;;) {
    const wanted = Math.min(CATALOG_SNAPSHOT_FETCH_ROWS, max + 1 - rows.length);
    const page = (await client.query(`FETCH FORWARD ${wanted} FROM ${cursor}`))
      .rows as readonly Row[];
    for (const row of page) rows.push(row);
    if (rows.length > max) {
      await client.query(`CLOSE ${cursor}`);
      return null;
    }
    if (page.length < wanted) break;
  }
  await client.query(`CLOSE ${cursor}`);
  return rows;
};
