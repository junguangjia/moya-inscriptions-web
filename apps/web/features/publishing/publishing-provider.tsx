"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { authorClient } from "../authors/author-data";
import { useAuthors } from "../authors/author-context";
import { forgetWorkSnapshot } from "../authors/work-snapshots";
import {
  detectDeviceClass,
  resolveRuntimePresentationPlatform,
} from "../shell/device-platform";
import { requestIdentity } from "../shell/request-identity";
import { createBlobHasher } from "./hashing";
import { identifyFiles } from "./import-grouping";
import { createBrowserRecoveryStore } from "./local-recovery";
import {
  TRANSFER_CONCURRENCY,
  preprocessConcurrency,
} from "./preprocess/capabilities";
import { createWorkerPreprocess } from "./preprocess/worker-client";
import { IDLE_EDIT_READINESS } from "./edit-readiness";
import { publishingClient } from "./publishing-data";
import { PublishingRuntime } from "./publishing-runtime";
import {
  backgroundProgressText,
  canRetryProcessing,
  readinessText,
  summarizeUploads,
} from "./upload-manager";
import { createUppyTransfer } from "./uppy-transfer";

import type { AutosaveState } from "./draft-autosave";
import type { EditReadinessState } from "./edit-readiness";
import type { FileOrigin } from "./import-grouping";
import type {
  PublishingServices,
  RuntimeSnapshot,
  SaveMode,
  PublishingCheckpoint,
} from "./publishing-runtime";
import type { SubmissionState } from "./submission-reconcile";
import type { UploadItemView, UploadManagerSnapshot } from "./upload-manager";
import type { ExternalStore } from "./upload-manager-store";
import type { EditorTarget } from "../product-shell/product-history";
import type {
  MediaComponentRole,
  PublishingDraft,
  WorkDraftContent,
  WorkSubmissionContent,
} from "@moya/contracts";
import type { ReactNode } from "react";

/**
 * Publishing context for the editor UI: one runtime above the pages (so
 * uploads survive navigation), keyed by the confirmed viewer. The hooks expose
 * immutable snapshots and explicit actions only.
 */

const PublishingContext = createContext<PublishingRuntime | null>(null);

const browserServices = (): PublishingServices => ({
  client: publishingClient,
  currentAccount: () => authorClient.account(),
  requestId: requestIdentity,
  createTransfer: (concurrency) => createUppyTransfer(concurrency),
  createPreprocess: () => createWorkerPreprocess(),
  createHasher: () => createBlobHasher(),
  createRecovery: () => createBrowserRecoveryStore(),
  identifyFiles: (files) => identifyFiles(files),
  preprocessConcurrency: () =>
    typeof navigator === "undefined"
      ? 1
      : preprocessConcurrency(
          resolveRuntimePresentationPlatform(navigator, window.innerWidth),
        ),
  transferConcurrency: TRANSFER_CONCURRENCY,
  deviceClass: () =>
    typeof navigator === "undefined" ? "desktop" : detectDeviceClass(navigator),
});

export const PublishingProvider = ({
  children,
  services,
}: {
  readonly children: ReactNode;
  /** Replaced only in tests. */
  readonly services?: PublishingServices;
}) => {
  const { viewer, notify } = useAuthors();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [runtime] = useState(
    () =>
      new PublishingRuntime({
        ...(services ?? browserServices()),
        onBackgroundPublished: () => {
          services?.onBackgroundPublished?.();
          notifyRef.current?.("作品已发布");
        },
        onSubmissionConfirmed: (id) => {
          services?.onSubmissionConfirmed?.(id);
          // The held record predates the submission: its Detail opens
          // through loading again and its feed bodies read it again.
          forgetWorkSnapshot(id);
        },
      }),
  );
  const accountId = viewer?.id ?? null;

  useEffect(() => {
    runtime.setAccount(accountId);
  }, [runtime, accountId]);

  useEffect(
    () => () => {
      // Leaving the tree pauses every account's work; nothing resumes by itself.
      runtime.setAccount(null);
    },
    [runtime],
  );

  useEffect(() => {
    const offline = () => runtime.manager()?.pause("offline");
    window.addEventListener("offline", offline);
    return () => window.removeEventListener("offline", offline);
  }, [runtime]);

  return (
    <PublishingContext.Provider value={runtime}>
      {children}
    </PublishingContext.Provider>
  );
};

