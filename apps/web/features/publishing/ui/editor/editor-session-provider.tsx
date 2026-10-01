"use client";

import { useBeforeAuth } from "../../../auth/auth-return";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useUploadSession } from "../../publishing-provider";
import { createBrowserEditorRecovery } from "../../editor-recovery";
import { contentOf, createEditorSessionStore } from "./editor-session-state";

import type {
  EditorSessionState,
  EditorSessionStore,
} from "./editor-session-state";
import type { EditorTarget } from "../../../product-shell/product-history";
import type { WorkDraftContent } from "@moya/contracts";
import type { ReactNode } from "react";

/**
 * The account-scoped editor registry: at most one editor session store per
 * account, living above the shell's editor host (so it survives the overlay
 * closing while uploads continue) and inside the publishing provider (so it
 * ends with the runtime session it describes).
 */
export class EditorSessionRegistry {
  readonly recovery = createBrowserEditorRecovery();
  private readonly stores = new Map<string, EditorSessionStore>();
  private readonly listeners = new Set<() => void>();
  private readonly mounted = new Map<string, number>();
  private readonly closeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly leaving = new Map<string, "discarded" | "completed">();
  private readonly seen = new Set<string>();
  /** The runtime's confirmed account (kept current by the provider). */
  accountId: string | null = null;

  /** The runtime session behind this store has started. */
  markSessionSeen(store: EditorSessionStore): void {
    this.seen.add(store.key);
  }

  sessionSeen(store: EditorSessionStore): boolean {
    return this.seen.has(store.key);
  }

  /** The author discarded the session or it was submitted: nothing is kept on leaving. */
  markLeaving(store: EditorSessionStore, reason: "discarded" | "completed") {
    this.leaving.set(store.key, reason);
    this.recovery?.discard(store.accountId);
  }

