import { z } from "zod";

import {
  WORK_BODY_MAXIMUM,
  WORK_ITEMS_CONFIGURABLE_MAXIMUM,
  WORK_ITEMS_HARD_MAXIMUM,
  WORK_TITLE_MAXIMUM,
  mediaEditKeySchema,
  mediaEditSchema,
  mediaCropSchema,
  mediaItemIdSchema,
  mediaItemKindSchema,
  mediaItemStateSchema,
  mediaPresentationSchema,
  mediaQualityModeSchema,
  mediaVariantSchema,
  publicUserDisplayNameSchema,
  publicUserHandleSchema,
  storedPublishingTextSchema,
  workAuthorshipSchema,
  workRevisionIdSchema,
} from "../../schemas.js";
import { operatorLabelSchema, publicationPolicySchema } from "./schemas.js";

/**
 * Server-only operator shapes for work publishing: the independent work
 * publication policy and limits, the explicit submission queue, account
 * capacity designation and content-free job outcomes. Never a Public DTO,
 * never OpenAPI; the Admin envelope carries the subject id and forwards only
 * the command body.
 */

const version = z.number().int().nonnegative().max(2147483647);
const count = z.number().int().nonnegative().max(2147483647);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: false });
const requestId = z.uuid();
const workId = z.string().regex(/^work-[0-9a-f]{32}$/u);
const strictUserId = z.string().regex(/^user-[0-9a-f]{32}$/u);
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const TEBIBYTE = 1024 * GIBIBYTE;

const pageNumber = z
  .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
  .pipe(z.coerce.number<string | number>().int().min(1).max(100000))
  .default(1);
const pageSize = z
  .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
  .pipe(z.coerce.number<string | number>().int().min(1).max(50))
  .default(20);

/** Every configurable limit with its sane bound; the Backend enforces the stored values. */
const workPublishingLimitsShape = {
  /** At most 100, so a full draft save with realistic text stays within the 100 KB JSON command limit. */
  maxItemsPerWork: z.number().int().min(1).max(WORK_ITEMS_CONFIGURABLE_MAXIMUM),
  originalItemMaxBytes: z
    .number()
    .int()
    .min(MEBIBYTE)
    .max(8 * GIBIBYTE),
  standardComponentMaxBytes: z
    .number()
    .int()
    .min(MEBIBYTE)
    .max(8 * GIBIBYTE),
  ordinaryAccountCapacityBytes: z.number().int().min(MEBIBYTE).max(TEBIBYTE),
  ownerAccountCapacityBytes: z.number().int().min(MEBIBYTE).max(TEBIBYTE),
  maxActiveDrafts: z.number().int().min(1).max(10_000),
  dailyNewWorkLimit: z.number().int().min(1).max(10_000),
  historyLimit: z.number().int().min(1).max(200),
  trashRetentionDays: z.number().int().min(1).max(365),
  orphanGraceDays: z.number().int().min(1).max(90),
  unsavedSessionLeaseMinutes: z.number().int().min(5).max(10_080),
};

/** Independent of the comment publication policy; prospective only. */
export const workPublishingSettingsSchema = z.strictObject({
  policy: publicationPolicySchema,
  ...workPublishingLimitsShape,
  version,
  updatedAt: timestamp,
  updatedBy: operatorLabelSchema.nullable(),
});

export const setWorkPublishingSettingsCommandSchema = z.strictObject({
  requestId,
  expectedVersion: version,
  policy: publicationPolicySchema,
  ...workPublishingLimitsShape,
});

/** Every stored revision disposition; `not_required` marks a self-only submission. */
export const workSubmissionDispositionSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn",
  "not_required",
]);

/**
 * The dispositions an operator can see. Self-only (`not_required`) revisions
 * are private works and never enter the queue or its item reads (P04).
 */
export const workSubmissionQueueStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn",
]);

export const operatorWorkSubmissionQuerySchema = z.strictObject({
  state: workSubmissionQueueStateSchema.optional(),
  page: pageNumber,
  pageSize,
});

/**
 * One revision item as a content-free descriptor; bytes come from the operator
 * media proxy. `editKey` addresses the display, full and motion variants (the
 * item edit alone). `coverEditKey` addresses the thumb and cover variants of
 * the revision's cover item (its edit and the revision cover crop); it is null
 * for every other item, whose thumb and cover use `editKey`. `variants` names
 * the five moderation derivatives only: the optional `viewer` zoom still
 * (unified media pipeline) is a reader candidate, never listed here or
 * requested through the Admin media proxy.
 */
