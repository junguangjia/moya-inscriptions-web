import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_SCALE_25K,
  catalogScaleCounts,
  catalogScaleIndexedStatements as statements,
  createCatalogScaleDatabase,
  explainCatalogScaleOn as plan,
  rolledBackCatalogScale as rolledBack,
  seedCatalogScale,
  type CatalogScaleCostedPlan,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W6: the plans of the statements App
 * migration A1 and CMS migration M2 index, at the 25k fixture. Local only,
 * never part of CI: like catalog-scale-bench.ts this is not a *.test.ts file,
 * so no suite collects it; catalog-scale-bench.config.mts runs it (about a
 * minute, mostly the seed; docs/development/catalog-scale-bench.md has the
 * command and the numbers). CI plans the same statements over a long history
 * on a small Catalog (catalog-publication-scope.test.ts).
 *
 * For each statement it asserts the plan shape and that the plan stays below
 * the JIT thresholds where it should, and prints one line per plan: the
 * indexes and Seq Scans, the top cost, the execution time (one run), the
 * shared blocks hit or read and the JIT time.
 * EXPLAIN ANALYZE runs on a rolled-back transaction as the role that runs the
 * statement. Environment: TEST_DATABASE_URL, as the PostgreSQL suites.
 */

const SLOW = 600_000;
const target = requireSyntheticTestDatabaseUrl();
const openPool = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const measured: string[] = [];
/** Records one plan for the summary printed when the file ends. */
const record = (name: string, read: CatalogScaleCostedPlan) => {
  const scans = read.nodes.filter((node) => /Scan/u.test(node));
  measured.push(
    `${name}: cost ${Math.round(read.cost)}, ${read.executionMs?.toFixed(1) ?? "-"} ms, ${read.sharedBlocks ?? "-"} shared blocks, JIT ${read.jit ? `${read.jitMs?.toFixed(1) ?? "?"} ms` : "no"}; ${[...new Set(scans)].join("; ")}`,
  );
  return read;
};

