import {
  enqueueNotification,
  validateMentionUsers,
} from "../notifications/source.js";
import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM,
  AUTHORSHIP_REFERENCE_TITLE_MAXIMUM,
  AUTHORSHIP_SOURCE_NOTE_MAXIMUM,
  DRAFT_TEXT_RAW_ALLOWANCE,
  checkPublishingText,
  isEmptyWorkContent,
  normalizePublishingBody,
  normalizePublishingTitle,
  publishingBodyRule,
  publishingTitleRule,
  workSubmissionReceiptSchema,
} from "@moya/contracts/schemas";
import type {
  MediaCrop,
  WorkAuthorship,
  WorkDraftContent,
  WorkPublishingFailureCode,
  WorkSubmissionCommand,
  WorkSubmissionContent,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
} from "@moya/contracts";
import type { PublishingTextRule } from "@moya/contracts/schemas";
import type { WorkPublishingSettings } from "@moya/contracts/internal/community-operator";
import type { Pool, QueryResultRow } from "pg";

import {
  authorCommand,
  newYorkDateSql,
  nowParam,
  opaqueId,
  publishingAuthorActions,
  readAuthorReceipt,
  readTransaction,
  selectSettings,
} from "./db.js";
import type { PublishingDb } from "./db.js";
import { trimHistory } from "./drafts.js";
import {
  attachItems,
  cancelItems,
  legacyNeedsSql,
  releaseRefs,
} from "./media.js";

/*
 * Explicit idempotent submissions and the receipt query for lost responses
 * (design §2.4), plus the revision transitions shared with visibility changes
 * and operator moderation. Stored text is always the normalized form, and
 * revision content identity comes only from community.work_content_sha256.
 */

/** Quick-composer bound for a Thread post; the general editor keeps its own limits. */
const THREAD_QUICK_COMPOSER_ITEMS = 3;

const fail = (code: WorkPublishingFailureCode): never => {
  throw new CommunityInputError(code);
};

interface TextCodes {
  readonly tooLong: WorkPublishingFailureCode;
  readonly lineBreak?: WorkPublishingFailureCode;
}

/** The normalized value of one field, or the field-specific rejection. */
const normalizedText = (
  raw: string,
  rule: PublishingTextRule,
  codes: TextCodes,
): string => {
  const { value, issue } = checkPublishingText(raw, rule);
  if (issue === null) return value;
  if (issue === "too_long") return fail(codes.tooLong);
  if (issue === "line_break" && codes.lineBreak !== undefined)
    return fail(codes.lineBreak);
  throw new CommunityInputError();
};

const authorshipRule = (
  maximum: number,
  singleLine: boolean,
): PublishingTextRule => ({
  maximum,
  singleLine,
  rawAllowance: DRAFT_TEXT_RAW_ALLOWANCE,
});

/** The submission content in its stored form. */
export interface NormalizedSubmission {
  readonly title: string;
  readonly body: string;
  /** Null when the submission declares no authorship. */
  readonly authorship: WorkAuthorship | null;
  readonly referenceTitle: string | null;
  readonly originalAuthor: string | null;
  readonly sourceNote: string | null;
  readonly content: WorkDraftContent;
  readonly coverItemId: string | null;
  readonly coverCrop: MediaCrop | null;
}

const optionalText = (
  raw: string | undefined,
  rule: PublishingTextRule,
  tooLong: WorkPublishingFailureCode,
): string | null => {
  if (raw === undefined) return null;
  const value = normalizedText(raw, rule, { tooLong });
  return value === "" ? null : value;
};

/**
 * Applies the shared counting rule (C02) to submitted content: single-line
 * normalized title, trimmed body with LF line breaks, authorship fields, the
 * empty-work rule and the cover reference.
 */
