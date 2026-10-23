import { createHash, randomBytes } from "node:crypto";

import {
  currentCatalogRecipePolicy,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  CATALOG_MEMBERSHIP_INTERVAL_MS,
  catalogMembershipRequestsSql,
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
  catalogMembershipHoldsSql,
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
  analyzeCatalogScale,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleIntentId,
  catalogScaleShape,
  createCatalogScaleTemplates,
  createQueryRecorder,
  explainCatalogScaleOn,
  holdCatalogScaleRecords,
  rolledBackCatalogScale,
  type CatalogScaleDatabase,
  type CatalogScaleShape,
  type CatalogScaleTemplates,
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
 * - an asset that private B alone serves (every publication a pin of a
 *   release request that holds a pin for each of its members and that the
 *   CMS confirms in the same snapshot as requested, unexpired and of the
 *   current recipe policy, whose plan keeps it) is never marked when its
 *   buckets are listed; one that serves more than its pins is a takedown,
 *   as is one whose request the CMS has already ended while the App mirror
 *   still holds it (marked in the observation that sees the takedown), one
 *   whose request is of an earlier policy or has a member inspect could not
 *   pin, and every such asset for a step whose confirmation fails or that
 *   has no prepare reader (the reconcile then reads no intent);
 * - a private intent's request, cancellation or withdrawal marks exactly its
 *   App-known assets, and a change the Catalog sync applies first is marked
 *   by the sync (as are a refusal that only tombstones, the reference flips
 *   it applies both ways, and a recorded render); a lasting private
 *   difference (a refused intent) is marked again only with its own bucket;
 * - a published row without a media id or object key is left out;
 * - a lease that passed since the last observation marks its intent's
 *   assets; the end of render grace after it marks nothing (grace is
 *   rendering only), nor does a lease still running; a lapse the CMS
 *   projection reports (expired at the same state version) is marked by the
 *   private diff and then the sync, normal for a prepared intent and urgent
 *   for a request;
 * - each mark has its class: urgent for a takedown (an asset the Catalog no
 *   longer publishes that serves more than the confirmed requests' pins, a
 *   reference flip to unreferenced), the end or refusal of an intent that
 *   may have granted exposure (requested or released, or prepared but
 *   possibly requested since the App saw it), and a passed requested lease;
 *   normal for a return, a request, a recorded render, and the end or lapse
 *   of an intent the App saw prepared and the CMS shows was never requested;
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

let templates: CatalogScaleTemplates;
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
  templates = await createCatalogScaleTemplates({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csmember",
  });
}, SLOW);

afterAll(async () => {
  await templates?.close();
}, SLOW);

/** A freshly seeded Catalog with an empty queue and no stored fingerprint
 * (A1's state row as it creates it): a copy of the one seeded template, the
 * previous test's copy dropped. */
const fresh = async () => {
  await fixture?.close();
  fixture = await templates.seeded(SHAPE);
};

/** The recipe policy of this build, which the fixture's intents carry. */
const POLICY = currentCatalogRecipePolicy().recipeManifestSha256;

/** The membership step on the fixture's three roles (or without a prepare
 * reader), under this build's recipe policy unless another is given. */
const watch = (
  pools: {
    readonly published: CatalogScaleDatabase["publicRead"];
    readonly prepare: CatalogScaleDatabase["prepare"] | null;
    readonly app: CatalogScaleDatabase["app"];
  } = {
    published: fixture.publicRead,
    prepare: fixture.prepare,
    app: fixture.app,
  },
  port: Partial<ReturnType<typeof catalogMembershipStore>> = {},
  policy = POLICY,
) =>
  createCatalogMembershipWatch({
    published: pools.published,
    prepare: pools.prepare,
    policy,
    port: { ...catalogMembershipStore(pools.app), ...port },
    logger: silent,
  });

/** Pending marks (asset id, reason and class), by asset id. */
const pending = async () =>
  (
    await fixture.setup.query<{
      asset_id: string;
      reason: string;
      urgent: boolean;
    }>(
      "SELECT asset_id, reason, urgent FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY asset_id",
    )
  ).rows;
