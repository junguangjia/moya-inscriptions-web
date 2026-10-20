import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type { MediaComponentRole } from "@moya/contracts";
import type {
  PublishingBlobContentType,
  PublishingMediaWriteResult,
  PublishingUploadCommit,
  PublishingUploadFence,
  PublishingUploadStart,
  PublishingUploadTiming,
} from "@moya/api";
import type { Pool } from "pg";

import {
  actorTransaction,
  nowParam,
  opaqueId,
  safeInteger,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { adjustCapacity, insertJob } from "./jobs.js";
import { selectMediaItems } from "./media.js";

/*
 * Streaming component uploads behind the attempt/cancel fence.
 * Owner: B1a. Each function implements the same-named WorkPublishingPort method
 * (see its JSDoc in @moya/api); `pool` is the adapter's pool. Shared helpers: ./db.ts.
 */

interface ItemRow {
  id: string;
  owner_id: string;
  state: string;
  quality_mode: "standard" | "original" | "legacy";
}

interface ComponentRow {
  id: string;
  item_id: string;
  role: MediaComponentRole;
  state: string;
  upload_attempt: string | null;
  declared_bytes: string;
  declared_type: PublishingBlobContentType;
  reserved_bytes: string;
}

const lockItem = async (
  db: PublishingDb,
  itemId: string,
  ownerId: string,
): Promise<ItemRow | undefined> =>
  (
    await db.query<ItemRow>(
      "SELECT id,owner_id,state,quality_mode FROM community.media_items WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [itemId, ownerId],
    )
  ).rows[0];

const lockComponent = async (
  db: PublishingDb,
  componentId: string,
  itemId: string,
): Promise<ComponentRow | undefined> =>
  (
    await db.query<ComponentRow>(
      "SELECT id,item_id,role,state,upload_attempt::text AS upload_attempt,declared_bytes,declared_type,reserved_bytes FROM community.media_components WHERE id=$1 AND item_id=$2 FOR UPDATE",
      [componentId, itemId],
    )
  ).rows[0];

/**
 * Whether an active draft or an active session still holds the item. With
 * `requireLease`, a session also needs an unexpired lease; without it an
 * active session whose lease lapsed still holds the item (a transfer that
 * was streaming), but only unexpired leases are renewed to `now` + lease
 * minutes, so a lapsed session stays inaccessible (D11).
 */
const holdAndRenew = async (
  db: PublishingDb,
  itemId: string,
  ownerId: string,
  now: Date,
  requireLease: boolean,
): Promise<boolean> => {
  const at = nowParam(now);
  const drafts = await db.query(
    `SELECT 1 FROM community.media_item_refs r
     JOIN community.work_drafts d ON d.id=r.holder_id AND d.owner_id=$2
     WHERE r.item_id=$1 AND r.holder_kind='draft' AND d.state='active'
     LIMIT 1`,
    [itemId, ownerId],
  );
  const renewed = await db.query(
    `UPDATE community.publishing_sessions s
     SET lease_expires_at=$3::timestamptz + make_interval(mins => st.unsaved_session_lease_minutes)
     FROM community.media_item_refs r, community.work_publishing_settings st
     WHERE st.id='settings' AND r.item_id=$1 AND r.holder_kind='session' AND r.holder_id=s.id
       AND s.owner_id=$2 AND s.state='active' AND s.lease_expires_at >= $3::timestamptz
     RETURNING s.id`,
    [itemId, ownerId, at],
  );
  if ((drafts.rowCount ?? 0) > 0 || (renewed.rowCount ?? 0) > 0) return true;
  if (requireLease) return false;
  const lapsed = await db.query(
    `SELECT 1 FROM community.publishing_sessions s
     JOIN community.media_item_refs r ON r.holder_id=s.id AND r.holder_kind='session'
     WHERE r.item_id=$1 AND s.owner_id=$2 AND s.state='active'
     LIMIT 1 FOR UPDATE OF s`,
    [itemId, ownerId],
  );
  return (lapsed.rowCount ?? 0) > 0;
};

/** WorkPublishingPort.beginComponentUpload */
export const beginComponentUpload = async (
  pool: Pool,
  actorId: string,
  componentId: string,
  start: PublishingUploadStart,
  now: Date,
): Promise<PublishingUploadFence> =>
  actorTransaction(pool, actorId, async (db) => {
    const found = (
      await db.query<{ item_id: string }>(
        "SELECT item_id FROM community.media_components WHERE id=$1 AND owner_id=$2",
        [componentId, actorId],
      )
    ).rows[0];
    if (found === undefined) throw new CommunityNotFoundError();
    // Holders before the item: the lock order expiry and discard also follow.
    const held = await holdAndRenew(db, found.item_id, actorId, now, true);
    const item = await lockItem(db, found.item_id, actorId);
    const component = await lockComponent(db, componentId, found.item_id);
    if (item === undefined || component === undefined)
      throw new CommunityNotFoundError();
    if (item.state !== "awaiting_upload" || item.quality_mode === "legacy")
      throw new CommunityConflictError("The item is not awaiting uploads");
    if (!(
      component.state === "awaiting" ||
      (component.state === "receiving" && start.supersede)
    ))
      throw new CommunityConflictError(
        "The component is not awaiting an upload",
      );
    const declared = safeInteger(component.declared_bytes);
    if (start.contentLength > declared)
      throw new CommunityInputError("component_too_large");
    // Shorter than declared: a generic input error (no failure code fits).
    if (start.contentLength !== declared) throw new CommunityInputError();
    if (!held) throw new CommunityConflictError("The upload holder has ended");
    await db.query(
      `UPDATE community.media_components
       SET state='receiving', upload_attempt=$2::uuid, received_bytes=0, updated_at=$3::timestamptz,
           upload_attempts=COALESCE(upload_attempts, 0) + 1,
           upload_first_started_at=COALESCE(upload_first_started_at, $3::timestamptz)
       WHERE id=$1`,
      [component.id, start.attempt, nowParam(now)],
    );
    return {
      componentId: component.id,
      itemId: item.id,
      ownerId: actorId,
      attempt: start.attempt,
      role: component.role,
      contentType: component.declared_type,
      byteSize: declared,
      purpose:
        item.quality_mode === "original" ? "original" : "standard_master",
    };
  });

const committedResult = async (
  db: PublishingDb,
  fence: PublishingUploadFence,
  sha256: string,
  receivedBytes: number,
): Promise<PublishingUploadCommit> => {
  const item = (await selectMediaItems(db, fence.ownerId, [fence.itemId])).get(
    fence.itemId,
  );
  if (item === undefined) throw new CommunityNotFoundError();
  return {
    status: "committed",
    result: { componentId: fence.componentId, sha256, receivedBytes, item },
  };
};

const sameAttempt = (stored: string | null, fence: string): boolean =>
  stored !== null && stored.toLowerCase() === fence.toLowerCase();

/** Valid, ordered transfer timing as parameters; anything else records nothing. */
const timingParams = (
  timing: PublishingUploadTiming | undefined,
): readonly [string | null, string | null] => {
  if (timing === undefined) return [null, null];
  const first = timing.firstByteAt.getTime();
  const last = timing.lastByteAt.getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first)
    return [null, null];
  return [nowParam(timing.firstByteAt), nowParam(timing.lastByteAt)];
};

