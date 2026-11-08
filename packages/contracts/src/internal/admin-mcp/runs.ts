import { z } from "zod";

import { AI_SELECT_FREEZE_MAX, AI_SELECT_IDS_MAX } from "./ai-reads.js";
import {
  ADMIN_EXECUTE_MAX_TARGETS,
  adminExecuteDataSchema,
  adminExecuteTargetRefSchema,
  adminRequestIdSchema,
  adminSentObjectSchema,
} from "./execute.js";

/**
 * admin_preview and the run it freezes (admin-mcp-completion-v1 section 8), held in the
 * CMS tables mcp_runs and mcp_run_targets. A stored run carries this number, so a run
 * frozen in one format never executes in another: it answers PREVIEW_STALE.
 */
export const ADMIN_RUN_FORMAT_VERSION = 1;

/** Section 8's states. Only succeeded gives `ok:true`. */
export const ADMIN_RUN_STATES = [
  "previewed",
  "planning",
  "awaiting_owner",
  "confirmed",
  "running",
  "settling",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "expired",
] as const;
export type AdminRunState = (typeof ADMIN_RUN_STATES)[number];

/** A run in one of these moves no more, and its frozen input is cleared. */
export const ADMIN_RUN_TERMINAL_STATES = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly AdminRunState[];

/** One target's outcome, grouped as admin_execute groups them. */
export const ADMIN_RUN_TARGET_STATES = [
  "pending",
  "conflict",
  "applied",
  "already_applied",
  "queued",
  "failed",
  "unknown",
  "cancelled",
] as const;
export type AdminRunTargetState = (typeof ADMIN_RUN_TARGET_STATES)[number];

/** Targets one planning call freezes, given or selected: the body limit's share. */
export const ADMIN_RUN_FREEZE_MAX = AI_SELECT_FREEZE_MAX;
/** Targets one execute call runs, each under its own budget check. */
export const ADMIN_RUN_EXECUTE_MAX = ADMIN_EXECUTE_MAX_TARGETS;
/** Targets one state read freezes, in one statement. */
export const ADMIN_RUN_STAMP_BATCH = AI_SELECT_IDS_MAX;
/** A run nobody executes expires this long after its last planning call. */
export const ADMIN_PREVIEW_TTL_MS = 15 * 60 * 1000;
/** A run waiting for the Owner, or confirmed and not started, expires after this. */
export const ADMIN_RUN_AWAITING_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_RUN_LEASE_MS = 60 * 1000;
/** A run left this long with no live lease shows as stalled: resumable or cancellable. */
export const ADMIN_RUN_STALLED_MS = 10 * 60 * 1000;
export const ADMIN_PREVIEW_SAMPLE_MAX = 10;
/** Conflict rows and new identities a preview names; the counts stay whole. */
export const ADMIN_PREVIEW_ROWS_MAX = 20;
/** The reason a run stores for the control page, as mcp_runs checks it. */
export const ADMIN_RUN_REASON_MAX = 2_000;

/**
 * What an effect cannot take back, as a preview names it. Fixed English, so a preview
 * never carries content; exhaustive by type, as the code guide is.
 */
export const ADMIN_PREVIEW_CONSEQUENCE_CODES = [
  "body_deleted_permanently",
  "thread_removed",
  "job_not_retried",
  "purge_not_retried",
  "forwarded_to_other_party",
  "legal_hold_released",
  "identity_bound_permanently",
  "subject_notified",
] as const;
export type AdminPreviewConsequence =
  (typeof ADMIN_PREVIEW_CONSEQUENCE_CODES)[number];

export const ADMIN_PREVIEW_CONSEQUENCES: Readonly<
  Record<AdminPreviewConsequence, string>
