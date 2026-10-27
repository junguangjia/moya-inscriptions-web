import type { PublishingAccountPurge } from "@moya/api";
import type { WorkDraftContent } from "@moya/contracts";
import type { Pool } from "pg";

import {
  ERASED_ARTICLE_DOCUMENT,
  articleHoldsContentSql,
  endArticleDraft,
  eraseEndedArticleDraft,
} from "../article-authoring/postgres-article-authoring-adapter.js";
import { nowParam, writeTransaction, type PublishingDb } from "./db.js";
import { eraseDraft } from "./drafts.js";
import { cancelItems, releaseHolderRefs } from "./media.js";
import { releaseProfileRenditions } from "./profile-assets.js";
import type { PublicationSyncOptions } from "./publication-sync.js";
import { endSession } from "./sessions.js";
import { eraseWork } from "./works.js";

/*
 * The background purge of a deleted account (account-deletion-v1, job
 * `purge_deleted_account`, WorkPublishingPort.purgeDeletedAccount). The
 * deletion transaction already anonymized the profile, ended every session
 * and login, withdrew public copies and queued this job; the purge erases
 * what the account authored with the same primitives an author's own
 * deletions use, so the existing `purge_item`, `purge_blob` and publication
 * jobs delete the bytes. Owner-agnostic: the deleted account's row lock
 * stands in for the author command's active actor lock, and no receipt or
 * audit row is written.
 *
 * Kept by decision: comments, replies and direct messages (anonymized by the
 * account status), feedback and its images, report evidence, and submitted
 * or published article revisions (immutable, hidden by the account status).
 * Article drafts end as an author's draft deletion ends them, and their
 * title, document and cover are emptied in the same update; drafts the
 * author had already deleted, which kept their content, are emptied too.
 *
 * Lock order (as every publishing transaction): account → holder (session,
 * draft) → work → item → blob → component → capacity; user media after
 * items, as a work deletion takes them.
 */

/** Rows one purge transaction handles per step at most. */
export interface AccountPurgeLimits {
  readonly works: number;
  readonly sessions: number;
  readonly drafts: number;
  readonly articles: number;
  readonly items: number;
  readonly images: number;
  readonly receipts: number;
  readonly relations: number;
}

/**
 * One transaction stays short: at most this much of a step, and a step that
 * reaches its bound ends the run (the job runs again for the rest).
 */
export const ACCOUNT_PURGE_LIMITS: AccountPurgeLimits = Object.freeze({
  works: 20,
  sessions: 20,
  drafts: 20,
  articles: 20,
  items: 100,
  images: 50,
  receipts: 500,
  relations: 500,
});

const RECEIPT_TOMBSTONE = '{"permanentlyDeleted":true}';

/**
 * SQL: work alias `w` still holds content an erasure removes. A trash
 * purge marks a work deleted but keeps its title, text, media list and
 * revisions; an erased work keeps none of them.
 */
const workHoldsContentSql = `(w.deleted_at IS NULL OR w.title<>'' OR w.text<>''
  OR cardinality(w.media_ids)>0 OR w.public_revision_id IS NOT NULL OR w.author_revision_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM community.work_revisions r WHERE r.work_id=w.id)
  OR EXISTS (SELECT 1 FROM community.work_drafts d WHERE d.work_id=w.id)
  OR EXISTS (SELECT 1 FROM community.work_draft_snapshots s WHERE s.work_id=w.id)
  OR EXISTS (SELECT 1 FROM community.work_edit_drafts e WHERE e.work_id=w.id))`;

interface PurgeContext {
  readonly db: PublishingDb;
  readonly accountId: string;
  readonly now: Date;
  readonly publication: PublicationSyncOptions | undefined;
  /** Components whose transfers must stop (cancelled items). */
  readonly stopped: string[];
}

/** One step: handles up to `limit` rows, resolves how many it handled. */
type PurgeStep = (context: PurgeContext, limit: number) => Promise<number>;

/** Every work that still holds content, trashed and trash-purged ones too. */
const purgeWorks: PurgeStep = async (context, limit) => {
  const works = (
    await context.db.query<{ id: string }>(
      `SELECT w.id FROM community.works w
       WHERE w.author_id=$1 AND ${workHoldsContentSql}
       ORDER BY w.id LIMIT $2`,
      [context.accountId, limit],
    )
  ).rows;
  for (const work of works)
    await eraseWork(
      context.db,
      context.accountId,
      work.id,
      context.now,
      context.publication,
      "any",
    );
  return works.length;
};

/**
 * Active sessions are discarded (their unreferenced media cancelled); any
 * session that still names a draft lets go of it before drafts go.
 */
