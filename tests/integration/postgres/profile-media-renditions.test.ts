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

import type {
  ProfileRenderOutcome,
  ProfileRenditionRecord,
  PublishingDerivativeRecord,
} from "@moya/api";

/*
 * profile-media-renditions-v1 (unified-media-pipeline increment 3a), on
 * dedicated synthetic databases.
 * Part 1: migration 20261014010000 as an upgrade from the previous head
 * (existing rows unchanged, a bounded wait for its locks, all or nothing),
 * the CHECK and unique-index accept/refuse matrix of profile rows, the job
 * kind and role lists, profile rows outside every publication path,
 * owner-less profile blobs in use until released and outside every
 * capacity, and the store's recording rule for the profile subject.
 * Part 2: the profile asset store: the render plan and source bytes,
 * recording a whole family (replay, discard, the race with erasure),
 * erasure releasing renditions for the purge schedule, the read
 * authorization matrix, and the store-wide paced sweep (pointer drive,
 * pacing, pauses, retry), each sweep case on a database of its own.
 * Profile renditions are never created on the shared database.
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
const { eraseUnreferencedLegacyMedia } = (await import(
  new URL(
    "../../../services/community-postgres/src/publishing/permanent-media.ts",
    import.meta.url,
  ).href
)) as {
  readonly eraseUnreferencedLegacyMedia: (
    db: Client,
    ownerId: string,
    itemIds: readonly string[],
    now: Date,
    legacyMediaIds?: readonly string[],
  ) => Promise<void>;
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

// Only these test-owned databases and roles are ever created or dropped.
const dedicatedDatabaseName =
  /^pmr_(?:upgrade|shared|assets|sweep)_[0-9a-f]{12}_synthetic_test$/;
const dedicatedRoleName = /^pmr_nobytes_[0-9a-f]{12}$/;
const administration = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: testDatabaseUrl }),
);
const created: string[] = [];
const createdRoles: string[] = [];
const pools: Pool[] = [];

const createDedicatedDatabase = async (
  kind: "upgrade" | "shared" | "assets" | "sweep",
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
  // Their only privileges were in the dropped databases.
  for (const role of createdRoles)
    if (dedicatedRoleName.test(role))
      await administration.query(`DROP ROLE IF EXISTS ${role}`);
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

// Part 2: the profile asset store.

type ProfileRole = (typeof PROFILE_RENDITION_ROLES)[number];

/** The current identity of both family anchors, as the worker passes it. */
const anchors = (["avatar-128", "background-960"] as const).map((role) => ({
  role,
  version: currentRecipe(role).version,
  digest: currentRecipe(role).digest,
}));

const migratedDatabase = async (kind: "assets" | "sweep"): Promise<Pool> => {
  const pool = await createDedicatedDatabase(kind);
  await runCommunityMigrations(pool, migrationsDirectory);
  return pool;
};

/** A time after the migrations: blobs written then are this task's own (never held). */
const afterMigrations = async (pool: Pool): Promise<Date> =>
  new Date(
    (
      await pool.query<{ applied_at: Date }>(
        "SELECT max(applied_at) AS applied_at FROM community.schema_migrations",
      )
    ).rows[0]!.applied_at.getTime() + 60_000,
  );

const inTransaction = async <T>(
  pool: Pool,
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

interface Image {
  readonly id: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** A stored profile PNG row with known bytes (opaque to the store). */
const createImage = async (
  pool: Pool,
  owner: string,
  width = 512,
  height = 512,
): Promise<Image> => {
  const id = opaque("user-media");
  const bytes = randomBytes(96);
  await pool.query(
    "INSERT INTO community.user_media(id,owner_id,mime_type,width,height,sha256,bytes,created_at) VALUES($1,$2,'image/png',$3,$4,$5,$6,$7)",
    [id, owner, width, height, sha256(bytes), bytes, t0],
  );
  return { id, bytes, sha256: sha256(bytes) };
};

const setProfile = (
  pool: Pool,
  owner: string,
  avatar: string | null,
  background: string | null,
) =>
  pool.query(
    "UPDATE community.public_users SET avatar_media_id=$2, background_media_id=$3 WHERE id=$1",
    [owner, avatar, background],
  );

const setStatus = (pool: Pool, user: string, status: "active" | "suspended") =>
  pool.query("UPDATE community.public_users SET status=$2 WHERE id=$1", [
    user,
    status,
  ]);

/** The erasure of an unreferenced profile image, as deleted content triggers it. */
const erase = (pool: Pool, owner: string, image: string, at: Date) =>
  inTransaction(pool, (db) =>
    eraseUnreferencedLegacyMedia(db, owner, [], at, [image]),
  );

const rendition = (
  role: ProfileRole,
  extra: Partial<ProfileRenditionRecord> = {},
): ProfileRenditionRecord => ({
  ...written(),
  role,
  recipeVersion: currentRecipe(role).version,
  recipeDigest: currentRecipe(role).digest,
  contentType: "image/webp",
  width: 128,
  height: 128,
  ...extra,
});

const outcomeOf = (
  sourceSha256: string,
  ...roles: ProfileRole[]
): ProfileRenderOutcome => ({
  sourceSha256,
  renditions: roles.map((role) => rendition(role)),
});

const keysOf = (outcome: ProfileRenderOutcome) =>
  outcome.renditions.map((record) => record.storageKey);

const renditionRows = async (pool: Pool, image: string) =>
  (
    await pool.query<{
      role: string;
      state: string;
      released_at: Date | null;
      owner_id: string | null;
      purpose: string;
      blob_id: string;
    }>(
      `SELECT r.role, r.state, r.released_at, b.owner_id, b.purpose, b.id AS blob_id
       FROM community.media_renditions r JOIN community.media_blobs b ON b.id=r.blob_id
       WHERE r.user_media_id=$1 ORDER BY r.role, r.created_at, r.id`,
      [image],
    )
  ).rows;

/** Waits until some statement of this database waits for a row lock. */
const lockWaiter = async (pool: Pool): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { waiting } = (
      await pool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )
    ).rows[0]!;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No statement waited for the lock");
};

