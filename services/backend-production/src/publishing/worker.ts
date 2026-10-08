import { randomBytes } from "node:crypto";

import {
  PUBLISHING_STAGING_SWEEP_SUBJECT,
  PUBLISHING_STORE_RECONCILE_SUBJECT,
  defaultPublishingWorkerTimers,
} from "./job-handlers.js";

import type {
  PublishingJobHandlers,
  PublishingJobResult,
  PublishingWorkerJobClaim,
  PublishingWorkerJobKind,
  PublishingWorkerLogger,
  PublishingWorkerPort,
  PublishingWorkerTimers,
} from "./job-handlers.js";

/*
 * The bounded publishing job worker (design §2.5, §3.5; T06). One in-process
 * loop polls the durable PostgreSQL queue, leases at most `concurrency` jobs
 * at a time, renews their leases while they run and records one outcome per
 * job. It also drives the periodic maintenance that has no author request:
 * requeueing expired leases, scheduling cleanup jobs, and enqueueing the
 * staging sweep and the store reconciliation.
 *
 * Shutdown stops polling, waits a bounded time for running jobs, aborts the
 * rest and releases their leases so no job waits for lease expiry. Logs carry
 * job kinds, counts and content-free codes only.
 */

export const PUBLISHING_WORKER_DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 5 * 60 * 1000,
  shutdownGraceMs: 30_000,
  abortGraceMs: 5_000,
  requeueIntervalMs: 30_000,
  cleanupIntervalMs: 60_000,
  sweepIntervalMs: 60 * 60 * 1000,
  reconcileIntervalMs: 6 * 60 * 60 * 1000,
  maintenanceLimit: 100,
} as const;

const MAX_CONCURRENCY = 4;
const MAX_ERROR_BACKOFF_MS = 30_000;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Base label; each claim call appends `.<sequence>` (at most 128 in total). */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Longest margin before lease expiry at which an unrenewed job is aborted. */
const MAX_LEASE_SAFETY_MS = 30_000;

/** Which built-in maintenance steps a worker runs (all of them by default). */
export interface PublishingWorkerMaintenanceSteps {
  /** Requeue expired leases (every kind; idempotent across processes). */
  readonly requeue?: boolean;
  /** Schedule cleanup jobs, including `expire_session`. */
  readonly cleanup?: boolean;
  /** Enqueue the `sweep_staging` job. */
  readonly sweep?: boolean;
  /** Enqueue the store-wide `reconcile_capacity` job. */
  readonly reconcile?: boolean;
}

/** An additional periodic step of the maintenance pass (for example the Catalog sync). */
export interface PublishingWorkerExtraStep {
  /** Content-free label used in failure logs. */
  readonly label: string;
  readonly intervalMs: number;
  run(now: Date): Promise<unknown>;
}

export interface PublishingWorkerOptions {
  readonly port: PublishingWorkerPort;
  readonly handlers: PublishingJobHandlers;
  /** Jobs leased and running at once, 1..4 (default 1). */
  readonly concurrency?: number;
  /**
   * Content-free lease owner label (at most 100 characters); a random process
   * label by default. Every claim call leases under `<owner>.<sequence>`, so a
   * job this worker claims again never shares a lease with its earlier run.
   */
  readonly owner?: string;
  /** Claim only these job kinds; every kind when omitted. */
  readonly kinds?: readonly PublishingWorkerJobKind[];
  /**
   * Run the periodic queue maintenance (lease requeue, cleanup scheduling,
   * sweep and reconciliation enqueueing). Default true (every step); an
   * object selects steps, and a worker that shares its queue with another
   * maintaining worker may turn it off.
   */
  readonly maintenance?: boolean | PublishingWorkerMaintenanceSteps;
  /** Additional periodic steps, run after the built-in ones. */
  readonly extraMaintenance?: readonly PublishingWorkerExtraStep[];
  readonly clock?: () => Date;
  readonly timers?: PublishingWorkerTimers;
  readonly logger?: PublishingWorkerLogger;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  /** Lease renewal cadence while a job runs; default a third of the lease. */
  readonly renewIntervalMs?: number;
  /** How long `stop` waits for running jobs before aborting them. */
  readonly shutdownGraceMs?: number;
  /** How long `stop` waits for aborted jobs before releasing their leases anyway. */
  readonly abortGraceMs?: number;
  readonly requeueIntervalMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly sweepIntervalMs?: number;
  readonly reconcileIntervalMs?: number;
  /** Per-pass bound for requeueing and cleanup scheduling. */
  readonly maintenanceLimit?: number;
}

