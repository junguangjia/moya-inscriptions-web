import type {
  CreatePublishingDraftCommand,
  CreatePublishingSessionCommand,
  EditableWork,
  MediaComponentRole,
  MediaFailureCode,
  MediaVariant,
  OpenWorkEditDraftCommand,
  PublishingDraft,
  PublishingDraftDeletionCommand,
  PublishingDraftDeletionResult,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingHolder,
  PublishingMediaItem,
  PublishingOpenedEditDraft,
  PublishingPageQuery,
  PublishingSession,
  PublishingSnapshotPage,
  PublishingUploadResult,
  RegisterMediaItemCommand,
  ResolvePublishingConflictCommand,
  RestorePublishingSnapshotCommand,
  SavePublishingDraftCommand,
  WorkDraftContent,
  WorkSubmissionCommand,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
  WorkVisibilityCommand,
  WorkVisibilityResult,
} from "@moya/contracts";
import type {
  OperatorAccountCapacity,
  PublishingJobKind,
  WorkPublishingSettings,
} from "@moya/contracts/internal/community-operator";

import type {
  PublishingDerivativeVariant,
  PublishingMediaEdit,
  PublishingNormalizedCrop,
  PublishingProcessInput,
  PublishingProcessOutcome,
} from "./publishing-media-processor-port.js";
import type {
  PublishingBlobContentType,
  PublishingMediaWriteResult,
} from "./publishing-media-store-port.js";

/*
 * Work publishing persistence (work-publishing-v1, design.md §2-§5, §9-§10).
 *
 * Conventions shared by every method:
 * - Ids are the opaque contract strings (`work-draft-<32hex>`, …). `actorId` is
 *   the authenticated PublicUserId; an inactive (suspended) actor, or a subject
 *   the actor does not own, throws `CommunityNotFoundError` (never a hint that
 *   the subject exists).
 * - `now` is the injected service clock. Adapters bind it as a SQL parameter
 *   for every stored time, lease, retention and America/New_York day boundary;
 *   they never read the database clock for product decisions.
 * - Commands are already strictly parsed by the service with the contract
 *   schemas. A method whose command carries `requestId` is an author command:
 *   one transaction locks the actor row, checks `author_command_receipts`
 *   (same request and same fingerprint returns the stored result; a different
 *   fingerprint throws `CommunityConflictError`), applies the change, writes
 *   one `author_events` row and the receipt. Results are therefore JSON-safe.
 * - A rule rejection throws `CommunityInputError` whose message is exactly one
 *   `WorkPublishingFailureCode` (`capacity_exceeded`, `items_limit`,
 *   `draft_limit`, `daily_limit`, `original_item_too_large`,
 *   `component_too_large`, `work_unavailable`, …). A state that moved on
 *   (stale version, late write after submit/discard, upload in progress)
 *   throws `CommunityConflictError` with a content-free message. Thrown errors
 *   roll back: nothing is stored, receipted or audited.
 * - Nothing here logs or returns titles, bodies, file names, metadata values,
 *   storage keys to clients, or tokens. Storage keys only travel to the Backend
 *   media store and worker.
 */

/** A command body that carries only its idempotency key. */
export interface PublishingCommandIdentity {
  readonly requestId: string;
}

/** Uploads the caller must stop in its in-process transfer registry. */
export interface PublishingStoppedUploads {
  readonly cancelledComponentIds: readonly string[];
}

/** `deleteDraft`: the contract result plus the transfers to stop. */
export interface PublishingDraftDeletion extends PublishingStoppedUploads {
  readonly result: PublishingDraftDeletionResult;
}

/** `discardSession`: the contract result plus the transfers to stop. */
export interface PublishingSessionDiscard extends PublishingStoppedUploads {
  readonly result: { readonly discarded: true };
}

/** `cancelItem` and `resetComponent`: the owner's item plus the transfers to stop. */
export interface PublishingItemChange extends PublishingStoppedUploads {
  readonly item: PublishingMediaItem;
}

/**
 * `expireSession` outcome. `active`: the lease is still valid or a transfer is
 * still streaming (the scheduler looks again later). `ended`: already
 * submitted, discarded or expired. `missing`: no such session.
 */
export interface PublishingSessionExpiry extends PublishingStoppedUploads {
  readonly status: "expired" | "active" | "ended" | "missing";
}

/** The start of one component transfer (`POST publishing/uploads/:componentId`). */
export interface PublishingUploadStart {
  /** The `x-upload-attempt` UUID of this transfer. */
  readonly attempt: string;
  /** The transfer's content-length; it must equal the declared component bytes. */
  readonly contentLength: number;
  /**
   * Take over a component still `receiving` under another attempt. True only
   * when the caller verified that no transfer for this component is still
   * streaming in this process; otherwise such a component is a conflict.
   */
  readonly supersede: boolean;
}

/**
 * The attempt/cancel fence of one accepted transfer. The Backend streams into
 * the media store with exactly these facts and presents the fence again at
 * commit or abort; a changed attempt or a cancelled item or holder is detected
 * there.
 */
