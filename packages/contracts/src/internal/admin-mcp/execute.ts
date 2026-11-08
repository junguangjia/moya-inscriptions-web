import { z } from "zod";

import { adminLockSchema } from "./locate.js";

/**
 * Past this a reversible op goes through a preview and a resumable run, which has no
 * quantity cap, so this is routing and not a limit (admin-mcp-completion-v1 section 7).
 */
export const ADMIN_EXECUTE_MAX_TARGETS = 100;

// Kept as sent, own keys included: Zod's record would drop `__proto__` quietly, and
// a save reads which keys were sent, so its defaults must not join them either.
export const adminSentObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);
const sentObject = adminSentObjectSchema;

/** One intention, scoped to the credential: the same one replays and never repeats. */
export const adminRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const adminExecuteShape = {
  requestId: adminRequestIdSchema,
  op: z.string().min(1).max(64),
  /** The one target, or what every target has in common. */
  input: sentObject.optional(),
  /** Each merges over `input`. A second call with the same requestId replays. */
  targets: z.array(sentObject).min(1).optional(),
  /** Targets before this index are not run again: their ids stay bound by index. */
  startAt: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Run from this target on. The answer covers only these: done is this call's own count.",
    )
    .optional(),
  /** Set by `next`: an earlier call of this batch left a target incomplete. */
  priorIncomplete: z.literal(true).optional(),
};

export const adminExecuteInputSchema = z.strictObject({
  ...adminExecuteShape,
  // Routed to USE_PREVIEW by name, not refused as an unknown field.
  selector: z.unknown().optional(),
});

/** tools/list: runtime is wider, so a larger batch can answer USE_PREVIEW. */
export const adminExecuteListedShape = {
  ...adminExecuteShape,
  input: z.looseObject({}).optional(),
  targets: z
    .array(z.looseObject({}))
    .min(1)
    .max(ADMIN_EXECUTE_MAX_TARGETS)
    .optional(),
};

const runId = z.uuid();

/**
 * A run admin_preview froze, by either name: previewId and runId are one uuid
 * (admin-mcp-completion-v1 section 8). Nothing else travels, so what runs is what was
 * previewed. The requestId only goes into the audit: a run resumes under any.
 */
export const adminRunInputSchema = z
  .strictObject({
    requestId: adminRequestIdSchema,
    previewId: runId.optional(),
    runId: runId.optional(),
  })
  .superRefine(({ previewId, runId: run }, context) => {
    if ((previewId === undefined) !== (run === undefined)) return;
    context.addIssue({
      code: "custom",
      path: [previewId === undefined ? "previewId" : "runId"],
      message: "Exactly one of previewId and runId.",
    });
  });

/** tools/list for a run: plain strings, since a listed uuid costs 195 bytes a field. */
export const adminRunListedShape = {
  requestId: adminRequestIdSchema,
  previewId: z.string().optional(),
  runId: z.string().optional(),
};

const OP_SHAPE_KEYS = [
  "op",
  "input",
  "targets",
  "startAt",
  "priorIncomplete",
  "selector",
] as const;

/**
 * What admin_execute takes once it also runs a previewed run: one op on its targets,
 * or the run by previewId or runId and nothing else. Exactly one of the two shapes, so
 * a call never changes what a preview froze.
 */
export const adminExecuteCallSchema = z
  .strictObject({
    ...adminExecuteShape,
    op: adminExecuteShape.op.optional(),
    selector: z.unknown().optional(),
    previewId: runId.optional(),
    runId: runId.optional(),
  })
  .superRefine((call, context) => {
    const refuse = (key: string, message: string) =>
      context.addIssue({ code: "custom", path: [key], message });
    if (call.previewId === undefined && call.runId === undefined) {
      if (call.op === undefined) refuse("op", "An op, or a previewed run.");
      return;
    }
    if (call.previewId !== undefined && call.runId !== undefined)
      refuse("runId", "Exactly one of previewId and runId.");
    for (const key of OP_SHAPE_KEYS)
      if (call[key] !== undefined) refuse(key, "Not with a previewed run.");
  });

