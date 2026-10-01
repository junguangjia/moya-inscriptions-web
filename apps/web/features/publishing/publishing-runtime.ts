import { createDraftAutosave, sameDraftContent } from "./draft-autosave";
import { createEditReadinessTracker } from "./edit-readiness";
import {
  addStaticPhotosToStaging,
  attachStagedCounterpart,
  confirmStaging,
  countStaging,
  removeStagedEntry,
  resolveStagedAmbiguity,
  setBatchOriginal,
  keepStagedStillAsPhoto,
} from "./import-grouping";
import { createSubmissionController } from "./submission-reconcile";
import { UploadManager, summarizeUploads } from "./upload-manager";
import { createExternalStore } from "./upload-manager-store";
import { confirmedItems, replaceItem } from "./ui/media/media-order";

import type { DraftAutosave, DraftAutosavePort } from "./draft-autosave";
import type {
  EditReadinessState,
  EditReadinessTracker,
} from "./edit-readiness";
import type { BlobHasher } from "./hashing";
import type {
  ConfirmStagingResult,
  FileOrigin,
  IdentifiedFile,
  StagingBatch,
  StagingChoiceError,
  StagingCount,
} from "./import-grouping";
import type { LocalRecoveryStore, RestorePlanEntry } from "./local-recovery";
import type { PreprocessPort } from "./preprocess/worker-client";
import type {
  SubmissionController,
  SubmissionPort,
  SubmissionState,
} from "./submission-reconcile";
import type {
  UploadClientPort,
  UploadManagerOptions,
  UploadManagerSnapshot,
  UploadTimers,
  UploadCheckpoint,
} from "./upload-manager";
import type { ExternalStore } from "./upload-manager-store";
import type { TransferPort } from "./uppy-transfer";
import type { EditorTarget } from "../product-shell/product-history";
import type {
  CreatePublishingSessionCommand,
  CreatePublishingDraftCommand,
  PublishingDeviceClass,
  PublishingDraft,
  PublishingDraftDeletionResult,
  PublishingHolder,
  PublishingLimits,
  PublishingOpenedEditDraft,
  PublishingReadiness,
  PublishingSession,
  WorkDraftContent,
  WorkDraftItem,
  WorkSubmissionContent,
} from "@moya/contracts";

/**
 * Framework-free publishing runtime behind the provider: one upload manager
 * per account (an account change pauses every other account's manager and
 * suspends its autosave and heartbeat, and nothing of one account is ever
 * sent under another), one active editor session per account, the selection
 * staging batch, draft autosave (saved mode) or a minimal temporary session
 * (no-save mode), and the explicit submission controller. Item identities
 * assigned by registration flow into the saved content by themselves.
 */

export interface PublishingClientPort
  extends UploadClientPort, DraftAutosavePort, SubmissionPort {
  limits(): Promise<PublishingLimits>;
  openWorkEditDraft?(
    workId: string,
    cmd: { requestId: string; deviceClass: PublishingDeviceClass | null },
  ): Promise<PublishingOpenedEditDraft>;
  createSession(
    cmd: CreatePublishingSessionCommand,
  ): Promise<PublishingSession>;
  heartbeatSession(sessionId: string): Promise<PublishingSession>;
  discardSession(
    sessionId: string,
    cmd: { requestId: string },
  ): Promise<{ discarded: true }>;
  deleteDraft(
    draftId: string,
    cmd: { requestId: string; expectedRevision?: number },
  ): Promise<PublishingDraftDeletionResult>;
  /** Readiness of the holder's content; starts missing edit derivatives (§10). */
  readiness(
    holder: PublishingHolder,
    content: WorkDraftContent,
  ): Promise<PublishingReadiness>;
}

export interface PublishingServices {
  readonly client: PublishingClientPort;
  readonly currentAccount: () => string | null;
  readonly requestId: () => string;
  readonly createTransfer: (concurrency: number) => TransferPort;
  readonly createPreprocess: () => PreprocessPort;
  readonly createHasher: () => BlobHasher | null;
  readonly createRecovery: () => LocalRecoveryStore | null;
  readonly identifyFiles: (files: readonly File[]) => Promise<IdentifiedFile[]>;
  readonly preprocessConcurrency: () => number;
  readonly transferConcurrency: number;
  readonly deviceClass: () => PublishingDeviceClass;
  readonly timers?: UploadTimers;
  /** Private metadata extraction (exifr in browsers). */
  readonly metadata?: UploadManagerOptions["metadata"];
}

export type SaveMode = "saved" | "unsaved";

export interface EditorSessionView {
  readonly target: EditorTarget;
  /** The Thread a new work publishes into (quick composer), else null. */
  readonly threadId: string | null;
  readonly saveMode: SaveMode;
  readonly draftId: string | null;
  readonly sessionId: string | null;
  readonly workId: string | null;
  readonly baseRevisionId: string | null;
  /** The editor content is not empty (text or items): leaving a no-save session would lose it. */
  readonly hasContent: boolean;
}

export interface PublishingCheckpoint {
  readonly draftCreation?: CreatePublishingDraftCommand | null;
  readonly view: EditorSessionView;
  readonly savedDraft: PublishingDraft | null;
  readonly baseline: WorkDraftContent | null;
  readonly content: WorkDraftContent | null;
  readonly uploads: readonly UploadCheckpoint[];
  readonly staging: StagingBatch | null;
  readonly pendingFiles: readonly {
    id: string;
    files: readonly File[];
    origin: FileOrigin;
    original: boolean;
    replacement?: {
      target: string;
      previous: Pick<WorkDraftItem, "kind" | "qualityMode" | "edit">;
    };
  }[];
}

export interface StagingView {
  readonly batch: StagingBatch;
  readonly count: StagingCount;
  /** Files still being identified. */
  readonly identifying: number;
}

export interface RuntimeSnapshot {
  readonly accountId: string | null;
  readonly session: EditorSessionView | null;
  readonly staging: StagingView | null;
  readonly limits: PublishingLimits | null;
}

/** Heartbeat for a temporary no-save session while its editor is open. */
export const SESSION_HEARTBEAT_MS = 10 * 60 * 1000;

const DEFAULT_MAX_ITEMS = 50;

interface AccountRuntime {
  readonly manager: UploadManager;
  session: SessionRecord | null;
  /** The confirmed submission of the session that just ended (its receipt stays readable). */
  completed: SubmissionController | null;
  staging: StagingBatch | null;
  identifying: number;
  limits: PublishingLimits | null;
}

