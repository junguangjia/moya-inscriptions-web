import type { MediaVariant } from "@moya/contracts";
import type {
  ModerateWorkSubmissionCommand,
  OperatorAccountCapacity,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorPublishingJobQuery,
  OperatorReadScope,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  OperatorWorkSubmissionQuery,
  SetAccountCapacityClassCommand,
  SetWorkPublishingSettingsCommand,
  WorkPublishingSettings,
  WorkSubmissionModerationResult,
} from "@moya/contracts/internal/community-operator";

import type {
  PublishingCommandIdentity,
  PublishingMediaReadTarget,
} from "./work-publishing-port.js";

/**
 * Owner operator persistence for work publishing (design.md §3.3, §5, §10):
 * the independent work publication policy and limits, the explicit
 * submission queue, account capacity designation and content-free job
 * outcomes. Never reachable from Public routes.
 *
 * `operator` is the server-fixed operator label. Every command runs in one
 * transaction serialized with the other content operator commands, checks
 * `content_operator_receipts` (same request and fingerprint returns the stored
 * result; a different fingerprint throws `CommunityConflictError`), applies
 * the change and writes one `content_operator_events` row and the receipt.
 * `now` is the injected clock for every stored time. An unknown subject throws
 * `CommunityNotFoundError`; a stale `expectedVersion` or a subject in another
 * state throws `CommunityConflictError`, changing and recording nothing.
 */
export interface PublishingOperatorPort {
  /** The settings row; a stored item maximum above 100 reads as 100. */
  readSettings(): Promise<WorkPublishingSettings>;
  /**
   * Replaces the policy and every limit when `expectedVersion` matches; the
   * version increases and `updatedBy` becomes `operator`. Prospective only:
   * existing revisions keep their dispositions. An item maximum outside
   * 1..100 throws `CommunityInputError` (storage alone admits up to 500).
   */
  setSettings(
    operator: string,
    command: SetWorkPublishingSettingsCommand,
    now: Date,
  ): Promise<WorkPublishingSettings>;
  /**
   * Explicit submissions that requested public visibility (self-only
   * `not_required` revisions never appear), oldest pending first when
   * filtered by `pending`, otherwise newest first.
   */
  listSubmissions(
    query: OperatorWorkSubmissionQuery,
    scope?: OperatorReadScope,
  ): Promise<OperatorWorkSubmissionPage>;
  /**
   * One queue-visible revision; a `not_required` revision is not found. Its
   * cover item names `coverEditKey` (`community.media_edit_key(edit,
   * cover_crop)`, the key of its thumb and cover); other items name null.
   */
  readSubmission(revisionId: string): Promise<OperatorWorkSubmission>;
  /**
   * Approves or rejects the work's latest explicit submission (P08). Only a
   * `pending` revision that is still the work's author revision, whose version
   * equals `expectedVersion` and whose work is neither trashed nor deleted can
   * change; anything else is a conflict. Approve applies the public revision,
   * visibility, first publication time, edited time and the denormalized
   * public text as a direct publication would; reject keeps the previous public
   * revision.
   */
  moderateSubmission(
    revisionId: string,
    operator: string,
    command: ModerateWorkSubmissionCommand,
    now: Date,
  ): Promise<WorkSubmissionModerationResult>;
  /**
   * A derivative of an item that belongs to this queue-visible revision, for
   * the Admin media proxy; `null` otherwise. An unedited legacy display may
   * return its existing user-media PNG. Publishing originals/masters never do.
   */
  resolveMediaRead(
    revisionId: string,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
  ): Promise<
    | PublishingMediaReadTarget
    | { readonly legacyPng: Uint8Array; readonly sha256: string }
    | null
  >;
  /**
   * The account's capacity; an account without a capacity row reads as
   * ordinary with zero counters, version 0 and `updatedAt` null.
   */
  readCapacity(accountId: string): Promise<OperatorAccountCapacity>;
  /**
   * Designates the capacity class on the immutable account id when
   * `expectedVersion` matches (version 0 creates the row). Counters are
   * untouched.
   */
  setCapacity(
    accountId: string,
    operator: string,
    command: SetAccountCapacityClassCommand,
    now: Date,
  ): Promise<OperatorAccountCapacity>;
  /** Content-free jobs, most recently changed first. */
  listJobs(
    query: OperatorPublishingJobQuery,
  ): Promise<OperatorPublishingJobPage>;
  /**
   * A `failed` or `abandoned` job is queued again at `now` with attempts reset
   * (an equal active job is a conflict). A `process_item` job whose item was
   * already failed (its attempts ran out, or it was abandoned) finds nothing
   * to process and completes without work: the author retries by resetting a
   * component.
   */
  retryJob(
    jobId: string,
    operator: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<OperatorPublishingJob>;
  /**
   * A `queued` or `failed` job becomes `abandoned` with `finished_at` = `now`.
   * Abandoning a `process_item` job also fails its still-processing item
   * (`processing_failed`, open reservations released) in the same
   * transaction, so the item never stays processing without a job.
   */
  abandonJob(
    jobId: string,
    operator: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<OperatorPublishingJob>;
}
