"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@moya/ui";

import { TimelineEntryCard } from "./timeline-entry-card";
import { TimelineSheet } from "./timeline-sheet";
import {
  buildShelfSections,
  timelineChapterInfo,
  timelineShelfMeta,
} from "./timeline-model";
import styles from "./timeline.module.css";

import type { TimelineChapter, TimelineEntry } from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type { TimelineShelfMode } from "./timeline-model";

const MODES: readonly {
  readonly mode: TimelineShelfMode;
  readonly label: string;
}[] = [
  { mode: "place", label: "按地" },
  { mode: "name", label: "按名" },
  { mode: "polity", label: "按政权" },
];

const ShelfEntry = ({
  entry,
  mode,
  onOpen,
}: {
  readonly entry: TimelineEntry;
  readonly mode: TimelineShelfMode;
  readonly onOpen: (entry: TimelineEntry) => void;
}) => {
  const meta = timelineShelfMeta(entry, mode);
  return (
    <button
      className={styles.shelfEntry}
      data-shelf-entry={entry.id}
      onClick={() => onOpen(entry)}
      type="button"
      {...(entry.catalogId === null
        ? {}
        : { "data-open-catalog": "", "data-catalog-id": entry.catalogId })}
    >
      <span className={styles.shelfEntryTitle}>{entry.fullTitle}</span>
      {meta === "" ? null : (
        <span className={styles.shelfEntryMeta}>{meta}</span>
      )}
    </button>
  );
};

/**
 * 书架: a chapter's entries with no exact year. A row with no Catalog page
 * opens its card as a child view of this modal, so Back returns to the list;
 * a linked row closes the sheet first because Detail sits under the top layer.
 */
export const TimelineShelfSheet = ({
  chapter,
  closeRequested,
  entries,
  onClose,
  onOpenCatalog,
}: {
  readonly chapter: TimelineChapter;
  readonly closeRequested: boolean;
  readonly entries: readonly TimelineEntry[];
  readonly onClose: () => void;
  readonly onOpenCatalog: (catalogId: string) => void;
}) => {
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  const [mode, setMode] = useState<TimelineShelfMode>("place");
  const [card, setCard] = useState<TimelineEntry | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const sections = useMemo(
    () => buildShelfSections(entries, mode),
    [entries, mode],
  );
  const title = `${timelineChapterInfo(chapter).shortName} · 其他 ${entries.length}`;
  const listRef = useRef<HTMLDivElement>(null);
  const listReturn = useRef<{ id: string; scrollTop: number } | null>(null);
  const openEntry = (entry: TimelineEntry) => {
    if (entry.catalogId !== null) {
      onOpenCatalog(entry.catalogId);
      return;
    }
    listReturn.current = {
      id: entry.id,
      scrollTop: listRef.current?.scrollTop ?? 0,
    };
    setCard(entry);
  };
  // The card replaces the list, so Back puts the reader where they left it.
  useLayoutEffect(() => {
    const back = listReturn.current;
    const list = listRef.current;
    if (card !== null || back === null || list === null) return;
    listReturn.current = null;
    list.scrollTop = back.scrollTop;
    list
      .querySelector<HTMLElement>(`[data-shelf-entry="${back.id}"]`)
      ?.focus({ preventScroll: true });
  }, [card]);
  return (
    <TimelineSheet
      closeRequested={closeRequested}
      navigationDepth={card === null ? 0 : 1}
      navigationRef={navigationRef}
      onBack={(depth) => {
        if (depth === 0) setCard(null);
      }}
      onClose={onClose}
      title={card === null ? title : card.fullTitle}
      variant="full"
    >
      <div className={styles.shelfSheet} data-timeline-shelf-sheet={chapter}>
        <header className={styles.shelfHeader}>
          {card === null ? (
            <h2 className={styles.sheetTitle}>{title}</h2>
          ) : (
            <button
              aria-label="返回"
              className={styles.sheetIconButton}
              onClick={() => navigationRef.current?.back()}
              type="button"
            >
              <Icon aria-hidden="true" name="back" />
            </button>
          )}
          {card === null ? (
            <button
              aria-label="关闭"
              className={styles.sheetIconButton}
              onClick={() => navigationRef.current?.back()}
              type="button"
            >
              <Icon aria-hidden="true" name="close" />
            </button>
          ) : null}
        </header>
        {card !== null ? (
          <TimelineEntryCard entry={card} />
        ) : (
          <>
            <div className={styles.shelfTabs} role="tablist">
              {MODES.map((item) => (
                <button
                  aria-selected={item.mode === mode}
                  className={styles.shelfTab}
                  key={item.mode}
                  onClick={() => setMode(item.mode)}
                  role="tab"
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className={styles.shelfList} ref={listRef} role="tabpanel">
              {sections.map((section) => (
                <section key={section.key}>
                  {section.label === null ? null : (
                    <h3 className={styles.shelfSectionHead}>
                      <span>{section.label}</span>
                      <span>{section.count}</span>
                    </h3>
                  )}
                  {section.items.map((item) =>
                    item.type === "entry" ? (
                      <ShelfEntry
                        entry={item.entry}
                        key={item.entry.id}
                        mode={mode}
                        onOpen={openEntry}
                      />
                    ) : (
                      <div
                        className={styles.shelfGroup}
                        data-expanded={
                          expanded.has(item.groupKey) ? "" : undefined
                        }
                        key={item.groupKey}
                      >
                        <button
                          aria-expanded={expanded.has(item.groupKey)}
                          className={styles.shelfGroupToggle}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (!next.delete(item.groupKey))
                                next.add(item.groupKey);
                              return next;
                            })
                          }
                          type="button"
                        >
                          <span className={styles.groupTitle}>
                            {item.title}
                          </span>
                          <span className={styles.groupCount}>
                            {item.entries.length} 件
                          </span>
                          {expanded.has(item.groupKey) ? (
                            <span className={styles.groupCollapse}>收起</span>
                          ) : (
                            <Icon
                              aria-hidden="true"
                              className={styles.chevronDown}
                              name="next"
                            />
                          )}
                        </button>
                        {expanded.has(item.groupKey)
                          ? item.entries.map((entry) => (
                              <ShelfEntry
                                entry={entry}
                                key={entry.id}
                                mode={mode}
                                onOpen={openEntry}
                              />
                            ))
                          : null}
                      </div>
                    ),
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </TimelineSheet>
  );
};
