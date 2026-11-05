"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuthors } from "../../authors/author-context";
import { authorClient } from "../../authors/author-data";
import { TimelineFeed } from "./timeline-feed";

import type { TimelineEntry } from "@moya/contracts";
import type { HomeFeedState } from "../home-feed";

/*
 * The list loads on the feed's first activation, not with the page: every
 * panel mounts and server-renders, and a full answer runs to megabytes. It
 * stays cached for the page session; a failure or an empty answer is retried
 * on the next activation. Linked images can carry signed URLs that last five
 * minutes and load only when their row is reached, so an older list refreshes
 * in place: when the feed comes back, or when an image fails to load.
 */
const REFRESH_AFTER_MS = 240_000;
const IMAGE_RETRY_AFTER_MS = 60_000;

let sessionEntries: readonly TimelineEntry[] | null = null;
let sessionFetchedAt = 0;
let pending: {
  readonly epoch: number;
  readonly read: Promise<readonly TimelineEntry[]>;
} | null = null;

const loadTimeline = (): Promise<readonly TimelineEntry[]> => {
  // A read that overlaps an account change is refused when it lands.
  const epoch = authorClient.accountEpoch();
  if (pending?.epoch === epoch) return pending.read;
  const read: Promise<readonly TimelineEntry[]> = authorClient
    .timeline()
    .then(({ entries }) => {
      if (entries.length > 0) sessionEntries = entries;
      sessionFetchedAt = Date.now();
      return entries;
    })
    .finally(() => {
      if (pending?.read === read) pending = null;
    });
  pending = { epoch, read };
  return read;
};

const populated = (
  items: readonly TimelineEntry[],
): HomeFeedState<TimelineEntry> => ({ state: "populated", items });

export const LiveTimeline = ({ active }: { readonly active: boolean }) => {
  // A read that overlaps the account check is refused when its answer lands,
  // so the first load waits for that check, as the discovery feed does.
  const { checking } = useAuthors();
  const [state, setState] = useState<HomeFeedState<TimelineEntry>>(() =>
    sessionEntries === null ? { state: "loading" } : populated(sessionEntries),
  );
  const refresh = useCallback((minimumAgeMs: number) => {
    if (Date.now() - sessionFetchedAt < minimumAgeMs) return;
    sessionFetchedAt = Date.now();
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
    if (sessionEntries !== null) {
      const items = sessionEntries;
      setState((current) =>
        current.state === "populated" ? current : populated(items),
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
  return (
    <TimelineFeed
      active={active}
      onMediaFailed={refreshAfterImageFailure}
      state={state}
    />
  );
};