> = {
  body_deleted_permanently:
    "Each comment's text is deleted for good: nobody can restore it, the Owner included. Replies under it stay.",
  thread_removed:
    "Each thread leaves public view with every reply in it. No op brings it back; only a review that overturns the removal can.",
  job_not_retried:
    "Each job stops and no schedule plans it again: what it was doing stays undone until someone retries it by hand.",
  purge_not_retried:
    "A purge job stops: the data it would remove stays in place, and no schedule plans that purge again.",
  forwarded_to_other_party:
    "The other party receives this text at once. It cannot be recalled or edited.",
  legal_hold_released:
    "The case's legal hold ends, so retention may delete its evidence at once if it closed more than three years ago.",
  identity_bound_permanently:
    "Each new identity is bound to its record for good: it can never name another record, even after a withdrawal.",
  subject_notified:
    "Each subject receives a message about this action, and a message cannot be recalled.",
};

const runId = z.uuid();
const frozenTargets = z
  .array(adminSentObjectSchema)
  .min(1)
  .max(ADMIN_RUN_FREEZE_MAX);

/**
 * `filter` is what admin_read takes as that list op's input. `listOp:"run"` takes the
 * targets an earlier run of this credential applied, so its inverse op undoes it.
 */
export const adminPreviewSelectorSchema = z.union([
  z.strictObject({ listOp: z.literal("run"), runId }),
  z.strictObject({
    listOp: z
      .string()
      .min(1)
      .max(64)
      .refine((name) => name !== "run"),
    filter: adminSentObjectSchema.optional(),
  }),
]);

const adminPreviewShape = {
  /** The run's own: the same one with the same payload returns the same previewId. */
  requestId: adminRequestIdSchema,
  op: z.string().min(1).max(64).optional(),
  /** What every target has in common. */
  input: adminSentObjectSchema.optional(),
  /** Each merges over `input`. More than 5,000 go on through appendTargets. */
  targets: frozenTargets.optional(),
  selector: adminPreviewSelectorSchema.optional(),
  /** How many targets the run will hold; it seals when that many are frozen. */
  expectedCount: z.number().int().min(1).optional(),
  previewId: runId.optional(),
  /** From 1. The next number applies; the same one with the same payload replays. */
  chunkSeq: z.number().int().min(1).optional(),
  appendTargets: frozenTargets.optional(),
  continuePlanning: z.literal(true).optional(),
};

const CREATE_KEYS = [
  "op",
  "input",
  "targets",
  "selector",
  "expectedCount",
] as const;
const PLANNING_KEYS = [
  "previewId",
  "chunkSeq",
  "appendTargets",
  "continuePlanning",
] as const;

/**
 * Three shapes, by which fields arrive: create `{requestId, op, input?, targets |
 * selector, expectedCount?}`, append `{requestId, previewId, chunkSeq, appendTargets}`
 * and continue `{requestId, previewId, chunkSeq, continuePlanning:true}`. A field of
 * another shape is refused by name, so a count is never quietly changed.
 */
export const adminPreviewInputSchema = z
  .strictObject(adminPreviewShape)
  .superRefine((call, context) => {
    const refuse = (key: string, message: string) =>
      context.addIssue({ code: "custom", path: [key], message });
    for (const key of call.previewId === undefined
      ? PLANNING_KEYS
      : CREATE_KEYS)
      if (call[key] !== undefined) refuse(key, "Not in this shape of call.");
    if (call.previewId === undefined) {
      if (call.op === undefined) refuse("op", "A new run names its op.");
      if ((call.targets === undefined) === (call.selector === undefined))
        refuse(
          call.targets === undefined ? "targets" : "selector",
          "Exactly one of targets and selector.",
        );
      if (
        call.expectedCount !== undefined &&
        (call.targets === undefined || call.expectedCount < call.targets.length)
      )
        refuse("expectedCount", "At least as many as the targets sent.");
      return;
    }
    if (call.chunkSeq === undefined)
      refuse("chunkSeq", "A planning call carries its number.");
    if (
      (call.appendTargets === undefined) ===
      (call.continuePlanning === undefined)
    )
      refuse(
        call.appendTargets === undefined ? "appendTargets" : "continuePlanning",
        "Exactly one of appendTargets and continuePlanning.",
      );
  });
