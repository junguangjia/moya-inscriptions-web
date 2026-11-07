"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuthors } from "../../authors/author-context";
import { authorClient } from "../../authors/author-data";
import { TimelineFeed } from "./timeline-feed";
import {
  cachedTimelinePostCounts,
  emptyTimelinePostCounts,
  invalidateTimelinePostCounts,
  loadTimelinePostCounts,
  subscribeTimelinePostCounts,
} from "./timeline-posts-data";
import {
  cachedTimeline,
  loadTimeline,
  markTimelineFetched,
  timelineFetchedAt,
} from "./timeline-session";

import type { TimelineEntry } from "@moya/contracts";
import type { HomeFeedState } from "../home-feed";

/*
 * The list loads on the feed's first activation, not with the page: every
 * panel mounts and server-renders, and a full answer runs to megabytes. It
 * stays cached for the page session (timeline-session.ts, shared with the
 * entry pickers); a failure or an empty answer is retried on the next
 * activation. Linked images can carry signed URLs that last five minutes
 * and load only when their row is reached, so an older list refreshes in
 * place: when the feed comes back, or when an image fails to load.
 *
 * timeline-posts-v1: the rows' post counts are the viewer's own read, made
 * after the list is on screen, so they never hold up its first paint; a
 * count of another account is never shown.
 */
const REFRESH_AFTER_MS = 240_000;
const IMAGE_RETRY_AFTER_MS = 60_000;

const populated = (
  items: readonly TimelineEntry[],
): HomeFeedState<TimelineEntry> => ({ state: "populated", items });

interface CountsState {
  readonly epoch: number;
  readonly counts: ReadonlyMap<string, number>;
}

export const LiveTimeline = ({ active }: { readonly active: boolean }) => {
  // A read that overlaps the account check is refused when its answer lands,
  // so the first load waits for that check, as the discovery feed does.
  const { checking, viewer } = useAuthors();
  const viewerId = viewer?.id ?? null;
  const [state, setState] = useState<HomeFeedState<TimelineEntry>>(() => {
    const entries = cachedTimeline();
    return entries === null ? { state: "loading" } : populated(entries);
  });
  const refresh = useCallback((minimumAgeMs: number) => {
    if (Date.now() - timelineFetchedAt() < minimumAgeMs) return;
    markTimelineFetched();
    // A failed refresh keeps the list on screen.
    loadTimeline().then(
      (entries) => {
        if (entries.length > 0) setState(populated(entries));
      },
      () => undefined,
    );
  }, []);
  const refreshAfterImageFailure = useCallback(
    () => refresh(IMAGE_RETRY_AFTER_MS),
    [refresh],
  );
  useEffect(() => {
    if (!active || checking) return undefined;
    const cached = cachedTimeline();
    if (cached !== null) {
      setState((current) =>
        current.state === "populated" ? current : populated(cached),
      );
      refresh(REFRESH_AFTER_MS);
      return undefined;
    }
    let stale = false;
    setState({ state: "loading" });
    loadTimeline().then(
      (entries) => {
        if (stale) return;
        setState(
          entries.length === 0 ? { state: "unavailable" } : populated(entries),
        );
      },
      () => {
        if (!stale) setState({ state: "unavailable" });
      },
    );
    return () => {
      stale = true;
    };
  }, [active, checking, refresh]);

  const [counts, setCounts] = useState<CountsState | null>(() => {
    const cached = cachedTimelinePostCounts();
    return cached === null
      ? null
      : { epoch: authorClient.accountEpoch(), counts: cached };
  });
  const [countsRevision, setCountsRevision] = useState(0);
  const listShown = state.state === "populated";
  useEffect(() => {
    if (!active || checking || !listShown) return undefined;
    let stale = false;
    const epoch = authorClient.accountEpoch();
    // A failed read keeps the rows as they are: a count is never required.
    loadTimelinePostCounts().then(
      (next) => {
        if (!stale && authorClient.accountEpoch() === epoch)
          setCounts({ epoch, counts: next });
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [active, checking, countsRevision, listShown, viewerId]);
  // Any change of posts (here, on a work page, Catalog Detail or a published
  // post) reads the counts again while the feed is shown.
  useEffect(
    () =>
      subscribeTimelinePostCounts(() =>
        setCountsRevision((value) => value + 1),
      ),
    [],
  );
  const postsChanged = useCallback(() => invalidateTimelinePostCounts(), []);
  const shownCounts =
    counts !== null && counts.epoch === authorClient.accountEpoch()
      ? counts.counts
      : emptyTimelinePostCounts();

  return (
    <TimelineFeed
      active={active}
      onMediaFailed={refreshAfterImageFailure}
      onPostsChanged={postsChanged}
      postCounts={shownCounts}
      state={state}
    />
  );
};
