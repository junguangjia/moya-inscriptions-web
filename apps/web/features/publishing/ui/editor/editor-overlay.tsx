"use client";

import { Icon, IconButton } from "@moya/ui";
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
import { useArticleAvailability } from "../../../editorial-content/article-authoring/article-availability";
import {
  openArticleDraftBox,
  openArticleDraftInPlace,
  useArticleDraftCreation,
} from "../../../editorial-content/article-authoring/use-article-draft-creation";
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
import { mediaUiFor, useMediaUiState } from "../media/media-ui-store";
import {
  PHONE_MEDIA_TARGET,
  PhoneFlow,
  cancelPhoneLayer,
  showPhoneField,
  shownPhoneScreen,
  stepBackPhone,
} from "../phone/phone-flow";
import { ConfirmationSheet } from "./confirmation-sheet";
import { DesktopEditor } from "./desktop-editor";
import { EditorDialog } from "./editor-dialog";
import { KEYBOARD_ATTRIBUTE, useEditorLayout } from "./editor-layout";
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
  isEmptyWork,
  localIssues,
  readinessOf,
  resolveSession,
  sameAuthorContent,
  preserveLaterConflictEdits,
} from "./editor-session-state";
import { LeaveDialog } from "./leave-dialog";
import { ModeSwitches, OriginalQualitySwitch } from "./mode-switches";
import {
  ContinuousPreview,
  PhonePreview,
  editorPreviewPresentation,
  useEditorMediaSources,
} from "./preview";
import { ReturnBar } from "./return-bar";
import { SaveStatus, saveStatusOf } from "./save-status";
import { TextSettings } from "./text-settings";
import styles from "./editor.module.css";

