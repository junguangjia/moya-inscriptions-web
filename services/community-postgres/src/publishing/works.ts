import type { MentionReference } from "@moya/contracts";
import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import { editableWorkSchema } from "@moya/contracts/schemas";
import type {
  EditableWork,
  MediaCrop,
  MediaEdit,
  PublishingMediaItem,
  WorkVisibilityCommand,
  WorkVisibilityResult,
} from "@moya/contracts";
import type {
  PublishingCommandIdentity,
  PublishingTrashPurge,
} from "@moya/api";
import type { Pool, QueryResultRow } from "pg";

import {
  authorCommand,
  isoOrNull,
  nowParam,
  publishingAuthorActions,
  readTransaction,
  selectSettings,
  writeTransaction,
} from "./db.js";
import type { PublishingDb } from "./db.js";
import { revisionAuthorship } from "./authorship.js";
import type { RevisionAuthorshipColumns } from "./authorship.js";
import { insertJob } from "./jobs.js";
import { eraseUnreferencedLegacyMedia } from "./permanent-media.js";
import { cancelItems, releaseHolderRefs, selectMediaItems } from "./media.js";
import { clipboardOriginSql } from "./media-read.js";
import {
  applyPublicRevision,
  closePendingRevisions,
  touchWork,
  withholdReplacedPublicRevision,
} from "./submissions.js";

/*
 * Author work reads, visibility changes, permanent deletion and legacy
 * retention cleanup. Every author command runs under the
 * actor lock with its receipt and audit row (./db.ts authorCommand).
 */

const activeActor = async (db: PublishingDb, actorId: string) => {
  const active = await db.query(
    "SELECT id FROM community.public_users WHERE id=$1 AND status='active'",
    [actorId],
  );
  if (active.rowCount !== 1) throw new CommunityNotFoundError();
};

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

/** Public presentation facts only; private facts such as display rotation stay stored. */
export const presentationDto = (
  kind: "static" | "live",
  stored: Record<string, unknown> | null,
): PublishingMediaItem["presentation"] => {
  const width = positiveInteger(stored?.width);
  const height = positiveInteger(stored?.height);
  if (stored === null || width === null || height === null) return null;
  const durationMs = positiveInteger(stored.durationMs);
  return {
    width,
    height,
    ...(kind === "live" && durationMs !== null ? { durationMs } : {}),
    ...(kind === "live" && typeof stored.hasAudio === "boolean"
      ? { hasAudio: stored.hasAudio }
      : {}),
  };
};

interface EditableWorkRow extends QueryResultRow {
  id: string;
  author_revision_id: string | null;
  visibility: "public" | "self";
  first_published_at: Date | null;
  edited_at: Date | null;
  version: number;
}

interface RevisionRow extends QueryResultRow, RevisionAuthorshipColumns {
  id: string;
  title: string;
  body: string;
  mentions: MentionReference[];
  cover_item_id: string | null;
  cover_crop: MediaCrop | null;
}

interface RevisionItemRow extends QueryResultRow {
  item_id: string;
  edit: MediaEdit;
  kind: "static" | "live";
  quality_mode: "standard" | "original" | "legacy";
  clipboard: boolean;
}

