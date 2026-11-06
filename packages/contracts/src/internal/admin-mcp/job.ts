import { z } from "zod";

import { publishingJobIdSchema } from "../community-operator/work-publishing-schemas.js";
import { aiSettlementQuerySchema } from "./ai-reads.js";

/**
 * admin_job (admin-mcp-completion-v1 sections 3 and 9): how far the work an op queued
 * has got, read without repeating the op. A row of its answer fits under the text cap
 * at this many, along with a `next` naming them all.
 */
export const ADMIN_JOB_MAX_REFS = 50;

/** One thing to settle: copied from the `next` of a QUEUED answer. */
export const adminJobRefSchema = z.union([
  aiSettlementQuerySchema,
  z.strictObject({
    type: z.literal("publishing_job"),
    id: publishingJobIdSchema,
  }),
]);

export const adminJobInputSchema = z.strictObject({
  kind: z.literal("settlement"),
  refs: z.array(adminJobRefSchema).min(1).max(ADMIN_JOB_MAX_REFS),
});

/** Grouped by ref, in the order sent: `state` is what this read of it found. */
export const adminJobRowSchema = z.strictObject({
  type: z.string(),
  id: z.string(),
  state: z.enum(["settled", "open", "failed", "unread", "refused"]),
  open: z.number().int().positive().optional(),
  failed: z.number().int().positive().optional(),
  jobs: z.array(publishingJobIdSchema).optional(),
  /** Why it was refused: a ref no source could answer stays `unread` and has none. */
  code: z.string().optional(),
});

export const adminJobDataSchema = z.strictObject({
  refs: z.array(adminJobRowSchema),
});

export type AdminJobInput = z.infer<typeof adminJobInputSchema>;
export type AdminJobRef = z.infer<typeof adminJobRefSchema>;
export type AdminJobRow = z.infer<typeof adminJobRowSchema>;