import type { ConfirmationSheetProps } from "./confirmation-sheet";
import type { EditorLoaderDeps } from "./editor-session-loader";
import type { EditorSessionRegistry } from "./editor-session-provider";
import type {
  EditorField,
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { LeaveDialogVariant } from "./leave-dialog";
import type { StartOptions } from "../phone/add-tiles";
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
import type { RefObject } from "react";

const editorTitle = (target: EditorTarget, state: EditorSessionState | null) =>
  (state?.kind ?? (target.type === "work" ? "edit" : "new")) === "edit"
    ? "编辑作品"
    : target.type === "new" && target.threadId
      ? "参与话题"
      : "发布作品";

type UploadSessionApi = ReturnType<typeof useUploadSession>;

/** Said when a new work leaves from 编辑 with its photos kept as a draft (r4 §2.3). */
const LEFT_FROM_EDIT_NOTICE = "照片已存入草稿箱，可从草稿箱继续编辑。";

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

/**
 * Keeps the editor inside the visual viewport (keyboard, safe areas), like
 * Search. The host also says whether the keyboard is up (`KEYBOARD_ATTRIBUTE`):
 * the measured inset, not focus, since a keyboard dismissed by the system
 * Back or a hardware keyboard leaves focus in the field.
 */
export const useVisualViewportFrame = (
  hostRef: RefObject<HTMLElement | null>,
) => {
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
        host.setAttribute(KEYBOARD_ATTRIBUTE, "false");
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
      host.setAttribute(KEYBOARD_ATTRIBUTE, inset > 1 ? "true" : "false");
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
      host.removeAttribute(KEYBOARD_ATTRIBUTE);
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

interface Viewer {
  readonly id: string;
  readonly displayName: string;
  readonly studioName?: string | undefined;
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
        <IconButton
          icon={<Icon aria-hidden="true" name="back" />}
          label="返回"
          onClick={onBack}
        />
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

/**
 * Why 存草稿并退出 stopped waiting for the uploads: the photos (by their
 * place) that need the author before the draft can hold them.
 */
const waitStoppedText = (
  album: readonly { readonly key: string }[],
  blocked: readonly string[],
): string => {
  const places = album.flatMap((item, index) =>
    blocked.includes(item.key) ? [index + 1] : [],
  );
  const first = places[0];
  if (first === undefined) return "没有存草稿：有照片需要处理";
  return places.length === 1
    ? `没有存草稿：第 ${first} 项需要处理`
    : `没有存草稿：第 ${first} 项等 ${places.length} 项需要处理`;
};

/**
 * Why 编辑's 存草稿并退出 did not leave (r4 ASK-1): said among 编辑's
 * notices, where no dialog offers 放弃.
 */
const editSaveErrorText = (autosave: AutosaveState | null): string =>
  autosave?.status === "conflict"
    ? "有两个版本待选择，选择版本后才能保存"
    : autosave?.error?.code != null
      ? autosave.error.message
      : "保存没有完成，请再试一次";

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
  const layout = useEditorLayout();
  // The phone screens' place (media-ui-store), kept with the session.
  const mediaUi = mediaUiFor(store);
  const { phone: phoneUi, dialog: mediaDialog } = useMediaUiState(mediaUi);
  const phoneScreen =
    layout === "phone"
      ? shownPhoneScreen(state.step, state.items, phoneUi.heldRemoval)
      : null;
  /**
   * What 编辑 or the start screen still holds (the shown crop, a removal
   * waiting for 撤销), kept before a browser Back leaves the screen.
   */
  const editCommitRef = useRef<(() => void) | null>(null);
  // Where the phone resumes is decided once per opening; an editor opened
  // on the desktop keeps its place when it later swaps to the phone.
  const [resumeChecked, setResumeChecked] = useState(() => layout !== "phone");

  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // 专题 on the phone's start screen (r4 D3): today's 专题文章 creation,
  // here so a create in flight outlives a layout swap.
  const articlesOn = useArticleAvailability();
  const topicCreation = useArticleDraftCreation();
  const topicCreating = topicCreation.creating;

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
  /**
   * 存草稿并退出 waiting for the picks' uploads: how it settles (the
   * refusal's reason, or null once it left or the wait ended).
   */
  const uploadWait = useRef<((reason: string | null) => void) | null>(null);
  const [waitingUploads, setWaitingUploads] = useState(false);
  const leavingRef = useRef(false);
  const submitIntentRef = useRef(false);
  const pendingFocusRef = useRef<EditorField | null>(null);
  const menuId = useId();

  /**
   * Author changes reach the runtime (autosave in saved mode) once per edit;
   * true when this call sent one. The leave guard sends at once what a Back
   * just committed, before it decides whether leaving loses anything.
   */
  const sendEdits = useCallback(() => {
    const { editVersion } = store.get();
    if (sentEditVersion(store) === editVersion) return false;
    markEditVersionSent(store, editVersion);
    uploadRef.current.edit(contentOf(store.get()));
    return true;
  }, [store]);
  useEffect(() => {
    sendEdits();
  }, [state.editVersion, sendEdits]);

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
  // The phone screens decode their own pictures; 预览作品页 needs them all.
  const mediaScope: EditorMediaScope =
    layout === "desktop" || previewOpen !== null ? "all" : "none";
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
  /**
   * One phone screen back: 发布 → 编辑 (or the start screen without
   * photos), 编辑 → its back sheet for a work started here (r4 ASK-1);
   * false where Back leaves (the start screen, 编辑 of a draft or a work).
   */
  const phoneBack = () =>
    phoneScreen !== null &&
    stepBackPhone(store, mediaUi, () => editCommitRef.current?.());
  /** The topmost phone layer (a sheet, 封面构图) closes as its ‹ would. */
  const phoneLayerBack = () =>
    phoneScreen !== null &&
    cancelPhoneLayer(
      hostRef.current?.querySelector("[data-phone-flow]") ?? null,
    );
  const guardState = {
    submissionBusy,
    unsavedText,
    noSaveContent,
    unfinishedWork,
    topicCreating,
    // Leaving a new work from 编辑 with its draft: say where the photos are.
    // Only a work started in this editor: a draft opened from 草稿箱 is
    // already there (its session is "new" too).
    leavingFromEdit:
      phoneScreen === "edit" &&
      state.openedAs.type === "new" &&
      draftId !== null,
    newWorkOnEdit: phoneScreen === "edit" && state.openedAs.type === "new",
    savedMode: saveMode === "saved",
    previewOpen: previewOpen !== null,
    // 历史版本 or the version chooser over the phone screens.
    phonePanel: phoneScreen !== null && shownPanel !== null,
    phoneBack,
    phoneLayerBack,
    sendEdits,
  };
  const latestGuard = useRef(guardState);
  latestGuard.current = guardState;
  const notifyRef = useRef(author.notify);
  notifyRef.current = author.notify;
  const needsGuard =
    submissionBusy ||
    unsavedText ||
    noSaveContent ||
    unfinishedWork ||
    previewOpen !== null ||
    phoneScreen === "edit" ||
    phoneScreen === "publish" ||
    // 封面构图 over 编辑: Back closes it first.
    (phoneScreen !== null && mediaDialog?.type === "cover") ||
    // Removals waiting for 撤销 on the start screen: Back commits them first.
    (phoneScreen === "select" && phoneUi.heldRemoval !== null) ||
    // 专题 creating its draft (r4 D3): nothing leaves until it answers.
    topicCreating ||
    guardState.phonePanel;

  const guard = useCallback((reason: ProductShellEditorLeaveReason) => {
    if (leavingRef.current) return "allow" as const;
    const now = latestGuard.current;
    // 专题 creating its draft: the editor stays (a reload asks first), so
    // the result always lands somewhere (r4 D3).
    if (now.topicCreating) return "blocked" as const;
    if (reason === "unload")
      return now.submissionBusy ||
        now.unsavedText ||
        now.noSaveContent ||
        now.unfinishedWork
        ? ("blocked" as const)
        : ("allow" as const);
    if (reason === "history") {
      // The browser's Back from 预览 returns to the editor, like its own Back.
      if (now.previewOpen) {
        setPreviewOpen(null);
        return "blocked" as const;
      }
      // On a phone a layer closes first, as 预览 does: 历史版本 or the
      // version chooser, then a sheet or 封面构图 (which asks first when
      // its composition changed) ...
      if (now.phonePanel) {
        setVersionsPanel(null);
        return "blocked" as const;
      }
      if (now.phoneLayerBack()) return "blocked" as const;
      // ... then it steps back a screen in the one editor entry: 发布 →
      // 编辑 (or the start screen) → 编辑's back sheet for a work started
      // here; on the start screen, or on 编辑 of a draft or a work, it
      // commits what the screen holds and leaves as below. Never while a
      // submission is in flight: 发布 stays, and 正在确认结果… says why (编辑
      // could change the work being submitted).
      if (!now.submissionBusy && now.phoneBack()) return "blocked" as const;
    }
    // What a Back just committed reaches the runtime now, so leaving is
    // decided on the album as it is (a removal waiting for 撤销 included).
    const sent = now.sendEdits();
    const upload = uploadRef.current;
    const unsavedText =
      now.unsavedText || (sent && now.savedMode && upload.hasUnsavedChanges());
    const unfinishedWork = sent
      ? upload.session !== null && upload.hasUnfinishedWork()
      : now.unfinishedWork;
    const variant: LeaveDialogVariant | null = now.submissionBusy
      ? "submitting"
      : now.noSaveContent
        ? "unsaved"
        : unsavedText || unfinishedWork
          ? "saved"
          : null;
    // Unsaved text and unfinished media both require an explicit leave choice.
    if (variant === null) {
      // The picks are the draft now; the author finds them in 草稿箱.
      if (now.leavingFromEdit) notifyRef.current(LEFT_FROM_EDIT_NOTICE);
      return "allow" as const;
    }
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
      // Leaving a new work on 编辑 another way than its back sheet: once
      // saved, the picks are the draft, and the author is told where to
      // find them, as when nothing was left to save.
      if (latestGuard.current.newWorkOnEdit)
        notifyRef.current(LEFT_FROM_EDIT_NOTICE);
      leaveNow();
      return;
    }
    setLeave(
      (current) => current && { ...current, saving: false, failed: true },
    );
  };

  /** A refusal of 存草稿并退出: among 编辑's notices, and what 编辑 says. */
  const refuseEditSave = (reason: string) => {
    store.setNotice(reason);
    return reason;
  };

  /**
   * 编辑's 存草稿并退出 (r4 ASK-1): one tap saves the draft and leaves, as
   * the leave dialog's 保存草稿并离开 does, and says where the photos are.
   * Production saves only on an explicit action (r6), so this is that
   * action and no second question follows. While the picks are still on
   * their way to the account (the usual state right after a pick), it
   * waits for them: the back sheet shows 等待上传完成… with the progress,
   * and the save follows as soon as the runtime would take it. 继续编辑,
   * Escape or the browser's Back end the wait and stay on 编辑 (nothing is
   * saved, the uploads go on), and so do the session ending and the
   * editor going. A save the runtime refuses (a photo that needs the
   * author, before or during the wait, two versions waiting, an error)
   * leaves nothing: 编辑 stays, the reason among its notices, and the
   * reason is what this resolves with, so 编辑 says it through the flow's
   * announcer (an inserted notice is often not read out). Null when it
   * left, when the wait ended, or when, without drafts, the leave guard's
   * own 结束本次编辑？ decides.
   */
  const saveFromEdit = async (): Promise<string | null> => {
    if (leavingRef.current || uploadWait.current !== null) return null;
    if (!latestGuard.current.savedMode) {
      controls.close();
      return null;
    }
    // What 编辑 just kept (its crop, a removal) is what is saved.
    sendEdits();
    const hold = uploadRef.current.mediaSaveHold();
    if (hold !== null && hold.blocked.length === 0)
      return new Promise<string | null>((resolve) => {
        uploadWait.current = resolve;
        setWaitingUploads(true);
      });
    return saveEditAndLeave();
  };

  /** 存草稿并退出's save itself, once nothing holds the media back. */
  const saveEditAndLeave = async (): Promise<string | null> => {
    if (leavingRef.current) return null;
    try {
      await uploadRef.current.saveNow();
    } catch (error) {
      return refuseEditSave(
        error instanceof Error ? error.message : "保存失败，请重试",
      );
    }
    if (uploadRef.current.hasUnsavedChanges())
      return refuseEditSave(editSaveErrorText(uploadRef.current.autosave));
    if (latestGuard.current.newWorkOnEdit)
      notifyRef.current(LEFT_FROM_EDIT_NOTICE);
    leaveNow();
    return null;
  };

  // 存草稿并退出's wait (above): after each render (the uploads, the
  // staging, the back sheet), it ends without saving once its sheet or 编辑
  // went or the session ended; it stops, saying why, once a photo needs the
  // author; it saves and leaves once nothing holds the media back.
  const backAsk = phoneUi.backAsk;
  const sessionGone = session === null;
  useEffect(() => {
    const settle = uploadWait.current;
    if (!waitingUploads || settle === null) return;
    const end = (reason: string | null) => {
      uploadWait.current = null;
      setWaitingUploads(false);
      settle(reason);
    };
    if (!backAsk || phoneScreen !== "edit" || sessionGone) {
      end(null);
      return;
    }
    const hold = uploadRef.current.mediaSaveHold();
    if (hold === null) {
      uploadWait.current = null;
      setWaitingUploads(false);
      void saveEditAndLeave().then(settle, () => settle(null));
      return;
    }
    if (hold.blocked.length > 0)
      end(refuseEditSave(waitStoppedText(store.media().items, hold.blocked)));
  });
  // The editor going (closed, another account) ends the wait: nothing is
  // saved after it.
  useEffect(
    () => () => {
      const settle = uploadWait.current;
      uploadWait.current = null;
      settle?.(null);
    },
    [],
  );
  const waitHold = waitingUploads ? upload.mediaSaveHold() : null;
  const saveWait =
    waitHold === null || waitHold.blocked.length > 0
      ? null
      : {
          received: waitHold.received,
          total: waitHold.total,
          reading: waitHold.reading,
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
    if (layout === "phone") showPhoneField(store, mediaUi, field);
    nextFrame(() => {
      const target = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (target === null) return;
      const element = hostRef.current?.querySelector<HTMLElement>(
        target !== "media"
          ? `[data-editor-input="${target}"]`
          : layout === "phone"
            ? PHONE_MEDIA_TARGET
            : "[data-editor-media]",
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
    if (layout === "phone") showPhoneField(store, mediaUi, entry.field);
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
  }, [hostRef, layout, mediaUi, store]);

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

  // 保存草稿 and 历史版本 live on the phone's 发布 screen only: the menu
  // closes with it.
  if (menuOpen && phoneScreen !== null && phoneScreen !== "publish")
    setMenuOpen(false);

  const saveNowButton =
    saveMode === "saved" ? (
      <button
        className={styles.textButton}
        data-editor-save-now=""
        disabled={!canSaveNow}
        onClick={() => void saveNow()}
        type="button"
      >
        保存草稿
      </button>
    ) : null;

  const versionsMenu =
    saveMode === "saved" && draftId !== null ? (
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
    ) : null;

  const barActions = (
    <>
      {saveNowButton}
      {versionsMenu}
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

  const switches = (
    <ModeSwitches>
      <OriginalQualitySwitch
        onChange={store.setOriginalNext}
        original={state.originalNext}
      />
    </ModeSwitches>
  );

  const saveStatus = (
    <SaveStatus
      autosave={autosave}
      onChooseVersion={() => setVersionsPanel("conflict")}
      onRetry={() => void saveNow()}
      saveMode={saveMode}
    />
  );
  const saveKind = saveStatusOf(saveMode, autosave);

  const sessionEnded =
    session === null &&
    !leavingRef.current &&
    !state.restarting &&
    submissionState.status !== "confirmed";
  // Null when there is nothing to say, so a phone screen draws no notes.
  const notices =
    state.notice === null &&
    state.fieldErrors.media === undefined &&
    !sessionEnded ? null : (
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
        {sessionEnded ? (
          <p className={styles.notice} data-tone="error" role="alert">
            本次编辑已结束，返回后可重新开始
          </p>
        ) : null}
      </>
    );

  const mediaSection = (
    <div data-editor-media="" tabIndex={-1}>
      <MediaSection layout="desktop" sessionKey={store.key} />
    </div>
  );

  const progressLine =
    readiness.blocking > 0 && readiness.text !== null ? (
      <p className={styles.notice} data-editor-upload-progress="">
        图片：{readiness.text}
      </p>
    ) : null;

  const confirmationProps: ConfirmationSheetProps = {
    cover,
    issues,
    onCheckAgain: () => void submission.checkAgain(),
    onGoToField: goToField,
    onRetry: () => void submission.retry(),
    onSubmit: () => void submit(),
    readiness,
    resolving: submitting,
    state,
    submission: submissionState,
    unconfirmedFiles:
      stagingActive && staging !== null ? staging.count.ready : 0,
  };
  const confirmation = <ConfirmationSheet {...confirmationProps} />;

  const previewShown = previewOpen !== null && layout === "phone";
  const leaveHasDraft = draftId !== null;

  // 专题 and 草稿箱 on the start screen (r4 §3.1): an untouched new work
  // (photos held for 撤销 aside) with 专题文章 on; never 参与话题, a draft
  // or a work, and gone once text or photos exist.
  const heldKeys = phoneUi.heldRemoval?.keys ?? [];
  const startOffered =
    layout === "phone" &&
    articlesOn &&
    state.target.type === "new" &&
    !state.target.threadId &&
    state.kind === "new" &&
    isEmptyWork({
      ...state,
      items: state.items.filter((item) => !heldKeys.includes(item.key)),
    });
  const start: StartOptions | null = startOffered
    ? {
        topic: {
          busy: topicCreating,
          disabled: author.checking || author.sessionError,
          retry: topicCreation.retrying,
          notice: topicCreation.notice,
          onCreate: () => {
            void topicCreation.create().then((id) => {
              if (id === null) return;
              // The article editor takes this editor's entry; the empty
              // work session ends as the overlay goes (`closeOnLeave`).
              openArticleDraftInPlace(controls, id);
              // The shell's focus follows a new editor session only.
              nextFrame(() => {
                const active = document.activeElement;
                if (active === null || active === document.body)
                  controls.backButtonRef.current?.focus();
              });
            });
          },
        },
        // The article editor's own way to its 草稿箱 (ASK-2).
        onOpenDrafts: () => openArticleDraftBox(controls),
      }
    : null;

  return (
    <>
      {/* The phone screens draw their own bars (each Back goes a screen back). */}
      {layout === "desktop" ? (
        <ReturnBar
          actions={barActions}
          controls={controls}
          status={saveStatus}
          title={title}
        />
      ) : null}
      {/*
       * The media section, the phone flow and the confirmation (its readiness
       * line on 发布) announce their own changes.
       */}
      <p aria-live="polite" className={styles.visuallyHidden} role="status">
        {announcement}
      </p>
      <div className={styles.body} data-editor-body="" inert={previewShown}>
        {layout === "phone" ? (
          <PhoneFlow
            backButtonRef={controls.backButtonRef}
            checkResume={!resumeChecked}
            confirmation={confirmationProps}
            editCommitRef={editCommitRef}
            menu={versionsMenu}
            notices={notices}
            onClose={controls.close}
            onOpenPreview={(opener) => setPreviewOpen({ opener })}
            onResumeChecked={() => setResumeChecked(true)}
            onSaveAndLeave={saveFromEdit}
            saveWait={saveWait}
            publish={{
              label: primaryLabel,
              busy: submissionBusy,
              onSubmit: () => void submit(),
            }}
            saveAction={saveNowButton}
            saveAlert={saveKind === "error" || saveKind === "conflict"}
            saveStatus={saveStatus}
            sessionKey={store.key}
            start={start}
            // 标题 is never the opening's focus here: its keyboard would
            // hide 发布's bar and preview (the flow focuses 标题 only for
            // 跳过，只发布文字).
            textProps={{ state, store }}
            title={title}
          />
        ) : (
          <DesktopEditor
            media={mediaSection}
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
            switches={switches}
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
