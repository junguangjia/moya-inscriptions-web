import { CommunityInputError } from "@moya/api";
import { workTimelineEntryResultSchema } from "@moya/contracts/schemas";
import type {
  WorkPublishingFailureCode,
  WorkTimelineEntryResult,
} from "@moya/contracts";
import type { QueryResultRow } from "pg";

import { nowParam } from "./db.js";
import type { PublishingDb } from "./db.js";

/*
 * timeline-posts-v1: a work's place on the Home timeline, written by its
 * author (community.timeline_entry_posts, one row per work). The operator
 * side withholds and moves rows through its own receipted command.
 *
 * Lock order, shared by every writer of the table: the work FOR UPDATE, then
 * the entry FOR SHARE, then the association row. The entry lock holds an
 * operator hiding it, and the timeline import replacing it, until this
 * transaction ends; an attach racing an import may find the entry gone and
 * answers timeline_entry_unavailable. Every change bumps the row's version, so
 * an operator's compare-and-set sees an author's change too.
 */

const refuse = (code: WorkPublishingFailureCode): never => {
  throw new CommunityInputError(code);
};

/** Locks a visible entry until commit; a hidden or unknown one is unavailable. */
export const lockVisibleTimelineEntry = async (
  db: PublishingDb,
  entryId: string,
): Promise<void> => {
  const entry = await db.query(
    "SELECT entry_id FROM community.timeline_entries WHERE entry_id=$1 AND hidden_at IS NULL FOR SHARE",
    [entryId],
  );
  if (entry.rowCount !== 1) refuse("timeline_entry_unavailable");
};

/**
 * Attaches a work that has no association yet: a new work in the transaction
 * that creates it, or the first attach of an existing one. The entry is
 * locked already; its state and version take the column defaults.
 */
export const insertTimelinePost = async (
  db: PublishingDb,
  workId: string,
  entryId: string,
  now: Date,
): Promise<void> => {
  await db.query(
    "INSERT INTO community.timeline_entry_posts(work_id,entry_id,attached_by,updated_by,attached_at,updated_at) VALUES($1,$2,'author','author',$3::timestamptz,$3::timestamptz)",
    [workId, entryId, nowParam(now)],
  );
};

interface TimelinePostRow extends QueryResultRow {
  entry_id: string | null;
  state: "attached" | "detached" | "withheld";
  withheld_entry_id: string | null;
  version: number;
}

/**
 * The author's attach, move or detach (`entryId: null`) of an own work the
 * caller has locked and found usable. Asking for what is already true writes
 * nothing and answers the current version; a detach of a work that is not
 * attached keeps its state, so a withheld row stays withheld. The entry an
 * operator last took this work off is refused by name.
 */
export const setAuthorTimelineEntry = async (
  db: PublishingDb,
  workId: string,
  entryId: string | null,
  now: Date,
): Promise<WorkTimelineEntryResult> => {
  const at = nowParam(now);
  if (entryId !== null) await lockVisibleTimelineEntry(db, entryId);
  const current = (
    await db.query<TimelinePostRow>(
      "SELECT entry_id,state,withheld_entry_id,version FROM community.timeline_entry_posts WHERE work_id=$1 FOR UPDATE",
      [workId],
    )
  ).rows[0];
  const result = (attached: string | null, version: number) =>
    workTimelineEntryResultSchema.parse({
      workId,
      entryId: attached,
      version,
    });
  if (entryId === null) {
    if (current === undefined) return result(null, 0);
    if (current.state !== "attached") return result(null, current.version);
    const detached = await db.query<{ version: number }>(
      "UPDATE community.timeline_entry_posts SET state='detached',entry_id=NULL,updated_by='author',version=version+1,updated_at=$2::timestamptz WHERE work_id=$1 RETURNING version",
      [workId, at],
    );
    return result(null, detached.rows[0]!.version);
  }
  if (current === undefined) {
    await insertTimelinePost(db, workId, entryId, now);
    return result(entryId, 1);
  }
  if (current.withheld_entry_id === entryId) refuse("timeline_entry_withheld");
  if (current.state === "attached" && current.entry_id === entryId)
    return result(entryId, current.version);
  // A move or a re-attach is a new attachment: its time and attacher too.
  const attached = await db.query<{ version: number }>(
    "UPDATE community.timeline_entry_posts SET entry_id=$2,state='attached',attached_by='author',attached_at=$3::timestamptz,updated_by='author',version=version+1,updated_at=$3::timestamptz WHERE work_id=$1 RETURNING version",
    [workId, entryId, at],
  );
  return result(entryId, attached.rows[0]!.version);
};
