"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";
import type {
  FeaturedPage,
  OperatorWork,
  OperatorUser,
  OperatorUserPage,
  OperatorWorkPage,
} from "@moya/contracts/internal/community-operator";
import type { ContentIdentity } from "@moya/contracts";
import {
  call,
  describeFailure,
  describeFinalFailure,
  formatTime,
  outcomeUnknown,
  submissionStateLabels,
  UNTITLED_WORK,
  workActionPhrases,
  workTitleOf,
} from "./api";
import type { OperatorWorkSubmission } from "./api";
import { SubmissionDetail } from "./work-submissions-client";
import styles from "./community.module.css";
import {
  BulkActions,
  ModerationReasonInput,
  readModerationReason,
  planWorkOperations,
  workBulkConfirmText,
} from "./bulk-actions";
import type { WorkBulkAction } from "./bulk-actions";
import { CommunityUsers } from "./users-client";
import { contentTab } from "../workspace/routes";
import { UiIcon } from "../workspace/Icon";
import { useNavigationGuard } from "../workspace/use-navigation-guard";

type Tab = "works" | "featured" | "users";
type CandidatePage = {
  items: { id: string; title: string }[];
  total: number;
  page: number;
  pageSize: number;
};
type Operation = {
  name: string;
  input: Record<string, unknown>;
  label: string;
};
const labels = { visible: "正常", hidden: "已隐藏", removed: "已移除" };
const PAGE_SIZE = 20;
const positivePage = (value: string | null) => {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
};
const Pager = ({
  page,
  total,
  busy,
  onPage,
}: {
  page: number;
  total: number;
  busy: boolean;
  onPage: (page: number) => void;
}) => (
  <div className={styles.pager}>
    <span>
      共 {total} 项 · 第 {total === 0 ? 0 : page} /{" "}
      {Math.ceil(total / PAGE_SIZE)} 页
    </span>
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.actionButton}
        disabled={busy || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </button>
      <button
        type="button"
        className={styles.actionButton}
        disabled={busy || page * PAGE_SIZE >= total}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </div>
  </div>
);

