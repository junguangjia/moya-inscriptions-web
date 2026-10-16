import { CommunityConflictError, CommunityNotFoundError } from "@moya/api";
import type { PublishingCommandIdentity } from "@moya/api";
import type {
  PublishingMediaItem,
  PublishingMediaItemProgress,
} from "@moya/contracts";
import { publishingMediaItemProgressSchema } from "@moya/contracts/schemas";
import type { Pool } from "pg";

import {
  authorCommand,
  nowParam,
  publishingAuthorActions,
  readTransaction,
  type PublishingDb,
} from "./db.js";
import {
  reserveBaseHighResolution,
  requireActiveActor,
  selectMediaItems,
} from "./media.js";

/* Author-only progress and HD retry. Existing item/receipt shapes stay unchanged.
 * Readiness comes from committed outputs and durable jobs, never elapsed-time
 * percentages or a lease heartbeat misread as the start of processing. */

// Demand is the base, current editable/visible frames, and real outstanding
// HD work (including unsaved-session edits). Retained history alone must not
// invent work the renderer never scheduled; retention is decided separately.
const wantedFrames = `WITH raw_frames AS (
  SELECT 'base'::text AS edit_key WHERE $2::boolean
  UNION
  SELECT community.media_edit_key(e.item->'edit',NULL)
  FROM community.media_item_refs r
  JOIN community.work_drafts d ON r.holder_kind='draft' AND d.id=r.holder_id
    AND d.state='active' AND d.resolved_at IS NULL
  CROSS JOIN LATERAL jsonb_array_elements(d.content->'items') e(item)
  WHERE r.item_id=$1 AND e.item->>'itemId'=$1
  UNION
  SELECT community.media_edit_key(ri.edit,NULL)
  FROM community.media_item_refs r
  JOIN community.work_revision_items ri ON r.holder_kind='revision' AND ri.revision_id=r.holder_id AND ri.item_id=r.item_id
  JOIN community.works w ON w.deleted_at IS NULL AND (w.author_revision_id=ri.revision_id OR w.public_revision_id=ri.revision_id)
  WHERE r.item_id=$1
  UNION
  SELECT j.payload->>'editKey'
  FROM community.publishing_jobs j
  WHERE j.subject_id=$1 AND j.kind='derive_edit' AND j.payload->'variants'='["full"]'::jsonb
    AND j.state IN ('queued','running','failed')
), frames AS (SELECT edit_key FROM raw_frames WHERE $2::boolean OR edit_key<>'base'), missing AS (
  SELECT f.edit_key FROM frames f WHERE NOT EXISTS (
    SELECT 1 FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
    WHERE d.item_id=$1 AND d.role='full' AND d.edit_key=f.edit_key AND d.state='ready')
)`;

const ownedItem = async (
  db: PublishingDb,
  actorId: string,
  itemId: string,
): Promise<PublishingMediaItem> => {
  await requireActiveActor(db, actorId);
  const item = (await selectMediaItems(db, actorId, [itemId])).get(itemId);
  if (item === undefined) throw new CommunityNotFoundError();
  return item;
};

const selectProgress = async (
  db: PublishingDb,
  item: PublishingMediaItem,
): Promise<PublishingMediaItemProgress> => {
  const facts = (
    await db.query<{
      missing_count: number;
      frame_count: number;
      completed: number;
      hd_states: string[];
      preview_states: string[];
    }>(
      `${wantedFrames}
    SELECT (SELECT count(*)::int FROM missing) AS missing_count,
      (SELECT count(*)::int FROM frames) AS frame_count,
      (SELECT count(*)::int FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
        WHERE d.item_id=$1 AND d.state='ready') AS completed,
      COALESCE((SELECT array_agg(j.state) FROM community.publishing_jobs j
        WHERE j.subject_id=$1 AND j.kind='derive_edit' AND j.payload->'variants'='["full"]'::jsonb
          AND j.payload->>'editKey' IN (SELECT edit_key FROM missing)), ARRAY[]::text[]) AS hd_states,
      COALESCE((SELECT array_agg(j.state) FROM community.publishing_jobs j
        WHERE j.subject_id=$1 AND j.kind='process_item'), ARRAY[]::text[]) AS preview_states`,
      [item.id, item.qualityMode !== "legacy"],
    )
  ).rows[0]!;
  const previewStatus =
    item.state === "ready"
      ? "ready"
      : item.state === "awaiting_upload"
        ? "waiting"
        : item.state === "processing"
          ? facts.preview_states.includes("running")
            ? "processing"
            : "queued"
          : "failed";
  const highResolutionStatus =
    item.kind !== "static" ||
    (item.qualityMode === "legacy" && facts.frame_count === 0)
      ? "not_required"
      : item.state !== "ready"
        ? "waiting"
        : facts.missing_count === 0
          ? "ready"
          : facts.hd_states.includes("running")
            ? "processing"
            : facts.hd_states.includes("queued")
              ? "queued"
              : facts.hd_states.some(
                    (state) => state === "failed" || state === "abandoned",
                  )
                ? "failed"
                : "waiting";
  return publishingMediaItemProgressSchema.parse({
    item,
    processing: {
      previewStatus,
      highResolutionStatus,
      completedRenditions: facts.completed,
    },
  });
};

