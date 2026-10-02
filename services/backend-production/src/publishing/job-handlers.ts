import { PUBLISHING_BLOB_KEY_PATTERN } from "../storage/publishing-media-store.js";
import { LEGACY_USER_MEDIA_MAX_BYTES } from "./processing/profiles.js";
import { sniffSignature } from "./processing/signature.js";

import type { PublishingMediaStoreBlobEntry } from "../storage/publishing-media-store.js";
import type { MediaEdit, NormalizedCrop } from "./processing/edits.js";
import type { MediaFailureCode } from "./processing/errors.js";
import type {
  ProcessorInput,
  ProcessorLegacySource,
  ProcessorOutcome,
  ProcessorVariant,
} from "./processing/media-processor.js";

/*
 * Job handlers of the work publishing worker (design §2.5, §3.5; T05-T06).
 *
 * The types below are structural mirrors of `WorkPublishingPort` and its job
 * shapes in `@moya/api`: this workspace composes adapters and never imports
 * the application package directly. `PostgresWorkPublishingAdapter` satisfies
 * `PublishingWorkerPort` by structure, which the composition and the tests
 * package typecheck.
 *
 * Handlers never log or return titles, bodies, file names, metadata values,
 * storage keys or error messages: outcomes and log lines carry only job kinds,
 * counts and content-free codes.
 */

export type PublishingWorkerJobKind =
  | "process_item"
  | "derive_edit"
  | "purge_item"
  | "purge_blob"
  | "expire_session"
  | "purge_trashed_work"
  | "sweep_staging"
  | "reconcile_capacity";

/** Mirror of `PublishingDeriveEditPayload`. */
export interface PublishingWorkerDerivePayload {
  readonly editKey: string;
  readonly edit: MediaEdit;
  readonly coverCrop: NormalizedCrop | null;
  readonly variants: readonly ProcessorVariant[];
}

