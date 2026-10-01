"use client";

import { Icon } from "@moya/ui";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAuthors } from "../../../authors/author-context";
import { authorClient } from "../../../authors/author-data";
import detailStyles from "../../../detail/catalog-detail.module.css";
import { useProductShell } from "../../../product-shell/product-shell";
import { resolvePrimaryNavigationViewportInset } from "../../../shell/primary-navigation-motion";
import { detectDeviceClass } from "../../../shell/device-platform";
import { requestIdentity } from "../../../shell/request-identity";
import hostStyles from "../../publishing-entry.module.css";
import { publishingClient } from "../../publishing-data";
import {
  useEditReadiness,
  useStagedItems,
  useSubmission,
  useUploadSession,
} from "../../publishing-provider";
import { ConflictChooser } from "../drafts/conflict-chooser";
import { HistoryPanel } from "../drafts/history-panel";
import { MediaSection } from "../media/media-section";
import { ConfirmationSheet } from "./confirmation-sheet";
import { DesktopEditor } from "./desktop-editor";
import { EditorDialog } from "./editor-dialog";
import {
  markEditVersionSent,
  openEditorSession,
  removeUnchangedEditDraft,
  retryEditorSession,
  sentEditVersion,
} from "./editor-session-loader";
import {
  useEditorSessionRegistry,
  useEditorStoreState,
} from "./editor-session-provider";
import {
  authorshipOf,
  contentOf,
  failureField,
  fieldStep,
  isEmptyWork,
  localIssues,
  readinessOf,
  resolveSession,
  sameAuthorContent,
  preserveLaterConflictEdits,
} from "./editor-session-state";
import { LeaveDialog } from "./leave-dialog";
import { ModeSwitches, OriginalQualitySwitch } from "./mode-switches";
import { PhoneSteps } from "./phone-steps";
import {
  ContinuousPreview,
  PhonePreview,
  editorPreviewPresentation,
  useEditorMediaSources,
} from "./preview";
import { SaveStatus } from "./save-status";
import { TextSettings } from "./text-settings";
import styles from "./editor.module.css";

import type { MediaSectionLayout } from "../media/media-section";
import type { EditorLoaderDeps } from "./editor-session-loader";
import type { EditorSessionRegistry } from "./editor-session-provider";
import type {
  EditorField,
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { LeaveDialogVariant } from "./leave-dialog";
import type { EditorMediaScope } from "./preview";
import type { AutosaveState } from "../../draft-autosave";
import type { EditorTarget } from "../../../product-shell/product-history";
import type {
  ProductShellEditorLeaveReason,
  ProductShellEditorOverlayControls,
} from "../../../product-shell/product-shell";
import type { UploadManagerSnapshot } from "../../upload-manager";
import type {
  PublishingDraft,
  PublishingDraftConflict,
  PublishingMediaItem,
} from "@moya/contracts";
import type { ReactNode, RefObject } from "react";

/** Wide tablets use the desktop editor from this width (design §11.1). */
export const DESKTOP_MINIMUM_WIDTH = 896;

const editorTitle = (target: EditorTarget, state: EditorSessionState | null) =>
  (state?.kind ?? (target.type === "work" ? "edit" : "new")) === "edit"
    ? "编辑作品"
    : target.type === "new" && target.threadId
      ? "参与话题"
      : "发布作品";

type UploadSessionApi = ReturnType<typeof useUploadSession>;

/** The one version panel open at a time: history or the conflict chooser. */
type VersionsPanel = "history" | "conflict" | null;

const settledPhases: ReadonlySet<string> = new Set([
  "ready",
  "cancelled",
  "cleanup",
  "missing_local",
]);

const unfinishedUploads = (uploads: UploadManagerSnapshot | null): number =>
  (uploads?.items ?? []).filter((item) => !settledPhases.has(item.phase))
    .length;

// ---------------------------------------------------------------------------
// Viewport

const subscribeResize = (listener: () => void) => {
  window.addEventListener("resize", listener);
  window.addEventListener("orientationchange", listener);
  return () => {
    window.removeEventListener("resize", listener);
    window.removeEventListener("orientationchange", listener);
  };
};

const useViewportWidth = () =>
  useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => DESKTOP_MINIMUM_WIDTH,
  );

/** Keeps the editor inside the visual viewport (keyboard, safe areas), like Search. */
const useVisualViewportFrame = (hostRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const synchronize = () => {
      frame = null;
      if (viewport == null) {
        host.style.setProperty(
          "--editor-viewport-height",
          `${window.innerHeight}px`,
        );
        return;
      }
      host.style.setProperty(
        "--editor-viewport-height",
        `${viewport.height}px`,
      );
      host.style.setProperty(
        "--editor-viewport-top",
        `${viewport.offsetTop}px`,
      );
      const inset = resolvePrimaryNavigationViewportInset(
        window.innerHeight,
        viewport.height,
        viewport.offsetTop,
      );
      // Already bounded by the visual viewport: no second keyboard inset.
      host.style.setProperty(
        "--editor-bottom-safe-area",
        inset > 1 ? "0px" : "env(safe-area-inset-bottom)",
      );
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(synchronize);
    };
    synchronize();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [hostRef]);
};

