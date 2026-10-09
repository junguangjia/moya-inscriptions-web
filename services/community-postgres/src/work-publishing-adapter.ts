import type { PublicationSyncOptions } from "./publishing/publication-sync.js";
import type {
  CreatePublishingDraftCommand,
  CreatePublishingSessionCommand,
  EditableWork,
  MediaComponentRole,
  MediaFailureCode,
  MediaVariant,
  OpenWorkEditDraftCommand,
  PublishingDraft,
  PublishingOpenedEditDraft,
  PublishingDraftDeletionCommand,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingMediaItem,
  PublishingPageQuery,
  PublishingSession,
  PublishingSnapshotPage,
  RegisterMediaItemCommand,
  ResolvePublishingConflictCommand,
  RestorePublishingSnapshotCommand,
  SavePublishingDraftCommand,
  WorkSubmissionCommand,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
  WorkVisibilityCommand,
  WorkVisibilityResult,
} from "@moya/contracts";
import type {
  OperatorAccountCapacity,
  WorkPublishingSettings,
} from "@moya/contracts/internal/community-operator";
import type {
  CatalogAssetSyncCounts,
  CatalogAssetSyncOptions,
  CatalogMediaAssetPort,
  CatalogMediaSource,
  CatalogRenderOutcome,
  CatalogRenderPlan,
  PublishingCleanupCounts,
  PublishingCommandIdentity,
  PublishingDerivativeCommit,
  PublishingDerivedOutcome,
  PublishingDraftDeletion,
  PublishingEditReadiness,
  PublishingEditReadinessOptions,
  PublishingEditTarget,
  PublishingItemChange,
  PublishingJobClaim,
  PublishingJobClaimOptions,
  PublishingJobEnqueue,
  PublishingJobEnqueued,
  PublishingJobFailure,
  PublishingJobFailureOptions,
  PublishingJobLease,
  PublishingMediaReadTarget,
  PublishingMediaWriteResult,
  PublishingProcessedOutcome,
  PublishingProcessingInput,
  PublishingPurgePlan,
  PublishingSessionDiscard,
  PublishingSessionExpiry,
  PublishingTrashPurge,
  PublishingUploadCommit,
  PublishingUploadFence,
  PublishingUploadStart,
  WorkPublishingPort,
} from "@moya/api";
import type { Pool } from "pg";

import * as sessions from "./publishing/sessions.js";
import * as drafts from "./publishing/drafts.js";
import * as media from "./publishing/media.js";
import * as uploads from "./publishing/uploads.js";
import * as jobs from "./publishing/jobs.js";
import * as submissions from "./publishing/submissions.js";
import * as works from "./publishing/works.js";
import * as mediaRead from "./publishing/media-read.js";
import * as catalogAssets from "./publishing/catalog-assets.js";

/**
 * Work publishing persistence on PostgreSQL, plus the Catalog media asset
 * state the same worker drives. Every method delegates to its
 * publishing/<area>.ts function with this adapter's pool.
 */