interface SessionRecord {
  draftCreation: CreatePublishingDraftCommand | null;
  view: EditorSessionView;
  savedDraft: PublishingDraft | null;
  pendingFiles: Map<
    symbol,
    {
      id: string;
      files: readonly File[];
      origin: FileOrigin;
      original: boolean;
      replacement?: {
        target: string;
        previous: Pick<WorkDraftItem, "kind" | "qualityMode" | "edit">;
      };
    }
  >;
  submitting: boolean;
  autosave: DraftAutosave | null;
  submission: SubmissionController;
  /** Edit derivative readiness of the album (QA D1). */
  readonly readiness: EditReadinessTracker;
  latest: WorkDraftContent | null;
  /**
   * The content the editor opened with when no draft carries it (a no-save
   * edit of a published work): until the first edit arrives it stands in for
   * `latest` in the album (item limits, managed items), never for whether the
   * session holds content of its own.
   */
  readonly baseline: WorkDraftContent | null;
  sessionRequestId: string | null;
  sessionTask: Promise<string> | null;
  heartbeat: unknown;
  closed: boolean;
  /** Stops following the submission store. */
  unsubscribe: () => void;
  /**
   * Keys of items confirmed from staging in this session that the editor
   * content has not listed yet: only these are appended by themselves. Once
   * the editor lists an item, or an adopted version leaves it out, the
   * content alone decides whether it belongs to the album (V04).
   */
  appendable: Set<string>;
  /** The item count last published for staging limits. */
  itemCount: number;
  pendingSelections: Set<symbol>;
}

const liveItemCount = (manager: UploadManager) =>
  manager
    .getSnapshot()
    .items.filter(
      (item) => item.phase !== "cancelled" && item.phase !== "cleanup",
    ).length;

/** The content that decides the album: the latest edit, else what the editor opened with. */
const albumContent = (session: SessionRecord): WorkDraftContent | null =>
  session.latest ?? session.baseline;

/**
 * Keys of the manager's items that belong to the session's album: items the
 * album content lists and confirmed items it does not list yet. Null while
 * there is no album content (every manager item belongs to it then).
 */
const albumKeys = (
  session: SessionRecord | null,
): ReadonlySet<string> | null => {
  if (session === null || session.closed) return null;
  const content = albumContent(session);
  if (content === null) return null;
  const keys = new Set(content.items.map((item) => item.key));
  for (const key of session.appendable) keys.add(key);
  return keys;
};

/** The manager snapshot restricted to the album (the same object when nothing is left out). */
const albumSnapshot = (
  snapshot: UploadManagerSnapshot,
  session: SessionRecord | null,
): UploadManagerSnapshot => {
  const keys = albumKeys(session);
  if (keys === null || snapshot.items.every((item) => keys.has(item.key)))
    return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.filter((item) => keys.has(item.key)),
  };
};

/**
 * The items the work would hold now: every item the album content lists
 * (including media the manager does not track, such as legacy or other-device
 * items of an edit) except ones the manager has cancelled (they are leaving
 * the album), plus confirmed items the content does not list yet. Without a
 * session, the manager's live items.
 */
const albumItemCount = (
  manager: UploadManager,
  session: SessionRecord | null,
): number => {
  if (session === null || session.closed) return liveItemCount(manager);
  const leaving = new Set(
    manager
      .getSnapshot()
      .items.filter(
        (item) => item.phase === "cancelled" || item.phase === "cleanup",
      )
      .map((item) => item.key),
  );
  const keys = new Set(
    (albumContent(session)?.items ?? [])
      .map((item) => item.key)
      .filter((key) => !leaving.has(key)),
  );
  for (const item of manager.draftItems())
    if (session.appendable.has(item.key)) keys.add(item.key);
  return keys.size;
};

const hasContent = (content: WorkDraftContent | null): boolean =>
  content !== null &&
  (content.title.trim() !== "" ||
    content.body.trim() !== "" ||
    content.items.length > 0);

type ManagedItem = ReturnType<UploadManager["draftItems"]>[number];

const NOTHING_APPENDABLE: ReadonlySet<string> = new Set();

/**
 * Brings item identities, quality after an explicit Original choice and the
 * clipboard provenance from the manager into content items with the same
 * key; items the content does not list yet are added as pending entries only
 * when their key is `appendable` (confirmed from staging and not yet listed
 * or left out by the editor). Manager items outside both are never re-added:
 * a restored or chosen version decides the album.
 */
/** Quick-composer bound for a Thread post (content-community-completion-v1). */
export const THREAD_QUICK_COMPOSER_ITEMS = 3;
const sessionMaxItems = (
  session: { readonly view: { readonly threadId: string | null } } | null,
  limit: number,
): number =>
  session?.view.threadId ? Math.min(limit, THREAD_QUICK_COMPOSER_ITEMS) : limit;

const withManagedItems = <
  C extends { readonly items: readonly WorkDraftItem[] },
>(
  content: C,
  managed: readonly ManagedItem[],
  appendable: ReadonlySet<string> = NOTHING_APPENDABLE,
): C => {
  const byKey = new Map(managed.map((item) => [item.key, item]));
  let changed = false;
  const items = content.items.map((item): WorkDraftItem => {
    const current = byKey.get(item.key);
    if (!current) return item;
    // Provenance never changes for a key: once from the clipboard, always.
    const origin = item.origin ?? current.origin;
    if (
      current.itemId === item.itemId &&
      current.qualityMode === item.qualityMode &&
      origin === item.origin
    )
      return item;
    changed = true;
    const base = {
      key: item.key,
      kind: item.kind,
      qualityMode: current.qualityMode,
      edit: item.edit,
      ...(origin === undefined ? {} : { origin }),
    };
    return current.itemId === null
      ? {
          ...base,
          itemId: null,
          pendingLabel: item.kind === "live" ? "live" : "photo",
        }
      : { ...base, itemId: current.itemId };
  });
  const known = new Set(content.items.map((item) => item.key));
  const missing = managed
    .filter((item) => !known.has(item.key) && appendable.has(item.key))
    .map((item): WorkDraftItem => ({
      ...item,
      edit: { rotation: 0, crop: null },
    }));
  return !changed && missing.length === 0
    ? content
    : { ...content, items: [...items, ...missing] };
};

/** The placeholder before the editor has sent any content; claims nothing (C05). */
const emptyContent = (): WorkDraftContent => ({
  title: "",
  body: "",
  authorship: null,
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
});