export const normalizeSubmission = (
  content: WorkSubmissionContent,
): NormalizedSubmission => {
  const title = normalizedText(content.title, publishingTitleRule, {
    tooLong: "title_too_long",
    lineBreak: "title_line_break",
  });
  const body = normalizedText(content.body, publishingBodyRule, {
    tooLong: "body_too_long",
  });
  if (isEmptyWorkContent(content)) fail("empty_work");
  // Not set stays not set: nothing is stored as `original` unless declared.
  const source = content.authorship;
  const referenced = source !== null && source.kind !== "original";
  const referenceTitle = referenced
    ? optionalText(
        source.referenceTitle,
        authorshipRule(AUTHORSHIP_REFERENCE_TITLE_MAXIMUM, true),
        "reference_title_too_long",
      )
    : null;
  const originalAuthor = referenced
    ? optionalText(
        source.originalAuthor,
        authorshipRule(AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM, true),
        "original_author_too_long",
      )
    : null;
  const sourceNote = referenced
    ? optionalText(
        source.sourceNote,
        authorshipRule(AUTHORSHIP_SOURCE_NOTE_MAXIMUM, false),
        "source_note_too_long",
      )
    : null;
  const authorship: WorkAuthorship | null =
    source === null
      ? null
      : source.kind === "original"
        ? { kind: "original" }
        : {
            kind: source.kind,
            ...(referenceTitle === null ? {} : { referenceTitle }),
            ...(originalAuthor === null ? {} : { originalAuthor }),
            ...(sourceNote === null ? {} : { sourceNote }),
          };
  const keys = new Set(content.items.map((item) => item.key));
  const itemIds = content.items.flatMap((item) =>
    item.itemId === null ? [] : [item.itemId],
  );
  if (
    keys.size !== content.items.length ||
    new Set(itemIds).size !== itemIds.length ||
    (content.coverKey !== null && !keys.has(content.coverKey)) ||
    (content.coverKey === null && content.coverCrop !== null)
  )
    throw new CommunityInputError();
  const cover =
    content.coverKey === null
      ? null
      : (content.items.find((item) => item.key === content.coverKey) ?? null);
  return {
    title,
    body,
    authorship,
    referenceTitle,
    originalAuthor,
    sourceNote,
    content: { ...content, title, body, authorship },
    coverItemId: cover?.itemId ?? null,
    coverCrop: cover === null ? null : content.coverCrop,
  };
};

const jsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/** Pending explicit submissions of the work other than `keep` become `disposition`. */
export const closePendingRevisions = async (
  db: PublishingDb,
  workId: string,
  disposition: "superseded" | "withdrawn",
  keep: string | null = null,
): Promise<void> => {
  await db.query(
    "UPDATE community.work_revisions SET disposition=$2,version=version+1 WHERE work_id=$1 AND disposition='pending' AND id IS DISTINCT FROM $3::text",
    [workId, disposition, keep],
  );
};

/**
 * Makes an approved revision the work's effective public revision: public
 * visibility, the first publication time set once, the Edited time only when
 * the content others last saw differs (the current public revision, or the
 * latest earlier approved revision when an older one was withheld), and the
 * denormalized public title and text.
 */
export const applyPublicRevision = async (
  db: PublishingDb,
  workId: string,
  revisionId: string,
  now: Date,
): Promise<void> => {
  const updated = await db.query(
    `UPDATE community.works w SET public_revision_id=r.id,visibility='public',
      first_published_at=COALESCE(w.first_published_at,$3::timestamptz),
      edited_at=CASE WHEN r.content_sha256 IS DISTINCT FROM COALESCE(
          (SELECT p.content_sha256 FROM community.work_revisions p WHERE p.id=w.public_revision_id AND p.id<>r.id),
          CASE WHEN w.public_revision_id IS NULL THEN (
            SELECT p.content_sha256 FROM community.work_revisions p
            WHERE p.work_id=w.id AND p.id<>r.id AND p.disposition='approved'
            ORDER BY p.sequence DESC LIMIT 1
          ) END,
          r.content_sha256)
        THEN $3::timestamptz ELSE w.edited_at END,
      title=r.title,text=r.body
    FROM community.work_revisions r
    WHERE w.id=$1 AND r.id=$2 AND r.work_id=w.id`,
    [workId, revisionId, nowParam(now)],
  );
  if (updated.rowCount !== 1) throw new CommunityNotFoundError();
  const author = (
    await db.query<{ author_id: string }>(
      "SELECT author_id FROM community.works WHERE id=$1",
      [workId],
    )
  ).rows[0]!;
  await enqueueNotification(db, "work_mention", workId, author.author_id);
  // Restore only recorded task-era effects that could not project while private.
  await db.query(
    `UPDATE community.notification_sources SET generation=generation+1,attempts=0,
      run_after=CURRENT_TIMESTAMP,error_code=NULL
      WHERE (kind='work_like' AND subject_id=$1) OR (kind IN ('comment','comment_like') AND subject_id IN (
        SELECT id FROM community.catalog_comments WHERE target_type='work' AND catalog_id=$1
        UNION ALL SELECT r.id FROM community.catalog_comment_replies r
          JOIN community.catalog_comments c ON c.id=r.root_comment_id WHERE c.target_type='work' AND c.catalog_id=$1))`,
    [workId],
  );
};

