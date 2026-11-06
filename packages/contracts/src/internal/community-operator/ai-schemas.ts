import { z } from "zod";

import {
  AI_OPERATOR_LABEL,
  SELF_ONLY_OWNER_REVIEW,
} from "../admin-mcp/ai-routes.js";
import { operatorUserSchema } from "./content-schemas.js";
import { operatorReportSchema } from "./reporting.ts";

/**
 * What only the AI operator reads (admin-mcp-completion-v1 sections 5, 6 and 12),
 * beside the Owner's shapes, which stay as they are. The Backend emits these only for
 * `ai-admin`, so Owner UI parsing cannot change and no deployment order applies.
 */

/** Which rows a read may hand over; the Owner reads everything, as always. */
export interface OperatorReadScope {
  /**
   * Leave out self-only works, comments and replies under them, and the text of
   * reports on either. Read from current visibility on every call.
   */
  readonly withholdSelfOnly: boolean;
}

/**
 * The trailing argument a service's own label gives its reads, so a read cannot
 * forget to ask. None for the Owner, whose calls stay as they have always been.
 */
export const operatorReadScopeFor = (
  label: string,
): readonly [] | readonly [OperatorReadScope] =>
  label === AI_OPERATOR_LABEL ? [{ withholdSelfOnly: true }] : [];

/**
 * What only `ai-admin` is told of a write: `replayed`, its receipt answered and nothing
 * ran; `alreadyInPlace`, nothing was left to change. The Owner's answers stay as they
 * always were, and a stored receipt holds neither word.
 */
export const markForAiOperator = <Answer>(
  label: string,
  answer: Answer,
  mark: "replayed" | "alreadyInPlace",
): Answer =>
  label === AI_OPERATOR_LABEL
    ? ({ ...(answer as object), [mark]: true } as Answer)
    : answer;

/**
 * A report as AI reads it. Evidence keeps its count and type: its id, name and
 * download path are behind the evidence switch. `redacted` names what was removed.
 * A rights claimant's contact is withheld in every state of every switch.
 */
export const operatorReportAiSchema = operatorReportSchema
  .omit({ claimant: true, evidence: true })
  .extend({
    claimant: z
      .strictObject({ name: z.string(), rightsBasis: z.string() })
      .nullable(),
    evidence: z.array(
      z.strictObject({
        mimeType: z.string(),
        size: z.number().int().positive(),
        sensitive: z.boolean(),
        createdAt: z.iso.datetime(),
      }),
    ),
    redacted: z.array(z.string()),
  })
  .strict();

/** A case on a self-only work or a comment under one: it exists, and it is the Owner's. */
export const operatorReportOwnerOnlySchema = z.strictObject({
  id: z.string(),
  kind: operatorReportSchema.shape.kind,
  status: operatorReportSchema.shape.status,
  ownerOnly: z.literal(true),
  code: z.literal(SELF_ONLY_OWNER_REVIEW),
});

export const operatorReportAiAnswerSchema = z.union([
  operatorReportAiSchema,
  operatorReportOwnerOnlySchema,
]);

export const operatorReportAiPageSchema = z.strictObject({
  items: z.array(operatorReportAiAnswerSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  /** Decided by the query alone, so saying it says nothing about any one case. */
  leavesOutOwnerOnly: z.literal(true).optional(),
});

export type OperatorReportAi = z.infer<typeof operatorReportAiSchema>;
export type OperatorReportOwnerOnly = z.infer<
  typeof operatorReportOwnerOnlySchema
>;
export type OperatorReportAiAnswer = z.infer<
  typeof operatorReportAiAnswerSchema
>;
export type OperatorReportAiPage = z.infer<typeof operatorReportAiPageSchema>;

/** Every AI report answer passes here: nothing else builds the AI shape. */
export const projectReportForAi = (
  report: z.infer<typeof operatorReportSchema>,
): OperatorReportAi => {
  const { claimant, evidence, ...rest } = report;
  return operatorReportAiSchema.parse({
    ...rest,
    claimant:
      claimant === null
        ? null
        : { name: claimant.name, rightsBasis: claimant.rightsBasis },
    evidence: evidence.map(({ mimeType, size, sensitive, createdAt }) => ({
      mimeType,
      size,
      sensitive,
      createdAt,
    })),
    redacted: [
      ...(claimant === null ? [] : ["claimant.contact"]),
      ...(evidence.length === 0
        ? []
        : ["evidence.id", "evidence.fileName", "evidence.downloadPath"]),
    ],
  });
};

/** What a person asks about a user in one read, with withheld works left out. */
export const operatorUserAiSchema = operatorUserSchema.extend({
  commentCount: z.number().int().nonnegative(),
  reportCount: z.number().int().nonnegative(),
});
export const operatorUserAiPageSchema = z.strictObject({
  items: z.array(operatorUserAiSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type OperatorUserAi = z.infer<typeof operatorUserAiSchema>;
export type OperatorUserAiPage = z.infer<typeof operatorUserAiPageSchema>;
