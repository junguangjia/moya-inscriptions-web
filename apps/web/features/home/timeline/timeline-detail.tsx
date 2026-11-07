"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useOptionalAuthors } from "../../authors/author-context";
import { useProductShell } from "../../product-shell/product-shell";
import { isWideLayout } from "../../shell/device-platform";
import { TimelineEntryCard } from "./timeline-entry-card";
import { TimelineEntryPosts } from "./timeline-entry-posts";
import {
  readContentTimelineEntry,
  invalidateTimelinePostCounts,
} from "./timeline-posts-data";
import {
  cachedTimeline,
  loadTimeline,
  rememberTimelineEntryName,
} from "./timeline-session";
import { TimelineSheet } from "./timeline-sheet";
import timelineStyles from "./timeline.module.css";
import styles from "./timeline-posts.module.css";

import type { CSSProperties } from "react";
import type {
  ContentIdentity,
  ContentTimelineEntry,
  TimelineEntry,
} from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type { TimelineEntryPostsActions } from "./timeline-entry-posts";

export type ContentTimelineEntryValue = ContentTimelineEntry["entry"];

/**
 * timeline-posts-v1: the timeline entry of a work (收录于) or of a Catalog
 * record (Catalog Detail's 帖子 section), read after the Detail has painted
 * and once the account is known, so it never holds up the first screen.
 * `undefined` until answered; a failed read stays unanswered (nothing is
 * shown). `replace` sets what an attachment made true without a read.
 */