export const readItemProgress = (
  pool: Pool,
  actorId: string,
  itemId: string,
): Promise<PublishingMediaItemProgress> =>
  readTransaction(pool, async (db) =>
    selectProgress(db, await ownedItem(db, actorId, itemId)),
  );

/** Explicit receipt-bound retry of stopped HD work, without source mutation. */
export const retryItemProcessing = (
  pool: Pool,
  actorId: string,
  itemId: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<PublishingMediaItemProgress> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.retryProcessing,
      subjectId: itemId,
      input: command,
      now,
    },
    async (db) => {
      await db.query(
        "SELECT id FROM community.media_items WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [itemId, actorId],
      );
      const item = await ownedItem(db, actorId, itemId);
      if (item.state !== "ready" || item.kind !== "static")
        throw new CommunityConflictError(
          "Only ready static image HD processing can retry",
        );
      // Select only current missing frames. An operator abandonment stays stopped.
      const jobs = (
        await db.query<{ id: string; state: string; edit_key: string }>(
          `${wantedFrames}
      SELECT j.id,j.state,j.payload->>'editKey' AS edit_key FROM community.publishing_jobs j
      WHERE j.subject_id=$1 AND j.kind='derive_edit' AND j.payload->'variants'='["full"]'::jsonb
        AND j.payload->>'editKey' IN (SELECT edit_key FROM missing)
        AND j.state IN ('failed','abandoned')
        AND (j.state='abandoned' OR NOT EXISTS (
          SELECT 1 FROM community.publishing_jobs stopped
          WHERE stopped.subject_id=j.subject_id AND stopped.kind=j.kind AND stopped.payload=j.payload AND stopped.state='abandoned'))
        AND NOT EXISTS (SELECT 1 FROM community.publishing_jobs active
          WHERE active.subject_id=j.subject_id AND active.kind=j.kind AND active.payload=j.payload AND active.state IN ('queued','running'))
      ORDER BY j.created_at DESC,j.id DESC LIMIT 100 FOR UPDATE OF j`,
          [itemId, item.qualityMode !== "legacy"],
        )
      ).rows;
      if (jobs.some((job) => job.state === "failed" && job.edit_key === "base"))
        await reserveBaseHighResolution(db, item.id, actorId, now);
      const retried = new Set<string>();
      for (const job of jobs) {
        if (job.state === "abandoned") continue;
        // Multiple historical failed attempts can share a payload; updating one
        // claims the existing unique active slot, so the others are skipped.
        const updated = await db.query<{ id: string }>(
          `UPDATE community.publishing_jobs j
        SET state='queued',attempts=0,run_after=$2::timestamptz,lease_owner=NULL,lease_expires_at=NULL,
          last_error_code=NULL,finished_at=NULL,updated_at=$2::timestamptz
        WHERE j.id=$1 AND j.state='failed' AND NOT EXISTS (
          SELECT 1 FROM community.publishing_jobs active WHERE active.subject_id=j.subject_id AND active.kind=j.kind
            AND active.payload=j.payload AND active.state IN ('queued','running')) RETURNING j.id`,
          [job.id, nowParam(now)],
        );
        if (updated.rowCount === 1) retried.add(job.id);
      }
      if (retried.size === 0 && jobs.some((job) => job.state === "abandoned"))
        throw new CommunityConflictError(
          "Processing was stopped by an operator",
        );
      return selectProgress(db, item);
    },
  );
