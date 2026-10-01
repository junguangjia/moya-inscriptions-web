"use client";

import { Icon } from "@moya/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArticleDraftSummary } from "@moya/contracts";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { articleAuthoringClient } from "../../../lib/public-api/article-authoring-client";
import { useAuthors } from "../../authors/author-context";
import {
  absoluteTime,
  newestEditedFirst,
  relativeTime,
} from "../../publishing/ui/drafts/drafts-format";
import styles from "../../publishing/ui/drafts/drafts.module.css";
import homeStyles from "../../home/home-screen.module.css";

const status = {
  draft: "草稿",
  pending: "审核中",
  published: "已公开",
  withdrawn: "已撤回",
} as const;

/** Presentation-only Article tab in the existing private account draft box. */
export const ArticleDraftsPanel = ({
  accountId,
  onOpen,
}: {
  readonly accountId: string;
  readonly onOpen: (id: string) => void;
}) => {
  const author = useAuthors();
  const accountEpoch = authorClient.accountEpoch();
  const [items, setItems] = useState<readonly ArticleDraftSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (after?: string) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const epoch = authorClient.accountEpoch();
      const live = () => controller.current === abort && !abort.signal.aborted;
      const owned = () =>
        authorClient.account() === accountId &&
        authorClient.accountEpoch() === epoch;
      if (!owned()) {
        setLoading(false);
        setError("账号暂时无法确认，请重新确认后读取专题草稿。");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const page = await articleAuthoringClient.list(
          { pageSize: 20, ...(after === undefined ? {} : { cursor: after }) },
          abort.signal,
        );
        if (!live()) return;
        if (!owned()) {
          setItems([]);
          setCursor(null);
          setError("账号验证已变化，请重新确认后读取专题草稿。");
          return;
        }
        if (page.items.some((item) => item.ownerId !== accountId))
          throw new Error("article_drafts_owner_changed");
        setItems((old) =>
          [
            ...new Map(
              (after === undefined ? page.items : [...old, ...page.items]).map(
                (item) => [item.id, item],
              ),
            ).values(),
          ].sort(newestEditedFirst),
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch {
        if (live()) setError("暂时无法读取专题草稿，请重试。");
      } finally {
        if (live()) setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoaded(false);
    if (
      author.checking ||
      author.sessionError ||
      author.viewer?.id !== accountId ||
      authorClient.account() !== accountId
    ) {
      setLoading(false);
      setError("账号暂时无法确认，请重新确认后读取专题草稿。");
      return;
    }
    void load();
    return () => controller.current?.abort();
  }, [
    accountId,
    accountEpoch,
    author.checking,
    author.sessionError,
    author.viewer?.id,
    load,
  ]);

  const confirmed =
    !author.checking &&
    !author.sessionError &&
    author.viewer?.id === accountId &&
    authorClient.account() === accountId;
  const now = new Date();
  return (
    <div
      className={styles.panel}
      data-article-drafts-panel=""
      aria-busy={loading}
    >
      <p className={styles.lead}>
        专题文章仅自己管理，按最近编辑排列；公开版本可单独查看。
      </p>
      {loading ? (
        <p role="status" className={styles.status}>
          正在读取专题草稿…
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className={styles.alert}>
          {error}
          <button
            className={styles.button}
            type="button"
            disabled={loading || author.checking}
            onClick={() => {
              if (confirmed) void load();
              else void author.refresh();
            }}
          >
            {confirmed ? "重试" : "重新确认账号"}
          </button>
        </p>
      )}
      {confirmed && loaded && items.length === 0 && error === null ? (
        <p className={styles.empty}>
          <Icon name="empty" />
          <span>暂无专题文章</span>
        </p>
      ) : null}
      {confirmed && items.length > 0 ? (
        <ul
          className={`${styles.list} ${styles.draftGrid}`}
          aria-label="专题文章列表"
        >
          {items.map((draft) => (
            <li
              key={draft.id}
              className={`${homeStyles.card} ${homeStyles.feedCard} ${styles.row} ${styles.draftCard}`}
              data-article-draft-id={draft.id}
            >
              <div className={styles.rowBody}>
                <p className={styles.label}>专题文章</p>
                <h3
                  className={styles.rowTitle}
                  id={`article-draft-heading-${draft.id}`}
                >
                  {draft.title.trim() || "未命名专题"}
                </h3>
                <p className={styles.meta}>
                  <span>{status[draft.status]}</span>
                  <time
                    dateTime={draft.updatedAt}
                    title={absoluteTime(draft.updatedAt)}
                  >
                    {relativeTime(draft.updatedAt, now)}编辑
                  </time>
                </p>
                <div className={styles.actions}>
                  <button
                    className={`${styles.button} ${styles.primary}`}
                    type="button"
                    disabled={loading}
                    aria-describedby={`article-draft-heading-${draft.id}`}
                    onClick={() => onOpen(draft.id)}
                  >
                    继续编辑
                  </button>
                  {draft.publicVersion === null ? null : (
                    <a
                      className={`${styles.button} ${styles.quiet}`}
                      href={`/?topic=${encodeURIComponent(draft.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      公开版本
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {confirmed && cursor !== null ? (
        <button
          className={`${styles.button} ${styles.loadMore}`}
          type="button"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          加载更多
        </button>
      ) : null}
      {confirmed && loaded && error === null ? (
        <button
          className={styles.button}
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          刷新专题草稿
        </button>
      ) : null}
    </div>
  );
};