/** Media the chooser can show without reading the draft again, when all are known. */
const conflictMediaItems = (
  state: EditorSessionState,
  uploads: UploadManagerSnapshot | null,
  conflict: PublishingDraftConflict,
): { readonly mediaItems?: readonly PublishingMediaItem[] } => {
  const known = new Map(Object.entries(state.serverItems));
  for (const item of uploads?.items ?? [])
    if (item.serverItem !== null)
      known.set(item.serverItem.id, item.serverItem);
  const needed = [
    ...conflict.device.content.items,
    ...conflict.account.content.items,
  ].flatMap((item) => (item.itemId === null ? [] : [item.itemId]));
  return needed.every((id) => known.has(id))
    ? { mediaItems: [...known.values()] }
    : {};
};

const nextFrame = (callback: () => void) => {
  if (typeof window.requestAnimationFrame === "function")
    window.requestAnimationFrame(callback);
  else setTimeout(callback, 0);
};

/** Moves focus to a panel's heading when nothing else holds it. */
const useHeadingFocus = () => {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, []);
  return ref;
};

// ---------------------------------------------------------------------------
// Host

/** The ProductShell `editor` seam renderer (design §11.1). */
export const renderEditorOverlay = (
  target: EditorTarget,
  controls: ProductShellEditorOverlayControls,
) => <EditorOverlay controls={controls} target={target} />;

