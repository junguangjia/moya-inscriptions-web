import { CommunityNotFoundError } from "@moya/api";
import type { AuthorPage, TimelinePostsPort } from "@moya/api";
import type {
  AuthorListQuery,
  ContentIdentity,
  ContentTimelineEntry,
  TimelinePostCounts,
  UserWork,
} from "@moya/contracts";
import type { Pool, QueryResultRow } from "pg";

import { readTransaction } from "./publishing/db.js";
import { workColumns, workDtos, workVisibleTo } from "./work-dto.js";
import type { WorkRow } from "./work-dto.js";

/*
 * timeline-posts-v1: the public reads of posts attached to Home timeline rows
 * (community.timeline_entry_posts). One predicate serves the list, the counts
 * and a work's entry: an attached row of a visible entry whose work the viewer
 * may see by the shared Work read rule (work-dto.ts), so the number on a row
 * is the length of its list for that viewer, blocks and the viewer's own
 * self-only, pending and removed works included. A post that becomes hidden,
 * removed, trashed or deleted, or whose author is suspended, leaves on the
 * next read with no write. Each read is one read-only snapshot.
 */

/** `viewer` is the placeholder of the viewer id; `p`, `e`, `w` and `u` are bound here. */
const attachedPostsFor = (viewer: string) => `community.timeline_entry_posts p
  JOIN community.timeline_entries e ON e.entry_id=p.entry_id AND e.hidden_at IS NULL
  JOIN community.works w ON w.id=p.work_id
  JOIN community.public_users u ON u.id=w.author_id
  WHERE p.state='attached' AND ${workVisibleTo(viewer)}`;

interface EntryNameRow extends QueryResultRow {
  entry_id: string;
  title: string;
  full_title: string;
}

const entryOf = (row: EntryNameRow | undefined): ContentTimelineEntry => ({
  entry:
    row === undefined
      ? null
      : { id: row.entry_id, title: row.title, fullTitle: row.full_title },
});

export class PostgresTimelinePostsAdapter implements TimelinePostsPort {
  constructor(private readonly pool: Pool) {}

  listTimelinePosts(
    entryId: string,
    viewer: string | null,
    q: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>> {
    return readTransaction(this.pool, async (db) => {
      const entry = await db.query(
        "SELECT entry_id FROM community.timeline_entries WHERE entry_id=$1 AND hidden_at IS NULL",
        [entryId],
      );
      if (entry.rowCount !== 1) throw new CommunityNotFoundError();
      const from = `FROM ${attachedPostsFor("$2")} AND p.entry_id=$1`;
      const total = Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total ${from}`,
            [entryId, viewer],
          )
        ).rows[0]?.total ?? 0,
      );
      // The newest attachment first: a move or a re-attach counts as new.
      const rows = (
        await db.query<WorkRow>(
          `SELECT ${workColumns} ${from} ORDER BY p.attached_at DESC, p.work_id DESC LIMIT $3 OFFSET $4`,
          [entryId, viewer, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      return {
        items: await workDtos(db, rows, viewer),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  timelinePostCounts(viewer: string | null): Promise<TimelinePostCounts> {
    return readTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<{ entry_id: string; total: number }>(
          `SELECT p.entry_id, count(*)::integer AS total FROM ${attachedPostsFor("$1")} GROUP BY p.entry_id ORDER BY p.entry_id`,
          [viewer],
        )
      ).rows;
      return {
        counts: Object.fromEntries(
          rows.map(({ entry_id, total }) => [entry_id, total]),
        ),
      };
    });
  }

  timelineEntryOf(
    target: ContentIdentity,
    viewer: string | null,
  ): Promise<ContentTimelineEntry> {
    return readTransaction(this.pool, async (db) =>
      entryOf(
        target.type === "catalog"
          ? (
              await db.query<EntryNameRow>(
                "SELECT entry_id,title,full_title FROM community.timeline_entries WHERE catalog_id=$1 AND hidden_at IS NULL",
                [target.id],
              )
            ).rows[0]
          : (
              await db.query<EntryNameRow>(
                `SELECT e.entry_id,e.title,e.full_title FROM ${attachedPostsFor("$2")} AND p.work_id=$1`,
                [target.id, viewer],
              )
            ).rows[0],
      ),
    );
  }
}
