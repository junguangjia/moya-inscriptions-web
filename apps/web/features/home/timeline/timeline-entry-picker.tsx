"use client";

import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { timelineEntryDate } from "./timeline-model";
import { useTimelineEntries } from "./timeline-session";
import styles from "./timeline-posts.module.css";

import type { TimelineEntry } from "@moya/contracts";

/** At most this many matches are listed; more words narrow the rest. */
export const TIMELINE_PICKER_LIMIT = 50;

const haystack = (entry: TimelineEntry) =>
  [
    entry.title,
    entry.fullTitle,
    entry.dateLabel,
    entry.province,
    entry.polity,
    entry.holder,
    timelineEntryDate(entry),
  ]
    .filter((part) => part !== null)
    .join("\n")
    .toLocaleLowerCase("zh-CN");

/**
 * The entries whose title, 年代 or 地点 hold every word of the query, in
 * timeline order, at most `limit`. An empty query matches nothing: the list
 * runs to thousands, so the reader names what they want.
 */
export const searchTimelineEntries = (
  entries: readonly TimelineEntry[],
  query: string,
  limit = TIMELINE_PICKER_LIMIT,
): { readonly matches: readonly TimelineEntry[]; readonly more: boolean } => {
  const words = query
    .trim()
    .toLocaleLowerCase("zh-CN")
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return { matches: [], more: false };
  const matches: TimelineEntry[] = [];
  for (const entry of entries) {
    const text = haystack(entry);
    if (!words.every((word) => text.includes(word))) continue;
    if (matches.length === limit) return { matches, more: true };
    matches.push(entry);
  }
  return { matches, more: false };
};

/** The line under an entry's name: its 年代 and 地点 as the card states them. */
export const timelinePickerMeta = (entry: TimelineEntry): string =>
  [timelineEntryDate(entry), entry.province]
    .filter((part) => part !== null)
    .join(" · ");

/**
 * 关联词条's picker (timeline-posts-v1 §2.3): a local search over the Home
 * timeline the page session holds (read on first use, never with the page)
 * and a single choice. Hidden rows are not in the public list, so they
 * never appear. `onChoose(null)` takes the post off its entry. A picker
 * that opens in place takes the focus to its search (`focusOnOpen`), so
 * the focus is not dropped to the page with its opener; a sheet that moves
 * the focus itself leaves it off.
 */
export const TimelineEntryPicker = ({
  focusOnOpen = false,
  onCancel,
  onChoose,
  selectedId,
}: {
  readonly focusOnOpen?: boolean | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onChoose: (entry: TimelineEntry | null) => void;
  readonly selectedId: string | null;
}) => {
  const { entries, retry } = useTimelineEntries(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusedOnOpen = useRef(false);
  useEffect(() => {
    if (!focusOnOpen || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    searchRef.current?.focus();
  }, [focusOnOpen]);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const searchId = useId();
  const all = entries.state === "ready" ? entries.entries : null;
  const selected = useMemo(
    () =>
      all === null || selectedId === null
        ? null
        : (all.find((entry) => entry.id === selectedId) ?? null),
    [all, selectedId],
  );
  const found = useMemo(
    () =>
      all === null
        ? { matches: [], more: false }
        : searchTimelineEntries(all, deferred),
    [all, deferred],
  );
  const listed =
    selected !== null && !found.matches.some((entry) => entry === selected)
      ? [selected, ...found.matches]
      : found.matches;

  return (
    <div className={styles.picker} data-timeline-entry-picker="">
      <input
        aria-label="搜索词条"
        autoComplete="off"
        className={styles.search}
        enterKeyHint="search"
        id={searchId}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="题名、年代或地点"
        ref={searchRef}
        type="search"
        value={query}
      />
      {entries.state === "loading" || entries.state === "idle" ? (
        <p className={styles.status} role="status">
          正在载入词条
        </p>
      ) : null}
      {entries.state === "failed" ? (
        <div className={styles.row}>
          <p className={styles.status} data-tone="error" role="status">
            词条载入失败
          </p>
          <button className={styles.textAction} onClick={retry} type="button">
            重试
          </button>
        </div>
      ) : null}
      {all !== null && deferred.trim() === "" && selected === null ? (
        <p className={styles.status}>输入题名、年代或地点查找词条。</p>
      ) : null}
      {all !== null && deferred.trim() !== "" && found.matches.length === 0 ? (
        <p className={styles.status} role="status">
          换个字词再找找。
        </p>
      ) : null}
      {listed.length > 0 ? (
        <ul aria-label="词条" className={styles.options} role="radiogroup">
          {listed.map((entry) => {
            const checked = entry.id === selectedId;
            const meta = timelinePickerMeta(entry);
            return (
              <li key={entry.id}>
                <button
                  aria-checked={checked}
                  className={styles.option}
                  data-timeline-entry-option={entry.id}
                  onClick={() => onChoose(entry)}
                  role="radio"
                  type="button"
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>
                      {entry.fullTitle}
                    </span>
                    {meta === "" ? null : (
                      <span className={styles.optionMeta}>{meta}</span>
                    )}
                  </span>
                  {checked ? (
                    <span aria-hidden="true" className={styles.optionMark}>
                      已选
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {found.more ? (
        <p className={styles.status}>
          只列出前 {TIMELINE_PICKER_LIMIT} 条，多输入几个字可缩小范围。
        </p>
      ) : null}
      {selectedId !== null || onCancel !== undefined ? (
        <div className={styles.actions}>
          {selectedId === null ? null : (
            <button
              className={styles.secondary}
              data-timeline-entry-clear=""
              onClick={() => onChoose(null)}
              type="button"
            >
              不关联词条
            </button>
          )}
          {onCancel === undefined ? null : (
            <button
              className={styles.secondary}
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};
