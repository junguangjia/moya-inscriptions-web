import { createHash, randomBytes } from "node:crypto";

import {
  catalogExpectedRenditions,
  currentCatalogRecipePolicy,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  CATALOG_RENDER_QUEUE_TARGET,
  catalogSyncIdentities,
  createCatalogSync,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  readCatalogRenderBacklog,
} from "@moya/community-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_SCALE_25K,
  catalogScaleCounts,
  clearCatalogScale,
  createCatalogScaleDatabase,
  createQueryRecorder,
  explainCatalogScaleOn,
  rolledBackCatalogScale,
  seedCatalogScale,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B W9 on the scale fixture's roles: the
 * render tiers of the Catalog sync, through the restricted App role.
 * - One pass queues its jobs in tier order (t0 a published image without a
 *   rendition, in its record's order; t1 a release_requested intent's; t2 a
 *   prepared intent's, soonest lease first; t4 a recipe re-render, last in
 *   the pass, after it the failed re-render queued again), each job at the
 *   pass's time plus its rank in milliseconds, so the claim order follows
 *   the tiers, and records the per-tier backlog in the reconcile state row
 *   (after the commit: a failed write flags the pass, never fails it).
 * - The queue target bounds the queued base renders: a pass queues only the
 *   room below it, and user and block jobs neither count nor lose their
 *   claim class.
 * - W-AC10: 50 records of 7 images whose leases run in turn a minute apart,
 *   all in the snapshot from the first pass, beside 20 published re-renders,
 *   rendered at 35 a pass: record k finishes before any image of record k+2
 *   starts, every re-render runs after every prepared image, and the queue
 *   never holds more than the target.
 * - Records that arrive pass by pass: a re-render is queued only while no
 *   higher tier waits, so a record prepared later waits behind at most the
 *   re-renders already queued (the target), and still renders together.
 * - Locally, at the 25k fixture (MOYA_CATALOG_RENDER_IMAGES=25200): no
 *   statement of a sync pass is JIT-compiled.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 600_000;
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

const hex = (bytes = 8) => randomBytes(bytes).toString("hex");
const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const md5 = (value: string) =>
  createHash("md5").update(value, "utf8").digest("hex");
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
const t0 = new Date("2126-10-21T04:00:00.000Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const HOUR = 60;

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csrq",
  });
}, SLOW);

afterAll(async () => {
  await fixture?.close();
}, SLOW);

interface Image {
  readonly label: string;
  readonly mediaId: string;
  readonly objectKey: string;
  readonly sourceSha256: string;
  readonly width: number;
  readonly height: number;
  readonly assetId: string;
}

const image = (label: string): Image => {
  const mediaId = `media-${label}-${hex(4)}`;
  const sourceSha256 = sha(`bytes:${mediaId}`);
  const objectKey = `editorial/${sha(`catalog:${label}`)}/${sha(mediaId)}-${sourceSha256}.jpg`;
  return {
    label,
    mediaId,
    objectKey,
    sourceSha256,
    width: 3000,
    height: 2000,
    assetId: `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`,
  };
};

/** A published row of the listing: the image in its record and position. */
interface Shown {
  readonly image: Image;
  readonly catalogId: string;
  readonly position: number;
}

const intent = (
  documentId: number,
  state: "prepared" | "release_requested",
  expiresAt: Date,
  images: readonly Image[],
) => ({
  intentId: `00000000-0000-4000-8000-${documentId.toString(16).padStart(12, "0")}`,
  documentId,
  catalogId: `catalog-${documentId}`,
  revision: 1,
  fingerprint: sha(`fingerprint:${documentId}`),
  manifestSha256: sha(`manifest:${documentId}`),
  recipeManifestSha256: policy,
  state,
  stateVersion: state === "release_requested" ? 2 : 1,
  mediaCount: images.length,
  media: images.map((item, index) => ({
    ordinal: index + 1,
    mediaId: item.mediaId,
    objectKey: item.objectKey,
    sourceSha256: item.sourceSha256,
    width: item.width,
    height: item.height,
  })),
  expiresAt: expiresAt.toISOString(),
});
type Intent = ReturnType<typeof intent>;

const works = () => new PostgresWorkPublishingAdapter(fixture.app);

/** One sync pass as the worker hands it over: the union of the published
 * rows and the live intents' members, with the snapshot. */