export class PublishingRuntime {
  readonly store: ExternalStore<RuntimeSnapshot>;
  private readonly services: PublishingServices;
  private readonly accounts = new Map<string, AccountRuntime>();
  private accountId: string | null = null;
  private readonly timers: UploadTimers;
  private selectionTail: Promise<void> = Promise.resolve();
  private selectionEpoch = 0;

  constructor(services: PublishingServices) {
    this.services = services;
    this.timers = services.timers ?? {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.store = createExternalStore<RuntimeSnapshot>(this.snapshot());
  }

  // -- accounts ------------------------------------------------------------

  /**
   * The confirmed viewer. Every other account's manager and session pauses;
   * nothing of theirs is visible or resumed while another account is active.
   */
  setAccount(accountId: string | null): void {
    if (accountId === this.accountId) return;
    this.selectionEpoch += 1;
    for (const [id, account] of this.accounts)
      if (id !== accountId) {
        account.manager.pause("account");
        // A pending draft save of this account must never be sent under another one.
        account.session?.autosave?.suspend();
        this.stopHeartbeat(account.session);
      }
    this.accountId = accountId;
    const returning = this.accounts.get(accountId ?? "");
    if (returning) {
      returning.manager.resumeIfIdle();
      const session = returning.session;
      if (session && !session.closed) {
        session.autosave?.resume();
        if (session.view.sessionId !== null)
          this.startHeartbeat(returning, session);
        session.readiness.poke();
      }
    }
    if (accountId !== null && !this.accounts.has(accountId)) {
      const manager = new UploadManager({
        accountId,
        client: this.services.client,
        transfer: this.services.createTransfer(
          this.services.transferConcurrency,
        ),
        preprocess: this.services.createPreprocess(),
        currentAccount: this.services.currentAccount,
        requestId: this.services.requestId,
        attemptId: this.services.requestId,
        preprocessConcurrency: this.services.preprocessConcurrency(),
        transferConcurrency: this.services.transferConcurrency,
        hasher: this.services.createHasher(),
        recovery: this.services.createRecovery(),
        ...(this.services.timers ? { timers: this.services.timers } : {}),
        ...(this.services.metadata ? { metadata: this.services.metadata } : {}),
      });
      const account: AccountRuntime = {
        manager,
        session: null,
        completed: null,
        staging: null,
        identifying: 0,
        limits: null,
      };
      this.accounts.set(accountId, account);
      // Staging counts depend on the manager's item count; progress alone does not republish.
      let itemCount = 0;
      let identities = "";
      let readyKeys = "";
      manager.store.subscribe(() => {
        const count = liveItemCount(manager);
        if (count !== itemCount && this.accountId === accountId) {
          itemCount = count;
          this.publish();
        }
        // An item the account just made ready can now get its edit derivatives.
        const ready = manager
          .getSnapshot()
          .items.filter((item) => item.phase === "ready")
          .map((item) => item.key)
          .join("|");
        if (ready !== readyKeys) {
          readyKeys = ready;
          if (ready !== "" && this.accountId === accountId)
            account.session?.readiness.poke();
        }
        // Registration assigns item ids: the saved content follows without the editor.
        const next = manager
          .draftItems()
          .map(
            (item) =>
              `${item.key}:${item.itemId}:${item.qualityMode}:${item.origin ?? ""}`,
          )
          .join("|");
        if (next !== identities) {
          identities = next;
          this.syncManagedItems(account);
        }
      });
      void this.loadLimits(accountId);
    }
    this.publish();
  }

  /** The current account's manager, or null for a guest. */
  manager(): UploadManager | null {
    return this.current()?.manager ?? null;
  }

  /** The session's submission, or the confirmed one of the session that just completed. */
  submission(): SubmissionController | null {
    const account = this.current();
    return account?.session?.submission ?? account?.completed ?? null;
  }

  autosave(): DraftAutosave | null {
    return this.current()?.session?.autosave ?? null;
  }

  /** The session's edit derivative readiness (see edit-readiness.ts), or null. */
  editReadiness(): ExternalStore<EditReadinessState> | null {
    const session = this.current()?.session;
    return session && !session.closed ? session.readiness.store : null;
  }

  /**
   * The manager's draft entries that belong to the session's album: items the
   * content lists and confirmed items it does not list yet. Items a chosen
   * version left out stay tracked (their uploads are not cancelled) but are
   * not offered to the editor again.
   */
  draftItems(): ManagedItem[] {
    const account = this.current();
    if (!account) return [];
    const items = account.manager.draftItems();
    const keys = albumKeys(account.session);
    return keys === null ? items : items.filter((item) => keys.has(item.key));
  }

  /**
   * `snapshot` (the current manager's) restricted to the album's items, for
   * progress and readiness outside the editor: items a chosen version left
   * out are neither counted nor shown as unfinished there.
   */
  albumUploads(snapshot: UploadManagerSnapshot): UploadManagerSnapshot {
    const account = this.current();
    return account && account.manager.accountId === snapshot.accountId
      ? albumSnapshot(snapshot, account.session)
      : snapshot;
  }

  // -- editor session ------------------------------------------------------

  /**
   * Opens the one editor session of this account. A saved draft (reopened or
   * an edit draft) is passed in; a new work starts without any server record.
   * `content` is what the editor opens with when no draft carries it (a
   * no-save edit of a published work): its items count against the item
   * limit before the first edit arrives.
   */
  startSession(options: {
    readonly target: EditorTarget;
    readonly saveMode: SaveMode;
    readonly draft?: PublishingDraft | null;
    readonly workId?: string | null;
    readonly baseRevisionId?: string | null;
    readonly content?: WorkDraftContent | null;
  }): EditorSessionView | null {
    const account = this.current();
    if (!account) return null;
    if (account.session && !account.session.closed) return account.session.view;
    const draft = options.draft ?? null;
    const saveMode = draft ? "saved" : options.saveMode;
    const view: EditorSessionView = {
      target: options.target,
      threadId:
        options.target.type === "new"
          ? (options.target.threadId ?? null)
          : null,
      saveMode,
      draftId: draft?.id ?? null,
      sessionId: null,
      workId: draft?.workId ?? options.workId ?? null,
      baseRevisionId: draft?.baseRevisionId ?? options.baseRevisionId ?? null,
      hasContent: hasContent(draft?.content ?? null),
    };
    const submission = createSubmissionController({
      port: this.services.client,
      requestId: this.services.requestId,
    });
    const record: SessionRecord = {
      draftCreation: null,
      view,
      savedDraft: draft,
      pendingFiles: new Map(),
      submitting: false,
      autosave: null,
      submission,
      readiness: createEditReadinessTracker({
        content: () => this.readinessContent(account, record),
        check: (content) => this.checkReadiness(account, record, content),
        timers: this.timers,
      }),
      latest: draft?.content ?? null,
      baseline: draft ? null : (options.content ?? null),
      sessionRequestId: null,
      sessionTask: null,
      heartbeat: null,
      closed: false,
      unsubscribe: () => undefined,
      appendable: new Set(),
      pendingSelections: new Set(),
      itemCount: (draft?.content ?? options.content)?.items.length ?? 0,
    };
    // However the confirmation arrives (answer, receipt, explicit retry), the session completes.
    record.unsubscribe = submission.store.subscribe(() => {
      if (submission.store.get().status === "confirmed")
        this.completeSession(account, record);
    });
    if (saveMode === "saved")
      record.autosave = this.createAutosave(account, record, draft);
    account.completed?.dispose();
    account.completed = null;
    account.session = record;
    account.manager.resumeIfIdle();
    account.manager.setDraftId(view.draftId);
    account.manager.bindSession({
      saveMode,
      resolveHolder: () => this.resolveHolder(account, record),
    });
    // A reopened draft may carry edits whose derivatives do not exist yet.
    record.readiness.schedule();
    this.publish();
    return view;
  }

  /** Reopens a saved draft's media on this browser (after `startSession`). */
  async restoreDraftMedia(draft: PublishingDraft): Promise<RestorePlanEntry[]> {
    const account = this.current();
    if (!account?.session || account.session.view.saveMode !== "saved")
      return [];
    return account.manager.restoreDraft(draft);
  }

  checkpoint(): PublishingCheckpoint | null {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return null;
    return {
      view: session.view,
      draftCreation: session.draftCreation,
      savedDraft: session.savedDraft,
      baseline: session.baseline,
      content: session.latest,
      uploads: account.manager.checkpoint(),
      staging: account.staging,
      pendingFiles: [...session.pendingFiles.values()],
    };
  }

  async restoreCheckpoint(checkpoint: PublishingCheckpoint): Promise<void> {
    const view = this.startSession({
      ...checkpoint.view,
      saveMode: "saved",
      draft: checkpoint.savedDraft,
      content: checkpoint.baseline,
    });
    const account = this.current();
    const session = account?.session;
    if (!view || !account || !session) return;
    session.draftCreation = checkpoint.draftCreation ?? null;
    session.view = {
      ...session.view,
      sessionId: checkpoint.view.sessionId,
      baseRevisionId: checkpoint.view.baseRevisionId,
    };
    if (session.view.sessionId !== null) {
      const previous = session.view.sessionId;
      try {
        await this.services.client.heartbeatSession(previous);
      } catch (error) {
        if (
          (error as { status?: number })?.status === 404 &&
          this.current() === account
        ) {
          // Release an expired holder before retrying its cancelled bytes; this
          // preserves any draft/revision references and releases old reservations.
          await this.services.client
            .discardSession(previous, { requestId: this.services.requestId() })
            .catch(() => undefined);
          session.view = { ...session.view, sessionId: null };
        }
      }
      if (this.current() !== account || session.closed) return;
      if (session.view.sessionId !== null)
        this.startHeartbeat(account, session);
    }
    await account.manager.restoreCheckpoint(checkpoint.uploads);
    if (this.current() !== account || session.closed) return;
    // A pending selection may also have published staging before its acceptance
    // callback. Re-identify its retained files exactly once, with its intent.
    account.staging = checkpoint.pendingFiles.length
      ? null
      : checkpoint.staging;
    if (checkpoint.content) this.edit(checkpoint.content);
    if (account.staging?.entries.length) this.confirmStaging();
    for (const [index, pending] of checkpoint.pendingFiles.entries()) {
      const replacement = pending.replacement;
      if (
        replacement &&
        (checkpoint.pendingFiles
          .slice(index + 1)
          .some((next) => next.replacement?.target === replacement.target) ||
          !session.latest?.items.some(
            (item) => item.key === replacement.target,
          ))
      )
        continue;
      await this.stageFiles(
        pending.files,
        pending.origin,
        () => {
          this.setStagingOriginal(pending.original);
          const before = session.latest;
          const result = this.confirmStaging(replacement?.target);
          if (result.ok && replacement && before) {
            const items = confirmedItems(result.confirmed).map((item) =>
              item.kind === replacement.previous.kind
                ? { ...item, edit: replacement.previous.edit }
                : item,
            );
            const next = replaceItem(before, replacement.target, items);
            this.edit({ ...before, ...next, items: [...next.items] });
          }
        },
        pending.original,
        replacement,
      );
    }
    this.publish();
  }

  async saveNow(): Promise<void> {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed || !session.autosave) return;
    if (session.submitting) throw new Error("正在提交作品，请等待结果");
    // A saved draft must contain complete uploaded bytes. Derivatives may still
    // process, but another device must not depend on this tab's local files.
    if (
      session.pendingSelections.size > 0 ||
      account.staging?.entries.length ||
      this.draftItems().some((item) => {
        const upload = account.manager
          .getSnapshot()
          .items.find((entry) => entry.key === item.key);
        if (item.itemId && upload?.serverItem?.state === "ready") return false;
        return (
          item.itemId === null ||
          !upload ||
          upload.components.length === 0 ||
          upload.components.some((component) => component.phase !== "received")
        );
      })
    )
      throw new Error("图片还未准备好，请完成上传或移除失败项后保存草稿");
    const content = this.contentWithItems(
      account,
      session,
      session.latest ?? session.baseline,
    );
    session.latest = content;
    session.autosave.edit(content);
    await session.autosave.saveNow();
  }

