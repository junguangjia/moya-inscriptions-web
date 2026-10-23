import {
  createCatalogDeliveryFacts,
  createCatalogPublicationAuthority,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  catalogSyncIdentities,
  createCatalogSync,
  listPublishedCatalogSources,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CATALOG_SNAPSHOT_FETCH_ROWS,
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catalogAuthorityWithCopySet } from "../../unit/backend/catalog-copy-set.js";
import {
  CATALOG_SCALE_25K,
  CATALOG_SCALE_EPOCH,
  bumpCatalogScaleRecipe,
  catalogMediaView,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleIndexedStatements,
  catalogScaleIntentId,
  catalogScaleRecord,
  catalogScaleRenditionId,
  catalogScaleShape,
  clearCatalogScale,
  createCatalogScaleDatabase,
  createQueryRecorder,
  explainCatalogScale,
  seedCatalogScale,
  setCatalogMediaView,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { MediaId } from "@moya/contracts";

/*
 * catalog-scale-v1 (Issue #323) 1B, slice W0: the scale fixture at a reduced
 * size, so CI proves what the bench and the later 1B suites build on. The
 * seeded Catalog has the 25k fixture's parts (published records, drafts,
 * released, ended (old and recent) and live intents, the App's published
 * generations and intent mirror), every name is derived, each role reads only
 * its own relations, and the seed is a fixed point of this head's worker: a
 * sync of the live prepare projection (M2) changes no mirror row but its
 * observation time (the old ended intents are already its tombstones) and
 * writes no asset or job, and the authority desires exactly the published
 * generations, so reconcile schedules nothing. The tests share one seed and
 * run in order (the last ones change it). Content is synthetic.
 */

const SLOW = 120_000;
// 11 records (the last with 5 images), 4 drafts, 8 released, 20 ended (the
// last 4, one of each ended state, within R) and 4 live intents, every second
// one release_requested.
const SHAPE = catalogScaleShape(75, {
  draftRecords: 4,
  releasedIntents: 8,
  endedIntents: 20,
  recentEndedIntents: 4,
  livePrepares: 4,
  requestedEvery: 2,
});
const counts = catalogScaleCounts(SHAPE);
const imagesOf = (n: number) =>
  n === counts.records ? counts.lastRecordImages : SHAPE.imagesPerRecord;
const publishedImages = () =>
  Array.from({ length: counts.records }, (_, r) =>
    Array.from({ length: imagesOf(r + 1) }, (_, i) =>
      catalogScaleImage(r + 1, i + 1),
    ),
  ).flat();
const count = async (
  pool: CatalogScaleDatabase["setup"],
  sql: string,
  values: unknown[] = [],
) => Number((await pool.query<{ n: string }>(sql, values)).rows[0]!.n);

/** The App rows a worker pass must leave as they are: the intent mirror but
 * its observation time, and every asset, rendition, generation and job. */
const appRows = async (pool: CatalogScaleDatabase["setup"]) => {
  const tables = {
    prepares: [
      "to_jsonb(t) - 'observed_at' - 'updated_at'",
      "community.catalog_delivery_prepares",
      "intent_id",
    ],
    mediaRefs: [
      "to_jsonb(t)",
      "community.catalog_delivery_media_refs",
      "intent_id, ordinal",
    ],
    pins: [
      "to_jsonb(t)",
      "community.catalog_delivery_rendition_pins",
      "intent_id, ordinal, role",
    ],
    assets: ["to_jsonb(t)", "community.catalog_media_assets", "id"],
    renditions: ["to_jsonb(t)", "community.media_renditions", "id"],
    publicAssets: ["to_jsonb(t)", "community.media_public_assets", "id"],
    publications: ["to_jsonb(t)", "community.media_publications", "id"],
    jobs: ["to_jsonb(t)", "community.publishing_jobs", "id"],
  } as const;
  const rows: Record<string, unknown[]> = {};
  for (const [name, [row, table, order]] of Object.entries(tables))
    rows[name] = (
      await pool.query<{ row: unknown }>(
        `SELECT ${row} AS row FROM ${table} t ORDER BY ${order}`,
      )
    ).rows.map((r) => r.row);
  return rows;
};

// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csfix",
  });
  await seedCatalogScale(fixture, SHAPE);
}, SLOW);