describe("profile assets on a dedicated synthetic database", () => {
  let pool: Pool;
  let adapter: PostgresWorkPublishingAdapter;
  let at: Date;

  beforeAll(async () => {
    pool = await migratedDatabase("assets");
    adapter = new PostgresWorkPublishingAdapter(pool);
    at = await afterMigrations(pool);
  }, SLOW);

  it(
    "plans the families current pointers select, from stored facts only",
    async () => {
      const owner = await createUser(pool);
      const avatar = await createImage(pool, owner, 640, 480);
      const background = await createImage(pool, owner);
      const unbound = await createImage(pool, owner);
      await setProfile(pool, owner, avatar.id, background.id);
      const both = await createUser(pool);
      const shared = await createImage(pool, both);
      await setProfile(pool, both, shared.id, shared.id);
      const suspended = await createUser(pool);
      const hidden = await createImage(pool, suspended);
      await setProfile(pool, suspended, hidden.id, null);
      await setStatus(pool, suspended, "suspended");
      const families = async (
        image: string,
        identities: typeof anchors = anchors,
      ) => (await adapter.readProfileRenderPlan(image, identities))?.families;

      expect(await adapter.readProfileRenderPlan(avatar.id, anchors)).toEqual({
        userMediaId: avatar.id,
        sha256: avatar.sha256,
        width: 640,
        height: 480,
        byteSize: avatar.bytes.length,
        families: ["avatar"],
      });
      expect(await families(background.id)).toEqual(["background"]);
      expect(await families(shared.id)).toEqual(["avatar", "background"]);
      // No current pointer of an active owner: nothing to render.
      expect(await families(unbound.id)).toEqual([]);
      expect(await families(hidden.id)).toEqual([]);
      expect(
        await adapter.readProfileRenderPlan(opaque("user-media"), anchors),
      ).toBeNull();

      // A family whose anchor is ready at its current identity, on a
      // committed blob, is done; it is planned again once the identity moves
      // on or the blob is gone.
      expect(
        await adapter.recordProfileRenditions(
          shared.id,
          outcomeOf(shared.sha256, "avatar-128", "avatar-512"),
          at,
        ),
      ).toEqual({ status: "recorded" });
      expect(await families(shared.id)).toEqual(["background"]);
      const bumped = anchors.map((anchor) =>
        anchor.role === "avatar-128"
          ? { ...anchor, version: anchor.version + 1 }
          : anchor,
      );
      expect(await families(shared.id, bumped)).toEqual([
        "avatar",
        "background",
      ]);
      await pool.query(
        `UPDATE community.media_blobs b SET state='tombstoned', tombstoned_at=$2
         FROM community.media_renditions r
         WHERE r.blob_id=b.id AND r.user_media_id=$1 AND r.role='avatar-128'`,
        [shared.id, at],
      );
      expect(await families(shared.id)).toEqual(["avatar", "background"]);

      // The bytes of an image that is not erased.
      expect(
        Buffer.from((await adapter.readProfileMediaBytes(avatar.id))!),
      ).toEqual(avatar.bytes);
      expect(
        await adapter.readProfileMediaBytes(opaque("user-media")),
      ).toBeNull();
      await erase(pool, owner, unbound.id, at);
      expect(await adapter.readProfileMediaBytes(unbound.id)).toBeNull();
      expect(await adapter.readProfileRenderPlan(unbound.id, anchors)).toBe(
        null,
      );

      // Malformed ids and anchor lists are refused.
      const [avatarAnchor, backgroundAnchor] = anchors as [
        (typeof anchors)[number],
        (typeof anchors)[number],
      ];
      for (const malformed of [
        [],
        [avatarAnchor],
        [avatarAnchor, avatarAnchor],
        [avatarAnchor, backgroundAnchor, avatarAnchor],
        [{ ...avatarAnchor, role: "avatar-512" as const }, backgroundAnchor],
        [{ ...avatarAnchor, version: 0 }, backgroundAnchor],
        [{ ...avatarAnchor, digest: "0123" }, backgroundAnchor],
      ])
        await expect(
          adapter.readProfileRenderPlan(avatar.id, malformed),
          JSON.stringify(malformed),
        ).rejects.toBeInstanceOf(TypeError);
      await expect(
        adapter.readProfileRenderPlan(opaque("media-item"), anchors),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        adapter.readProfileMediaBytes("user-media-0"),
      ).rejects.toBeInstanceOf(TypeError);
    },
    SLOW,
  );

  it(
    "records a whole family in one transaction and discards what it cannot record",
    async () => {
      const owner = await createUser(pool);
      const image = await createImage(pool, owner);
      const blobCount = async () =>
        (
          await pool.query<{ blobs: number }>(
            "SELECT count(*)::int AS blobs FROM community.media_blobs",
          )
        ).rows[0]!.blobs;

      // Refused before anything is recorded: another source, a family
      // without its anchor, a role twice or a role of works, an empty
      // outcome, or one malformed record of a family.
      const before = await blobCount();
      for (const outcome of [
        outcomeOf(sha256("another source"), "avatar-128"),
        outcomeOf(image.sha256, "avatar-512"),
        outcomeOf(image.sha256, "background-960", "background-960"),
        {
          sourceSha256: image.sha256,
          renditions: [{ ...rendition("avatar-128"), role: "thumb" }],
        } as unknown as ProfileRenderOutcome,
        { sourceSha256: image.sha256, renditions: [] },
        {
          sourceSha256: image.sha256,
          renditions: [
            rendition("avatar-128"),
            rendition("avatar-512", { recipeDigest: "not a digest" }),
          ],
        },
      ])
        await expect(
          adapter.recordProfileRenditions(image.id, outcome, at),
          outcome.renditions.map((record) => record.role).join(","),
        ).rejects.toBeInstanceOf(TypeError);
      expect(await blobCount()).toBe(before);
      expect(await renditionRows(pool, image.id)).toEqual([]);

      const family = outcomeOf(
        image.sha256,
        "background-960",
        "background-1600",
      );
      expect(
        await adapter.recordProfileRenditions(image.id, family, at),
      ).toEqual({ status: "recorded" });
      const recorded = await renditionRows(pool, image.id);
      expect(
        recorded.map(({ role, state, owner_id, purpose }) => ({
          role,
          state,
          owner_id,
          purpose,
        })),
      ).toEqual(
        ["background-1600", "background-960"].map((role) => ({
          role,
          state: "ready",
          owner_id: null,
          purpose: "profile_derivative",
        })),
      );
      // A replay reads as recorded; another render of the same versions is
      // returned for removal.
      expect(
        await adapter.recordProfileRenditions(image.id, family, at),
      ).toEqual({ status: "recorded" });
      const again = outcomeOf(image.sha256, "background-960");
      expect(
        await adapter.recordProfileRenditions(image.id, again, at),
      ).toEqual({ status: "discarded", storageKeys: keysOf(again) });
      expect(await renditionRows(pool, image.id)).toEqual(recorded);

      // An erased or unknown image records nothing; every key is returned.
      await erase(pool, owner, image.id, at);
      const late = outcomeOf(image.sha256, "avatar-128", "avatar-512");
      expect(await adapter.recordProfileRenditions(image.id, late, at)).toEqual(
        { status: "discarded", storageKeys: keysOf(late) },
      );
      expect(
        await adapter.recordProfileRenditions(opaque("user-media"), late, at),
      ).toEqual({ status: "discarded", storageKeys: keysOf(late) });
      expect(
        (await renditionRows(pool, image.id)).map(({ role, state }) => ({
          role,
          state,
        })),
      ).toEqual([
        { role: "background-1600", state: "released" },
        { role: "background-960", state: "released" },
      ]);
    },
    SLOW,
  );

  it(
    "serializes recording with erasure, which releases renditions for the purge schedule",
    async () => {
      const owner = await createUser(pool);
      const viewer = await createUser(pool);

      // Erasure holds the row first: a render recorded meanwhile waits for
      // it, then finds the image erased and records nothing.
      const waiting = await createImage(pool, owner);
      const outcome = outcomeOf(waiting.sha256, "avatar-128", "avatar-512");
      const recording = await inTransaction(pool, async (db) => {
        await eraseUnreferencedLegacyMedia(db, owner, [], at, [waiting.id]);
        const pending = adapter.recordProfileRenditions(
          waiting.id,
          outcome,
          at,
        );
        pending.catch(() => undefined);
        await lockWaiter(pool);
        return { pending };
      });
      expect(await recording.pending).toEqual({
        status: "discarded",
        storageKeys: keysOf(outcome),
      });
      expect(await renditionRows(pool, waiting.id)).toEqual([]);

      // Recorded first, erased later: the erasure releases every rendition
      // in its own transaction, and nothing stays readable.
      const image = await createImage(pool, owner);
      const family = outcomeOf(
        image.sha256,
        "background-960",
        "background-1600",
      );
      await adapter.recordProfileRenditions(image.id, family, at);
      await adapter.recordProfileRenditions(
        image.id,
        outcomeOf(image.sha256, "avatar-128"),
        at,
      );
      await setProfile(pool, owner, null, image.id);
      expect(
        await adapter.resolveProfileRenditionRead(
          viewer,
          image.id,
          "background-960",
        ),
      ).toMatchObject({ revalidate: true });
      // A current profile image is never erased.
      const erasedAt = new Date(at.getTime() + 10 * 60_000);
      await erase(pool, owner, image.id, erasedAt);
      expect(
        (await renditionRows(pool, image.id)).map(({ state }) => state),
      ).toEqual(["ready", "ready", "ready"]);
      await setProfile(pool, owner, null, null);
      await erase(pool, owner, image.id, erasedAt);
      const released = await renditionRows(pool, image.id);
      expect(
        released.map(({ role, state, released_at }) => ({
          role,
          state,
          released_at,
        })),
      ).toEqual(
        ["avatar-128", "background-1600", "background-960"].map((role) => ({
          role,
          state: "released",
          released_at: erasedAt,
        })),
      );
      for (const who of [owner, viewer, null])
        expect(
          await adapter.resolveProfileRenditionRead(
            who,
            image.id,
            "background-960",
          ),
        ).toBeNull();

      // The existing purge schedule removes the blobs one hour after they
      // were written, and no capacity counts them.
      const blobs = released.map(({ blob_id }) => blob_id);
      const purgeJobs = async () =>
        (
          await pool.query<{ subject_id: string }>(
            "SELECT subject_id FROM community.publishing_jobs WHERE kind='purge_blob' AND subject_id=ANY($1::text[]) ORDER BY subject_id",
            [blobs],
          )
        ).rows.map(({ subject_id }) => subject_id);
      await adapter.scheduleCleanup(new Date(at.getTime() + 30 * 60_000), 1000);
      expect(await purgeJobs()).toEqual([]);
      const later = new Date(at.getTime() + HOUR + 60_000);
      await adapter.scheduleCleanup(later, 1000);
      expect(await purgeJobs()).toEqual([...blobs].sort());
      for (const blob of blobs)
        expect(await adapter.purgeBlob(blob, later)).toMatchObject({
          status: "tombstoned",
        });
      await adapter.confirmPurged(blobs, later);
      expect(
        (
          await pool.query(
            "SELECT DISTINCT state, owner_id FROM community.media_blobs WHERE id=ANY($1::text[])",
            [blobs],
          )
        ).rows,
      ).toEqual([{ state: "purged", owner_id: null }]);
      expect(
        (await adapter.reconcileCapacity(owner, later)).committedBytes,
      ).toBe(0);
    },
    SLOW,
  );

  it(
    "authorizes a rendition read like the original image, narrowed by family",
    async () => {
      const owner = await createUser(pool);
      const viewer = await createUser(pool);
      const avatar = await createImage(pool, owner);
      const background = await createImage(pool, owner);
      const replacement = await createImage(pool, owner);
      await setProfile(pool, owner, avatar.id, background.id);
      const avatarFamily = outcomeOf(avatar.sha256, "avatar-128", "avatar-512");
      await adapter.recordProfileRenditions(avatar.id, avatarFamily, at);
      // The avatar image also holds a background family from an earlier use.
      await adapter.recordProfileRenditions(
        avatar.id,
        outcomeOf(avatar.sha256, "background-960"),
        at,
      );
      const backgroundFamily = outcomeOf(background.sha256, "background-960");
      await adapter.recordProfileRenditions(
        background.id,
        backgroundFamily,
        at,
      );

      const first = avatarFamily.renditions[0]!;
      expect(
        await adapter.resolveProfileRenditionRead(
          viewer,
          avatar.id,
          "avatar-128",
        ),
      ).toEqual({
        storageKey: first.storageKey,
        contentType: "image/webp",
        byteSize: first.byteSize,
        sha256: first.sha256,
        revalidate: true,
      });

      // Each cell: "current" (readable and revalidated), "owner-only"
      // (readable, never revalidated) or null (not found).
      const cells = [
        [avatar.id, "avatar-128"],
        [avatar.id, "avatar-512"],
        [avatar.id, "background-960"],
        [background.id, "background-960"],
        [background.id, "background-1600"],
      ] as const;
      const matrix = async () => {
        const row = async (who: string | null) =>
          Promise.all(
            cells.map(async ([image, role]) => {
              const target = await adapter.resolveProfileRenditionRead(
                who,
                image,
                role,
              );
              return target === null
                ? null
                : target.revalidate
                  ? "current"
                  : "owner-only";
            }),
          );
        return {
          owner: await row(owner),
          viewer: await row(viewer),
          anonymous: await row(null),
        };
      };
      const others = (row: readonly (string | null)[]) => ({
        viewer: row,
        anonymous: row,
      });

      // Current avatar and background; the avatar image's background family
      // is the owner's only (wrong family for everyone else).
      expect(await matrix()).toEqual({
        owner: ["current", "current", "owner-only", "current", null],
        ...others(["current", "current", null, "current", null]),
      });
      // A replaced avatar: its renditions are the owner's only.
      await setProfile(pool, owner, replacement.id, background.id);
      expect(await matrix()).toEqual({
        owner: ["owner-only", "owner-only", "owner-only", "current", null],
        ...others([null, null, null, "current", null]),
      });
      // A cleared background, and one image as both avatar and background.
      await setProfile(pool, owner, avatar.id, null);
      expect(await matrix()).toEqual({
        owner: ["current", "current", "owner-only", "owner-only", null],
        ...others(["current", "current", null, null, null]),
      });
      await setProfile(pool, owner, avatar.id, avatar.id);
      expect(await matrix()).toEqual({
        owner: ["current", "current", "current", "owner-only", null],
        ...others(["current", "current", "current", null, null]),
      });
      await setProfile(pool, owner, avatar.id, background.id);
      const current = {
        owner: ["current", "current", "owner-only", "current", null],
        ...others(["current", "current", null, "current", null]),
      };
      expect(await matrix()).toEqual(current);

      // A block either way hides everything from that viewer only.
      for (const [blocker, blocked] of [
        [owner, viewer],
        [viewer, owner],
      ] as const) {
        await pool.query(
          "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
          [blocker, blocked],
        );
        expect(await matrix()).toEqual({
          ...current,
          viewer: [null, null, null, null, null],
        });
        await pool.query(
          "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
          [blocker, blocked],
        );
      }
      // A suspended owner hides everything from everyone, the owner too.
      await setStatus(pool, owner, "suspended");
      expect(await matrix()).toEqual({
        owner: [null, null, null, null, null],
        ...others([null, null, null, null, null]),
      });
      await setStatus(pool, owner, "active");
      expect(await matrix()).toEqual(current);

      // A rendition whose blob is gone, and an unknown image, are not found.
      await pool.query(
        `UPDATE community.media_blobs b SET state='tombstoned', tombstoned_at=$2
         FROM community.media_renditions r WHERE r.blob_id=b.id AND r.user_media_id=$1`,
        [background.id, at],
      );
      expect((await matrix()).owner[3]).toBeNull();
      expect(
        await adapter.resolveProfileRenditionRead(
          owner,
          opaque("user-media"),
          "avatar-128",
        ),
      ).toBeNull();
      await expect(
        adapter.resolveProfileRenditionRead(
          owner,
          avatar.id,
          "thumb" as ProfileRole,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        adapter.resolveProfileRenditionRead(
          owner,
          "user-media-0",
          "avatar-128",
        ),
      ).rejects.toBeInstanceOf(TypeError);
    },
    SLOW,
  );
});

describe("profile render sweep on dedicated synthetic databases", () => {
  const sweep = (
    adapter: PostgresWorkPublishingAdapter,
    now: Date,
    limit = 2,
    maxOpen = 2,
  ) => adapter.enqueueProfileRenders(now, { limit, maxOpen, anchors });

  const profileJobs = async (pool: Pool) =>
    (
      await pool.query<{
        id: string;
        subject_id: string;
        state: string;
        attempts: number;
        last_error_code: string | null;
        finished_at: Date | null;
      }>(
        "SELECT id, subject_id, state, attempts, last_error_code, finished_at FROM community.publishing_jobs WHERE kind='profile_render' ORDER BY created_at, subject_id, id",
      )
    ).rows;

  const insertJob = async (
    pool: Pool,
    kind: string,
    subject: string,
    state: "queued" | "running" | "succeeded" | "failed" | "abandoned",
    at: Date,
    errorCode: string | null = null,
  ): Promise<string> => {
    const id = opaque("publishing-job");
    const ended = ["succeeded", "failed", "abandoned"].includes(state);
    await pool.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,lease_owner,lease_expires_at,last_error_code,created_at,updated_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$6,$10)`,
      [
        id,
        kind,
        subject,
        state,
        ended ? 5 : 0,
        at,
        state === "running" ? "qa-worker" : null,
        state === "running" ? new Date(at.getTime() + HOUR) : null,
        errorCode,
        ended ? at : null,
      ],
    );
    return id;
  };

  const finishJobs = (pool: Pool, at: Date) =>
    pool.query(
      "UPDATE community.publishing_jobs SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL, finished_at=$1, updated_at=$1 WHERE state IN ('queued','running')",
      [at],
    );

  /** A public work first published at `publishedAt` (the sweep's ordering key). */
  const publicWork = async (pool: Pool, author: string, publishedAt: Date) => {
    const work = opaque("work");
    const revision = opaque("work-revision");
    await pool.query(
      "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'头像排序','','publishing','public',$3)",
      [work, author, publishedAt],
    );
    await pool.query(
      `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,content_sha256,disposition,submitted_at)
       VALUES($1,$2,$3,1,'submission','头像排序','','original','public',$4,'approved',$5)`,
      [revision, work, author, sha256(revision), publishedAt],
    );
    await pool.query(
      "UPDATE community.works SET public_revision_id=$2,author_revision_id=$2,first_submitted_at=$3 WHERE id=$1",
      [work, revision, publishedAt],
    );
  };

  /** An active owner whose current avatar is a new image. */
  const avatarOwner = async (pool: Pool) => {
    const owner = await createUser(pool);
    const image = await createImage(pool, owner);
    await setProfile(pool, owner, image.id, null);
    return { owner, image };
  };

  /**
   * The same database through a login role that may read every column the
   * sweep and the read authorization need, but not `user_media.bytes`: a
   * statement that touched the bytes would be refused (42501).
   */
  const withoutBytes = async (pool: Pool): Promise<Pool> => {
    const { database } = (
      await pool.query<{ database: string }>(
        "SELECT current_database() AS database",
      )
    ).rows[0]!;
    if (!dedicatedDatabaseName.test(database))
      throw new Error("Unexpected database");
    const role = `pmr_nobytes_${randomBytes(6).toString("hex")}`;
    if (!dedicatedRoleName.test(role)) throw new Error("Unexpected role");
    const password = randomBytes(32).toString("hex");
    await administration.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    createdRoles.push(role);
    await pool.query(
      `GRANT USAGE ON SCHEMA community TO ${role};
       GRANT SELECT ON community.public_users, community.media_renditions, community.media_blobs,
         community.publishing_jobs, community.works, community.blocks TO ${role};
       GRANT SELECT (id, owner_id, mime_type, width, height, sha256, created_at, deleted_at)
         ON community.user_media TO ${role};
       GRANT INSERT ON community.publishing_jobs TO ${role};
       GRANT UPDATE (state, attempts, run_after, lease_owner, lease_expires_at, last_error_code,
         finished_at, updated_at) ON community.publishing_jobs TO ${role};`,
    );
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${database}`;
    url.username = role;
    url.password = password;
    const restricted = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: url.toString() }),
    );
    pools.push(restricted);
    return restricted;
  };

  it(
    "queues each image the pointers of active owners select once, without reading bytes",
    async () => {
      const pool = await migratedDatabase("sweep");
      const adapter = new PostgresWorkPublishingAdapter(pool);
      const at = await afterMigrations(pool);
      const a = await createUser(pool);
      const avatar = await createImage(pool, a);
      const background = await createImage(pool, a);
      await setProfile(pool, a, avatar.id, background.id);
      // One image as both avatar and background: one job.
      const b = await createUser(pool);
      const both = await createImage(pool, b);
      await setProfile(pool, b, both.id, both.id);
      // A suspended owner and an upload no pointer selects: none.
      const suspended = await avatarOwner(pool);
      await setStatus(pool, suspended.owner, "suspended");
      await createImage(pool, a);
      // A background whose anchor is ready at its current identity: none.
      const c = await createUser(pool);
      const done = await createImage(pool, c);
      await setProfile(pool, c, null, done.id);
      await adapter.recordProfileRenditions(
        done.id,
        outcomeOf(done.sha256, "background-960"),
        at,
      );
      // An anchor of another recipe identity only: queued.
      const stale = await avatarOwner(pool);
      await adapter.recordProfileRenditions(
        stale.image.id,
        {
          sourceSha256: stale.image.sha256,
          renditions: [
            rendition("avatar-128", { recipeDigest: "0123456789abcdef" }),
          ],
        },
        at,
      );
      // An erased image a pointer still names (forced): none.
      const erased = await avatarOwner(pool);
      await pool.query(
        "UPDATE community.user_media SET bytes=''::bytea, deleted_at=$2 WHERE id=$1",
        [erased.image.id, at],
      );

      const restricted = new PostgresWorkPublishingAdapter(
        await withoutBytes(pool),
      );
      await expect(
        restricted.readProfileMediaBytes(avatar.id),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        await restricted.enqueueProfileRenders(at, {
          limit: 10,
          maxOpen: 10,
          anchors,
        }),
      ).toEqual({
        missing: 4,
        blocked: 0,
        enqueued: 4,
        requeued: 0,
        paused: false,
      });
      const expected = [avatar.id, background.id, both.id, stale.image.id];
      expect((await profileJobs(pool)).map((job) => job.subject_id)).toEqual(
        expect.arrayContaining(expected),
      );
      expect(await profileJobs(pool)).toHaveLength(4);
      expect(
        (await profileJobs(pool)).every(
          (job) => job.state === "queued" && job.attempts === 0,
        ),
      ).toBe(true);
      // Queued images are not queued again.
      expect(
        await restricted.enqueueProfileRenders(at, {
          limit: 10,
          maxOpen: 10,
          anchors,
        }),
      ).toEqual({
        missing: 4,
        blocked: 0,
        enqueued: 0,
        requeued: 0,
        paused: false,
      });
      // The read authorization needs no bytes either.
      expect(
        await restricted.resolveProfileRenditionRead(
          null,
          done.id,
          "background-960",
        ),
      ).toMatchObject({ revalidate: true });

      // Options are bounded.
      for (const options of [
        { limit: 0, maxOpen: 2 },
        { limit: 11, maxOpen: 2 },
        { limit: 2, maxOpen: 0 },
        { limit: 2, maxOpen: 11 },
        { limit: 1.5, maxOpen: 2 },
      ])
        await expect(
          adapter.enqueueProfileRenders(at, { ...options, anchors }),
          JSON.stringify(options),
        ).rejects.toBeInstanceOf(TypeError);
    },
    SLOW,
  );

  it(
    "keeps at most two profile jobs open, most recent public work first, and yields to other media work",
    async () => {
      const pool = await migratedDatabase("sweep");
      const adapter = new PostgresWorkPublishingAdapter(pool);
      const at = await afterMigrations(pool);
      // Owners with the most recent public work first, owners without any last.
      const quiet = await avatarOwner(pool);
      const older = await avatarOwner(pool);
      await publicWork(pool, older.owner, new Date(at.getTime() - 10 * DAY));
      const recent = await avatarOwner(pool);
      await publicWork(pool, recent.owner, new Date(at.getTime() - DAY));

      expect(await sweep(adapter, at, 1)).toEqual({
        missing: 3,
        blocked: 0,
        enqueued: 1,
        requeued: 0,
        paused: false,
      });
      expect((await profileJobs(pool)).map((job) => job.subject_id)).toEqual([
        recent.image.id,
      ]);
      // A pass queues at most `maxOpen` minus the open jobs.
      expect(await sweep(adapter, at)).toEqual({
        missing: 3,
        blocked: 0,
        enqueued: 1,
        requeued: 0,
        paused: false,
      });
      expect(
        (await profileJobs(pool)).map((job) => job.subject_id).sort(),
      ).toEqual([older.image.id, recent.image.id].sort());
      // Two open jobs: nothing more until one ends.
      expect(await sweep(adapter, at)).toEqual({
        missing: 3,
        blocked: 0,
        enqueued: 0,
        requeued: 0,
        paused: true,
      });
      // One render done (its family recorded): room for one.
      const recentJob = (await profileJobs(pool)).find(
        (job) => job.subject_id === recent.image.id,
      )!;
      const render = (image: Image) =>
        adapter.recordProfileRenditions(
          image.id,
          outcomeOf(image.sha256, "avatar-128", "avatar-512"),
          at,
        );
      await render(recent.image);
      await pool.query(
        "UPDATE community.publishing_jobs SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
        [recentJob.id, at],
      );
      const next = new Date(at.getTime() + 60_000);
      expect(await sweep(adapter, next)).toEqual({
        missing: 2,
        blocked: 0,
        enqueued: 1,
        requeued: 0,
        paused: false,
      });
      expect((await profileJobs(pool)).at(-1)!.subject_id).toBe(quiet.image.id);

      // Queued or running uploads, edits and Catalog renders pause the
      // sweep; other kinds do not.
      await render(older.image);
      await render(quiet.image);
      await finishJobs(pool, next);
      const late = await avatarOwner(pool);
      for (const [kind, state] of [
        ["process_item", "queued"],
        ["process_item", "running"],
        ["derive_edit", "queued"],
        ["derive_edit", "running"],
        ["catalog_render", "queued"],
        ["catalog_render", "running"],
      ] as const) {
        const job = await insertJob(
          pool,
          kind,
          opaque("media-item"),
          state,
          at,
        );
        expect(await sweep(adapter, at), `${kind} ${state}`).toMatchObject({
          enqueued: 0,
          requeued: 0,
          paused: true,
        });
        await pool.query(
          "UPDATE community.publishing_jobs SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL, finished_at=$2 WHERE id=$1",
          [job, at],
        );
      }
      for (const [kind, state] of [
        ["process_item", "failed"],
        ["purge_blob", "queued"],
        ["reconcile_capacity", "running"],
      ] as const)
        await insertJob(pool, kind, opaque("media-blob"), state, at);
      expect(await sweep(adapter, new Date(at.getTime() + 120_000))).toEqual({
        missing: 1,
        blocked: 0,
        enqueued: 1,
        requeued: 0,
        paused: false,
      });
      expect((await profileJobs(pool)).at(-1)!.subject_id).toBe(late.image.id);
    },
    SLOW,
  );

  it(
    "queues exhausted renders again after a day and leaves rejections and abandoned jobs to the operator",
    async () => {
      const pool = await migratedDatabase("sweep");
      const adapter = new PostgresWorkPublishingAdapter(pool);
      const at = await afterMigrations(pool);
      const hours = (count: number) => new Date(at.getTime() + count * HOUR);
      const failedImage = async (
        ...jobs: readonly ["failed" | "abandoned", string, number][]
      ) => {
        const { image } = await avatarOwner(pool);
        const ids: string[] = [];
        for (const [state, code, ended] of jobs)
          ids.push(
            await insertJob(
              pool,
              "profile_render",
              image.id,
              state,
              hours(ended),
              code,
            ),
          );
        return { image, ids };
      };
      const exhausted = await failedImage([
        "failed",
        "processing_unavailable",
        0,
      ]);
      const rejected = await failedImage(["failed", "decode_failed", 0]);
      const abandoned = await failedImage([
        "abandoned",
        "processing_unavailable",
        0,
      ]);
      const recent = await failedImage(["failed", "media_store_failure", 12]);
      // Only the latest failed job of an image counts.
      const rejectedLast = await failedImage(
        ["failed", "processing_unavailable", 0],
        ["failed", "source_mismatch", 1],
      );
      const exhaustedLast = await failedImage(
        ["failed", "decode_failed", 0],
        ["failed", "lease_expired", 1],
      );
      // Rendered meanwhile: not missing, so not retried.
      const rendered = await failedImage([
        "failed",
        "processing_unavailable",
        0,
      ]);
      await adapter.recordProfileRenditions(
        rendered.image.id,
        outcomeOf(rendered.image.sha256, "avatar-128"),
        at,
      );
      const stateOf = async (id: string) =>
        (await profileJobs(pool)).find((job) => job.id === id);
      const untouched = [
        rejected.ids[0]!,
        abandoned.ids[0]!,
        rejectedLast.ids[0]!,
        rejectedLast.ids[1]!,
        exhaustedLast.ids[0]!,
        rendered.ids[0]!,
      ];
      const snapshotOf = async (ids: readonly string[]) =>
        Promise.all(ids.map((id) => stateOf(id)));
      const kept = await snapshotOf(untouched);

      // Nothing is due within the day.
      expect(await sweep(adapter, hours(23), 10, 10)).toEqual({
        missing: 6,
        blocked: 6,
        enqueued: 0,
        requeued: 0,
        paused: false,
      });
      // A day after they failed, the oldest due first, within the room.
      const day = hours(26);
      expect(await sweep(adapter, day, 1, 10)).toEqual({
        missing: 6,
        blocked: 6,
        enqueued: 0,
        requeued: 1,
        paused: false,
      });
      expect(await stateOf(exhausted.ids[0]!)).toMatchObject({
        state: "queued",
        attempts: 0,
        last_error_code: null,
        finished_at: null,
      });
      expect(await sweep(adapter, day, 10, 2)).toEqual({
        missing: 6,
        blocked: 5,
        enqueued: 0,
        requeued: 1,
        paused: false,
      });
      expect(await stateOf(exhaustedLast.ids[1]!)).toMatchObject({
        state: "queued",
        attempts: 0,
        last_error_code: null,
      });
      // Two open: paused, even for retries.
      expect(await sweep(adapter, hours(40), 10, 2)).toMatchObject({
        requeued: 0,
        paused: true,
      });
      expect(await sweep(adapter, hours(40), 10, 10)).toEqual({
        missing: 6,
        blocked: 4,
        enqueued: 0,
        requeued: 1,
        paused: false,
      });
      expect(await stateOf(recent.ids[0]!)).toMatchObject({ state: "queued" });
      expect(await sweep(adapter, hours(100), 10, 10)).toEqual({
        missing: 6,
        blocked: 3,
        enqueued: 0,
        requeued: 0,
        paused: false,
      });
      expect(await snapshotOf(untouched)).toEqual(kept);
    },
    SLOW,
  );
});
