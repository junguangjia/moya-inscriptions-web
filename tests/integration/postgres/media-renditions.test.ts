import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECIPE_DIGESTS_V1,
  currentRecipe,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CommunityMigrationStateError,
  PostgresWorkPublishingAdapter,
  USER_PURGE_HOLDS_PRE_TASK_BLOBS,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type {
  CatalogMediaSource,
  CatalogRenditionIdentity,
  CatalogRenditionRole,
  PublishingDerivativeRecord,
  PublishingRenditionRole,
} from "@moya/api";

/*
 * unified-media-pipeline-v1 increment 1 on dedicated synthetic databases:
 * the media_derivatives → media_renditions copy (adoption as recipe version
 * 1, abort on mismatch, idempotent re-run), recording with supersede and
 * dead-blob release, readers through ready renditions, the Catalog asset
 * store (dead blobs count as missing, unreadable sources are retried after
 * a day), owner-less blobs outside every capacity, the D7 retention hold
 * (set by the recording rule, released only by the author's own purge) and
 * the job kind CHECK. Every case runs on databases this file creates, so the
 * store-wide cleanup pass and the Catalog sync never meet another suite.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const testDatabaseUrl = requireSyntheticTestDatabaseUrl();
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(
  repositoryRoot,
  "database",
  "community-migrations",
);
const disposableTarget = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget: (rows: unknown, database: string) => string;
};

const endpoint = new URL(testDatabaseUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search !== "" ||
  endpoint.hash !== ""
)
  throw new Error(
    "Media rendition tests require a loopback TEST_DATABASE_URL without query overrides or fragments",
  );

const RENDITIONS_MIGRATION = "20261004010000";
const PREVIOUS_MIGRATION = "20261003010000";
const SLOW = 60_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = new Date("2026-09-20T12:00:00.000Z");

const hex = () => randomBytes(16).toString("hex");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const written = (byteSize = 1000) => {
  const key = hex();
  return {
    storageKey: `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`,
    byteSize,
    sha256: sha256(key),
  };
};

// Only these test-owned databases are ever created or dropped.
const dedicatedDatabaseName =
  /^mr_(?:upgrade|shared)_[0-9a-f]{12}_synthetic_test$/;
const administration = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const created: string[] = [];
const pools: Pool[] = [];

const createDedicatedDatabase = async (
  kind: "upgrade" | "shared",
): Promise<Pool> => {
  const probe = await administration.query(
    disposableTarget.disposableTestTargetProbeSql,
  );
  disposableTarget.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(testDatabaseUrl),
  );
  const name = `mr_${kind}_${randomBytes(6).toString("hex")}_synthetic_test`;
  if (!dedicatedDatabaseName.test(name)) throw new Error("Unexpected name");
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  assertSyntheticTestDatabaseUrl(url.toString());
  await administration.query(`CREATE DATABASE ${name}`);
  created.push(name);
  const pool = createPostgresPool(
    parsePostgresConfig({ DATABASE_URL: url.toString() }),
  );
  pools.push(pool);
  return pool;
};

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  for (const name of created)
    if (dedicatedDatabaseName.test(name))
      await administration.query(
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
      );
  await administration.end();
});

const createUser = async (pool: Pool): Promise<string> => {
  const id = opaque("user");
  await pool.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'媒体测试')",
    [id, `mr-${id.slice(-20)}`],
  );
  return id;
};

const createItem = async (
  pool: Pool,
  owner: string,
  kind: "static" | "live" = "static",
  state: "ready" | "purged" | "cancelled" = "ready",
): Promise<string> => {
  const id = opaque("media-item");
  await pool.query(
    `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,created_at,updated_at)
     VALUES($1,$2,$3,'standard','upload',$4,'{"width":4000,"height":3000}'::jsonb,$5,$5)`,
    [id, owner, kind, state, t0],
  );
  return id;
};

const createBlob = async (
  pool: Pool,
  owner: string,
  createdAt: Date,
  state: "committed" | "tombstoned" = "committed",
  contentType = "image/webp",
): Promise<{ id: string; storageKey: string }> => {
  const id = opaque("media-blob");
  const blob = written();
  await pool.query(
    `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at,tombstoned_at)
     VALUES($1,$2,'derivative',$3,$4,$5,$6,$7,$8,CASE WHEN $7='tombstoned' THEN $8::timestamptz END)`,
    [
      id,
      owner,
      blob.storageKey,
      blob.byteSize,
      blob.sha256,
      contentType,
      state,
      createdAt,
    ],
  );
  return { id, storageKey: blob.storageKey };
};

/** A ready version 1 rendition row, as migration 20261004010000 adopts one. */
const insertRendition = async (
  pool: Pool,
  itemId: string,
  role: PublishingRenditionRole,
  blobId: string,
  createdAt: Date,
): Promise<string> => {
  const id = opaque("media-rendition");
  await pool.query(
    `INSERT INTO community.media_renditions(id,item_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at)
     VALUES($1,$2,'base',$3,1,$4,$5,2048,1536,'image/webp',$6)`,
    [id, itemId, role, RECIPE_DIGESTS_V1[role], blobId, createdAt],
  );
  return id;
};

const record = (
  role: PublishingRenditionRole,
  extra: Partial<PublishingDerivativeRecord> = {},
): PublishingDerivativeRecord => ({
  ...written(),
  variant: role,
  editKey: "base",
  contentType: role === "motion" ? "video/mp4" : "image/webp",
  width: 480,
  height: 360,
  durationMs: role === "motion" ? 3000 : null,
  recipeVersion: currentRecipe(role).version,
  recipeDigest: currentRecipe(role).digest,
  ...extra,
});

