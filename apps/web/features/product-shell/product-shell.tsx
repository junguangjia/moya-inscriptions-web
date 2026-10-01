"use client";

import { useAuthReturn, useAuthReturnView } from "../auth/auth-return";

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button, LoadingScreen } from "@moya/ui";

import styles from "./product-shell.module.css";
import { requestIdentity } from "../shell/request-identity";

import { PRODUCT_LOADING_MINIMUM_MS } from "./product-boot";
import {
  detailHistoryState,
  detailLocation,
  directContentFromLocation,
  directAuthorFromLocation,
  directEditorTargetFromLocation,
  editorHistoryState,
  editorLocation,
  parseProductEditorTarget,
  sameEditorLink,
  sameEditorTarget,
  profileHistoryState,
  profileLocation,
  directMediaIdFromLocation,
  mergeProductHistoryState,
  parseProductHistoryState,
  primaryHistoryState,
  primaryLocation,
  settingsHistoryState,
  settingsLocation,
  topicHistoryState,
  topicLocation,
  viewerHistoryState,
  viewerLocation,
} from "./product-history";
import {
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  applyFeedLayoutPreferenceToRoot,
  applyThemePreferenceToRoot,
  nextFeedLayoutPreference,
  nextThemePreference,
  persistPreference,
  readStoredFeedLayoutPreference,
  readStoredThemePreference,
} from "./preferences";
import { SettingsOverlay } from "../settings/settings-overlay";
import {
  readRuntimeDeviceClass,
  resolvePresentationOrientation,
  resolveRuntimePresentationPlatform,
} from "../shell/device-platform";
import { PrimaryNavigationPager } from "../shell/primary-navigation-pager";
import {
  createPrimaryNavigationScrollState,
  PRIMARY_NAVIGATION_IDLE_EXPAND_MS,
  resolvePrimaryNavigationScrollState,
  resolvePrimaryNavigationViewportInset,
  synchronizePrimaryNavigationViewportInset,
} from "../shell/primary-navigation-motion";

import type { ReactNode, RefObject } from "react";
import type { ContentIdentity } from "@moya/contracts";
import type {
  EditorProductHistoryState,
  ProductEditorTarget,
  ProfileProductHistoryState,
  ProfileTab,
  ProductHistoryState,
} from "./product-history";
import type { FeedLayoutPreference, ThemePreference } from "./preferences";
import type {
  PresentationOrientation,
  PresentationPlatform,
  RuntimeNavigatorLike,
} from "../shell/device-platform";
import type { PrimaryDestination } from "../shell/primary-shell";

type ScrollPositions = Record<PrimaryDestination, number>;

const SCROLL_RESTORE_RETRY_FRAMES = 12;
const DETAIL_HISTORY_SYNC_DELAY_MS = 500;
/**
 * How long an approved editor close excuses the popstate its Back causes. A
 * Back with no earlier entry dispatches none, and the approval must not then
 * excuse an unrelated later one; a popstate slower than this asks again.
 */
const EDITOR_LEAVE_APPROVAL_MS = 1_000;

const historyDocumentId = requestIdentity();
const historyOffsets = new Map<string, number>();
const resetHistoryScroll = (state: ProductHistoryState): ProductHistoryState =>
  state.kind === "primary"
    ? { ...state, scrollTop: 0 }
    : state.kind === "detail" || state.kind === "viewer"
      ? { ...state, detailScrollTop: 0, sourceScrollTop: 0 }
      : state.kind === "profile"
        ? { ...state, profileScrollTop: 0, sourceScrollTop: 0 }
        : state.kind === "topic" || state.kind === "editor"
          ? { ...state, sourceScrollTop: 0 }
          : state;
const entryIdentity = (state: ProductHistoryState | null) =>
  state === null
    ? ""
    : state.kind === "profile"
      ? state.entryId
      : state.kind === "detail" || state.kind === "viewer"
        ? `${state.kind}:${state.target.type}:${state.target.id}`
        : state.kind === "primary"
          ? state.destination
          : state.kind === "topic"
            ? state.topicId
            : state.kind === "editor"
              ? `editor:${state.editorTarget.type}:${"id" in state.editorTarget ? state.editorTarget.id : ""}`
              : state.kind;
const currentProductHistoryState = (state: ProductHistoryState) => {
  const articleEntry = (value: ProductHistoryState | null) =>
    value?.kind === "editor" &&
    (value.editorTarget.type === "article-list" ||
      value.editorTarget.type === "article-draft");
  const merged: ProductHistoryState & Record<string, unknown> = {
    ...mergeProductHistoryState(window.history.state, state),
    __artvennDocument: historyDocumentId,
    __artvennEntry:
      entryIdentity(parseProductHistoryState(window.history.state)) ===
        entryIdentity(state) &&
      typeof window.history.state?.__artvennEntry === "string"
        ? window.history.state.__artvennEntry
        : requestIdentity(),
  };
  // Next's native History wrapper copies its router state. Supplying its
  // internal markers ourselves bypasses canonical URL synchronization.
  if (
    articleEntry(state) ||
    articleEntry(parseProductHistoryState(window.history.state))
  ) {
    delete merged.__NA;
    delete merged._N;
  }
  return merged;
};
const rememberHistoryOffset = (top: number) => {
  const id = window.history.state?.__artvennEntry;
  if (typeof id !== "string") return;
  historyOffsets.set(id, top);
  if (historyOffsets.size > 200)
    historyOffsets.delete(historyOffsets.keys().next().value!);
};
const restoredHistoryState = (raw: unknown) => {
  const state = parseProductHistoryState(raw);
  if (!state) return null;
  const fields = raw as Record<string, unknown>;
  if (fields.__artvennDocument !== historyDocumentId)
    return resetHistoryScroll(state);
  const top =
    typeof fields.__artvennEntry === "string"
      ? historyOffsets.get(fields.__artvennEntry)
      : undefined;
  return top === undefined
    ? state
    : state.kind === "profile"
      ? { ...state, profileScrollTop: top }
      : state.kind === "detail" || state.kind === "viewer"
        ? { ...state, detailScrollTop: top }
        : state;
};

export interface ProductShellContextValue {
  readonly activeCatalogId: string | null;
  readonly activeContent: ContentIdentity | null;
  readonly activeProfile: ProfileProductHistoryState | null;
  readonly activeEditor: ProductEditorTarget | null;
  readonly openContent: (target: ContentIdentity, opener: HTMLElement) => void;
  readonly openProfile: (authorId: string | null, opener: HTMLElement) => void;
  /** False when the editor is disabled or another layer refuses it. */
  readonly openEditor: (
    target: ProductEditorTarget,
    opener: HTMLElement,
  ) => boolean;
  readonly activeDestination: PrimaryDestination;
  readonly navigatePrimary: (destination: PrimaryDestination) => void;
  readonly registerActiveDiscussionScrollElement: (
    element: HTMLElement,
  ) => () => void;
  readonly activeTopicId: string | null;
  readonly activeViewerMediaId: string | null;
  readonly closeTopic: () => void;
  readonly closeViewer: () => void;
  /** Recover only unavailable content from the current authentication return. */
  readonly recoverUnavailableAuthContent: (target?: ContentIdentity) => boolean;
  readonly changeViewerMedia: (mediaId: string) => void;
  readonly feedLayout: FeedLayoutPreference;
  readonly setThemePreference: (value: ThemePreference) => void;
  readonly setFeedLayoutPreference: (value: FeedLayoutPreference) => void;
  readonly cycleTheme: () => void;
  readonly cycleFeedLayout: () => void;
  readonly openCatalog: (catalogId: string, opener: HTMLElement) => void;
  readonly openViewer: (mediaId: string) => void;
  readonly openTopic: (
    topicId: string,
    opener: HTMLElement,
    sourceScrollTop: number,
  ) => void;
  readonly orientation: PresentationOrientation;
  readonly platform: PresentationPlatform;
  readonly readActiveScrollTop: () => number;
  readonly registerActiveHomeScrollElement: (
    element: HTMLElement,
  ) => () => void;
  readonly registerTopicOpener: (
    topicId: string,
    opener: HTMLButtonElement,
  ) => void;
  readonly requestSettings: (opener?: HTMLElement) => void;
  readonly restoreActiveScrollTop: (top: number) => void;
  readonly settingsOpen: boolean;
  readonly theme: ThemePreference;
}

const ProductShellContext = createContext<ProductShellContextValue | null>(
  null,
);

export const useProductShell = (): ProductShellContextValue => {
  const value = useContext(ProductShellContext);
  if (value === null) {
    throw new Error("useProductShell must be used inside ProductShell");
  }
  return value;
};

export interface ProductShellProps {
  readonly user: ReactNode;
  readonly developmentPlatformOverride?: PresentationPlatform | null;
  readonly home: ReactNode;
  readonly initialPlatform: PresentationPlatform;
  readonly discussion: ReactNode;
  readonly primaryUtility?: ReactNode;
  readonly navigationAction?: ReactNode;
  readonly renderProfileOverlay?: (
    properties: ProductShellProfileOverlayRenderProps,
  ) => ReactNode;
  /** Enables the history-owned `#editor` overlay; absent keeps it closed. */
  readonly articleEditorEnabled?: boolean;
  readonly renderEditorOverlay?: (
    target: ProductEditorTarget,
    controls: ProductShellEditorOverlayControls,
  ) => ReactNode;
  readonly renderDetailOverlay?: (
    properties: ProductShellDetailOverlayRenderProps,
  ) => ReactNode;
  readonly renderTopicOverlay?: (
    properties: ProductShellTopicOverlayRenderProps,
  ) => ReactNode;
  readonly showDevelopmentPagerControls?: boolean;
}

export interface ProductShellDetailOverlayRenderProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly target: ContentIdentity;
  readonly initialScrollTop: number;
  readonly navigationRevision: number;
  readonly onClose: () => void;
  readonly onScrollTopChange: (top: number) => void;
}

export interface ProductShellProfileOverlayRenderProps {
  readonly state: ProfileProductHistoryState;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onViewChange: (tab: ProfileTab, scrollTop: number) => void;
}

/** Why the shell asks an editor before it leaves. */
export type ProductShellEditorLeaveReason = "close" | "history" | "unload";
/**
 * Returns "blocked" to keep the editor open: for "close" and "history" the
 * editor then offers its own choice; for "unload" the browser asks. Register a
 * guard only while there is something to protect, so the page carries no
 * `beforeunload` listener otherwise.
 */
