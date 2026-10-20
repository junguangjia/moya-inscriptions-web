import { createHash } from "node:crypto";

import { publishedObjectUrl, validatePublishedKey } from "./keys.js";

import type {
  PublishingJobHandlers,
  PublishingJobResult,
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
  PublishingWorkerJobLease,
  PublishingWorkerLogger,
  PublishingWorkerPort,
} from "../publishing/job-handlers.js";
import type { PublishingWorkerExtraStep } from "../publishing/worker.js";
import type {
  PublicationProvider,
  PublishedObjectEvidence,
} from "./provider.js";

/** Structural mirror of the application publication port. No private keys leave it. */
export interface PublicationUnit {
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
  readonly sweepAttempts: number;
  readonly sweepStartedAt: Date | null;
  /** When a withdrawal deleted the origin object; null before. */
  readonly originDeletedAt?: Date | null;
  /** The forced edge TTL a deferred block withdrawal waits for; null otherwise. */
  readonly fallbackTtlSeconds?: number | null;
}

export interface PublicationFence {
  readonly assetId: string;
  readonly sequence: string;
  readonly job: PublishingWorkerJobLease;
  readonly intent: "publish" | "withdraw";
  readonly unitIds: readonly string[];
}

export type PublicationPlan =
  | {
      readonly status: "ready";
      readonly fence: PublicationFence;
      readonly units: readonly PublicationUnit[];
    }
  | { readonly status: "busy" | "disabled" | "missing" };

