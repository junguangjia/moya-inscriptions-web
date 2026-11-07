import { z } from "zod";

import { AI_OPERATOR_LABEL } from "../admin-mcp/ai-routes.js";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  TIMELINE_RESPONSE_BYTES_MAXIMUM,
  timelineChapterSchema,
  timelineImportEntrySchema,
  timelinePrecisionSchema,
} from "../../schemas.js";
import { operatorExactIdSchema } from "./query-filters.js";

/*
 * home-timeline-v1 (Issue #384 r3): the operator routes of the Home timeline,
 * one shape for the Owner's route and the AI's. The database holds the rows;
 * every write is checked against the import row and the whole set
 * (`checkTimelineEntrySet`) inside the shared content-operator lock.
 *
 * The commands are fresh objects over the import row's field schemas: the row
 * schema itself is refined, and a refined object can neither be narrowed nor
 * lose its `requestId` in Admin. Cross-field rules (an entry ends no earlier
 * than it starts, a group has both an id and a title) are checked on the
 * Backend over the row as it would be stored.
 */
const fields = timelineImportEntrySchema.shape;
const version = z.number().int().min(1).max(2147483647);

/** Who wrote a row: the import, or the operator label the Backend passes. */
export const timelineActorSchema = z.enum([
  "import",
  "owner",
  AI_OPERATOR_LABEL,
]);

/** `published`: the linked Catalog record is published now, so the public read keeps the link. */
export const timelineLinkStateSchema = z.enum([
  "unlinked",
  "published",
  "not_published",
]);

/**
 * What a write was refused for, with nothing changed and nothing recorded.
 * ENTRY_INVALID: the row as it would be stored fails the import row.
 * TIMELINE_INVALID: another stored row does (read issue=contract to find it).
 * SET_CHANGED: a reorder did not list exactly the rows of its start year.
 */
export const timelineRefusalCodeSchema = z.enum([
  "ENTRY_EXISTS",
  "CATALOG_ALREADY_LINKED",
  "TIMELINE_FULL",
  "TIMELINE_TOO_LARGE",
  "ENTRY_INVALID",
  "TIMELINE_INVALID",
  "SET_CHANGED",
]);

/**
 * One stored row as the operator reads it. Values come back as stored, so a
 * row the contract would refuse (issue=contract) is still readable and can be
 * fixed. `position` orders rows within one start year and display rank (the
 * Web ranks an entry with an image first, then a folded group, then text).
 */
export const operatorTimelineEntrySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  fullTitle: z.string(),
  startYear: z.number().int(),
  endYear: z.number().int(),
  precision: timelinePrecisionSchema,
  dateLabel: z.string().nullable(),
  onAxis: z.boolean(),
  chapter: timelineChapterSchema,
  polity: z.string().nullable(),
  disputed: z.boolean(),
  groupId: z.string().nullable(),
  groupTitle: z.string().nullable(),
  province: z.string().nullable(),
  holder: z.string().nullable(),
  catalogId: z.string().nullable(),
  position: z.number().int(),
  version,
  hidden: z.boolean(),
  linkState: timelineLinkStateSchema,
  createdBy: timelineActorSchema,
  updatedBy: timelineActorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * A row's import fields in the contract's order, as the import file holds
 * them: what `timelineImportEntrySchema` (issue=contract) and the response
 * estimate read.
 */
export const timelineImportFieldsOf = (entry: OperatorTimelineEntry) => ({
  id: entry.id,
  title: entry.title,
  fullTitle: entry.fullTitle,
  startYear: entry.startYear,
  endYear: entry.endYear,
  precision: entry.precision,
  dateLabel: entry.dateLabel,
  onAxis: entry.onAxis,
  chapter: entry.chapter,
  polity: entry.polity,
  disputed: entry.disputed,
  groupId: entry.groupId,
  groupTitle: entry.groupTitle,
  province: entry.province,
  holder: entry.holder,
  catalogId: entry.catalogId,
  position: entry.position,
});

/** As text on the Backend, where a coercion would read `false` as true. */
const textBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);
const timelineIds = z.array(fields.id).min(1).max(100);
const filterYear = z.coerce.number().int().min(-3000).max(3000);

/**
 * Every filter narrows; all are optional. `search` matches title, full title,
 * date label, polity, holder and province. `yearFrom`/`yearTo` keep rows whose
 * span overlaps them. `issue`: `contract`, the row fails the import row;
 * `group`, its group has more than one title or members differ in chapter or
 * axis; `chapter_year`, its start year lies outside its chapter's span;
 * `not_published`, it links a Catalog record that is not published. Order is
 * the public read's: start year, position, id.
 */
export const operatorTimelineQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  id: fields.id.optional(),
  /** Comma-joined on the Backend, where a query field carries one value. */
  ids: z
    .union([
      timelineIds,
      z
        .string()
        .transform((value) => value.split(","))
        .pipe(timelineIds),
    ])
    .optional(),
  search: z.string().trim().min(1).max(200).optional(),
  chapter: timelineChapterSchema.optional(),
  yearFrom: filterYear.optional(),
  yearTo: filterYear.optional(),
  polity: z.string().trim().min(1).max(200).optional(),
  precision: timelinePrecisionSchema.optional(),
  onAxis: textBoolean.optional(),
  disputed: textBoolean.optional(),
  groupId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u)
    .optional(),
  linked: z.enum(["any", "linked", "unlinked", "not_published"]).default("any"),
  catalogId: operatorExactIdSchema.optional(),
  hidden: z.enum(["include", "exclude", "only"]).default("include"),
  updatedBy: timelineActorSchema.optional(),
  issue: z
    .enum(["contract", "group", "chapter_year", "not_published"])
    .optional(),
});

