import type {
  AuthorListQuery,
  ContentIdentity,
  ContentTimelineEntry,
  TimelinePostCounts,
  UserWork,
} from "@moya/contracts";

import type { AuthorPage } from "./author-community-port.js";

/**
 * timeline-posts-v1: public reads of the posts attached to Home timeline rows.
 * A post is a Work; every read applies the Work read rule of the author's
 * Works page and of Thread posts (public works for everybody, plus the
 * viewer's own works outside the recycle bin, with active and unblocked
 * authors) to attached posts of visible rows, so a count and its list always
 * agree for one viewer. The author's writes live on the work publishing port.
 */
export interface TimelinePostsPort {
  /**
   * The posts attached to a visible entry that the viewer may see, newest
   * attachment first. A hidden or unknown entry is not found.
   */
  listTimelinePosts(
    entryId: string,
    viewer: string | null,
    query: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>>;
  /** Per visible entry, how many posts its list shows the viewer; entries with none are left out. */
  timelinePostCounts(viewer: string | null): Promise<TimelinePostCounts>;
  /**
   * The visible entry a work is attached to (null unless the viewer may see
   * the work), or the visible entry linking a Catalog record. The caller has
   * checked that the target itself is visible.
   */
  timelineEntryOf(
    target: ContentIdentity,
    viewer: string | null,
  ): Promise<ContentTimelineEntry>;
}