export type PublishingWorkerAbortReason = "shutdown" | "lease_lost";

/** Abort reason handed to job handlers. */
export class PublishingWorkerAbortError extends Error {
  constructor(readonly reason: PublishingWorkerAbortReason) {
    super(`Publishing job aborted: ${reason}`);
    this.name = "PublishingWorkerAbortError";
  }
}

/** Content-free job failure classification. */
export interface PublishingJobFailureClass {
  readonly errorCode: string;
  readonly retryable: boolean;
}

const codeOf = (error: Error): string | null => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(code)
    ? code
    : null;
};

/**
 * Classifies a thrown job error by its name, never by its message.
 * Infrastructure failures (media tools, the media store, processing
 * availability, the database) are retried with backoff; malformed job input
 * and unknown subjects fail without retry. Deterministic media rejections
 * never reach here: handlers record them as item or edit failures.
 */
export const classifyPublishingJobError = (
  error: unknown,
): PublishingJobFailureClass => {
  if (!(error instanceof Error)) {
    return { errorCode: "unexpected_error", retryable: true };
  }
  const code = codeOf(error);
  switch (error.name) {
    case "MediaToolError":
      return {
        errorCode: code ? `media_tool_${code}` : "media_tool_failure",
        retryable: true,
      };
    case "PublishingMediaStoreError":
      return {
        errorCode: code ? `media_store_${code}` : "media_store_failure",
        retryable: true,
      };
    case "MediaProcessingUnavailableError":
      return { errorCode: "processing_unavailable", retryable: true };
    case "PublishingJobSystemError":
      return { errorCode: code ?? "system_failure", retryable: true };
    case "MediaPublicationJobError":
      return {
        errorCode: code ? `publication_${code}` : "publication_failure",
        retryable: code !== "integrity",
      };
    case "CommunityStoreUnavailableError":
      return { errorCode: "database_unavailable", retryable: true };
    case "CommunityConflictError":
      return { errorCode: "state_conflict", retryable: true };
    case "MediaProcessingInputError":
      return { errorCode: "processing_input_invalid", retryable: false };
    case "CommunityNotFoundError":
      return { errorCode: "subject_not_found", retryable: false };
    case "CommunityInputError":
      return { errorCode: "invalid_job_input", retryable: false };
    default:
      return { errorCode: "unexpected_error", retryable: true };
  }
};

interface ActiveRun {
  readonly claim: PublishingWorkerJobClaim;
  readonly controller: AbortController;
  /** Local view of the lease deadline (ms since epoch). */
  leaseExpiresAt: number;
  renewTimer: unknown;
  /** Aborts the run shortly before `leaseExpiresAt` unless a renewal moved it. */
  deadlineTimer: unknown;
  /** Set once an outcome is being recorded or the lease was released. */
  settled: boolean;
  finished: boolean;
  done: Promise<void>;
}

const positive = (
  value: number | undefined,
  fallback: number,
  name: string,
) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`Publishing worker ${name} must be a positive integer`);
  }
  return result;
};

export class PublishingWorker {
  private readonly port: PublishingWorkerPort;
  private readonly handlers: PublishingJobHandlers;
  private readonly concurrency: number;
  private readonly owner: string;
  private readonly kinds: readonly PublishingWorkerJobKind[] | undefined;
  private readonly steps: Required<PublishingWorkerMaintenanceSteps>;
  private readonly extraSteps: readonly {
    readonly step: PublishingWorkerExtraStep;
    nextAt: number;
  }[];
  private readonly clock: () => Date;
  private readonly timers: PublishingWorkerTimers;
  private readonly logger: PublishingWorkerLogger;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly leaseSafetyMs: number;
  private readonly shutdownGraceMs: number;
  private readonly abortGraceMs: number;
  private readonly requeueIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly maintenanceLimit: number;

