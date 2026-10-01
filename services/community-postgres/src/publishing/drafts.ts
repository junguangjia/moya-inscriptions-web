import type { MentionReference } from "@moya/contracts";
import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type {
  CreatePublishingDraftCommand,
  OpenWorkEditDraftCommand,
  PublishingDeviceClass,
  PublishingDraft,
  PublishingDraftDeletionCommand,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingDraftSummary,
  PublishingOpenedEditDraft,
  PublishingPageQuery,
  PublishingSnapshotPage,
  ResolvePublishingConflictCommand,
  RestorePublishingSnapshotCommand,
  SavePublishingDraftCommand,
  WorkDraftContent,
  WorkSnapshotKind,
} from "@moya/contracts";
import {
  PUBLISHING_DRAFT_CHANGED,
  normalizePublishingBody,
  normalizePublishingTitle,
  publishingDraftPageSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingOpenedEditDraftSchema,
  publishingSnapshotPageSchema,
  workDraftContentSchema,
} from "@moya/contracts/schemas";
import type { PublishingDraftDeletion } from "@moya/api";
import type { WorkPublishingSettings } from "@moya/contracts/internal/community-operator";
import type { Pool } from "pg";

import {
  actorTransaction,
  authorCommand,
  jsonbSha256Sql,
  type AuthorCommandSpec,
  nowParam,
  opaqueId,
  pageBounds,
  pageOf,
  publishingAuthorActions,
  readTransaction,
  safeInteger,
  selectSettings,
  type PublishingDb,
} from "./db.js";
import {
  assertOwnedItems,
  attachItems,
  cancelItems,
  contentItemIds,
  ensureContentDerivatives,
  legacyMediaSrc,
  mediaEditKeySql,
  publishingMediaSrc,
  releaseHolderRefs,
  releaseRefs,
  requireActiveActor,
  selectMediaItems,
  type RefHolderKind,
  type RefRelease,
} from "./media.js";
import { clipboardOriginSql, workExcerpt } from "./media-read.js";
import { revisionAuthorship } from "./authorship.js";
import { eraseUnreferencedLegacyMedia } from "./permanent-media.js";

/*
 * Persistent drafts: creation, conditional saves with conflict copies,
 * snapshots, history, restore, conflict resolution, targeted deletion and
 * edit drafts of existing works. Owner: B1a. Each exported function
 * implements the same-named WorkPublishingPort method (see its JSDoc in
 * @moya/api); `pool` is the adapter's pool. Shared helpers: ./db.ts.
 *
 * A primary draft has `conflict_of` NULL. A conflict copy is a draft row with
 * `conflict_of` = its primary draft, holding the device content a stale save
 * carried; it is resolved (never deleted) by `resolveConflict` and has a
 * pinned `conflict` snapshot while unresolved or unchosen (a chosen copy's
 * snapshot becomes a plain `saved` one); a later stale save from the same
 * device class on the same base replaces that copy and its snapshot. Draft refs follow
 * content: items a save drops lose their ref and wait the orphan grace from
 * that moment; items registered to the draft but not yet in its content keep
 * theirs, so an autosave racing a registration never releases a transfer.
 *
 * Receipts of draft commands hold only the draft id (and, for an opened edit
 * draft, whether that request created it): a replay reads the draft again, so
 * a deleted draft's content never survives in a receipt.
 */

const MEDIA_ITEMS_MAXIMUM = 500;

interface DraftRow {
  id: string;
  owner_id: string;
  work_id: string | null;
  base_revision_id: string | null;
  state: "active" | "submitted" | "deleted";
  conflict_of: string | null;
  resolved_at: Date | null;
  revision: number;
  content: WorkDraftContent;
  content_sha256: string;
  device_class: PublishingDeviceClass | null;
  created_at: Date;
  updated_at: Date;
}

const draftColumns =
  "id,owner_id,work_id,base_revision_id,state,conflict_of,resolved_at,revision,content,content_sha256,device_class,created_at,updated_at";

const firstRow = <T>(rows: readonly T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error("Draft statement returned no row");
  return row;
};

const earlier = (now: Date): Date => new Date(now.getTime() - 1);

// ---------------------------------------------------------------------------
// DTOs

/**
 * The draft DTO: content, media items of the content, of its unresolved
 * conflict and of its registered refs, and its newest unresolved conflict
 * (or the given one).
 */