  /**
   * Latest editor content; saved mode forwards it to autosave. Items the
   * editor lists are its own from now on: leaving one out later removes it.
   */
  edit(content: WorkDraftContent): void {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return;
    for (const item of content.items) session.appendable.delete(item.key);
    const merged = withManagedItems(
      content,
      account.manager.draftItems(),
      session.appendable,
    );
    session.latest = merged;
    session.autosave?.edit(merged);
    session.readiness.schedule();
    this.updateContentView(account, session, merged);
  }

  /**
   * Adopts a draft version the author chose outside autosave (conflict
   * resolution or history restore). `content` is what the editor now shows
   * for it: it becomes the session's latest content, and autosave leaves
   * the conflict and continues from the chosen draft's revision. Items the
   * manager still tracks that this content leaves out are not re-added
   * (V04); items confirmed from staging afterwards are.
   */
  adoptDraft(draft: PublishingDraft, content: WorkDraftContent): void {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return;
    session.appendable.clear();
    const adopted = withManagedItems(content, account.manager.draftItems());
    session.latest = adopted;
    if (session.view.saveMode === "saved") {
      const view = session.view;
      if (
        view.draftId !== draft.id ||
        view.baseRevisionId !== draft.baseRevisionId ||
        (draft.workId !== null && view.workId !== draft.workId)
      ) {
        session.view = {
          ...view,
          draftId: draft.id,
          baseRevisionId: draft.baseRevisionId,
          workId: draft.workId ?? view.workId,
        };
        account.manager.setDraftId(draft.id);
        this.publish();
      }
    }
    session.autosave?.adoptDraft(draft, adopted);
    session.readiness.schedule();
    this.updateContentView(account, session, adopted);
  }