describe("catalog-scale-v1 W6: A1 and M2 index plans at 25k (local only)", () => {
  let fixture: CatalogScaleDatabase;
  const counts = catalogScaleCounts(CATALOG_SCALE_25K);

  beforeAll(async () => {
    fixture = await createCatalogScaleDatabase({
      target,
      openPool,
      label: "csindex_25k",
    });
    await seedCatalogScale(fixture, CATALOG_SCALE_25K);
  }, SLOW);

  afterAll(async () => {
    console.info(
      `A1 and M2 index plans at 25k:\n${measured.map((line) => `- ${line}`).join("\n")}`,
    );
    await fixture?.close();
  }, SLOW);

  it(
    "reads the live prepare projection through M2's index, not every intent ever prepared",
    async () => {
      const read = record(
        "snapshot private cursor",
        await rolledBack(fixture.prepare, (client) =>
          plan(client, statements.privateCursor, [], {
            analyze: true,
            buffers: true,
          }),
        ),
      );
      expect(read.rows).toBe(counts.livePrivateRows);
      expect(read.nodes).not.toContainEqual(
        "Seq Scan on catalog_delivery_intents",
      );
      expect(read.nodes).toContainEqual(
        "Bitmap Index Scan using catalog_delivery_intents_state_ended",
      );
      expect(read.nodes).toContainEqual(
        "Bitmap Index Scan using catalog_delivery_intents_expiry",
      );
      // Below jit_optimize_above_cost (500,000), which made a cheap statement
      // cost ~0.4 s in #322. It crosses jit_above_cost (100,000), so it is
      // JIT-compiled without optimization: the cost is the cursor's sort of
      // the members (estimated at 100 per intent, about 7 actual). Dropping
      // that ORDER BY or paging by intent_id is W3's follow-up.
      expect(read.cost).toBeLessThan(250_000);
      // Without the index the same read scans the whole history.
      const unindexed = record(
        "snapshot private cursor without M2's index",
        await rolledBack(fixture.setup, async (client) => {
          await client.query("DROP INDEX catalog_delivery_intents_state_ended");
          return plan(client, statements.privateCursor, [], {
            analyze: true,
            buffers: true,
          });
        }),
      );
      expect(unindexed.nodes).toContainEqual(
        "Seq Scan on catalog_delivery_intents",
      );
      expect(read.sharedBlocks!).toBeLessThan(unindexed.sharedBlocks!);
    },
    SLOW,
  );

  it(
    "keeps the cursor's read of the intents flat as the ended history grows fourfold",
    async () => {
      try {
        const [read, unindexed] = await rolledBack(
          fixture.setup,
          async (client) => {
            // Four more copies of the 14,800 intents that ended long before
            // R (59,200 more, 77,700 in all), as years of history would add.
            await client.query(
              `INSERT INTO public.catalog_delivery_intents
               SELECT copy.* FROM public.catalog_delivery_intents i, generate_series(1, 4) AS r,
                 LATERAL jsonb_populate_record(NULL::public.catalog_delivery_intents,
                   to_jsonb(i) || jsonb_build_object('id', md5('index-history:' || r || ':' || i.id)::uuid)) AS copy
               WHERE i.ended_at < now() - interval '96 hours'`,
            );
            await client.query("ANALYZE public.catalog_delivery_intents");
            const indexed = await plan(client, statements.privateCursor, [], {
              analyze: true,
              buffers: true,
            });
            await client.query(
              "DROP INDEX catalog_delivery_intents_state_ended",
            );
            return [
              indexed,
              await plan(client, statements.privateCursor, [], {
                analyze: true,
                buffers: true,
              }),
            ] as const;
          },
        );
        record("snapshot private cursor, 4x ended history", read);
        record(
          "snapshot private cursor, 4x ended history, without M2's index",
          unindexed,
        );
        expect(read.rows).toBe(counts.livePrivateRows);
        expect(read.nodes).toContainEqual(
          "Bitmap Index Scan using catalog_delivery_intents_state_ended",
        );
        expect(read.nodes).not.toContainEqual(
          "Seq Scan on catalog_delivery_intents",
        );
        expect(read.cost).toBeLessThan(250_000);
        expect(unindexed.nodes).toContainEqual(
          "Seq Scan on catalog_delivery_intents",
        );
        expect(read.sharedBlocks!).toBeLessThan(unindexed.sharedBlocks! / 4);
      } finally {
        // ANALYZE's page and row counts are not rolled back.
        await fixture.setup.query("ANALYZE public.catalog_delivery_intents");
      }
    },
    SLOW,
  );

  it(
    "tombstones through A1's partial index at 25k, and reads the mirror through it once history outgrows the live rows (PG17+)",
    async () => {
      const snapshotIds = (
        await fixture.setup.query<{ ids: string[] }>(
          "SELECT array_agg(DISTINCT intent_id)::text[] AS ids FROM public.catalog_delivery_live_prepare_media",
        )
      ).rows[0]!.ids;
      expect(snapshotIds).toHaveLength(counts.liveIntents);
      const at = new Date();

      // At the 25k shape (14,800 tombstones beside 3,700 live rows) the
      // tombstone pass reads the live rows only, while for the read a scan of
      // the 772-page table is the planner's cheaper choice.
      const tombstone = record(
        "sync tombstone",
        await rolledBack(fixture.app, (client) =>
          plan(client, statements.tombstone, [snapshotIds, at], {
            analyze: true,
            buffers: true,
          }),
        ),
      );
      expect(tombstone.nodes).toContainEqual(
        "Bitmap Index Scan using catalog_delivery_prepares_observed_live",
      );
      expect(tombstone.nodes).not.toContainEqual(
        "Seq Scan on catalog_delivery_prepares",
      );
      expect(tombstone.jit).toBe(false);
      const read = record(
        "sync mirror read",
        await rolledBack(fixture.app, (client) =>
          plan(client, statements.mirrorRead, [snapshotIds], {
            analyze: true,
            buffers: true,
          }),
        ),
      );
      expect(read.rows).toBe(counts.liveIntents);
      expect(read.jit).toBe(false);

      // With the history of one more such period (20,000 more tombstones)
      // PG18 reads the live rows and the snapshot's ids through the indexes,
      // leaving the tombstones alone. PG16's planner keeps the scan (about
      // 1,600 blocks, 5 ms), so there the read still grows with history,
      // slowly. Splitting the read into the observed-live index read and the
      // primary key lookup would make it use both indexes on either major.
      const major = Math.floor(
        Number(
          (
            await fixture.setup.query<{ server_version_num: string }>(
              "SHOW server_version_num",
            )
          ).rows[0]!.server_version_num,
        ) / 10_000,
      );
      try {
        const grown = record(
          "sync mirror read, 20,000 more tombstones",
          await rolledBack(fixture.setup, async (client) => {
            await client.query(
              `INSERT INTO community.catalog_delivery_prepares (intent_id, cms_document_id, catalog_id,
                 draft_revision, draft_fingerprint, manifest_sha256, recipe_manifest_sha256, media_count,
                 source_state, source_state_version, expires_at, observed_at, observed_live, ended_at,
                 created_at, updated_at)
               SELECT md5('scope-history:' || g)::uuid, 1, 'scale-catalog-1', 1, repeat('a', 64),
                 repeat('b', 64), repeat('c', 64), 7, 'cancelled', 2, now(), now(), false, now(), now(), now()
               FROM generate_series(1, 20000) AS g`,
            );
            await client.query("ANALYZE community.catalog_delivery_prepares");
            return plan(client, statements.mirrorRead, [snapshotIds], {
              analyze: true,
              buffers: true,
            });
          }),
        );
        expect(grown.rows).toBe(counts.liveIntents);
        if (major >= 17) {
          expect(grown.nodes).toContainEqual(
            "Bitmap Index Scan using catalog_delivery_prepares_observed_live",
          );
          expect(grown.nodes).not.toContainEqual(
            "Seq Scan on catalog_delivery_prepares",
          );
        }
        expect(grown.jit).toBe(false);
      } finally {
        // ANALYZE's page and row counts are not rolled back.
        await fixture.setup.query(
          "ANALYZE community.catalog_delivery_prepares",
        );
      }
    },
    SLOW,
  );

  it(
    "lists in-flight publications and pending marks through A1's partial indexes",
    async () => {
      // Three of the fixture's 100,800 published generations are being
      // withdrawn; the reconcile scope's first part lists their assets.
      const inFlight = record(
        "reconcile in-flight",
        await rolledBack(fixture.setup, async (client) => {
          await client.query(
            `UPDATE community.media_publications SET state = 'withdrawing', withdraw_requested_at = now()
             WHERE id IN (SELECT id FROM community.media_publications ORDER BY id LIMIT 3)`,
          );
          return plan(client, statements.inFlight, [], {
            analyze: true,
            buffers: true,
          });
        }),
      );
      expect(inFlight.rows).toBe(3);
      expect(inFlight.nodes).toContainEqual(
        expect.stringMatching(/using media_publications_in_flight/u),
      );
      expect(inFlight.nodes).not.toContainEqual(
        "Seq Scan on media_publications",
      );
      expect(inFlight.jit).toBe(false);

      // Every asset marked once and cleared, and 1,000 pending: the FIFO read
      // walks the pending rows in order, without a sort or the cleared ones.
      try {
        const queue = record(
          "reconcile pending marks",
          await rolledBack(fixture.setup, async (client) => {
            await client.query(
              `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, cleared_seq, reason, marked_at)
               SELECT id, 1, CASE WHEN row_number() OVER (ORDER BY id) <= 1000 THEN 0 ELSE 1 END,
                 'reference', now() - make_interval(secs => row_number() OVER (ORDER BY id))
               FROM community.catalog_media_assets`,
            );
            await client.query("ANALYZE community.catalog_publication_dirty");
            return plan(client, statements.pending, [], {
              analyze: true,
              buffers: true,
            });
          }),
        );
        expect(queue.rows).toBe(1000);
        expect(queue.nodes).toContainEqual(
          "Index Scan using catalog_publication_dirty_pending on catalog_publication_dirty",
        );
        expect(queue.nodes).not.toContainEqual(expect.stringMatching(/Sort/u));
        expect(queue.jit).toBe(false);
      } finally {
        await fixture.setup.query(
          "ANALYZE community.catalog_publication_dirty",
        );
      }
    },
    SLOW,
  );

  it(
    "reads a pinned rendition's publications through A1's rendition index, not every publication",
    async () => {
      // A job's inspection runs this once per pinned role (28 times for a
      // released 7-image record); the partial live index cannot serve it.
      const { rendition } = (
        await fixture.setup.query<{ rendition: string }>(
          "SELECT rendition_id AS rendition FROM community.media_publications WHERE state = 'published' ORDER BY id LIMIT 1",
        )
      ).rows[0]!;
      const read = record(
        "inspect rendition publications",
        await rolledBack(fixture.app, (client) =>
          plan(client, statements.renditionPublications, [rendition], {
            analyze: true,
            buffers: true,
          }),
        ),
      );
      expect(read.rows).toBe(1);
      expect(read.nodes).toContainEqual(
        expect.stringMatching(/using media_publications_rendition/u),
      );
      expect(read.nodes).not.toContainEqual("Seq Scan on media_publications");
      expect(read.jit).toBe(false);
      const unindexed = record(
        "inspect rendition publications without A1's index",
        await rolledBack(fixture.setup, async (client) => {
          await client.query(
            "DROP INDEX community.media_publications_rendition",
          );
          return plan(client, statements.renditionPublications, [rendition], {
            analyze: true,
            buffers: true,
          });
        }),
      );
      expect(unindexed.nodes).toContainEqual("Seq Scan on media_publications");
      expect(read.sharedBlocks!).toBeLessThan(unindexed.sharedBlocks! / 100);
    },
    SLOW,
  );
});