/**
 * A self-only work that asks to become public again under pre-moderation
 * stays unseen until the pending revision is approved, including unchanged
 * previously approved content. Call only when the work was self-only; a
 * work that stayed public retains V1 while its V2 submission is pending.
 */
export const withholdReplacedPublicRevision = async (
  db: PublishingDb,
  workId: string,
  pendingRevisionId: string,
): Promise<void> => {
  await db.query(
    `UPDATE community.works w SET public_revision_id=NULL,title='',text=''
    FROM community.work_revisions r
    WHERE w.id=$1 AND r.id=$2 AND r.work_id=w.id`,
    [workId, pendingRevisionId],
  );
};

/** Records a change of the work row itself (optimistic operator version and time). */
export const touchWork = async (
  db: PublishingDb,
  workId: string,
  now: Date,
): Promise<void> => {
  await db.query(
    "UPDATE community.works SET version=version+1,updated_at=$2::timestamptz WHERE id=$1",
    [workId, nowParam(now)],
  );
};

interface DraftHolderRow extends QueryResultRow {
  id: string;
  work_id: string | null;
  base_revision_id: string | null;
  state: string;
  conflict_of: string | null;
  revision: number;
  content: WorkDraftContent;
}

interface SessionHolderRow extends QueryResultRow {
  id: string;
  work_id: string | null;
  state: string;
  live: boolean;
}

interface Holder {
  readonly kind: "draft" | "session";
  readonly id: string;
  readonly workId: string | null;
  readonly baseRevisionId: string | null;
  readonly revision: number | null;
  /** The draft's stored content; null for a session. */
  readonly content: WorkDraftContent | null;
}

/**
 * Locks the actor's active holder; a holder that moved on is a conflict. A
 * session is usable under the rule `expireSession` applies: its lease has not
 * lapsed, or a transfer progressed within one lease period.
 */
const lockHolder = async (
  db: PublishingDb,
  actorId: string,
  command: WorkSubmissionCommand,
  now: Date,
): Promise<Holder> => {
  if ("draftId" in command.holder) {
    const draft = (
      await db.query<DraftHolderRow>(
        "SELECT id,work_id,base_revision_id,state,conflict_of,revision,content FROM community.work_drafts WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [command.holder.draftId, actorId],
      )
    ).rows[0];
    if (draft === undefined || draft.conflict_of !== null)
      throw new CommunityNotFoundError();
    if (draft.state !== "active")
      throw new CommunityConflictError("The draft is no longer active");
    return {
      kind: "draft",
      id: draft.id,
      workId: draft.work_id,
      baseRevisionId: draft.base_revision_id,
      revision: draft.revision,
      content: draft.content,
    };
  }
  const session = (
    await db.query<SessionHolderRow>(
      `SELECT s.id,s.work_id,s.state,s.lease_expires_at>=$3::timestamptz OR EXISTS (
        SELECT 1 FROM community.media_item_refs r
        JOIN community.media_components c ON c.item_id=r.item_id
        CROSS JOIN community.work_publishing_settings st
        WHERE st.id='settings' AND r.holder_kind='session' AND r.holder_id=s.id
          AND c.state='receiving'
          AND c.updated_at>=$3::timestamptz-make_interval(mins=>st.unsaved_session_lease_minutes)
      ) AS live
      FROM community.publishing_sessions s WHERE s.id=$1 AND s.owner_id=$2 FOR UPDATE OF s`,
      [command.holder.sessionId, actorId, nowParam(now)],
    )
  ).rows[0];
  if (session === undefined) throw new CommunityNotFoundError();
  if (session.state !== "active" || !session.live)
    throw new CommunityConflictError("The publishing session has ended");
  return {
    kind: "session",
    id: session.id,
    workId: session.work_id,
    baseRevisionId: null,
    revision: null,
    content: null,
  };
};

