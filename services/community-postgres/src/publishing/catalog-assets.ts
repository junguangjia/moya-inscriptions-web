import { createHash } from "node:crypto";

import type {
  CatalogAssetSyncCounts,
  CatalogAssetSyncOptions,
  CatalogMediaSource,
  CatalogRenderOutcome,
  CatalogRenderPlan,
  CatalogRenditionIdentity,
  PublishingDerivativeCommit,
} from "@moya/api";
import type { Pool } from "pg";

import { nowParam, readTransaction, writeTransaction } from "./db.js";
import { RECIPE_DIGEST_PATTERN } from "./recipe-identity.js";
import { recordRenditionRows, unrecordedKeys } from "./renditions.js";

/*
 * Catalog media assets (unified media pipeline, increment 1): sync from the
 * published Catalog list, the render plan of one `catalog_render` job, and
 * recording its renditions and facts in one transaction. Each exported
 * function implements the same-named CatalogMediaAssetPort method (see its
 * JSDoc in @moya/api); `pool` is the adapter's pool. Catalog source objects
 * are never written or deleted here; their renditions are owner-less blobs.
 */

const MAX_SOURCES = 10_000;
const MAX_BATCH = 1000;
/**
 * How long a failed render waits before the sync tries it again. A pending
 * asset that failed only because its source could not be read (missing or
 * forbidden: a read permission not granted yet, a transient signing or
 * deployment error) is rendered again this long after it failed; every other
 * failure of a pending asset is a fact of the hash-pinned source bytes and
 * stays final. A ready asset never fails: its failed render job (a rejected
 * re-render, or attempts used up) is queued again this long after it failed,
 * while the asset keeps its ready renditions.
 */
const RETRY_DELAY_SQL = "interval '24 hours'";
/** A ready rendition counts only while its blob is committed (a rollback can purge it). */
const LIVE_RENDITION_SQL = `community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'`;
/**
 * SQL: asset `a` misses a ready rendition, on a committed blob, of one of the
 * listed identities (`$3`, a JSON array of `{role, version, digest}`).
 */
const MISSING_IDENTITY_SQL = `EXISTS (
  SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS want(role text, version integer, digest text)
  WHERE NOT EXISTS (
    SELECT 1 FROM ${LIVE_RENDITION_SQL}
    WHERE r.catalog_asset_id=a.id AND r.state='ready' AND r.role=want.role
      AND r.recipe_version=want.version AND r.recipe_digest=want.digest))`;
/** SQL: when job `j` ended (failed rows always carry `finished_at`). */
const endedAtSql = (job: string): string =>
  `COALESCE(${job}.finished_at, ${job}.updated_at)`;
const MAX_DIMENSION = 65_535;
const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const MEDIA_ID = /^[^\s]{1,128}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLACEHOLDER_COLOR = /^#[0-9a-f]{6}$/u;
const CATALOG_ROLES: ReadonlySet<string> = new Set([
  "thumb",
  "cover",
  "display",
  "viewer",
]);
/** The two approved key forms; each embeds the SHA-256 of the object bytes. */
const DISPLAY_KEY = /^display\/v1\/media_[a-f0-9]{32}\/([a-f0-9]{64})\.webp$/u;
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-([a-f0-9]{64})\.(jpg|png|webp)$/u;
const SOURCE_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type SourceContentType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];

/** The byte hash and content type an approved key names, or null for any other key. */
const approvedKey = (
  key: string,
): {
  readonly sha256: string;
  readonly contentType: SourceContentType;
} | null => {
  const display = DISPLAY_KEY.exec(key);
  if (display?.[1] !== undefined)
    return { sha256: display[1], contentType: "image/webp" };
  const editorial = EDITORIAL_KEY.exec(key);
  if (editorial?.[1] !== undefined && editorial[2] !== undefined)
    return {
      sha256: editorial[1],
      contentType: SOURCE_TYPES[editorial[2] as keyof typeof SOURCE_TYPES],
    };
  return null;
};

/** `catalog-asset-` + md5(media id ':' key), as the table CHECK derives it. */
const assetIdOf = (mediaId: string, objectKey: string): string =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`, "utf8").digest("hex")}`;

const dimension = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_DIMENSION
    ? value
    : null;

