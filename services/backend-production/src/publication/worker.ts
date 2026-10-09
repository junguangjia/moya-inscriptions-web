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

const MAX_PURGE_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 10_000;
const VERIFY_POLL_MS = 30_000;
const MAX_WITHDRAWAL_WAIT_MS = 10 * 60_000;
const MAX_UNITS = 500;
const PURGE_BATCH_SIZE = 100;
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

  const alert = (errorCode: string) =>
    logger.error(
      `publication.withdrawal code=${errorCode} fallback_ttl_seconds=${PUBLICATION_EDGE_FALLBACK_TTL_SECONDS}`,
    );

  const purgeFailure = async (
    plan: Extract<PublicationPlan, { readonly status: "ready" }>,
    errorCode: string,
  ): Promise<PublishingJobResult> => {
    const held = await port.failPurge(
      plan.fence,
      ids(plan.units),
      errorCode,
      clock(),
    );
    if (!held) return deferred();
    alert(errorCode);
    return failed(errorCode, attempts(plan.units) + 1 < MAX_PURGE_ATTEMPTS);
  };

  const submitPurge = async (
    plan: Extract<PublicationPlan, { readonly status: "ready" }>,
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    if (attempts(plan.units) >= MAX_PURGE_ATTEMPTS) {
      return await purgeFailure(plan, "purge_failed");
    }
    try {
      const target = configuredProvider();
      if (!(await current(plan.fence, signal))) return deferred();
      for (
        let start = 0;
        start < plan.units.length;
        start += PURGE_BATCH_SIZE
      ) {
        const batch = plan.units.slice(start, start + PURGE_BATCH_SIZE);
        if (!(await current(plan.fence, signal))) return deferred();
        const taskId = await target.provider.purge(
          batch.map((unit) =>
            publishedObjectUrl(target.origin, unit.objectKey),
          ),
          "file",
          signal,
        );
        throwAborted(signal);
        if (
          !(await port.recordPurge(plan.fence, ids(batch), [taskId], clock()))
        )
          return deferred();
      }
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
    } catch (error) {
      throwAborted(signal);
      return await purgeFailure(plan, providerCode(error));
    }
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
      for (const unit of plan.units) {
        if (!(await current(plan.fence, signal))) return deferred();
        validatePublishedKey(unit.objectKey);
        await target.provider.remove(unit.objectKey, signal);
      }
      if (
        !(await port.recordOriginDeleted(plan.fence, ids(plan.units), clock()))
      )
        return deferred();
      const taskIds = uniqueTasks(plan.units);
      if (plan.units.some((unit) => unit.purgeTaskIds.length === 0)) {
        // A crash after one batch preserves that batch's tasks; missing units
        // are submitted on restart before the group can finish verification.
        return await submitPurge(
          {
            ...plan,
            units: plan.units.filter((unit) => unit.purgeTaskIds.length === 0),
          },
          claim,
          signal,
        );
      }
      const states: ("pending" | "succeeded" | "failed")[] = [];
      for (const taskId of taskIds) {
        if (!(await current(plan.fence, signal))) return deferred();
        states.push(await target.provider.purgeStatus(taskId, signal));
      }
      if (states.includes("failed"))
        return await submitPurge(plan, claim, signal);
      if (states.includes("pending")) {
        if (
          clock().getTime() - earliestRequestedAt(plan.units, clock()) >=
          MAX_WITHDRAWAL_WAIT_MS
        ) {
          return await purgeFailure(plan, "purge_unconfirmed");
        }
        return deferred(VERIFY_POLL_MS);
      }
      for (const unit of plan.units) {
        if (!(await current(plan.fence, signal))) return deferred();
        if (
          !(await target.provider.verifyGone(
            publishedObjectUrl(target.origin, unit.objectKey),
            signal,
          ))
        ) {
          if (attempts(plan.units) >= MAX_PURGE_ATTEMPTS)
            return await purgeFailure(plan, "withdrawal_still_served");
          return await submitPurge(plan, claim, signal);
        }
      }
      throwAborted(signal);
      if (!(await port.finishWithdrawal(plan.fence, ids(plan.units), clock())))
        return deferred();
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
      return await purgeFailure(plan, providerCode(error));
    } finally {
      await port.release(plan.fence, clock());
    }
  };

  const sweep = async (signal: AbortSignal): Promise<PublishingJobResult> => {
    const candidates = await port.sweepCandidates(clock(), limit);
    if (candidates.length === 0) return COMPLETE;
    const target = configuredProvider();
    for (const unit of candidates) {
      throwAborted(signal);
      validatePublishedKey(unit.objectKey);
      const url = publishedObjectUrl(target.origin, unit.objectKey);
      try {
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
  }
  return steps;
}
