import type { PublishingMediaWriteResult } from "@moya/api";

import { nowParam, opaqueId, type PublishingDb } from "./db.js";
import {
  RECIPE_DIGEST_PATTERN,
  isRenditionRole,
  type RenditionRole,
} from "./recipe-identity.js";

/*
 * community.media_renditions: the one rendition table of media items and
 * Catalog assets (unified media pipeline, increment 1). One definition each
 * of the rendition recording rule, the holder-need and blob-in-use
 * predicates, and the D7 retention hold. Readers select `state='ready'`;
 * no rendition row is ever deleted. A superseded row keeps its pre-task blob
 * held; a replaced task-created row and an unneeded row are released and
 * free their blob for the existing purge.
 */

/** The migration whose ledger time separates pre-task bytes from task-created ones (D7). */
const RENDITIONS_MIGRATION_ID = "20261004010000";

/**
 * D7 for user-initiated lifecycle deletion of blobs (an author's trash
 * retention and item purge, the orphan purge of unreferenced uploads and
 * released edit renditions): `false` keeps today's lifecycle for pre-task
 * bytes as well (Owner answer to Q4, 2026-10-04: only task-initiated
 * deletions are held), so an item purge also deletes a blob this task held
 * when it superseded the rendition. `true` would hold every pre-task blob
 * those paths reach (`purgeItem`, the `purge_blob` schedule and `purgeBlob`)
 * instead of deleting it. Task-initiated deletions are always held.
 */
export const USER_PURGE_HOLDS_PRE_TASK_BLOBS: boolean = false;

/** SQL: the blob (alias) existed before this task's first migration. */
export const preTaskBlobSql = (blob: string): string =>
  `(${blob}.created_at < COALESCE((SELECT m.applied_at FROM community.schema_migrations m WHERE m.migration_id='${RENDITIONS_MIGRATION_ID}'), 'infinity'::timestamptz))`;

/**
 * SQL: a pre-task blob (alias) a task-initiated path would delete, or (while
 * `USER_PURGE_HOLDS_PRE_TASK_BLOBS` is true) any pre-task blob. Task-initiated
 * means a rendition of the blob was replaced by this task: only a recorded
 * newer recipe version ever sets `superseded_at`, and the row keeps it once
 * released. The recording rule already holds such a blob when it supersedes
 * the rendition; the purge paths re-check this as a safety net.
 */
export const retentionHoldSql = (blob: string): string =>
  USER_PURGE_HOLDS_PRE_TASK_BLOBS
    ? preTaskBlobSql(blob)
    : `(${preTaskBlobSql(blob)} AND EXISTS (
        SELECT 1 FROM community.media_renditions hr
        WHERE hr.blob_id=${blob}.id AND hr.superseded_at IS NOT NULL))`;

/**
 * SQL (blob id expression): true while a live component or a rendition that
 * is not released uses the blob. A purged item's components and renditions
 * no longer count; Catalog renditions count until released.
 */
export const blobInUseSql = (blobId: string): string => `(
  EXISTS (
    SELECT 1 FROM community.media_components c JOIN community.media_items ci ON ci.id=c.item_id
    WHERE c.blob_id=${blobId} AND ci.state <> 'purged')
  OR EXISTS (
    SELECT 1 FROM community.media_renditions r LEFT JOIN community.media_items ri ON ri.id=r.item_id
    WHERE r.blob_id=${blobId} AND r.state <> 'released' AND (r.item_id IS NULL OR ri.state <> 'purged'))
)`;

/**
 * SQL (for a ready rendition `d` of item `i`) that is true when a holder still
 * wants that role and edit key: the content of an active draft or unresolved
 * conflict copy, a snapshot, or a revision holding a ref to the item, each
 * through `community.media_wanted_renditions` (the required set plus the
 * optional `viewer`, so a viewer of a held edit is never released).
 */
