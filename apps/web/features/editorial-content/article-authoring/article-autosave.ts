import type {
  ArticleDraft,
  ArticleDocument,
  UpdateArticleDraftCommand,
} from "@moya/contracts";
import { createExternalStore } from "../../publishing/upload-manager-store";

export interface ArticleAutosavePort {
  save(
    id: ArticleDraft["id"],
    command: UpdateArticleDraftCommand,
    signal: AbortSignal,
  ): Promise<ArticleDraft>;
  read(id: ArticleDraft["id"], signal: AbortSignal): Promise<ArticleDraft>;
}

export interface ArticleEditorCapture {
  readonly title: string;
  readonly coverRefId: string | null;
  readonly document: ArticleDocument;
}

export interface ArticleAutosaveFailure {
  readonly status: number;
  readonly reason: string | null;
  readonly outcomeUnknown: boolean;
}

export interface ArticleAutosaveSnapshot {
  readonly draft: ArticleDraft;
  readonly editGeneration: number;
  readonly acknowledgedGeneration: number;
  readonly status:
    | "saved"
    | "pending"
    | "saving"
    | "failed"
    | "conflict"
    | "permission_lost"
    | "closed";
  readonly remote: ArticleDraft | null;
  readonly message: string | null;
}

interface SavedAttempt {
  readonly generation: number;
  readonly command: UpdateArticleDraftCommand;
}