  leavingReason(store: EditorSessionStore): "discarded" | "completed" | null {
    return this.leaving.get(store.key) ?? null;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  current(accountId: string | null): EditorSessionStore | null {
    return accountId === null ? null : (this.stores.get(accountId) ?? null);
  }

  byKey(sessionKey: string): EditorSessionStore | null {
    for (const store of this.stores.values())
      if (store.key === sessionKey) return store;
    return null;
  }

  create(accountId: string, target: EditorTarget): EditorSessionStore {
    const existing = this.stores.get(accountId);
    if (existing) return existing;
    const store = createEditorSessionStore(accountId, target);
    this.stores.set(accountId, store);
    this.notify();
    return store;
  }

  dispose(store: EditorSessionStore): void {
    if (this.stores.get(store.accountId) !== store) return;
    this.cancelClose(store);
    this.recovery?.discard(store.accountId);
    this.stores.delete(store.accountId);
    this.mounted.delete(store.key);
    this.leaving.delete(store.key);
    this.seen.delete(store.key);
    this.notify();
  }

  /** An editor host shows this store; a pending deferred close is cancelled. */
  mount(store: EditorSessionStore): () => void {
    this.cancelClose(store);
    this.mounted.set(store.key, (this.mounted.get(store.key) ?? 0) + 1);
    return () =>
      this.mounted.set(
        store.key,
        Math.max(0, (this.mounted.get(store.key) ?? 1) - 1),
      );
  }

  isMounted(store: EditorSessionStore): boolean {
    return (this.mounted.get(store.key) ?? 0) > 0;
  }

  /**
   * Runs `close` after the current commit unless the store is shown again
   * (React StrictMode replays effects; a remount must not end the session).
   */
  deferClose(store: EditorSessionStore, close: () => void): void {
    this.cancelClose(store);
    this.closeTimers.set(
      store.key,
      setTimeout(() => {
        this.closeTimers.delete(store.key);
        if (!this.isMounted(store)) close();
      }, 0),
    );
  }

  private cancelClose(store: EditorSessionStore): void {
    const timer = this.closeTimers.get(store.key);
    if (timer !== undefined) clearTimeout(timer);
    this.closeTimers.delete(store.key);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const RegistryContext = createContext<EditorSessionRegistry | null>(null);

/** Place inside `PublishingProvider`, above the product shell. */
export const EditorSessionProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [registry] = useState(() => new EditorSessionRegistry());
  const upload = useUploadSession();
  const { accountId, session } = upload;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  registry.accountId = accountId;
  const current = useSyncExternalStore(
    registry.subscribe,
    () => registry.current(accountId),
    () => null,
  );

  useEffect(() => {
    if (!current) return;
    let generation = 0;
    let active = true;
    const persist = () => {
      const state = current.get();
      if (state.phase !== "ready" || registry.leavingReason(current)) return;
      const checkpoint = uploadRef.current.checkpoint?.();
      if (!checkpoint) return;
      const intent = ++generation;
      const work = registry.recovery
        ? registry.recovery.save(state, {
            ...checkpoint,
            content: contentOf(state),
          })
        : Promise.resolve(false);
      if (work)
        void work.then((saved) => {
          if (
            !active ||
            generation !== intent ||
            registry.leavingReason(current)
          )
            return;
          const warning = "本机恢复未能保存，请先保存草稿再离开，避免内容丢失";
          const atRisk =
            uploadRef.current.hasUnsavedChanges() ||
            checkpoint.pendingFiles.length > 0;
          if (!saved && atRisk && current.get().notice === null)
            current.setNotice(warning);
          else if ((saved || !atRisk) && current.get().notice === warning)
            current.setNotice(null);
        });
    };
    persist();
    const unsubscribe = current.subscribe(persist);
    const background = () => persist();
    document.addEventListener("visibilitychange", background);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", background);
    };
  }, [registry, current, upload]);

  useBeforeAuth(async () => {
    const store = registry.current(accountId);
    if (!store || registry.leavingReason(store)) return true;
    const state = store.get();
    const checkpoint = uploadRef.current.checkpoint?.();
    if (state.phase !== "ready" || !checkpoint) return true;
    const saved = await registry.recovery?.save(state, {
      ...checkpoint,
      content: contentOf(state),
    });
    if (
      !saved &&
      (uploadRef.current.hasUnsavedChanges() ||
        checkpoint.pendingFiles.length > 0)
    ) {
      store.setNotice("本机恢复未能保存，请先保存草稿再离开，避免内容丢失");
      return false;
    }
    return true;
  });

  // A session that ended while no editor showed it (e.g. its last upload was
  // discarded elsewhere) leaves nothing to return to. A store whose runtime
  // session has not started yet is never pruned.
  useEffect(() => {
    const store = registry.current(accountId);
    if (store === null) return;
    if (session !== null) {
      registry.markSessionSeen(store);
      return;
    }
    if (registry.sessionSeen(store) && !registry.isMounted(store))
      registry.dispose(store);
  }, [registry, accountId, session]);

  return (
    <RegistryContext.Provider value={registry}>
      {children}
    </RegistryContext.Provider>
  );
};

export const useEditorSessionRegistry = (): EditorSessionRegistry => {
  const registry = useContext(RegistryContext);
  if (registry === null)
    throw new Error("Editor sessions require EditorSessionProvider");
  return registry;
};

const noSubscription = () => () => undefined;

export const useEditorStoreState = (
  store: EditorSessionStore | null,
): EditorSessionState | null =>
  useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store?.get() ?? null,
    () => store?.get() ?? null,
  );

export interface EditorSessionHandle {
  readonly state: EditorSessionState;
  readonly content: WorkDraftContent;
  /** Album and text actions (see editor-session-state.ts). */
  readonly actions: EditorSessionStore;
}

/**
 * The editor session a media or drafts component belongs to, by the
 * `sessionKey` the editor passed down; null once that session has ended.
 */
export const useEditorSession = (
  sessionKey: string,
): EditorSessionHandle | null => {
  const registry = useEditorSessionRegistry();
  const store = useSyncExternalStore(
    registry.subscribe,
    () => registry.byKey(sessionKey),
    () => registry.byKey(sessionKey),
  );
  const state = useEditorStoreState(store);
  return useMemo(
    () =>
      store === null || state === null
        ? null
        : { state, content: contentOf(state), actions: store },
    [store, state],
  );
};
