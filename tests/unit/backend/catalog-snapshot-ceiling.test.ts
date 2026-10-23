import { createHash } from "node:crypto";

import {
  currentCatalogRecipePolicy,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import { createCatalogSync } from "@moya/backend-production/internal/publishing-catalog";
import {
  CATALOG_SNAPSHOT_FETCH_ROWS,
  CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
  CATALOG_SNAPSHOT_MAX_SOURCES,
  CATALOG_SNAPSHOT_WARN_RATIO,
  PostgresWorkPublishingAdapter,
  partitionCatalogPrepareRows,
  readCatalogSnapshotCursor,
  synchronizeCatalogDeliveryIntents,
} from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

import {
  snapshotCursors,
  type CursorFetch,
} from "./catalog-snapshot-cursor.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W3: one ceiling for the complete Catalog
 * snapshot, far above the planned 20,000 images, replaces the 10,000-source
 * and 20,000-row bounds. Each side is read through a cursor in batches of at
 * most 5,000 rows under the one REPEATABLE READ snapshot, never more than one
 * row past the ceiling; at ceiling + 1 the snapshot is null and the sync
 * writes nothing, never a partial list. The store's bounds derive from the
 * same module. Synthetic metadata only; no database.
 */

type Row = Record<string, unknown>;

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
const source = (n: number) => ({
  media_id: `synthetic-media-${n}`,
  object_key: `display/v1/media_${md5(`k${n}`)}/${"e".repeat(64)}.webp`,
  width: 1200,
  height: 800,
});
/** One prepared, current-policy intent naming `count` distinct images. */
const preparedRows = (intentId: string, count: number, from = 0): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    intent_id: intentId,
    catalog_document_id: 1,
    catalog_id: "synthetic-catalog-1",
    draft_revision: 1,
    draft_fingerprint: "a".repeat(64),
    media_manifest_sha256: "b".repeat(64),
    recipe_manifest_sha256: policy,
    state: "prepared",
    state_version: 1,
    media_count: count,
    expires_at: "2126-10-20T00:00:00.000Z",
    media_ordinal: i + 1,
    media_id: `synthetic-private-${from + i}`,
    object_key: `editorial/${"a".repeat(64)}/${md5(`p${from + i}`)}${md5(`q${from + i}`)}-${"c".repeat(64)}.jpg`,
    source_sha256: "c".repeat(64),
    width: 3000,
    height: 2000,
  }));
/** A header-only intent (no member), as the private view lists an ended one. */
const endedRow = (n: number): Row => ({
  intent_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
  catalog_document_id: 1 + (n % 1000),
  catalog_id: "synthetic-catalog-ended",
  draft_revision: 1,
  draft_fingerprint: "a".repeat(64),
  media_manifest_sha256: "b".repeat(64),
  recipe_manifest_sha256: policy,
  state: "cancelled",
  state_version: 2,
  media_count: 1,
  expires_at: "2126-10-20T00:00:00.000Z",
  media_ordinal: null,
  media_id: null,
  object_key: null,
  source_sha256: null,
  width: null,
  height: null,
});

/** A client whose declared cursor reads `rows`; every statement recorded. */
const cursorClient = (rows: readonly unknown[], failOnFetch?: number) => {
  const fetches: CursorFetch[] = [];
  const statements: string[] = [];
  const cursors = snapshotCursors(() => rows, fetches);
  return {
    fetches,
    statements,
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (
        failOnFetch !== undefined &&
        sql.startsWith("FETCH") &&
        fetches.length + 1 === failOnFetch
      )
        throw Object.assign(new Error("synthetic cursor failure"), {
          code: "57P01",
        });
      return cursors(sql)!;
    }),
  };
};

/**
 * Public and private pools over synthetic rows, as the snapshot reads them:
 * each client records its statements and is released once.
 */
