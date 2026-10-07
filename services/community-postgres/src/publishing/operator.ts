import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import { WORK_ITEMS_CONFIGURABLE_MAXIMUM } from "@moya/contracts/schemas";
import {
  operatorPublishingJobPageSchema,
  operatorPublishingJobSchema,
  operatorWorkSubmissionPageSchema,
  operatorWorkSubmissionSchema,
  workSubmissionModerationResultSchema,
} from "@moya/contracts/internal/community-operator";
import type { MediaCrop, MediaEdit, MediaVariant } from "@moya/contracts";
import type {
  ModerateWorkSubmissionCommand,
  OperatorAccountCapacity,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorPublishingJobQuery,
  OperatorSubmissionMedia,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  OperatorWorkSubmissionQuery,
  SetAccountCapacityClassCommand,
  SetWorkPublishingSettingsCommand,
  WorkPublishingSettings,
  WorkSubmissionModerationResult,
} from "@moya/contracts/internal/community-operator";
import type {
  PublishingCommandIdentity,
  PublishingOperatorPort,
} from "@moya/api";
import type { Pool, QueryResultRow } from "pg";

import {
  capacityDto,
  isoOrNull,
  nowParam,
  operatorCommand,
  pageBounds,
  pageOf,
  publishingOperatorActions,
  readTransaction,
  selectCapacity,
  selectSettings,
} from "./db.js";
import type { PublishingDb } from "./db.js";
import { failProcessingItems } from "./jobs.js";
import { mediaReadTarget, variantEditKeySql } from "./media-read.js";
import type { MediaReadTargetRow } from "./media-read.js";
import { applyPublicRevision, touchWork } from "./submissions.js";
import { revisionAuthorship } from "./authorship.js";
import type { RevisionAuthorshipColumns } from "./authorship.js";
import { presentationDto } from "./works.js";

/*
 * Operator work publishing commands: the independent policy and limits, the
 * explicit submission queue with latest-only moderation (P08), operator media
 * reads, account capacity designation and content-free job outcomes. Every
 * command is serialized with the other content operator commands and writes
 * its receipt and one content_operator_events row (./db.ts operatorCommand).
 */

/** PublishingOperatorPort.readSettings */
export const readSettings = async (
  pool: Pool,
): Promise<WorkPublishingSettings> =>
  readTransaction(pool, (db) => selectSettings(db));

/** PublishingOperatorPort.setSettings */
export const setSettings = async (
  pool: Pool,
  operator: string,
  command: SetWorkPublishingSettingsCommand,
  now: Date,
): Promise<WorkPublishingSettings> => {
  const settings = await operatorCommand(
    pool,
    {
      operator,
      requestId: command.requestId,
      action: publishingOperatorActions.setSettings,
      target: { type: "work_publishing_settings", id: "settings" },
      input: command,
      now,
    },
    async (db) => {
      // The contract bound, kept here too: storage alone admits up to 500.
      if (
        !Number.isSafeInteger(command.maxItemsPerWork) ||
        command.maxItemsPerWork < 1 ||
        command.maxItemsPerWork > WORK_ITEMS_CONFIGURABLE_MAXIMUM
      )
        throw new CommunityInputError("items_limit");
      const current = await selectSettings(db, "update");
      if (current.version !== command.expectedVersion)
        throw new CommunityConflictError("Work publishing settings changed");
      await db.query(
        `UPDATE community.work_publishing_settings SET publication_policy=$1,max_items_per_work=$2,
          original_item_max_bytes=$3,standard_component_max_bytes=$4,ordinary_account_capacity_bytes=$5,
          owner_account_capacity_bytes=$6,max_active_drafts=$7,daily_new_work_limit=$8,history_limit=$9,
          trash_retention_days=$10,orphan_grace_days=$11,unsaved_session_lease_minutes=$12,
          version=version+1,updated_at=$13::timestamptz,updated_by=$14
        WHERE id='settings'`,
        [
          command.policy,
          command.maxItemsPerWork,
          command.originalItemMaxBytes,
          command.standardComponentMaxBytes,
          command.ordinaryAccountCapacityBytes,
          command.ownerAccountCapacityBytes,
          command.maxActiveDrafts,
          command.dailyNewWorkLimit,
          command.historyLimit,
          command.trashRetentionDays,
          command.orphanGraceDays,
          command.unsavedSessionLeaseMinutes,
          nowParam(now),
          operator,
        ],
      );
      return selectSettings(db);
    },
  );
  // A receipt written before the configurable maximum existed may replay a
  // larger value; it is enforced as that maximum, like the stored setting.
  return {
    ...settings,
    maxItemsPerWork: Math.min(
      settings.maxItemsPerWork,
      WORK_ITEMS_CONFIGURABLE_MAXIMUM,
    ),
  };
};

