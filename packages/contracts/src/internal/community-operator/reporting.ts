import { z } from "zod";
import {
  communityReportActionSchema,
  communityReportSchema,
  communityReportStatusSchema,
} from "../../reporting.ts";

/** Server-only storage outcome: a remote write may still commit after failure.
 * The pending reservation must survive until a later verified retry or expiry. */
export interface ReportingEvidenceWriteOutcome {
  readonly status: "uncertain";
}

export const operatorReportQuerySchema = z
  .object({
    status: communityReportStatusSchema.optional(),
    urgent: z.enum(["true", "false"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const operatorReportSchema = communityReportSchema
  .extend({
    allowedActions: z.array(communityReportActionSchema),
    reporterId: z.string().nullable(),
    affectedUserId: z.string().nullable(),
    legalHold: z.boolean(),
    snapshot: z.record(z.string(), z.unknown()),
    claimant: z
      .object({
        name: z.string(),
        contact: z.string(),
        rightsBasis: z.string(),
      })
      .nullable(),
    materials: z.array(
      z
        .object({
          id: z.string(),
          authorId: z.string(),
          kind: z.enum(["supplement", "statement"]),
          text: z.string(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    history: z.array(
      z
        .object({
          id: z.string(),
          action: z.string(),
          operator: z.string(),
          reason: z.string(),
          occurredAt: z.iso.datetime(),
        })
        .strict(),
    ),
    notificationFailures: z.number().int().nonnegative(),
  })
  .strict();
export const operatorReportPageSchema = z
  .object({
    items: z.array(operatorReportSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export const operatorReportDecisionRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: communityReportActionSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const operatorReportReviewRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    outcome: z.enum(["uphold", "overturn"]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const operatorReportMetadataRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    urgent: z.boolean().optional(),
    legalHold: z.boolean().optional(),
    status: z.enum(["open", "reviewing"]).optional(),
  })
  .strict();
export const operatorReportForwardRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    kind: z.enum(["notice", "statement", "result"]),
    text: z.string().trim().min(1).max(10000),
  })
  .strict();
export type OperatorReport = z.infer<typeof operatorReportSchema>;
export type OperatorReportPage = z.infer<typeof operatorReportPageSchema>;
export type OperatorReportQuery = z.infer<typeof operatorReportQuerySchema>;
export type OperatorReportDecisionRequest = z.infer<
  typeof operatorReportDecisionRequestSchema
>;
export type OperatorReportReviewRequest = z.infer<
  typeof operatorReportReviewRequestSchema
>;
export type OperatorReportMetadataRequest = z.infer<
  typeof operatorReportMetadataRequestSchema
>;
export type OperatorReportForwardRequest = z.infer<
  typeof operatorReportForwardRequestSchema
>;
