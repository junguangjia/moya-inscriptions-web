import { randomBytes } from "node:crypto";

import {
  catalogExpectedRenditions,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
} from "@moya/backend-production/internal/catalog-delivery";
import { createCatalogMembershipWatch } from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
  catalogMembershipStore,
  catalogPublicationDirtyLockSql,
  catalogPublicationDirtyMarkSql,
  markCatalogPublicationDirty,
  readCatalogDeliveryProjection,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { wholeCatalogCopySet } from "../../unit/backend/catalog-copy-set.js";
import {
  CATALOG_SCALE_25K,
  bumpCatalogScaleRecipe,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleIndexedStatements,
  catalogScaleIntentId,
  catalogScaleRenditionId,
  catalogScaleShape,
  createCatalogScaleTemplates,
  createQueryRecorder,
  explainCatalogScaleOn,
  holdCatalogScaleRecords,
  rolledBackCatalogScale,
  type CatalogScaleDatabase,
  type CatalogScaleSeedOptions,
  type CatalogScaleShape,
  type CatalogScaleTemplates,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { CatalogRenditionRole, PublishingJobLease } from "@moya/api";

/*
 * catalog-scale-v1 (Issue #323) 1B W7 on the scale fixture, through the real
 * roles and views: the scoped Catalog publication reconcile.
 * - A pass over a Catalog no larger than K schedules exactly what the
 *   whole-Catalog reconcile of 0859d19a scheduled (its statement, kept here
 *   verbatim as the oracle, over the whole-Catalog copy set).
 * - Never outside the scope: a Catalog asset the pass did not plan is never
 *   a candidate; a fixed point larger than K stays one.
 * - N3 at scale: a recipe bump over a Catalog larger than K is copied and
 *   retired pass by pass; every asset keeps serving one complete generation,
 *   and the previous set is withdrawn only once its replacement is
 *   published.
 * - Dirty marks: a pass clears exactly the marks it read before planning;
 *   marks made meanwhile, more marks than K, a failed plan and an asset the
 *   budget did not reach all stay pending; two passes at once lose nothing
 *   and duplicate nothing. With the jobs run between passes, a queue larger
 *   than K drains at the dirty share of K a pass: the re-plan after each job
 *   waits behind the first marks.
 * - In flight: a publishing generation whose job ran out of attempts never
 *   takes a slot while publishing is allowed (it counts as present, as it
 *   always has), so a takedown is scheduled in the next pass; while it is
 *   not, in flight and the queue each get half the room; an in-flight asset
 *   a pass could not plan waits in the queue, behind the earlier marks.
 * - The sweep keeps its share of K under a saturated queue, wraps, and
 *   starts a new round when the recipe policy changes; a pass's statements
 *   follow K, not the Catalog.
 * - Takedowns first (W-AC5): an urgent mark stays urgent under a normal
 *   one, a normal one becomes urgent in its place, and a pass never
 *   downgrades one it carries over; a takedown queued behind more than K
 *   publish-side marks that inspect is scheduled within two passes, and so
 *   is one the membership step marks right after a release wave lists the
 *   buckets of more than two passes of images private B serves (their
 *   requests inspect); and a pass whose every batch takes more than half
 *   its budget still plans the oldest urgent marks and moves the sweep on.
 * - A rendition recorded for an asset outside the sweep is published by the
 *   next pass, a purge that failed with attempts left is retried from the
 *   in-flight part of the scope, and an intent's public generations are
 *   recorded by the pass after its publish job.
 * - Locally, at the 25k fixture (MOYA_CATALOG_SCALE_RECONCILE_IMAGES=25200):
 *   a pass plans at most K within its budget, and none of its statements is
 *   JIT-compiled, the in-flight read with every generation withdrawing
 *   included.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 600_000;
// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
let templates: CatalogScaleTemplates;
let fixture: CatalogScaleDatabase;

const hex = (bytes = 8) => randomBytes(bytes).toString("hex");
const blobKey = () => {
  const key = hex(16);
  return `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
};
const ROLES = ["thumb", "cover", "display", "viewer"];
/** A shape with published images only: no intents, no drafts. */
const plain = (publishedImages: number): CatalogScaleShape =>
  catalogScaleShape(publishedImages, {
    draftRecords: 0,
    releasedIntents: 0,
    endedIntents: 0,
    recentEndedIntents: 0,
    livePrepares: 0,
  });

beforeAll(async () => {
  templates = await createCatalogScaleTemplates({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csrec",
  });
}, SLOW);

afterAll(async () => {
  await templates?.close();
}, SLOW);

/** A database of its own holding `shape` as seeded (a copy of its template,
 * seeded once per shape and options), the previous one dropped; returns the
 * seed's shape and counts. */
const reseed = async (
  shape: CatalogScaleShape,
  options: CatalogScaleSeedOptions = {},
) => {
  await fixture?.close();
  fixture = await templates.seeded(shape, options);
  return { shape, counts: catalogScaleCounts(shape) };
};

type Authority = ReturnType<typeof createCatalogPublicationAuthority>;
const authority = (): Authority =>
  createCatalogPublicationAuthority(
    fixture.publicRead,
    fixture.prepare,
    fixture.app,
  );
const adapter = (
  catalogScope?: { readonly max?: number; readonly budgetMs?: number },
  catalogAuthority: Pick<
    Authority,
    "planScope" | "acquire" | "publishedAssetIds"
  > = authority(),
  allowPublish = true,
) =>
  new PostgresMediaPublicationAdapter(fixture.app, {
    isPublic: () => true,
    allowPublish: () => allowPublish,
    catalogAuthority,
    ...(catalogScope ? { catalogScope } : {}),
  });
/** The authority, with every pass's planned and failed assets kept. */
const recording = (inner: Authority = authority()) => {
  const passes: { planned: string[]; failed: string[]; order: string[] }[] = [];
  return {
    passes,
    authority: {
      ...inner,
      async planScope(
        assetIds: readonly string[],
        options: { readonly budgetMs: number },
      ) {
        const planned = await inner.planScope(assetIds, options);
        passes.push({
          planned: [...planned.plans.keys()],
          failed: [...planned.failed],
          order: [...assetIds],
        });
        return planned;
      },
    } satisfies Pick<Authority, "planScope" | "acquire" | "publishedAssetIds">,
  };
};

/** Queued publish and withdraw jobs, as `kind subject` lines. */
const queuedJobs = async () =>
  (
    await fixture.setup.query<{ job: string }>(
      "SELECT kind || ' ' || subject_id AS job FROM community.publishing_jobs WHERE kind IN ('publish_media','withdraw_media') AND state='queued' ORDER BY 1",
    )
  ).rows.map((row) => row.job);
const clearJobs = () =>
  fixture.setup.query(
    "DELETE FROM community.publishing_jobs WHERE kind IN ('publish_media','withdraw_media','verify_withdrawal')",
  );
/** A1's mark, as the other writers of marks make it (normal unless
 * `urgent`). */
const mark = (
  ids: readonly string[],
  reason = "public_membership",
  urgent = false,
) =>
  fixture.setup.query(
    `INSERT INTO community.catalog_publication_dirty AS d (asset_id,mark_seq,reason,urgent,marked_at)
     SELECT m.id,1,$2,$3,clock_timestamp() FROM unnest($1::text[]) AS m(id) ORDER BY m.id
     ON CONFLICT (asset_id) DO UPDATE SET mark_seq=d.mark_seq+1,reason=EXCLUDED.reason,
       urgent=EXCLUDED.urgent OR (d.mark_seq>d.cleared_seq AND d.urgent),
       marked_at=CASE WHEN d.mark_seq>d.cleared_seq THEN d.marked_at ELSE EXCLUDED.marked_at END`,
    [[...ids].sort(), reason, urgent],
  );
/** One asset's mark through the module's own statement, as the App role. */
const writeMark = (id: string, reason: string, urgent: boolean) =>
  markCatalogPublicationDirty(
    fixture.app,
    new Map([[id, { reason: reason as "rendition", urgent }]]),
    new Date(),
  );
/** Every mark row: asset, mark_seq, whether pending and urgent, marked_at. */
const marks = async () =>
  new Map(
    (
      await fixture.setup.query<{
        asset_id: string;
        mark_seq: string;
        pending: boolean;
        urgent: boolean;
        marked_at: Date;
      }>(
        "SELECT asset_id,mark_seq,mark_seq>cleared_seq AS pending,urgent,marked_at FROM community.catalog_publication_dirty",
      )
    ).rows.map((row) => [row.asset_id, row]),
  );
const pending = async () =>
  [...(await marks()).values()]
    .filter((row) => row.pending)
    .map((row) => row.asset_id)
    .sort();
const state = async () =>
  (
    await fixture.setup.query<{
      sweep_cursor: string | null;
      policy_digest: string | null;
    }>(
      "SELECT sweep_cursor,policy_digest FROM community.catalog_reconcile_state",
    )
  ).rows;
const setCursor = (cursor: string | null) =>
  fixture.setup.query(
    "UPDATE community.catalog_reconcile_state SET sweep_cursor=$1 WHERE id",
    [cursor],
  );
/** Every Catalog asset id, in the sweep's order. */
const assetIds = async () =>
  (
    await fixture.setup.query<{ id: string }>(
      "SELECT id FROM community.catalog_media_assets ORDER BY id",
    )
  ).rows.map((row) => row.id);
/** The asset ids of the published images of records first..last. */
const recordAssets = (first: number, last: number, perRecord = 7) =>
  Array.from({ length: last - first + 1 }, (_, r) =>
    Array.from(
      { length: perRecord },
      (_, i) => catalogScaleImage(first + r, i + 1).assetId,
    ),
  ).flat();
/** Unpublishes records first..last in the CMS (their pairs leave
 * catalog_media). */
const takeDown = (first: number, last: number) =>
  fixture.setup.query(
    "UPDATE public.catalogs SET _status='draft' WHERE id BETWEEN $1 AND $2",
    [first, last],
  );

/** Runs every queued publish and withdraw job through the real adapter, as
 * the two lanes run them (withdrawals first), to completion; returns them.
 * `check` runs after each withdrawal. */
const runJobs = async (
  when: Date,
  check: (subject: string) => Promise<void> = async () => undefined,
) => {
  const jobs = (
    await fixture.setup.query<{ id: string; kind: string; subject: string }>(
      "SELECT id,kind,subject_id AS subject FROM community.publishing_jobs WHERE kind IN ('publish_media','withdraw_media') AND state='queued' ORDER BY kind DESC,subject_id",
    )
  ).rows;
  const publication = adapter();
  for (const job of jobs) {
    const owner = hex();
    await fixture.setup.query(
      "UPDATE community.publishing_jobs SET state='running',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '1 hour' WHERE id=$1",
      [job.id, owner, when],
    );
    const lease: PublishingJobLease = { id: job.id, leaseOwner: owner };
    const plan =
      job.kind === "publish_media"
        ? await publication.planPublish(job.subject, lease, when)
        : await publication.planWithdrawal(job.subject, lease, when);
    if (plan.status !== "ready") throw new Error(`${job.kind} ${plan.status}`);
    try {
      const ids = plan.units.map((unit) => unit.id);
      if (job.kind === "publish_media")
        expect(await publication.finishPublish(plan.fence, when)).toBe(true);
      else if (ids.length) {
        expect(
          await publication.recordOriginDeleted(plan.fence, ids, when),
        ).toBe(true);
        expect(await publication.finishWithdrawal(plan.fence, ids, when)).toBe(
          true,
        );
      }
    } finally {
      await publication.release(plan.fence, when);
    }
    await fixture.setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [job.id, when],
    );
    if (job.kind === "withdraw_media") await check(job.subject);
  }
  return jobs;
};

