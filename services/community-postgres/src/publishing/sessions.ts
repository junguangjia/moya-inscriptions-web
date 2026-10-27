import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type {
  CreatePublishingSessionCommand,
  PublishingSession,
} from "@moya/contracts";
import { publishingSessionSchema } from "@moya/contracts/schemas";
import type {
  PublishingCommandIdentity,
  PublishingSessionDiscard,
  PublishingSessionExpiry,
} from "@moya/api";
import type { Pool } from "pg";

import {
  actorTransaction,
  authorCommand,
  nowParam,
  opaqueId,
  publishingAuthorActions,
  selectSettings,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { cancelItems } from "./media.js";

/*
 * No-save temporary sessions: create, heartbeat, discard and lease expiry.
 * Owner: B1a. Each function implements the same-named WorkPublishingPort method
 * (see its JSDoc in @moya/api); `pool` is the adapter's pool. Shared helpers: ./db.ts.
 */

interface SessionRow {
  id: string;
  owner_id: string;
  state: PublishingSession["state"];
  work_id: string | null;
  lease_expires_at: Date;
  created_at: Date;
}

const sessionColumns = "id,owner_id,state,work_id,lease_expires_at,created_at";

const sessionDto = (row: SessionRow): PublishingSession =>
  publishingSessionSchema.parse({
    id: row.id,
    state: row.state,
    workId: row.work_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  });

/**
 * Ends a session with `state` (`discarded` or `expired`): its refs are
 * removed, and the items no other holder references are cancelled with their
 * reservations released and purges enqueued. Works, revisions and drafts are
 * never touched. The session row must already be locked (also by the account
 * purge of a deleted account, account-deletion-v1).
 */
export const endSession = async (
  db: PublishingDb,
  sessionId: string,
  state: "discarded" | "expired",
  now: Date,
): Promise<readonly string[]> => {
  const released = await db.query<{ item_id: string }>(
    "DELETE FROM community.media_item_refs WHERE holder_kind='session' AND holder_id=$1 RETURNING item_id",
    [sessionId],
  );
  const { cancelledComponentIds } = await cancelItems(
    db,
    released.rows.map((row) => row.item_id),
    now,
    { onlyUnreferenced: true },
  );
  await db.query(
    "UPDATE community.publishing_sessions SET state=$2, ended_at=$3::timestamptz WHERE id=$1",
    [sessionId, state, nowParam(now)],
  );
  return cancelledComponentIds;
};

/** WorkPublishingPort.createSession */
export const createSession = async (
  pool: Pool,
  actorId: string,
  command: CreatePublishingSessionCommand,
  now: Date,
): Promise<PublishingSession> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.createSession,
      subjectId: command.workId ?? actorId,
      input: command,
      now,
    },
    async (db) => {
      if (command.workId !== null) {
        const work = (
          await db.query<{
            trashed_at: Date | null;
            operator_state: string;
          }>(
            "SELECT trashed_at,operator_state FROM community.works WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL FOR SHARE",
            [command.workId, actorId],
          )
        ).rows[0];
        if (work === undefined) throw new CommunityNotFoundError();
        if (work.trashed_at !== null || work.operator_state === "removed")
          throw new CommunityInputError("work_unavailable");
      }
      const settings = await selectSettings(db, "share");
      const created = await db.query<SessionRow>(
        `INSERT INTO community.publishing_sessions(id,owner_id,save_mode,work_id,state,lease_expires_at,created_at)
         VALUES($1,$2,'unsaved',$3,'active',$4::timestamptz + make_interval(mins => $5::integer),$4::timestamptz)
         RETURNING ${sessionColumns}`,
        [
          opaqueId("publishing-session"),
          actorId,
          command.workId,
          nowParam(now),
          settings.unsavedSessionLeaseMinutes,
        ],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error("Session insert returned no row");
      return sessionDto(row);
    },
    { auditSubject: (session) => session.id },
  );

/**
 * SQL (session alias, settings alias, `now` placeholder) true while a
 * component of the session's items is `receiving` under a transfer that
 * started within one lease period: the protection `expireSession`, `submit`
 * and `heartbeatSession` share.
 */
