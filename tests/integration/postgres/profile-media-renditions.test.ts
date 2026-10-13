import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentRecipe } from "@moya/backend-production/internal/publishing-processing";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CommunityMigrationStateError,
  PROFILE_RENDITION_ROLES,
  PostgresWorkPublishingAdapter,
  RENDITION_ROLES,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { PublishingDerivativeRecord } from "@moya/api";

/*
 * profile-media-renditions-v1 (unified-media-pipeline increment 3a), part 1,
 * on dedicated synthetic databases: migration 20261014010000 as an upgrade
 * from the previous head (existing rows unchanged, a bounded wait for its
 * locks, all or nothing), the CHECK and unique-index accept/refuse matrix of
 * profile rows, the job kind and role lists, profile rows outside every
 * publication path, owner-less profile blobs in use until released and
 * outside every capacity, and the store's recording rule for the profile
 * subject. Profile renditions are never created on the shared database.
 */

type Pool = ReturnType<typeof createPostgresPool>;
const connect = (pool: Pool) => pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;

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

/** Store internals with no port yet: the recording rule and the publication eligibility fragment. */
type RecordSubject =
  | { readonly kind: "item"; readonly id: string; readonly ownerId: string }
  | { readonly kind: "catalog"; readonly id: string }
  | { readonly kind: "profile"; readonly id: string };
interface RecordInput {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly role: string;
  readonly editKey: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
}
const { recordRenditionRows } = (await import(
  new URL(
    "../../../services/community-postgres/src/publishing/renditions.ts",
    import.meta.url,
  ).href
)) as {
  readonly recordRenditionRows: (
    db: Client,
    subject: RecordSubject,
    records: readonly RecordInput[],
    now: Date,
  ) => Promise<{ recordedBytes: number; duplicates: string[] }>;
};
const { desiredRenditionsSql } = (await import(
  new URL(
    "../../../services/community-postgres/src/publishing/publication-eligibility.ts",
    import.meta.url,
  ).href
)) as { readonly desiredRenditionsSql: (catalogAvailable?: boolean) => string };

const endpoint = new URL(testDatabaseUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search !== "" ||
  endpoint.hash !== ""
)
  throw new Error(
    "Profile media rendition tests require a loopback TEST_DATABASE_URL without query overrides or fragments",
  );

const PROFILE_MIGRATION = "20261014010000";
const PREVIOUS_MIGRATION = "20261008010000";
const SLOW = 60_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = new Date("2026-09-20T12:00:00.000Z");

const hex = () => randomBytes(16).toString("hex");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const sha256 = (value: string | Uint8Array) =>
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
  /^pmr_(?:upgrade|shared)_[0-9a-f]{12}_synthetic_test$/;
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
  const name = `pmr_${kind}_${randomBytes(6).toString("hex")}_synthetic_test`;
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
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'头像测试')",
    [id, `pmr-${id.slice(-20)}`],
  );
  return id;
};

/** A stored profile PNG row (the bytes are opaque to these cases). */
const createUserMedia = async (pool: Pool, owner: string): Promise<string> => {
  const id = opaque("user-media");
  const bytes = randomBytes(64);
  await pool.query(
    "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes,created_at) VALUES($1,$2,'image/png',512,512,$3,$4,$5)",
    [id, owner, sha256(bytes), bytes, t0],
  );
  return id;
};

const createItem = async (pool: Pool, owner: string): Promise<string> => {
  const id = opaque("media-item");
  await pool.query(
    `INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,created_at,updated_at)
     VALUES($1,$2,'static','standard','upload','ready','{"width":4000,"height":3000}'::jsonb,$3,$3)`,
    [id, owner, t0],
  );
  return id;
};