export const renditionNeededSql = `(
  EXISTS (
    SELECT 1 FROM community.media_item_refs r
    JOIN community.work_drafts w ON w.id=r.holder_id AND w.state='active' AND w.resolved_at IS NULL
    CROSS JOIN LATERAL jsonb_array_elements(w.content->'items') e(item)
    CROSS JOIN LATERAL community.media_wanted_renditions(
      i.kind, e.item->'edit',
      COALESCE(e.item->>'key' = w.content->>'coverKey', FALSE),
      CASE WHEN e.item->>'key' = w.content->>'coverKey' THEN w.content->'coverCrop' END) rd
    WHERE r.item_id=i.id AND r.holder_kind='draft' AND e.item->>'itemId'=i.id
      AND rd.role=d.role AND rd.edit_key=d.edit_key)
  OR EXISTS (
    SELECT 1 FROM community.media_item_refs r
    JOIN community.work_draft_snapshots w ON w.id=r.holder_id
    CROSS JOIN LATERAL jsonb_array_elements(w.content->'items') e(item)
    CROSS JOIN LATERAL community.media_wanted_renditions(
      i.kind, e.item->'edit',
      COALESCE(e.item->>'key' = w.content->>'coverKey', FALSE),
      CASE WHEN e.item->>'key' = w.content->>'coverKey' THEN w.content->'coverCrop' END) rd
    WHERE r.item_id=i.id AND r.holder_kind='snapshot' AND e.item->>'itemId'=i.id
      AND rd.role=d.role AND rd.edit_key=d.edit_key)
  OR EXISTS (
    SELECT 1 FROM community.media_item_refs r
    JOIN community.work_revisions rv ON rv.id=r.holder_id
    JOIN community.work_revision_items ri ON ri.revision_id=rv.id AND ri.item_id=i.id
    CROSS JOIN LATERAL community.media_wanted_renditions(
      i.kind, ri.edit,
      COALESCE(rv.cover_item_id = ri.item_id, FALSE),
      CASE WHEN rv.cover_item_id = ri.item_id THEN rv.cover_crop END) rd
    WHERE r.item_id=i.id AND r.holder_kind='revision'
      AND rd.role=d.role AND rd.edit_key=d.edit_key)
)`;

/** Storage keys of the records that no `media_blobs` row names (safe to remove). */
export const unrecordedKeys = async (
  db: PublishingDb,
  records: readonly PublishingMediaWriteResult[],
): Promise<string[]> => {
  const keys = records.map((record) => record.storageKey);
  if (keys.length === 0) return [];
  const known = new Set(
    (
      await db.query<{ storage_key: string }>(
        "SELECT storage_key FROM community.media_blobs WHERE storage_key=ANY($1::text[])",
        [keys],
      )
    ).rows.map((row) => row.storage_key),
  );
  return keys.filter((key) => !known.has(key));
};

/** One stored result to record, for either subject kind. */
export interface RenditionRecordInput extends PublishingMediaWriteResult {
  readonly role: RenditionRole;
  readonly editKey: string;
  readonly contentType: "image/webp" | "video/mp4";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
}

/** The locked subject of a recording: an owned item or an owner-less Catalog asset. */
export type RenditionSubject =
  | { readonly kind: "item"; readonly id: string; readonly ownerId: string }
  | { readonly kind: "catalog"; readonly id: string };

const RECIPE_VERSION_MAX = 2_147_483_647;
const EDIT_KEY = /^(?:base|[0-9a-f]{32})$/u;

/**
 * The recipe a record names. The store never defaults or computes one: the
 * processor renders with the one registry and names what it rendered.
 */
const recipeOf = (
  record: RenditionRecordInput,
): { readonly version: number; readonly digest: string } => {
  if (
    !Number.isSafeInteger(record.recipeVersion) ||
    record.recipeVersion < 1 ||
    record.recipeVersion > RECIPE_VERSION_MAX ||
    !RECIPE_DIGEST_PATTERN.test(record.recipeDigest)
  )
    throw new TypeError(
      "A rendition recipe needs a positive integer version and a 16-hex digest",
    );
  return { version: record.recipeVersion, digest: record.recipeDigest };
};

const assertRecordShape = (
  subject: RenditionSubject,
  record: RenditionRecordInput,
): void => {
  if (!isRenditionRole(record.role) || !EDIT_KEY.test(record.editKey))
    throw new TypeError("Unknown rendition role or edit key");
  recipeOf(record);
  if (
    subject.kind === "catalog" &&
    (record.editKey !== "base" ||
      record.role === "motion" ||
      record.contentType !== "image/webp")
  )
    throw new TypeError("Catalog renditions are unedited WebP stills");
};

interface ReadySlot {
  readonly id: string;
  readonly blobId: string;
  readonly version: number;
  readonly committed: boolean;
  /** The blob existed before this task's migration (D7). */
  readonly preTask: boolean;
}