const useRuntime = (): PublishingRuntime => {
  const runtime = useContext(PublishingContext);
  if (runtime === null)
    throw new Error("Publishing hooks require PublishingProvider");
  return runtime;
};

const useStore = <T,>(store: ExternalStore<T>): T =>
  useSyncExternalStore(store.subscribe, store.get, store.get);

const idleAutosave: ExternalStore<AutosaveState | null> = {
  get: () => null,
  set: () => undefined,
  update: () => undefined,
  subscribe: () => () => undefined,
};

const IDLE_SUBMISSION: SubmissionState = { status: "idle" };

const idleSubmission: ExternalStore<SubmissionState> = {
  // A stable snapshot: useSyncExternalStore compares by identity.
  get: () => IDLE_SUBMISSION,
  set: () => undefined,
  update: () => undefined,
  subscribe: () => () => undefined,
};

const idleEditReadiness: ExternalStore<EditReadinessState> = {
  get: () => IDLE_EDIT_READINESS,
  set: () => undefined,
  update: () => undefined,
  subscribe: () => () => undefined,
};

const idleUploads: ExternalStore<UploadManagerSnapshot | null> = {
  get: () => null,
  set: () => undefined,
  update: () => undefined,
  subscribe: () => () => undefined,
};

const useRuntimeSnapshot = (runtime: PublishingRuntime): RuntimeSnapshot =>
  useStore(runtime.store);

const useUploads = (
  runtime: PublishingRuntime,
): UploadManagerSnapshot | null => {
  useRuntimeSnapshot(runtime);
  const manager = runtime.manager();
  return useStore<UploadManagerSnapshot | null>(
    (manager?.store as
      ExternalStore<UploadManagerSnapshot | null> | undefined) ?? idleUploads,
  );
};

