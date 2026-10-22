import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { catalogSyncIdentities } from "@moya/backend-production/internal/publishing-catalog";
import {
  catalogExpectedRenditions,
  createCatalogPublicationAuthority,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  PostgresWorkPublishingAdapter,
  readCatalogDeliveryProjection,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { CatalogRenditionRole, PublishingJobLease } from "@moya/api";

/*
 * catalog-delivery-release-hardening-v1 (Issue #317), group g3, on a dedicated
 * synthetic database with its own App role, so every store command runs with
 * exactly the App grants:
 * N3 a Catalog recipe bump keeps the published editorial set desired and
 *    served, for every role at once (never a replacement copied early beside
 *    it, even when the worker records a re-render in two passes); reconcile
 *    plans no withdrawal before its replacement is published, even though
 *    recording the replacement releases the old rows.
 * F3 a release committed after the mirror already expired its intent never
 *    wedges the asset sync of every other source and intent, and the pass
 *    reports it; an intent whose immutable identity drifted is skipped alone
 *    and its live mirror left as it is.
 * F7 an intent the snapshot holds but cannot decode leaves its mirror row
 *    untouched; only absence tombstones it.
 * Content is synthetic; no object store, CMS or network.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targetUrl = requireSyntheticTestDatabaseUrl();
const endpoint = new URL(targetUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error(
    "Catalog delivery tests require a loopback disposable target",
  );
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};

const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const administration = poolFor(targetUrl);
const SLOW = 120_000;
const t0 = new Date("2126-10-21T04:00:00.000Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

const suffix = hex(6);
const database = `cd_robust_${suffix}_synthetic_test`;
const appRole = `cd_app_${suffix}`;
let setup: Pool;
let app: Pool;
let created = { database: false, app: false };

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const appPassword = hex(32);
  await administration.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, app: true };
  await administration.query(`CREATE DATABASE ${database}`);
  created = { ...created, database: true };
  const url = (login?: {
    readonly role: string;
    readonly password: string;
  }) => {
    const value = new URL(targetUrl);
    value.pathname = `/${database}`;
    if (login !== undefined) {
      value.username = login.role;
      value.password = login.password;
    }
    return value.toString();
  };
  setup = poolFor(url());
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  // The CMS projection stubs the grant scripts name; the setup (owner) pool
  // reads public.catalog_media as the CMS public read identity.
  await setup.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      )
    ).replaceAll(':"app_role"', `"${appRole}"`),
  );
  await setup.query(
    `GRANT SELECT (intent_id, asset_id) ON TABLE community.catalog_delivery_media_refs TO "${appRole}"`,
  );
  app = poolFor(url({ role: appRole, password: appPassword }));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.app) await administration.query(`DROP ROLE IF EXISTS ${appRole}`);
  await administration.end();
}, SLOW);

const blobKey = () => {
  const key = hex();
  return `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
};

interface Image {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

const editorialImage = (width = 4096, height = 2731): Image => {
  const mediaId = `media-${hex(8)}`;
  const objectKey = `editorial/${sha(`catalog-${mediaId}`)}/${sha(`${mediaId}:orig`)}-${sha(mediaId)}.jpg`;
  return {
    mediaId,
    objectKey,
    assetId: `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`,
    width,
    height,
  };
};

/** Ready renditions of the current recipe on committed blobs (of the listed
 * roles, else every planned role); returns their IDs. */
const readyRenditions = async (
  image: Image,
  when: Date,
  roles?: readonly string[],
) => {
  const ids: string[] = [];
  for (const want of catalogExpectedRenditions(image.width, image.height)) {
    if (roles && !roles.includes(want.role)) continue;
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp',$4)",
      [blob, blobKey(), sha(blob), when],
    );
    const id = `media-rendition-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,$4,$5,$6,$7,$8,'image/webp',$9)",
      [
        id,
        image.assetId,
        want.role,
        want.version,
        want.digest,
        blob,
        want.width,
        want.height,
        when,
      ],
    );
    ids.push(id);
  }
  return ids.sort();
};

/** A published, rendered editorial image (current recipe), rendered long
 * enough ago that the blob purge delay no longer protects its bytes. */
const publishedImage = async () => {
  const image = editorialImage();
  await setup.query(
    "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,$4,$5,true,0)",
    [
      `catalog-${hex(8)}`,
      image.mediaId,
      image.objectKey,
      image.width,
      image.height,
    ],
  );
  const master = sha(image.mediaId);
  await setup.query(
    `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,master_sha256,master_width,master_height,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',$4,$5,$6,'ready',$7,$7)`,
    [
      image.assetId,
      image.mediaId,
      image.objectKey,
      master,
      image.width,
      image.height,
      t0,
    ],
  );
  return { image, renditions: await readyRenditions(image, at(-180)) };
};

