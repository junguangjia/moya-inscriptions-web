import { createHash, randomBytes } from "node:crypto";

import {
  catalogExpectedRenditions,
  currentCatalogRecipePolicy,
} from "@moya/backend-production/internal/catalog-delivery";
import { catalogSyncIdentities } from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  inspectCatalogDelivery,
  readCatalogRenderBacklog,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B W10 on the scale fixture's roles: render
 * grace, through the restricted App role, on the real clock (the render
 * plan reads the database's, an inspection the process's).
 * - A record whose renders sit behind a backlog past its 24-hour lease is
 *   still rendered for G (72) hours after it: a job queued during the lease
 *   finds its asset referenced, and the sync names the images that had no
 *   job yet (tier t3), never one whose lease passed more than G ago.
 * - The lapsed intent grants nothing: an inspection is not ready and pins
 *   nothing.
 * - A re-prepare of the same images is READY after the next sync with no
 *   render queued again; the newer intent ends the older one's grace, so an
 *   image only the older intent named is no longer rendered.
 * - Only a prepared or requested intent whose lease passed is in grace: one
 *   the Owner cancelled, one superseded and one withdrawn, each still
 *   listed live within R with the members stored while it was prepared, are
 *   not rendered for, and a newer intent of the document ends the grace
 *   whatever its state (a cancelled one too).
 * Each scenario has its own database: the snapshot watermark only moves
 * forward, and each starts its syncs days in the past.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 300_000;
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

const hex = (bytes = 8) => randomBytes(bytes).toString("hex");
const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const md5 = (value: string) =>
  createHash("md5").update(value, "utf8").digest("hex");
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
// The real clock: the render plan's grace reads now(), an inspection
// Date.now(). Each sync is newer than the last (the snapshot watermark).
const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);

/** A fresh database for the scenario of the enclosing describe. */
const ownDatabase = () => {
  beforeAll(async () => {
    fixture = await createCatalogScaleDatabase({
      target,
      openPool: (url) =>
        createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
      label: "csgr",
    });
  }, SLOW);
  afterAll(async () => {
    await fixture?.close();
  }, SLOW);
};

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

/** An intent as the live projection lists it: live with its members, or a
 * lapsed or ended one as a header (the projection reads a passed lease as
 * expired; an Owner's cancel or withdrawal, or a supersession, advances the
 * state version). */
