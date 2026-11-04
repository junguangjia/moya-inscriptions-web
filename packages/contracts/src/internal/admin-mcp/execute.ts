import { z } from "zod";

import { adminLockSchema } from "./locate.js";

/**
 * Past this a reversible op goes through a preview and a resumable run, which has no
 * quantity cap, so this is routing and not a limit (admin-mcp-completion-v1 section 7).
 */
export const ADMIN_EXECUTE_MAX_TARGETS = 100;

// Kept as sent, own keys included: Zod's record would drop `__proto__` quietly, and
// a save reads which keys were sent, so its defaults must not join them either.
const sentObject = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);

const adminExecuteShape = {
  requestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/u),
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

const adminExecuteTargetRefSchema = z.union([z.number(), z.string()]);

/** A target that did not complete: by index, always, and by id when it has a safe one. */
export const adminExecuteRowSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  id: adminExecuteTargetRefSchema.optional(),
  code: z.string().min(1),
  fields: z.array(z.string()).optional(),
  replayed: z.literal(true).optional(),
  lock: adminLockSchema.optional(),
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
      }),
    )
    .optional(),
  conflict: z.array(adminExecuteRowSchema).optional(),
  failed: z.array(adminExecuteRowSchema).optional(),
  unknown: z.array(adminExecuteRowSchema).optional(),
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

export type AdminExecuteInput = z.infer<typeof adminExecuteInputSchema>;
export type AdminExecuteRow = z.infer<typeof adminExecuteRowSchema>;
export type AdminExecuteData = z.infer<typeof adminExecuteDataSchema>;
export type AdminSaveEcho = z.infer<typeof adminSaveEchoSchema>;