afterAll(async () => {
  await fixture?.close();
}, SLOW);

// One seed, changed by the last tests: never shuffled or concurrent.
describe(
  "catalog-scale-v1 W0: the Catalog scale fixture",
  {
    concurrent: false,
    shuffle: false,
  },
  () => {
    it("sizes the 25k fixture as the issue names it", () => {
      expect(catalogScaleShape(25_200)).toEqual(CATALOG_SCALE_25K);
      expect(catalogScaleCounts(CATALOG_SCALE_25K)).toMatchObject({
        records: 3_600,
        publishedImages: 25_200,
        intents: 18_500,
        releasedMedia: 21_000,
        privateRows: 39_500,
        unionSources: 28_700,
        // The worker's snapshot reads the live projection only: 3,000
        // released, the 200 recent ended and 500 live intents; their 21,000
        // + 3,500 media rows and 200 header rows. The other 14,800 ended
        // intents stay in the full view and the mirror's tombstones.
        liveIntents: 3_700,
        livePrivateRows: 24_700,
      });
      expect(() => catalogScaleShape(70, { releasedIntents: 11 })).toThrow(
        TypeError,
      );
      expect(() =>
        catalogScaleShape(70, { endedIntents: 2, recentEndedIntents: 3 }),
      ).toThrow(TypeError);
      // In proportion, the recent ended intents never outnumber the ended.
      expect(
        catalogScaleShape(25_200, { endedIntents: 10 }).recentEndedIntents,
      ).toBe(10);
    });

    it("seeds the published view, the private view and the App rows of the shape", async () => {
      const { setup, publicRead, prepare } = fixture;
      expect(counts).toMatchObject({
        records: 11,
        lastRecordImages: 5,
        releasedMedia: 56,
        liveMedia: 28,
        privateRows: 104,
        unionSources: 103,
        // 8 released + 4 recent ended + 4 live intents; 56 + 28 media rows
        // and the 4 recent ended intents' header rows.
        liveIntents: 16,
        livePrivateRows: 88,
      });
      expect(
        await count(publicRead, "SELECT count(*) AS n FROM catalog_media"),
      ).toBe(75);
      // Draft records' images are in the CMS table only.
      expect(
        await count(setup, "SELECT count(*) AS n FROM public.catalogs_media"),
      ).toBe(75 + counts.draftImages);
      const view = async (name: string) =>
        (
          await prepare.query<{ state: string; members: boolean; n: string }>(
            `SELECT state, media_ordinal IS NOT NULL AS members, count(*) AS n
           FROM public.${name} GROUP BY 1, 2 ORDER BY 1, 2`,
          )
        ).rows.map((row) => [row.state, row.members, Number(row.n)]);
      // The full view: every intent, an ended one as one header row.
      expect(await view("catalog_delivery_prepare_media")).toEqual([
        ["cancelled", false, 5],
        ["expired", false, 5],
        ["prepared", true, 14],
        ["release_requested", true, 14],
        ["released", true, 56],
        ["superseded", false, 5],
        ["withdrawn", false, 5],
      ]);
      // The live projection (M2) keeps every released and live intent's
      // rows, but of the ended ones only the 4 that ended within R (one per
      // ended state); the 16 that ended at the epoch are past R.
      expect(await view("catalog_delivery_live_prepare_media")).toEqual([
        ["cancelled", false, 1],
        ["expired", false, 1],
        ["prepared", true, 14],
        ["release_requested", true, 14],
        ["released", true, 56],
        ["superseded", false, 1],
        ["withdrawn", false, 1],
      ]);
      // The CMS history: no ended intent ends after the release of a later
      // revision of its record (every released intent is revision 2, the
      // recent ended ones revision 3, the others ended at the release), and
      // a recent ended intent's lease follows from its end: an hour of it
      // used, or all 24 hours when it expired. The 16 that ended at the epoch
      // keep the epoch as creation and end.
      expect(
        (
          await setup.query(
            `SELECT e.ended_at > $1::timestamptz AS recent, count(*)::int AS n,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.catalog_delivery_intents r
                 WHERE r.catalog_document_id = e.catalog_document_id AND r.state = 'released'
                   AND r.draft_revision > e.draft_revision AND r.updated_at < e.ended_at))::int AS after_release,
               count(*) FILTER (WHERE e.expires_at = e.created_at + interval '24 hours'
                 AND e.ended_at - e.created_at = CASE WHEN e.state = 'expired'
                   THEN interval '24 hours' ELSE interval '1 hour' END
                 AND e.updated_at = e.ended_at)::int AS lease_from_end
             FROM public.catalog_delivery_intents e WHERE e.ended_at IS NOT NULL
             GROUP BY 1 ORDER BY 1`,
            [CATALOG_SCALE_EPOCH],
          )
        ).rows,
      ).toEqual([
        {
          recent: false,
          n: SHAPE.endedIntents - SHAPE.recentEndedIntents,
          after_release: 0,
          lease_from_end: 0,
        },
        {
          recent: true,
          n: SHAPE.recentEndedIntents,
          after_release: 0,
          lease_from_end: SHAPE.recentEndedIntents,
        },
      ]);
      // App: ready, published current-recipe sets of the published images; a
      // render backlog of the live images, which are private only.
      expect(
        (
          await setup.query(
            `SELECT state, unreferenced_since IS NOT NULL AS unreferenced, count(*)::int AS n
           FROM community.catalog_media_assets GROUP BY 1, 2 ORDER BY 1, 2`,
          )
        ).rows,
      ).toEqual([
        { state: "pending", unreferenced: true, n: 28 },
        { state: "ready", unreferenced: false, n: 75 },
      ]);
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.media_publications p JOIN community.media_renditions r ON r.id = p.rendition_id AND r.state = 'ready' WHERE p.state = 'published'",
        ),
      ).toBe(75 * 4);
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.publishing_jobs WHERE kind = 'catalog_render' AND state = 'queued'",
        ),
      ).toBe(28);
      // The mirror: every intent, each one's stored media, the released
      // intents' approved pins on their published generations. The intents
      // the live projection lists are observed live; the rest are the
      // tombstones the sync leaves by absence: exactly the ended intents
      // that ended at the epoch, each ended.
      expect(
        (
          await setup.query(
            `SELECT observed_live AS live, source_state IN ('cancelled', 'superseded', 'expired', 'withdrawn') AS terminal,
               ended_at IS NOT NULL AS ended, count(*)::int AS n
             FROM community.catalog_delivery_prepares GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
          )
        ).rows,
      ).toEqual([
        {
          live: false,
          terminal: true,
          ended: true,
          n: SHAPE.endedIntents - SHAPE.recentEndedIntents,
        },
        {
          live: true,
          terminal: false,
          ended: false,
          n: SHAPE.releasedIntents + SHAPE.livePrepares,
        },
        {
          live: true,
          terminal: true,
          ended: true,
          n: SHAPE.recentEndedIntents,
        },
      ]);
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.catalog_delivery_prepares WHERE observed_live",
        ),
      ).toBe(counts.liveIntents);
      let ended = 0;
      for (let k = 1; k <= SHAPE.endedIntents; k += 1)
        ended += imagesOf(((k - 1) % counts.records) + 1);
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.catalog_delivery_media_refs",
        ),
      ).toBe(counts.releasedMedia + ended + counts.liveMedia);
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.catalog_delivery_rendition_pins WHERE public_generation_id IS NOT NULL",
        ),
      ).toBe(counts.releasedMedia * 4);
    });

    it("derives every name from its record and image number", async () => {
      const { setup, publicRead, prepare } = fixture;
      const expected = publishedImages();
      const rows = (
        await publicRead.query<{
          media_id: string;
          object_key: string;
          width: number;
          height: number;
          catalog_id: string;
        }>(
          "SELECT media_id, object_key, width, height, catalog_id FROM catalog_media",
        )
      ).rows;
      const key = (image: {
        mediaId: string;
        objectKey: string;
        width: number;
        height: number;
      }) =>
        JSON.stringify([
          image.mediaId,
          image.objectKey,
          image.width,
          image.height,
        ]);
      expect(
        rows
          .map((row) =>
            key({
              mediaId: row.media_id,
              objectKey: row.object_key,
              width: row.width,
              height: row.height,
            }),
          )
          .sort(),
      ).toEqual(expected.map(key).sort());
      const last = catalogScaleImage(11, 5);
      expect(
        rows.find((row) => row.media_id === last.mediaId)?.catalog_id,
      ).toBe(catalogScaleRecord(11).catalogId);
      expect(
        (
          await setup.query<{ id: string }>(
            "SELECT id FROM community.catalog_media_assets WHERE state = 'ready' ORDER BY id",
          )
        ).rows.map((row) => row.id),
      ).toEqual(expected.map((image) => image.assetId).sort());
      expect(
        (
          await setup.query<{ id: string }>(
            "SELECT id FROM community.media_renditions WHERE catalog_asset_id = $1 ORDER BY id",
            [last.assetId],
          )
        ).rows.map((row) => row.id),
      ).toEqual(
        ["thumb", "cover", "display", "viewer"]
          .map((role) => catalogScaleRenditionId(last.assetId, role))
          .sort(),
      );
      const intents = (
        await prepare.query<{
          intent_id: string;
          catalog_id: string;
          state: string;
        }>(
          "SELECT DISTINCT intent_id, catalog_id, state FROM public.catalog_delivery_prepare_media WHERE intent_id = ANY($1::uuid[]) ORDER BY catalog_id",
          [
            [
              catalogScaleIntentId("released", 3),
              catalogScaleIntentId("ended", 12),
              catalogScaleIntentId("live", 2),
            ],
          ],
        )
      ).rows;
      // Ended intents cycle over the published records and the four ended
      // states: the 12th is record 1's, withdrawn.
      expect(intents).toEqual([
        {
          intent_id: catalogScaleIntentId("ended", 12),
          catalog_id: catalogScaleRecord(1).catalogId,
          state: "withdrawn",
        },
        {
          intent_id: catalogScaleIntentId("live", 2),
          catalog_id: catalogScaleRecord(counts.records + 2).catalogId,
          state: "release_requested",
        },
        {
          intent_id: catalogScaleIntentId("released", 3),
          catalog_id: catalogScaleRecord(3).catalogId,
          state: "released",
        },
      ]);
    });

    it("keeps each identity to its own relations", async () => {
      const { app, publicRead, prepare } = fixture;
      const refused = { code: "42501" };
      await expect(
        publicRead.query("SELECT 1 FROM public.catalog_delivery_prepare_media"),
      ).rejects.toMatchObject(refused);
      await expect(
        publicRead.query("SELECT 1 FROM community.catalog_media_assets"),
      ).rejects.toMatchObject(refused);
      await expect(
        prepare.query("SELECT 1 FROM public.catalog_media"),
      ).rejects.toMatchObject(refused);
      await expect(
        app.query("SELECT 1 FROM public.catalog_delivery_intents"),
      ).rejects.toMatchObject(refused);
      await expect(
        app.query("SELECT 1 FROM public.catalog_delivery_prepare_media"),
      ).rejects.toMatchObject(refused);
      // The App role has no TEMPORARY and no DELETE on the asset table.
      await expect(
        app.query("CREATE TEMP TABLE scale_probe (id text)"),
      ).rejects.toMatchObject(refused);
      await expect(
        app.query("DELETE FROM community.catalog_media_assets WHERE false"),
      ).rejects.toMatchObject(refused);
    });

    it("is a fixed point of this head's sync, authority and reconcile", async () => {
      const { app, publicRead, prepare, setup } = fixture;
      const seeded = await appRows(setup);
      // The mirror holds every intent, tombstones included.
      expect(seeded.prepares).toHaveLength(counts.intents);
      expect(seeded.pins).toHaveLength(counts.releasedMedia * 4);
      const snapshot = await readCatalogSourceSnapshot(publicRead, prepare);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.publishedSources).toHaveLength(75);
      expect(snapshot!.sources).toHaveLength(counts.unionSources);
      // The snapshot reads the live projection: it decodes the intents the
      // mirror observes live, and none of its tombstones, so the sync below
      // neither ends nor revives one.
      expect(snapshot!.privateRows).toBe(counts.livePrivateRows);
      expect(snapshot!.preparations).toHaveLength(counts.liveIntents);
      expect(
        snapshot!.preparations!.map(({ intentId }) => intentId).sort(),
      ).toEqual(
        (
          await setup.query<{ intent_id: string }>(
            "SELECT intent_id FROM community.catalog_delivery_prepares WHERE observed_live ORDER BY intent_id",
          )
        ).rows.map((row) => row.intent_id),
      );
      const recentEnded = Array.from(
        { length: SHAPE.recentEndedIntents },
        (_, j) => catalogScaleIntentId("ended", SHAPE.endedIntents - j),
      );
      expect(
        snapshot!.preparations!.filter(({ intentId }) =>
          recentEnded.includes(intentId),
        ),
      ).toHaveLength(SHAPE.recentEndedIntents);
      expect(
        snapshot!.preparations!.some(
          ({ intentId }) => intentId === catalogScaleIntentId("ended", 1),
        ),
      ).toBe(false);
      expect(snapshot!.undecodableIntentIds).toBeUndefined();

      const recorder = createQueryRecorder();
      const port = new PostgresWorkPublishingAdapter(
        recorder.wrap("app", app),
        { publication: { allowPublish: () => true, isPublic: () => true } },
      );
      const passes: unknown[] = [];
      const lines: string[] = [];
      await createCatalogSync({
        listSources: () => listPublishedCatalogSources(publicRead),
        readSnapshot: () => readCatalogSourceSnapshot(publicRead, prepare),
        port: {
          syncCatalogAssets: async (sources, now, options) => {
            const result = await port.syncCatalogAssets(
              sources,
              now,
              options as Parameters<typeof port.syncCatalogAssets>[2],
            );
            passes.push(result);
            return result;
          },
        },
        logger: {
          info: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      }).run(new Date());
      // The sync's mirror read is the copy the index plans check, verbatim.
      expect(recorder.queries.map((q) => q.sql)).toContain(
        catalogScaleIndexedStatements.mirrorRead,
      );
      expect(passes).toEqual([
        {
          referenced: counts.unionSources,
          skipped: 0,
          created: 0,
          unreferenced: 0,
          enqueued: 0,
        },
      ]);
      expect(lines).toEqual([]);
      // Nothing but the mirror's observation times may change.
      expect(await appRows(setup)).toEqual(seeded);

      const authority = catalogAuthorityWithCopySet(publicRead, prepare, app);
      const published = (
        await setup.query<{ rendition_id: string }>(
          "SELECT rendition_id FROM community.media_publications WHERE state = 'published' ORDER BY rendition_id",
        )
      ).rows.map((row) => row.rendition_id);
      expect([...(await authority.copyRenditionIds())].sort()).toEqual(
        published,
      );
      const adapter = new PostgresMediaPublicationAdapter(app, {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: authority,
      });
      expect(await adapter.reconcile(new Date(), true, 500)).toEqual({
        publish: 0,
        withdraw: 0,
      });

      // A record's facts are its complete published sets.
      const record = Array.from({ length: 7 }, (_, i) =>
        catalogScaleImage(1, i + 1),
      );
      const facts = await createCatalogDeliveryFacts(
        publicRead,
        app,
      )(
        record.map(({ mediaId, objectKey }) => ({
          mediaId: mediaId as MediaId,
          objectKey,
        })),
      );
      for (const image of record)
        expect(
          facts
            .get(JSON.stringify([image.mediaId, image.objectKey]))
            ?.renditions?.map((r) => r.key)
            .sort(),
        ).toEqual(
          ["thumb", "cover", "display", "viewer"]
            .map((role) => catalogScaleRenditionId(image.assetId, role))
            .sort(),
        );

      // One job's fence of a released record's image.
      const lease = await authority.acquire(record[0]!.assetId);
      try {
        expect([...lease.renditionIds].sort()).toEqual(
          ["thumb", "cover", "display", "viewer"]
            .map((role) => catalogScaleRenditionId(record[0]!.assetId, role))
            .sort(),
        );
        expect(await lease.current()).toBe(true);
        expect(await lease.authorized()).toBe(true);
      } finally {
        await lease.release();
      }
      expect(await appRows(setup)).toEqual(seeded);
    });

    it("records statements per pool and explains them as their role", async () => {
      const { publicRead, prepare, app } = fixture;
      const recorder = createQueryRecorder();
      const record = Array.from({ length: 7 }, (_, i) =>
        catalogScaleImage(2, i + 1),
      );
      await createCatalogDeliveryFacts(
        recorder.wrap("cms", publicRead),
        recorder.wrap("app", app),
      )(
        record.map(({ mediaId, objectKey }) => ({
          mediaId: mediaId as MediaId,
          objectKey,
        })),
      );
      expect(recorder.counts()).toEqual({
        statements: { cms: 1, app: 1 },
        connects: {},
      });
      const [check] = recorder.queries;
      expect(check).toMatchObject({ pool: "cms", rows: 7, failed: false });
      expect(check!.values).toEqual([
        record.map((image) => image.mediaId),
        record.map((image) => image.objectKey),
      ]);
      // Replayed as the public reader; at this size any plan may scan.
      const plan = await explainCatalogScale(
        publicRead,
        check!.sql,
        check!.values,
        { analyze: true },
      );
      expect(
        plan.nodes.some((node) => node.endsWith(" on catalogs_media")),
      ).toBe(true);
      expect(plan.executionMs).toBeGreaterThanOrEqual(0);

      // Statements of clients from pool.connect, as the snapshot, the sync,
      // plans() and the fences run theirs. The snapshot (W3) holds one
      // REPEATABLE READ transaction per role on the exported snapshot and
      // reads each side through a NO SCROLL cursor: DECLARE, a FETCH per
      // CATALOG_SNAPSHOT_FETCH_ROWS rows until a short page, CLOSE. Both
      // sides here are below one page (75 published rows, 88 live private
      // rows), so each side runs one FETCH: 7 CMS and 6 prepare statements
      // where d51114c5 ran 5 and 4 (one plain SELECT per side).
      recorder.reset();
      expect(
        await readCatalogSourceSnapshot(
          recorder.wrap("cms", publicRead),
          recorder.wrap("prepare", prepare),
        ),
      ).not.toBeNull();
      expect(counts.livePrivateRows).toBeLessThan(CATALOG_SNAPSHOT_FETCH_ROWS);
      const kinds = (pool: string) =>
        recorder.queries
          .filter((query) => query.pool === pool)
          .map(
            (query) =>
              query.sql.match(
                /^(BEGIN|SELECT clock_timestamp|SELECT pg_export_snapshot|SET TRANSACTION SNAPSHOT|DECLARE|FETCH|CLOSE|ROLLBACK)/u,
              )?.[0] ?? query.sql,
          );
      expect(kinds("cms")).toEqual([
        "BEGIN",
        "SELECT clock_timestamp",
        "DECLARE",
        "FETCH",
        "CLOSE",
        "SELECT pg_export_snapshot",
        "ROLLBACK",
      ]);
      expect(kinds("prepare")).toEqual([
        "BEGIN",
        "SET TRANSACTION SNAPSHOT",
        "DECLARE",
        "FETCH",
        "CLOSE",
        "ROLLBACK",
      ]);
      expect(recorder.counts()).toEqual({
        statements: { cms: 7, prepare: 6 },
        connects: { cms: 1, prepare: 1 },
      });
      // The private cursor reads the live projection, and its one FETCH
      // returns every live row; the published one every catalog_media row.
      const fetched = (pool: string) =>
        recorder.queries.find(
          (query) => query.pool === pool && query.sql.startsWith("FETCH"),
        )?.rows;
      expect(fetched("cms")).toBe(75);
      expect(fetched("prepare")).toBe(counts.livePrivateRows);
      expect(
        recorder.queries.find(
          (query) =>
            query.pool === "prepare" && query.sql.startsWith("DECLARE"),
        )?.sql,
      ).toContain("FROM public.catalog_delivery_live_prepare_media");
      recorder.reset();
      const client = await recorder.wrap("probe", app).connect();
      try {
        await client.query("SELECT $1::int AS n", [7]);
        await expect(
          client.query("SELECT 1 FROM public.catalog_delivery_intents"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        client.release();
      }
      expect(recorder.queries).toMatchObject([
        { pool: "probe", sql: "SELECT $1::int AS n", values: [7], rows: 1 },
        { pool: "probe", values: undefined, rows: null, failed: true },
      ]);
      expect(recorder.queries[0]!.failed).toBe(false);
    });

    it("switches catalog_media between its fenced and keyed definitions with the same rows", async () => {
      const rows = async () =>
        (
          await fixture.publicRead.query(
            "SELECT * FROM catalog_media ORDER BY media_id, object_key",
          )
        ).rows;
      expect(await catalogMediaView(fixture)).toBe("keyed");
      const keyed = await rows();
      await setCatalogMediaView(fixture, "fenced");
      expect(await catalogMediaView(fixture)).toBe("fenced");
      expect(
        await count(
          fixture.setup,
          "SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'catalogs_media_media_id_lookup_idx'",
        ),
      ).toBe(0);
      expect(await rows()).toEqual(keyed);
      await setCatalogMediaView(fixture, "keyed");
      expect(await catalogMediaView(fixture)).toBe("keyed");
      expect(await rows()).toEqual(keyed);
    });

    it("records the N3 mid-state of a recipe bump, which reconcile copies without withdrawing", async () => {
      const { app, publicRead, prepare, setup } = fixture;
      expect(await bumpCatalogScaleRecipe(fixture, { first: 1, last: 2 })).toBe(
        14,
      );
      expect(
        (
          await setup.query(
            `SELECT r.state, r.recipe_digest = '0000000000000000' AS old, p.state AS publication, count(*)::int AS n
           FROM community.media_renditions r
           JOIN community.catalog_media_assets a ON a.id = r.catalog_asset_id
           LEFT JOIN community.media_publications p ON p.rendition_id = r.id
           WHERE a.media_id LIKE 'scale-media-1-%' OR a.media_id LIKE 'scale-media-2-%'
           GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
          )
        ).rows,
      ).toEqual([
        { state: "ready", old: false, publication: null, n: 56 },
        { state: "released", old: true, publication: "published", n: 56 },
      ]);
      const adapter = new PostgresMediaPublicationAdapter(app, {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: createCatalogPublicationAuthority(
          publicRead,
          prepare,
          app,
        ),
      });
      expect(await adapter.reconcile(new Date(), true, 500)).toEqual({
        publish: 14,
        withdraw: 0,
      });
    });

    it("clears either side and seeds another shape from an empty App", async () => {
      const { app, publicRead, prepare, setup } = fixture;
      await clearCatalogScale(fixture, { cms: false });
      expect(
        await count(
          setup,
          "SELECT count(*) AS n FROM community.media_renditions",
        ),
      ).toBe(0);
      expect(
        await count(publicRead, "SELECT count(*) AS n FROM catalog_media"),
      ).toBe(75);
      await expect(seedCatalogScale(fixture, SHAPE)).rejects.toThrow(
        "Clear the Catalog scale fixture before seeding it",
      );
      await clearCatalogScale(fixture);
      expect(
        await count(publicRead, "SELECT count(*) AS n FROM catalog_media"),
      ).toBe(0);
      const small = catalogScaleShape(14, {
        draftRecords: 1,
        releasedIntents: 1,
        endedIntents: 3,
        livePrepares: 1,
        requestedEvery: 1,
      });
      await seedCatalogScale(fixture, small, { app: false });
      // The first sync of an empty App creates every source's asset and job,
      // and leaves the private-only images unreferenced.
      const port = new PostgresWorkPublishingAdapter(app, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      const snapshot = await readCatalogSourceSnapshot(publicRead, prepare);
      expect(
        await port.syncCatalogAssets(snapshot!.sources, snapshot!.observedAt, {
          limit: 100,
          renditions: catalogSyncIdentities(),
          snapshot: snapshot!,
        }),
      ).toEqual({
        referenced: 21,
        skipped: 0,
        created: 21,
        unreferenced: 7,
        enqueued: 21,
      });
    });

    it("bumps the published images of a record range only", async () => {
      await clearCatalogScale(fixture);
      // Two published records and one draft whose live images are ready.
      await seedCatalogScale(
        fixture,
        catalogScaleShape(14, {
          draftRecords: 1,
          releasedIntents: 1,
          endedIntents: 0,
          livePrepares: 1,
          requestedEvery: 1,
        }),
        { liveAssets: "ready" },
      );
      expect(
        await count(
          fixture.setup,
          "SELECT count(*) AS n FROM community.catalog_media_assets WHERE state = 'ready'",
        ),
      ).toBe(21);
      expect(await bumpCatalogScaleRecipe(fixture, { first: 1, last: 3 })).toBe(
        14,
      );
    });
  },
);