const pools = (
  published: readonly unknown[],
  privateRows: readonly unknown[] | null,
  options: { readonly failPrivateFetch?: number } = {},
) => {
  const released = { public: 0, private: 0 };
  const statements = { public: [] as string[], private: [] as string[] };
  const fetches = { public: [] as CursorFetch[], private: [] as CursorFetch[] };
  const publicCursors = snapshotCursors(
    (sql) => (sql.includes("FROM catalog_media") ? published : undefined),
    fetches.public,
  );
  const publicQuery = async (sql: string) => {
    statements.public.push(sql);
    const cursor = publicCursors(sql);
    if (cursor) return cursor;
    if (sql.includes("clock_timestamp()"))
      return { rows: [{ at: new Date("2026-10-22T00:00:00.000Z") }] };
    if (sql.includes("pg_export_snapshot()"))
      return { rows: [{ id: "aaa-bbb-ccc" }] };
    if (["BEGIN", "ROLLBACK"].some((prefix) => sql.startsWith(prefix)))
      return { rows: [] };
    throw new Error("UNEXPECTED_PUBLIC_SQL");
  };
  const privateCursors = snapshotCursors(
    (sql) =>
      sql.startsWith("SELECT * FROM public.catalog_delivery_live_prepare_media")
        ? (privateRows ?? [])
        : undefined,
    fetches.private,
  );
  const privateQuery = async (sql: string) => {
    statements.private.push(sql);
    if (
      options.failPrivateFetch !== undefined &&
      sql.startsWith("FETCH") &&
      fetches.private.length + 1 === options.failPrivateFetch
    )
      throw Object.assign(new Error("synthetic cursor failure"), {
        code: "57P01",
      });
    const cursor = privateCursors(sql);
    if (cursor) return cursor;
    if (
      ["BEGIN", "ROLLBACK", "SET TRANSACTION"].some((prefix) =>
        sql.startsWith(prefix),
      )
    )
      return { rows: [] };
    throw new Error("UNEXPECTED_PRIVATE_SQL");
  };
  type Pools = Parameters<typeof readCatalogSourceSnapshot>;
  const prepareConnect = vi.fn(async () => ({
    query: privateQuery,
    release: () => {
      released.private += 1;
    },
  }));
  return {
    published: {
      connect: async () => ({
        query: publicQuery,
        release: () => {
          released.public += 1;
        },
      }),
    } as unknown as Pools[0],
    prepare:
      privateRows === null
        ? null
        : ({ connect: prepareConnect } as unknown as NonNullable<Pools[1]>),
    prepareConnect,
    released,
    statements,
    fetches,
  };
};