const purgeSessions: PurgeStep = async (context, limit) => {
  const sessions = (
    await context.db.query<{ id: string; state: string }>(
      `SELECT id,state FROM community.publishing_sessions
       WHERE owner_id=$1 AND (state='active' OR draft_id IS NOT NULL)
       ORDER BY id LIMIT $2 FOR UPDATE`,
      [context.accountId, limit],
    )
  ).rows;
  for (const session of sessions)
    if (session.state === "active")
      context.stopped.push(
        ...(await endSession(context.db, session.id, "discarded", context.now)),
      );
  await context.db.query(
    "UPDATE community.publishing_sessions SET draft_id=NULL WHERE id=ANY($1::text[]) AND draft_id IS NOT NULL",
    [sessions.map((session) => session.id)],
  );
  return sessions.length;
};

/**
 * Drafts with their conflict copies and snapshots, then any snapshot that
 * outlived its lineage (its media is cancelled with the account's rest).
 */
const purgeDrafts: PurgeStep = async (context, limit) => {
  const drafts = (
    await context.db.query<{ id: string; content: WorkDraftContent }>(
      `SELECT id,content FROM community.work_drafts
       WHERE owner_id=$1 AND conflict_of IS NULL
       ORDER BY id LIMIT $2 FOR UPDATE`,
      [context.accountId, limit],
    )
  ).rows;
  for (const draft of drafts)
    context.stopped.push(
      ...(await eraseDraft(context.db, context.accountId, draft, context.now))
        .cancelledComponentIds,
    );
  if (drafts.length === limit) return drafts.length;
  const snapshots = (
    await context.db.query<{ id: string }>(
      "SELECT id FROM community.work_draft_snapshots WHERE owner_id=$1 ORDER BY id LIMIT $2 FOR UPDATE",
      [context.accountId, limit - drafts.length],
    )
  ).rows.map((row) => row.id);
  if (snapshots.length > 0) {
    await releaseHolderRefs(
      context.db,
      [{ holderKind: "snapshot", holderIds: snapshots }],
      context.now,
    );
    await context.db.query(
      "DELETE FROM community.work_draft_snapshots WHERE id=ANY($1::text[])",
      [snapshots],
    );
  }
  return drafts.length + snapshots.length;
};

/**
 * Article drafts end as an author's draft deletion ends them; their stored
 * title, document and cover are emptied as they end. A draft the author had
 * already deleted kept that content and is emptied now (an author's own
 * deletion does not erase it); an emptied one is never selected again.
 */
const purgeArticleDrafts: PurgeStep = async (context, limit) => {
  const articles = (
    await context.db.query<{ id: string; ended: boolean }>(
      `SELECT a.id,a.deleted_at IS NOT NULL AS ended FROM community.article_documents a
       WHERE a.owner_id=$1 AND ${articleHoldsContentSql("$3")}
       ORDER BY a.id LIMIT $2 FOR UPDATE`,
      [context.accountId, limit, ERASED_ARTICLE_DOCUMENT],
    )
  ).rows;
  for (const article of articles)
    if (article.ended)
      await eraseEndedArticleDraft(
        context.db,
        context.accountId,
        article.id,
        context.now,
      );
    else
      await endArticleDraft(
        context.db,
        context.accountId,
        article.id,
        context.now,
        { eraseContent: true },
      );
  return articles.length;
};

/**
 * The account's media no holder references any more is cancelled, so its
 * purge runs at once instead of after the orphan grace. Media a feedback or
 * a published article revision holds keeps its ref and is never selected.
 */
const purgeItems: PurgeStep = async (context, limit) => {
  const items = (
    await context.db.query<{ id: string }>(
      `SELECT i.id FROM community.media_items i
       WHERE i.owner_id=$1 AND i.state NOT IN ('cancelled','purged')
         AND NOT EXISTS (SELECT 1 FROM community.media_item_refs r WHERE r.item_id=i.id)
       ORDER BY i.id LIMIT $2`,
      [context.accountId, limit],
    )
  ).rows.map((row) => row.id);
  const { cancelledComponentIds } = await cancelItems(
    context.db,
    items,
    context.now,
    { onlyUnreferenced: true },
  );
  context.stopped.push(...cancelledComponentIds);
  return items.length;
};

/**
 * Every profile and legacy image of the account (current and former avatars
 * and backgrounds, legacy work images) keeps only its row: empty bytes and
 * the erasure time. The row lock comes first, as a profile render's
 * recording expects; its renditions are released for the purge schedule.
 */