const assertAssetId = (assetId: string): void => {
  if (!ASSET_ID.test(assetId))
    throw new TypeError("A Catalog asset id is catalog-asset-<32 hex>");
};

const assertIdentities = (
  identities: readonly CatalogRenditionIdentity[],
): void => {
  const roles = new Set<string>();
  for (const identity of identities) {
    if (
      !CATALOG_ROLES.has(identity.role) ||
      roles.has(identity.role) ||
      !Number.isSafeInteger(identity.version) ||
      identity.version < 1 ||
      !RECIPE_DIGEST_PATTERN.test(identity.digest)
    )
      throw new TypeError(
        "Catalog rendition identities name distinct roles, versions and digests",
      );
    roles.add(identity.role);
  }
};

interface NamedSource {
  readonly id: string;
  readonly media_id: string;
  readonly object_key: string;
  readonly source_sha256: string;
  readonly source_content_type: SourceContentType;
  readonly width: number | null;
  readonly height: number | null;
}

/** CatalogMediaAssetPort.syncCatalogAssets */
export const syncCatalogAssets = async (
  pool: Pool,
  sources: readonly CatalogMediaSource[],
  now: Date,
  options: CatalogAssetSyncOptions,
): Promise<CatalogAssetSyncCounts> => {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_BATCH
  )
    throw new TypeError("A Catalog sync takes 1..1000 assets per pass");
  assertIdentities(options.renditions);
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES)
    throw new TypeError("A Catalog sync takes at most 10,000 sources");
  const named = new Map<string, NamedSource>();
  let skipped = 0;
  for (const source of sources) {
    const key = approvedKey(source.objectKey);
    if (key === null || !MEDIA_ID.test(source.mediaId)) {
      skipped += 1;
      continue;
    }
    const id = assetIdOf(source.mediaId, source.objectKey);
    if (named.has(id)) continue;
    const width = dimension(source.width);
    const height = dimension(source.height);
    const paired = width !== null && height !== null;
    named.set(id, {
      id,
      media_id: source.mediaId,
      object_key: source.objectKey,
      source_sha256: key.sha256,
      source_content_type: key.contentType,
      width: paired ? width : null,
      height: paired ? height : null,
    });
  }
  const ids = [...named.keys()].sort();
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const created = await db.query(
      `INSERT INTO community.catalog_media_assets(
         id, media_id, source_object_key, source_sha256, source_width, source_height,
         source_content_type, state, created_at, updated_at)
       SELECT s.id, s.media_id, s.object_key, s.source_sha256, s.width, s.height,
         s.source_content_type, 'pending', $2::timestamptz, $2::timestamptz
       FROM (
         SELECT s.* FROM jsonb_to_recordset($1::jsonb) AS s(
           id text, media_id text, object_key text, source_sha256 text,
           source_content_type text, width integer, height integer)
         WHERE NOT EXISTS (SELECT 1 FROM community.catalog_media_assets a WHERE a.id=s.id)
         ORDER BY s.id
         LIMIT $3
       ) s
       ON CONFLICT (media_id, source_object_key) DO NOTHING
       RETURNING id`,
      [JSON.stringify([...named.values()]), at, options.limit],
    );
    await db.query(
      `UPDATE community.catalog_media_assets
       SET unreferenced_since=NULL, updated_at=$2::timestamptz
       WHERE id=ANY($1::text[]) AND unreferenced_since IS NOT NULL`,
      [ids, at],
    );
    const unreferenced = await db.query(
      `UPDATE community.catalog_media_assets
       SET unreferenced_since=$2::timestamptz, updated_at=$2::timestamptz
       WHERE unreferenced_since IS NULL AND NOT (id=ANY($1::text[]))`,
      [ids, at],
    );
    // A named asset whose source was unreadable gets another render once the
    // retry delay passed (bounded per pass); other failures stay final.
    await db.query(
      `UPDATE community.catalog_media_assets a
       SET state='pending', failure_code=NULL, updated_at=$2::timestamptz
       FROM (
         SELECT id FROM community.catalog_media_assets
         WHERE id=ANY($1::text[]) AND unreferenced_since IS NULL
           AND state='failed' AND failure_code='source_unreadable'
           AND updated_at < $2::timestamptz - ${RETRY_DELAY_SQL}
         ORDER BY updated_at, id
         LIMIT $3
         FOR UPDATE
       ) due
       WHERE a.id=due.id`,
      [ids, at, options.limit],
    );
    const wanted = JSON.stringify(options.renditions);
    // A named asset is rendered while pending, or again while ready but
    // missing a ready rendition (on a committed blob) of a listed identity.
    // One queued or running job per asset (the active unique index); a
    // failed or abandoned job waits for the operator, as every scheduled
    // kind does, except as below.
    const inserted = await db.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,created_at,updated_at)
       SELECT 'publishing-job-' || replace(gen_random_uuid()::text, '-', ''), 'catalog_render', c.id,
         'queued', 0, $2::timestamptz, $2::timestamptz, $2::timestamptz
       FROM (
         SELECT a.id FROM community.catalog_media_assets a
         WHERE a.id=ANY($1::text[]) AND a.unreferenced_since IS NULL
           AND (a.state='pending' OR (a.state='ready' AND ${MISSING_IDENTITY_SQL}))
           AND NOT EXISTS (
             SELECT 1 FROM community.publishing_jobs j
             WHERE j.kind='catalog_render' AND j.subject_id=a.id
               AND j.state IN ('queued','running','failed','abandoned'))
         ORDER BY a.created_at, a.id
         LIMIT $4
       ) c
       ON CONFLICT (kind, subject_id, md5(COALESCE(payload, '{}'::jsonb)::text)) WHERE state IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [ids, at, wanted, options.limit],
    );
    const insertedCount = inserted.rowCount ?? 0;
    // A ready asset still missing a listed identity whose latest render job
    // failed (its re-render was rejected, or its attempts were used up) keeps
    // its ready renditions; that job is queued again, with fresh attempts,
    // once the retry delay passed since it failed, so a rejection is retried
    // daily instead of on every pass. An abandoned job (the operator's stop)
    // still blocks. Within the same per-pass bound as new jobs.
    const requeued =
      insertedCount >= options.limit
        ? 0
        : ((
            await db.query(
              `UPDATE community.publishing_jobs j
               SET state='queued', attempts=0, run_after=$2::timestamptz, lease_owner=NULL,
                   lease_expires_at=NULL, last_error_code=NULL, finished_at=NULL,
                   updated_at=$2::timestamptz
               FROM (
                 SELECT f.id FROM community.publishing_jobs f
                 JOIN community.catalog_media_assets a ON a.id=f.subject_id
                 WHERE f.kind='catalog_render' AND f.state='failed'
                   AND ${endedAtSql("f")} < $2::timestamptz - ${RETRY_DELAY_SQL}
                   AND a.id=ANY($1::text[]) AND a.unreferenced_since IS NULL
                   AND a.state='ready' AND ${MISSING_IDENTITY_SQL}
                   AND NOT EXISTS (
                     SELECT 1 FROM community.publishing_jobs o
                     WHERE o.kind='catalog_render' AND o.subject_id=f.subject_id AND o.id<>f.id
                       AND (o.state IN ('queued','running','abandoned')
                         OR (o.state='failed'
                           AND (${endedAtSql("o")}, o.id) > (${endedAtSql("f")}, f.id))))
                 ORDER BY ${endedAtSql("f")}, f.id
                 LIMIT $4
                 FOR UPDATE OF f SKIP LOCKED
               ) due
               WHERE j.id=due.id AND j.state='failed'
               RETURNING j.id`,
              [ids, at, wanted, options.limit - insertedCount],
            )
          ).rowCount ?? 0);
    return {
      referenced: ids.length,
      skipped,
      created: created.rowCount ?? 0,
      unreferenced: unreferenced.rowCount ?? 0,
      enqueued: insertedCount + requeued,
    };
  });
};