export interface PublicationRepository {
  hasRegisteredPublications(): Promise<boolean>;
  planPublish(
    subjectId: string,
    job: PublishingWorkerJobLease,
    now: Date,
  ): Promise<PublicationPlan>;
  planWithdrawal(
    subjectId: string,
    job: PublishingWorkerJobLease,
    now: Date,
  ): Promise<PublicationPlan>;
  isCurrent(fence: PublicationFence, now: Date): Promise<boolean>;
  finishPublish(fence: PublicationFence, now: Date): Promise<boolean>;
  recordOriginDeleted(
    fence: PublicationFence,
    unitIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  recordPurge(
    fence: PublicationFence,
    unitIds: readonly string[],
    taskIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  finishWithdrawal(
    fence: PublicationFence,
    unitIds: readonly string[],
    now: Date,
  ): Promise<boolean>;
  failPurge(
    fence: PublicationFence,
    unitIds: readonly string[],
    errorCode: string,
    now: Date,
  ): Promise<boolean>;
  /** Block URLs submitted for purge since `since` (the daily block budget). */
  blockPurgesSince(since: Date): Promise<number>;
  /**
   * Puts withdrawing block units whose origin object is deleted on the TTL
   * path: no purge, gone from warmed edges within `ttlSeconds`.
   */
  deferBlockWithdrawal(
    fence: PublicationFence,
    unitIds: readonly string[],
    ttlSeconds: number,
    now: Date,
  ): Promise<boolean>;
  release(fence: PublicationFence, now: Date): Promise<void>;
  reconcile(
    now: Date,
    allowPublish: boolean,
    limit: number,
  ): Promise<{ readonly publish: number; readonly withdraw: number }>;
  sweepCandidates(
    now: Date,
    limit: number,
  ): Promise<readonly PublicationUnit[]>;
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
  /** catalog-deep-zoom-v1: today's counts on the usage row; false without one. */
  recordDayUsage(
    usage: {
      readonly dayStart: Date;
      readonly requests: number;
      readonly bytes: number | null;
    },
    now: Date,
  ): Promise<boolean>;
}

/** Existing private rendition store; publication never calls its remove method. */
export interface PublicationSource {
  openRead(storageKey: string): Promise<
    | {
        readonly status: "ok";
        readonly byteSize: number;
        readonly contentLength: number;
        readonly body: AsyncIterable<Uint8Array>;
        close(): Promise<void>;
      }
    | { readonly status: "range_not_satisfiable"; readonly byteSize: number }
    | null
  >;
}

export interface PublicationJobHandlerOptions {
  readonly port: PublicationRepository;
  readonly queue: Pick<PublishingWorkerPort, "enqueueJob">;
  readonly source: PublicationSource;
  /** Unconfigured default-off deployments have no provider or public origin. */
  readonly provider?: PublicationProvider;
  readonly origin?: string;
  /** Product public mode AND MEDIA_PUBLICATION=on. Rechecked during copying. */
  readonly allowPublish: () => boolean;
  readonly clock?: () => Date;
  readonly logger?: PublishingWorkerLogger;
  readonly limit?: number;
  /** Block URL purges per quota day; defaults to the recorded budget. */
  readonly blockPurgeBudget?: number;
  /** The image host's forced edge TTL; defaults to the recorded value. */
  readonly blockFallbackTtlSeconds?: number;
}

export const PUBLICATION_WITHDRAW_JOB_KINDS = [
  "withdraw_media",
  "verify_withdrawal",
  "reconcile_publication",
] as const satisfies readonly PublishingWorkerJobKind[];
export const PUBLICATION_PUBLISH_JOB_KINDS = [
  "publish_media",
  "sweep_published",
] as const satisfies readonly PublishingWorkerJobKind[];
export const PUBLICATION_WITHDRAW_LEASE_MS = 120_000;
export const PUBLICATION_PUBLISH_LEASE_MS = 300_000;
export const PUBLICATION_RECONCILE_SUBJECT = "publication";
export const PUBLICATION_SWEEP_SUBJECT = "published-bucket";
export const PUBLICATION_RECONCILE_INTERVAL_MS = 60_000;
export const PUBLICATION_SWEEP_INTERVAL_MS = 3_600_000;
export const PUBLICATION_USAGE_INTERVAL_MS = 86_400_000;
export const PUBLICATION_EDGE_FALLBACK_TTL_SECONDS = 3_600;
/**
 * Block URL purges per purge-quota day (catalog-deep-zoom-v1, OD-4): 25 % of
 * the zone's daily `purge_url` quota as read at P0, and 0 while no figure is
 * recorded. Every block withdrawal beyond it takes the TTL path: the origin
 * object is deleted and warmed edges drop it within the forced edge TTL.
 */
export const CATALOG_BLOCK_PURGE_BUDGET_PER_DAY = 0;

/** The purge quota's day: from 00:00 Asia/Shanghai (UTC+8), until P0 says otherwise. */
export const purgeQuotaDayStart = (now: Date): Date => {
  const shanghai = 8 * 60 * 60 * 1_000;
  const day = 24 * 60 * 60 * 1_000;
  return new Date(
    Math.floor((now.getTime() + shanghai) / day) * day - shanghai,
  );
};

/**
 * The image host's day-to-date usage that the Catalog deep-zoom breaker reads
 * (catalog-deep-zoom-v1): written by the worker's usage step every 15
 * minutes, evaluated by the Backend.
 */
export interface CatalogZoomDayUsage {
  /** The cap's day the counts belong to (from 00:00 Asia/Shanghai). */
  readonly dayStart: Date;
  readonly requests: number;
  /** Bytes the cap counts; null when the provider reports no traffic figure. */
  readonly bytes: number | null;
  readonly observedAt: Date;
}

/**
 * The breaker's thresholds (planned; P0 item 7 settles them): a warning line
 * at 100,000 requests or 3 GB, a trip at 150,000 requests or 5 GB. A trip
 * hides the Detail `zoom` frame and answers 404 on the block-list read until
 * the cap's next day. GB is 10^9 bytes, the lower reading of the cap.
 */
export const CATALOG_ZOOM_USAGE_LIMITS = {
  warningRequests: 100_000,
  warningBytes: 3_000_000_000,
  tripRequests: 150_000,
  tripBytes: 5_000_000_000,
  /** An observation older than this counts as missing. */
  staleMs: 60 * 60 * 1_000,
} as const;

/** The worker's day usage step interval (96 provider reads a day). */
export const CATALOG_ZOOM_USAGE_INTERVAL_MS = 15 * 60 * 1_000;

/** Whether today's counts reach a threshold of the given level. */
export const catalogZoomUsageAt = (
  usage: Pick<CatalogZoomDayUsage, "requests" | "bytes">,
  level: "warning" | "trip",
): boolean => {
  const limits = CATALOG_ZOOM_USAGE_LIMITS;
  const requests =
    level === "warning" ? limits.warningRequests : limits.tripRequests;
  const bytes = level === "warning" ? limits.warningBytes : limits.tripBytes;
  return usage.requests >= requests || (usage.bytes ?? 0) >= bytes;
};

/**
 * The breaker (catalog-deep-zoom-v1): with edge delivery on, a missing row
 * for today or an observation older than an hour counts as tripped (fail
 * closed); with edge delivery off (Development's relay) only a row for today
 * that reaches a trip threshold trips it, and a missing row leaves it closed.
 */
export const catalogZoomBreakerTripped = (
  usage: CatalogZoomDayUsage | null,
  now: Date,
  edgeDelivery: boolean,
): boolean => {
  if (
    usage === null ||
    usage.dayStart.getTime() !== purgeQuotaDayStart(now).getTime()
  )
    return edgeDelivery;
  const stale =
    now.getTime() - usage.observedAt.getTime() >
    CATALOG_ZOOM_USAGE_LIMITS.staleMs;
  if (edgeDelivery && stale) return true;
  return catalogZoomUsageAt(usage, "trip");
};

/** How long the Backend keeps one usage read for the breaker. */
export const CATALOG_ZOOM_USAGE_CACHE_MS = 60_000;

/**
 * The Backend's deep-zoom gate (catalog-deep-zoom-v1): open only where blocks
 * can be delivered (edge delivery, or the Development relay) and while the
 * breaker is closed. The usage row is read at most once a minute; a failed
 * read counts as missing (tripped with edge delivery, closed without).
 */
export const createCatalogZoomGate = (options: {
  readonly readUsage: () => Promise<CatalogZoomDayUsage | null>;
  readonly edgeDelivery: () => boolean;
  readonly development: boolean;
  readonly clock?: () => Date;
  readonly logger?: { error(message: string): void };
}): { isOpen(): Promise<boolean> } => {
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? console;
  let cached: {
    readonly at: number;
    readonly usage: Promise<CatalogZoomDayUsage | null>;
  } | null = null;
  const usage = (now: Date) => {
    if (
      cached === null ||
      now.getTime() - cached.at >= CATALOG_ZOOM_USAGE_CACHE_MS
    )
      cached = {
        at: now.getTime(),
        usage: options.readUsage().catch(() => {
          logger.error("[catalog-zoom] usage_unavailable");
          return null;
        }),
      };
    return cached.usage;
  };
  return {
    async isOpen() {
      const edge = options.edgeDelivery();
      if (!edge && !options.development) return false;
      const now = clock();
      return !catalogZoomBreakerTripped(await usage(now), now, edge);
    },
  };
};

const BLOCK_ROLE = /^block-[0-9]{2}$/u;
/** A Catalog block publication (catalog-deep-zoom-v1). */
export const isBlockUnit = (unit: Pick<PublicationUnit, "role">): boolean =>
  BLOCK_ROLE.test(unit.role);

const MAX_PURGE_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 10_000;
const VERIFY_POLL_MS = 30_000;
const MAX_WITHDRAWAL_WAIT_MS = 10 * 60_000;
const MAX_UNITS = 500;
const PURGE_BATCH_SIZE = 100;
/** A deferred block group finishes this long after its TTL elapsed. */
const BLOCK_TTL_MARGIN_MS = 5 * 60_000;
/** The queue's longest deferral. */
const MAX_DEFER_MS = 300_000;
const STREAM_FENCE_BYTES = 1024 * 1024;
const STREAM_FENCE_MS = 1_000;
const SHA256 = /^[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const NULL_LOGGER: PublishingWorkerLogger = { info: () => {}, error: () => {} };
const COMPLETE: PublishingJobResult = { status: "completed" };
const deferred = (delayMs = 2_000): PublishingJobResult => ({
  status: "deferred",
  delayMs,
});
const failed = (errorCode: string, retryable = false): PublishingJobResult => ({
  status: "failed",
  errorCode,
  retryable,
});

/** No raw provider, object key, source key or content enters a job error. */
export class MediaPublicationJobError extends Error {
  constructor(
    readonly code: "integrity" | "lease_lost" | "provider_unavailable",
  ) {
    super("Media publication operation failed");
    this.name = "MediaPublicationJobError";
  }
}

const throwAborted = (signal: AbortSignal) => {
  if (signal.aborted)
    throw signal.reason ?? new MediaPublicationJobError("lease_lost");
};

const etagMd5 = (etag: string | undefined): string | null => {
  const value = etag?.replace(/^"|"$/g, "").toLowerCase();
  return value && MD5.test(value) ? value : null;
};

const verifyEvidence = (
  evidence: PublishedObjectEvidence | undefined,
  unit: PublicationUnit,
  md5: string,
) => {
  if (
    !evidence ||
    evidence.byteSize !== unit.byteSize ||
    etagMd5(evidence.etag) !== md5
  ) {
    throw new MediaPublicationJobError("integrity");
  }
};

const providerCode = (
  error: unknown,
): "purge_quota_exhausted" | "purge_failed" =>
  error instanceof Error && "code" in error && error.code === "quota"
    ? "purge_quota_exhausted"
    : "purge_failed";

const ids = (units: readonly PublicationUnit[]) => units.map((unit) => unit.id);
const uniqueTasks = (units: readonly PublicationUnit[]) => [
  ...new Set(units.flatMap((unit) => unit.purgeTaskIds)),
];
const attempts = (units: readonly PublicationUnit[]) =>
  Math.max(0, ...units.map((unit) => unit.purgeAttempts));
const earliestRequestedAt = (units: readonly PublicationUnit[], now: Date) =>
  Math.min(
    now.getTime(),
    ...units.flatMap((unit) =>
      unit.withdrawRequestedAt ? [unit.withdrawRequestedAt.getTime()] : [],
    ),
  );

/** Creates handlers shared by the two publication lanes in the existing queue. */
export function createPublicationJobHandlers(
  options: PublicationJobHandlerOptions,
): PublishingJobHandlers {
  const { port, source, queue, provider, origin, allowPublish } = options;
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? NULL_LOGGER;
  const limit = options.limit ?? MAX_UNITS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_UNITS) {
    throw new Error("Media publication batch limit is invalid");
  }

  const configuredProvider = () => {
    if (!provider || !origin)
      throw new MediaPublicationJobError("provider_unavailable");
    return { provider, origin };
  };

  const current = async (fence: PublicationFence, signal: AbortSignal) => {
    throwAborted(signal);
    if (fence.intent === "publish" && !allowPublish()) return false;
    return port.isCurrent(fence, clock());
  };

  const copy = async (
    unit: PublicationUnit,
    fence: PublicationFence,
    signal: AbortSignal,
  ): Promise<void> => {
    validatePublishedKey(unit.objectKey);
    if (
      (unit.purpose !== "derivative" &&
        unit.purpose !== "catalog_derivative") ||
      !["image/webp", "image/jpeg", "video/mp4"].includes(unit.contentType) ||
      !SHA256.test(unit.sha256) ||
      !Number.isSafeInteger(unit.byteSize) ||
      unit.byteSize < 1
    ) {
      throw new MediaPublicationJobError("integrity");
    }
    if (!(await current(fence, signal)))
      throw new MediaPublicationJobError("lease_lost");
    const { provider: destination } = configuredProvider();
    const existing = await destination.head(unit.objectKey, signal);
    if (!(await current(fence, signal)))
      throw new MediaPublicationJobError("lease_lost");
    const read = await source.openRead(unit.storageKey);
    if (
      !read ||
      read.status !== "ok" ||
      read.byteSize !== unit.byteSize ||
      read.contentLength !== unit.byteSize
    ) {
      if (read?.status === "ok") await read.close();
      throw new MediaPublicationJobError("integrity");
    }
    const sha256 = createHash("sha256");
    const md5 = createHash("md5");
    let seen = 0;
    let checkedBytes = 0;
    let checkedAt = clock().getTime();
    let finished = false;
    const abortRead = () => {
      void read.close().catch(() => {});
    };
    signal.addEventListener("abort", abortRead, { once: true });
    const guardedSource = (async function* () {
      throwAborted(signal);
      for await (const chunk of read.body) {
        throwAborted(signal);
        if (
          !(chunk instanceof Uint8Array) ||
          seen + chunk.byteLength > unit.byteSize
        ) {
          throw new MediaPublicationJobError("integrity");
        }
        const now = clock().getTime();
        if (
          seen - checkedBytes >= STREAM_FENCE_BYTES ||
          now - checkedAt >= STREAM_FENCE_MS
        ) {
          if (!(await current(fence, signal)))
            throw new MediaPublicationJobError("lease_lost");
          checkedAt = now;
          checkedBytes = seen;
        }
        seen += chunk.byteLength;
        sha256.update(chunk);
        md5.update(chunk);
        yield chunk;
      }
      if (seen !== unit.byteSize || sha256.digest("hex") !== unit.sha256) {
        throw new MediaPublicationJobError("integrity");
      }
      if (!(await current(fence, signal)))
        throw new MediaPublicationJobError("lease_lost");
      finished = true;
    })();
    try {
      let written: PublishedObjectEvidence | undefined;
      if (existing) {
        // Never trust length alone on restart: compare this immutable object's
        // MD5 with a full, SHA-validated read of the private ready rendition.
        for await (const chunk of guardedSource) void chunk;
      } else {
        written = await destination.write(unit, guardedSource, signal);
      }
      if (!finished || !(await current(fence, signal))) {
        throw new MediaPublicationJobError("lease_lost");
      }
      const digest = md5.digest("hex");
      verifyEvidence(existing ?? written, unit, digest);
      const head = await destination.head(unit.objectKey, signal);
      verifyEvidence(head, unit, digest);
      const first = existing ?? written;
      if (first?.crc64 && head?.crc64 && first.crc64 !== head.crc64) {
        throw new MediaPublicationJobError("integrity");
      }
      if (!(await current(fence, signal)))
        throw new MediaPublicationJobError("lease_lost");
    } finally {
      signal.removeEventListener("abort", abortRead);
      await read.close();
    }
  };

  const publish = async (
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ) => {
    // Gate before even planning a public row or invoking a lazy credential provider.
    if (!allowPublish()) return COMPLETE;
    const plan = await port.planPublish(claim.subjectId, claim, clock());
    if (plan.status !== "ready")
      return plan.status === "busy" ? deferred() : COMPLETE;
    try {
      for (const unit of plan.units) {
        if (!(await current(plan.fence, signal))) return deferred();
        await copy(unit, plan.fence, signal);
      }
      throwAborted(signal);
      if (!allowPublish() || !(await port.finishPublish(plan.fence, clock())))
        return deferred();
      logger.info(`publication.publish completed count=${plan.units.length}`);
      return COMPLETE;
    } catch (error) {
      // Provider boundaries intentionally replace source errors with content-free
      // provider errors. A sequence/mode change must still defer without charging
      // a queue attempt even when that boundary sanitised our stream exception.
      if (
        !signal.aborted &&
        (!allowPublish() || !(await port.isCurrent(plan.fence, clock())))
      ) {
        return deferred();
      }
      if (
        error instanceof MediaPublicationJobError &&
        error.code === "lease_lost" &&
        !signal.aborted
      ) {
        return deferred();
      }
      throw error;
    } finally {
      await port.release(plan.fence, clock());
    }
  };

  const blockBudget =
    options.blockPurgeBudget ?? CATALOG_BLOCK_PURGE_BUDGET_PER_DAY;
  const blockTtlSeconds =
    options.blockFallbackTtlSeconds ?? PUBLICATION_EDGE_FALLBACK_TTL_SECONDS;
  if (
    !Number.isSafeInteger(blockBudget) ||
    blockBudget < 0 ||
    !Number.isSafeInteger(blockTtlSeconds) ||
    blockTtlSeconds < 60 ||
    blockTtlSeconds > 86_400
  ) {
    throw new Error("Media publication block withdrawal options are invalid");
  }

  const alert = (errorCode: string) =>
    logger.error(
      `publication.withdrawal code=${errorCode} fallback_ttl_seconds=${PUBLICATION_EDGE_FALLBACK_TTL_SECONDS}`,
    );

  /**
   * The outcome of one purge group of a withdrawal plan: ordinary roles and
   * Catalog blocks are purged, retried and failed separately, so a block
   * group never holds back the take-down of the other roles.
   */
  type GroupOutcome =
    | { readonly kind: "finished" }
    | { readonly kind: "submitted" }
    | { readonly kind: "wait"; readonly delayMs: number }
    | { readonly kind: "lost" }
    | { readonly kind: "failed"; readonly result: PublishingJobResult };
  const LOST: GroupOutcome = { kind: "lost" };

  const groupFailure = async (
    fence: PublicationFence,
    units: readonly PublicationUnit[],
    errorCode: string,
  ): Promise<GroupOutcome> => {
    const held = await port.failPurge(fence, ids(units), errorCode, clock());
    if (!held) return LOST;
    alert(errorCode);
    return {
      kind: "failed",
      result: failed(errorCode, attempts(units) + 1 < MAX_PURGE_ATTEMPTS),
    };
  };

  /** Submits one group's URLs in purge tasks of at most 100 URLs. */
  const submitGroup = async (
    fence: PublicationFence,
    units: readonly PublicationUnit[],
    signal: AbortSignal,
  ): Promise<GroupOutcome> => {
    if (attempts(units) >= MAX_PURGE_ATTEMPTS) {
      return await groupFailure(fence, units, "purge_failed");
    }
    try {
      const target = configuredProvider();
      if (!(await current(fence, signal))) return LOST;
      for (let start = 0; start < units.length; start += PURGE_BATCH_SIZE) {
        const batch = units.slice(start, start + PURGE_BATCH_SIZE);
        if (!(await current(fence, signal))) return LOST;
        const taskId = await target.provider.purge(
          batch.map((unit) =>
            publishedObjectUrl(target.origin, unit.objectKey),
          ),
          "file",
          signal,
        );
        throwAborted(signal);
        if (!(await port.recordPurge(fence, ids(batch), [taskId], clock())))
          return LOST;
      }
      return { kind: "submitted" };
    } catch (error) {
      throwAborted(signal);
      return await groupFailure(fence, units, providerCode(error));
    }
  };

  /** Ordinary roles: purge, confirm, verify every unit (up to 3 attempts). */
  const withdrawOrdinary = async (
    fence: PublicationFence,
    units: readonly PublicationUnit[],
    signal: AbortSignal,
  ): Promise<readonly GroupOutcome[]> => {
    const target = configuredProvider();
    if (units.some((unit) => unit.purgeTaskIds.length === 0)) {
      // A crash after one batch preserves that batch's tasks; missing units
      // are submitted on restart before the group can finish verification.
      return [
        await submitGroup(
          fence,
          units.filter((unit) => unit.purgeTaskIds.length === 0),
          signal,
        ),
      ];
    }
    const states: ("pending" | "succeeded" | "failed")[] = [];
    for (const taskId of uniqueTasks(units)) {
      if (!(await current(fence, signal))) return [LOST];
      states.push(await target.provider.purgeStatus(taskId, signal));
    }
    if (states.includes("failed"))
      return [await submitGroup(fence, units, signal)];
    if (states.includes("pending")) {
      if (
        clock().getTime() - earliestRequestedAt(units, clock()) >=
        MAX_WITHDRAWAL_WAIT_MS
      ) {
        return [await groupFailure(fence, units, "purge_unconfirmed")];
      }
      return [{ kind: "wait", delayMs: VERIFY_POLL_MS }];
    }
    for (const unit of units) {
      if (!(await current(fence, signal))) return [LOST];
      if (
        !(await target.provider.verifyGone(
          publishedObjectUrl(target.origin, unit.objectKey),
          signal,
        ))
      ) {
        if (attempts(units) >= MAX_PURGE_ATTEMPTS)
          return [await groupFailure(fence, units, "withdrawal_still_served")];
        return [await submitGroup(fence, units, signal)];
      }
    }
    throwAborted(signal);
    if (!(await port.finishWithdrawal(fence, ids(units), clock())))
      return [LOST];
    return [{ kind: "finished" }];
  };

  /** The first and last block of a group (by key): its sampled edge checks. */
  const sampledBlocks = (units: readonly PublicationUnit[]) => {
    const sorted = [...units].sort((left, right) =>
      left.objectKey < right.objectKey
        ? -1
        : left.objectKey > right.objectKey
          ? 1
          : 0,
    );
    return sorted.length <= 2 ? sorted : [sorted[0]!, sorted.at(-1)!];
  };

  const allGone = async (
    units: readonly PublicationUnit[],
    fence: PublicationFence,
    signal: AbortSignal,
  ): Promise<boolean | null> => {
    const target = configuredProvider();
    for (const unit of sampledBlocks(units)) {
      if (!(await current(fence, signal))) return null;
      if (
        !(await target.provider.verifyGone(
          publishedObjectUrl(target.origin, unit.objectKey),
          signal,
        ))
      )
        return false;
    }
    return true;
  };

  /** One content-free error line per deferred block group (OD-4). */
  const deferBlocks = async (
    fence: PublicationFence,
    units: readonly PublicationUnit[],
    code: "block_budget_deferred" | "block_purge_unconfirmed",
  ): Promise<readonly PublicationUnit[] | null> => {
    if (
      !(await port.deferBlockWithdrawal(
        fence,
        ids(units),
        blockTtlSeconds,
        clock(),
      ))
    )
      return null;
    logger.error(
      `publication.withdrawal code=${code} units=${units.length} ttl_seconds=${blockTtlSeconds}`,
    );
    return units.map((unit) => ({
      ...unit,
      purgeTaskIds: [],
      fallbackTtlSeconds: blockTtlSeconds,
    }));
  };

  /**
   * Catalog blocks (catalog-deep-zoom-v1): one purge attempt within the daily
   * block budget, sampled verification (first and last block), and otherwise
   * the TTL path: the origin object is already deleted, and the group
   * finishes once the forced edge TTL plus a margin has passed.
   */
  const withdrawBlocks = async (
    fence: PublicationFence,
    units: readonly PublicationUnit[],
    signal: AbortSignal,
  ): Promise<readonly GroupOutcome[]> => {
    const target = configuredProvider();
    const outcomes: GroupOutcome[] = [];
    let ttl = units.filter(
      (unit) =>
        unit.purgeTaskIds.length === 0 &&
        unit.fallbackTtlSeconds !== null &&
        unit.fallbackTtlSeconds !== undefined,
    );
    const fresh = units.filter(
      (unit) =>
        unit.purgeTaskIds.length === 0 &&
        (unit.fallbackTtlSeconds === null ||
          unit.fallbackTtlSeconds === undefined),
    );
    const purged = units.filter((unit) => unit.purgeTaskIds.length > 0);
    if (fresh.length > 0) {
      const used =
        blockBudget === 0
          ? 0
          : await port.blockPurgesSince(purgeQuotaDayStart(clock()));
      if (blockBudget > 0 && used + fresh.length <= blockBudget) {
        outcomes.push(await submitGroup(fence, fresh, signal));
      } else {
        const deferredUnits = await deferBlocks(
          fence,
          fresh,
          "block_budget_deferred",
        );
        if (deferredUnits === null) return [LOST];
        ttl = [...ttl, ...deferredUnits];
      }
    }
    if (purged.length > 0) {
      const states: ("pending" | "succeeded" | "failed")[] = [];
      for (const taskId of uniqueTasks(purged)) {
        if (!(await current(fence, signal))) return [LOST];
        states.push(await target.provider.purgeStatus(taskId, signal));
      }
      let fallback = states.includes("failed");
      if (!fallback && states.includes("pending")) {
        if (
          clock().getTime() - earliestRequestedAt(purged, clock()) <
          MAX_WITHDRAWAL_WAIT_MS
        )
          outcomes.push({ kind: "wait", delayMs: VERIFY_POLL_MS });
        else fallback = true;
      } else if (!fallback) {
        const gone = await allGone(purged, fence, signal);
        if (gone === null) return [LOST];
        if (gone) {
          throwAborted(signal);
          if (!(await port.finishWithdrawal(fence, ids(purged), clock())))
            return [LOST];
          outcomes.push({ kind: "finished" });
        } else fallback = true;
      }
      if (fallback) {
        const deferredUnits = await deferBlocks(
          fence,
          purged,
          "block_purge_unconfirmed",
        );
        if (deferredUnits === null) return [LOST];
        ttl = [...ttl, ...deferredUnits];
      }
    }
    if (ttl.length > 0) {
      const now = clock().getTime();
      const deletedAt = Math.max(
        ...ttl.map((unit) => unit.originDeletedAt?.getTime() ?? now),
      );
      const ttlMs =
        Math.max(
          ...ttl.map((unit) => unit.fallbackTtlSeconds ?? blockTtlSeconds),
        ) * 1_000;
      const wait = deletedAt + ttlMs + BLOCK_TTL_MARGIN_MS - now;
      if (wait > 0) {
        outcomes.push({ kind: "wait", delayMs: Math.min(MAX_DEFER_MS, wait) });
      } else {
        const gone = await allGone(ttl, fence, signal);
        if (gone === null) return [LOST];
        if (!gone) {
          outcomes.push(
            await groupFailure(fence, ttl, "withdrawal_still_served"),
          );
        } else {
          throwAborted(signal);
          if (!(await port.finishWithdrawal(fence, ids(ttl), clock())))
            return [LOST];
          outcomes.push({ kind: "finished" });
        }
      }
    }
    return outcomes;
  };

  const withdraw = async (
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ) => {
    // Intentionally ungated: existing public generations must drain in Beta/off.
    const plan = await port.planWithdrawal(claim.subjectId, claim, clock());
    if (plan.status !== "ready")
      return plan.status === "busy" ? deferred() : COMPLETE;
    try {
      if (plan.units.length === 0) return COMPLETE;
      const target = configuredProvider();
      const blocks = plan.units.filter(isBlockUnit);
      const ordinary = plan.units.filter((unit) => !isBlockUnit(unit));
      // Every ordinary origin object is deleted on each run, as before; a
      // block only until its deletion is recorded (a deferred block group
      // is re-run every few minutes while its edge TTL passes).
      const deleting = [
        ...ordinary,
        ...blocks.filter((unit) => !unit.originDeletedAt),
      ];
      for (const unit of deleting) {
        if (!(await current(plan.fence, signal))) return deferred();
        validatePublishedKey(unit.objectKey);
        await target.provider.remove(unit.objectKey, signal);
      }
      if (
        deleting.length > 0 &&
        !(await port.recordOriginDeleted(plan.fence, ids(deleting), clock()))
      )
        return deferred();
      const guarded = async (
        units: readonly PublicationUnit[],
        run: () => Promise<readonly GroupOutcome[]>,
      ): Promise<readonly GroupOutcome[]> => {
        try {
          return await run();
        } catch (error) {
          throwAborted(signal);
          if (
            error instanceof MediaPublicationJobError &&
            error.code === "provider_unavailable"
          )
            throw error;
          return [await groupFailure(plan.fence, units, providerCode(error))];
        }
      };
      // Ordinary roles first, in their own purge tasks.
      const outcomes = [
        ...(ordinary.length > 0
          ? await guarded(ordinary, () =>
              withdrawOrdinary(plan.fence, ordinary, signal),
            )
          : []),
        ...(blocks.length > 0
          ? await guarded(blocks, () =>
              withdrawBlocks(plan.fence, blocks, signal),
            )
          : []),
      ];
      if (outcomes.some((outcome) => outcome.kind === "lost"))
        return deferred();
      const failure = outcomes.find((outcome) => outcome.kind === "failed");
      if (failure?.kind === "failed") return failure.result;
      if (outcomes.some((outcome) => outcome.kind === "submitted")) {
        await queue.enqueueJob(
          {
            kind: "verify_withdrawal",
            subjectId: claim.subjectId,
            runAfter: new Date(clock().getTime() + VERIFY_DELAY_MS),
            maxAttempts: MAX_PURGE_ATTEMPTS,
          },
          clock(),
        );
        return claim.kind === "verify_withdrawal"
          ? deferred(VERIFY_DELAY_MS)
          : COMPLETE;
      }
      const waits = outcomes.flatMap((outcome) =>
        outcome.kind === "wait" ? [outcome.delayMs] : [],
      );
      if (waits.length > 0) return deferred(Math.min(...waits));
      logger.info(`publication.withdrawal verified count=${plan.units.length}`);
      return COMPLETE;
    } catch (error) {
      throwAborted(signal);
      if (
        error instanceof MediaPublicationJobError &&
        error.code === "provider_unavailable"
      ) {
        return failed("publication_provider_unavailable", true);
      }
      const outcome = await groupFailure(
        plan.fence,
        plan.units,
        providerCode(error),
      );
      return outcome.kind === "failed" ? outcome.result : deferred();
    } finally {
      await port.release(plan.fence, clock());
    }
  };

  const sweep = async (signal: AbortSignal): Promise<PublishingJobResult> => {
    const candidates = await port.sweepCandidates(clock(), limit);
    if (candidates.length === 0) return COMPLETE;
    const target = configuredProvider();
    // Catalog blocks are swept once: one origin HEAD each and two sampled
    // edge checks per asset, never a purge (catalog-deep-zoom-v1).
    const blocksByAsset = new Map<string, PublicationUnit[]>();
    for (const unit of candidates.filter(isBlockUnit))
      blocksByAsset.set(unit.assetId, [
        ...(blocksByAsset.get(unit.assetId) ?? []),
        unit,
      ]);
    const sampledIds = new Set(
      [...blocksByAsset.values()].flatMap((units) =>
        sampledBlocks(units).map((unit) => unit.id),
      ),
    );
    for (const unit of candidates) {
      throwAborted(signal);
      validatePublishedKey(unit.objectKey);
      const url = publishedObjectUrl(target.origin, unit.objectKey);
      try {
        if (isBlockUnit(unit)) {
          if (await target.provider.head(unit.objectKey, signal)) {
            await target.provider.remove(unit.objectKey, signal);
            alert("orphan_published_object");
          }
          if (
            sampledIds.has(unit.id) &&
            !(await target.provider.verifyGone(url, signal))
          ) {
            await port.recordSweepFailure(
              [unit.id],
              "withdrawal_still_served",
              clock(),
            );
            alert("orphan_published_object");
            return failed(
              "orphan_published_object",
              unit.sweepAttempts + 1 < MAX_PURGE_ATTEMPTS,
            );
          }
          throwAborted(signal);
          await port.recordSweep([unit.id], clock());
          continue;
        }
        let taskIds = unit.sweepTaskIds;
        if (taskIds.length === 0) {
          const head = await target.provider.head(unit.objectKey, signal);
          // A restart may see no origin object after a delete but before purge.
          // Only edge denial, never origin absence alone, clears the sweep intent.
          if (!head && (await target.provider.verifyGone(url, signal))) {
            await port.recordSweep([unit.id], clock());
            continue;
          }
          if (unit.sweepAttempts >= MAX_PURGE_ATTEMPTS) {
            alert("orphan_published_object");
            return failed("orphan_published_object");
          }
          if (head) await target.provider.remove(unit.objectKey, signal);
          const taskId = await target.provider.purge([url], "file", signal);
          await port.recordSweepPurge([unit.id], [taskId], clock());
          taskIds = [taskId];
        }
        const startedAt = unit.sweepStartedAt?.getTime() ?? clock().getTime();
        for (const taskId of taskIds) {
          const state = await target.provider.purgeStatus(taskId, signal);
          if (
            state === "pending" &&
            clock().getTime() - startedAt < MAX_WITHDRAWAL_WAIT_MS
          ) {
            return deferred(VERIFY_POLL_MS);
          }
          if (state !== "succeeded") {
            await port.recordSweepFailure(
              [unit.id],
              "purge_unconfirmed",
              clock(),
            );
            alert("orphan_published_object");
            return failed(
              "orphan_published_object",
              unit.sweepAttempts + 1 < MAX_PURGE_ATTEMPTS,
            );
          }
        }
        if (!(await target.provider.verifyGone(url, signal))) {
          await port.recordSweepFailure(
            [unit.id],
            "withdrawal_still_served",
            clock(),
          );
          alert("orphan_published_object");
          return failed(
            "orphan_published_object",
            unit.sweepAttempts + 1 < MAX_PURGE_ATTEMPTS,
          );
        }
        throwAborted(signal);
        await port.recordSweep([unit.id], clock());
      } catch (error) {
        throwAborted(signal);
        await port.recordSweepFailure([unit.id], providerCode(error), clock());
        alert("orphan_published_object");
        return failed(
          "orphan_published_object",
          unit.sweepAttempts + 1 < MAX_PURGE_ATTEMPTS,
        );
      }
    }
    logger.info(`publication.sweep completed count=${candidates.length}`);
    return COMPLETE;
  };

  return {
    async run(claim, signal) {
      throwAborted(signal);
      switch (claim.kind) {
        case "publish_media":
          return publish(claim, signal);
        case "withdraw_media":
        case "verify_withdrawal":
          return withdraw(claim, signal);
        case "reconcile_publication": {
          const result = await port.reconcile(clock(), allowPublish(), limit);
          logger.info(
            `publication.reconcile publish=${result.publish} withdraw=${result.withdraw}`,
          );
          return COMPLETE;
        }
        case "sweep_published":
          return sweep(signal);
        default:
          return failed("invalid_job_input");
      }
    },
  };
}

/** Uses existing active-job deduplication; these steps create no second queue. */
export function publicationMaintenanceSteps(
  queue: Pick<PublishingWorkerPort, "enqueueJob">,
  options: Pick<
    PublicationJobHandlerOptions,
    "port" | "provider" | "logger" | "allowPublish"
  >,
): readonly PublishingWorkerExtraStep[] {
  const logger = options.logger ?? NULL_LOGGER;
  const needsMaintenance = async (): Promise<boolean> =>
    options.allowPublish() || (await options.port.hasRegisteredPublications());
  const steps: PublishingWorkerExtraStep[] = [
    {
      label: "publication_reconcile",
      intervalMs: PUBLICATION_RECONCILE_INTERVAL_MS,
      async run(now) {
        if (!(await needsMaintenance())) return;
        await queue.enqueueJob(
          {
            kind: "reconcile_publication",
            subjectId: PUBLICATION_RECONCILE_SUBJECT,
          },
          now,
        );
      },
    },
    {
      label: "publication_sweep",
      intervalMs: PUBLICATION_SWEEP_INTERVAL_MS,
      async run(now) {
        if (!(await needsMaintenance())) return;
        await queue.enqueueJob(
          { kind: "sweep_published", subjectId: PUBLICATION_SWEEP_SUBJECT },
          now,
        );
      },
    },
  ];
  const provider = options.provider;
  if (provider) {
    steps.push({
      label: "publication_request_usage",
      intervalMs: PUBLICATION_USAGE_INTERVAL_MS,
      async run(now) {
        // Off/Beta does not assume the publisher role for a scheduled read.
        if (!options.allowPublish()) return;
        const usage = await provider.monthlyRequests(now);
        await options.port.recordRequestUsage(usage, now);
        if (usage.warning)
          logger.error(
            "publication.usage code=monthly_request_warning threshold=2000000",
          );
      },
    });
    // catalog-deep-zoom-v1: the breaker's day-to-date counts, read from the
    // start of the cap's day. Lines are content-free (a code and the counts)
    // and error-level, like the monthly warning, so the journal grep finds
    // both thresholds.
    steps.push({
      label: "publication_day_usage",
      intervalMs: CATALOG_ZOOM_USAGE_INTERVAL_MS,
      async run(now) {
        if (!options.allowPublish()) return;
        const usage = await provider.dayUsage(purgeQuotaDayStart(now), now);
        const stored = await options.port.recordDayUsage(usage, now);
        if (!stored) logger.error("publication.usage code=day_usage_no_row");
        const counts = `requests=${usage.requests} bytes=${usage.bytes}`;
        if (catalogZoomUsageAt(usage, "trip"))
          logger.error(`publication.usage code=day_usage_trip ${counts}`);
        else if (catalogZoomUsageAt(usage, "warning"))
          logger.error(`publication.usage code=day_usage_warning ${counts}`);
      },
    });
  }
  return steps;
}
