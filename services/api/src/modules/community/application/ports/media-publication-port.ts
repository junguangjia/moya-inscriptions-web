import type { PublishingJobLease } from "./work-publishing-port.js";

/** Backend-only immutable publication facts; never a Public DTO. */
export interface MediaPublicationUnit {
  readonly id: string;
  readonly assetId: string;
  readonly renditionId: string | null;
  readonly objectKey: string;
  readonly storageKey: string;
  readonly contentType: "image/webp" | "image/jpeg" | "video/mp4";
  readonly purpose: "derivative" | "catalog_derivative";
  readonly byteSize: number;
  readonly sha256: string;
  readonly role: string;
  readonly editKey: string;
  readonly purgeTaskIds: readonly string[];
  readonly withdrawRequestedAt: Date | null;
  readonly purgeAttempts: number;
  readonly sweepTaskIds: readonly string[];
  readonly sweepStartedAt: Date | null;
  readonly sweepAttempts: number;
  /** When a withdrawal deleted the origin object; null before. */
  readonly originDeletedAt?: Date | null;
  /** The forced edge TTL a deferred block withdrawal waits for; null otherwise. */
  readonly fallbackTtlSeconds?: number | null;
}

export interface MediaPublicationFence {
  readonly assetId: string;
  readonly sequence: string;
  readonly job: PublishingJobLease;
  readonly intent: "publish" | "withdraw";
  readonly unitIds: readonly string[];
}

export type MediaPublicationPlan =
  | {
      readonly status: "ready";
      readonly fence: MediaPublicationFence;
      readonly units: readonly MediaPublicationUnit[];
    }
  | { readonly status: "busy" | "disabled" | "missing" };

export interface MediaPublicationPort {
  /** Includes historical generations, so cleanup remains active in Beta/off. */
  hasRegisteredPublications(): Promise<boolean>;
  planPublish(
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
  ): Promise<MediaPublicationPlan>;
  planWithdrawal(
    subjectId: string,
    job: PublishingJobLease,
    now: Date,
  ): Promise<MediaPublicationPlan>;
  /** Renews an asset lease only while the queue lease and desired sequence still match. */
  isCurrent(fence: MediaPublicationFence, now: Date): Promise<boolean>;
  finishPublish(fence: MediaPublicationFence, now: Date): Promise<boolean>;
  recordOriginDeleted(
    fence: MediaPublicationFence,
    unitIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  recordPurge(
    fence: MediaPublicationFence,
    unitIds: readonly string[],
    taskIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  finishWithdrawal(
    fence: MediaPublicationFence,
    unitIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  failPurge(
    fence: MediaPublicationFence,
    unitIds: readonly string[],
    errorCode: string,
    now: Date,
  ): Promise<boolean>;
  /**
   * Catalog block URLs (role `block-NN`) submitted for purge since `since`:
   * the daily block purge budget's use (catalog-deep-zoom-v1).
   */
  blockPurgesSince(since: Date): Promise<number>;
  /**
   * Puts withdrawing block units whose origin object is deleted on the TTL
   * path: their purge tasks are dropped, `fallbackTtlSeconds` is recorded and
   * the group finishes once that TTL has passed (catalog-deep-zoom-v1).
   */
  deferBlockWithdrawal(
    fence: MediaPublicationFence,
    unitIds: readonly string[],
    ttlSeconds: number,
    now: Date,
  ): Promise<boolean>;
  release(fence: MediaPublicationFence, now: Date): Promise<void>;
  reconcile(
    now: Date,
    allowPublish: boolean,
    limit: number,
  ): Promise<{ readonly publish: number; readonly withdraw: number }>;
  /** Registered, never-reused historical keys only; marks sweep intent before I/O. */
  sweepCandidates(
    now: Date,
    limit: number,
  ): Promise<readonly MediaPublicationUnit[]>;
  recordSweepPurge(
    unitIds: readonly string[],
    taskIds: readonly string[],
    now: Date,
  ): Promise<void>;
  recordSweepFailure(
    unitIds: readonly string[],
    errorCode: string,
    now: Date,
  ): Promise<void>;
  recordSweep(unitIds: readonly string[], now: Date): Promise<void>;
  recordRequestUsage(
    usage: {
      readonly start: Date;
      readonly end: Date;
      readonly requests: number;
      readonly warning: boolean;
    },
    now: Date,
  ): Promise<void>;
  /**
   * catalog-deep-zoom-v1: stores the image host's day-to-date counts on the
   * usage row (its day columns only). False when the row does not exist yet.
   */
  recordDayUsage(
    usage: {
      readonly dayStart: Date;
      readonly requests: number;
      readonly bytes: number | null;
    },
    now: Date,
  ): Promise<boolean>;
  /** catalog-deep-zoom-v1: the stored day-to-date counts, or null. */
  readDayUsage(): Promise<{
    readonly dayStart: Date;
    readonly requests: number;
    readonly bytes: number | null;
    readonly observedAt: Date;
  } | null>;
  /** Keys are existing same-origin item/role/edit paths; values stay Backend-only until URL resolution. */
  lookupPublishedItems(
    itemIds: readonly string[],
    now: Date,
  ): Promise<ReadonlyMap<string, string>>;
  lookupPublishedCatalog(
    renditionIds: readonly string[],
    now: Date,
  ): Promise<ReadonlyMap<string, string>>;
}
