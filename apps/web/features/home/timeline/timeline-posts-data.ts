import { authorClient } from "../../authors/author-data";
import { publishingClient } from "../../publishing/publishing-data";

import type {
  ContentIdentity,
  ContentTimelineEntry,
  UserWork,
  WorkTimelineEntryCommand,
  WorkTimelineEntryResult,
} from "@moya/contracts";

/*
 * timeline-posts-v1: the reads and the one write behind the posts of a Home
 * timeline row. Every read is the viewer's (the Backend applies the Works
 * page's rule: public posts, plus the viewer's own), so nothing here is kept
 * across an account change.
 */

/**
 * The 词条卡 and Catalog Detail show this many posts before 「全部 N 篇」; the
 * card deck reads as many first.
 */
export const TIMELINE_POSTS_PREVIEW = 6;
/** Each further page of 「全部 N 篇」: whole rows of the three-column grid. */
export const TIMELINE_POSTS_PAGE = 18;
/**
 * Issue #422: a row tap whose post count is unknown reads one post's page,
 * the smallest the route answers, only for its total.
 */
export const TIMELINE_POSTS_COUNT_PAGE = 1;

export interface TimelinePostsPage {
  readonly items: readonly UserWork[];
  readonly total: number;
  readonly page: number;
}

export const readTimelinePosts = async (
  entryId: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<TimelinePostsPage> => {
  const answer = await authorClient.timelinePosts(
    entryId,
    { page, pageSize },
    signal,
  );
  return { items: answer.items, total: answer.total, page: answer.page };
};

/** The viewer's own works for 「关联我发过的帖子」, a Works tab page at a time. */
export const readOwnWorks = async (
  authorId: string,
  page: number,
): Promise<TimelinePostsPage> => {
  const answer = await authorClient.works(authorId, page);
  return { items: answer.items, total: answer.total, page: answer.page };
};

/** The row a work is attached to, or the row of a Catalog record; null when none. */
export const readContentTimelineEntry = async (
  target: ContentIdentity,
  signal?: AbortSignal,
): Promise<ContentTimelineEntry["entry"]> =>
  (await authorClient.timelineEntryOf(target, signal)).entry;

export const setWorkTimelineEntry = (
  workId: string,
  command: WorkTimelineEntryCommand,
): Promise<WorkTimelineEntryResult> =>
  publishingClient.setTimelineEntry(workId, command);

const NO_COUNTS: ReadonlyMap<string, number> = new Map();
/** A refresh of the counts waits this long after the last read. */
const COUNTS_FRESH_MS = 60_000;

let countsCache: {
  readonly epoch: number;
  readonly fetchedAt: number;
  readonly counts: ReadonlyMap<string, number>;
} | null = null;
let countsPending: {
  readonly epoch: number;
  readonly read: Promise<ReadonlyMap<string, number>>;
} | null = null;

export const emptyTimelinePostCounts = (): ReadonlyMap<string, number> =>
  NO_COUNTS;

/** The counts read for the current account, or null when none are held. */
/** Whether the cached counts are this account's and still within their freshness. */
export const timelinePostCountsFresh = (): boolean =>
  countsCache !== null &&
  countsCache.epoch === authorClient.accountEpoch() &&
  Date.now() - countsCache.fetchedAt < COUNTS_FRESH_MS;

export const cachedTimelinePostCounts = (): ReadonlyMap<
  string,
  number
> | null =>
  countsCache?.epoch === authorClient.accountEpoch()
    ? countsCache.counts
    : null;

const countsListeners = new Set<() => void>();

/**
 * The next read of the counts asks the Backend again, and a mounted timeline
 * is told: an attachment, a move or a published post changed some row's.
 */
export const invalidateTimelinePostCounts = (): void => {
  countsCache = null;
  // A read already on its way may predate the change: the next caller reads
  // again, and that older answer is never kept.
  countsPending = null;
  for (const listener of [...countsListeners]) listener();
};

/** Called after every invalidation; returns the unsubscribe. */
export const subscribeTimelinePostCounts = (
  listener: () => void,
): (() => void) => {
  countsListeners.add(listener);
  return () => {
    countsListeners.delete(listener);
  };
};

/**
 * The per-row post counts of the current account. A fresh copy of the same
 * account answers at once; overlapping callers share one read, and a read
 * that overlaps an account change is refused by the transport.
 */
export const loadTimelinePostCounts = (): Promise<
  ReadonlyMap<string, number>
> => {
  const epoch = authorClient.accountEpoch();
  if (
    countsCache !== null &&
    countsCache.epoch === epoch &&
    Date.now() - countsCache.fetchedAt < COUNTS_FRESH_MS
  )
    return Promise.resolve(countsCache.counts);
  if (countsPending?.epoch === epoch) return countsPending.read;
  const read = authorClient
    .timelinePostCounts()
    .then(({ counts }) => {
      const map: ReadonlyMap<string, number> = new Map(Object.entries(counts));
      // Kept only while it is still the current read: an invalidation or an
      // account change since it started leaves it out of the cache.
      if (authorClient.accountEpoch() === epoch && countsPending?.read === read)
        countsCache = { epoch, fetchedAt: Date.now(), counts: map };
      return map;
    })
    .finally(() => {
      if (countsPending?.read === read) countsPending = null;
    });
  countsPending = { epoch, read };
  return read;
};
