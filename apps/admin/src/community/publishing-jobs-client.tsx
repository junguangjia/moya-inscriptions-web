"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConfirmationModal, SetStepNav, useModal } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  call,
  describeFailure,
  describeFinalFailure,
  formatPreciseTime,
  formatTime,
  jobKindLabels,
  jobStateLabels,
  outcomeUnknown,
} from "./api";
import styles from "./community.module.css";
import { publishingJobActions } from "./work-publishing-rules";

import type {
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  PublishingJobAction,
  PublishingJobKind,
  PublishingJobState,
} from "./api";

interface Notice {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

interface JobCommand {
  readonly job: OperatorPublishingJob;
  readonly action: PublishingJobAction;
  readonly requestId: string;
}

type StateFilter = PublishingJobState | "all";
type KindFilter = PublishingJobKind | "all";

const CONFIRM_SLUG = "community-publishing-job-confirm";
const PAGE_SIZE = 20;
const stateFilters: readonly StateFilter[] = [
  "failed",
  "abandoned",
  "running",
  "queued",
  "succeeded",
  "all",
];
const kinds = Object.keys(jobKindLabels) as PublishingJobKind[];

const readQuery = (params: URLSearchParams) => {
  const state = params.get("state");
  const kind = params.get("kind");
  const page = Number(params.get("page") ?? "1");
  return {
    state: stateFilters.includes(state as StateFilter)
      ? (state as StateFilter)
      : "failed",
    kind: kinds.includes(kind as PublishingJobKind)
      ? (kind as PublishingJobKind)
      : ("all" as KindFilter),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
};

type Query = ReturnType<typeof readQuery>;

const actionLabels: Record<PublishingJobAction, string> = {
  retry: "重新排队",
  abandon: "放弃任务",
};

/** The states in which each action still applies; the Backend checks the same at the time of the command. */
const applicableStates: Record<PublishingJobAction, string> = {
  retry: `「${jobStateLabels.failed}」或「${jobStateLabels.abandoned}」`,
  abandon: `「${jobStateLabels.queued}」或「${jobStateLabels.failed}」`,
};

const chipState = (state: PublishingJobState): string =>
  state === "failed"
    ? "suspended"
    : state === "succeeded"
      ? "visible"
      : state === "abandoned"
        ? "hidden"
        : "pending";

/**
 * Content-free publishing job outcomes: kind, subject id, attempts, the last
 * error code and times. Never a payload, path, file name or message. The
 * Owner may re-queue a failed or abandoned job, or abandon a queued or failed
 * one; the Backend keeps its reference rechecks, so a retry never deletes
 * anything still referenced.
 */
export const PublishingJobsClient = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => readQuery(searchParams), [searchParams]);
  const { openModal, closeModal } = useModal();