describe("the one Catalog snapshot ceiling", () => {
  it("is one named ceiling far above the planned Catalog, with the private bound derived from it", () => {
    expect(CATALOG_SNAPSHOT_MAX_SOURCES).toBe(200_000);
    expect(CATALOG_SNAPSHOT_MAX_SOURCES).toBeGreaterThanOrEqual(10 * 20_000);
    expect(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS).toBe(
      2 * CATALOG_SNAPSHOT_MAX_SOURCES,
    );
    expect(CATALOG_SNAPSHOT_FETCH_ROWS).toBe(5_000);
    expect(CATALOG_SNAPSHOT_WARN_RATIO).toBe(0.8);
  });

  it("reads a cursor in bounded batches and refuses one row past the ceiling as a whole", async () => {
    const max = 12_000;
    const rows = Array.from({ length: 20_000 }, (_, n) => ({ n }));
    for (const [count, complete] of [
      [0, true],
      [4_999, true],
      [5_000, true],
      [max, true],
      [max + 1, false],
      [20_000, false],
    ] as const) {
      const client = cursorClient(rows.slice(0, count));
      const read = await readCatalogSnapshotCursor<{ n: number }>(
        client,
        "catalog_unit_cursor",
        "SELECT n FROM synthetic",
        max,
      );
      if (complete) expect(read).toEqual(rows.slice(0, count));
      else expect(read).toBeNull();
      expect(client.statements[0]).toBe(
        "DECLARE catalog_unit_cursor NO SCROLL CURSOR FOR SELECT n FROM synthetic",
      );
      expect(client.statements.at(-1)).toBe("CLOSE catalog_unit_cursor");
      expect(
        Math.max(...client.fetches.map(({ wanted }) => wanted)),
      ).toBeLessThanOrEqual(CATALOG_SNAPSHOT_FETCH_ROWS);
      // Never a row more than the ceiling plus one is read.
      expect(
        client.fetches.reduce((sum, { returned }) => sum + returned, 0),
      ).toBe(Math.min(count, max + 1));
    }
  });

  it("refuses an invalid cursor or ceiling before any statement and passes a failed FETCH on", async () => {
    const client = cursorClient([]);
    await expect(
      readCatalogSnapshotCursor(client, "c; DROP TABLE x", "SELECT 1", 1),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      readCatalogSnapshotCursor(client, "catalog_unit_cursor", "SELECT 1", -1),
    ).rejects.toBeInstanceOf(TypeError);
    expect(client.query).not.toHaveBeenCalled();
    const failing = cursorClient(
      Array.from({ length: 12_000 }, (_, n) => ({ n })),
      2,
    );
    await expect(
      readCatalogSnapshotCursor(
        failing,
        "catalog_unit_cursor",
        "SELECT n FROM synthetic",
        20_000,
      ),
    ).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("the complete snapshot at the ceiling", () => {
  it("reads both sides through cursors under one exported snapshot, beyond the old 10,000 and 20,000 bounds", async () => {
    const published = Array.from({ length: 10_001 }, (_, n) => source(n));
    // 26,000 private rows: 13 prepared intents of 2,000 images each.
    const privateRows = Array.from({ length: 13 }, (_, i) =>
      preparedRows(
        `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
        2_000,
        i * 2_000,
      ),
    ).flat();
    const p = pools(published, privateRows);
    const snapshot = await readCatalogSourceSnapshot(p.published, p.prepare);
    expect(snapshot?.publishedSources).toHaveLength(10_001);
    expect(snapshot?.preparations).toHaveLength(13);
    expect(snapshot?.sources).toHaveLength(10_001 + 26_000);
    expect(snapshot?.privateRows).toBe(26_000);
    expect(p.statements.public.slice(0, 3)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT clock_timestamp() AS at",
      expect.stringMatching(
        /^DECLARE catalog_published_sources NO SCROLL CURSOR FOR\s+SELECT media_id, object_key, width, height\s+FROM catalog_media\s+ORDER BY media_id ASC, object_key ASC\s*$/u,
      ),
    ]);
    expect(p.statements.private.slice(0, 3)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET TRANSACTION SNAPSHOT 'aaa-bbb-ccc'",
      "DECLARE catalog_private_snapshot NO SCROLL CURSOR FOR SELECT * FROM public.catalog_delivery_live_prepare_media ORDER BY intent_id,media_ordinal NULLS FIRST",
    ]);
    for (const side of ["public", "private"] as const) {
      expect(p.statements[side].join("\n")).not.toMatch(/LIMIT/u);
      expect(
        Math.max(...p.fetches[side].map(({ wanted }) => wanted)),
      ).toBeLessThanOrEqual(CATALOG_SNAPSHOT_FETCH_ROWS);
      expect(p.statements[side].at(-1)).toBe("ROLLBACK");
    }
    expect(p.released).toEqual({ public: 1, private: 1 });
  });

  it("is null at one published row past the ceiling, before the private side is read", async () => {
    const row = source(0);
    const exact = pools(
      new Array<unknown>(CATALOG_SNAPSHOT_MAX_SOURCES).fill(row),
      [],
    );
    expect(
      (await readCatalogSourceSnapshot(exact.published, exact.prepare))
        ?.publishedSources,
    ).toHaveLength(CATALOG_SNAPSHOT_MAX_SOURCES);
    const over = pools(
      new Array<unknown>(CATALOG_SNAPSHOT_MAX_SOURCES + 1).fill(row),
      [],
    );
    expect(
      await readCatalogSourceSnapshot(over.published, over.prepare),
    ).toBeNull();
    expect(over.prepareConnect).not.toHaveBeenCalled();
    expect(over.released.public).toBe(1);
  });

  it("is null at one private row past its ceiling, and when the union passes the source ceiling", async () => {
    const over = pools(
      [source(0)],
      new Array<unknown>(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS + 1).fill(
        endedRow(1),
      ),
    );
    expect(
      await readCatalogSourceSnapshot(over.published, over.prepare),
    ).toBeNull();
    expect(
      over.fetches.private.reduce((sum, { returned }) => sum + returned, 0),
    ).toBe(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS + 1);
    expect(over.released).toEqual({ public: 1, private: 1 });
    // The published list and a prepared intent's 1,000 or 1,001 other images.
    const published = Array.from(
      { length: CATALOG_SNAPSHOT_MAX_SOURCES - 1_000 },
      (_, n) => source(n),
    );
    for (const [extra, complete] of [
      [1_000, true],
      [1_001, false],
    ] as const) {
      const p = pools(
        published,
        preparedRows("00000000-0000-4000-8000-000000000001", extra),
      );
      const snapshot = await readCatalogSourceSnapshot(p.published, p.prepare);
      if (complete)
        expect(snapshot?.sources).toHaveLength(CATALOG_SNAPSHOT_MAX_SOURCES);
      else expect(snapshot).toBeNull();
    }
  });

  it("writes nothing when the snapshot is incomplete or a FETCH fails, and warns near the ceiling", async () => {
    const counts = {
      referenced: 0,
      skipped: 0,
      created: 0,
      unreferenced: 0,
      enqueued: 0,
    };
    const port = { syncCatalogAssets: vi.fn(async () => counts) };
    const logger = { info: vi.fn(), error: vi.fn() };
    const now = new Date("2026-10-22T00:05:00.000Z");
    const over = pools(
      new Array<unknown>(CATALOG_SNAPSHOT_MAX_SOURCES + 1).fill(source(0)),
      [],
    );
    await createCatalogSync({
      listSources: async () => [],
      readSnapshot: () =>
        readCatalogSourceSnapshot(over.published, over.prepare),
      port,
      logger,
    }).run(now);
    expect(port.syncCatalogAssets).not.toHaveBeenCalled();
    expect(logger.error.mock.calls).toEqual([
      ["[media-worker] catalog sync skipped: incomplete snapshot"],
    ]);
    // A cursor that fails midway: the pass fails, both transactions roll
    // back and the store is never called.
    const failing = pools(
      [source(0)],
      Array.from({ length: 7 }, (_, n) => endedRow(n + 1)).concat(
        preparedRows("00000000-0000-4000-8000-00000000ffff", 2_000),
        preparedRows("00000000-0000-4000-8000-0000000fffff", 2_000, 2_000),
        preparedRows("00000000-0000-4000-8000-000000ffffff", 2_000, 4_000),
      ),
      { failPrivateFetch: 2 },
    );
    await expect(
      createCatalogSync({
        listSources: async () => [],
        readSnapshot: () =>
          readCatalogSourceSnapshot(failing.published, failing.prepare),
        port,
        logger,
      }).run(now),
    ).rejects.toMatchObject({ code: "57P01" });
    expect(port.syncCatalogAssets).not.toHaveBeenCalled();
    expect(failing.released).toEqual({ public: 1, private: 1 });
    expect(failing.statements.private.at(-1)).toBe("ROLLBACK");
    expect(failing.statements.public.at(-1)).toBe("ROLLBACK");

    // From 80% of a ceiling on, each pass logs its counts (never content).
    for (const [sources, privateRows, warned] of [
      [CATALOG_SNAPSHOT_MAX_SOURCES * 0.8 - 1, 0, false],
      [CATALOG_SNAPSHOT_MAX_SOURCES * 0.8, 0, true],
      [10, CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS * 0.8, true],
    ] as const) {
      logger.error.mockClear();
      const listed = new Array(sources).fill({
        mediaId: "synthetic-media",
        objectKey: "display/v1/media_x",
        width: 1,
        height: 1,
      });
      await createCatalogSync({
        listSources: async () => [],
        readSnapshot: async () => ({
          sources: listed,
          publishedSources: listed,
          preparations: [],
          privateRows,
          observedAt: now,
        }),
        port,
        logger,
      }).run(now);
      expect(logger.error.mock.calls).toEqual(
        warned
          ? [
              [
                `[media-worker] catalog sync near ceiling sources=${sources}/${CATALOG_SNAPSHOT_MAX_SOURCES} private_rows=${privateRows}/${CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS}`,
              ],
            ]
          : [],
      );
    }
  });
});

describe("the store's bounds follow the ceiling", () => {
  it("decodes more than the old 20,000 private rows and refuses more than the ceiling", () => {
    const rows = Array.from({ length: 20_001 }, (_, n) => endedRow(n + 1));
    const { intents, undecodableIntentIds } = partitionCatalogPrepareRows(rows);
    expect(intents).toHaveLength(20_001);
    expect(undecodableIntentIds).toEqual([]);
    expect(() =>
      partitionCatalogPrepareRows(
        new Array<Row>(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS + 1),
      ),
    ).toThrow("Catalog private source exceeds its bound");
  });

  it("mirrors more than the old 10,000 intents in one statement per kind, and refuses more than the ceiling", async () => {
    const { intents } = partitionCatalogPrepareRows(
      Array.from({ length: 10_001 }, (_, n) => endedRow(n + 1)),
    );
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        return { rows: [] };
      }),
    } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
    const undecodable = Array.from(
      { length: 20_001 },
      (_, n) => `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`,
    );
    expect(
      await synchronizeCatalogDeliveryIntents(
        db,
        intents,
        new Date("2126-10-22T00:00:00.000Z"),
        undecodable,
      ),
    ).toMatchObject({ refused: [], mismatched: [] });
    const inserts = statements.filter(({ sql }) =>
      /^\s*INSERT INTO community\.catalog_delivery_(prepares|media_refs)\b/u.test(
        sql,
      ),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values[0]).toHaveLength(10_001);
    // Read, watermark, header insert and the absence tombstone: never one
    // statement per intent.
    expect(statements.length).toBeLessThan(10);
    await expect(
      synchronizeCatalogDeliveryIntents(
        db,
        new Array(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS + 1),
        new Date("2126-10-22T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Catalog intent snapshot exceeds its bound");
    await expect(
      synchronizeCatalogDeliveryIntents(
        db,
        [],
        new Date("2126-10-22T00:00:00.000Z"),
        new Array<string>(CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS + 1).fill(
          undecodable[0]!,
        ),
      ),
    ).rejects.toThrow("Catalog undecodable intent list invalid");
  });

  it("syncs more than the old 10,000 sources and refuses more than the ceiling before any connection", async () => {
    const connect = vi.fn(async () => {
      throw Object.assign(new Error("synthetic store unavailable"), {
        code: "57P01",
      });
    });
    const adapter = new PostgresWorkPublishingAdapter({
      connect,
    } as unknown as ConstructorParameters<
      typeof PostgresWorkPublishingAdapter
    >[0]);
    const sources = (count: number) =>
      new Array(count).fill({
        mediaId: "synthetic-media",
        objectKey: "display/v1/media_x",
        width: 1,
        height: 1,
      });
    const options = { limit: 100, renditions: [] };
    const now = new Date("2126-10-22T00:00:00.000Z");
    await expect(
      adapter.syncCatalogAssets(
        sources(CATALOG_SNAPSHOT_MAX_SOURCES + 1),
        now,
        options,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(connect).not.toHaveBeenCalled();
    const accepted = adapter.syncCatalogAssets(sources(10_001), now, options);
    await expect(accepted).rejects.not.toBeInstanceOf(TypeError);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