/** One bounded, account-fenced save stream. Selection changes never call it. */
export const createArticleAutosave = (options: {
  readonly initial: ArticleDraft;
  readonly client: ArticleAutosavePort;
  readonly currentAccount: () => string | null;
  readonly accountEpoch: () => number;
  readonly capture: () => ArticleEditorCapture;
  readonly requestId: () => string;
  readonly classifyFailure: (error: unknown) => ArticleAutosaveFailure;
  readonly now?: () => number;
  readonly timers?: {
    set(callback: () => void, milliseconds: number): unknown;
    clear(timer: unknown): void;
  };
}) => {
  const epoch = options.accountEpoch();
  const account = options.initial.ownerId;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? {
    set: (callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds),
    clear: (timer: unknown) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  const store = createExternalStore<ArticleAutosaveSnapshot>({
    draft: options.initial,
    editGeneration: 0,
    acknowledgedGeneration: 0,
    status: "saved",
    remote: null,
    message: null,
  });
  const abort = new AbortController();
  let timer: unknown | null = null;
  let firstDirtyAt: number | null = null;
  let composing = false;
  let closed = false;
  let active: Promise<ArticleDraft> | null = null;
  let retryAttempt: SavedAttempt | null = null;
  const sameAccount = () =>
    !closed &&
    options.currentAccount() === account &&
    options.accountEpoch() === epoch;
  const requireAccount = () => {
    if (sameAccount()) return;
    if (closed) throw new Error("article_session_closed");
    store.update((state) => ({
      ...state,
      status: "permission_lost",
      message: "账户已变化，请在原账户中重新打开专题。",
    }));
    throw new Error("article_account_changed");
  };
  const cancelTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const schedule = () => {
    cancelTimer();
    if (composing || closed) return;
    const state = store.get();
    if (
      state.status === "conflict" ||
      state.status === "permission_lost" ||
      state.status === "failed"
    )
      return;
    const waited = firstDirtyAt === null ? 0 : now() - firstDirtyAt;
    timer = timers.set(
      () => {
        timer = null;
        void flush().catch(() => undefined);
      },
      Math.min(800, Math.max(0, 5_000 - waited)),
    );
  };
  const flush = (): Promise<ArticleDraft> => {
    cancelTimer();
    if (active !== null) return active;
    requireAccount();
    const beginning = store.get();
    if (composing)
      return Promise.reject(new Error("article_composition_active"));
    if (beginning.status === "conflict")
      return Promise.reject(new Error("article_changed"));
    if (beginning.status === "permission_lost")
      return Promise.reject(new Error("article_permission_lost"));
    if (beginning.editGeneration === beginning.acknowledgedGeneration)
      return Promise.resolve(beginning.draft);

    const run = async (): Promise<ArticleDraft> => {
      for (;;) {
        requireAccount();
        const before = store.get();
        if (composing) throw new Error("article_composition_active");
        if (before.editGeneration === before.acknowledgedGeneration)
          return before.draft;
        // Capture exactly once for each coalesced attempt. The frozen command
        // and request ID survive an ambiguous network failure unchanged.
        let attempt: SavedAttempt;
        try {
          attempt = retryAttempt ?? {
            generation: before.editGeneration,
            command: {
              requestId: options.requestId(),
              expectedVersion: before.draft.version,
              ...structuredClone(options.capture()),
            },
          };
        } catch (error) {
          store.update((state) => ({
            ...state,
            status: "failed",
            message: "内容超出支持范围或限制。输入仍保留，请调整后重试。",
          }));
          throw error;
        }
        retryAttempt = attempt;
        store.update((state) => ({
          ...state,
          status: "saving",
          message: null,
        }));
        try {
          const saved = await options.client.save(
            before.draft.id,
            attempt.command,
            abort.signal,
          );
          requireAccount();
          if (
            saved.id !== before.draft.id ||
            saved.ownerId !== account ||
            saved.version !== attempt.command.expectedVersion + 1
          )
            throw new Error("article_invalid_save_acknowledgement");
          retryAttempt = null;
          store.update((state) => ({
            ...state,
            draft: saved,
            acknowledgedGeneration: attempt.generation,
            status:
              state.editGeneration === attempt.generation ? "saved" : "pending",
            message: null,
          }));
          if (store.get().status === "saved") firstDirtyAt = null;
          // A late acknowledgement never replaces the active editor document.
          // Edits made during this request become the next version-checked save.
        } catch (error) {
          if (closed) throw error;
          if (!sameAccount()) {
            requireAccount();
            throw error;
          }
          const failure = options.classifyFailure(error);
          if (!failure.outcomeUnknown) retryAttempt = null;
          store.update((state) => ({
            ...state,
            status:
              failure.status === 409
                ? "conflict"
                : failure.status === 401 || failure.status === 403
                  ? "permission_lost"
                  : "failed",
            message:
              failure.status === 409
                ? "专题已由另一窗口或 Agent 更新。当前输入已保留，请比较版本。"
                : failure.status === 401 || failure.status === 403
                  ? "当前授权已失效。输入仍保留，请重新登录原账户。"
                  : failure.outcomeUnknown
                    ? "保存结果尚未确认。重试会核对同一次保存，请勿关闭。"
                    : "保存失败，输入仍保留。请检查内容并重试。",
          }));
          throw error;
        }
      }
    };
    // Schedule asynchronously so active is installed before user code can run.
    active = Promise.resolve()
      .then(run)
      .finally(() => {
        active = null;
        if (store.get().status === "pending") schedule();
      });
    return active;
  };
  return {
    store,
    canMutate: () => sameAccount() && store.get().status !== "permission_lost",
    checkIdentity: () => {
      if (sameAccount() || closed) return;
      cancelTimer();
      abort.abort();
      store.update((state) => ({
        ...state,
        status: "permission_lost",
        message: "账号验证发生变化。输入仍保留，请在原账户中重新打开专题。",
      }));
    },
    changed: () => {
      requireAccount();
      if (firstDirtyAt === null) firstDirtyAt = now();
      store.update((state) => ({
        ...state,
        editGeneration: state.editGeneration + 1,
        status: ["conflict", "permission_lost", "failed"].includes(state.status)
          ? state.status
          : "pending",
      }));
      if (active === null) schedule();
    },
    composition: (value: boolean) => {
      composing = value;
      if (value) cancelTimer();
      else if (store.get().editGeneration > store.get().acknowledgedGeneration)
        schedule();
    },
    flush,
    retry: () => {
      if (store.get().status !== "failed")
        return Promise.reject(new Error("article_retry_unavailable"));
      store.update((state) => ({ ...state, status: "pending", message: null }));
      return flush();
    },
    inspectRemote: async () => {
      requireAccount();
      const remote = await options.client.read(
        store.get().draft.id,
        abort.signal,
      );
      requireAccount();
      if (remote.id !== store.get().draft.id || remote.ownerId !== account)
        throw new Error("article_invalid_remote");
      store.update((state) => ({ ...state, remote }));
      return remote;
    },
    /** Preview/publish may discover staleness even when no local edit exists. */
    noteCandidateConflict: () => {
      requireAccount();
      cancelTimer();
      retryAttempt = null;
      store.update((state) => ({
        ...state,
        editGeneration:
          state.status === "conflict"
            ? state.editGeneration
            : Math.max(state.editGeneration, state.acknowledgedGeneration + 1),
        status: "conflict",
        remote: null,
        message: "专题已由另一窗口或 Agent 更新。当前内容已保留，请比较版本。",
      }));
    },
    /** Explicit compare-and-keep action; never called automatically on 409. */
    keepLocalAfterComparison: () => {
      requireAccount();
      const state = store.get();
      if (state.status !== "conflict" || state.remote === null)
        throw new Error("article_comparison_required");
      retryAttempt = null;
      store.set({
        ...state,
        draft: state.remote,
        editGeneration: Math.max(
          state.editGeneration,
          state.acknowledgedGeneration + 1,
        ),
        remote: null,
        status: "pending",
        message: null,
      });
      return flush();
    },
    publicationCheckpoint: () => {
      requireAccount();
      const state = store.get();
      if (
        active !== null ||
        state.status !== "saved" ||
        state.editGeneration !== state.acknowledgedGeneration
      )
        throw new Error("article_publication_requires_saved_candidate");
      return {
        version: state.draft.version,
        fingerprint: state.draft.fingerprint,
        generation: state.acknowledgedGeneration,
      };
    },
    /** Advance the observed server revision without replacing active input. */
    adoptPublicationResult: (
      draft: ArticleDraft,
      checkpoint: {
        readonly version: number;
        readonly fingerprint: string;
        readonly generation: number;
      },
    ) => {
      requireAccount();
      const state = store.get();
      if (
        active !== null ||
        retryAttempt !== null ||
        state.draft.version !== checkpoint.version ||
        state.draft.fingerprint !== checkpoint.fingerprint ||
        state.acknowledgedGeneration !== checkpoint.generation ||
        draft.id !== state.draft.id ||
        draft.ownerId !== account ||
        draft.version !== checkpoint.version + 1 ||
        draft.fingerprint !== checkpoint.fingerprint ||
        (draft.status !== "pending" && draft.status !== "published")
      )
        throw new Error("article_publication_result_changed");
      store.set({
        ...state,
        draft,
        status:
          state.editGeneration === checkpoint.generation ? "saved" : "pending",
        remote: null,
        message: null,
      });
      if (store.get().status === "pending") schedule();
    },
    isDirty: () => {
      const state = store.get();
      return state.editGeneration !== state.acknowledgedGeneration;
    },
    dispose: () => {
      closed = true;
      cancelTimer();
      abort.abort();
      retryAttempt = null;
      store.update((state) => ({ ...state, status: "closed", remote: null }));
    },
  };
};

export type ArticleAutosave = ReturnType<typeof createArticleAutosave>;