/** WorkPublishingPort.commitComponentUpload */
export const commitComponentUpload = async (
  pool: Pool,
  fence: PublishingUploadFence,
  blob: PublishingMediaWriteResult,
  now: Date,
  timing?: PublishingUploadTiming,
): Promise<PublishingUploadCommit> =>
  actorTransaction(pool, fence.ownerId, async (db) => {
    const at = nowParam(now);
    // A transfer still streaming may commit into a session whose lease
    // lapsed (expiry waits for it) without reviving that lease; holders are
    // locked before the item, as expiry and discard do.
    const held = await holdAndRenew(
      db,
      fence.itemId,
      fence.ownerId,
      now,
      false,
    );
    const item = await lockItem(db, fence.itemId, fence.ownerId);
    const component =
      item === undefined
        ? undefined
        : await lockComponent(db, fence.componentId, fence.itemId);
    // A replayed commit (lost response) of a recorded blob must never tell
    // the caller to remove stored bytes.
    const recorded = (
      await db.query<{ component_id: string | null; sha256: string }>(
        `SELECT c.id AS component_id, b.sha256 FROM community.media_blobs b
         LEFT JOIN community.media_components c ON c.blob_id=b.id
         WHERE b.storage_key=$1`,
        [blob.storageKey],
      )
    ).rows[0];
    if (recorded !== undefined) {
      if (item === undefined || recorded.component_id !== fence.componentId)
        throw new CommunityConflictError(
          "The stored blob is recorded for another component",
        );
      return committedResult(db, fence, recorded.sha256, blob.byteSize);
    }
    if (
      item === undefined ||
      component === undefined ||
      item.state === "cancelled" ||
      item.state === "purged" ||
      component.state === "cancelled"
    )
      return { status: "cancelled" };
    if (!held) {
      // The holder ended: this transfer's attempt must not keep the component.
      if (
        component.state === "receiving" &&
        sameAttempt(component.upload_attempt, fence.attempt)
      )
        await db.query(
          "UPDATE community.media_components SET state='awaiting', upload_attempt=NULL, received_bytes=0, updated_at=$2::timestamptz WHERE id=$1",
          [component.id, at],
        );
      return { status: "cancelled" };
    }
    if (
      item.state !== "awaiting_upload" ||
      component.state !== "receiving" ||
      !sameAttempt(component.upload_attempt, fence.attempt)
    )
      return { status: "superseded" };
    const declared = safeInteger(component.declared_bytes);
    if (blob.byteSize !== declared) {
      await db.query(
        "UPDATE community.media_components SET state='awaiting', upload_attempt=NULL, received_bytes=0, updated_at=$2::timestamptz WHERE id=$1",
        [component.id, at],
      );
      return { status: "size_mismatch" };
    }
    const blobId = opaqueId("media-blob");
    await db.query(
      `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'committed',$8::timestamptz)`,
      [
        blobId,
        fence.ownerId,
        item.quality_mode === "original" ? "original" : "standard_master",
        blob.storageKey,
        blob.byteSize,
        blob.sha256,
        component.declared_type,
        at,
      ],
    );
    const reserved = safeInteger(component.reserved_bytes);
    const moved = Math.min(declared, reserved);
    const [firstByteAt, lastByteAt] = timingParams(timing);
    await db.query(
      `UPDATE community.media_components
       SET state='received', upload_attempt=NULL, received_bytes=$2, sha256=$3, blob_id=$4,
           reserved_bytes=reserved_bytes - $5::bigint, updated_at=$6::timestamptz,
           upload_first_byte_at=$7::timestamptz, upload_last_byte_at=$8::timestamptz
       WHERE id=$1`,
      [
        component.id,
        blob.byteSize,
        blob.sha256,
        blobId,
        moved,
        at,
        firstByteAt,
        lastByteAt,
      ],
    );
    await adjustCapacity(
      db,
      fence.ownerId,
      { committed: blob.byteSize, reserved: -moved },
      now,
    );
    const remaining = await db.query(
      "SELECT 1 FROM community.media_components WHERE item_id=$1 AND state NOT IN ('received','verified') LIMIT 1",
      [item.id],
    );
    const complete = (remaining.rowCount ?? 0) === 0;
    await db.query(
      `UPDATE community.media_items
       SET received_total_bytes=received_total_bytes + $2::bigint, updated_at=$3::timestamptz
           ${complete ? ", state='processing', version=version+1" : ""}
       WHERE id=$1`,
      [item.id, blob.byteSize, at],
    );
    if (complete)
      await insertJob(db, { kind: "process_item", subjectId: item.id }, now);
    return committedResult(db, fence, blob.sha256, blob.byteSize);
  });

