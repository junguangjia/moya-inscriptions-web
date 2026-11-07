"use client";

import { timelineEntryDate } from "./timeline-model";
import styles from "./timeline.module.css";

import type { TimelineEntry } from "@moya/contracts";

/** 词条卡 of an entry with no Catalog page: absent values leave no row. */
export const TimelineEntryCard = ({
  entry,
}: {
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
    </div>
  );
};
