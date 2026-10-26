"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SetStepNav } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  actionLabels,
  call,
  describeFailure,
  formatTime,
  subjectKindLabels,
} from "./api";
import styles from "./community.module.css";

import type {
  ModerationEventAction,
  ModerationEventPage,
} from "@moya/contracts/internal/community-operator";

const actions = Object.keys(actionLabels) as ModerationEventAction[];

const readQuery = (params: URLSearchParams) => {
  const action = params.get("action");
  const page = Number(params.get("page") ?? "1");
  return {
    action: actions.includes(action as ModerationEventAction)
      ? (action as ModerationEventAction)
      : "all",
    subject: (params.get("subject") ?? "").slice(0, 128),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
};

const subjectHref = (kind: string, id: string): string | null =>
  kind === "comment" || kind === "reply"
    ? `/admin/community-moderation?status=all&item=${encodeURIComponent(id)}`
    : kind === "setting"
      ? "/admin/community-moderation/settings"
      : null;

/** The operation history, straight from the authoritative audit records. */
export const CommunityHistoryClient = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => readQuery(searchParams), [searchParams]);
  const [page, setPage] = useState<ModerationEventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const navigate = (patch: Partial<typeof query>) => {
    const next = { ...query, ...patch };
    const params = new URLSearchParams();
    if (next.action !== "all") params.set("action", next.action);
    if (next.subject !== "") params.set("subject", next.subject);
    if (next.page !== 1) params.set("page", String(next.page));
    const encoded = params.toString();
    router.replace(`${pathname}${encoded === "" ? "" : `?${encoded}`}`, {
      scroll: false,
    });
  };

  const load = useCallback(async () => {
    const current = (sequence.current += 1);
    setLoading(true);
    try {
      const result = await call<ModerationEventPage>("read-events", {
        ...(query.action === "all" ? {} : { action: query.action }),
        ...(query.subject === "" ? {} : { subjectId: query.subject }),
        page: query.page,
        pageSize: 20,
      });
      if (current !== sequence.current) return;
      setPage(result);
      setError(null);
    } catch (failure) {
      if (current !== sequence.current) return;
      setError(describeFailure(failure).text);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [query.action, query.subject, query.page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "操作记录", url: "/admin/community-moderation/history" },
          { label: "社区操作" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation/history")}
          </h1>
          <p className={styles.lead}>
            查看审核、账号和设置的操作记录；{TIME_ZONE_NOTE}。
          </p>
        </div>
      </header>

      <div className={styles.filters}>
        <label>
          操作类型
          <select
            onChange={(event) =>
              navigate({
                action: event.currentTarget.value as
                  ModerationEventAction | "all",
                page: 1,
              })
            }
            value={query.action}
          >
            <option value="all">全部操作</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {actionLabels[action]}
              </option>
            ))}
          </select>
        </label>
        {query.subject === "" ? null : (
          <span className={styles.summaryLine}>
            仅显示对象 <span className={styles.mono}>{query.subject}</span>{" "}
            <button
              className={styles.rowLink}
              onClick={() => navigate({ subject: "", page: 1 })}
              type="button"
            >
              清除
            </button>
          </span>
        )}
      </div>

      <section aria-busy={loading} aria-label="操作记录" data-history-list="">
        {error !== null ? (
          <p className={styles.state} role="alert">
            无法读取操作记录：{error}{" "}
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
            正在读取…
          </p>
        ) : page.items.length === 0 ? (
          <p className={styles.state}>暂无操作记录。</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">操作</th>
                  <th scope="col">对象</th>
                  <th scope="col">操作者</th>
                  <th scope="col">备注</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((event) => {
                  const href = subjectHref(event.subjectKind, event.subjectId);
                  return (
                    <tr data-history-row={event.id} key={event.id}>
                      <td>
                        <time dateTime={event.occurredAt}>
                          {formatTime(event.occurredAt)}
                        </time>
                      </td>
                      <td>{actionLabels[event.action]}</td>
                      <td>
                        {subjectKindLabels[event.subjectKind]}
                        <span className={styles.secondary}>
                          {href === null ? (
                            <span className={styles.mono}>
                              {event.subjectId}
                            </span>
                          ) : (
                            <Link className={styles.mono} href={href}>
                              {event.subjectId}
                            </Link>
                          )}
                        </span>
                      </td>
                      <td>{event.operatorLabel}</td>
                      <td>{event.detail ?? ""}</td>
                    </tr>
                  );
                })}
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
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