  private state: "idle" | "running" | "stopping" | "stopped" = "idle";
  private readonly runs = new Map<string, ActiveRun>();
  /** Leases given back for claims that were never run. */
  private readonly releases = new Set<Promise<void>>();
  private pollTimer: unknown = undefined;
  private ticking: Promise<void> | null = null;
  private rerun = false;
  private stopping: Promise<void> | null = null;
  private failureStreak = 0;
  private claimSequence = 0;
  private nextRequeueAt = 0;
  private nextCleanupAt = 0;
  private nextSweepAt = 0;
  private nextReconcileAt = 0;

  constructor(options: PublishingWorkerOptions) {
    const defaults = PUBLISHING_WORKER_DEFAULTS;
    this.port = options.port;
    this.handlers = options.handlers;
    this.concurrency = positive(options.concurrency, 1, "concurrency");
    if (this.concurrency > MAX_CONCURRENCY) {
      throw new Error(
        `Publishing worker concurrency must be at most ${MAX_CONCURRENCY}`,
      );
    }
    this.owner =
      options.owner ??
      `publishing-worker-${process.pid}-${randomBytes(6).toString("hex")}`;
    if (!OWNER_PATTERN.test(this.owner)) {
      throw new Error("Publishing worker owner label is invalid");
    }
    this.kinds = options.kinds ? [...options.kinds] : undefined;
    const maintenance = options.maintenance ?? true;
    const all = maintenance === true;
    const selected = typeof maintenance === "object" ? maintenance : {};
    this.steps = {
      requeue: all || selected.requeue === true,
      cleanup: all || selected.cleanup === true,
      sweep: all || selected.sweep === true,
      reconcile: all || selected.reconcile === true,
    };
    this.extraSteps = (options.extraMaintenance ?? []).map((step) => {
      positive(step.intervalMs, step.intervalMs, "maintenance step interval");
      if (!/^[a-z][a-z0-9 _-]{0,63}$/.test(step.label)) {
        throw new Error("Publishing worker maintenance step label is invalid");
      }
      return { step, nextAt: 0 };
    });
    this.clock = options.clock ?? (() => new Date());
    this.timers = options.timers ?? defaultPublishingWorkerTimers;
    this.logger = options.logger ?? console;
    this.pollIntervalMs = positive(
      options.pollIntervalMs,
      defaults.pollIntervalMs,
      "poll interval",
    );
    this.leaseMs = positive(options.leaseMs, defaults.leaseMs, "lease");
    this.renewIntervalMs = positive(
      options.renewIntervalMs,
      Math.max(1, Math.floor(this.leaseMs / 3)),
      "renew interval",
    );
    if (this.renewIntervalMs >= this.leaseMs) {
      throw new Error(
        "Publishing worker renew interval must be below the lease",
      );
    }
    this.leaseSafetyMs = Math.min(
      MAX_LEASE_SAFETY_MS,
      Math.floor(this.leaseMs / 10),
      Math.floor((this.leaseMs - this.renewIntervalMs) / 2),
    );
    this.shutdownGraceMs = positive(
      options.shutdownGraceMs,
      defaults.shutdownGraceMs,
      "shutdown grace",
    );
    this.abortGraceMs = positive(
      options.abortGraceMs,
      defaults.abortGraceMs,
      "abort grace",
    );
    this.requeueIntervalMs = positive(
      options.requeueIntervalMs,
      defaults.requeueIntervalMs,
      "requeue interval",
    );
    this.cleanupIntervalMs = positive(
      options.cleanupIntervalMs,
      defaults.cleanupIntervalMs,
      "cleanup interval",
    );
    this.sweepIntervalMs = positive(
      options.sweepIntervalMs,
      defaults.sweepIntervalMs,
      "sweep interval",
    );
    this.reconcileIntervalMs = positive(
      options.reconcileIntervalMs,
      defaults.reconcileIntervalMs,
      "reconcile interval",
    );
    this.maintenanceLimit = positive(
      options.maintenanceLimit,
      defaults.maintenanceLimit,
      "maintenance limit",
    );
  }

