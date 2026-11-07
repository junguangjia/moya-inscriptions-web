import { useEffect, useState } from "react";

import { authorClient } from "../../authors/author-data";

import type { TimelineEntry } from "@moya/contracts";

/*
 * The Home timeline as this page session last read it, shared by the feed
 * and the entry pickers (发布作品 and the work page's 关联词条): it loads
 * once, on the feed's first activation or the first picker that needs it,
 * never with the page, because a full answer runs to megabytes. A failure
 * or an empty answer keeps nothing, so the next caller reads again. The
 * list is public; only a read that overlaps an account change is refused.
 */

let sessionEntries: readonly TimelineEntry[] | null = null;
let sessionFetchedAt = 0;
let pending: {
  readonly epoch: number;
  readonly read: Promise<readonly TimelineEntry[]>;
} | null = null;

/** The list this page session holds, or null before a read succeeded. */
export const cachedTimeline = (): readonly TimelineEntry[] | null =>
  sessionEntries;

/** When the last read was started or answered (0 before any). */
export const timelineFetchedAt = (): number => sessionFetchedAt;

/** Marks a refresh as started, so callers that check the age wait. */
export const markTimelineFetched = (): void => {
  sessionFetchedAt = Date.now();
};

/** One read at a time per account epoch; overlapping callers share it. */
export const loadTimeline = (): Promise<readonly TimelineEntry[]> => {
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

export type TimelineEntriesState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly entries: readonly TimelineEntry[] }
  | { readonly state: "failed" };

/**
 * The shared list for a picker: what the session holds at once, else a read
 * started only while `wanted` (the picker is open, or a chosen entry needs
 * its name). `retry` reads again after a failure.
 */
export const useTimelineEntries = (
  wanted: boolean,
): { readonly entries: TimelineEntriesState; readonly retry: () => void } => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TimelineEntriesState>(() =>
    sessionEntries === null
      ? { state: "idle" }
      : { state: "ready", entries: sessionEntries },
  );
  useEffect(() => {
    if (sessionEntries !== null) {
      const entries = sessionEntries;
      setState((current) =>
        current.state === "ready" && current.entries === entries
          ? current
          : { state: "ready", entries },
      );
      return undefined;
    }
    if (!wanted) return undefined;
    let stale = false;
    setState({ state: "loading" });
    loadTimeline().then(
      (entries) => {
        if (!stale)
          setState(
            entries.length === 0
              ? { state: "failed" }
              : { state: "ready", entries },
          );
      },
      () => {
        if (!stale) setState({ state: "failed" });
      },
    );
    return () => {
      stale = true;
    };
  }, [attempt, wanted]);
  return { entries: state, retry: () => setAttempt((value) => value + 1) };
};

/*
 * Full titles learned without the list (Catalog Detail and the work page
 * read their entry's title), so 关联词条 can name an entry it was opened
 * with before, or without, reading megabytes. Titles are public.
 */
const knownNames = new Map<string, string>();

export const rememberTimelineEntryName = (id: string, title: string): void => {
  knownNames.set(id, title);
};

export type TimelineEntryName =
  | { readonly state: "none" }
  | { readonly state: "loading" }
  | { readonly state: "named"; readonly name: string }
  /** The list holds no such entry (it was hidden since it was chosen). */
  | { readonly state: "missing" }
  | { readonly state: "failed" };

/**
 * The full title of a chosen entry (with its dynasty, as the picker and the
 * 词条卡 name it): what was learned or the session's list names, else a
 * read of the list, started only because a name is needed.
 */
export const useTimelineEntryName = (
  id: string | null,
): { readonly name: TimelineEntryName; readonly retry: () => void } => {
  const cachedEntry =
    id === null ? undefined : sessionEntries?.find((entry) => entry.id === id);
  const known =
    id === null ? undefined : (cachedEntry?.fullTitle ?? knownNames.get(id));
  const { entries, retry } = useTimelineEntries(
    id !== null && known === undefined,
  );
  if (id === null) return { name: { state: "none" }, retry };
  if (known !== undefined)
    return { name: { state: "named", name: known }, retry };
  if (entries.state === "ready") {
    const entry = entries.entries.find((candidate) => candidate.id === id);
    return {
      name:
        entry === undefined
          ? { state: "missing" }
          : { state: "named", name: entry.fullTitle },
      retry,
    };
  }
  return {
    name:
      entries.state === "failed" ? { state: "failed" } : { state: "loading" },
    retry,
  };
};