/** tools/list for admin_execute once it takes a run as well: `op` is then optional. */
export const adminExecuteCallListedShape = {
  ...adminExecuteListedShape,
  op: adminExecuteListedShape.op.optional(),
  previewId: adminRunListedShape.previewId,
  runId: adminRunListedShape.runId,
};

export const adminExecuteTargetRefSchema = z.union([z.number(), z.string()]);

/** A target that did not complete: by index, always, and by id when it has a safe one. */
export const adminExecuteRowSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  id: adminExecuteTargetRefSchema.optional(),
  code: z.string().min(1),
  fields: z.array(z.string()).optional(),
  replayed: z.literal(true).optional(),
  lock: adminLockSchema.optional(),
  /** On MEDIA_JOB_FAILED: the newest jobs that stopped, for reading and retrying. */
  jobs: z.array(z.string()).optional(),
});

/** Grouped by state, not one object per target. An empty group is omitted. */
export const adminExecuteDataSchema = z.strictObject({
  applied: z.array(adminExecuteTargetRefSchema).optional(),
  already_applied: z.array(adminExecuteTargetRefSchema).optional(),
  queued: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        id: adminExecuteTargetRefSchema.optional(),
        state: z.string().min(1),
        /** This call changed nothing here: the wait is on work already open. */
        alreadyApplied: z.literal(true).optional(),
      }),
    )
    .optional(),
  conflict: z.array(adminExecuteRowSchema).optional(),
  failed: z.array(adminExecuteRowSchema).optional(),
  unknown: z.array(adminExecuteRowSchema).optional(),
  /**
   * Moderation only: each subject this call moderated got its own case, user message
   * and appeal path, and this many did. A replay opens none.
   */
  moderationCases: z.number().int().positive().optional(),
  /** What each completed target's op answered. It is what a cut drops first. */
  results: z
    .array(z.looseObject({ index: z.number().int().nonnegative() }))
    .optional(),
});

/** One save's row in `results`, so a wrong-record write shows at once. */
export const adminSaveEchoSchema = z.strictObject({
  id: z.number().int().positive(),
  catalogId: z.string().optional(),
  articleId: z.string().optional(),
  collectionId: z.string().optional(),
  title: z.string().optional(),
  revision: z.number().int().nonnegative(),
  fingerprint: z.string().min(1),
  status: z.enum(["draft", "published"]).optional(),
  /** Absent on a replay: what the save changed is no longer known then. */
  changedFields: z.array(z.string()).optional(),
  removedItems: z
    .strictObject({
      media: z.array(z.string()).optional(),
      provenance: z.array(z.string()).optional(),
      /** Stored links the caller was shown as WITHHELD, by place and never by value. */
      links: z.array(z.string()).optional(),
    })
    .optional(),
  supersededIntents: z.array(z.string()).optional(),
  /** Exactly one of these: read the record again only when warnings are present. */
  noRereadNeeded: z.literal(true).optional(),
  warnings: z.array(z.string()).optional(),
});

/**
 * One community write's row in `results`: small, because a report or a work can run
 * past the text cap, and read through admin_get when the whole of it is wanted.
 */
export const adminCommunityWriteEchoSchema = z.looseObject({
  id: z.string().optional(),
  state: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  caseOpened: z.literal(true).optional(),
});

export type AdminExecuteInput = z.infer<typeof adminExecuteInputSchema>;
export type AdminExecuteCall = z.infer<typeof adminExecuteCallSchema>;
export type AdminRunInput = z.infer<typeof adminRunInputSchema>;
export type AdminExecuteRow = z.infer<typeof adminExecuteRowSchema>;
export type AdminExecuteData = z.infer<typeof adminExecuteDataSchema>;
export type AdminSaveEcho = z.infer<typeof adminSaveEchoSchema>;