/** The editor session: save mode, draft autosave, item actions. */
export const useUploadSession = () => {
  const runtime = useRuntime();
  const snapshot = useRuntimeSnapshot(runtime);
  const uploads = useUploads(runtime);
  const autosaveStore = runtime.autosave()?.store ?? idleAutosave;
  const autosave = useStore<AutosaveState | null>(autosaveStore);
  const manager = runtime.manager();
  return useMemo(
    () => ({
      accountId: snapshot.accountId,
      session: snapshot.session,
      limits: snapshot.limits,
      autosave,
      uploads,
      startSession: (options: {
        target: EditorTarget;
        saveMode: SaveMode;
        draft?: PublishingDraft | null;
        workId?: string | null;
        baseRevisionId?: string | null;
        /** What the editor opens with when no draft carries it (counts against the item limit). */
        content?: WorkDraftContent | null;
      }) => runtime.startSession(options),
      restoreDraftMedia: (draft: PublishingDraft) =>
        runtime.restoreDraftMedia(draft),
      closeSession: (options: { discard: boolean }) =>
        runtime.closeSession(options),
      /** Whether leaving now would lose work (the leave guard asks first). */
      hasUnfinishedWork: () => runtime.hasUnfinishedWork(),
      forgetDraftLocalCopies: (draftId: string) =>
        runtime.forgetDraftLocalCopies(draftId),
      /** Items of a saved draft this browser holds local copies of (drafts picker). */
      countLocalDraftItems: (draftId: string) =>
        runtime.countLocalDraftItems(draftId),
      edit: (content: WorkDraftContent) => runtime.edit(content),
      /**
       * Adopts a version chosen in the conflict chooser or history: the
       * session continues from that draft's revision with `content`, and
       * items that content leaves out are not added back.
       */
      adoptDraft: (draft: PublishingDraft, content: WorkDraftContent) =>
        runtime.adoptDraft(draft, content),
      saveNow: () => runtime.saveNow(),
      /**
       * What keeps `saveNow` from saving the album's media now (picks still
       * on their way, or ones that need the author); null when nothing does.
       */
      mediaSaveHold: () => runtime.mediaSaveHold(),
      checkpoint: () => runtime.checkpoint(),
      restoreCheckpoint: (checkpoint: PublishingCheckpoint) =>
        runtime.restoreCheckpoint(checkpoint),
      retrySave: () => runtime.saveNow(),
      hasUnsavedChanges: () => runtime.autosave()?.hasUnsavedChanges() ?? false,
      enableSaving: () => runtime.enableSaving(),
      disableSaving: () => runtime.disableSaving(),
      /** Upload identities of the album's items (never items a chosen version left out). */
      draftItems: () => runtime.draftItems(),
      localStill: (key: string) => manager?.localStill(key) ?? null,
      cancelItem: (key: string) =>
        manager?.cancelItem(key) ?? Promise.resolve(),
      forgetItem: (key: string) => manager?.forget(key),
      chooseOriginal: (key: string) => manager?.chooseOriginal(key),
      retryComponent: (key: string, role: MediaComponentRole) =>
        manager?.retryComponent(key, role) ?? Promise.resolve(),
      retryRegistration: (key: string) => manager?.retryRegistration(key),
      canRetryProcessing: (item: UploadItemView) => canRetryProcessing(item),
      retryProcessing: (key: string) =>
        manager?.retryProcessing(key) ?? Promise.resolve(),
      retryHighResolution: (key: string) =>
        manager?.retryHighResolution(key) ?? Promise.resolve(),
      continueUploads: () => manager?.continueUploads() ?? Promise.resolve(),
    }),
    [runtime, manager, snapshot, autosave, uploads],
  );
};

/**
 * Readiness of the album's edit derivatives as the account last confirmed
 * it (QA D1): an edited item counts as processing until then. Idle without
 * a session.
 */
export const useEditReadiness = (): EditReadinessState => {
  const runtime = useRuntime();
  useRuntimeSnapshot(runtime);
  return useStore<EditReadinessState>(
    runtime.editReadiness() ?? idleEditReadiness,
  );
};

/** The selection staging batch and its explicit choices. */
export const useStagedItems = () => {
  const runtime = useRuntime();
  const snapshot = useRuntimeSnapshot(runtime);
  return useMemo(
    () => ({
      staging: snapshot.staging,
      current: () => runtime.store.get().staging,
      stageFiles: (
        files: readonly File[],
        origin: FileOrigin,
        onReady?: () => void,
        original = false,
        replacement?: {
          target: string;
          previous: Pick<
            WorkDraftContent["items"][number],
            "kind" | "qualityMode" | "edit"
          >;
        },
      ) => runtime.stageFiles(files, origin, onReady, original, replacement),
      setOriginal: (original: boolean) => runtime.setStagingOriginal(original),
      remove: (key: string) => runtime.removeStaged(key),
      keepStill: (key: string) => runtime.keepStagedStill(key),
      attachCounterpart: (key: string, file: File) =>
        runtime.attachCounterpart(key, file),
      resolveAmbiguous: (
        key: string,
        stillIndex: number,
        motionIndex: number,
      ) => runtime.resolveAmbiguous(key, stillIndex, motionIndex),
      confirm: () => runtime.confirmStaging(),
      cancel: (cancelPending = true) => runtime.cancelStaging(cancelPending),
    }),
    [runtime, snapshot],
  );
};

/**
 * For the dock progress ring: whether an editor session has work in progress
 * (including interrupted, failed or waiting items) or unsaved changes (a
 * no-save session's content counts: it exists nowhere else).
 */
