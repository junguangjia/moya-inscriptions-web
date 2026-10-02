"use client";

import { Icon } from "@moya/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuthors } from "../../../authors/author-context";
import { authorClient } from "../../../../lib/public-api/author-community-client";
import { articleAuthoringClient } from "../../../../lib/public-api/article-authoring-client";
import { useArticleDrafts } from "../../../editorial-content/article-authoring/article-drafts-panel";
import { useDraftSelectionGesture } from "./drafts-selection";
import { AuthorDialog } from "../../../authors/author-dialog";
import { publishingClient } from "../../publishing-data";
import { useUploadSession } from "../../publishing-provider";
import {
  absoluteTime,
  displayTitle,
  draftDeletionScopeText,
  draftKindLabel,
  draftName,
  mediaCountText,
  missingLocalText,
  newestEditedFirst,
  relativeTime,
  textExcerpt,
} from "./drafts-format";
import { createIntentIds, failureText, isAbort } from "./drafts-intent";
import {
  ConfirmPanel,
  CoverThumb,
  useFocusAfterRemoval,
} from "./drafts-shared";
import styles from "./drafts.module.css";
import homeStyles from "../../../home/home-screen.module.css";

import type {
  ArticleDraftSummary,
  PublishingDraftDeletionResult,
  PublishingDraftSummary,
} from "@moya/contracts";

const PAGE_SIZE = 20;

interface PickerList {
  readonly items: readonly PublishingDraftSummary[];
  readonly page: number;
  readonly total: number;
}

const deletionReport = (result: PublishingDraftDeletionResult): string => {
  const parts = [
    result.snapshots > 0 ? `${result.snapshots} 个历史版本` : null,
    result.conflictCopies > 0 ? `${result.conflictCopies} 个冲突副本` : null,
    result.mediaItems > 0 ? `${result.mediaItems} 项图片` : null,
  ].filter((part) => part !== null);
  return parts.length === 0
    ? "草稿已删除"
    : `草稿已删除，同时删除了 ${parts.join("、")}`;
};

/**
 * The owner's drafts, newest edited first (D03). Opening hands the draft to
 * the editor; deleting names exactly that draft and its targeted scope (its
 * history, conflict copies and media only they reference), never another
 * draft or any work revision (D06). The draft of an editor session that is
 * still running (uploads, unsaved input) cannot be deleted here: its uploads
 * and next save would fail against a draft that no longer exists.
 */