interface SubmissionRow extends QueryResultRow, RevisionAuthorshipColumns {
  id: string;
  work_id: string;
  sequence: number;
  origin: "submission" | "legacy";
  author_id: string;
  handle: string;
  display_name: string;
  author_status: "active" | "suspended";
  title: string;
  body: string;
  cover_item_id: string | null;
  cover_crop: MediaCrop | null;
  disposition: OperatorWorkSubmission["disposition"];
  latest: boolean;
  operator_state: "visible" | "hidden" | "removed";
  trashed: boolean;
  submitted_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  version: number;
}

/** Queue-visible revisions: explicit or legacy, never self-only, of works that are not purged. */
const submissionFrom = `FROM community.work_revisions r
  JOIN community.works w ON w.id=r.work_id
  JOIN community.public_users u ON u.id=r.author_id
  WHERE r.disposition<>'not_required' AND w.deleted_at IS NULL`;

const submissionProjection = `SELECT r.id,r.work_id,r.sequence,r.origin,r.author_id,u.handle,u.display_name,
  u.status AS author_status,r.title,r.body,r.authorship_kind,r.reference_title,r.original_author,r.source_note,
  r.cover_item_id,r.cover_crop,r.disposition,r.id=w.author_revision_id AS latest,w.operator_state,
  w.trashed_at IS NOT NULL AS trashed,r.submitted_at,r.decided_at,r.decided_by,r.version`;

interface SubmissionItemRow extends QueryResultRow {
  revision_id: string;
  position: number;
  item_id: string;
  edit: MediaEdit;
  kind: "static" | "live";
  quality_mode: "standard" | "original" | "legacy";
  state: OperatorSubmissionMedia["state"];
  presentation: Record<string, unknown> | null;
  edit_key: string;
  cover_edit_key: string | null;
  variants: MediaVariant[];
  legacy_display: boolean;
}

/**
 * Each item is described under the edit key of its own edit (`editKey`, for
 * display, full and motion); the revision's cover item also names the key of
 * its edit with the revision cover crop (`coverEditKey`, for thumb and
 * cover), null for other items. `variants` lists every derivative the
 * revision shows. The operator media read resolves a variant of a revision
 * item by either key.
 */