/** WorkPublishingPort.abortComponentUpload */
export const abortComponentUpload = async (
  pool: Pool,
  fence: PublishingUploadFence,
  now: Date,
): Promise<void> => {
  // No actor lock: a transfer of a meanwhile suspended account still releases its attempt.
  await writeTransaction(pool, (db) =>
    db.query(
      `UPDATE community.media_components
       SET state='awaiting', upload_attempt=NULL, received_bytes=0, updated_at=$4::timestamptz
       WHERE id=$1 AND item_id=$2 AND state='receiving' AND upload_attempt=$3::uuid`,
      [fence.componentId, fence.itemId, fence.attempt, nowParam(now)],
    ),
  );
};

/** WorkPublishingPort.noteUploadRefusedAfterCommit */
export const noteUploadRefusedAfterCommit = async (
  pool: Pool,
  actorId: string,
  componentId: string,
  now: Date,
): Promise<Date | null> => {
  // Measurement only: one component row, no actor or holder lock, and
  // updated_at stays as it was (expiry and sweeps read it).
  const noted = await writeTransaction(pool, (db) =>
    db.query<{ committed_at: Date }>(
      `UPDATE community.media_components c
       SET upload_refusals_after_commit=COALESCE(c.upload_refusals_after_commit, 0) + 1,
           upload_first_refusal_after_commit_at=COALESCE(c.upload_first_refusal_after_commit_at, $3::timestamptz)
       FROM community.media_blobs b
       WHERE c.id=$1 AND c.owner_id=$2 AND c.state IN ('received','verified')
         AND b.id=c.blob_id AND b.owner_id=c.owner_id
       RETURNING b.created_at AS committed_at`,
      [componentId, actorId, nowParam(now)],
    ),
  );
  return noted.rows[0]?.committed_at ?? null;
};