export const useGlobalUploadProgress = () => {
  const runtime = useRuntime();
  const snapshot = useRuntimeSnapshot(runtime);
  const uploads = useUploads(runtime);
  const autosave = useStore<AutosaveState | null>(
    runtime.autosave()?.store ?? idleAutosave,
  );
  return useMemo(() => {
    // Items a chosen version left out are neither counted nor unfinished here.
    const summary = uploads
      ? summarizeUploads(runtime.albumUploads(uploads))
      : null;
    const unsaved =
      autosave !== null &&
      (autosave.editVersion > autosave.savedVersion ||
        autosave.status === "saving" ||
        autosave.status === "error" ||
        autosave.status === "conflict" ||
        autosave.status === "reconciling");
    const publication = runtime.submission()?.store.get();
    const editReadiness = runtime.editReadiness()?.get();
    const background = snapshot.backgroundPublication === true;
    const backgroundText = !background
      ? null
      : publication?.status === "failed" ||
          publication?.status === "unconfirmed"
        ? publication.message
        : publication?.status === "reconciling"
          ? "正在确认发布结果…"
          : publication?.status === "submitting"
            ? "正在发布…"
            : snapshot.publicationPaused || uploads?.status === "paused"
              ? "后台发布已暂停，返回继续"
              : (editReadiness?.answered?.failedItemKeys.size ?? 0) > 0 ||
                  (summary &&
                    summary.failed +
                      summary.needsChoice +
                      summary.missingLocal >
                      0)
                ? "图片需要处理，返回继续"
                : editReadiness?.status === "unavailable"
                  ? "暂时无法确认图片状态，返回重试"
                  : `${summary ? (readinessText(summary) ?? "正在确认图片状态") : "正在准备发布"}，完成后自动发布`;
    const bytesTotal = summary?.bytesTotal ?? 0;
    const unsavedSession =
      snapshot.session?.saveMode === "unsaved" &&
      (snapshot.session.hasContent || (summary?.total ?? 0) > 0);
    return {
      target: snapshot.session?.target ?? null,
      // The same rule as leaving: the entry shows exactly while leaving would keep the session.
      active:
        snapshot.session !== null &&
        (runtime.hasUnfinishedWork() ||
          (summary?.backgroundProcessing ?? 0) > 0 ||
          (summary?.backgroundFailed ?? 0) > 0),
      paused:
        uploads?.status === "paused" || snapshot.publicationPaused === true,
      ...(background
        ? {
            backgroundPublication: true as const,
            publicationStatus: publication?.status,
          }
        : {}),
      itemCount: summary?.total ?? 0,
      fraction:
        bytesTotal > 0
          ? Math.min(1, (summary?.bytesSent ?? 0) / bytesTotal)
          : 0,
      summary,
      readiness:
        backgroundText ??
        (summary
          ? (readinessText(summary) ?? backgroundProgressText(summary))
          : null),
      hasUnsavedChanges: unsaved || unsavedSession,
    };
  }, [runtime, snapshot, uploads, autosave]);
};

/** Explicit submission with receipt reconciliation. */
export const useSubmission = () => {
  const runtime = useRuntime();
  const snapshot = useRuntimeSnapshot(runtime);
  const controller = runtime.submission();
  const state = useStore<SubmissionState>(controller?.store ?? idleSubmission);
  const submit = useCallback(
    (content: WorkSubmissionContent) => runtime.submit(content),
    [runtime],
  );
  return useMemo(
    () => ({
      state,
      submit,
      background: snapshot.backgroundPublication === true,
      paused: snapshot.publicationPaused === true,
      queue: (content: WorkSubmissionContent) =>
        runtime.queuePublication(content),
      cancelQueued: () => runtime.cancelPublication(),
      continueQueued: () => runtime.continuePublication(),
      retry: () => controller?.retry() ?? Promise.resolve(state),
      checkAgain: () => controller?.checkAgain() ?? Promise.resolve(state),
      reset: () => controller?.reset(),
    }),
    [controller, state, submit, snapshot, runtime],
  );
};