const draftDto = async (
  db: PublishingDb,
  row: DraftRow,
  conflictId: string | null = null,
): Promise<PublishingDraft> => {
  const copy = (
    await db.query<DraftRow>(
      `SELECT ${draftColumns} FROM community.work_drafts
       WHERE conflict_of=$1 AND owner_id=$2 AND state='active' AND resolved_at IS NULL
       ${conflictId === null ? "" : "AND id=$3"}
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
      conflictId === null
        ? [row.id, row.owner_id]
        : [row.id, row.owner_id, conflictId],
    )
  ).rows[0];
  const refs = await db.query<{ item_id: string }>(
    "SELECT item_id FROM community.media_item_refs WHERE holder_kind='draft' AND holder_id=$1 ORDER BY item_id",
    [row.id],
  );
  const itemIds = [
    ...new Set([
      ...contentItemIds(row.content),
      ...(copy === undefined ? [] : contentItemIds(copy.content)),
      ...refs.rows.map((ref) => ref.item_id),
    ]),
  ].slice(0, MEDIA_ITEMS_MAXIMUM);
  const items = await selectMediaItems(db, row.owner_id, itemIds);
  return publishingDraftSchema.parse({
    id: row.id,
    kind: row.work_id === null ? "new" : "edit",
    workId: row.work_id,
    baseRevisionId: row.base_revision_id,
    revision: row.revision,
    content: row.content,
    mediaItems: itemIds.flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    }),
    conflict:
      copy === undefined
        ? null
        : {
            id: copy.id,
            device: {
              content: copy.content,
              baseRevision: copy.revision,
              deviceClass: copy.device_class,
              savedAt: copy.updated_at.toISOString(),
            },
            account: {
              content: row.content,
              revision: row.revision,
              deviceClass: row.device_class,
              updatedAt: row.updated_at.toISOString(),
            },
            createdAt: copy.created_at.toISOString(),
          },
    deviceClass: row.device_class,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
};

/** Card cover of each draft: its cover item, else the first ready item. */
const draftCovers = async (
  db: PublishingDb,
  ownerId: string,
  rows: readonly DraftRow[],
): Promise<Map<string, string>> => {
  const entries = rows.flatMap((row) => {
    const items = row.content.items.filter((item) => item.itemId !== null);
    const ordered = [
      ...items.filter((item) => item.key === row.content.coverKey),
      ...items.filter((item) => item.key !== row.content.coverKey),
    ];
    return ordered.map((item, rank) => ({
      draft_id: row.id,
      rank,
      item_id: item.itemId,
      edit: { rotation: item.edit.rotation, crop: item.edit.crop },
      cover_crop:
        item.key === row.content.coverKey ? row.content.coverCrop : null,
    }));
  });
  if (entries.length === 0) return new Map();
  const covers = await db.query<{
    draft_id: string;
    item_id: string;
    legacy_media_id: string | null;
    edit_key: string;
    keyed: boolean;
  }>(
    `WITH input AS (
       SELECT e.draft_id, e.rank, e.item_id, ${mediaEditKeySql("e.edit", "e.cover_crop")} AS edit_key
       FROM jsonb_to_recordset($1::jsonb) AS e(draft_id text, rank integer, item_id text, edit jsonb, cover_crop jsonb)
     )
     SELECT DISTINCT ON (e.draft_id) e.draft_id, i.id AS item_id, i.legacy_media_id, e.edit_key,
       EXISTS (SELECT 1 FROM community.media_derivatives d WHERE d.item_id=i.id AND d.variant='thumb' AND d.edit_key=e.edit_key) AS keyed
     FROM input e
     JOIN community.media_items i ON i.id=e.item_id AND i.owner_id=$2 AND i.state='ready'
     ORDER BY e.draft_id, e.rank`,
    [JSON.stringify(entries), ownerId],
  );
  // An unedited legacy item keeps its user media PNG; an edited one shows its
  // thumb derivative once recorded, as uploaded items do.
  return new Map(
    covers.rows.map((cover) => [
      cover.draft_id,
      cover.legacy_media_id !== null && !cover.keyed
        ? legacyMediaSrc(cover.legacy_media_id)
        : publishingMediaSrc(
            cover.item_id,
            "thumb",
            cover.keyed ? cover.edit_key : "base",
          ),
    ]),
  );
};

const summaryOf = (
  row: DraftRow,
  coverSrc: string | null,
): PublishingDraftSummary => {
  const body = normalizePublishingBody(row.content.body);
  return {
    id: row.id,
    kind: row.work_id === null ? "new" : "edit",
    workId: row.work_id,
    title: normalizePublishingTitle(row.content.title),
    excerpt: workExcerpt(body),
    coverSrc,
    itemCount: row.content.items.length,
    missingLocalCount: row.content.items.filter((item) => item.itemId === null)
      .length,
    deviceClass: row.device_class,
    updatedAt: row.updated_at.toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Rows, refs and snapshots

/** The actor's primary draft row, locked. Unknown or foreign: not found. */
const lockDraft = async (
  db: PublishingDb,
  actorId: string,
  draftId: string,
): Promise<DraftRow> => {
  const row = (
    await db.query<DraftRow>(
      `SELECT ${draftColumns} FROM community.work_drafts WHERE id=$1 AND owner_id=$2 AND conflict_of IS NULL FOR UPDATE`,
      [draftId, actorId],
    )
  ).rows[0];
  if (row === undefined) throw new CommunityNotFoundError();
  return row;
};

const lockActiveDraft = async (
  db: PublishingDb,
  actorId: string,
  draftId: string,
): Promise<DraftRow> => {
  const row = await lockDraft(db, actorId, draftId);
  if (row.state !== "active")
    throw new CommunityConflictError("The draft is no longer active");
  return row;
};

const assertDraftAllowance = async (
  db: PublishingDb,
  actorId: string,
  settings: WorkPublishingSettings,
): Promise<void> => {
  const active = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM community.work_drafts WHERE owner_id=$1 AND state='active' AND conflict_of IS NULL",
    [actorId],
  );
  if (safeInteger(active.rows[0]?.count ?? 0) >= settings.maxActiveDrafts)
    throw new CommunityInputError("draft_limit");
};

/**
 * Refs follow content: new items gain a ref, items the content dropped lose
 * it (their orphan grace starts at `now`).
 */
const syncRefs = async (
  db: PublishingDb,
  ownerId: string,
  holderKind: RefHolderKind,
  holderId: string,
  previous: WorkDraftContent,
  next: WorkDraftContent,
  now: Date,
): Promise<void> => {
  const nextIds = contentItemIds(next);
  await attachItems(db, ownerId, holderKind, holderId, nextIds);
  const kept = new Set(nextIds);
  const dropped = contentItemIds(previous).filter((id) => !kept.has(id));
  await releaseRefs(db, holderKind, [holderId], now, dropped);
};

const replaceContent = async (
  db: PublishingDb,
  draftId: string,
  content: WorkDraftContent,
  deviceClass: PublishingDeviceClass | null,
  now: Date,
): Promise<DraftRow> =>
  firstRow(
    (
      await db.query<DraftRow>(
        `UPDATE community.work_drafts
         SET content=$2::jsonb, content_sha256=${jsonbSha256Sql("$2")}, revision=revision+1,
             device_class=$3, updated_at=$4::timestamptz
         WHERE id=$1
         RETURNING ${draftColumns}`,
        [draftId, JSON.stringify(content), deviceClass, nowParam(now)],
      )
    ).rows,
  );

interface SnapshotInput {
  readonly ownerId: string;
  readonly draftId: string;
  readonly workId: string | null;
  readonly kind: WorkSnapshotKind;
  readonly content: WorkDraftContent;
  readonly sourceRevision: number | null;
  readonly pinned: boolean;
  readonly createdAt: Date;
}

const insertSnapshot = async (
  db: PublishingDb,
  snapshot: SnapshotInput,
): Promise<string> => {
  const id = opaqueId("work-snapshot");
  await db.query(
    `INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,work_id,kind,content,source_revision,pinned,created_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz)`,
    [
      id,
      snapshot.ownerId,
      snapshot.draftId,
      snapshot.workId,
      snapshot.kind,
      JSON.stringify(snapshot.content),
      snapshot.sourceRevision,
      snapshot.pinned,
      nowParam(snapshot.createdAt),
    ],
  );
  await attachItems(
    db,
    snapshot.ownerId,
    "snapshot",
    id,
    contentItemIds(snapshot.content),
  );
  return id;
};

/**
 * Keeps the newest `limit` unpinned snapshots of a lineage; evicted snapshots
 * take their refs along (released items wait the orphan grace from `now`).
 * `alsoRelease` holder refs go in the same single item lock pass (a
 * submission releases its draft's refs this way). Shared with submissions
 * (./submissions.ts).
 */
export const trimHistory = async (
  db: PublishingDb,
  ownerId: string,
  lineage: string,
  limit: number,
  now: Date,
  alsoRelease: readonly RefRelease[] = [],
): Promise<void> => {
  const evicted = (
    await db.query<{ id: string }>(
      `SELECT id FROM (
         SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS rank
         FROM community.work_draft_snapshots
         WHERE owner_id=$1 AND COALESCE(work_id,draft_id)=$2 AND NOT pinned
       ) ranked WHERE rank > $3
       ORDER BY id`,
      [ownerId, lineage, limit],
    )
  ).rows.map((row) => row.id);
  await releaseHolderRefs(
    db,
    [...alsoRelease, { holderKind: "snapshot", holderIds: evicted }],
    now,
  );
  if (evicted.length === 0) return;
  await db.query(
    "DELETE FROM community.work_draft_snapshots WHERE id=ANY($1::text[])",
    [evicted],
  );
};

/** Content-free receipt of a draft command. */
interface DraftReceipt {
  readonly draftId: string;
}

/** Content-free receipt of an opened edit draft; receipts written before `created` existed read as false. */
interface OpenedDraftReceipt extends DraftReceipt {
  readonly created?: boolean;
}

/**
 * An author command whose result is a draft: the receipt stores only the
 * draft id. A fresh run returns the draft read in its own transaction; a
 * replay reads the draft again (not found once it was deleted or submitted).
 */
const draftCommand = async (
  pool: Pool,
  spec: AuthorCommandSpec,
  run: (db: PublishingDb) => Promise<PublishingDraft>,
  auditSubject?: (draftId: string) => string,
): Promise<PublishingDraft> => {
  const fresh: { draft?: PublishingDraft } = {};
  const receipt = await authorCommand<DraftReceipt>(
    pool,
    spec,
    async (db) => {
      fresh.draft = await run(db);
      return { draftId: fresh.draft.id };
    },
    {
      auditSubject: (result) =>
        auditSubject === undefined
          ? spec.subjectId
          : auditSubject(result.draftId),
    },
  );
  return fresh.draft ?? readDraft(pool, spec.actorId, receipt.draftId);
};

const lineageOf = (row: Pick<DraftRow, "id" | "work_id">): string =>
  row.work_id ?? row.id;

// ---------------------------------------------------------------------------
// Commands

/** WorkPublishingPort.createDraft */
export const createDraft = async (
  pool: Pool,
  actorId: string,
  command: CreatePublishingDraftCommand,
  now: Date,
): Promise<PublishingDraft> =>
  draftCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.createDraft,
      subjectId: actorId,
      input: command,
      now,
    },
    async (db) => {
      const settings = await selectSettings(db, "share");
      await assertDraftAllowance(db, actorId, settings);
      const itemIds = contentItemIds(command.content);
      await assertOwnedItems(db, actorId, itemIds);
      const at = nowParam(now);
      const row = firstRow(
        (
          await db.query<DraftRow>(
            `INSERT INTO community.work_drafts(id,owner_id,state,revision,content,content_sha256,device_class,created_at,updated_at)
             VALUES($1,$2,'active',1,$3::jsonb,${jsonbSha256Sql("$3")},$4,$5::timestamptz,$5::timestamptz)
             RETURNING ${draftColumns}`,
            [
              opaqueId("work-draft"),
              actorId,
              JSON.stringify(command.content),
              command.deviceClass,
              at,
            ],
          )
        ).rows,
      );
      await attachItems(db, actorId, "draft", row.id, itemIds);
      await ensureContentDerivatives(db, actorId, command.content, now, {
        settle: { itemIds },
      });
      return draftDto(db, row);
    },
    (draftId) => draftId,
  );

type SaveOutcome =
  | { readonly status: "saved"; readonly row: DraftRow }
  | {
      readonly status: "conflict";
      readonly row: DraftRow;
      readonly conflictId: string;
    };

const saveContent = async (
  db: PublishingDb,
  actorId: string,
  draftId: string,
  command: SavePublishingDraftCommand,
  now: Date,
): Promise<SaveOutcome> => {
  const draft = await lockActiveDraft(db, actorId, draftId);
  const content = JSON.stringify(command.content);
  const sha = firstRow(
    (
      await db.query<{ sha: string }>(`SELECT ${jsonbSha256Sql("$1")} AS sha`, [
        content,
      ])
    ).rows,
  ).sha;
  // A retried save of content already stored is saved without a new revision.
  if (sha === draft.content_sha256) return { status: "saved", row: draft };
  await assertOwnedItems(db, actorId, contentItemIds(command.content));
  if (command.baseRevision === draft.revision) {
    const row = await replaceContent(
      db,
      draft.id,
      command.content,
      command.deviceClass,
      now,
    );
    await syncRefs(
      db,
      actorId,
      "draft",
      draft.id,
      draft.content,
      command.content,
      now,
    );
    await ensureContentDerivatives(db, actorId, command.content, now, {
      settle: { itemIds: contentItemIds(draft.content) },
    });
    return { status: "saved", row };
  }
  // A stale base never overwrites newer account content: the device content
  // is kept as a conflict copy. A retried stale save reuses its copy; the
  // same device class saving other content on the same stale base replaces
  // its own copy and that copy's pinned snapshot instead of adding more.
  const copies = (
    await db.query<DraftRow>(
      `SELECT ${draftColumns} FROM community.work_drafts
       WHERE conflict_of=$1 AND owner_id=$2 AND state='active' AND resolved_at IS NULL
         AND revision=$3 AND (content_sha256=$4 OR device_class IS NOT DISTINCT FROM $5)
       ORDER BY content_sha256=$4 DESC, updated_at DESC, id DESC
       FOR UPDATE`,
      [draft.id, actorId, command.baseRevision, sha, command.deviceClass],
    )
  ).rows;
  const existing = copies[0];
  const at = nowParam(now);
  if (existing !== undefined) {
    if (existing.content_sha256 !== sha) {
      await db.query(
        `UPDATE community.work_drafts SET content=$2::jsonb, content_sha256=$3, updated_at=$4::timestamptz
         WHERE id=$1`,
        [existing.id, content, sha, at],
      );
      await syncRefs(
        db,
        actorId,
        "draft",
        existing.id,
        existing.content,
        command.content,
        now,
      );
      const snapshot = (
        await db.query<{ id: string; content: WorkDraftContent }>(
          `SELECT id,content FROM community.work_draft_snapshots
           WHERE draft_id=$1 AND owner_id=$2 AND kind='conflict' AND pinned
             AND source_revision=$3 AND created_at=$4::timestamptz
           ORDER BY id LIMIT 1 FOR UPDATE`,
          [
            draft.id,
            actorId,
            command.baseRevision,
            nowParam(existing.created_at),
          ],
        )
      ).rows[0];
      if (snapshot === undefined)
        await insertSnapshot(db, {
          ownerId: actorId,
          draftId: draft.id,
          workId: draft.work_id,
          kind: "conflict",
          content: command.content,
          sourceRevision: command.baseRevision,
          pinned: true,
          createdAt: now,
        });
      else {
        await db.query(
          "UPDATE community.work_draft_snapshots SET content=$2::jsonb WHERE id=$1",
          [snapshot.id, content],
        );
        await syncRefs(
          db,
          actorId,
          "snapshot",
          snapshot.id,
          snapshot.content,
          command.content,
          now,
        );
      }
    }
    return { status: "conflict", row: draft, conflictId: existing.id };
  }
  const copy = firstRow(
    (
      await db.query<{ id: string }>(
        `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,state,conflict_of,revision,content,content_sha256,device_class,created_at,updated_at)
         VALUES($1,$2,$3,$4,'active',$5,$6,$7::jsonb,$8,$9,$10::timestamptz,$10::timestamptz)
         RETURNING id`,
        [
          opaqueId("work-draft"),
          actorId,
          draft.work_id,
          draft.base_revision_id,
          draft.id,
          command.baseRevision,
          content,
          sha,
          command.deviceClass,
          at,
        ],
      )
    ).rows,
  );
  await attachItems(
    db,
    actorId,
    "draft",
    copy.id,
    contentItemIds(command.content),
  );
  await insertSnapshot(db, {
    ownerId: actorId,
    draftId: draft.id,
    workId: draft.work_id,
    kind: "conflict",
    content: command.content,
    sourceRevision: command.baseRevision,
    pinned: true,
    createdAt: now,
  });
  return { status: "conflict", row: draft, conflictId: copy.id };
};

const saveResult = async (
  db: PublishingDb,
  outcome: SaveOutcome,
): Promise<PublishingDraftSaveResult> => {
  if (outcome.status === "saved")
    return publishingDraftSaveResultSchema.parse({
      status: "saved",
      draft: await draftDto(db, outcome.row),
    });
  const draft = await draftDto(db, outcome.row, outcome.conflictId);
  return publishingDraftSaveResultSchema.parse({
    status: "conflict",
    draft,
    conflict: draft.conflict,
  });
};

/** WorkPublishingPort.saveDraft */
export const saveDraft = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  command: SavePublishingDraftCommand,
  now: Date,
): Promise<PublishingDraftSaveResult> =>
  actorTransaction(pool, actorId, async (db) =>
    saveResult(db, await saveContent(db, actorId, draftId, command, now)),
  );

/** WorkPublishingPort.snapshotDraft */
export const snapshotDraft = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  command: SavePublishingDraftCommand,
  now: Date,
): Promise<PublishingDraftSaveResult> =>
  actorTransaction(pool, actorId, async (db) => {
    const outcome = await saveContent(db, actorId, draftId, command, now);
    if (outcome.status === "saved") {
      const row = outcome.row;
      const recorded = await db.query(
        "SELECT 1 FROM community.work_draft_snapshots WHERE draft_id=$1 AND owner_id=$2 AND kind='saved' AND source_revision=$3 LIMIT 1",
        [row.id, actorId, row.revision],
      );
      if ((recorded.rowCount ?? 0) === 0) {
        const settings = await selectSettings(db, "share");
        await insertSnapshot(db, {
          ownerId: actorId,
          draftId: row.id,
          workId: row.work_id,
          kind: "saved",
          content: row.content,
          sourceRevision: row.revision,
          pinned: false,
          createdAt: now,
        });
        await trimHistory(
          db,
          actorId,
          lineageOf(row),
          settings.historyLimit,
          now,
        );
      }
    }
    return saveResult(db, outcome);
  });

/** WorkPublishingPort.listDrafts */
export const listDrafts = async (
  pool: Pool,
  actorId: string,
  query: PublishingPageQuery,
): Promise<PublishingDraftPage> =>
  readTransaction(pool, async (db) => {
    await requireActiveActor(db, actorId);
    const total = safeInteger(
      firstRow(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM community.work_drafts WHERE owner_id=$1 AND state='active' AND conflict_of IS NULL",
            [actorId],
          )
        ).rows,
      ).count,
    );
    const { limit, offset } = pageBounds(query);
    const rows = (
      await db.query<DraftRow>(
        `SELECT ${draftColumns} FROM community.work_drafts
         WHERE owner_id=$1 AND state='active' AND conflict_of IS NULL
         ORDER BY updated_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [actorId, limit, offset],
      )
    ).rows;
    const covers = await draftCovers(db, actorId, rows);
    return publishingDraftPageSchema.parse(
      pageOf(
        rows.map((row) => summaryOf(row, covers.get(row.id) ?? null)),
        total,
        query,
      ),
    );
  });