/** CatalogMediaAssetPort.readCatalogRenderPlan */
export const readCatalogRenderPlan = async (
  pool: Pool,
  assetId: string,
): Promise<CatalogRenderPlan | null> => {
  assertAssetId(assetId);
  return readTransaction(pool, async (db) => {
    const asset = (
      await db.query<{
        id: string;
        media_id: string;
        source_object_key: string;
        source_width: number | null;
        source_height: number | null;
        state: "pending" | "ready" | "failed";
        unreferenced_since: Date | null;
      }>(
        `SELECT id, media_id, source_object_key, source_width, source_height, state, unreferenced_since
         FROM community.catalog_media_assets WHERE id=$1`,
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed") return null;
    const key = approvedKey(asset.source_object_key);
    if (key === null) return null;
    const ready = await db.query<{
      role: CatalogRenditionIdentity["role"];
      recipe_version: number;
      recipe_digest: string;
      width: number;
      height: number;
    }>(
      `SELECT r.role, r.recipe_version, r.recipe_digest, r.width, r.height
       FROM ${LIVE_RENDITION_SQL}
       WHERE r.catalog_asset_id=$1 AND r.state='ready'
       ORDER BY r.role`,
      [assetId],
    );
    return {
      assetId: asset.id,
      mediaId: asset.media_id,
      sourceObjectKey: asset.source_object_key,
      sourceSha256: key.sha256,
      sourceContentType: key.contentType,
      sourceWidth: asset.source_width,
      sourceHeight: asset.source_height,
      state: asset.state,
      referenced: asset.unreferenced_since === null,
      ready: ready.rows.map((row) => ({
        role: row.role,
        version: row.recipe_version,
        digest: row.recipe_digest,
        width: row.width,
        height: row.height,
      })),
    };
  });
};

const assertOutcome = (outcome: CatalogRenderOutcome): void => {
  const sideOk = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION;
  if (
    !SHA256.test(outcome.masterSha256) ||
    !sideOk(outcome.masterWidth) ||
    !sideOk(outcome.masterHeight) ||
    (outcome.placeholderColor !== null &&
      !PLACEHOLDER_COLOR.test(outcome.placeholderColor)) ||
    !Array.isArray(outcome.renditions)
  )
    throw new TypeError("Malformed Catalog render outcome");
  for (const record of outcome.renditions)
    if (!CATALOG_ROLES.has(record.role))
      throw new TypeError("Unknown Catalog rendition role");
};

/** CatalogMediaAssetPort.recordCatalogRenditions */
export const recordCatalogRenditions = async (
  pool: Pool,
  assetId: string,
  outcome: CatalogRenderOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  assertAssetId(assetId);
  assertOutcome(outcome);
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const asset = (
      await db.query<{ state: string; source_sha256: string | null }>(
        "SELECT state, source_sha256 FROM community.catalog_media_assets WHERE id=$1 FOR UPDATE",
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed")
      return {
        status: "discarded",
        storageKeys: await unrecordedKeys(db, outcome.renditions),
      };
    if (
      asset.source_sha256 !== null &&
      asset.source_sha256 !== outcome.masterSha256
    )
      throw new TypeError("The rendered source is not the asset's source");
    const { duplicates } = await recordRenditionRows(
      db,
      { kind: "catalog", id: assetId },
      outcome.renditions.map((record) => ({
        storageKey: record.storageKey,
        byteSize: record.byteSize,
        sha256: record.sha256,
        role: record.role,
        editKey: "base",
        contentType: record.contentType,
        width: record.width,
        height: record.height,
        durationMs: null,
        recipeVersion: record.recipeVersion,
        recipeDigest: record.recipeDigest,
      })),
      now,
    );
    await db.query(
      `UPDATE community.catalog_media_assets
       SET state='ready', failure_code=NULL, master_sha256=$2, master_width=$3, master_height=$4,
           placeholder_color=$5, updated_at=$6::timestamptz
       WHERE id=$1`,
      [
        assetId,
        outcome.masterSha256,
        outcome.masterWidth,
        outcome.masterHeight,
        outcome.placeholderColor,
        at,
      ],
    );
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });
};

/** CatalogMediaAssetPort.failCatalogAsset */
export const failCatalogAsset = async (
  pool: Pool,
  assetId: string,
  failureCode: string,
  now: Date,
): Promise<void> => {
  assertAssetId(assetId);
  if (!FAILURE_CODE.test(failureCode))
    throw new TypeError("Catalog failure codes are content-free identifiers");
  const at = nowParam(now);
  await writeTransaction(pool, (db) =>
    db.query(
      `UPDATE community.catalog_media_assets
       SET state='failed', failure_code=$2, updated_at=$3::timestamptz
       WHERE id=$1 AND state='pending'`,
      [assetId, failureCode, at],
    ),
  );
};