const submissionDtos = async (
  db: PublishingDb,
  rows: readonly SubmissionRow[],
): Promise<OperatorWorkSubmission[]> => {
  const items = (
    await db.query<SubmissionItemRow>(
      `SELECT ri.revision_id,ri.position,ri.item_id,ri.edit,i.kind,i.quality_mode,i.state,i.presentation,k.edit_key,
        (i.quality_mode='legacy' AND i.state='ready' AND k.edit_key='base' AND i.owner_id=r.author_id AND EXISTS (
          SELECT 1 FROM community.user_media m WHERE m.id=i.legacy_media_id AND m.owner_id=i.owner_id
            AND m.mime_type='image/png')) AS legacy_display,
        CASE WHEN ri.item_id=r.cover_item_id THEN community.media_edit_key(ri.edit,r.cover_crop) END AS cover_edit_key,
        ARRAY(
          SELECT d.role FROM community.media_renditions d
          JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
          WHERE d.item_id=ri.item_id AND d.state='ready'
            AND d.role=ANY(ARRAY['thumb','display','full','cover','motion']::text[])
            AND d.edit_key=${variantEditKeySql("d.role", "ri", "r")}
          ORDER BY array_position(ARRAY['thumb','display','full','cover','motion']::text[],d.role)
        ) AS variants
      FROM community.work_revision_items ri
      JOIN community.work_revisions r ON r.id=ri.revision_id
      JOIN community.media_items i ON i.id=ri.item_id
      CROSS JOIN LATERAL (SELECT community.media_edit_key(ri.edit,NULL) AS edit_key) k
      WHERE ri.revision_id=ANY($1::text[])
      ORDER BY ri.revision_id,ri.position`,
      [rows.map((row) => row.id)],
    )
  ).rows;
  return rows.map((row) =>
    operatorWorkSubmissionSchema.parse({
      revisionId: row.id,
      workId: row.work_id,
      sequence: row.sequence,
      origin: row.origin,
      author: {
        id: row.author_id,
        handle: row.handle,
        displayName: row.display_name,
        status: row.author_status,
      },
      title: row.title,
      body: row.body,
      authorship: revisionAuthorship(row),
      coverItemId: row.cover_item_id,
      coverCrop: row.cover_item_id === null ? null : row.cover_crop,
      items: items
        .filter((item) => item.revision_id === row.id)
        .map((item) => ({
          position: item.position,
          itemId: item.item_id,
          kind: item.kind,
          qualityMode: item.quality_mode,
          state: item.state,
          edit: item.edit,
          editKey: item.edit_key,
          coverEditKey: item.cover_edit_key,
          presentation: presentationDto(item.kind, item.presentation),
          variants: [
            ...new Set([
              ...item.variants,
              ...(item.legacy_display ? ["display"] : []),
            ]),
          ],
        })),
      disposition: row.disposition,
      latest: row.latest,
      workState: row.operator_state,
      workTrashed: row.trashed,
      submittedAt: row.submitted_at.toISOString(),
      decidedAt: isoOrNull(row.decided_at),
      decidedBy: row.decided_by,
      version: row.version,
    }),
  );
};

/** PublishingOperatorPort.listSubmissions */
export const listSubmissions = async (
  pool: Pool,
  query: OperatorWorkSubmissionQuery,
): Promise<OperatorWorkSubmissionPage> =>
  readTransaction(pool, async (db) => {
    // The queue holds explicit submissions only; legacy baselines are readable
    // by id but never queued.
    const where = `${submissionFrom} AND r.origin='submission' AND ($1::text IS NULL OR r.disposition=$1::text)`;
    const state = query.state ?? null;
    const total = Number(
      (
        await db.query<{ total: string }>(`SELECT count(*) AS total ${where}`, [
          state,
        ])
      ).rows[0]?.total ?? 0,
    );
    const { limit, offset } = pageBounds(query);
    const order =
      state === "pending"
        ? "r.submitted_at ASC,r.id ASC"
        : "r.submitted_at DESC,r.id DESC";
    const rows = (
      await db.query<SubmissionRow>(
        `${submissionProjection} ${where} ORDER BY ${order} LIMIT $2 OFFSET $3`,
        [state, limit, offset],
      )
    ).rows;
    return operatorWorkSubmissionPageSchema.parse(
      pageOf(await submissionDtos(db, rows), total, query),
    );
  });

/** PublishingOperatorPort.readSubmission */
export const readSubmission = async (
  pool: Pool,
  revisionId: string,
): Promise<OperatorWorkSubmission> =>
  readTransaction(pool, async (db) => {
    const row = (
      await db.query<SubmissionRow>(
        `${submissionProjection} ${submissionFrom} AND r.id=$1`,
        [revisionId],
      )
    ).rows[0];
    if (row === undefined) throw new CommunityNotFoundError();
    const [submission] = await submissionDtos(db, [row]);
    return submission!;
  });

interface ModerationRow extends QueryResultRow {
  work_id: string;
  author_revision_id: string | null;
  trashed: boolean;
  deleted: boolean;
  disposition: string;
  version: number;
}