/** WorkPublishingPort.readDraft */
export const readDraft = async (
  pool: Pool,
  actorId: string,
  draftId: string,
): Promise<PublishingDraft> =>
  readTransaction(pool, async (db) => {
    await requireActiveActor(db, actorId);
    const row = (
      await db.query<DraftRow>(
        `SELECT ${draftColumns} FROM community.work_drafts WHERE id=$1 AND owner_id=$2 AND conflict_of IS NULL AND state='active'`,
        [draftId, actorId],
      )
    ).rows[0];
    if (row === undefined) throw new CommunityNotFoundError();
    return draftDto(db, row);
  });

/** WorkPublishingPort.deleteDraft */
export const deleteDraft = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  command: PublishingDraftDeletionCommand,
  now: Date,
): Promise<PublishingDraftDeletion> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.deleteDraft,
      subjectId: draftId,
      input: command,
      now,
    },
    async (db) => {
      const draft = await lockActiveDraft(db, actorId, draftId);
      // The author confirmed the deletion scope of one draft revision with no
      // pending conflict: nothing is removed when the revision moved on (a
      // save on the current base) or an unresolved conflict copy exists (a
      // save on an outdated base leaves the revision unchanged). Conflict
      // copies are only written under the primary draft's row lock, which is
      // held here, so none can appear before this transaction ends.
      if (command.expectedRevision !== undefined) {
        const unresolvedCopy =
          (
            await db.query(
              "SELECT 1 FROM community.work_drafts WHERE conflict_of=$1 AND owner_id=$2 AND state='active' AND resolved_at IS NULL LIMIT 1",
              [draft.id, actorId],
            )
          ).rowCount !== 0;
        if (draft.revision !== command.expectedRevision || unresolvedCopy)
          throw new CommunityConflictError(PUBLISHING_DRAFT_CHANGED);
      }
      const copies = (
        await db.query<{ id: string; content: WorkDraftContent }>(
          "SELECT id,content FROM community.work_drafts WHERE conflict_of=$1 AND owner_id=$2 ORDER BY id FOR UPDATE",
          [draft.id, actorId],
        )
      ).rows;
      const draftIds = [draft.id, ...copies.map((copy) => copy.id)];
      const snapshots = (
        await db.query<{ id: string; content: WorkDraftContent }>(
          "SELECT id,content FROM community.work_draft_snapshots WHERE draft_id=ANY($1::text[]) AND owner_id=$2 ORDER BY id FOR UPDATE",
          [draftIds, actorId],
        )
      ).rows;
      const snapshotIds = snapshots.map((snapshot) => snapshot.id);
      const contentIds = [
        ...contentItemIds(draft.content),
        ...copies.flatMap((copy) => contentItemIds(copy.content)),
        ...snapshots.flatMap((snapshot) => contentItemIds(snapshot.content)),
      ];
      // Sessions are only created in unsaved mode, so none names the draft.
      // One item lock pass covers the refs released and the items cancelled.
      const released = await releaseHolderRefs(
        db,
        [
          { holderKind: "draft", holderIds: draftIds },
          { holderKind: "snapshot", holderIds: snapshotIds },
        ],
        now,
        contentIds,
      );
      await db.query(
        "DELETE FROM community.work_draft_snapshots WHERE id=ANY($1::text[])",
        [snapshotIds],
      );
      await db.query(
        "DELETE FROM community.work_drafts WHERE conflict_of=$1 AND owner_id=$2",
        [draft.id, actorId],
      );
      await db.query("DELETE FROM community.work_drafts WHERE id=$1", [
        draft.id,
      ]);
      const candidates = [...released, ...contentIds];
      const owned = (
        await db.query<{ id: string }>(
          "SELECT id FROM community.media_items WHERE owner_id=$1 AND id=ANY($2::text[])",
          [actorId, [...new Set(candidates)]],
        )
      ).rows.map((row) => row.id);
      // Only media no other draft, snapshot, session or revision references.
      const { itemIds, cancelledComponentIds } = await cancelItems(
        db,
        owned,
        now,
        { onlyUnreferenced: true },
      );
      await eraseUnreferencedLegacyMedia(db, actorId, owned, now);
      return {
        result: {
          deleted: true,
          snapshots: snapshots.length,
          conflictCopies: copies.length,
          mediaItems: itemIds.length,
        },
        cancelledComponentIds,
      };
    },
  );

