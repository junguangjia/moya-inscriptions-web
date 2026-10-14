import type { PublishingDb } from "./db.js";
import { nowParam } from "./db.js";
import { releaseProfileRenditions } from "./profile-assets.js";

/**
 * Erases legacy PNG bytes only for the explicitly deleted content's candidates.
 * The row remains for media-item foreign keys. Reference writers lock the same
 * media row before assigning avatars/backgrounds, so the check and wipe cannot
 * race a new profile reference. This never scans or purges historical media.
 */
export const eraseUnreferencedLegacyMedia = async (
  db: PublishingDb,
  ownerId: string,
  itemIds: readonly string[],
  now: Date,
  legacyMediaIds: readonly string[] = [],
): Promise<void> => {
  if (itemIds.length === 0 && legacyMediaIds.length === 0) return;
  const rows = await db.query<{ id: string }>(
    `SELECT m.id FROM community.user_media m
     WHERE m.owner_id=$1 AND m.deleted_at IS NULL AND (m.id=ANY($3::text[]) OR EXISTS (
       SELECT 1 FROM community.media_items i
       WHERE i.owner_id=$1 AND i.legacy_media_id=m.id AND i.id=ANY($2::text[])))
     ORDER BY m.id FOR UPDATE`,
    [ownerId, [...new Set(itemIds)], [...new Set(legacyMediaIds)]],
  );
  if (rows.rows.length === 0) return;
  // A fresh statement after locking observes reference writes that committed
  // while the lock was acquired. Keep references from every surviving holder,
  // including legacy drafts and other works and both profile images.
  const erased = await db.query<{ id: string }>(
    `UPDATE community.user_media m SET bytes=''::bytea,deleted_at=$3::timestamptz
     WHERE m.owner_id=$1 AND m.id=ANY($2::text[]) AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM community.public_users u
         WHERE u.avatar_media_id=m.id OR u.background_media_id=m.id)
       AND NOT EXISTS (SELECT 1 FROM community.works w
         WHERE w.deleted_at IS NULL AND m.id=ANY(w.media_ids))
       AND NOT EXISTS (SELECT 1 FROM community.work_edit_drafts d
         WHERE m.id=ANY(d.media_ids))
       AND NOT EXISTS (
         SELECT 1 FROM community.media_items i WHERE i.legacy_media_id=m.id AND (
           EXISTS (SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id)
           OR EXISTS (SELECT 1 FROM community.work_revision_items ri WHERE ri.item_id=i.id)
           OR EXISTS (SELECT 1 FROM community.work_drafts d
             WHERE d.content->'items' @> jsonb_build_array(jsonb_build_object('itemId',i.id)))
           OR EXISTS (SELECT 1 FROM community.work_draft_snapshots s
             WHERE s.content->'items' @> jsonb_build_array(jsonb_build_object('itemId',i.id)))))
     RETURNING m.id`,
    [ownerId, rows.rows.map((row) => row.id), nowParam(now)],
  );
  // Renditions of an erased image (a former avatar or background) go with
  // it, in this transaction: the purge schedule removes their blobs.
  await releaseProfileRenditions(
    db,
    erased.rows.map((row) => row.id),
    now,
  );
};
