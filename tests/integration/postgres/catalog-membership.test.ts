import { createHash, randomBytes } from "node:crypto";

import { readCatalogSourceSnapshot } from "@moya/backend-production/internal/catalog-delivery";
import {
  CATALOG_MEMBERSHIP_INTERVAL_MS,
  catalogPrivateMembershipBucketsSql,
  catalogPrivateMembershipMembersSql,
  catalogPublicMembershipBucketsSql,
  catalogPublicMembershipMembersSql,
  catalogSyncIdentities,
  createCatalogMembershipWatch,
  createCatalogSync,
  listPublishedCatalogSources,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CATALOG_RENDER_GRACE_HOURS,
  CatalogReconcileStateMissingError,
  PostgresWorkPublishingAdapter,
  catalogIntentAssetsSql,
  catalogMembershipBoundariesSql,
  catalogMembershipStateSql,
  catalogMembershipStore,
  catalogMirrorStatesSql,
  catalogPrivateMembershipAppBucketsSql,
  catalogPrivateMembershipAppMembersSql,
  catalogPublicMembershipAppBucketsSql,
  catalogPublicMembershipAppMembersSql,
  catalogPublicationDirtyMarkSql,
} from "@moya/community-postgres";
import { CATALOG_PREPARE_RETENTION_HOURS } from "admin/published";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_SCALE_25K,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleIntentId,
  catalogScaleShape,
  clearCatalogScale,
  createCatalogScaleDatabase,
  createQueryRecorder,
  explainCatalogScaleOn,
  rolledBackCatalogScale,
  seedCatalogScale,
  type CatalogScaleDatabase,
  type CatalogScaleShape,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W8 on the scale fixture: the per-minute
 * membership fingerprints that feed the scoped reconcile's dirty queue (App
 * migration A1), through the real roles and views. The public read role
 * aggregates the published pairs, the prepare reader the live private
 * projection's intents, and the restricted App role (no DELETE, no
 * TEMPORARY) diffs, marks and stores:
 * - a Catalog without a change marks nothing, and a minute without a change
 *   reads only the two aggregates and writes the state row;
 * - one record's takedown marks exactly its images, listing only its buckets
 *   and no App aggregate, and its return after the withdrawal marks them
 *   again; a takedown of the released records is queued whole in one
 *   observation and drains through the queue in ceil(n / (0.9 K)) passes of
 *   a stub consumer that keeps a tenth of K for the sweep (K = 1,000 at the
 *   issue's 25k fixture, where 3,000 records are 21,000 images);
 * - a difference that lasts (served but no longer published) is marked
 *   again only with a change in its own buckets, except once by a step
 *   without its own stored observation (restarted, or overtaken by another);
 * - a private intent's request, cancellation or withdrawal marks exactly its
 *   App-known assets, and a change the Catalog sync applies first is marked
 *   by the sync (as are a refusal that only tombstones, the reference flips
 *   it applies both ways, and a recorded render); a lasting private
 *   difference (a refused intent) is marked again only with its own bucket;
 * - a published row without a media id or object key is left out;
 * - a lease, and the render grace after it, that passed since the last
 *   observation mark their intents' assets; others do not;
 * - a missing state row, or one another observation advanced, fails clearly
 *   and rolls every mark back;
 * - every statement plans below JIT's threshold (cost under 100,000) with no
 *   JIT. Set MOYA_CATALOG_MEMBERSHIP_IMAGES=25200 for the issue's 25k
 *   fixture (local only; it prints the plans); CI runs 1,400 images.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 900_000;
// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
const AT_25K = process.env.MOYA_CATALOG_MEMBERSHIP_IMAGES === "25200";
const SHAPE: CatalogScaleShape = AT_25K
  ? CATALOG_SCALE_25K
  : catalogScaleShape(
      Number(process.env.MOYA_CATALOG_MEMBERSHIP_IMAGES ?? 1_400),
    );
const COUNTS = catalogScaleCounts(SHAPE);
/** The scoped reconcile's scope size (W7: 1,000), of which a tenth is kept
 * for the sweep; CI scales it with its Catalog. */
const K = AT_25K ? 1_000 : 100;
/** JIT compiles a plan from jit_above_cost (100,000 by default). */
const JIT_ABOVE_COST = 100_000;

let fixture: CatalogScaleDatabase;
const silent = { info: () => undefined, error: () => undefined };
const now = () => new Date();
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The asset ids of a CMS record's images (draft records follow the
 * published ones), sorted. */