describe("media_renditions migration on a dedicated synthetic database", () => {
  it(
    "copies every derivative row as recipe version 1, aborts on a mismatch and re-runs as a no-op",
    async () => {
      const pool = await createDedicatedDatabase("upgrade");
      await runCommunityMigrations(pool, migrationsDirectory, {
        through: PREVIOUS_MIGRATION,
      });
      const owner = await createUser(pool);
      const still = await createItem(pool, owner);
      const live = await createItem(pool, owner, "live");
      const purged = await createItem(pool, owner, "static", "purged");
      const edit = "0123456789abcdef0123456789abcdef";
      const derivatives: {
        item: string;
        variant: "thumb" | "display" | "full" | "motion" | "cover";
        editKey: string;
        width: number;
        height: number;
        durationMs: number | null;
        contentType: string;
        blob: string;
        createdAt: Date;
      }[] = [];
      const seed = async (
        item: string,
        variant: (typeof derivatives)[number]["variant"],
        editKey: string,
        width: number,
        height: number,
        blobState: "committed" | "tombstoned" = "committed",
      ) => {
        const contentType = variant === "motion" ? "video/mp4" : "image/webp";
        const createdAt = new Date(t0.getTime() + derivatives.length * 1000);
        const blob = await createBlob(pool, owner, t0, blobState, contentType);
        const durationMs = variant === "motion" ? 3000 : null;
        await pool.query(
          `INSERT INTO community.media_derivatives(item_id,variant,edit_key,blob_id,width,height,duration_ms,content_type,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            item,
            variant,
            editKey,
            blob.id,
            width,
            height,
            durationMs,
            contentType,
            createdAt,
          ],
        );
        derivatives.push({
          item,
          variant,
          editKey,
          width,
          height,
          durationMs,
          contentType,
          blob: blob.id,
          createdAt,
        });
        return blob;
      };
      await seed(still, "thumb", "base", 480, 360);
      const display = await seed(still, "display", "base", 2048, 1536);
      await seed(still, "full", "base", 4000, 3000);
      await seed(still, "cover", "base", 1080, 810);
      await seed(still, "thumb", edit, 360, 480);
      await seed(live, "display", "base", 1536, 2048);
      await seed(live, "motion", "base", 1080, 1920);
      // A long scroll at the long-scroll display bound.
      await seed(live, "full", "base", 2500, 16_000);
      await seed(purged, "display", "base", 2048, 1536, "tombstoned");
      const checksum = async () =>
        (
          await pool.query<{ sum: string }>(
            "SELECT md5(string_agg(d::text, ',' ORDER BY item_id, variant, edit_key)) AS sum FROM community.media_derivatives d",
          )
        ).rows[0]!.sum;
      const before = await checksum();

      // A row the new table cannot hold (WebP's 16,383 bound) aborts the
      // whole migration; nothing of it remains.
      const oversized = await createBlob(pool, owner, t0);
      await pool.query(
        "INSERT INTO community.media_derivatives(item_id,variant,edit_key,blob_id,width,height,content_type) VALUES($1,'full',$2,$3,16384,1000,'image/webp')",
        [still, "f".repeat(32), oversized.id],
      );
      await expect(
        runCommunityMigrations(pool, migrationsDirectory),
      ).rejects.toBeInstanceOf(CommunityMigrationStateError);
      expect(
        (
          await pool.query<{ table: string | null; applied: string }>(
            `SELECT to_regclass('community.media_renditions')::text AS table,
               (SELECT count(*)::text FROM community.schema_migrations WHERE migration_id=$1) AS applied`,
            [RENDITIONS_MIGRATION],
          )
        ).rows,
      ).toEqual([{ table: null, applied: "0" }]);
      await pool.query(
        "DELETE FROM community.media_derivatives WHERE blob_id=$1",
        [oversized.id],
      );
      await pool.query("DELETE FROM community.media_blobs WHERE id=$1", [
        oversized.id,
      ]);

      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual([
        RENDITIONS_MIGRATION,
      ]);
      // The retained table is byte-identical.
      expect(await checksum()).toBe(before);
      const renditions = (
        await pool.query<{
          id: string;
          item_id: string;
          catalog_asset_id: string | null;
          role: string;
          edit_key: string;
          recipe_version: number;
          recipe_digest: string;
          blob_id: string;
          width: number;
          height: number;
          duration_ms: number | null;
          content_type: string;
          state: string;
          created_at: Date;
          superseded_at: Date | null;
          released_at: Date | null;
        }>("SELECT * FROM community.media_renditions ORDER BY created_at")
      ).rows;
      expect(renditions).toEqual(
        derivatives.map((row) => ({
          id: `media-rendition-${md5(`media-derivative:${row.item}:${row.variant}:${row.editKey}`)}`,
          item_id: row.item,
          catalog_asset_id: null,
          role: row.variant,
          edit_key: row.editKey,
          recipe_version: 1,
          recipe_digest: RECIPE_DIGESTS_V1[row.variant],
          blob_id: row.blob,
          width: row.width,
          height: row.height,
          duration_ms: row.durationMs,
          content_type: row.contentType,
          state: "ready",
          created_at: row.createdAt,
          superseded_at: null,
          released_at: null,
        })),
      );
      expect(
        (
          await pool.query(
            "SELECT placeholder_color FROM community.media_items WHERE id=ANY($1::text[])",
            [[still, live, purged]],
          )
        ).rows,
      ).toEqual([
        { placeholder_color: null },
        { placeholder_color: null },
        { placeholder_color: null },
      ]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS held FROM community.media_blobs WHERE retention_hold IS NOT NULL",
          )
        ).rows,
      ).toEqual([{ held: 0 }]);

      // Readers serve the adopted rows; a tombstoned blob stays unreadable.
      const adapter = new PostgresWorkPublishingAdapter(pool);
      expect(
        await adapter.resolveMediaRead(owner, still, "display", "base"),
      ).toMatchObject({ storageKey: display.storageKey });
      expect(
        await adapter.resolveMediaRead(owner, purged, "display", "base"),
      ).toBeNull();

      // Re-running applies nothing.
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
      expect(await checksum()).toBe(before);
    },
    SLOW,
  );
});

describe("media renditions, Catalog assets and the D7 hold on a dedicated synthetic database", () => {
  let pool: Pool;
  let adapter: PostgresWorkPublishingAdapter;
  let appliedAt: Date;

  beforeAll(async () => {
    pool = await createDedicatedDatabase("shared");
    await runCommunityMigrations(pool, migrationsDirectory);
    adapter = new PostgresWorkPublishingAdapter(pool);
    appliedAt = (
      await pool.query<{ applied_at: Date }>(
        "SELECT applied_at FROM community.schema_migrations WHERE migration_id=$1",
        [RENDITIONS_MIGRATION],
      )
    ).rows[0]!.applied_at;
  }, SLOW);

  it("keeps the job kind CHECK equal to the one TypeScript list", async () => {
    const definition = (
      await pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='publishing_jobs_kind_valid' AND conrelid='community.publishing_jobs'::regclass",
      )
    ).rows[0]!.definition;
    const kinds = [...definition.matchAll(/'([a-z_]+)'::text/gu)].map(
      (match) => match[1],
    );
    expect(kinds).toEqual(publishingJobKindSchema.options);
    expect(kinds).toContain("catalog_render");
  });

  it(
    "records renditions with their recipe, supersedes newer versions and releases dead slots",
    async () => {
      const owner = await createUser(pool);
      const item = await createItem(pool, owner);
      const first = (
        ["thumb", "display", "full", "cover", "viewer"] as const
      ).map((role) => record(role));
      expect(
        await adapter.recordDerivatives(
          item,
          {
            status: "derived",
            derivatives: first,
            placeholderColor: "#a1b2c3",
          },
          t0,
        ),
      ).toEqual({ status: "recorded" });
      const rows = async () =>
        (
          await pool.query<{
            role: string;
            recipe_version: number;
            recipe_digest: string;
            state: string;
            storage_key: string;
            owner_id: string | null;
            purpose: string;
            superseded: boolean;
            released: boolean;
          }>(
            `SELECT r.role, r.recipe_version, r.recipe_digest, r.state, b.storage_key, b.owner_id, b.purpose,
               r.superseded_at IS NOT NULL AS superseded, r.released_at IS NOT NULL AS released
             FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id
             WHERE r.item_id=$1 ORDER BY r.role, r.created_at, r.recipe_version`,
            [item],
          )
        ).rows;
      expect(await rows()).toEqual(
        [...first]
          .sort((left, right) => (left.variant < right.variant ? -1 : 1))
          .map((entry) => ({
            role: entry.variant,
            recipe_version: 1,
            recipe_digest: currentRecipe(entry.variant).digest,
            state: "ready",
            storage_key: entry.storageKey,
            owner_id: owner,
            purpose: "derivative",
            superseded: false,
            released: false,
          })),
      );
      expect((await adapter.readCapacity(owner)).committedBytes).toBe(5000);
      expect(
        (
          await pool.query(
            "SELECT placeholder_color FROM community.media_items WHERE id=$1",
            [item],
          )
        ).rows,
      ).toEqual([{ placeholder_color: "#a1b2c3" }]);

      // A replayed result reads as recorded and adds nothing.
      expect(
        await adapter.recordDerivatives(
          item,
          { status: "derived", derivatives: first },
          t0,
        ),
      ).toEqual({ status: "recorded" });
      expect(await rows()).toHaveLength(5);

      // The same recipe version again is a duplicate.
      const duplicate = record("display");
      expect(
        await adapter.recordDerivatives(
          item,
          { status: "derived", derivatives: [duplicate] },
          t0,
        ),
      ).toEqual({ status: "discarded", storageKeys: [duplicate.storageKey] });

      // A newer version supersedes the ready row, which is kept.
      const newer = record("display", {
        recipeVersion: 2,
        recipeDigest: "0123456789abcdef",
        width: 2048,
        height: 1536,
      });
      expect(
        await adapter.recordDerivatives(
          item,
          { status: "derived", derivatives: [newer] },
          t0,
        ),
      ).toEqual({ status: "recorded" });
      const displays = (await rows()).filter((row) => row.role === "display");
      expect(displays).toMatchObject([
        { recipe_version: 1, state: "superseded", superseded: true },
        {
          recipe_version: 2,
          recipe_digest: "0123456789abcdef",
          state: "ready",
          storage_key: newer.storageKey,
        },
      ]);
      expect(
        await adapter.resolveMediaRead(owner, item, "display", "base"),
      ).toMatchObject({ storageKey: newer.storageKey });
      // An older version than the ready one is a duplicate too.
      const older = record("display");
      expect(
        await adapter.recordDerivatives(
          item,
          { status: "derived", derivatives: [older] },
          t0,
        ),
      ).toEqual({ status: "discarded", storageKeys: [older.storageKey] });
      // A superseded rendition's blob (written at t0, before the migration
      // ran) is pre-task bytes: the replacement held it at once.
      const supersededBlob = (
        await pool.query<{ blob_id: string }>(
          "SELECT blob_id FROM community.media_renditions WHERE item_id=$1 AND state='superseded'",
          [item],
        )
      ).rows[0]!.blob_id;
      expect(
        (
          await pool.query(
            "SELECT state, retention_hold FROM community.media_blobs WHERE id=$1",
            [supersededBlob],
          )
        ).rows,
      ).toEqual([{ state: "committed", retention_hold: "d7_pre_task" }]);
      expect(await adapter.purgeBlob(supersededBlob, t0)).toEqual({
        status: "referenced",
      });

      // A ready row whose blob is gone is released and the slot recorded.
      await pool.query(
        `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2
         WHERE id=(SELECT blob_id FROM community.media_renditions WHERE item_id=$1 AND role='thumb' AND state='ready')`,
        [item, t0],
      );
      const thumb = record("thumb");
      expect(
        await adapter.recordDerivatives(
          item,
          { status: "derived", derivatives: [thumb] },
          t0,
        ),
      ).toEqual({ status: "recorded" });
      expect(
        (await rows())
          .filter((row) => row.role === "thumb")
          .map((row) => [row.state, row.released, row.storage_key]),
      ).toEqual([
        ["released", true, first[0]!.storageKey],
        ["ready", false, thumb.storageKey],
      ]);

      // The store never defaults a recipe identity: a missing or malformed
      // one, like an edited placeholder, is a programming error.
      for (const malformed of [
        { recipeVersion: undefined },
        { recipeDigest: undefined },
        { recipeVersion: 0 },
        { recipeDigest: "0123456789ABCDEF" },
      ])
        await expect(
          adapter.recordDerivatives(
            item,
            {
              status: "derived",
              derivatives: [
                record(
                  "full",
                  malformed as unknown as Partial<PublishingDerivativeRecord>,
                ),
              ],
            },
            t0,
          ),
        ).rejects.toBeInstanceOf(TypeError);
      await expect(
        adapter.recordDerivatives(
          item,
          {
            status: "derived",
            derivatives: [record("thumb", { editKey: "a".repeat(32) })],
            placeholderColor: "#000000",
          },
          t0,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      // viewer is optional: readiness and the operator view never need it.
      const plain = await createItem(pool, owner);
      await adapter.recordDerivatives(
        plain,
        {
          status: "derived",
          derivatives: (["thumb", "display", "full", "cover"] as const).map(
            (role) => record(role),
          ),
        },
        t0,
      );
      expect(
        await adapter.ensureEditDerivatives(
          owner,
          {
            items: [
              {
                key: plain,
                itemId: plain,
                kind: "static",
                qualityMode: "standard",
                edit: { rotation: 0, crop: null },
              },
            ],
            coverKey: plain,
            coverCrop: null,
          },
          t0,
        ),
      ).toMatchObject({ ready: true, items: [{ state: "ready" }] });
    },
    SLOW,
  );

  it(
    "syncs Catalog assets from the published list and records owner-less renditions",
    async () => {
      const catalogKey = (sha: string) =>
        `display/v1/media_${hex()}/${sha}.webp`;
      const editorialKey = (sha: string) =>
        `editorial/${sha256(hex())}/${sha256(hex())}-${sha}.jpg`;
      const [shaA, shaB, shaC] = [sha256("a"), sha256("b"), sha256("c")];
      const a: CatalogMediaSource = {
        mediaId: `media_${hex()}`,
        objectKey: catalogKey(shaA),
        width: 3000,
        height: 2000,
      };
      const b: CatalogMediaSource = {
        mediaId: `media_${hex()}`,
        objectKey: catalogKey(shaB),
        width: 1000,
        height: 4000,
      };
      const c: CatalogMediaSource = {
        mediaId: `media-${randomUUID()}`,
        objectKey: editorialKey(shaC),
        width: null,
        height: null,
      };
      const unapproved: CatalogMediaSource = {
        mediaId: "media_unapproved",
        objectKey: "uploads/readable-name.jpg",
        width: 10,
        height: 10,
      };
      const idOf = (source: CatalogMediaSource) =>
        `catalog-asset-${md5(`${source.mediaId}:${source.objectKey}`)}`;
      const identity = (
        role: CatalogRenditionRole,
      ): CatalogRenditionIdentity => {
        const current = currentRecipe(role);
        return { role, version: current.version, digest: current.digest };
      };
      const renditions = (["thumb", "cover", "display"] as const).map(identity);
      const sync = (
        sources: readonly CatalogMediaSource[],
        now = t0,
        wanted = renditions,
      ) =>
        adapter.syncCatalogAssets(sources, now, {
          limit: 10,
          renditions: wanted,
        });

      expect(await sync([a, b, c, unapproved, a])).toEqual({
        referenced: 3,
        skipped: 1,
        created: 3,
        unreferenced: 0,
        enqueued: 3,
      });
      const ids = [idOf(a), idOf(b), idOf(c)];
      expect(
        (
          await pool.query(
            `SELECT id, source_sha256, source_content_type, source_width, source_height, state, unreferenced_since
             FROM community.catalog_media_assets WHERE id=ANY($1::text[]) ORDER BY source_sha256`,
            [ids],
          )
        ).rows,
      ).toEqual(
        [
          [a, shaA, "image/webp", 3000, 2000],
          [b, shaB, "image/webp", 1000, 4000],
          [c, shaC, "image/jpeg", null, null],
        ]
          .map(([source, sha, type, width, height]) => ({
            id: idOf(source as CatalogMediaSource),
            source_sha256: sha,
            source_content_type: type,
            source_width: width,
            source_height: height,
            state: "pending",
            unreferenced_since: null,
          }))
          .sort((left, right) =>
            String(left.source_sha256) < String(right.source_sha256) ? -1 : 1,
          ),
      );
      const jobs = async () =>
        (
          await pool.query<{ subject_id: string; state: string }>(
            "SELECT subject_id, state FROM community.publishing_jobs WHERE kind='catalog_render' AND subject_id=ANY($1::text[]) ORDER BY created_at, subject_id",
            [ids],
          )
        ).rows;
      expect((await jobs()).map((job) => job.state)).toEqual([
        "queued",
        "queued",
        "queued",
      ]);
      // Idempotent: nothing new while the jobs are queued.
      expect(await sync([a, b, c])).toEqual({
        referenced: 3,
        skipped: 0,
        created: 0,
        unreferenced: 0,
        enqueued: 0,
      });

      expect(await adapter.readCatalogRenderPlan(idOf(a))).toEqual({
        assetId: idOf(a),
        mediaId: a.mediaId,
        sourceObjectKey: a.objectKey,
        sourceSha256: shaA,
        sourceContentType: "image/webp",
        sourceWidth: 3000,
        sourceHeight: 2000,
        state: "pending",
        referenced: true,
        ready: [],
      });
      expect(await adapter.readCatalogRenderPlan(idOf(c))).toMatchObject({
        sourceSha256: shaC,
        sourceContentType: "image/jpeg",
        sourceWidth: null,
      });

      const outcome = (sha: string) => ({
        masterSha256: sha,
        masterWidth: 3000,
        masterHeight: 2000,
        placeholderColor: "#112233",
        renditions: (["thumb", "cover", "display", "viewer"] as const).map(
          (role) => ({
            ...written(500),
            role,
            recipeVersion: identity(role).version,
            recipeDigest: identity(role).digest,
            contentType: "image/webp" as const,
            width: 480,
            height: 320,
          }),
        ),
      });
      const rendered = outcome(shaA);
      expect(
        await adapter.recordCatalogRenditions(idOf(a), rendered, t0),
      ).toEqual({ status: "recorded" });
      expect(
        await adapter.recordCatalogRenditions(idOf(a), rendered, t0),
      ).toEqual({ status: "recorded" });
      await expect(
        adapter.recordCatalogRenditions(idOf(a), outcome(shaB), t0),
      ).rejects.toBeInstanceOf(TypeError);
      expect(
        (
          await pool.query(
            "SELECT state, master_sha256, master_width, master_height, placeholder_color FROM community.catalog_media_assets WHERE id=$1",
            [idOf(a)],
          )
        ).rows,
      ).toEqual([
        {
          state: "ready",
          master_sha256: shaA,
          master_width: 3000,
          master_height: 2000,
          placeholder_color: "#112233",
        },
      ]);
      const catalogBlobs = (
        await pool.query<{
          id: string;
          owner_id: string | null;
          purpose: string;
          role: string;
          edit_key: string;
        }>(
          `SELECT b.id, b.owner_id, b.purpose, r.role, r.edit_key
           FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id
           WHERE r.catalog_asset_id=$1 AND r.state='ready' ORDER BY r.role`,
          [idOf(a)],
        )
      ).rows;
      expect(
        catalogBlobs.map((row) => [
          row.owner_id,
          row.purpose,
          row.role,
          row.edit_key,
        ]),
      ).toEqual(
        ["cover", "display", "thumb", "viewer"].map((role) => [
          null,
          "catalog_derivative",
          role,
          "base",
        ]),
      );
      expect(await adapter.readCatalogRenderPlan(idOf(a))).toMatchObject({
        state: "ready",
        ready: ["cover", "display", "thumb", "viewer"].map((role) => ({
          role,
          version: 1,
          digest: RECIPE_DIGESTS_V1[role as CatalogRenditionRole],
          width: 480,
          height: 320,
        })),
      });

      // A content rejection fails only a pending asset.
      await adapter.failCatalogAsset(idOf(b), "source_unreadable", t0);
      await adapter.failCatalogAsset(idOf(a), "source_unreadable", t0);
      expect(
        (
          await pool.query(
            "SELECT id, state, failure_code FROM community.catalog_media_assets WHERE id=ANY($1::text[]) ORDER BY state",
            [[idOf(a), idOf(b)]],
          )
        ).rows,
      ).toEqual([
        { id: idOf(b), state: "failed", failure_code: "source_unreadable" },
        { id: idOf(a), state: "ready", failure_code: null },
      ]);
      expect(await adapter.readCatalogRenderPlan(idOf(b))).toBeNull();
      const late = outcome(shaB);
      expect(await adapter.recordCatalogRenditions(idOf(b), late, t0)).toEqual({
        status: "discarded",
        storageKeys: late.renditions.map((entry) => entry.storageKey),
      });

      // Unreferenced while the published list no longer names it; revived
      // when it does again. A pending asset whose job ended is enqueued again.
      await pool.query(
        "UPDATE community.publishing_jobs SET state='succeeded', lease_expires_at=NULL, finished_at=$2 WHERE kind='catalog_render' AND subject_id=ANY($1::text[])",
        [ids, t0],
      );
      const later = new Date(t0.getTime() + HOUR);
      expect(await sync([b, c], later)).toEqual({
        referenced: 2,
        skipped: 0,
        created: 0,
        unreferenced: 1,
        enqueued: 1,
      });
      expect(await adapter.readCatalogRenderPlan(idOf(a))).toMatchObject({
        referenced: false,
      });
      expect(await sync([a, b, c], later)).toMatchObject({
        unreferenced: 0,
        enqueued: 0,
      });
      expect(await adapter.readCatalogRenderPlan(idOf(a))).toMatchObject({
        referenced: true,
      });
      // A new current recipe for a role renders a ready asset again.
      expect(
        await sync([a, b, c], later, [
          ...renditions.filter((entry) => entry.role !== "display"),
          { role: "display", version: 2, digest: "fedcba9876543210" },
        ]),
      ).toMatchObject({ enqueued: 1 });
      expect(
        (await jobs()).filter(
          (job) => job.subject_id === idOf(a) && job.state === "queued",
        ),
      ).toHaveLength(1);

      // Owner-less blobs count toward no capacity and stay in use.
      const owner = await createUser(pool);
      const item = await createItem(pool, owner);
      await adapter.recordDerivatives(
        item,
        {
          status: "derived",
          derivatives: [record("display", { byteSize: 1234 })],
        },
        t0,
      );
      expect((await adapter.reconcileCapacity(owner, t0)).committedBytes).toBe(
        1234,
      );
      await adapter.scheduleCleanup(new Date(t0.getTime() + 30 * DAY), 1000);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS jobs FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=ANY($1::text[])",
            [catalogBlobs.map((row) => row.id)],
          )
        ).rows,
      ).toEqual([{ jobs: 0 }]);
      const capacityRows = async () =>
        (
          await pool.query(
            "SELECT account_id, committed_bytes FROM community.account_publishing_capacity ORDER BY account_id",
          )
        ).rows;
      const capacityBefore = await capacityRows();
      await pool.query(
        "UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2 WHERE id=$1",
        [catalogBlobs[0]!.id, t0],
      );
      await adapter.confirmPurged([catalogBlobs[0]!.id], t0);
      expect(
        (
          await pool.query(
            "SELECT state FROM community.media_blobs WHERE id=$1",
            [catalogBlobs[0]!.id],
          )
        ).rows,
      ).toEqual([{ state: "purged" }]);
      expect(await capacityRows()).toEqual(capacityBefore);

      // A ready rendition whose blob is gone (for example purged by the
      // previous release after a rollback) counts as missing: the plan
      // omits it and the sync renders the asset again.
      expect(
        (await adapter.readCatalogRenderPlan(idOf(a)))?.ready.map(
          (entry) => entry.role,
        ),
      ).toEqual(["display", "thumb", "viewer"]);
      await pool.query(
        "UPDATE community.publishing_jobs SET state='succeeded', lease_expires_at=NULL, finished_at=$2 WHERE kind='catalog_render' AND subject_id=$1 AND state='queued'",
        [idOf(a), t0],
      );
      expect(await sync([a, b, c], later)).toMatchObject({ enqueued: 1 });
      expect(
        (await jobs()).filter(
          (job) => job.subject_id === idOf(a) && job.state === "queued",
        ),
      ).toHaveLength(1);

      // An unreadable source is tried again a day after it failed; any other
      // failure is a fact of the hash-pinned source bytes and stays final.
      const d: CatalogMediaSource = {
        mediaId: `media_${hex()}`,
        objectKey: catalogKey(sha256("d")),
        width: 10,
        height: 10,
      };
      expect(await sync([a, b, c, d], later)).toMatchObject({
        created: 1,
        enqueued: 1,
      });
      await pool.query(
        "UPDATE community.publishing_jobs SET state='succeeded', lease_expires_at=NULL, finished_at=$2 WHERE kind='catalog_render' AND subject_id=$1",
        [idOf(d), later],
      );
      await adapter.failCatalogAsset(idOf(d), "decode_failed", later);
      const states = async () =>
        (
          await pool.query(
            "SELECT id, state, failure_code FROM community.catalog_media_assets WHERE id=ANY($1::text[]) ORDER BY id",
            [[idOf(b), idOf(d)]],
          )
        ).rows;
      const failedStates = await states();
      // Not yet: b failed less than a day ago.
      expect(
        await sync([a, b, c, d], new Date(t0.getTime() + 23 * HOUR)),
      ).toMatchObject({ enqueued: 0 });
      expect(await states()).toEqual(failedStates);
      expect(
        await sync([a, b, c, d], new Date(t0.getTime() + 25 * HOUR)),
      ).toMatchObject({ enqueued: 1 });
      expect(await states()).toEqual(
        [
          { id: idOf(b), state: "pending", failure_code: null },
          { id: idOf(d), state: "failed", failure_code: "decode_failed" },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );
      expect(await adapter.readCatalogRenderPlan(idOf(b))).toMatchObject({
        state: "pending",
      });

      // Malformed input is refused before any statement.
      await expect(
        adapter.syncCatalogAssets([a], t0, { limit: 0, renditions }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        adapter.failCatalogAsset(idOf(c), "Source unreadable", t0),
      ).rejects.toBeInstanceOf(TypeError);
    },
    SLOW,
  );

  it(
    "retries a ready asset's rejected re-render a day later, not on every pass, and keeps its renditions",
    async () => {
      const asset = () => {
        const sha = sha256(hex());
        const source: CatalogMediaSource = {
          mediaId: `media_${hex()}`,
          objectKey: `display/v1/media_${hex()}/${sha}.webp`,
          width: 4000,
          height: 3000,
        };
        return {
          source,
          sha,
          id: `catalog-asset-${md5(`${source.mediaId}:${source.objectKey}`)}`,
        };
      };
      const [ready, second, pending, stopped] = [
        asset(),
        asset(),
        asset(),
        asset(),
      ];
      const sources = [ready, second, pending, stopped].map(
        (entry) => entry.source,
      );
      const v1 = (["thumb", "cover", "display"] as const).map(
        (role): CatalogRenditionIdentity => ({
          role,
          version: 1,
          digest: currentRecipe(role).digest,
        }),
      );
      // A newer display recipe that the ready assets do not hold yet.
      const v2: CatalogRenditionIdentity[] = [
        ...v1.filter((entry) => entry.role !== "display"),
        { role: "display", version: 2, digest: "fedcba9876543210" },
      ];
      const sync = (now: Date, wanted = v2, limit = 10) =>
        adapter.syncCatalogAssets(sources, now, { limit, renditions: wanted });
      const jobs = async (assetId: string) =>
        (
          await pool.query<{
            id: string;
            state: string;
            attempts: number;
            last_error_code: string | null;
            finished_at: Date | null;
          }>(
            `SELECT id, state, attempts, last_error_code, finished_at FROM community.publishing_jobs
             WHERE kind='catalog_render' AND subject_id=$1 ORDER BY created_at, id`,
            [assetId],
          )
        ).rows;
      /** The worker's path: claim the queued job, then record a final failure. */
      const fail = async (assetId: string, code: string, now: Date) => {
        const claimed = (
          await pool.query<{ id: string }>(
            `UPDATE community.publishing_jobs
             SET state='running', attempts=attempts+1, lease_owner='synthetic-worker',
                 lease_expires_at=$2::timestamptz + interval '5 minutes', updated_at=$2::timestamptz
             WHERE kind='catalog_render' AND subject_id=$1 AND state='queued'
             RETURNING id`,
            [assetId, now],
          )
        ).rows;
        expect(claimed).toHaveLength(1);
        expect(
          await adapter.failJob(
            { id: claimed[0]!.id, leaseOwner: "synthetic-worker" },
            code,
            now,
            { retryable: false },
          ),
        ).toBe("failed");
        return claimed[0]!.id;
      };
      const complete = (assetId: string, now: Date) =>
        pool.query(
          `UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2::timestamptz, updated_at=$2::timestamptz
           WHERE kind='catalog_render' AND subject_id=$1 AND state='queued'`,
          [assetId, now],
        );

      expect(await sync(t0, v1)).toMatchObject({ created: 4, enqueued: 4 });
      // Three assets become ready with version 1 renditions; one stays
      // pending with a failed job, which waits for the operator as before.
      for (const entry of [ready, second, stopped]) {
        await complete(entry.id, t0);
        expect(
          await adapter.recordCatalogRenditions(
            entry.id,
            {
              masterSha256: entry.sha,
              masterWidth: 4000,
              masterHeight: 3000,
              placeholderColor: null,
              renditions: (
                ["thumb", "cover", "display", "viewer"] as const
              ).map((role) => ({
                ...written(500),
                role,
                recipeVersion: 1,
                recipeDigest: currentRecipe(role).digest,
                contentType: "image/webp" as const,
                width: 480,
                height: 360,
              })),
            },
            t0,
          ),
        ).toEqual({ status: "recorded" });
      }
      await fail(pending.id, "processing_unavailable", t0);

      // The new display recipe renders the ready assets again; the worker
      // records a rejected re-render as the job's failure (code and time).
      const t1 = new Date(t0.getTime() + HOUR);
      expect(await sync(t1)).toMatchObject({ enqueued: 3 });
      const rejected = await fail(ready.id, "decode_failed", t1);
      await fail(second.id, "source_unreadable", t1);
      await fail(stopped.id, "decode_failed", t1);
      // The operator stops one of them.
      await pool.query(
        "UPDATE community.publishing_jobs SET state='abandoned' WHERE kind='catalog_render' AND subject_id=$1 AND state='failed'",
        [stopped.id],
      );
      expect(await jobs(ready.id)).toEqual([
        expect.objectContaining({ state: "succeeded" }),
        {
          id: rejected,
          state: "failed",
          attempts: 1,
          last_error_code: "decode_failed",
          finished_at: t1,
        },
      ]);
      // The asset keeps its state and its usable version 1 renditions.
      expect(
        (
          await pool.query(
            "SELECT state, failure_code FROM community.catalog_media_assets WHERE id=$1",
            [ready.id],
          )
        ).rows,
      ).toEqual([{ state: "ready", failure_code: null }]);
      expect(await adapter.readCatalogRenderPlan(ready.id)).toMatchObject({
        state: "ready",
        ready: ["cover", "display", "thumb", "viewer"].map((role) => ({
          role,
          version: 1,
        })),
      });

      // No new job on any pass within the day, however often the sync runs.
      for (const minutes of [5, 10, 60, 23 * 60]) {
        expect(
          await sync(new Date(t1.getTime() + minutes * 60_000)),
        ).toMatchObject({ enqueued: 0 });
      }
      expect((await jobs(ready.id)).map((job) => job.state)).toEqual([
        "succeeded",
        "failed",
      ]);
      // Nothing is retried while the asset misses no listed identity.
      const t2 = new Date(t1.getTime() + 25 * HOUR);
      expect(await sync(t2, v1)).toMatchObject({ enqueued: 0 });
      // After the day: the failed job is queued again with fresh attempts,
      // one per pass within the bound; abandoned jobs and a pending asset's
      // failed job still wait for the operator.
      expect(await sync(t2, v2, 1)).toMatchObject({ enqueued: 1 });
      expect(await sync(t2, v2, 1)).toMatchObject({ enqueued: 1 });
      expect(await sync(t2)).toMatchObject({ enqueued: 0 });
      for (const entry of [ready, second])
        expect((await jobs(entry.id)).at(-1)).toMatchObject({
          state: "queued",
          attempts: 0,
          last_error_code: null,
          finished_at: null,
        });
      expect((await jobs(ready.id)).map((job) => job.id)).toContain(rejected);
      expect((await jobs(ready.id)).length).toBe(2);
      expect((await jobs(stopped.id)).map((job) => job.state)).toEqual([
        "succeeded",
        "abandoned",
      ]);
      expect((await jobs(pending.id)).map((job) => job.state)).toEqual([
        "failed",
      ]);

      // Rejected again: again a day of quiet before the next try.
      await fail(ready.id, "decode_failed", t2);
      expect(await sync(new Date(t2.getTime() + 23 * HOUR))).toMatchObject({
        enqueued: 0,
      });
      expect(await sync(new Date(t2.getTime() + 25 * HOUR))).toMatchObject({
        enqueued: 1,
      });
      expect((await jobs(ready.id)).map((job) => job.state)).toEqual([
        "succeeded",
        "queued",
      ]);
    },
    SLOW,
  );

  it(
    "holds pre-task bytes a task-initiated replacement frees and keeps the user lifecycle as today",
    async () => {
      // Owner answer Q4 (2026-10-04): user-initiated deletion is unchanged.
      expect(USER_PURGE_HOLDS_PRE_TASK_BLOBS).toBe(false);
      const owner = await createUser(pool);
      const preTask = new Date(appliedAt.getTime() - 14 * DAY);
      const postTask = new Date(appliedAt.getTime() + DAY);
      const sweep = new Date(appliedAt.getTime() + 10 * DAY);

      /** An item whose display is replaced by recipe version 2, through the recording rule only. */
      const replaced = async (createdAt: Date) => {
        const item = await createItem(pool, owner);
        const blob = await createBlob(pool, owner, createdAt);
        await insertRendition(pool, item, "display", blob.id, createdAt);
        expect(
          await adapter.recordDerivatives(
            item,
            {
              status: "derived",
              derivatives: [
                record("display", {
                  recipeVersion: 2,
                  recipeDigest: "0123456789abcdef",
                }),
              ],
            },
            createdAt,
          ),
        ).toEqual({ status: "recorded" });
        return { item, blob };
      };
      const held = await replaced(preTask);
      const fresh = await replaced(postTask);
      const blobState = async (id: string) =>
        (
          await pool.query<{ state: string; retention_hold: string | null }>(
            "SELECT state, retention_hold FROM community.media_blobs WHERE id=$1",
            [id],
          )
        ).rows[0];
      const renditionState = async (blobId: string) =>
        (
          await pool.query(
            "SELECT state, superseded_at IS NOT NULL AS superseded, released_at IS NOT NULL AS released FROM community.media_renditions WHERE blob_id=$1",
            [blobId],
          )
        ).rows[0];
      const purgeJobs = async (id: string) =>
        (
          await pool.query<{ state: string }>(
            "SELECT state FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=$1",
            [id],
          )
        ).rows;
      // Pre-task: the replaced row stays superseded and its blob is held at
      // once, before any cleanup pass.
      expect(await renditionState(held.blob.id)).toEqual({
        state: "superseded",
        superseded: true,
        released: false,
      });
      expect(await blobState(held.blob.id)).toEqual({
        state: "committed",
        retention_hold: "d7_pre_task",
      });
      // Task-created: the replaced row is released (superseded_at kept) and
      // its blob follows the existing purge.
      expect(await renditionState(fresh.blob.id)).toEqual({
        state: "released",
        superseded: true,
        released: true,
      });
      expect(await blobState(fresh.blob.id)).toEqual({
        state: "committed",
        retention_hold: null,
      });
      await adapter.scheduleCleanup(sweep, 1000);
      // Held: never scheduled, never tombstoned by the blob purge.
      expect(await purgeJobs(held.blob.id)).toEqual([]);
      expect(await adapter.purgeBlob(held.blob.id, sweep)).toEqual({
        status: "referenced",
      });
      expect(await blobState(held.blob.id)).toEqual({
        state: "committed",
        retention_hold: "d7_pre_task",
      });
      expect(await purgeJobs(fresh.blob.id)).toEqual([{ state: "queued" }]);
      expect(await adapter.purgeBlob(fresh.blob.id, sweep)).toEqual({
        status: "tombstoned",
        blobs: [{ blobId: fresh.blob.id, storageKey: fresh.blob.storageKey }],
      });

      // The item's own purge is its author's lifecycle (Q4): the held blob
      // goes with the item exactly as before this task.
      await pool.query(
        "UPDATE community.media_items SET state='cancelled', cancelled_at=$2 WHERE id=$1",
        [held.item, sweep],
      );
      const heldPurge = await adapter.purgeItem(held.item, sweep);
      expect(heldPurge.status).toBe("tombstoned");
      expect(
        heldPurge.status === "tombstoned"
          ? heldPurge.blobs.map((entry) => entry.blobId)
          : [],
      ).toContain(held.blob.id);
      expect(await blobState(held.blob.id)).toEqual({
        state: "tombstoned",
        retention_hold: null,
      });

      // User-initiated purge of pre-task media works exactly as today: every
      // component and rendition blob of the item, including the superseded
      // one this task held when it recorded version 2.
      const userItem = await createItem(pool, owner);
      const adopted = await createBlob(pool, owner, preTask);
      await insertRendition(pool, userItem, "thumb", adopted.id, preTask);
      await adapter.recordDerivatives(
        userItem,
        {
          status: "derived",
          derivatives: [
            record("thumb", {
              recipeVersion: 2,
              recipeDigest: "0123456789abcdef",
            }),
          ],
        },
        preTask,
      );
      await pool.query(
        "UPDATE community.media_items SET state='cancelled', cancelled_at=$2 WHERE id=$1",
        [userItem, sweep],
      );
      const userPurge = await adapter.purgeItem(userItem, sweep);
      expect(userPurge.status).toBe("tombstoned");
      expect(
        userPurge.status === "tombstoned"
          ? userPurge.blobs.map((entry) => entry.blobId)
          : [],
      ).toContain(adopted.id);
      expect(
        (
          await pool.query(
            "SELECT b.state, b.retention_hold FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id WHERE r.item_id=$1",
            [userItem],
          )
        ).rows,
      ).toEqual([
        { state: "tombstoned", retention_hold: null },
        { state: "tombstoned", retention_hold: null },
      ]);
    },
    SLOW,
  );
});
