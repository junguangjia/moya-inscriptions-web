"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  actionLabels,
  applicableActions,
  call,
  describeFailure,
  describeFinalFailure,
  doneLabels,
  excerpt,
  formatPreciseTime,
  formatTime,
  kindLabels,
  moderationLabels,
  outcomeUnknown,
  policyLabels,
  shortId,
  subjectKindLabels,
  userStatusLabels,
} from "./api";
import styles from "./community.module.css";
import { ModerationReasonInput, readModerationReason } from "./bulk-actions";

import type {
  BulkModerationResult,
  CommentModerationAction,
  CommentModerationState,
  ModerationResult,
  OperatorComment,
  OperatorCommentDetail,
  OperatorCommentPage,
  PublicationPolicyState,
  UserModerationResult,
} from "@moya/contracts/internal/community-operator";

type Status = CommentModerationState | "all";
type Kind = "all" | "comment" | "reply";
type Order = "newest" | "oldest";
type PageSize = 20 | 50;

interface QueueQuery {
  readonly status: Status;
  readonly q: string;
  readonly kind: Kind;
  readonly catalog: string;
  readonly order: Order;
  readonly page: number;
  readonly size: PageSize;
  readonly item: string | null;
}

interface Notice {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

const statuses: readonly Status[] = ["pending", "visible", "hidden", "all"];
const statusLabels: Record<Status, string> = {
  pending: "待审核",
  visible: "已公开",
  hidden: "已隐藏",
  all: "全部",
};
// One wording per action, shared with the history timeline and the card.
const bulkActionLabels: Record<CommentModerationAction, string> = {
  approve: actionLabels.approve,
  reject: actionLabels.reject,
  hide: actionLabels.hide,
  unhide: actionLabels.unhide,
};
const BULK_LIMIT = 50;

/** The queue state lives in the URL, so back, reload and direct entry agree. */
const readQuery = (params: URLSearchParams): QueueQuery => {
  const status = params.get("status");
  const kind = params.get("kind");
  const order = params.get("order");
  const size = params.get("size");
  const page = Number(params.get("page") ?? "1");
  return {
    status: statuses.includes(status as Status)
      ? (status as Status)
      : "pending",
    q: (params.get("q") ?? "").trim().slice(0, 100),
    kind: kind === "comment" || kind === "reply" ? kind : "all",
    catalog: (params.get("catalog") ?? "").slice(0, 128),
    order: order === "oldest" ? "oldest" : "newest",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    size: size === "50" ? 50 : 20,
    item: params.get("item"),
  };
};

const writeQuery = (query: QueueQuery): string => {
  const params = new URLSearchParams();
  if (query.status !== "pending") params.set("status", query.status);
  if (query.q !== "") params.set("q", query.q);
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.catalog !== "") params.set("catalog", query.catalog);
  if (query.order !== "newest") params.set("order", query.order);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.size !== 20) params.set("size", String(query.size));
  if (query.item !== null) params.set("item", query.item);
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

const filterKey = (query: QueueQuery): string =>
  [
    query.status,
    query.q,
    query.kind,
    query.catalog,
    query.order,
    query.page,
    query.size,
  ].join("|");

const catalogLink = (catalogId: string): string =>
  `/admin/collections/catalogs?where[catalogId][equals]=${encodeURIComponent(catalogId)}`;

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const StateChip = ({ state }: { readonly state: CommentModerationState }) => (
  <span className={styles.chip} data-state={state}>
    <span aria-hidden="true">
      {state === "pending" ? "◷" : state === "visible" ? "✓" : "−"}
    </span>{" "}
    {moderationLabels[state]}
  </span>
);