  const [page, setPage] = useState<OperatorPublishingJobPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<JobCommand | null>(null);
  const [retry, setRetry] = useState<JobCommand | null>(null);
  const lock = useRef(false);
  const sequence = useRef(0);
  // The latest filters, so a reload after a command lists what is on screen now.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const navigate = (patch: Partial<Query>) => {
    const next = { ...query, ...patch };
    const params = new URLSearchParams();
    if (next.state !== "failed") params.set("state", next.state);
    if (next.kind !== "all") params.set("kind", next.kind);
    if (next.page !== 1) params.set("page", String(next.page));
    const encoded = params.toString();
    router.replace(`${pathname}${encoded === "" ? "" : `?${encoded}`}`, {
      scroll: false,
    });
  };

  const load = useCallback(async () => {
    const current = (sequence.current += 1);
    const { state, kind, page: pageNumber } = queryRef.current;
    setLoading(true);
    try {
      const result = await call<OperatorPublishingJobPage>(
        "read-publishing-jobs",
        {
          ...(state === "all" ? {} : { state }),
          ...(kind === "all" ? {} : { kind }),
          page: pageNumber,
          pageSize: PAGE_SIZE,
        },
      );
      if (current !== sequence.current) return;
      setPage(result);
      setLoadError(null);
    } catch (failure) {
      if (current !== sequence.current) return;
      setLoadError(describeFailure(failure).text);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, query.state, query.kind, query.page]);

  const run = async (command: JobCommand) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const { job, action, requestId } = command;
    const label = `${jobKindLabels[job.kind]}（${job.subjectId}）`;
    try {
      await call<OperatorPublishingJob>(
        action === "retry" ? "retry-publishing-job" : "abandon-publishing-job",
        { id: job.id, requestId },
      );
      setRetry(null);
      setReceipt({
        tone: "success",
        text:
          action === "retry"
            ? `已重新排队：${label}。`
            : `已放弃：${label}；不会再自动执行。`,
      });
      await load();
    } catch (failure) {
      const { code, text } = describeFailure(failure);
      if (outcomeUnknown(failure)) {
        // Outcome unknown: the same request identity may be re-sent safely.
        setRetry(command);
        setReceipt({
          tone: "error",
          text: `${actionLabels[action]}结果未确认（${label}）：${text}`,
        });
      } else {
        setRetry(null);
        setReceipt({
          tone: "error",
          text:
            code === "STATE_CONFLICT"
              ? `${actionLabels[action]}未执行（${label}）：任务已不处于${applicableStates[action]}状态，已刷新列表。`
              : code === "OPERATOR_RESPONSE_INVALID"
                ? `${actionLabels[action]}结果无法确认（${label}）：${text}已刷新列表。`
                : `${actionLabels[action]}未执行（${label}）：${describeFinalFailure(failure)}`,
        });
        await load();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "发布工具", url: "/admin/editorial-workflow" },
          { label: "发布进度" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation/publishing-jobs")}
          </h1>
          <p className={styles.lead}>
            查看图片处理、清理进度与失败原因；
            {TIME_ZONE_NOTE}。
          </p>
        </div>
      </header>

      <div className={styles.filters}>
        <label>
          状态
          <select
            onChange={(event) =>
              navigate({
                state: event.currentTarget.value as StateFilter,
                page: 1,
              })
            }
            value={query.state}
          >
            {stateFilters.map((state) => (
              <option key={state} value={state}>
                {state === "all" ? "全部状态" : jobStateLabels[state]}
              </option>
            ))}
          </select>
        </label>
        <label>
          类型
          <select
            onChange={(event) =>
              navigate({
                kind: event.currentTarget.value as KindFilter,
                page: 1,
              })
            }
            value={query.kind}
          >
            <option value="all">全部类型</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {jobKindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <button
          className={styles.actionButton}
          disabled={loading}
          onClick={() => void load()}
          type="button"
          aria-label="刷新"
          title="刷新"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>

      {receipt === null ? null : (
        <p className={styles.receipt} data-tone={receipt.tone} role="status">
          {receipt.text}
          {retry === null ? null : (
            <>
              {" "}
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => void run(retry)}
                type="button"
              >
                重试同一操作
              </button>
              {" · "}
              <button
                className={styles.rowLink}
                disabled={busy}
                onClick={() => {
                  setRetry(null);
                  void load();
                }}
                type="button"
              >
                放弃并刷新
              </button>
            </>
          )}
        </p>
      )}

      <section
        aria-busy={loading}
        aria-label="发布进度"
        data-publishing-job-list=""
      >
        {loadError !== null ? (
          <p className={styles.state} role="alert">
            无法读取发布进度：{loadError}{" "}
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
          <p className={styles.state}>没有符合条件的任务。</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">任务</th>
                  <th scope="col">状态</th>
                  <th scope="col">次数</th>
                  <th scope="col">最近错误</th>
                  <th scope="col">时间</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((job) => (
                  <tr
                    data-busy={busy && confirmation?.job.id === job.id}
                    data-publishing-job-row={job.id}
                    key={job.id}
                  >
                    <td>
                      {jobKindLabels[job.kind]}
                      <span className={`${styles.secondary} ${styles.mono}`}>
                        {job.subjectId}
                      </span>
                      <span className={`${styles.secondary} ${styles.mono}`}>
                        {job.id}
                      </span>
                    </td>
                    <td>
                      <span
                        className={styles.chip}
                        data-state={chipState(job.state)}
                      >
                        {jobStateLabels[job.state]}
                      </span>
                      {job.state === "running" &&
                      job.leaseExpiresAt !== null ? (
                        <span className={styles.secondary}>
                          租约至{" "}
                          <time dateTime={job.leaseExpiresAt}>
                            {formatTime(job.leaseExpiresAt)}
                          </time>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {job.attempts} / {job.maxAttempts}
                    </td>
                    <td>
                      {job.lastErrorCode === null ? (
                        <span className={styles.secondary}>无</span>
                      ) : (
                        <span className={styles.mono}>{job.lastErrorCode}</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.secondary}>
                        创建{" "}
                        <time dateTime={job.createdAt}>
                          {formatTime(job.createdAt)}
                        </time>
                      </span>
                      <span className={styles.secondary}>
                        更新{" "}
                        <time
                          dateTime={job.updatedAt}
                          title={formatPreciseTime(job.updatedAt)}
                        >
                          {formatTime(job.updatedAt)}
                        </time>
                      </span>
                      {job.state === "queued" ? (
                        <span className={styles.secondary}>
                          计划{" "}
                          <time dateTime={job.runAfter}>
                            {formatTime(job.runAfter)}
                          </time>
                        </span>
                      ) : null}
                      {job.finishedAt === null ? null : (
                        <span className={styles.secondary}>
                          结束{" "}
                          <time dateTime={job.finishedAt}>
                            {formatTime(job.finishedAt)}
                          </time>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        {publishingJobActions(job.state).map((action) => (
                          <button
                            className={styles.actionButton}
                            data-danger={action === "abandon"}
                            data-publishing-job-action={action}
                            disabled={busy || retry !== null}
                            key={action}
                            onClick={() => {
                              setConfirmation({
                                job,
                                action,
                                requestId: crypto.randomUUID(),
                              });
                              openModal(CONFIRM_SLUG);
                            }}
                            type="button"
                          >
                            {actionLabels[action]}…
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page === null ? null : (
          <div className={styles.pager}>
            <span>
              共 {page.total} 个 · 第 {page.total === 0 ? 0 : page.page} /{" "}
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

      <ConfirmationModal
        body={
          confirmation === null ? (
            <p />
          ) : (
            <div>
              <p>
                将对任务「{jobKindLabels[confirmation.job.kind]}」（对象{" "}
                <span className={styles.mono}>
                  {confirmation.job.subjectId}
                </span>
                ，已执行 {confirmation.job.attempts} 次）执行「
                {actionLabels[confirmation.action]}」。
              </p>
              <p>
                {confirmation.action === "retry"
                  ? "任务会重新排队，由后台按顺序执行；清理类任务执行前仍会重新检查引用，不会删除仍被草稿、版本或会话引用的内容。"
                  : "任务将不再自动执行，相关对象保持当前状态。"}
              </p>
              <p>
                只有任务届时仍为{applicableStates[confirmation.action]}
                时才会执行；否则不会执行，列表会刷新。
              </p>
            </div>
          )
        }
        cancelLabel="取消"
        confirmLabel={
          confirmation?.action === "abandon" ? "确认放弃" : "确认重新排队"
        }
        confirmingLabel="处理中…"
        heading={
          confirmation?.action === "abandon" ? "确认放弃任务" : "确认重新排队"
        }
        modalSlug={CONFIRM_SLUG}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          closeModal(CONFIRM_SLUG);
          const target = confirmation;
          if (target !== null) await run(target);
          setConfirmation(null);
        }}
      />
    </div>
  );
};