/** Mirror of `PublishingJobClaim`. */
export interface PublishingWorkerJobClaim {
  readonly id: string;
  readonly kind: PublishingWorkerJobKind;
  readonly subjectId: string;
  readonly payload: PublishingWorkerDerivePayload | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export type PublishingWorkerJobLease = Pick<
  PublishingWorkerJobClaim,
  "id" | "leaseOwner"
>;

export type PublishingWorkerProcessed = Extract<
  ProcessorOutcome,
  { readonly status: "processed" }
>;
export type PublishingWorkerDerived = Extract<
  ProcessorOutcome,
  { readonly status: "derived" }
>;

/**
 * Mirror of `PublishingProcessingInput`: what the port hands the worker. The
 * worker adds the signal and, for a legacy source, the PNG it read.
 */
export type PublishingWorkerProcessingInput = Omit<
  ProcessorInput,
  "signal" | "legacyStill"
>;

export type PublishingWorkerDerivativeCommit =
  | { readonly status: "recorded" }
  | { readonly status: "discarded"; readonly storageKeys: readonly string[] };

export type PublishingWorkerPurgePlan =
  | { readonly status: "referenced" | "missing" }
  | {
      readonly status: "tombstoned";
      readonly blobs: readonly {
        readonly blobId: string;
        readonly storageKey: string;
      }[];
    };

/** The `WorkPublishingPort` methods the worker uses (structural mirror). */
export interface PublishingWorkerPort {
  readSettings(): Promise<{ readonly orphanGraceDays: number }>;
  reconcileCapacity(accountId: string, now: Date): Promise<unknown>;
  unrecordedStorageKeys(
    storageKeys: readonly string[],
  ): Promise<readonly string[]>;
  expireSession(
    sessionId: string,
    now: Date,
  ): Promise<{
    readonly status: "expired" | "active" | "ended" | "missing";
    readonly cancelledComponentIds: readonly string[];
  }>;
  readProcessing(
    job: Pick<PublishingWorkerJobClaim, "kind" | "subjectId" | "payload">,
  ): Promise<PublishingWorkerProcessingInput | null>;
  /**
   * The user media PNG of a legacy item, read for one `derive_edit` job;
   * `null` for an unknown, purged or uploaded item. A read: the worker never
   * writes user media.
   */
  readLegacyMediaBytes(itemId: string): Promise<Uint8Array | null>;
  markItemReady(
    itemId: string,
    outcome: PublishingWorkerProcessed,
    now: Date,
  ): Promise<PublishingWorkerDerivativeCommit>;
  recordDerivatives(
    itemId: string,
    outcome: PublishingWorkerDerived,
    now: Date,
  ): Promise<PublishingWorkerDerivativeCommit>;
  markItemFailed(
    itemId: string,
    failureCode: MediaFailureCode,
    now: Date,
  ): Promise<void>;
  purgeTrashedWork(
    workId: string,
    now: Date,
  ): Promise<"purged" | "not_due" | "missing">;
  claimJobs(
    options: {
      readonly owner: string;
      readonly limit: number;
      readonly leaseMs: number;
      readonly kinds?: readonly PublishingWorkerJobKind[];
    },
    now: Date,
  ): Promise<readonly PublishingWorkerJobClaim[]>;
  renewJobLease(
    lease: PublishingWorkerJobLease,
    leaseMs: number,
    now: Date,
  ): Promise<boolean>;
  completeJob(lease: PublishingWorkerJobLease, now: Date): Promise<boolean>;
  /**
   * Gives a held lease back without charging an attempt: the job is queued
   * again at `now` with its attempt count restored and its last error code
   * kept; false when the lease was lost (nothing changes then).
   */
  releaseJob(lease: PublishingWorkerJobLease, now: Date): Promise<boolean>;
  failJob(
    lease: PublishingWorkerJobLease,
    errorCode: string,
    now: Date,
    options?: { readonly retryable?: boolean },
  ): Promise<"retry_scheduled" | "failed" | "lease_lost">;
  requeueExpiredJobs(now: Date, limit: number): Promise<number>;
  enqueueJob(
    job: {
      readonly kind: PublishingWorkerJobKind;
      readonly subjectId: string;
      readonly payload?: PublishingWorkerDerivePayload | null;
      readonly runAfter?: Date;
      readonly maxAttempts?: number;
    },
    now: Date,
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  scheduleCleanup(
    now: Date,
    limit: number,
  ): Promise<{
    readonly expireSession: number;
    readonly purgeTrashedWork: number;
    readonly purgeItem: number;
    readonly purgeBlob: number;
  }>;
  purgeItem(itemId: string, now: Date): Promise<PublishingWorkerPurgePlan>;
  purgeBlob(blobId: string, now: Date): Promise<PublishingWorkerPurgePlan>;
  confirmPurged(blobIds: readonly string[], now: Date): Promise<void>;
}

/** The media store operations the worker uses (filesystem store in Development). */
export interface PublishingWorkerStore {
  remove(storageKey: string): Promise<void>;
  listBlobs(options: {
    readonly after?: string | null;
    readonly limit: number;
  }): Promise<{
    readonly entries: readonly PublishingMediaStoreBlobEntry[];
    readonly nextAfter: string | null;
  }>;
  sweepStaging(
    olderThan: Date,
    signal?: AbortSignal,
  ): Promise<{ readonly removed: number }>;
}

export interface PublishingWorkerProcessor {
  process(input: ProcessorInput): Promise<ProcessorOutcome>;
}

/** Sweeps crash leftovers of sandboxed tool jobs (the media tools runner). */
export interface PublishingWorkerToolJobs {
  sweepJobs(olderThan: Date): Promise<{ readonly removed: number }>;
}

/** Injectable timers (defaults: the global timers). */
export interface PublishingWorkerTimers {
  /**
   * `keepAlive` timers hold the process open (bounded shutdown waits); all
   * other timers (polling, lease renewal, cancellation checks) never do.
   */
  setTimeout(
    callback: () => void,
    ms: number,
    options?: { readonly keepAlive?: boolean },
  ): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultPublishingWorkerTimers: PublishingWorkerTimers = {
  setTimeout: (callback, ms, options) => {
    const handle = setTimeout(callback, ms);
    if (!options?.keepAlive) handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Content-free log sink; lines never carry ids, keys, paths or messages. */
export interface PublishingWorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

/** What the worker records for one handled job. */
export type PublishingJobResult =
  | { readonly status: "completed" }
  | {
      readonly status: "failed";
      /** Content-free `^[a-z][a-z0-9_]{0,63}$`. */
      readonly errorCode: string;
      readonly retryable: boolean;
    };

/** Subject of the store-wide `reconcile_capacity` job the worker schedules. */
export const PUBLISHING_STORE_RECONCILE_SUBJECT = "media-store";
/** Subject of the `sweep_staging` job the worker schedules. */
export const PUBLISHING_STAGING_SWEEP_SUBJECT = "staging";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID_PATTERN = /^user-[0-9a-f]{32}$/;
const ITEM_ID_PATTERN = /^media-item-[0-9a-f]{32}$/;
const BLOB_ID_PATTERN = /^media-blob-[0-9a-f]{32}$/;
const SESSION_ID_PATTERN = /^publishing-session-[0-9a-f]{32}$/;
const WORK_ID_PATTERN = /^work-[0-9a-f]{32}$/;
const LEGACY_MEDIA_ID_PATTERN = /^user-media-[0-9a-f]{32}$/;
const STAGING_SWEEP_LIMIT = 1000;
const BLOB_LIST_LIMIT = 1000;

export interface PublishingJobHandlerOptions {
  readonly port: PublishingWorkerPort;
  readonly store: PublishingWorkerStore;
  readonly processor: PublishingWorkerProcessor;
  readonly toolJobs?: PublishingWorkerToolJobs;
  readonly clock?: () => Date;
  readonly timers?: PublishingWorkerTimers;
  readonly logger?: PublishingWorkerLogger;
  /**
   * While an item is processed, how often the handler rechecks that the item
   * still wants processing; a cancelled or purged item aborts the tools early.
   */
  readonly cancellationCheckMs?: number;
  /**
   * Receives component ids whose transfers the upload registry must stop
   * (sessions expired by the worker). Must not throw.
   */
  readonly onUploadsCancelled?: (componentIds: readonly string[]) => void;
  /**
   * Staging files and tool job directories untouched for this long are crash
   * leftovers. Must exceed the job lease and the longest upload stall.
   */
  readonly leftoverAgeMs?: number;
  /** Store pages (1000 keys each) examined per store reconciliation run. */
  readonly reconcilePagesPerRun?: number;
  /**
   * Floor of the orphan blob grace in milliseconds; the effective grace is the
   * larger of this and the configured `orphanGraceDays`.
   */
  readonly minimumOrphanGraceMs?: number;
}

export const PUBLISHING_LEFTOVER_AGE_MS = 6 * 60 * 60 * 1000;
export const PUBLISHING_CANCELLATION_CHECK_MS = 10_000;
export const PUBLISHING_MINIMUM_ORPHAN_GRACE_MS = DAY_MS;

export interface PublishingJobHandlers {
  /**
   * Runs one leased job. Resolves the job's result; rejects with the original
   * error for system failures (the worker classifies and retries them) and
   * with the abort reason when `signal` aborted before a commit.
   */
  run(
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ): Promise<PublishingJobResult>;
  /**
   * Called once the queue recorded the job as permanently `failed` (no retry
   * left, or not retryable), so its subject never waits for a job that will
   * not run again. Rejections are logged by the worker, never retried.
   */
  onJobFailed?(claim: PublishingWorkerJobClaim): Promise<void>;
}

const COMPLETED: PublishingJobResult = { status: "completed" };

const failed = (
  errorCode: string,
  retryable: boolean,
): PublishingJobResult => ({
  status: "failed",
  errorCode,
  retryable,
});

/** Domain rejections the adapters throw inside a transaction, before COMMIT. */
const ROLLED_BACK_ERROR_NAMES = new Set([
  "CommunityInputError",
  "CommunityConflictError",
  "CommunityNotFoundError",
  "TypeError",
  "RangeError",
]);
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * True when a failed commit certainly rolled back: a domain rejection, or a
 * statement error the server itself reported. Lost connections, availability
 * failures (SQLSTATE classes 08 and 57) and errors without a SQLSTATE may have
 * committed after all, so their outcome is unknown.
 */
const rolledBack = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (ROLLED_BACK_ERROR_NAMES.has(error.name)) return true;
  if (error.name === "CommunityStoreUnavailableError") return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    SQLSTATE_PATTERN.test(code) &&
    !code.startsWith("08") &&
    !code.startsWith("57")
  );
};

/** True for an input whose source is a legacy user media item. */
const isLegacySource = (
  input: PublishingWorkerProcessingInput,
): input is PublishingWorkerProcessingInput & {
  readonly source: ProcessorLegacySource;
} =>
  typeof input.source === "object" &&
  input.source !== null &&
  input.source.kind === "legacy_user_media";

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason;
};

/** Abort reason when the item stopped wanting processing mid-run. */
export class PublishingJobCancelledError extends Error {
  constructor() {
    super("Publishing job subject no longer needs processing");
    this.name = "PublishingJobCancelledError";
  }
}

/** A system failure that is safe to retry later with backoff. */
export class PublishingJobSystemError extends Error {
  constructor(readonly code: string) {
    super(`Publishing job system failure: ${code}`);
    this.name = "PublishingJobSystemError";
  }
}

export function createPublishingJobHandlers(
  options: PublishingJobHandlerOptions,
): PublishingJobHandlers {
  const { port, store, processor } = options;
  const clock = options.clock ?? (() => new Date());
  const timers = options.timers ?? defaultPublishingWorkerTimers;
  const cancellationCheckMs =
    options.cancellationCheckMs ?? PUBLISHING_CANCELLATION_CHECK_MS;
  const logger = options.logger ?? console;
  const leftoverAgeMs = options.leftoverAgeMs ?? PUBLISHING_LEFTOVER_AGE_MS;
  const reconcilePagesPerRun = Math.max(1, options.reconcilePagesPerRun ?? 20);
  const minimumOrphanGraceMs =
    options.minimumOrphanGraceMs ?? PUBLISHING_MINIMUM_ORPHAN_GRACE_MS;
  /** Resume point of the store-wide reconciliation across runs (in memory). */
  let reconcileAfter: string | null = null;

  /**
   * Removes derivative blobs that were committed to the store but are not
   * recorded. Only keys without a `media_blobs` row are removed, and keys that
   * cannot be checked wait for store reconciliation.
   */
  const removeUnrecorded = async (storageKeys: readonly string[]) => {
    if (storageKeys.length === 0) return;
    let unrecorded: readonly string[];
    try {
      unrecorded = await port.unrecordedStorageKeys(storageKeys);
    } catch {
      return;
    }
    const produced = new Set(storageKeys);
    await Promise.all(
      unrecorded
        .filter((key) => produced.has(key))
        .map((key) => store.remove(key).catch(() => undefined)),
    );
  };

  /** Removes keys the port declared discarded (nothing recorded them). */
  const removeDiscarded = async (storageKeys: readonly string[]) => {
    const results = await Promise.allSettled(
      storageKeys.map((key) => store.remove(key)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      // Leftovers are unrecorded blobs that store reconciliation removes.
      logger.error(
        `[publishing-worker] discarded derivative removal failed count=${failures.length}`,
      );
    }
  };

  /**
   * Commits a processor outcome. Blobs of a commit that certainly rolled back
   * are removed at once. When the outcome is unknown (the connection dropped
   * around COMMIT) another connection may not see the commit yet, so the
   * blobs stay for store reconciliation, which removes them only when still
   * unrecorded after the orphan grace.
   */
  const commitDerivatives = async (
    storageKeys: readonly string[],
    commit: () => Promise<PublishingWorkerDerivativeCommit>,
  ) => {
    let result: PublishingWorkerDerivativeCommit;
    try {
      result = await commit();
    } catch (error) {
      if (rolledBack(error)) {
        await removeUnrecorded(storageKeys);
      } else if (storageKeys.length > 0) {
        logger.error(
          `[publishing-worker] derivative commit outcome unknown count=${storageKeys.length}`,
        );
      }
      throw error;
    }
    if (result.status === "discarded") {
      await removeDiscarded(result.storageKeys);
    }
  };

  /**
   * Runs the processor under a signal that also aborts when the job's item
   * no longer needs processing (cancelled, purged, or no longer ready for an
   * edit). Resolves `null` for such a cancellation; the processor has then
   * already removed every blob it wrote.
   */
  const runProcessor = async (
    claim: PublishingWorkerJobClaim,
    input: Omit<ProcessorInput, "signal">,
    signal: AbortSignal,
  ): Promise<ProcessorOutcome | null> => {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    let timer: unknown;
    let watching = true;
    const watch = () => {
      timer = timers.setTimeout(() => {
        void port.readProcessing(claim).then(
          (current) => {
            if (!watching) return;
            if (current === null) {
              controller.abort(new PublishingJobCancelledError());
            } else watch();
          },
          () => {
            if (watching) watch();
          },
        );
      }, cancellationCheckMs);
    };
    watch();
    try {
      return await processor.process({ ...input, signal: controller.signal });
    } catch (error) {
      if (
        !signal.aborted &&
        controller.signal.reason instanceof PublishingJobCancelledError
      ) {
        return null;
      }
      throw error;
    } finally {
      watching = false;
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    }
  };

  /**
   * Work that finishes while the job still holds its signal is committed (the
   * shutdown grace lets running jobs finish; every commit rechecks
   * cancellation and existing results). Work that finishes after the job was
   * aborted (lease lost, or released at shutdown) is discarded: its blobs were
   * never recorded, and the job runs again elsewhere.
   */
  const discardIfAborted = async (
    outcome: ProcessorOutcome,
    signal: AbortSignal,
  ) => {
    if (!signal.aborted) return;
    if (outcome.status !== "rejected") {
      await Promise.all(
        outcome.derivatives.map((derivative) =>
          store.remove(derivative.storageKey).catch(() => undefined),
        ),
      );
    }
    throw signal.reason;
  };

  const processItem = async (
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    const input = await port.readProcessing(claim);
    if (input === null) return COMPLETED;
    if (
      input.mode !== "process" ||
      input.itemId !== claim.subjectId ||
      isLegacySource(input)
    ) {
      // Legacy items are ready by construction and only ever derive edits.
      return failed("processing_input_invalid", false);
    }
    throwIfAborted(signal);
    const outcome = await runProcessor(claim, input, signal);
    if (outcome === null) return COMPLETED;
    await discardIfAborted(outcome, signal);
    if (outcome.status === "rejected") {
      await port.markItemFailed(input.itemId, outcome.failureCode, clock());
      return COMPLETED;
    }
    const keys = outcome.derivatives.map((derivative) => derivative.storageKey);
    if (outcome.status !== "processed") {
      await removeUnrecorded(keys);
      return failed("processing_outcome_invalid", false);
    }
    await commitDerivatives(keys, () =>
      port.markItemReady(input.itemId, outcome, clock()),
    );
    return COMPLETED;
  };

  /**
   * Reads the PNG of a legacy item's user media for one edit job, bounded by
   * the declared size (at most the 4 MiB user media bound) and checked to be
   * a PNG before any decoder sees it. Resolves the bytes, or the job result
   * when there is nothing (left) to derive from.
   */
  const readLegacyStill = async (
    claim: PublishingWorkerJobClaim,
    source: ProcessorLegacySource,
  ): Promise<Uint8Array | PublishingJobResult> => {
    if (
      !LEGACY_MEDIA_ID_PATTERN.test(source.legacyMediaId) ||
      source.contentType !== "image/png" ||
      !Number.isSafeInteger(source.byteSize) ||
      source.byteSize < 1 ||
      source.byteSize > LEGACY_USER_MEDIA_MAX_BYTES
    ) {
      return failed("processing_input_invalid", false);
    }
    const bytes = await port.readLegacyMediaBytes(claim.subjectId);
    // The item was purged meanwhile: nothing to derive. (User media cannot
    // disappear under a live item; the item names it through a foreign key.)
    if (bytes === null) return COMPLETED;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== source.byteSize ||
      bytes.byteLength > LEGACY_USER_MEDIA_MAX_BYTES
    ) {
      return failed("size_mismatch", false);
    }
    if (sniffSignature(bytes.subarray(0, 8)).type !== "image/png") {
      return failed("unsupported_type", false);
    }
    return bytes;
  };

  const deriveEdit = async (
    claim: PublishingWorkerJobClaim,
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    const found = await port.readProcessing(claim);
    if (found === null) return COMPLETED;
    if (found.mode !== "derive" || found.itemId !== claim.subjectId) {
      return failed("processing_input_invalid", false);
    }
    let input: Omit<ProcessorInput, "signal"> = found;
    if (isLegacySource(found)) {
      throwIfAborted(signal);
      const still = await readLegacyStill(claim, found.source);
      if (!(still instanceof Uint8Array)) return still;
      input = { ...found, legacyStill: still };
    }
    throwIfAborted(signal);
    const outcome = await runProcessor(claim, input, signal);
    if (outcome === null) return COMPLETED;
    await discardIfAborted(outcome, signal);
    if (outcome.status === "rejected") {
      // Only this edit fails; the item stays ready (no system retry helps).
      return failed(outcome.failureCode, false);
    }
    const keys = outcome.derivatives.map((derivative) => derivative.storageKey);
    if (outcome.status !== "derived") {
      await removeUnrecorded(keys);
      return failed("processing_outcome_invalid", false);
    }
    await commitDerivatives(keys, () =>
      port.recordDerivatives(input.itemId, outcome, clock()),
    );
    return COMPLETED;
  };

  /** Tombstoned blobs: unlink each key, then confirm exactly the removed ones. */
  const finishPurge = async (
    plan: PublishingWorkerPurgePlan,
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    if (plan.status !== "tombstoned") return COMPLETED;
    const removed: string[] = [];
    let failures = 0;
    for (const blob of plan.blobs) {
      if (signal.aborted) break;
      if (!PUBLISHING_BLOB_KEY_PATTERN.test(blob.storageKey)) {
        failures += 1;
        continue;
      }
      try {
        await store.remove(blob.storageKey);
        removed.push(blob.blobId);
      } catch {
        failures += 1;
      }
    }
    if (removed.length > 0) await port.confirmPurged(removed, clock());
    throwIfAborted(signal);
    // Unconfirmed tombstones stay; a retry (or a purge_blob job) finishes them.
    if (failures > 0)
      throw new PublishingJobSystemError("media_store_unavailable");
    return COMPLETED;
  };

  const expireSession = async (
    claim: PublishingWorkerJobClaim,
  ): Promise<PublishingJobResult> => {
    const expiry = await port.expireSession(claim.subjectId, clock());
    if (expiry.cancelledComponentIds.length > 0) {
      try {
        options.onUploadsCancelled?.(expiry.cancelledComponentIds);
      } catch {
        logger.error("[publishing-worker] upload registry notification failed");
      }
    }
    return COMPLETED;
  };

  const sweepLeftovers = async (
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    const cutoff = new Date(clock().getTime() - leftoverAgeMs);
    let staging = 0;
    for (let round = 0; round < 10; round += 1) {
      throwIfAborted(signal);
      const { removed } = await store.sweepStaging(cutoff, signal);
      staging += removed;
      if (removed < STAGING_SWEEP_LIMIT) break;
    }
    let toolJobs = 0;
    if (options.toolJobs) {
      throwIfAborted(signal);
      try {
        toolJobs = (await options.toolJobs.sweepJobs(cutoff)).removed;
      } catch {
        throw new PublishingJobSystemError("tool_jobs_sweep_failed");
      }
    }
    if (staging + toolJobs > 0) {
      logger.info(
        `[publishing-worker] leftovers removed staging=${staging} tool_jobs=${toolJobs}`,
      );
    }
    return COMPLETED;
  };

  /**
   * Store-wide orphan pass: committed store blobs without any `media_blobs`
   * row are reported, and removed once older than the orphan grace. Only
   * well-formed keys the store itself listed are considered, so nothing
   * outside the publishing blob namespace is touched.
   */
  const reconcileStore = async (
    signal: AbortSignal,
  ): Promise<PublishingJobResult> => {
    const settings = await port.readSettings();
    const graceMs = Math.max(
      minimumOrphanGraceMs,
      settings.orphanGraceDays * DAY_MS,
    );
    let unrecordedCount = 0;
    let removedCount = 0;
    let removalFailures = 0;
    for (let page = 0; page < reconcilePagesPerRun; page += 1) {
      throwIfAborted(signal);
      const listing = await store.listBlobs({
        after: reconcileAfter,
        limit: BLOB_LIST_LIMIT,
      });
      const entries = listing.entries.filter((entry) =>
        PUBLISHING_BLOB_KEY_PATTERN.test(entry.storageKey),
      );
      if (entries.length > 0) {
        const unrecorded = new Set(
          await port.unrecordedStorageKeys(
            entries.map((entry) => entry.storageKey),
          ),
        );
        // The row check happens before the age check, so a blob recorded
        // after listing is never old enough to be removed here.
        const cutoff = clock().getTime() - graceMs;
        for (const entry of entries) {
          if (!unrecorded.has(entry.storageKey)) continue;
          unrecordedCount += 1;
          if (entry.modifiedAt.getTime() >= cutoff) continue;
          try {
            await store.remove(entry.storageKey);
            removedCount += 1;
          } catch {
            removalFailures += 1;
          }
        }
      }
      reconcileAfter = listing.nextAfter;
      if (reconcileAfter === null) break;
    }
    if (unrecordedCount > 0) {
      logger.info(
        `[publishing-worker] media store reconciliation unrecorded=${unrecordedCount} removed=${removedCount}`,
      );
    }
    if (removalFailures > 0) {
      throw new PublishingJobSystemError("media_store_unavailable");
    }
    return COMPLETED;
  };

  const invalidSubject = failed("invalid_job_subject", false);

  return {
    async onJobFailed(claim) {
      // A processing job that will not run again fails its item (reservation
      // released) so the author can reset a component instead of waiting.
      if (
        claim.kind === "process_item" &&
        ITEM_ID_PATTERN.test(claim.subjectId)
      ) {
        await port.markItemFailed(
          claim.subjectId,
          "processing_failed",
          clock(),
        );
      }
    },
    async run(claim, signal) {
      throwIfAborted(signal);
      const subject = claim.subjectId;
      switch (claim.kind) {
        case "process_item":
          return ITEM_ID_PATTERN.test(subject)
            ? processItem(claim, signal)
            : invalidSubject;
        case "derive_edit":
          if (claim.payload === null)
            return failed("invalid_job_payload", false);
          return ITEM_ID_PATTERN.test(subject)
            ? deriveEdit(claim, signal)
            : invalidSubject;
        case "purge_item":
          return ITEM_ID_PATTERN.test(subject)
            ? finishPurge(await port.purgeItem(subject, clock()), signal)
            : invalidSubject;
        case "purge_blob":
          return BLOB_ID_PATTERN.test(subject)
            ? finishPurge(await port.purgeBlob(subject, clock()), signal)
            : invalidSubject;
        case "expire_session":
          return SESSION_ID_PATTERN.test(subject)
            ? expireSession(claim)
            : invalidSubject;
        case "purge_trashed_work":
          if (!WORK_ID_PATTERN.test(subject)) return invalidSubject;
          await port.purgeTrashedWork(subject, clock());
          return COMPLETED;
        case "sweep_staging":
          return sweepLeftovers(signal);
        case "reconcile_capacity":
          if (subject === PUBLISHING_STORE_RECONCILE_SUBJECT) {
            return reconcileStore(signal);
          }
          if (!ACCOUNT_ID_PATTERN.test(subject)) return invalidSubject;
          await port.reconcileCapacity(subject, clock());
          return COMPLETED;
        default:
          return failed("unsupported_job_kind", false);
      }
    },
  };
}