export const DraftsPicker = ({
  accountId,
  onClose,
  onOpenDraft,
  onChanged,
  articleEnabled = false,
  onOpenArticle,
}: {
  /** The confirmed viewer; this browser's local copies of a deleted draft are cleared for it. */
  readonly accountId: string;
  /** Existing Development availability; false preserves the Work-only box. */
  readonly articleEnabled?: boolean;
  readonly onOpenArticle?: (id: string) => void;
  readonly onClose: () => void;
  /** Called with the chosen draft; the caller closes this picker before the editor opens. */
  readonly onOpenDraft: (draftId: string) => void;
  /** The account's draft total after a load or a deletion. */
  readonly onChanged?: (
    total: number,
    newest: PublishingDraftSummary | null,
  ) => void;
}) => {
  const hasArticles = articleEnabled && onOpenArticle !== undefined;
  const author = useAuthors();
  const articles = useArticleDrafts(accountId, hasArticles);
  const accountEpoch = authorClient.accountEpoch();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [list, setList] = useState<PickerList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    readonly id: string;
    readonly text: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** Items of each listed draft this browser still holds locally (by draft id). */
  const [localCounts, setLocalCounts] = useState<
    Readonly<Record<string, number>>
  >({});
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const upload = useUploadSession();
  // The kept editor session's draft (the profile shows only while the editor is closed).
  const activeDraftId =
    upload.session === null
      ? null
      : (upload.autosave?.draftId ?? upload.session.draftId);
  const state = useRef<PickerList | null>(null);
  const deleted = useRef(0);
  const failed = useRef<{ from: number; through: number }>({
    from: 1,
    through: 1,
  });
  const intents = useRef(createIntentIds());
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ onChanged, upload, activeDraftId });
  latest.current = { onChanged, upload, activeDraftId };

  /**
   * Reads pages `from`..`through` and merges them by id. After deletions the
   * account's pages shift, so "load more" starts early enough to catch the
   * drafts that moved up.
   */
  const load = useCallback(
    async (from: number, through = from) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setLoading(true);
      setLoadError("");
      const epoch = authorClient.accountEpoch();
      try {
        if (hasArticles && authorClient.account() !== accountId)
          throw new Error("account_unconfirmed");
        let merged: readonly PublishingDraftSummary[] =
          from === 1 ? [] : (state.current?.items ?? []);
        let total = 0;
        let lastPage = from;
        for (let page = from; page <= through; page++) {
          const result = await publishingClient.listDrafts(
            { page, pageSize: PAGE_SIZE },
            current.signal,
          );
          if (current.signal.aborted) return;
          if (
            hasArticles &&
            (authorClient.account() !== accountId ||
              authorClient.accountEpoch() !== epoch)
          )
            throw new Error("account_changed");
          merged = [
            ...merged,
            ...result.items.filter(
              (item) => !merged.some((known) => known.id === item.id),
            ),
          ].sort(newestEditedFirst);
          total = result.total;
          lastPage = page;
          if (page === 1) latest.current.onChanged?.(total, merged[0] ?? null);
        }
        deleted.current = 0;
        const next = { items: merged, page: lastPage, total };
        state.current = next;
        setList(next);
      } catch (error) {
        if (current.signal.aborted || isAbort(error)) return;
        failed.current = { from, through };
        setLoadError(failureText(error, "草稿读取失败"));
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    },
    [accountId, hasArticles],
  );

  const loadMore = () => {
    const current = state.current;
    if (current === null) return void load(1);
    const shiftedStart = current.page * PAGE_SIZE - deleted.current;
    void load(
      Math.max(1, Math.floor(shiftedStart / PAGE_SIZE) + 1),
      current.page + 1,
    );
  };

  useEffect(() => {
    if (
      hasArticles &&
      (author.checking ||
        author.sessionError ||
        author.viewer?.id !== accountId ||
        authorClient.account() !== accountId)
    ) {
      controller.current?.abort();
      state.current = null;
      setList(null);
      setLoading(false);
      return;
    }
    void load(1, Math.max(1, state.current?.page ?? 1));
    return () => controller.current?.abort();
  }, [
    load,
    accountId,
    hasArticles,
    accountEpoch,
    author.checking,
    author.sessionError,
    author.viewer?.id,
  ]);

  // The account counts items no device has uploaded yet; the ones this
  // browser still holds (recoverable on opening) are not missing here.
  const pendingDrafts = (list?.items ?? [])
    .filter((draft) => draft.missingLocalCount > 0)
    .map((draft) => draft.id)
    .join(" ");
  useEffect(() => {
    if (pendingDrafts === "") return undefined;
    let active = true;
    const runtime = latest.current.upload;
    if (runtime.accountId !== accountId) return undefined;
    for (const id of pendingDrafts.split(" ")) {
      if (id in localCounts) continue;
      void runtime
        .countLocalDraftItems(id)
        .catch(() => 0)
        .then((count) => {
          if (active)
            setLocalCounts((current) =>
              id in current ? current : { ...current, [id]: count },
            );
        });
    }
    return () => {
      active = false;
    };
  }, [accountId, localCounts, pendingDrafts]);

  const focusAfterRemoval = useFocusAfterRemoval(
    (list?.items.length ?? 0) + articles.items.length,
    {
      list: listRef,
      empty: emptyRef,
      panel: panelRef,
    },
  );

  const remove = async (
    draft: PublishingDraftSummary,
    expectedRevision?: number,
  ) => {
    if (deleting !== null) return false;
    if (latest.current.activeDraftId === draft.id) {
      setConfirming(null);
      return false;
    }
    const intent = `delete:${draft.id}`;
    setDeleting(draft.id);
    setRowError(null);
    try {
      const result = await publishingClient.deleteDraft(draft.id, {
        requestId: intents.current.take(intent),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      intents.current.settle(intent);
      workDeletionRevisions.current.delete(draft.id);
      // This browser's copies go through the runtime that owns them, and only
      // for the account that deleted the draft.
      const runtime = latest.current.upload;
      if (runtime.accountId === accountId)
        await runtime.forgetDraftLocalCopies(draft.id).catch(() => undefined);
      setConfirming(null);
      const before = state.current;
      const next =
        before === null
          ? null
          : {
              ...before,
              items: before.items.filter((item) => item.id !== draft.id),
              total: Math.max(0, before.total - 1),
            };
      state.current = next;
      deleted.current += 1;
      setList(next);
      setAnnouncement(deletionReport(result));
      latest.current.onChanged?.(next?.total ?? 0, next?.items[0] ?? null);
      focusAfterRemoval();
      // The last shown draft is gone but later pages exist: read them again.
      if (next !== null && next.items.length === 0 && next.total > 0)
        void load(1);
      return true;
    } catch (error) {
      intents.current.settle(intent, error);
      if (!(
        error instanceof Error &&
        "outcomeUnknown" in error &&
        error.outcomeUnknown
      ))
        workDeletionRevisions.current.delete(draft.id);
      const text = failureText(error, "删除未完成");
      setRowError({ id: draft.id, text });
      setBulkErrors((current) => ({ ...current, [draft.id]: text }));
      return false;
    } finally {
      setDeleting(null);
    }
  };

  const now = new Date();
  const items = hasArticles && !articles.confirmed ? [] : (list?.items ?? []);
  const more = list !== null && items.length < list.total;
  type Entry =
    | { readonly kind: "work"; readonly draft: PublishingDraftSummary }
    | { readonly kind: "article"; readonly draft: ArticleDraftSummary };
  const entries: readonly Entry[] = [
    ...items.map((draft): Entry => ({ kind: "work", draft })),
    ...articles.items.map((draft): Entry => ({ kind: "article", draft })),
  ].sort((a, b) => newestEditedFirst(a.draft, b.draft));
  const confirmed = !hasArticles || articles.confirmed;
  const busy = bulkBusy || deleting !== null;
  const authority = useRef({
    confirmed,
    checking: author.checking,
    sessionError: author.sessionError,
  });
  authority.current = {
    confirmed,
    checking: author.checking,
    sessionError: author.sessionError,
  };
  const workDeletionRevisions = useRef(new Map<string, number>());
  const articleDeletionVersions = useRef(new Map<string, number>());
  const prepared = useRef<readonly { entry: Entry; revision?: number }[]>([]);
  const [confirmCount, setConfirmCount] = useState(0);
  const allowed = () =>
    !busy &&
    !confirmBulk &&
    confirmed &&
    (!hasArticles ||
      (!author.checking &&
        !author.sessionError &&
        authorClient.account() === accountId &&
        authorClient.accountEpoch() === accountEpoch));
  const toggle = (id: string) => {
    if (!allowed() || id === activeDraftId) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const gesture = useDraftSelectionGesture(
    `${accountId}:${accountEpoch}:${confirmed}`,
    (id) => {
      if (!allowed()) return;
      setSelecting(true);
      toggle(id);
    },
    allowed,
  );
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
    setConfirmBulk(false);
    setBulkErrors({});
    prepared.current = [];
    workDeletionRevisions.current.clear();
    articleDeletionVersions.current.clear();
  }, [accountId, accountEpoch, confirmed]);
  const currentAccount = (epoch: number) =>
    (!hasArticles ||
      (authority.current.confirmed &&
        !authority.current.checking &&
        !authority.current.sessionError &&
        authorClient.account() === accountId &&
        authorClient.accountEpoch() === epoch)) &&
    latest.current.upload.accountId === accountId;
  const prepareDeletion = async () => {
    if (!allowed()) return;
    const candidates = entries.filter(
      (entry) =>
        selected.has(entry.draft.id) && entry.draft.id !== activeDraftId,
    );
    const epoch = authorClient.accountEpoch();
    setBulkBusy(true);
    setBulkErrors({});
    const ready: { entry: Entry; revision?: number }[] = [];
    for (const entry of candidates) {
      if (!currentAccount(epoch)) break;
      if (entry.kind === "article") {
        ready.push({ entry });
        continue;
      }
      try {
        const retained = workDeletionRevisions.current.get(entry.draft.id);
        const draft =
          retained === undefined
            ? await publishingClient.draft(entry.draft.id)
            : null;
        if (!currentAccount(epoch)) break;
        if (draft !== null && draft.updatedAt !== entry.draft.updatedAt)
          throw new Error("draft_changed");
        ready.push({ entry, revision: retained ?? draft!.revision });
      } catch {
        setBulkErrors((old) => ({
          ...old,
          [entry.draft.id]: "草稿已变化或暂时无法确认，请刷新草稿后重选。",
        }));
      }
    }
    prepared.current = ready;
    setConfirmCount(ready.length);
    setBulkBusy(false);
    if (currentAccount(epoch) && ready.length > 0) setConfirmBulk(true);
  };
  const removeSelected = async () => {
    if (busy || !confirmed) return;
    const candidates = prepared.current;
    const epoch = authorClient.accountEpoch();
    const stillOwned = () => currentAccount(epoch);
    if (!stillOwned()) return;
    setBulkBusy(true);
    setBulkErrors({});
    let successes = 0;
    for (const { entry, revision } of candidates) {
      if (!stillOwned() || entry.draft.id === latest.current.activeDraftId)
        break;
      let success = false;
      if (entry.kind === "work") {
        workDeletionRevisions.current.set(entry.draft.id, revision!);
        success = await remove(entry.draft, revision);
      } else {
        const intent = `delete:${entry.draft.id}`;
        try {
          const expectedVersion =
            articleDeletionVersions.current.get(entry.draft.id) ??
            entry.draft.version;
          articleDeletionVersions.current.set(entry.draft.id, expectedVersion);
          await articleAuthoringClient.deleteDraft(entry.draft.id, {
            requestId: intents.current.take(intent),
            expectedVersion,
          });
          intents.current.settle(intent);
          articleDeletionVersions.current.delete(entry.draft.id);
          if (!stillOwned()) break;
          articles.forget(entry.draft.id);
          success = true;
        } catch (error) {
          // Preserve the same request id when the committed outcome is unknown.
          if (!(
            error instanceof Error &&
            "outcomeUnknown" in error &&
            error.outcomeUnknown
          )) {
            intents.current.settle(intent);
            articleDeletionVersions.current.delete(entry.draft.id);
          }
          setBulkErrors((current) => ({
            ...current,
            [entry.draft.id]: "删除未完成，请刷新确认版本后重试。",
          }));
        }
      }
      if (!stillOwned()) break;
      if (success) {
        successes += 1;
        setSelected((current) => {
          const next = new Set(current);
          next.delete(entry.draft.id);
          return next;
        });
      }
    }
    setConfirmBulk(false);
    setBulkBusy(false);
    setAnnouncement(
      stillOwned()
        ? `已删除 ${successes} 份草稿${successes < candidates.length ? `，${candidates.length - successes} 份未完成，保留选择供重试。` : "。"}`
        : "账号已变化，后续删除已停止。请重新确认当前账号。",
    );
  };

  return (
    <AuthorDialog
      dismissible={!busy}
      onClose={onClose}
      title={hasArticles ? "草稿箱" : "草稿"}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        data-drafts-picker=""
        tabIndex={-1}
        {...(hasArticles ? gesture : {})}
      >
        {hasArticles ? (
          <div className={`${styles.actions} ${styles.selectionBar}`}>
            <p className={styles.lead}>
              {selecting
                ? `已选择 ${selected.size} 份草稿`
                : "按最近编辑排列，长按卡片可多选。"}
            </p>
            <button
              className={styles.button}
              type="button"
              disabled={busy || confirmBulk || !confirmed}
              onClick={() => {
                setSelecting(!selecting);
                setSelected(new Set());
                setConfirmBulk(false);
              }}
            >
              {selecting ? "取消选择" : "选择"}
            </button>
            {selecting ? (
              <>
                <button
                  className={styles.button}
                  type="button"
                  disabled={busy || confirmBulk || !confirmed}
                  onClick={() => {
                    if (allowed())
                      setSelected(
                        new Set(
                          entries
                            .filter((entry) => entry.draft.id !== activeDraftId)
                            .map((entry) => entry.draft.id),
                        ),
                      );
                  }}
                >
                  全选
                </button>
                <button
                  className={`${styles.button} ${styles.quiet}`}
                  type="button"
                  disabled={busy || confirmBulk || selected.size === 0}
                  onClick={() => void prepareDeletion()}
                >
                  删除所选（{selected.size}）
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <p className={styles.lead}>草稿仅自己可见，按最近编辑排列。</p>
        )}
        {confirmBulk ? (
          <ConfirmPanel
            busy={bulkBusy}
            busyLabel="正在删除…"
            confirmLabel="删除所选草稿"
            title={`删除 ${confirmCount} 份草稿？`}
            description="将删除所选私有草稿及其仅在草稿中使用的媒体。已公开的作品、专题版本不受影响。此操作无法撤销。"
            onCancel={() => setConfirmBulk(false)}
            onConfirm={() => void removeSelected()}
          />
        ) : null}
        {hasArticles && articles.loading ? (
          <p role="status" className={styles.status}>
            正在读取专题草稿…
          </p>
        ) : null}
        {hasArticles && articles.error ? (
          <p className={styles.alert} role="alert">
            {articles.error}
            <button
              type="button"
              className={styles.button}
              disabled={busy || articles.loading}
              onClick={() => {
                setSelected(new Set());
                prepared.current = [];
                articles.refresh();
              }}
            >
              重试专题草稿
            </button>
          </p>
        ) : null}
        {hasArticles ? (
          <button
            type="button"
            className={styles.button}
            disabled={busy || confirmBulk || loading || articles.loading}
            onClick={() => {
              setSelected(new Set());
              prepared.current = [];
              setAnnouncement("已刷新草稿，请重新选择需要删除的项。");
              void load(1);
              articles.refresh();
            }}
          >
            刷新草稿
          </button>
        ) : null}
        <p aria-live="polite" className={styles.status} role="status">
          {loading && list === null ? "正在读取草稿…" : announcement}
        </p>
        {loadError !== "" ? (
          <p className={styles.alert} role="alert">
            {loadError}
            <button
              aria-disabled={loading || undefined}
              className={styles.button}
              onClick={() => {
                if (loading) return;
                // The alert holding this button goes away while reading.
                panelRef.current?.focus({ preventScroll: true });
                void load(failed.current.from, failed.current.through);
              }}
              type="button"
            >
              重试
            </button>
          </p>
        ) : null}
        {list !== null &&
        entries.length === 0 &&
        loadError === "" &&
        (!hasArticles || (articles.loaded && articles.error === null)) ? (
          <p ref={emptyRef} className={styles.empty} tabIndex={-1}>
            <Icon name="empty" />
            <span>暂无草稿</span>
          </p>
        ) : null}
        <ul
          ref={listRef}
          aria-label="草稿列表"
          className={`${styles.list} ${styles.draftGrid}`}
          hidden={entries.length === 0}
          tabIndex={-1}
        >
          {entries.map((entry) => {
            if (entry.kind === "article") {
              const draft = entry.draft;
              return (
                <li
                  key={draft.id}
                  className={`${homeStyles.card} ${homeStyles.feedCard} ${styles.row} ${styles.draftCard}`}
                  data-draft-id={draft.id}
                  data-article-draft-id={draft.id}
                  data-draft-kind="article"
                  data-selected={selected.has(draft.id) ? "true" : undefined}
                  onClick={(event) => {
                    if (
                      !allowed() ||
                      (event.target instanceof Element &&
                        event.target.closest("button,a,input,label"))
                    )
                      return;
                    if (selecting) toggle(draft.id);
                    else onOpenArticle?.(draft.id);
                  }}
                >
                  {selecting ? (
                    <label className={styles.selectionCheck}>
                      <input
                        type="checkbox"
                        aria-label={`选择${draft.title || "未命名专题"}`}
                        checked={selected.has(draft.id)}
                        disabled={busy || confirmBulk}
                        onChange={() => toggle(draft.id)}
                      />
                    </label>
                  ) : null}
                  <div
                    className={`${styles.rowBody} ${styles.articleCardBody}`}
                    role={selecting ? undefined : "button"}
                    tabIndex={selecting ? undefined : 0}
                    aria-label={
                      selecting
                        ? undefined
                        : `打开${draft.title.trim() || "未命名专题"}`
                    }
                    aria-disabled={!allowed() || undefined}
                    onKeyDown={(event) => {
                      if (
                        selecting ||
                        (event.key !== "Enter" && event.key !== " ")
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (allowed()) onOpenArticle?.(draft.id);
                    }}
                  >
                    <p className={styles.label}>专题文章</p>
                    <h3 className={styles.rowTitle}>
                      {draft.title.trim() || "未命名专题"}
                    </h3>
                    <p className={styles.meta}>
                      <span>
                        {
                          (
                            {
                              draft: "草稿",
                              pending: "审核中",
                              published: "已公开",
                              withdrawn: "已撤回",
                            } as const
                          )[draft.status]
                        }
                      </span>
                      <time
                        dateTime={draft.updatedAt}
                        title={absoluteTime(draft.updatedAt)}
                      >
                        {relativeTime(draft.updatedAt, now)}编辑
                      </time>
                    </p>
                    {bulkErrors[draft.id] ? (
                      <p role="alert" className={styles.alert}>
                        {bulkErrors[draft.id]}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            }
            const draft = entry.draft;
            const title = displayTitle(draft.title);
            const excerpt = textExcerpt(draft.excerpt, 80);
            const headingId = `draft-heading-${draft.id}`;
            const updated = relativeTime(draft.updatedAt, now);
            const active = draft.id === activeDraftId;
            const activeNoteId = `draft-active-${draft.id}`;
            // Said only once this browser's own copies are known.
            const local = localCounts[draft.id];
            const missingHere =
              local === undefined
                ? 0
                : Math.max(0, draft.missingLocalCount - local);
            return (
              <li
                key={draft.id}
                className={`${homeStyles.card} ${homeStyles.feedCard} ${styles.row} ${styles.draftCard}`}
                data-draft-active={active ? "" : undefined}
                data-draft-id={draft.id}
                data-draft-kind={draft.kind}
                data-selected={selected.has(draft.id) ? "true" : undefined}
                onClick={(event) => {
                  if (
                    !hasArticles ||
                    !allowed() ||
                    (event.target instanceof Element &&
                      event.target.closest("button,a,input,label"))
                  )
                    return;
                  if (selecting) toggle(draft.id);
                  else onOpenDraft(draft.id);
                }}
              >
                {selecting ? (
                  <label className={styles.selectionCheck}>
                    <input
                      type="checkbox"
                      aria-label={`选择${title}`}
                      checked={selected.has(draft.id)}
                      disabled={busy || confirmBulk || active}
                      onChange={() => toggle(draft.id)}
                    />
                  </label>
                ) : null}
                {draft.itemCount > 0 ? (
                  <CoverThumb
                    className={`${styles.thumb} ${styles.draftCover}`}
                    src={draft.coverSrc}
                    text=""
                  />
                ) : null}
                <div
                  className={styles.rowBody}
                  role={hasArticles && !selecting ? "button" : undefined}
                  tabIndex={hasArticles && !selecting ? 0 : undefined}
                  aria-labelledby={
                    hasArticles && !selecting ? headingId : undefined
                  }
                  aria-disabled={hasArticles && !allowed() ? true : undefined}
                  onKeyDown={(event) => {
                    if (
                      !hasArticles ||
                      selecting ||
                      (event.key !== "Enter" && event.key !== " ")
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (allowed()) onOpenDraft(draft.id);
                  }}
                >
                  {draft.kind === "new" ? (
                    <>
                      <p className={styles.label} data-draft-label="">
                        {draftKindLabel(draft)}
                      </p>
                      <h3
                        className={styles.rowTitle}
                        data-unnamed={
                          draft.title.trim() === "" ? "" : undefined
                        }
                        id={headingId}
                      >
                        {title}
                      </h3>
                    </>
                  ) : (
                    // An edit names its work in the heading itself.
                    <h3
                      className={styles.rowTitle}
                      data-draft-label=""
                      id={headingId}
                    >
                      {draftKindLabel(draft)}
                    </h3>
                  )}
                  {excerpt !== "" ? (
                    <p className={styles.excerpt}>{excerpt}</p>
                  ) : null}
                  <p className={styles.meta}>
                    <span>{mediaCountText(draft.itemCount)}</span>
                    <time
                      dateTime={draft.updatedAt}
                      title={absoluteTime(draft.updatedAt)}
                    >
                      {updated === "" ? "" : `${updated}编辑`}
                    </time>
                    {/* A running session still holds its files. */}
                    {missingHere > 0 && !active ? (
                      <span className={styles.warning} data-missing-local="">
                        {missingLocalText(missingHere)}
                      </span>
                    ) : null}
                  </p>
                  {active ? (
                    <p className={styles.notice} id={activeNoteId}>
                      <span className={styles.label} data-draft-active-label="">
                        正在编辑
                      </span>{" "}
                      这项编辑还在进行，结束后才能删除这份草稿
                    </p>
                  ) : null}
                  {!hasArticles && !selecting ? (
                    <div className={styles.actions}>
                      <button
                        aria-describedby={headingId}
                        className={`${styles.button} ${styles.primary}`}
                        disabled={busy || !confirmed}
                        onClick={() => {
                          if (allowed()) onOpenDraft(draft.id);
                        }}
                        type="button"
                      >
                        继续编辑
                      </button>
                      {!hasArticles ? (
                        <button
                          aria-describedby={
                            active ? `${headingId} ${activeNoteId}` : headingId
                          }
                          aria-expanded={confirming === draft.id}
                          className={`${styles.button} ${styles.quiet}`}
                          disabled={deleting !== null || active}
                          onClick={() => {
                            setRowError(null);
                            setConfirming(draft.id);
                          }}
                          type="button"
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {confirming === draft.id && !active ? (
                  <ConfirmPanel
                    busy={deleting === draft.id}
                    busyLabel="正在删除…"
                    confirmLabel="删除草稿"
                    description={draftDeletionScopeText(draft, now)}
                    onCancel={() => {
                      setRowError(null);
                      setConfirming(null);
                    }}
                    onConfirm={() => void remove(draft)}
                    title={`删除${draftName(draft)}？`}
                  />
                ) : null}
                {bulkErrors[draft.id] || rowError?.id === draft.id ? (
                  <p className={styles.alert} role="alert">
                    {bulkErrors[draft.id] ?? rowError?.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {more && loadError === "" ? (
          <button
            aria-disabled={loading || busy || confirmBulk || undefined}
            className={`${styles.button} ${styles.loadMore}`}
            onClick={() => {
              if (!loading && !busy && !confirmBulk) loadMore();
            }}
            type="button"
          >
            加载更多
          </button>
        ) : null}
        {hasArticles && articles.cursor !== null ? (
          <button
            type="button"
            className={`${styles.button} ${styles.loadMore}`}
            disabled={busy || confirmBulk || articles.loading}
            onClick={articles.more}
          >
            加载更多专题草稿
          </button>
        ) : null}
      </div>
    </AuthorDialog>
  );
};