const jobs = async (subject: string) =>
  (
    await setup.query<{ kind: string; state: string }>(
      "SELECT kind,state FROM community.publishing_jobs WHERE subject_id=$1 AND kind IN ('publish_media','withdraw_media') ORDER BY kind,created_at",
      [subject],
    )
  ).rows;

describe("N3: a Catalog recipe bump never withdraws before replacement", () => {
  const authority = () => createCatalogPublicationAuthority(setup, null, app);
  const adapter = () =>
    new PostgresMediaPublicationAdapter(app, {
      isPublic: () => true,
      allowPublish: () => true,
      catalogAuthority: authority(),
    });
  /** Runs the queued publish job of a subject to completion. */
  const publishQueued = async (subject: string, when: Date) => {
    const owner = hex(8);
    const job = (
      await setup.query<{ id: string }>(
        "UPDATE community.publishing_jobs SET state='running',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '1 hour' WHERE subject_id=$1 AND kind='publish_media' AND state='queued' RETURNING id",
        [subject, owner, when],
      )
    ).rows[0]!;
    // The reconcile also queues a withdraw of nothing; it is not under test.
    await setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2 WHERE subject_id=$1 AND state='queued'",
      [subject, when],
    );
    const lease: PublishingJobLease = { id: job.id, leaseOwner: owner };
    const publication = adapter();
    const plan = await publication.planPublish(subject, lease, when);
    if (plan.status !== "ready") throw new Error(plan.status);
    try {
      expect(await publication.finishPublish(plan.fence, when)).toBe(true);
    } finally {
      await publication.release(plan.fence, when);
      await setup.query(
        "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id, when],
      );
    }
    return plan.units.map((unit) => unit.renditionId!).sort();
  };
  /** Plans the queued withdraw job of a subject; returns what it withdraws. */
  const withdrawQueued = async (subject: string, when: Date) => {
    const owner = hex(8);
    const job = (
      await setup.query<{ id: string }>(
        "UPDATE community.publishing_jobs SET state='running',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '1 hour' WHERE subject_id=$1 AND kind='withdraw_media' AND state='queued' RETURNING id",
        [subject, owner, when],
      )
    ).rows[0]!;
    const lease: PublishingJobLease = { id: job.id, leaseOwner: owner };
    const publication = adapter();
    const plan = await publication.planWithdrawal(subject, lease, when);
    if (plan.status !== "ready") throw new Error(plan.status);
    try {
      return plan.units.map((unit) => unit.renditionId!).sort();
    } finally {
      await publication.release(plan.fence, when);
      await setup.query(
        "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id, when],
      );
    }
  };
  /** purge_blob jobs scheduled for the blobs of these renditions. */
  const purgesScheduled = async (renditionIds: readonly string[]) =>
    (
      await setup.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM community.publishing_jobs j JOIN community.media_renditions r ON r.blob_id=j.subject_id WHERE j.kind='purge_blob' AND r.id=ANY($1::text[])",
        [renditionIds],
      )
    ).rows[0]!.n;
  const cleanup = (when: Date) =>
    new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    }).scheduleCleanup(when, 100);
  const published = async (assetId: string) =>
    (
      await setup.query<{ rendition_id: string }>(
        "SELECT p.rendition_id FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id WHERE a.catalog_asset_id=$1 AND p.state='published' ORDER BY p.rendition_id",
        [assetId],
      )
    ).rows.map((r) => r.rendition_id);
  const served = async (image: Image, plan = catalogExpectedRenditions) =>
    (
      await readCatalogDeliveryProjection(
        app,
        [{ mediaId: image.mediaId, objectKey: image.objectKey }],
        plan,
      )
    )
      .get(JSON.stringify([image.mediaId, image.objectKey]))
      ?.renditions?.map(({ key }) => key)
      .sort();

  it("keeps the published set desired and served until the new recipe's set is published, then retires it", async () => {
    const { image, renditions: previous } = await publishedImage();
    expect(await adapter().reconcile(at(1), true, 500)).toMatchObject({
      publish: 1,
    });
    expect(await publishQueued(image.assetId, at(2))).toEqual(previous);
    expect(await published(image.assetId)).toEqual(previous);
    expect(await served(image)).toEqual(previous);

    // The deployed registry changes the Catalog recipe: every stored
    // rendition of this image now names a recipe the current plan omits.
    await setup.query(
      "UPDATE community.media_renditions SET recipe_digest='0000000000000000' WHERE id=ANY($1::text[])",
      [previous],
    );
    // Reconcile keeps the previous set: no withdrawal and nothing to copy.
    expect(await adapter().reconcile(at(3), true, 500)).toEqual({
      publish: 0,
      withdraw: 0,
    });
    expect(await jobs(image.assetId)).not.toContainEqual(
      expect.objectContaining({ kind: "withdraw_media", state: "queued" }),
    );
    expect(await published(image.assetId)).toEqual(previous);
    expect(await served(image)).toEqual(previous);
    expect((await adapter().lookupPublishedCatalog(previous, at(3))).size).toBe(
      previous.length,
    );

    // The re-render records the new recipe's set, which releases each
    // slot's previous rendition at once (renditions.ts recording rule),
    // before the replacement is copied.
    await setup.query(
      "UPDATE community.media_renditions SET state='released',superseded_at=$2,released_at=$2 WHERE id=ANY($1::text[])",
      [previous, at(4)],
    );
    const replacement = await readyRenditions(image, at(4));
    // Released but still published: it keeps serving (its keys still resolve
    // to their public objects), and reconcile copies the replacement without
    // withdrawing it.
    expect(await served(image)).toEqual(previous);
    expect((await adapter().lookupPublishedCatalog(previous, at(4))).size).toBe(
      previous.length,
    );
    expect(await adapter().reconcile(at(5), true, 500)).toEqual({
      publish: 1,
      withdraw: 0,
    });
    // Queuing the copy also re-checks the live generations (publication-sync);
    // that check withdraws nothing while the previous set is still served.
    expect(await withdrawQueued(image.assetId, at(5))).toEqual([]);
    expect(await published(image.assetId)).toEqual(previous);
    expect(await served(image)).toEqual(previous);
    // Its bytes stay committed meanwhile: a live generation keeps a released
    // Catalog rendition's blob in use, so the cleanup schedules no purge.
    await cleanup(at(5));
    expect(await purgesScheduled(previous)).toBe(0);
    expect(await publishQueued(image.assetId, at(6))).toEqual(replacement);
    expect(await published(image.assetId)).toEqual(
      [...previous, ...replacement].sort(),
    );
    expect(await served(image)).toEqual(replacement);
    // Only now, with its replacement published, is the previous set retired.
    expect(await adapter().reconcile(at(7), true, 500)).toEqual({
      publish: 0,
      withdraw: 1,
    });
    expect(await withdrawQueued(image.assetId, at(7))).toEqual(previous);
    expect(await published(image.assetId)).toEqual(replacement);
    expect(await served(image)).toEqual(replacement);
    expect((await adapter().lookupPublishedCatalog(previous, at(7))).size).toBe(
      0,
    );
    expect(
      (await adapter().lookupPublishedCatalog(replacement, at(7))).size,
    ).toBe(replacement.length);
    // Withdrawn, the previous set's blobs return to the existing purge.
    await cleanup(at(8));
    expect(await purgesScheduled(previous)).toBe(previous.length);
  });

  it("never serves a replacement published early beside the previous set", async () => {
    const { image, renditions: previous } = await publishedImage();
    expect(await adapter().reconcile(at(11), true, 500)).toMatchObject({
      publish: 1,
    });
    expect(await publishQueued(image.assetId, at(12))).toEqual(previous);
    expect(await served(image)).toEqual(previous);
    const roleOf = async (ids: readonly string[]) =>
      (
        await setup.query<{ id: string; role: string }>(
          "SELECT id,role FROM community.media_renditions WHERE id=ANY($1::text[]) ORDER BY id",
          [ids],
        )
      ).rows;
    const byRole = await roleOf(previous);
    const previousOf = (roles: readonly string[]) =>
      byRole.filter((r) => roles.includes(r.role)).map((r) => r.id);
    const rest = ["cover", "display", "viewer"];
    await setup.query(
      "UPDATE community.media_renditions SET recipe_digest='0000000000000000' WHERE id=ANY($1::text[])",
      [previous],
    );
    // The re-render records the thumb first: its previous rendition is
    // released and its replacement is ready at the same instant.
    await setup.query(
      "UPDATE community.media_renditions SET state='released',superseded_at=$2,released_at=$2 WHERE id=ANY($1::text[])",
      [previousOf(["thumb"]), at(14)],
    );
    const thumb = await readyRenditions(image, at(14), ["thumb"]);
    expect(await adapter().reconcile(at(15), true, 500)).toEqual({
      publish: 1,
      withdraw: 0,
    });
    expect(await withdrawQueued(image.assetId, at(15))).toEqual([]);
    // Reconcile copies the new thumb early; the public read still serves the
    // previous set for every role, never the new thumb beside it.
    expect(await publishQueued(image.assetId, at(16))).toEqual(thumb);
    expect(await published(image.assetId)).toEqual(
      [...previous, ...thumb].sort(),
    );
    expect(await served(image)).toEqual(previous);
    // The rest of the set is recorded later, and is not yet copied.
    await setup.query(
      "UPDATE community.media_renditions SET state='released',superseded_at=$2,released_at=$2 WHERE id=ANY($1::text[])",
      [previousOf(rest), at(20)],
    );
    const others = await readyRenditions(image, at(20), rest);
    expect(await served(image)).toEqual(previous);
    expect(await adapter().reconcile(at(21), true, 500)).toEqual({
      publish: 1,
      withdraw: 0,
    });
    expect(await withdrawQueued(image.assetId, at(21))).toEqual([]);
    expect(await publishQueued(image.assetId, at(22))).toEqual(others);
    // Complete and published: every role switches at once.
    const replacement = [...thumb, ...others].sort();
    expect(await served(image)).toEqual(replacement);
    expect(await adapter().reconcile(at(23), true, 500)).toEqual({
      publish: 0,
      withdraw: 1,
    });
    expect(await withdrawQueued(image.assetId, at(23))).toEqual(previous);
    expect(await served(image)).toEqual(replacement);
  });

  it("holds the previous set across a re-render the worker records in two passes", async () => {
    const { image, renditions: previous } = await publishedImage();
    expect(await adapter().reconcile(at(31), true, 500)).toMatchObject({
      publish: 1,
    });
    expect(await publishQueued(image.assetId, at(32))).toEqual(previous);
    // The next recipe version of every role; the projection reads against it
    // while reconcile keeps the deployed registry (it copies every ready
    // rendition early, whatever its recipe, and withdraws nothing).
    const bumped = (width: number, height: number) =>
      catalogExpectedRenditions(width, height).map((want) => ({
        ...want,
        version: want.version + 1,
        digest: "fedcba9876543210",
      }));
    expect(await served(image, bumped)).toEqual(previous);
    const works = new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
    /** Records these roles of the bumped recipe through the worker's own
     * recording path (recordCatalogRenditions); returns their IDs. */
    const record = async (roles: readonly string[], when: Date) => {
      expect(
        await works.recordCatalogRenditions(
          image.assetId,
          {
            masterSha256: sha(image.mediaId),
            masterWidth: image.width,
            masterHeight: image.height,
            placeholderColor: null,
            renditions: bumped(image.width, image.height)
              .filter((want) => roles.includes(want.role))
              .map((want) => ({
                storageKey: blobKey(),
                byteSize: 1000,
                sha256: sha(hex()),
                role: want.role as CatalogRenditionRole,
                recipeVersion: want.version,
                recipeDigest: want.digest,
                contentType: "image/webp" as const,
                width: want.width,
                height: want.height,
              })),
          },
          when,
        ),
      ).toEqual({ status: "recorded" });
      return (
        await setup.query<{ id: string }>(
          "SELECT id FROM community.media_renditions WHERE catalog_asset_id=$1 AND state='ready' AND role=ANY($2::text[]) AND NOT(id=ANY($3::text[])) ORDER BY id",
          [image.assetId, roles, previous],
        )
      ).rows.map((r) => r.id);
    };
    // The fallback relies on this recording rule: a replaced rendition
    // leaves its slot at the very instant its successor is recorded.
    const handover = async () =>
      (
        await setup.query<{ role: string; replaced: Date; created: Date }>(
          "SELECT o.role,COALESCE(o.superseded_at,o.released_at) AS replaced,n.created_at AS created FROM community.media_renditions o JOIN community.media_renditions n ON n.catalog_asset_id=o.catalog_asset_id AND n.role=o.role AND n.edit_key=o.edit_key AND n.state='ready' WHERE o.catalog_asset_id=$1 AND o.state<>'ready' ORDER BY o.role",
          [image.assetId],
        )
      ).rows;
    const thumb = await record(["thumb"], at(34));
    expect(await handover()).toEqual([
      { role: "thumb", replaced: at(34), created: at(34) },
    ]);
    expect(await adapter().reconcile(at(35), true, 500)).toEqual({
      publish: 1,
      withdraw: 0,
    });
    expect(await withdrawQueued(image.assetId, at(35))).toEqual([]);
    expect(await publishQueued(image.assetId, at(36))).toEqual(thumb);
    // The new thumb is published, yet never served beside the previous set.
    expect(await served(image, bumped)).toEqual(previous);
    const rest = ["cover", "display", "viewer"];
    const others = await record(rest, at(40));
    expect(await handover()).toEqual(
      ["cover", "display", "thumb", "viewer"].map((role) => {
        const when = role === "thumb" ? at(34) : at(40);
        return { role, replaced: when, created: when };
      }),
    );
    expect(await served(image, bumped)).toEqual(previous);
    expect(await adapter().reconcile(at(41), true, 500)).toEqual({
      publish: 1,
      withdraw: 0,
    });
    expect(await withdrawQueued(image.assetId, at(41))).toEqual([]);
    expect(await publishQueued(image.assetId, at(42))).toEqual(others);
    // Complete and published: every role switches at once.
    expect(await served(image, bumped)).toEqual([...thumb, ...others].sort());
  });
});