  /**
   * Switches an unsaved session to saved mode. Only possible before any
   * media was registered under the temporary session.
   */
  enableSaving(): boolean {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return false;
    if (session.view.saveMode === "saved") return true;
    if (session.view.sessionId !== null) return false;
    session.view = { ...session.view, saveMode: "saved" };
    session.autosave = this.createAutosave(account, session, null);
    if (session.latest) session.autosave.edit(session.latest);
    account.manager.bindSession({
      saveMode: "saved",
      resolveHolder: () => this.resolveHolder(account, session),
    });
    this.publish();
    return true;
  }

  /**
   * Switches a saved draft to no-save after the author confirmed the
   * targeted deletion scope (D06): autosave stops and any draft save or
   * creation still in flight finishes first (so the draft it produces is the
   * one deleted), uploads stop, then that draft (its history, conflict copies
   * and media only it references) is deleted at the revision the author saw
   * and its local copies cleared.
   * The editor content stays in memory under a new temporary session; media
   * of the published work an edit draft started from keeps its identity.
   * When the deletion fails nothing changes except that uploads wait for the
   * explicit Continue.
   */
  async disableSaving(): Promise<PublishingDraftDeletionResult | null> {
    const account = this.current();
    const session = account?.session;
    if (
      !account ||
      !session ||
      session.closed ||
      session.view.saveMode !== "saved"
    )
      return null;
    const autosave = session.autosave;
    const manager = account.manager;
    autosave?.suspend();
    manager.suspendForHolderChange();
    let draftId: string | null;
    let expectedRevision: number | undefined;
    try {
      await autosave?.idle();
      draftId =
        (await autosave?.resolveCreatedDraft()) ??
        autosave?.store.get().draftId ??
        session.view.draftId;
      // The revision the author confirmed the scope against; the account
      // refuses the deletion (`draft_changed`) when another device saved a
      // newer one meanwhile, and nothing is deleted (D06).
      expectedRevision = autosave?.store.get().revision ?? undefined;
    } catch (error) {
      this.abortHolderChange(account, session);
      throw error;
    }
    let result: PublishingDraftDeletionResult | null = null;
    if (draftId !== null) {
      try {
        result = await this.services.client.deleteDraft(draftId, {
          requestId: this.services.requestId(),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        });
      } catch (error) {
        this.abortHolderChange(account, session);
        throw error;
      }
      await this.services
        .createRecovery()
        ?.clearDraft(manager.accountId, draftId)
        .catch(() => undefined);
    }
    autosave?.dispose();
    if (session.closed) return result;
    session.autosave = null;
    session.view = { ...session.view, saveMode: "unsaved", draftId: null };
    manager.setDraftId(null);
    manager.bindSession({
      saveMode: "unsaved",
      resolveHolder: () => this.resolveHolder(account, session),
    });
    await manager.detachFromHolder();
    this.publish();
    return result;
  }

  private abortHolderChange(
    account: AccountRuntime,
    session: SessionRecord,
  ): void {
    account.manager.cancelHolderChange();
    if (!session.closed && this.current() === account)
      session.autosave?.resume();
  }

  /**
   * Leaves the editor session.
   *
   * - `discard: false` (leave): the session stays alive — for the global
   *   progress entry, `"kept"` — while any album item (never one a chosen
   *   version left out) is not yet ready (preparing,
   *   transferring, processing, paused, failed or waiting for a choice; in a
   *   saved draft an item already missing on this browser loses nothing), a
   *   saved draft has unsaved input, or a no-save session holds any content
   *   (it exists nowhere else). Otherwise it ends.
   * - `discard: true` (explicit): a no-save session cancels its items and
   *   discards the temporary session on the account, including one still
   *   being created (D08). A saved draft is left as last saved; its media
   *   stays with the draft.
   */
  async closeSession(options: {
    readonly discard: boolean;
  }): Promise<"ended" | "kept" | "none"> {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return "none";
    if (session.submitting) return "kept";
    if (!options.discard) {
      if (this.leaveWouldLoseWork(account, session)) return "kept";
    } else {
      this.selectionEpoch += 1;
      session.pendingSelections.clear();
      session.pendingFiles.clear();
      const manager = account.manager;
      // Fence saves before releasing temporary ownership. A confirmed draft's
      // references preserve its uploads; explicit cancelItem would not.
      session.autosave?.suspend();
      await session.autosave?.idle();
      manager.pause("offline");
      manager.bindSession(null);
      manager.release();
      await session.sessionTask?.catch(() => undefined);
      if (
        session.view.sessionId !== null &&
        this.services.currentAccount() === account.manager.accountId
      )
        // A refused or lost discard leaves only a lease that expires on the account.
        await this.services.client
          .discardSession(session.view.sessionId, {
            requestId: this.services.requestId(),
          })
          .catch(() => undefined);
      session.view = { ...session.view, sessionId: null };
    }
    if (!session.closed) this.endSession(account, session);
    return "ended";
  }

  /** Whether leaving the current session now would lose work (see `closeSession`). */
  hasUnfinishedWork(): boolean {
    const account = this.current();
    const session = account?.session;
    return !!account && !!session && !session.closed
      ? this.leaveWouldLoseWork(account, session)
      : false;
  }