export const useContentTimelineEntry = (
  target: ContentIdentity | null,
): {
  readonly entry: ContentTimelineEntryValue | undefined;
  readonly replace: (entry: ContentTimelineEntryValue) => void;
} => {
  const authors = useOptionalAuthors();
  const checking = authors?.checking ?? false;
  const viewerId = authors?.viewer?.id ?? null;
  const key = target === null ? null : `${target.type}:${target.id}`;
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly entry: ContentTimelineEntryValue;
  } | null>(null);
  const type = target?.type;
  const id = target?.id;
  useEffect(() => {
    if (key === null || type === undefined || id === undefined || checking)
      return undefined;
    const controller = new AbortController();
    readContentTimelineEntry({ type, id }, controller.signal).then(
      (entry) => {
        if (controller.signal.aborted) return;
        if (entry !== null) rememberTimelineEntryName(entry.id, entry.title);
        setAnswer({ key, entry });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [checking, id, key, type, viewerId]);
  const replace = useCallback(
    (entry: ContentTimelineEntryValue) => {
      if (key === null) return;
      if (entry !== null) rememberTimelineEntryName(entry.id, entry.title);
      setAnswer({ key, entry });
    },
    [key],
  );
  return {
    entry: answer !== null && answer.key === key ? answer.entry : undefined,
    replace,
  };
};

/**
 * Opens the editor for a new post on an entry for a signed-in author, or
 * sign-in for a guest, as the publishing entry does (the 词条卡 on the
 * timeline, Catalog Detail and a work's 收录于 share it).
 */
export const useOpenPostEditor = () => {
  const authors = useOptionalAuthors();
  const { openEditor, openProfile } = useProductShell();
  return useCallback(
    (entryId: string, opener: HTMLElement) => {
      if (authors?.checking) return;
      if (authors?.viewer)
        openEditor({ type: "new", timelineEntryId: entryId }, opener);
      else openProfile(null, opener);
    },
    [authors?.checking, authors?.viewer, openEditor, openProfile],
  );
};

/**
 * Catalog Detail's 帖子 section (timeline-posts-v1, Owner D1-A): the 60
 * entries that open Detail instead of a 词条卡 show their posts and
 * 「上传这件碑帖」 here, with the 词条卡's own components. Nothing at all
 * while the record has no entry or the answer is pending.
 */
export const CatalogTimelinePosts = ({
  catalogId,
}: {
  readonly catalogId: string;
}) => {
  const { browseOnly, openContent, openProfile } = useProductShell();
  const openPostEditor = useOpenPostEditor();
  const { entry } = useContentTimelineEntry({
    type: "catalog",
    id: catalogId,
  });
  if (entry === undefined || entry === null) return null;
  const actions: TimelineEntryPostsActions = {
    upload: (opener) => openPostEditor(entry.id, opener),
    openWork: (workId, opener) =>
      openContent({ type: "work", id: workId }, opener),
    signIn: (opener) => openProfile(null, opener),
    postsChanged: invalidateTimelinePostCounts,
  };
  return (
    <div className={styles.detailSection} data-detail-timeline-posts="">
      <TimelineEntryPosts
        actions={actions}
        browseOnly={browseOnly}
        entryId={entry.id}
        entryTitle={entry.title}
        heading="帖子"
      />
    </div>
  );
};

/** The 词条卡 opened outside the timeline, from a work's 收录于. */
export const TimelineEntryCardSheet = ({
  entry,
  onClose,
  opener,
}: {
  readonly entry: TimelineEntry;
  readonly onClose: () => void;
  /** The control the card returns to; its actions act from it. */
  readonly opener: HTMLElement;
}) => {
  const { browseOnly, openContent, openProfile, platform } = useProductShell();
  const openPostEditor = useOpenPostEditor();
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  const [closing, setClosing] = useState(false);
  const after = useRef<(() => void) | null>(null);
  const [wide, setWide] = useState(() =>
    typeof window === "undefined"
      ? platform === "pc"
      : isWideLayout(platform, window.innerWidth),
  );
  useEffect(() => {
    const read = () => setWide(isWideLayout(platform, window.innerWidth));
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [platform]);
  const layout = wide ? "wide" : platform === "phone" ? "phone" : "tablet";
  const closeThen = (action: () => void) => {
    after.current = action;
    setClosing(true);
  };
  const actions: TimelineEntryPostsActions = {
    upload: () => closeThen(() => openPostEditor(entry.id, opener)),
    openWork: (workId) =>
      closeThen(() => openContent({ type: "work", id: workId }, opener)),
    signIn: () => closeThen(() => openProfile(null, opener)),
    postsChanged: invalidateTimelinePostCounts,
  };
  return (
    // The timeline's sheet geometry is keyed on its root and layout; this
    // host draws no box of its own.
    <div
      className={timelineStyles.root}
      data-timeline-layout={layout}
      style={
        {
          display: "contents",
          "--timeline-wide-drawer-end": "var(--yoyi-space-7)",
        } as CSSProperties
      }
    >
      <TimelineSheet
        closeRequested={closing}
        navigationRef={navigationRef}
        onClose={() => {
          const action = after.current;
          after.current = null;
          onClose();
          action?.();
        }}
        title={entry.fullTitle}
      >
        <TimelineEntryCard
          actions={actions}
          browseOnly={browseOnly}
          entry={entry}
        />
      </TimelineSheet>
    </div>
  );
};

/**
 * 收录于 · 题名 (timeline-posts-v1 §2.4): under a work's title for everyone
 * once its entry is known. It opens the same 词条卡, reading the session's
 * timeline only then, because the card needs the entry's facts.
 */
export const WorkTimelineEntryLine = ({
  entry,
}: {
  readonly entry: NonNullable<ContentTimelineEntryValue>;
}) => {
  const [card, setCard] = useState<{
    readonly entry: TimelineEntry;
    readonly opener: HTMLElement;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = async (opener: HTMLElement) => {
    if (busy) return;
    const find = (entries: readonly TimelineEntry[] | null) =>
      entries?.find((candidate) => candidate.id === entry.id) ?? null;
    const known = find(cachedTimeline());
    if (known !== null) {
      setCard({ entry: known, opener });
      return;
    }
    setBusy(true);
    try {
      const found = find(await loadTimeline());
      if (mounted.current && found !== null) setCard({ entry: found, opener });
    } catch {
      /* The line stays; a later tap reads again. */
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      <button
        aria-busy={busy || undefined}
        aria-haspopup="dialog"
        className={styles.collected}
        data-work-timeline-entry={entry.id}
        onClick={(event) => void open(event.currentTarget)}
        type="button"
      >
        收录于 · <span>{entry.fullTitle}</span>
      </button>
      {card === null ? null : (
        <TimelineEntryCardSheet
          entry={card.entry}
          onClose={() => setCard(null)}
          opener={card.opener}
        />
      )}
    </>
  );
};