const purgeImages: PurgeStep = async (context, limit) => {
  const erased = (
    await context.db.query<{ id: string }>(
      `WITH doomed AS (
         SELECT id FROM community.user_media
         WHERE owner_id=$1 AND deleted_at IS NULL
         ORDER BY id LIMIT $2 FOR UPDATE
       )
       UPDATE community.user_media m SET bytes=''::bytea,deleted_at=$3::timestamptz
       FROM doomed WHERE m.id=doomed.id
       RETURNING m.id`,
      [context.accountId, limit, nowParam(context.now)],
    )
  ).rows.map((row) => row.id);
  await releaseProfileRenditions(context.db, erased, context.now);
  return erased.length;
};

/**
 * Author command receipts may carry draft, work, article or profile
 * content; the deleted account never replays one, so every payload becomes
 * the content-free tombstone a deletion writes.
 */
const purgeReceipts: PurgeStep = async (context, limit) =>
  (
    await context.db.query(
      `WITH doomed AS MATERIALIZED (
         SELECT request_id FROM community.author_command_receipts
         WHERE actor_id=$1 AND result IS DISTINCT FROM $3::jsonb
         ORDER BY request_id LIMIT $2
       )
       UPDATE community.author_command_receipts c SET result=$3::jsonb
       FROM doomed WHERE c.actor_id=$1 AND c.request_id=doomed.request_id`,
      [context.accountId, limit, RECEIPT_TOMBSTONE],
    )
  ).rowCount ?? 0;

/**
 * The deletion's relation statements once more: follows naming the account
 * and the blocks it set. Another user's follow that found the account still
 * active can wait for the deletion's row lock and commit just after it.
 * Blocks other users set against the account stay in force (r3).
 */
const purgeRelations: PurgeStep = async (context, limit) => {
  const follows =
    (
      await context.db.query(
        `WITH doomed AS MATERIALIZED (
           SELECT follower_id,followed_id FROM community.follows
           WHERE follower_id=$1 OR followed_id=$1
           LIMIT $2
         )
         DELETE FROM community.follows f USING doomed
         WHERE f.follower_id=doomed.follower_id AND f.followed_id=doomed.followed_id`,
        [context.accountId, limit],
      )
    ).rowCount ?? 0;
  if (follows === limit) return follows;
  const blocks =
    (
      await context.db.query(
        `WITH doomed AS MATERIALIZED (
           SELECT blocked_id FROM community.blocks WHERE blocker_id=$1 LIMIT $2
         )
         DELETE FROM community.blocks b USING doomed
         WHERE b.blocker_id=$1 AND b.blocked_id=doomed.blocked_id`,
        [context.accountId, limit - follows],
      )
    ).rowCount ?? 0;
  return follows + blocks;
};

/**
 * Steps in dependency order: holders go before the media they hold. The
 * relations go last, right before the record completes.
 */
const PURGE_STEPS: readonly (readonly [keyof AccountPurgeLimits, PurgeStep])[] =
  [
    ["works", purgeWorks],
    ["sessions", purgeSessions],
    ["drafts", purgeDrafts],
    ["articles", purgeArticleDrafts],
    ["items", purgeItems],
    ["images", purgeImages],
    ["receipts", purgeReceipts],
    ["relations", purgeRelations],
  ];

/** WorkPublishingPort.purgeDeletedAccount */
export const purgeDeletedAccount = async (
  pool: Pool,
  accountId: string,
  now: Date,
  publication?: PublicationSyncOptions,
  limits: AccountPurgeLimits = ACCOUNT_PURGE_LIMITS,
): Promise<PublishingAccountPurge> => {
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const account = await db.query(
      "SELECT id FROM community.public_users WHERE id=$1 AND status='deleted' FOR NO KEY UPDATE",
      [accountId],
    );
    if (account.rowCount !== 1)
      return { status: "missing", cancelledComponentIds: [] };
    const deletion = (
      await db.query<{ purge_state: "pending" | "completed" }>(
        "SELECT purge_state FROM community.account_deletions WHERE user_id=$1 FOR UPDATE",
        [accountId],
      )
    ).rows[0];
    if (deletion === undefined)
      return { status: "missing", cancelledComponentIds: [] };
    if (deletion.purge_state === "completed")
      return { status: "purged", cancelledComponentIds: [] };
    const context: PurgeContext = {
      db,
      accountId,
      now,
      publication,
      stopped: [],
    };
    for (const [bound, step] of PURGE_STEPS)
      if ((await step(context, limits[bound])) >= limits[bound])
        return { status: "partial", cancelledComponentIds: context.stopped };
    // Another clock may trail the deletion's by a moment; the record never
    // completes before the deletion.
    await db.query(
      `UPDATE community.account_deletions
       SET purge_state='completed',purge_completed_at=GREATEST($2::timestamptz,deleted_at)
       WHERE user_id=$1 AND purge_state='pending'`,
      [accountId, at],
    );
    return { status: "purged", cancelledComponentIds: context.stopped };
  });
};