const sync = (
  when: Date,
  shown: readonly Shown[],
  intents: readonly Intent[],
  renderQueueTarget: number | undefined = CATALOG_RENDER_QUEUE_TARGET,
) => {
  const publishedSources = shown.map((row) => ({
    mediaId: row.image.mediaId,
    objectKey: row.image.objectKey,
    width: row.image.width,
    height: row.image.height,
    catalogId: row.catalogId,
    position: row.position,
  }));
  const union = new Map(publishedSources.map((row) => [row.objectKey, row]));
  for (const live of intents)
    for (const media of live.media)
      if (!union.has(media.objectKey))
        union.set(media.objectKey, {
          mediaId: media.mediaId,
          objectKey: media.objectKey,
          width: media.width,
          height: media.height,
          catalogId: "",
          position: 0,
        });
  return works().syncCatalogAssets(
    [...union.values()].map(({ mediaId, objectKey, width, height }) => ({
      mediaId,
      objectKey,
      width,
      height,
    })),
    when,
    {
      limit: 100,
      renditions: catalogSyncIdentities(),
      ...(renderQueueTarget === undefined ? {} : { renderQueueTarget }),
      snapshot: {
        observedAt: when,
        publishedSources,
        preparations: intents,
        recipeManifestSha256: policy,
      },
    } as unknown as Parameters<
      PostgresWorkPublishingAdapter["syncCatalogAssets"]
    >[2],
  );
};

/** Committed blobs and ready renditions of `digest` (the current recipe's
 * by default) of every planned role; the asset becomes ready with them, and
 * the renditions it had are released, as a recorded render replaces them. */
