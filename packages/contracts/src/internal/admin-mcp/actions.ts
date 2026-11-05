import { z } from "zod";

/** At most this many ops in one admin_actions detail call. */
export const ADMIN_ACTIONS_MAX_OPS = 5;

const opName = z.string().min(1).max(64);

/** No argument gives the index; `op` or `ops` gives details. */
export const adminActionsInputSchema = z.strictObject({
  op: opName.optional(),
  ops: z.array(opName).min(1).max(ADMIN_ACTIONS_MAX_OPS).optional(),
});

const opClass = z.enum(["read", "reversible", "irreversible"]);

/**
 * Rows are `name(required,fields)`, grouped by tool so the class stays implied:
 * one string each, because the index must fit one text result. `unavailable`
 * holds rows this key cannot call now, under the code a call would answer.
 */
export const adminActionsIndexSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  groups: z.array(
    z.strictObject({
      tool: z.string().min(1),
      class: opClass,
      ops: z.array(z.string().min(1)),
      unavailable: z
        .record(z.string().min(1), z.array(z.string().min(1)))
        .optional(),
    }),
  ),
});

const jsonSchema = z.record(z.string(), z.unknown());

/** One op's whole contract, so a client never guesses its arguments. */
export const adminActionDetailSchema = z.strictObject({
  op: opName,
  summary: z.string().min(1),
  tool: z.string().min(1),
  class: opClass,
  risesWhen: z.string().min(1).optional(),
  sensitive: z.string().min(1).optional(),
  recovery: z.enum(["receipt", "cas_read_back", "state_idempotent"]),
  completion: z.enum(["sync", "async"]),
  available: z.boolean(),
  /** What a call answers now, when `available` is false. */
  unavailable: z.string().min(1).optional(),
  input: jsonSchema.optional(),
  /** The `data` a success carries, per op; every tool shares one envelope schema. */
  output: jsonSchema.optional(),
  /** Set when `output` would not fit one text result beside the rest. */
  outputOmitted: z.literal(true).optional(),
  example: z.record(z.string(), z.unknown()).optional(),
  selectorSources: z.array(z.string().min(1)).optional(),
});

export const adminActionDetailsSchema = z.strictObject({
  details: z.array(adminActionDetailSchema),
});

/** UNKNOWN_OP carries these in `data`. Registry names, never the caller's text. */
export const adminUnknownOpDataSchema = z.strictObject({
  nearest: z.array(opName),
});

export type AdminActionsInput = z.infer<typeof adminActionsInputSchema>;
export type AdminActionsIndex = z.infer<typeof adminActionsIndexSchema>;
export type AdminActionDetail = z.infer<typeof adminActionDetailSchema>;
export type AdminActionDetails = z.infer<typeof adminActionDetailsSchema>;