export const EditorOverlay = ({
  target,
  controls,
}: {
  readonly target: EditorTarget;
  readonly controls: ProductShellEditorOverlayControls;
}) => {
  const author = useAuthors();
  const hostRef = useRef<HTMLElement>(null);
  const [label, setLabel] = useState(editorTitle(target, null));
  useVisualViewportFrame(hostRef);
  const viewer = author.viewer;
  return (
    <>
      <div aria-hidden="true" className={styles.viewportBackdrop} />
      <section
        ref={hostRef}
        aria-label={label}
        aria-modal="true"
        className={`${detailStyles.experience} ${hostStyles.host} ${styles.overlay}`}
        data-publishing-editor={target.type}
        role="dialog"
      >
        {viewer !== null ? (
          // A different account never inherits another account's session.
          <EditorSessionHost
            controls={controls}
            hostRef={hostRef}
            key={viewer.id}
            onTitle={setLabel}
            target={target}
            viewer={viewer}
          />
        ) : (
          <>
            <ReturnBar controls={controls} title={label} />
            {author.checking ? null : (
              <div className={styles.message}>
                <p>登录后可发布与编辑作品。</p>
                <div className="phase4-actions">
                  <a href={author.signInHref}>登录</a>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
};

/** Whether the return bar's Back held focus when a state change replaced the bar. */
const backFocus = new WeakMap<ProductShellEditorOverlayControls, true>();

const ReturnBar = ({
  controls,
  title,
  status,
  actions,
  inert = false,
}: {
  readonly controls: ProductShellEditorOverlayControls;
  readonly title: string;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly inert?: boolean;
}) => {
  // Loading, the workspace and the unavailable state each render their own
  // bar: a focused Back stays focused across the swap.
  useLayoutEffect(() => {
    const button = controls.backButtonRef.current;
    const active = document.activeElement;
    if (
      backFocus.has(controls) &&
      button !== null &&
      (active === null || active === document.body)
    )
      button.focus({ preventScroll: true });
    backFocus.delete(controls);
    return () => {
      if (button !== null && document.activeElement === button)
        backFocus.set(controls, true);
    };
  }, [controls]);
  return (
    <header
      className={`${detailStyles.detailHeader} ${hostStyles.bar} ${styles.bar}`}
      data-editor-bar=""
      inert={inert}
    >
      <button
        ref={controls.backButtonRef}
        aria-label="返回"
        onClick={controls.close}
        type="button"
      >
        <Icon aria-hidden="true" name="back" />
      </button>
      <div className={styles.barTitle}>
        <strong>{title}</strong>
        {status}
      </div>
      <div className={styles.barActions}>
        {actions ?? <span aria-hidden="true" className={hostStyles.balance} />}
      </div>
    </header>
  );
};

interface Viewer {
  readonly id: string;
  readonly displayName: string;
}

const EditorSessionHost = ({
  target,
  controls,
  viewer,
  hostRef,
  onTitle,
}: {
  readonly target: EditorTarget;
  readonly controls: ProductShellEditorOverlayControls;
  readonly viewer: Viewer;
  readonly hostRef: RefObject<HTMLElement | null>;
  readonly onTitle: (title: string) => void;
}) => {
  const registry = useEditorSessionRegistry();
  const upload = useUploadSession();
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  // Wait until the runtime has confirmed this viewer's account.
  const accountId = upload.accountId === viewer.id ? viewer.id : null;
  const store = useSyncExternalStore(
    registry.subscribe,
    () => registry.current(accountId),
    () => registry.current(accountId),
  );
  const state = useEditorStoreState(store);
  const resolution =
    accountId === null ? null : resolveSession(store, target, upload.session);
  const title = editorTitle(
    target,
    resolution?.kind === "store" ? state : null,
  );

  useEffect(() => onTitle(title), [onTitle, title]);

  const deps = useMemo<EditorLoaderDeps>(
    () => ({
      client: publishingClient,
      recovery: registry.recovery,
      upload: () => uploadRef.current,
      alive: (candidate) =>
        registry.accountId === candidate.accountId &&
        registry.current(candidate.accountId) === candidate,
      requestId: requestIdentity,
      deviceClass: () =>
        typeof navigator === "undefined" ? null : detectDeviceClass(navigator),
      currentAccount: () => authorClient.account(),
    }),
    [registry],
  );

  const resolutionKind = resolution?.kind ?? null;
  useEffect(() => {
    if (accountId === null || resolutionKind !== "create") return;
    const created = registry.create(accountId, target);
    void openEditorSession(created, target, deps);
  }, [accountId, deps, registry, resolutionKind, target]);

  const shown = resolution?.kind === "store" ? resolution.store : null;
  useEffect(() => {
    if (shown === null) return undefined;
    const release = registry.mount(shown);
    return () => {
      release();
      registry.deferClose(
        shown,
        () => void closeOnLeave(registry, shown, deps),
      );
    };
  }, [deps, registry, shown]);

  if (resolution === null || resolution.kind === "create")
    return <ReturnBar controls={controls} title={title} />;

  if (resolution.kind === "other")
    return (
      <>
        <ReturnBar controls={controls} title={title} />
        <OtherSessionPanel
          controls={controls}
          deps={deps}
          registry={registry}
          resolution={resolution}
          upload={upload}
        />
      </>
    );

  const current = resolution.store;
  if (state === null || state.key !== current.key)
    return <ReturnBar controls={controls} title={title} />;

  if (state.phase !== "ready")
    return (
      <>
        <ReturnBar controls={controls} title={title} />
        {state.phase === "loading" ? (
          <p aria-live="polite" className={styles.message} role="status">
            正在打开…
          </p>
        ) : (
          <UnavailablePanel
            message={state.unavailableMessage ?? ""}
            onBack={() => {
              registry.markLeaving(current, "discarded");
              controls.close();
            }}
            onRetry={() => void retryEditorSession(current, state.target, deps)}
          />
        )}
      </>
    );

  return (
    <EditorWorkspace
      controls={controls}
      deps={deps}
      hostRef={hostRef}
      state={state}
      store={current}
      title={title}
      viewer={viewer}
    />
  );
};

const UnavailablePanel = ({
  message,
  onRetry,
  onBack,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) => {
  const headingRef = useHeadingFocus();
  return (
    <div className={styles.message} data-editor-unavailable="">
      <h2 ref={headingRef} tabIndex={-1}>
        {message}
      </h2>
      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          onClick={onRetry}
          type="button"
        >
          重试
        </button>
        <button className={styles.textButton} onClick={onBack} type="button">
          返回
        </button>
      </div>
    </div>
  );
};

/**
 * Leaving the editor (overlay unmounted): the runtime keeps the session when
 * leaving would lose work (uploads continue; the progress entry returns),
 * otherwise it ends. An edit draft this session opened is removed again only
 * while the account still holds it at the revision it was opened with.
 */
const closeOnLeave = async (
  registry: EditorSessionRegistry,
  store: EditorSessionStore,
  deps: EditorLoaderDeps,
) => {
  // Another account is active: the runtime already paused this one, and
  // nothing may act on the other account's session in its name.
  if (
    registry.accountId !== store.accountId ||
    deps.currentAccount() !== store.accountId
  )
    return;
  const upload = deps.upload();
  const removeOpenedDraft = () => {
    const opened = store.get().openedEditDraft;
    if (opened === null) return;
    void removeUnchangedEditDraft(store.accountId, opened, {
      ...deps,
      forgetLocalCopies: (draftId) => upload.forgetDraftLocalCopies(draftId),
    });
  };
  const reason = registry.leavingReason(store);
  if (reason !== null) {
    if (reason === "discarded") removeOpenedDraft();
    registry.dispose(store);
    return;
  }
  const result = await upload.closeSession({ discard: false });
  if (result === "kept") return;
  if (result === "ended") removeOpenedDraft();
  registry.dispose(store);
};

const OtherSessionPanel = ({
  resolution,
  registry,
  controls,
  upload,
  deps,
}: {
  readonly resolution: Extract<
    ReturnType<typeof resolveSession>,
    { kind: "other" }
  >;
  readonly registry: EditorSessionRegistry;
  readonly controls: ProductShellEditorOverlayControls;
  readonly upload: UploadSessionApi;
  readonly deps: EditorLoaderDeps;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useHeadingFocus();
  const latest = useRef(upload);
  latest.current = upload;
  const other = resolution.store;
  // Only a session whose editor state still exists can be returned to.
  const otherTarget = other?.get().target ?? null;
  const unsaved = resolution.session?.saveMode === "unsaved";
  const unfinished = unfinishedUploads(upload.uploads);

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!unsaved) {
        await latest.current.saveNow();
        if (latest.current.hasUnsavedChanges()) {
          const status = latest.current.autosave?.status;
          setError(
            status === "conflict"
              ? `那项编辑有两个版本待选择，暂时无法结束。${otherTarget === null ? "" : "请回到那项编辑选择版本。"}`
              : (latest.current.autosave?.error?.message ??
                  `那项编辑的更改没有保存完成，暂时无法结束。${otherTarget === null ? "请稍后重试。" : "可以回到那项编辑处理。"}`),
          );
          return;
        }
      }
      const opened = other?.get().openedEditDraft ?? null;
      const result = await latest.current.closeSession({ discard: true });
      if (other !== null) {
        if (result === "ended" && opened !== null)
          void removeUnchangedEditDraft(other.accountId, opened, {
            ...deps,
            forgetLocalCopies: (draftId) =>
              latest.current.forgetDraftLocalCopies(draftId),
          });
        registry.dispose(other);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "草稿未保存，请回到编辑后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.message} data-editor-other-session="">
      <h2 ref={headingRef} tabIndex={-1}>
        还有一项编辑没有结束
      </h2>
      <p>同一时间只能进行一项编辑。可以回到那项编辑，或结束它后再开始。</p>
      <p data-editor-other-scope="">
        {unsaved
          ? "那项编辑没有保存到账号，结束后其中的文字、设置和图片都会被丢弃，无法找回。"
          : "结束前会先保存那项编辑的更改，之后可以在草稿中继续。"}
        {unfinished > 0
          ? `其中 ${unfinished} 项图片还没有上传完成，结束后这些上传会停止。`
          : ""}
      </p>
      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {otherTarget === null ? null : (
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => controls.replaceTarget(otherTarget)}
            type="button"
          >
            回到那项编辑
          </button>
        )}
        <button
          aria-busy={busy || undefined}
          className={styles.textButton}
          disabled={busy}
          onClick={() => void end()}
          type="button"
        >
          {busy ? "正在保存…" : "保存草稿并结束那项编辑"}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Workspace

type LeaveState = {
  readonly variant: LeaveDialogVariant;
  readonly saving: boolean;
  /** 保存并离开 ran and the account has not confirmed everything. */
  readonly failed: boolean;
};

/** Why 保存并离开 did not finish, from the autosave state now. */
const leaveErrorText = (autosave: AutosaveState | null): string =>
  autosave?.status === "conflict"
    ? "有两个版本待选择，选择版本后才能保存"
    : autosave?.error?.code != null
      ? autosave.error.message
      : "保存没有完成，可以再试一次，或放弃本次未保存的更改";

interface FocusedField {
  readonly field: EditorField;
  readonly start: number | null;
  readonly end: number | null;
  focused: boolean;
}

const EditorWorkspace = ({
  store,
  state,
  controls,
  viewer,
  title,
  deps,
  hostRef,
}: {
  readonly store: EditorSessionStore;
  readonly state: EditorSessionState;
  readonly controls: ProductShellEditorOverlayControls;
  readonly viewer: Viewer;
  readonly title: string;
  readonly deps: EditorLoaderDeps;
  readonly hostRef: RefObject<HTMLElement | null>;
}) => {
  const registry = useEditorSessionRegistry();
  const upload = useUploadSession();
  const staged = useStagedItems();
  const submission = useSubmission();
  const edits = useEditReadiness();
  const shell = useProductShell();
  const author = useAuthors();
  const width = useViewportWidth();
  const layout =
    shell.platform === "pc" ||
    (shell.platform === "tablet" && width >= DESKTOP_MINIMUM_WIDTH)
      ? "desktop"
      : "phone";

  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const session = upload.session;
  const saveMode = session?.saveMode ?? null;
  const autosave = saveMode === "saved" ? upload.autosave : null;
  const draftId = autosave?.draftId ?? session?.draftId ?? null;
  const uploads = upload.uploads;

  const [leave, setLeave] = useState<LeaveState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState<{
    readonly opener: HTMLElement;
  } | null>(null);
  const [versionsPanel, setVersionsPanel] = useState<VersionsPanel>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const leavingRef = useRef(false);
  const submitIntentRef = useRef(false);
  const pendingFocusRef = useRef<EditorField | null>(null);
  const menuId = useId();

  // Author changes reach the runtime (autosave in saved mode) once per edit.
  useEffect(() => {
    if (sentEditVersion(store) === state.editVersion) return;
    markEditVersionSent(store, state.editVersion);
    uploadRef.current.edit(contentOf(store.get()));
  }, [state.editVersion, store]);

  // Items the manager adds or identifies follow into the album.
  useEffect(() => {
    store.syncManagedItems(uploadRef.current.draftItems());
  }, [store, uploads]);

  // A new work's draft becomes the editor entry (reload reopens it); a
  // draft turned into a no-save session is a new work again.
  useEffect(() => {
    const current = store.get();
    if (current.kind !== "new") return;
    const next: EditorTarget | null =
      saveMode === "saved" && draftId !== null
        ? current.target.type === "draft" && current.target.id === draftId
          ? null
          : { type: "draft", id: draftId }
        : saveMode === "unsaved" && current.target.type === "draft"
          ? { type: "new" }
          : null;
    if (next === null) return;
    store.setTarget(next);
    controls.replaceTarget(next);
  }, [controls, draftId, saveMode, store]);

  const staging = staged.staging;
  const stagingActive = staging !== null && staging.batch.entries.length > 0;

  const readiness = readinessOf(state, uploads, edits);
  const issues = localIssues(state);
  const mediaScope: EditorMediaScope =
    layout === "desktop" || previewOpen !== null
      ? "all"
      : state.step === "confirm"
        ? "cover"
        : "none";
  const media = useEditorMediaSources(
    state,
    uploads,
    upload.localStill,
    mediaScope,
  );
  const authorshipKind = state.authorshipKind;
  const reference = state.reference;
  const presentation = useMemo(
    () =>
      editorPreviewPresentation(
        {
          title: state.title,
          body: state.body,
          workId: state.workId,
          authorship: authorshipOf({ authorshipKind, reference }),
        },
        media.sources,
        viewer,
      ),
    [
      state.title,
      state.body,
      state.workId,
      authorshipKind,
      reference,
      media.sources,
      viewer,
    ],
  );
  // The continuous preview follows typing without holding it up.
  const deferredPresentation = useDeferredValue(presentation);
  const coverKey = state.coverKey ?? state.items[0]?.key ?? null;
  const cover = media.sources.find((entry) => entry.key === coverKey) ?? null;

  // Account items whose state is not known yet are read once (never counted as ready).
  const unknownItems = readiness.unknownItemIds.join(" ");
  const requestedItems = useRef(new Set<string>());
  const [itemRetry, setItemRetry] = useState(0);
  useEffect(() => {
    if (unknownItems === "") return undefined;
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const itemId of unknownItems.split(" ")) {
      if (requestedItems.current.has(itemId)) continue;
      requestedItems.current.add(itemId);
      Promise.resolve()
        .then(() => publishingClient.item(itemId))
        .then(
          (item) => {
            if (active) store.mergeServerItems([item]);
          },
          () => {
            requestedItems.current.delete(itemId);
            if (active)
              timers.push(setTimeout(() => setItemRetry((n) => n + 1), 5000));
          },
        );
    }
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [itemRetry, store, unknownItems]);

  // -- versions -------------------------------------------------------------

  const submissionBusy =
    submitting ||
    submission.state.status === "submitting" ||
    submission.state.status === "reconciling";
  const unfinished = unfinishedUploads(uploads);

  /**
   * A version the author chose (conflict chooser or history). The runtime
   * adopts it at once as the base of the next conditional save, together
   * with the content now on screen, so no later edit or item sync can reach
   * the account on the replaced base; uploads keep running. This browser's
   * local copies of the chosen draft's media are then reopened. An answer
   * that arrives once the account, this editor session or the draft it
   * saves to has changed belongs to none of them: nothing is adopted, and a
   * later save of that draft still meets the account's newer revision.
   */
  const chooseVersion = (
    draft: PublishingDraft,
    conflict: PublishingDraftConflict | null,
  ) => {
    const api = uploadRef.current;
    const heldDraftId =
      api.session?.saveMode === "saved"
        ? (api.autosave?.draftId ?? api.session.draftId ?? null)
        : null;
    if (
      !deps.alive(store) ||
      deps.currentAccount() !== store.accountId ||
      api.accountId !== store.accountId ||
      heldDraftId !== draft.id
    )
      return;
    const screen = store.content();
    const hasLaterEdits =
      conflict !== null && !sameAuthorContent(screen, conflict.device.content);
    const content =
      conflict === null
        ? draft.content
        : preserveLaterConflictEdits(
            draft.content,
            conflict.device.content,
            screen,
          );
    store.adoptContent(content, draft.mediaItems);
    // The adopted content carries every edit made so far.
    markEditVersionSent(store, store.get().editVersion);
    api.adoptDraft(draft, store.content());
    void api.restoreDraftMedia(draft).catch(() => undefined);
    if (
      hasLaterEdits &&
      conflict !== null &&
      !sameAuthorContent(draft.content, conflict.device.content)
    )
      store.setNotice("已选择版本，并保留冲突出现后在本设备输入的更改");
  };

  const conflict = autosave?.status === "conflict" ? autosave.conflict : null;
  const conflictId = conflict?.id ?? null;
  const shownConflict = useRef<string | null>(null);
  useEffect(() => {
    if (
      conflictId === null ||
      state.restarting ||
      shownConflict.current === conflictId
    )
      return;
    shownConflict.current = conflictId;
    // A new conflict takes over from history: never two panels at once.
    setVersionsPanel("conflict");
  }, [conflictId, state.restarting]);

  // The chooser is gone with its conflict (chosen here or settled elsewhere).
  const shownPanel: VersionsPanel =
    versionsPanel === "conflict" && conflict === null ? null : versionsPanel;
  const closePanel = (panel: Exclude<VersionsPanel, null>) =>
    setVersionsPanel((current) => (current === panel ? null : current));

  // -- leave guard ----------------------------------------------------------

  const unsavedText =
    saveMode === "saved" &&
    autosave !== null &&
    (autosave.editVersion > autosave.savedVersion ||
      autosave.status === "saving" ||
      autosave.status === "reconciling" ||
      autosave.status === "error" ||
      autosave.status === "conflict");
  const noSaveContent =
    saveMode === "unsaved" &&
    (session?.hasContent === true ||
      (uploads?.items.length ?? 0) > 0 ||
      !isEmptyWork(state));
  const unfinishedWork = session !== null && upload.hasUnfinishedWork();
  const latestGuard = useRef({
    submissionBusy,
    unsavedText,
    noSaveContent,
    unfinishedWork,
    previewOpen: previewOpen !== null,
  });
  latestGuard.current = {
    submissionBusy,
    unsavedText,
    noSaveContent,
    unfinishedWork,
    previewOpen: previewOpen !== null,
  };
  const needsGuard =
    submissionBusy ||
    unsavedText ||
    noSaveContent ||
    unfinishedWork ||
    previewOpen !== null;

  const guard = useCallback((reason: ProductShellEditorLeaveReason) => {
    if (leavingRef.current) return "allow" as const;
    const now = latestGuard.current;
    if (reason === "unload")
      return now.submissionBusy ||
        now.unsavedText ||
        now.noSaveContent ||
        now.unfinishedWork
        ? ("blocked" as const)
        : ("allow" as const);
    // The browser's Back from 预览 returns to the editor, like its own Back.
    if (reason === "history" && now.previewOpen) {
      setPreviewOpen(null);
      return "blocked" as const;
    }
    const variant: LeaveDialogVariant | null = now.submissionBusy
      ? "submitting"
      : now.noSaveContent
        ? "unsaved"
        : now.unsavedText || now.unfinishedWork
          ? "saved"
          : null;
    // Unsaved text and unfinished media both require an explicit leave choice.
    if (variant === null) return "allow" as const;
    setLeave({ variant, saving: false, failed: false });
    return "blocked" as const;
  }, []);

  useEffect(() => {
    if (!needsGuard) return undefined;
    return controls.registerLeaveGuard(guard);
  }, [controls, guard, needsGuard]);

  const leaveNow = useCallback(() => {
    leavingRef.current = true;
    setLeave(null);
    controls.close();
  }, [controls]);

  const saveAndLeave = async () => {
    setLeave(
      (current) => current && { ...current, saving: true, failed: false },
    );
    try {
      await uploadRef.current.saveNow();
    } catch (error) {
      store.setNotice(
        error instanceof Error ? error.message : "保存失败，请重试",
      );
      setLeave(
        (current) => current && { ...current, saving: false, failed: true },
      );
      return;
    }
    if (!uploadRef.current.hasUnsavedChanges()) {
      leaveNow();
      return;
    }
    setLeave(
      (current) => current && { ...current, saving: false, failed: true },
    );
  };

  const discardAndLeave = () => {
    registry.markLeaving(store, "discarded");
    void uploadRef.current.closeSession({ discard: true });
    leaveNow();
  };

  // -- submission -----------------------------------------------------------

  const submit = async () => {
    if (submitting) return;
    store.setFieldErrors({});
    submitIntentRef.current = true;
    setSubmitting(true);
    try {
      await submission.submit(store.content());
    } finally {
      setSubmitting(false);
    }
  };

  const submissionState = submission.state;
  const notify = author.notify;
  const handledSubmission = useRef(submissionState);
  useEffect(() => {
    // Each result is handled once, and only for a submit made in this editor
    // (a receipt of an earlier session never navigates anywhere).
    if (
      !submitIntentRef.current ||
      handledSubmission.current === submissionState
    )
      return;
    handledSubmission.current = submissionState;
    if (submissionState.status === "confirmed") {
      submitIntentRef.current = false;
      leavingRef.current = true;
      registry.markLeaving(store, "completed");
      notify(store.get().kind === "edit" ? "更新已保存" : "作品已提交");
      controls.completeWith({
        type: "work",
        id: submissionState.receipt.workId,
      });
    } else if (submissionState.status === "failed") {
      submitIntentRef.current = false;
      store.setFieldErrors({
        [failureField(submissionState.code)]: submissionState.message,
      });
    } else if (submissionState.status === "not_ready") {
      // The runtime shows those items as processing and asks the account
      // again; the sheet names the count (no field error).
      submitIntentRef.current = false;
    }
  }, [controls, notify, registry, store, submissionState]);

  const goToField = (field: EditorField) => {
    pendingFocusRef.current = field;
    setConfirmOpen(false);
    if (layout === "phone") store.setStep(fieldStep(field));
    nextFrame(() => {
      const target = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (target === null) return;
      const element = hostRef.current?.querySelector<HTMLElement>(
        target === "media"
          ? "[data-editor-media]"
          : `[data-editor-input="${target}"]`,
      );
      element?.focus({ preventScroll: false });
    });
  };

  // -- focus ------------------------------------------------------------------

  const focusedOnOpen = useRef(false);
  useEffect(() => {
    if (focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    nextFrame(() => {
      const host = hostRef.current;
      if (host === null || !host.isConnected) return;
      // The author already moved on inside the editor: focus stays there.
      const active = document.activeElement;
      if (
        active !== null &&
        active !== host &&
        host.contains(active) &&
        active !== controls.backButtonRef.current
      )
        return;
      // The first meaningful control; the step heading only without one.
      const control =
        host.querySelector<HTMLElement>(
          "[data-editor-autofocus]:not(:disabled)",
        ) ?? host.querySelector<HTMLElement>("[data-editor-step-heading]");
      control?.focus({ preventScroll: true });
    });
  }, [controls, hostRef]);

  // The field being typed in follows a layout change (E06).
  const focusedField = useRef<FocusedField | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const fieldOf = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
        ? target.getAttribute("data-editor-input")
        : null;
    const record = (event: Event) => {
      const element = event.target as HTMLInputElement | HTMLTextAreaElement;
      const field = fieldOf(event.target) as EditorField | null;
      if (field === null) return;
      focusedField.current = {
        field,
        start: element.selectionStart,
        end: element.selectionEnd,
        focused: true,
      };
    };
    const blur = (event: FocusEvent) => {
      const element = event.target;
      const entry = focusedField.current;
      if (fieldOf(element) === null || entry === null) return;
      // A field removed by a layout change keeps its claim; a real blur does not.
      queueMicrotask(() => {
        if ((element as Element).isConnected && focusedField.current === entry)
          entry.focused = false;
      });
    };
    const events = ["focusin", "input", "keyup", "pointerup", "select"];
    for (const name of events) host.addEventListener(name, record);
    host.addEventListener("focusout", blur);
    return () => {
      for (const name of events) host.removeEventListener(name, record);
      host.removeEventListener("focusout", blur);
    };
  }, [hostRef]);

  const shownLayout = useRef(layout);
  useLayoutEffect(() => {
    if (shownLayout.current === layout) return;
    shownLayout.current = layout;
    // A dialog of the other layout never reopens later by itself.
    if (layout === "phone") setConfirmOpen(false);
    else setPreviewOpen(null);
    const entry = focusedField.current;
    if (entry === null || !entry.focused) return;
    if (layout === "phone") store.setStep(fieldStep(entry.field));
    nextFrame(() => {
      const element = hostRef.current?.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(`[data-editor-input="${entry.field}"]`);
      if (element == null || document.activeElement === element) return;
      element.focus({ preventScroll: false });
      if (entry.start !== null && entry.end !== null)
        try {
          element.setSelectionRange(entry.start, entry.end);
        } catch {
          // Some input types do not keep a selection.
        }
    });
  }, [hostRef, layout, store]);

  // -- rendering --------------------------------------------------------------

  const canSaveNow =
    !submissionBusy &&
    saveMode === "saved" &&
    autosave !== null &&
    autosave.status !== "saving" &&
    autosave.status !== "reconciling" &&
    autosave.status !== "conflict" &&
    (draftId !== null || !isEmptyWork(state));

  const primaryLabel = state.kind === "edit" ? "保存更新" : "发布";

  const saveNow = async () => {
    setAnnouncement("");
    try {
      await uploadRef.current.saveNow();
    } catch (error) {
      store.setNotice(
        error instanceof Error ? error.message : "保存失败，请重试",
      );
      return;
    }
    if (!uploadRef.current.hasUnsavedChanges()) setAnnouncement("已保存");
  };

  const barActions = (
    <>
      {saveMode === "saved" ? (
        <button
          className={styles.textButton}
          data-editor-save-now=""
          disabled={!canSaveNow}
          onClick={() => void saveNow()}
          type="button"
        >
          保存草稿
        </button>
      ) : null}
      {saveMode === "saved" && draftId !== null ? (
        <>
          <button
            aria-controls={menuOpen ? menuId : undefined}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="更多操作"
            data-editor-menu=""
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <Icon aria-hidden="true" name="menu" />
          </button>
          {menuOpen ? (
            <EditorMenu
              id={menuId}
              onClose={() => setMenuOpen(false)}
              onHistory={() => {
                setMenuOpen(false);
                setVersionsPanel("history");
              }}
            />
          ) : null}
        </>
      ) : null}
      {layout === "desktop" ? (
        <button
          className={styles.primaryButton}
          data-editor-open-confirmation=""
          onClick={() => setConfirmOpen(true)}
          type="button"
        >
          {primaryLabel}
        </button>
      ) : null}
    </>
  );

  const switches = () => (
    <ModeSwitches>
      <OriginalQualitySwitch
        autoFocus={layout === "phone"}
        onChange={store.setOriginalNext}
        original={state.originalNext}
      />
    </ModeSwitches>
  );

  const uploadSummary =
    readiness.total === 0
      ? ""
      : readiness.text !== null
        ? readiness.text
        : readiness.confirmed
          ? `全部 ${readiness.ready} 项已就绪`
          : "正在确认图片状态…";

  const notices = (
    <>
      {state.notice === null ? null : (
        <p className={styles.notice} data-editor-notice="" role="status">
          <span>{state.notice}</span>
          <button
            className={styles.inlineAction}
            onClick={() => store.setNotice(null)}
            type="button"
          >
            知道了
          </button>
        </p>
      )}
      {state.fieldErrors.media === undefined ? null : (
        <p className={styles.notice} data-tone="error" role="alert">
          {state.fieldErrors.media}
        </p>
      )}
      {session === null &&
      !leavingRef.current &&
      !state.restarting &&
      submissionState.status !== "confirmed" ? (
        <p className={styles.notice} data-tone="error" role="alert">
          本次编辑已结束，返回后可重新开始
        </p>
      ) : null}
    </>
  );

  const mediaSection = (mediaLayout: MediaSectionLayout) => (
    <div data-editor-media="" tabIndex={-1}>
      <MediaSection
        layout={mediaLayout}
        {...(mediaLayout === "phone"
          ? { onSkip: () => store.setStep("text") }
          : {})}
        sessionKey={store.key}
      />
    </div>
  );

  const progressLine =
    readiness.blocking > 0 && readiness.text !== null ? (
      <p className={styles.notice} data-editor-upload-progress="">
        图片：{readiness.text}
      </p>
    ) : null;

  const confirmation = (
    <ConfirmationSheet
      cover={cover}
      issues={issues}
      onCheckAgain={() => void submission.checkAgain()}
      onGoToField={goToField}
      onRetry={() => void submission.retry()}
      onSubmit={() => void submit()}
      readiness={readiness}
      resolving={submitting}
      state={state}
      submission={submissionState}
      unconfirmedFiles={
        stagingActive && staging !== null ? staging.count.ready : 0
      }
    />
  );

  const previewShown = previewOpen !== null && layout === "phone";
  const leaveHasDraft = draftId !== null;

  return (
    <>
      <ReturnBar
        actions={barActions}
        controls={controls}
        inert={previewShown}
        status={
          <SaveStatus
            autosave={autosave}
            onChooseVersion={() => setVersionsPanel("conflict")}
            onRetry={() => void saveNow()}
            saveMode={saveMode}
          />
        }
        title={title}
      />
      {/* The media section and the confirmation announce their own changes. */}
      <p aria-live="polite" className={styles.visuallyHidden} role="status">
        {announcement !== ""
          ? announcement
          : layout === "phone" && state.step === "text"
            ? uploadSummary
            : ""}
      </p>
      <div className={styles.body} data-editor-body="" inert={previewShown}>
        {layout === "phone" ? (
          <PhoneSteps
            confirm={
              <>
                {notices}
                {confirmation}
              </>
            }
            canContinue={state.items.length > 0 || stagingActive}
            mediaItemCount={state.items.length}
            focusHeading
            media={
              <>
                {switches()}
                {notices}
                {mediaSection("phone")}
              </>
            }
            onPreview={(opener) => setPreviewOpen({ opener })}
            onStepChange={store.setStep}
            step={state.step}
            text={
              <TextSettings
                autoFocusTitle
                progress={
                  <>
                    {notices}
                    {progressLine}
                  </>
                }
                state={state}
                store={store}
              />
            }
          />
        ) : (
          <DesktopEditor
            media={mediaSection("desktop")}
            preview={
              <ContinuousPreview
                presentation={deferredPresentation}
                unedited={media.unedited}
              />
            }
            status={
              <div className={styles.fields}>
                {notices}
                {progressLine}
              </div>
            }
            switches={switches()}
            text={<TextSettings autoFocusTitle state={state} store={store} />}
          />
        )}
      </div>

      {confirmOpen && layout === "desktop" ? (
        <EditorDialog
          cancellable={!submissionBusy}
          dataName="confirmation"
          onCancel={() => setConfirmOpen(false)}
          size="wide"
          title={state.kind === "edit" ? "确认保存更新" : "确认发布"}
        >
          {confirmation}
          <div className={styles.sheetActions}>
            <button
              className={styles.textButton}
              disabled={submissionBusy}
              onClick={() => setConfirmOpen(false)}
              type="button"
            >
              返回编辑
            </button>
          </div>
        </EditorDialog>
      ) : null}

      {previewShown ? (
        <PhonePreview
          onClose={() => setPreviewOpen(null)}
          opener={previewOpen.opener}
          orientation={shell.orientation}
          platform={shell.platform}
          presentation={presentation}
          unedited={media.unedited}
        />
      ) : null}

      {leave === null ? null : (
        <LeaveDialog
          canChooseVersion={conflict !== null}
          error={leave.failed ? leaveErrorText(autosave) : null}
          hasDraft={leaveHasDraft}
          isEdit={state.kind === "edit"}
          onChooseVersion={() => {
            setLeave(null);
            setVersionsPanel("conflict");
          }}
          onContinue={() => setLeave(null)}
          onDiscard={discardAndLeave}
          onSaveAndLeave={() => void saveAndLeave()}
          saveBlocked={autosave?.status === "conflict"}
          saving={leave.saving}
          unfinishedUploads={unfinished}
          variant={leave.variant}
        />
      )}

      {shownPanel === "history" && draftId !== null ? (
        <HistoryPanel
          draftId={draftId}
          onClose={() => closePanel("history")}
          {...(conflict === null
            ? {}
            : { onChooseVersion: () => setVersionsPanel("conflict") })}
          onRestored={(draft) => {
            closePanel("history");
            chooseVersion(draft, null);
          }}
        />
      ) : null}

      {shownPanel === "conflict" && draftId !== null && conflict !== null ? (
        <ConflictChooser
          conflict={conflict}
          draftId={draftId}
          {...conflictMediaItems(state, uploads, conflict)}
          onClose={() => closePanel("conflict")}
          onResolved={(draft) => {
            closePanel("conflict");
            chooseVersion(draft, conflict);
          }}
        />
      ) : null}
    </>
  );
};

const EditorMenu = ({
  id,
  onClose,
  onHistory,
}: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onHistory: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const menu = ref.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      latest.current();
      opener?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (
        menu !== null &&
        event.target instanceof Node &&
        !menu.contains(event.target) &&
        !(opener?.contains(event.target) ?? false)
      )
        latest.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);
  return (
    <div className={styles.menu} id={id} ref={ref} role="menu">
      <button
        data-editor-menu-history=""
        onClick={onHistory}
        role="menuitem"
        type="button"
      >
        <span className={styles.menuLabel}>历史版本</span>
      </button>
    </div>
  );
};