const imagesOf = (record: number) =>
  Array.from(
    {
      length:
        record === COUNTS.records
          ? COUNTS.lastRecordImages
          : SHAPE.imagesPerRecord,
    },
    (_, i) => catalogScaleImage(record, i + 1).assetId,
  ).sort();
/** The draft record a live intent prepares. */
const liveRecord = (k: number) => COUNTS.records + k;

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csmember",
  });
}, SLOW);

afterAll(async () => {
  await fixture?.close();
}, SLOW);

/** A freshly seeded Catalog with an empty queue and no stored fingerprint. */
const fresh = async () => {
  await clearCatalogScale(fixture);
  await fixture.setup.query(
    `TRUNCATE community.catalog_publication_dirty;
     INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now())
       ON CONFLICT (id) DO NOTHING;
     UPDATE community.catalog_reconcile_state SET public_count = NULL, public_sum = NULL,
       public_observed_at = NULL, private_count = NULL, private_sum = NULL,
       private_observed_at = NULL, updated_at = now() WHERE id`,
  );
  await seedCatalogScale(fixture, SHAPE);
};

/** The membership step on the fixture's three roles. */
const watch = (
  pools: {
    readonly published: CatalogScaleDatabase["publicRead"];
    readonly prepare: CatalogScaleDatabase["prepare"];
    readonly app: CatalogScaleDatabase["app"];
  } = {
    published: fixture.publicRead,
    prepare: fixture.prepare,
    app: fixture.app,
  },
  port: Partial<ReturnType<typeof catalogMembershipStore>> = {},
) =>
  createCatalogMembershipWatch({
    published: pools.published,
    prepare: pools.prepare,
    port: { ...catalogMembershipStore(pools.app), ...port },
    logger: silent,
  });

/** Pending marks (asset id and reason), by asset id. */
const pending = async () =>
  (
    await fixture.setup.query<{ asset_id: string; reason: string }>(
      "SELECT asset_id, reason FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY asset_id",
    )
  ).rows;
const pendingIds = async () => (await pending()).map((row) => row.asset_id);

/** A stub of the scoped reconcile's consumer, as the App role: each pass
 * takes the oldest 0.9 K pending marks (a tenth of K stays the sweep's) and
 * clears the mark_seq it read (A1's clear). */
const drain = async (k: number) => {
  const take = Math.floor(0.9 * k);
  const drained: string[] = [];
  for (let passes = 0; ; passes += 1) {
    const batch = (
      await fixture.app.query<{ asset_id: string; mark_seq: string }>(
        "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY marked_at, asset_id LIMIT $1",
        [take],
      )
    ).rows;
    if (!batch.length) return { passes, drained, take };
    await fixture.app.query(
      `UPDATE community.catalog_publication_dirty d SET cleared_seq = c.seq
       FROM unnest($1::text[], $2::bigint[]) AS c(asset_id, seq)
       WHERE d.asset_id = c.asset_id AND d.mark_seq = c.seq`,
      [batch.map((row) => row.asset_id), batch.map((row) => row.mark_seq)],
    );
    drained.push(...batch.map((row) => row.asset_id));
  }
};

/** Takes CMS records off (draft) or puts them back (published). */
const setPublished = (records: readonly number[], published: boolean) =>
  fixture.setup.query(
    `UPDATE public.catalogs SET _status = $2::public.enum_catalogs_status WHERE id = ANY($1::integer[])`,
    [records, published ? "published" : "draft"],
  );

