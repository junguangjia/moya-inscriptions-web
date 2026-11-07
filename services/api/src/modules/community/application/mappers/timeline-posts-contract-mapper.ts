import {
  contentTimelineEntrySchema,
  timelinePostCountsSchema,
} from "@moya/contracts/schemas";

import type { ContentTimelineEntry, TimelinePostCounts } from "@moya/contracts";

/**
 * timeline-posts-v1: the two small timeline post answers, validated before
 * they leave the Backend. A post page is not parsed again here: each post is
 * a Work parsed by the store, and Production then maps its media to published
 * delivery, as the author's Works page and Thread posts are.
 */
export const mapTimelinePostCounts = (
  counts: TimelinePostCounts,
): TimelinePostCounts => timelinePostCountsSchema.parse(counts);

export const mapContentTimelineEntry = (
  entry: ContentTimelineEntry,
): ContentTimelineEntry => contentTimelineEntrySchema.parse(entry);
