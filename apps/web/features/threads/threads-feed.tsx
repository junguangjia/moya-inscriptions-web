"use client";
import { DiscussionCount, Heat } from "../discussion-preview/discussion-icons";
import styles from "../discussion-preview/discussion-preview.module.css";
import homeStyles from "../home/home-screen.module.css";
import { useThreads } from "./use-threads";
import { useEffect, useRef } from "react";
import { useSubmission } from "../publishing/publishing-provider";

/**
 * 话题: operator-managed Threads ranked by the server heat at one anchor.
 * A signed-in reader's opened Threads turn gray from the server-observed
 * marker; a guest keeps a session-local memory only.
 */
export function ThreadsFeed({
  localRead,
  onOpen,
}: {
  readonly localRead: ReadonlySet<string>;
  readonly onOpen: (id: string, opener: HTMLElement) => void;
}) {
  const { state, busy, refresh, loadMore } = useThreads();
  // A confirmed submission (a Thread post) re-ranks the list at a new anchor.
  const submission = useSubmission().state;
  const confirmed = useRef<string | null>(null);
  useEffect(() => {
    if (submission.status !== "confirmed") return;
    if (confirmed.current === submission.receipt.requestId) return;
    confirmed.current = submission.receipt.requestId;
    refresh();
  }, [submission, refresh]);
  if (state.state !== "populated")
    return (
      <section
        className={homeStyles.stateMessage}
        role={state.state === "unavailable" ? "alert" : "status"}
        data-threads-state={state.state}
      >
        <h2>
          {state.state === "loading"
            ? "正在加载"
            : state.state === "empty"
              ? "暂无话题"
              : "话题暂时不可用"}
        </h2>
        {state.state === "unavailable" && (
          <button type="button" onClick={refresh}>
            重试
          </button>
        )}
      </section>
    );
  return (
    <div
      className={styles.feed}
      data-threads-feed=""
      data-threads-anchor={state.anchor}
    >
      <ol
        className={styles.ranking}
        aria-label={`${state.items.length} 条热门话题`}
      >
        {state.items.map((item, index) => {
          const read =
            item.unread === null
              ? localRead.has(item.id)
              : item.unread === false;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-topic-id={item.id}
                data-read={read}
                data-thread-status={item.status}
                onClick={(event) => onOpen(item.id, event.currentTarget)}
              >
                <span className={styles.rank} data-top={index < 3}>
                  {index + 1}
                </span>
                <span className={styles.rankCopy}>
                  <strong>{item.title}</strong>
                  <span className={styles.meta}>
                    <Heat value={Math.round(item.heat * 100)} />
                    <DiscussionCount value={item.postCount} />
                    {item.status === "closed" && <span>已关闭</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {state.hasMore && (
        <div className={styles.topicAction}>
          <button type="button" disabled={busy} onClick={loadMore}>
            {busy ? "正在加载…" : "继续加载"}
          </button>
        </div>
      )}
      <p className={styles.notice} data-threads-heat-note="">
        热度为按 7 天半衰期加权的近期公开活动，仅作排序参考。
      </p>
    </div>
  );
}

/**
 * 话题 where the live Threads are not composed (Production, and any
 * composition without the author and publishing providers): Community V1
 * enables nothing in Production, so nothing is read and there is no retry.
 */
export function ThreadsUnavailable() {
  return (
    <section
      className={homeStyles.stateMessage}
      role="status"
      data-threads-state="unavailable"
    >
      <h2>话题暂时不可用</h2>
    </section>
  );
}
