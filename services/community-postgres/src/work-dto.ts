import { workSchema } from "@moya/contracts/schemas";
import type { UserWork } from "@moya/contracts";
import type { PoolClient, QueryResultRow } from "pg";

import {
  revisionCover,
  revisionCoverColumns,
  revisionCoverJoin,
  revisionsMedia,
} from "./publishing/media-read.js";
import type {
  RevisionCoverColumns,
  RevisionMediaView,
} from "./publishing/media-read.js";
import { revisionAuthorship } from "./publishing/authorship.js";

/*
 * Shared Work row → UserWork DTO assembly, used by the author adapter and by
 * the Thread adapter (content-community-completion-v1) so a Thread post is the
 * same Work with the same identity, media and visibility rules everywhere.
 */
export interface WorkRow extends QueryResultRow {
  id: string;
  author_id: string;
  display_name: string;
  title: string;
  text: string;
  first_published_at: Date | null;
  edited_at: Date | null;
  version: number;
  visibility: "public" | "self";
  trashed_at: Date | null;
  public_revision_id: string | null;
  author_revision_id: string | null;
  operator_state: "visible" | "hidden" | "removed";
  is_public: boolean;
}
export interface WorkRevisionRow extends RevisionCoverColumns {
  title: string;
  body: string;
  authorship_kind: string | null;
  reference_title: string | null;
  original_author: string | null;
  source_note: string | null;
}
/**
 * Effective third-party visibility (community.work_is_public) plus the
 * author-active and block checks, or the author's own branch: not purged and
 * not in the recycle bin. `$1` is the viewer, `w`/`u` the work and author.
 */
export const workVisibleTo = (viewer: string) =>
  `u.status='active' AND community.accounts_can_interact(${viewer},w.author_id)
  AND (community.work_is_public(w) OR (w.author_id=${viewer} AND w.deleted_at IS NULL AND w.trashed_at IS NULL))`;
export const workColumns =
  "w.id,w.author_id,w.title,w.text,w.first_published_at,w.edited_at,w.version,w.visibility,w.trashed_at,w.public_revision_id,w.author_revision_id,w.operator_state,community.work_is_public(w) AS is_public,u.display_name";

export const workDtos = async (
  db: PoolClient,
  rows: readonly WorkRow[],
  viewer: string | null,
): Promise<UserWork[]> => {
  const revisionIdOf = (row: WorkRow) =>
    row.author_id === viewer ? row.author_revision_id : row.public_revision_id;
  const revisionIds = [
    ...new Set(
      rows.flatMap((row) => {
        const id = revisionIdOf(row);
        return id === null ? [] : [id];
      }),
    ),
  ];
  const revisions = new Map<string, WorkRevisionRow>();
  if (revisionIds.length > 0)
    for (const revision of (
      await db.query<WorkRevisionRow & { id: string }>(
        `SELECT r.id,r.title,r.body,r.authorship_kind,r.reference_title,r.original_author,r.source_note,${revisionCoverColumns("cov")}
            FROM community.work_revisions r ${revisionCoverJoin("r", "cov")} WHERE r.id=ANY($1::text[])`,
        [revisionIds],
      )
    ).rows)
      revisions.set(revision.id, revision);
  const mediaViews = await revisionsMedia(db, revisionIds);
  return rows.map((row) => workDtoFrom(row, viewer, revisions, mediaViews));
};
const workDtoFrom = (
  row: WorkRow,
  viewer: string | null,
  revisions: ReadonlyMap<string, WorkRevisionRow>,
  mediaViews: ReadonlyMap<string, RevisionMediaView>,
): UserWork => {
  const owner = row.author_id === viewer;
  const revisionId = owner ? row.author_revision_id : row.public_revision_id;
  const revision = revisionId === null ? undefined : revisions.get(revisionId);
  const { media, coverMediaId } = (revision === undefined
    ? undefined
    : mediaViews.get(revisionId!)) ?? { media: [], coverMediaId: null };
  const authorship =
    revision === undefined ? null : revisionAuthorship(revision);
  return workSchema.parse({
    id: row.id,
    authorId: row.author_id,
    authorName: row.display_name,
    title: revision?.title ?? row.title,
    text: revision?.body ?? row.text,
    media,
    coverMediaId,
    coverSrc:
      revision === undefined ? null : (revisionCover(revision)?.src ?? null),
    firstPublishedAt: row.first_published_at?.toISOString() ?? null,
    version: row.version,
    canEdit: owner,
    available: row.is_public || (owner && row.operator_state === "visible"),
    editedAt: row.edited_at?.toISOString() ?? null,
    ...(authorship === null ? {} : { authorship }),
    ...(owner
      ? {
          visibility: row.visibility,
          trashedAt: row.trashed_at?.toISOString() ?? null,
          publiclyVisible: row.is_public,
        }
      : {}),
  });
};