export const CommunityQueueClient = ({
  phase4Enabled = false,
}: {
  readonly phase4Enabled?: boolean;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => readQuery(searchParams), [searchParams]);
  const { openModal, closeModal } = useModal();

  const [page, setPage] = useState<OperatorCommentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PublicationPolicyState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rowNotices, setRowNotices] = useState<Record<string, Notice>>({});
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [receipt, setReceipt] = useState<Notice | null>(null);
  const [bulkAction, setBulkAction] =
    useState<CommentModerationAction>("approve");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const reason = readModerationReason(reasonDraft);
  const [pendingModeration, setPendingModeration] = useState<{
    item: OperatorComment;
    action: CommentModerationAction;
    reason: string;
  } | null>(null);
  const [pendingBulk, setPendingBulk] = useState<{
    action: CommentModerationAction;
    ids: readonly string[];
    reason: string;
  } | null>(null);
  const [bulkFailed, setBulkFailed] = useState<{
    readonly action: CommentModerationAction;
    readonly ids: readonly string[];
    readonly reason: string;
  } | null>(null);
  const deletionLock = useRef(false);
  const [pendingDeletion, setPendingDeletion] = useState<{
    item: OperatorComment;
    scope: "body" | "thread";
    requestId: string;
    reason: string;
    expectedAffectedCount?: number;
  } | null>(null);
  const [failedDeletion, setFailedDeletion] =
    useState<typeof pendingDeletion>(null);
  const [pendingSuspension, setPendingSuspension] = useState<{
    item: OperatorComment;
    action: "suspend" | "reinstate";
    reason: string;
  } | null>(null);
  const [detail, setDetail] = useState<
    | { readonly state: "loading"; readonly id: string }
    | {
        readonly state: "ready";
        readonly id: string;
        readonly data: OperatorCommentDetail;
      }
    | { readonly state: "error"; readonly id: string; readonly text: string }
    | null
  >(null);
  const [searchDraft, setSearchDraft] = useState(query.q);
  const requestSequence = useRef(0);
  const detailSequence = useRef(0);
  // The item currently open, readable from callbacks created before it changed.
  const openItemRef = useRef<string | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // The open 更多 menu floats over the viewport so the table's scroll box never clips it.
  const [menuAnchor, setMenuAnchor] = useState<{
    key: string;
    top: number;
    right: number;
  } | null>(null);
  // The list query excludes the open item, so opening detail never reloads.
  const listQuery = useMemo(
    () => ({
      status: query.status,
      q: query.q,
      kind: query.kind,
      catalog: query.catalog,
      order: query.order,
      page: query.page,
      size: query.size,
    }),
    // Keyed on the serialized filters on purpose.
    [filterKey(query)],
  );

  const navigate = useCallback(
    (patch: Partial<QueueQuery>, mode: "replace" | "push" = "replace") => {
      const next = writeQuery({ ...query, ...patch });
      const href = `${pathname}${next}`;
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, query, router],
  );

  // A newer request always wins; a slow older answer can never replace it.
  const load = useCallback(async () => {
    const sequence = (requestSequence.current += 1);
    setLoading(true);
    try {
      const result = await call<OperatorCommentPage>("read-comments", {
        ...(listQuery.status === "all" ? {} : { moderation: listQuery.status }),
        ...(listQuery.kind === "all" ? {} : { kind: listQuery.kind }),
        ...(listQuery.catalog === "" ? {} : { catalogId: listQuery.catalog }),
        ...(listQuery.q === "" ? {} : { search: listQuery.q }),
        order: listQuery.order,
        page: listQuery.page,
        pageSize: listQuery.size,
      });
      if (sequence !== requestSequence.current) return;
      setPage(result);
      setLoadError(null);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setLoadError(describeFailure(error).text);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [listQuery]);

  useEffect(() => {
    void load();
    setSelected(new Set());
    setBulkFailed(null);
  }, [load]);

  useEffect(() => {
    setSearchDraft(query.q);
  }, [query.q]);

  useEffect(() => {
    void call<PublicationPolicyState>("read-policy")
      .then(setPolicy)
      .catch(() => setPolicy(null));
  }, []);

  useEffect(() => {
    if (query.item === null) {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      return;
    }
    // Below the two-column width the panel follows the whole list.
    panel.current?.focus();
    panel.current?.scrollIntoView({ block: "start" });
  }, [query.item]);

  useEffect(() => {
    openItemRef.current = query.item;
    if (query.item === null) {
      setDetail(null);
      return;
    }
    const id = query.item;
    const sequence = (detailSequence.current += 1);
    setDetail({ state: "loading", id });
    void call<OperatorCommentDetail>("read-comment", { id })
      .then((data) => {
        if (sequence === detailSequence.current)
          setDetail({ state: "ready", id, data });
      })
      .catch((error: unknown) => {
        if (sequence === detailSequence.current)
          setDetail({ state: "error", id, text: describeFailure(error).text });
      });
  }, [query.item]);

  const items = page?.items ?? [];
  const catalogOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of items)
      if (item.catalogId !== null)
        options.set(item.catalogId, item.catalogTitle ?? item.catalogId);
    if (query.catalog !== "" && !options.has(query.catalog))
      options.set(query.catalog, query.catalog);
    return [...options.entries()];
  }, [items, query.catalog]);

  const setBusy = (id: string, busy: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const noteRow = (id: string, notice: Notice) =>
    setRowNotices((current) => ({ ...current, [id]: notice }));

  /** Updates the row and the tab counts in place; no page reload needed. */
  const applyTransition = (id: string, moderation: CommentModerationState) =>
    setPage((current) => {
      if (current === null) return current;
      const previous = current.items.find((item) => item.id === id);
      if (previous === undefined || previous.moderation === moderation)
        return current;
      const counts = { ...current.counts };
      counts[previous.moderation] = Math.max(
        0,
        counts[previous.moderation] - 1,
      );
      counts[moderation] += 1;
      return {
        ...current,
        counts,
        items: current.items.map((item) =>
          item.id === id ? { ...item, moderation } : item,
        ),
      };
    });

  // A refresh after an action competes with a newer open: the sequence
  // decides, so an older answer never overwrites the item the URL names.
  const refreshDetailIfOpen = (id: string) => {
    if (openItemRef.current !== id) return;
    const sequence = (detailSequence.current += 1);
    void call<OperatorCommentDetail>("read-comment", { id })
      .then((data) => {
        if (sequence === detailSequence.current)
          setDetail({ state: "ready", id, data });
      })
      .catch(() => undefined);
  };

  const moderate = async (
    item: OperatorComment,
    action: CommentModerationAction,
    reason: string,
  ) => {
    if (readModerationReason(reason) === null) return;
    setBusy(item.id, true);
    try {
      const result = await call<ModerationResult>("moderate-comment", {
        id: item.id,
        action,
        reason,
      });
      applyTransition(result.id, result.moderation);
      noteRow(item.id, { tone: "success", text: doneLabels[action] });
      setReceipt({
        tone: "success",
        text: `${doneLabels[action]}：${kindLabels[item.kind]} ${shortId(item.id)}`,
      });
      refreshDetailIfOpen(item.id);
    } catch (error) {
      const failure = describeFailure(error);
      noteRow(item.id, { tone: "error", text: failure.text });
      setReceipt({
        tone: "error",
        text: `${actionLabels[action]}未执行（${kindLabels[item.kind]} ${shortId(item.id)}）：${failure.text}`,
      });
    } finally {
      setBusy(item.id, false);
    }
  };

  const moderateAuthor = async (
    item: OperatorComment,
    action: "suspend" | "reinstate",
    reason: string,
  ) => {
    if (readModerationReason(reason) === null) return;
    setBusy(item.id, true);
    try {
      const result = await call<UserModerationResult>("moderate-user", {
        id: item.author.id,
        action,
        reason,
      });
      setPage((current) =>
        current === null
          ? current
          : {
              ...current,
              items: current.items.map((row) =>
                row.author.id === result.id
                  ? { ...row, author: { ...row.author, status: result.status } }
                  : row,
              ),
            },
      );
      setReceipt({
        tone: "success",
        text:
          action === "suspend"
            ? `已停用账号 @${item.author.handle}，撤销 ${result.revokedSessions} 个会话；既有评论状态不变。`
            : `已恢复账号 @${item.author.handle}。`,
      });
      refreshDetailIfOpen(item.id);
    } catch (error) {
      setReceipt({
        tone: "error",
        text: `${actionLabels[action]}未执行（@${item.author.handle}）：${describeFailure(error).text}`,
      });
    } finally {
      setBusy(item.id, false);
    }
  };

  const runBulk = async (
    action: CommentModerationAction,
    ids: readonly string[],
    reason: string,
  ) => {
    if (
      ids.length === 0 ||
      ids.length > BULK_LIMIT ||
      readModerationReason(reason) === null
    )
      return;
    setBulkBusy(true);
    try {
      const result = await call<BulkModerationResult>("moderate-comments", {
        action,
        ids,
        reason,
      });
      const failed: string[] = [];
      for (const outcome of result.results) {
        if (outcome.outcome === "applied" && outcome.moderation !== undefined) {
          applyTransition(outcome.id, outcome.moderation);
          noteRow(outcome.id, {
            tone: "success",
            text: doneLabels[result.action],
          });
        } else if (outcome.outcome === "conflict") {
          noteRow(outcome.id, {
            tone: "error",
            text: "状态已变化（可能已被处理），本次未处理；请刷新后再决定。",
          });
        } else if (outcome.outcome === "not_found") {
          noteRow(outcome.id, {
            tone: "error",
            text: "目标已不存在，请刷新队列。",
          });
        } else {
          failed.push(outcome.id);
          noteRow(outcome.id, {
            tone: "error",
            text: "处理失败，可重试失败项。",
          });
        }
      }
      setBulkFailed(
        failed.length === 0
          ? null
          : { action: result.action, ids: failed, reason },
      );
      setSelected(new Set(failed));
      setReceipt({
        tone:
          failed.length === 0 && result.conflicts === 0 ? "success" : "info",
        text: `批量${bulkActionLabels[result.action]}：成功 ${result.applied} 条，状态冲突 ${result.conflicts} 条，已不存在 ${result.notFound} 条，失败 ${result.failed} 条。`,
      });
    } catch (error) {
      setReceipt({
        tone: "error",
        text: `批量操作未执行：${describeFailure(error).text}`,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < BULK_LIMIT) next.add(id);
      return next;
    });

  const allOnPageSelected =
    items.length > 0 && items.every((item) => selected.has(item.id));

  const openItem = (id: string) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-queue-list]"))
      returnFocus.current = active;
    navigate({ item: id }, "push");
  };
  const closeItem = () => navigate({ item: null }, "replace");

  const deleteContent = async (
    command: NonNullable<typeof pendingDeletion>,
  ) => {
    if (deletionLock.current || readModerationReason(command.reason) === null)
      return;
    deletionLock.current = true;
    setBusy(command.item.id, true);
    try {
      await call(command.scope === "body" ? "delete-body" : "remove-thread", {
        id: command.item.id,
        requestId: command.requestId,
        reason: command.reason,
        ...(command.scope === "thread"
          ? { expectedAffectedCount: command.expectedAffectedCount }
          : {}),
      });
      setFailedDeletion(null);
      setReceipt({
        tone: "success",
        text:
          command.scope === "body"
            ? "正文已删除；已有回复保留。"
            : "整帖及全部回复的讨论访问已移除。",
      });
      await load();
      refreshDetailIfOpen(command.item.id);
    } catch (error) {
      // Only a lost answer keeps the command for a same-identity retry; a
      // refusal, conflict or missing subject is final.
      const unknown = outcomeUnknown(error);
      setReceipt({
        tone: "error",
        text: unknown
          ? describeFailure(error).text
          : describeFinalFailure(error),
      });
      setFailedDeletion(unknown ? command : null);
    } finally {
      deletionLock.current = false;
      setBusy(command.item.id, false);
    }
  };

  const renderActions = (item: OperatorComment, compact: boolean) => {
    const busy = busyIds.has(item.id);
    const suspended = item.author.status === "suspended";
    return (
      <div className={styles.actions}>
        {(item.bodyDeleted || item.threadRemoved
          ? []
          : applicableActions(item.moderation)
        ).map((action) => (
          <button
            className={styles.actionButton}
            data-primary={
              action === "approve" || action === "unhide" ? "true" : undefined
            }
            data-danger={
              action === "reject" || action === "hide" ? "true" : undefined
            }
            disabled={busy || reason === null}
            key={action}
            onClick={() => {
              if (reason !== null) {
                setPendingModeration({ item, action, reason });
                openModal("community-comment-confirm");
              }
            }}
            type="button"
          >
            {busy ? "处理中…" : bulkActionLabels[action]}
          </button>
        ))}
        <details
          className={styles.more}
          onToggle={(event) => {
            const details = event.currentTarget;
            const key = `${compact ? "row" : "detail"}:${item.id}`;
            if (!details.open) {
              setMenuAnchor((current) =>
                current?.key === key ? null : current,
              );
              return;
            }
            const rect = details.firstElementChild?.getBoundingClientRect();
            if (rect)
              setMenuAnchor({
                key,
                top: rect.bottom,
                right: window.innerWidth - rect.right,
              });
          }}
        >
          <summary aria-label={`更多操作：${shortId(item.id)}`}>更多</summary>
          <div
            className={styles.moreMenu}
            role="menu"
            style={
              menuAnchor?.key === `${compact ? "row" : "detail"}:${item.id}`
                ? {
                    position: "fixed",
                    top: menuAnchor.top,
                    right: menuAnchor.right,
                  }
                : undefined
            }
          >
            {phase4Enabled && !item.threadRemoved ? (
              <>
                {!item.bodyDeleted ? (
                  <button
                    role="menuitem"
                    type="button"
                    disabled={
                      busy || failedDeletion !== null || reason === null
                    }
                    onClick={() => {
                      if (reason === null) return;
                      setPendingDeletion({
                        item,
                        scope: "body",
                        requestId: crypto.randomUUID(),
                        reason,
                      });
                      openModal("community-delete-confirm");
                    }}
                  >
                    删除正文…
                  </button>
                ) : null}
                {item.kind === "comment" ? (
                  <button
                    role="menuitem"
                    type="button"
                    disabled={
                      busy ||
                      failedDeletion !== null ||
                      reason === null ||
                      !item.threadAffectedCount
                    }
                    onClick={() => {
                      if (reason === null || !item.threadAffectedCount) return;
                      setPendingDeletion({
                        item,
                        scope: "thread",
                        requestId: crypto.randomUUID(),
                        reason,
                        expectedAffectedCount: item.threadAffectedCount,
                      });
                      openModal("community-delete-confirm");
                    }}
                  >
                    移除整帖…
                  </button>
                ) : null}
              </>
            ) : null}
            {compact ? (
              <button
                onClick={() => openItem(item.id)}
                role="menuitem"
                type="button"
              >
                查看详情
              </button>
            ) : null}
            {/* A deleted account is terminal: neither action applies. */}
            {item.author.status === "deleted" ? null : (
              <button
                disabled={busy || reason === null}
                onClick={() => {
                  if (reason === null) return;
                  setPendingSuspension({
                    item,
                    action: suspended ? "reinstate" : "suspend",
                    reason,
                  });
                  openModal("community-suspend-confirm");
                }}
                role="menuitem"
                type="button"
              >
                {suspended ? "恢复账号" : "停用账号…"}
              </button>
            )}
          </div>
        </details>
      </div>
    );
  };

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "审核", url: "/admin/community-moderation" },
          { label: workspacePageLabel("/admin/community-moderation") },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation")}
          </h1>
          <p className={styles.lead}>
            评论和回复，按提交时间排序；{TIME_ZONE_NOTE}。
          </p>
        </div>
        <div className={styles.summaryLine} data-policy-summary="">
          <span>
            当前发布模式：
            <strong>
              {policy === null ? "读取中…" : policyLabels[policy.policy]}
            </strong>
          </span>
        </div>
      </header>

      <div aria-label="审核状态" className={styles.tabs} role="tablist">
        {statuses.map((status) => (
          <button
            aria-busy={loading && query.status === status}
            aria-selected={query.status === status}
            className={styles.tab}
            key={status}
            onClick={() => navigate({ status, page: 1 })}
            aria-controls="community-queue-list"
            role="tab"
            type="button"
          >
            {statusLabels[status]}
            <span className={styles.count}>
              {page === null ? "…" : page.counts[status]}
            </span>
          </button>
        ))}
      </div>

      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ q: searchDraft.trim().slice(0, 100), page: 1 });
        }}
      >
        <label>
          搜索评论正文、作者账号或显示名
          <input
            data-queue-search=""
            maxLength={100}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="例如：字口 或 dev-user-02"
            type="search"
            value={searchDraft}
          />
        </label>
        <details
          className={styles.filterDisclosure}
          open={
            query.kind !== "all" ||
            query.catalog !== "" ||
            query.order !== "newest"
          }
        >
          <summary>筛选与排序</summary>
          <div className={styles.filters}>
            <label>
              类型
              <select
                onChange={(event) =>
                  navigate({ kind: event.currentTarget.value as Kind, page: 1 })
                }
                value={query.kind}
              >
                <option value="all">根评论与回复</option>
                <option value="comment">仅根评论</option>
                <option value="reply">仅回复</option>
              </select>
            </label>
            <label>
              资料
              <select
                onChange={(event) =>
                  navigate({ catalog: event.currentTarget.value, page: 1 })
                }
                value={query.catalog}
              >
                <option value="">全部资料</option>
                {catalogOptions.map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              审阅顺序
              <select
                onChange={(event) =>
                  navigate({
                    order: event.currentTarget.value as Order,
                    page: 1,
                  })
                }
                value={query.order}
              >
                <option value="newest">最新优先</option>
                <option value="oldest">最早优先</option>
              </select>
            </label>
          </div>
        </details>
        <button className={styles.actionButton} type="submit">
          搜索
        </button>
        {query.q === "" &&
        query.kind === "all" &&
        query.catalog === "" ? null : (
          <button
            className={styles.actionButton}
            onClick={() =>
              navigate({ q: "", kind: "all", catalog: "", page: 1 })
            }
            type="button"
          >
            清除筛选
          </button>
        )}
      </form>

      <ModerationReasonInput
        label="评论与账号处置理由（必填）"
        value={reasonDraft}
        onChange={setReasonDraft}
        disabled={bulkBusy || busyIds.size > 0}
      />

      {receipt === null ? null : (
        <p
          className={styles.receipt}
          data-queue-receipt=""
          data-tone={receipt.tone}
          role="status"
        >
          {receipt.text}
        </p>
      )}

      {selected.size === 0 ? null : (
        <div className={styles.bulkBar} data-bulk-bar="">
          <span>
            已选 <strong>{selected.size}</strong> 条（仅限本页，最多{" "}
            {BULK_LIMIT} 条）
          </span>
          <label>
            <span className={styles.srOnly}>批量操作</span>
            <select
              onChange={(event) =>
                setBulkAction(
                  event.currentTarget.value as CommentModerationAction,
                )
              }
              value={bulkAction}
            >
              {(Object.keys(bulkActionLabels) as CommentModerationAction[]).map(
                (action) => (
                  <option key={action} value={action}>
                    {bulkActionLabels[action]}
                  </option>
                ),
              )}
            </select>
          </label>
          <button
            className={styles.actionButton}
            data-primary="true"
            disabled={bulkBusy || reason === null}
            onClick={() => {
              if (reason !== null) {
                setPendingBulk({
                  action: bulkAction,
                  ids: [...selected],
                  reason,
                });
                openModal("community-bulk-confirm");
              }
            }}
            type="button"
          >
            {bulkBusy ? "处理中…" : "执行批量操作…"}
          </button>
          {bulkFailed === null ? null : (
            <button
              className={styles.actionButton}
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(
                  bulkFailed.action,
                  bulkFailed.ids,
                  bulkFailed.reason,
                )
              }
              type="button"
            >
              重试失败项（{bulkFailed.ids.length}，
              {bulkActionLabels[bulkFailed.action]}）
            </button>
          )}
          <button
            className={styles.actionButton}
            onClick={() => setSelected(new Set())}
            type="button"
          >
            取消选择
          </button>
        </div>
      )}

      <div
        className={styles.layout}
        data-panel-open={query.item === null ? "false" : "true"}
      >
        <section
          aria-busy={loading}
          aria-label="评论列表"
          data-queue-list=""
          id="community-queue-list"
          role="tabpanel"
        >
          {loadError !== null ? (
            <p className={styles.state} data-queue-error="" role="alert">
              无法加载队列：{loadError}{" "}
              <button
                className={styles.rowLink}
                onClick={() => void load()}
                type="button"
              >
                重试
              </button>
            </p>
          ) : page === null ? (
            <p className={styles.state} role="status">
              正在读取评论…
            </p>
          ) : page.items.length === 0 ? (
            <p className={styles.state} data-queue-empty="">
              没有符合条件的{statusLabels[query.status]}评论。
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-queue-table="">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        aria-label="选择本页全部"
                        checked={allOnPageSelected}
                        onChange={() =>
                          setSelected(
                            allOnPageSelected
                              ? new Set()
                              : new Set(
                                  items
                                    .slice(0, BULK_LIMIT)
                                    .map((item) => item.id),
                                ),
                          )
                        }
                        type="checkbox"
                      />
                    </th>
                    <th scope="col">评论</th>
                    <th scope="col">资料</th>
                    <th scope="col">作者</th>
                    <th scope="col">状态 / 时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr
                      data-busy={busyIds.has(item.id) ? "true" : undefined}
                      data-current={query.item === item.id ? "true" : undefined}
                      data-queue-row={item.id}
                      data-state={item.moderation}
                      key={item.id}
                    >
                      <td>
                        <input
                          aria-label={`选择 ${shortId(item.id)}`}
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelected(item.id)}
                          type="checkbox"
                        />
                      </td>
                      <td>
                        <p className={styles.excerpt}>
                          <button
                            className={styles.rowLink}
                            onClick={() => openItem(item.id)}
                            type="button"
                          >
                            {excerpt(item.text)}
                          </button>
                        </p>
                        <span className={styles.secondary}>
                          <span className={styles.chip} data-state="kind">
                            {kindLabels[item.kind]}
                          </span>{" "}
                          <span className={styles.mono}>
                            {shortId(item.id)}
                          </span>
                        </span>
                        {rowNotices[item.id] === undefined ? null : (
                          <p
                            className={styles.rowNotice}
                            data-row-notice=""
                            data-tone={rowNotices[item.id]?.tone}
                            role="status"
                          >
                            {rowNotices[item.id]?.text}
                          </p>
                        )}
                      </td>
                      <td>
                        {item.contentTitle ??
                          item.catalogTitle ??
                          "（当前不可用的内容）"}
                        <span className={styles.secondary}>
                          {item.target?.type === "work"
                            ? `用户作品 · ${item.target.id}`
                            : item.catalogId}
                        </span>
                      </td>
                      <td>
                        {item.author.displayName}
                        <span className={styles.secondary}>
                          @{item.author.handle}{" "}
                          {item.author.status === "active" ? null : (
                            <span
                              className={styles.chip}
                              data-state={item.author.status}
                            >
                              {userStatusLabels[item.author.status]}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>
                        <StateChip state={item.moderation} />
                        {item.threadRemoved ? (
                          <span> 整帖已移除</span>
                        ) : item.bodyDeleted ? (
                          <span> 正文已删除</span>
                        ) : null}
                        <span className={styles.secondary}>
                          <time dateTime={item.createdAt}>
                            {formatTime(item.createdAt)}
                          </time>
                        </span>
                      </td>
                      <td>{renderActions(item, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {page === null ? null : (
            <div className={styles.pager}>
              <span>
                共 {page.total} 条 · 第 {page.total === 0 ? 0 : page.page} /{" "}
                {page.totalPages} 页
              </span>
              <div className={styles.actions}>
                <button
                  className={styles.actionButton}
                  disabled={page.page <= 1 || loading}
                  onClick={() => navigate({ page: query.page - 1 })}
                  type="button"
                  aria-label="上一页"
                  title="上一页"
                >
                  <span aria-hidden="true">←</span>
                </button>
                <button
                  className={styles.actionButton}
                  disabled={page.page >= page.totalPages || loading}
                  onClick={() => navigate({ page: query.page + 1 })}
                  type="button"
                  aria-label="下一页"
                  title="下一页"
                >
                  <span aria-hidden="true">→</span>
                </button>
                <label>
                  <span className={styles.srOnly}>每页条数</span>
                  <select
                    onChange={(event) =>
                      navigate({
                        size: Number(event.currentTarget.value) as PageSize,
                        page: 1,
                      })
                    }
                    value={query.size}
                  >
                    <option value={20}>每页 20 条</option>
                    <option value={50}>每页 50 条</option>
                  </select>
                </label>
              </div>
            </div>
          )}
        </section>

        {query.item === null ? null : (
          <aside
            aria-labelledby="community-detail-title"
            className={styles.panel}
            data-queue-detail=""
            ref={panel}
            tabIndex={-1}
          >
            <div className={styles.panelHeader}>
              <h2 id="community-detail-title">评论详情</h2>
              <button
                className={styles.iconButton}
                onClick={closeItem}
                type="button"
              >
                <span aria-hidden="true">← </span>返回列表
              </button>
            </div>
            {detail === null || detail.state === "loading" ? (
              <p role="status">正在读取详情…</p>
            ) : detail.state === "error" ? (
              <p className={styles.notice} data-tone="error" role="alert">
                {detail.text}
              </p>
            ) : (
              <DetailBody
                data={detail.data}
                onOpen={openItem}
                renderActions={(item) => renderActions(item, false)}
              />
            )}
          </aside>
        )}
      </div>

      {failedDeletion ? (
        <p className={styles.notice} role="alert">
          上次处置操作结果尚未确认。
          <button
            type="button"
            disabled={busyIds.has(failedDeletion.item.id)}
            onClick={() => void deleteContent(failedDeletion)}
          >
            重试同一操作
          </button>
          <button
            type="button"
            disabled={busyIds.has(failedDeletion.item.id)}
            onClick={() => {
              const id = failedDeletion.item.id;
              setFailedDeletion(null);
              void load();
              refreshDetailIfOpen(id);
            }}
          >
            放弃并刷新
          </button>
        </p>
      ) : null}
      <ConfirmationModal
        heading={
          pendingDeletion?.scope === "thread" ? "确认移除整帖" : "确认删除正文"
        }
        modalSlug="community-delete-confirm"
        cancelLabel="取消"
        confirmLabel={
          pendingDeletion?.scope === "thread" ? "确认移除" : "确认删除"
        }
        confirmingLabel={
          pendingDeletion?.scope === "thread" ? "移除中…" : "删除中…"
        }
        body={
          <>
            {pendingDeletion?.scope === "thread" ? (
              <p>
                将移除此根评论及全部回复的讨论访问，共{" "}
                {pendingDeletion.expectedAffectedCount}{" "}
                项。原有正文、作者关系及记录保留；复核撤销只解除本决定造成的整帖限制，已删除正文不会恢复，其他有效处分仍可限制访问。新回复会使确认失效，需重新检查数量。
              </p>
            ) : (
              <p>
                删除这条评论的正文。已有回复及其关系保留；曾公开的内容显示删除占位，未公开内容不会因此公开。作者也无法再读取被删除的正文，此操作不可恢复。
              </p>
            )}
            <p className={styles.reportText}>
              处置理由：{pendingDeletion?.reason}
            </p>
          </>
        }
        onConfirm={async () => {
          closeModal("community-delete-confirm");
          if (pendingDeletion) await deleteContent(pendingDeletion);
          setPendingDeletion(null);
        }}
      />
      <ConfirmationModal
        body={
          <>
            <p>
              将对{pendingModeration?.item.kind === "reply" ? "回复" : "评论"}{" "}
              {pendingModeration?.item.id} 执行「
              {pendingModeration === null
                ? ""
                : bulkActionLabels[pendingModeration.action]}
              」。
            </p>
            <p className={styles.reportText}>
              处置理由：{pendingModeration?.reason}
            </p>
          </>
        }
        cancelLabel="取消"
        confirmLabel="确认处置"
        confirmingLabel="处理中…"
        heading="确认评论处置"
        modalSlug="community-comment-confirm"
        onCancel={() => setPendingModeration(null)}
        onConfirm={async () => {
          const command = pendingModeration;
          setPendingModeration(null);
          closeModal("community-comment-confirm");
          if (command !== null)
            await moderate(command.item, command.action, command.reason);
        }}
      />
      <ConfirmationModal
        body={
          <>
            <p>
              将对本页已选的 {pendingBulk?.ids.length ?? 0} 条评论执行「
              {pendingBulk === null ? "" : bulkActionLabels[pendingBulk.action]}
              」。每条都会单独检查当前状态并记录审计；状态已变化的项目不会被处理。
            </p>
            <p className={styles.reportText}>
              各项处置理由：{pendingBulk?.reason}
            </p>
          </>
        }
        cancelLabel="取消"
        confirmLabel="确认执行"
        confirmingLabel="处理中…"
        heading="确认批量操作"
        modalSlug="community-bulk-confirm"
        onCancel={() => setPendingBulk(null)}
        onConfirm={async () => {
          const command = pendingBulk;
          setPendingBulk(null);
          closeModal("community-bulk-confirm");
          if (command !== null)
            await runBulk(command.action, command.ids, command.reason);
        }}
      />
      <ConfirmationModal
        body={
          <>
            <p>
              {pendingSuspension?.action === "reinstate"
                ? "恢复账号"
                : "停用账号"}{" "}
              @{pendingSuspension?.item.author.handle ?? ""}（
              {pendingSuspension?.item.author.displayName ?? ""}）。
              {pendingSuspension?.action === "reinstate"
                ? "恢复后仍遵循其他有效限制。"
                : "将撤销全部普通登录会话并拒绝后续发言；已有评论状态不变，可单独隐藏。"}
              此操作会记录到操作历史。
            </p>
            <p className={styles.reportText}>
              处置理由：{pendingSuspension?.reason}
            </p>
          </>
        }
        cancelLabel="取消"
        confirmLabel={
          pendingSuspension?.action === "reinstate"
            ? "确认恢复账号"
            : "确认停用"
        }
        confirmingLabel="处理中…"
        heading={
          pendingSuspension?.action === "reinstate"
            ? "确认恢复账号"
            : "确认停用账号"
        }
        modalSlug="community-suspend-confirm"
        onCancel={() => setPendingSuspension(null)}
        onConfirm={async () => {
          const command = pendingSuspension;
          setPendingSuspension(null);
          closeModal("community-suspend-confirm");
          if (command !== null)
            await moderateAuthor(command.item, command.action, command.reason);
        }}
      />
    </div>
  );
};

const DetailBody = ({
  data,
  onOpen,
  renderActions,
}: {
  readonly data: OperatorCommentDetail;
  readonly onOpen: (id: string) => void;
  readonly renderActions: (item: OperatorComment) => React.ReactNode;
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    setCopied(
      (await copyText(value)) ? `已复制${label}` : "复制失败，请手动选择",
    );
  };
  const { item } = data;
  return (
    <>
      <div>
        <h3>正文</h3>
        <p className={styles.fullText} data-detail-text="">
          {item.text}
        </p>
      </div>
      <div>
        <h3>状态</h3>
        <StateChip state={item.moderation} />{" "}
        {item.threadRemoved ? (
          <p>整帖已移除，不可恢复。</p>
        ) : item.bodyDeleted ? (
          <p>正文已删除，不可恢复。</p>
        ) : null}
        <span className={styles.chip} data-state="kind">
          {kindLabels[item.kind]}
        </span>
        {data.parentRestriction === "none" ? null : (
          <p className={styles.notice} data-tone="info">
            {data.parentRestriction === "root_pending"
              ? "所属根评论仍待审核：即使本回复已公开，公开页也不会显示它。"
              : "所属根评论已隐藏：即使本回复已公开，公开页也不会显示它。"}
          </p>
        )}
      </div>
      <div>
        <h3>所属内容</h3>
        {item.contentTitle ?? item.catalogTitle ?? "（当前不可用的内容）"}
        <span className={styles.secondary}>
          {item.catalogId !== null ? (
            <Link href={catalogLink(item.catalogId)}>在资料列表中查看</Link>
          ) : item.target?.type === "work" ? (
            <Link
              href={`/admin/community-moderation/content?q=${encodeURIComponent(item.target.id)}`}
            >
              在作品管理中查看
            </Link>
          ) : null}
          {" · "}
          <span className={styles.mono}>
            {item.target?.id ?? item.catalogId}
          </span>
        </span>
      </div>
      {data.root === null ? null : (
        <div>
          <h3>所属根评论</h3>
          <div className={styles.contextBox}>
            <StateChip state={data.root.moderation} />{" "}
            {data.root.author.displayName}：{excerpt(data.root.text, 160)}
            <span className={styles.secondary}>
              <button
                className={styles.rowLink}
                onClick={() => onOpen(data.root!.id)}
                type="button"
              >
                打开根评论
              </button>
            </span>
          </div>
        </div>
      )}
      {data.replyTo === null ? null : (
        <div>
          <h3>回复对象</h3>
          <div className={styles.contextBox}>
            <StateChip state={data.replyTo.moderation} />{" "}
            {data.replyTo.author.displayName}：{excerpt(data.replyTo.text, 160)}
            <span className={styles.secondary}>
              <button
                className={styles.rowLink}
                onClick={() => onOpen(data.replyTo!.id)}
                type="button"
              >
                打开该回复
              </button>
            </span>
          </div>
        </div>
      )}
      <div>
        <h3>作者</h3>
        {item.author.displayName}{" "}
        <span className={styles.mono}>@{item.author.handle}</span>{" "}
        <span
          className={styles.chip}
          data-state={
            item.author.status === "active" ? "visible" : item.author.status
          }
        >
          {userStatusLabels[item.author.status]}
        </span>
        <span className={styles.secondary}>
          <span className={styles.mono}>{item.author.id}</span>
        </span>
      </div>
      <div>
        <h3>时间</h3>
        <time dateTime={item.createdAt}>
          {formatPreciseTime(item.createdAt)}
        </time>
        <span className={styles.secondary}>
          <span className={styles.mono}>{item.createdAt}</span>{" "}
          <button
            className={styles.rowLink}
            onClick={() => void copy("时间戳", item.createdAt)}
            type="button"
          >
            复制
          </button>
        </span>
      </div>
      <div>
        <h3>内部 ID</h3>
        <span className={styles.mono}>{item.id}</span>{" "}
        <button
          className={styles.rowLink}
          onClick={() => void copy("ID", item.id)}
          type="button"
        >
          复制
        </button>
        {copied === null ? null : (
          <span className={styles.secondary}>{copied}</span>
        )}
      </div>
      <div>
        <h3>操作历史</h3>
        {data.history.length === 0 ? (
          <p className={styles.secondary}>尚无审核操作记录。</p>
        ) : (
          <ol className={styles.timeline} data-detail-history="">
            {data.history.map((event) => (
              <li key={event.id}>
                <time dateTime={event.occurredAt}>
                  {formatTime(event.occurredAt)}
                </time>
                <span>
                  {actionLabels[event.action]} · {event.operatorLabel}
                  {event.detail === undefined ? "" : ` · ${event.detail}`}
                  <span className={styles.secondary}>
                    {subjectKindLabels[event.subjectKind]}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <h3>机器分析（仅供参考）</h3>
        <p
          className={styles.secondary}
          data-detail-analysis={data.analysis.status}
        >
          {data.analysis.status === "not_connected"
            ? "未接入分析服务：没有任何机器判断，也不代表内容无问题。"
            : data.analysis.status === "not_analyzed"
              ? "尚未分析。"
              : data.analysis.status === "completed"
                ? `建议：${data.analysis.recommendation}（${data.analysis.analyzer.name} ${data.analysis.analyzer.version}）。${data.analysis.explanation}`
                : `分析${data.analysis.status === "failed" ? "失败" : data.analysis.status === "stale" ? "已过期" : "已跳过"}，不构成任何结论。`}
        </p>
      </div>
      <div>
        <h3>操作</h3>
        {renderActions(item)}
      </div>
    </>
  );
};