export const operatorSubmissionMediaSchema = z.strictObject({
  position: z.number().int().min(1).max(WORK_ITEMS_HARD_MAXIMUM),
  itemId: mediaItemIdSchema,
  kind: mediaItemKindSchema,
  qualityMode: mediaQualityModeSchema,
  state: mediaItemStateSchema,
  edit: mediaEditSchema,
  editKey: mediaEditKeySchema,
  coverEditKey: mediaEditKeySchema.nullable(),
  presentation: mediaPresentationSchema.nullable(),
  variants: z
    .array(mediaVariantSchema.exclude(["viewer"]))
    .max(5)
    .refine((variants) => new Set(variants).size === variants.length, {
      message: "variants must be unique",
    }),
});

/**
 * An explicit immutable submission that requested public visibility;
 * autosaves and self-only submissions never appear here. Text is returned as
 * stored, including legacy Phase 4 line breaks.
 */
export const operatorWorkSubmissionSchema = z
  .strictObject({
    revisionId: workRevisionIdSchema,
    workId,
    sequence: z.number().int().min(1).max(2147483647),
    origin: z.enum(["submission", "legacy"]),
    author: z.strictObject({
      id: strictUserId,
      handle: publicUserHandleSchema,
      displayName: publicUserDisplayNameSchema,
      status: z.enum(["active", "suspended"]),
    }),
    title: storedPublishingTextSchema(WORK_TITLE_MAXIMUM),
    body: storedPublishingTextSchema(WORK_BODY_MAXIMUM),
    /** Null when the revision declares no authorship (legacy baselines, undeclared submissions). */
    authorship: workAuthorshipSchema.nullable(),
    coverItemId: mediaItemIdSchema.nullable(),
    coverCrop: mediaCropSchema.nullable(),
    items: z.array(operatorSubmissionMediaSchema).max(WORK_ITEMS_HARD_MAXIMUM),
    disposition: workSubmissionQueueStateSchema,
    /** Only the latest explicit submission of a work can be approved. */
    latest: z.boolean(),
    workState: z.enum(["visible", "hidden", "removed"]),
    workTrashed: z.boolean(),
    submittedAt: timestamp,
    decidedAt: timestamp.nullable(),
    decidedBy: operatorLabelSchema.nullable(),
    version,
  })
  .superRefine((submission, context) => {
    submission.items.forEach((item, index) => {
      if (
        (item.coverEditKey !== null) !==
        (item.itemId === submission.coverItemId)
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "coverEditKey"],
          message: "only the cover item carries a cover edit key",
        });
    });
  });

export const operatorWorkSubmissionPageSchema = z.strictObject({
  items: z.array(operatorWorkSubmissionSchema).max(50),
  total: count,
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: count,
});

export const workSubmissionModerationActionSchema = z.enum([
  "approve",
  "reject",
]);

/** The Backend command body; the revision id travels in the route. */
export const moderateWorkSubmissionCommandSchema = z.strictObject({
  requestId,
  action: workSubmissionModerationActionSchema,
  expectedVersion: version,
});

export const adminModerateWorkSubmissionRequestSchema =
  moderateWorkSubmissionCommandSchema.extend({ id: workRevisionIdSchema });

export const adminReadWorkSubmissionRequestSchema = z.strictObject({
  id: workRevisionIdSchema,
});

export const workSubmissionModerationResultSchema = z.strictObject({
  revisionId: workRevisionIdSchema,
  workId,
  disposition: z.enum(["approved", "rejected"]),
  version,
});

/** Owner capacity is designated on an immutable account id, never a handle or name. */
export const accountCapacityClassSchema = z.enum(["ordinary", "owner"]);

export const operatorAccountCapacitySchema = z.strictObject({
  accountId: strictUserId,
  capacityClass: accountCapacityClassSchema,
  capacityBytes: bytes,
  committedBytes: bytes,
  reservedBytes: bytes,
  version,
  updatedAt: timestamp.nullable(),
});

export const setAccountCapacityClassCommandSchema = z.strictObject({
  requestId,
  capacityClass: accountCapacityClassSchema,
  expectedVersion: version,
});

export const adminSetAccountCapacityClassRequestSchema =
  setAccountCapacityClassCommandSchema.extend({ accountId: strictUserId });

export const adminReadAccountCapacityRequestSchema = z.strictObject({
  accountId: strictUserId,
});