describe("F3: a release committed after local expiry never wedges the sync", () => {
  const works = () =>
    new PostgresWorkPublishingAdapter(app, {
      publication: { allowPublish: () => true, isPublic: () => true },
    });
  const source = (image: Image) => ({
    mediaId: image.mediaId,
    objectKey: image.objectKey,
    width: image.width,
    height: image.height,
  });
  const intent = (
    intentId: string,
    image: Image,
    state: "prepared" | "release_requested" | "released",
    stateVersion: number,
    expiresAt: Date,
    documentId: number,
  ) => ({
    intentId,
    documentId,
    catalogId: `catalog-${documentId}`,
    revision: 1,
    fingerprint: sha(`${intentId}:fingerprint`),
    manifestSha256: sha(`${intentId}:manifest`),
    recipeManifestSha256: sha("recipe"),
    state,
    stateVersion,
    mediaCount: 1,
    media: [
      {
        ordinal: 1,
        mediaId: image.mediaId,
        objectKey: image.objectKey,
        sourceSha256: sha(image.mediaId),
        width: image.width,
        height: image.height,
      },
    ],
    expiresAt: expiresAt.toISOString(),
  });
  const prepares = async (ids: readonly string[]) =>
    (
      await setup.query<{
        intent_id: string;
        source_state: string;
        source_state_version: number;
        observed_live: boolean;
        ended: boolean;
      }>(
        "SELECT intent_id,source_state,source_state_version,observed_live,ended_at IS NOT NULL AS ended FROM community.catalog_delivery_prepares WHERE intent_id=ANY($1::uuid[]) ORDER BY intent_id",
        [ids],
      )
    ).rows;

  it("keeps the late release's tombstone and applies every other intent and source", async () => {
    const late = "00000000-0000-4000-8000-0000000000f1";
    const other = "00000000-0000-4000-8000-0000000000f2";
    const lateImage = editorialImage(3000, 2000);
    const otherImage = editorialImage(3000, 2000);
    const live = editorialImage(3000, 2000);
    const added = editorialImage(3000, 2000);
    const observed = at(60);
    const options = (
      when: Date,
      sources: readonly Image[],
      preparations: ReturnType<typeof intent>[],
    ) =>
      ({
        limit: 100,
        renditions: catalogSyncIdentities(),
        snapshot: {
          observedAt: when,
          publishedSources: sources.map(source),
          preparations,
        },
      }) as unknown as Parameters<
        PostgresWorkPublishingAdapter["syncCatalogAssets"]
      >[2];
    // The snapshot sees release_requested just past expires_at (the release
    // transaction has not committed yet), so the mirror stores it expired.
    await works().syncCatalogAssets(
      [live, lateImage, otherImage].map(source),
      observed,
      options(
        observed,
        [live],
        [
          intent(late, lateImage, "release_requested", 2, at(59), 1),
          intent(other, otherImage, "prepared", 1, at(24 * 60), 2),
        ],
      ),
    );
    expect(await prepares([late, other])).toEqual([
      {
        intent_id: late,
        source_state: "expired",
        source_state_version: 2,
        observed_live: true,
        ended: true,
      },
      {
        intent_id: other,
        source_state: "prepared",
        source_state_version: 1,
        observed_live: true,
        ended: false,
      },
    ]);
    // The release then commits (state_version 3); the record is published
    // with its image, and an unrelated image and lifecycle change arrive.
    for (const round of [1, 2]) {
      const when = at(60 + 5 * round);
      const counts = await works().syncCatalogAssets(
        [live, lateImage, added, otherImage].map(source),
        when,
        options(
          when,
          [live, lateImage, added],
          [
            intent(late, lateImage, "released", 3, at(59), 1),
            intent(other, otherImage, "release_requested", 2, at(24 * 60), 2),
          ],
        ),
      );
      expect(counts.referenced).toBe(4);
      // Reported every pass while Native keeps the late release.
      expect(counts.refusedIntentIds).toEqual([late]);
    }
    expect(await prepares([late, other])).toEqual([
      {
        intent_id: late,
        source_state: "expired",
        source_state_version: 2,
        observed_live: false,
        ended: true,
      },
      {
        intent_id: other,
        source_state: "release_requested",
        source_state_version: 2,
        observed_live: true,
        ended: false,
      },
    ]);
    const assets = (
      await setup.query<{ id: string; unreferenced: boolean }>(
        "SELECT id,unreferenced_since IS NOT NULL AS unreferenced FROM community.catalog_media_assets WHERE id=ANY($1::text[]) ORDER BY id",
        [[live, lateImage, added].map((image) => image.assetId)],
      )
    ).rows;
    expect(assets).toHaveLength(3);
    expect(assets.every((asset) => !asset.unreferenced)).toBe(true);
    expect(
      (
        await setup.query(
          "SELECT 1 FROM community.publishing_jobs WHERE kind='catalog_render' AND subject_id=$1",
          [added.assetId],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("skips an intent whose identity drifted, leaving its live mirror as it is", async () => {
    const drifted = "00000000-0000-4000-8000-0000000000f8";
    const other = "00000000-0000-4000-8000-0000000000f9";
    const image = editorialImage(3000, 2000);
    const otherImage = editorialImage(3000, 2000);
    const expires = at(24 * 60 + 100);
    const sync = (when: Date, preparations: ReturnType<typeof intent>[]) =>
      works().syncCatalogAssets([image, otherImage].map(source), when, {
        limit: 100,
        renditions: catalogSyncIdentities(),
        snapshot: { observedAt: when, publishedSources: [], preparations },
      } as unknown as Parameters<
        PostgresWorkPublishingAdapter["syncCatalogAssets"]
      >[2]);
    const exact = intent(drifted, image, "prepared", 1, expires, 4);
    await sync(at(100), [
      exact,
      intent(other, otherImage, "prepared", 1, expires, 5),
    ]);
    const live = {
      intent_id: drifted,
      source_state: "prepared",
      source_state_version: 1,
      observed_live: true,
      ended: false,
    };
    expect(await prepares([drifted])).toEqual([live]);
    // Each snapshot contradicts the immutable identity (expiry, fingerprint,
    // document, media) while the other intent moves on.
    const drifts = [
      { ...exact, expiresAt: at(24 * 60 + 200).toISOString() },
      { ...exact, fingerprint: sha("drifted") },
      { ...exact, documentId: 6 },
      { ...exact, media: [{ ...exact.media[0]!, width: 3001 }] },
    ];
    for (const [round, snapshot] of drifts.entries()) {
      const counts = await sync(at(105 + round), [
        snapshot,
        intent(other, otherImage, "release_requested", 2 + round, expires, 5),
      ]);
      // Neither ended nor revived: the mirror stays exactly as it was.
      expect(await prepares([drifted, other])).toEqual([
        live,
        {
          intent_id: other,
          source_state: "release_requested",
          source_state_version: 2 + round,
          observed_live: true,
          ended: false,
        },
      ]);
      // Reported for the operator's log, never as a tombstone.
      expect(counts.mismatchedIntentIds).toEqual([drifted]);
      expect(counts.refusedIntentIds).toBeUndefined();
    }
    // A snapshot that agrees again is applied as usual.
    const agreed = await sync(at(120), [
      intent(drifted, image, "release_requested", 2, expires, 4),
    ]);
    expect(agreed.mismatchedIntentIds).toBeUndefined();
    expect(await prepares([drifted])).toEqual([
      { ...live, source_state: "release_requested", source_state_version: 2 },
    ]);
    // A drift beside a state_version regression (2 -> 1) is still a drift,
    // header or media alike: skipped, never tombstoned.
    for (const [round, snapshot] of [
      { ...exact, fingerprint: sha("drifted") },
      { ...exact, media: [{ ...exact.media[0]!, width: 3001 }] },
    ].entries()) {
      const counts = await sync(at(125 + round), [snapshot]);
      expect(counts.mismatchedIntentIds).toEqual([drifted]);
      expect(counts.refusedIntentIds).toBeUndefined();
      expect(await prepares([drifted])).toEqual([
        { ...live, source_state: "release_requested", source_state_version: 2 },
      ]);
    }
  });

  it("leaves the mirror of an undecodable intent untouched; only absence tombstones it", async () => {
    const kept = "00000000-0000-4000-8000-0000000000f7";
    const image = editorialImage(3000, 2000);
    const sync = (
      when: Date,
      preparations: ReturnType<typeof intent>[],
      undecodableIntentIds?: string[],
    ) =>
      works().syncCatalogAssets([source(image)], when, {
        limit: 100,
        renditions: catalogSyncIdentities(),
        snapshot: {
          observedAt: when,
          publishedSources: [],
          preparations,
          ...(undecodableIntentIds ? { undecodableIntentIds } : {}),
        },
      } as unknown as Parameters<
        PostgresWorkPublishingAdapter["syncCatalogAssets"]
      >[2]);
    await sync(at(200), [
      intent(kept, image, "prepared", 1, at(24 * 60 + 200), 3),
    ]);
    const live = {
      intent_id: kept,
      source_state: "prepared",
      source_state_version: 1,
      observed_live: true,
      ended: false,
    };
    expect(await prepares([kept])).toEqual([live]);
    // Decoder or view skew: the snapshot holds the intent but cannot decode
    // it. Nothing about it is known, so nothing is written.
    const skewed = await sync(at(205), [], [kept]);
    expect(skewed.refusedIntentIds).toBeUndefined();
    expect(await prepares([kept])).toEqual([live]);
    // Absent from a complete snapshot: tombstoned as before.
    await sync(at(210), []);
    expect(await prepares([kept])).toEqual([
      { ...live, observed_live: false, ended: true },
    ]);
  });
});
