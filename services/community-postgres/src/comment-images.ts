import { cancelItems, releaseHolderRefs } from "./publishing/media.js";
import { CommunityInputError } from "@moya/api";
import { COMMENT_IMAGE_LIMITS } from "@moya/contracts/schemas";
import type { CommentImageInput } from "@moya/contracts";
import type { PoolClient } from "pg";
import { withinPublicPolicySql } from "./publishing/rendition-read.js";

/** Only committed processed derivatives are projected; no provider keys leave PostgreSQL. */
export const commentImagesSql = (subject: string, operator = false): string => {
  const prefix = operator
    ? "'/api/community-moderation/comment-media/'"
    : "'/api/community/discussion/images/'";
  const base = `${prefix}||${subject}.id||'/'||i.id||'/'`;
  return `CASE WHEN ${subject}.body_deleted_at IS NOT NULL ${operator ? "" : `OR ${subject}.moderation='hidden'`} THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',i.id,'offset',(ref.value->>'offset')::integer,
      'width',d.width,'height',d.height,'thumbSrc',${base}||'thumb','src',${base}||'display',
      'fullSrc',CASE WHEN EXISTS (SELECT 1 FROM community.media_renditions f JOIN community.media_blobs fb ON fb.id=f.blob_id AND fb.state='committed'
        WHERE f.item_id=i.id AND f.role='full' AND f.edit_key='base' AND f.state='ready' AND f.content_type='image/webp' AND ${withinPublicPolicySql("f")}) THEN ${base}||'full' END)) ORDER BY ref.ordinality)
    FROM jsonb_array_elements(${subject}.image_refs) WITH ORDINALITY ref(value,ordinality)
    JOIN community.media_items i ON i.id=ref.value->>'itemId' AND i.owner_id=${subject}.author_id AND i.purpose='comment'
      AND i.state='ready' AND i.cancelled_at IS NULL AND i.purged_at IS NULL
    JOIN community.media_renditions d ON d.item_id=i.id AND d.role='display' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp'
    JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
    WHERE EXISTS (SELECT 1 FROM community.media_renditions t JOIN community.media_blobs tb ON tb.id=t.blob_id AND tb.state='committed'
      WHERE t.item_id=i.id AND t.role='thumb' AND t.edit_key='base' AND t.state='ready' AND t.content_type='image/webp')
  ),'[]'::jsonb) END`;
};

/** Same item locks as cancellation/lease cleanup. Pin before the temporary session is retired. */
export async function pinCommentImages(
  db: PoolClient,
  actor: string,
  commentId: string,
  images: readonly CommentImageInput[],
): Promise<void> {
  if (!images.length) return;
  const ids = images.map((i) => i.itemId);
  const rows = (
    await db.query<{
      id: string;
      owner_id: string;
      purpose: string;
      kind: string;
      state: string;
      ready: boolean;
    }>(
      `SELECT i.id,i.owner_id,i.purpose,i.kind,i.state,
      (i.cancelled_at IS NULL AND i.purged_at IS NULL AND i.declared_total_bytes<=$2::bigint AND i.received_total_bytes=i.declared_total_bytes AND i.received_total_bytes>0 AND
      EXISTS(SELECT 1 FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed' WHERE d.item_id=i.id AND d.role='thumb' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp') AND
      EXISTS(SELECT 1 FROM community.media_renditions d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed' WHERE d.item_id=i.id AND d.role='display' AND d.edit_key='base' AND d.state='ready' AND d.content_type='image/webp')) AS ready
      FROM community.media_items i WHERE i.id=ANY($1::text[]) ORDER BY i.id FOR UPDATE OF i`,
      [ids, COMMENT_IMAGE_LIMITS.maxBytes],
    )
  ).rows;
  if (
    rows.length !== ids.length ||
    rows.some(
      (i) =>
        i.owner_id !== actor ||
        i.purpose !== "comment" ||
        i.kind !== "static" ||
        i.state !== "ready" ||
        !i.ready,
    )
  )
    throw new CommunityInputError("Invalid comment image selection");
  for (const id of ids)
    await db.query(
      "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) VALUES($1,'comment',$2) ON CONFLICT DO NOTHING",
      [id, commentId],
    );
}

/** Irreversible deletion releases this body only. Shared comments keep their pins.
 * Cancellation revokes stale preview URLs immediately; bytes retain the existing grace. */
export async function releaseCommentImages(
  db: PoolClient,
  commentIds: readonly string[],
  now: Date,
): Promise<void> {
  const released = await releaseHolderRefs(
    db,
    [{ holderKind: "comment", holderIds: commentIds }],
    now,
  );
  if (!released.length) return;
  // The item locks taken by releaseHolderRefs also fence new holders. Never
  // cancel an item any non-session holder still retains, including future kinds.
  const orphanIds = (
    await db.query<{ id: string }>(
      "SELECT id FROM community.media_items i WHERE i.id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id AND r.holder_kind<>'session') ORDER BY i.id",
      [released],
    )
  ).rows.map((row) => row.id);
  const cancelled = await cancelItems(db, orphanIds, now);
  if (!cancelled.itemIds.length) return;
  await db.query(
    `UPDATE community.publishing_jobs j SET run_after=GREATEST(j.run_after,$2::timestamptz+make_interval(days=>s.orphan_grace_days)),updated_at=$2::timestamptz
    FROM community.work_publishing_settings s WHERE s.id='settings' AND j.kind='purge_item' AND j.subject_id=ANY($1::text[]) AND j.state='queued'`,
    [cancelled.itemIds, now.toISOString()],
  );
}
