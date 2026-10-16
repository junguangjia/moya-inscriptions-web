import { pairingDigest } from "./import-grouping";
import { planDraftRestore } from "./local-recovery";
import { extractMediaMetadata, withClientSource } from "./metadata";
import { blobByteReader, readHead } from "./parsers/bytes";
import { readImageHeader } from "./parsers/signature";
import { JPEG_LIMITS, readJpegDimensions } from "./parsers/tiff-exif";
import {
  STANDARD_IMAGE_PROFILE,
  STANDARD_LIVE_PROFILE,
} from "./preprocess/profiles";
import { isRetainableStandardStillType } from "./preprocess/static-image";
import { createExternalStore } from "./upload-manager-store";

import type { BlobHasher } from "./hashing";
import type {
  ConfirmedSource,
  IdentifiedStill,
  LogicalSource,
  StillType,
} from "./import-grouping";
import type {
  LocalRecoveryStore,
  RecoveryRecord,
  RestorePlanEntry,
} from "./local-recovery";
import type { ClientStillFacts } from "./metadata";
import type { MotionPreprocessResult } from "./preprocess/live-motion";
import type { StaticPreprocessResult } from "./preprocess/static-image";
import type { PreprocessPort } from "./preprocess/worker-client";
import type { ExternalStore } from "./upload-manager-store";
import type { TransferOutcome, TransferPort } from "./uppy-transfer";
import type {
  MediaClientPairing,
  MediaClientSource,
  MediaComponentRole,
  MediaContentType,
  MediaFailureCode,
  MediaItemKind,
  MediaMetadata,
  MediaQualityMode,
  PublishingDraft,
  PublishingHolder,
  PublishingMediaItem,
  PublishingMediaItemProgress,
  PublishingMediaProcessingProgress,
  PublishingUploadResult,
  RegisterMediaItemCommand,
  StandardComponentOutcome,
  WorkDraftItem,
} from "@moya/contracts";

/**
 * The account-scoped upload manager (U01–U07, U11 inputs, L04–L05, M04):
 * preprocessing (bounded, in workers), registration with final byte sizes,
 * per-component transfers through the transfer port (Uppy, no automatic
 * retries), server polling until ready or failed, per-item cancellation with
 * an epoch fence against late answers, explicit component retry, explicit
 * Continue after a pause, and saved-draft local recovery. One manager serves
 * exactly one account; any account change pauses it and it never writes for
 * another account.
 */

// ---------------------------------------------------------------------------
// Public view

export type UploadItemPhase =
  /** Confirmed, waiting for a preprocessing slot. */
  | "waiting"
  | "preprocessing"
  /** Standard is not possible in this browser: Upload Original or remove. */
  | "needs_choice"
  | "registering"
  /** Registered, waiting for a transfer slot. */
  | "queued"
  | "uploading"
  /** Every component is on the account; processing not reported yet (100 % ≠ ready). */
  | "uploaded"
  | "processing"
  | "ready"
  | "failed"
  | "paused"
  /** Being cancelled on the account. */
  | "cleanup"
  | "cancelled"
  /** A restored draft item whose bytes are neither on the account nor in this browser. */
  | "missing_local";

export type UploadComponentPhase =
  | "preparing"
  | "queued"
  | "uploading"
  | "received"
  | "failed"
  | "paused"
  | "missing_local"
  | "cancelled";

export interface UploadFailure {
  /** Content-free code (a contract failure code or a client reason). */
  readonly code: string;
  /** Product text. */
  readonly message: string;
  /** The write may have taken effect; the manager re-reads before offering a retry. */
  readonly outcomeUnknown: boolean;
}

export interface UploadComponentView {
  readonly role: MediaComponentRole;
  readonly contentType: MediaContentType | null;
  readonly byteSize: number;
  readonly bytesSent: number;
  readonly standardOutcome: StandardComponentOutcome | null;
  readonly phase: UploadComponentPhase;
  readonly failure: UploadFailure | null;
}

export interface UploadItemView {
  readonly key: string;
  readonly kind: MediaItemKind;
  readonly qualityMode: MediaQualityMode;
  readonly notCameraOriginal: boolean;
  readonly phase: UploadItemPhase;
  readonly itemId: string | null;
  readonly components: readonly UploadComponentView[];
  readonly failure: UploadFailure | null;
  /** Why Standard is unavailable (only in `needs_choice`). */
  readonly choice: { readonly reason: string; readonly message: string } | null;
  /** A local copy was stored and read back (saved drafts only). */
  readonly recoverable: boolean;
  /** Latest owner view of the item (derivative paths once ready). */
  readonly serverItem: PublishingMediaItem | null;
  /** Committed server stages, independent of preview/submission readiness. */
  readonly processing?: PublishingMediaProcessingProgress | null;
  /** A background retry refusal never makes a usable preview fail. */
  readonly processingFailure?: UploadFailure | null;
}

export type UploadManagerStatus = "active" | "paused" | "disposed";

export interface UploadManagerSnapshot {
  readonly accountId: string;
  readonly status: UploadManagerStatus;
  readonly pauseReason: "account" | "offline" | null;
  readonly items: readonly UploadItemView[];
}

// ---------------------------------------------------------------------------
// Ports