/** WorkPublishingPort.readEditableWork */
export const readEditableWork = async (
  pool: Pool,
  actorId: string,
  workId: string,
): Promise<EditableWork> =>
  readTransaction(pool, async (db) => {
    await activeActor(db, actorId);
    const work = (
      await db.query<EditableWorkRow>(
        "SELECT id,author_revision_id,visibility,first_published_at,edited_at,version FROM community.works WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL AND trashed_at IS NULL",
        [workId, actorId],
      )
    ).rows[0];
    if (work === undefined || work.author_revision_id === null)
      throw new CommunityNotFoundError();
    const revision = (
      await db.query<RevisionRow>(
        "SELECT id,title,body,mentions,authorship_kind,reference_title,original_author,source_note,cover_item_id,cover_crop FROM community.work_revisions WHERE id=$1",
        [work.author_revision_id],
      )
    ).rows[0];
    if (revision === undefined) throw new CommunityNotFoundError();
    const items = (
      await db.query<RevisionItemRow>(
        `SELECT ri.item_id,ri.edit,i.kind,i.quality_mode,${clipboardOriginSql("i")} AS clipboard FROM community.work_revision_items ri JOIN community.media_items i ON i.id=ri.item_id WHERE ri.revision_id=$1 ORDER BY ri.position`,
        [revision.id],
      )
    ).rows;
    const draft = (
      await db.query<{ id: string }>(
        "SELECT id FROM community.work_drafts WHERE owner_id=$1 AND work_id=$2 AND state='active' AND conflict_of IS NULL",
        [actorId, workId],
      )
    ).rows[0];
    return editableWorkSchema.parse({
      workId: work.id,
      revisionId: revision.id,
      content: {
        title: revision.title,
        body: revision.body,
        ...(revision.mentions.length ? { mentions: revision.mentions } : {}),
        authorship: revisionAuthorship(revision),
        visibility: work.visibility,
        items: items.map((item) => ({
          key: item.item_id,
          itemId: item.item_id,
          kind: item.kind,
          qualityMode: item.quality_mode,
          edit: item.edit,
          ...(item.clipboard ? { origin: "clipboard" } : {}),
        })),
        coverKey: revision.cover_item_id,
        coverCrop: revision.cover_item_id === null ? null : revision.cover_crop,
      },
      // The owner's item view (base derivative paths, as drafts show them).
      mediaItems: await (async () => {
        const byId = await selectMediaItems(
          db,
          actorId,
          items.map((item) => item.item_id),
        );
        return items.flatMap((item) => {
          const dto = byId.get(item.item_id);
          return dto === undefined ? [] : [dto];
        });
      })(),
      visibility: work.visibility,
      firstPublishedAt: isoOrNull(work.first_published_at),
      editedAt: isoOrNull(work.edited_at),
      draftId: draft?.id ?? null,
      version: work.version,
    });
  });

interface LockedWorkRow extends QueryResultRow {
  id: string;
  visibility: "public" | "self";
  author_revision_id: string | null;
  trashed_at: Date | null;
  trash_purge_after: Date | null;
  deleted_at: Date | null;
  operator_state: "visible" | "hidden" | "removed";
}

/** Locks the actor's work that is not purged; anything else is not found. */
const lockOwnWork = async (
  db: PublishingDb,
  actorId: string,
  workId: string,
): Promise<LockedWorkRow> => {
  const work = (
    await db.query<LockedWorkRow>(
      "SELECT id,visibility,author_revision_id,trashed_at,trash_purge_after,deleted_at,operator_state FROM community.works WHERE id=$1 AND author_id=$2 FOR UPDATE",
      [workId, actorId],
    )
  ).rows[0];
  if (work === undefined || work.deleted_at !== null)
    throw new CommunityNotFoundError();
  return work;
};

const workUnavailable = (): never => {
  throw new CommunityInputError("work_unavailable");
};

