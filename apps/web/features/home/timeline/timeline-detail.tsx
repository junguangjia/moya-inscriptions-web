"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@moya/ui";

import { useOptionalAuthors } from "../../authors/author-context";
import { DetailBand, useInDetailBand } from "../../detail/detail-band";
import { useProductShell } from "../../product-shell/product-shell";
import { isWideLayout } from "../../shell/device-platform";
import { TimelineCardDeck } from "./timeline-card-deck";
import { TimelineEntryPicker } from "./timeline-entry-picker";
import { TimelineEntryPosts, useTimelinePosts } from "./timeline-entry-posts";
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

import type { CSSProperties, ReactNode } from "react";
import type {
  ContentIdentity,
  ContentTimelineEntry,
  TimelineEntry,
} from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type { TimelineRowLayout } from "./timeline-model";

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
        if (entry !== null)
          rememberTimelineEntryName(entry.id, entry.fullTitle);
        setAnswer({ key, entry });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [checking, id, key, type, viewerId]);
  const replace = useCallback(
    (entry: ContentTimelineEntryValue) => {
      if (key === null) return;
      if (entry !== null) rememberTimelineEntryName(entry.id, entry.fullTitle);
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
 * sign-in for a guest, as the publishing entry does (the 词条卡 and the card
 * deck share it, on the timeline and from a work's 收录于).
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
 * Catalog Detail's 帖子 section (timeline-posts-v1, Owner D1-A): the posts of
 * the row that links this record, as the 词条卡's grid shows them. Since
 * Issue #422 a post starts from the card deck's 「上传」 button (and the
 * 词条卡), never from a card the deck opened (Owner: 「点开某一个卡片后不要再
 * 显示上传」), so this section has no 「上传这件碑帖」 and no 「关联我发过的
 * 帖子」, and with nothing to offer it is not there at all, heading and band
 * included, while the record has no entry, the answers are pending or the
 * entry has no posts. A failed read of the posts still says so, with 重试.
 * On the desktop Detail it renders in the band under the first screen, so
 * the image keeps its place; elsewhere it follows the actions.
 */
export const CatalogTimelinePosts = ({
  catalogId,
}: {
  readonly catalogId: string;
}) => {
  const { entry } = useContentTimelineEntry({
    type: "catalog",
    id: catalogId,
  });
  if (entry === undefined || entry === null) return null;
  return <CatalogEntryPosts entry={entry} key={entry.id} />;
};

const CatalogEntryPosts = ({
  entry,
}: {
  readonly entry: NonNullable<ContentTimelineEntryValue>;
}) => {
  const { openContent } = useProductShell();
  const posts = useTimelinePosts(entry.id);
  const inBand = useInDetailBand();
  const { state } = posts;
  if (state.state === "loading") return null;
  if (state.state === "ready" && state.total === 0 && state.items.length === 0)
    return null;
  return (
    <DetailBand>
      <div
        className={styles.detailSection}
        data-detail-band-section={inBand ? "" : undefined}
        data-detail-timeline-posts=""
      >
        <TimelineEntryPosts
          actions={{
            openWork: (workId, opener) =>
              openContent({ type: "work", id: workId }, opener),
          }}
          entryId={entry.id}
          entryTitle={entry.fullTitle}
          heading="帖子"
          posts={posts}
          uploads={false}
        />
      </div>
    </DetailBand>
  );
};

/** The timeline's layout outside the timeline, from the shell's platform. */
const useTimelineSheetLayout = (): TimelineRowLayout => {
  const { platform } = useProductShell();
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
  return wide ? "wide" : platform === "phone" ? "phone" : "tablet";
};

/**
 * Plays a sheet's closing transition, calls `onClose`, then runs the action
 * (`closeThen`); a close without one (Back, the scrim, ×) only calls `onClose`.
 */
const useCloseThen = (onClose: () => void) => {
  const [closing, setClosing] = useState(false);
  const after = useRef<(() => void) | null>(null);
  const closeThen = (action: () => void) => {
    after.current = action;
    setClosing(true);
  };
  const closed = () => {
    const action = after.current;
    after.current = null;
    onClose();
    action?.();
  };
  return { closing, closeThen, closed };
};

/**
 * The timeline's sheet outside the timeline: a bottom sheet on phone, a
 * side sheet on tablet, a drawer when wide. `children` gets `closeThen`,
 * which plays the closing transition, calls `onClose`, then runs the action.
 */
const TimelineSheetHost = ({
  children,
  onClose,
  title,
}: {
  readonly children: (closeThen: (action: () => void) => void) => ReactNode;
  /** After any close: Back, the scrim, × or `closeThen`. */
  readonly onClose: () => void;
  readonly title: string;
}) => {
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  const layout = useTimelineSheetLayout();
  const { closing, closeThen, closed } = useCloseThen(onClose);
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
        onClose={closed}
        title={title}
      >
        {children(closeThen)}
      </TimelineSheet>
    </div>
  );
};

/**
 * The card deck opened outside the timeline, from a work's 收录于 (Issue
 * #422). Its cards and its upload close it first and act from the line.
 */
export const TimelineCardDeckSheet = ({
  entry,
  onClose,
  opener,
}: {
  readonly entry: TimelineEntry;
  readonly onClose: () => void;
  /** The control the deck returns to; its actions act from it. */
  readonly opener: HTMLElement;
}) => {
  const { browseOnly, openContent, openProfile } = useProductShell();
  const openPostEditor = useOpenPostEditor();
  const layout = useTimelineSheetLayout();
  const { closing, closeThen, closed } = useCloseThen(onClose);
  return (
    <TimelineCardDeck
      actions={{
        upload: () => closeThen(() => openPostEditor(entry.id, opener)),
        openWork: (workId) =>
          closeThen(() => openContent({ type: "work", id: workId }, opener)),
        openCatalog: (catalogId) =>
          closeThen(() =>
            openContent({ type: "catalog", id: catalogId }, opener),
          ),
        signIn: () => closeThen(() => openProfile(null, opener)),
        postsChanged: invalidateTimelinePostCounts,
      }}
      browseOnly={browseOnly}
      closeRequested={closing}
      entry={entry}
      layout={layout}
      onClose={closed}
    />
  );
};

/**
 * A work's 关联词条 on its own page (timeline-posts-v1 §2.4): the picker in
 * the timeline's sheet, so the Detail under it keeps its layout. A choice
 * closes the sheet, then `onChoose` runs; every close calls `onClose`.
 */
export const TimelineEntryPickerSheet = ({
  onChoose,
  onClose,
  selectedId,
}: {
  readonly onChoose: (entry: TimelineEntry | null) => void;
  readonly onClose: () => void;
  readonly selectedId: string | null;
}) => (
  <TimelineSheetHost onClose={onClose} title="关联词条">
    {(closeThen) => (
      <div
        className={`${timelineStyles.card} ${styles.sheetPicker}`}
        data-timeline-entry-picker-sheet=""
      >
        <h2 className={timelineStyles.cardTitle}>关联词条</h2>
        <TimelineEntryPicker
          onCancel={() => closeThen(() => undefined)}
          onChoose={(entry) => closeThen(() => onChoose(entry))}
          selectedId={selectedId}
        />
      </div>
    )}
  </TimelineSheetHost>
);

/**
 * 收录于 · 题名 (timeline-posts-v1 §2.4): above a work's author for everyone
 * once its entry is known. It opens the entry's card deck (Issue #422),
 * reading the session's timeline only then, because the deck needs the
 * entry's facts. The line is only shown for a work its viewer can read, and
 * the entry's posts follow the same read rule, so the entry always holds at
 * least this post: the deck's open rule needs no count here.
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
      // A late answer never stacks the deck on a modal opened meanwhile
      // (the author's 关联词条, for one): the reader has moved on.
      const moved = document.querySelector("dialog[open]") !== null;
      if (mounted.current && found !== null && !moved)
        setCard({ entry: found, opener });
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
        <Icon
          aria-hidden="true"
          className={styles.collectedChevron}
          name="next"
          size="sm"
        />
      </button>
      {card === null ? null : (
        <TimelineCardDeckSheet
          entry={card.entry}
          onClose={() => setCard(null)}
          opener={card.opener}
        />
      )}
    </>
  );
};