const createCatalogAsset = async (pool: Pool): Promise<string> => {
  const mediaId = `media_${hex()}`;
  const objectKey = `display/v1/media_${hex()}/${sha256(hex())}.webp`;
  const id = `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`).digest("hex")}`;
  await pool.query(
    "INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",
    [id, mediaId, objectKey, t0],
  );
  return id;
};

interface Blob {
  readonly id: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
}

const createBlob = async (
  pool: Pool,
  owner: string | null,
  purpose: string,
  createdAt = t0,
): Promise<Blob> => {
  const id = opaque("media-blob");
  const blob = written();
  await pool.query(
    `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/webp','committed',$7)`,
    [
      id,
      owner,
      purpose,
      blob.storageKey,
      blob.byteSize,
      blob.sha256,
      createdAt,
    ],
  );
  return { id, ...blob };
};

type SubjectColumn = "item_id" | "catalog_asset_id" | "user_media_id";

/** One rendition row; every column is overridable to probe a constraint. */
const insertRendition = async (
  pool: Pool,
  subjects: Partial<Record<SubjectColumn, string>>,
  role: string,
  blobId: string,
  extra: {
    readonly editKey?: string;
    readonly contentType?: string;
    readonly durationMs?: number | null;
    readonly state?: "ready" | "released";
    readonly createdAt?: Date;
  } = {},
): Promise<string> => {
  const id = opaque("media-rendition");
  const digest = (RENDITION_ROLES as readonly string[]).includes(role)
    ? currentRecipe(role as (typeof RENDITION_ROLES)[number]).digest
    : "0123456789abcdef";
  // Only the named subject columns: user_media_id exists after the migration.
  const columns = Object.keys(subjects) as SubjectColumn[];
  await pool.query(
    `INSERT INTO community.media_renditions(id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,duration_ms,content_type,state,created_at,released_at${columns.map((column) => `,${column}`).join("")})
     VALUES($1,$2,$3,1,$4,$5,128,128,$6,$7,$8,$9,CASE WHEN $8='released' THEN $9::timestamptz END${columns.map((_, index) => `,$${index + 10}`).join("")})`,
    [
      id,
      extra.editKey ?? "base",
      role,
      digest,
      blobId,
      extra.durationMs ?? null,
      extra.contentType ?? "image/webp",
      extra.state ?? "ready",
      extra.createdAt ?? t0,
      ...columns.map((column) => subjects[column]),
    ],
  );
  return id;
};