export type AdminPreviewInput = z.infer<typeof adminPreviewInputSchema>;

/** Which of the three shapes a parsed call is. */
export const previewCallKind = (
  call: AdminPreviewInput,
): "create" | "append" | "continue" =>
  call.previewId === undefined
    ? "create"
    : call.appendTargets === undefined
      ? "continue"
      : "append";

/**
 * tools/list: plain strings, integers and open objects, within the 1,100 bytes a tool
 * added after E1 lists in. A listed uuid costs 195 bytes a field, and the bounds the
 * runtime check holds name their path when they fail.
 */
export const adminPreviewListedShape = {
  ...adminPreviewShape,
  input: z.looseObject({}).optional(),
  targets: z.array(z.looseObject({})).optional(),
  selector: z.looseObject({}).optional(),
  expectedCount: z.number().int().optional(),
  previewId: z.string().optional(),
  chunkSeq: z.number().int().optional(),
  appendTargets: z.array(z.looseObject({})).optional(),
  continuePlanning: z.boolean().optional(),
};

const index = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

/** A target as a preview shows it: by index and a ref no text fits in, never its content. */
const previewTargetSchema = z.strictObject({
  index,
  ref: adminExecuteTargetRefSchema.optional(),
  /** Its state now, as frozen: a fixed word. */
  state: z.string().min(1).max(64).optional(),
});

/**
 * admin_preview's `data`. `count` is the targets that will run: a conflict is frozen
 * too, but never runs and never counts. No `next` once an irreversible run is sealed:
 * running it is a call of its own.
 */