/** PublishingOperatorPort.moderateSubmission */
export const moderateSubmission = async (
  pool: Pool,
  revisionId: string,
  operator: string,
  command: ModerateWorkSubmissionCommand,
  now: Date,
): Promise<WorkSubmissionModerationResult> =>
  operatorCommand(
    pool,
    {
      operator,
      requestId: command.requestId,
      action: publishingOperatorActions.moderateSubmission,
      target: { type: "work_revision", id: revisionId },
      input: command,
      now,
    },
    async (db) => {
      const workId = (
        await db.query<{ work_id: string }>(
          "SELECT work_id FROM community.work_revisions WHERE id=$1",
          [revisionId],
        )
      ).rows[0]?.work_id;
      if (workId === undefined) throw new CommunityNotFoundError();
      // Work first, then revision: the same order as author submissions.
      await db.query("SELECT id FROM community.works WHERE id=$1 FOR UPDATE", [
        workId,
      ]);
      const row = (
        await db.query<ModerationRow>(
          `SELECT r.work_id,w.author_revision_id,w.trashed_at IS NOT NULL AS trashed,w.deleted_at IS NOT NULL AS deleted,
            r.disposition,r.version
          FROM community.work_revisions r JOIN community.works w ON w.id=r.work_id
          WHERE r.id=$1 FOR UPDATE OF r`,
          [revisionId],
        )
      ).rows[0];
      if (row === undefined || row.disposition === "not_required")
        throw new CommunityNotFoundError();
      if (
        row.disposition !== "pending" ||
        row.author_revision_id !== revisionId ||
        row.version !== command.expectedVersion ||
        row.trashed ||
        row.deleted
      )
        throw new CommunityConflictError(
          "The submission is no longer the pending latest submission",
        );
      const disposition =
        command.action === "approve" ? "approved" : "rejected";
      const version = (
        await db.query<{ version: number }>(
          "UPDATE community.work_revisions SET disposition=$2,decided_at=$3::timestamptz,decided_by=$4,version=version+1 WHERE id=$1 RETURNING version",
          [revisionId, disposition, nowParam(now), operator],
        )
      ).rows[0]!.version;
      if (disposition === "approved") {
        await applyPublicRevision(db, row.work_id, revisionId, now);
        await touchWork(db, row.work_id, now);
      }
      return workSubmissionModerationResultSchema.parse({
        revisionId,
        workId: row.work_id,
        disposition,
        version,
      });
    },
  );

/**
 * PublishingOperatorPort.resolveMediaRead: the committed derivative a
 * queue-visible revision shows for one of its items. `editKey` is the item
 * edit key the submission DTO lists (or the derivative's own key); thumb and
 * cover of a cropped cover item resolve to their cover-crop derivatives.
 */
export const resolveMediaRead = async (
  pool: Pool,
  revisionId: string,
  itemId: string,
  variant: MediaVariant,
  editKey: string,
): ReturnType<PublishingOperatorPort["resolveMediaRead"]> =>
  readTransaction(pool, async (db) => {
    const derivative = mediaReadTarget(
      (
        await db.query<MediaReadTargetRow>(
          `SELECT b.storage_key,d.content_type,b.byte_size,b.sha256
          FROM community.work_revisions r
          JOIN community.works w ON w.id=r.work_id
          JOIN community.work_revision_items ri ON ri.revision_id=r.id AND ri.item_id=$1
          JOIN community.media_items i ON i.id=ri.item_id AND i.state<>'purged'
          JOIN community.media_renditions d ON d.item_id=i.id AND d.role=$2 AND d.state='ready'
            AND d.edit_key=${variantEditKeySql("d.role", "ri", "r")}
          JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
          WHERE r.id=$4 AND r.disposition<>'not_required' AND w.deleted_at IS NULL
            AND $3::text IN (d.edit_key,community.media_edit_key(ri.edit,NULL))`,
          [itemId, variant, editKey, revisionId],
        )
      ).rows[0],
    );
    if (derivative !== null) return derivative;
    if (variant !== "display" || editKey !== "base") return null;
    // Only the selected unedited legacy item of an operator-readable revision.
    // Never use a guessed public URL, an avatar lookup, or a publishing source.
    const row = (
      await db.query<{ bytes: Buffer; sha256: string }>(
        `SELECT m.bytes,m.sha256 FROM community.work_revisions r
       JOIN community.works w ON w.id=r.work_id
       JOIN community.work_revision_items ri ON ri.revision_id=r.id AND ri.item_id=$2
       JOIN community.media_items i ON i.id=ri.item_id AND i.owner_id=r.author_id
         AND i.quality_mode='legacy' AND i.state='ready'
       JOIN community.user_media m ON m.id=i.legacy_media_id AND m.owner_id=i.owner_id AND m.mime_type='image/png'
       WHERE r.id=$1 AND r.disposition<>'not_required' AND w.deleted_at IS NULL
         AND community.media_edit_key(ri.edit,NULL)='base'`,
        [revisionId, itemId],
      )
    ).rows[0];
    return row === undefined
      ? null
      : { legacyPng: row.bytes, sha256: row.sha256 };
  });