export interface PublishingUploadFence {
  readonly componentId: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly attempt: string;
  readonly role: MediaComponentRole;
  /** The declared component type, passed to the store as the blob content type. */
  readonly contentType: PublishingBlobContentType;
  /** Declared bytes; the store write must deliver exactly this many. */
  readonly byteSize: number;
  /** `original` for Original items, `standard_master` for Standard items (optimized or retained). */
  readonly purpose: "original" | "standard_master";
}

/**
 * `commitComponentUpload` outcome. Every status other than `committed` stored
 * nothing: the caller removes the written blob from the media store and
 * answers 409 (`superseded`, `cancelled`) or 413 (`size_mismatch`).
 */
export type PublishingUploadCommit =
  | { readonly status: "committed"; readonly result: PublishingUploadResult }
  | { readonly status: "superseded" | "cancelled" | "size_mismatch" };

/**
 * Where the bytes of a processing input come from. `upload`: the received
 * components listed in `components` (media store keys). `legacy_user_media`:
 * a Phase 4 PNG kept in `community.user_media`; `components` is empty, the
 * worker reads the bytes with `readLegacyMediaBytes(itemId)` (exactly
 * `byteSize` bytes of `contentType`) and never writes them back as a
 * component or source blob.
 */
export type PublishingProcessingSource =
  | { readonly kind: "upload" }
  | {
      readonly kind: "legacy_user_media";
      /** The `user-media-<32hex>` id; content-free, never a storage key. */
      readonly legacyMediaId: string;
      readonly byteSize: number;
      readonly contentType: "image/png";
    };

/**
 * What the port hands the worker for one `process_item` or `derive_edit` job.
 * For an `upload` source the worker adds its own signal and passes the rest to
 * the processor as `PublishingProcessInput`. For a `legacy_user_media` source
 * `components` is empty and no component is built: the worker reads the PNG
 * bytes with `readLegacyMediaBytes(itemId)`, checks their size and signature,
 * and hands them to the Backend's media processor, whose input carries the
 * still bytes of a legacy item (`PublishingProcessInput` in this package has
 * no field for them). A legacy item is always mode `derive` with a non-`base`
 * edit key, kind `static` and quality mode `standard` (a lossless PNG decoded
 * like a retained Standard master).
 */
export type PublishingProcessingInput = Omit<
  PublishingProcessInput,
  "signal"
> & {
  readonly source: PublishingProcessingSource;
};

export type PublishingProcessedOutcome = Extract<
  PublishingProcessOutcome,
  { readonly status: "processed" }
>;

export type PublishingDerivedOutcome = Extract<
  PublishingProcessOutcome,
  { readonly status: "derived" }
>;

/**
 * `markItemReady` / `recordDerivatives` outcome. `discarded`: the item was
 * cancelled or purged meanwhile, or some derivatives already existed for
 * their variant and edit key. The listed `storageKeys` were not recorded and
 * the caller removes exactly those from the media store; other derivatives of
 * the same outcome may have been recorded (a partial duplicate). A replayed
 * outcome whose keys are all recorded already reads as `recorded`, so a lost
 * response never hands back stored bytes for removal.
 */
export type PublishingDerivativeCommit =
  | { readonly status: "recorded" }
  | { readonly status: "discarded"; readonly storageKeys: readonly string[] };

/** The part of draft or submission content that decides derivative readiness. */
export type PublishingEditTarget = Pick<
  WorkDraftContent,
  "items" | "coverKey" | "coverCrop"
>;

/**
 * Readiness of one content item for its edit and cover crop.
 * `pending`: a placeholder without an item id. `uploading`: components still
 * awaited. `processing`: the item is being validated. `deriving`: the item is
 * ready and a derivative job for this edit is queued or running. `failed`: the
 * item failed, or the derivative job for this edit failed. `unavailable`: not
 * owned, cancelled or purged.
 */
export type PublishingEditItemState =
  | "pending"
  | "uploading"
  | "processing"
  | "deriving"
  | "ready"
  | "failed"
  | "unavailable";

export interface PublishingEditReadiness {
  /** True exactly when every item is `ready`. */
  readonly ready: boolean;
  readonly items: readonly {
    readonly key: string;
    readonly itemId: string | null;
    readonly state: PublishingEditItemState;
    /**
     * For a `ready` item, the edit key (computed in SQL) under which its
     * `thumb` and `cover` derivatives are recorded: the cover crop is part
     * of it for the cover item; `base` for an unedited item. `null` in every
     * other state.
     */
    readonly editKey: string | null;
  }[];
}

/** `ensureEditDerivatives` options. */
export interface PublishingEditReadinessOptions {
  /**
   * The holder whose content is checked (an explicit readiness route). It
   * is verified like an item registration: the actor's active primary draft
   * or active unlapsed session; unknown, foreign or lapsed throws
   * `CommunityNotFoundError`, a submitted draft or an ended session
   * `CommunityConflictError`, and nothing is enqueued then.
   */
  readonly holder?: PublishingHolder;
}

/** A private derivative the media route may stream (sources are never addressable). */
export interface PublishingMediaReadTarget {
  readonly storageKey: string;
  readonly contentType: "image/webp" | "video/mp4";
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the stored bytes (usable as a strong validator). */
  readonly sha256: string;
}