/**
 * Records rendition blobs and rows for a subject the caller has locked. Per
 * result, in order:
 * 1. a storage key that is already recorded is skipped (a replayed result);
 * 2. when the slot (role and edit key) has a ready rendition whose blob is
 *    no longer committed, that row is released and the result recorded;
 * 3. when the result's recipe version is newer than the ready rendition's,
 *    the result is recorded as the slot's ready rendition and the replaced
 *    row (a task-initiated replacement) becomes `superseded` with its
 *    pre-task blob held (D7), or `released` (its `superseded_at` kept) when
 *    this task created the blob, so the existing purge removes it;
 * 4. otherwise (an equal or older version) the result is a duplicate: it is
 *    not recorded and its key is returned for removal.
 * Item blobs belong to the item owner (purpose `derivative`) and their bytes
 * are returned for the committed counter; Catalog blobs have no owner
 * (purpose `catalog_derivative`) and count toward no capacity.
 */
export const recordRenditionRows = async (
  db: PublishingDb,
  subject: RenditionSubject,
  records: readonly RenditionRecordInput[],
  now: Date,
): Promise<{
  readonly recordedBytes: number;
  readonly duplicates: string[];
}> => {
  const at = nowParam(now);
  for (const record of records) assertRecordShape(subject, record);
  const fresh = new Set(await unrecordedKeys(db, records));
  const subjectColumn =
    subject.kind === "item" ? "item_id" : "catalog_asset_id";
  const ready = new Map<string, ReadySlot>(
    (
      await db.query<{
        id: string;
        role: string;
        edit_key: string;
        recipe_version: number;
        blob_id: string;
        blob_state: string;
        pre_task: boolean;
      }>(
        `SELECT r.id, r.role, r.edit_key, r.recipe_version, r.blob_id, b.state AS blob_state,
           ${preTaskBlobSql("b")} AS pre_task
         FROM community.media_renditions r
         JOIN community.media_blobs b ON b.id=r.blob_id
         WHERE r.${subjectColumn}=$1 AND r.state='ready'
         ORDER BY r.id FOR UPDATE OF r`,
        [subject.id],
      )
    ).rows.map((row) => [
      `${row.role}@${row.edit_key}`,
      {
        id: row.id,
        blobId: row.blob_id,
        version: row.recipe_version,
        committed: row.blob_state === "committed",
        preTask: row.pre_task,
      },
    ]),
  );
  const duplicates: string[] = [];
  let recordedBytes = 0;
  for (const record of records) {
    if (!fresh.has(record.storageKey)) continue;
    fresh.delete(record.storageKey);
    const recipe = recipeOf(record);
    const slot = `${record.role}@${record.editKey}`;
    const current = ready.get(slot);
    if (current !== undefined) {
      if (!current.committed)
        await db.query(
          "UPDATE community.media_renditions SET state='released', released_at=$2::timestamptz WHERE id=$1",
          [current.id, at],
        );
      else if (recipe.version > current.version && current.preTask) {
        // D7: a task-initiated replacement never frees pre-task bytes.
        await db.query(
          "UPDATE community.media_renditions SET state='superseded', superseded_at=$2::timestamptz WHERE id=$1",
          [current.id, at],
        );
        await db.query(
          "UPDATE community.media_blobs SET retention_hold='d7_pre_task' WHERE id=$1 AND state='committed' AND retention_hold IS NULL",
          [current.blobId],
        );
      } else if (recipe.version > current.version)
        await db.query(
          "UPDATE community.media_renditions SET state='released', superseded_at=$2::timestamptz, released_at=$2::timestamptz WHERE id=$1",
          [current.id, at],
        );
      else {
        duplicates.push(record.storageKey);
        continue;
      }
    }
    const blobId = opaqueId("media-blob");
    await db.query(
      `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'committed',$8::timestamptz)`,
      [
        blobId,
        subject.kind === "item" ? subject.ownerId : null,
        subject.kind === "item" ? "derivative" : "catalog_derivative",
        record.storageKey,
        record.byteSize,
        record.sha256,
        record.contentType,
        at,
      ],
    );
    const renditionId = opaqueId("media-rendition");
    await db.query(
      `INSERT INTO community.media_renditions(id,${subjectColumn},edit_key,role,recipe_version,recipe_digest,blob_id,width,height,duration_ms,content_type,state,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',$12::timestamptz)`,
      [
        renditionId,
        subject.id,
        record.editKey,
        record.role,
        recipe.version,
        recipe.digest,
        blobId,
        record.width,
        record.height,
        record.durationMs,
        record.contentType,
        at,
      ],
    );
    ready.set(slot, {
      id: renditionId,
      blobId,
      version: recipe.version,
      committed: true,
      preTask: false,
    });
    if (subject.kind === "item") recordedBytes += record.byteSize;
  }
  return { recordedBytes, duplicates };
};
