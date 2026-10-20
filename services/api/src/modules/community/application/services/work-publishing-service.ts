import {
  CommunityInputError,
  CommunityNotFoundError,
  isCommunityConflictError,
} from "../errors/community-request-errors.js";
import { CommunityStoreUnavailableError } from "../errors/community-store-unavailable-error.js";
import { mapPublishingLimits } from "../mappers/work-publishing-limits-mapper.js";

import type {
  CreatePublishingDraftCommand,
  CreatePublishingSessionCommand,
  EditableWork,
  MediaComponentRole,
  MediaVariant,
  OpenWorkEditDraftCommand,
  ProfileMediaRenditionRole,
  PublishingDraft,
  PublishingDraftDeletionCommand,
  PublishingDraftDeletionResult,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingHolder,
  PublishingLimits,
  PublishingMediaItem,
  PublishingMediaItemProgress,
  PublishingOpenedEditDraft,
  PublishingPageQuery,
  PublishingReadiness,
  PublishingReadinessCommand,
  PublishingSession,
  PublishingSnapshotPage,
  PublishingUploadResult,
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
import type { PublishingMediaProcessorPort } from "../ports/publishing-media-processor-port.js";
import type {
  PublishingMediaByteRange,
  PublishingMediaReadResult,
  PublishingMediaStoreFailureCode,
  PublishingMediaStorePort,
  PublishingMediaWriteResult,
} from "../ports/publishing-media-store-port.js";
import type {
  ProfileRenditionReadTarget,
  PublishingCommandIdentity,
  PublishingEditReadiness,
  PublishingMediaReadTarget,
  PublishingUploadCommit,
  PublishingUploadFence,
  WorkPublishingPort,
} from "../ports/work-publishing-port.js";

/*
 * Author use cases of work publishing (design.md §3.1, §9.6, §10). Commands
 * and route ids arrive strictly parsed by the transport parsers; the port
 * adapter owns ownership checks, receipts and atomicity. Nothing here logs,
 * and no title, body, file name or storage key leaves through an error.
 *
 * Error meaning at this boundary (the HTTP handler maps the classes):
 * - `CommunityNotFoundError` (404): unknown, foreign or deleted subjects. A
 *   deleted draft is removed, so any late write to it (autosave, save now,
 *   restore, resolve, item registration, submission) is not found.
 * - `CommunityConflictError` (409): the subject exists but moved on (a draft
 *   already submitted, an ended session, a stale base, an upload attempt
 *   that was superseded or cancelled).
 * - `CommunityInputError` (422): the message is one rule code. For media,
 *   `unsupported_type` means a real type failure of the bytes; edits of
 *   legacy items are supported and derived like any other edit.
 */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const storeFailureCodes: ReadonlySet<string> =
  new Set<PublishingMediaStoreFailureCode>([
    "invalid_argument",
    "invalid_key",
    "size_limit_exceeded",
    "size_mismatch",
    "empty_content",
    "aborted",
    "not_regular_file",
    "unavailable",
  ]);

/** The content-free code of a `PublishingMediaStoreError`; nothing else matches. */
const storeFailureCode = (
  error: unknown,
): PublishingMediaStoreFailureCode | undefined => {
  if (
    !(error instanceof Error) ||
    error.name !== "PublishingMediaStoreError" ||
    !("code" in error)
  )
    return undefined;
  const { code } = error as { readonly code: unknown };
  return typeof code === "string" && storeFailureCodes.has(code)
    ? (code as PublishingMediaStoreFailureCode)
    : undefined;
};

/**
 * The author's readiness answer for one content: keys still waiting
 * (placeholders, uploads, processing, derivations in progress), keys that
 * cannot become ready as they are (failed items, failed derivations,
 * cancelled, purged or foreign items) and the non-`base` thumb keys of ready
 * items. `ready` is the port's verdict (every item `ready`).
 */
const mapPublishingReadiness = (
  readiness: PublishingEditReadiness,
): PublishingReadiness => {
  const pendingItemKeys: string[] = [];
  const failedItemKeys: string[] = [];
  const editKeys: Record<string, string> = {};
  for (const item of readiness.items) {
    switch (item.state) {
      case "ready":
        if (item.editKey !== null && item.editKey !== "base")
          editKeys[item.key] = item.editKey;
        break;
      case "failed":
      case "unavailable":
        failedItemKeys.push(item.key);
        break;
      default:
        pendingItemKeys.push(item.key);
    }
  }
  return {
    ready:
      readiness.ready &&
      pendingItemKeys.length === 0 &&
      failedItemKeys.length === 0,
    pendingItemKeys,
    failedItemKeys,
    editKeys,
  };
};

/** Transfer timing of component uploads. */
export interface PublishingTransferPolicy {
  /** A transfer that delivers no byte for this long is ended as stalled. */
  readonly idleTimeoutMs: number;
  /**
   * How long the transport keeps reading (and discarding) a refused
   * transfer's remaining bytes so its early answer reaches a client that is
   * still sending, before the connection closes.
   */
  readonly refusalReadMs: number;
}

const defaultTransferPolicy: PublishingTransferPolicy = {
  idleTimeoutMs: 120_000,
  refusalReadMs: 5_000,
};

/** A derivative ready to stream: its allowlisted type and the opened byte range. */
export interface PublishingMediaDelivery {
  readonly contentType: PublishingMediaReadTarget["contentType"] | "image/png";
  readonly sha256: string;
  readonly read: PublishingMediaReadResult;
}

/** Resolves a derivative read target against the private media store. */
export const openPublishingMedia = async (
  store: PublishingMediaStorePort | undefined,
  resolve: () => Promise<PublishingMediaReadTarget | null>,
  range: PublishingMediaByteRange | undefined,
): Promise<PublishingMediaDelivery> => {
  if (store === undefined) throw new CommunityStoreUnavailableError();
  const target = await resolve();
  if (target === null) throw new CommunityNotFoundError();
  const read = await store.openRead(target.storageKey, range);
  if (read === null) throw new CommunityNotFoundError();
  return { contentType: target.contentType, sha256: target.sha256, read };
};

interface TransferEntry {
  readonly stop: () => void;
  /** Registry sequence at which the fence opened; `null` before that. */
  streamingSince: number | null;
}

/** One transfer registered in a {@link PublishingTransferRegistry}. */
export interface PublishingTransferClaim {
  /**
   * Marks the transfer as streaming once its fence opened (the port accepted
   * the owner's attempt). Only streaming transfers are ever stopped.
   */
  markStreaming(): void;
  /** True while another transfer of the same component streams here. */
  othersStreaming(): boolean;
  /** Idempotent; never releases another transfer. */
  release(): void;
}

/**
 * In-process registry of component transfers. A command that cancels uploads
 * (item cancel, component reset, draft deletion, session discard or expiry)
 * stops the listed transfers that stream here so the transport answers early
 * and nothing is committed. One registry is shared by the HTTP composition and
 * any worker running in the same process.
 *
 * Registering never blocks another request: a transfer counts only after its
 * fence opened, so a caller that does not own the component cannot hold it.
 */
export class PublishingTransferRegistry {
  readonly #entries = new Map<string, Set<TransferEntry>>();
  #sequence = 0;

  /** True while a transfer for this component streams in this process. */
  isActive(componentId: string): boolean {
    for (const entry of this.#entries.get(componentId) ?? [])
      if (entry.streamingSince !== null) return true;
    return false;
  }

  /** Number of transfers registered in this process. */
  get size(): number {
    let size = 0;
    for (const entries of this.#entries.values()) size += entries.size;
    return size;
  }

  /**
   * The current position. Take it before a cancelling transaction and pass it
   * to {@link stop}: a transfer whose fence opened later (a new attempt after
   * a reset) is then never stopped by that command.
   */
  mark(): number {
    return this.#sequence;
  }

  /** Registers one transfer; `stop` runs at most once, synchronously. */
  claim(componentId: string, stop: () => void): PublishingTransferClaim {
    const entry: TransferEntry = { stop, streamingSince: null };
    const entries = this.#entries.get(componentId) ?? new Set<TransferEntry>();
    entries.add(entry);
    this.#entries.set(componentId, entries);
    return {
      markStreaming: () => {
        this.#sequence += 1;
        entry.streamingSince = this.#sequence;
      },
      othersStreaming: () => {
        for (const other of this.#entries.get(componentId) ?? [])
          if (other !== entry && other.streamingSince !== null) return true;
        return false;
      },
      release: () => this.#remove(componentId, entry),
    };
  }

  /**
   * Stops the listed components' streaming transfers; with `before`, only
   * those whose fence opened at or before that {@link mark}. Returns how many
   * stopped.
   */
  stop(
    componentIds: readonly string[],
    options: { readonly before?: number } = {},
  ): number {
    let stopped = 0;
    for (const componentId of new Set(componentIds)) {
      for (const entry of [...(this.#entries.get(componentId) ?? [])]) {
        if (
          entry.streamingSince === null ||
          (options.before !== undefined &&
            entry.streamingSince > options.before)
        )
          continue;
        this.#remove(componentId, entry);
        stopped += 1;
        try {
          entry.stop();
        } catch {
          // One failing stop never keeps the other transfers running.
        }
      }
    }
    return stopped;
  }

  #remove(componentId: string, entry: TransferEntry): void {
    const entries = this.#entries.get(componentId);
    if (entries === undefined || !entries.delete(entry)) return;
    if (entries.size === 0) this.#entries.delete(componentId);
  }
}

/** One component transfer as the transport hands it over. */
export interface PublishingComponentTransfer {
  /** The `x-upload-attempt` UUID. */
  readonly attempt: string;
  /** The transfer's content length; it must equal the declared bytes. */
  readonly contentLength: number;
  /** The raw bytes, consumed at most once. */
  readonly source: AsyncIterable<Uint8Array>;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  /**
   * Called at most once, synchronously, when a cancel in this process stops
   * the transfer; the transport answers 409 at once and stops reading.
   */
  readonly onStopped?: (() => void) | undefined;
}

/**
 * `committed`: stored and recorded. `superseded` / `cancelled`: nothing
 * stored (409). `too_large`: more bytes than declared (413). `incomplete`:
 * fewer bytes than declared (422). `aborted`: the client went away; nothing
 * stored and nobody to answer. `stalled`: no byte arrived within the idle
 * timeout; nothing stored and the transport closes the connection.
 */
export type PublishingComponentUploadOutcome =
  | { readonly status: "committed"; readonly result: PublishingUploadResult }
  | { readonly status: "superseded" | "cancelled" }
  | { readonly status: "too_large" | "incomplete" | "aborted" | "stalled" };

export interface WorkPublishingServiceOptions {
  /** Private media bytes; without it uploads and media reads are unavailable. */
  readonly store?: PublishingMediaStorePort | undefined;
  /** Derivative processing; without it no media item is accepted. */
  readonly processor?: PublishingMediaProcessorPort | undefined;
  /** Shared with a worker in the same process; a private one otherwise. */
  readonly transfers?: PublishingTransferRegistry | undefined;
  readonly clock?: (() => Date) | undefined;
  /** Upload idle timeout and refusal read window; defaults 120 s and 5 s. */
  readonly transferPolicy?: Partial<PublishingTransferPolicy> | undefined;
  /** Receives the content-free upload attempt lines; defaults to `console`. */
  readonly logger?: PublishingUploadLogger | undefined;
}

/**
 * One line per upload attempt that reached the fence, and per refused
 * attempt: outcome, role, size and Backend-side milliseconds only. Lines
 * never carry ids, names, keys, URLs, headers or bytes.
 */
export interface PublishingUploadLogger {
  info(line: string): void;
}

/** Milliseconds between two clock readings, or `-` when one is missing. */
const elapsedMs = (from: Date | null, to: Date | null): string =>
  from === null || to === null
    ? "-"
    : String(Math.max(0, Math.round(to.getTime() - from.getTime())));

const mebibytes = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

const positiveMilliseconds = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

export class WorkPublishingService {
  readonly transfers: PublishingTransferRegistry;
  readonly transferPolicy: PublishingTransferPolicy;
  private readonly store: PublishingMediaStorePort | undefined;
  private readonly processor: PublishingMediaProcessorPort | undefined;
  private readonly clock: () => Date;
  private readonly logger: PublishingUploadLogger;

  constructor(
    private readonly port: WorkPublishingPort,
    options: WorkPublishingServiceOptions = {},
  ) {
    this.store = options.store;
    this.processor = options.processor;
    this.transfers = options.transfers ?? new PublishingTransferRegistry();
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? console;
    const policy = { ...defaultTransferPolicy, ...options.transferPolicy };
    this.transferPolicy = {
      idleTimeoutMs: positiveMilliseconds(
        policy.idleTimeoutMs,
        "idleTimeoutMs",
      ),
      refusalReadMs: positiveMilliseconds(
        policy.refusalReadMs,
        "refusalReadMs",
      ),
    };
  }

  /** True when media items may be registered and uploaded. */
  get acceptsMedia(): boolean {
    return this.store !== undefined && this.processor !== undefined;
  }

  /** True when stored derivatives can be read. */
  get readsMedia(): boolean {
    return this.store !== undefined;
  }

  private mediaStore(): PublishingMediaStorePort {
    if (this.store === undefined || this.processor === undefined)
      throw new CommunityStoreUnavailableError();
    return this.store;
  }

  async limits(): Promise<PublishingLimits> {
    return mapPublishingLimits(await this.port.readSettings());
  }

  createDraft(
    actorId: string,
    command: CreatePublishingDraftCommand,
  ): Promise<PublishingDraft> {
    return this.port.createDraft(actorId, command, this.clock());
  }

  listDrafts(
    actorId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingDraftPage> {
    return this.port.listDrafts(actorId, query);
  }

  readDraft(actorId: string, draftId: string): Promise<PublishingDraft> {
    return this.port.readDraft(actorId, draftId);
  }

  /**
   * Revision-conditional autosave. A deleted draft is not found; a submitted
   * one conflicts; another base keeps both versions (`conflict`).
   */
  saveDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
  ): Promise<PublishingDraftSaveResult> {
    return this.port.saveDraft(actorId, draftId, command, this.clock());
  }

  snapshotDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
  ): Promise<PublishingDraftSaveResult> {
    return this.port.snapshotDraft(actorId, draftId, command, this.clock());
  }

  /**
   * Targeted deletion; with `expectedRevision`, a draft revision that moved
   * past it or an unresolved conflict copy is a
   * `CommunityConflictError("draft_changed")` and deletes nothing.
   */
  async deleteDraft(
    actorId: string,
    draftId: string,
    command: PublishingDraftDeletionCommand,
  ): Promise<PublishingDraftDeletionResult> {
    const before = this.transfers.mark();
    const deletion = await this.port.deleteDraft(
      actorId,
      draftId,
      command,
      this.clock(),
    );
    this.transfers.stop(deletion.cancelledComponentIds, { before });
    return deletion.result;
  }

  listHistory(
    actorId: string,
    draftId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingSnapshotPage> {
    return this.port.listHistory(actorId, draftId, query);
  }

  restoreSnapshot(
    actorId: string,
    draftId: string,
    command: RestorePublishingSnapshotCommand,
  ): Promise<PublishingDraft> {
    return this.port.restoreSnapshot(actorId, draftId, command, this.clock());
  }

  resolveConflict(
    actorId: string,
    draftId: string,
    command: ResolvePublishingConflictCommand,
  ): Promise<PublishingDraft> {
    return this.port.resolveConflict(actorId, draftId, command, this.clock());
  }

  /** The work's edit draft and whether this request created it. */
  openEditDraft(
    actorId: string,
    workId: string,
    command: OpenWorkEditDraftCommand,
  ): Promise<PublishingOpenedEditDraft> {
    return this.port.openEditDraft(actorId, workId, command, this.clock());
  }

  readEditableWork(actorId: string, workId: string): Promise<EditableWork> {
    return this.port.readEditableWork(actorId, workId);
  }

  setVisibility(
    actorId: string,
    workId: string,
    command: WorkVisibilityCommand,
  ): Promise<WorkVisibilityResult> {
    return this.port.setVisibility(actorId, workId, command, this.clock());
  }

  createSession(
    actorId: string,
    command: CreatePublishingSessionCommand,
  ): Promise<PublishingSession> {
    return this.port.createSession(actorId, command, this.clock());
  }

  heartbeatSession(
    actorId: string,
    sessionId: string,
  ): Promise<PublishingSession> {
    return this.port.heartbeatSession(actorId, sessionId, this.clock());
  }

  async discardSession(
    actorId: string,
    sessionId: string,
    command: PublishingCommandIdentity,
  ): Promise<{ readonly discarded: true }> {
    const before = this.transfers.mark();
    const discard = await this.port.discardSession(
      actorId,
      sessionId,
      command,
      this.clock(),
    );
    this.transfers.stop(discard.cancelledComponentIds, { before });
    return discard.result;
  }

  registerItem(
    actorId: string,
    command: RegisterMediaItemCommand,
  ): Promise<PublishingMediaItem> {
    this.mediaStore();
    return this.port.registerItem(actorId, command, this.clock());
  }

  readItemProgress(
    actorId: string,
    itemId: string,
  ): Promise<PublishingMediaItemProgress> {
    return this.port.readItemProgress(actorId, itemId);
  }

  retryItemProcessing(
    actorId: string,
    itemId: string,
    command: PublishingCommandIdentity,
  ): Promise<PublishingMediaItemProgress> {
    return this.port.retryItemProcessing(
      actorId,
      itemId,
      command,
      this.clock(),
    );
  }

  readItem(actorId: string, itemId: string): Promise<PublishingMediaItem> {
    return this.port.readItem(actorId, itemId);
  }

  async cancelItem(
    actorId: string,
    itemId: string,
    command: PublishingCommandIdentity,
  ): Promise<PublishingMediaItem> {
    const before = this.transfers.mark();
    const change = await this.port.cancelItem(
      actorId,
      itemId,
      command,
      this.clock(),
    );
    this.transfers.stop(change.cancelledComponentIds, { before });
    return change.item;
  }

  async resetComponent(
    actorId: string,
    itemId: string,
    role: MediaComponentRole,
    command: PublishingCommandIdentity,
  ): Promise<PublishingMediaItem> {
    this.mediaStore();
    const before = this.transfers.mark();
    const change = await this.port.resetComponent(
      actorId,
      itemId,
      role,
      command,
      this.clock(),
    );
    this.transfers.stop(change.cancelledComponentIds, { before });
    return change.item;
  }

  /**
   * Streams one component behind the attempt/cancel fence: begin (the
   * component becomes `receiving` under this attempt), store the bytes with
   * the declared size as the exact limit, then commit, or abort and remove
   * what was written. A cancel in this process stops the stream early and
   * nothing is committed afterwards; a transfer that delivers no byte within
   * the idle timeout ends as `stalled`.
   */
  async uploadComponent(
    actorId: string,
    componentId: string,
    transfer: PublishingComponentTransfer,
  ): Promise<PublishingComponentUploadOutcome> {
    const store = this.mediaStore();
    if (
      !uuidPattern.test(transfer.attempt) ||
      !Number.isSafeInteger(transfer.contentLength) ||
      transfer.contentLength < 1
    )
      throw new CommunityInputError("invalid_input");

    const controller = new AbortController();
    let stopped = false;
    let stalled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // Registering never blocks anyone: the entry only counts once the port
    // opened the fence, i.e. once the actor is proven to own the component.
    const claim = this.transfers.claim(componentId, () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      transfer.onStopped?.();
    });
    const onClientAbort = () => controller.abort();
    transfer.signal.addEventListener("abort", onClientAbort, { once: true });
    if (transfer.signal.aborted) controller.abort();
    const ended = (): PublishingComponentUploadOutcome =>
      stopped
        ? { status: "cancelled" }
        : stalled
          ? { status: "stalled" }
          : { status: "aborted" };
    const { idleTimeoutMs } = this.transferPolicy;
    const source = transfer.source;
    // Backend-side transfer timing: when the store took the first chunk and
    // when the body ended, both read from the service clock.
    let firstByteAt: Date | null = null;
    let lastByteAt: Date | null = null;
    const idleBounded: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const iterator = source[Symbol.asyncIterator]();
        return {
          next: async () => {
            idleTimer = setTimeout(() => {
              stalled = true;
              controller.abort();
            }, idleTimeoutMs);
            try {
              const next = await iterator.next();
              if (next.done) lastByteAt ??= this.clock();
              else firstByteAt ??= this.clock();
              return next;
            } finally {
              clearTimeout(idleTimer);
            }
          },
          return: async () => {
            await iterator.return?.();
            return { value: undefined, done: true };
          },
        };
      },
    };

    let fence: PublishingUploadFence | undefined;
    let fencedAt: Date | null = null;
    let storedAt: Date | null = null;
    let committedAt: Date | null = null;
    const logged = (
      outcome: PublishingComponentUploadOutcome,
    ): PublishingComponentUploadOutcome => {
      this.logAttempt(
        outcome.status,
        fence,
        fencedAt,
        firstByteAt,
        lastByteAt,
        storedAt,
        committedAt,
      );
      return outcome;
    };
    try {
      fence = await this.beginTransfer(actorId, componentId, transfer, claim);
      fencedAt = this.clock();
      claim.markStreaming();
      if (controller.signal.aborted) {
        await this.abortQuietly(fence);
        return logged(ended());
      }

      let blob: PublishingMediaWriteResult;
      try {
        blob = await store.writeStream(
          fence.ownerId,
          fence.purpose,
          fence.contentType,
          fence.byteSize,
          idleBounded,
          { signal: controller.signal, requireExactSize: true },
        );
      } catch (error) {
        await this.abortQuietly(fence);
        if (controller.signal.aborted) return logged(ended());
        const code = storeFailureCode(error);
        if (code === "size_limit_exceeded")
          return logged({ status: "too_large" });
        if (code === "size_mismatch" || code === "empty_content")
          return logged({ status: "incomplete" });
        this.logAttempt("error", fence, fencedAt, firstByteAt, lastByteAt);
        throw error;
      }
      storedAt = this.clock();

      if (stopped) {
        await this.removeQuietly(store, blob.storageKey);
        await this.abortQuietly(fence);
        return logged({ status: "cancelled" });
      }

      let commit: PublishingUploadCommit;
      try {
        commit = await this.port.commitComponentUpload(
          fence,
          blob,
          storedAt,
          firstByteAt !== null && lastByteAt !== null
            ? { firstByteAt, lastByteAt }
            : undefined,
        );
      } catch (error) {
        // The outcome is unknown: the row may exist although the answer was
        // lost, so the blob stays. Capacity reconciliation removes it after
        // the grace period only when no row records it.
        await this.abortQuietly(fence);
        this.logAttempt(
          "commit_unknown",
          fence,
          fencedAt,
          firstByteAt,
          lastByteAt,
          storedAt,
        );
        throw error;
      }
      committedAt = this.clock();
      if (commit.status === "committed") return logged(commit);
      await this.removeQuietly(store, blob.storageKey);
      return logged(
        commit.status === "size_mismatch"
          ? { status: "too_large" }
          : { status: commit.status },
      );
    } finally {
      clearTimeout(idleTimer);
      transfer.signal.removeEventListener("abort", onClientAbort);
      claim.release();
    }
  }

  /**
   * Opens the fence without taking over first, so ownership is checked before
   * anything else. A component still `receiving` is taken over only when no
   * other transfer of it streams in this process (a transfer that died
   * elsewhere, or before its abort was recorded).
   */
  private async beginTransfer(
    actorId: string,
    componentId: string,
    transfer: PublishingComponentTransfer,
    claim: PublishingTransferClaim,
  ): Promise<PublishingUploadFence> {
    const begin = (supersede: boolean) =>
      this.port.beginComponentUpload(
        actorId,
        componentId,
        {
          attempt: transfer.attempt,
          contentLength: transfer.contentLength,
          supersede,
        },
        this.clock(),
      );
    try {
      return await begin(false);
    } catch (error) {
      // A conflict comes after the ownership check: the actor owns it.
      if (!isCommunityConflictError(error)) throw error;
      if (claim.othersStreaming()) {
        await this.noteRefusal(actorId, componentId, "busy");
        throw error;
      }
    }
    try {
      return await begin(true);
    } catch (error) {
      if (isCommunityConflictError(error))
        await this.noteRefusal(actorId, componentId, "conflict");
      throw error;
    }
  }

  /**
   * Measurement only: a refused transfer of a component that already
   * committed is a resend after a lost answer. It is counted on the
   * component and logged; any failure here leaves the refusal unchanged.
   */
  private async noteRefusal(
    actorId: string,
    componentId: string,
    reason: "busy" | "conflict",
  ): Promise<void> {
    const now = this.clock();
    let committedAt: Date | null = null;
    try {
      committedAt = await this.port.noteUploadRefusedAfterCommit(
        actorId,
        componentId,
        now,
      );
    } catch {
      // The refusal stands without its measurement.
    }
    this.writeLog(
      committedAt === null
        ? `[publishing-upload] attempt outcome=refused reason=${reason}`
        : `[publishing-upload] attempt outcome=refused reason=after_commit since_commit_ms=${elapsedMs(committedAt, now)}`,
    );
  }

  /** One content-free line per fenced upload attempt (see `PublishingUploadLogger`). */
  private logAttempt(
    outcome: string,
    fence: PublishingUploadFence | undefined,
    fencedAt: Date | null,
    firstByteAt: Date | null,
    lastByteAt: Date | null,
    storedAt: Date | null = null,
    committedAt: Date | null = null,
  ): void {
    if (fence === undefined) return;
    this.writeLog(
      `[publishing-upload] attempt outcome=${outcome} role=${fence.role} mib=${mebibytes(fence.byteSize)}` +
        ` first_byte_ms=${elapsedMs(fencedAt, firstByteAt)} last_byte_ms=${elapsedMs(fencedAt, lastByteAt)}` +
        ` store_ms=${elapsedMs(lastByteAt, storedAt)} commit_ms=${elapsedMs(storedAt, committedAt)}`,
    );
  }

  private writeLog(line: string): void {
    try {
      this.logger.info(line);
    } catch {
      // Logging never changes an upload outcome.
    }
  }

  private async abortQuietly(fence: PublishingUploadFence): Promise<void> {
    try {
      await this.port.abortComponentUpload(fence, this.clock());
    } catch {
      // The session lease and cleanup jobs recover a component left receiving.
    }
  }

  private async removeQuietly(
    store: PublishingMediaStorePort,
    storageKey: string,
  ): Promise<void> {
    try {
      await store.remove(storageKey);
    } catch {
      // An unrecorded blob is removed by capacity reconciliation later.
    }
  }

  /** Streams an authorized derivative; sources are never addressable. */
  openMedia(
    viewerId: string | null,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaDelivery> {
    return openPublishingMedia(
      this.store,
      () => this.port.resolveMediaRead(viewerId, itemId, variant, editKey),
      range,
    );
  }

  /**
   * The authorized read of a profile image rendition, resolved before any
   * byte is opened so the route can answer a revalidation from its hash.
   * `null`: not found for this viewer.
   */
  async profileRenditionTarget(
    viewerId: string | null,
    userMediaId: string,
    role: ProfileMediaRenditionRole,
  ): Promise<ProfileRenditionReadTarget | null> {
    if (this.store === undefined) throw new CommunityStoreUnavailableError();
    return this.port.resolveProfileRenditionRead(viewerId, userMediaId, role);
  }

  /** Streams a profile rendition target resolved by `profileRenditionTarget`. */
  openProfileRendition(
    target: ProfileRenditionReadTarget,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaDelivery> {
    return openPublishingMedia(this.store, async () => target, range);
  }

  /**
   * Explicit, idempotent submission, submitted first. The port confirms
   * atomically or answers `not_ready`; a refused submission (deleted or
   * ended holder, stale base, unavailable work, item limit, daily limit)
   * throws before anything is queued. Only a `not_ready` answer ensures the
   * derivatives of the submitted edits (for uploaded and legacy items alike)
   * and, when they are all ready already, submits once more; otherwise the
   * first `not_ready` answer stands while the worker derives them.
   */
  async submit(
    actorId: string,
    command: WorkSubmissionCommand,
  ): Promise<WorkSubmissionResult> {
    const first = await this.port.submit(actorId, command, this.clock());
    if (first.state !== "not_ready") return first;
    const readiness = await this.port.ensureEditDerivatives(
      actorId,
      command.content,
      this.clock(),
    );
    return readiness.ready
      ? this.port.submit(actorId, command, this.clock())
      : first;
  }

  /**
   * Explicit readiness of a holder's current content, so the editor can
   * show and wait for what a submission would refuse as `not_ready`. The
   * port verifies the holder (foreign or deleted: not found; submitted draft
   * or ended session: conflict), starts every missing edit derivative at
   * once (settle-delayed jobs move up to now, as a submission retry does) and
   * reports each item; nothing else changes.
   */
  async readiness(
    actorId: string,
    holder: PublishingHolder,
    command: PublishingReadinessCommand,
  ): Promise<PublishingReadiness> {
    return mapPublishingReadiness(
      await this.port.ensureEditDerivatives(
        actorId,
        command.content,
        this.clock(),
        { holder },
      ),
    );
  }

  async readSubmissionReceipt(
    actorId: string,
    requestId: string,
  ): Promise<WorkSubmissionReceipt> {
    if (!uuidPattern.test(requestId)) throw new CommunityNotFoundError();
    const receipt = await this.port.readSubmissionReceipt(actorId, requestId);
    if (receipt === null) throw new CommunityNotFoundError();
    return receipt;
  }

  deleteWork(
    actorId: string,
    workId: string,
    command: PublishingCommandIdentity,
  ): Promise<{ readonly deleted: true }> {
    return this.port.deleteWork(actorId, workId, command, this.clock());
  }
}
