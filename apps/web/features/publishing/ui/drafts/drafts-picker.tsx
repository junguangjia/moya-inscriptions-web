"use client";

import { Icon, Tabs } from "@moya/ui";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

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
  PublishingDraftDeletionResult,
  PublishingDraftSummary,
} from "@moya/contracts";

const ArticleDraftsPanel = lazy(() =>
  import("../../../editorial-content/article-authoring/article-drafts-panel").then(
    (module) => ({ default: module.ArticleDraftsPanel }),
  ),
);

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
  initialType = "work",
  onOpenArticle,
}: {
  /** The confirmed viewer; this browser's local copies of a deleted draft are cleared for it. */
  readonly accountId: string;
  /** Existing Development availability; false preserves the Work-only box. */
  readonly articleEnabled?: boolean;
  readonly initialType?: "work" | "article";
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
  const [type, setType] = useState<"work" | "article">(
    hasArticles ? initialType : "work",
  );
  const selectedType = hasArticles ? type : "work";
  const panelId = useId();
  const workPanelId = `${panelId}-work`;
  const articlePanelId = `${panelId}-article`;
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
  const load = useCallback(async (from: number, through = from) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setLoadError("");
    try {
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
  }, []);

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
    if (selectedType !== "work") return;
    void load(1, Math.max(1, state.current?.page ?? 1));
    return () => controller.current?.abort();
  }, [load, selectedType]);

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

  const focusAfterRemoval = useFocusAfterRemoval(list?.items.length ?? 0, {
    list: listRef,
    empty: emptyRef,
    panel: panelRef,
  });

  const remove = async (draft: PublishingDraftSummary) => {
    if (deleting !== null) return;
    if (latest.current.activeDraftId === draft.id) {
      setConfirming(null);
      return;
    }
    const intent = `delete:${draft.id}`;
    setDeleting(draft.id);
    setRowError(null);
    try {
      const result = await publishingClient.deleteDraft(draft.id, {
        requestId: intents.current.take(intent),
      });
      intents.current.settle(intent);
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
    } catch (error) {
      intents.current.settle(intent, error);
      setRowError({ id: draft.id, text: failureText(error, "删除未完成") });
    } finally {
      setDeleting(null);
    }
  };

  const now = new Date();
  const items = list?.items ?? [];
  const more = list !== null && items.length < list.total;

  return (
    <AuthorDialog
      dismissible={deleting === null}
      onClose={onClose}
      title={hasArticles ? "草稿箱" : "草稿"}
    >
      {hasArticles ? (
        <Tabs
          ariaLabel="草稿类型"
          items={[
            {
              id: "work",
              label: "作品",
              panelId: workPanelId,
              disabled: deleting !== null || confirming !== null,
            },
            {
              id: "article",
              label: "专题文章",
              panelId: articlePanelId,
              disabled: deleting !== null || confirming !== null,
            },
          ]}
          value={selectedType}
          onValueChange={(value) => {
            if (deleting !== null || confirming !== null) return;
            if (value === "work" || value === "article") setType(value);
          }}
        />
      ) : null}
      {selectedType === "article" && onOpenArticle !== undefined ? (
        <section id={articlePanelId} role="tabpanel" aria-label="专题文章草稿">
          <Suspense fallback={<p role="status">正在读取专题草稿…</p>}>
            <ArticleDraftsPanel accountId={accountId} onOpen={onOpenArticle} />
          </Suspense>
        </section>
      ) : (
        <div
          id={hasArticles ? workPanelId : undefined}
          role={hasArticles ? "tabpanel" : undefined}
          aria-label={hasArticles ? "作品草稿" : undefined}
          ref={panelRef}
          className={styles.panel}
          data-drafts-picker=""
          tabIndex={-1}
        >
          <p className={styles.lead}>草稿仅自己可见，按最近编辑排列。</p>
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
          {list !== null && list.total === 0 && loadError === "" ? (
            <p ref={emptyRef} className={styles.empty} tabIndex={-1}>
              <Icon name="empty" />
              <span>暂无草稿</span>
            </p>
          ) : null}
          <ul
            ref={listRef}
            aria-label="草稿列表"
            className={`${styles.list} ${styles.draftGrid}`}
            hidden={items.length === 0}
            tabIndex={-1}
          >
            {items.map((draft) => {
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
                >
                  {draft.itemCount > 0 ? (
                    <CoverThumb
                      className={`${styles.thumb} ${styles.draftCover}`}
                      src={draft.coverSrc}
                      text=""
                    />
                  ) : null}
                  <div className={styles.rowBody}>
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
                        <span
                          className={styles.label}
                          data-draft-active-label=""
                        >
                          正在编辑
                        </span>{" "}
                        这项编辑还在进行，结束后才能删除这份草稿
                      </p>
                    ) : null}
                    <div className={styles.actions}>
                      <button
                        aria-describedby={headingId}
                        className={`${styles.button} ${styles.primary}`}
                        disabled={deleting !== null}
                        onClick={() => onOpenDraft(draft.id)}
                        type="button"
                      >
                        继续编辑
                      </button>
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
                    </div>
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
                  {rowError?.id === draft.id ? (
                    <p className={styles.alert} role="alert">
                      {rowError.text}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {more && loadError === "" ? (
            <button
              aria-disabled={loading || undefined}
              className={`${styles.button} ${styles.loadMore}`}
              onClick={() => {
                if (!loading) loadMore();
              }}
              type="button"
            >
              加载更多
            </button>
          ) : null}
        </div>
      )}
    </AuthorDialog>
  );
};