export type ProductShellEditorLeaveGuard = (
  reason: ProductShellEditorLeaveReason,
) => "allow" | "blocked";

export interface ProductShellEditorOverlayControls {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  /** Leaves through history after consulting the registered guard. */
  readonly close: () => void;
  /**
   * Leaves for the work just submitted (E07) without consulting the guard:
   * the editor entry becomes that Detail, whose Back returns to the editor's
   * origin; if the editor sits on that same Detail, history returns there.
   */
  readonly completeWith: (target: ContentIdentity) => void;
  /** Latest registration wins; the returned function unregisters it. */
  readonly registerLeaveGuard: (
    guard: ProductShellEditorLeaveGuard,
  ) => () => void;
  /** Replaces the current editor entry, e.g. once a new work gains a draft. */
  readonly replaceTarget: (target: ProductEditorTarget) => void;
  /** Retires only the legacy Article list alias into the existing own profile. */
  readonly openDraftBox?: () => void;
}

export interface ProductShellTopicOverlayRenderProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly topicId: string;
}

type NavigatorWithUserAgentData = Navigator & RuntimeNavigatorLike;

const runtimePlatform = () =>
  resolveRuntimePresentationPlatform(
    navigator as NavigatorWithUserAgentData,
    window.innerWidth,
  );

const runtimeOrientation = () =>
  resolvePresentationOrientation(window.innerWidth, window.innerHeight);

const documentScrollElement = () =>
  document.scrollingElement ?? document.documentElement;

const clampScrollTop = (element: Element, desired: number) => {
  const scrollingElement = element as HTMLElement;
  const maximum = Math.max(
    0,
    scrollingElement.scrollHeight - scrollingElement.clientHeight,
  );
  return Math.min(Math.max(0, desired), maximum);
};