const intent = (
  id: number,
  documentId: number,
  expiresAt: Date,
  images: readonly Image[],
  state:
    | "prepared"
    | "expired"
    | "cancelled"
    | "superseded"
    | "withdrawn" = "prepared",
  recipeManifestSha256 = policy,
) => ({
  intentId: `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`,
  documentId,
  catalogId: `catalog-${documentId}`,
  revision: 1,
  fingerprint: sha(`fingerprint:${id}`),
  manifestSha256: sha(`manifest:${id}`),
  recipeManifestSha256,
  state,
  stateVersion: state === "prepared" || state === "expired" ? 1 : 2,
  mediaCount: images.length,
  media:
    state !== "prepared"
      ? []
      : images.map((item, index) => ({
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

/** One sync pass of a snapshot with no published image. */
const sync = (
  when: Date,
  intents: readonly Intent[],
  renderQueueTarget: number,
) =>
  works().syncCatalogAssets(
    intents.flatMap((live) =>
      live.media.map(({ mediaId, objectKey, width, height }) => ({
        mediaId,
        objectKey,
        width,
        height,
      })),
    ),
    when,
    {
      limit: 100,
      renditions: catalogSyncIdentities(),
      renderQueueTarget,
      snapshot: {
        observedAt: when,
        publishedSources: [],
        preparations: intents,
        recipeManifestSha256: policy,
      },
    } as unknown as Parameters<
      PostgresWorkPublishingAdapter["syncCatalogAssets"]
    >[2],
  );

/** A recorded render: committed blobs and ready renditions of the current
 * recipe's plan, the asset ready with its master facts. */
const render = async (item: Image) => {
  const client = await fixture.setup.connect();
  try {
    await client.query("BEGIN");
    for (const want of catalogExpectedRenditions(item.width, item.height)) {
      const blob = `media-blob-${hex(16)}`;
      const key = hex(16);
      await client.query(
        "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp','committed',now())",
        [blob, `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`, sha(blob)],
      );
      await client.query(
        "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,$4,$5,$6,$7,$8,'image/webp',now())",
        [
          `media-rendition-${hex(16)}`,
          item.assetId,
          want.role,
          want.version,
          want.digest,
          blob,
          want.width,
          want.height,
        ],
      );
    }
    await client.query(
      "UPDATE community.catalog_media_assets SET state='ready', master_sha256=source_sha256, master_width=$2, master_height=$3 WHERE id=$1",
      [item.assetId, item.width, item.height],
    );
    await client.query(
      "UPDATE community.publishing_jobs SET state='succeeded', finished_at=now() WHERE kind='catalog_render' AND subject_id=$1 AND state='queued'",
      [item.assetId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const renderJobs = async (images: readonly Image[]) =>
  Object.fromEntries(
    images
      .map((item) => [item.label, 0] as [string, number])
      .concat(
        (
          await fixture.setup.query<{ subject_id: string; jobs: number }>(
            "SELECT subject_id, count(*)::integer AS jobs FROM community.publishing_jobs WHERE kind='catalog_render' AND subject_id=ANY($1::text[]) GROUP BY 1",
            [images.map((item) => item.assetId)],
          )
        ).rows.map((row) => [
          images.find((item) => item.assetId === row.subject_id)!.label,
          row.jobs,
        ]),
      ),
  );

const referenced = async (images: readonly Image[]) =>
  Object.fromEntries(
    await Promise.all(
      images.map(
        async (item) =>
          [
            item.label,
            (await works().readCatalogRenderPlan(item.assetId))?.referenced ??
              null,
          ] as const,
      ),
    ),
  );

describe("W10: render grace", () => {
  ownDatabase();

  it(
    "renders a record behind a 30-hour backlog after its lease, grants it nothing, and is READY again on a re-prepare without a render",
    async () => {
      const [x, y, z] = [image("x"), image("y"), image("z")];
      const inGrace = image("w-71h");
      const pastGrace = image("w-73h");
      const olderRecipe = image("v-older-recipe");
      const all = [x, y, z, inGrace, pastGrace, olderRecipe];
      const oldPolicy = sha("an older recipe policy");
      // A full queue: one unrelated render queued, at a target of one.
      await fixture.setup.query(
        "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at) VALUES($1,'catalog_render',$2,'queued',$3,$3,$3)",
        [
          `publishing-job-${hex(16)}`,
          `catalog-asset-${hex(16)}`,
          hoursAgo(100),
        ],
      );
      // Two records prepared about four days ago, whose leases passed 71
      // and 73 hours ago, before any of their images got a job.
      const twoDays = [
        intent(2, 502, hoursAgo(71), [inGrace]),
        intent(3, 503, hoursAgo(73), [pastGrace]),
        intent(5, 505, hoursAgo(60), [olderRecipe], "prepared", oldPolicy),
      ];
      expect((await sync(hoursAgo(90), twoDays, 1)).enqueued).toBe(0);
      // The record under test, prepared 54 hours ago with a 24-hour lease:
      // only its first image got a job before the backlog.
      const prepared = intent(1, 501, hoursAgo(30), [x, y, z]);
      const lapsed = [
        intent(2, 502, hoursAgo(71), [inGrace], "expired"),
        intent(3, 503, hoursAgo(73), [pastGrace], "expired"),
      ];
      // The older recipe's intent is live at the next pass (its lease passed
      // 60 hours ago, 6 hours after it), then lapsed.
      const olderLive = twoDays[2]!;
      const olderLapsed = intent(
        5,
        505,
        hoursAgo(60),
        [olderRecipe],
        "expired",
        oldPolicy,
      );
      expect(
        (
          await sync(
            new Date(now - 54 * 3_600_000 + 60_000),
            [prepared, ...lapsed, olderLive],
            2,
          )
        ).enqueued,
      ).toBe(1);
      expect(await renderJobs(all)).toEqual({
        x: 1,
        y: 0,
        z: 0,
        "w-71h": 0,
        "w-73h": 0,
        "v-older-recipe": 0,
      });

      // Thirty hours after the lease, the backlog drained enough.
      const expired = intent(1, 501, hoursAgo(30), [x, y, z], "expired");
      const pass = await sync(
        new Date(now),
        [expired, ...lapsed, olderLapsed],
        300,
      );
      // Y, Z and the 71-hour image get their job (t3); X keeps its own. The
      // older recipe's intent is in grace too, but only the current recipe
      // is rendered for one.
      expect(pass.enqueued).toBe(3);
      expect(await renderJobs(all)).toEqual({
        x: 1,
        y: 1,
        z: 1,
        "w-71h": 1,
        "w-73h": 0,
        "v-older-recipe": 0,
      });
      // A claimed job renders them; past G it would complete unrendered.
      expect(await referenced([x, y, z, inGrace, pastGrace])).toEqual({
        x: true,
        y: true,
        z: true,
        "w-71h": true,
        "w-73h": false,
      });
      expect((await readCatalogRenderBacklog(fixture.app)).tiers).toEqual({
        t0: 0,
        t1: 0,
        t2: 0,
        t3: 4,
        t4: 0,
      });

      // X and Y are rendered in grace. The lapsed intent grants nothing: no
      // inspection of it is ready, and it pins no rendition.
      await render(x);
      await render(y);
      const notReady = await inspectCatalogDelivery(
        fixture.app,
        prepared as Parameters<typeof inspectCatalogDelivery>[1],
        policy,
        catalogExpectedRenditions,
      );
      expect(notReady).toMatchObject({
        privateReady: false,
        publicReady: false,
      });
      expect(
        (
          await fixture.setup.query(
            "SELECT 1 FROM community.catalog_delivery_rendition_pins WHERE intent_id=$1",
            [prepared.intentId],
          )
        ).rowCount,
      ).toBe(0);

      // The Owner prepares the record again with X and Y. After the next
      // sync it is READY, with no render queued again; the newer intent
      // ends the older one's grace, so Z is no longer rendered.
      const again = intent(4, 501, new Date(now + 24 * 3_600_000), [x, y]);
      const next = await sync(
        new Date(now + 1_000),
        [expired, again, ...lapsed, olderLapsed],
        300,
      );
      expect(next.enqueued).toBe(0);
      expect(await renderJobs(all)).toEqual({
        x: 1,
        y: 1,
        z: 1,
        "w-71h": 1,
        "w-73h": 0,
        "v-older-recipe": 0,
      });
      expect(
        await inspectCatalogDelivery(
          fixture.app,
          again as Parameters<typeof inspectCatalogDelivery>[1],
          policy,
          catalogExpectedRenditions,
        ),
      ).toMatchObject({ privateReady: true });
      expect(await referenced([x, y, z, inGrace, pastGrace])).toEqual({
        x: true,
        y: true,
        z: false,
        "w-71h": true,
        "w-73h": false,
      });
      expect((await readCatalogRenderBacklog(fixture.app)).tiers).toEqual({
        t0: 0,
        t1: 0,
        t2: 0,
        t3: 1,
        t4: 0,
      });
    },
    SLOW,
  );
});

describe("W10: render grace is a passed lease's only", () => {
  ownDatabase();

  it(
    "renders for no cancelled, superseded or withdrawn intent, and ends with a newer intent whatever its state",
    async () => {
      const cancelled = image("c-cancelled");
      const superseded = image("s-superseded");
      const withdrawn = image("w-withdrawn");
      const older = image("a-older");
      const newer = image("b-newer-cancelled");
      const control = image("d-in-grace");
      const all = [cancelled, superseded, withdrawn, older, newer, control];
      // A full queue while the intents are live: one unrelated render
      // queued, at a target of one, so none of their images gets a job.
      await fixture.setup.query(
        "INSERT INTO community.publishing_jobs(id,kind,subject_id,state,run_after,created_at,updated_at) VALUES($1,'catalog_render',$2,'queued',$3,$3,$3)",
        [
          `publishing-job-${hex(16)}`,
          `catalog-asset-${hex(16)}`,
          hoursAgo(100),
        ],
      );
      // Twenty hours ago every intent is prepared and live, its members
      // stored; each lease passes ten hours ago, the newer intent of
      // document 604 an hour later. Superseded names its own document here,
      // so only its state can end its grace.
      const lease = hoursAgo(10);
      const live = [
        intent(11, 601, lease, [cancelled]),
        intent(12, 602, lease, [superseded]),
        intent(13, 603, lease, [withdrawn]),
        intent(14, 604, lease, [older]),
        intent(15, 604, hoursAgo(9), [newer]),
        intent(16, 605, lease, [control]),
      ];
      expect((await sync(hoursAgo(20), live, 1)).enqueued).toBe(0);
      // An hour later, before any lease passed, the Owner cancels or
      // withdraws, or a prepare is superseded; each is still listed live
      // (within R), as a header.
      const ended = [
        intent(11, 601, lease, [cancelled], "cancelled"),
        intent(12, 602, lease, [superseded], "superseded"),
        intent(13, 603, lease, [withdrawn], "withdrawn"),
        intent(15, 604, hoursAgo(9), [newer], "cancelled"),
      ];
      expect(
        (await sync(hoursAgo(19), [...ended, live[3]!, live[5]!], 1)).enqueued,
      ).toBe(0);
      // Ten hours after the leases, with room in the queue: only the
      // control, an expired intent with no newer one, is rendered for (t3).
      // The older intent of document 604 is expired too, but its newer
      // intent, though cancelled, ends its grace.
      const pass = await sync(
        new Date(now),
        [
          ...ended,
          intent(14, 604, lease, [older], "expired"),
          intent(16, 605, lease, [control], "expired"),
        ],
        300,
      );
      expect(pass.enqueued).toBe(1);
      expect(await renderJobs(all)).toEqual({
        "c-cancelled": 0,
        "s-superseded": 0,
        "w-withdrawn": 0,
        "a-older": 0,
        "b-newer-cancelled": 0,
        "d-in-grace": 1,
      });
      // A job claimed for any of them now completes unrendered.
      expect(await referenced(all)).toEqual({
        "c-cancelled": false,
        "s-superseded": false,
        "w-withdrawn": false,
        "a-older": false,
        "b-newer-cancelled": false,
        "d-in-grace": true,
      });
      expect((await readCatalogRenderBacklog(fixture.app)).tiers).toEqual({
        t0: 0,
        t1: 0,
        t2: 0,
        t3: 1,
        t4: 0,
      });
    },
    SLOW,
  );
});