/** PublishingOperatorPort.readCapacity */
export const readCapacity = async (
  pool: Pool,
  accountId: string,
): Promise<OperatorAccountCapacity> =>
  readTransaction(pool, async (db) =>
    capacityDto(await selectCapacity(db, accountId)),
  );

/** PublishingOperatorPort.setCapacity */
export const setCapacity = async (
  pool: Pool,
  accountId: string,
  operator: string,
  command: SetAccountCapacityClassCommand,
  now: Date,
): Promise<OperatorAccountCapacity> =>
  operatorCommand(
    pool,
    {
      operator,
      requestId: command.requestId,
      action: publishingOperatorActions.setCapacity,
      target: { type: "account", id: accountId },
      input: command,
      now,
    },
    async (db) => {
      const at = nowParam(now);
      const current = await selectCapacity(db, accountId);
      const changed =
        command.expectedVersion === 0
          ? await db.query(
              `INSERT INTO community.account_publishing_capacity(account_id,capacity_class,updated_at)
              VALUES($1,$2,$3::timestamptz) ON CONFLICT (account_id) DO NOTHING`,
              [accountId, command.capacityClass, at],
            )
          : await db.query(
              `UPDATE community.account_publishing_capacity SET capacity_class=$2,version=version+1,updated_at=$3::timestamptz
              WHERE account_id=$1 AND version=$4`,
              [accountId, command.capacityClass, at, command.expectedVersion],
            );
      if (current.version !== command.expectedVersion || changed.rowCount !== 1)
        throw new CommunityConflictError("Account capacity changed");
      return capacityDto(await selectCapacity(db, accountId));
    },
  );

