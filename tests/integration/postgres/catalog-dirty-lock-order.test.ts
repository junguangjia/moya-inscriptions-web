import { createCatalogPublicationAuthority } from "@moya/backend-production/internal/catalog-delivery";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  applyCatalogMembership,
  markCatalogPublicationDirty,
  readCatalogMembershipState,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  catalogScaleImage,
  catalogScaleShape,
  clearCatalogScale,
  createCatalogScaleDatabase,
  seedCatalogScale,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

type Pool = ReturnType<typeof createPostgresPool>;

/*
 * catalog-scale-v1 (Issue #323) 1B, the integration of W7 and W8: one lock
 * order for every transaction that writes the scoped reconcile's dirty queue
 * (App migration A1). The catalog_reconcile_state row first (a reconcile
 * pass, the membership step), then asset rows (the sync, a recorded render),
 * then the dirty rows, by one statement in asset id order, before any other
 * dirty-row write. Each case holds one transaction at the point where the
 * other order would wait on it, through the real adapter and the real App
 * role, and requires both to commit (no 40P01):
 * - a reconcile pass that settles marks while a marker (the sync's one
 *   sorted statement) has inserted a lower asset's first mark and goes on to
 *   a higher one the pass clears: the pass must take every dirty row it
 *   writes, new rows included, in that one ordered statement, not lock the
 *   existing rows first and insert the new ones after;
 * - the membership step, which marks and stores its fingerprint while a pass
 *   holds the state row: it must take the state row before its marks, as a
 *   pass does, not mark first and wait for the row with the marks held.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 600_000;
// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "cslock",
  });
}, SLOW);

afterAll(async () => {
  await fixture?.close();
}, SLOW);

/** Ten records of seven published images: no intents, no drafts. */
const reseed = async () => {
  await clearCatalogScale(fixture);
  await seedCatalogScale(
    fixture,
    catalogScaleShape(70, {
      draftRecords: 0,
      releasedIntents: 0,
      endedIntents: 0,
      recentEndedIntents: 0,
      livePrepares: 0,
    }),
  );
};

/** A reconcile adapter over every asset (K above the Catalog), on `pool`. */
const adapter = (pool: Pool = fixture.app) =>
  new PostgresMediaPublicationAdapter(pool, {
    isPublic: () => true,
    allowPublish: () => true,
    catalogAuthority: createCatalogPublicationAuthority(
      fixture.publicRead,
      fixture.prepare,
      fixture.app,
    ),
    catalogScope: { max: 200 },
  });