interface WorkLockRow extends QueryResultRow {
  id: string;
  visibility: "public" | "self";
  author_revision_id: string | null;
  trashed_at: Date | null;
  deleted_at: Date | null;
  operator_state: "visible" | "hidden" | "removed";
}

interface ReadinessRow extends QueryResultRow {
  key: string;
  item_id: string | null;
  found_id: string | null;
  owner_id: string | null;
  ready: boolean;
}

/**
 * Keys of content items that are placeholders, not ready, or missing the
 * derivatives of their edit. Items the actor does not own are not found.
 *
 * Readiness is the rule `ensureContentDerivatives` applies: every derivative
 * `community.media_required_derivatives` lists has a recorded row, except a
 * legacy item's `base` derivatives (its unedited form is the user media PNG;
 * a rotation, crop or cover crop derives from those bytes like any item).
 * Derivative rows a holder needs are never released, and blobs are only
 * tombstoned once their row is gone, so a recorded row of a ready item always
 * names a committed blob.
 */
const notReadyKeys = async (
  db: PublishingDb,
  actorId: string,
  normalized: NormalizedSubmission,
): Promise<string[]> => {
  const items = normalized.content.items;
  const ids = items.flatMap((item) =>
    item.itemId === null ? [] : [item.itemId],
  );
  // Cancel, purge and processing transitions wait until this submission
  // commits and then see its revision refs.
  await db.query(
    "SELECT id FROM community.media_items WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE",
    [ids],
  );
  const rows = (
    await db.query<ReadinessRow>(
      `SELECT e.item->>'key' AS key,e.item->>'itemId' AS item_id,i.id AS found_id,i.owner_id,
        CASE
          WHEN i.id IS NULL OR i.state<>'ready' THEN FALSE
          ELSE NOT EXISTS (
            SELECT 1 FROM community.media_required_derivatives(i.kind,e.item->'edit',e.item->>'key' IS NOT DISTINCT FROM $2::text,CASE WHEN e.item->>'key'=$2::text THEN $3::jsonb END) req
            WHERE ${legacyNeedsSql("i", "req")} AND NOT EXISTS (
              SELECT 1 FROM community.media_derivatives d
              WHERE d.item_id=i.id AND d.variant=req.variant AND d.edit_key=req.edit_key
            )
          )
        END AS ready
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(item,ordinal)
      LEFT JOIN community.media_items i ON i.id=e.item->>'itemId'
      ORDER BY e.ordinal`,
      [
        JSON.stringify(
          items.map((item) => ({
            key: item.key,
            itemId: item.itemId,
            edit: item.edit,
          })),
        ),
        normalized.content.coverKey,
        jsonOrNull(normalized.coverCrop),
      ],
    )
  ).rows;
  for (const row of rows)
    if (
      row.item_id !== null &&
      (row.found_id === null || row.owner_id !== actorId)
    )
      throw new CommunityNotFoundError();
  return rows.flatMap((row) => (row.ready ? [] : [row.key]));
};

/** Counts the first submission of a new work on the America/New_York date of `now`. */
const countNewWork = async (
  db: PublishingDb,
  actorId: string,
  settings: WorkPublishingSettings,
  now: Date,
): Promise<void> => {
  const count = (
    await db.query<{ count: number }>(
      `INSERT INTO community.daily_new_work_submissions(account_id,ny_date,count)
      VALUES($1,${newYorkDateSql("$2")},1)
      ON CONFLICT (account_id,ny_date) DO UPDATE SET count=community.daily_new_work_submissions.count+1
      RETURNING count`,
      [actorId, nowParam(now)],
    )
  ).rows[0]?.count;
  if (count === undefined || count > settings.dailyNewWorkLimit)
    fail("daily_limit");
};

/** Inserts one snapshot of `content` with refs to the actor's live items. */
const insertSnapshot = async (
  db: PublishingDb,
  actorId: string,
  holder: Holder,
  workId: string,
  kind: "submitted" | "conflict",
  content: WorkDraftContent,
  now: Date,
): Promise<void> => {
  const snapshotId = opaqueId("work-snapshot");
  await db.query(
    `INSERT INTO community.work_draft_snapshots(id,owner_id,draft_id,work_id,kind,content,source_revision,pinned,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz)`,
    [
      snapshotId,
      actorId,
      holder.id,
      workId,
      kind,
      JSON.stringify(content),
      holder.revision,
      kind === "conflict",
      nowParam(now),
    ],
  );
  await attachItems(
    db,
    actorId,
    "snapshot",
    snapshotId,
    content.items.flatMap((item) =>
      item.itemId === null ? [] : [item.itemId],
    ),
  );
};

