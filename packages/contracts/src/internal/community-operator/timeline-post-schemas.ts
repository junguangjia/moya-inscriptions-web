import { z } from "zod";

import { AI_OPERATOR_LABEL } from "../admin-mcp/ai-routes.js";
import { timelineEntryIdSchema } from "../../schemas.js";
import { operatorTimeBoundSchema, rangeInOrder } from "./query-filters.js";

/*
 * timeline-posts-v1: the operator side of the posts on Home timeline rows
 * (community.timeline_entry_posts, one row per work), one shape for the
 * Owner's route and the AI's. An author attaches, moves and detaches an own
 * post through the public command; here the Owner or AI reads every row,
 * attaches a public post (curation), moves one, takes one off, or withholds it
 * from its row. Each write is receipted, audited under the operator label and
 * checked against the version the row was read at (0: the work has no row).
 */

const workId = z.string().regex(/^work-[0-9a-f]{32}$/u);
const userId = z.string().regex(/^user-[0-9a-f]{32}$/u);
const version = z.number().int().min(1).max(2147483647);

/**
 * `attached`: the post shows under its row. `detached`: its author or an
 * operator took it off. `withheld`: an operator took it off its row, and its
 * author may not attach it to that row again (another row stays open).
 */
export const timelinePostStateSchema = z.enum([
  "attached",
  "detached",
  "withheld",
]);

/** Who attached or last changed a post's row: its author, or an operator label. */
export const timelinePostActorSchema = z.enum([
  "author",
  "owner",
  AI_OPERATOR_LABEL,
]);

/**
 * What an operator write was refused for, with nothing changed and nothing
 * recorded. WORK_NOT_PUBLIC: only a public work by an active author is
 * attached by an operator. ENTRY_UNAVAILABLE: the row is unknown or hidden.
 * POST_NOT_ATTACHED: a detach or a withhold of a work with no row, or a
 * withhold of a post that is not attached (its row would name no entry).
 */
export const timelinePostRefusalCodeSchema = z.enum([
  "WORK_NOT_PUBLIC",
  "ENTRY_UNAVAILABLE",
  "POST_NOT_ATTACHED",
]);

/**
 * One post's row as the operator reads it. `entryId` is set exactly while it
 * is attached; `withheldEntryId` names the row an operator last withheld it
 * from, which its author cannot attach it to again. `publiclyVisible`: the work
 * is public and its author active, which is what the public reads and the
 * rows' `postCount` go by.
 */
export const operatorTimelinePostSchema = z.strictObject({
  workId,
  title: z.string(),
  authorId: z.string(),
  workState: z.enum(["visible", "hidden", "removed"]),
  publiclyVisible: z.boolean(),
  entryId: timelineEntryIdSchema.nullable(),
  withheldEntryId: timelineEntryIdSchema.nullable(),
  state: timelinePostStateSchema,
  attachedBy: timelinePostActorSchema,
  updatedBy: timelinePostActorSchema,
  version,
  attachedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** As decimal text on the Backend, where a coercion would read a blank value as 0. */
const textCount = (maximum: number) =>
  z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(maximum));

/**
 * Every filter narrows; all are optional. `entryId` keeps the posts attached to
 * that row and those withheld from it. `from`/`to` bound the row's last change
 * (an attach, a move, a detach or a withhold), which also orders the page,
 * newest first. AI never reads a self-only work here: the Backend leaves it out.
 */
export const operatorTimelinePostQuerySchema = z
  .strictObject({
    page: textCount(100000).default(1),
    pageSize: textCount(50).default(20),
    entryId: timelineEntryIdSchema.optional(),
    workId: workId.optional(),
    authorId: userId.optional(),
    state: timelinePostStateSchema.optional(),
    attachedBy: timelinePostActorSchema.optional(),
    from: operatorTimeBoundSchema.optional(),
    to: operatorTimeBoundSchema.optional(),
  })
  .refine(rangeInOrder);

export const operatorTimelinePostPageSchema = z.strictObject({
  items: z.array(operatorTimelinePostSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

/**
 * One post's row, against the version it was read at (0: the work has no row
 * yet). `entryId` attaches the post to that visible row, or moves it there;
 * an operator attach of the row it was withheld from lifts that withhold.
 * `entryId: null` takes it off; with `state: "withheld"` it is withheld from
 * its row as well. A withhold names no row, which the Backend checks.
 */
export const setTimelinePostCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2147483647),
  entryId: timelineEntryIdSchema.nullable(),
  state: z.literal("withheld").optional(),
});
/** Admin envelope: the work id travels in the route on the Backend side. */
export const adminSetTimelinePostRequestSchema =
  setTimelinePostCommandSchema.extend({ id: workId });

export type TimelinePostState = z.infer<typeof timelinePostStateSchema>;
export type TimelinePostActor = z.infer<typeof timelinePostActorSchema>;
export type TimelinePostRefusalCode = z.infer<
  typeof timelinePostRefusalCodeSchema
>;
export type OperatorTimelinePost = z.infer<typeof operatorTimelinePostSchema>;
export type OperatorTimelinePostQuery = z.infer<
  typeof operatorTimelinePostQuerySchema
>;
export type OperatorTimelinePostPage = z.infer<
  typeof operatorTimelinePostPageSchema
>;
export type SetTimelinePostCommand = z.infer<
  typeof setTimelinePostCommandSchema
>;