/** `pool`, whose transactions stop after `sql` returns until `gate` opens. */
const pausedAfter = (
  pool: Pool,
  sql: string,
  gate: Promise<void>,
  entered: () => void,
): Pool =>
  new Proxy(pool, {
    get(inner, key) {
      if (key === "connect")
        return async () => {
          const client = await inner.connect();
          return new Proxy(client, {
            get(held, name) {
              if (name === "query")
                return async (text: string, values?: unknown[]) => {
                  const result = await held.query(text, values);
                  if (text === sql) {
                    entered();
                    await gate;
                  }
                  return result;
                };
              const value = Reflect.get(held, name, held) as unknown;
              return typeof value === "function" ? value.bind(held) : value;
            },
          });
        };
      const value = Reflect.get(inner, key, inner) as unknown;
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });

/** Waits until a session of the fixture database other than `except` waits
 * on a lock. */
const lockWaitOtherThan = async (except: readonly number[]) => {
  for (const started = Date.now(); ;) {
    const waiting = (
      await fixture.setup.query<{ waiting: number }>(
        `SELECT count(*)::integer AS waiting FROM pg_locks l
         JOIN pg_stat_activity s ON s.pid = l.pid
         WHERE NOT l.granted AND s.datname = current_database()
           AND NOT l.pid = ANY($1::integer[])`,
        [except],
      )
    ).rows[0]!.waiting;
    if (waiting > 0) return;
    if (Date.now() - started > 60_000)
      throw new Error("synthetic lock wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const settled = async <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: {
      code?: string;
      cause?: { code?: string };
      message?: string;
    }) => ({
      ok: false as const,
      error: error.cause?.code ?? error.code ?? error.message ?? "failed",
    }),
  );

const pendingRows = async () =>
  (
    await fixture.setup.query<{ asset_id: string; reason: string }>(
      "SELECT asset_id, reason FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY asset_id",
    )
  ).rows;

describe(
  "catalog-scale-v1 1B: one lock order for the dirty queue",
  { timeout: SLOW },
  () => {
    it("settles a pass while a sorted mark inserts a lower asset's first mark and goes on to a higher one the pass clears", async () => {
      await reseed();
      // Record 1 is taken down: the pass schedules a withdrawal for each of
      // its images and keeps them marked. None has a mark row yet.
      await fixture.setup.query(
        "UPDATE public.catalogs SET _status='draft' WHERE id = 1",
      );
      const down = Array.from(
        { length: 7 },
        (_, i) => catalogScaleImage(1, i + 1).assetId,
      ).sort();
      const lower = down[0]!;
      // A pending mark above it that the pass reads, plans and clears.
      const higher = (
        await fixture.setup.query<{ id: string }>(
          "SELECT id FROM community.catalog_media_assets WHERE id > $1 AND NOT id = ANY($2::text[]) ORDER BY id DESC LIMIT 1",
          [lower, down],
        )
      ).rows[0]!.id;
      await fixture.setup.query(
        `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at)
         VALUES ($1, 1, 'reference', now())`,
        [higher],
      );
      // The marker (the sync's one sorted statement, here its two halves)
      // has inserted the lower asset's first mark and not committed.
      const marker = await fixture.app.connect();
      let pass: Promise<{ ok: boolean }> | undefined;
      try {
        await marker.query("BEGIN");
        const markerPid = (
          await marker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        await markCatalogPublicationDirty(
          marker,
          new Map([[lower, { reason: "reference", urgent: false }]]),
          new Date(),
        );
        pass = settled(adapter().reconcile(new Date(), true, 500));
        // The pass waits for that new row...
        await lockWaitOtherThan([markerPid]);
        // ...holding no dirty row above it, so the marker goes on to the
        // higher one and commits, and then the pass goes on.
        const higherMark = await settled(
          markCatalogPublicationDirty(
            marker,
            new Map([[higher, { reason: "reference", urgent: false }]]),
            new Date(),
          ),
        );
        await marker.query(higherMark.ok ? "COMMIT" : "ROLLBACK");
        expect(higherMark).toEqual({ ok: true, value: 1 });
      } finally {
        await marker.query("ROLLBACK").catch(() => undefined);
        marker.release();
      }
      expect(await pass).toEqual({
        ok: true,
        value: { publish: 0, withdraw: 7 },
      });
      // The withdrawals keep their marks; the higher asset's mark, made
      // while the pass planned, is not the one it read, so it stays.
      expect((await pendingRows()).map((row) => row.asset_id)).toEqual(
        [...down, higher].sort(),
      );
    });

    it("stores a membership observation while a pass holds the state row and then clears a mark the observation makes", async () => {
      await reseed();
      const asset = catalogScaleImage(2, 3).assetId;
      const bucket = asset.slice(14, 16);
      // A pending mark the pass reads, plans and clears (it is served and
      // published: no job).
      await fixture.setup.query(
        `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at)
         VALUES ($1, 1, 'rendition', now())`,
        [asset],
      );
      // An observation in which the CMS no longer publishes that asset:
      // the step marks it, as it is served.
      const others = (
        await fixture.setup.query<{ id: string }>(
          "SELECT id FROM community.catalog_media_assets WHERE substr(id, 15, 2) = $1 AND id <> $2 ORDER BY id",
          [bucket, asset],
        )
      ).rows.map((row) => row.id);
      const previous = await readCatalogMembershipState(fixture.app);
      const observation = {
        observedAt: new Date(),
        previous,
        public: {
          count: 69,
          sum: "1",
          diff: { buckets: [bucket], members: others },
        },
        private: null,
      };
      // The pass holds the state row (its first lock) and pauses there.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let entered!: () => void;
      const holding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pass = settled(
        adapter(
          pausedAfter(
            fixture.app,
            "SELECT sweep_cursor,policy_digest FROM community.catalog_reconcile_state WHERE id FOR UPDATE",
            gate,
            () => entered(),
          ),
        ).reconcile(new Date(), true, 500),
      );
      let step: Promise<{ ok: boolean }> | undefined;
      try {
        await holding;
        step = settled(
          applyCatalogMembership(fixture.app, observation, new Date()),
        );
        // The step waits for the state row...
        await lockWaitOtherThan([]);
      } finally {
        // ...and the pass goes on to settle its marks.
        open();
      }
      expect(await pass).toEqual({
        ok: true,
        value: { publish: 0, withdraw: 0 },
      });
      expect(await step).toEqual({
        ok: true,
        value: { public: 1, private: 0, boundaries: 0 },
      });
      // The pass cleared the mark it read; the step's mark, after it, is
      // pending.
      expect(await pendingRows()).toEqual([
        { asset_id: asset, reason: "public_membership" },
      ]);
    });
  },
);