/** The pending marks expected for groups of assets, each group with its
 * class (urgent or not), as pending() lists them. */
const marked = (
  reason: string,
  ...groups: (readonly [readonly string[], boolean])[]
) =>
  groups
    .flatMap(([ids, urgent]) =>
      ids.map((asset_id) => ({ asset_id, reason, urgent })),
    )
    .sort((a, b) =>
      a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0,
    );
const pendingIds = async () => (await pending()).map((row) => row.asset_id);

/** A stub of the scoped reconcile's consumer, as the App role: each pass
 * takes 0.9 K pending marks, urgent ones first and each class oldest first
 * (a tenth of K stays the sweep's), and clears the mark_seq it read (A1's
 * clear). */
const drain = async (k: number) => {
  const take = Math.floor(0.9 * k);
  const drained: string[] = [];
  for (let passes = 0; ; passes += 1) {
    const batch = (
      await fixture.app.query<{ asset_id: string; mark_seq: string }>(
        "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY urgent DESC, marked_at, asset_id LIMIT $1",
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
      // A takedown: the assets were served, so each mark is urgent.
      expect(await pending()).toEqual(
        marked("public_membership", [imagesOf(2), true]),
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
      // A return is publish-side work: normal marks.
      expect(await pending()).toEqual(
        marked("public_membership", [imagesOf(2), false]),
      );
      await drain(K);
      await setPublished([2], false);
      await step.run(now());
      await drain(K);
      await setPublished([2], true);
      await watch().run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [imagesOf(2), false]),
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
      // Records 10..29 are taken off but stay served (the stub consumer
      // withdraws nothing, and no release request holds them): a difference
      // between the CMS and the App that lasts until they are withdrawn.
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
    "never marks an asset that private B alone serves when its buckets are listed, and takes down one serving more than its pins",
    async () => {
      await fresh();
      const bucketOf = (assetId: string) => assetId.slice(14, 16);
      // A release wave before its release: records 10..29 are not
      // published, and their release requests (private B) serve every
      // published generation of their images, which their plans keep.
      const held = await holdCatalogScaleRecords(fixture, {
        first: 10,
        last: 29,
      });
      expect(held).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 10)
          .flatMap(imagesOf)
          .sort(),
      );
      const recorder = createQueryRecorder();
      const step = watch({
        published: fixture.publicRead,
        prepare: fixture.prepare,
        app: recorder.wrap("app", fixture.app),
      });
      /** The buckets the step listed since the recorder's last reset. */
      const listed = () =>
        new Set(
          recorder.queries
            .filter(
              (query) => query.sql === catalogPublicMembershipAppMembersSql,
            )
            .flatMap((query) => query.values![0] as string[]),
        );
      // The first observation compares every bucket with the App's record,
      // in which the held images are served: all their buckets are listed,
      // and none of them is marked.
      await step.run(now());
      expect(held.filter((id) => !listed().has(bucketOf(id)))).toEqual([]);
      expect(await pending()).toEqual([]);
      // A later change lists its own buckets again, some of them shared with
      // held images: the takedown marks its own images only.
      recorder.reset();
      await setPublished([2], false);
      await step.run(now());
      expect(held.some((id) => listed().has(bucketOf(id)))).toBe(true);
      expect(await pending()).toEqual(
        marked("public_membership", [imagesOf(2), true]),
      );
      await drain(K);
      await withdraw(imagesOf(2));
      // A held image that also serves a publication its request does not
      // pin (here, a pin removed) has something to withdraw: a takedown,
      // found by a restarted step, which lists every differing bucket.
      const extra = held[0]!;
      await fixture.setup.query(
        `DELETE FROM community.catalog_delivery_rendition_pins h
         USING community.media_renditions r
         WHERE r.id = h.rendition_id AND r.catalog_asset_id = $1 AND r.role = 'viewer'`,
        [extra],
      );
      await setPublished([3], false);
      await watch().run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [[extra, ...imagesOf(3)], true]),
      );
      await drain(K);
      // A step that cannot confirm the requests in the CMS (here the App
      // read of the requests holding the listed assets fails) counts no
      // pin: a restarted one takes every held image down, with record 3
      // (still served) and the next takedown.
      await setPublished([4], false);
      await watch(undefined, {
        readCatalogMembershipHolds: () =>
          Promise.reject(new Error("synthetic")),
      }).run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [
          [...held, ...imagesOf(3), ...imagesOf(4)],
          true,
        ]),
      );
      await drain(K);
      // Without a prepare reader the reconcile reads no intent, so private B
      // keeps nothing: a step without one takes every held image down too.
      await setPublished([5], false);
      await watch({
        published: fixture.publicRead,
        prepare: null,
        app: fixture.app,
      }).run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [
          [...held, ...imagesOf(3), ...imagesOf(4), ...imagesOf(5)],
          true,
        ]),
      );
    },
    SLOW,
  );

  it(
    "marks a takedown urgent in the observation that sees it when the CMS has already ended the request the App mirror still holds",
    async () => {
      await fresh();
      const bucketOf = (assetId: string) => assetId.slice(14, 16);
      // Record 1 is published and serves its images, and a release request
      // X names them (here its own intent, requested again, as a new
      // revision's request would be) and pins every publication they serve.
      const record = 1;
      const images = await holdCatalogScaleRecords(fixture, {
        first: record,
        last: record,
      });
      expect(images).toEqual(imagesOf(record));
      await setPublished([record], true);
      const recorder = createQueryRecorder();
      const step = watch({
        published: fixture.publicRead,
        prepare: recorder.wrap("prepare", fixture.prepare),
        app: recorder.wrap("app", fixture.app),
      });
      await step.run(now());
      expect(await pending()).toEqual([]);
      // The editor cancels X. Only the sync writes the App mirror, so until
      // the next one (up to 5 minutes) the mirror still holds X requested,
      // observed live, leased and pinning those publications.
      await fixture.setup.query(
        `UPDATE public.catalog_delivery_intents SET state = 'cancelled',
           state_version = state_version + 1, ended_at = now(), end_reason = 'synthetic',
           updated_at = now()
         WHERE catalog_document_id = $1 AND state = 'release_requested'`,
        [record],
      );
      await step.run(now());
      expect(await pending()).toEqual(
        marked("private_membership", [images, true]),
      );
      // The reconcile plans them while the record is public (nothing to
      // withdraw): the marks drain.
      await drain(K);
      // Then the record is withdrawn, before any sync. The withdrawal ends no
      // intent (X has already ended), and the private total is unchanged, so
      // only the public diff can see it: X's mirror pins cover every served
      // publication, but the CMS no longer confirms X, so the takedown is
      // marked, urgent, in this same observation.
      await setPublished([record], false);
      recorder.reset();
      await step.run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [images, true]),
      );
      // The mirror's requests naming an asset of the listed buckets and
      // holding a pin for each member (X alone: the fixture's other live
      // requests pin nothing) were read and confirmed in the same CMS
      // snapshot, by intent id; X was not confirmed, so its pins did not
      // count.
      const ran = (pool: string, sql: string) =>
        recorder.queries.filter(
          (query) => query.pool === pool && query.sql === sql,
        );
      const x = catalogScaleIntentId("released", record);
      const listed = [...new Set(images.map(bucketOf))].sort();
      const [holds, ...moreHolds] = ran("app", catalogMembershipHoldsSql);
      expect(moreHolds).toEqual([]);
      expect(holds!.values![0]).toEqual(listed);
      const [confirm, ...moreConfirms] = ran(
        "prepare",
        catalogMembershipRequestsSql,
      );
      expect(moreConfirms).toEqual([]);
      expect(confirm!.values![0]).toEqual([x]);
      expect(confirm!.rows).toBe(0);
      const [members] = ran("app", catalogPublicMembershipAppMembersSql);
      expect(members!.values![3]).toEqual([]);
    },
    SLOW,
  );

  it(
    "marks a takedown urgent when only a release request of an earlier recipe policy pins what its images serve",
    async () => {
      await fresh();
      // Records 1 and 2 are published, and their release requests (of this
      // build's policy) pin every publication their images serve.
      const images = await holdCatalogScaleRecords(fixture, {
        first: 1,
        last: 2,
      });
      await setPublished([1, 2], true);
      const step = watch();
      await step.run(now());
      // Record 1 is withdrawn: its request is confirmed, its plan keeps
      // every pin, so there is nothing to withdraw and nothing is marked.
      await setPublished([1], false);
      await step.run(now());
      expect(await pending()).toEqual([]);
      // A deploy changes the recipe policy while both requests are live:
      // neither can be released now, and their plans grant them nothing, so
      // their pins keep nothing. Record 2's takedown is marked, urgent, and
      // so is record 1, still served (the restarted step compares with the
      // App's record).
      const deployed = watch(
        undefined,
        {},
        sha256("synthetic later recipe policy"),
      );
      await setPublished([2], false);
      await deployed.run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [images, true]),
      );
    },
    SLOW,
  );

  it(
    "marks a takedown urgent when the release request pinning what its images serve has a member inspect could not pin",
    async () => {
      await fresh();
      // Records 1 and 2 are published, and release requests (each standing
      // for another record's request, which the withdrawals below do not
      // end) pin every publication their images serve.
      await holdCatalogScaleRecords(fixture, { first: 1, last: 2 });
      await setPublished([1, 2], true);
      // One member of record 2's request is still rendering: its asset is
      // pending and serves nothing, and inspect pinned only the others. Inspect
      // reports the request not private-ready, so its plan grants it nothing.
      const [rendering, ...pinned] = imagesOf(2);
      await withdraw([rendering!]);
      await fixture.setup.query(
        `UPDATE community.catalog_media_assets SET state = 'pending', updated_at = now()
         WHERE id = $1`,
        [rendering],
      );
      const unpinned = await fixture.setup.query(
        `DELETE FROM community.catalog_delivery_rendition_pins h
         USING community.catalog_delivery_media_refs r
         WHERE r.intent_id = h.intent_id AND r.ordinal = h.ordinal AND r.asset_id = $1
           AND h.intent_id = $2::uuid`,
        [rendering, catalogScaleIntentId("released", 2)],
      );
      expect(unpinned.rowCount).toBeGreaterThan(0);
      const step = watch();
      await step.run(now());
      expect(await pending()).toEqual([]);
      // Record 1 is withdrawn: its request pins a member each, is confirmed,
      // and its plan keeps every pin, so nothing is marked.
      await setPublished([1], false);
      await step.run(now());
      expect(await pending()).toEqual([]);
      // Record 2 is withdrawn: the CMS confirms its request too, but the
      // request does not hold a pin for each member, so its pins keep
      // nothing, and the images they serve are marked, urgent, in this same
      // observation (not at the next sync's unreferenced flip).
      await setPublished([2], false);
      await step.run(now());
      expect(await pending()).toEqual(
        marked("public_membership", [pinned, true]),
      );
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
          "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY urgent DESC, marked_at, asset_id LIMIT 1",
        )
      ).rows[0]!;
      await fixture.app.query(catalogPublicationDirtyMarkSql, [
        [first.asset_id],
        ["publication"],
        [false],
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
      const end = (intentId: string, state: string) =>
        fixture.setup.query(
          `UPDATE public.catalog_delivery_intents SET state = $2, state_version = state_version + 1,
             ended_at = now(), end_reason = 'synthetic', updated_at = now()
           WHERE id = $1`,
          [intentId, state],
        );
      await request(1);
      await end(live(5), "cancelled");
      await end(released(3), "withdrawn");
      // Intents the mirror holds prepared: one cancelled, one requested and
      // then cancelled before any sync, and one the CMS expired itself (one
      // version later, as a request that then lapsed reads too).
      await end(live(2), "cancelled");
      await request(3);
      await end(live(3), "cancelled");
      await end(live(4), "expired");
      await step.run(now());
      // A request is normal; a cancellation and a withdrawal end what their
      // intents granted, so their marks are urgent. A prepared intent grants
      // nothing a takedown removes, so its cancellation is normal, but not
      // where the CMS may have held a request the mirror never saw (and the
      // reconcile, which plans from the CMS, copied for).
      expect(await pending()).toEqual(
        marked(
          "private_membership",
          [imagesOf(liveRecord(1)), false],
          [imagesOf(liveRecord(2)), false],
          [imagesOf(liveRecord(3)), true],
          [imagesOf(liveRecord(4)), true],
          [imagesOf(liveRecord(5)), true],
          [imagesOf(3), true],
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
          "intent",
          [imagesOf(liveRecord(1)), false],
          [imagesOf(liveRecord(2)), false],
          [imagesOf(liveRecord(3)), true],
          [imagesOf(liveRecord(4)), true],
          [imagesOf(liveRecord(5)), true],
          [imagesOf(liveRecord(6)), false],
          [imagesOf(3), true],
        ),
      );
      await drain(K);
      await step.run(now());
      expect(await pending()).toEqual([]);
      // The sync marks the reference flips it applies, too: a record taken
      // down (urgent), and its return (normal).
      await setPublished([4], false);
      await sync();
      expect(await pending()).toEqual(marked("reference", [imagesOf(4), true]));
      await drain(K);
      await setPublished([4], true);
      await sync();
      expect(await pending()).toEqual(
        marked("reference", [imagesOf(4), false]),
      );
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
        marked("intent", [imagesOf(liveRecord(10)), true]),
      );
      await drain(K);
      // The refusal lasts: the CMS lists the intent and the mirror no longer
      // observes it. The step marks it once (normal: the CMS still lists it
      // as requested), as its bucket changed since the step's last
      // observation; after that only a change in its own bucket marks it
      // again, not another intent's change.
      await step.run(now());
      expect(await pending()).toEqual(
        marked("private_membership", [imagesOf(liveRecord(10)), false]),
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
        marked("private_membership", [imagesOf(liveRecord(other)), false]),
      );
    },
    SLOW,
  );

  it(
    "marks the assets of intents whose lease passed since the last observation, urgent for a request, and not when their render grace ends",
    async () => {
      await fresh();
      await watch().run(now());
      const live = (k: number) => catalogScaleIntentId("live", k);
      // In the App mirror only: the CMS projection (and so the private
      // fingerprint) does not change, so only the time-driven scope can
      // mark them. Prepared intents 2, 3 and 4 and requested intent 5: the
      // leases of 2 and 5 pass in the window, 3's render grace ends in it
      // (its lease passed G hours ago), 4's lease is still running.
      expect(5 % SHAPE.requestedEvery).toBe(0);
      await fixture.setup.query(
        `UPDATE community.catalog_delivery_prepares SET expires_at = CASE intent_id
           WHEN $1::uuid THEN clock_timestamp()
           WHEN $5::uuid THEN clock_timestamp()
           WHEN $2::uuid THEN clock_timestamp() - make_interval(hours => $4::integer)
           ELSE clock_timestamp() + interval '1 hour' END
         WHERE intent_id IN ($1::uuid, $2::uuid, $3::uuid, $5::uuid)`,
        [live(2), live(3), live(4), CATALOG_RENDER_GRACE_HOURS, live(5)],
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await watch().run(now());
      // A passed request lease ends private B: urgent. A passed prepared
      // lease ends nothing a takedown removes: normal. The end of render
      // grace changes no publication plan (no publication input reads grace;
      // it decides only whether an image renders), so it marks nothing.
      expect(await pending()).toEqual(
        marked(
          "private_membership",
          [imagesOf(liveRecord(2)), false],
          [imagesOf(liveRecord(5)), true],
        ),
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
    "keeps the lapse of a prepared intent normal as the CMS projection reports it, at the same state version, and a lapsed request urgent",
    async () => {
      await fresh();
      const step = watch();
      await step.run(now());
      const live = (k: number) => catalogScaleIntentId("live", k);
      // Prepared intent 2 and requested intent 5 lapse in the CMS: the live
      // projection now reads each as expired at its own state version (the
      // CMS writes nothing when a lease passes). The App mirror carries the
      // same expiry (the sync copies it and refuses another), an hour ago:
      // before the step's last observation, so no lease boundary falls in
      // its window, and only the private diff (then the sync) marks them.
      expect(5 % SHAPE.requestedEvery).toBe(0);
      const lapsed = [live(2), live(5)];
      await fixture.setup.query(
        `UPDATE public.catalog_delivery_intents SET expires_at = now() - interval '1 hour', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND state IN ('prepared', 'release_requested')`,
        [lapsed],
      );
      await fixture.setup.query(
        `UPDATE community.catalog_delivery_prepares p SET expires_at = i.expires_at
         FROM public.catalog_delivery_intents i
         WHERE i.id = p.intent_id AND p.intent_id = ANY($1::uuid[])`,
        [lapsed],
      );
      await step.run(now());
      // The App saw intent 2 prepared, and the CMS shows it expired at that
      // same version: no request came between, so its end is normal. A
      // lapsed request ends private B: urgent.
      expect(await pending()).toEqual(
        marked(
          "private_membership",
          [imagesOf(liveRecord(2)), false],
          [imagesOf(liveRecord(5)), true],
        ),
      );
      await drain(K);
      // The sync copies the same change into the mirror (expired, at the
      // same version): its marks have the same classes.
      await createCatalogSync({
        listSources: () => listPublishedCatalogSources(fixture.publicRead),
        readSnapshot: () =>
          readCatalogSourceSnapshot(fixture.publicRead, fixture.prepare),
        port: new PostgresWorkPublishingAdapter(fixture.app, {
          publication: { allowPublish: () => true, isPublic: () => true },
        }),
        logger: silent,
      }).run(now());
      expect(await pending()).toEqual(
        marked(
          "intent",
          [imagesOf(liveRecord(2)), false],
          [imagesOf(liveRecord(5)), true],
        ),
      );
      expect(
        (
          await fixture.setup.query<{ source_state: string }>(
            "SELECT source_state FROM community.catalog_delivery_prepares WHERE intent_id = ANY($1::uuid[]) ORDER BY intent_id",
            [lapsed],
          )
        ).rows.map((row) => row.source_state),
      ).toEqual(["expired", "expired"]);
      // Mirror and CMS agree again: the next minute marks nothing.
      await drain(K);
      await step.run(now());
      expect(await pending()).toEqual([]);
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
      expect(await pending()).toEqual(
        marked("rendition", [[image.assetId], false]),
      );
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
          [allBuckets, at.toISOString(), POLICY, []],
        ],
        [
          "app public members, 7 buckets",
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [allBuckets.slice(0, 7), at.toISOString(), POLICY, []],
        ],
        [
          "app public members, one bucket",
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [allBuckets.slice(0, 1), at.toISOString(), POLICY, []],
        ],
        [
          "app holds, every bucket",
          fixture.app,
          catalogMembershipHoldsSql,
          [allBuckets, at.toISOString(), POLICY],
        ],
        [
          "app holds, 7 buckets",
          fixture.app,
          catalogMembershipHoldsSql,
          [allBuckets.slice(0, 7), at.toISOString(), POLICY],
        ],
        [
          "app private members, every bucket",
          fixture.app,
          catalogPrivateMembershipAppMembersSql,
          [allBuckets],
        ],
        [
          "app intent assets, every live intent, half of them ended",
          fixture.app,
          catalogIntentAssetsSql,
          [liveIntents, liveIntents.filter((_, i) => i % 2 === 0)],
        ],
        [
          "app boundaries, one minute",
          fixture.app,
          catalogMembershipBoundariesSql,
          [new Date(at.getTime() - 60_000).toISOString(), at.toISOString()],
        ],
        [
          "app boundaries, every live lease at once",
          fixture.app,
          catalogMembershipBoundariesSql,
          [
            at.toISOString(),
            new Date(at.getTime() + 25 * 3_600_000).toISOString(),
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
            published.map(() => true),
            at.toISOString(),
          ],
        ],
      ];
      const lines: string[] = [];
      const plan = async (
        label: string,
        pool: CatalogScaleDatabase["setup"],
        sql: string,
        values: readonly unknown[],
      ) => {
        const planned = await rolledBackCatalogScale(pool, (client) =>
          explainCatalogScaleOn(client, sql, values, {
            analyze: true,
            buffers: true,
          }),
        );
        lines.push(
          `${label}: cost ${Math.round(planned.cost)}, ${planned.executionMs?.toFixed(1)} ms, ${planned.sharedBlocks} blocks, JIT ${planned.jit ? `${planned.jitMs?.toFixed(1)} ms` : "no"}; ${planned.nodes.join(" > ")}`,
        );
        expect(planned.cost, label).toBeLessThan(JIT_ABOVE_COST);
        expect(planned.jit, label).toBe(false);
      };
      for (const [label, pool, sql, values] of statements)
        await plan(label, pool, sql, values);
      // A release wave before its release: private B serves the images of
      // the records whose requests it holds (700 at 25k, about 4,900
      // images, the wave of W-AC5's scenario), so the holds read finds
      // those requests for the listed buckets, the CMS confirms them by id,
      // and the exposed test of the App members finds their pins for each
      // listed image.
      const held = AT_25K ? 700 : Math.ceil(SHAPE.releasedIntents / 5);
      await holdCatalogScaleRecords(fixture, { first: 1, last: held });
      await analyzeCatalogScale(fixture);
      const heldAt = new Date().toISOString();
      const store = catalogMembershipStore(fixture.app);
      for (const [label, buckets] of [
        ["every bucket", allBuckets],
        ["7 buckets", allBuckets.slice(0, 7)],
      ] as const) {
        // The requests the step reads for these buckets, all of which the
        // CMS still confirms: the held ones. The fixture's other live
        // requests name images nothing serves yet and pin nothing (as
        // inspect leaves a request whose members are still rendering), so
        // the read leaves them out, after reading their pins.
        const requests = await store.readCatalogMembershipHolds(
          buckets,
          new Date(heldAt),
          POLICY,
        );
        if (buckets === allBuckets) expect(requests).toHaveLength(held);
        await plan(
          `app holds, ${label}, ${held} records held by private B`,
          fixture.app,
          catalogMembershipHoldsSql,
          [buckets, heldAt, POLICY],
        );
        await plan(
          `cms requests, ${label}, ${requests.length} read with ${held} records held by private B`,
          fixture.prepare,
          catalogMembershipRequestsSql,
          [requests, heldAt, POLICY],
        );
        const confirmed = (
          await fixture.prepare.query<{ intent_id: string }>(
            catalogMembershipRequestsSql,
            [requests, heldAt, POLICY],
          )
        ).rows.map((row) => row.intent_id);
        expect(confirmed.sort()).toEqual(requests);
        await plan(
          `app public members, ${label}, ${held} records held by private B, ${confirmed.length} confirmed`,
          fixture.app,
          catalogPublicMembershipAppMembersSql,
          [buckets, heldAt, POLICY, confirmed],
        );
      }
      if (AT_25K)
        console.info(
          `[catalog-membership] first observation ${first.toFixed(0)} ms, unchanged minute ${unchanged.toFixed(0)} ms\n${lines.join("\n")}`,
        );
    },
    SLOW,
  );
});