  /**
   * How many of a saved draft's items this browser still holds local copies
   * of (the recovery store): the drafts picker subtracts them from the
   * account's count of items no device has uploaded yet, so a draft whose
   * pending files are on this very browser is not warned about here.
   */
  async countLocalDraftItems(draftId: string): Promise<number> {
    const account = this.current();
    if (!account) return 0;
    const records = await this.services
      .createRecovery()
      ?.list(account.manager.accountId, draftId)
      .catch(() => []);
    return records?.length ?? 0;
  }

  /** Clears this browser's local copies of a draft deleted elsewhere (e.g. the drafts picker). */
  async forgetDraftLocalCopies(draftId: string): Promise<void> {
    const account = this.current();
    if (!account) return;
    await this.services
      .createRecovery()
      ?.clearDraft(account.manager.accountId, draftId)
      .catch(() => undefined);
  }

  private leaveWouldLoseWork(
    account: AccountRuntime,
    session: SessionRecord,
  ): boolean {
    // Items a chosen version left out lose nothing the author still has in the album.
    const snapshot = albumSnapshot(account.manager.getSnapshot(), session);
    const uploads = summarizeUploads(snapshot);
    // A saved draft's item missing on this browser loses nothing by leaving; any other
    // unfinished item would drop local bytes or a pending choice.
    const unfinished =
      session.view.saveMode === "saved"
        ? snapshot.items.some(
            (item) =>
              item.phase !== "ready" &&
              item.phase !== "cancelled" &&
              item.phase !== "cleanup" &&
              item.phase !== "missing_local",
          )
        : uploads.unfinished;
    return (
      session.pendingSelections.size > 0 ||
      unfinished ||
      (session.autosave?.hasUnsavedChanges() ?? false) ||
      (session.view.saveMode === "unsaved" &&
        (hasContent(session.latest) || uploads.total > 0))
    );
  }

  private endSession(
    account: AccountRuntime,
    session: SessionRecord,
    keepSubmission = false,
  ): void {
    session.closed = true;
    if (
      session.view.sessionId !== null &&
      this.services.currentAccount() === account.manager.accountId
    )
      void this.services.client
        .discardSession(session.view.sessionId, {
          requestId: this.services.requestId(),
        })
        .catch(() => undefined);
    session.unsubscribe();
    this.stopHeartbeat(session);
    session.autosave?.dispose();
    session.readiness.dispose();
    if (keepSubmission) {
      account.completed?.dispose();
      account.completed = session.submission;
    } else session.submission.dispose();
    account.session = null;
    account.staging = null;
    account.manager.bindSession(null);
    account.manager.setDraftId(null);
    // The next session starts empty; items of this one never leak into it.
    account.manager.release();
    this.publish();
  }

  /**
   * A confirmed submission completes the session: no pending autosave may
   * write to the submitted draft, the heartbeat stops, local copies of the
   * draft are cleared, and the receipt stays readable through `submission()`.
   */
  private completeSession(account: AccountRuntime, session: SessionRecord) {
    if (session.closed) return;
    session.autosave?.dispose();
    const draftId =
      session.autosave?.store.get().draftId ?? session.view.draftId;
    if (draftId !== null)
      void this.services
        .createRecovery()
        ?.clearDraft(account.manager.accountId, draftId)
        .catch(() => undefined);
    this.endSession(account, session, true);
  }

  // -- staging -------------------------------------------------------------

  /** Preserve selection order and fence identification to its original session.
   * The optional acceptance callback survives media-step navigation, but never
   * runs after logout, session replacement, discard or explicit cancellation.
   */
  stageFiles(
    files: readonly File[],
    origin: FileOrigin,
    onReady?: () => void,
    original = false,
    replacement?: {
      target: string;
      previous: Pick<WorkDraftItem, "kind" | "qualityMode" | "edit">;
    },
  ): Promise<void> {
    const account = this.current();
    if (!account || files.length === 0) return Promise.resolve();
    const session = account.session;
    const epoch = this.selectionEpoch;
    const active = () =>
      this.current() === account &&
      account.session === session &&
      session?.closed !== true &&
      this.selectionEpoch === epoch;
    const selection = Symbol();
    session?.pendingSelections.add(selection);
    session?.pendingFiles.set(selection, {
      id: this.services.requestId(),
      files,
      origin,
      original,
      ...(replacement ? { replacement } : {}),
    });
    account.identifying += files.length;
    this.publish();
    const task = this.selectionTail.then(async () => {
      try {
        if (!active()) return;
        const identified = await this.services.identifyFiles(files);
        if (!active()) return;
        account.staging = addStaticPhotosToStaging(
          account.staging,
          identified,
          origin,
        );
        this.publish();
        onReady?.();
      } finally {
        account.identifying = Math.max(0, account.identifying - files.length);
        session?.pendingSelections.delete(selection);
        session?.pendingFiles.delete(selection);
        this.publish();
      }
    });
    this.selectionTail = task.catch(() => undefined);
    return task;
  }

  setStagingOriginal(original: boolean): void {
    const account = this.current();
    if (!account?.staging) return;
    account.staging = setBatchOriginal(account.staging, original);
    this.publish();
  }

  removeStaged(key: string): StagingChoiceError | null {
    return this.applyChoice((batch) => removeStagedEntry(batch, key));
  }

  keepStagedStill(key: string): StagingChoiceError | null {
    return this.applyChoice((batch) => keepStagedStillAsPhoto(batch, key));
  }

  async attachCounterpart(
    key: string,
    file: File,
  ): Promise<StagingChoiceError | null> {
    const account = this.current();
    if (!account?.staging) return "entry_missing";
    const [identified] = await this.services.identifyFiles([file]);
    if (!identified || this.current() !== account) return "choice_invalid";
    return this.applyChoice((batch) =>
      attachStagedCounterpart(batch, key, identified),
    );
  }

  resolveAmbiguous(
    key: string,
    stillIndex: number,
    motionIndex: number,
  ): StagingChoiceError | null {
    return this.applyChoice((batch) =>
      resolveStagedAmbiguity(batch, key, stillIndex, motionIndex),
    );
  }

