import { z } from "zod";

import { ADMIN_MCP_NATIVE_TOOLS } from "./op-names.js";

/** At most this many ops in one admin_actions detail call. */
export const ADMIN_ACTIONS_MAX_OPS = 5;

const opName = z.string().min(1).max(64);

/**
 * No argument gives the index; `op` or `ops` gives details; `tool` alone gives that
 * tool's worked examples. tools/list shows `tool` as a string: the names grow.
 */
export const adminActionsInputSchema = z.strictObject({
  op: opName.optional(),
  ops: z.array(opName).min(1).max(ADMIN_ACTIONS_MAX_OPS).optional(),
  tool: z.enum(ADMIN_MCP_NATIVE_TOOLS).optional(),
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

/** One worked call of a tool, and what it shows: fixed English, never content. */
export const adminToolExampleSchema = z.strictObject({
  args: z.record(z.string(), z.unknown()),
  says: z.string().min(1),
});

/**
 * admin_actions `{tool}`: the examples tools/list has no room for. A tool this
 * credential cannot call has none, under the code an op on it reports.
 */
export const adminToolDetailSchema = z.strictObject({
  tool: z.string().min(1),
  available: z.boolean(),
  unavailable: z.string().min(1).optional(),
  examples: z.array(adminToolExampleSchema).optional(),
});

/** UNKNOWN_OP carries these in `data`. Registry names, never the caller's text. */
export const adminUnknownOpDataSchema = z.strictObject({
  nearest: z.array(opName),
});

/** OP_RETIRED: the earlier name, from the alias table, and the op that replaced it. */
export const adminRetiredOpDataSchema = z.strictObject({
  op: opName,
  use: opName,
});

/** WRONG_TOOL: the tool this op runs on. */
export const adminWrongToolDataSchema = z.strictObject({
  tool: z.string().min(1),
});

export type AdminActionsInput = z.infer<typeof adminActionsInputSchema>;
export type AdminActionsIndex = z.infer<typeof adminActionsIndexSchema>;
export type AdminActionDetail = z.infer<typeof adminActionDetailSchema>;
export type AdminActionDetails = z.infer<typeof adminActionDetailsSchema>;
export type AdminToolExample = z.infer<typeof adminToolExampleSchema>;
export type AdminToolDetail = z.infer<typeof adminToolDetailSchema>;