const comparableText = (raw: string | undefined): string | undefined => {
  const value = raw === undefined ? "" : normalizePublishingBody(raw);
  return value === "" ? undefined : value;
};

/** Content items without their presentation provenance (`origin`). */
const comparableItems = (content: WorkDraftContent): unknown[] =>
  content.items.map((item) => {
    const comparable: Partial<WorkDraftContent["items"][number]> = { ...item };
    delete comparable.origin;
    return comparable;
  });

/**
 * Stored draft content in the form a submission of the same input stores:
 * normalized text, authorship without empty optional fields (JSON drops the
 * fields left undefined), and items without their presentation provenance.
 * Only compared as JSON.
 */
const comparableDraftContent = (content: WorkDraftContent): unknown => {
  const source = content.authorship;
  return {
    ...content,
    items: comparableItems(content),
    title: normalizePublishingTitle(content.title),
    body: normalizePublishingBody(content.body),
    authorship:
      source === null
        ? null
        : source.kind === "original"
          ? { kind: "original" }
          : {
              kind: source.kind,
              referenceTitle: comparableText(source.referenceTitle),
              originalAuthor: comparableText(source.originalAuthor),
              sourceNote: comparableText(source.sourceNote),
            },
  };
};

/**
 * The holder's refs move to the revision (already written); the holder ends
 * in `submitted`.
 *
 * A session's items the revision does not hold are cancelled at once, as a
 * discard would (D05, D08, A06): uploads and processing stop being accounted
 * and their commit fence answers `cancelled`.
 *
 * A draft records a `submitted` snapshot. When the draft holds content other
 * than what was submitted (another device saved after this one loaded it, or
 * this device submitted before its last save), that stored content is first
 * kept as a pinned `conflict` snapshot in the work's history, so a
 * submission never makes newer saved input unreachable (V03, V05).
 */
const transferHolder = async (
  db: PublishingDb,
  actorId: string,
  holder: Holder,
  workId: string,
  normalized: NormalizedSubmission,
  settings: WorkPublishingSettings,
  now: Date,
): Promise<void> => {
  const at = nowParam(now);
  if (holder.kind === "session") {
    await db.query(
      "UPDATE community.publishing_sessions SET state='submitted',ended_at=$2::timestamptz WHERE id=$1",
      [holder.id, at],
    );
    const released = await releaseRefs(db, "session", [holder.id], now);
    await cancelItems(db, released, now, { onlyUnreferenced: true });
    return;
  }
  await db.query(
    "UPDATE community.work_drafts SET state='submitted',submitted_at=$2::timestamptz,updated_at=$2::timestamptz,work_id=COALESCE(work_id,$3) WHERE id=$1",
    [holder.id, at, workId],
  );
  // Unresolved conflict copies of a new work's draft join the work's lineage
  // too (their content is preserved; only the work binding was missing), so a
  // later recycle-bin purge finds them as holders and releases their media
  // references instead of deleting them with dangling refs.
  await db.query(
    "UPDATE community.work_drafts SET work_id=COALESCE(work_id,$3) WHERE conflict_of=$1 AND owner_id=$2",
    [holder.id, actorId, workId],
  );
  // A new work's draft history joins the work's lineage.
  await db.query(
    "UPDATE community.work_draft_snapshots SET work_id=$2 WHERE draft_id=$1 AND work_id IS NULL",
    [holder.id, workId],
  );
  if (holder.content !== null) {
    const same = (
      await db.query<{ same: boolean }>("SELECT $1::jsonb=$2::jsonb AS same", [
        JSON.stringify(comparableDraftContent(holder.content)),
        JSON.stringify({
          ...normalized.content,
          items: comparableItems(normalized.content),
        }),
      ])
    ).rows[0]?.same;
    if (same !== true)
      await insertSnapshot(
        db,
        actorId,
        holder,
        workId,
        "conflict",
        holder.content,
        now,
      );
  }
  await insertSnapshot(
    db,
    actorId,
    holder,
    workId,
    "submitted",
    normalized.content,
    now,
  );
  // The draft's refs and evicted history go in one item lock pass.
  await trimHistory(db, actorId, workId, settings.historyLimit, now, [
    { holderKind: "draft", holderIds: [holder.id] },
  ]);
};