  /** Confirms the ready staging entries under the batch mode and starts their preparation. */
  confirmStaging(replacementTarget?: string): ConfirmStagingResult {
    const account = this.current();
    if (!account?.staging || !account.session || account.session.closed)
      return { ok: false, error: "nothing_ready" };
    const session = account.session;
    const replacing =
      replacementTarget !== undefined &&
      albumContent(session)?.items.some(
        (item) => item.key === replacementTarget,
      );
    const existing =
      albumItemCount(account.manager, session) - (replacing ? 1 : 0);
    const result = confirmStaging(
      account.staging,
      existing,
      sessionMaxItems(session, account.limits?.maxItems ?? DEFAULT_MAX_ITEMS),
    );
    if (!result.ok) return result;
    account.staging = result.remaining;
    // Appendable before the manager publishes, so the content follows at once.
    for (const confirmed of result.confirmed)
      session.appendable.add(confirmed.key);
    account.manager.addConfirmed(result.confirmed);
    session.itemCount = albumItemCount(account.manager, session);
    this.publish();
    return result;
  }

  cancelStaging(cancelPending = true): void {
    const account = this.current();
    if (!account) return;
    if (cancelPending) {
      this.selectionEpoch += 1;
      account.session?.pendingSelections.clear();
      account.session?.pendingFiles.clear();
    }
    account.staging = null;
    this.publish();
  }

  // -- submission ----------------------------------------------------------

  /** One explicit submit of the current content (idempotent by its request identity). */
  async submit(
    content: WorkSubmissionContent,
  ): Promise<SubmissionState | null> {
    const account = this.current();
    const session = account?.session;
    if (!account || !session || session.closed) return null;
    const controller = session.submission;
    if (session.submitting) return controller.store.get();
    const status = controller.store.get().status;
    if (status !== "idle" && status !== "failed" && status !== "not_ready")
      return controller.store.get();
    controller.reset();
    // Registration may have assigned ids the editor content does not carry yet.
    const current = withManagedItems(content, account.manager.draftItems());
    let holder: PublishingHolder;
    session.submitting = true;
    try {
      await session.autosave?.idle();
      holder = await this.resolveHolder(account, session, current);
    } catch (error) {
      session.submitting = false;
      const shape = (error ?? {}) as {
        message?: unknown;
        status?: unknown;
        code?: unknown;
      };
      return controller.reportFailure({
        code: typeof shape.code === "string" ? shape.code : null,
        message:
          typeof shape.message === "string" && typeof shape.status === "number"
            ? shape.message
            : "暂时无法发布，请重试",
      });
    }
    if (session.closed) {
      session.submitting = false;
      return controller.store.get();
    }
    const result = await controller.submit({
      holder,
      content: current,
      baseRevisionId: session.view.baseRevisionId,
      ...(session.view.threadId === null
        ? {}
        : { threadId: session.view.threadId }),
    });
    session.submitting = false;
    // Refused as not ready: those items show as processing and the account
    // is asked again until they are ready (never a bare error).
    if (result.status === "not_ready" && !session.closed)
      session.readiness.markPending(result.itemKeys);
    return result;
  }

  dispose(): void {
    for (const account of this.accounts.values()) {
      if (account.session) {
        account.session.closed = true;
        account.session.unsubscribe();
        this.stopHeartbeat(account.session);
        account.session.autosave?.dispose();
        account.session.readiness.dispose();
        account.session.submission.dispose();
      }
      account.completed?.dispose();
      account.manager.dispose();
    }
    this.accounts.clear();
    this.accountId = null;
    this.publish();
  }

  // -- internals -----------------------------------------------------------

  private current(): AccountRuntime | null {
    return this.accountId === null
      ? null
      : (this.accounts.get(this.accountId) ?? null);
  }

  private async loadLimits(accountId: string): Promise<void> {
    try {
      const limits = await this.services.client.limits();
      const account = this.accounts.get(accountId);
      if (account) {
        account.limits = limits;
        this.publish();
      }
    } catch {
      // Counters fall back to the documented default; the Backend still enforces.
    }
  }

  private createAutosave(
    account: AccountRuntime,
    session: SessionRecord,
    draft: PublishingDraft | null,
  ): DraftAutosave {
    const autosave = createDraftAutosave({
      manualOnly: true,
      port: {
        draft: (id) => this.services.client.draft(id),
        saveDraft: (id, cmd) => this.services.client.saveDraft(id, cmd),
        saveDraftNow: (id, cmd) => this.services.client.saveDraftNow(id, cmd),
        createDraft: async (input) => {
          const cmd = (session.draftCreation ??= input);
          this.publish();
          try {
            const workId = session.view.workId;
            if (workId === null)
              return await this.services.client.createDraft(cmd);
            const open = this.services.client.openWorkEditDraft;
            if (!open) throw new Error("无法保存作品草稿，请重试");
            const { draft: opened, created } = await open(workId, {
              requestId: cmd.requestId,
              deviceClass: cmd.deviceClass,
            });
            if (
              this.services.currentAccount() !== account.manager.accountId ||
              session.closed
            )
              throw new Error("账号已切换，本次保存已暂停");
            if (opened.baseRevisionId !== session.view.baseRevisionId)
              throw new Error(
                "作品已在别处更新，请重新打开后比较；本次内容仍保留在本机",
              );
            if (
              opened.conflict ||
              sameDraftContent(opened.content, cmd.content)
            )
              return opened;
            if (
              !created &&
              opened.revision === 1 &&
              session.baseline !== null &&
              !sameDraftContent(opened.content, session.baseline)
            )
              throw new Error(
                "这件作品已有其他草稿，请先打开那份草稿；本次内容仍保留在本机",
              );
            // A draft already edited elsewhere is a conflict, never an overwrite.
            const result = await this.services.client.saveDraft(opened.id, {
              baseRevision:
                opened.revision > 1 ? opened.revision - 1 : opened.revision,
              content: cmd.content,
              deviceClass: cmd.deviceClass,
            });
            return result.draft;
          } catch (error) {
            if (
              (error as { outcomeUnknown?: boolean })?.outcomeUnknown !== true
            ) {
              session.draftCreation = null;
              this.publish();
            }
            throw error;
          }
        },
      },
      requestId: this.services.requestId,
      deviceClass: this.services.deviceClass(),
      draft,
      accountId: account.manager.accountId,
      currentAccount: this.services.currentAccount,
      onDraftSaved: (saved) => {
        session.savedDraft = saved;
      },
      ...(this.services.timers ? { timers: this.services.timers } : {}),
      onDraftCreated: (created) => {
        if (session.closed) return;
        session.draftCreation = null;
        session.view = { ...session.view, draftId: created.id };
        account.manager.setDraftId(created.id);
        this.publish();
        // The draft is the holder a readiness check needs.
        session.readiness.poke();
      },
    });
    return autosave;
  }