/** WorkPublishingPort.setVisibility */
export const setVisibility = async (
  pool: Pool,
  actorId: string,
  workId: string,
  command: WorkVisibilityCommand,
  now: Date,
): Promise<WorkVisibilityResult> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.setVisibility,
      subjectId: workId,
      input: command,
      now,
    },
    async (db) => {
      const work = await lockOwnWork(db, actorId, workId);
      if (work.trashed_at !== null || work.operator_state === "removed")
        workUnavailable();
      const result = { workId, visibility: command.visibility };
      if (command.visibility === "self") {
        // Third-party access ends with this commit; public intent is withdrawn.
        await closePendingRevisions(db, workId, "withdrawn");
        if (work.visibility !== "self") {
          await db.query(
            "UPDATE community.works SET visibility='self' WHERE id=$1",
            [workId],
          );
          await touchWork(db, workId, now);
        }
        return result;
      }
      if (work.visibility === "public") return result;
      if (work.author_revision_id === null)
        throw new CommunityConflictError("The work has no revision");
      const settings = await selectSettings(db, "share");
      const revision = (
        await db.query<{ disposition: string }>(
          "SELECT disposition FROM community.work_revisions WHERE id=$1 FOR UPDATE",
          [work.author_revision_id],
        )
      ).rows[0];
      if (revision === undefined) throw new CommunityNotFoundError();
      // Re-publication is a new public intent, even for unchanged content
      // approved before the work became self-only. Apply the current policy.
      if (settings.policy === "DIRECT_PUBLICATION") {
        await closePendingRevisions(
          db,
          workId,
          "superseded",
          work.author_revision_id,
        );
        await db.query(
          "UPDATE community.work_revisions SET disposition='approved',decided_at=$2::timestamptz,decided_by=NULL,version=version+1 WHERE id=$1",
          [work.author_revision_id, nowParam(now)],
        );
        await applyPublicRevision(db, workId, work.author_revision_id, now);
      } else {
        await closePendingRevisions(
          db,
          workId,
          "superseded",
          work.author_revision_id,
        );
        if (revision.disposition !== "pending")
          await db.query(
            "UPDATE community.work_revisions SET disposition='pending',decided_at=NULL,decided_by=NULL,version=version+1 WHERE id=$1",
            [work.author_revision_id],
          );
        // Public intent is recorded; others see nothing replaced while the
        // work was self-only until the pending revision is approved.
        await db.query(
          "UPDATE community.works SET visibility='public' WHERE id=$1",
          [workId],
        );
        await withholdReplacedPublicRevision(
          db,
          workId,
          work.author_revision_id,
        );
      }
      await touchWork(db, workId, now);
      return result;
    },
  );

/**
 * Permanently deletes only the authenticated author's work. The remaining work
 * identity is a content-free tombstone for discussions and audit references;
 * there is no restore operation. Byte deletion runs through the existing worker.
 */