export const adminPreviewDataSchema = z.strictObject({
  previewId: runId,
  op: z.string().min(1).max(64),
  class: z.enum(["reversible", "irreversible"]),
  count,
  sample: z.array(previewTargetSchema).max(ADMIN_PREVIEW_SAMPLE_MAX),
  conflicts: z.strictObject({
    count,
    rows: z
      .array(
        z.strictObject({
          index,
          ref: adminExecuteTargetRefSchema.optional(),
          code: z.string().min(1),
        }),
      )
      .max(ADMIN_PREVIEW_ROWS_MAX),
  }),
  /** Summed over the targets and shown, never compared: one thread is one target. */
  impact: z.record(z.string(), count).optional(),
  consequences: z.array(z.enum(ADMIN_PREVIEW_CONSEQUENCE_CODES)),
  /** Subjects that receive a message they cannot recall. */
  userNotifications: count,
  /** Identities the run binds for good, each by its target and field. */
  newIdentities: z
    .strictObject({
      count,
      first: z
        .array(
          z.strictObject({
            index,
            field: z.string().min(1).max(64),
            value: z.string().min(1).max(500),
          }),
        )
        .max(ADMIN_PREVIEW_ROWS_MAX),
    })
    .optional(),
  needsOwnerConfirmation: z.boolean(),
  /** The Owner's, read now; the run compares it again when it first executes. */
  threshold: z.number().int().min(1),
  expiresAt: z.iso.datetime(),
  sealed: z.boolean(),
  /** What one op adds, in its own fixed shape: a duplicate's carried and dropped fields. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AdminPreviewData = z.infer<typeof adminPreviewDataSchema>;

/** An execute call on a run answers as admin_execute does, and a run adds these. */
export const adminRunDataSchema = adminExecuteDataSchema.extend({
  /** Targets a cancel stopped before they ran. */
  cancelled: z.number().int().positive().optional(),
  /** On AWAITING_OWNER: the control page that confirms this run, and until when. */
  awaiting: z
    .strictObject({
      path: z.string().regex(/^\/[\w/-]*$/u),
      expiresAt: z.iso.datetime(),
    })
    .optional(),
});
export type AdminRunData = z.infer<typeof adminRunDataSchema>;

/** A run's reason as list.runs shows it, in code points; the control page shows it whole. */
export const ADMIN_RUN_REASON_SHOWN = 500;

/**
 * list.runs: this credential's runs, newest first, or with `runId` that run's targets
 * in index order. Another credential's run reads as none. No frozen input ever shows.
 */
export const adminRunListInputSchema = z.strictObject({
  runId: runId.optional(),
});
export type AdminRunListInput = z.infer<typeof adminRunListInputSchema>;

/** run.cancel: a run of this credential with no live lease ends at once. */
export const adminRunCancelInputSchema = z.strictObject({ runId });
export type AdminRunCancelInput = z.infer<typeof adminRunCancelInputSchema>;

/** Each target state's tally; a state no target is in is left out. */
const runTallySchema = z.partialRecord(
  z.enum(ADMIN_RUN_TARGET_STATES),
  z.number().int().positive(),
);

/** A run as list.runs shows it: its states and counts, never its input. */
export const adminRunRowSchema = z.strictObject({
  runId,
  op: z.string().min(1).max(64),
  class: z.enum(["reversible", "irreversible"]),
  state: z.enum(ADMIN_RUN_STATES),
  /** Targets frozen, conflicts found at preview included. */
  count,
  /** Targets no longer pending. */
  done: count,
  counts: runTallySchema,
  needsOwnerConfirmation: z.boolean(),
  /** No live lease for a while: its execute tool resumes it, run.cancel ends it. */
  stalled: z.literal(true).optional(),
  /** Only where the state has a deadline. */
  expiresAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});
export type AdminRunRow = z.infer<typeof adminRunRowSchema>;

/** One target as list.runs shows it: by index, a safe id, and fixed words. */
export const adminRunTargetRowSchema = z.strictObject({
  index,
  id: adminExecuteTargetRefSchema.optional(),
  state: z.enum(ADMIN_RUN_TARGET_STATES),
  code: z.string().min(1).max(64).optional(),
  /** A queued target's own word on what it waits for. */
  settledState: z.string().min(1).max(64).optional(),
});
export type AdminRunTargetRow = z.infer<typeof adminRunTargetRowSchema>;

/** The run a target page belongs to, with the reason it was planned under. */
export const adminRunAboutSchema = adminRunRowSchema.extend({
  /** The caller's own words, cut at ADMIN_RUN_REASON_SHOWN; untrusted. */
  reason: z
    .string()
    .max(ADMIN_RUN_REASON_SHOWN * 2)
    .optional(),
  /** Set when the reason was cut: its whole length, in code points. */
  reasonLength: z.number().int().positive().optional(),
});

/** list.runs's `data`, as admin_read answers rows; `next` is the way on. */
export const adminRunListDataSchema = z.strictObject({
  rows: z.array(z.union([adminRunRowSchema, adminRunTargetRowSchema])),
  filter: adminRunListInputSchema,
  total: count.optional(),
  about: adminRunAboutSchema.optional(),
});

/** What run.cancel answers of its one run: where it ended, and every target's tally. */
export const adminRunCancelEchoSchema = z.strictObject({
  runId,
  state: z.enum(ADMIN_RUN_STATES),
  counts: runTallySchema,
});

/**
 * Canonical JSON (f1): keys in UTF-16 code-unit order at every depth, strings as sent
 * with no Unicode normalization, numbers as JSON writes them. Anything JSON cannot
 * hold the same way twice is refused rather than written: undefined in an array, a
 * non-finite number, a class instance. A key whose value is undefined is left out, as
 * JSON leaves it out.
 */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("canonicalJson: a non-finite number");
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined)
      throw new TypeError(`canonicalJson: a ${typeof value}`);
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("canonicalJson: not a plain object");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

/** The text a fingerprint hashes: its format, then the canonical JSON. Admin hashes it. */
export const fingerprintTextOf = (value: unknown): string =>
  `f1:${canonicalJson(value)}`;