export const operatorTimelinePageSchema = z.strictObject({
  items: z.array(operatorTimelineEntrySchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

const count = z.number().int().nonnegative();
/**
 * Counts over every stored row unless named otherwise; `hidden` counts the
 * hidden ones among them. Groups count over visible rows, as the Web folds
 * them: `folding` groups have at least three visible members. The response
 * estimate is the one every write is held to.
 */
export const operatorTimelineSummarySchema = z.strictObject({
  entries: z.strictObject({
    total: count,
    visible: count,
    hidden: count,
    onAxis: count,
    shelf: count,
    disputed: count,
  }),
  chapters: z
    .array(
      z.strictObject({
        chapter: timelineChapterSchema,
        total: count,
        hidden: count,
        onAxis: count,
        shelf: count,
      }),
    )
    .max(timelineChapterSchema.options.length),
  links: z.strictObject({
    unlinked: count,
    published: count,
    notPublished: count,
  }),
  groups: z.strictObject({ total: count, folding: count }),
  updatedBy: z.strictObject({
    import: count,
    owner: count,
    [AI_OPERATOR_LABEL]: count,
  }),
  issues: z.strictObject({
    contract: count,
    group: count,
    chapterYear: count,
    notPublished: count,
  }),
  limits: z.strictObject({
    entries: count,
    entriesMaximum: z.literal(TIMELINE_ENTRIES_MAXIMUM),
    responseBytes: count,
    responseBytesMaximum: z.literal(TIMELINE_RESPONSE_BYTES_MAXIMUM),
  }),
  lastUpdatedAt: z.iso.datetime().nullable(),
});

/**
 * A new row with a chosen id. Without `position` it goes to the end of its
 * start year (the year's highest position plus 1024, or 0).
 */
export const createTimelineEntryCommandSchema = z.strictObject({
  requestId: z.uuid(),
  id: fields.id,
  title: fields.title,
  fullTitle: fields.fullTitle,
  startYear: fields.startYear,
  endYear: fields.endYear,
  precision: fields.precision,
  dateLabel: fields.dateLabel.default(null),
  onAxis: fields.onAxis,
  chapter: fields.chapter,
  polity: fields.polity.default(null),
  disputed: fields.disputed.default(false),
  groupId: fields.groupId.default(null),
  groupTitle: fields.groupTitle.default(null),
  province: fields.province.default(null),
  holder: fields.holder.default(null),
  catalogId: fields.catalogId.default(null),
  position: fields.position.optional(),
});

/**
 * Any subset of a row's fields, against the version it was read at; the id
 * never changes. `catalogId: null` unlinks; `groupId` and `groupTitle` change
 * as a pair. A new `startYear` without `position` goes to the end of that year.
 * `hidden` takes the row out of the public read, or back.
 */
export const updateTimelineEntryCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: version,
  title: fields.title.optional(),
  fullTitle: fields.fullTitle.optional(),
  startYear: fields.startYear.optional(),
  endYear: fields.endYear.optional(),
  precision: fields.precision.optional(),
  dateLabel: fields.dateLabel.optional(),
  onAxis: fields.onAxis.optional(),
  chapter: fields.chapter.optional(),
  polity: fields.polity.optional(),
  disputed: fields.disputed.optional(),
  groupId: fields.groupId.optional(),
  groupTitle: fields.groupTitle.optional(),
  province: fields.province.optional(),
  holder: fields.holder.optional(),
  catalogId: fields.catalogId.optional(),
  position: fields.position.optional(),
  hidden: z.boolean().optional(),
});
/** Admin envelope: the id travels in the route on the Backend side. */
export const adminUpdateTimelineEntryRequestSchema =
  updateTimelineEntryCommandSchema.extend({ id: fields.id });

/** A year's rows in one call: 100,000 body bytes hold about a thousand. */
export const TIMELINE_REORDER_MAXIMUM = 1_000;
/**
 * The rows of one start year in their new order, each at the version it was
 * read at. The list is exactly that year's rows, or SET_CHANGED. Positions
 * become 0, 1024, 2048, ... in list order, and each row's version rises by one.
 */
export const reorderTimelineCommandSchema = z.strictObject({
  requestId: z.uuid(),
  startYear: fields.startYear,
  entries: z
    .array(z.strictObject({ id: fields.id, expectedVersion: version }))
    .min(1)
    .max(TIMELINE_REORDER_MAXIMUM)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      { message: "Each entry is listed once" },
    ),
});
export const timelineReorderResultSchema = z.strictObject({
  startYear: fields.startYear,
  count: z.number().int().positive().max(TIMELINE_REORDER_MAXIMUM),
});

export type TimelineActor = z.infer<typeof timelineActorSchema>;
export type TimelineLinkState = z.infer<typeof timelineLinkStateSchema>;
export type TimelineRefusalCode = z.infer<typeof timelineRefusalCodeSchema>;
export type OperatorTimelineEntry = z.infer<typeof operatorTimelineEntrySchema>;
export type OperatorTimelineQuery = z.infer<typeof operatorTimelineQuerySchema>;
export type OperatorTimelinePage = z.infer<typeof operatorTimelinePageSchema>;
export type OperatorTimelineSummary = z.infer<
  typeof operatorTimelineSummarySchema
>;
export type CreateTimelineEntryCommand = z.infer<
  typeof createTimelineEntryCommandSchema
>;
export type UpdateTimelineEntryCommand = z.infer<
  typeof updateTimelineEntryCommandSchema
>;
export type ReorderTimelineCommand = z.infer<
  typeof reorderTimelineCommandSchema
>;
export type TimelineReorderResult = z.infer<typeof timelineReorderResultSchema>;