export const deleteWork = async (
  pool: Pool,
  actorId: string,
  workId: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<{ readonly deleted: true }> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.deleteWork,
      subjectId: workId,
      input: command,
      now,
    },
    async (db) => {
      // Same lock order as submission and the legacy retention worker: holders
      // before work, then media. The account lock serializes the author's writes.
      await db.query(
        "SELECT id FROM community.publishing_sessions WHERE work_id=$1 AND owner_id=$2 ORDER BY id FOR UPDATE",
        [workId, actorId],
      );
      const drafts = (
        await db.query<{ id: string }>(
          "SELECT id FROM community.work_drafts WHERE work_id=$1 AND owner_id=$2 ORDER BY id FOR UPDATE",
          [workId, actorId],
        )
      ).rows.map((row) => row.id);
      await lockOwnWork(db, actorId, workId);
      // Finished legacy drafts were never backfilled into media_items. Capture
      // their native media IDs before erasing the only remaining content rows.
      const legacyMediaIds = (
        await db.query<{ id: string }>(
          `SELECT unnest(media_ids) AS id FROM community.works WHERE id=$1
           UNION SELECT unnest(media_ids) FROM community.work_edit_drafts WHERE work_id=$1`,
          [workId],
        )
      ).rows.map((row) => row.id);
      const holders = (
        await db.query<{
          kind: "revision" | "draft" | "snapshot" | "session";
          id: string;
        }>(
          `SELECT 'revision'::text AS kind,id FROM community.work_revisions WHERE work_id=$1
           UNION ALL SELECT 'draft',id FROM community.work_drafts WHERE work_id=$1
           UNION ALL SELECT 'snapshot',id FROM community.work_draft_snapshots WHERE work_id=$1 OR draft_id=ANY($2::text[])
           UNION ALL SELECT 'session',id FROM community.publishing_sessions WHERE work_id=$1`,
          [workId, drafts],
        )
      ).rows;
      const released = await releaseHolderRefs(
        db,
        (["revision", "draft", "snapshot", "session"] as const).map((kind) => ({
          holderKind: kind,
          holderIds: holders
            .filter((holder) => holder.kind === kind)
            .map((holder) => holder.id),
        })),
        now,
      );
      const at = nowParam(now);
      await db.query(
        `UPDATE community.works SET title='',text='',media_ids='{}',
          public_revision_id=NULL,author_revision_id=NULL,visibility='self',
          trashed_at=NULL,trash_purge_after=NULL,deleted_at=$2::timestamptz,
          updated_at=$2::timestamptz,version=version+1 WHERE id=$1`,
        [workId, at],
      );
      await db.query(
        "DELETE FROM community.work_draft_snapshots WHERE work_id=$1 OR draft_id=ANY($2::text[])",
        [workId, drafts],
      );
      await db.query(
        `UPDATE community.publishing_sessions SET state=CASE WHEN state='active' THEN 'discarded' ELSE state END,
          ended_at=CASE WHEN state='active' THEN $2::timestamptz ELSE ended_at END,draft_id=NULL
         WHERE work_id=$1 OR draft_id=ANY($3::text[])`,
        [workId, at, drafts],
      );
      await db.query(
        "DELETE FROM community.work_drafts WHERE work_id=$1 OR conflict_of=ANY($2::text[])",
        [workId, drafts],
      );
      await db.query(
        "DELETE FROM community.work_edit_drafts WHERE work_id=$1",
        [workId],
      );
      await db.query(
        "DELETE FROM community.work_revision_items WHERE revision_id IN (SELECT id FROM community.work_revisions WHERE work_id=$1)",
        [workId],
      );
      await db.query("DELETE FROM community.work_revisions WHERE work_id=$1", [
        workId,
      ]);
      // Earlier Phase 4 edit receipts could contain a full draft. Preserve the
      // receipt identity/fingerprint but erase its payload and refuse replay.
      await db.query(
        `UPDATE community.author_command_receipts SET result='{"permanentlyDeleted":true}'::jsonb
         WHERE actor_id=$1 AND (result->>'workId'=$2 OR result->>'work_id'=$2)
           AND (result ? 'content' OR result ? 'title' OR result ? 'text' OR result ? 'body')`,
        [actorId, workId],
      );
      await db.query(
        `UPDATE community.content_operator_receipts SET result='{"permanentlyDeleted":true}'::jsonb
         WHERE (result->>'id'=$1 OR result->>'workId'=$1)
           AND (result ? 'title' OR result ? 'text' OR result ? 'body' OR result ? 'content')`,
        [workId],
      );
      await db.query(
        `UPDATE community.content_operator_events
         SET detail=jsonb_set(detail,'{result}','{"permanentlyDeleted":true}'::jsonb)
         WHERE content_type='work' AND content_id=$1
           AND (detail->'result' ? 'title' OR detail->'result' ? 'text'
             OR detail->'result' ? 'body' OR detail->'result' ? 'content')`,
        [workId],
      );
      await cancelItems(db, released, now, { onlyUnreferenced: true });
      await eraseUnreferencedLegacyMedia(
        db,
        actorId,
        released,
        now,
        legacyMediaIds,
      );
      // Superseded queued retention work must not keep an unnecessary timer.
      await db.query(
        "DELETE FROM community.publishing_jobs WHERE kind='purge_trashed_work' AND subject_id=$1 AND state='queued'",
        [workId],
      );
      return { deleted: true } as const;
    },
  );