export const ProductShell = ({
  user,
  developmentPlatformOverride = null,
  home,
  initialPlatform,
  discussion,
  primaryUtility,
  navigationAction,
  renderDetailOverlay,
  renderEditorOverlay,
  articleEditorEnabled = false,
  renderProfileOverlay,
  renderTopicOverlay,
  showDevelopmentPagerControls = false,
}: ProductShellProps) => {
  const authReturn = useAuthReturn();
  const [authReturnNotice, setAuthReturnNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const topicBackRef = useRef<HTMLButtonElement>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const detailOpenerIdRef = useRef<string | null>(null);
  const detailHistoryTimerRef = useRef<number | null>(null);
  const detailScrollTopRef = useRef(0);
  const detailSourceDestinationRef = useRef<PrimaryDestination>("home");
  const detailSourceScrollTopRef = useRef(0);
  const topicOpenerRef = useRef<HTMLElement | null>(null);
  const topicOpenerIdRef = useRef<string | null>(null);
  const topicSourceScrollTopRef = useRef(0);
  const settingsOpenerRef = useRef<HTMLElement | null>(null);
  const settingsFocusFrameRef = useRef<number | null>(null);
  const settingsFocusCleanupRef = useRef<(() => void) | null>(null);
  const activeHomeScrollElementRef = useRef<HTMLElement | null>(null);
  const activeDiscussionScrollElementRef = useRef<HTMLElement | null>(null);
  const [activeDiscussionScrollElement, setActiveDiscussionScrollElement] =
    useState<HTMLElement | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreInputCleanupRef = useRef<(() => void) | null>(null);
  const topicFocusFrameRef = useRef<number | null>(null);
  const navigationIdleTimerRef = useRef<number | null>(null);
  const navigationMinimizedRef = useRef(false);
  const navigationScrollStateRef = useRef(
    createPrimaryNavigationScrollState(0),
  );
  const scrollRestorePendingRef = useRef(false);
  const activeDestinationRef = useRef<PrimaryDestination>("home");
  const platformRef = useRef<PresentationPlatform>(initialPlatform);
  const settingsOpenRef = useRef(false);
  const contentRef = useRef<ContentIdentity | null>(null);
  const profileRef = useRef<ProfileProductHistoryState | null>(null);
  const profileBackRef = useRef<HTMLButtonElement>(null);
  const profileOpenerRef = useRef<HTMLElement | null>(null);
  const [activeProfile, setActiveProfile] =
    useState<ProfileProductHistoryState | null>(null);
  const profileEnabled = renderProfileOverlay !== undefined;
  const editorRef = useRef<EditorProductHistoryState | null>(null);
  const editorBackRef = useRef<HTMLButtonElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const editorLeaveGuardRef = useRef<{
    readonly guard: ProductShellEditorLeaveGuard;
    readonly dispose: () => void;
  } | null>(null);
  const editorLeaveApprovedRef = useRef(false);
  const editorLeaveApprovalTimerRef = useRef<number | null>(null);
  // The entry beneath an editor this document opened; null when unknown.
  const editorBelowRef = useRef<ProductHistoryState | null>(null);
  const [activeEditor, setActiveEditor] =
    useState<EditorProductHistoryState | null>(null);
  // Remounts the host for a different editor, never for replaceTarget.
  const [editorSession, setEditorSession] = useState(0);
  const editorOpen = activeEditor !== null;
  const editorEnabled = renderEditorOverlay !== undefined;
  const allowedEditorTarget = useCallback(
    (target: ProductEditorTarget | null) =>
      target !== null &&
      (!target.type.startsWith("article-") || articleEditorEnabled)
        ? target
        : null,
    [articleEditorEnabled],
  );
  const viewerMediaIdRef = useRef<string | null>(null);
  const topicIdRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef<ScrollPositions>({
    user: 0,
    home: 0,
    discussion: 0,
  });
  const [activeDestination, setActiveDestination] =
    useState<PrimaryDestination>("home");
  const [platform, setPlatform] =
    useState<PresentationPlatform>(initialPlatform);
  const [orientation, setOrientation] =
    useState<PresentationOrientation>("portrait");
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [feedLayout, setFeedLayout] = useState<FeedLayoutPreference>("double");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeContent, setActiveContent] = useState<ContentIdentity | null>(
    null,
  );
  const [detailNavigationRevision, setDetailNavigationRevision] = useState(0);
  const [activeViewerMediaId, setActiveViewerMediaId] = useState<string | null>(
    null,
  );
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [navigationMinimized, setNavigationMinimized] = useState(false);
  const [activeHomeScrollElement, setActiveHomeScrollElement] =
    useState<HTMLElement | null>(null);
  const [bootPending, setBootPending] = useState(true);

  const setNavigationMinimizedState = useCallback((minimized: boolean) => {
    navigationMinimizedRef.current = minimized;
    setNavigationMinimized((current) =>
      current === minimized ? current : minimized,
    );
  }, []);

  const expandNavigation = useCallback(() => {
    if (navigationIdleTimerRef.current !== null) {
      window.clearTimeout(navigationIdleTimerRef.current);
      navigationIdleTimerRef.current = null;
    }
    navigationScrollStateRef.current = {
      ...navigationScrollStateRef.current,
      intent: 0,
      minimized: false,
    };
    setNavigationMinimizedState(false);
  }, [setNavigationMinimizedState]);

  const registerActiveHomeScrollElement = useCallback(
    (element: HTMLElement) => {
      activeHomeScrollElementRef.current = element;
      setActiveHomeScrollElement((current) =>
        current === element ? current : element,
      );
      return () => {
        if (activeHomeScrollElementRef.current !== element) return;
        activeHomeScrollElementRef.current = null;
        setActiveHomeScrollElement((current) =>
          current === element ? null : current,
        );
      };
    },
    [],
  );

  const registerActiveDiscussionScrollElement = useCallback(
    (element: HTMLElement) => {
      activeDiscussionScrollElementRef.current = element;
      setActiveDiscussionScrollElement(element);
      return () => {
        if (activeDiscussionScrollElementRef.current !== element) return;
        activeDiscussionScrollElementRef.current = null;
        setActiveDiscussionScrollElement(null);
      };
    },
    [],
  );

  const scrollElementFor = useCallback(
    (
      destination: PrimaryDestination,
      presentationPlatform: PresentationPlatform,
    ): Element | null => {
      if (presentationPlatform === "pc") return documentScrollElement();
      if (
        destination === "discussion" &&
        activeDiscussionScrollElementRef.current !== null
      )
        return activeDiscussionScrollElementRef.current;
      if (
        destination === "home" &&
        activeHomeScrollElementRef.current !== null
      ) {
        return activeHomeScrollElementRef.current;
      }
      return (
        rootRef.current?.querySelector(
          `[data-primary-destination="${destination}"]`,
        ) ?? null
      );
    },
    [],
  );

  const saveScroll = useCallback(
    (
      destination: PrimaryDestination,
      presentationPlatform: PresentationPlatform,
    ) => {
      const element = scrollElementFor(destination, presentationPlatform);
      if (element === null) return;
      scrollPositionsRef.current[destination] =
        presentationPlatform === "pc"
          ? documentScrollElement().scrollTop
          : (element as HTMLElement).scrollTop;
    },
    [scrollElementFor],
  );

  const cancelScrollRestore = useCallback(() => {
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    scrollRestorePendingRef.current = false;
    restoreInputCleanupRef.current?.();
    restoreInputCleanupRef.current = null;
  }, []);

  const restoreScroll = useCallback(
    (
      destination: PrimaryDestination,
      presentationPlatform: PresentationPlatform,
    ) => {
      cancelScrollRestore();
      const desired = scrollPositionsRef.current[destination];
      // During document-to-panel layout changes, Home registers its first
      // panel in the upcoming layout effect. Bind it when it becomes available.
      let targetElement =
        presentationPlatform !== "pc" &&
        ((destination === "home" &&
          activeHomeScrollElementRef.current === null) ||
          (destination === "discussion" &&
            activeDiscussionScrollElementRef.current === null))
          ? null
          : scrollElementFor(destination, presentationPlatform);
      let retryFrames = SCROLL_RESTORE_RETRY_FRAMES;
      const applyScroll = () => {
        restoreFrameRef.current = null;
        const element = scrollElementFor(destination, presentationPlatform);
        if (targetElement === null) targetElement = element;
        // A Home feed switch can replace the registered scroll owner without
        // issuing another restore. Never transfer this request to that panel.
        if (element === null || element !== targetElement) {
          cancelScrollRestore();
          return;
        }
        const top = clampScrollTop(element, desired);
        scrollRestorePendingRef.current = true;
        if (presentationPlatform === "pc") {
          window.scrollTo({ behavior: "auto", top });
        } else {
          (element as HTMLElement).scrollTop = top;
        }
        restoreFrameRef.current = window.requestAnimationFrame(() => {
          restoreFrameRef.current = null;
          const currentElement = scrollElementFor(
            destination,
            presentationPlatform,
          );
          if (currentElement === null || currentElement !== targetElement) {
            cancelScrollRestore();
            return;
          }
          const currentTop =
            presentationPlatform === "pc"
              ? documentScrollElement().scrollTop
              : (currentElement as HTMLElement).scrollTop;
          const clampedDesired = clampScrollTop(currentElement, desired);
          if (
            retryFrames > 0 &&
            (clampedDesired < desired || currentTop !== clampedDesired)
          ) {
            retryFrames -= 1;
            applyScroll();
            return;
          }
          cancelScrollRestore();
        });
      };
      // Scroll events alone cannot distinguish layout drift from user input.
      // Relinquish this bounded restore before the user's default scroll action.
      const cancelOnScrollInput = (event: Event) => {
        if (
          event instanceof KeyboardEvent &&
          (![
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key) ||
            (event.target instanceof HTMLElement &&
              event.target.closest(
                'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
              ) !== null))
        ) {
          return;
        }
        const element = scrollElementFor(destination, presentationPlatform);
        if (
          element === null ||
          !(event.target instanceof Node) ||
          !element.contains(event.target)
        ) {
          return;
        }
        cancelScrollRestore();
      };
      const inputEvents = [
        "wheel",
        "touchstart",
        "pointerdown",
        "keydown",
      ] as const;
      for (const type of inputEvents) {
        window.addEventListener(type, cancelOnScrollInput, {
          capture: true,
          passive: true,
        });
      }
      restoreInputCleanupRef.current = () => {
        for (const type of inputEvents) {
          window.removeEventListener(type, cancelOnScrollInput, true);
        }
      };
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = window.requestAnimationFrame(() => {
          applyScroll();
        });
      });
    },
    [cancelScrollRestore, scrollElementFor],
  );

  const readActiveScrollTop = useCallback(() => {
    const element = scrollElementFor(
      activeDestinationRef.current,
      platformRef.current,
    );
    if (element === null) return 0;
    return platformRef.current === "pc"
      ? documentScrollElement().scrollTop
      : (element as HTMLElement).scrollTop;
  }, [scrollElementFor]);

  const restoreActiveScrollTop = useCallback(
    (top: number) => {
      const destination = activeDestinationRef.current;
      scrollPositionsRef.current[destination] = Number.isFinite(top)
        ? Math.max(0, top)
        : 0;
      restoreScroll(destination, platformRef.current);
    },
    [restoreScroll],
  );

  const restoreTopicFocus = useCallback((topicId: string) => {
    if (topicFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(topicFocusFrameRef.current);
    }
    topicFocusFrameRef.current = window.requestAnimationFrame(() => {
      topicFocusFrameRef.current = window.requestAnimationFrame(() => {
        topicFocusFrameRef.current = null;
        const registered = topicOpenerRef.current;
        const opener =
          registered !== null && topicOpenerIdRef.current === topicId
            ? registered
            : Array.from(
                rootRef.current?.querySelectorAll<HTMLButtonElement>(
                  "[data-topic-id]",
                ) ?? [],
              ).find((button) => button.dataset.topicId === topicId);
        if (opener !== undefined && opener !== null) {
          topicOpenerRef.current = opener;
          topicOpenerIdRef.current = topicId;
          opener.focus({ preventScroll: true });
          return;
        }
        rootRef.current
          ?.querySelector<HTMLElement>("[data-home-surface]")
          ?.focus({ preventScroll: true });
      });
    });
  }, []);

  const restoreCatalogFocus = useCallback((catalogId: string) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const registered = detailOpenerRef.current;
        const registeredCatalogId =
          registered?.closest<HTMLElement>("[data-catalog-id]")?.dataset
            .catalogId;
        const opener =
          registered !== null &&
          detailOpenerIdRef.current === catalogId &&
          registered.isConnected &&
          (registeredCatalogId === catalogId ||
            registered.closest<HTMLElement>("[data-content-id]")?.dataset
              .contentId === catalogId)
            ? registered
            : Array.from(
                rootRef.current?.querySelectorAll<HTMLButtonElement>(
                  '[data-open-catalog], [data-content-id] button[aria-label^="打开"]',
                ) ?? [],
              ).find(
                (button) =>
                  (button.closest<HTMLElement>("[data-catalog-id]")?.dataset
                    .catalogId ??
                    button.closest<HTMLElement>("[data-content-id]")?.dataset
                      .contentId) === catalogId,
              );
        if (opener !== undefined && opener !== null) {
          detailOpenerRef.current = opener;
          detailOpenerIdRef.current = catalogId;
          opener.focus({ preventScroll: true });
        }
      });
    });
  }, []);

  const cancelSettingsFocus = useCallback(() => {
    if (settingsFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsFocusFrameRef.current);
      settingsFocusFrameRef.current = null;
    }
    settingsFocusCleanupRef.current?.();
    settingsFocusCleanupRef.current = null;
  }, []);

  const restoreSettingsFocus = useCallback(() => {
    cancelSettingsFocus();
    const opener = settingsOpenerRef.current;
    const destination = activeDestinationRef.current;
    // QA can fulfill this return on its own resume frame. Once the exact
    // opener receives focus, this shell must not reclaim subsequent focus.
    const onFocus = (event: FocusEvent) => {
      if (event.target === opener) cancelSettingsFocus();
    };
    const onInput = (event: Event) => {
      if (
        !settingsOpenRef.current &&
        contentRef.current === null &&
        profileRef.current === null &&
        editorRef.current === null &&
        topicIdRef.current === null &&
        event.target instanceof Node &&
        (rootRef.current?.contains(event.target) ||
          event.target === document.body ||
          event.target === document.documentElement)
      ) {
        cancelSettingsFocus();
      }
    };
    window.addEventListener("focusin", onFocus, true);
    window.addEventListener("keydown", onInput, true);
    window.addEventListener("pointerdown", onInput, true);
    settingsFocusCleanupRef.current = () => {
      window.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("keydown", onInput, true);
      window.removeEventListener("pointerdown", onInput, true);
    };
    settingsFocusFrameRef.current = window.requestAnimationFrame(() => {
      settingsFocusFrameRef.current = window.requestAnimationFrame(() => {
        settingsFocusFrameRef.current = null;
        cancelSettingsFocus();
        if (
          activeDestinationRef.current !== destination ||
          settingsOpenRef.current ||
          contentRef.current !== null ||
          profileRef.current !== null ||
          editorRef.current !== null ||
          topicIdRef.current !== null ||
          !opener?.isConnected ||
          opener.closest('[inert], [hidden], [aria-hidden="true"]') !== null
        ) {
          return;
        }
        opener.focus({ preventScroll: true });
      });
    });
  }, [cancelSettingsFocus]);

  const commitDestination = useCallback(
    (destination: PrimaryDestination) => {
      const current = activeDestinationRef.current;
      if (
        destination === current ||
        settingsOpenRef.current ||
        contentRef.current !== null ||
        profileRef.current !== null ||
        editorRef.current !== null ||
        topicIdRef.current !== null
      ) {
        return;
      }

      expandNavigation();
      cancelSettingsFocus();
      saveScroll(current, platformRef.current);
      activeDestinationRef.current = destination;
      setActiveDestination(destination);
      window.history.replaceState(
        currentProductHistoryState(primaryHistoryState(destination)),
        "",
        primaryLocation(window.location),
      );
      restoreScroll(destination, platformRef.current);
    },
    [cancelSettingsFocus, expandNavigation, restoreScroll, saveScroll],
  );

  const setSettingsVisibility = useCallback((open: boolean) => {
    settingsOpenRef.current = open;
    setSettingsOpen(open);
  }, []);

  const setDetailVisibility = useCallback((target: ContentIdentity | null) => {
    contentRef.current = target;
    setActiveContent(target);
  }, []);

  const setViewerVisibility = useCallback((mediaId: string | null) => {
    viewerMediaIdRef.current = mediaId;
    setActiveViewerMediaId(mediaId);
  }, []);

  const setTopicVisibility = useCallback((topicId: string | null) => {
    topicIdRef.current = topicId;
    setActiveTopicId(topicId);
  }, []);

  const registerTopicOpener = useCallback(
    (topicId: string, opener: HTMLButtonElement) => {
      if (topicIdRef.current === topicId) {
        topicOpenerRef.current = opener;
        topicOpenerIdRef.current = topicId;
      }
    },
    [],
  );

  const openSettings = useCallback(
    (opener: HTMLElement) => {
      if (
        settingsOpenRef.current ||
        contentRef.current !== null ||
        profileRef.current !== null ||
        editorRef.current !== null ||
        topicIdRef.current !== null
      ) {
        return;
      }
      const sourceDestination = activeDestinationRef.current;
      saveScroll(sourceDestination, platformRef.current);
      settingsOpenerRef.current = opener;
      window.history.pushState(
        currentProductHistoryState(settingsHistoryState(sourceDestination)),
        "",
        settingsLocation(window.location),
      );
      setSettingsVisibility(true);
    },
    [saveScroll, setSettingsVisibility],
  );

  const closeSettings = useCallback(() => {
    const state = parseProductHistoryState(window.history.state);
    if (state?.kind === "settings") {
      window.history.back();
      return;
    }

    setSettingsVisibility(false);
    window.history.replaceState(
      currentProductHistoryState(
        primaryHistoryState(activeDestinationRef.current),
      ),
      "",
      primaryLocation(window.location),
    );
    restoreScroll(activeDestinationRef.current, platformRef.current);
  }, [restoreScroll, setSettingsVisibility]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSettings();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeSettings, settingsOpen]);

  const requestSettings = useCallback(
    (requestedOpener?: HTMLElement) => {
      const opener =
        requestedOpener ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : rootRef.current);
      if (opener !== null) openSettings(opener);
    },
    [openSettings],
  );

  const openTopic = useCallback(
    (topicId: string, opener: HTMLElement, sourceScrollTop: number) => {
      if (
        topicId.length === 0 ||
        activeDestinationRef.current !== "discussion" ||
        settingsOpenRef.current ||
        contentRef.current !== null ||
        profileRef.current !== null ||
        editorRef.current !== null ||
        topicIdRef.current !== null
      ) {
        return;
      }
      saveScroll("discussion", platformRef.current);
      const boundedScrollTop = Number.isFinite(sourceScrollTop)
        ? Math.max(0, sourceScrollTop)
        : readActiveScrollTop();
      topicSourceScrollTopRef.current = boundedScrollTop;
      scrollPositionsRef.current.discussion = boundedScrollTop;
      topicOpenerRef.current = opener;
      topicOpenerIdRef.current = topicId;
      window.history.replaceState(
        currentProductHistoryState(
          primaryHistoryState("discussion", boundedScrollTop, topicId),
        ),
        "",
        primaryLocation(window.location),
      );
      window.history.pushState(
        currentProductHistoryState(
          topicHistoryState(topicId, boundedScrollTop),
        ),
        "",
        topicLocation(window.location, topicId),
      );
      setTopicVisibility(topicId);
    },
    [readActiveScrollTop, saveScroll, setTopicVisibility],
  );

  const closeTopic = useCallback(() => {
    const state = parseProductHistoryState(window.history.state);
    if (state?.kind === "topic") {
      window.history.back();
      return;
    }
    setTopicVisibility(null);
    window.history.replaceState(
      currentProductHistoryState(primaryHistoryState("discussion")),
      "",
      primaryLocation(window.location),
    );
    restoreScroll("discussion", platformRef.current);
  }, [restoreScroll, setTopicVisibility]);

  const updateDetailScrollTop = useCallback((top: number) => {
    detailScrollTopRef.current = Number.isFinite(top) ? Math.max(0, top) : 0;
    rememberHistoryOffset(detailScrollTopRef.current);
    if (detailHistoryTimerRef.current !== null) {
      window.clearTimeout(detailHistoryTimerRef.current);
    }
    detailHistoryTimerRef.current = window.setTimeout(() => {
      detailHistoryTimerRef.current = null;
      const state = parseProductHistoryState(window.history.state);
      if (state?.kind === "detail") {
        if (state.detailScrollTop === detailScrollTopRef.current) return;
        window.history.replaceState(
          currentProductHistoryState(
            detailHistoryState(
              state.target,
              state.sourceDestination,
              state.sourceScrollTop,
              detailScrollTopRef.current,
            ),
          ),
          "",
          detailLocation(window.location, state.target),
        );
      } else if (state?.kind === "viewer") {
        if (state.detailScrollTop === detailScrollTopRef.current) return;
        window.history.replaceState(
          currentProductHistoryState(
            viewerHistoryState(
              state.target,
              state.mediaId,
              state.sourceDestination,
              state.sourceScrollTop,
              detailScrollTopRef.current,
            ),
          ),
          "",
          viewerLocation(window.location, state.target, state.mediaId),
        );
      }
    }, DETAIL_HISTORY_SYNC_DELAY_MS);
  }, []);

  const setProfileVisibility = useCallback(
    (value: ProfileProductHistoryState | null) => {
      profileRef.current = value;
      setActiveProfile(value);
    },
    [],
  );
  const saveCurrentEntry = useCallback(() => {
    if (detailHistoryTimerRef.current !== null) {
      window.clearTimeout(detailHistoryTimerRef.current);
      detailHistoryTimerRef.current = null;
    }
    const current = parseProductHistoryState(window.history.state);
    if (current?.kind === "detail" || current?.kind === "viewer")
      window.history.replaceState(
        currentProductHistoryState({
          ...current,
          detailScrollTop: detailScrollTopRef.current,
        }),
        "",
      );
    else if (current?.kind === "profile" && profileRef.current)
      window.history.replaceState(
        currentProductHistoryState(profileRef.current),
        "",
      );
    else {
      const destination = activeDestinationRef.current;
      saveScroll(destination, platformRef.current);
      window.history.replaceState(
        currentProductHistoryState(
          primaryHistoryState(destination, readActiveScrollTop()),
        ),
        "",
        primaryLocation(window.location),
      );
    }
  }, [readActiveScrollTop, saveScroll]);
  const authReturnView = useAuthReturnView("shell", () => {
    const stored = parseProductHistoryState(window.history.state);
    const history =
      stored?.kind === "detail" || stored?.kind === "viewer"
        ? { ...stored, detailScrollTop: detailScrollTopRef.current }
        : stored?.kind === "profile" && profileRef.current
          ? profileRef.current
          : stored?.kind === "primary"
            ? { ...stored, scrollTop: readActiveScrollTop() }
            : stored;
    return { history, positions: { ...scrollPositionsRef.current } };
  });
  const openContent = useCallback(
    (target: ContentIdentity, opener: HTMLElement) => {
      if (
        !target.id ||
        target.id.length > 128 ||
        /\s/u.test(target.id) ||
        settingsOpenRef.current ||
        topicIdRef.current !== null ||
        viewerMediaIdRef.current !== null ||
        editorRef.current !== null ||
        (target.type === "work" && !profileEnabled)
      )
        return;
      if (
        contentRef.current?.type === target.type &&
        contentRef.current.id === target.id
      )
        return;
      saveCurrentEntry();
      const sourceDestination = activeDestinationRef.current;
      const saved = parseProductHistoryState(window.history.state);
      if (saved?.kind === "primary" && target.type === "catalog")
        window.history.replaceState(
          currentProductHistoryState({ ...saved, focusCatalogId: target.id }),
          "",
          primaryLocation(window.location),
        );
      const sourceScrollTop = scrollPositionsRef.current[sourceDestination];
      detailOpenerRef.current = opener;
      detailOpenerIdRef.current = target.id;
      detailSourceDestinationRef.current = sourceDestination;
      detailSourceScrollTopRef.current = sourceScrollTop;
      detailScrollTopRef.current = 0;
      window.history.pushState(
        currentProductHistoryState(
          detailHistoryState(target, sourceDestination, sourceScrollTop),
        ),
        "",
        detailLocation(window.location, target),
      );
      setProfileVisibility(null);
      setDetailVisibility(target);
      setViewerVisibility(null);
    },
    [
      profileEnabled,
      saveCurrentEntry,
      setDetailVisibility,
      setProfileVisibility,
      setViewerVisibility,
    ],
  );
  const openCatalog = useCallback(
    (catalogId: string, opener: HTMLElement) =>
      openContent({ type: "catalog", id: catalogId }, opener),
    [openContent],
  );
  const openProfile = useCallback(
    (authorId: string | null, opener: HTMLElement) => {
      if (
        !profileEnabled ||
        settingsOpenRef.current ||
        viewerMediaIdRef.current !== null ||
        topicIdRef.current !== null ||
        editorRef.current !== null ||
        (authorId !== null && !/^user-[0-9a-f]{32}$/.test(authorId))
      )
        return;
      saveCurrentEntry();
      const destination = activeDestinationRef.current;
      const state = profileHistoryState(
        authorId,
        requestIdentity(),
        "works",
        0,
        destination,
        scrollPositionsRef.current[destination],
      );
      profileOpenerRef.current = opener;
      window.history.pushState(
        currentProductHistoryState(state),
        "",
        profileLocation(window.location, authorId),
      );
      setDetailVisibility(null);
      setViewerVisibility(null);
      setProfileVisibility(state);
    },
    [
      profileEnabled,
      saveCurrentEntry,
      setDetailVisibility,
      setViewerVisibility,
      setProfileVisibility,
    ],
  );
  const closeProfile = useCallback(() => {
    saveCurrentEntry();
    window.history.back();
  }, [saveCurrentEntry]);
  const updateProfileView = useCallback(
    (tab: ProfileTab, scrollTop: number) => {
      const current = profileRef.current;
      if (!current) return;
      const next = profileHistoryState(
        current.authorId,
        current.entryId,
        tab,
        scrollTop,
        current.sourceDestination,
        current.sourceScrollTop,
      );
      profileRef.current = next;
      rememberHistoryOffset(scrollTop);
      if (detailHistoryTimerRef.current !== null) {
        window.clearTimeout(detailHistoryTimerRef.current);
        detailHistoryTimerRef.current = null;
      }
      if (current.tab !== tab) {
        setActiveProfile(next);
        window.history.replaceState(
          currentProductHistoryState(next),
          "",
          profileLocation(window.location, current.authorId),
        );
      } else
        detailHistoryTimerRef.current = window.setTimeout(() => {
          detailHistoryTimerRef.current = null;
          const live = profileRef.current;
          if (live)
            window.history.replaceState(currentProductHistoryState(live), "");
        }, DETAIL_HISTORY_SYNC_DELAY_MS);
    },
    [],
  );

  const setEditorLeaveApproval = useCallback((approved: boolean) => {
    if (editorLeaveApprovalTimerRef.current !== null) {
      window.clearTimeout(editorLeaveApprovalTimerRef.current);
      editorLeaveApprovalTimerRef.current = null;
    }
    editorLeaveApprovedRef.current = approved;
    if (approved)
      editorLeaveApprovalTimerRef.current = window.setTimeout(() => {
        editorLeaveApprovalTimerRef.current = null;
        editorLeaveApprovedRef.current = false;
      }, EDITOR_LEAVE_APPROVAL_MS);
  }, []);
  const disposeEditorLeaveGuard = useCallback(() => {
    editorLeaveGuardRef.current?.dispose();
    editorLeaveGuardRef.current = null;
  }, []);
  /** `keepSession` only for the same editor changing its own target. */
  const setEditorVisibility = useCallback(
    (value: EditorProductHistoryState | null, keepSession = false) => {
      editorRef.current = value;
      if (!keepSession) {
        // A closed or different editor never inherits a guard or its origin.
        disposeEditorLeaveGuard();
        editorBelowRef.current = null;
        if (value !== null) setEditorSession((session) => session + 1);
      }
      setActiveEditor(value);
    },
    [disposeEditorLeaveGuard],
  );
  const restoreEditorFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const opener = editorOpenerRef.current;
      if (
        editorRef.current === null &&
        opener?.isConnected &&
        opener.closest('[inert], [hidden], [aria-hidden="true"]') === null
      )
        opener.focus({ preventScroll: true });
    });
  }, []);
  const openEditor = useCallback(
    (target: ProductEditorTarget, opener: HTMLElement) => {
      const editorTarget = allowedEditorTarget(
        parseProductEditorTarget(target),
      );
      // content-community-completion-v1: the Thread quick composer opens the
      // editor above the Thread overlay it was started from; closing the
      // editor returns to that Thread through the history entry below.
      const fromThread =
        editorTarget?.type === "new" && editorTarget.threadId !== undefined;
      if (
        !editorEnabled ||
        editorTarget === null ||
        settingsOpenRef.current ||
        viewerMediaIdRef.current !== null ||
        (topicIdRef.current !== null && !fromThread) ||
        editorRef.current !== null
      )
        return false;
      saveCurrentEntry();
      const below = parseProductHistoryState(window.history.state);
      const destination = activeDestinationRef.current;
      const state = editorHistoryState(
        editorTarget,
        destination,
        scrollPositionsRef.current[destination],
      );
      editorOpenerRef.current = opener;
      setEditorLeaveApproval(false);
      window.history.pushState(
        currentProductHistoryState(state),
        "",
        editorLocation(window.location, editorTarget),
      );
      setDetailVisibility(null);
      setViewerVisibility(null);
      setProfileVisibility(null);
      setEditorVisibility(state);
      editorBelowRef.current = below;
      return true;
    },
    [
      editorEnabled,
      allowedEditorTarget,
      saveCurrentEntry,
      setDetailVisibility,
      setEditorLeaveApproval,
      setEditorVisibility,
      setProfileVisibility,
      setViewerVisibility,
    ],
  );
  const closeEditor = useCallback(() => {
    if (
      editorRef.current === null ||
      editorLeaveGuardRef.current?.guard("close") === "blocked"
    )
      return;
    if (parseProductHistoryState(window.history.state)?.kind === "editor") {
      setEditorLeaveApproval(true);
      window.history.back();
      return;
    }
    const destination = activeDestinationRef.current;
    setEditorVisibility(null);
    window.history.replaceState(
      currentProductHistoryState(
        primaryHistoryState(
          destination,
          scrollPositionsRef.current[destination],
        ),
      ),
      "",
      primaryLocation(window.location),
    );
    restoreScroll(destination, platformRef.current);
    restoreEditorFocus();
  }, [
    restoreEditorFocus,
    restoreScroll,
    setEditorLeaveApproval,
    setEditorVisibility,
  ]);
  const completeEditor = useCallback(
    (target: ContentIdentity) => {
      const current = editorRef.current;
      if (
        current === null ||
        !target.id ||
        target.id.length > 128 ||
        /\s/u.test(target.id) ||
        (target.type === "work" && !profileEnabled)
      )
        return;
      const below = editorBelowRef.current;
      const owned =
        parseProductHistoryState(window.history.state)?.kind === "editor";
      // The submission is saved: nothing remains for the guard to protect.
      disposeEditorLeaveGuard();
      if (
        owned &&
        below?.kind === "detail" &&
        below.target.type === target.type &&
        below.target.id === target.id
      ) {
        // Return to that Detail, reloaded, instead of stacking a second copy.
        setDetailNavigationRevision((value) => value + 1);
        window.history.back();
        return;
      }
      const { sourceDestination, sourceScrollTop } = current;
      if (!owned)
        window.history.replaceState(
          currentProductHistoryState(
            primaryHistoryState(sourceDestination, sourceScrollTop),
          ),
          "",
          primaryLocation(window.location),
        );
      window.history[owned ? "replaceState" : "pushState"](
        currentProductHistoryState(
          detailHistoryState(target, sourceDestination, sourceScrollTop),
        ),
        "",
        detailLocation(window.location, target),
      );
      detailOpenerRef.current = editorOpenerRef.current;
      detailOpenerIdRef.current = target.id;
      detailSourceDestinationRef.current = sourceDestination;
      detailSourceScrollTopRef.current = sourceScrollTop;
      detailScrollTopRef.current = 0;
      scrollPositionsRef.current[sourceDestination] = sourceScrollTop;
      setEditorVisibility(null);
      setProfileVisibility(null);
      setViewerVisibility(null);
      setDetailNavigationRevision((value) => value + 1);
      setDetailVisibility(target);
    },
    [
      disposeEditorLeaveGuard,
      profileEnabled,
      setDetailVisibility,
      setEditorVisibility,
      setProfileVisibility,
      setViewerVisibility,
    ],
  );
  const registerEditorLeaveGuard = useCallback(
    (guard: ProductShellEditorLeaveGuard) => {
      if (editorRef.current === null) return () => undefined;
      editorLeaveGuardRef.current?.dispose();
      // A new registration protects new work; no earlier approval covers it.
      setEditorLeaveApproval(false);
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (guard("unload") !== "blocked") return;
        event.preventDefault();
        // Older engines still require a return value to show the prompt.
        event.returnValue = "";
      };
      const registration = {
        guard,
        dispose: () =>
          window.removeEventListener("beforeunload", handleBeforeUnload),
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      editorLeaveGuardRef.current = registration;
      return () => {
        registration.dispose();
        if (editorLeaveGuardRef.current === registration)
          editorLeaveGuardRef.current = null;
      };
    },
    [setEditorLeaveApproval],
  );
  const replaceEditorTarget = useCallback(
    (target: ProductEditorTarget) => {
      const current = editorRef.current;
      const editorTarget = allowedEditorTarget(
        parseProductEditorTarget(target),
      );
      if (
        current === null ||
        editorTarget === null ||
        sameEditorTarget(current.editorTarget, editorTarget)
      )
        return;
      const next = editorHistoryState(
        editorTarget,
        current.sourceDestination,
        current.sourceScrollTop,
      );
      if (parseProductHistoryState(window.history.state)?.kind === "editor")
        window.history.replaceState(
          currentProductHistoryState(next),
          "",
          editorLocation(window.location, editorTarget),
        );
      setEditorVisibility(next, true);
    },
    [setEditorVisibility, allowedEditorTarget],
  );
  const openEditorDraftBox = useCallback(() => {
    const current = editorRef.current;
    if (
      !articleEditorEnabled ||
      !profileEnabled ||
      current?.editorTarget.type !== "article-list"
    )
      return;
    const profile = profileHistoryState(
      null,
      requestIdentity(),
      "works",
      0,
      current.sourceDestination,
      current.sourceScrollTop,
    );
    window.history.replaceState(
      currentProductHistoryState(profile),
      "",
      profileLocation(window.location, null),
    );
    disposeEditorLeaveGuard();
    editorBelowRef.current = null;
    setEditorVisibility(null);
    setProfileVisibility(profile);
  }, [
    articleEditorEnabled,
    profileEnabled,
    disposeEditorLeaveGuard,
    setEditorVisibility,
    setProfileVisibility,
  ]);
  const editorControls = useMemo<ProductShellEditorOverlayControls>(
    () => ({
      backButtonRef: editorBackRef,
      close: closeEditor,
      completeWith: completeEditor,
      registerLeaveGuard: registerEditorLeaveGuard,
      replaceTarget: replaceEditorTarget,
      openDraftBox: openEditorDraftBox,
    }),
    [
      closeEditor,
      completeEditor,
      registerEditorLeaveGuard,
      replaceEditorTarget,
      openEditorDraftBox,
    ],
  );

  const openViewer = useCallback(
    (mediaId: string) => {
      const target = contentRef.current;
      if (
        target === null ||
        viewerMediaIdRef.current !== null ||
        mediaId.length === 0 ||
        mediaId.length > 128 ||
        /\s/u.test(mediaId)
      ) {
        return;
      }
      const current = parseProductHistoryState(window.history.state);
      const sourceDestination =
        current?.kind === "detail"
          ? current.sourceDestination
          : detailSourceDestinationRef.current;
      const sourceScrollTop =
        current?.kind === "detail"
          ? current.sourceScrollTop
          : detailSourceScrollTopRef.current;
      window.history.replaceState(
        currentProductHistoryState(
          detailHistoryState(
            target,
            sourceDestination,
            sourceScrollTop,
            detailScrollTopRef.current,
          ),
        ),
        "",
        detailLocation(window.location, target),
      );
      window.history.pushState(
        currentProductHistoryState(
          viewerHistoryState(
            target,
            mediaId,
            sourceDestination,
            sourceScrollTop,
            detailScrollTopRef.current,
          ),
        ),
        "",
        viewerLocation(window.location, target, mediaId),
      );
      setViewerVisibility(mediaId);
    },
    [setViewerVisibility],
  );

  const changeViewerMedia = useCallback(
    (mediaId: string) => {
      if (mediaId.length === 0 || mediaId.length > 128 || /\s/u.test(mediaId)) {
        return;
      }
      const state = parseProductHistoryState(window.history.state);
      if (state?.kind !== "viewer" || state.mediaId === mediaId) return;
      window.history.replaceState(
        currentProductHistoryState(
          viewerHistoryState(
            state.target,
            mediaId,
            state.sourceDestination,
            state.sourceScrollTop,
            detailScrollTopRef.current,
          ),
        ),
        "",
        viewerLocation(window.location, state.target, mediaId),
      );
      setViewerVisibility(mediaId);
    },
    [setViewerVisibility],
  );

  const closeViewer = useCallback(() => {
    const state = parseProductHistoryState(window.history.state);
    if (state?.kind === "viewer") {
      window.history.back();
      return;
    }
    const target = contentRef.current;
    setViewerVisibility(null);
    if (target === null) return;
    window.history.replaceState(
      currentProductHistoryState(
        detailHistoryState(
          target,
          detailSourceDestinationRef.current,
          detailSourceScrollTopRef.current,
          detailScrollTopRef.current,
        ),
      ),
      "",
      detailLocation(window.location, target),
    );
  }, [setViewerVisibility]);

  const closeDetail = useCallback(() => {
    if (viewerMediaIdRef.current !== null) {
      closeViewer();
      return;
    }
    if (detailHistoryTimerRef.current !== null) {
      window.clearTimeout(detailHistoryTimerRef.current);
      detailHistoryTimerRef.current = null;
    }
    const state = parseProductHistoryState(window.history.state);
    if (state?.kind === "detail") {
      window.history.replaceState(
        currentProductHistoryState(
          detailHistoryState(
            state.target,
            state.sourceDestination,
            state.sourceScrollTop,
            detailScrollTopRef.current,
          ),
        ),
        "",
        detailLocation(window.location, state.target),
      );
      window.history.back();
      return;
    }
    const sourceDestination = detailSourceDestinationRef.current;
    setViewerVisibility(null);
    setDetailVisibility(null);
    window.history.replaceState(
      currentProductHistoryState(
        primaryHistoryState(
          sourceDestination,
          detailSourceScrollTopRef.current,
          undefined,
          detailOpenerIdRef.current ?? undefined,
        ),
      ),
      "",
      primaryLocation(window.location),
    );
    scrollPositionsRef.current[sourceDestination] =
      detailSourceScrollTopRef.current;
    restoreScroll(sourceDestination, platformRef.current);
    if (detailOpenerIdRef.current !== null) {
      restoreCatalogFocus(detailOpenerIdRef.current);
    }
  }, [
    closeViewer,
    restoreCatalogFocus,
    restoreScroll,
    setDetailVisibility,
    setViewerVisibility,
  ]);

  const recoverUnavailableAuthContent = useCallback(
    (target?: ContentIdentity) => {
      if (!authReturn?.isRestoring()) return false;
      const state = parseProductHistoryState(window.history.state);
      if (
        state === null ||
        (state.kind !== "detail" &&
          state.kind !== "viewer" &&
          state.kind !== "topic") ||
        (target !== undefined &&
          (state.kind === "topic" ||
            state.target.type !== target.type ||
            state.target.id !== target.id))
      )
        return false;
      if (detailHistoryTimerRef.current !== null) {
        window.clearTimeout(detailHistoryTimerRef.current);
        detailHistoryTimerRef.current = null;
      }
      const { sourceDestination, sourceScrollTop } = state;
      // This replaces the unavailable source entry itself. Closing a viewer
      // with Back would leave an equally unavailable Detail beneath it.
      authReturn.retire();
      setViewerVisibility(null);
      setDetailVisibility(null);
      setTopicVisibility(null);
      detailScrollTopRef.current = 0;
      activeDestinationRef.current = sourceDestination;
      setActiveDestination(sourceDestination);
      scrollPositionsRef.current[sourceDestination] = sourceScrollTop;
      window.history.replaceState(
        currentProductHistoryState(
          primaryHistoryState(sourceDestination, sourceScrollTop),
        ),
        "",
        primaryLocation(window.location),
      );
      expandNavigation();
      restoreScroll(sourceDestination, platformRef.current);
      setAuthReturnNotice("原内容已删除或暂时无法访问，已返回原列表。");
      return true;
    },
    [
      authReturn,
      expandNavigation,
      restoreScroll,
      setDetailVisibility,
      setTopicVisibility,
      setViewerVisibility,
    ],
  );

  useEffect(() => {
    const root = document.documentElement;
    const storedTheme = readStoredThemePreference(window.localStorage);
    const storedFeedLayout = readStoredFeedLayoutPreference(
      window.localStorage,
    );
    setTheme(storedTheme);
    setFeedLayout(storedFeedLayout);
    applyThemePreferenceToRoot(root, storedTheme);
    applyFeedLayoutPreferenceToRoot(root, storedFeedLayout);

    const started = Number(root.dataset.yoyiBootStarted);
    const elapsed = Number.isFinite(started)
      ? Math.max(0, performance.now() - started)
      : PRODUCT_LOADING_MINIMUM_MS;
    const remaining = Math.max(0, PRODUCT_LOADING_MINIMUM_MS - elapsed);
    const loadingTimer = window.setTimeout(() => {
      root.dataset.yoyiBoot = "ready";
      setBootPending(false);
    }, remaining);

    return () => window.clearTimeout(loadingTimer);
  }, []);

  useEffect(() => {
    const synchronizeEffectiveTheme = () => {
      const effective =
        theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : theme;
      document.documentElement.dataset.effectiveTheme = effective;
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    synchronizeEffectiveTheme();
    media.addEventListener?.("change", synchronizeEffectiveTheme);
    return () =>
      media.removeEventListener?.("change", synchronizeEffectiveTheme);
  }, [theme]);

  useEffect(() => {
    const synchronizeViewportInset = () => {
      const root = document.documentElement;
      const viewport = window.visualViewport;
      if (platformRef.current === "pc" || viewport == null) {
        synchronizePrimaryNavigationViewportInset(root, null);
        return;
      }
      const inset = resolvePrimaryNavigationViewportInset(
        window.innerHeight,
        viewport.height,
        viewport.offsetTop,
      );
      synchronizePrimaryNavigationViewportInset(root, inset);
    };

    const synchronizeRuntime = () => {
      const nextPlatform = developmentPlatformOverride ?? runtimePlatform();
      const nextOrientation = runtimeOrientation();
      const previousPlatform = platformRef.current;

      if (nextPlatform !== previousPlatform) {
        saveScroll(activeDestinationRef.current, previousPlatform);
        platformRef.current = nextPlatform;
        setPlatform(nextPlatform);
        document.documentElement.dataset.platform = nextPlatform;
        restoreScroll(activeDestinationRef.current, nextPlatform);
      }
      setOrientation((current) =>
        current === nextOrientation ? current : nextOrientation,
      );
      document.documentElement.dataset.orientation = nextOrientation;
      document.documentElement.dataset.deviceClass = readRuntimeDeviceClass(
        navigator as NavigatorWithUserAgentData,
      );
      synchronizeViewportInset();
    };

    synchronizeRuntime();
    window.addEventListener("orientationchange", synchronizeRuntime);
    window.addEventListener("resize", synchronizeRuntime);
    window.visualViewport?.addEventListener("resize", synchronizeRuntime);
    window.visualViewport?.addEventListener(
      "scroll",
      synchronizeViewportInset,
      { passive: true },
    );

    return () => {
      window.removeEventListener("orientationchange", synchronizeRuntime);
      window.removeEventListener("resize", synchronizeRuntime);
      window.visualViewport?.removeEventListener("resize", synchronizeRuntime);
      window.visualViewport?.removeEventListener(
        "scroll",
        synchronizeViewportInset,
      );
    };
  }, [developmentPlatformOverride, restoreScroll, saveScroll]);

  useEffect(() => {
    if (
      settingsOpen ||
      activeContent !== null ||
      activeTopicId !== null ||
      activeProfile !== null ||
      editorOpen
    ) {
      return undefined;
    }
    if (platform === "pc") {
      expandNavigation();
      return undefined;
    }

    const scrollElement =
      activeDestination === "home" && activeHomeScrollElement !== null
        ? activeHomeScrollElement
        : activeDestination === "discussion" &&
            activeDiscussionScrollElement !== null
          ? activeDiscussionScrollElement
          : scrollElementFor(activeDestination, platform);
    if (!(scrollElement instanceof HTMLElement)) return undefined;

    navigationScrollStateRef.current = createPrimaryNavigationScrollState(
      scrollElement.scrollTop,
      navigationMinimizedRef.current,
    );

    const clearIdleTimer = () => {
      if (navigationIdleTimerRef.current === null) return;
      window.clearTimeout(navigationIdleTimerRef.current);
      navigationIdleTimerRef.current = null;
    };
    const scheduleIdleExpansion = () => {
      clearIdleTimer();
      if (!navigationScrollStateRef.current.minimized) return;
      navigationIdleTimerRef.current = window.setTimeout(
        expandNavigation,
        PRIMARY_NAVIGATION_IDLE_EXPAND_MS,
      );
    };
    const handleScroll = () => {
      if (scrollRestorePendingRef.current) {
        navigationScrollStateRef.current = createPrimaryNavigationScrollState(
          scrollElement.scrollTop,
          navigationMinimizedRef.current,
        );
        return;
      }

      const nextState = resolvePrimaryNavigationScrollState(
        navigationScrollStateRef.current,
        scrollElement.scrollTop,
      );
      navigationScrollStateRef.current = nextState;
      setNavigationMinimizedState(nextState.minimized);
      scheduleIdleExpansion();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearIdleTimer();
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [
    activeDestination,
    activeHomeScrollElement,
    activeDiscussionScrollElement,
    activeProfile,
    activeContent,
    activeTopicId,
    editorOpen,
    expandNavigation,
    platform,
    scrollElementFor,
    setNavigationMinimizedState,
    settingsOpen,
  ]);

  useEffect(() => {
    const storedState =
      authReturnView?.history ?? parseProductHistoryState(window.history.state);
    const initialState =
      storedState === null ||
      (storedState.kind === "editor" &&
        allowedEditorTarget(storedState.editorTarget) === null)
        ? null
        : authReturnView
          ? storedState
          : resetHistoryScroll(storedState);
    if (authReturnView)
      scrollPositionsRef.current = { ...authReturnView.positions };
    if (initialState)
      window.history.replaceState(currentProductHistoryState(initialState), "");
    const candidateTarget = directContentFromLocation(window.location);
    const directTarget =
      candidateTarget?.type === "work" && !profileEnabled
        ? null
        : candidateTarget;
    const directAuthor = profileEnabled
      ? directAuthorFromLocation(window.location)
      : undefined;
    const directMediaId = directMediaIdFromLocation(window.location);
    const directSettings = window.location.hash === "#settings";
    const directEditor = editorEnabled
      ? allowedEditorTarget(directEditorTargetFromLocation(window.location))
      : null;
    let destination: PrimaryDestination = "home";

    if (initialState?.kind === "primary") {
      destination = initialState.destination;
    } else if (
      initialState?.kind === "settings" ||
      initialState?.kind === "detail" ||
      initialState?.kind === "viewer" ||
      initialState?.kind === "profile" ||
      initialState?.kind === "editor" ||
      initialState?.kind === "topic"
    ) {
      destination = initialState.sourceDestination;
    }

    activeDestinationRef.current = destination;
    setActiveDestination(destination);
    if (
      initialState?.kind === "primary" &&
      initialState.scrollTop !== undefined
    ) {
      scrollPositionsRef.current[destination] = initialState.scrollTop;
    }

    if (
      editorEnabled &&
      (initialState?.kind === "editor" ||
        ((initialState === null || initialState.kind === "primary") &&
          directEditor !== null))
    ) {
      const state =
        initialState?.kind === "editor"
          ? initialState
          : editorHistoryState(directEditor ?? { type: "new" }, destination, 0);
      scrollPositionsRef.current[destination] = state.sourceScrollTop;
      if (initialState?.kind !== "editor") {
        window.history.replaceState(
          currentProductHistoryState(primaryHistoryState(destination, 0)),
          "",
          primaryLocation(window.location),
        );
        window.history.pushState(
          currentProductHistoryState(state),
          "",
          editorLocation(window.location, state.editorTarget),
        );
      }
      setEditorVisibility(state);
      // A restored entry's predecessor is unknown; a rebuilt link's is Home.
      if (initialState?.kind !== "editor")
        editorBelowRef.current = primaryHistoryState(destination, 0);
      setProfileVisibility(null);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
      setSettingsVisibility(false);
    } else if (
      profileEnabled &&
      (initialState?.kind === "profile" || directAuthor !== undefined)
    ) {
      const state =
        initialState?.kind === "profile"
          ? initialState
          : profileHistoryState(
              directAuthor ?? null,
              requestIdentity(),
              "works",
              0,
              destination,
              0,
            );
      if (initialState?.kind !== "profile") {
        window.history.replaceState(
          currentProductHistoryState(primaryHistoryState(destination, 0)),
          "",
          primaryLocation(window.location),
        );
        window.history.pushState(
          currentProductHistoryState(state),
          "",
          profileLocation(window.location, state.authorId),
        );
      }
      setProfileVisibility(state);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
      setSettingsVisibility(false);
    } else if (
      (initialState?.kind === "detail" || initialState?.kind === "viewer") &&
      (initialState.target.type === "catalog" || profileEnabled)
    ) {
      detailSourceDestinationRef.current = initialState.sourceDestination;
      detailSourceScrollTopRef.current = initialState.sourceScrollTop;
      detailScrollTopRef.current = initialState.detailScrollTop;
      detailOpenerIdRef.current = initialState.target.id;
      scrollPositionsRef.current[initialState.sourceDestination] =
        initialState.sourceScrollTop;
      setSettingsVisibility(false);
      setTopicVisibility(null);
      setDetailVisibility(initialState.target);
      setViewerVisibility(
        initialState.kind === "viewer" ? initialState.mediaId : null,
      );
    } else if (initialState?.kind === "topic") {
      topicSourceScrollTopRef.current = initialState.sourceScrollTop;
      scrollPositionsRef.current.discussion = initialState.sourceScrollTop;
      setSettingsVisibility(false);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(initialState.topicId);
    } else if (initialState?.kind === "settings") {
      setSettingsVisibility(true);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
    } else if (directTarget !== null) {
      const sourceScrollTop =
        initialState?.kind === "primary" && initialState.scrollTop !== undefined
          ? initialState.scrollTop
          : 0;
      detailSourceDestinationRef.current = destination;
      detailSourceScrollTopRef.current = sourceScrollTop;
      detailScrollTopRef.current = 0;
      detailOpenerIdRef.current = directTarget.id;
      scrollPositionsRef.current[destination] = sourceScrollTop;
      window.history.replaceState(
        currentProductHistoryState(
          primaryHistoryState(
            destination,
            sourceScrollTop,
            undefined,
            directTarget.type === "catalog" ? directTarget.id : undefined,
          ),
        ),
        "",
        primaryLocation(window.location),
      );
      window.history.pushState(
        currentProductHistoryState(
          detailHistoryState(directTarget, destination, sourceScrollTop),
        ),
        "",
        detailLocation(window.location, directTarget),
      );
      if (directMediaId !== null) {
        window.history.pushState(
          currentProductHistoryState(
            viewerHistoryState(
              directTarget,
              directMediaId,
              destination,
              sourceScrollTop,
            ),
          ),
          "",
          viewerLocation(window.location, directTarget, directMediaId),
        );
      }
      setSettingsVisibility(false);
      setTopicVisibility(null);
      setDetailVisibility(directTarget);
      setViewerVisibility(directMediaId);
    } else if (directSettings) {
      window.history.replaceState(
        currentProductHistoryState(primaryHistoryState(destination)),
        "",
        primaryLocation(window.location),
      );
      window.history.pushState(
        currentProductHistoryState(settingsHistoryState(destination)),
        "",
        settingsLocation(window.location),
      );
      setSettingsVisibility(true);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
    } else {
      window.history.replaceState(
        currentProductHistoryState(
          primaryHistoryState(
            destination,
            initialState?.kind === "primary"
              ? initialState.scrollTop
              : undefined,
            initialState?.kind === "primary"
              ? initialState.focusTopicId
              : undefined,
            initialState?.kind === "primary"
              ? initialState.focusCatalogId
              : undefined,
          ),
        ),
        "",
        primaryLocation(window.location),
      );
      setSettingsVisibility(false);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
      if (
        initialState?.kind === "primary" &&
        initialState.scrollTop !== undefined
      ) {
        restoreScroll(destination, platformRef.current);
      }
      if (
        initialState?.kind === "primary" &&
        initialState.focusTopicId !== undefined
      ) {
        restoreTopicFocus(initialState.focusTopicId);
      } else if (
        initialState?.kind === "primary" &&
        initialState.focusCatalogId !== undefined
      ) {
        restoreCatalogFocus(initialState.focusCatalogId);
      }
    }

    const handlePopState = (event: PopStateEvent) => {
      cancelSettingsFocus();
      let state = restoredHistoryState(event.state);
      if (
        state?.kind === "editor" &&
        allowedEditorTarget(state.editorTarget) === null
      )
        state = null;
      // An entry this shell never wrote, such as a native fragment link's.
      const nativeEntry = state === null;
      let reloadDetail = false;
      // Following an identical fragment link can be a native same-document
      // navigation with null state. Reconstruct its validated public target;
      // treating it as Home would close the overlay while leaving its URL open.
      if (state === null) {
        const target = directContentFromLocation(window.location);
        const author = profileEnabled
          ? directAuthorFromLocation(window.location)
          : undefined;
        const destination = activeDestinationRef.current;
        const editorTarget = editorEnabled
          ? allowedEditorTarget(directEditorTargetFromLocation(window.location))
          : null;
        if (editorTarget !== null) {
          const current = editorRef.current;
          // A draft shares the plain `#editor` link, so match links, not IDs.
          state =
            current !== null &&
            sameEditorLink(current.editorTarget, editorTarget)
              ? current
              : editorHistoryState(editorTarget, destination, 0);
        } else if (author !== undefined) {
          const current = profileRef.current;
          state =
            current?.authorId === author
              ? current
              : profileHistoryState(
                  author,
                  requestIdentity(),
                  "works",
                  0,
                  destination,
                  0,
                );
        } else if (target && (target.type === "catalog" || profileEnabled)) {
          const media = directMediaIdFromLocation(window.location);
          state =
            media === null
              ? detailHistoryState(target, destination, 0)
              : viewerHistoryState(target, media, destination, 0);
          reloadDetail = true;
        }
      }
      const openEditorState = editorRef.current;
      const sameEditor =
        openEditorState !== null &&
        state?.kind === "editor" &&
        sameEditorTarget(openEditorState.editorTarget, state.editorTarget);
      if (openEditorState !== null) {
        const approved = editorLeaveApprovedRef.current;
        setEditorLeaveApproval(false);
        if (
          !approved &&
          !sameEditor &&
          editorLeaveGuardRef.current?.guard("history") === "blocked"
        ) {
          // History has already moved; give the editor its entry back before
          // anything is written for the refused one. A native link's own new
          // entry is overwritten rather than left behind the editor.
          window.history[nativeEntry ? "replaceState" : "pushState"](
            currentProductHistoryState(openEditorState),
            "",
            editorLocation(window.location, openEditorState.editorTarget),
          );
          return;
        }
      }
      if (nativeEntry && state !== null)
        window.history.replaceState(currentProductHistoryState(state), "");
      if (reloadDetail) setDetailNavigationRevision((value) => value + 1);
      const wasDetailOpen = contentRef.current !== null;
      const wasSettingsOpen = settingsOpenRef.current;
      const wasTopicOpen = topicIdRef.current !== null;
      const wasProfileOpen = profileRef.current !== null;
      const wasEditorOpen = openEditorState !== null;
      setProfileVisibility(null);
      if (
        !wasDetailOpen &&
        !wasTopicOpen &&
        !wasProfileOpen &&
        !wasEditorOpen
      ) {
        saveScroll(activeDestinationRef.current, platformRef.current);
      }

      if (state?.kind === "editor" && editorEnabled) {
        activeDestinationRef.current = state.sourceDestination;
        setActiveDestination(state.sourceDestination);
        setSettingsVisibility(false);
        setTopicVisibility(null);
        setDetailVisibility(null);
        setViewerVisibility(null);
        // The same open editor keeps its session and registered guard; a
        // different one starts a new session with no guard or known origin.
        if (!sameEditor) setEditorVisibility(state);
        return;
      }
      setEditorVisibility(null);

      if (state?.kind === "profile" && profileEnabled) {
        const returningContent = contentRef.current;
        activeDestinationRef.current = state.sourceDestination;
        setActiveDestination(state.sourceDestination);
        setSettingsVisibility(false);
        setTopicVisibility(null);
        setDetailVisibility(null);
        setViewerVisibility(null);
        setProfileVisibility(state);
        if (returningContent) restoreCatalogFocus(returningContent.id);
        return;
      }
      if (
        (state?.kind === "detail" || state?.kind === "viewer") &&
        (state.target.type === "catalog" || profileEnabled)
      ) {
        activeDestinationRef.current = state.sourceDestination;
        setActiveDestination(state.sourceDestination);
        detailSourceDestinationRef.current = state.sourceDestination;
        detailSourceScrollTopRef.current = state.sourceScrollTop;
        detailScrollTopRef.current = state.detailScrollTop;
        detailOpenerIdRef.current = state.target.id;
        scrollPositionsRef.current[state.sourceDestination] =
          state.sourceScrollTop;
        setSettingsVisibility(false);
        setTopicVisibility(null);
        setDetailVisibility(state.target);
        setViewerVisibility(state.kind === "viewer" ? state.mediaId : null);
        return;
      }

      if (state?.kind === "settings") {
        activeDestinationRef.current = state.sourceDestination;
        setActiveDestination(state.sourceDestination);
        setDetailVisibility(null);
        setViewerVisibility(null);
        setTopicVisibility(null);
        setSettingsVisibility(true);
        return;
      }

      if (state?.kind === "topic") {
        activeDestinationRef.current = "discussion";
        setActiveDestination("discussion");
        topicSourceScrollTopRef.current = state.sourceScrollTop;
        scrollPositionsRef.current.discussion = state.sourceScrollTop;
        setSettingsVisibility(false);
        setDetailVisibility(null);
        setViewerVisibility(null);
        setTopicVisibility(state.topicId);
        return;
      }

      const nextDestination =
        state?.kind === "primary" ? state.destination : "home";
      if (
        !wasSettingsOpen &&
        !wasDetailOpen &&
        nextDestination !== activeDestinationRef.current
      ) {
        expandNavigation();
      }
      activeDestinationRef.current = nextDestination;
      setActiveDestination(nextDestination);
      setDetailVisibility(null);
      setViewerVisibility(null);
      setTopicVisibility(null);
      setSettingsVisibility(false);
      if (state?.kind === "primary" && state.scrollTop !== undefined) {
        scrollPositionsRef.current[nextDestination] = state.scrollTop;
      } else if (wasDetailOpen) {
        scrollPositionsRef.current[detailSourceDestinationRef.current] =
          detailSourceScrollTopRef.current;
      } else if (wasTopicOpen) {
        scrollPositionsRef.current.discussion = topicSourceScrollTopRef.current;
      }
      restoreScroll(nextDestination, platformRef.current);

      if (wasDetailOpen && state?.kind === "primary") {
        const focusCatalogId =
          state.focusCatalogId ?? detailOpenerIdRef.current;
        if (focusCatalogId !== null && focusCatalogId !== undefined) {
          restoreCatalogFocus(focusCatalogId);
        }
      } else if (wasProfileOpen) {
        window.requestAnimationFrame(
          () =>
            profileOpenerRef.current?.isConnected &&
            profileOpenerRef.current.focus({ preventScroll: true }),
        );
      } else if (wasEditorOpen) {
        restoreEditorFocus();
      } else if (wasSettingsOpen) {
        restoreSettingsFocus();
      } else if (
        wasTopicOpen &&
        state?.kind === "primary" &&
        state.focusTopicId !== undefined
      ) {
        restoreTopicFocus(state.focusTopicId);
      } else if (wasTopicOpen) {
        window.requestAnimationFrame(() => topicOpenerRef.current?.focus());
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    cancelSettingsFocus,
    editorEnabled,
    allowedEditorTarget,
    expandNavigation,
    restoreCatalogFocus,
    restoreEditorFocus,
    setEditorLeaveApproval,
    restoreScroll,
    restoreSettingsFocus,
    restoreTopicFocus,
    saveScroll,
    setDetailVisibility,
    setEditorVisibility,
    setSettingsVisibility,
    setTopicVisibility,
    setViewerVisibility,
    setProfileVisibility,
    profileEnabled,
  ]);

  useLayoutEffect(() => {
    if (
      !settingsOpen &&
      activeContent === null &&
      activeTopicId === null &&
      activeProfile === null &&
      !editorOpen
    ) {
      return undefined;
    }
    cancelScrollRestore();
    cancelSettingsFocus();
    if (settingsOpen) settingsBackRef.current?.focus();
    else if (activeContent !== null) detailBackRef.current?.focus();
    else if (activeProfile !== null) profileBackRef.current?.focus();
    else if (editorOpen) editorBackRef.current?.focus();
    else topicBackRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [
    activeContent,
    activeProfile,
    activeTopicId,
    cancelScrollRestore,
    cancelSettingsFocus,
    editorOpen,
    // A new editor session mounts a new host and back button.
    editorSession,
    settingsOpen,
  ]);

  useEffect(
    () => () => {
      cancelScrollRestore();
      cancelSettingsFocus();
      if (topicFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(topicFocusFrameRef.current);
      }
      if (detailHistoryTimerRef.current !== null) {
        window.clearTimeout(detailHistoryTimerRef.current);
      }
      if (navigationIdleTimerRef.current !== null) {
        window.clearTimeout(navigationIdleTimerRef.current);
      }
      if (editorLeaveApprovalTimerRef.current !== null) {
        window.clearTimeout(editorLeaveApprovalTimerRef.current);
      }
      editorLeaveGuardRef.current?.dispose();
      synchronizePrimaryNavigationViewportInset(document.documentElement, null);
    },
    [cancelScrollRestore, cancelSettingsFocus],
  );

  const setThemePreference = (next: ThemePreference) => {
    setTheme(next);
    applyThemePreferenceToRoot(document.documentElement, next);
    persistPreference(window.localStorage, THEME_PREFERENCE_STORAGE_KEY, next);
  };

  const setFeedLayoutPreference = (next: FeedLayoutPreference) => {
    setFeedLayout(next);
    applyFeedLayoutPreferenceToRoot(document.documentElement, next);
    persistPreference(
      window.localStorage,
      FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
      next,
    );
  };

  const cycleTheme = () => setThemePreference(nextThemePreference(theme));
  const cycleFeedLayout = () =>
    setFeedLayoutPreference(nextFeedLayoutPreference(feedLayout));

  const contextValue: ProductShellContextValue = {
    activeCatalogId:
      activeContent?.type === "catalog" ? activeContent.id : null,
    activeProfile,
    activeEditor: activeEditor?.editorTarget ?? null,
    openContent,
    openProfile,
    openEditor,
    activeContent,
    activeDestination,
    activeTopicId,
    activeViewerMediaId,
    changeViewerMedia,
    closeViewer,
    recoverUnavailableAuthContent,
    closeTopic,
    feedLayout,
    cycleTheme,
    cycleFeedLayout,
    setThemePreference,
    setFeedLayoutPreference,
    openCatalog,
    openViewer,
    openTopic,
    orientation,
    platform,
    readActiveScrollTop,
    registerActiveHomeScrollElement,
    registerActiveDiscussionScrollElement,
    navigatePrimary: commitDestination,
    registerTopicOpener,
    requestSettings,
    restoreActiveScrollTop,
    settingsOpen,
    theme,
  };
  const ownedOverlayOpen =
    settingsOpen ||
    activeContent !== null ||
    activeTopicId !== null ||
    activeProfile !== null ||
    editorOpen;

  return (
    <ProductShellContext.Provider value={contextValue}>
      <div
        ref={rootRef}
        className={styles.productShell}
        data-active-destination={activeDestination}
        data-feed-layout={feedLayout}
        data-detail-open={activeContent === null ? "false" : "true"}
        data-editor-open={editorOpen ? "true" : "false"}
        data-orientation={orientation}
        data-primary-navigation-minimized={
          navigationMinimized ? "true" : "false"
        }
        data-platform={platform}
        data-product-shell=""
        data-settings-open={settingsOpen ? "true" : "false"}
        data-topic-open={activeTopicId === null ? "false" : "true"}
        data-viewer-open={activeViewerMediaId === null ? "false" : "true"}
        data-theme-preference={theme}
      >
        <div
          aria-hidden={ownedOverlayOpen || undefined}
          className={styles.primaryLayer}
          data-product-primary-layer=""
          inert={ownedOverlayOpen || undefined}
        >
          <PrimaryNavigationPager
            activeDestination={activeDestination}
            user={user}
            home={home}
            discussion={discussion}
            navigationAction={navigationAction}
            navigationHidden={ownedOverlayOpen}
            navigationMinimized={navigationMinimized}
            onNavigationExpand={expandNavigation}
            onDestinationChange={commitDestination}
            platform={platform}
            showDevelopmentPagerControls={showDevelopmentPagerControls}
          />
          {primaryUtility}
        </div>

        {authReturnNotice !== null ? (
          <div
            aria-live="polite"
            data-auth-content-recovery=""
            role="status"
            style={{
              position: "fixed",
              insetInline: "var(--yoyi-space-5)",
              top: "calc(env(safe-area-inset-top, 0px) + var(--yoyi-space-5))",
              zIndex: "var(--yoyi-z-index-overlay)",
              display: "flex",
              alignItems: "center",
              gap: "var(--yoyi-space-3)",
              padding: "var(--yoyi-space-4)",
              border: "1px solid var(--yoyi-color-border-default)",
              borderRadius: "var(--yoyi-radius-md)",
              background: "var(--yoyi-color-background-elevated)",
              color: "var(--yoyi-color-text-primary)",
            }}
          >
            <span style={{ flex: 1 }}>{authReturnNotice}</span>
            <Button onClick={() => setAuthReturnNotice(null)} variant="quiet">
              关闭提示
            </Button>
          </div>
        ) : null}

        {settingsOpen ? (
          <SettingsOverlay
            backButtonRef={settingsBackRef}
            feedLayout={feedLayout}
            onClose={closeSettings}
            onCycleFeedLayout={cycleFeedLayout}
            onCycleTheme={cycleTheme}
            platform={platform}
            theme={theme}
          />
        ) : null}

        {activeTopicId === null || renderTopicOverlay === undefined
          ? null
          : renderTopicOverlay({
              backButtonRef: topicBackRef,
              onClose: closeTopic,
              topicId: activeTopicId,
            })}

        {activeContent === null || renderDetailOverlay === undefined
          ? null
          : renderDetailOverlay({
              backButtonRef: detailBackRef,
              target: activeContent,
              initialScrollTop: detailScrollTopRef.current,
              navigationRevision: detailNavigationRevision,
              onClose: closeDetail,
              onScrollTopChange: updateDetailScrollTop,
            })}

        {activeProfile !== null && renderProfileOverlay
          ? renderProfileOverlay({
              state: activeProfile,
              backButtonRef: profileBackRef,
              onClose: closeProfile,
              onViewChange: updateProfileView,
            })
          : null}
        {activeEditor !== null && renderEditorOverlay ? (
          <Fragment key={editorSession}>
            {renderEditorOverlay(activeEditor.editorTarget, editorControls)}
          </Fragment>
        ) : null}
        <LoadingScreen
          active={bootPending}
          className={styles.loading}
          data-product-boot=""
          delay={0}
        />
      </div>
    </ProductShellContext.Provider>
  );
};
