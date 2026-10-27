"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useEffect, useRef, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";

import { TIME_ZONE_NOTE, call, describeFailure, formatTime } from "./api";
import type { OperatorFeedbackPage } from "./api";
import styles from "./community.module.css";

/** Read-only feedback, through the same Owner-only operator boundary. */
export const CommunityFeedbackClient = () => {
  const [pageNumber, setPageNumber] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<OperatorFeedbackPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setLoading(true);
    setPage(null);
    setError(null);
    void call<OperatorFeedbackPage>(
      "read-feedback",
      { page: pageNumber, pageSize: 20 },
      controller.signal,
    )
      .then((result) => {
        if (current === sequence.current) setPage(result);
      })
      .catch((failure) => {
        if (current === sequence.current)
          setError(describeFailure(failure).text);
      })
      .finally(() => {
        if (current === sequence.current) setLoading(false);
      });
    return () => {
      sequence.current++;
      controller.abort();
    };
  }, [pageNumber, refresh]);

  const totalPages = page === null ? 0 : Math.ceil(page.total / page.pageSize);
  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "审核", url: "/admin/community-moderation" },
          { label: workspacePageLabel("/admin/community-moderation/feedback") },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation/feedback")}
          </h1>
          <p className={styles.lead}>
            用户从设置提交的反馈与建议，最新在前；{TIME_ZONE_NOTE}。
          </p>
        </div>
        <button
          className={styles.actionButton}
          disabled={loading}
          onClick={() => {
            setPageNumber(1);
            setRefresh((value) => value + 1);
          }}
          type="button"
          aria-label="刷新反馈"
          title="刷新反馈"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </header>

      <section aria-busy={loading} aria-label="用户反馈列表">
        {error !== null ? (
          <p className={styles.state} role="alert">
            无法读取用户反馈：{error}{" "}
            <button
              className={styles.rowLink}
              onClick={() => setRefresh((value) => value + 1)}
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
          <p className={styles.state}>暂无用户反馈。</p>
        ) : (
          <div className={styles.workspace}>
            {page.items.map((item) => (
              <article
                aria-label={`${item.user.displayName} 的反馈`}
                className={styles.userDetail}
                data-feedback-id={item.id}
                key={item.id}
              >
                <div className={styles.summaryLine}>
                  <strong>{item.user.displayName}</strong>
                  <time dateTime={item.createdAt}>
                    {formatTime(item.createdAt)}
                  </time>
                </div>
                <span className={styles.secondary}>
                  用户 ID：{item.user.id}
                </span>
                <p className={styles.fullText}>{item.message}</p>
                {item.images?.length ? (
                  <div className={styles.mediaGrid} aria-label="反馈配图">
                    {item.images.map((image, index) => (
                      <a
                        className={styles.mediaFrame}
                        href={image.src}
                        key={image.id}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`查看反馈配图 ${index + 1}`}
                      >
                        <img
                          src={image.thumbSrc}
                          alt={`反馈配图 ${index + 1}`}
                          width={image.width}
                          height={image.height}
                          loading="lazy"
                        />
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {page === null ? null : (
          <div className={styles.pager}>
            <span>
              共 {page.total} 条 · 第 {page.total === 0 ? 0 : page.page} /{" "}
              {totalPages} 页
            </span>
            <div className={styles.actions}>
              <button
                className={styles.actionButton}
                disabled={page.page <= 1 || loading}
                onClick={() => setPageNumber((value) => value - 1)}
                type="button"
                aria-label="上一页"
                title="上一页"
              >
                <span aria-hidden="true">←</span>
              </button>
              <button
                className={styles.actionButton}
                disabled={page.page >= totalPages || loading}
                onClick={() => setPageNumber((value) => value + 1)}
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