/** Owner commands retain their request identity until the response is reconciled. */
export const CommunityContentClient = () => {
  const params = useSearchParams();
  const authorFromURL = params.get("author");
  const { openModal, closeModal } = useModal();
  const [selectedWork, setSelectedWork] = useState<OperatorWork | null>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const restoreDetailFocus = useRef(false);
  useEffect(() => {
    if (selectedWork === null && restoreDetailFocus.current) {
      restoreDetailFocus.current = false;
      if (detailOpener.current?.isConnected) detailOpener.current.focus();
    }
  }, [selectedWork]);
  const detailRequest = useRef(0);
  const [activeUser, setActiveUser] = useState<OperatorUser | null>(null);
  const activeAuthorId = authorFromURL ?? activeUser?.id;
  const [authorError, setAuthorError] = useState<string | null>(null);
  const [authorLoading, setAuthorLoading] = useState(false);
  const [authorRefresh, setAuthorRefresh] = useState(0);
  const [userReload, setUserReload] = useState(0);
  const [featuredFilter, setFeaturedFilter] = useState<"active" | "all">(
    "active",
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>(() => contentTab(params.get("tab")));
  const [query, setQuery] = useState({
    page: positivePage(params.get("page")),
    search: params.get("q") ?? "",
  });
  const [search, setSearch] = useState(query.search);
  const [works, setWorks] = useState<OperatorWorkPage | null>(null);
  const [featured, setFeatured] = useState<FeaturedPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commandLock = useRef(false);
  const request = useRef(0);
  const [retry, setRetry] = useState<Operation | null>(null);
  // Selected-item commands whose outcome is still unknown; they keep their
  // request identity inside BulkActions, so navigation waits for them.
  const [bulkPending, setBulkPending] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Operation | null>(null);
  const [reasonDraft, setReasonDraft] = useState("");
  const reason = readModerationReason(reasonDraft);
  const [quantity, setQuantity] = useState("");
  const urlQuery = params.toString();
  const updateURL = (
    changes: Record<string, string | null>,
    replace = false,
  ) => {
    const next = new URL(window.location.href);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === "") next.searchParams.delete(name);
      else next.searchParams.set(name, value);
    }
    window.history[replace ? "replaceState" : "pushState"](
      null,
      "",
      `${next.pathname}${next.search}`,
    );
  };
  useNavigationGuard(busy || retry !== null || bulkPending > 0, () =>
    setNotice("请先确认当前操作的结果，再切换页面。"),
  );
  useEffect(() => {
    if (commandLock.current || retry !== null || bulkPending > 0) return;
    const next = new URLSearchParams(urlQuery);
    const nextTab = contentTab(next.get("tab"));
    setTab(nextTab);
    const searchText = next.get("q") ?? "";
    setSearch(searchText);
    const page = positivePage(next.get("page"));
    setQuery((current) =>
      current.page === page && current.search === searchText
        ? current
        : { page, search: searchText },
    );
    setFeaturedFilter(next.get("filter") === "all" ? "all" : "active");
    if (activeUser && activeUser.id !== authorFromURL) setActiveUser(null);
    setSelectedIds(new Set());
  }, [urlQuery, busy, retry, bulkPending]);
  useEffect(() => {
    if (tab !== "works" || !authorFromURL) {
      setAuthorError(null);
      setAuthorLoading(false);
      return;
    }
    const controller = new AbortController();
    setAuthorError(null);
    setAuthorLoading(true);
    void call<OperatorUserPage>(
      "read-users",
      { userId: authorFromURL, page: 1, pageSize: 1, search: "" },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const user = page.items.find((item) => item.id === authorFromURL);
        setActiveUser(user ?? null);
        if (!user) setAuthorError("找不到该用户，请返回用户列表核对。");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setAuthorError(describeFailure(error).text);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAuthorLoading(false);
      });
    return () => controller.abort();
  }, [tab, authorFromURL, authorRefresh]);
  const settingsVersion = useRef<number | null>(null);
  const load = useCallback(async () => {
    const epoch = ++request.current;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    setUserReload((n) => n + 1);
    try {
      if (tab === "works") {
        const result = await call<OperatorWorkPage>("read-works", {
          ...query,
          ...(activeAuthorId ? { authorId: activeAuthorId } : {}),
          pageSize: PAGE_SIZE,
        });
        if (epoch === request.current) {
          setWorks(result);
          setSelectedWork((current) =>
            current === null
              ? null
              : (result.items.find((item) => item.id === current.id) ??
                current),
          );
        }
      } else if (tab === "featured") {
        const result = await call<FeaturedPage>("read-featured", {
          ...query,
          filter: featuredFilter,
          pageSize: PAGE_SIZE,
        });
        if (epoch === request.current) {
          setFeatured(result);
          if (settingsVersion.current !== result.settingsVersion) {
            settingsVersion.current = result.settingsVersion;
            setQuantity(
              result.enabledQuantity === null
                ? ""
                : String(result.enabledQuantity),
            );
          }
        }
      }
    } catch (e) {
      if (epoch === request.current) setError(describeFailure(e).text);
    } finally {
      if (epoch === request.current) setLoading(false);
    }
  }, [tab, query, activeAuthorId, featuredFilter]);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
      detailRequest.current++;
    };
  }, [load]);
  const run = async (op: Operation) => {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await call(op.name, op.input);
      if (op.name === "moderate-work") {
        const updated = result as OperatorWork;
        setSelectedWork((current) =>
          current?.id === updated.id ? updated : current,
        );
      }
      if (op.name === "set-featured") {
        const target = op.input.target as ContentIdentity;
        setSelectedWork((current) =>
          current?.id === target.id && target.type === "work"
            ? {
                ...current,
                recommendation: {
                  enabled: op.input.enabled as boolean,
                  position: op.input.position as number,
                  version: (result as { version: number }).version,
                  source: "work",
                },
              }
            : current,
        );
      }
      setRetry(null);
      setNotice(`${op.label}已保存。`);
      await load();
    } catch (e) {
      // Only an answer that never arrived may be re-sent with the same
      // identity; a refusal, conflict or missing subject is final.
      if (outcomeUnknown(e)) {
        setNotice(describeFailure(e).text);
        setRetry(op);
      } else {
        setNotice(describeFinalFailure(e));
        setRetry(null);
      }
    } finally {
      commandLock.current = false;
      setBusy(false);
    }
  };
  const execute = (
    name: string,
    input: Record<string, unknown>,
    label: string,
  ) =>
    void run({
      name,
      input: { ...input, requestId: crypto.randomUUID() },
      label,
    });
  const bulkGate = busy || retry !== null || loading || error !== null;
  const disabled = bulkGate || bulkPending > 0;
  const bulkBusy = (value: boolean) => {
    commandLock.current = value;
    setBusy(value);
  };
  const chooseTab = (next: Tab) => {
    if (busy || retry !== null || bulkPending > 0) return;
    detailRequest.current++;
    setSelectedWork(null);
    setActiveUser(null);
    setSelectedIds(new Set());
    setSkipped([]);
    setTab(next);
    const rememberedSearch =
      next === "users" ? (params.get("usersQ") ?? "") : "";
    const rememberedPage =
      next === "users" ? positivePage(params.get("usersPage")) : 1;
    setQuery({ page: rememberedPage, search: rememberedSearch });
    setSearch(rememberedSearch);
    updateURL({
      tab: next === "works" ? null : next,
      q: rememberedSearch || null,
      page: rememberedPage === 1 ? null : String(rememberedPage),
      item: null,
      author: null,
    });
  };
  const feature = (target: ContentIdentity, title: string) =>
    execute(
      "set-featured",
      { target, enabled: true, position: 0, expectedVersion: 0 },
      `推荐「${title}」`,
    );
  const confirmWork = (item: OperatorWork, state: OperatorWork["state"]) => {
    if (reason === null) return;
    setConfirmation({
      name: "moderate-work",
      input: {
        id: item.id,
        state,
        expectedVersion: item.version,
        requestId: crypto.randomUUID(),
        reason,
      },
      label: `${workActionPhrases[state]}「${workTitleOf(item)}」`,
    });
    openModal("community-work-confirm");
  };
  const openWork = async (
    id: string,
    opener: HTMLElement,
    known?: OperatorWork,
    syncLocation = true,
  ) => {
    const sequence = ++detailRequest.current;
    detailOpener.current = opener;
    setSelectedWork(null);
    try {
      const item =
        known ??
        (
          await call<OperatorWorkPage>("read-works", {
            page: 1,
            pageSize: 20,
            search: id,
          })
        ).items.find((work) => work.id === id);
      if (sequence !== detailRequest.current) return;
      if (!item) {
        setNotice("该作品当前不可用。");
        return;
      }
      setSelectedWork(item);
      if (syncLocation) updateURL({ item: id });
    } catch (error) {
      if (sequence === detailRequest.current)
        setNotice(describeFailure(error).text);
    }
  };
  const itemFromURL = params.get("item");
  useEffect(() => {
    if (commandLock.current || retry !== null || bulkPending > 0) return;
    if (
      query.search !== (params.get("q") ?? "") ||
      query.page !== positivePage(params.get("page"))
    )
      return;
    if (!itemFromURL || tab === "users") {
      if (selectedWork !== null) restoreDetailFocus.current = true;
      setSelectedWork(null);
      return;
    }
    if (selectedWork?.id !== itemFromURL)
      void openWork(
        itemFromURL,
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : document.body,
        undefined,
        false,
      );
  }, [itemFromURL, tab, query.search, query.page, busy, retry, bulkPending]);
  const workActions = (item: OperatorWork) => (
    <div className={styles.actions}>
      {(["visible", "hidden", "removed"] as const)
        .filter((state) => state !== item.state)
        .map((state) => (
          <button
            type="button"
            className={styles.actionButton}
            key={state}
            disabled={disabled || item.authorDeleted || reason === null}
            onClick={() => confirmWork(item, state)}
          >
            {workActionPhrases[state]}
          </button>
        ))}
      <button
        className={styles.actionButton}
        type="button"
        aria-pressed={item.recommendation?.enabled ?? false}
        disabled={
          disabled ||
          item.authorDeleted ||
          (!item.recommendation?.enabled && item.publiclyVisible === false)
        }
        onClick={() =>
          execute(
            "set-featured",
            {
              target: { type: "work", id: item.id },
              enabled: !item.recommendation?.enabled,
              // A new explicit recommendation starts at 0; only an existing
              // explicit row keeps its own position.
              position:
                item.recommendation?.source === "work"
                  ? item.recommendation.position
                  : 0,
              expectedVersion: item.recommendation?.version ?? 0,
            },
            item.recommendation?.enabled ? "取消推荐" : "加入推荐",
          )
        }
      >
        {item.recommendation?.enabled ? "已推荐" : "加入推荐"}
      </button>
    </div>
  );
  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: tab === "users" ? "用户" : "内容" },
          {
            label:
              tab === "users"
                ? "网站用户"
                : tab === "featured"
                  ? "推荐"
                  : "用户作品",
          },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {tab === "users"
              ? "网站用户"
              : tab === "featured"
                ? "推荐"
                : "用户作品"}
          </h1>
          <p className={styles.lead}>
            {tab === "users"
              ? "查看网站用户和已提交作品。"
              : tab === "featured"
                ? "调整推荐内容与展示顺序。"
                : "查看作品，管理可见性与推荐。"}
          </p>
        </div>
      </header>
      <div className={styles.layout} data-panel-open={selectedWork !== null}>
        <section
          aria-label={
            tab === "users"
              ? "网站用户列表"
              : tab === "featured"
                ? "推荐列表"
                : "作品列表"
          }
        >
          {!activeUser && authorFromURL && tab === "works" ? (
            <button
              type="button"
              className={styles.rowLink}
              disabled={disabled}
              onClick={() => chooseTab("users")}
            >
              <UiIcon name="back" size="sm" />
              返回用户列表
            </button>
          ) : null}
          {tab === "works" && authorFromURL && authorLoading ? (
            <p role="status">读取用户资料中…</p>
          ) : null}
          {tab === "works" && authorFromURL && authorError ? (
            <div role="alert">
              {authorError}
              <button
                type="button"
                className={styles.actionButton}
                disabled={disabled || authorLoading}
                onClick={() => setAuthorRefresh((value) => value + 1)}
              >
                重新读取用户资料
              </button>
            </div>
          ) : null}
          {activeUser && tab === "works" ? (
            <section className={styles.userDetail} aria-label="用户详情">
              <button
                type="button"
                className={styles.rowLink}
                disabled={disabled}
                onClick={() => chooseTab("users")}
              >
                返回用户列表
              </button>
              <h2>{activeUser.displayName}</h2>
              <p>
                @{activeUser.handle} ·{" "}
                {activeUser.status === "active" ? "正常" : "已停用"}
              </p>
              <p>{activeUser.bio || "尚未填写简介"}</p>
              <p>
                加入于 {formatTime(activeUser.createdAt)} ·{" "}
                {activeUser.submittedWorks} 件可管理的已提交作品
              </p>
            </section>
          ) : null}
          {tab === "users" ? (
            <CommunityUsers
              disabled={bulkGate}
              reload={userReload}
              locationQuery={query}
              onQueryChange={(next) => {
                setQuery(next);
                updateURL({
                  q: next.search || null,
                  page: next.page === 1 ? null : String(next.page),
                });
              }}
              onBusy={bulkBusy}
              onPending={setBulkPending}
              onOpen={(user) => {
                setActiveUser(user);
                setTab("works");
                updateURL({
                  tab: null,
                  q: null,
                  page: null,
                  item: null,
                  author: user.id,
                  usersQ: query.search || null,
                  usersPage: query.page === 1 ? null : String(query.page),
                });
                setQuery({ page: 1, search: "" });
                setSearch("");
              }}
              onRecommend={(user) =>
                execute(
                  "recommend-user",
                  {
                    id: user.id,
                    enabled: !user.recommended,
                    expectedVersion: user.recommendationVersion,
                  },
                  user.recommended ? "取消推荐用户" : "推荐用户",
                )
              }
            />
          ) : null}
          {notice ? (
            <div className={styles.notice} role="status">
              {notice}
              {retry ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(retry)}
                  >
                    重试同一操作
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRetry(null);
                      setNotice(null);
                      void load();
                    }}
                  >
                    放弃并刷新
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {tab !== "users" ? (
            <form
              className={styles.filters}
              onSubmit={(e) => {
                e.preventDefault();
                setQuery({ page: 1, search: search.trim() });
                updateURL({ q: search.trim() || null, page: null });
              }}
            >
              <label>
                搜索{tab === "works" ? "作品、作者或作品 ID" : "推荐标题"}
                <input
                  maxLength={200}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <button
                className={styles.actionButton}
                type="submit"
                disabled={loading}
              >
                <UiIcon name="search" size="sm" />
                <span>搜索</span>
              </button>
              <button
                className={styles.actionButton}
                type="button"
                disabled={loading}
                onClick={() => void load()}
                aria-label="刷新当前页"
                title="刷新当前页"
              >
                <UiIcon name="loading" size="sm" />
              </button>
            </form>
          ) : null}
          {error ? (
            <p className={styles.notice} role="alert">
              {error}
              <button
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                重试读取
              </button>
            </p>
          ) : null}
          {loading ? <p role="status">读取中…</p> : null}
          {tab === "works" && works ? (
            <>
              <ModerationReasonInput
                label="作品处置理由（必填）"
                value={reasonDraft}
                onChange={setReasonDraft}
                disabled={disabled}
              />
              <BulkActions
                key={activeUser?.id ?? "all-works"}
                view="works"
                count={selectedIds.size}
                disabled={bulkGate}
                skipped={skipped}
                onBusy={bulkBusy}
                onPending={setBulkPending}
                onComplete={load}
                choices={[
                  { value: "feature", label: "批量推荐" },
                  { value: "unfeature", label: "批量取消推荐" },
                  {
                    value: "hidden",
                    label: "批量隐藏",
                    confirm: workBulkConfirmText.hidden,
                    requiresReason: true,
                  },
                  {
                    value: "removed",
                    label: "批量移除",
                    confirm: workBulkConfirmText.removed,
                    requiresReason: true,
                  },
                ]}
                prepare={(action) => {
                  const plan = planWorkOperations(
                    action as WorkBulkAction,
                    works.items,
                    selectedIds,
                  );
                  setSkipped(plan.skipped);
                  return plan.operations;
                }}
              />
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="选择本页所有作品"
                          disabled={
                            disabled ||
                            !works.items.some((w) => !w.authorDeleted)
                          }
                          checked={
                            works.items.some((w) => !w.authorDeleted) &&
                            works.items
                              .filter((w) => !w.authorDeleted)
                              .every((w) => selectedIds.has(w.id))
                          }
                          onChange={(e) =>
                            setSelectedIds(
                              new Set(
                                e.target.checked
                                  ? works.items
                                      .filter((w) => !w.authorDeleted)
                                      .map((w) => w.id)
                                  : [],
                              ),
                            )
                          }
                        />
                      </th>
                      <th>作品</th>
                      <th>作者</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {works.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择作品：${workTitleOf(item)}`}
                            disabled={disabled || item.authorDeleted}
                            checked={selectedIds.has(item.id)}
                            onChange={(e) =>
                              setSelectedIds((old) => {
                                const next = new Set(old);
                                if (e.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.rowLink}
                            onClick={(event) =>
                              void openWork(item.id, event.currentTarget, item)
                            }
                          >
                            {workTitleOf(item)}
                          </button>
                          {item.latestSubmission ? (
                            <span className={styles.secondary}>
                              最新公开提交 ·{" "}
                              {
                                submissionStateLabels[
                                  item.latestSubmission.disposition
                                ]
                              }
                            </span>
                          ) : null}
                          <span className={styles.secondary}>
                            {/* Null for a work never publicly exposed (self-only or
                            still awaiting its first approval). */}
                            {item.firstPublishedAt === null
                              ? "尚未公开发布"
                              : `首次发布 ${formatTime(item.firstPublishedAt)}`}
                          </span>
                        </td>
                        <td>
                          {item.authorName}
                          {item.authorStatus === "suspended" ? (
                            <span
                              className={styles.chip}
                              data-state="suspended"
                            >
                              账号已停用
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span
                            className={styles.chip}
                            data-state={
                              item.authorDeleted ? "removed" : item.state
                            }
                          >
                            {item.authorDeleted
                              ? "作者已删除"
                              : labels[item.state]}
                          </span>
                          <span className={styles.secondary}>
                            {item.publiclyVisible
                              ? "当前对外公开"
                              : "当前不对外显示"}
                          </span>
                        </td>
                        <td>{workActions(item)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {works.total === 0 ? <p>没有符合条件的作品。</p> : null}
              <Pager
                page={query.page}
                total={works.total}
                busy={loading || busy}
                onPage={(page) => {
                  setQuery((q) => ({ ...q, page }));
                  updateURL({ page: page === 1 ? null : String(page) });
                }}
              />
            </>
          ) : null}
          {tab === "featured" ? (
            <>
              <div className={styles.tabs} aria-label="推荐筛选">
                <button
                  type="button"
                  className={styles.tab}
                  aria-pressed={featuredFilter === "active"}
                  disabled={disabled}
                  onClick={() => {
                    setFeaturedFilter("active");
                    updateURL({ filter: null, page: null });
                    setQuery((q) => ({ ...q, page: 1 }));
                  }}
                >
                  当前推荐
                </button>
                <button
                  type="button"
                  className={styles.tab}
                  aria-pressed={featuredFilter === "all"}
                  disabled={disabled}
                  onClick={() => {
                    setFeaturedFilter("all");
                    updateURL({ filter: "all", page: null });
                    setQuery((q) => ({ ...q, page: 1 }));
                  }}
                >
                  全部推荐设置
                </button>
              </div>
              {featured ? (
                <>
                  <form
                    className={styles.filters}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value =
                        quantity.trim() === "" ? null : Number(quantity);
                      if (
                        value !== null &&
                        (!Number.isSafeInteger(value) || value < 0)
                      ) {
                        setNotice("推荐数量须为非负整数；留空表示不限。");
                        return;
                      }
                      execute(
                        "set-featured-quantity",
                        {
                          enabledQuantity: value,
                          expectedVersion: featured.settingsVersion,
                        },
                        "推荐数量",
                      );
                    }}
                  >
                    <label>
                      启用数量（留空不限，0 暂停推荐）
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      className={styles.actionButton}
                      disabled={disabled}
                    >
                      保存数量
                    </button>
                  </form>
                  <p className={styles.secondary}>
                    按顺序值从小到大排列，同值按内容身份稳定排序。不可用内容保留配置但不展示；恢复后重新参与推荐。正在浏览的列表保持原有顺序，刷新后使用新配置。
                  </p>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>内容</th>
                          <th>展示资格</th>
                          <th>排序与启用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {featured.items.map((item) => (
                          <FeaturedRow
                            onOpenWork={(id, opener) =>
                              void openWork(id, opener)
                            }
                            key={`${item.target.type}:${item.target.id}:${item.version}`}
                            item={item}
                            disabled={disabled}
                            onSave={(position, enabled) =>
                              execute(
                                "set-featured",
                                {
                                  target: item.target,
                                  position,
                                  enabled,
                                  expectedVersion: item.version,
                                },
                                "推荐设置",
                              )
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {featured.total === 0 ? (
                    <p>尚无符合条件的推荐配置。</p>
                  ) : null}
                  <Pager
                    page={query.page}
                    total={featured.total}
                    busy={loading || busy}
                    onPage={(page) => {
                      setQuery((q) => ({ ...q, page }));
                      updateURL({ page: page === 1 ? null : String(page) });
                    }}
                  />
                </>
              ) : null}
              <CatalogPicker
                disabled={disabled}
                onFeature={(id, title) =>
                  feature({ type: "catalog", id }, title)
                }
              />
              <p>
                用户作品可在「用户作品」页加入推荐；已经加入的内容请在推荐列表中编辑。
              </p>
            </>
          ) : null}
        </section>
        {selectedWork === null ? null : (
          <WorkDetailPanel
            key={selectedWork.id}
            item={selectedWork}
            actions={workActions(selectedWork)}
            onClose={() => {
              detailRequest.current++;
              restoreDetailFocus.current = true;
              setSelectedWork(null);
              updateURL({ item: null });
            }}
          />
        )}
      </div>
      <ConfirmationModal
        heading="确认作品管理状态变更"
        modalSlug="community-work-confirm"
        cancelLabel="取消"
        confirmLabel="确认保存"
        confirmingLabel="保存中…"
        body={
          <>
            <p>
              {confirmation?.label}
              。隐藏或移除会限制访问；解除管理限制仍遵循作者的可见范围和当前审核结果，不会代替审核通过。原有身份、首次发布时间和审计记录保留。
            </p>
            <p className={styles.reportText}>
              处置理由：{String(confirmation?.input.reason ?? "")}
            </p>
          </>
        }
        onConfirm={async () => {
          closeModal("community-work-confirm");
          if (confirmation) await run(confirmation);
          setConfirmation(null);
        }}
      />
    </div>
  );
};

const FeaturedRow = ({
  item,
  disabled,
  onSave,
  onOpenWork,
}: {
  item: FeaturedPage["items"][number];
  disabled: boolean;
  onSave: (position: number, enabled: boolean) => void;
  onOpenWork: (id: string, opener: HTMLElement) => void;
}) => {
  const [position, setPosition] = useState(
    item.version === 0 ? "" : String(item.position),
  );
  const [enabled, setEnabled] = useState(item.enabled);
  const [error, setError] = useState(false);
  return (
    <tr>
      <td>
        {item.target.type === "work" ? (
          <button
            type="button"
            className={styles.rowLink}
            onClick={(event) => onOpenWork(item.target.id, event.currentTarget)}
          >
            {item.title || UNTITLED_WORK} · 查看详情
          </button>
        ) : (
          (item.title ?? "当前不可用的内容")
        )}
        <span className={styles.secondary}>
          {item.target.type === "work" ? "用户作品" : "资料"} · {item.target.id}
        </span>
      </td>
      <td>{item.eligible ? "可展示" : "不可展示（配置保留）"}</td>
      <td>
        <form
          className={styles.filters}
          onSubmit={(e) => {
            e.preventDefault();
            const automatic = item.version === 0 && position === "";
            const value = automatic ? item.position : Number(position);
            if (
              !Number.isSafeInteger(value) ||
              value < 0 ||
              (position === "" && !automatic)
            ) {
              setError(true);
              return;
            }
            setError(false);
            onSave(value, enabled);
          }}
        >
          <label>
            顺序
            <input
              aria-label={`顺序：${item.title ?? item.target.id}`}
              placeholder={item.version === 0 ? "自动" : undefined}
              type="number"
              min="0"
              step="1"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用
          </label>
          <button
            className={styles.actionButton}
            type="submit"
            // An ineligible row cannot be enabled; disabling or keeping it disabled is allowed.
            disabled={disabled || (!item.eligible && enabled)}
          >
            保存
          </button>
          {error ? <span role="alert">请输入非负整数顺序。</span> : null}
        </form>
      </td>
    </tr>
  );
};

const CatalogPicker = ({
  disabled,
  onFeature,
}: {
  disabled: boolean;
  onFeature: (id: string, title: string) => void;
}) => {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<{ page: number; search: string } | null>(
    null,
  );
  const [data, setData] = useState<CandidatePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    if (!query) return;
    const epoch = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await call<CandidatePage>("read-feature-catalogs", {
        ...query,
        pageSize: PAGE_SIZE,
      });
      if (epoch === sequence.current) setData(result);
    } catch (e) {
      if (epoch === sequence.current) setError(describeFailure(e).text);
    } finally {
      if (epoch === sequence.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  return (
    <section className={styles.card}>
      <h2>添加已公开资料</h2>
      <form
        className={styles.filters}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ page: 1, search: search.trim() });
        }}
      >
        <label>
          资料标题
          <input
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className={styles.actionButton}
          disabled={loading}
        >
          查找资料
        </button>
      </form>
      {error ? (
        <p role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </p>
      ) : null}
      {loading ? <p role="status">读取中…</p> : null}
      {data ? (
        <>
          <ul>
            {data.items.map((item) => (
              <li key={item.id}>
                {item.title}{" "}
                <button
                  type="button"
                  className={styles.actionButton}
                  disabled={disabled}
                  onClick={() => onFeature(item.id, item.title)}
                >
                  加入推荐
                </button>
              </li>
            ))}
          </ul>
          {data.total === 0 ? <p>没有符合条件的已公开资料。</p> : null}
          <Pager
            page={query?.page ?? 1}
            total={data.total}
            busy={loading}
            onPage={(page) => setQuery((q) => (q ? { ...q, page } : q))}
          />
        </>
      ) : null}
    </section>
  );
};

const WorkDetailPanel = ({
  item,
  actions,
  onClose,
}: {
  item: OperatorWork;
  actions: React.ReactNode;
  onClose: () => void;
}) => {
  const panel = useRef<HTMLElement | null>(null);
  const [revision, setRevision] = useState(
    item.latestSubmission?.revisionId ?? item.publicRevisionId,
  );
  const [detail, setDetail] = useState<OperatorWorkSubmission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    panel.current?.focus();
    panel.current?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    if (revision)
      void call<OperatorWorkSubmission>("read-work-submission", {
        id: revision,
      }).then(
        (data) => {
          if (current) setDetail(data);
        },
        (error) => {
          if (current) setError(describeFailure(error).text);
        },
      );
    return () => {
      current = false;
    };
  }, [revision, retry]);
  return (
    <section
      className={styles.panel}
      ref={panel}
      tabIndex={-1}
      aria-label="作品详情与管理"
      data-work-management-detail=""
    >
      <div className={styles.panelHeader}>
        <h2>{workTitleOf(item)}</h2>
        <button type="button" className={styles.actionButton} onClick={onClose}>
          返回列表
        </button>
      </div>
      <details>
        <summary>详细信息</summary>
        <p>作品编号：{item.id}</p>
        <p>作者编号：{item.authorId}</p>
      </details>
      <p>
        {item.publiclyVisible ? "当前对外公开" : "当前不对外显示"} · 管理状态：
        {labels[item.state]}
      </p>
      {actions}
      <div className={styles.tabs}>
        {item.latestSubmission ? (
          <button
            className={styles.tab}
            type="button"
            aria-pressed={revision === item.latestSubmission.revisionId}
            onClick={() => setRevision(item.latestSubmission!.revisionId)}
          >
            最新公开提交
          </button>
        ) : null}
        {item.publicRevisionId &&
        item.publicRevisionId !== item.latestSubmission?.revisionId ? (
          <button
            className={styles.tab}
            type="button"
            aria-pressed={revision === item.publicRevisionId}
            onClick={() => setRevision(item.publicRevisionId)}
          >
            {item.publiclyVisible ? "当前公开版本" : "上次公开版本"}
          </button>
        ) : null}
      </div>
      {!revision ? (
        <p>
          暂无可供管理查看的公开提交。私人草稿和仅自己可见的提交不在此展示。
        </p>
      ) : error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            重试读取详情
          </button>
        </p>
      ) : detail === null ? (
        <p role="status">正在读取详情…</p>
      ) : (
        <SubmissionDetail
          key={detail.revisionId}
          data={detail}
          actions={
            <Link
              href={`/admin/community-moderation/work-submissions?item=${encodeURIComponent(detail.revisionId)}`}
            >
              打开提交审核与处理
            </Link>
          }
        />
      )}
    </section>
  );
};
