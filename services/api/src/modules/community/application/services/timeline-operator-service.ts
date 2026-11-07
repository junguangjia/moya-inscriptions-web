import {
  createTimelineEntryCommandSchema,
  operatorTimelineQuerySchema,
  reorderTimelineCommandSchema,
  updateTimelineEntryCommandSchema,
} from "@moya/contracts/internal/community-operator";

import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";
import {
  timelineIssuesOf,
  timelineSummaryOf,
} from "../mappers/timeline-operator-contract-mapper.js";

import type { TimelineIssue } from "../mappers/timeline-operator-contract-mapper.js";
import type { TimelineOperatorPort } from "../ports/timeline-operator-port.js";
import type {
  OperatorTimelineEntry,
  OperatorTimelinePage,
  OperatorTimelineQuery,
  OperatorTimelineSummary,
} from "@moya/contracts/internal/community-operator";

const command = <T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new CommunityInputError();
  return result.data;
};

const includes = (value: string | null, search: string) =>
  value !== null && value.toLowerCase().includes(search);

/** Every filter given narrows; the order stays the stored one. */
const matches = (
  entry: OperatorTimelineEntry,
  issues: ReadonlySet<TimelineIssue>,
  query: OperatorTimelineQuery,
  ids: ReadonlySet<string> | null,
  search: string | null,
): boolean =>
  (query.id === undefined || entry.id === query.id) &&
  (ids === null || ids.has(entry.id)) &&
  (search === null ||
    [
      entry.title,
      entry.fullTitle,
      entry.dateLabel,
      entry.polity,
      entry.holder,
      entry.province,
    ].some((value) => includes(value, search))) &&
  (query.chapter === undefined || entry.chapter === query.chapter) &&
  (query.yearFrom === undefined || entry.endYear >= query.yearFrom) &&
  (query.yearTo === undefined || entry.startYear <= query.yearTo) &&
  (query.polity === undefined || entry.polity === query.polity) &&
  (query.precision === undefined || entry.precision === query.precision) &&
  (query.onAxis === undefined || entry.onAxis === query.onAxis) &&
  (query.disputed === undefined || entry.disputed === query.disputed) &&
  (query.groupId === undefined || entry.groupId === query.groupId) &&
  (query.linked === "any" ||
    (query.linked === "linked" && entry.catalogId !== null) ||
    (query.linked === "unlinked" && entry.catalogId === null) ||
    (query.linked === "not_published" &&
      entry.linkState === "not_published")) &&
  (query.catalogId === undefined || entry.catalogId === query.catalogId) &&
  (query.hidden === "include" || entry.hidden === (query.hidden === "only")) &&
  (query.updatedBy === undefined || entry.updatedBy === query.updatedBy) &&
  (query.issue === undefined || issues.has(query.issue));

/**
 * Application boundary for the operator side of the Home timeline. The adapter
 * owns transactions, receipts and the whole-set check; reads load every stored
 * row (at most one past the contract's maximum) and filter, page and count
 * here, because `issue=contract` is a contract parse no SQL can run.
 */
export class TimelineOperatorService {
  constructor(private readonly port: TimelineOperatorPort) {}

  private id(value: string): string {
    const parsed = createTimelineEntryCommandSchema.shape.id.safeParse(value);
    if (!parsed.success) throw new CommunityNotFoundError();
    return parsed.data;
  }

  /** Operator inputs arrive untrusted; the Contracts decide what is a query. */
  async operatorList(input: unknown): Promise<OperatorTimelinePage> {
    const query = command(operatorTimelineQuerySchema, input);
    if (
      query.yearFrom !== undefined &&
      query.yearTo !== undefined &&
      query.yearFrom > query.yearTo
    )
      throw new CommunityInputError("The year range ends before it starts");
    const entries = await this.port.operatorTimelineEntries();
    const issues = timelineIssuesOf(entries);
    const ids = query.ids === undefined ? null : new Set(query.ids);
    const search = query.search?.toLowerCase() ?? null;
    const matched = entries.filter((entry, index) =>
      matches(entry, issues[index]!, query, ids, search),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: matched.slice(start, start + query.pageSize),
      total: matched.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Counts, issues and limits over every stored row. */
  async operatorSummary(): Promise<OperatorTimelineSummary> {
    return timelineSummaryOf(await this.port.operatorTimelineEntries());
  }

  operatorCreate(operator: string, input: unknown) {
    return this.port.operatorCreateTimelineEntry(
      operator,
      command(createTimelineEntryCommandSchema, input),
    );
  }

  operatorUpdate(operator: string, id: string, input: unknown) {
    const parsed = command(updateTimelineEntryCommandSchema, input);
    return this.port.operatorUpdateTimelineEntry(operator, this.id(id), parsed);
  }

  operatorReorder(operator: string, input: unknown) {
    return this.port.operatorReorderTimeline(
      operator,
      command(reorderTimelineCommandSchema, input),
    );
  }
}
