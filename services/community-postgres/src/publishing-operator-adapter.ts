import type { PublicationSyncOptions } from "./publishing/publication-sync.js";
import type { MediaVariant } from "@moya/contracts";
import type {
  ModerateWorkSubmissionCommand,
  OperatorAccountCapacity,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorPublishingJobQuery,
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
  PublishingOperatorPort,
} from "@moya/api";
import type { Pool } from "pg";

import * as operations from "./publishing/operator.js";

/**
 * Work publishing operator persistence on PostgreSQL; every method delegates
 * to publishing/operator.ts with this adapter's pool.
 */
export class PostgresPublishingOperatorAdapter implements PublishingOperatorPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly publication?: PublicationSyncOptions;
    } = {},
  ) {}

  readSettings(): Promise<WorkPublishingSettings> {
    return operations.readSettings(this.pool);
  }
  setSettings(
    operator: string,
    command: SetWorkPublishingSettingsCommand,
    now: Date,
  ): Promise<WorkPublishingSettings> {
    return operations.setSettings(this.pool, operator, command, now);
  }
  listSubmissions(
    query: OperatorWorkSubmissionQuery,
  ): Promise<OperatorWorkSubmissionPage> {
    return operations.listSubmissions(this.pool, query);
  }
  readSubmission(revisionId: string): Promise<OperatorWorkSubmission> {
    return operations.readSubmission(this.pool, revisionId);
  }
  moderateSubmission(
    revisionId: string,
    operator: string,
    command: ModerateWorkSubmissionCommand,
    now: Date,
  ): Promise<WorkSubmissionModerationResult> {
    return operations.moderateSubmission(
      this.pool,
      revisionId,
      operator,
      command,
      now,
      this.options.publication,
    );
  }
  resolveMediaRead(
    revisionId: string,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
  ): ReturnType<PublishingOperatorPort["resolveMediaRead"]> {
    return operations.resolveMediaRead(
      this.pool,
      revisionId,
      itemId,
      variant,
      editKey,
    );
  }
  readCapacity(accountId: string): Promise<OperatorAccountCapacity> {
    return operations.readCapacity(this.pool, accountId);
  }
  setCapacity(
    accountId: string,
    operator: string,
    command: SetAccountCapacityClassCommand,
    now: Date,
  ): Promise<OperatorAccountCapacity> {
    return operations.setCapacity(this.pool, accountId, operator, command, now);
  }
  listJobs(
    query: OperatorPublishingJobQuery,
  ): Promise<OperatorPublishingJobPage> {
    return operations.listJobs(this.pool, query);
  }
  retryJob(
    jobId: string,
    operator: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<OperatorPublishingJob> {
    return operations.retryJob(this.pool, jobId, operator, command, now);
  }
  abandonJob(
    jobId: string,
    operator: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<OperatorPublishingJob> {
    return operations.abandonJob(this.pool, jobId, operator, command, now);
  }
}