/** WorkPublishingPort.listHistory */
export const listHistory = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  query: PublishingPageQuery,
): Promise<PublishingSnapshotPage> =>
  readTransaction(pool, async (db) => {
    await requireActiveActor(db, actorId);
    const draft = (
      await db.query<Pick<DraftRow, "id" | "work_id">>(
        "SELECT id,work_id FROM community.work_drafts WHERE id=$1 AND owner_id=$2 AND conflict_of IS NULL AND state='active'",
        [draftId, actorId],
      )
    ).rows[0];
    if (draft === undefined) throw new CommunityNotFoundError();
    const lineage = lineageOf(draft);
    const total = safeInteger(
      firstRow(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM community.work_draft_snapshots WHERE owner_id=$1 AND COALESCE(work_id,draft_id)=$2",
            [actorId, lineage],
          )
        ).rows,
      ).count,
    );
    const { limit, offset } = pageBounds(query);
    const rows = await db.query<{
      id: string;
      kind: WorkSnapshotKind;
      draft_id: string | null;
      work_id: string | null;
      source_revision: number | null;
      pinned: boolean;
      created_at: Date;
      content: WorkDraftContent;
    }>(
      `SELECT id,kind,draft_id,work_id,source_revision,pinned,created_at,content
       FROM community.work_draft_snapshots
       WHERE owner_id=$1 AND COALESCE(work_id,draft_id)=$2
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [actorId, lineage, limit, offset],
    );
    return publishingSnapshotPageSchema.parse(
      pageOf(
        rows.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          draftId: row.draft_id,
          workId: row.work_id,
          sourceRevision: row.source_revision,
          pinned: row.pinned,
          createdAt: row.created_at.toISOString(),
          content: row.content,
        })),
        total,
        query,
      ),
    );
  });

/** WorkPublishingPort.restoreSnapshot */
export const restoreSnapshot = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  command: RestorePublishingSnapshotCommand,
  now: Date,
): Promise<PublishingDraft> =>
  draftCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.restoreSnapshot,
      subjectId: draftId,
      input: command,
      now,
    },
    async (db) => {
      const draft = await lockActiveDraft(db, actorId, draftId);
      const lineage = lineageOf(draft);
      const snapshot = (
        await db.query<{ content: WorkDraftContent }>(
          "SELECT content FROM community.work_draft_snapshots WHERE id=$1 AND owner_id=$2 AND COALESCE(work_id,draft_id)=$3",
          [command.snapshotId, actorId, lineage],
        )
      ).rows[0];
      if (snapshot === undefined) throw new CommunityNotFoundError();
      const content = workDraftContentSchema.parse(snapshot.content);
      await assertOwnedItems(db, actorId, contentItemIds(content));
      const settings = await selectSettings(db, "share");
      // Restoring never loses the current edit: it stays in history unless
      // an identical snapshot already exists.
      const kept = await db.query(
        "SELECT 1 FROM community.work_draft_snapshots WHERE owner_id=$1 AND COALESCE(work_id,draft_id)=$2 AND content=$3::jsonb LIMIT 1",
        [actorId, lineage, JSON.stringify(draft.content)],
      );
      if ((kept.rowCount ?? 0) === 0)
        await insertSnapshot(db, {
          ownerId: actorId,
          draftId: draft.id,
          workId: draft.work_id,
          kind: "saved",
          content: draft.content,
          sourceRevision: draft.revision,
          pinned: false,
          createdAt: earlier(now),
        });
      const row = await replaceContent(
        db,
        draft.id,
        content,
        draft.device_class,
        now,
      );
      await syncRefs(
        db,
        actorId,
        "draft",
        draft.id,
        draft.content,
        content,
        now,
      );
      await insertSnapshot(db, {
        ownerId: actorId,
        draftId: draft.id,
        workId: draft.work_id,
        kind: "restored",
        content,
        sourceRevision: row.revision,
        pinned: false,
        createdAt: now,
      });
      await trimHistory(db, actorId, lineage, settings.historyLimit, now);
      await ensureContentDerivatives(db, actorId, content, now, {
        settle: { itemIds: contentItemIds(draft.content) },
      });
      return draftDto(db, row);
    },
  );

/** WorkPublishingPort.resolveConflict */
export const resolveConflict = async (
  pool: Pool,
  actorId: string,
  draftId: string,
  command: ResolvePublishingConflictCommand,
  now: Date,
): Promise<PublishingDraft> =>
  draftCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.resolveConflict,
      subjectId: draftId,
      input: command,
      now,
    },
    async (db) => {
      const draft = await lockActiveDraft(db, actorId, draftId);
      const copy = (
        await db.query<DraftRow>(
          `SELECT ${draftColumns} FROM community.work_drafts WHERE id=$1 AND conflict_of=$2 AND owner_id=$3 FOR UPDATE`,
          [command.conflictId, draft.id, actorId],
        )
      ).rows[0];
      if (copy === undefined) throw new CommunityNotFoundError();
      if (copy.resolved_at !== null || copy.state !== "active")
        throw new CommunityConflictError("The conflict was already resolved");
      let current = draft;
      if (command.choice === "device") {
        // The unchosen account content stays recoverable, pinned.
        await insertSnapshot(db, {
          ownerId: actorId,
          draftId: draft.id,
          workId: draft.work_id,
          kind: "conflict",
          content: draft.content,
          sourceRevision: draft.revision,
          pinned: true,
          createdAt: earlier(now),
        });
        await assertOwnedItems(db, actorId, contentItemIds(copy.content));
        current = await replaceContent(
          db,
          draft.id,
          copy.content,
          copy.device_class,
          now,
        );
        await syncRefs(
          db,
          actorId,
          "draft",
          draft.id,
          draft.content,
          copy.content,
          now,
        );
        // The chosen device content is no longer a conflict copy: its
        // pinned `conflict` snapshot (the copy's own, matched like a stale
        // save finds it) becomes the unpinned `saved` snapshot of the new
        // revision, as a Save now of this content would record, and the
        // lineage is trimmed the same way. Only unchosen content stays a
        // pinned conflict snapshot.
        await db.query(
          `UPDATE community.work_draft_snapshots
           SET kind='saved', pinned=false, source_revision=$3, created_at=$4::timestamptz
           WHERE id=(
             SELECT id FROM community.work_draft_snapshots
             WHERE draft_id=$1 AND owner_id=$2 AND kind='conflict' AND pinned
               AND source_revision=$5 AND created_at=$6::timestamptz AND content=$7::jsonb
             ORDER BY id LIMIT 1)`,
          [
            draft.id,
            actorId,
            current.revision,
            nowParam(now),
            copy.revision,
            nowParam(copy.created_at),
            JSON.stringify(copy.content),
          ],
        );
        const settings = await selectSettings(db, "share");
        await trimHistory(
          db,
          actorId,
          lineageOf(draft),
          settings.historyLimit,
          now,
        );
      } else {
        // The chosen account version must remain recoverable when this
        // browser subsequently saves input typed after the conflict appeared.
        await insertSnapshot(db, {
          ownerId: actorId,
          draftId: draft.id,
          workId: draft.work_id,
          kind: "saved",
          content: draft.content,
          sourceRevision: draft.revision,
          pinned: false,
          createdAt: now,
        });
        const settings = await selectSettings(db, "share");
        await trimHistory(
          db,
          actorId,
          lineageOf(draft),
          settings.historyLimit,
          now,
        );
      }
      await db.query(
        "UPDATE community.work_drafts SET resolved_at=$2::timestamptz, updated_at=$2::timestamptz WHERE id=$1",
        [copy.id, nowParam(now)],
      );
      // An unchosen device content keeps its pinned conflict snapshot; the
      // copy's own refs go either way (the snapshot keeps its own).
      await releaseRefs(db, "draft", [copy.id], now);
      await ensureContentDerivatives(db, actorId, current.content, now, {
        settle: { itemIds: contentItemIds(draft.content) },
      });
      return draftDto(db, current);
    },
  );

interface EditableRevisionRow {
  title: string;
  body: string;
  mentions: MentionReference[];
  authorship_kind: "original" | "copy_practice" | "material_sharing" | null;
  reference_title: string | null;
  original_author: string | null;
  source_note: string | null;
  cover_item_id: string | null;
  cover_crop: WorkDraftContent["coverCrop"];
}

/**
 * WorkPublishingPort.openEditDraft. `created` is true only when this request
 * inserted the draft; the receipt keeps it, so a retried request identity
 * answers the same, and an older receipt without it answers false.
 */
export const openEditDraft = async (
  pool: Pool,
  actorId: string,
  workId: string,
  command: OpenWorkEditDraftCommand,
  now: Date,
): Promise<PublishingOpenedEditDraft> => {
  const fresh: { opened?: PublishingOpenedEditDraft } = {};
  const answer = async (
    db: PublishingDb,
    row: DraftRow,
    created: boolean,
  ): Promise<OpenedDraftReceipt> => {
    fresh.opened = publishingOpenedEditDraftSchema.parse({
      draft: await draftDto(db, row),
      created,
    });
    return { draftId: row.id, created };
  };
  const receipt = await authorCommand<OpenedDraftReceipt>(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.openEditDraft,
      subjectId: workId,
      input: command,
      now,
    },
    async (db) => {
      // Holder before work, the lock order every other author command and the
      // recycle-bin purge use (jobs.ts); taking the work row first deadlocked
      // against purgeTrashedWork, which locks the drafts and then the work.
      const existing = (
        await db.query<DraftRow>(
          `SELECT ${draftColumns} FROM community.work_drafts WHERE owner_id=$1 AND work_id=$2 AND state='active' AND conflict_of IS NULL FOR UPDATE`,
          [actorId, workId],
        )
      ).rows[0];
      const work = (
        await db.query<{
          visibility: "public" | "self";
          trashed_at: Date | null;
          operator_state: string;
          author_revision_id: string | null;
        }>(
          "SELECT visibility,trashed_at,operator_state,author_revision_id FROM community.works WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL FOR SHARE",
          [workId, actorId],
        )
      ).rows[0];
      if (work === undefined) throw new CommunityNotFoundError();
      if (work.trashed_at !== null || work.operator_state === "removed")
        throw new CommunityInputError("work_unavailable");
      if (existing !== undefined) return answer(db, existing, false);
      if (work.author_revision_id === null)
        throw new CommunityInputError("work_unavailable");
      const settings = await selectSettings(db, "share");
      await assertDraftAllowance(db, actorId, settings);
      const revision = firstRow(
        (
          await db.query<EditableRevisionRow>(
            "SELECT title,body,mentions,authorship_kind,reference_title,original_author,source_note,cover_item_id,cover_crop FROM community.work_revisions WHERE id=$1",
            [work.author_revision_id],
          )
        ).rows,
      );
      const items = await db.query<{
        item_id: string;
        edit: {
          rotation?: 0 | 90 | 180 | 270;
          crop?: WorkDraftContent["coverCrop"];
        };
        kind: "static" | "live";
        quality_mode: "standard" | "original" | "legacy";
        clipboard: boolean;
      }>(
        `SELECT ri.item_id, ri.edit, i.kind, i.quality_mode, ${clipboardOriginSql("i")} AS clipboard
         FROM community.work_revision_items ri JOIN community.media_items i ON i.id=ri.item_id
         WHERE ri.revision_id=$1 ORDER BY ri.position`,
        [work.author_revision_id],
      );
      const coverKey = items.rows.some(
        (item) => item.item_id === revision.cover_item_id,
      )
        ? revision.cover_item_id
        : null;
      const content = workDraftContentSchema.parse({
        title: revision.title,
        body: revision.body,
        ...(revision.mentions.length ? { mentions: revision.mentions } : {}),
        // A revision without a declaration (a legacy baseline) opens as not set.
        authorship: revisionAuthorship(revision),
        visibility: work.visibility,
        // Stored item ids are stable client keys as well (as legacy snapshots use).
        items: items.rows.map((item) => ({
          key: item.item_id,
          itemId: item.item_id,
          kind: item.kind,
          qualityMode: item.quality_mode,
          edit: {
            rotation: item.edit.rotation ?? 0,
            crop: item.edit.crop ?? null,
          },
          ...(item.clipboard ? { origin: "clipboard" } : {}),
        })),
        coverKey,
        coverCrop: coverKey === null ? null : revision.cover_crop,
      });
      const itemIds = contentItemIds(content);
      await assertOwnedItems(db, actorId, itemIds);
      const at = nowParam(now);
      const row = firstRow(
        (
          await db.query<DraftRow>(
            `INSERT INTO community.work_drafts(id,owner_id,work_id,base_revision_id,state,revision,content,content_sha256,device_class,created_at,updated_at)
             VALUES($1,$2,$3,$4,'active',1,$5::jsonb,${jsonbSha256Sql("$5")},$6,$7::timestamptz,$7::timestamptz)
             RETURNING ${draftColumns}`,
            [
              opaqueId("work-draft"),
              actorId,
              workId,
              work.author_revision_id,
              JSON.stringify(content),
              command.deviceClass,
              at,
            ],
          )
        ).rows,
      );
      await attachItems(db, actorId, "draft", row.id, itemIds);
      await ensureContentDerivatives(db, actorId, content, now, {
        settle: { itemIds },
      });
      return answer(db, row, true);
    },
  );
  return (
    fresh.opened ??
    publishingOpenedEditDraftSchema.parse({
      draft: await readDraft(pool, actorId, receipt.draftId),
      created: receipt.created === true,
    })
  );
};