const render = async (item: Image, when: Date, digest?: string) => {
  const client = await fixture.setup.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,state,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'image/jpeg','pending',$7,$7) ON CONFLICT (id) DO NOTHING`,
      [
        item.assetId,
        item.mediaId,
        item.objectKey,
        item.sourceSha256,
        item.width,
        item.height,
        when,
      ],
    );
    await client.query(
      "UPDATE community.media_renditions SET state='released', released_at=$2 WHERE catalog_asset_id=$1 AND state='ready'",
      [item.assetId, when],
    );
    for (const want of catalogExpectedRenditions(item.width, item.height)) {
      const blob = `media-blob-${hex(16)}`;
      const key = hex(16);
      await client.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp','committed',$4)",
        [
          blob,
          `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
          sha(blob),
          when,
        ],
      );
      await client.query(
        "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,$4,$5,$6,$7,$8,'image/webp',$9)",
        [
          `media-rendition-${hex(16)}`,
          item.assetId,
          want.role,
          want.version,
          digest ?? want.digest,
          blob,
          want.width,
          want.height,
          when,
        ],
      );
    }
    await client.query(
      "UPDATE community.catalog_media_assets SET state='ready', master_sha256=source_sha256, master_width=$2, master_height=$3, updated_at=$4 WHERE id=$1",
      [item.assetId, item.width, item.height, when],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** Claims every claimable Catalog render at `when`, in claim order. */
const claim = async (when: Date, limit = 100) =>
  works().claimJobs(
    {
      owner: `render-${hex(4)}`,
      limit,
      leaseMs: 3_600_000,
      kinds: ["catalog_render"],
    },
    when,
  );

const queuedBase = async () =>
  (
    await fixture.setup.query<{ queued: number }>(
      `SELECT count(*)::integer AS queued FROM community.publishing_jobs
       WHERE state='queued' AND kind='catalog_render' AND payload IS NULL`,
    )
  ).rows[0]!.queued;

const label = (assetId: string, images: readonly Image[]) =>
  images.find((item) => item.assetId === assetId)?.label ?? assetId;

beforeEach(async () => {
  await clearCatalogScale(fixture, { cms: false });
}, SLOW);

describe("W9: one pass queues its renders in tier order", () => {
  it("ranks published images by record, then requested and prepared intents by lease, and re-renders last", async () => {
    // Published records: b's positions run against its media ids' order.
    const a = [image("a0"), image("a1"), image("a2-shared")];
    const b = [image("b0"), image("b1"), image("b2")];
    const rerender = image("c0-rerender");
    const retried = image("d0-retried");
    const shown: Shown[] = [
      ...b.map((item, index) => ({
        image: item,
        catalogId: "catalog-b",
        position: [2, 0, 1][index]!,
      })),
      ...a.map((item, position) => ({
        image: item,
        catalogId: "catalog-a",
        position,
      })),
      { image: rerender, catalogId: "catalog-c", position: 0 },
      { image: retried, catalogId: "catalog-d", position: 0 },
    ];
    const requested = [image("r1"), image("r2")];
    const sooner = [image("s1"), image("s2")];
    const later = [a[2]!, image("l2")];
    const intents = [
      intent(13, "prepared", at(20 * HOUR), later),
      intent(12, "release_requested", at(30 * HOUR), requested),
      intent(11, "prepared", at(5 * HOUR), sooner),
    ];
    // Two published images rendered under an older recipe: one never tried
    // again, one whose re-render failed more than a day ago.
    await render(rerender, at(-3 * 24 * HOUR), "0000000000000000");
    await render(retried, at(-3 * 24 * HOUR), "0000000000000000");
    await fixture.setup.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,last_error_code,created_at,updated_at,finished_at)
       VALUES($1,'catalog_render',$2,'failed',5,$3,'processing_failed',$3,$3,$3)`,
      [`publishing-job-${hex(16)}`, retried.assetId, at(-26 * HOUR)],
    );
    const counts = await sync(at(0), shown, intents);
    expect(counts.enqueued).toBe(13);
    const all = [
      ...a,
      ...b,
      rerender,
      retried,
      ...requested,
      ...sooner,
      later[1]!,
    ];
    const order = [
      // t0: record a, then record b by position; the shared image keeps t0.
      "a0",
      "a1",
      "a2-shared",
      "b1",
      "b2",
      "b0",
      // t1, then t2 by lease (s before l).
      "r1",
      "r2",
      "s1",
      "s2",
      "l2",
      // t4: the re-render, then the failed one queued again after it.
      "c0-rerender",
      "d0-retried",
    ];
    // The claim follows run_after, which is the pass's time plus the rank.
    const jobs = (
      await fixture.setup.query<{ subject_id: string; offset: number }>(
        `SELECT subject_id, (extract(epoch FROM run_after - $1::timestamptz) * 1000)::integer AS offset
         FROM community.publishing_jobs WHERE kind='catalog_render' AND state='queued' ORDER BY run_after, id`,
        [at(0)],
      )
    ).rows;
    expect(jobs.map((job) => label(job.subject_id, all))).toEqual(order);
    expect(jobs.map((job) => job.offset)).toEqual(order.map((_, rank) => rank));
    expect(
      (await claim(at(1))).map((job) => label(job.subjectId, all)),
    ).toEqual(order);
    // The backlog by tier: named images still to render (queued or not).
    expect(await readCatalogRenderBacklog(fixture.app)).toEqual({
      tiers: { t0: 6, t1: 2, t2: 3, t3: 0, t4: 2 },
      countedAt: at(0),
      queued: 0,
      running: 13,
    });
  });

  it("queues only the room below the target, which user and block jobs do not take", async () => {
    const shown = Array.from({ length: 10 }, (_, position) => ({
      image: image(`q${position}`),
      catalogId: "catalog-q",
      position,
    }));
    const other = image("other");
    const item = `media-item-${hex(16)}`;
    const owner = `user-${hex(16)}`;
    await fixture.setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'合成')",
      [owner, `rq-${hex(6)}`],
    );
    await fixture.setup.query(
      "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,created_at,updated_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":10,\"height\":10}'::jsonb,$3,$3)",
      [item, owner, at(-1)],
    );
    // A user upload's job, a block job and an unrelated failed render: none
    // is a queued base render.
    await fixture.setup.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,payload,state,run_after,created_at,updated_at,finished_at)
       VALUES($1,'process_item',$2,NULL,'queued',$4,$4,$4,NULL),
         ($3,'catalog_render',$5,'{"variant":"blocks","masterId":"m","cells":[0,3]}'::jsonb,'queued',$4,$4,$4,NULL),
         ($6,'catalog_render',$7,NULL,'failed',$4,$4,$4,$4)`,
      [
        `publishing-job-${hex(16)}`,
        item,
        `publishing-job-${hex(16)}`,
        at(-1),
        shown[0]!.image.assetId,
        `publishing-job-${hex(16)}`,
        other.assetId,
      ],
    );
    const queuedLabels = async () =>
      (
        await fixture.setup.query<{ subject_id: string }>(
          `SELECT subject_id FROM community.publishing_jobs
           WHERE state='queued' AND kind='catalog_render' AND payload IS NULL ORDER BY run_after, id`,
        )
      ).rows.map((row) =>
        label(
          row.subject_id,
          shown.map((entry) => entry.image),
        ),
      );
    expect((await sync(at(0), shown, [], 4)).enqueued).toBe(4);
    expect(await queuedLabels()).toEqual(["q0", "q1", "q2", "q3"]);
    expect((await sync(at(5), shown, [], 4)).enqueued).toBe(0);
    expect(await queuedLabels()).toEqual(["q0", "q1", "q2", "q3"]);
    // Three renders finish: three more are queued, the queue is full again.
    const claimed = await claim(at(6), 3);
    for (const job of claimed) {
      await render(
        shown.find((entry) => entry.image.assetId === job.subjectId)!.image,
        at(6),
      );
      await works().completeJob(job, at(6));
    }
    expect((await sync(at(10), shown, [], 4)).enqueued).toBe(3);
    expect(await queuedLabels()).toEqual(["q3", "q4", "q5", "q6"]);
    // The user job keeps its claim class ahead of every Catalog render.
    const next = await works().claimJobs(
      { owner: `w-${hex(4)}`, limit: 1, leaseMs: 60_000 },
      at(11),
    );
    expect(next.map((job) => job.kind)).toEqual(["process_item"]);
    expect(await readCatalogRenderBacklog(fixture.app)).toMatchObject({
      tiers: { t0: 7, t1: 0, t2: 0, t3: 0, t4: 0 },
      queued: 4,
    });
  });

  it("keeps a committed pass whose backlog cannot be recorded, flagged, and records the next pass's", async () => {
    const shown = [0, 1].map((position) => ({
      image: image(`m${position}`),
      catalogId: "catalog-m",
      position,
    }));
    // The state row is gone (only an owner can remove it): the backlog
    // write after the commit fails, and the pass and its counts stand.
    await fixture.setup.query("DELETE FROM community.catalog_reconcile_state");
    try {
      expect(await sync(at(0), shown, [])).toEqual({
        referenced: 2,
        skipped: 0,
        created: 2,
        unreferenced: 0,
        enqueued: 2,
        renderBacklogRecorded: false,
      });
      expect(await queuedBase()).toBe(2);
    } finally {
      await fixture.setup.query(
        "INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now()) ON CONFLICT (id) DO NOTHING",
      );
    }
    expect(await sync(at(5), shown, [])).toEqual({
      referenced: 2,
      skipped: 0,
      created: 0,
      unreferenced: 0,
      enqueued: 0,
    });
    expect(await readCatalogRenderBacklog(fixture.app)).toEqual({
      tiers: { t0: 2, t1: 0, t2: 0, t3: 0, t4: 0 },
      countedAt: at(5),
      queued: 2,
      running: 0,
    });
  });
});