describe(
  "W7: a pass over a Catalog no larger than K equals the whole-Catalog reconcile",
  { timeout: SLOW },
  () => {
    /** The desired set the adapter binds a Catalog selection into, as its
     * item lookup issues it (`r.id=ANY($2::text[])`), renumbered to $3: the
     * desired set of the whole-Catalog reconcile of 0859d19a. */
    const recordedDesiredSql = async () => {
      const recorder = createQueryRecorder();
      await new PostgresMediaPublicationAdapter(
        recorder.wrap("app", fixture.app),
        {
          isPublic: () => true,
          allowPublish: () => true,
          catalogAuthority: authority(),
        },
      ).lookupPublishedItems([`media-item-${"0".repeat(32)}`], new Date());
      const lookup = recorder.queries.find(({ sql }) =>
        sql.startsWith("SELECT a.item_id,p.role"),
      )!.sql;
      const desired = lookup.slice(
        lookup.indexOf("JOIN (") + "JOIN (".length,
        lookup.lastIndexOf(") d ON d.rendition_id=p.rendition_id"),
      );
      expect(desired.match(/\$\d+/gu)).toEqual(["$2", "$2"]);
      return desired.replaceAll("$2::text[]", "$3::text[]");
    };
    /** The whole-Catalog reconcile statement of 0859d19a, verbatim. */
    const oracleSql = (
      desired: string,
      subjects = "COALESCE(a.item_id,a.catalog_asset_id)",
    ) => `WITH desired AS (${desired}), wanted AS (SELECT DISTINCT COALESCE(d.item_id,d.catalog_asset_id) AS subject_id,d.item_id,d.catalog_asset_id FROM desired d), subjects AS (
        SELECT w.subject_id,w.item_id,w.catalog_asset_id FROM wanted w UNION SELECT ${subjects},a.item_id,a.catalog_asset_id FROM community.media_public_assets a
      ) , candidates AS (SELECT s.*, EXISTS(SELECT 1 FROM desired d WHERE COALESCE(d.item_id,d.catalog_asset_id)=s.subject_id AND NOT EXISTS(SELECT 1 FROM community.media_publications p WHERE p.rendition_id=d.rendition_id AND p.state IN ('publishing','published'))) AS publish,
        EXISTS(SELECT 1 FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE ${subjects}=s.subject_id AND ((p.state IN ('publishing','published') AND (NOT EXISTS(SELECT 1 FROM desired d WHERE d.rendition_id=p.rendition_id) OR (p.state='publishing' AND NOT $2::boolean))) OR (p.state IN ('withdrawing','purge_failed') AND p.purge_attempts<3))) AS withdraw,
        EXISTS(SELECT 1 FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE ${subjects}=s.subject_id AND p.state IN ('publishing','published') AND (NOT EXISTS(SELECT 1 FROM desired d WHERE d.rendition_id=p.rendition_id) OR (p.state='publishing' AND NOT $2::boolean))) AS fence_change
      FROM subjects s WHERE NOT EXISTS(SELECT 1 FROM community.publishing_jobs j WHERE j.subject_id=s.subject_id AND j.kind IN ('publish_media','withdraw_media','verify_withdrawal') AND j.state IN ('queued','running'))) SELECT * FROM candidates WHERE ($2::boolean AND publish) OR withdraw ORDER BY subject_id LIMIT $1`;
    /** What the whole-Catalog reconcile schedules over the whole-Catalog
     * copy set `ids`: its counts and its jobs (a publish for each publish
     * candidate, a withdrawal for each withdrawal candidate and for each
     * publish candidate with a live generation, which the publication sync
     * re-checks). */
    const oracle = async (allow: boolean, ids: readonly string[]) => {
      const rows = (
        await fixture.app.query<{
          subject_id: string;
          publish: boolean;
          withdraw: boolean;
        }>(oracleSql(await recordedDesiredSql()), [500, allow, ids])
      ).rows;
      const live = new Set(
        (
          await fixture.setup.query<{ subject: string }>(
            "SELECT DISTINCT COALESCE(a.item_id,a.catalog_asset_id) AS subject FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE p.state<>'withdrawn'",
          )
        ).rows.map((row) => row.subject),
      );
      const publish = allow ? rows.filter((s) => s.publish) : [];
      return {
        counts: {
          publish: publish.length,
          withdraw: rows.filter((s) => s.withdraw).length,
        },
        jobs: [
          ...publish.map((s) => `publish_media ${s.subject_id}`),
          ...new Set(
            rows
              .filter(
                (s) =>
                  s.withdraw || (allow && s.publish && live.has(s.subject_id)),
              )
              .map((s) => `withdraw_media ${s.subject_id}`),
          ),
        ].sort(),
        rows: rows.length,
      };
    };

    it("schedules the same jobs with and without publication allowed", async () => {
      // 245 images in the fixture's proportions; the draft images of live
      // intents are ready but unpublished (private B for the requested).
      const seeded = await reseed(catalogScaleShape(245), {
        liveAssets: "ready",
      });
      const counts = seeded.counts;
      // A recipe bump mid-way (copies, no withdrawal), three records taken
      // down (withdrawals), a purge that failed once (a retried withdrawal
      // of a still-desired rendition, which is also copied again).
      expect(await bumpCatalogScaleRecipe(fixture, { first: 1, last: 3 })).toBe(
        21,
      );
      await takeDown(4, 6);
      const failedPurge = catalogScaleImage(8, 1).assetId;
      await fixture.setup.query(
        `UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=now(),version=version+1
         WHERE rendition_id=$1`,
        [catalogScaleRenditionId(failedPurge, "thumb")],
      );
      await fixture.setup.query(
        `UPDATE community.media_publications SET state='purge_failed',purge_attempts=1,version=version+1
         WHERE rendition_id=$1`,
        [catalogScaleRenditionId(failedPurge, "thumb")],
      );
      expect(counts.requested).toBeGreaterThan(0);
      // The copy set is read once: between the two passes no job runs and
      // nothing it plans from changes (the second plan's inspections find
      // the pins the first one made).
      const ids = await wholeCatalogCopySet(
        fixture.publicRead,
        fixture.prepare,
        fixture.app,
      );
      for (const allow of [false, true]) {
        await clearJobs();
        await fixture.setup.query(
          "TRUNCATE community.catalog_publication_dirty",
        );
        const expected = await oracle(allow, ids);
        expect(expected.rows).toBeLessThan(500);
        expect(expected.counts.withdraw).toBeGreaterThanOrEqual(22);
        if (allow) expect(expected.counts.publish).toBeGreaterThan(22);
        const passes = recording();
        expect(
          await adapter(undefined, passes.authority, allow).reconcile(
            new Date(),
            allow,
            500,
          ),
          `allow ${allow}`,
        ).toEqual(expected.counts);
        expect(await queuedJobs(), `allow ${allow}`).toEqual(expected.jobs);
        // The pass planned the whole Catalog, in one sweep.
        expect(passes.passes[0]!.planned.sort()).toEqual(await assetIds());
        expect(await state()).toEqual([
          {
            sweep_cursor: null,
            policy_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ]);
      }
    });
  },
);

describe(
  "W7: a Catalog asset outside the pass's scope is never a candidate",
  { timeout: SLOW },
  () => {
    it("keeps a fixed point larger than K one, and withdraws only taken-down assets it planned", async () => {
      await reseed(plain(350));
      const all = await assetIds();
      // The Catalog is at its fixed point: a pass that plans 50 of its 350
      // assets schedules nothing, publishes and withdraws nothing.
      const passes = recording();
      expect(
        await adapter({ max: 50 }, passes.authority).reconcile(
          new Date(),
          true,
          500,
        ),
      ).toEqual({ publish: 0, withdraw: 0 });
      expect(passes.passes[0]!.planned).toHaveLength(50);
      expect(await queuedJobs()).toEqual([]);
      expect((await state())[0]!.sweep_cursor).toBe(all[49]);
      // Ten records (70 assets) taken down, unmarked: only the ones the next
      // pass sweeps are withdrawn.
      await takeDown(1, 10);
      const down = new Set(recordAssets(1, 10));
      await adapter({ max: 50 }, passes.authority).reconcile(
        new Date(),
        true,
        500,
      );
      const swept = passes.passes[1]!.planned;
      expect(swept).toEqual(all.slice(50, 100));
      const expected = swept
        .filter((id) => down.has(id))
        .map((id) => `withdraw_media ${id}`)
        .sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(await queuedJobs()).toEqual(expected);
    });
  },
);

describe(
  "W7: N3 at scale: a recipe bump over a Catalog larger than K",
  { timeout: SLOW },
  () => {
    // CI: 70 images, K = 14 (five passes a round, as the issue's 2,000 and
    // 500 give four). MOYA_CATALOG_SCALE_RECONCILE_N3=2000 runs the issue's
    // 2,000 assets with K = 500 (W-AC6).
    const IMAGES = Number(process.env.MOYA_CATALOG_SCALE_RECONCILE_N3 ?? 70);
    const K = IMAGES >= 2_000 ? 500 : 14;

    it("copies and retires every asset's set pass by pass, never withdrawing before the replacement is published", async () => {
      const seeded = await reseed(plain(IMAGES));
      const records = seeded.counts.records;
      const bumped = await bumpCatalogScaleRecipe(fixture, {
        first: 1,
        last: records,
      });
      expect(bumped).toBe(IMAGES);
      const all = await assetIds();
      const pairs = Array.from({ length: records }, (_, r) =>
        Array.from(
          {
            length:
              r + 1 === records
                ? seeded.counts.lastRecordImages
                : seeded.shape.imagesPerRecord,
          },
          (_, i) => catalogScaleImage(r + 1, i + 1),
        ),
      ).flat();
      const generationOf = (assetId: string, generation: 1 | 2) =>
        ROLES.map((role) =>
          catalogScaleRenditionId(assetId, role, generation),
        ).sort();
      /** Each asset's published renditions. */
      const published = async () => {
        const rows = (
          await fixture.setup.query<{ asset: string; rendition: string }>(
            "SELECT a.catalog_asset_id AS asset,p.rendition_id AS rendition FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id WHERE p.state='published' ORDER BY 2",
          )
        ).rows;
        const byAsset = new Map<string, string[]>();
        for (const row of rows)
          byAsset.set(row.asset, [
            ...(byAsset.get(row.asset) ?? []),
            row.rendition,
          ]);
        return byAsset;
      };
      /** Every asset serves one complete generation, the previous or the
       * current, never a mix and never nothing. */
      const servesOneGeneration = async (label: string) => {
        const served = await readCatalogDeliveryProjection(
          fixture.app,
          pairs.map(({ mediaId, objectKey }) => ({ mediaId, objectKey })),
          catalogExpectedRenditions,
        );
        for (const image of pairs) {
          const keys = served
            .get(JSON.stringify([image.mediaId, image.objectKey]))
            ?.renditions?.map((r) => r.key)
            .sort();
          expect(
            [
              generationOf(image.assetId, 1),
              generationOf(image.assetId, 2),
            ].map((g) => JSON.stringify(g)),
            `${label} ${image.assetId}`,
          ).toContain(JSON.stringify(keys));
        }
      };
      /** A withdrawal of the previous set only once the current one is
       * published. */
      const replacedFirst = async (subject: string) => {
        const live = (await published()).get(subject) ?? [];
        const previousLive = generationOf(subject, 1).filter((id) =>
          live.includes(id),
        );
        if (previousLive.length < 4)
          expect(
            generationOf(subject, 2).every((id) => live.includes(id)),
            subject,
          ).toBe(true);
      };
      await servesOneGeneration("seeded");
      /** Every asset publishes its current set alone, and nothing waits. */
      const settled = async () => {
        const live = await published();
        return (
          all.every(
            (id) =>
              JSON.stringify([...(live.get(id) ?? [])].sort()) ===
              JSON.stringify(generationOf(id, 2)),
          ) &&
          !(await queuedJobs()).length &&
          !(await pending()).length
        );
      };
      const passes = recording();
      // Each asset takes three plans (found by the sweep, retired after its
      // copy, cleared after its withdrawal), K a pass.
      const bound = Math.ceil((3 * IMAGES) / K) + 6;
      let pass = 0;
      for (; pass < bound && !(await settled()); pass += 1) {
        const before = new Set(await queuedJobs());
        await adapter({ max: K }, passes.authority).reconcile(
          new Date(),
          true,
          500,
        );
        const planned = new Set(passes.passes.at(-1)!.planned);
        expect(planned.size).toBeLessThanOrEqual(K);
        const scheduled = (await queuedJobs()).filter(
          (job) => !before.has(job),
        );
        const live = await published();
        for (const job of scheduled) {
          const [kind, subject] = job.split(" ") as [string, string];
          // Never outside the scope.
          expect(planned.has(subject), job).toBe(true);
          // A withdrawal that is not the publication sync's re-check of a
          // copy comes only once the replacement is published (N3).
          if (
            kind === "withdraw_media" &&
            !scheduled.includes(`publish_media ${subject}`)
          )
            expect(
              generationOf(subject, 2).every((id) =>
                (live.get(subject) ?? []).includes(id),
              ),
              `pass ${pass} ${job}`,
            ).toBe(true);
        }
        await runJobs(new Date(), replacedFirst);
        await servesOneGeneration(`pass ${pass}`);
      }
      // Every asset now serves and publishes the current set alone, within
      // the bound.
      expect(await settled()).toBe(true);
      expect(pass).toBeLessThan(bound);
    });
  },
);

describe(
  "W7: dirty marks, budget, failures and concurrency",
  { timeout: SLOW },
  () => {
    it("clears exactly the marks read before planning; marks made meanwhile stay pending", async () => {
      await reseed(plain(140));
      const all = await assetIds();
      const marked = all.slice(0, 10);
      await mark(marked);
      const before = await marks();
      const inner = authority();
      const late = all.slice(100, 101);
      const during = {
        ...inner,
        async planScope(
          ids: readonly string[],
          options: { readonly budgetMs: number },
        ) {
          const planned = await inner.planScope(ids, options);
          // Two planned assets are marked again, and one more is marked,
          // while the pass plans.
          await mark([...marked.slice(0, 2), ...late], "intent");
          return planned;
        },
      };
      expect(
        await adapter({ max: 50 }, during).reconcile(new Date(), true, 500),
      ).toEqual({ publish: 0, withdraw: 0 });
      const after = await marks();
      expect(await pending()).toEqual([...marked.slice(0, 2), ...late].sort());
      for (const id of marked.slice(2))
        expect(after.get(id)!.mark_seq, id).toBe(before.get(id)!.mark_seq);
      for (const id of marked.slice(0, 2))
        expect(Number(after.get(id)!.mark_seq), id).toBe(
          Number(before.get(id)!.mark_seq) + 1,
        );
    });

    it("drains more marks than K oldest first, scheduling each taken-down asset once", async () => {
      await reseed(plain(140));
      // Ten records (70 assets) taken down and marked, as the membership
      // fingerprint marks them; K = 20 plans 18 of them a pass.
      await takeDown(1, 10);
      const down = recordAssets(1, 10);
      await mark(down);
      const scheduled: string[] = [];
      for (let pass = 1; pass <= Math.ceil(70 / 18); pass += 1) {
        await adapter({ max: 20 }).reconcile(new Date(), true, 500);
        const jobs = await queuedJobs();
        expect(new Set(jobs).size).toBe(jobs.length);
        scheduled.splice(0, scheduled.length, ...jobs);
      }
      expect(scheduled).toEqual(
        down.map((id) => `withdraw_media ${id}`).sort(),
      );
      // Every one stays marked while its withdrawal is queued, and the pass
      // after its job clears it.
      expect(await pending()).toEqual([...down].sort());
      await runJobs(new Date());
      for (let pass = 0; pass < Math.ceil(70 / 18); pass += 1)
        await adapter({ max: 20 }).reconcile(new Date(), true, 500);
      expect(await pending()).toEqual([]);
      expect(await queuedJobs()).toEqual([]);
    });

    it("drains a queue larger than K at the dirty share of K a pass while the jobs run between passes", async () => {
      await reseed(plain(140));
      await takeDown(1, 10);
      const down = recordAssets(1, 10);
      await mark(down);
      // Each pass's withdrawals run before the next pass, as the withdraw
      // lane runs them. The re-plan after a job goes to the back of the
      // queue, so every pass schedules first marks: ⌈70 / 18⌉ passes.
      // The passes' clocks, after the marks (the database's clock), so the
      // order is the passes' and not two clocks' skew: a pass moves the marks
      // it leaves to its own time, and a host clock even a millisecond behind
      // the database's would put them ahead of the last first marks.
      const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
      const scheduled = new Map<string, number>();
      const passes = Math.ceil(70 / 18);
      for (let pass = 1; pass <= passes; pass += 1) {
        await adapter({ max: 20 }).reconcile(at(pass), true, 500);
        for (const job of await runJobs(at(pass)))
          scheduled.set(job.subject, (scheduled.get(job.subject) ?? 0) + 1);
      }
      expect([...scheduled.keys()].sort()).toEqual([...down].sort());
      expect(new Set(scheduled.values())).toEqual(new Set([1]));
      // The re-plans after the jobs then clear every mark, scheduling
      // nothing more.
      for (let pass = 0; pass < passes && (await pending()).length; pass += 1)
        await adapter({ max: 20 }).reconcile(at(passes + 1 + pass), true, 500);
      expect(await pending()).toEqual([]);
      expect(await queuedJobs()).toEqual([]);
    });

    it("excludes an asset whose plan throws, which stays marked behind newer marks; a pass where every plan fails writes nothing", async () => {
      await reseed(plain(140));
      await takeDown(1, 2);
      const down = recordAssets(1, 2);
      const broken = down[0]!;
      await mark(down);
      await mark([(await assetIds()).at(-1)!], "rendition");
      const before = await marks();
      // The App read of the broken asset's row fails, every time.
      const app = new Proxy(fixture.app, {
        get(pool, key) {
          if (key === "query")
            return (sql: string, values?: unknown[]) =>
              sql.startsWith(
                "SELECT id,media_id,source_object_key FROM community.catalog_media_assets",
              ) && (values?.[0] as string[]).includes(broken)
                ? Promise.reject(
                    Object.assign(new Error("terminating connection"), {
                      code: "57P01",
                    }),
                  )
                : pool.query(sql, values);
          const value = Reflect.get(pool, key, pool) as unknown;
          return typeof value === "function" ? value.bind(pool) : value;
        },
      });
      const failing = createCatalogPublicationAuthority(
        fixture.publicRead,
        fixture.prepare,
        app,
      );
      const passes = recording(failing);
      // The pass's clock, a minute after the marks (the database's clock),
      // so the order is the pass's and not two clocks' skew.
      const later = new Date(Date.now() + 60_000);
      expect(
        await adapter({ max: 50 }, passes.authority).reconcile(
          later,
          true,
          500,
        ),
      ).toEqual({ publish: 0, withdraw: down.length - 1 });
      expect(passes.passes[0]!.failed).toEqual([broken]);
      expect(await queuedJobs()).not.toContain(`withdraw_media ${broken}`);
      const after = await marks();
      expect(after.get(broken)!.pending).toBe(true);
      expect(after.get(broken)!.mark_seq).toBe(before.get(broken)!.mark_seq);
      // Behind every mark made before the pass, at the pass's time.
      expect(after.get(broken)!.marked_at).toEqual(later);
      for (const [id, row] of before)
        if (id !== broken)
          expect(after.get(broken)!.marked_at.getTime()).toBeGreaterThan(
            row.marked_at.getTime(),
          );
      // A pass where every plan fails (the CMS is unavailable) fails, as
      // the whole-Catalog plan did, and writes nothing.
      const snapshot = JSON.stringify([
        [...(await marks()).entries()],
        await state(),
        await queuedJobs(),
      ]);
      const unavailable = createCatalogPublicationAuthority(
        new Proxy(fixture.publicRead, {
          get(pool, key) {
            if (key === "query" || key === "connect")
              return () =>
                Promise.reject(
                  Object.assign(new Error("connection refused"), {
                    code: "ECONNREFUSED",
                  }),
                );
            const value = Reflect.get(pool, key, pool) as unknown;
            return typeof value === "function" ? value.bind(pool) : value;
          },
        }),
        fixture.prepare,
        fixture.app,
      );
      await expect(
        adapter({ max: 50 }, unavailable).reconcile(new Date(), true, 500),
      ).rejects.toThrow("connection refused");
      expect(
        JSON.stringify([
          [...(await marks()).entries()],
          await state(),
          await queuedJobs(),
        ]),
      ).toBe(snapshot);
    });

    it("leaves the assets the budget did not reach as they were, the sweep included", async () => {
      await reseed(plain(350));
      const all = await assetIds();
      // 150 marks, oldest first in id order; K = 300 plans the first 100 and
      // the sweep's share (30) whatever its budget.
      await mark(all.slice(200, 350));
      const before = await marks();
      const inner = authority();
      // The budget stops the pass right after its reserved part: the first
      // 100 marks and the sweep's share.
      const stopped = {
        ...inner,
        planScope: (
          ids: readonly string[],
          options: { readonly budgetMs: number; readonly reserved?: number },
        ) => {
          expect(options.reserved).toBe(130);
          return inner.planScope(ids.slice(0, options.reserved), options);
        },
      };
      await adapter({ max: 300 }, stopped).reconcile(new Date(), true, 500);
      const after = await marks();
      const attempted = new Set(all.slice(200, 300));
      for (const id of all.slice(200, 350))
        if (attempted.has(id)) expect(after.get(id)!.pending, id).toBe(false);
        else expect(after.get(id), id).toEqual(before.get(id));
      // The sweep moved past its share only.
      expect((await state())[0]!.sweep_cursor).toBe(all[29]);
    });

    it("keeps a pending mark urgent under a normal one, raises a pending normal one to urgent in its place, and never lets a pass downgrade one it carries over", async () => {
      await reseed(plain(140));
      const all = await assetIds();
      const [a, b, c] = all.slice(120, 123) as [string, string, string];
      const markNow = (id: string, urgent: boolean) =>
        writeMark(id, urgent ? "public_membership" : "rendition", urgent);
      await markNow(a, true);
      await markNow(b, false);
      await markNow(c, false);
      const placed = await marks();
      // A normal mark on a pending urgent row leaves it urgent; an urgent
      // mark on a pending normal row makes it urgent; both keep their place.
      await markNow(a, false);
      await markNow(b, true);
      const raised = await marks();
      for (const id of [a, b]) {
        expect(raised.get(id)!.urgent, id).toBe(true);
        expect(raised.get(id)!.marked_at, id).toEqual(
          placed.get(id)!.marked_at,
        );
      }
      expect(raised.get(c)!.urgent).toBe(false);
      // A cleared row takes the class of the mark that makes it pending.
      await fixture.setup.query(
        "UPDATE community.catalog_publication_dirty SET cleared_seq=mark_seq WHERE asset_id=$1",
        [a],
      );
      await markNow(a, false);
      expect((await marks()).get(a)!.urgent).toBe(false);
      // A pass reads urgent marks first, then the others.
      await fixture.setup.query(
        "UPDATE community.catalog_publication_dirty SET cleared_seq=mark_seq",
      );
      await takeDown(1, 1);
      const down = recordAssets(1, 1);
      await mark([c], "rendition");
      await mark(down, "public_membership", true);
      const passes = recording();
      await adapter({ max: 20 }, passes.authority).reconcile(
        new Date(Date.now() + 60_000),
        true,
        500,
      );
      expect(passes.passes[0]!.order.slice(0, 8)).toEqual([
        ...[...down].sort(),
        c,
      ]);
      // The pass scheduled each withdrawal and keeps each mark for the pass
      // after its job: still urgent, at the back of its class.
      expect(await queuedJobs()).toEqual(
        down.map((id) => `withdraw_media ${id}`).sort(),
      );
      const kept = await marks();
      for (const id of down) {
        expect(kept.get(id)!.pending, id).toBe(true);
        expect(kept.get(id)!.urgent, id).toBe(true);
      }
    });

    it("runs two passes at once without losing or duplicating a job or mark", async () => {
      await reseed(plain(140));
      await takeDown(1, 1);
      const down = recordAssets(1, 1);
      await mark(down);
      const inner = authority();
      let arrived = 0;
      let release: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const together = {
        ...inner,
        async planScope(
          ids: readonly string[],
          options: { readonly budgetMs: number },
        ) {
          const planned = await inner.planScope(ids, options);
          // Both passes have planned before either writes.
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
          return planned;
        },
      };
      const results = await Promise.all([
        adapter({ max: 50 }, together).reconcile(new Date(), true, 500),
        adapter({ max: 50 }, together).reconcile(new Date(), true, 500),
      ]);
      expect(results.map((r) => r.withdraw).sort()).toEqual([0, down.length]);
      expect(await queuedJobs()).toEqual(
        down.map((id) => `withdraw_media ${id}`).sort(),
      );
      // Each stays marked for the pass after its job; the sweep moved once.
      expect(await pending()).toEqual([...down].sort());
      const all = await assetIds();
      const swept = all.filter((id) => !down.includes(id));
      expect((await state())[0]!.sweep_cursor).toBe(swept[50 - 7 - 1]);
    });
  },
);

describe("W7: the sweep and a pass's cost", { timeout: SLOW }, () => {
  it("keeps the sweep's share under a saturated queue, wraps, and restarts on a new recipe policy", async () => {
    await reseed(plain(140));
    const all = await assetIds();
    // Forty assets that need nothing are marked before every pass: K = 20
    // plans 18 of them and 2 from the sweep.
    const busy = all.slice(70, 110);
    const pass = async () => {
      await mark(busy);
      const passes = recording();
      await adapter({ max: 20 }, passes.authority).reconcile(
        new Date(),
        true,
        500,
      );
      return passes.passes[0]!;
    };
    const first = await pass();
    // The sweep's share follows the queue's first batch (18 marks here).
    expect(first.order.slice(18, 20)).toEqual(all.slice(0, 2));
    expect(first.planned).toHaveLength(20);
    expect((await state())[0]!.sweep_cursor).toBe(all[1]);
    await pass();
    expect((await state())[0]!.sweep_cursor).toBe(all[3]);
    // At the end of the ids the sweep continues from the start.
    await setCursor(all.at(-2)!);
    const wrapped = await pass();
    expect(wrapped.order.slice(18, 20)).toEqual([all.at(-1), all[0]]);
    expect((await state())[0]!.sweep_cursor).toBe(all[0]);
    // A changed recipe policy starts a new round.
    await fixture.setup.query(
      "UPDATE community.catalog_reconcile_state SET policy_digest=$1 WHERE id",
      ["f".repeat(64)],
    );
    await pass();
    const [after] = await state();
    expect(after!.sweep_cursor).toBeNull();
    expect(after!.policy_digest).not.toBe("f".repeat(64));
  });

  it("issues the same statements per pass whatever the Catalog's size", async () => {
    const measured: Record<string, number>[] = [];
    for (const images of [140, 350]) {
      await reseed(plain(images));
      // A queue of 40 marked assets and the sweep: K = 50.
      await mark((await assetIds()).slice(60, 100));
      const recorder = createQueryRecorder();
      const scoped = createCatalogPublicationAuthority(
        recorder.wrap("cms", fixture.publicRead),
        recorder.wrap("prepare", fixture.prepare),
        recorder.wrap("app", fixture.app),
      );
      await new PostgresMediaPublicationAdapter(
        recorder.wrap("app", fixture.app),
        {
          isPublic: () => true,
          allowPublish: () => true,
          catalogAuthority: scoped,
          catalogScope: { max: 50 },
        },
      ).reconcile(new Date(), true, 500);
      measured.push(recorder.counts().statements);
      // The scope reads the pass issues are the fixture's copies, verbatim.
      expect(recorder.queries.map((q) => q.sql)).toEqual(
        expect.arrayContaining([
          catalogScaleIndexedStatements.inFlight,
          catalogScaleIndexedStatements.pending,
        ]),
      );
    }
    expect(measured[0]).toEqual(measured[1]);
  });
});

describe("W7: what marks a pass's work", { timeout: SLOW }, () => {
  it("publishes a rendition recorded for an asset outside the sweep in the next pass", async () => {
    await reseed(plain(140));
    const all = await assetIds();
    const image = catalogScaleImage(10, 3);
    // The sweep is far from the asset.
    const at = all.indexOf(image.assetId);
    await setCursor(all[(at + 70) % all.length]!);
    const bumped = (width: number, height: number) =>
      catalogExpectedRenditions(width, height).map((want) => ({
        ...want,
        version: want.version + 1,
        digest: "fedcba9876543210",
      }));
    // The worker records a re-render of the next recipe (its own path).
    expect(
      await new PostgresWorkPublishingAdapter(fixture.app, {
        publication: { allowPublish: () => true, isPublic: () => true },
      }).recordCatalogRenditions(
        image.assetId,
        {
          masterSha256: image.sourceSha256,
          masterWidth: image.width,
          masterHeight: image.height,
          placeholderColor: null,
          renditions: bumped(image.width, image.height).map((want) => ({
            storageKey: blobKey(),
            byteSize: 1000,
            sha256: hex(32),
            role: want.role as CatalogRenditionRole,
            recipeVersion: want.version,
            recipeDigest: want.digest,
            contentType: "image/webp" as const,
            width: want.width,
            height: want.height,
          })),
        },
        new Date(),
      ),
    ).toEqual({ status: "recorded" });
    expect(await pending()).toEqual([image.assetId]);
    const passes = recording();
    expect(
      await adapter({ max: 20 }, passes.authority).reconcile(
        new Date(),
        true,
        500,
      ),
    ).toEqual({ publish: 1, withdraw: 0 });
    expect(await queuedJobs()).toEqual([
      `publish_media ${image.assetId}`,
      `withdraw_media ${image.assetId}`,
    ]);
  });

  it("plans an asset whose purge failed with attempts left, unmarked and outside the sweep; not one without", async () => {
    await reseed(plain(140));
    const all = await assetIds();
    const retried = catalogScaleImage(5, 2).assetId;
    const exhausted = catalogScaleImage(6, 2).assetId;
    // A cursor whose next 20 assets are neither.
    const cursor = all.findIndex((_, c) =>
      [retried, exhausted].every(
        (id) => (all.indexOf(id) - c - 1 + all.length) % all.length >= 20,
      ),
    );
    await setCursor(all[cursor]!);
    // Each one's cover: withdrawing, then its purge failed.
    for (const [id, attempts] of [
      [retried, 1],
      [exhausted, 3],
    ] as const) {
      const rendition = catalogScaleRenditionId(id, "cover");
      await fixture.setup.query(
        "UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=now(),version=version+1 WHERE rendition_id=$1",
        [rendition],
      );
      await fixture.setup.query(
        "UPDATE community.media_publications SET state='purge_failed',purge_attempts=$2,version=version+1 WHERE rendition_id=$1",
        [rendition, attempts],
      );
    }
    const passes = recording();
    await adapter({ max: 20 }, passes.authority).reconcile(
      new Date(),
      true,
      500,
    );
    const [pass] = passes.passes;
    // In flight: planned first, as no mark is pending.
    expect(pass!.order[0]).toBe(retried);
    expect(pass!.order).not.toContain(exhausted);
    // Its withdrawal is tried again, and its still-desired cover copied again.
    expect(await queuedJobs()).toEqual([
      `publish_media ${retried}`,
      `withdraw_media ${retried}`,
    ]);
  });

  it("records an intent's public generations in the pass after its publish job", async () => {
    // Ready draft images; every fifth live intent is release_requested.
    const seeded = await reseed(catalogScaleShape(245), {
      liveAssets: "ready",
    });
    const counts = seeded.counts;
    const k = seeded.shape.requestedEvery;
    const intentId = catalogScaleIntentId("live", k);
    const image = catalogScaleImage(counts.records + k, 1);
    const all = await assetIds();
    await setCursor(all[(all.indexOf(image.assetId) + 200) % all.length]!);
    // A change of the intent marks its assets (as the sync does).
    await mark([image.assetId], "intent");
    const pins = async () =>
      (
        await fixture.setup.query<{ generation: string | null }>(
          `SELECT pp.public_generation_id AS generation FROM community.catalog_delivery_rendition_pins pp
             JOIN community.catalog_delivery_media_refs m ON m.intent_id=pp.intent_id AND m.ordinal=pp.ordinal
             WHERE pp.intent_id=$1 AND m.asset_id=$2`,
          [intentId, image.assetId],
        )
      ).rows.map((row) => row.generation);
    // K = 2: the marked asset and one swept.
    const pass = () => adapter({ max: 2 }).reconcile(new Date(), true, 500);
    // Private B: the pass inspects the intent (pinning its renditions) and
    // schedules the copy.
    await pass();
    expect(await queuedJobs()).toContain(`publish_media ${image.assetId}`);
    expect(await pins()).toEqual([null, null, null, null]);
    await runJobs(new Date());
    expect(await pins()).toEqual([null, null, null, null]);
    // The pass after the job plans the asset again: the inspection records
    // each pin's public generation, and its mark is cleared.
    await pass();
    const recorded = await pins();
    expect(recorded).toHaveLength(4);
    for (const generation of recorded)
      expect(generation).toMatch(/^media-publication-[a-f0-9]{32}$/u);
    expect(await queuedJobs()).not.toContain(`publish_media ${image.assetId}`);
    expect(await pending()).not.toContain(image.assetId);
  });
});

describe("W7: the scope's in-flight part", { timeout: SLOW }, () => {
  /** Leaves each queued publish job's generation publishing, as a publish
   * job that ran out of attempts after planning leaves it, and removes the
   * queued withdrawals; returns the stalled subjects. */
  const stallPublishJobs = async (when: Date) => {
    const jobs = (
      await fixture.setup.query<{ id: string; subject: string }>(
        "SELECT id,subject_id AS subject FROM community.publishing_jobs WHERE kind='publish_media' AND state='queued' ORDER BY subject_id",
      )
    ).rows;
    const publication = adapter();
    for (const job of jobs) {
      const owner = hex();
      await fixture.setup.query(
        "UPDATE community.publishing_jobs SET state='running',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '1 hour' WHERE id=$1",
        [job.id, owner, when],
      );
      const plan = await publication.planPublish(
        job.subject,
        { id: job.id, leaseOwner: owner },
        when,
      );
      if (plan.status !== "ready") throw new Error(`publish ${plan.status}`);
      expect(plan.units.length).toBeGreaterThan(0);
      await publication.release(plan.fence, when);
      await fixture.setup.query(
        "UPDATE community.publishing_jobs SET state='failed',attempts=max_attempts,finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id, when],
      );
    }
    await fixture.setup.query(
      "DELETE FROM community.publishing_jobs WHERE kind IN ('withdraw_media','verify_withdrawal') AND state='queued'",
    );
    return jobs.map((job) => job.subject).sort();
  };

  it("never gives a slot to a publishing generation whose job ran out of attempts while publishing is allowed, and shares the room while it is not", async () => {
    await reseed(plain(140));
    // Four records (28 assets) re-rendered: a pass over the whole Catalog
    // schedules their copies, and each copy job plans (its generation is
    // publishing), then runs out of attempts.
    expect(await bumpCatalogScaleRecipe(fixture, { first: 1, last: 4 })).toBe(
      28,
    );
    await adapter({ max: 200 }).reconcile(new Date(), true, 500);
    const stuck = await stallPublishJobs(new Date());
    expect(stuck).toEqual([...recordAssets(1, 4)].sort());
    await fixture.setup.query("TRUNCATE community.catalog_publication_dirty");
    // Two records taken down and marked: 14 marks, beside 28 stuck assets,
    // and K = 20 leaves 18 slots after the sweep's share.
    await takeDown(5, 6);
    const down = recordAssets(5, 6);
    await mark(down);
    const on = recording();
    expect(
      await adapter({ max: 20 }, on.authority).reconcile(new Date(), true, 500),
    ).toEqual({ publish: 0, withdraw: down.length });
    // A publishing generation counts as present, as the whole-Catalog
    // reconcile counted it: none is in flight, every mark is planned first,
    // and the takedown is scheduled in this pass.
    expect(on.passes[0]!.order.slice(0, down.length).sort()).toEqual(
      [...down].sort(),
    );
    expect(await queuedJobs()).toEqual(
      down.map((id) => `withdraw_media ${id}`).sort(),
    );

    // Publishing not allowed: the reconcile withdraws a publishing
    // generation whatever its plan, so the stuck assets are in flight. With
    // more of them and more marks than the room, each part gets half.
    await runJobs(new Date());
    await fixture.setup.query("TRUNCATE community.catalog_publication_dirty");
    await takeDown(7, 9);
    const later = [...recordAssets(7, 9)].sort();
    await mark(later);
    const off = recording();
    const result = await adapter({ max: 20 }, off.authority, false).reconcile(
      new Date(),
      false,
      500,
    );
    const { order } = off.passes[0]!;
    expect(order.slice(0, 9)).toEqual(stuck.slice(0, 9));
    expect(order.slice(9, 18)).toEqual(later.slice(0, 9));
    expect(result.publish).toBe(0);
    expect(await queuedJobs()).toEqual(
      expect.arrayContaining(
        [...stuck.slice(0, 9), ...later.slice(0, 9)].map(
          (id) => `withdraw_media ${id}`,
        ),
      ),
    );
  });

  it("sends an in-flight asset it could not plan to the back of the queue instead of planning it first every pass", async () => {
    await reseed(plain(140));
    const all = await assetIds();
    const broken = catalogScaleImage(5, 2).assetId;
    // The broken asset's cover: withdrawing, then its purge failed once.
    const rendition = catalogScaleRenditionId(broken, "cover");
    await fixture.setup.query(
      "UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=now(),version=version+1 WHERE rendition_id=$1",
      [rendition],
    );
    await fixture.setup.query(
      "UPDATE community.media_publications SET state='purge_failed',purge_attempts=1,version=version+1 WHERE rendition_id=$1",
      [rendition],
    );
    // Thirty marked assets, more than the room: the last ids but the broken
    // one, so the sweep (from the first ids) never plans one of them.
    const queued = all.filter((id) => id !== broken).slice(-30);
    await mark(queued);
    // The App read of the broken asset's row fails, every time.
    const app = new Proxy(fixture.app, {
      get(pool, key) {
        if (key === "query")
          return (sql: string, values?: unknown[]) =>
            sql.startsWith(
              "SELECT id,media_id,source_object_key FROM community.catalog_media_assets",
            ) && (values?.[0] as string[]).includes(broken)
              ? Promise.reject(
                  Object.assign(new Error("terminating connection"), {
                    code: "57P01",
                  }),
                )
              : pool.query(sql, values);
        const value = Reflect.get(pool, key, pool) as unknown;
        return typeof value === "function" ? value.bind(pool) : value;
      },
    });
    const passes = recording(
      createCatalogPublicationAuthority(
        fixture.publicRead,
        fixture.prepare,
        app,
      ),
    );
    // The passes' clocks, after the marks (the database's clock).
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    await adapter({ max: 20 }, passes.authority).reconcile(at(1), true, 500);
    const [first] = passes.passes;
    expect(first!.order[0]).toBe(broken);
    expect(first!.failed).toEqual([broken]);
    // It is marked now, at the back of the queue: the next pass plans the
    // 13 marks left from before first, and it after them.
    await adapter({ max: 20 }, passes.authority).reconcile(at(2), true, 500);
    const second = passes.passes[1]!;
    expect(second.order.slice(0, 13)).toEqual(queued.slice(17));
    expect(second.order[13]).toBe(broken);
    expect((await marks()).get(broken)!.pending).toBe(true);
  });
});

describe("W-AC5: takedowns first", { timeout: SLOW }, () => {
  it("schedules a takedown within two passes behind more than K publish-side marks that inspect", async () => {
    // 42 published records of 7 images, each with a released intent: the
    // plan of every public asset inspects its record's intent (the work a
    // release wave queues).
    await reseed(
      catalogScaleShape(294, {
        releasedIntents: 42,
        draftRecords: 0,
        endedIntents: 0,
        recentEndedIntents: 0,
        livePrepares: 0,
      }),
    );
    const all = await assetIds();
    const record = 21;
    const down = recordAssets(record, record);
    const others = all.filter((id) => !down.includes(id));
    // In FIFO order the takedown would wait for more than two passes of
    // marks (each plans at most 0.9 K; K = 100 here, as the release wave
    // below, a tenth of the production K).
    const K = 100;
    expect(others.length).toBeGreaterThan(2 * 0.9 * K);
    // Every other asset queued first, as normal marks (publish-side work),
    // then the takedown, as the membership step marks it: urgent.
    await mark(others, "intent");
    await takeDown(record, record);
    await mark(down, "public_membership", true);
    // A short budget, which the reserved part ignores (at K = 100 it is the
    // whole pass: the first 90 marks and the sweep's share). The passes'
    // clocks, after the marks (the database's clock).
    const scheduled = (jobs: readonly string[]) =>
      down.every((id) => jobs.includes(`withdraw_media ${id}`));
    const recorded = recording();
    let passes = 0;
    for (; passes < 2 && !scheduled(await queuedJobs()); passes += 1)
      await adapter({ max: K, budgetMs: 2_000 }, recorded.authority).reconcile(
        new Date(Date.now() + (passes + 1) * 60_000),
        true,
        500,
      );
    // The first pass read the urgent marks before every normal one and
    // planned them first, inside its reserved part.
    expect(recorded.passes[0]!.order.slice(0, down.length)).toEqual(
      [...down].sort(),
    );
    expect(recorded.passes[0]!.planned).toEqual(expect.arrayContaining(down));
    // Its withdrawals were queued by that first pass (the loop stops once
    // they are), not the second.
    expect(scheduled(await queuedJobs())).toBe(true);
    expect(passes).toBe(1);
  });

  it("schedules a takedown within two passes when a release wave has just listed the buckets of images private B serves", async () => {
    // 101 published records of 7 images, the first 60 with a released
    // intent. Records 1..60 are the wave's requests, not released yet:
    // private B serves their images (their plans inspect). Records 61..100
    // are the wave's releases, served nowhere before.
    await reseed(
      catalogScaleShape(707, {
        releasedIntents: 60,
        draftRecords: 0,
        endedIntents: 0,
        recentEndedIntents: 0,
        livePrepares: 0,
      }),
    );
    const held = await holdCatalogScaleRecords(fixture, { first: 1, last: 60 });
    const released = recordAssets(61, 100);
    await takeDown(61, 100);
    for (const [state, extra] of [
      ["withdrawing", "withdraw_requested_at = now()"],
      ["withdrawn", "origin_deleted_at = now(), verified_at = now()"],
    ] as const)
      await fixture.setup.query(
        `UPDATE community.media_publications p SET state = '${state}', ${extra}, version = version + 1
         FROM community.media_public_assets pa
         WHERE pa.id = p.public_asset_id AND pa.catalog_asset_id = ANY($1::text[])`,
        [released],
      );
    // The membership step, once a minute: its first observation, whose
    // marks the reconcile has planned; the release; then a takedown.
    const step = createCatalogMembershipWatch({
      published: fixture.publicRead,
      prepare: fixture.prepare,
      policy: currentCatalogRecipePolicy().recipeManifestSha256,
      port: catalogMembershipStore(fixture.app),
      logger: { info: () => undefined, error: () => undefined },
    });
    await step.run(new Date());
    await fixture.setup.query(
      "UPDATE community.catalog_publication_dirty SET cleared_seq = mark_seq",
    );
    await fixture.setup.query(
      "UPDATE public.catalogs SET _status='published' WHERE id BETWEEN 61 AND 100",
    );
    await step.run(new Date());
    const record = 101;
    const down = recordAssets(record, record);
    await takeDown(record, record);
    await step.run(new Date());
    // The release listed the buckets of more held images than two passes
    // plan (each plans at most 0.9 K marks).
    const K = 100;
    const bucketOf = (id: string) => id.slice(14, 16);
    const listed = new Set(released.map(bucketOf));
    expect(
      held.filter((id) => listed.has(bucketOf(id))).length,
    ).toBeGreaterThan(2 * 0.9 * K);
    const queued = new Map(
      [...(await marks()).values()]
        .filter((row) => row.pending)
        .map((row) => [row.asset_id, row.urgent]),
    );
    const scheduled = (jobs: readonly string[]) =>
      down.every((id) => jobs.includes(`withdraw_media ${id}`));
    let passes = 0;
    for (; passes < 2 && !scheduled(await queuedJobs()); passes += 1)
      await adapter({ max: K }).reconcile(
        new Date(Date.now() + (passes + 1) * 60_000),
        true,
        500,
      );
    expect(scheduled(await queuedJobs())).toBe(true);
    expect(passes).toBe(1);
    // The takedown was the one urgent mark; the released images were marked
    // to be copied, and no held image was marked at all.
    expect(queued).toEqual(
      new Map([
        ...released.map((id) => [id, false] as const),
        ...down.map((id) => [id, true] as const),
      ]),
    );
  });

  it("plans the oldest urgent marks and moves the sweep on, whatever a slow batch leaves of the budget", async () => {
    await reseed(plain(350));
    await takeDown(1, 1);
    const down = recordAssets(1, 1);
    await mark(down, "public_membership", true);
    const swept = (await assetIds()).filter((id) => !down.includes(id));
    // Each clock reading of the planning is 60% of the budget later, so
    // every batch, the sweep's included, takes more than half of it: the
    // budget alone admits one batch a pass.
    const budgetMs = 14_000;
    let ms = 0;
    const inner = authority();
    const slow = recording({
      ...inner,
      planScope: (ids, options) =>
        inner.planScope(
          ids,
          Object.assign({}, options, { clock: () => (ms += 0.6 * budgetMs) }),
        ),
    });
    const result = await adapter({ budgetMs }, slow.authority).reconcile(
      new Date(Date.now() + 60_000),
      true,
      500,
    );
    // The reserved part: the takedown (7) and the sweep's share (100), in
    // two batches; then the budget stops the pass.
    const [pass] = slow.passes;
    expect(pass!.order.slice(0, 7)).toEqual([...down].sort());
    expect(pass!.planned).toHaveLength(200);
    expect(result.withdraw).toBe(down.length);
    expect(await queuedJobs()).toEqual(
      down.map((id) => `withdraw_media ${id}`).sort(),
    );
    expect((await state())[0]!.sweep_cursor).toBe(swept[192]);
  });
});

const LOCAL_25K = process.env.MOYA_CATALOG_SCALE_RECONCILE_IMAGES === "25200";

describe.skipIf(!LOCAL_25K)(
  "W7 at the 25k fixture (local)",
  { timeout: 3_600_000 },
  () => {
    it("plans at most K within its budget, with no statement JIT-compiled", async () => {
      await reseed(CATALOG_SCALE_25K);
      const counts = catalogScaleCounts(CATALOG_SCALE_25K);
      const report: string[] = [];
      for (const label of ["sweep", "dirty"] as const) {
        if (label === "dirty") {
          // Taken down, as the membership step marks it: urgent.
          await takeDown(1, 143);
          await mark(recordAssets(1, 143), "public_membership", true);
        }
        const recorder = createQueryRecorder();
        const passes = recording(
          createCatalogPublicationAuthority(
            fixture.publicRead,
            fixture.prepare,
            recorder.wrap("app", fixture.app),
          ),
        );
        const started = performance.now();
        const result = await new PostgresMediaPublicationAdapter(
          recorder.wrap("app", fixture.app),
          {
            isPublic: () => true,
            allowPublish: () => true,
            catalogAuthority: passes.authority,
          },
        ).reconcile(new Date(), true, 500);
        const ms = performance.now() - started;
        const [pass] = passes.passes;
        report.push(
          `${label}: ${Math.round(ms)} ms, planned ${pass!.planned.length} of ${pass!.order.length}, failed ${pass!.failed.length}, ${recorder.queries.length} App statements, publish ${result.publish}, withdraw ${result.withdraw}`,
        );
        expect(pass!.order.length).toBeLessThanOrEqual(1_000);
        expect(pass!.failed).toEqual([]);
        // Its budget, reads and transaction (W-AC4).
        expect(ms).toBeLessThan(15_000);
        // The 900 marked assets the pass planned, and any of the other
        // taken-down ones its sweep planned.
        if (label === "dirty")
          expect(result.withdraw).toBeGreaterThanOrEqual(900);
        // Every App read and write of the reconcile itself, planned as it
        // ran (EXPLAIN ANALYZE in a transaction rolled back). The dirty
        // queue's shared statements begin with a line break.
        const own = recorder.queries.filter(
          (q) =>
            !q.failed &&
            /^\s*(SELECT|WITH|UPDATE|INSERT)/u.test(q.sql) &&
            /catalog_reconcile_state|catalog_publication_dirty|catalog_media_assets a WHERE|WITH desired AS/u.test(
              q.sql,
            ),
        );
        expect(own.length).toBeGreaterThan(5);
        // The settle's lock and its marks are among them.
        if (label === "dirty")
          expect(own.map((q) => q.sql)).toEqual(
            expect.arrayContaining([
              catalogPublicationDirtyLockSql,
              catalogPublicationDirtyMarkSql,
            ]),
          );
        for (const q of own) {
          const plan = await rolledBackCatalogScale(fixture.setup, (client) =>
            explainCatalogScaleOn(client, q.sql, q.values ?? [], {
              analyze: true,
              buffers: true,
            }),
          );
          const scans = plan.nodes.filter((node) =>
            node.startsWith("Seq Scan"),
          );
          report.push(
            `  cost ${Math.round(plan.cost)}, ${plan.executionMs?.toFixed(1)} ms, JIT ${plan.jitMs === null ? "no" : `${plan.jitMs.toFixed(1)} ms`}${scans.length ? `, ${scans.join(", ")}` : ""}: ${q.sql.replace(/\s+/gu, " ").slice(0, 90)}`,
          );
          expect(plan.cost, q.sql.slice(0, 200)).toBeLessThan(500_000);
          expect(plan.jit, q.sql.slice(0, 200)).toBe(false);
        }
      }
      // The in-flight read at its worst: every published generation
      // withdrawing (a mass takedown whose jobs all failed after planning),
      // planned with the statistics of before and of after.
      for (const analyzed of [false, true])
        try {
          const plan = await rolledBackCatalogScale(
            fixture.setup,
            async (client) => {
              await client.query(
                "UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=now(),version=version+1 WHERE state='published'",
              );
              if (analyzed)
                await client.query("ANALYZE community.media_publications");
              return explainCatalogScaleOn(
                client,
                catalogScaleIndexedStatements.inFlight,
                [900, true],
                { analyze: true, buffers: true },
              );
            },
          );
          report.push(
            `in flight, every generation withdrawing${analyzed ? ", analyzed" : ""}: cost ${Math.round(plan.cost)}, ${plan.executionMs?.toFixed(1)} ms, JIT ${plan.jitMs === null ? "no" : `${plan.jitMs.toFixed(1)} ms`}, ${plan.nodes.join(" / ")}`,
          );
          expect(plan.rows).toBe(900);
          expect(plan.jit).toBe(false);
        } finally {
          // ANALYZE's page and row counts are not rolled back.
          if (analyzed)
            await fixture.setup.query("ANALYZE community.media_publications");
        }
      expect(counts.publishedImages).toBe(25_200);
      console.log(report.join("\n"));
    });
  },
);