  /** The content with the manager's items (pending entries for confirmed ones it does not list yet). */
  private contentWithItems(
    account: AccountRuntime,
    session: SessionRecord,
    content: WorkDraftContent | null,
  ): WorkDraftContent {
    return withManagedItems(
      content ?? emptyContent(),
      account.manager.draftItems(),
      session.appendable,
    );
  }

  /** Pushes identity changes from the manager into the session content and autosave. */
  private syncManagedItems(account: AccountRuntime): void {
    const session = account.session;
    if (!session || session.closed || session.latest === null) return;
    const merged = this.contentWithItems(account, session, session.latest);
    if (sameDraftContent(merged, session.latest)) return;
    session.latest = merged;
    // Suspended for another account, autosave records it and sends nothing.
    session.autosave?.edit(merged);
    this.updateContentView(account, session, merged);
  }

  /** Republishes when the content changes whether there is content or how many items the album holds. */
  private updateContentView(
    account: AccountRuntime,
    session: SessionRecord,
    content: WorkDraftContent,
  ): void {
    const next = hasContent(content);
    const itemCount = albumItemCount(account.manager, session);
    if (next === session.view.hasContent && itemCount === session.itemCount)
      return;
    session.itemCount = itemCount;
    if (next !== session.view.hasContent)
      session.view = { ...session.view, hasContent: next };
    if (this.current()?.session === session) this.publish();
  }

  /** The album content a readiness check describes (with the manager's items). */
  private readinessContent(
    account: AccountRuntime,
    session: SessionRecord,
  ): WorkDraftContent | null {
    if (session.closed) return null;
    const content = albumContent(session);
    return content === null
      ? null
      : this.contentWithItems(account, session, content);
  }

  /**
   * The holder the session already has (a draft or temporary session);
   * null before one exists. Never creates one: a readiness check that has
   * nothing to ask about must not open a session on the account.
   */
  private existingHolder(session: SessionRecord): PublishingHolder | null {
    if (session.view.saveMode === "saved") {
      const draftId =
        session.autosave?.store.get().draftId ?? session.view.draftId;
      if (draftId !== null) return { draftId };
    }
    return session.view.sessionId === null
      ? null
      : { sessionId: session.view.sessionId };
  }

  private async checkReadiness(
    account: AccountRuntime,
    session: SessionRecord,
    content: WorkDraftContent,
  ): Promise<PublishingReadiness | null> {
    if (
      session.closed ||
      this.accountId !== account.manager.accountId ||
      this.services.currentAccount() !== account.manager.accountId
    )
      return null;
    const holder = this.existingHolder(session);
    if (holder === null) return null;
    return this.services.client.readiness(holder, content);
  }

  private async resolveHolder(
    account: AccountRuntime,
    session: SessionRecord,
    content?: WorkDraftContent,
  ): Promise<PublishingHolder> {
    if (session.closed) throw new Error("The editor session has ended");
    if (this.services.currentAccount() !== account.manager.accountId)
      throw new Error("The account changed");
    if (
      content !== undefined &&
      session.view.saveMode === "saved" &&
      session.autosave
    ) {
      const existing = session.autosave.store.get().draftId;
      if (existing !== null) return { draftId: existing };
    }
    if (session.view.sessionId !== null)
      return { sessionId: session.view.sessionId };
    session.sessionTask ??= (async () => {
      const requestId = (session.sessionRequestId ??=
        this.services.requestId());
      const created = await this.services.client.createSession({
        requestId,
        workId: session.view.workId,
      });
      // Recorded even when the editor is closing, so its discard can find it.
      session.view = { ...session.view, sessionId: created.id };
      if (session.closed) throw new Error("The editor session has ended");
      this.startHeartbeat(account, session);
      this.publish();
      session.readiness.poke();
      return created.id;
    })().catch((error: unknown) => {
      session.sessionTask = null;
      // A refused create gets a new identity next time; an unknown outcome keeps it.
      if ((error as { outcomeUnknown?: unknown })?.outcomeUnknown !== true)
        session.sessionRequestId = null;
      throw error;
    });
    return { sessionId: await session.sessionTask };
  }

  private startHeartbeat(
    account: AccountRuntime,
    session: SessionRecord,
  ): void {
    this.stopHeartbeat(session);
    const beat = () => {
      session.heartbeat = this.timers.setTimeout(() => {
        const sessionId = session.view.sessionId;
        if (
          session.closed ||
          sessionId === null ||
          this.accountId !== account.manager.accountId ||
          this.services.currentAccount() !== account.manager.accountId
        )
          return;
        // One lease renewal per interval; a failed beat is not retried.
        void Promise.resolve()
          .then(() => this.services.client.heartbeatSession(sessionId))
          .catch(() => undefined);
        beat();
      }, SESSION_HEARTBEAT_MS);
    };
    beat();
  }

  private stopHeartbeat(session: SessionRecord | null): void {
    if (session?.heartbeat != null) {
      this.timers.clearTimeout(session.heartbeat);
      session.heartbeat = null;
    }
  }

  private applyChoice(
    change: (
      batch: StagingBatch,
    ) =>
      | { ok: true; batch: StagingBatch }
      | { ok: false; error: StagingChoiceError },
  ): StagingChoiceError | null {
    const account = this.current();
    if (!account?.staging) return "entry_missing";
    const result = change(account.staging);
    if (!result.ok) return result.error;
    account.staging = result.batch.entries.length === 0 ? null : result.batch;
    this.publish();
    return null;
  }

  private snapshot(): RuntimeSnapshot {
    const account = this.current();
    const staging = account?.staging ?? null;
    const existing = account
      ? albumItemCount(account.manager, account.session)
      : 0;
    return {
      accountId: this.accountId,
      session: account?.session?.view ?? null,
      staging:
        account && staging
          ? {
              batch: staging,
              count: countStaging(
                staging,
                existing,
                sessionMaxItems(
                  account.session,
                  account.limits?.maxItems ?? DEFAULT_MAX_ITEMS,
                ),
              ),
              identifying: account.identifying,
            }
          : account && account.identifying > 0
            ? {
                batch: { origin: "picker", original: false, entries: [] },
                count: countStaging(
                  { origin: "picker", original: false, entries: [] },
                  existing,
                  sessionMaxItems(
                    account.session,
                    account.limits?.maxItems ?? DEFAULT_MAX_ITEMS,
                  ),
                ),
                identifying: account.identifying,
              }
            : null,
      limits: account?.limits ?? null,
    };
  }

  private publish(): void {
    this.store.set(this.snapshot());
  }
}
