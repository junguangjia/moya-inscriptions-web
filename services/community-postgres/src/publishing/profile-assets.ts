import type {
  ProfileRenderOutcome,
  ProfileRenderPlan,
  ProfileRenderSweepCounts,
  ProfileRenderSweepOptions,
  ProfileRenditionIdentity,
  ProfileRenditionReadTarget,
  PublishingDerivativeCommit,
} from "@moya/api";
import type {
  ProfileMediaFamily,
  ProfileMediaRenditionRole,
} from "@moya/contracts";
import type { PublishingJobKind } from "@moya/contracts/internal/community-operator";
import {
  profileMediaFamilyOf,
  userMediaIdSchema,
} from "@moya/contracts/schemas";
import type { Pool } from "pg";

import {
  nowParam,
  readTransaction,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { mediaReadTarget, type MediaReadTargetRow } from "./media-read.js";
import {
  RECIPE_DIGEST_PATTERN,
  isProfileRenditionRole,
} from "./recipe-identity.js";
import { recordRenditionRows, unrecordedKeys } from "./renditions.js";

/*
 * Profile image renditions (unified media pipeline, increment 3a): the
 * render plan of one `profile_render` job, its source bytes, recording a
 * rendered family in one transaction, the paced sweep that queues the jobs,
 * the release primitive of erasure, and the read authorization of the
 * rendition route. Each exported port function implements the same-named
 * ProfileMediaAssetPort or WorkPublishingPort method (see its JSDoc in
 * @moya/api); `pool` is the adapter's pool. Profile images
 * (`community.user_media`) are never written here, and only
 * `readProfileMediaBytes` reads their bytes.
 */

/**
 * Each family's anchor: its smallest role, always rendered with the family.
 * The plan and the sweep look at the anchor only: a family is done while its
 * anchor is ready at the current recipe version or a later one, whatever its
 * digest, because the recording rule replaces a ready rendition only with a
 * higher version. A lost non-anchor blob is not rendered again while the
 * anchor stands, and a version bump of a non-anchor role (`avatar-512`,
 * `background-1600`) alone is never rendered; it needs an anchor version
 * bump or an extension of the plan and the sweep.
 */
const FAMILY_ANCHORS: Readonly<
  Record<ProfileMediaFamily, ProfileMediaRenditionRole>
> = { avatar: "avatar-128", background: "background-960" };
/** The `public_users` pointer that selects an image for each family. */
const POINTER_COLUMNS = {
  avatar: "avatar_media_id",
  background: "background_media_id",
} as const satisfies Record<ProfileMediaFamily, string>;

/**
 * Content rejections of a profile render: facts of the hash-pinned source
 * bytes or of the protocol, never retried until the operator acts. Every
 * other code of an exhausted job (an unavailable sandbox, store or database,
 * a lost lease) is retried once the retry delay passed.
 */
const PROFILE_FINAL_FAILURE_CODES = [
  "unsupported_type",
  "decode_failed",
  "dimensions_exceeded",
  "animated_image_unsupported",
  "stream_layout_unsupported",
  "duration_exceeded",
  "pairing_mismatch",
  "size_mismatch",
  "processing_failed",
  "source_mismatch",
  "invalid_job_subject",
  "invalid_job_payload",
  "processing_input_invalid",
  "invalid_job_input",
  "subject_not_found",
  "processing_outcome_invalid",
  "unsupported_job_kind",
] as const;
/** How long an exhausted retryable render waits before the sweep queues it again. */
const RETRY_DELAY_SQL = "interval '24 hours'";
/** While one of these is queued or running, the sweep queues nothing (uploads first). */
const YIELD_TO_KINDS = [
  "process_item",
  "derive_edit",
  "catalog_render",
] as const satisfies readonly PublishingJobKind[];
const SWEEP_MAXIMUM = 10;
const SHA256 = /^[0-9a-f]{64}$/u;

/** SQL: when job `j` ended (failed rows always carry `finished_at`). */
const endedAtSql = (job: string): string =>
  `COALESCE(${job}.finished_at, ${job}.updated_at)`;

/**
 * SQL: image `media` holds a ready rendition, on a committed blob, of the
 * anchor role of `want` (a row of `{family, role, version, digest}`) at that
 * recipe version or a later one, whatever its digest: the recording rule
 * would discard a render of it, so it never counts as missing.
 */
const anchorReadySql = (media: string, want: string): string => `EXISTS (
  SELECT 1 FROM community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
  WHERE r.user_media_id=${media} AND r.state='ready' AND r.role=${want}.role
    AND r.recipe_version>=${want}.version)`;

/**
 * SQL: owner `owner` has a queued or running `profile_render` job, for any
 * of their images.
 */
const ownerJobOpenSql = (owner: string): string => `EXISTS (
  SELECT 1 FROM community.publishing_jobs o
  JOIN community.user_media om ON om.id=o.subject_id
  WHERE o.kind='profile_render' AND o.state IN ('queued','running')
    AND om.owner_id=${owner})`;

/** SQL: the anchor identities (a JSON parameter) as rows `w` of `{family, role, version, digest}`. */
const wantSql = (placeholder: string): string =>
  `jsonb_to_recordset(${placeholder}::jsonb) AS w(family text, role text, version integer, digest text)`;

/**
 * SQL prefix (placeholder `$1`: the anchor identities): `missing`, the
 * profile images a current pointer of an active owner selects, not erased,
 * whose family anchor is not ready (`anchorReadySql`), with their owner.
 * Driven by the pointers (one row per pointer, so an image that is both
 * avatar and background is checked for both families); never reads `bytes`.
 */
const MISSING_SQL = `WITH want AS (SELECT * FROM ${wantSql("$1")}),
pointers AS (
  SELECT u.id AS owner_id, u.avatar_media_id AS media_id, 'avatar'::text AS family
  FROM community.public_users u WHERE u.status='active' AND u.avatar_media_id IS NOT NULL
  UNION ALL
  SELECT u.id, u.background_media_id, 'background'::text
  FROM community.public_users u WHERE u.status='active' AND u.background_media_id IS NOT NULL
),
missing AS (
  SELECT p.media_id, p.owner_id FROM pointers p
  JOIN want w ON w.family=p.family
  JOIN community.user_media m ON m.id=p.media_id AND m.owner_id=p.owner_id AND m.deleted_at IS NULL
  WHERE NOT ${anchorReadySql("p.media_id", "w")}
  GROUP BY p.media_id, p.owner_id
)`;

const assertUserMediaId = (userMediaId: string): void => {
  if (!userMediaIdSchema.safeParse(userMediaId).success)
    throw new TypeError("A profile image id is user-media-<32 hex>");
};

/** The anchor identities as the JSON the statements read, one per family. */
const anchorRows = (anchors: readonly ProfileRenditionIdentity[]): string => {
  const families = new Set<ProfileMediaFamily>();
  const rows = Array.isArray(anchors)
    ? anchors.map((anchor) => {
        const family = isProfileRenditionRole(anchor.role)
          ? profileMediaFamilyOf(anchor.role)
          : null;
        if (
          family === null ||
          FAMILY_ANCHORS[family] !== anchor.role ||
          families.has(family) ||
          !Number.isSafeInteger(anchor.version) ||
          anchor.version < 1 ||
          !RECIPE_DIGEST_PATTERN.test(anchor.digest)
        )
          throw new TypeError(
            "Profile anchors name each family's anchor role once, with a version and digest",
          );
        families.add(family);
        return {
          family,
          role: anchor.role,
          version: anchor.version,
          digest: anchor.digest,
        };
      })
    : [];
  if (families.size !== Object.keys(FAMILY_ANCHORS).length)
    throw new TypeError("Profile anchors name both families");
  return JSON.stringify(rows);
};

/** ProfileMediaAssetPort.readProfileRenderPlan */
export const readProfileRenderPlan = async (
  pool: Pool,
  userMediaId: string,
  anchors: readonly ProfileRenditionIdentity[],
): Promise<ProfileRenderPlan | null> => {
  assertUserMediaId(userMediaId);
  const want = anchorRows(anchors);
  return readTransaction(pool, async (db) => {
    // `octet_length` reads the stored length, not the bytes.
    const row = (
      await db.query<{
        sha256: string;
        width: number;
        height: number;
        byte_size: number;
        families: ProfileMediaFamily[];
      }>(
        `SELECT m.sha256, m.width, m.height, octet_length(m.bytes) AS byte_size,
           ARRAY(
             SELECT w.family FROM ${wantSql("$2")}
             WHERE EXISTS (
                 SELECT 1 FROM community.public_users u
                 WHERE u.id=m.owner_id AND u.status='active'
                   AND (CASE w.family WHEN 'avatar' THEN u.avatar_media_id
                     ELSE u.background_media_id END)=m.id)
               AND NOT ${anchorReadySql("m.id", "w")}
             ORDER BY w.family
           ) AS families
         FROM community.user_media m
         WHERE m.id=$1 AND m.deleted_at IS NULL`,
        [userMediaId, want],
      )
    ).rows[0];
    if (row === undefined) return null;
    return {
      userMediaId,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      byteSize: row.byte_size,
      families: row.families,
    };
  });
};

/** ProfileMediaAssetPort.readProfileMediaBytes */
export const readProfileMediaBytes = async (
  pool: Pool,
  userMediaId: string,
): Promise<Uint8Array | null> => {
  assertUserMediaId(userMediaId);
  return readTransaction(pool, async (db) => {
    const row = (
      await db.query<{ bytes: Buffer }>(
        "SELECT bytes FROM community.user_media WHERE id=$1 AND deleted_at IS NULL",
        [userMediaId],
      )
    ).rows[0];
    return row === undefined
      ? null
      : new Uint8Array(
          row.bytes.buffer,
          row.bytes.byteOffset,
          row.bytes.length,
        );
  });
};

const assertOutcome = (outcome: ProfileRenderOutcome): void => {
  if (
    !SHA256.test(outcome.sourceSha256) ||
    !Array.isArray(outcome.renditions) ||
    outcome.renditions.length === 0
  )
    throw new TypeError("Malformed profile render outcome");
  const roles = new Set<ProfileMediaRenditionRole>();
  for (const record of outcome.renditions) {
    if (!isProfileRenditionRole(record.role) || roles.has(record.role))
      throw new TypeError("A profile render names distinct profile roles");
    roles.add(record.role);
  }
  // A family is recorded whole: its anchor, which is always rendered, with it.
  for (const role of roles)
    if (!roles.has(FAMILY_ANCHORS[profileMediaFamilyOf(role)]))
      throw new TypeError("A profile family is recorded with its anchor");
};

/** ProfileMediaAssetPort.recordProfileRenditions */
export const recordProfileRenditions = async (
  pool: Pool,
  userMediaId: string,
  outcome: ProfileRenderOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  assertUserMediaId(userMediaId);
  assertOutcome(outcome);
  nowParam(now);
  return writeTransaction(pool, async (db) => {
    // Erasure locks the row FOR UPDATE before it wipes it and releases its
    // renditions: a render recorded first is released with it, and one that
    // waited here finds the row erased and records nothing.
    const image = (
      await db.query<{ sha256: string }>(
        "SELECT sha256 FROM community.user_media WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [userMediaId],
      )
    ).rows[0];
    if (image === undefined)
      return {
        status: "discarded",
        storageKeys: await unrecordedKeys(db, outcome.renditions),
      };
    if (image.sha256 !== outcome.sourceSha256)
      throw new TypeError("The rendered source is not the profile image");
    const { duplicates } = await recordRenditionRows(
      db,
      { kind: "profile", id: userMediaId },
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
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });
};

/**
 * Releases every unreleased rendition of the given profile images inside
 * the caller's transaction; the existing purge schedule then removes their
 * blobs. Erasure calls it for the images it erases (and account deletion,
 * once it exists, must too). Returns the count of released rows.
 */
export const releaseProfileRenditions = async (
  db: PublishingDb,
  userMediaIds: readonly string[],
  now: Date,
): Promise<number> => {
  const at = nowParam(now);
  if (userMediaIds.length === 0) return 0;
  return (
    (
      await db.query(
        `UPDATE community.media_renditions SET state='released', released_at=$2::timestamptz
         WHERE user_media_id=ANY($1::text[]) AND state<>'released'`,
        [[...new Set(userMediaIds)], at],
      )
    ).rowCount ?? 0
  );
};

/** ProfileMediaAssetPort.enqueueProfileRenders */
export const enqueueProfileRenders = async (
  pool: Pool,
  now: Date,
  options: ProfileRenderSweepOptions,
): Promise<ProfileRenderSweepCounts> => {
  const bounded = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= SWEEP_MAXIMUM;
  if (!bounded(options.limit) || !bounded(options.maxOpen))
    throw new TypeError(
      "A profile sweep queues 1..10 jobs per pass with 1..10 open",
    );
  const want = anchorRows(options.anchors);
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    // One pass at a time, so two workers never exceed `maxOpen` together.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('profile-render-sweep',0))",
    );
    const gate = (
      await db.query<{
        missing: number;
        blocked: number;
        busy: boolean;
        open: number;
      }>(
        `${MISSING_SQL}
         SELECT
           (SELECT count(*) FROM missing)::int AS missing,
           (SELECT count(*) FROM missing x
            WHERE NOT EXISTS (
                SELECT 1 FROM community.publishing_jobs j
                WHERE j.kind='profile_render' AND j.subject_id=x.media_id
                  AND j.state IN ('queued','running'))
              AND EXISTS (
                SELECT 1 FROM community.publishing_jobs j
                WHERE j.kind='profile_render' AND j.subject_id=x.media_id
                  AND j.state IN ('failed','abandoned')))::int AS blocked,
           EXISTS (
             SELECT 1 FROM community.publishing_jobs
             WHERE kind=ANY($2::text[]) AND state IN ('queued','running')) AS busy,
           (SELECT count(*) FROM community.publishing_jobs
            WHERE kind='profile_render' AND state IN ('queued','running'))::int AS open`,
        [want, [...YIELD_TO_KINDS]],
      )
    ).rows[0]!;
    // Uploads, edits and Catalog renders go first; open profile jobs are bounded.
    const room = gate.busy
      ? 0
      : Math.max(0, Math.min(options.limit, options.maxOpen - gate.open));
    const counts = {
      missing: gate.missing,
      blocked: gate.blocked,
      paused: room === 0,
    };
    if (room === 0 || gate.missing === 0)
      return { ...counts, enqueued: 0, requeued: 0 };
    // One queued or running job per image (the active unique index); a
    // failed or abandoned job waits, except as below. One open job per
    // owner, so one owner never takes every slot: an owner with an open job
    // waits, and a pass queues at most one image per owner (the first by
    // id). Owners with the most recent public work first.
    const enqueued =
      (
        await db.query(
          `${MISSING_SQL}
           INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,created_at,updated_at)
           SELECT 'publishing-job-' || replace(gen_random_uuid()::text, '-', ''), 'profile_render', c.media_id,
             'queued', 0, $2::timestamptz, $2::timestamptz, $2::timestamptz
           FROM (
             SELECT f.media_id FROM (
               SELECT DISTINCT ON (x.owner_id) x.media_id, x.owner_id FROM missing x
               WHERE NOT EXISTS (
                   SELECT 1 FROM community.publishing_jobs j
                   WHERE j.kind='profile_render' AND j.subject_id=x.media_id
                     AND j.state IN ('queued','running','failed','abandoned'))
                 AND NOT ${ownerJobOpenSql("x.owner_id")}
               ORDER BY x.owner_id, x.media_id
             ) f
             ORDER BY (
               SELECT max(w.first_published_at) FROM community.works w
               WHERE w.author_id=f.owner_id AND community.work_is_public(w)
             ) DESC NULLS LAST, f.media_id
             LIMIT $3
           ) c
           ON CONFLICT (kind, subject_id, md5(COALESCE(payload, '{}'::jsonb)::text)) WHERE state IN ('queued', 'running') DO NOTHING
           RETURNING id`,
          [want, at, room],
        )
      ).rowCount ?? 0;
    // The latest failed job of a still-missing image whose code is not a
    // content rejection (its attempts were used up) is queued again, with
    // fresh attempts, once the retry delay passed since it failed, within
    // the same room and still at most one open job per owner (an owner's
    // oldest due job first). A content rejection and an abandoned job (the
    // operator's stop) still wait for the operator.
    const requeued =
      enqueued >= room
        ? 0
        : ((
            await db.query(
              `${MISSING_SQL},
               due AS (
                 SELECT f.id, x.owner_id, ${endedAtSql("f")} AS ended_at
                 FROM community.publishing_jobs f
                 JOIN missing x ON x.media_id=f.subject_id
                 WHERE f.kind='profile_render' AND f.state='failed'
                   AND f.last_error_code IS NOT NULL AND f.last_error_code <> ALL($4::text[])
                   AND ${endedAtSql("f")} < $2::timestamptz - ${RETRY_DELAY_SQL}
                   AND NOT EXISTS (
                     SELECT 1 FROM community.publishing_jobs o
                     WHERE o.kind='profile_render' AND o.subject_id=f.subject_id AND o.id<>f.id
                       AND (o.state IN ('queued','running','abandoned')
                         OR (o.state='failed'
                           AND (${endedAtSql("o")}, o.id) > (${endedAtSql("f")}, f.id))))
                   AND NOT ${ownerJobOpenSql("x.owner_id")}
                 FOR UPDATE OF f SKIP LOCKED
               )
               UPDATE community.publishing_jobs j
               SET state='queued', attempts=0, run_after=$2::timestamptz, lease_owner=NULL,
                   lease_expires_at=NULL, last_error_code=NULL, finished_at=NULL,
                   updated_at=$2::timestamptz
               FROM (
                 SELECT d.id FROM (
                   SELECT DISTINCT ON (owner_id) id, ended_at FROM due
                   ORDER BY owner_id, ended_at, id
                 ) d
                 ORDER BY d.ended_at, d.id
                 LIMIT $3
               ) picked
               WHERE j.id=picked.id AND j.state='failed'
               RETURNING j.id`,
              [want, at, room - enqueued, [...PROFILE_FINAL_FAILURE_CODES]],
            )
          ).rowCount ?? 0);
    return { ...counts, enqueued, requeued };
  });
};

