import {
  TIMELINE_CHAPTER_SPANS,
  TIMELINE_ENTRIES_MAXIMUM,
  TIMELINE_RESPONSE_BYTES_MAXIMUM,
  estimateTimelineResponseBytes,
  timelineChapterSchema,
  timelineImportEntrySchema,
} from "@moya/contracts/schemas";
import { timelineImportFieldsOf } from "@moya/contracts/internal/community-operator";

import type {
  OperatorTimelineEntry,
  OperatorTimelineQuery,
  OperatorTimelineSummary,
} from "@moya/contracts/internal/community-operator";

export type TimelineIssue = NonNullable<OperatorTimelineQuery["issue"]>;

/** A group folds on the Web once it has this many visible members. */
const GROUP_FOLD_MINIMUM = 3;

/**
 * What is wrong with each stored row, in the order given. Checked over every
 * row, hidden ones included, since any of them may be shown again: `contract`,
 * the row fails the import row; `group`, its group has more than one title or
 * its members differ in chapter or axis; `chapter_year`, its start year lies
 * outside its chapter's span; `not_published`, it links a Catalog record that
 * is not published now. Only the contract refuses a write; the rest report.
 */
export const timelineIssuesOf = (
  entries: readonly OperatorTimelineEntry[],
): readonly ReadonlySet<TimelineIssue>[] => {
  const groups = new Map<
    string,
    {
      titles: Set<string | null>;
      chapters: Set<string>;
      axes: Set<boolean>;
    }
  >();
  for (const { groupId, groupTitle, chapter, onAxis } of entries) {
    if (groupId === null) continue;
    const group = groups.get(groupId) ?? {
      titles: new Set(),
      chapters: new Set(),
      axes: new Set(),
    };
    group.titles.add(groupTitle);
    group.chapters.add(chapter);
    group.axes.add(onAxis);
    groups.set(groupId, group);
  }
  const unevenGroups = new Set(
    [...groups]
      .filter(
        ([, { titles, chapters, axes }]) =>
          titles.size > 1 || chapters.size > 1 || axes.size > 1,
      )
      .map(([groupId]) => groupId),
  );
  return entries.map((entry) => {
    const issues = new Set<TimelineIssue>();
    if (
      !timelineImportEntrySchema.safeParse(timelineImportFieldsOf(entry))
        .success
    )
      issues.add("contract");
    if (entry.groupId !== null && unevenGroups.has(entry.groupId))
      issues.add("group");
    const [from, to] = TIMELINE_CHAPTER_SPANS[entry.chapter];
    if (entry.startYear < from || (to !== null && entry.startYear > to))
      issues.add("chapter_year");
    if (entry.linkState === "not_published") issues.add("not_published");
    return issues;
  });
};

/**
 * The summary over every stored row; groups over the visible ones, as the Web
 * folds them. The response estimate is the one every write is held to.
 */
export const timelineSummaryOf = (
  entries: readonly OperatorTimelineEntry[],
): OperatorTimelineSummary => {
  const issues = timelineIssuesOf(entries);
  const count = (predicate: (entry: OperatorTimelineEntry) => boolean) =>
    entries.filter(predicate).length;
  const issueCount = (issue: TimelineIssue) =>
    issues.filter((found) => found.has(issue)).length;
  const members = new Map<string, number>();
  for (const { groupId, hidden } of entries)
    if (groupId !== null && !hidden)
      members.set(groupId, (members.get(groupId) ?? 0) + 1);
  let lastUpdatedAt: string | null = null;
  for (const { updatedAt } of entries)
    if (lastUpdatedAt === null || updatedAt > lastUpdatedAt)
      lastUpdatedAt = updatedAt;
  return {
    entries: {
      total: entries.length,
      visible: count(({ hidden }) => !hidden),
      hidden: count(({ hidden }) => hidden),
      onAxis: count(({ onAxis }) => onAxis),
      shelf: count(({ onAxis }) => !onAxis),
      disputed: count(({ disputed }) => disputed),
    },
    chapters: timelineChapterSchema.options.map((chapter) => {
      const rows = entries.filter((entry) => entry.chapter === chapter);
      return {
        chapter,
        total: rows.length,
        hidden: rows.filter(({ hidden }) => hidden).length,
        onAxis: rows.filter(({ onAxis }) => onAxis).length,
        shelf: rows.filter(({ onAxis }) => !onAxis).length,
      };
    }),
    links: {
      unlinked: count(({ linkState }) => linkState === "unlinked"),
      published: count(({ linkState }) => linkState === "published"),
      notPublished: count(({ linkState }) => linkState === "not_published"),
    },
    groups: {
      total: members.size,
      folding: [...members.values()].filter(
        (size) => size >= GROUP_FOLD_MINIMUM,
      ).length,
    },
    updatedBy: {
      import: count(({ updatedBy }) => updatedBy === "import"),
      owner: count(({ updatedBy }) => updatedBy === "owner"),
      "ai-admin": count(({ updatedBy }) => updatedBy === "ai-admin"),
    },
    issues: {
      contract: issueCount("contract"),
      group: issueCount("group"),
      chapterYear: issueCount("chapter_year"),
      notPublished: issueCount("not_published"),
    },
    limits: {
      entries: entries.length,
      entriesMaximum: TIMELINE_ENTRIES_MAXIMUM,
      responseBytes: estimateTimelineResponseBytes(
        entries.map(timelineImportFieldsOf),
      ),
      responseBytesMaximum: TIMELINE_RESPONSE_BYTES_MAXIMUM,
    },
    lastUpdatedAt,
  };
};