/** Each table's rows as JSON, in id order: the upgrade must leave them unchanged. */
const snapshot = async (pool: Pool) => {
  const rows = async (table: string, key = "id") =>
    (
      await pool.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row FROM community.${table} t ORDER BY ${key}`,
      )
    ).rows.map(({ row }) => row);
  return {
    users: await rows("public_users"),
    userMedia: await rows("user_media"),
    items: await rows("media_items"),
    assets: await rows("catalog_media_assets"),
    blobs: await rows("media_blobs"),
    renditions: await rows("media_renditions"),
    jobs: await rows("publishing_jobs"),
  };
};

describe("profile media renditions migration on a dedicated synthetic database", () => {
  it(
    "upgrades from the previous head within a bounded lock wait and keeps every row",
    async () => {
      const pool = await createDedicatedDatabase("upgrade");
      expect(
        (
          await runCommunityMigrations(pool, migrationsDirectory, {
            through: PREVIOUS_MIGRATION,
          })
        ).at(-1),
      ).toBe(PREVIOUS_MIGRATION);
      const owner = await createUser(pool);
      const avatar = await createUserMedia(pool, owner);
      const background = await createUserMedia(pool, owner);
      await pool.query(
        "UPDATE community.public_users SET avatar_media_id=$2, avatar_changed_on='2026-09-20', background_media_id=$3 WHERE id=$1",
        [owner, avatar, background],
      );
      const item = await createItem(pool, owner);
      const itemBlob = await createBlob(pool, owner, "derivative");
      await insertRendition(pool, { item_id: item }, "thumb", itemBlob.id);
      const asset = await createCatalogAsset(pool);
      const catalogBlob = await createBlob(pool, null, "catalog_derivative");
      await insertRendition(
        pool,
        { catalog_asset_id: asset },
        "display",
        catalogBlob.id,
      );
      await pool.query(
        `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,last_error_code,created_at,updated_at,finished_at)
         VALUES($1,'process_item',$2,'queued',0,$4,NULL,$4,$4,NULL),
               ($3,'catalog_render',$5,'failed',5,$4,'processing_unavailable',$4,$4,$4)`,
        [opaque("publishing-job"), item, opaque("publishing-job"), t0, asset],
      );
      const before = await snapshot(pool);

      // A writer still running holds the upgrade off: it waits at most five
      // seconds for its first lock, then nothing of it remains.
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          "LOCK TABLE community.user_media IN ROW EXCLUSIVE MODE",
        );
        const started = Date.now();
        const failure = await runCommunityMigrations(
          pool,
          migrationsDirectory,
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CommunityMigrationStateError);
        expect((failure as { cause?: { code?: string } }).cause?.code).toBe(
          "55P03",
        );
        expect(Date.now() - started).toBeLessThan(30_000);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      expect(
        (
          await pool.query<{ column: string | null; applied: string }>(
            `SELECT (SELECT column_name::text FROM information_schema.columns
                 WHERE table_schema='community' AND table_name='media_renditions' AND column_name='user_media_id') AS column,
               (SELECT count(*)::text FROM community.schema_migrations WHERE migration_id=$1) AS applied`,
            [PROFILE_MIGRATION],
          )
        ).rows,
      ).toEqual([{ column: null, applied: "0" }]);
      expect(await snapshot(pool)).toEqual(before);

      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual([
        PROFILE_MIGRATION,
      ]);
      await verifyCommunityMigrationLedger(pool);
      const after = await snapshot(pool);
      expect(after.renditions.map((row) => row.user_media_id)).toEqual([
        null,
        null,
      ]);
      expect({
        ...after,
        renditions: after.renditions.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "user_media_id"),
          ),
        ),
      }).toEqual(before);
      // The previous release's readers still serve the item rendition.
      expect(
        await new PostgresWorkPublishingAdapter(pool).resolveMediaRead(
          owner,
          item,
          "thumb",
          "base",
        ),
      ).toMatchObject({ storageKey: itemBlob.storageKey });

      // Re-running applies nothing.
      expect(await runCommunityMigrations(pool, migrationsDirectory)).toEqual(
        [],
      );
    },
    SLOW,
  );
});

describe("profile renditions on a dedicated synthetic database", () => {
  let pool: Pool;
  let adapter: PostgresWorkPublishingAdapter;
  /** Profile renditions exist only after the migration. */
  let appliedAt: Date;

  beforeAll(async () => {
    pool = await createDedicatedDatabase("shared");
    await runCommunityMigrations(pool, migrationsDirectory);
    adapter = new PostgresWorkPublishingAdapter(pool);
    appliedAt = (
      await pool.query<{ applied_at: Date }>(
        "SELECT applied_at FROM community.schema_migrations WHERE migration_id=$1",
        [PROFILE_MIGRATION],
      )
    ).rows[0]!.applied_at;
  }, SLOW);

  const constraintLiterals = async (
    table: string,
    name: string,
  ): Promise<string[]> => {
    const definition = (
      await pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=$2 AND conrelid=$1::regclass",
        [`community.${table}`, name],
      )
    ).rows[0]!.definition;
    return [...definition.matchAll(/'([a-z0-9_-]+)'::text/gu)].map(
      (match) => match[1]!,
    );
  };

  it("keeps the job kind and role CHECKs equal to the TypeScript lists", async () => {
    expect(
      await constraintLiterals("publishing_jobs", "publishing_jobs_kind_valid"),
    ).toEqual(publishingJobKindSchema.options);
    expect(
      await constraintLiterals(
        "media_renditions",
        "media_renditions_role_valid",
      ),
    ).toEqual([...RENDITION_ROLES]);
    expect(
      await constraintLiterals(
        "media_renditions",
        "media_renditions_profile_roles",
      ),
    ).toEqual([...PROFILE_RENDITION_ROLES]);
    expect(
      await constraintLiterals("media_blobs", "media_blobs_purpose_valid"),
    ).toContain("profile_derivative");
    // The new kind is accepted as a job row.
    const owner = await createUser(pool);
    const media = await createUserMedia(pool, owner);
    await pool.query(
      "INSERT INTO community.publishing_jobs(id,kind,subject_id) VALUES($1,'profile_render',$2)",
      [opaque("publishing-job"), media],
    );
    await expect(
      pool.query(
        "INSERT INTO community.publishing_jobs(id,kind,subject_id) VALUES($1,'avatar_render',$2)",
        [opaque("publishing-job"), media],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "publishing_jobs_kind_valid",
    });
  });

  it("accepts owner-less profile blobs only", async () => {
    const owner = await createUser(pool);
    await expect(
      createBlob(pool, null, "profile_derivative"),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(
      createBlob(pool, null, "catalog_derivative"),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(createBlob(pool, owner, "derivative")).resolves.toMatchObject({
      id: expect.any(String),
    });
    for (const [blobOwner, purpose] of [
      [owner, "profile_derivative"],
      [owner, "catalog_derivative"],
      [null, "derivative"],
      [null, "original"],
    ] as const)
      await expect(
        createBlob(pool, blobOwner, purpose),
        purpose,
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "media_blobs_owner_matches_purpose",
      });
    await expect(
      createBlob(pool, owner, "avatar_derivative"),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "media_blobs_purpose_valid",
    });
  });

  it(
    "accepts unedited WebP profile renditions in profile roles only, one ready per role",
    async () => {
      const owner = await createUser(pool);
      const media = await createUserMedia(pool, owner);
      const item = await createItem(pool, owner);
      const asset = await createCatalogAsset(pool);
      const profileBlob = () => createBlob(pool, null, "profile_derivative");

      // One image may be both the avatar and the background: every profile
      // role on one row id.
      const ready: Record<string, string> = {};
      for (const role of PROFILE_RENDITION_ROLES)
        ready[role] = await insertRendition(
          pool,
          { user_media_id: media },
          role,
          (await profileBlob()).id,
        );

      const refused = async (
        subjects: Partial<Record<SubjectColumn, string>>,
        role: string,
        constraint: string,
        extra: Parameters<typeof insertRendition>[4] = {},
      ) =>
        expect(
          insertRendition(
            pool,
            subjects,
            role,
            (await profileBlob()).id,
            extra,
          ),
          `${role} ${constraint}`,
        ).rejects.toMatchObject({ code: "23514", constraint });
      // Profile roles belong to profile images, and profile images to them.
      for (const role of ["thumb", "cover", "display", "viewer", "full"])
        await refused(
          { user_media_id: media },
          role,
          "media_renditions_profile_roles",
        );
      await refused(
        { item_id: item },
        "avatar-128",
        "media_renditions_profile_roles",
      );
      await refused(
        { catalog_asset_id: asset },
        "background-960",
        "media_renditions_profile_roles",
      );
      await refused(
        { item_id: item },
        "avatar-64",
        "media_renditions_role_valid",
      );
      // Profile renditions are unedited WebP stills.
      await refused(
        { user_media_id: media },
        "avatar-512",
        "media_renditions_profile_unedited_webp",
        { editKey: "0123456789abcdef0123456789abcdef" },
      );
      await refused(
        { user_media_id: media },
        "avatar-512",
        "media_renditions_profile_unedited_webp",
        { contentType: "image/jpeg" },
      );
      await refused(
        { user_media_id: media },
        "background-1600",
        "media_renditions_profile_unedited_webp",
        { durationMs: 1000 },
      );
      // Exactly one subject.
      await refused(
        { item_id: item, user_media_id: media },
        "avatar-128",
        "media_renditions_one_subject",
      );
      await refused(
        { catalog_asset_id: asset, user_media_id: media },
        "avatar-128",
        "media_renditions_one_subject",
      );
      await refused({}, "avatar-128", "media_renditions_one_subject");
      await expect(
        insertRendition(
          pool,
          { user_media_id: opaque("user-media") },
          "avatar-128",
          (await profileBlob()).id,
        ),
      ).rejects.toMatchObject({ code: "23503" });

      // One ready row per image and role; released rows do not count.
      await expect(
        insertRendition(
          pool,
          { user_media_id: media },
          "avatar-128",
          (await profileBlob()).id,
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "media_renditions_profile_ready_unique",
      });
      await insertRendition(
        pool,
        { user_media_id: media },
        "avatar-128",
        (await profileBlob()).id,
        { state: "released" },
      );
      await pool.query(
        "UPDATE community.media_renditions SET state='released', released_at=$2 WHERE id=$1",
        [ready["avatar-128"], t0],
      );
      await insertRendition(
        pool,
        { user_media_id: media },
        "avatar-128",
        (await profileBlob()).id,
      );
      // Another image has slots of its own.
      await insertRendition(
        pool,
        { user_media_id: await createUserMedia(pool, owner) },
        "avatar-128",
        (await profileBlob()).id,
      );
      expect(
        (
          await pool.query<{ role: string; state: string }>(
            "SELECT role, state FROM community.media_renditions WHERE user_media_id=$1 ORDER BY role, state",
            [media],
          )
        ).rows,
      ).toEqual([
        { role: "avatar-128", state: "ready" },
        { role: "avatar-128", state: "released" },
        { role: "avatar-128", state: "released" },
        { role: "avatar-512", state: "ready" },
        { role: "background-1600", state: "ready" },
        { role: "background-960", state: "ready" },
      ]);
    },
    SLOW,
  );

  it("never publishes or delivers a profile rendition", async () => {
    const owner = await createUser(pool);
    const media = await createUserMedia(pool, owner);
    const blob = await createBlob(pool, null, "profile_derivative");
    const rendition = await insertRendition(
      pool,
      { user_media_id: media },
      "avatar-128",
      blob.id,
    );
    // A public asset names an item or a Catalog asset, never a profile image:
    // the insert trigger refuses a profile rendition under either.
    const item = await createItem(pool, owner);
    const asset = hex();
    await pool.query(
      "INSERT INTO community.media_public_assets(id,item_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [asset, item, t0],
    );
    for (const purpose of ["derivative", "profile_derivative"]) {
      const generation = hex();
      await expect(
        pool.query(
          `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,created_at)
           VALUES($1,$2,$3,$4,$5,$6,'image/webp',$7,$8,$9,'avatar-128','base',$10)`,
          [
            opaque("media-publication"),
            asset,
            rendition,
            generation,
            `v1/${asset}/${generation}/base/avatar-128.r1.webp`,
            blob.storageKey,
            purpose,
            blob.byteSize,
            blob.sha256,
            t0,
          ],
        ),
        purpose,
      ).rejects.toMatchObject({
        code: "23000",
        message: "Only ready rendition bytes may be published",
      });
    }
    // The desired publication set and the Catalog delivery view never list it.
    expect(
      (
        await pool.query(
          `SELECT d.rendition_id FROM (${desiredRenditionsSql(false)}) d WHERE d.rendition_id=$1`,
          [rendition],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT delivery_key FROM community.catalog_media_delivery WHERE delivery_key=$1",
          [rendition],
        )
      ).rows,
    ).toEqual([]);
  });

  it(
    "records owner-less profile renditions with the one recording rule and refuses other shapes",
    async () => {
      const owner = await createUser(pool);
      const media = await createUserMedia(pool, owner);
      const item = await createItem(pool, owner);
      const asset = await createCatalogAsset(pool);
      const at = new Date(appliedAt.getTime() + 60_000);
      const profileRecord = (
        role: (typeof PROFILE_RENDITION_ROLES)[number],
        extra: Partial<RecordInput> = {},
      ): RecordInput => ({
        ...written(),
        role,
        editKey: "base",
        contentType: "image/webp",
        width: role === "avatar-128" ? 128 : 512,
        height: role === "avatar-128" ? 128 : 512,
        durationMs: null,
        recipeVersion: currentRecipe(role).version,
        recipeDigest: currentRecipe(role).digest,
        ...extra,
      });
      const transaction = async <T>(
        run: (db: Client) => Promise<T>,
      ): Promise<T> => {
        const db = await connect(pool);
        try {
          await db.query("BEGIN");
          const result = await run(db);
          await db.query("COMMIT");
          return result;
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
      };
      const record = (
        subject: RecordSubject,
        records: readonly RecordInput[],
      ) => transaction((db) => recordRenditionRows(db, subject, records, at));
      const profile = { kind: "profile", id: media } as const;
      const rows = async () =>
        (
          await pool.query<{
            id: string;
            role: string;
            state: string;
            item_id: string | null;
            catalog_asset_id: string | null;
            edit_key: string;
            content_type: string;
            recipe_version: number;
            superseded_at: Date | null;
            storage_key: string;
            owner_id: string | null;
            purpose: string;
            blob_state: string;
            retention_hold: string | null;
          }>(
            `SELECT r.id, r.role, r.state, r.item_id, r.catalog_asset_id, r.edit_key, r.content_type,
               r.recipe_version, r.superseded_at, b.storage_key, b.owner_id, b.purpose,
               b.state AS blob_state, b.retention_hold
             FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id
             WHERE r.user_media_id=$1 ORDER BY r.role, r.recipe_version`,
            [media],
          )
        ).rows;

      const family = [profileRecord("avatar-128"), profileRecord("avatar-512")];
      expect(await record(profile, family)).toEqual({
        recordedBytes: 0,
        duplicates: [],
      });
      const recorded = await rows();
      expect(recorded).toEqual(
        family.map((entry) => ({
          id: expect.stringMatching(/^media-rendition-[0-9a-f]{32}$/u),
          role: entry.role,
          state: "ready",
          item_id: null,
          catalog_asset_id: null,
          edit_key: "base",
          content_type: "image/webp",
          recipe_version: 1,
          superseded_at: null,
          storage_key: entry.storageKey,
          owner_id: null,
          purpose: "profile_derivative",
          blob_state: "committed",
          retention_hold: null,
        })),
      );

      // A replayed result is skipped; another result at the same version is
      // a duplicate whose key is returned for removal.
      expect(await record(profile, family)).toEqual({
        recordedBytes: 0,
        duplicates: [],
      });
      const again = profileRecord("avatar-128");
      expect(await record(profile, [again])).toEqual({
        recordedBytes: 0,
        duplicates: [again.storageKey],
      });
      expect(await rows()).toEqual(recorded);

      // A newer recipe version replaces the slot; this task's own bytes are
      // released at once (never held).
      const newer = profileRecord("avatar-128", {
        recipeVersion: 2,
        recipeDigest: "fedcba9876543210",
      });
      await record(profile, [newer]);
      expect(
        (await rows()).map(
          ({ role, state, recipe_version, superseded_at }) => ({
            role,
            state,
            recipe_version,
            superseded: superseded_at !== null,
          }),
        ),
      ).toEqual([
        {
          role: "avatar-128",
          state: "released",
          recipe_version: 1,
          superseded: true,
        },
        {
          role: "avatar-128",
          state: "ready",
          recipe_version: 2,
          superseded: false,
        },
        {
          role: "avatar-512",
          state: "ready",
          recipe_version: 1,
          superseded: false,
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS held FROM community.media_blobs WHERE retention_hold IS NOT NULL",
          )
        ).rows,
      ).toEqual([{ held: 0 }]);

      // Every other shape is refused before anything is written.
      const before = await pool.query(
        "SELECT count(*)::int AS blobs FROM community.media_blobs",
      );
      const refusals: [RecordSubject, RecordInput][] = [
        [
          profile,
          {
            ...profileRecord("avatar-128"),
            role: "thumb",
            recipeDigest: currentRecipe("thumb").digest,
          },
        ],
        [
          { kind: "item", id: item, ownerId: owner },
          profileRecord("avatar-128"),
        ],
        [{ kind: "catalog", id: asset }, profileRecord("background-960")],
        [
          profile,
          profileRecord("avatar-512", {
            editKey: "0123456789abcdef0123456789abcdef",
          }),
        ],
        [profile, profileRecord("avatar-512", { contentType: "video/mp4" })],
        [profile, profileRecord("avatar-512", { durationMs: 1000 })],
      ];
      for (const [subject, input] of refusals)
        await expect(
          record(subject, [input]),
          `${subject.kind} ${input.role}`,
        ).rejects.toBeInstanceOf(TypeError);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS blobs FROM community.media_blobs",
          )
        ).rows,
      ).toEqual(before.rows);
    },
    SLOW,
  );

  it(
    "keeps profile blobs in use until released and outside every capacity",
    async () => {
      const owner = await createUser(pool);
      const media = await createUserMedia(pool, owner);
      const created = new Date(appliedAt.getTime() + 60_000);
      const later = new Date(created.getTime() + 30 * DAY);
      const blob = await createBlob(pool, null, "profile_derivative", created);
      const rendition = await insertRendition(
        pool,
        { user_media_id: media },
        "avatar-128",
        blob.id,
        { createdAt: created },
      );
      // The owner's own publishing bytes, recorded for an item.
      const item = await createItem(pool, owner);
      await adapter.recordDerivatives(
        item,
        {
          status: "derived",
          derivatives: [
            {
              ...written(1234),
              variant: "display",
              editKey: "base",
              contentType: "image/webp",
              width: 2048,
              height: 1536,
              durationMs: null,
              recipeVersion: currentRecipe("display").version,
              recipeDigest: currentRecipe("display").digest,
            } satisfies PublishingDerivativeRecord,
          ],
        },
        created,
      );
      expect(
        (await adapter.reconcileCapacity(owner, later)).committedBytes,
      ).toBe(1234);

      // In use: no cleanup releases or schedules it, and a purge keeps it.
      await adapter.scheduleCleanup(later, 1000);
      const purgeJobs = async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS jobs FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=$1",
            [blob.id],
          )
        ).rows;
      expect(await purgeJobs()).toEqual([{ jobs: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT state FROM community.media_renditions WHERE id=$1",
            [rendition],
          )
        ).rows,
      ).toEqual([{ state: "ready" }]);
      expect(await adapter.purgeBlob(blob.id, later)).toEqual({
        status: "referenced",
      });

      // Released: the existing purge schedule removes it after the delay,
      // and no capacity changes.
      const capacityRows = async () =>
        (
          await pool.query(
            "SELECT account_id, committed_bytes FROM community.account_publishing_capacity ORDER BY account_id",
          )
        ).rows;
      const capacityBefore = await capacityRows();
      await pool.query(
        "UPDATE community.media_renditions SET state='released', released_at=$2 WHERE id=$1",
        [rendition, later],
      );
      await adapter.scheduleCleanup(later, 1000);
      expect(await purgeJobs()).toEqual([{ jobs: 1 }]);
      expect(await adapter.purgeBlob(blob.id, later)).toEqual({
        status: "tombstoned",
        blobs: [{ blobId: blob.id, storageKey: blob.storageKey }],
      });
      await adapter.confirmPurged([blob.id], later);
      expect(
        (
          await pool.query(
            "SELECT state, owner_id FROM community.media_blobs WHERE id=$1",
            [blob.id],
          )
        ).rows,
      ).toEqual([{ state: "purged", owner_id: null }]);
      expect(await capacityRows()).toEqual(capacityBefore);
      expect(
        (await adapter.reconcileCapacity(owner, later)).committedBytes,
      ).toBe(1234);
    },
    SLOW,
  );
});
