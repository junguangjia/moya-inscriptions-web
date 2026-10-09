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
