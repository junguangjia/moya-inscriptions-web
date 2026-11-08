"use client";

import { TimelineEntryPosts } from "./timeline-entry-posts";
import { timelineEntryDate } from "./timeline-model";
import styles from "./timeline.module.css";

import type { TimelineEntry } from "@moya/contracts";
import type { TimelineEntryPostsActions } from "./timeline-entry-posts";

/**
 * 词条卡 of an entry with no Catalog page: absent values leave no row.
 * timeline-posts-v1: under the facts, 「上传这件碑帖」, its line and the
 * entry's posts (Figma B5); browse-only keeps the posts alone. Since Issue
 * #422 a timeline row opens it only while the entry has no posts either;
 * otherwise the row opens the card deck.
 */
export const TimelineEntryCard = ({
  actions,
  browseOnly = false,
  entry,
}: {
  /** Without actions (a static preview) the card shows its facts only. */
  readonly actions?: TimelineEntryPostsActions | undefined;
  readonly browseOnly?: boolean;
  readonly entry: TimelineEntry;
}) => {
  const facts = [
    ["年代", timelineEntryDate(entry)],
    ["地点", entry.province],
    ["保管", entry.holder],
  ] as const;
  return (
    <div className={styles.card} data-timeline-card="">
      <h2 className={styles.cardTitle}>{entry.fullTitle}</h2>
      <dl className={styles.cardFacts}>
        {facts.map(([label, value]) =>
          value === null ? null : (
            <div className={styles.cardFact} key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ),
        )}
      </dl>
      {actions === undefined ? null : (
        <TimelineEntryPosts
          actions={actions}
          browseOnly={browseOnly}
          entryId={entry.id}
          entryTitle={entry.fullTitle}
        />
      )}
    </div>
  );
};