export const publishingJobIdSchema = z
  .string()
  .regex(/^publishing-job-[0-9a-f]{32}$/u);
/** Media blob ids are operator-visible job subjects only; never public. */
export const mediaBlobIdSchema = z.string().regex(/^media-blob-[0-9a-f]{32}$/u);

/**
 * Every durable job kind: the one definition. The PostgreSQL CHECK
 * `publishing_jobs_kind_valid` restates this list in each migration that
 * changes it, and an integration test compares both.
 */
export const publishingJobKindSchema = z.enum([
  "process_item",
  "derive_edit",
  "purge_item",
  "purge_blob",
  "expire_session",
  "purge_trashed_work",
  "sweep_staging",
  "reconcile_capacity",
  "catalog_render",
]);

export const publishingJobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);

/** Content-free: ids, counters, times and an error code; never payloads, paths or messages. */
export const operatorPublishingJobSchema = z.strictObject({
  id: publishingJobIdSchema,
  kind: publishingJobKindSchema,
  subjectId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/u),
  state: publishingJobStateSchema,
  attempts: count,
  maxAttempts: z.number().int().min(1).max(1000),
  runAfter: timestamp,
  leaseExpiresAt: timestamp.nullable(),
  lastErrorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/u)
    .nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.nullable(),
});

export const operatorPublishingJobQuerySchema = z.strictObject({
  state: publishingJobStateSchema.optional(),
  kind: publishingJobKindSchema.optional(),
  page: pageNumber,
  pageSize,
});

export const operatorPublishingJobPageSchema = z.strictObject({
  items: z.array(operatorPublishingJobSchema).max(50),
  total: count,
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: count,
});

export const publishingJobActionSchema = z.enum(["retry", "abandon"]);

/** The Backend command body for `jobs/:id/retry` and `jobs/:id/abandon`. */
export const publishingJobCommandSchema = z.strictObject({ requestId });

export const adminPublishingJobRequestSchema = z.strictObject({
  id: publishingJobIdSchema,
  action: publishingJobActionSchema,
  requestId,
});

export type WorkPublishingSettings = z.infer<
  typeof workPublishingSettingsSchema
>;
export type SetWorkPublishingSettingsCommand = z.infer<
  typeof setWorkPublishingSettingsCommandSchema
>;
export type WorkSubmissionDisposition = z.infer<
  typeof workSubmissionDispositionSchema
>;
export type WorkSubmissionQueueState = z.infer<
  typeof workSubmissionQueueStateSchema
>;
export type OperatorWorkSubmissionQuery = z.infer<
  typeof operatorWorkSubmissionQuerySchema
>;
export type OperatorSubmissionMedia = z.infer<
  typeof operatorSubmissionMediaSchema
>;
export type OperatorWorkSubmission = z.infer<
  typeof operatorWorkSubmissionSchema
>;
export type OperatorWorkSubmissionPage = z.infer<
  typeof operatorWorkSubmissionPageSchema
>;
export type WorkSubmissionModerationAction = z.infer<
  typeof workSubmissionModerationActionSchema
>;
export type ModerateWorkSubmissionCommand = z.infer<
  typeof moderateWorkSubmissionCommandSchema
>;
export type AdminModerateWorkSubmissionRequest = z.infer<
  typeof adminModerateWorkSubmissionRequestSchema
>;
export type WorkSubmissionModerationResult = z.infer<
  typeof workSubmissionModerationResultSchema
>;
export type AccountCapacityClass = z.infer<typeof accountCapacityClassSchema>;
export type OperatorAccountCapacity = z.infer<
  typeof operatorAccountCapacitySchema
>;
export type SetAccountCapacityClassCommand = z.infer<
  typeof setAccountCapacityClassCommandSchema
>;
export type AdminSetAccountCapacityClassRequest = z.infer<
  typeof adminSetAccountCapacityClassRequestSchema
>;
export type PublishingJobKind = z.infer<typeof publishingJobKindSchema>;
export type PublishingJobState = z.infer<typeof publishingJobStateSchema>;
export type OperatorPublishingJob = z.infer<typeof operatorPublishingJobSchema>;
export type OperatorPublishingJobQuery = z.infer<
  typeof operatorPublishingJobQuerySchema
>;
export type OperatorPublishingJobPage = z.infer<
  typeof operatorPublishingJobPageSchema
>;
export type PublishingJobAction = z.infer<typeof publishingJobActionSchema>;
export type AdminPublishingJobRequest = z.infer<
  typeof adminPublishingJobRequestSchema
>;