describe("W-AC10: prepared records render record by record", () => {
  it(
    "finishes record k before record k+2 starts, runs re-renders last and never queues more than the target",
    async () => {
      const RECORDS = 50;
      const PER_PASS = 35; // about 7 renders a minute, a pass every 5 minutes
      const records = Array.from({ length: RECORDS }, (_, k) =>
        Array.from({ length: 7 }, (_, i) => image(`r${k + 1}-${i + 1}`)),
      );
      // Leases in turn, each a minute after the last, every intent in the
      // snapshot from the first pass (the arrival case is the next test).
      const intents = records.map((images, k) =>
        intent(1000 + k + 1, "prepared", at(24 * HOUR + k + 1), images),
      );
      const rerenders = Array.from({ length: 20 }, (_, position) => ({
        image: image(`t4-${position}`),
        catalogId: "catalog-rerender",
        position,
      }));
      for (const row of rerenders)
        await render(row.image, at(-HOUR), "0000000000000000");
      const recordOf = new Map(
        records.flatMap((images, k) =>
          images.map((item) => [item.assetId, k + 1] as const),
        ),
      );
      const rerenderIds = new Set(rerenders.map((row) => row.image.assetId));
      const everything = [
        ...records.flat(),
        ...rerenders.map((row) => row.image),
      ];
      const claimed: string[] = [];
      for (let pass = 0; pass < 30; pass += 1) {
        const when = at(5 * pass);
        const before = await queuedBase();
        const counts = await sync(when, rerenders, intents);
        expect(counts.enqueued).toBeLessThanOrEqual(
          CATALOG_RENDER_QUEUE_TARGET - before,
        );
        expect(await queuedBase()).toBeLessThanOrEqual(
          CATALOG_RENDER_QUEUE_TARGET,
        );
        // The worker renders one job after another until the next pass.
        for (let n = 0; n < PER_PASS; n += 1) {
          const [job] = await claim(new Date(when.getTime() + 60_000), 1);
          if (job === undefined) break;
          claimed.push(job.subjectId);
          await render(
            everything.find((item) => item.assetId === job.subjectId)!,
            when,
          );
          await works().completeJob(job, when);
        }
        const backlog = (await readCatalogRenderBacklog(fixture.app)).tiers!;
        if (
          Object.values(backlog).every((count) => count === 0) &&
          (await queuedBase()) === 0
        )
          break;
      }
      expect(new Set(claimed).size).toBe(everything.length);
      expect(claimed).toHaveLength(everything.length);
      const first = (record: number) =>
        claimed.findIndex((id) => recordOf.get(id) === record);
      const lastIndex = (match: (id: string) => boolean) => {
        for (let index = claimed.length - 1; index >= 0; index -= 1)
          if (match(claimed[index]!)) return index;
        return -1;
      };
      const last = (record: number) =>
        lastIndex((id) => recordOf.get(id) === record);
      for (let k = 1; k + 2 <= RECORDS; k += 1)
        expect(last(k), `record ${k}`).toBeLessThan(first(k + 2));
      const firstRerender = claimed.findIndex((id) => rerenderIds.has(id));
      const lastPrepared = lastIndex((id) => recordOf.has(id));
      expect(firstRerender).toBeGreaterThan(lastPrepared);
    },
    SLOW,
  );

  it(
    "queues re-renders only while no higher tier waits, so a record prepared later waits behind at most the target of them",
    async () => {
      const TARGET = 10;
      const PER_PASS = 6;
      const RECORDS = 6;
      // Record k is prepared at pass k and stays in every later snapshot.
      const records = Array.from({ length: RECORDS }, (_, k) =>
        Array.from({ length: 3 }, (_, i) => image(`p${k + 1}-${i + 1}`)),
      );
      const intents = records.map((images, k) =>
        intent(2000 + k + 1, "prepared", at(24 * HOUR + 5 * (k + 1)), images),
      );
      const rerenders = Array.from({ length: 30 }, (_, position) => ({
        image: image(`t4-${position}`),
        catalogId: "catalog-rerender",
        position,
      }));
      for (const row of rerenders)
        await render(row.image, at(-HOUR), "0000000000000000");
      const recordOf = new Map(
        records.flatMap((images, k) =>
          images.map((item) => [item.assetId, k + 1] as const),
        ),
      );
      const everything = [
        ...records.flat(),
        ...rerenders.map((row) => row.image),
      ];
      const claimed: { id: string; pass: number }[] = [];
      for (let pass = 0; pass < 30; pass += 1) {
        const when = at(5 * pass);
        const before = await queuedBase();
        const counts = await sync(
          when,
          rerenders,
          intents.slice(0, pass),
          TARGET,
        );
        expect(counts.enqueued).toBeLessThanOrEqual(TARGET - before);
        expect(await queuedBase()).toBeLessThanOrEqual(TARGET);
        for (let n = 0; n < PER_PASS; n += 1) {
          const [job] = await claim(new Date(when.getTime() + 60_000), 1);
          if (job === undefined) break;
          claimed.push({ id: job.subjectId, pass });
          await render(
            everything.find((item) => item.assetId === job.subjectId)!,
            when,
          );
          await works().completeJob(job, when);
        }
        const backlog = (await readCatalogRenderBacklog(fixture.app)).tiers!;
        if (
          pass >= RECORDS &&
          Object.values(backlog).every((count) => count === 0) &&
          (await queuedBase()) === 0
        )
          break;
      }
      expect(new Set(claimed.map(({ id }) => id)).size).toBe(everything.length);
      expect(claimed).toHaveLength(everything.length);
      const waits = records.map((_, k) => {
        const record = k + 1;
        const indices = claimed.flatMap(({ id }, index) =>
          recordOf.get(id) === record ? [index] : [],
        );
        // One record's images render together, nothing between them.
        expect(indices, `record ${record}`).toEqual([
          indices[0],
          indices[0]! + 1,
          indices[0]! + 2,
        ]);
        // The re-renders claimed after the record was prepared, before its
        // last image.
        return claimed.filter(
          ({ id, pass }, index) =>
            pass >= record && index < indices.at(-1)! && !recordOf.has(id),
        ).length;
      });
      // Re-renders queued when nothing else waited run before a record
      // prepared later (cross-pass FIFO), never more than the target.
      expect(Math.max(...waits)).toBeGreaterThan(0);
      for (const [k, wait] of waits.entries())
        expect(wait, `record ${k + 1}`).toBeLessThanOrEqual(TARGET);
    },
    SLOW,
  );
});