/** The publishing client operations the manager uses (§10). */
export interface UploadClientPort {
  registerItem(
    cmd: RegisterMediaItemCommand,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem>;
  item(itemId: string, signal?: AbortSignal): Promise<PublishingMediaItem>;
  /** Optional for legacy adapters that retain the original item-only response. */
  itemProgress?(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItemProgress>;
  retryHighResolution?(
    itemId: string,
    cmd: { requestId: string },
    signal?: AbortSignal,
  ): Promise<PublishingMediaItemProgress>;
  cancelItem(
    itemId: string,
    cmd: { requestId: string },
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem>;
  resetComponent(
    itemId: string,
    role: MediaComponentRole,
    cmd: { requestId: string },
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem>;
  uploadEndpoint(componentId: string): string;
  uploadHeaders(attempt: string): Record<string, string>;
  uploadResult(
    status: number,
    responseText: string,
    account: string,
  ): PublishingUploadResult;
}

export interface UploadSessionBinding {
  readonly saveMode: "saved" | "unsaved";
  /** Resolves the holder, creating the draft or temporary session on first need. */
  resolveHolder(): Promise<PublishingHolder>;
}

export interface UploadTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UploadManagerOptions {
  readonly accountId: string;
  readonly client: UploadClientPort;
  readonly transfer: TransferPort;
  readonly preprocess: PreprocessPort;
  /** The confirmed account right now (`authorClient.account`). */
  readonly currentAccount: () => string | null;
  readonly requestId: () => string;
  readonly attemptId: () => string;
  readonly preprocessConcurrency: number;
  readonly transferConcurrency: number;
  readonly hasher?: BlobHasher | null;
  /** Used for saved drafts only; never consulted in no-save mode. */
  readonly recovery?: LocalRecoveryStore | null;
  readonly metadata?: (
    file: Blob,
    facts: ClientStillFacts,
  ) => Promise<MediaMetadata>;
  readonly timers?: UploadTimers;
  readonly now?: () => number;
}

/** Healthy pending items are checked within five seconds (plus request time). */
export const POLL_DELAYS_MS = [1000, 2000, 3000, 5000];
/** Consecutive failed status checks back off without slowing healthy processing. */
export const POLL_ERROR_DELAYS_MS = [5000, 8000, 13_000, 20_000, 30_000];

// ---------------------------------------------------------------------------
// Product text

const messages = {
  network: "网络连接中断，可继续上传",
  stalled: "上传长时间没有进展，已停止，可重试",
  paused: "上传已暂停，可继续上传",
  accountPaused: "账户状态已变化，上传已暂停",
  integrity: "上传内容校验不一致，请重试",
  preprocess: "图片处理失败，请移除后重新选择",
  decode: "文件无法解码，请移除后重新选择",
  holder: "暂时无法开始上传，请重试",
  missing: "本机没有这个文件，请重新选择",
  unavailable: "这项内容已不可用，请移除",
  resetRefused: "暂时无法重试，请稍后再试",
} as const;

const choiceMessages: Readonly<Record<string, string>> = {
  decode_unsupported:
    "此浏览器无法处理这张 HEIC/HEIF 照片的标准画质，可上传原图或移除",
  encode_unsupported: "此浏览器无法生成标准画质，可上传原图或移除",
  input_too_large: "图片尺寸过大，无法生成标准画质，可上传原图或移除",
  standard_not_smaller: "此文件无法以标准画质缩小，可上传原图或移除",
  webcodecs_unavailable: "此浏览器无法处理实况照片的动态部分，可上传原图或移除",
  video_decode_unsupported: "此浏览器无法解码实况照片的视频，可上传原图或移除",
  video_encode_unsupported:
    "此浏览器无法生成标准画质的动态影像，可上传原图或移除",
  audio_decode_unsupported: "此浏览器无法处理实况照片的声音，可上传原图或移除",
  audio_encode_unsupported: "此浏览器无法保留实况照片的声音，可上传原图或移除",
  color_unsupported:
    "动态影像的色彩格式无法在浏览器中保真处理，可上传原图或移除",
  output_rejected: "浏览器生成的动态影像未通过校验，可上传原图或移除",
};

/** Motion reasons Original cannot fix either (the Backend refuses them too). */
const FINAL_MOTION_REASONS = new Set([
  "stream_layout_unsupported",
  "duration_exceeded",
]);

const mediaFailureMessages: Readonly<Record<MediaFailureCode, string>> = {
  unsupported_type: "格式不支持",
  decode_failed: "文件无法解码",
  dimensions_exceeded: "尺寸超过允许范围",
  duration_exceeded: "实况照片时长超过允许范围",
  stream_layout_unsupported: "实况照片的视频结构不受支持",
  animated_image_unsupported: "暂不支持动图",
  pairing_mismatch: "实况照片的图片与视频不匹配",
  size_mismatch: "文件大小与登记不一致，请重试",
  processing_timeout: "处理超时",
  processing_failed: "处理失败",
};

const finalMotionMessages: Readonly<Record<string, string>> = {
  stream_layout_unsupported: mediaFailureMessages.stream_layout_unsupported,
  duration_exceeded: mediaFailureMessages.duration_exceeded,
};

// ---------------------------------------------------------------------------
// Internal records

interface PreparedComponent {
  readonly role: MediaComponentRole;
  readonly blob: Blob;
  readonly contentType: MediaContentType;
  readonly standardOutcome: StandardComponentOutcome | null;
}

interface ItemRecord {
  view: UploadItemView;
  source: LogicalSource | null;
  epoch: number;
  controller: AbortController;
  prepared: PreparedComponent[] | null;
  pairing: MediaClientPairing | undefined;
  metadata: MediaMetadata | undefined;
  /** How the item was selected; null when unknown (a restored item that was not pasted). */
  clientSource: MediaClientSource | null;
  registerRequestId: string | null;
  componentIds: Map<MediaComponentRole, string>;
  /** Active transfer id per role (component id + attempt). */
  transfers: Map<MediaComponentRole, string>;
  hashes: Map<MediaComponentRole, Promise<string | null>>;
  pollTimer: unknown;
  pollAttempt: number;
  pollFailures: number;
  draftId: string | null;
  backgroundRetryRequestId?: string | null;
  backgroundRetrying?: boolean;
}

/** Local interruption state. Prepared Standard bytes replace the source copy. */
export type UploadCheckpoint = Pick<
  ItemRecord,
  | "view"
  | "source"
  | "prepared"
  | "pairing"
  | "metadata"
  | "clientSource"
  | "registerRequestId"
>;

const TERMINAL: ReadonlySet<UploadItemPhase> = new Set([
  "ready",
  "cancelled",
  "cleanup",
]);

const componentView = (
  role: MediaComponentRole,
  phase: UploadComponentPhase,
): UploadComponentView => ({
  role,
  contentType: null,
  byteSize: 0,
  bytesSent: 0,
  standardOutcome: null,
  phase,
  failure: null,
});

const rolesOf = (
  source: LogicalSource,
  original: boolean,
): MediaComponentRole[] =>
  source.kind === "static"
    ? ["still"]
    : source.layout === "container" && original
      ? ["package"]
      : ["still", "motion"];

interface ErrorShape {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly outcomeUnknown?: unknown;
}

const failureFrom = (
  error: unknown,
  fallback: UploadFailure,
): UploadFailure => {
  const shape = (
    typeof error === "object" && error !== null ? error : {}
  ) as ErrorShape;
  if (typeof shape.message !== "string" || typeof shape.status !== "number")
    return fallback;
  return {
    code:
      typeof shape.code === "string"
        ? shape.code
        : shape.status === 0
          ? "network"
          : `http_${shape.status}`,
    message: shape.message,
    outcomeUnknown: shape.outcomeUnknown === true,
  };
};

const isAccountError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as ErrorShape).status === 401;

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as ErrorShape).status === 404;

/** Processing failures a new upload of the same bytes can fix. */
const RETRYABLE_PROCESSING: ReadonlySet<MediaFailureCode> = new Set([
  "size_mismatch",
  "processing_timeout",
  "processing_failed",
]);

/** Background work never changes whether a verified preview is usable. */
export const hasPendingHighResolution = (item: UploadItemView): boolean =>
  item.phase === "ready" &&
  (item.processingFailure?.code === "progress_refreshing" ||
    (item.processing !== undefined &&
      item.processing !== null &&
      ["waiting", "queued", "processing"].includes(
        item.processing.highResolutionStatus,
      )));

/** Authoritative stages/counts, never a fabricated processing percentage. */
export const processingProgressText = (item: UploadItemView): string | null => {
  const progress = item.processing;
  if (
    item.phase === "ready" &&
    item.processingFailure?.code === "progress_refreshing"
  )
    return "预览可用，正在确认高清图进度";
  if (
    item.phase === "ready" &&
    item.processingFailure?.code === "progress_unavailable"
  )
    return "预览可用，暂时无法确认高清图进度";
  if (progress === undefined || progress === null) return null;
  const count = `已保存 ${progress.completedRenditions} 个图像版本`;
  if (item.phase === "ready") {
    switch (progress.highResolutionStatus) {
      case "waiting":
      case "queued":
        return `预览已就绪，高清图等待处理 · ${count}`;
      case "processing":
        return `预览已就绪，高清图处理中 · ${count}`;
      case "failed":
        return `预览可用，高清图处理失败 · ${count}`;
      case "ready":
      case "not_required":
        return null;
    }
  }
  if (item.phase === "processing" || item.phase === "uploaded") {
    switch (progress.previewStatus) {
      case "waiting":
      case "queued":
        return `等待生成预览 · ${count}`;
      case "processing":
        return `正在生成预览 · ${count}`;
      default:
        return null;
    }
  }
  return null;
};

/** Whether `retryProcessing` applies to this item. */
export const canRetryProcessing = (item: UploadItemView): boolean =>
  item.itemId !== null &&
  item.serverItem?.state === "failed" &&
  item.serverItem.failureCode !== null &&
  RETRYABLE_PROCESSING.has(item.serverItem.failureCode);

const metadataEntry = (metadata: MediaMetadata | undefined) =>
  metadata ? { metadata } : {};

const isAbort = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

const defaultTimers: UploadTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class UploadManager {
  readonly accountId: string;
  readonly store: ExternalStore<UploadManagerSnapshot>;
  private readonly options: UploadManagerOptions;
  private readonly timers: UploadTimers;
  private readonly records = new Map<string, ItemRecord>();
  private readonly order: string[] = [];
  private session: UploadSessionBinding | null = null;
  private draftId: string | null = null;
  private preprocessQueue: string[] = [];
  private preprocessRunning = 0;
  private transferQueue: { key: string; role: MediaComponentRole }[] = [];
  private transferRunning = 0;
  private pollingEnabled = true;
  /** A saved draft is being deleted (switch to no-save): no local copy may be written. */
  private holderChanging = false;
  private status: UploadManagerStatus = "active";
  private pauseReason: "account" | "offline" | null = null;
  /** Late answers that the fence ignored (observable for tests). */
  ignoredLateAnswers = 0;

  constructor(options: UploadManagerOptions) {
    this.options = options;
    this.accountId = options.accountId;
    this.timers = options.timers ?? defaultTimers;
    this.store = createExternalStore<UploadManagerSnapshot>(this.snapshot());
  }

  // -- configuration -------------------------------------------------------

  /** Binds the editor session that owns new items (holder and save mode). */
  bindSession(session: UploadSessionBinding | null): void {
    this.session = session;
  }

  /** The saved draft the local recovery copies belong to (null in no-save mode). */
  setDraftId(draftId: string | null): void {
    this.draftId = draftId;
  }

  setPolling(enabled: boolean): void {
    this.pollingEnabled = enabled;
    for (const record of this.records.values()) {
      if (!enabled) this.stopPolling(record);
      else if (
        record.view.phase === "uploaded" ||
        record.view.phase === "processing" ||
        this.needsBackgroundPoll(record)
      )
        this.schedulePoll(record);
    }
  }

  /**
   * An edited frame can enqueue more derivatives after the base HD finished.
   * Fence the previous frame's status reads and ask again, retaining the
   * verified preview, original identity and committed output count.
   */
  refreshProcessing(keys: readonly string[]): void {
    if (
      this.status === "disposed" ||
      !this.options.client.itemProgress ||
      !this.guardAccount()
    )
      return;
    let changed = false;
    for (const key of new Set(keys)) {
      const record = this.records.get(key);
      if (
        !record ||
        record.view.phase !== "ready" ||
        record.view.kind !== "static" ||
        record.view.itemId === null
      )
        continue;
      this.stopPolling(record);
      this.renew(record);
      record.backgroundRetryRequestId = null;
      record.backgroundRetrying = false;
      record.pollAttempt = 0;
      record.pollFailures = 0;
      this.patch(record, {
        processingFailure: {
          code: "progress_refreshing",
          message: "正在确认当前编辑版本的高清图进度",
          outcomeUnknown: false,
        },
      });
      this.schedulePoll(record);
      changed = true;
    }
    if (changed) this.publish();
  }

  // -- reads ---------------------------------------------------------------

  getSnapshot(): UploadManagerSnapshot {
    return this.store.get();
  }

  /** The local still for previews; the caller owns any object URL it makes. */
  localStill(key: string): Blob | null {
    const record = this.records.get(key);
    const source = record?.source;
    if (!source)
      return record?.prepared?.find((c) => c.role !== "motion")?.blob ?? null;
    return source.still.file;
  }

  checkpoint(): UploadCheckpoint[] {
    return this.order.flatMap((key) => {
      const r = this.records.get(key);
      if (!r || r.view.phase === "cancelled" || r.view.phase === "cleanup")
        return [];
      return [
        {
          view: r.view,
          source: r.prepared ? null : r.source,
          prepared: r.prepared,
          pairing: r.pairing,
          metadata: r.metadata,
          clientSource: r.clientSource,
          registerRequestId: r.registerRequestId,
        },
      ];
    });
  }

  /** Restore without starting a transfer; only Continue resumes interrupted work. */
  async restoreCheckpoint(entries: readonly UploadCheckpoint[]): Promise<void> {
    this.pause("offline");
    for (const entry of entries) {
      const key = entry.view.key;
      if (this.records.has(key)) continue;
      const record: ItemRecord = {
        ...entry,
        epoch: 0,
        controller: new AbortController(),
        componentIds: new Map(
          entry.view.serverItem?.components.map((c) => [c.role, c.id]) ?? [],
        ),
        transfers: new Map(),
        hashes: new Map(),
        pollTimer: null,
        pollAttempt: 0,
        pollFailures: 0,
        draftId: this.draftId,
      };
      this.records.set(key, record);
      this.order.push(key);
      if (record.view.itemId !== null) {
        const read = await this.fetchItem(record, record.epoch);
        if (!this.records.has(key) || !this.guardAccount()) return;
        if (
          read &&
          "item" in read &&
          !["cancelled", "purged"].includes(read.item.state)
        ) {
          record.componentIds = new Map(
            read.item.components.map((c) => [c.role, c.id]),
          );
          this.applyServerItem(record, read.item, false);
          for (const component of record.view.components) {
            if (component.phase !== "received" && record.prepared)
              this.patchComponent(record, component.role, {
                phase: "paused",
                failure: null,
              });
          }
          this.derivePhase(record);
          continue;
        }
        if (
          !read ||
          (!("gone" in read) &&
            (!("item" in read) ||
              !["cancelled", "purged"].includes(read.item.state)))
        ) {
          this.patch(record, {
            phase: "failed",
            failure: {
              code: "network",
              message: "暂时无法确认图片，请重试",
              outcomeUnknown: true,
            },
          });
          continue;
        }
        record.registerRequestId = null;
        record.componentIds.clear();
        this.patch(record, { itemId: null, serverItem: null });
      }
      if (record.view.phase !== "needs_choice")
        this.patch(record, {
          phase: record.prepared || record.source ? "waiting" : "missing_local",
          recoverable: !!(record.prepared || record.source),
        });
    }
    this.publish();
  }

  /**
   * Draft content entries for the current items (pending until registered);
   * a clipboard item carries its presentation provenance.
   */
  draftItems(): Pick<
    WorkDraftItem,
    "key" | "itemId" | "kind" | "qualityMode" | "pendingLabel" | "origin"
  >[] {
    return this.order.flatMap((key) => {
      const record = this.records.get(key);
      if (
        !record ||
        record.view.phase === "cancelled" ||
        record.view.phase === "cleanup"
      )
        return [];
      const { itemId, kind, qualityMode, notCameraOriginal } = record.view;
      const origin = notCameraOriginal ? { origin: "clipboard" as const } : {};
      return [
        itemId === null
          ? {
              key,
              itemId,
              kind,
              qualityMode,
              pendingLabel: kind === "live" ? "live" : "photo",
              ...origin,
            }
          : { key, itemId, kind, qualityMode, ...origin },
      ];
    });
  }

  // -- adding items --------------------------------------------------------

  /** Adds confirmed staging entries; preprocessing starts in bounded slots. */
  addConfirmed(confirmed: readonly ConfirmedSource[]): void {
    if (this.status === "disposed") return;
    for (const entry of confirmed) {
      if (this.records.has(entry.key)) continue;
      const original = entry.qualityMode === "original";
      const record: ItemRecord = {
        view: {
          key: entry.key,
          kind: entry.source.kind,
          qualityMode: entry.qualityMode,
          notCameraOriginal: entry.notCameraOriginal,
          phase: "waiting",
          itemId: null,
          components: rolesOf(entry.source, original).map((role) =>
            componentView(role, "preparing"),
          ),
          failure: null,
          choice: null,
          recoverable: false,
          serverItem: null,
        },
        source: entry.source,
        epoch: 0,
        controller: new AbortController(),
        prepared: null,
        pairing: undefined,
        metadata: undefined,
        clientSource:
          entry.clientSource ?? (entry.notCameraOriginal ? "clipboard" : null),
        registerRequestId: null,
        componentIds: new Map(),
        transfers: new Map(),
        hashes: new Map(),
        pollTimer: null,
        pollAttempt: 0,
        pollFailures: 0,
        draftId: null,
      };
      this.records.set(entry.key, record);
      this.order.push(entry.key);
      this.preprocessQueue.push(entry.key);
    }
    this.publish();
    this.pumpPreprocess();
  }

  /** The explicit choice for an item whose Standard path is unsupported. */
  chooseOriginal(key: string): void {
    const record = this.records.get(key);
    if (!record || record.view.phase !== "needs_choice" || !record.source)
      return;
    this.renew(record);
    this.patch(record, {
      qualityMode: "original",
      phase: "waiting",
      choice: null,
      failure: null,
      components: rolesOf(record.source, true).map((role) =>
        componentView(role, "preparing"),
      ),
    });
    record.prepared = null;
    this.preprocessQueue.push(key);
    this.publish();
    this.pumpPreprocess();
  }

  // -- cancellation --------------------------------------------------------

  /**
   * Cancels one item (never the draft): aborts preprocessing and transfers,
   * fences every later answer, cancels it on the account and removes the
   * local copy.
   */
  async cancelItem(key: string): Promise<void> {
    const record = this.records.get(key);
    if (
      !record ||
      record.view.phase === "cancelled" ||
      record.view.phase === "cleanup"
    )
      return;
    this.renew(record);
    this.abortTransfers(record);
    this.stopPolling(record);
    this.preprocessQueue = this.preprocessQueue.filter(
      (queued) => queued !== key,
    );
    this.transferQueue = this.transferQueue.filter(
      (queued) => queued.key !== key,
    );
    const itemId = record.view.itemId;
    this.patch(record, {
      phase: itemId === null ? "cancelled" : "cleanup",
      components: record.view.components.map((c) =>
        c.phase === "received" ? c : { ...c, phase: "cancelled" },
      ),
    });
    this.publish();
    if (itemId !== null) await this.cancelOnAccount(itemId);
    this.patch(record, { phase: "cancelled" });
    this.publish();
    this.forgetLocalCopy(record);
  }

  /** Drops a cancelled item from the view. */
  forget(key: string): void {
    const record = this.records.get(key);
    if (!record || record.view.phase !== "cancelled") return;
    this.records.delete(key);
    this.order.splice(this.order.indexOf(key), 1);
    this.publish();
  }

  // -- explicit retries ----------------------------------------------------

  /**
   * Retries one failed (or paused) component from its first byte with a new
   * attempt. The item is read first: bytes the account already received are
   * never reset (a reset purges them), a component the account still waits
   * for is simply sent again, and only a stale receiving attempt is reset.
   */
  async retryComponent(key: string, role: MediaComponentRole): Promise<void> {
    const record = this.records.get(key);
    if (!record || this.status === "disposed") return;
    const component = record.view.components.find((c) => c.role === role);
    if (
      !component ||
      (component.phase !== "failed" && component.phase !== "paused") ||
      record.view.itemId === null ||
      record.view.serverItem?.state === "failed"
    )
      return;
    await this.restartComponent(record, role);
  }

  /** Retry durable HD work only; never reset or resend an original component. */
  async retryHighResolution(key: string): Promise<void> {
    const record = this.records.get(key);
    const retry = this.options.client.retryHighResolution;
    if (
      !record ||
      !retry ||
      record.backgroundRetrying ||
      record.view.phase !== "ready" ||
      record.view.processing?.highResolutionStatus !== "failed" ||
      record.view.processingFailure?.code === "progress_refreshing" ||
      record.view.itemId === null ||
      this.status === "disposed" ||
      !this.guardAccount()
    )
      return;
    if (this.status === "paused") this.resume();
    const epoch = record.epoch;
    record.backgroundRetrying = true;
    record.backgroundRetryRequestId ??= this.options.requestId();
    this.patch(record, { processingFailure: null });
    this.publish();
    try {
      const progress = await retry(
        record.view.itemId,
        {
          requestId: record.backgroundRetryRequestId,
        },
        record.controller.signal,
      );
      if (
        !this.alive(record, epoch) ||
        !this.guardAccount() ||
        this.status !== "active"
      )
        return;
      this.patch(record, {
        processing: progress.processing,
        processingFailure: null,
      });
      record.backgroundRetryRequestId = null;
      this.applyServerItem(record, progress.item, false);
    } catch (error) {
      if (!this.alive(record, epoch) || !this.guardAccount()) return;
      if (isAccountError(error)) {
        this.pause("account");
        return;
      }
      // A lost retry response may already have enqueued work. Re-read the
      // same item before offering the same idempotent command again.
      const read = await this.fetchItem(record, epoch);
      if (!this.alive(record, epoch) || !this.guardAccount()) return;
      if (read && "item" in read)
        this.applyServerItem(record, read.item, false);
      else if (read && "account" in read) {
        this.pause("account");
        return;
      } else if (read && "gone" in read) {
        this.markUnavailable(record);
        return;
      }
      if (
        record.view.processing?.highResolutionStatus !== "failed" ||
        (error as { outcomeUnknown?: boolean }).outcomeUnknown !== true
      )
        record.backgroundRetryRequestId = null;
      if (record.view.processing?.highResolutionStatus === "failed") {
        this.patch(record, {
          processingFailure: failureFrom(error, {
            code: "background_retry_refused",
            message: "暂时无法重试高清图，预览仍可使用",
            outcomeUnknown: false,
          }),
        });
        this.publish();
      }
    } finally {
      record.backgroundRetrying = false;
    }
  }

  /**
   * Explicitly re-sends an item the account failed to process for a reason a
   * new upload can fix (size mismatch, timeout, processing failure): every
   * component with local bytes is reset and sent again from its first byte.
   */
  async retryProcessing(key: string): Promise<void> {
    const record = this.records.get(key);
    const itemId = record?.view.itemId ?? null;
    if (
      !record ||
      itemId === null ||
      this.status === "disposed" ||
      !canRetryProcessing(record.view)
    )
      return;
    const roles = record.view.components
      .map((c) => c.role)
      .filter((role) => record.prepared?.some((c) => c.role === role));
    if (roles.length === 0) {
      this.fail(record, {
        code: "missing_local",
        message: messages.missing,
        outcomeUnknown: false,
      });
      return;
    }
    if (!this.guardAccount()) return;
    if (this.status === "paused") this.resume();
    const epoch = record.epoch;
    this.stopPolling(record);
    for (const role of roles)
      this.patchComponent(record, role, {
        phase: "queued",
        failure: null,
        bytesSent: 0,
      });
    this.patch(record, { phase: "queued", failure: null });
    this.publish();
    let item: PublishingMediaItem | null = null;
    for (const role of roles) {
      try {
        item = await this.options.client.resetComponent(itemId, role, {
          requestId: this.options.requestId(),
        });
      } catch (error) {
        if (!this.alive(record, epoch)) return;
        const accountChanged = isAccountError(error);
        const read = accountChanged
          ? null
          : await this.fetchItem(record, epoch);
        if (!this.alive(record, epoch)) return;
        for (const other of roles)
          this.patchComponent(record, other, {
            phase: "failed",
            failure: null,
          });
        if (read !== null && "item" in read)
          this.applyServerItem(record, read.item, false);
        const code = record.view.serverItem?.failureCode ?? null;
        this.fail(
          record,
          accountChanged && item === null && code !== null
            ? // Nothing was reset: the processing failure stands.
              {
                code,
                message: mediaFailureMessages[code],
                outcomeUnknown: false,
              }
            : failureFrom(error, {
                code: "reset_refused",
                message: messages.resetRefused,
                outcomeUnknown: false,
              }),
        );
        if (accountChanged) this.pause("account");
        return;
      }
      if (!this.alive(record, epoch)) return;
    }
    this.applyServerItem(record, item!, false);
    for (const server of item!.components)
      if (server.state === "awaiting" && roles.includes(server.role))
        this.enqueueTransfer(record, server.role);
  }

  private async restartComponent(
    record: ItemRecord,
    role: MediaComponentRole,
  ): Promise<void> {
    const itemId = record.view.itemId!;
    if (!record.prepared?.some((c) => c.role === role)) {
      this.patchComponent(record, role, {
        phase: "missing_local",
        failure: {
          code: "missing_local",
          message: messages.missing,
          outcomeUnknown: false,
        },
      });
      this.derivePhase(record);
      this.publish();
      return;
    }
    if (!this.guardAccount()) return;
    if (this.status === "paused") this.resume();
    const epoch = record.epoch;
    this.patchComponent(record, role, {
      phase: "queued",
      failure: null,
      bytesSent: 0,
    });
    this.derivePhase(record);
    this.publish();
    const failComponent = (failure: UploadFailure) => {
      this.patchComponent(record, role, { phase: "failed", failure });
      this.derivePhase(record);
      this.publish();
    };
    // Read first: Continue must never discard bytes the account already has (U05).
    const read = await this.fetchItem(record, epoch);
    if (read === null) return;
    if ("account" in read) {
      this.pause("account");
      return;
    }
    if ("gone" in read) {
      this.markUnavailable(record);
      return;
    }
    if ("error" in read) {
      failComponent(
        failureFrom(read.error, {
          code: "network",
          message: messages.network,
          outcomeUnknown: true,
        }),
      );
      return;
    }
    let item = read.item;
    let server = item.components.find((c) => c.role === role);
    if (
      !server ||
      item.state !== "awaiting_upload" ||
      server.state === "received" ||
      server.state === "verified"
    ) {
      // Received meanwhile, processing, ready, failed or gone: the account decides.
      if (item.state === "failed")
        this.patchComponent(record, role, { phase: "failed", failure: null });
      this.applyServerItem(record, item, true);
      return;
    }
    if (server.state !== "awaiting") {
      // A stale receiving attempt (or a refused one) is reset before a new attempt.
      try {
        item = await this.options.client.resetComponent(itemId, role, {
          requestId: this.options.requestId(),
        });
      } catch (error) {
        if (!this.alive(record, epoch)) return;
        if (isAccountError(error)) {
          this.pause("account");
          return;
        }
        const again = await this.fetchItem(record, epoch);
        if (again === null) return;
        const refreshed =
          "item" in again
            ? again.item.components.find((c) => c.role === role)
            : undefined;
        if ("item" in again && refreshed?.state !== "awaiting") {
          if (
            refreshed?.state === "received" ||
            refreshed?.state === "verified"
          )
            this.applyServerItem(record, again.item, true);
          else {
            this.patchComponent(record, role, {
              phase: "failed",
              failure: failureFrom(error, {
                code: "reset_refused",
                message: messages.resetRefused,
                outcomeUnknown: false,
              }),
            });
            this.applyServerItem(record, again.item, true, role);
          }
          return;
        }
        if (!("item" in again)) {
          failComponent(
            failureFrom(error, {
              code: "reset_refused",
              message: messages.resetRefused,
              outcomeUnknown: false,
            }),
          );
          return;
        }
        item = again.item;
      }
      if (!this.alive(record, epoch)) return;
      server = item.components.find((c) => c.role === role);
      this.applyServerItem(record, item, false);
      if (server?.state !== "awaiting") return;
    }
    this.enqueueTransfer(record, role);
  }

  /** Retries a failed registration (the same request identity when its outcome was unknown). */
  retryRegistration(key: string): void {
    const record = this.records.get(key);
    if (
      !record ||
      record.view.phase !== "failed" ||
      record.view.itemId !== null
    )
      return;
    if (!record.prepared) {
      this.preprocessQueue.push(key);
      this.patch(record, { phase: "waiting", failure: null });
      this.publish();
      this.pumpPreprocess();
      return;
    }
    if (record.view.failure && !record.view.failure.outcomeUnknown)
      record.registerRequestId = null;
    void this.register(record, record.epoch);
  }

  /**
   * The explicit Continue after a pause, a lost connection or a stall:
   * resumes the queues and retries every component that stopped for those
   * reasons. Nothing resumes without this call.
   */
  async continueUploads(): Promise<void> {
    if (this.status === "disposed" || !this.guardAccount()) return;
    this.resume();
    const retries: Promise<void>[] = [];
    for (const key of this.order) {
      const record = this.records.get(key)!;
      if (
        record.view.phase === "waiting" &&
        !this.preprocessQueue.includes(key)
      )
        this.preprocessQueue.push(key);
      if (
        record.view.phase === "failed" &&
        record.view.itemId === null &&
        record.view.failure?.outcomeUnknown
      )
        this.retryRegistration(key);
      for (const component of record.view.components)
        if (
          component.phase === "paused" ||
          (component.phase === "failed" &&
            (component.failure?.code === "network" ||
              component.failure?.code === "stalled" ||
              component.failure?.outcomeUnknown === true))
        )
          retries.push(this.retryComponent(key, component.role));
    }
    this.pumpPreprocess();
    await Promise.all(retries);
  }

  /**
   * Before a saved draft is deleted (switch to no-save): transfers abort,
   * registrations in flight are fenced back to waiting and no local copy is
   * written. When the deletion fails the manager stays paused (explicit
   * Continue); when it succeeds `detachFromHolder` follows.
   */
  suspendForHolderChange(): void {
    if (this.status === "disposed") return;
    this.pause("offline");
    this.holderChanging = true;
    for (const record of this.records.values())
      if (record.view.phase === "registering") {
        this.renew(record);
        this.patch(record, { phase: "waiting" });
      }
    this.publish();
  }

  /** The deletion did not happen: local copies may be written again (uploads wait for Continue). */
  cancelHolderChange(): void {
    this.holderChanging = false;
  }

  /**
   * The saved draft was deleted (switch to no-save). Items the account still
   * has — media of the published work an edit draft started from — keep
   * their identity; items that went with the draft register again under the
   * next holder from local bytes, and items without local bytes need
   * re-selection. An item that cannot be read is kept as it is: account
   * media is never dropped on a guess.
   */
  async detachFromHolder(): Promise<void> {
    if (this.status === "disposed") return;
    const records = [...this.records.values()].filter(
      (record) =>
        record.view.phase !== "cancelled" && record.view.phase !== "cleanup",
    );
    const epochs = new Map<ItemRecord, number>();
    for (const record of records) {
      this.renew(record);
      this.abortTransfers(record);
      this.stopPolling(record);
      epochs.set(record, record.epoch);
    }
    this.transferQueue = [];
    this.preprocessQueue = [];
    const reads = new Map<
      string,
      Awaited<ReturnType<UploadManager["fetchItem"]>>
    >();
    await Promise.all(
      records.map(async (record) => {
        if (record.view.itemId !== null)
          reads.set(
            record.view.key,
            await this.fetchItem(record, epochs.get(record)!),
          );
      }),
    );
    for (const record of records) {
      // Cancelled or dropped while reading: that newer intent stands.
      if (!this.alive(record, epochs.get(record)!)) continue;
      const read = reads.get(record.view.key);
      if (read && "item" in read) {
        const { state } = read.item;
        if (state !== "cancelled" && state !== "purged") {
          // It survived the deletion: it belongs to the work, not the draft.
          record.draftId = null;
          this.patch(record, { recoverable: false });
          this.applyServerItem(record, read.item, false);
          continue;
        }
      } else if (read !== undefined && !(read !== null && "gone" in read)) {
        // Unreadable now (network, account): keep the account identity.
        continue;
      }
      // Waiting for a choice, or failed before any registration (e.g. undecodable): unchanged.
      if (
        record.view.itemId === null &&
        (record.view.phase === "needs_choice" ||
          (record.view.phase === "failed" && record.prepared === null))
      )
        continue;
      record.componentIds = new Map();
      record.registerRequestId = null;
      record.hashes = new Map();
      record.draftId = null;
      const hasBytes = record.prepared !== null || record.source !== null;
      this.patch(record, {
        itemId: null,
        serverItem: null,
        recoverable: false,
        failure: hasBytes
          ? null
          : {
              code: "missing_local",
              message: messages.missing,
              outcomeUnknown: false,
            },
        phase: hasBytes ? "waiting" : "missing_local",
        components: record.view.components.map((component) => ({
          ...component,
          bytesSent: 0,
          failure: null,
          phase: hasBytes ? "preparing" : "missing_local",
        })),
      });
      if (hasBytes) this.preprocessQueue.push(record.view.key);
    }
    this.holderChanging = false;
    // The author's switch implies registering again under the new holder.
    if (this.status === "paused" && this.pauseReason === "offline")
      this.resume();
    this.publish();
    this.pumpPreprocess();
  }

  // -- pause / dispose ------------------------------------------------------

  /**
   * Pauses all work: transfers abort, preprocessing stops, nothing resumes by
   * itself. Every registered component that was queued or being sent ends
   * `paused`, whichever path stopped it (an aborted transfer, a refused
   * answer, a component taken off the queue), so the explicit Continue finds
   * it; a component whose bytes may have arrived is re-read before any reset.
   */
  pause(reason: "account" | "offline"): void {
    if (this.status === "disposed") return;
    this.status = "paused";
    this.pauseReason = reason;
    const message =
      reason === "account" ? messages.accountPaused : messages.paused;
    for (const record of this.records.values()) {
      this.stopPolling(record);
      if (record.view.phase === "preprocessing") {
        this.renew(record);
        this.patch(record, { phase: "waiting" });
      }
      const sending = new Set(record.transfers.keys());
      for (const transferId of record.transfers.values()) {
        this.options.transfer.abort(transferId);
        this.transferRunning = Math.max(0, this.transferRunning - 1);
      }
      record.transfers.clear();
      if (record.view.itemId !== null && !TERMINAL.has(record.view.phase))
        for (const component of record.view.components)
          if (component.phase === "uploading" || component.phase === "queued")
            this.patchComponent(record, component.role, {
              phase: "paused",
              failure: {
                code: "paused",
                message,
                outcomeUnknown:
                  component.phase === "uploading" ||
                  sending.has(component.role),
              },
            });
      this.derivePhase(record);
    }
    this.transferQueue = [];
    this.preprocessQueue = [];
    this.publish();
  }

  /**
   * Drops every item without any account write, when the editor session that
   * owned them has ended; local work stops and late answers are fenced.
   */
  release(): void {
    for (const record of this.records.values()) {
      this.renew(record);
      this.abortTransfers(record);
      this.stopPolling(record);
    }
    this.records.clear();
    this.order.length = 0;
    this.preprocessQueue = [];
    this.transferQueue = [];
    this.publish();
  }

  /**
   * Leaves a pause that interrupted nothing (no item waits, no component was
   * stopped), e.g. an account switch back before any selection. Anything
   * that was interrupted still needs the explicit Continue.
   */
  resumeIfIdle(): boolean {
    if (this.status !== "paused") return this.status === "active";
    const interrupted = [...this.records.values()].some(
      (record) =>
        record.view.phase === "waiting" ||
        record.view.phase === "registering" ||
        record.view.components.some(
          (component) =>
            component.phase === "paused" ||
            component.phase === "queued" ||
            component.phase === "uploading",
        ),
    );
    if (interrupted) return false;
    this.resume();
    return true;
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.pause("account");
    this.status = "disposed";
    for (const record of this.records.values()) this.renew(record);
    this.options.transfer.dispose();
    this.publish();
  }

  // -- restore -------------------------------------------------------------

  /**
   * Reopens a saved draft on this browser: account media wins, local copies
   * make unfinished items recoverable (explicit Continue), everything else is
   * reported as needing re-selection.
   */
  async restoreDraft(draft: PublishingDraft): Promise<RestorePlanEntry[]> {
    this.draftId = draft.id;
    const recovery =
      this.session?.saveMode === "saved"
        ? (this.options.recovery ?? null)
        : null;
    const records: RecoveryRecord[] = recovery
      ? await recovery.list(this.accountId, draft.id).catch(() => [])
      : [];
    const plan = planDraftRestore(
      draft.content.items,
      draft.mediaItems,
      records,
    );
    // Copies for items that are on the account, unavailable or no longer in the draft are stale.
    if (recovery)
      for (const stale of records)
        if (!plan.some((entry) => entry.record === stale))
          void recovery
            .remove(this.accountId, draft.id, stale.itemKey)
            .catch(() => undefined);
    for (const entry of plan) {
      if (this.records.has(entry.itemKey)) continue;
      const content = draft.content.items.find(
        (item) => item.key === entry.itemKey,
      )!;
      const server = entry.serverItem;
      const roles: MediaComponentRole[] =
        server?.components.map((c) => c.role) ??
        (content.kind === "live" ? ["still", "motion"] : ["still"]);
      const record: ItemRecord = {
        view: {
          key: entry.itemKey,
          kind: content.kind,
          qualityMode: content.qualityMode,
          // The clipboard label survives a restore through the draft content.
          notCameraOriginal: content.origin === "clipboard",
          phase: "missing_local",
          itemId: content.itemId,
          components: roles.map((role) => componentView(role, "missing_local")),
          failure: null,
          choice: null,
          recoverable: entry.disposition === "recoverable",
          serverItem: server,
        },
        source: null,
        epoch: 0,
        controller: new AbortController(),
        prepared:
          entry.record?.components.map((c) => ({
            role: c.role,
            blob: c.blob,
            contentType: c.contentType,
            standardOutcome: c.standardOutcome ?? null,
          })) ?? null,
        pairing: undefined,
        metadata: undefined,
        clientSource: content.origin === "clipboard" ? "clipboard" : null,
        registerRequestId: null,
        componentIds: new Map(
          server?.components.map((c) => [c.role, c.id]) ?? [],
        ),
        transfers: new Map(),
        hashes: new Map(),
        pollTimer: null,
        pollAttempt: 0,
        pollFailures: 0,
        draftId: draft.id,
      };
      this.records.set(entry.itemKey, record);
      this.order.push(entry.itemKey);
      if (entry.disposition === "unavailable") {
        this.patch(record, {
          phase: "failed",
          failure: {
            code: "unavailable",
            message: messages.unavailable,
            outcomeUnknown: false,
          },
        });
      } else if (server !== null) {
        this.applyServerItem(record, server, false);
        if (entry.disposition === "recoverable") {
          for (const component of record.view.components)
            if (component.phase !== "received")
              this.patchComponent(record, component.role, {
                phase: "paused",
                byteSize:
                  server.components.find((c) => c.role === component.role)
                    ?.byteSize ?? 0,
                failure: {
                  code: "paused",
                  message: messages.paused,
                  outcomeUnknown: false,
                },
              });
          this.derivePhase(record);
        } else if (entry.disposition === "must_reselect") {
          for (const component of record.view.components)
            if (component.phase !== "received")
              this.patchComponent(record, component.role, {
                phase: "missing_local",
                failure: {
                  code: "missing_local",
                  message: messages.missing,
                  outcomeUnknown: false,
                },
              });
          this.derivePhase(record);
        }
      }
    }
    this.publish();
    return plan;
  }

  // -- preprocessing -------------------------------------------------------

  private pumpPreprocess(): void {
    while (
      this.status === "active" &&
      this.preprocessRunning < this.options.preprocessConcurrency &&
      this.preprocessQueue.length > 0
    ) {
      const key = this.preprocessQueue.shift()!;
      const record = this.records.get(key);
      if (!record || record.view.phase !== "waiting") continue;
      if (record.prepared !== null) {
        // Prepared before a pause: register without preprocessing again.
        void this.register(record, record.epoch);
        continue;
      }
      this.preprocessRunning += 1;
      const epoch = record.epoch;
      this.patch(record, { phase: "preprocessing" });
      this.publish();
      this.prepare(record, epoch)
        .catch(() => undefined)
        .finally(() => {
          this.preprocessRunning -= 1;
          this.pumpPreprocess();
        });
    }
  }

  private async prepare(record: ItemRecord, epoch: number): Promise<void> {
    const source = record.source;
    if (!source) return;
    const original = record.view.qualityMode === "original";
    const signal = record.controller.signal;
    const still = source.still;
    const facts: ClientStillFacts = {
      appleMakerNote: still.appleMakerNote,
      livePhotoIdentifier: still.contentIdentifier !== null,
      exifOrientation: still.orientation,
    };
    const metadataTask = (this.options.metadata ?? extractMediaMetadata)(
      still.file,
      facts,
    ).catch(() => undefined);
    let components: PreparedComponent[];
    try {
      components = original
        ? this.originalComponents(source)
        : await this.standardComponents(record, source, signal);
    } catch (error) {
      if (!this.alive(record, epoch) || isAbort(error)) return;
      this.fail(record, {
        code: "preprocess_failed",
        message: messages.preprocess,
        outcomeUnknown: false,
      });
      return;
    }
    if (!this.alive(record, epoch) || record.view.phase !== "preprocessing")
      return;
    const metadata = await metadataTask;
    // A pause or cancel during extraction renewed the item: nothing half-prepared is kept.
    if (!this.alive(record, epoch) || record.view.phase !== "preprocessing")
      return;
    record.prepared = components;
    record.pairing = this.pairingFor(source);
    record.metadata = metadata;
    this.patch(record, {
      components: components.map((component) => ({
        role: component.role,
        contentType: component.contentType,
        byteSize: component.blob.size,
        bytesSent: 0,
        standardOutcome: component.standardOutcome,
        phase: "queued",
        failure: null,
      })),
    });
    await this.register(record, epoch);
  }

  private originalComponents(source: LogicalSource): PreparedComponent[] {
    if (source.kind === "static")
      return [
        {
          role: "still",
          // Static presentation does not permit altering an Original source.
          // Any embedded motion remains private and is not a playback component.
          blob: source.still.file,
          contentType: source.still.type,
          standardOutcome: null,
        },
      ];
    if (source.layout === "container")
      return [
        {
          role: "package",
          blob: source.still.file,
          contentType: source.still.type,
          standardOutcome: null,
        },
      ];
    return [
      {
        role: "still",
        blob: source.still.file,
        contentType: source.still.type,
        standardOutcome: null,
      },
      {
        role: "motion",
        blob: source.motion.file,
        contentType: source.motion.type,
        standardOutcome: null,
      },
    ];
  }

  /** Standard components, or throws after moving the item to a choice or failure. */
  private async standardComponents(
    record: ItemRecord,
    source: LogicalSource,
    signal: AbortSignal,
  ): Promise<PreparedComponent[]> {
    const still = source.still;
    const stillBlob =
      still.motionPhoto !== null
        ? still.file.slice(0, still.motionPhoto.primaryLength, still.type)
        : still.file;
    const stillResult = await this.preprocessStill(stillBlob, still, signal);
    const stillComponent = this.stillComponent(
      record,
      stillBlob,
      still.type,
      stillResult,
    );
    if (source.kind === "static") return [stillComponent];
    const motionBlob =
      source.layout === "container"
        ? still.file.slice(
            source.still.motionPhoto.videoStart,
            source.still.motionPhoto.videoStart +
              source.still.motionPhoto.videoLength,
            source.still.motionPhoto.videoType,
          )
        : source.motion.file;
    const motionResult = await this.options.preprocess.motion(
      motionBlob,
      signal,
    );
    return [stillComponent, this.motionComponent(record, motionResult)];
  }

  private async preprocessStill(
    blob: Blob,
    still: IdentifiedStill,
    signal: AbortSignal,
  ): Promise<StaticPreprocessResult> {
    const reader = blobByteReader(blob);
    let dimensions: { width: number; height: number } | null = null;
    let mayHaveAlpha = still.type !== "image/jpeg";
    try {
      if (still.type === "image/jpeg") {
        dimensions = readJpegDimensions(
          await readHead(reader, JPEG_LIMITS.maxHeaderBytes),
        );
      } else if (still.type === "image/png" || still.type === "image/webp") {
        const header = await readImageHeader(reader, still.type);
        dimensions = header.dimensions;
        mayHaveAlpha = header.mayHaveAlpha;
      }
    } catch {
      dimensions = null;
    }
    return this.options.preprocess.still(
      {
        file: blob,
        sourceType: still.type,
        exifOrientation: still.orientation,
        headerDimensions: dimensions,
        mayHaveAlpha,
      },
      signal,
    );
  }

  private stillComponent(
    record: ItemRecord,
    blob: Blob,
    type: StillType,
    result: StaticPreprocessResult,
  ): PreparedComponent {
    if (result.status === "optimized")
      return {
        role: "still",
        blob: result.blob,
        contentType: result.contentType,
        standardOutcome: "optimized",
      };
    if (result.status === "retained") {
      // Only an already-small JPEG/PNG/WebP may leave unchanged as Standard;
      // a HEIC/HEIF source is an explicit choice, never sent silently (D3).
      if (isRetainableStandardStillType(type))
        return {
          role: "still",
          blob,
          contentType: type,
          standardOutcome: "retained",
        };
      this.needsChoice(record, "standard_not_smaller");
    } else if (result.status === "unsupported")
      this.needsChoice(record, result.reason);
    else
      this.fail(record, {
        code: result.reason,
        message:
          result.reason === "decode_failed"
            ? messages.decode
            : messages.preprocess,
        outcomeUnknown: false,
      });
    throw new DOMException("choice", "AbortError");
  }

  private motionComponent(
    record: ItemRecord,
    result: MotionPreprocessResult,
  ): PreparedComponent {
    if (result.status === "optimized")
      return {
        role: "motion",
        blob: result.blob,
        contentType: "video/mp4",
        standardOutcome: "optimized",
      };
    if (result.status === "retained") {
      // Retention is a still-only exception; stale workers cannot upload source motion.
      this.needsChoice(record, "standard_not_smaller");
    } else if (
      result.status === "unsupported" &&
      !FINAL_MOTION_REASONS.has(result.reason)
    )
      this.needsChoice(record, result.reason);
    else
      this.fail(record, {
        code: result.reason,
        message: finalMotionMessages[result.reason] ?? messages.preprocess,
        outcomeUnknown: false,
      });
    throw new DOMException("choice", "AbortError");
  }

  /** Standard and Original share the proof; only the digest ever leaves the browser. */
  private pairingFor(source: LogicalSource): MediaClientPairing | undefined {
    if (source.kind === "static") return undefined;
    if (source.layout === "container") {
      const stillTimeMs = source.still.motionPhoto.stillTimeMs;
      return {
        method: "motion-photo-container",
        ...(stillTimeMs === null ? {} : { stillTimeMs }),
      };
    }
    const digest = pairingDigest(source);
    if (digest === null) return undefined;
    // Read from the source motion before Standard transcoding drops the track (L09).
    const stillTimeMs = source.motion.stillTimeMs;
    return {
      method: "apple-content-identifier",
      identifierSha256: digest,
      ...(stillTimeMs === null ? {} : { stillTimeMs }),
    };
  }

  private needsChoice(record: ItemRecord, reason: string): void {
    this.patch(record, {
      phase: "needs_choice",
      choice: {
        reason,
        message: choiceMessages[reason] ?? choiceMessages.encode_unsupported!,
      },
      components: record.view.components.map((c) => ({
        ...c,
        phase: "preparing",
      })),
    });
    this.publish();
  }

  // -- registration --------------------------------------------------------

  /** Puts an unregistered item back to waiting and pauses for the account change. */
  private waitForAccount(record: ItemRecord): void {
    this.patch(record, { phase: "waiting", failure: null });
    this.pause("account");
  }

  private async register(record: ItemRecord, epoch: number): Promise<void> {
    const prepared = record.prepared;
    if (!prepared) return;
    if (this.options.currentAccount() !== this.accountId) {
      this.waitForAccount(record);
      return;
    }
    const session = this.session;
    this.patch(record, { phase: "registering", failure: null });
    this.publish();
    let holder: PublishingHolder;
    try {
      if (!session) throw new Error("no session");
      holder = await session.resolveHolder();
    } catch (error) {
      if (!this.alive(record, epoch)) return;
      if (
        isAccountError(error) ||
        this.options.currentAccount() !== this.accountId
      ) {
        this.waitForAccount(record);
        return;
      }
      // e.g. draft_limit keeps its own product text.
      this.fail(
        record,
        failureFrom(error, {
          code: "holder_unavailable",
          message: messages.holder,
          outcomeUnknown: false,
        }),
      );
      return;
    }
    if (!this.alive(record, epoch)) return;
    if (this.options.currentAccount() !== this.accountId) {
      this.waitForAccount(record);
      return;
    }
    const standard = record.view.qualityMode === "standard";
    const requestId = (record.registerRequestId ??= this.options.requestId());
    const command: RegisterMediaItemCommand = {
      requestId,
      holder,
      kind: record.view.kind,
      qualityMode: standard ? "standard" : "original",
      ...(standard
        ? {
            processingProfile:
              record.view.kind === "static"
                ? STANDARD_IMAGE_PROFILE
                : STANDARD_LIVE_PROFILE,
          }
        : {}),
      components: prepared.map((component) => ({
        role: component.role,
        byteSize: component.blob.size,
        contentType: component.contentType,
        ...(standard && component.standardOutcome !== null
          ? { standardOutcome: component.standardOutcome }
          : {}),
      })),
      ...(record.pairing ? { clientPairing: record.pairing } : {}),
      ...metadataEntry(withClientSource(record.metadata, record.clientSource)),
    };
    let item: PublishingMediaItem;
    try {
      item = await this.options.client.registerItem(command);
    } catch (error) {
      if (!this.alive(record, epoch)) return;
      if (isAccountError(error)) {
        // The same request identity replays it once this account continues.
        this.waitForAccount(record);
        return;
      }
      this.fail(
        record,
        failureFrom(error, {
          code: "register_failed",
          message: messages.holder,
          outcomeUnknown: true,
        }),
      );
      return;
    }
    if (!this.alive(record, epoch)) {
      // Cancelled while registering: this late answer must not re-add the item.
      this.ignoredLateAnswers += 1;
      if (record.view.phase === "cancelled" || record.view.phase === "cleanup")
        void this.cancelOnAccount(item.id);
      return;
    }
    record.componentIds = new Map(item.components.map((c) => [c.role, c.id]));
    record.draftId = "draftId" in holder ? holder.draftId : null;
    this.patch(record, { itemId: item.id, phase: "queued" });
    void this.storeLocalCopy(record, epoch, session);
    this.applyServerItem(record, item, false);
    // The account's view decides what is sent (a replayed registration may have some bytes).
    for (const server of item.components) {
      if (server.state === "awaiting")
        this.enqueueTransfer(record, server.role);
      else if (server.state === "receiving")
        this.patchComponent(record, server.role, {
          phase: "paused",
          failure: {
            code: "paused",
            message: messages.paused,
            outcomeUnknown: true,
          },
        });
    }
    this.derivePhase(record);
    this.publish();
  }

  // -- transfers -----------------------------------------------------------

  private enqueueTransfer(record: ItemRecord, role: MediaComponentRole): void {
    if (
      this.transferQueue.some(
        (q) => q.key === record.view.key && q.role === role,
      )
    )
      return;
    this.patchComponent(record, role, { phase: "queued", failure: null });
    this.derivePhase(record);
    this.transferQueue.push({ key: record.view.key, role });
    this.publish();
    this.pumpTransfers();
  }

  private pumpTransfers(): void {
    while (
      this.status === "active" &&
      this.transferRunning < this.options.transferConcurrency &&
      this.transferQueue.length > 0
    ) {
      // Checked before a component leaves the queue: the pause keeps it resumable.
      if (!this.guardAccount()) return;
      const next = this.transferQueue.shift()!;
      const record = this.records.get(next.key);
      if (!record) continue;
      this.startTransfer(record, next.role);
    }
  }

  private startTransfer(record: ItemRecord, role: MediaComponentRole): void {
    const componentId = record.componentIds.get(role);
    const prepared = record.prepared?.find((c) => c.role === role);
    const component = record.view.components.find((c) => c.role === role);
    if (!componentId || !prepared || component?.phase !== "queued") return;
    const attempt = this.options.attemptId();
    let headers: Record<string, string>;
    let endpoint: string;
    try {
      headers = this.options.client.uploadHeaders(attempt);
      endpoint = this.options.client.uploadEndpoint(componentId);
    } catch (error) {
      if (isAccountError(error)) this.pause("account");
      else {
        this.patchComponent(record, role, {
          phase: "failed",
          failure: failureFrom(error, {
            code: "transfer_failed",
            message: messages.network,
            outcomeUnknown: false,
          }),
        });
        this.derivePhase(record);
        this.publish();
      }
      return;
    }
    const transferId = `${componentId}.${attempt}`;
    const epoch = record.epoch;
    record.transfers.set(role, transferId);
    if (this.options.hasher && !record.hashes.has(role))
      record.hashes.set(
        role,
        this.options.hasher.hash(prepared.blob).catch(() => null),
      );
    this.transferRunning += 1;
    this.patchComponent(record, role, {
      phase: "uploading",
      bytesSent: 0,
      failure: null,
    });
    this.derivePhase(record);
    this.publish();
    this.options.transfer.start(
      { id: transferId, endpoint, headers, body: prepared.blob },
      {
        onProgress: (sent) => {
          if (
            !this.alive(record, epoch) ||
            record.transfers.get(role) !== transferId
          )
            return;
          this.patchComponent(record, role, { bytesSent: sent });
          this.publish();
        },
        onSettled: (outcome) => {
          void this.settleTransfer(record, role, transferId, epoch, outcome);
        },
      },
    );
  }

  private async settleTransfer(
    record: ItemRecord,
    role: MediaComponentRole,
    transferId: string,
    epoch: number,
    outcome: TransferOutcome,
  ): Promise<void> {
    if (
      !this.alive(record, epoch) ||
      record.transfers.get(role) !== transferId
    ) {
      this.ignoredLateAnswers += 1;
      return;
    }
    record.transfers.delete(role);
    this.transferRunning = Math.max(0, this.transferRunning - 1);
    this.pumpTransfers();
    let result: PublishingUploadResult | null = null;
    let failure: UploadFailure | null = null;
    let accountError = false;
    try {
      result = this.options.client.uploadResult(
        outcome.status,
        outcome.responseText,
        this.accountId,
      );
    } catch (error) {
      accountError = isAccountError(error);
      failure = outcome.stalled
        ? { code: "stalled", message: messages.stalled, outcomeUnknown: true }
        : failureFrom(error, {
            code: "network",
            message: messages.network,
            outcomeUnknown: true,
          });
    }
    if (accountError) {
      this.pause("account");
      return;
    }
    if (result !== null) {
      const expected = await (record.hashes.get(role) ?? Promise.resolve(null));
      if (!this.alive(record, epoch)) {
        this.ignoredLateAnswers += 1;
        return;
      }
      if (expected !== null && expected !== result.sha256) {
        // The selected file changed after selection: never report it as done,
        // and no later answer or poll may turn it back into received.
        await this.abandonRegistration(record, {
          code: "integrity_mismatch",
          message: messages.integrity,
          outcomeUnknown: false,
        });
        return;
      }
      this.applyServerItem(record, result.item, true);
      return;
    }
    // Re-read the item before offering a retry: the bytes may have been committed.
    const read = await this.fetchItem(record, epoch);
    if (read === null) return;
    if ("account" in read) {
      this.pause("account");
      return;
    }
    if ("gone" in read) {
      this.markUnavailable(record);
      return;
    }
    const item = "item" in read ? read.item : null;
    const serverComponent = item?.components.find((c) => c.role === role);
    if (
      item &&
      serverComponent &&
      (serverComponent.state === "received" ||
        serverComponent.state === "verified")
    ) {
      this.applyServerItem(record, item, true);
      return;
    }
    this.patchComponent(record, role, { phase: "failed", failure });
    if (item) this.applyServerItem(record, item, true, role);
    else {
      this.derivePhase(record);
      this.publish();
    }
  }

  // -- server state --------------------------------------------------------

  /**
   * Merges the owner view of the item. `keepFailedRole` keeps a locally
   * failed component failed even when the server still waits for it.
   */
  private applyServerItem(
    record: ItemRecord,
    item: PublishingMediaItem,
    transferContext: boolean,
    keepFailedRole?: MediaComponentRole,
  ): void {
    record.view = { ...record.view, serverItem: item, itemId: item.id };
    if (record.view.processingFailure?.code !== "progress_unavailable")
      record.pollFailures = 0;
    for (const server of item.components) {
      const received =
        server.state === "received" || server.state === "verified";
      const local = record.view.components.find((c) => c.role === server.role);
      if (!local) continue;
      if (received && server.role !== keepFailedRole)
        this.patchComponent(record, server.role, {
          phase: "received",
          byteSize: server.byteSize,
          bytesSent: server.byteSize,
          failure: null,
        });
      else if (server.state === "cancelled")
        this.patchComponent(record, server.role, { phase: "cancelled" });
      else if (server.state === "rejected" && local.phase !== "failed")
        this.patchComponent(record, server.role, {
          phase: "failed",
          failure: {
            code: "rejected",
            message: messages.preprocess,
            outcomeUnknown: false,
          },
        });
      else if (local.phase === "missing_local" || local.byteSize === 0)
        this.patchComponent(record, server.role, { byteSize: server.byteSize });
    }
    switch (item.state) {
      case "ready":
        this.stopPolling(record);
        this.patch(record, { phase: "ready", failure: null });
        this.forgetLocalCopy(record);
        // Derivatives serve previews now; prepared bytes are not held for the session.
        record.prepared = null;
        record.hashes = new Map();
        if (this.needsBackgroundPoll(record)) this.schedulePoll(record);
        break;
      case "processing":
        this.patch(record, { phase: "processing" });
        this.forgetLocalCopy(record);
        this.schedulePoll(record);
        break;
      case "failed":
        this.stopPolling(record);
        this.patch(record, {
          phase: "failed",
          failure: {
            code: item.failureCode ?? "processing_failed",
            message:
              mediaFailureMessages[item.failureCode ?? "processing_failed"],
            outcomeUnknown: false,
          },
        });
        break;
      case "cancelled":
      case "purged":
        this.stopPolling(record);
        this.patch(record, { phase: "cancelled" });
        this.forgetLocalCopy(record);
        break;
      default:
        this.derivePhase(record);
        if (transferContext && record.view.phase === "uploaded")
          this.schedulePoll(record);
    }
    this.publish();
  }

  private derivePhase(record: ItemRecord): void {
    const phase = record.view.phase;
    if (
      TERMINAL.has(phase) ||
      phase === "needs_choice" ||
      phase === "waiting" ||
      phase === "preprocessing" ||
      phase === "registering" ||
      phase === "processing" ||
      (phase === "failed" && record.view.itemId === null)
    )
      return;
    if (record.view.serverItem?.state === "failed") return;
    const phases = record.view.components.map((c) => c.phase);
    const next: UploadItemPhase = phases.includes("uploading")
      ? "uploading"
      : phases.includes("queued")
        ? "queued"
        : phases.includes("failed")
          ? "failed"
          : phases.includes("paused")
            ? "paused"
            : phases.includes("missing_local")
              ? "missing_local"
              : phases.every((p) => p === "received")
                ? "uploaded"
                : "queued";
    const failed = record.view.components.find((c) => c.phase === "failed");
    this.patch(record, {
      phase: next,
      failure: next === "failed" ? (failed?.failure ?? null) : null,
    });
    if (next === "uploaded") this.schedulePoll(record);
  }

  private needsBackgroundPoll(record: ItemRecord): boolean {
    return (
      record.view.phase === "ready" &&
      record.view.kind === "static" &&
      this.options.client.itemProgress !== undefined &&
      (record.view.processing === undefined ||
        hasPendingHighResolution(record.view) ||
        record.view.processingFailure?.code === "progress_unavailable")
    );
  }

  private schedulePoll(record: ItemRecord): void {
    if (
      !this.pollingEnabled ||
      this.status !== "active" ||
      record.pollTimer !== null
    )
      return;
    if (record.view.itemId === null) return;
    const delay =
      record.pollFailures > 0
        ? POLL_ERROR_DELAYS_MS[
            Math.min(record.pollFailures - 1, POLL_ERROR_DELAYS_MS.length - 1)
          ]!
        : POLL_DELAYS_MS[
            Math.min(record.pollAttempt, POLL_DELAYS_MS.length - 1)
          ]!;
    record.pollAttempt += 1;
    const epoch = record.epoch;
    record.pollTimer = this.timers.setTimeout(() => {
      record.pollTimer = null;
      void (async () => {
        if (!this.alive(record, epoch) || this.status !== "active") return;
        const read = await this.fetchItem(record, epoch);
        if (!this.alive(record, epoch) || this.status !== "active") return;
        if (read === null) return;
        if ("account" in read) {
          this.pause("account");
          return;
        }
        if ("gone" in read) {
          this.markUnavailable(record);
          return;
        }
        if ("error" in read) {
          // A failed check backs off; successful pending answers stay responsive.
          record.pollFailures += 1;
          if (record.view.phase === "ready") {
            this.patch(record, {
              processingFailure: {
                code: "progress_unavailable",
                message: "暂时无法确认高清图进度，预览仍可使用",
                outcomeUnknown: false,
              },
            });
            this.publish();
          }
          this.schedulePoll(record);
          return;
        }
        this.applyServerItem(record, read.item, false);
        if (
          record.view.phase === "uploaded" ||
          record.view.phase === "processing" ||
          this.needsBackgroundPoll(record)
        )
          this.schedulePoll(record);
      })();
    }, delay);
  }

  private stopPolling(record: ItemRecord): void {
    if (record.pollTimer !== null) {
      this.timers.clearTimeout(record.pollTimer);
      record.pollTimer = null;
    }
  }

  // -- local recovery ------------------------------------------------------

  private async storeLocalCopy(
    record: ItemRecord,
    epoch: number,
    session: UploadSessionBinding | null,
  ): Promise<void> {
    const recovery = this.options.recovery ?? null;
    const draftId = record.draftId;
    const prepared = record.prepared;
    const itemId = record.view.itemId;
    // Saved drafts only: no-save mode never writes a local copy (D05).
    if (
      this.holderChanging ||
      !recovery ||
      session?.saveMode !== "saved" ||
      !draftId ||
      !prepared ||
      !itemId
    )
      return;
    const components = prepared.flatMap((component) => {
      const componentId = record.componentIds.get(component.role);
      return componentId
        ? [
            {
              role: component.role,
              componentId,
              contentType: component.contentType,
              byteSize: component.blob.size,
              ...(component.standardOutcome === null
                ? {}
                : { standardOutcome: component.standardOutcome }),
              // A nameless copy: File objects would persist raw file names.
              blob: component.blob.slice(
                0,
                component.blob.size,
                component.contentType,
              ),
            },
          ]
        : [];
    });
    const stored = await recovery
      .save({
        accountId: this.accountId,
        draftId,
        itemKey: record.view.key,
        itemId,
        kind: record.view.kind,
        qualityMode:
          record.view.qualityMode === "original" ? "original" : "standard",
        components,
        savedAt: (this.options.now ?? Date.now)(),
      })
      .catch(() => false);
    if (
      !this.alive(record, epoch) ||
      this.holderChanging ||
      this.draftId !== draftId ||
      record.draftId !== draftId
    ) {
      if (stored)
        await recovery.remove(this.accountId, draftId, record.view.key);
      return;
    }
    if (TERMINAL.has(record.view.phase) || record.view.phase === "processing") {
      if (stored)
        await recovery.remove(this.accountId, draftId, record.view.key);
      return;
    }
    this.patch(record, { recoverable: stored });
    this.publish();
  }

  private forgetLocalCopy(record: ItemRecord): void {
    const recovery = this.options.recovery ?? null;
    const draftId = record.draftId ?? this.draftId;
    if (recovery && draftId && this.session?.saveMode === "saved")
      void recovery
        .remove(this.accountId, draftId, record.view.key)
        .catch(() => undefined);
    if (record.view.recoverable) this.patch(record, { recoverable: false });
  }

  // -- helpers -------------------------------------------------------------

  /** Reads the item; null when this continuation became stale meanwhile. */
  private async fetchItem(
    record: ItemRecord,
    epoch: number,
  ): Promise<
    | { readonly item: PublishingMediaItem }
    | { readonly gone: true }
    | { readonly account: true }
    | { readonly error: unknown }
    | null
  > {
    const itemId = record.view.itemId;
    if (itemId === null) return null;
    try {
      if (this.options.client.itemProgress && record.view.processing !== null) {
        const progress = await this.options.client.itemProgress(
          itemId,
          record.controller.signal,
        );
        if (!this.alive(record, epoch)) return null;
        if (this.options.currentAccount() !== this.accountId)
          return { account: true };
        this.patch(record, {
          processing: progress.processing,
          processingFailure: null,
        });
        return { item: progress.item };
      }
      const item = await this.options.client.item(itemId);
      if (this.options.currentAccount() !== this.accountId)
        return { account: true };
      return this.alive(record, epoch) ? { item } : null;
    } catch (error) {
      if (!this.alive(record, epoch)) return null;
      if (isAccountError(error)) return { account: true };
      if (
        isNotFound(error) &&
        this.options.client.itemProgress &&
        record.view.processing !== null
      ) {
        // A legacy server has no progress route. Confirm the old item read
        // before treating the item as gone; do not discard a usable preview.
        try {
          const item = await this.options.client.item(itemId);
          if (!this.alive(record, epoch)) return null;
          if (this.options.currentAccount() !== this.accountId)
            return { account: true };
          record.pollFailures += 1;
          this.patch(record, {
            processingFailure: {
              code: "progress_unavailable",
              message: "暂时无法确认高清图进度，预览仍可使用",
              outcomeUnknown: false,
            },
          });
          return { item };
        } catch (legacyError) {
          if (!this.alive(record, epoch)) return null;
          if (isAccountError(legacyError)) return { account: true };
          if (isNotFound(legacyError)) return { gone: true };
          return { error: legacyError };
        }
      }
      if (isNotFound(error)) return { gone: true };
      return { error };
    }
  }

  /** The account no longer has the item: nothing is polled or sent for it again. */
  private markUnavailable(record: ItemRecord): void {
    this.stopPolling(record);
    this.abortTransfers(record);
    this.transferQueue = this.transferQueue.filter(
      (queued) => queued.key !== record.view.key,
    );
    this.forgetLocalCopy(record);
    this.patch(record, {
      phase: "failed",
      failure: {
        code: "unavailable",
        message: messages.unavailable,
        outcomeUnknown: false,
      },
      components: record.view.components.map((component) =>
        component.phase === "received"
          ? component
          : { ...component, phase: "failed", failure: null },
      ),
    });
    this.publish();
  }

  /**
   * The account holds bytes that are not what this browser selected (the
   * file changed after selection): that item is cancelled on the account and
   * forgotten locally; the explicit `retryRegistration` registers and sends
   * the local bytes again (hashed again). Late answers are fenced.
   */
  private async abandonRegistration(
    record: ItemRecord,
    failure: UploadFailure,
  ): Promise<void> {
    const itemId = record.view.itemId;
    this.renew(record);
    this.abortTransfers(record);
    this.stopPolling(record);
    this.transferQueue = this.transferQueue.filter(
      (queued) => queued.key !== record.view.key,
    );
    this.forgetLocalCopy(record);
    record.componentIds = new Map();
    record.registerRequestId = null;
    record.hashes = new Map();
    record.draftId = null;
    this.patch(record, {
      itemId: null,
      serverItem: null,
      recoverable: false,
      phase: "failed",
      failure,
      components: record.view.components.map((component) => ({
        ...component,
        phase: "queued",
        bytesSent: 0,
        failure: null,
      })),
    });
    this.publish();
    if (itemId !== null) await this.cancelOnAccount(itemId);
  }

  private async cancelOnAccount(itemId: string): Promise<void> {
    if (this.options.currentAccount() !== this.accountId) return;
    try {
      await this.options.client.cancelItem(itemId, {
        requestId: this.options.requestId(),
      });
    } catch {
      // The item stays unreferenced by content; the Backend's cleanup owns it.
    }
  }

  private guardAccount(): boolean {
    if (this.options.currentAccount() === this.accountId) return true;
    this.pause("account");
    return false;
  }

  private resume(): void {
    if (this.status !== "paused") return;
    this.status = "active";
    this.pauseReason = null;
    for (const record of this.records.values())
      if (
        record.view.phase === "uploaded" ||
        record.view.phase === "processing" ||
        this.needsBackgroundPoll(record)
      )
        this.schedulePoll(record);
    this.publish();
    this.pumpTransfers();
  }

  private alive(record: ItemRecord, epoch: number): boolean {
    return (
      this.status !== "disposed" &&
      record.epoch === epoch &&
      this.records.get(record.view.key) === record
    );
  }

  /** Starts a new epoch: every earlier continuation of this item becomes stale. */
  private renew(record: ItemRecord): void {
    record.epoch += 1;
    record.controller.abort(new DOMException("cancelled", "AbortError"));
    record.controller = new AbortController();
  }

  private abortTransfers(record: ItemRecord): void {
    for (const transferId of record.transfers.values()) {
      this.options.transfer.abort(transferId);
      this.transferRunning = Math.max(0, this.transferRunning - 1);
    }
    record.transfers.clear();
    this.pumpTransfers();
  }

  private fail(record: ItemRecord, failure: UploadFailure): void {
    this.patch(record, { phase: "failed", failure });
    this.publish();
  }

  private patch(record: ItemRecord, change: Partial<UploadItemView>): void {
    record.view = { ...record.view, ...change };
  }

  private patchComponent(
    record: ItemRecord,
    role: MediaComponentRole,
    change: Partial<UploadComponentView>,
  ): void {
    record.view = {
      ...record.view,
      components: record.view.components.map((component) =>
        component.role === role ? { ...component, ...change } : component,
      ),
    };
  }

  private snapshot(): UploadManagerSnapshot {
    return {
      accountId: this.accountId,
      status: this.status,
      pauseReason: this.pauseReason,
      items: this.order.flatMap((key) => {
        const record = this.records.get(key);
        return record ? [record.view] : [];
      }),
    };
  }

  private publish(): void {
    this.store.set(this.snapshot());
  }
}

// ---------------------------------------------------------------------------
// Selectors

export interface UploadSummary {
  readonly total: number;
  readonly preparing: number;
  readonly needsChoice: number;
  readonly queued: number;
  readonly uploading: number;
  readonly uploaded: number;
  readonly processing: number;
  readonly ready: number;
  readonly failed: number;
  readonly paused: number;
  readonly missingLocal: number;
  /** Usable previews whose high-resolution work continues on the account. */
  readonly backgroundProcessing?: number;
  readonly backgroundFailed?: number;
  readonly completedRenditions?: number;
  readonly bytesSent: number;
  readonly bytesTotal: number;
  /** Anything still being prepared, transferred or processed, or interrupted and waiting for Continue. */
  readonly active: boolean;
  /** Anything the author still has to act on or wait for (not ready, not cancelled). */
  readonly unfinished: boolean;
  /** Items that keep a submission from being confirmed (not ready, not cancelled). */
  readonly blocking: number;
}

export const summarizeUploads = (
  snapshot: UploadManagerSnapshot,
): UploadSummary => {
  const count = (...phases: UploadItemPhase[]) =>
    snapshot.items.filter((item) => phases.includes(item.phase)).length;
  const live = snapshot.items.filter(
    (item) => item.phase !== "cancelled" && item.phase !== "cleanup",
  );
  let bytesSent = 0;
  let bytesTotal = 0;
  for (const item of live)
    for (const component of item.components) {
      bytesTotal += component.byteSize;
      bytesSent +=
        component.phase === "received"
          ? component.byteSize
          : component.bytesSent;
    }
  const preparing = count("waiting", "preprocessing", "registering");
  const queued = count("queued");
  const uploading = count("uploading");
  const uploaded = count("uploaded");
  const processing = count("processing");
  const paused = count("paused");
  return {
    total: live.length,
    preparing,
    needsChoice: count("needs_choice"),
    queued,
    uploading,
    uploaded,
    processing,
    ready: count("ready"),
    failed: count("failed"),
    paused,
    missingLocal: count("missing_local"),
    backgroundProcessing: live.filter(hasPendingHighResolution).length,
    backgroundFailed: live.filter(
      (item) =>
        item.phase === "ready" &&
        item.processing?.highResolutionStatus === "failed" &&
        item.processingFailure?.code !== "progress_refreshing",
    ).length,
    completedRenditions: live.reduce(
      (sum, item) => sum + (item.processing?.completedRenditions ?? 0),
      0,
    ),
    bytesSent,
    bytesTotal,
    active: preparing + queued + uploading + uploaded + processing + paused > 0,
    unfinished: live.some((item) => item.phase !== "ready"),
    blocking: live.filter((item) => item.phase !== "ready").length,
  };
};

/** Background progress remains visible without blocking preview readiness. */
export const backgroundProgressText = (
  summary: UploadSummary,
): string | null => {
  const parts: string[] = [];
  if ((summary.backgroundProcessing ?? 0) > 0)
    parts.push(`${summary.backgroundProcessing} 项预览已就绪，高清图处理中`);
  if ((summary.backgroundFailed ?? 0) > 0)
    parts.push(`${summary.backgroundFailed} 项高清图处理失败，预览仍可使用`);
  return parts.length === 0 ? null : parts.join("，");
};

/** Exact readiness wording for the confirmation sheet (e.g. 2 项仍在上传，1 项失败). */
export const readinessText = (summary: UploadSummary): string | null => {
  const parts: string[] = [];
  if (summary.preparing > 0) parts.push(`${summary.preparing} 项正在准备`);
  if (summary.needsChoice > 0) parts.push(`${summary.needsChoice} 项需要选择`);
  if (summary.queued + summary.uploading > 0)
    parts.push(`${summary.queued + summary.uploading} 项仍在上传`);
  if (summary.uploaded + summary.processing > 0)
    parts.push(`${summary.uploaded + summary.processing} 项正在处理`);
  if (summary.paused > 0) parts.push(`${summary.paused} 项已暂停`);
  if (summary.failed > 0) parts.push(`${summary.failed} 项失败`);
  if (summary.missingLocal > 0)
    parts.push(`${summary.missingLocal} 项缺少本地文件`);
  return parts.length === 0 ? null : parts.join("，");
};