const submitInTransaction = async (
  db: PublishingDb,
  actorId: string,
  command: WorkSubmissionCommand,
  now: Date,
): Promise<WorkSubmissionResult> => {
  const normalized = normalizeSubmission(command.content);
  const settings = await selectSettings(db, "share");
  const holder = await lockHolder(db, actorId, command, now);
  const at = nowParam(now);

  let work: WorkLockRow | null = null;
  if (holder.workId === null) {
    if (command.baseRevisionId !== null)
      throw new CommunityConflictError("A new work has no base revision");
  } else {
    work =
      (
        await db.query<WorkLockRow>(
          "SELECT id,visibility,author_revision_id,trashed_at,deleted_at,operator_state FROM community.works WHERE id=$1 AND author_id=$2 FOR UPDATE",
          [holder.workId, actorId],
        )
      ).rows[0] ?? null;
    if (work === null) throw new CommunityNotFoundError();
    if (
      work.deleted_at !== null ||
      work.trashed_at !== null ||
      work.operator_state === "removed"
    )
      fail("work_unavailable");
    if (
      command.baseRevisionId !== work.author_revision_id ||
      (holder.kind === "draft" &&
        holder.baseRevisionId !== work.author_revision_id)
    )
      throw new CommunityConflictError(
        "The work changed since this edit started",
      );
  }

  const items = normalized.content.items;
  if (items.length > settings.maxItemsPerWork) fail("items_limit");
  // content-community-completion-v1: a Thread post is this Work, associated in
  // the same transaction. Only a NEW work may join a Thread (an existing Work
  // is never reassigned), the quick composer carries at most three static
  // items, and the Thread is rechecked under lock at commit, not only when the
  // composer opened.
  if (command.threadId !== undefined) {
    if (work !== null) {
      const existing = await db.query<{ thread_id: string }>(
        "SELECT thread_id FROM community.thread_works WHERE work_id=$1",
        [work.id],
      );
      if (existing.rows[0]?.thread_id !== command.threadId)
        fail("thread_conflict");
    }
    if (items.length > THREAD_QUICK_COMPOSER_ITEMS) fail("thread_items_limit");
    if (items.length > 0) {
      const nonStatic = await db.query<{ total: string }>(
        "SELECT count(*) AS total FROM community.media_items WHERE id = ANY($1::text[]) AND kind <> 'static'",
        [items.map((item) => item.itemId)],
      );
      if (Number(nonStatic.rows[0]?.total ?? 0) > 0) fail("thread_items_limit");
    }
    const thread = await db.query<{ status: string; hidden_at: Date | null }>(
      "SELECT status, hidden_at FROM community.threads WHERE id=$1 FOR SHARE",
      [command.threadId],
    );
    const row = thread.rows[0];
    if (!row || row.hidden_at !== null || row.status !== "open")
      fail("thread_unavailable");
  }
  const pending = await notReadyKeys(db, actorId, normalized);
  if (pending.length > 0) return { state: "not_ready", itemKeys: pending };

  const workId = work?.id ?? opaqueId("work");
  const visibility = normalized.content.visibility;
  if (work === null) {
    await countNewWork(db, actorId, settings, now);
    await db.query(
      `INSERT INTO community.works(id,author_id,title,text,first_published_at,updated_at,visibility,created_via,first_submitted_at)
      VALUES($1,$2,'','',NULL,$3::timestamptz,$4,'publishing',$3::timestamptz)`,
      [workId, actorId, at, visibility],
    );
    // The association commits with the Work; UNIQUE(work_id) keeps one Thread per Work.
    if (command.threadId !== undefined)
      await db.query(
        "INSERT INTO community.thread_works(thread_id, work_id, created_at) VALUES($1,$2,$3::timestamptz)",
        [command.threadId, workId, at],
      );
  }

  const disposition =
    visibility === "self"
      ? "not_required"
      : settings.policy === "DIRECT_PUBLICATION"
        ? "approved"
        : "pending";
  await validateMentionUsers(
    db,
    actorId,
    normalized.body,
    normalized.content.mentions ?? [],
  );
  const revisionId = opaqueId("work-revision");
  const sequence = (
    await db.query<{ next: number }>(
      "SELECT COALESCE(max(sequence),0)+1 AS next FROM community.work_revisions WHERE work_id=$1",
      [workId],
    )
  ).rows[0]!.next;
  await db.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,
      reference_title,original_author,source_note,requested_visibility,cover_item_id,cover_crop,content_sha256,
      disposition,submitted_at,decided_at,request_id,mentions)
    VALUES($1,$2,$3,$4,'submission',$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11,$12::text,$13::jsonb,
      CASE WHEN $19::jsonb='[]'::jsonb THEN community.work_content_sha256($5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$14::jsonb,$12::text,$13::jsonb) ELSE encode(sha256(convert_to(community.work_content_sha256($5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$14::jsonb,$12::text,$13::jsonb) || ($19::jsonb)::text,'UTF8')),'hex') END,
      $15,$16::timestamptz,$17::timestamptz,$18::uuid,$19::jsonb)`,
    [
      revisionId,
      workId,
      actorId,
      sequence,
      normalized.title,
      normalized.body,
      normalized.authorship?.kind ?? null,
      normalized.referenceTitle,
      normalized.originalAuthor,
      normalized.sourceNote,
      visibility,
      normalized.coverItemId,
      jsonOrNull(normalized.coverCrop),
      JSON.stringify(
        items.map((item) => ({ itemId: item.itemId, edit: item.edit })),
      ),
      disposition,
      at,
      disposition === "approved" ? at : null,
      command.requestId,
      JSON.stringify(normalized.content.mentions ?? []),
    ],
  );
  await db.query(
    `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit)
    SELECT $1,e.ordinal,e.item->>'itemId',e.item->'edit' FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(item,ordinal)`,
    [
      revisionId,
      JSON.stringify(
        items.map((item) => ({ itemId: item.itemId, edit: item.edit })),
      ),
    ],
  );
  await db.query(
    "INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id) SELECT item_id,'revision',revision_id FROM community.work_revision_items WHERE revision_id=$1 ON CONFLICT DO NOTHING",
    [revisionId],
  );
  // A self-only submission withdraws pending public intent (P10).
  await closePendingRevisions(
    db,
    workId,
    visibility === "self" ? "withdrawn" : "superseded",
    revisionId,
  );

  await db.query(
    "UPDATE community.works SET author_revision_id=$2,visibility=$3,updated_at=$4::timestamptz WHERE id=$1",
    [workId, revisionId, visibility, at],
  );
  if (disposition === "approved")
    await applyPublicRevision(db, workId, revisionId, now);
  else if (disposition === "pending" && work?.visibility === "self")
    await withholdReplacedPublicRevision(db, workId, revisionId);
  if (work !== null) await touchWork(db, workId, now);

  await transferHolder(db, actorId, holder, workId, normalized, settings, now);
  return workSubmissionReceiptSchema.parse({
    state: "confirmed",
    requestId: command.requestId,
    workId,
    revisionId,
    visibility,
    submittedAt: now.toISOString(),
  });
};

const holderId = (command: WorkSubmissionCommand): string =>
  "draftId" in command.holder
    ? command.holder.draftId
    : command.holder.sessionId;

/** WorkPublishingPort.submit */
export const submit = async (
  pool: Pool,
  actorId: string,
  command: WorkSubmissionCommand,
  now: Date,
): Promise<WorkSubmissionResult> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.submit,
      subjectId: holderId(command),
      input: command,
      now,
    },
    (db) => submitInTransaction(db, actorId, command, now),
    {
      record: (result) => result.state === "confirmed",
      auditSubject: (result) =>
        result.state === "confirmed" ? result.workId : holderId(command),
    },
  );

/** WorkPublishingPort.readSubmissionReceipt */
export const readSubmissionReceipt = async (
  pool: Pool,
  actorId: string,
  requestId: string,
): Promise<WorkSubmissionReceipt | null> =>
  readTransaction(pool, async (db) => {
    const active = await db.query(
      "SELECT id FROM community.public_users WHERE id=$1 AND status='active'",
      [actorId],
    );
    if (active.rowCount !== 1) throw new CommunityNotFoundError();
    const stored = workSubmissionReceiptSchema.safeParse(
      await readAuthorReceipt(db, actorId, requestId),
    );
    return stored.success && stored.data.requestId === requestId
      ? stored.data
      : null;
  });
