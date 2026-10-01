"use client";

import { useCallback, useEffect, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";

import { call, describeFailure, formatPreciseTime } from "./api";
import styles from "./community.module.css";

import type {
  OperatorThread,
  OperatorThreadPage,
} from "@moya/contracts/internal/community-operator";

const newRequestId = () => crypto.randomUUID();

const splitTags = (value: string): string[] =>
  [
    ...new Set(
      value
        .split(/[,，\s]+/u)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 6);

/**
 * content-community-completion-v1: the Owner creates and manages Threads.
 * Every command carries a fresh request identity and the expected version;
 * a stale version is a 409 the row reports in place. Hiding a Thread removes
 * its grouping only; its Works keep their own visibility and moderation.
 */
export const ThreadsClient = () => {
  const [page, setPage] = useState<OperatorThreadPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", tags: "" });
  const [editing, setEditing] = useState<OperatorThread | null>(null);
  const [edit, setEdit] = useState({ title: "", description: "", tags: "" });

  const load = useCallback(async () => {
    try {
      const result = await call<OperatorThreadPage>("read-threads", {
        page: 1,
        pageSize: 50,
        includeHidden: true,
      });
      setPage(result);
      setError(null);
    } catch (failure) {
      setError(describeFailure(failure).text);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(`${label}已完成。`);
      await load();
    } catch (failure) {
      setNotice(`${label}未执行：${describeFailure(failure).text}`);
    } finally {
      setBusy(false);
    }
  };

  const update = (
    thread: OperatorThread,
    label: string,
    command: Record<string, unknown>,
  ) =>
    run(label, () =>
      call<OperatorThread>("update-thread", {
        id: thread.id,
        requestId: newRequestId(),
        expectedVersion: thread.version,
        ...command,
      }),
    );

  return (
    <div className={styles.layout} data-community-threads="">
      <SetStepNav
        nav={[{ label: "话题管理", url: "/community-moderation/threads" }]}
      />
      <header className={styles.header}>
        <h1>话题管理</h1>
        <p className={styles.lead}>
          话题由运营创建；用户以作品的形式参与。隐藏话题只移除该分组，不改变其中作品的可见性。
        </p>
      </header>
      {notice && (
        <p role="status" className={styles.notice} data-threads-notice="">
          {notice}
        </p>
      )}
      <section
        className={styles.panel}
        aria-labelledby="threads-create-heading"
      >
        <h2 id="threads-create-heading" className={styles.sectionTitle}>
          新建话题
        </h2>
        <form
          className={styles.settingsForm}
          data-threads-create-form=""
          onSubmit={(event) => {
            event.preventDefault();
            const title = draft.title.trim();
            if (!title) return;
            void run("创建话题", async () => {
              await call<OperatorThread>("create-thread", {
                requestId: newRequestId(),
                title,
                description: draft.description.trim(),
                tags: splitTags(draft.tags),
                position: 0,
              });
              setDraft({ title: "", description: "", tags: "" });
            });
          }}
        >
          <label>
            标题
            <input
              value={draft.title}
              maxLength={120}
              required
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            说明
            <textarea
              value={draft.description}
              maxLength={2000}
              rows={4}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <label>
            标签（逗号分隔，最多 6 个）
            <input
              value={draft.tags}
              onChange={(event) =>
                setDraft({ ...draft, tags: event.target.value })
              }
            />
          </label>
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.actionButton}
              disabled={busy || !draft.title.trim()}
            >
              创建
            </button>
          </div>
        </form>
      </section>
      <section className={styles.panel} aria-labelledby="threads-list-heading">
        <h2 id="threads-list-heading" className={styles.sectionTitle}>
          全部话题{page ? `（${page.total}）` : ""}
        </h2>
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        {page && page.items.length === 0 && <p>尚无话题。</p>}
        <ul className={styles.links} data-threads-list="">
          {page?.items.map((thread) => (
            <li
              key={thread.id}
              className={styles.card}
              data-thread-row={thread.id}
            >
              {editing?.id === thread.id ? (
                <form
                  className={styles.settingsForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void update(thread, "保存话题", {
                      title: edit.title.trim(),
                      description: edit.description.trim(),
                      tags: splitTags(edit.tags),
                    }).then(() => setEditing(null));
                  }}
                >
                  <label>
                    标题
                    <input
                      value={edit.title}
                      maxLength={120}
                      required
                      onChange={(event) =>
                        setEdit({ ...edit, title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    说明
                    <textarea
                      value={edit.description}
                      maxLength={2000}
                      rows={3}
                      onChange={(event) =>
                        setEdit({ ...edit, description: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    标签
                    <input
                      value={edit.tags}
                      onChange={(event) =>
                        setEdit({ ...edit, tags: event.target.value })
                      }
                    />
                  </label>
                  <div className={styles.actions}>
                    <button
                      type="submit"
                      className={styles.actionButton}
                      disabled={busy}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className={styles.summary}>
                    <strong>{thread.title}</strong>
                    <span
                      className={styles.state}
                      data-thread-state={thread.status}
                    >
                      {thread.status === "open" ? "开放" : "已关闭"}
                      {thread.hidden ? " · 已隐藏" : ""}
                    </span>
                  </div>
                  {thread.description && (
                    <p className={styles.excerpt}>{thread.description}</p>
                  )}
                  <p className={styles.mono}>
                    {thread.id} · 版本 {thread.version} · {thread.postCount}{" "}
                    篇作品 · 更新于 {formatPreciseTime(thread.updatedAt)}
                  </p>
                  {thread.tags.length > 0 && (
                    <p>
                      {thread.tags.map((tag) => (
                        <span key={tag} className={styles.chip}>
                          {tag}
                        </span>
                      ))}
                    </p>
                  )}
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => {
                        setEditing(thread);
                        setEdit({
                          title: thread.title,
                          description: thread.description,
                          tags: thread.tags.join(", "),
                        });
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() =>
                        void update(
                          thread,
                          thread.status === "open"
                            ? "关闭话题"
                            : "重新开放话题",
                          {
                            status:
                              thread.status === "open" ? "closed" : "open",
                          },
                        )
                      }
                    >
                      {thread.status === "open" ? "关闭" : "重新开放"}
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() =>
                        void update(
                          thread,
                          thread.hidden ? "取消隐藏" : "隐藏话题",
                          {
                            hidden: !thread.hidden,
                          },
                        )
                      }
                    >
                      {thread.hidden ? "取消隐藏" : "隐藏"}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
