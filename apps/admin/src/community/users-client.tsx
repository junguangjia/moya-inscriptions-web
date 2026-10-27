"use client";
import { useEffect, useRef, useState } from "react";
import type {
  OperatorUser,
  OperatorUserPage,
} from "@moya/contracts/internal/community-operator";
import { call, describeFailure, formatTime, userStatusLabels } from "./api";
import { BulkActions } from "./bulk-actions";
import styles from "./community.module.css";

export const CommunityUsers = ({
  disabled,
  reload,
  onOpen,
  onRecommend,
  onBusy,
  onPending,
  locationQuery,
  onQueryChange,
}: {
  disabled: boolean;
  reload: number;
  onOpen: (user: OperatorUser) => void;
  onRecommend: (user: OperatorUser) => void;
  onBusy: (busy: boolean) => void;
  /** How many selected-user commands still await confirmation; the owner gates navigation on it. */
  onPending?: (count: number) => void;
  locationQuery?: { page: number; search: string };
  onQueryChange?: (query: { page: number; search: string }) => void;
}) => {
  const [localQuery, setLocalQuery] = useState({ page: 1, search: "" });
  const query = locationQuery ?? localQuery;
  const setQuery = (
    next:
      | typeof query
      | ((query: { page: number; search: string }) => {
          page: number;
          search: string;
        }),
  ) => {
    const value = typeof next === "function" ? next(query) : next;
    if (onQueryChange) onQueryChange(value);
    else setLocalQuery(value);
  };
  const [search, setSearch] = useState(query.search);
  useEffect(() => {
    setSearch(query.search);
  }, [query.search]);
  const [data, setData] = useState<OperatorUserPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const n = ++epoch.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSelected(new Set());
    void call<OperatorUserPage>(
      "read-users",
      { ...query, pageSize: 20 },
      controller.signal,
    )
      .then((page) => {
        if (n === epoch.current) setData(page);
      })
      .catch((e) => {
        if (n === epoch.current) setError(describeFailure(e).text);
      })
      .finally(() => {
        if (n === epoch.current) setLoading(false);
      });
    return () => {
      epoch.current++;
      controller.abort();
    };
  }, [query, refresh, reload]);
  const bulkGate = disabled || loading || error !== null;
  const blocked = bulkGate || pending > 0;
  const rows = data?.items ?? [];
  return (
    <section aria-label="用户管理" className={styles.workspace}>
      <form
        className={styles.filters}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ page: 1, search: search.trim() });
        }}
      >
        <label>
          搜索昵称、账号或用户 ID
          <input
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className={styles.actionButton}
          disabled={disabled || loading}
        >
          搜索用户
        </button>
        <button
          type="button"
          className={styles.actionButton}
          disabled={disabled || loading}
          onClick={() => setRefresh((r) => r + 1)}
        >
          刷新用户
        </button>
      </form>
      <p className={styles.lead}>
        推荐用户后，其符合公开条件的已有和新作品自动加入推荐。单篇作品的明确推荐设置优先。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">读取中…</p> : null}
      <BulkActions
        view="users"
        count={selected.size}
        disabled={bulkGate}
        onBusy={onBusy}
        onPending={(count) => {
          setPending(count);
          onPending?.(count);
        }}
        choices={[
          { value: "enable", label: "批量推荐用户" },
          { value: "disable", label: "批量取消推荐用户" },
        ]}
        prepare={(action) =>
          rows
            .filter((u) => selected.has(u.id))
            .map((u) => ({
              id: u.id,
              label: u.displayName,
              name: "recommend-user",
              input: {
                id: u.id,
                enabled: action === "enable",
                expectedVersion: u.recommendationVersion,
              },
            }))
        }
        onComplete={async () => {
          setRefresh((r) => r + 1);
          setSelected(new Set());
        }}
      />
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="选择本页所有用户"
                  disabled={blocked || rows.length === 0}
                  checked={
                    rows.length > 0 && rows.every((u) => selected.has(u.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      new Set(e.target.checked ? rows.map((u) => u.id) : []),
                    )
                  }
                />
              </th>
              <th>用户</th>
              <th>状态</th>
              <th>已提交作品</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择用户：${u.displayName}`}
                    disabled={blocked}
                    checked={selected.has(u.id)}
                    onChange={(e) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.rowLink}
                    disabled={blocked}
                    onClick={() => onOpen(u)}
                  >
                    {u.displayName} · 查看详情与作品
                  </button>
                  <span className={styles.secondary}>@{u.handle}</span>
                  <span className={styles.secondary}>
                    加入于 {formatTime(u.createdAt)}
                  </span>
                </td>
                <td>{userStatusLabels[u.status]}</td>
                <td>{u.submittedWorks}</td>
                <td>
                  {/* A deleted account is never recommended again; only an
                      earlier recommendation can still be withdrawn. */}
                  {u.status === "deleted" && !u.recommended ? (
                    <span className={styles.secondary}>不可推荐</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.actionButton}
                      aria-pressed={u.recommended}
                      disabled={blocked}
                      onClick={() => onRecommend(u)}
                    >
                      {u.recommended ? "已推荐用户" : "推荐用户"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.total === 0 ? <p>没有符合条件的用户。</p> : null}
      <div className={styles.pager}>
        <span>
          共 {data?.total ?? "—"} 位用户 · 第{" "}
          {data?.total === 0 ? 0 : query.page} 页
        </span>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={disabled || loading || query.page === 1}
            onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}
            aria-label="上一页"
            title="上一页"
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            disabled={
              disabled || loading || query.page * 20 >= (data?.total ?? 0)
            }
            onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}
            aria-label="下一页"
            title="下一页"
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </section>
  );
};