  /** Jobs currently leased by this worker. */
  get activeJobs(): number {
    return this.runs.size;
  }

  get running(): boolean {
    return this.state === "running";
  }

  /** Starts polling immediately. A stopped worker cannot be restarted. */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.schedule(0);
  }

  /**
   * Stops polling, waits up to the shutdown grace for running jobs, aborts
   * the remaining ones and releases their leases. Idempotent.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state === "idle") {
      this.state = "stopped";
      this.stopping = Promise.resolve();
      return this.stopping;
    }
    this.state = "stopping";
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    const inFlight = () => [
      ...(this.ticking ? [this.ticking] : []),
      ...[...this.runs.values()].map((run) => run.done),
      ...this.releases,
    ];
    await this.within(Promise.allSettled(inFlight()), this.shutdownGraceMs);
    if (this.runs.size > 0) {
      const remaining = [...this.runs.values()];
      for (const run of remaining) {
        run.controller.abort(new PublishingWorkerAbortError("shutdown"));
      }
      await this.within(
        Promise.allSettled(remaining.map((run) => run.done)),
        this.abortGraceMs,
      );
      const unsettled = remaining.filter((run) => !run.settled);
      await this.within(
        Promise.allSettled(unsettled.map((run) => this.release(run))),
        this.abortGraceMs,
      );
      for (const run of remaining) this.clearRunTimers(run);
    }
    await this.within(
      Promise.allSettled([...this.releases]),
      this.abortGraceMs,
    );
    this.state = "stopped";
  }

  /** Resolves when `promise` settles or after `ms`, whichever comes first. */
  private within(promise: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.timers.setTimeout(resolve, ms, { keepAlive: true });
      const done = () => {
        this.timers.clearTimeout(timer);
        resolve();
      };
      promise.then(done, done);
    });
  }

  private schedule(delayMs: number): void {
    if (this.state !== "running") return;
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      this.runTick();
    }, delayMs);
  }

  /** Polls again as soon as possible (a slot was freed). */
  private wake(): void {
    if (this.state !== "running") return;
    if (this.ticking) this.rerun = true;
    else this.schedule(0);
  }

  private runTick(): void {
    if (this.state !== "running") return;
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    this.ticking = this.tick().finally(() => {
      this.ticking = null;
      if (this.state !== "running") return;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
        return;
      }
      const backoff =
        this.failureStreak === 0
          ? this.pollIntervalMs
          : Math.min(
              MAX_ERROR_BACKOFF_MS,
              this.pollIntervalMs * 2 ** Math.min(this.failureStreak, 15),
            );
      this.schedule(backoff);
    });
  }

  private async tick(): Promise<void> {
    let healthy = true;
    if (Object.values(this.steps).some(Boolean) || this.extraSteps.length > 0) {
      try {
        await this.maintain();
      } catch {
        healthy = false;
      }
    }
    const free = this.concurrency - this.runs.size;
    if (this.state === "running" && free > 0) {
      try {
        this.claimSequence += 1;
        const claims = await this.port.claimJobs(
          {
            owner: `${this.owner}.${this.claimSequence.toString(36)}`,
            limit: free,
            leaseMs: this.leaseMs,
            ...(this.kinds ? { kinds: this.kinds } : {}),
          },
          this.clock(),
        );
        claims.forEach((claim, index) => {
          if (
            this.state === "running" &&
            index < free &&
            !this.runs.has(claim.id)
          ) {
            this.startRun(claim);
          } else {
            const release = this.releaseClaim(claim);
            this.releases.add(release);
            void release.finally(() => this.releases.delete(release));
          }
        });
      } catch {
        healthy = false;
        this.logFailureOnce("[publishing-worker] job claim failed");
      }
    }
    if (healthy) {
      if (this.failureStreak > 0) {
        this.logger.info("[publishing-worker] job queue reachable again");
      }
      this.failureStreak = 0;
    } else {
      this.failureStreak += 1;
    }
  }

  private logFailureOnce(message: string): void {
    if (this.failureStreak === 0) this.logger.error(message);
  }

  private async maintain(): Promise<void> {
    const now = this.clock();
    const at = now.getTime();
    let failure = false;
    const step = async (
      due: number,
      interval: number,
      action: () => Promise<unknown>,
      assign: (next: number) => void,
      label: string,
    ) => {
      if (at < due) return;
      assign(at + interval);
      try {
        await action();
      } catch {
        failure = true;
        this.logFailureOnce(`[publishing-worker] ${label} failed`);
      }
    };
    if (this.steps.requeue) {
      await step(
        this.nextRequeueAt,
        this.requeueIntervalMs,
        () => this.port.requeueExpiredJobs(now, this.maintenanceLimit),
        (next) => (this.nextRequeueAt = next),
        "lease requeue",
      );
    }
    if (this.steps.cleanup) {
      await step(
        this.nextCleanupAt,
        this.cleanupIntervalMs,
        () => this.port.scheduleCleanup(now, this.maintenanceLimit),
        (next) => (this.nextCleanupAt = next),
        "cleanup scheduling",
      );
    }
    if (this.steps.sweep) {
      await step(
        this.nextSweepAt,
        this.sweepIntervalMs,
        () =>
          this.port.enqueueJob(
            {
              kind: "sweep_staging",
              subjectId: PUBLISHING_STAGING_SWEEP_SUBJECT,
            },
            now,
          ),
        (next) => (this.nextSweepAt = next),
        "staging sweep scheduling",
      );
    }
    if (this.steps.reconcile) {
      await step(
        this.nextReconcileAt,
        this.reconcileIntervalMs,
        () =>
          this.port.enqueueJob(
            {
              kind: "reconcile_capacity",
              subjectId: PUBLISHING_STORE_RECONCILE_SUBJECT,
            },
            now,
          ),
        (next) => (this.nextReconcileAt = next),
        "store reconciliation scheduling",
      );
    }
    for (const extra of this.extraSteps) {
      await step(
        extra.nextAt,
        extra.step.intervalMs,
        () => extra.step.run(now),
        (next) => (extra.nextAt = next),
        extra.step.label,
      );
    }
    if (failure) throw new Error("maintenance failed");
  }

  private startRun(claim: PublishingWorkerJobClaim): void {
    const run: ActiveRun = {
      claim,
      controller: new AbortController(),
      leaseExpiresAt: claim.leaseExpiresAt.getTime(),
      renewTimer: undefined,
      deadlineTimer: undefined,
      settled: false,
      finished: false,
      done: Promise.resolve(),
    };
    this.runs.set(claim.id, run);
    this.scheduleRenewal(run);
    this.armDeadline(run);
    // The handler starts on a later microtask, so `done` is in place before
    // any handler code (which may itself request a stop) runs.
    run.done = Promise.resolve()
      .then(() => this.execute(run))
      .finally(() => {
        run.finished = true;
        this.clearRunTimers(run);
        this.runs.delete(claim.id);
        this.wake();
      });
  }

  private clearRunTimers(run: ActiveRun): void {
    this.timers.clearTimeout(run.renewTimer);
    this.timers.clearTimeout(run.deadlineTimer);
  }

  /**
   * Local lease guard, independent of renewal calls: a renewal that hangs or
   * keeps failing never lets the run outlive its lease, so a requeued job is
   * not processed twice at once.
   */
  private armDeadline(run: ActiveRun): void {
    this.timers.clearTimeout(run.deadlineTimer);
    const abortAt = run.leaseExpiresAt - this.leaseSafetyMs;
    run.deadlineTimer = this.timers.setTimeout(
      () => {
        if (run.finished || run.settled || run.controller.signal.aborted) {
          return;
        }
        if (this.clock().getTime() < abortAt) {
          this.armDeadline(run);
          return;
        }
        this.loseLease(run);
      },
      Math.max(0, abortAt - this.clock().getTime()),
    );
  }

  private loseLease(run: ActiveRun): void {
    this.logger.error(
      `[publishing-worker] job lease lost kind=${run.claim.kind}`,
    );
    run.controller.abort(new PublishingWorkerAbortError("lease_lost"));
  }

  private scheduleRenewal(run: ActiveRun): void {
    run.renewTimer = this.timers.setTimeout(() => {
      void this.renew(run);
    }, this.renewIntervalMs);
  }

  private async renew(run: ActiveRun): Promise<void> {
    if (run.finished || run.settled || run.controller.signal.aborted) return;
    const now = this.clock();
    let held: boolean | null;
    try {
      held = await this.port.renewJobLease(
        this.lease(run.claim),
        this.leaseMs,
        now,
      );
    } catch {
      held = null;
    }
    if (run.finished || run.settled || run.controller.signal.aborted) return;
    if (held === true) {
      run.leaseExpiresAt = now.getTime() + this.leaseMs;
      this.armDeadline(run);
    }
    if (
      held === false ||
      this.clock().getTime() >= run.leaseExpiresAt - this.leaseSafetyMs
    ) {
      this.loseLease(run);
      return;
    }
    this.scheduleRenewal(run);
  }

  private lease(claim: PublishingWorkerJobClaim) {
    return { id: claim.id, leaseOwner: claim.leaseOwner };
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { claim, controller } = run;
    let result: PublishingJobResult;
    try {
      result = await this.handlers.run(claim, controller.signal);
    } catch (error) {
      if (run.settled) return;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (
          reason instanceof PublishingWorkerAbortError &&
          reason.reason === "shutdown"
        ) {
          await this.release(run);
        }
        // A lost lease belongs to someone else now: record nothing.
        return;
      }
      const failure = classifyPublishingJobError(error);
      result = {
        status: "failed",
        errorCode: failure.errorCode,
        retryable: failure.retryable,
      };
    }
    if (run.settled) return;
    await this.record(run, result);
  }

  private async record(
    run: ActiveRun,
    result: PublishingJobResult,
  ): Promise<void> {
    run.settled = true;
    const { claim } = run;
    try {
      if (result.status === "completed") {
        await this.port.completeJob(this.lease(claim), this.clock());
        return;
      }
      if (result.status === "deferred") {
        if (!this.port.deferJob)
          throw new Error("Publication deferral is unavailable");
        await this.port.deferJob(
          this.lease(claim),
          result.delayMs,
          this.clock(),
        );
        return;
      }
      const errorCode = ERROR_CODE_PATTERN.test(result.errorCode)
        ? result.errorCode
        : "unexpected_error";
      const outcome = await this.port.failJob(
        this.lease(claim),
        errorCode,
        this.clock(),
        { retryable: result.retryable },
      );
      this.logger.error(
        `[publishing-worker] job failed kind=${claim.kind} code=${errorCode} outcome=${outcome}`,
      );
      if (outcome === "failed") await this.jobFailed(claim);
    } catch {
      // The lease expires and the job is requeued by a later pass.
      this.logger.error(
        `[publishing-worker] job outcome not recorded kind=${claim.kind}`,
      );
    }
  }

  /** Lets the handlers settle the subject of a job that will not run again. */
  private async jobFailed(claim: PublishingWorkerJobClaim): Promise<void> {
    if (!this.handlers.onJobFailed) return;
    try {
      await this.handlers.onJobFailed(claim);
    } catch {
      this.logger.error(
        `[publishing-worker] failed job subject not updated kind=${claim.kind}`,
      );
    }
  }

  /** Gives the job back to the queue without waiting for lease expiry. */
  private async release(run: ActiveRun): Promise<void> {
    if (run.settled) return;
    run.settled = true;
    await this.releaseClaim(run.claim);
  }

  /**
   * The port's attempt-neutral release: the job is queued again at once
   * without spending the claimed attempt or recording an error. A lost lease
   * belongs to someone else and changes nothing.
   */
  private async releaseClaim(claim: PublishingWorkerJobClaim): Promise<void> {
    try {
      await this.port.releaseJob(this.lease(claim), this.clock());
    } catch {
      this.logger.error(
        `[publishing-worker] job lease not released kind=${claim.kind}`,
      );
    }
  }
}