/** WorkPublishingPort.purgeTrashedWork */
export const purgeTrashedWork = async (
  pool: Pool,
  workId: string,
  now: Date,
): Promise<PublishingTrashPurge> =>
  writeTransaction(pool, async (db) => {
    const at = nowParam(now);
    // Holders before the work, in the order author submissions lock them.
    await db.query(
      "SELECT id FROM community.publishing_sessions WHERE work_id=$1 ORDER BY id FOR UPDATE",
      [workId],
    );
    const drafts = (
      await db.query<{ id: string }>(
        "SELECT id FROM community.work_drafts WHERE work_id=$1 ORDER BY id FOR UPDATE",
        [workId],
      )
    ).rows.map((row) => row.id);
    const work = (
      await db.query<{
        due: boolean | null;
        trashed: boolean;
        deleted: boolean;
      }>(
        "SELECT trash_purge_after<=$2::timestamptz AS due,trashed_at IS NOT NULL AS trashed,deleted_at IS NOT NULL AS deleted FROM community.works WHERE id=$1 FOR UPDATE",
        [workId, at],
      )
    ).rows[0];
    if (work === undefined || work.deleted) return "missing";
    if (!work.trashed || work.due !== true) return "not_due";
    await db.query(
      "UPDATE community.works SET deleted_at=$2::timestamptz,updated_at=$2::timestamptz,version=version+1 WHERE id=$1",
      [workId, at],
    );
    await closePendingRevisions(db, workId, "withdrawn");
    const holders = (
      await db.query<{
        kind: "revision" | "draft" | "snapshot" | "session";
        id: string;
      }>(
        `SELECT 'revision'::text AS kind,id FROM community.work_revisions WHERE work_id=$1
        UNION ALL SELECT 'draft',id FROM community.work_drafts WHERE work_id=$1 OR conflict_of=ANY($2::text[])
        UNION ALL SELECT 'snapshot',id FROM community.work_draft_snapshots WHERE work_id=$1 OR draft_id=ANY($2::text[])
        UNION ALL SELECT 'session',id FROM community.publishing_sessions WHERE work_id=$1`,
        [workId, drafts],
      )
    ).rows;
    // Items any revision of the work held (submitted content) keep the
    // orphan grace; the rest only this work's drafts, history and sessions
    // held, which end here like a draft deletion.
    const submitted = new Set(
      (
        await db.query<{ item_id: string }>(
          "SELECT DISTINCT ri.item_id FROM community.work_revision_items ri JOIN community.work_revisions r ON r.id=ri.revision_id WHERE r.work_id=$1",
          [workId],
        )
      ).rows.map((row) => row.item_id),
    );
    // Every holder lets go of its items in one item lock pass; each released
    // live item waits the whole orphan grace from now (T02, T05).
    const released = await releaseHolderRefs(
      db,
      (["revision", "draft", "snapshot", "session"] as const).map((kind) => ({
        holderKind: kind,
        holderIds: holders
          .filter((holder) => holder.kind === kind)
          .map((holder) => holder.id),
      })),
      now,
    );
    await db.query(
      "DELETE FROM community.work_draft_snapshots WHERE id=ANY($1::text[])",
      [
        holders
          .filter((holder) => holder.kind === "snapshot")
          .map((holder) => holder.id),
      ],
    );
    await db.query(
      `UPDATE community.publishing_sessions SET state=CASE WHEN state='active' THEN 'discarded' ELSE state END,
        ended_at=CASE WHEN state='active' THEN $2::timestamptz ELSE ended_at END,draft_id=NULL
      WHERE work_id=$1 OR draft_id=ANY($3::text[])`,
      [workId, at, drafts],
    );
    // Draft rows and their conflict copies go with their content, as a
    // draft deletion removes them (no content outlives the purged work).
    await db.query(
      "DELETE FROM community.work_drafts WHERE id=ANY($1::text[]) OR conflict_of=ANY($1::text[])",
      [drafts],
    );
    const orphaned = (
      await db.query<{ id: string; cancelled: boolean }>(
        `SELECT i.id,i.state='cancelled' AS cancelled FROM community.media_items i
        WHERE i.id=ANY($1::text[]) AND i.state<>'purged'
          AND NOT EXISTS (SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id)
        ORDER BY i.id`,
        [released],
      )
    ).rows;
    // Unsubmitted media nothing else holds is cancelled at once (reservations
    // released, transfers fenced, purge now).
    await cancelItems(
      db,
      orphaned.filter((item) => !submitted.has(item.id)).map((item) => item.id),
      now,
      { onlyUnreferenced: true },
    );
    // A purge before the grace ends would only answer `referenced`; the time
    // uses the same SQL interval arithmetic as purge_item's recheck.
    const afterGrace = (
      await db.query<{ run_after: Date }>(
        "SELECT $1::timestamptz+make_interval(days=>orphan_grace_days)+interval '1 second' AS run_after FROM community.work_publishing_settings WHERE id='settings' FOR SHARE",
        [at],
      )
    ).rows[0]!.run_after;
    for (const item of orphaned)
      if (submitted.has(item.id))
        await insertJob(
          db,
          {
            kind: "purge_item",
            subjectId: item.id,
            runAfter: item.cancelled ? now : afterGrace,
          },
          now,
        );
    return "purged";
  });