const LOCAL_25K = process.env.MOYA_CATALOG_RENDER_IMAGES === "25200";

describe.skipIf(!LOCAL_25K)(
  "W9 at the 25k fixture (local)",
  { timeout: 3_600_000 },
  () => {
    it("plans every statement of a sync pass without JIT, with room in the queue and re-renders due", async () => {
      await clearCatalogScale(fixture);
      // The live intents' images rendered, so the queue has room.
      await seedCatalogScale(fixture, CATALOG_SCALE_25K, {
        liveAssets: "ready",
      });
      const counts = catalogScaleCounts(CATALOG_SCALE_25K);
      // 200 published images under an older recipe (t4), 50 of them with a
      // failed re-render older than a day: 150 are queued, then the 50
      // again, so every statement of the pass runs.
      await fixture.setup.query(
        `UPDATE community.media_renditions SET recipe_digest='0000000000000000'
         WHERE catalog_asset_id IN (SELECT id FROM community.catalog_media_assets
           WHERE state='ready' AND unreferenced_since IS NULL ORDER BY id LIMIT 200)`,
      );
      await fixture.setup.query(
        `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,last_error_code,created_at,updated_at,finished_at)
         SELECT 'publishing-job-' || md5('w9-failed:' || a.id), 'catalog_render', a.id, 'failed', 5,
           now() - interval '30 hours', 'processing_failed', now() - interval '30 hours',
           now() - interval '30 hours', now() - interval '30 hours'
         FROM community.catalog_media_assets a
         WHERE a.state='ready' AND a.unreferenced_since IS NULL ORDER BY a.id LIMIT 50`,
      );
      // 5,000 failed renders of other subjects, which every named asset is
      // checked against.
      await fixture.setup.query(
        `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,last_error_code,created_at,updated_at,finished_at)
         SELECT 'publishing-job-' || md5('w9-stuck:' || g), 'catalog_render', 'catalog-asset-' || md5('w9-stuck:' || g),
           'failed', 5, now(), 'processing_failed', now(), now(), now()
         FROM generate_series(1, 5000) AS g`,
      );
      await fixture.setup.query("ANALYZE");
      const report: string[] = [];
      const recorder = createQueryRecorder();
      const lines: string[] = [];
      const started = performance.now();
      await createCatalogSync({
        listSources: async () => [],
        readSnapshot: () =>
          readCatalogSourceSnapshot(fixture.publicRead, fixture.prepare),
        port: new PostgresWorkPublishingAdapter(
          recorder.wrap("app", fixture.app),
        ),
        logger: {
          info: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      }).run(new Date());
      const passMs = performance.now() - started;
      report.push(
        `sync pass ${Math.round(passMs)} ms, ${recorder.queries.length} App statements: ${lines.join(" | ")}`,
      );
      expect(passMs).toBeLessThan(10_000);
      expect(lines).toEqual([expect.stringMatching(/ enqueued=200$/u)]);
      const own = recorder.queries.filter(
        (q) => !q.failed && /^\s*(SELECT|WITH|UPDATE|INSERT)/u.test(q.sql),
      );
      expect(own.length).toBeGreaterThan(10);
      for (const q of own) {
        const plan = await rolledBackCatalogScale(fixture.setup, (client) =>
          explainCatalogScaleOn(client, q.sql, q.values ?? [], {
            analyze: true,
            buffers: true,
          }),
        );
        report.push(
          `  cost ${Math.round(plan.cost)}, ${plan.executionMs?.toFixed(1)} ms, JIT ${plan.jitMs === null ? "no" : `${plan.jitMs.toFixed(1)} ms`}: ${q.sql.replace(/\s+/gu, " ").slice(0, 100)}`,
        );
        expect(plan.cost, q.sql.slice(0, 200)).toBeLessThan(100_000);
        expect(plan.jit, q.sql.slice(0, 200)).toBe(false);
        expect(plan.executionMs, q.sql.slice(0, 200)).toBeLessThan(2_000);
      }
      const backlog = await readCatalogRenderBacklog(fixture.app);
      report.push(`backlog ${JSON.stringify(backlog)}`);
      expect(backlog.tiers).toMatchObject({ t0: 0, t4: 200 });
      expect(backlog.queued).toBe(200);
      expect(counts.publishedImages).toBe(25_200);
      console.log(report.join("\n"));
    });
  },
);