/** Payload of a `derive_edit` job; every other job kind has no payload. Content-free. */
export interface PublishingDeriveEditPayload {
  /** Computed in SQL (`community.media_edit_key`); opaque everywhere else. */
  readonly editKey: string;
  readonly edit: PublishingMediaEdit;
  readonly coverCrop: PublishingNormalizedCrop | null;
  readonly variants: readonly PublishingDerivativeVariant[];
}

/** One leased job. `attempts` already counts this claim. */
export interface PublishingJobClaim {
  readonly id: string;
  readonly kind: PublishingJobKind;
  /** Item, blob, session, work or account id; `staging` for `sweep_staging`. */
  readonly subjectId: string;
  readonly payload: PublishingDeriveEditPayload | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

/**
 * The fence a worker presents for lease-protected job transitions: the job id
 * and the owner label of the claim. The fence has no attempt number, so a
 * worker must use a label unique to each claim call (for example
 * `<worker>.<claim sequence>`); a label reused across claims could complete
 * or release a later claim of the same job.
 */
export type PublishingJobLease = Pick<PublishingJobClaim, "id" | "leaseOwner">;

export interface PublishingJobClaimOptions {
  /** Content-free worker label, 1..128 characters, unique per claim call. */
  readonly owner: string;
  /** 1..100 jobs per claim. */
  readonly limit: number;
  readonly leaseMs: number;
  /** Restrict the claim to these kinds; all kinds when omitted. */
  readonly kinds?: readonly PublishingJobKind[];
}

/** `retry_scheduled`: queued again with backoff. `lease_lost`: the claim was no longer held; nothing changed. */
export type PublishingJobFailure = "retry_scheduled" | "failed" | "lease_lost";

export interface PublishingJobFailureOptions {
  /** False for deterministic failures (a processor rejection): fail now without retry. Default true. */
  readonly retryable?: boolean;
}

export interface PublishingJobEnqueue {
  readonly kind: PublishingJobKind;
  /** `^[a-z0-9][a-z0-9-]{0,127}$`, as the operator job DTO requires. */
  readonly subjectId: string;
  readonly payload?: PublishingDeriveEditPayload | null;
  /** Defaults to `now`. */
  readonly runAfter?: Date;
  /** 1..1000; the table default when omitted. */
  readonly maxAttempts?: number;
}

/** `created: false` when an equal queued or running job already existed (its id is returned). */
export interface PublishingJobEnqueued {
  readonly id: string;
  readonly created: boolean;
}

/**
 * New jobs enqueued by one `scheduleCleanup` pass, per kind. Released edit
 * derivatives and deleted `succeeded` job rows are not counted.
 */
export interface PublishingCleanupCounts {
  readonly expireSession: number;
  readonly purgeTrashedWork: number;
  readonly purgeItem: number;
  readonly purgeBlob: number;
}

export interface PublishingBlobUnlink {
  readonly blobId: string;
  readonly storageKey: string;
}

/**
 * `purgeItem` / `purgeBlob` plan. `referenced`: a holder, a live item, a
 * revision of a work that is not purged, live draft or snapshot content, or
 * (for an item that is not cancelled) its orphan grace still keeps it; nothing
 * changed. `missing`: unknown or already purged.
 * `tombstoned`: the blobs are tombstoned in the committed transaction; the
 * caller removes each storage key from the media store (idempotent) and then
 * calls `confirmPurged` with the blob ids. A crash in between leaves
 * tombstoned blobs that a later `purge_blob` job finishes.
 */
export type PublishingPurgePlan =
  | { readonly status: "referenced" | "missing" }
  | {
      readonly status: "tombstoned";
      readonly blobs: readonly PublishingBlobUnlink[];
    };

/** `purgeTrashedWork` outcome; `not_due` also covers a restored work. */
export type PublishingTrashPurge = "purged" | "not_due" | "missing";

/** Settings and account capacity reads, and capacity reconciliation. */
export interface PublishingSettingsOperations {
  /**
   * The single settings row (policy and every enforced limit); the service
   * derives the author `PublishingLimits` from it. A stored item maximum
   * above the configurable 100 is enforced and read as 100.
   */
  readSettings(): Promise<WorkPublishingSettings>;
  /**
   * The account's capacity class, capacity bytes (from settings) and counters.
   * An account without a capacity row reads as ordinary with zero counters,
   * version 0 and `updatedAt` null. Unknown account: `CommunityNotFoundError`.
   */
  readCapacity(accountId: string): Promise<OperatorAccountCapacity>;
  /**
   * Job `reconcile_capacity`: recomputes committed bytes from the account's
   * committed and tombstoned blobs (each counted once) and reserved bytes from
   * its open reservations, under the capacity row lock.
   */
  reconcileCapacity(
    accountId: string,
    now: Date,
  ): Promise<OperatorAccountCapacity>;
  /**
   * The given media store keys that have no `media_blobs` row in any state.
   * Reconciliation removes such keys only when older than its grace period.
   */
  unrecordedStorageKeys(
    storageKeys: readonly string[],
  ): Promise<readonly string[]>;
}

/** No-save temporary sessions (D05, D07, D08, D11). */
export interface PublishingSessionOperations {
  /**
   * Author command. Creates an unsaved-mode session with lease `now` +
   * `unsaved_session_lease_minutes`. A `workId` must name the actor's
   * non-deleted work; a trashed or removed work throws `work_unavailable`.
   */
  createSession(
    actorId: string,
    command: CreatePublishingSessionCommand,
    now: Date,
  ): Promise<PublishingSession>;
  /**
   * Extends an active session's lease to `now` + lease minutes. The session
   * must be usable under the rule `expireSession` applies: its lease has not
   * passed (a lease ending exactly at `now` counts), or a component of one of
   * its items is still `receiving` under a transfer that started within one
   * lease period. Any other session, including a lapsed one nothing protects,
   * is inaccessible (`CommunityNotFoundError`).
   */
  heartbeatSession(
    actorId: string,
    sessionId: string,
    now: Date,
  ): Promise<PublishingSession>;
  /**
   * Author command. Ends the session immediately (D08, no grace): state
   * `discarded`, its refs removed, items no other holder references are
   * cancelled with reservations released and `purge_item` jobs enqueued at
   * `now`. Existing works, revisions and drafts are untouched.
   */
  discardSession(
    actorId: string,
    sessionId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingSessionDiscard>;
  /**
   * Job `expire_session`: when the lease passed and no component of its items
   * is still `receiving` within one lease period, the session becomes
   * `expired` with the same cleanup as `discardSession`.
   */
  expireSession(sessionId: string, now: Date): Promise<PublishingSessionExpiry>;
}

/**
 * Persistent private drafts, history and conflicts (D02-D04, D06, V01-V05).
 *
 * Draft commands with a `requestId` store a content-free receipt (the draft
 * id only): the first run returns the draft read in its own transaction and a
 * replay reads the draft again, so a deleted draft replays as
 * `CommunityNotFoundError` and its content never survives in a receipt.
 * Deleted drafts are removed completely: every later read or write naming one
 * (a late autosave, an item registration) is `CommunityNotFoundError`, while a
 * submitted draft is `CommunityConflictError`.
 *
 * Derivative jobs a draft change needs (create, save, restore, resolve, edit
 * draft open) wait `30 s` before a worker may claim them; a later change
 * removes still-waiting jobs for edit keys its content no longer needs. An
 * explicit readiness check (`ensureEditDerivatives`) starts missing jobs at
 * `now` and moves matching waiting jobs up to `now`.
 */
export interface PublishingDraftOperations {
  /**
   * Author command. Creates a new-work draft at revision 1 on first real
   * content (the service refuses empty content). Refused with `draft_limit`
   * at `max_active_drafts` active primary drafts. Content item rules (also for
   * every later save, restore and resolution): an item id the actor does not
   * own throws `CommunityNotFoundError`; the actor's cancelled or purged items
   * stay in the content without a ref (they read as unavailable); every other
   * item gets a draft ref. Derivative jobs for ready items with edits
   * (uploaded and legacy items alike) are ensured with the settle delay.
   */
  createDraft(
    actorId: string,
    command: CreatePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraft>;
  /**
   * Revision-conditional autosave (not receipted). `baseRevision` equal to the
   * draft's revision stores the content at revision + 1, syncs draft refs to
   * the content's item ids (dropped items wait for the orphan grace) and
   * ensures edit derivatives: `saved`. Content equal to the current content
   * (a retried save) is `saved` without a new revision. Any other base keeps
   * the draft unchanged and stores the device content as a conflict copy plus
   * a pinned `conflict` snapshot: `conflict`; a later stale save from the same
   * device class on the same base replaces that copy and its snapshot. An
   * item registered to the draft but not yet in its content keeps its ref. A
   * submitted draft throws `CommunityConflictError`; a deleted one
   * `CommunityNotFoundError`.
   */
  saveDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraftSaveResult>;
  /**
   * Save now: `saveDraft`, and on `saved` also records a `saved` snapshot and
   * trims the lineage's unpinned snapshots beyond `history_limit` (their refs
   * go with them).
   */
  snapshotDraft(
    actorId: string,
    draftId: string,
    command: SavePublishingDraftCommand,
    now: Date,
  ): Promise<PublishingDraftSaveResult>;
  /** The actor's active primary drafts, newest `updated_at` first (conflict copies excluded). */
  listDrafts(
    actorId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingDraftPage>;
  /** One active primary draft with its media items and its unresolved conflict, if any. */
  readDraft(actorId: string, draftId: string): Promise<PublishingDraft>;
  /**
   * Author command. Targeted deletion (D06): the draft, its snapshots and its
   * conflict copies are deleted; items referenced only by them are cancelled
   * and `purge_item` jobs enqueued at `now`. Other drafts and every work
   * revision are untouched. Counts describe what was removed. With
   * `expectedRevision`, a draft whose revision differs (a save on its
   * current base advanced it after the author confirmed) or that has any
   * unresolved conflict copy (a save on an outdated base) throws
   * `CommunityConflictError("draft_changed")` and nothing is removed or
   * receipted; a replay of a completed deletion returns its receipt. Without
   * `expectedRevision` the draft and its conflict copies are deleted.
   */
  deleteDraft(
    actorId: string,
    draftId: string,
    command: PublishingDraftDeletionCommand,
    now: Date,
  ): Promise<PublishingDraftDeletion>;
  /** Snapshots of the draft's lineage (its work, else the draft), newest first. */
  listHistory(
    actorId: string,
    draftId: string,
    query: PublishingPageQuery,
  ): Promise<PublishingSnapshotPage>;
  /**
   * Author command. The lineage snapshot's content becomes the current draft
   * content at revision + 1 and a `restored` snapshot is recorded. Never
   * submits or republishes (V04).
   */
  restoreSnapshot(
    actorId: string,
    draftId: string,
    command: RestorePublishingSnapshotCommand,
    now: Date,
  ): Promise<PublishingDraft>;
  /**
   * Author command. `device` makes the conflict copy's content current at
   * revision + 1; `account` keeps the current content. The copy is resolved;
   * the unchosen content stays recoverable as a pinned `conflict` snapshot
   * (the account content gets one; the copy keeps its own). A chosen copy's
   * snapshot stops reading as a conflict copy: it becomes an unpinned
   * `saved` snapshot of the new revision at `now`, and the lineage is
   * trimmed to `history_limit` like a Save now. So a pinned `conflict`
   * snapshot always holds unchosen content, and pinned snapshots are never
   * evicted.
   */
  resolveConflict(
    actorId: string,
    draftId: string,
    command: ResolvePublishingConflictCommand,
    now: Date,
  ): Promise<PublishingDraft>;
  /**
   * Author command. Returns the work's active primary edit draft, or creates
   * one from the author revision (`baseRevisionId` = that revision, legacy
   * items included, draft refs for every item; authorship not set when the
   * revision declares none). `created` is true only when this request
   * inserted the draft (a replayed request identity answers as the original
   * request did). Creating counts toward `draft_limit`. A trashed or removed
   * work throws `work_unavailable`.
   */
  openEditDraft(
    actorId: string,
    workId: string,
    command: OpenWorkEditDraftCommand,
    now: Date,
  ): Promise<PublishingOpenedEditDraft>;
}

/** Media items, processing results and derivative readiness (L02-L06, A05-A06). */
export interface PublishingMediaOperations {
  /**
   * Author command. Registers one logical item held by the actor's active
   * draft or active, unexpired session: the item (`awaiting_upload`), its
   * components and a holder ref. Refusals: `items_limit` when the holder
   * already references `max_items_per_work` items that are not cancelled or
   * purged; `original_item_too_large` when an Original item's declared total
   * exceeds `original_item_max_bytes`; `component_too_large` when a Standard
   * component exceeds `standard_component_max_bytes`; `capacity_exceeded` when
   * committed + reserved + (declared total + min(declared total / 2, 64 MiB)
   * + 4 MiB) exceeds the account capacity, decided under the capacity row lock
   * (created lazily). The client pairing is stored with `verifiedBy: client`,
   * metadata privately, and the processing profile as given.
   */
  registerItem(
    actorId: string,
    command: RegisterMediaItemCommand,
    now: Date,
  ): Promise<PublishingMediaItem>;
  /** The owner's view of one item in any state. */
  readItem(actorId: string, itemId: string): Promise<PublishingMediaItem>;
  /**
   * Author command (U07). An item that is not ready (`awaiting_upload`,
   * `processing`, `failed`): components cancelled, reservation released, draft
   * and session refs removed (of every draft and session that holds it),
   * `purge_item` enqueued at `now`. A snapshot ref does not prevent the cancel
   * (the snapshot keeps its ref and restores the item as unavailable; the purge
   * waits until the snapshot is evicted). A ready item, or one a revision
   * references, is returned unchanged with no transfer to stop: removing it
   * from content is a draft save, and the client learns it from the unchanged
   * item state.
   */
  cancelItem(
    actorId: string,
    itemId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingItemChange>;
  /**
   * Author command: the explicit user retry of one component (U05). The
   * component returns to `awaiting` with no attempt (a `receiving` component's
   * transfer is listed to stop); a blob it already had is released
   * (`purge_blob` enqueued); a failed item returns to
   * `awaiting_upload` and its reservation is taken again (`capacity_exceeded`
   * when that no longer fits). Components of processing or ready items throw
   * `CommunityConflictError`.
   */
  resetComponent(
    actorId: string,
    itemId: string,
    role: MediaComponentRole,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<PublishingItemChange>;
  /**
   * Worker read for a `process_item` or `derive_edit` job. `null` when the
   * item is cancelled, purged or unknown, or (for `derive_edit`) no longer
   * ready: the job completes without work. `process_item` renders edit key
   * `base` with the identity edit and no cover crop: static `thumb`,
   * `display`, `full`, `cover`; live the same plus `motion`. `derive_edit`
   * uses the job payload with mode `derive`. Uploaded items carry source
   * `upload`. A legacy item (a Phase 4 PNG) is only ever derived: its
   * `derive_edit` input carries source `legacy_user_media` with the user media
   * id, byte size and `image/png`, no components and quality mode `standard`;
   * `process_item`, a `base` edit key or missing user media read as `null`
   * (its unedited form keeps the user media route).
   */
  readProcessing(
    job: Pick<PublishingJobClaim, "kind" | "subjectId" | "payload">,
  ): Promise<PublishingProcessingInput | null>;
  /**
   * Worker read of a legacy item's source PNG for `derive_edit`: the bytes of
   * the `community.user_media` row the item names, owned by the item's owner
   * (the item decides the owner; no other account's media is reachable).
   * `null` for an unknown, purged or uploaded item, or when the user media row
   * is gone. Never touches or rewrites user media.
   */
  readLegacyMediaBytes(itemId: string): Promise<Uint8Array | null>;
  /**
   * Job `process_item` success, in one transaction: derivative blobs and rows
   * recorded, detected types, presentation and pairing stored (private facts
   * such as display rotation and still EXIF orientation privately),
   * components `verified`, derivative bytes committed and the remaining
   * reservation released, item `ready`, then derivative jobs ensured for the
   * edits of every active draft that references the item.
   */
  markItemReady(
    itemId: string,
    outcome: PublishingProcessedOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit>;
  /** Job `derive_edit` success: records the edit's derivative blobs and rows; the item stays ready. */
  recordDerivatives(
    itemId: string,
    outcome: PublishingDerivedOutcome,
    now: Date,
  ): Promise<PublishingDerivativeCommit>;
  /**
   * Job `process_item` rejection: item `failed` with the content-free code and
   * its derivative allowance released. Received component blobs stay until
   * the user resets a component or removes the item. A `derive_edit`
   * rejection is recorded with `failJob(…, { retryable: false })` instead.
   */
  markItemFailed(
    itemId: string,
    failureCode: MediaFailureCode,
    now: Date,
  ): Promise<void>;
  /**
   * Not receipted; idempotent. For each content item: computes its edit keys
   * in SQL (display/full/motion from the edit alone; thumb/cover from the
   * edit and, for the cover item, the cover crop), enqueues `derive_edit` at
   * `now` for ready items whose derivatives are missing (one active job per
   * item, edit key and variant set; variants an active job does not cover get
   * their own job), moves still-settling jobs the content needs up to `now`
   * and reports readiness. A legacy item needs only its non-`base`
   * derivatives (its unedited form is the user media PNG), which it derives
   * like an uploaded item. A variant whose derive job for that key failed or
   * was abandoned reads `failed` and is not enqueued again (operator retry).
   * Placeholders are `pending`; items the actor does not own are
   * `unavailable`. `submit` enqueues nothing itself: the service submits
   * first and, only on a `not_ready` answer, calls this and submits again
   * when everything is ready. The explicit readiness routes call this with
   * the `holder` option (verified first, see
   * {@link PublishingEditReadinessOptions}).
   */
  ensureEditDerivatives(
    actorId: string,
    content: PublishingEditTarget,
    now: Date,
    options?: PublishingEditReadinessOptions,
  ): Promise<PublishingEditReadiness>;
}

/** Streaming component uploads behind the attempt/cancel fence (§3.4, §8.1, §9.4). */
export interface PublishingUploadOperations {
  /**
   * Not receipted. Under the component and item row locks: the actor owns the
   * item, its holder is still an active draft or an active unexpired session
   * (whose lease is renewed), the item is `awaiting_upload` and not cancelled,
   * the component is `awaiting` (or `receiving` with `supersede`), and
   * `contentLength` equals the declared bytes (`component_too_large` when
   * larger, a generic input error otherwise). The component becomes
   * `receiving` under this attempt. Other states throw
   * `CommunityConflictError`.
   */
  beginComponentUpload(
    actorId: string,
    componentId: string,
    start: PublishingUploadStart,
    now: Date,
  ): Promise<PublishingUploadFence>;
  /**
   * Finalizes a stored transfer under the item and component row locks:
   * `superseded` when the component is no longer `receiving` under the fence
   * attempt; `cancelled` when the item, component or holder was cancelled,
   * discarded, deleted or expired (a component whose holder ended returns to
   * `awaiting`); `size_mismatch` when the blob size differs from the declared
   * bytes (the component returns to `awaiting`). An active session whose lease
   * lapsed while this transfer streamed still accepts the commit, but its
   * lease is not renewed (it stays inaccessible, D11). Otherwise
   * inserts the blob (purpose from the fence), marks the component `received`
   * with its SHA-256, moves its declared bytes from reserved to committed
   * (actual size) and, when every component is received, moves the item to
   * `processing` and enqueues `process_item`.
   */
  commitComponentUpload(
    fence: PublishingUploadFence,
    blob: PublishingMediaWriteResult,
    now: Date,
  ): Promise<PublishingUploadCommit>;
  /**
   * The transfer ended without a stored blob (client abort, overflow, store
   * failure): a component still `receiving` under the fence attempt returns to
   * `awaiting`. Idempotent; any other state is left unchanged.
   */
  abortComponentUpload(fence: PublishingUploadFence, now: Date): Promise<void>;
}

/** Explicit, idempotent submissions (U11, P05-P06, V06-V07, A03). */
export interface PublishingSubmissionOperations {
  /**
   * Author command, receipted only when `confirmed`. Holder: the actor's
   * active draft or active unexpired session (a draft no longer active, or a
   * submitted, discarded or lapsed session, throws `CommunityConflictError`;
   * a deleted draft, a conflict copy and any holder the actor does not own
   * throw `CommunityNotFoundError`). An edit of a trashed
   * or removed work throws `work_unavailable`; a `baseRevisionId` other than
   * the work's author revision (or non-null for a new work) throws
   * `CommunityConflictError`. `items_limit` applies the configured maximum;
   * `daily_limit` counts only the first submission of a new work on the
   * America/New_York date of `now`. When any item is a placeholder, not
   * ready, or lacks its edit derivatives (for a legacy item: its non-`base`
   * derivatives) the result is `not_ready` listing those keys and the
   * transaction rolls back (no receipt, no audit, no job). A session holder is
   * usable under the `expireSession` rule; the refs of the holder move to the
   * revision, released items wait the orphan grace from `now`, and a session's
   * items the revision does not keep are cancelled.
   * Otherwise the revision, its items and refs, dispositions, visibility,
   * public pointers, first publication and edited times, the holder transfer
   * and the author event are written atomically per design §2.4.
   */
  submit(
    actorId: string,
    command: WorkSubmissionCommand,
    now: Date,
  ): Promise<WorkSubmissionResult>;
  /** The confirmed receipt stored for the actor's `requestId`, or `null`. */
  readSubmissionReceipt(
    actorId: string,
    requestId: string,
  ): Promise<WorkSubmissionReceipt | null>;
}

/** Author work reads, visibility and the recycle bin (P03, P10-P12, T01-T04). */
export interface PublishingWorkOperations {
  /**
   * The author revision of the actor's non-deleted, non-trashed work prepared
   * for editing (hidden and removed works included, so the author sees them),
   * with the active primary edit draft id when one exists.
   */
  readEditableWork(actorId: string, workId: string): Promise<EditableWork>;
  /**
   * Author command (P10). public→self is immediate and withdraws pending
   * revisions; self→public follows the current policy (direct: the author
   * revision becomes public; pre-moderation: it becomes pending). A trashed
   * or removed work throws `work_unavailable`.
   */
  setVisibility(
    actorId: string,
    workId: string,
    command: WorkVisibilityCommand,
    now: Date,
  ): Promise<WorkVisibilityResult>;
  /**
   * Author command; `DELETE works/:workId`. Permanently erases the actor's
   * work content, revisions, drafts and snapshots. A minimal identity remains
   * for relational/audit integrity; unshared media is cancelled for cleanup.
   * The exact request can replay; later distinct requests find no work.
   */
  deleteWork(
    actorId: string,
    workId: string,
    command: PublishingCommandIdentity,
    now: Date,
  ): Promise<{ readonly deleted: true }>;
  /**
   * Job `purge_trashed_work`: a work still trashed with `trash_purge_after`
   * ≤ `now` gets `deleted_at` = `now`; the refs of its revisions, drafts,
   * snapshots and sessions are released in one item lock pass (id order); its
   * snapshots, drafts and their conflict copies are deleted (no draft content
   * outlives the work) and its active sessions discarded. Items left without
   * refs: those a revision of the work named wait the orphan grace from `now`
   * (`purge_item` runs at `now` + `orphan_grace_days` + 1 s, computed in SQL
   * like the purge recheck; cancelled ones at `now`); the rest, held only by
   * the work's drafts, history or sessions, are cancelled at once like a draft
   * deletion (reservations released, purge at `now`).
   */
  purgeTrashedWork(workId: string, now: Date): Promise<PublishingTrashPurge>;
}

/** Private derivative read authorization (P13, S04). */
export interface PublishingMediaReadOperations {
  /**
   * The derivative a viewer may stream, or `null` (answered as not found).
   * The owner may read any recorded derivative of an item that is not purged.
   * Anyone else only a derivative whose variant and edit key belong to an item
   * of the public revision of a work that satisfies `community.work_is_public`
   * with an active author and `accounts_can_interact(viewer, author)`. A legacy
   * item's unedited form has no derivative here (it keeps the user media
   * route); its edited derivatives follow the same rules as uploaded items.
   */
  resolveMediaRead(
    viewerId: string | null,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
  ): Promise<PublishingMediaReadTarget | null>;
}

/** The durable PostgreSQL job queue and cleanup primitives (T05-T06). */
export interface PublishingJobOperations {
  /**
   * Leases up to `limit` queued jobs with `run_after` ≤ `now`, oldest first
   * (`FOR UPDATE SKIP LOCKED`): state `running`, attempts + 1, lease until
   * `now` + `leaseMs`.
   */
  claimJobs(
    options: PublishingJobClaimOptions,
    now: Date,
  ): Promise<readonly PublishingJobClaim[]>;
  /** Extends a held lease to `now` + `leaseMs`; false when the lease was lost. */
  renewJobLease(
    lease: PublishingJobLease,
    leaseMs: number,
    now: Date,
  ): Promise<boolean>;
  /** `succeeded` with `finished_at` = `now`; false when the lease was lost. */
  completeJob(lease: PublishingJobLease, now: Date): Promise<boolean>;
  /**
   * Gives a held claim back without spending an attempt (worker shutdown, a
   * claim that arrived after stop began): `running` → `queued` with attempts
   * − 1 (never below 0), `run_after` = `now`, lease cleared, `last_error_code`
   * kept. False when the lease was lost; nothing changes then.
   */
  releaseJob(lease: PublishingJobLease, now: Date): Promise<boolean>;
  /** Give a busy publication claim back with a durable delay, without spending an attempt. */
  deferJob?(
    lease: PublishingJobLease,
    delayMs: number,
    now: Date,
  ): Promise<boolean>;
  /**
   * Records a content-free error code (`^[a-z][a-z0-9_]{0,63}$`). Retryable
   * with attempts below the maximum: queued again at `now` +
   * min(30 s × 2^(attempts − 1), 1 h). Otherwise `failed` (operator retry or
   * abandon); a `process_item` job that fails finally fails its
   * still-processing item in the same transaction (`processing_failed`, open
   * reservations released), so a later `markItemFailed` for it changes
   * nothing. `lease_lost` changes nothing.
   */
  failJob(
    lease: PublishingJobLease,
    errorCode: string,
    now: Date,
    options?: PublishingJobFailureOptions,
  ): Promise<PublishingJobFailure>;
  /**
   * Running jobs whose lease passed: queued at `now` (attempts kept), or
   * `failed` with `lease_expired` when no attempt is left. A `process_item`
   * job that fails this way fails its still-processing item in the same
   * transaction (`processing_failed`, open reservations released), since no
   * worker observes it. Returns the count of changed jobs.
   */
  requeueExpiredJobs(now: Date, limit: number): Promise<number>;
  /** Idempotent enqueue: an equal queued or running job (kind, subject, payload) is reused. */
  enqueueJob(
    job: PublishingJobEnqueue,
    now: Date,
  ): Promise<PublishingJobEnqueued>;
  /**
   * One bounded scheduling pass (at most `limit` rows per step). First, in
   * its own transaction, ready edit renditions (never `base`) of ready items
   * that were recorded more than an hour ago, whose item no active session
   * holds and that no draft, conflict copy, snapshot or revision holding the
   * item wants (the required set plus `viewer`) become `released` (their
   * blobs become unused; rows are never deleted). Then: `expire_session`
   * for active sessions whose lease passed; `purge_trashed_work` for trashed
   * works past `trash_purge_after`; `purge_item` for items without refs that
   * are cancelled, or whose last change (a released ref counts) is older than
   * `orphan_grace_days`; `purge_blob` for blobs tombstoned more than one hour
   * ago and committed blobs no live component or unreleased rendition has
   * used for an hour; a blob under the D7 retention hold (a pre-task blob
   * this task replaced) is never scheduled.
   * A subject whose job of that kind failed or was abandoned is skipped
   * (the operator decides). Finally `succeeded` job rows finished more than 7
   * days ago are deleted. `sweep_staging` and `reconcile_capacity` are
   * enqueued by the worker on its own cadence.
   */
  scheduleCleanup(now: Date, limit: number): Promise<PublishingCleanupCounts>;
  /**
   * Job `purge_item`. Under the item row lock, rechecks that nothing keeps the
   * item (see `PublishingPurgePlan`: refs, revisions of works that are not
   * purged, live draft or snapshot content, and the orphan grace unless the
   * item is cancelled); then the item becomes `purged` (open reservations
   * released) and every blob of its components and renditions (any state)
   * is tombstoned. This is the author's own lifecycle, so a blob under the
   * D7 retention hold is tombstoned too and its hold cleared, as before this
   * task (Owner decision: only task-initiated deletions are held). Never
   * touches user media, Catalog or avatar data.
   */
  purgeItem(itemId: string, now: Date): Promise<PublishingPurgePlan>;
  /**
   * Job `purge_blob`. A tombstoned blob, or a committed blob no live component
   * or unreleased rendition uses, is (re)tombstoned and returned for
   * unlinking. A held blob (D7), or a pre-task blob a task-initiated change
   * freed (it is held now), reads as `referenced`.
   */
  purgeBlob(blobId: string, now: Date): Promise<PublishingPurgePlan>;
  /**
   * After the store removed their keys: tombstoned blobs become `purged` and
   * each owner's committed bytes drop by their size exactly once (owner-less
   * Catalog blobs count toward no capacity). Blobs in any other state are
   * ignored.
   */
  confirmPurged(blobIds: readonly string[], now: Date): Promise<void>;
}

/**
 * The complete work publishing persistence port used by
 * `WorkPublishingService` (author routes) and the publishing worker.
 * Operator commands live on `PublishingOperatorPort`.
 */
export interface WorkPublishingPort
  extends
    PublishingSettingsOperations,
    PublishingSessionOperations,
    PublishingDraftOperations,
    PublishingMediaOperations,
    PublishingUploadOperations,
    PublishingSubmissionOperations,
    PublishingWorkOperations,
    PublishingMediaReadOperations,
    PublishingJobOperations {}