/** WorkPublishingPort.resolveProfileRenditionRead */
export const resolveProfileRenditionRead = async (
  pool: Pool,
  viewerId: string | null,
  userMediaId: string,
  role: ProfileMediaRenditionRole,
): Promise<ProfileRenditionReadTarget | null> => {
  assertUserMediaId(userMediaId);
  if (!isProfileRenditionRole(role))
    throw new TypeError("Unknown profile rendition role");
  const pointer = POINTER_COLUMNS[profileMediaFamilyOf(role)];
  return readTransaction(pool, async (db) => {
    // The original image route's rule (an active owner, an image that is not
    // erased, no block either way; the owner, or anyone for a current
    // profile image) narrowed by family: others read the avatar roles of the
    // current avatar and the background roles of the current background.
    const row = (
      await db.query<MediaReadTargetRow & { revalidate: boolean }>(
        `SELECT b.storage_key, r.content_type, b.byte_size, b.sha256,
           COALESCE(u.${pointer}=m.id, FALSE) AS revalidate
         FROM community.media_renditions r
         JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
         JOIN community.user_media m ON m.id=r.user_media_id AND m.deleted_at IS NULL
         JOIN community.public_users u ON u.id=m.owner_id AND u.status='active'
         WHERE r.user_media_id=$1 AND r.role=$2 AND r.state='ready'
           AND community.accounts_can_interact($3::text, m.owner_id)
           AND (m.owner_id=$3::text OR u.${pointer}=m.id)`,
        [userMediaId, role, viewerId],
      )
    ).rows[0];
    const target = mediaReadTarget(row);
    if (row === undefined || target?.contentType !== "image/webp") return null;
    return { ...target, contentType: "image/webp", revalidate: row.revalidate };
  });
};