interface JobRow extends QueryResultRow {
  id: string;
  kind: OperatorPublishingJob["kind"];
  subject_id: string;
  state: OperatorPublishingJob["state"];
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const jobColumns =
  "id,kind,subject_id,state,attempts,max_attempts,run_after,lease_expires_at,last_error_code,created_at,updated_at,finished_at";

/** Content-free: never the payload, lease owner, paths or messages. */
const jobDto = (row: JobRow): OperatorPublishingJob =>
  operatorPublishingJobSchema.parse({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after.toISOString(),
    leaseExpiresAt: isoOrNull(row.lease_expires_at),
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: isoOrNull(row.finished_at),
  });

/** PublishingOperatorPort.listJobs */
export const listJobs = async (
  pool: Pool,
  query: OperatorPublishingJobQuery,
): Promise<OperatorPublishingJobPage> =>
  readTransaction(pool, async (db) => {
    const where =
      "WHERE ($1::text IS NULL OR state=$1::text) AND ($2::text IS NULL OR kind=$2::text)";
    const filters = [query.state ?? null, query.kind ?? null];
    const total = Number(
      (
        await db.query<{ total: string }>(
          `SELECT count(*) AS total FROM community.publishing_jobs ${where}`,
          filters,
        )
      ).rows[0]?.total ?? 0,
    );
    const { limit, offset } = pageBounds(query);
    const rows = (
      await db.query<JobRow>(
        `SELECT ${jobColumns} FROM community.publishing_jobs ${where} ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4`,
        [...filters, limit, offset],
      )
    ).rows;
    return operatorPublishingJobPageSchema.parse(
      pageOf(rows.map(jobDto), total, query),
    );
  });

const lockJob = async (db: PublishingDb, jobId: string): Promise<JobRow> => {
  const row = (
    await db.query<JobRow>(
      `SELECT ${jobColumns} FROM community.publishing_jobs WHERE id=$1 FOR UPDATE`,
      [jobId],
    )
  ).rows[0];
  if (row === undefined) throw new CommunityNotFoundError();
  return row;
};

/** PublishingOperatorPort.retryJob */
export const retryJob = async (
  pool: Pool,
  jobId: string,
  operator: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<OperatorPublishingJob> =>
  operatorCommand(
    pool,
    {
      operator,
      requestId: command.requestId,
      action: publishingOperatorActions.retryJob,
      target: { type: "publishing_job", id: jobId },
      input: command,
      now,
    },
    async (db) => {
      const job = await lockJob(db, jobId);
      if (job.state !== "failed" && job.state !== "abandoned")
        throw new CommunityConflictError("Only a stopped job can be retried");
      const duplicate = await db.query(
        `SELECT 1 FROM community.publishing_jobs o JOIN community.publishing_jobs j ON j.id=$1
        WHERE o.id<>j.id AND o.kind=j.kind AND o.subject_id=j.subject_id
          AND md5(COALESCE(o.payload,'{}'::jsonb)::text)=md5(COALESCE(j.payload,'{}'::jsonb)::text)
          AND o.state IN ('queued','running')`,
        [jobId],
      );
      if (duplicate.rowCount !== 0)
        throw new CommunityConflictError("An equal job is already active");
      return jobDto(
        (
          await db.query<JobRow>(
            `UPDATE community.publishing_jobs SET state='queued',attempts=0,run_after=$2::timestamptz,
              lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,finished_at=NULL,updated_at=$2::timestamptz
            WHERE id=$1 RETURNING ${jobColumns}`,
            [jobId, nowParam(now)],
          )
        ).rows[0]!,
      );
    },
  );

/** PublishingOperatorPort.abandonJob */
export const abandonJob = async (
  pool: Pool,
  jobId: string,
  operator: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<OperatorPublishingJob> =>
  operatorCommand(
    pool,
    {
      operator,
      requestId: command.requestId,
      action: publishingOperatorActions.abandonJob,
      target: { type: "publishing_job", id: jobId },
      input: command,
      now,
    },
    async (db) => {
      // A process_item job's item is locked before the job row, the order
      // upload commits and worker results take (kind and subject never change).
      const subject = (
        await db.query<{ kind: string; subject_id: string }>(
          "SELECT kind,subject_id FROM community.publishing_jobs WHERE id=$1",
          [jobId],
        )
      ).rows[0];
      if (subject?.kind === "process_item")
        await db.query(
          "SELECT id FROM community.media_items WHERE id=$1 FOR UPDATE",
          [subject.subject_id],
        );
      const job = await lockJob(db, jobId);
      if (job.state !== "queued" && job.state !== "failed")
        throw new CommunityConflictError(
          "Only a queued or failed job can be abandoned",
        );
      const abandoned = (
        await db.query<JobRow>(
          `UPDATE community.publishing_jobs SET state='abandoned',lease_owner=NULL,lease_expires_at=NULL,
            finished_at=$2::timestamptz,updated_at=$2::timestamptz
          WHERE id=$1 RETURNING ${jobColumns}`,
          [jobId, nowParam(now)],
        )
      ).rows[0]!;
      // Nothing will process the item any more: it must not stay processing.
      if (subject?.kind === "process_item")
        await failProcessingItems(db, [subject.subject_id], now);
      return jobDto(abandoned);
    },
  );