/** Withdraws every publication of the given assets, as a withdraw job would. */
const withdraw = async (assetIds: readonly string[]) => {
  for (const [state, extra] of [
    ["withdrawing", "withdraw_requested_at = now()"],
    ["withdrawn", "origin_deleted_at = now(), verified_at = now()"],
  ] as const)
    await fixture.setup.query(
      `UPDATE community.media_publications p SET state = '${state}', ${extra}
       FROM community.media_public_assets pa
       WHERE pa.id = p.public_asset_id AND pa.catalog_asset_id = ANY($1::text[])`,
      [assetIds],
    );
};

describe("Catalog membership fingerprints", () => {
  it(
    "marks nothing without a change, and a minute without one reads only the two aggregates",
    async () => {
      await fresh();
      expect(CATALOG_MEMBERSHIP_INTERVAL_MS).toBe(60_000);
      // The first observation has nothing stored: it compares every bucket
      // with the App's record, which matches the seeded Catalog exactly.
      await watch().run(now());
      expect(await pending()).toEqual([]);
      const stored = (
        await fixture.setup.query<{
          public_count: string;
          private_count: string;
          private_observed_at: Date | null;
        }>(catalogMembershipStateSql)
      ).rows[0]!;
      expect(Number(stored.public_count)).toBe(COUNTS.publishedImages);
      expect(Number(stored.private_count)).toBe(COUNTS.liveIntents);
      const recorder = createQueryRecorder();
      await watch({
        published: recorder.wrap("cms", fixture.publicRead),
        prepare: recorder.wrap("prepare", fixture.prepare),
        app: recorder.wrap("app", fixture.app),
      }).run(now());
      expect(await pending()).toEqual([]);
      const ran = (pool: string) =>
        recorder.queries
          .filter((query) => query.pool === pool)
          .map((query) => query.sql);
      expect(ran("cms")).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SELECT clock_timestamp() AS at",
        catalogPublicMembershipBucketsSql,
        "SELECT pg_export_snapshot() AS id",
        "ROLLBACK",
      ]);
      expect(ran("prepare")).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        expect.stringMatching(/^SET TRANSACTION SNAPSHOT '/u),
        catalogPrivateMembershipBucketsSql,
        "ROLLBACK",
      ]);
      // No member list and no App aggregate: the stored totals match.
      expect(ran("app")).toEqual([
        catalogMembershipStateSql,
        "BEGIN",
        catalogMembershipBoundariesSql,
        expect.stringMatching(/^UPDATE community\.catalog_reconcile_state/u),
        "COMMIT",
      ]);
      // The time-driven window moved on to this observation.
      const after = (
        await fixture.setup.query<{ private_observed_at: Date }>(
          catalogMembershipStateSql,
        )
      ).rows[0]!;
      expect(after.private_observed_at.getTime()).toBeGreaterThan(
        stored.private_observed_at!.getTime(),
      );
    },
    SLOW,
  );

  it(
    "marks exactly one record's images on its takedown, and again on its return once withdrawn",
    async () => {
      await fresh();
      // One step, as the worker runs it: from its second observation on it
      // lists only the buckets the CMS changed since its own last one.
      const recorder = createQueryRecorder();
      const step = watch({
        published: recorder.wrap("cms", fixture.publicRead),
        prepare: fixture.prepare,
        app: recorder.wrap("app", fixture.app),
      });
      await step.run(now());
      await setPublished([2], false);
      recorder.reset();
      await step.run(now());
      expect(await pending()).toEqual(
        imagesOf(2).map((asset_id) => ({
          asset_id,
          reason: "public_membership",
        })),
      );
      // Only the changed buckets were listed (a record's 7 images fall in
      // at most 7 of the 256), on both sides, and the App's record was not
      // aggregated.
      const listed = (sql: string) =>
        recorder.queries.filter((query) => query.sql === sql);
      expect(listed(catalogPublicMembershipMembersSql)).toHaveLength(1);
      const buckets = listed(catalogPublicMembershipMembersSql)[0]!
        .values![0] as string[];
      expect(buckets).toEqual(
        [...new Set(imagesOf(2).map((id) => id.slice(14, 16)))].sort(),
      );
      expect(
        listed(catalogPublicMembershipAppMembersSql).map(
          (query) => query.values![0],
        ),
      ).toEqual([buckets]);
      expect(listed(catalogPublicMembershipAppBucketsSql)).toEqual([]);
      // The reconcile (stubbed) plans them and withdraws what they served.
      await drain(K);
      await withdraw(imagesOf(2));
      // Another record is taken off and put back before the reconcile acts:
      // it is still served, so its return adds nothing to its pending marks,
      // and the withdrawn record, published nowhere and served nowhere, is
      // not marked again.
      await setPublished([6], false);
      await step.run(now());
      await setPublished([6], true);
      await step.run(now());
      expect(
        (
          await fixture.setup.query<{ asset_id: string; mark_seq: string }>(
            "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY asset_id",
          )
        ).rows,
      ).toEqual(imagesOf(6).map((asset_id) => ({ asset_id, mark_seq: "1" })));
      // The withdrawn record returns before any sync noticed it was gone: its
      // buckets changed, and its images are ready and served nowhere, so
      // they are marked to be copied again. A restarted step, which compares
      // with the App's record instead, finds the same: the sync record never
      // changed, but the served set did.
      await drain(K);
      await setPublished([2], true);
      await step.run(now());
      expect(await pending()).toEqual(
        imagesOf(2).map((asset_id) => ({
          asset_id,
          reason: "public_membership",
        })),
      );
      await drain(K);
      await setPublished([2], false);
      await step.run(now());
      await drain(K);
      await setPublished([2], true);
      await watch().run(now());
      expect(await pending()).toEqual(
        imagesOf(2).map((asset_id) => ({
          asset_id,
          reason: "public_membership",
        })),
      );
    },
    SLOW,
  );

  it(
    "marks a lasting difference again only when the Catalog changes one of its buckets",
    async () => {
      await fresh();
      const bucketOf = (assetId: string) => assetId.slice(14, 16);
      const recorder = createQueryRecorder();
      const step = watch({
        published: fixture.publicRead,
        prepare: fixture.prepare,
        app: recorder.wrap("app", fixture.app),
      });
      await step.run(now());
      // Records 10..29 are taken off but stay served, as the private-B
      // assets of new pairs a release_requested intent holds are (their plan
      // keeps them): a difference between the CMS and the App that lasts.
      const held = Array.from({ length: 20 }, (_, i) => i + 10);
      const lasting = new Set(held.flatMap(imagesOf));
      await setPublished(held, false);
      await step.run(now());
      expect(await pendingIds()).toEqual([...lasting].sort());
      await drain(K);
      // Each later takedown marks its own images and, of the lasting
      // differences, only those that share its buckets; the App's whole
      // record is not aggregated again. Each taken-down record stays served
      // too (the stub consumer withdraws nothing), so the lasting set grows.
      for (const record of [2, 3]) {
        await setPublished([record], false);
        recorder.reset();
        await step.run(now());
        const buckets = new Set(imagesOf(record).map(bucketOf));
        expect(await pendingIds()).toEqual(
          [
            ...imagesOf(record),
            ...[...lasting].filter((id) => buckets.has(bucketOf(id))),
          ].sort(),
        );
        expect(recorder.queries.map((query) => query.sql)).not.toContain(
          catalogPublicMembershipAppBucketsSql,
        );
        await drain(K);
        for (const id of imagesOf(record)) lasting.add(id);
      }
      // A restarted step has no observation of its own: it compares the
      // CMS with the App's record, so the first change it sees marks every
      // lasting difference once, then only changed buckets again.
      const restarted = watch();
      await setPublished([4], false);
      await restarted.run(now());
      expect(await pendingIds()).toEqual([...lasting, ...imagesOf(4)].sort());
      await drain(K);
      for (const id of imagesOf(4)) lasting.add(id);
      // The first step's own observation is no longer what is stored (the
      // restarted one advanced it): it compares with the App's record, not
      // with its stale buckets, in which record 4 is published as it is
      // again now. Record 4 was withdrawn meanwhile, so its return is marked.
      await withdraw(imagesOf(4));
      lasting.clear();
      for (const record of [...held, 2, 3])
        for (const id of imagesOf(record)) lasting.add(id);
      await setPublished([4], true);
      await step.run(now());
      expect(await pendingIds()).toEqual([...lasting, ...imagesOf(4)].sort());
    },
    SLOW,
  );

  it(
    "queues a takedown of every released record whole and drains it in ceil(n / 0.9K) passes",
    async () => {
      await fresh();
      await watch().run(now());
      const records = Array.from(
        { length: SHAPE.releasedIntents },
        (_, i) => i + 1,
      );
      const taken = records.flatMap(imagesOf).sort();
      await setPublished(records, false);
      const started = performance.now();
      await watch().run(now());
      const ms = performance.now() - started;
      expect(await pendingIds()).toEqual(taken);
      // A mark made while a pass plans an asset keeps it pending after the
      // pass clears the mark_seq it read.
      const first = (
        await fixture.app.query<{ asset_id: string; mark_seq: string }>(
          "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY marked_at, asset_id LIMIT 1",
        )
      ).rows[0]!;
      await fixture.app.query(catalogPublicationDirtyMarkSql, [
        [first.asset_id],
        ["publication"],
        now().toISOString(),
      ]);
      await fixture.app.query(
        "UPDATE community.catalog_publication_dirty SET cleared_seq = $2 WHERE asset_id = $1 AND mark_seq = $2",
        [first.asset_id, first.mark_seq],
      );
      expect(await pendingIds()).toContain(first.asset_id);
      const { passes, drained, take } = await drain(K);
      expect(passes).toBe(Math.ceil(taken.length / take));
      expect([...new Set(drained)].sort()).toEqual(taken);
      if (AT_25K) {
        expect(taken).toHaveLength(21_000);
        expect(passes).toBe(24);
        console.info(
          `[catalog-membership] takedown of ${taken.length} images: one observation ${ms.toFixed(0)} ms, ${passes} passes of ${take}`,
        );
      }
    },
    SLOW,
  );

  it(
    "marks an intent's App-known assets on a private change, and the sync marks a change it applies first",
    async () => {
      await fresh();
      const step = watch();
      await step.run(now());
      const live = (k: number) => catalogScaleIntentId("live", k);
      const released = (k: number) => catalogScaleIntentId("released", k);
      const marked = (ids: readonly string[], reason: string) =>
        [...ids].sort().map((asset_id) => ({ asset_id, reason }));
      // Requested every SHAPE.requestedEvery-th live intent; the others are
      // prepared.
      expect(SHAPE.requestedEvery).toBe(5);
      const request = (k: number) =>
        fixture.setup.query(
          `UPDATE public.catalog_delivery_intents SET state = 'release_requested',
             state_version = state_version + 1, release_requested_by = 1,
             release_requested_at = now(), updated_at = now()
           WHERE id = $1`,
          [live(k)],
        );
      await request(1);
      await fixture.setup.query(
        `UPDATE public.catalog_delivery_intents SET state = $2, state_version = state_version + 1,
           ended_at = now(), end_reason = 'synthetic', updated_at = now()
         WHERE id = $1`,
        [live(5), "cancelled"],
      );
      await fixture.setup.query(
        `UPDATE public.catalog_delivery_intents SET state = $2, state_version = state_version + 1,
           ended_at = now(), end_reason = 'synthetic', updated_at = now()
         WHERE id = $1`,
        [released(3), "withdrawn"],
      );
      await step.run(now());
      expect(await pending()).toEqual(
        marked(
          [
            ...imagesOf(liveRecord(1)),
            ...imagesOf(liveRecord(5)),
            ...imagesOf(3),
          ],
          "private_membership",
        ),
      );
      await drain(K);
      // The sync applies the next change before the step sees it: the
      // mirror then matches the CMS, so the sync marks what it applied (and
      // the three earlier changes, which it applies too).
      await request(6);
      const port = new PostgresWorkPublishingAdapter(fixture.app, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      const sync = () =>
        createCatalogSync({
          listSources: () => listPublishedCatalogSources(fixture.publicRead),
          readSnapshot: () =>
            readCatalogSourceSnapshot(fixture.publicRead, fixture.prepare),
          port,
          logger: silent,
        }).run(now());
      await sync();
      expect(await pending()).toEqual(
        marked(
          [
            ...imagesOf(liveRecord(1)),
            ...imagesOf(liveRecord(5)),
            ...imagesOf(liveRecord(6)),
            ...imagesOf(3),
          ],
          "intent",
        ),
      );
      await drain(K);
      await step.run(now());
      expect(await pending()).toEqual([]);
      // The sync marks the reference flips it applies, too: a record taken
      // down, and its return.
      await setPublished([4], false);
      await sync();
      expect(await pending()).toEqual(marked(imagesOf(4), "reference"));
      await drain(K);
      await setPublished([4], true);
      await sync();
      expect(await pending()).toEqual(marked(imagesOf(4), "reference"));
      await drain(K);
      // An intent the sync refuses under F3 (its state version went back)
      // only changes liveness: it is tombstoned like an absent one, which
      // ends what it granted, so the sync marks its App-known assets.
      expect(10 % SHAPE.requestedEvery).toBe(0);
      await fixture.setup.query(
        `UPDATE public.catalog_delivery_intents SET state_version = state_version - 1, updated_at = now()
         WHERE id = $1 AND state = 'release_requested'`,
        [live(10)],
      );
      await sync();
      expect(await pending()).toEqual(
        marked(imagesOf(liveRecord(10)), "intent"),
      );
      await drain(K);
      // The refusal lasts: the CMS lists the intent and the mirror no longer
      // observes it. The step marks it once, as its bucket changed since the
      // step's last observation; after that only a change in its own bucket
      // marks it again, not another intent's change.
      await step.run(now());
      expect(await pending()).toEqual(
        marked(imagesOf(liveRecord(10)), "private_membership"),
      );
      await drain(K);
      const bucketOf = (intentId: string) => intentId.slice(0, 2);
      // A prepared live intent not yet changed, in another bucket.
      const other = Array.from({ length: SHAPE.livePrepares }, (_, i) => i + 1)
        .filter((k) => k > 6 && k % SHAPE.requestedEvery !== 0)
        .find((k) => bucketOf(live(k)) !== bucketOf(live(10)))!;
      await request(other);
      await step.run(now());
      expect(await pending()).toEqual(
        marked(imagesOf(liveRecord(other)), "private_membership"),
      );
    },
    SLOW,
  );

  it(
    "marks the assets of intents whose lease or render grace passed since the last observation",
    async () => {
      await fresh();
      await watch().run(now());
      const live = (k: number) => catalogScaleIntentId("live", k);
      // In the App mirror only: the CMS projection (and so the private
      // fingerprint) does not change, so only the time-driven scope can
      // mark them. Prepared intents 2, 3 and 4.
      await fixture.setup.query(
        `UPDATE community.catalog_delivery_prepares SET expires_at = CASE intent_id
           WHEN $1::uuid THEN clock_timestamp()
           WHEN $2::uuid THEN clock_timestamp() - make_interval(hours => $4::integer)
           ELSE clock_timestamp() + interval '1 hour' END
         WHERE intent_id IN ($1::uuid, $2::uuid, $3::uuid)`,
        [live(2), live(3), live(4), CATALOG_RENDER_GRACE_HOURS],
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await watch().run(now());
      expect(await pending()).toEqual(
        [...imagesOf(liveRecord(2)), ...imagesOf(liveRecord(3))]
          .sort()
          .map((asset_id) => ({ asset_id, reason: "private_membership" })),
      );
      // Once marked, the same boundaries are behind the next window.
      await drain(K);
      await watch().run(now());
      expect(await pending()).toEqual([]);
      // G (D3) stays at least 24 hours inside R, so an intent in grace is
      // still listed by the live projection and observed live.
      expect(CATALOG_RENDER_GRACE_HOURS).toBe(72);
      expect(CATALOG_RENDER_GRACE_HOURS).toBeLessThanOrEqual(
        CATALOG_PREPARE_RETENTION_HOURS - 24,
      );
    },
    SLOW,
  );

  it(
    "leaves out a published row without a media id or object key, as the sync does",
    async () => {
      await fresh();
      const step = watch();
      await step.run(now());
      // Both columns are nullable in the CMS (only Payload requires them):
      // such a row is no pair and never an App asset.
      await fixture.setup.query(
        `INSERT INTO public.catalogs_media (_order, _parent_id, id, media_id, object_key, width, height)
         VALUES (100, 1, 'synthetic-no-media-id', NULL, $1, 6000, 4000),
           (101, 1, 'synthetic-no-object-key', 'synthetic-media', NULL, 6000, 4000)`,
        [catalogScaleImage(1, 1).objectKey],
      );
      await step.run(now());
      // A restarted step lists every bucket it compares, the rows' too.
      await setPublished([2], false);
      await watch().run(now());
      expect(await pendingIds()).toEqual(imagesOf(2));
      const stored = (
        await fixture.setup.query<{ public_count: string }>(
          catalogMembershipStateSql,
        )
      ).rows[0]!;
      expect(Number(stored.public_count)).toBe(
        COUNTS.publishedImages - imagesOf(2).length,
      );
    },
    SLOW,
  );

  it(
    "fails clearly without the state row, or when another observation advanced it, and keeps no mark",
    async () => {
      await fresh();
      await watch().run(now());
      await setPublished([5], false);
      const stored = await catalogMembershipStore(
        fixture.app,
      ).readCatalogMembershipState();
      // Another observation advanced the row meanwhile: nothing is kept.
      await fixture.setup.query(
        "UPDATE community.catalog_reconcile_state SET public_count = public_count + 1 WHERE id",
      );
      await expect(
        watch(undefined, {
          readCatalogMembershipState: async () => stored,
        }).run(now()),
      ).rejects.toThrow("Catalog membership state changed concurrently");
      expect(await pending()).toEqual([]);
      // The row itself is gone (startup refuses without it; only an owner
      // can remove it): the read fails, and so does a write prepared before.
      await fixture.setup.query(
        "DELETE FROM community.catalog_reconcile_state",
      );
      await expect(watch().run(now())).rejects.toBeInstanceOf(
        CatalogReconcileStateMissingError,
      );
      await expect(
        watch(undefined, {
          readCatalogMembershipState: async () => stored,
        }).run(now()),
      ).rejects.toBeInstanceOf(CatalogReconcileStateMissingError);
      expect(await pending()).toEqual([]);
      await fixture.setup.query(
        "INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now())",
      );
    },
    SLOW,
  );

  it(
    "marks an asset when its render is recorded",
    async () => {
      await fresh();
      const image = catalogScaleImage(liveRecord(1), 1);
      const written = () => {
        const key = hex();
        return {
          storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
          byteSize: 1_000,
          sha256: sha256(key),
        };
      };
      const port = new PostgresWorkPublishingAdapter(fixture.app, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      expect(
        await port.recordCatalogRenditions(
          image.assetId,
          {
            masterSha256: image.sourceSha256,
            masterWidth: image.width,
            masterHeight: image.height,
            placeholderColor: "#112233",
            renditions: catalogSyncIdentities().map((identity) => ({
              ...written(),
              role: identity.role,
              recipeVersion: identity.version,
              recipeDigest: identity.digest,
              contentType: "image/webp" as const,
              width: 480,
              height: 320,
            })),
          },
          now(),
        ),
      ).toEqual({ status: "recorded" });
      expect(await pending()).toEqual([
        { asset_id: image.assetId, reason: "rendition" },
      ]);
    },
    SLOW,
  );

  it(
    "plans every statement below JIT's threshold, as its own role",
    async () => {
      await fresh();
      // Wall time of a first observation (every bucket compared) and of a
      // minute without a change (the two aggregates and the state row).
      const timed = async () => {
        const started = performance.now();
        await watch().run(now());
        return performance.now() - started;
      };
      const first = await timed();
      const unchanged = await timed();
      const allBuckets = Array.from({ length: 256 }, (_, i) =>
        i.toString(16).padStart(2, "0"),
      );
      const liveIntents = (
        await fixture.setup.query<{ intent_id: string }>(
          "SELECT intent_id::text FROM community.catalog_delivery_prepares WHERE observed_live ORDER BY intent_id",
        )
      ).rows.map((row) => row.intent_id);
      expect(liveIntents).toHaveLength(COUNTS.liveIntents);
      const published = Array.from(
        { length: COUNTS.records },
        (_, i) => i + 1,
      ).flatMap(imagesOf);
      const at = new Date();
      const statements: readonly (readonly [
        string,
        CatalogScaleDatabase["setup"],
        string,
        readonly unknown[],
      ])[] = [
        [
          "cms public buckets",
          fixture.publicRead,
          catalogPublicMembershipBucketsSql,
          [],
        ],
        [
          "cms public members, every bucket",
          fixture.publicRead,
          catalogPublicMembershipMembersSql,
          [allBuckets],
        ],
        [
          "cms public members, 7 buckets",
          fixture.publicRead,
          catalogPublicMembershipMembersSql,
          [allBuckets.slice(0, 7)],
        ],
        [
          "cms private buckets",
          fixture.prepare,
          catalogPrivateMembershipBucketsSql,
          [],
        ],
        [
          "cms private members, every bucket",
          fixture.prepare,
          catalogPrivateMembershipMembersSql,
          [allBuckets],
        ],
        ["app state", fixture.app, catalogMembershipStateSql, []],
        [
          "app public buckets",
          fixture.app,
          catalogPublicMembershipAppBucketsSql,
          [],
        ],
        [
          "app private buckets",
          fixture.app,
          catalogPrivateMembershipAppBucketsSql,
          [],
        ],
        [
          "app public members, every bucket",
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [allBuckets],
        ],
        [
          "app public members, 7 buckets",
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [allBuckets.slice(0, 7)],
        ],
        [
          "app public members, one bucket",
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [allBuckets.slice(0, 1)],
        ],
        [
          "app private members, every bucket",
          fixture.app,
          catalogPrivateMembershipAppMembersSql,
          [allBuckets],
        ],
        [
          "app intent assets, every live intent",
          fixture.app,
          catalogIntentAssetsSql,
          [liveIntents],
        ],
        [
          "app boundaries, one minute",
          fixture.app,
          catalogMembershipBoundariesSql,
          [
            new Date(at.getTime() - 60_000).toISOString(),
            at.toISOString(),
            CATALOG_RENDER_GRACE_HOURS,
          ],
        ],
        [
          "sync mirror states, every live intent",
          fixture.app,
          catalogMirrorStatesSql,
          [liveIntents],
        ],
        [
          "mark every published image",
          fixture.app,
          catalogPublicationDirtyMarkSql,
          [
            published.sort(),
            published.map(() => "public_membership"),
            at.toISOString(),
          ],
        ],
      ];
      const lines: string[] = [];
      for (const [label, pool, sql, values] of statements) {
        const plan = await rolledBackCatalogScale(pool, (client) =>
          explainCatalogScaleOn(client, sql, values, {
            analyze: true,
            buffers: true,
          }),
        );
        lines.push(
          `${label}: cost ${Math.round(plan.cost)}, ${plan.executionMs?.toFixed(1)} ms, ${plan.sharedBlocks} blocks, JIT ${plan.jit ? `${plan.jitMs?.toFixed(1)} ms` : "no"}; ${plan.nodes.join(" > ")}`,
        );
        expect(plan.cost, label).toBeLessThan(JIT_ABOVE_COST);
        expect(plan.jit, label).toBe(false);
      }
      if (AT_25K)
        console.info(
          `[catalog-membership] first observation ${first.toFixed(0)} ms, unchanged minute ${unchanged.toFixed(0)} ms\n${lines.join("\n")}`,
        );
    },
    SLOW,
  );
});