export class PostgresWorkPublishingAdapter
  implements WorkPublishingPort, CatalogMediaAssetPort
{
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly publication?: PublicationSyncOptions;
    } = {},
  ) {}

  createSession(
    actorId: string,
    command: CreatePublishingSessionCommand,
    now: Date,
  ): Promise<PublishingSession> {
    return sessions.createSession(this.pool, actorId, command, now);
  }
  heartbeatSession(
    actorId: string,
    sessionId: string,
    now: Date,
  ): Promise<PublishingSession> {
    return sessions.heartbeatSession(this.pool, actorId, sessionId, now);
  }
  discardSession(
    actorId: string,
    sessionId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingSessionDiscard> {
    return sessions.discardSession(this.pool, actorId, sessionId, command, now);
  }
  expireSession(
    sessionId: string,
    now: Date,
  ): Promise<PublishingSessionExpiry> {
    return sessions.expireSession(this.pool, sessionId, now);
  }
  createDraft(
    actorId: string,
    command: CreatePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraft> {
    return drafts.createDraft(this.pool, actorId, command, now);
  }
  saveDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraftSaveResult> {
    return drafts.saveDraft(this.pool, actorId, draftId, command, now);
  }
  snapshotDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraftSaveResult> {
    return drafts.snapshotDraft(this.pool, actorId, draftId, command, now);
  }
  listDrafts(
    actorId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingDraftPage> {
    return drafts.listDrafts(this.pool, actorId, query);
  }
  readDraft(actorId: string, draftId: string): Promise<PublishingDraft> {
    return drafts.readDraft(this.pool, actorId, draftId);
  }
  deleteDraft(
    actorId: string,
    draftId: string,
    command: PublishingDraftDeletionCommand,
    now: Date,
  ): Promise<PublishingDraftDeletion> {
    return drafts.deleteDraft(this.pool, actorId, draftId, command, now);
  }
  listHistory(
    actorId: string,
    draftId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingSnapshotPage> {
    return drafts.listHistory(this.pool, actorId, draftId, query);
  }
  restoreSnapshot(
    actorId: string,
    draftId: string,
    command: RestorePublishingSnapshotCommand,
    now: Date,
  ): Promise<PublishingDraft> {
    return drafts.restoreSnapshot(this.pool, actorId, draftId, command, now);
  }
  resolveConflict(
    actorId: string,
    draftId: string,
    command: ResolvePublishingConflictCommand,
    now: Date,
  ): Promise<PublishingDraft> {
    return drafts.resolveConflict(this.pool, actorId, draftId, command, now);
  }
  openEditDraft(
    actorId: string,
    workId: string,
    command: OpenWorkEditDraftCommand,
    now: Date,
  ): Promise<PublishingOpenedEditDraft> {
    return drafts.openEditDraft(this.pool, actorId, workId, command, now);
  }
  readSettings(): Promise<WorkPublishingSettings> {
    return media.readSettings(this.pool);
  }
  readCapacity(accountId: string): Promise<OperatorAccountCapacity> {
    return media.readCapacity(this.pool, accountId);
  }
  reconcileCapacity(
    accountId: string,
    now: Date,
  ): Promise<OperatorAccountCapacity> {
    return media.reconcileCapacity(this.pool, accountId, now);
  }
  unrecordedStorageKeys(
    storageKeys: readonly string[],
  ): Promise<readonly string[]> {
    return media.unrecordedStorageKeys(this.pool, storageKeys);
  }
  registerItem(
    actorId: string,
    command: RegisterMediaItemCommand,
    now: Date,
  ): Promise<PublishingMediaItem> {
    return media.registerItem(this.pool, actorId, command, now);
  }
  readItem(actorId: string, itemId: string): Promise<PublishingMediaItem> {
    return media.readItem(this.pool, actorId, itemId);
  }
  cancelItem(
    actorId: string,
    itemId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingItemChange> {
    return media.cancelItem(this.pool, actorId, itemId, command, now);
  }
  resetComponent(
    actorId: string,
    itemId: string,
    role: MediaComponentRole,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingItemChange> {
    return media.resetComponent(this.pool, actorId, itemId, role, command, now);
  }
  readProcessing(
    job: Pick<PublishingJobClaim, "kind" | "subjectId" | "payload">,
  ): Promise<PublishingProcessingInput | null> {
    return media.readProcessing(this.pool, job);
  }
  readLegacyMediaBytes(itemId: string): Promise<Uint8Array | null> {
    return media.readLegacyMediaBytes(this.pool, itemId);
  }
  markItemReady(
    itemId: string,
    outcome: PublishingProcessedOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit> {
    return media.markItemReady(this.pool, itemId, outcome, now);
  }
  recordDerivatives(
    itemId: string,
    outcome: PublishingDerivedOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit> {
    return media.recordDerivatives(this.pool, itemId, outcome, now);
  }
  markItemFailed(
    itemId: string,
    failureCode: MediaFailureCode,
    now: Date,
  ): Promise<void> {
    return media.markItemFailed(this.pool, itemId, failureCode, now);
  }
  ensureEditDerivatives(
    actorId: string,
    content: PublishingEditTarget,
    now: Date,
    options?: PublishingEditReadinessOptions,
  ): Promise<PublishingEditReadiness> {
    return media.ensureEditDerivatives(
      this.pool,
      actorId,
      content,
      now,
      options,
    );
  }
  beginComponentUpload(
    actorId: string,
    componentId: string,
    start: PublishingUploadStart,
    now: Date,
  ): Promise<PublishingUploadFence> {
    return uploads.beginComponentUpload(
      this.pool,
      actorId,
      componentId,
      start,
      now,
    );
  }
  commitComponentUpload(
    fence: PublishingUploadFence,
    blob: PublishingMediaWriteResult,
    now: Date,
  ): Promise<PublishingUploadCommit> {
    return uploads.commitComponentUpload(this.pool, fence, blob, now);
  }
  abortComponentUpload(fence: PublishingUploadFence, now: Date): Promise<void> {
    return uploads.abortComponentUpload(this.pool, fence, now);
  }
  claimJobs(
    options: PublishingJobClaimOptions,
    now: Date,
  ): Promise<readonly PublishingJobClaim[]> {
    return jobs.claimJobs(this.pool, options, now);
  }
  renewJobLease(
    lease: PublishingJobLease,
    leaseMs: number,
    now: Date,
  ): Promise<boolean> {
    return jobs.renewJobLease(this.pool, lease, leaseMs, now);
  }
  completeJob(lease: PublishingJobLease, now: Date): Promise<boolean> {
    return jobs.completeJob(this.pool, lease, now);
  }
  releaseJob(lease: PublishingJobLease, now: Date): Promise<boolean> {
    return jobs.releaseJob(this.pool, lease, now);
  }
  deferJob(
    lease: PublishingJobLease,
    delayMs: number,
    now: Date,
  ): Promise<boolean> {
    return jobs.deferJob(this.pool, lease, delayMs, now);
  }
  failJob(
    lease: PublishingJobLease,
    errorCode: string,
    now: Date,
    options?: PublishingJobFailureOptions,
  ): Promise<PublishingJobFailure> {
    return jobs.failJob(this.pool, lease, errorCode, now, options);
  }
  requeueExpiredJobs(now: Date, limit: number): Promise<number> {
    return jobs.requeueExpiredJobs(this.pool, now, limit);
  }
  enqueueJob(
    job: PublishingJobEnqueue,
    now: Date,
  ): Promise<PublishingJobEnqueued> {
    return jobs.enqueueJob(this.pool, job, now);
  }
  scheduleCleanup(now: Date, limit: number): Promise<PublishingCleanupCounts> {
    return jobs.scheduleCleanup(this.pool, now, limit);
  }
  purgeItem(itemId: string, now: Date): Promise<PublishingPurgePlan> {
    return jobs.purgeItem(this.pool, itemId, now);
  }
  purgeBlob(blobId: string, now: Date): Promise<PublishingPurgePlan> {
    return jobs.purgeBlob(this.pool, blobId, now);
  }
  confirmPurged(blobIds: readonly string[], now: Date): Promise<void> {
    return jobs.confirmPurged(this.pool, blobIds, now);
  }
  submit(
    actorId: string,
    command: WorkSubmissionCommand,
    now: Date,
  ): Promise<WorkSubmissionResult> {
    return submissions.submit(
      this.pool,
      actorId,
      command,
      now,
      this.options.publication,
    );
  }
  readSubmissionReceipt(
    actorId: string,
    requestId: string,
  ): Promise<WorkSubmissionReceipt | null> {
    return submissions.readSubmissionReceipt(this.pool, actorId, requestId);
  }
  readEditableWork(actorId: string, workId: string): Promise<EditableWork> {
    return works.readEditableWork(this.pool, actorId, workId);
  }
  setVisibility(
    actorId: string,
    workId: string,
    command: WorkVisibilityCommand,
    now: Date,
  ): Promise<WorkVisibilityResult> {
    return works.setVisibility(
      this.pool,
      actorId,
      workId,
      command,
      now,
      this.options.publication,
    );
  }
  deleteWork(
    actorId: string,
    workId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<{ readonly deleted: true }> {
    return works.deleteWork(
      this.pool,
      actorId,
      workId,
      command,
      now,
      this.options.publication,
    );
  }
  purgeTrashedWork(workId: string, now: Date): Promise<PublishingTrashPurge> {
    return works.purgeTrashedWork(
      this.pool,
      workId,
      now,
      this.options.publication,
    );
  }
  resolveMediaRead(
    viewerId: string | null,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
  ): Promise<PublishingMediaReadTarget | null> {
    return mediaRead.resolveMediaRead(
      this.pool,
      viewerId,
      itemId,
      variant,
      editKey,
    );
  }
  syncCatalogAssets(
    sources: readonly CatalogMediaSource[],
    now: Date,
    options: CatalogAssetSyncOptions,
  ): Promise<CatalogAssetSyncCounts> {
    return catalogAssets.syncCatalogAssets(this.pool, sources, now, options);
  }
  readCatalogRenderPlan(assetId: string): Promise<CatalogRenderPlan | null> {
    return catalogAssets.readCatalogRenderPlan(this.pool, assetId);
  }
  recordCatalogRenditions(
    assetId: string,
    outcome: CatalogRenderOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit> {
    return catalogAssets.recordCatalogRenditions(
      this.pool,
      assetId,
      outcome,
      now,
    );
  }
  failCatalogAsset(
    assetId: string,
    failureCode: string,
    now: Date,
  ): Promise<void> {
    return catalogAssets.failCatalogAsset(this.pool, assetId, failureCode, now);
  }
}