const streamingProtectionSql = (
  session: string,
  settings: string,
  now: string,
): string => `EXISTS (
  SELECT 1 FROM community.media_item_refs pr
  JOIN community.media_components pc ON pc.item_id=pr.item_id
  WHERE pr.holder_kind='session' AND pr.holder_id=${session}.id
    AND pc.state='receiving'
    AND pc.updated_at >= ${now}::timestamptz - make_interval(mins => ${settings}.unsaved_session_lease_minutes))`;

/** WorkPublishingPort.heartbeatSession */
export const heartbeatSession = async (
  pool: Pool,
  actorId: string,
  sessionId: string,
  now: Date,
): Promise<PublishingSession> =>
  actorTransaction(pool, actorId, async (db) => {
    // Usable under the expiry rule: an unlapsed lease, or a lapsed lease a
    // transfer still protects (expireSession would answer `active` for it).
    const renewed = await db.query<SessionRow>(
      `UPDATE community.publishing_sessions s
       SET lease_expires_at=$3::timestamptz + make_interval(mins => st.unsaved_session_lease_minutes)
       FROM community.work_publishing_settings st
       WHERE st.id='settings' AND s.id=$1 AND s.owner_id=$2 AND s.state='active'
         AND (s.lease_expires_at >= $3::timestamptz OR ${streamingProtectionSql("s", "st", "$3")})
       RETURNING s.id,s.owner_id,s.state,s.work_id,s.lease_expires_at,s.created_at`,
      [sessionId, actorId, nowParam(now)],
    );
    const row = renewed.rows[0];
    if (row === undefined) throw new CommunityNotFoundError();
    return sessionDto(row);
  });

/** WorkPublishingPort.discardSession */
export const discardSession = async (
  pool: Pool,
  actorId: string,
  sessionId: string,
  command: PublishingCommandIdentity,
  now: Date,
): Promise<PublishingSessionDiscard> =>
  authorCommand(
    pool,
    {
      actorId,
      requestId: command.requestId,
      action: publishingAuthorActions.discardSession,
      subjectId: sessionId,
      input: command,
      now,
    },
    async (db) => {
      const session = (
        await db.query<SessionRow>(
          `SELECT ${sessionColumns} FROM community.publishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [sessionId, actorId],
        )
      ).rows[0];
      if (session === undefined) throw new CommunityNotFoundError();
      if (session.state === "submitted")
        throw new CommunityConflictError("The session was already submitted");
      // An explicit discard ends a lapsed session immediately as well (D08).
      const cancelledComponentIds =
        session.state === "active"
          ? await endSession(db, session.id, "discarded", now)
          : [];
      return { result: { discarded: true }, cancelledComponentIds };
    },
  );

/** WorkPublishingPort.expireSession */
export const expireSession = async (
  pool: Pool,
  sessionId: string,
  now: Date,
): Promise<PublishingSessionExpiry> =>
  writeTransaction(pool, async (db) => {
    const at = nowParam(now);
    const session = (
      await db.query<SessionRow>(
        `SELECT ${sessionColumns} FROM community.publishing_sessions WHERE id=$1 FOR UPDATE`,
        [sessionId],
      )
    ).rows[0];
    if (session === undefined)
      return { status: "missing", cancelledComponentIds: [] };
    if (session.state !== "active")
      return { status: "ended", cancelledComponentIds: [] };
    if (session.lease_expires_at.getTime() >= now.getTime())
      return { status: "active", cancelledComponentIds: [] };
    // A transfer that progressed within one lease period protects the session.
    const streaming = await db.query(
      `SELECT 1 FROM community.publishing_sessions s
       CROSS JOIN community.work_publishing_settings st
       WHERE st.id='settings' AND s.id=$1 AND ${streamingProtectionSql("s", "st", "$2")}`,
      [session.id, at],
    );
    if ((streaming.rowCount ?? 0) > 0)
      return { status: "active", cancelledComponentIds: [] };
    return {
      status: "expired",
      cancelledComponentIds: await endSession(db, session.id, "expired", now),
    };
  });
