"use client";
import { editorialMediaSrc } from "./editorial-media";
import type { ArticleSummary } from "@moya/contracts";
import { useProductShell } from "../product-shell/product-shell";
import styles from "../discussion-preview/discussion-preview.module.css";
import homeStyles from "../home/home-screen.module.css";
import { formatEditorialTime } from "./format-time";
import { useArticles } from "./use-editorial-content";
import type { EditorialListState } from "./use-editorial-content";

const Picture = ({
  src,
  alt,
  owner,
}: {
  src: string;
  alt: string;
  owner: string;
}) => (
  <img
    src={editorialMediaSrc(src, owner)}
    alt={alt}
    loading="lazy"
    decoding="async"
  />
);

const EmptyState = ({
  state,
  label,
  onRetry,
}: {
  state: EditorialListState<unknown>["state"];
  label: string;
  onRetry: () => void;
}) => (
  <section
    className={homeStyles.stateMessage}
    role={state === "unavailable" ? "alert" : "status"}
    data-editorial-state={state}
  >
    <h2>
      {state === "loading"
        ? "正在加载"
        : state === "empty"
          ? `暂无${label}`
          : `${label}暂时不可用`}
    </h2>
    {state === "unavailable" && (
      <button type="button" onClick={onRetry}>
        重试
      </button>
    )}
  </section>
);

const LoadMore = ({
  hasMore,
  busy,
  onLoadMore,
}: {
  hasMore: boolean;
  busy: boolean;
  onLoadMore: () => void;
}) =>
  hasMore ? (
    <div className={styles.topicAction}>
      <button type="button" disabled={busy} onClick={onLoadMore}>
        {busy ? "正在加载…" : "继续加载"}
      </button>
    </div>
  ) : null;

/** 近闻: published news Articles from the real editorial API. */
export function EditorialNewsFeed() {
  const shell = useProductShell();
  const { state, busy, retry, loadMore } = useArticles("news");
  if (state.state !== "populated")
    return <EmptyState state={state.state} label="近闻" onRetry={retry} />;
  return (
    <div className={styles.feed} data-editorial-feed="news">
      <div className={styles.newsList}>
        {state.items.map((item: ArticleSummary, index) => (
          <button
            type="button"
            key={item.id}
            data-topic-id={item.id}
            data-news-layout={index % 3 === 0 ? "large" : "compact"}
            className={styles.newsCard}
            onClick={(event) =>
              shell.openTopic(
                item.id,
                event.currentTarget,
                shell.readActiveScrollTop(),
              )
            }
          >
            {item.cover ? (
              <Picture
                owner={item.id}
                src={item.cover.src}
                alt={item.cover.alt}
              />
            ) : (
              <span className={styles.imageFallback} aria-hidden="true" />
            )}
            <span className={styles.newsCopy}>
              {item.section && (
                <span className={styles.eyebrow}>{item.section}</span>
              )}
              <strong>{item.title}</strong>
              {item.summary && (
                <span className={styles.summary}>{item.summary}</span>
              )}
              <span className={styles.meta}>
                {item.byline}
                <span>{formatEditorialTime(item.publishedAt)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <LoadMore hasMore={state.hasMore} busy={busy} onLoadMore={loadMore} />
    </div>
  );
}

/**
 * 专题: published academic Articles as the large image-background cards. Owner
 * acceptance (2026-09-25): each card opens its one Article directly, not a
 * Collection's reading list.
 */
export function EditorialTopicsFeed() {
  const shell = useProductShell();
  const { state, busy, retry, loadMore } = useArticles("academic");
  if (state.state !== "populated")
    return <EmptyState state={state.state} label="专题" onRetry={retry} />;
  return (
    <div className={styles.feed} data-editorial-feed="topics">
      <div className={styles.specialList}>
        {state.items.map((item: ArticleSummary) => (
          <button
            type="button"
            key={item.id}
            data-topic-id={item.id}
            className={styles.specialCard}
            onClick={(event) =>
              shell.openTopic(
                item.id,
                event.currentTarget,
                shell.readActiveScrollTop(),
              )
            }
          >
            {item.cover ? (
              <Picture owner={item.id} src={item.cover.src} alt="" />
            ) : (
              <span className={styles.imageFallback} aria-hidden="true" />
            )}
            <span className={styles.specialShade} />
            <span className={styles.specialCopy}>
              <span className={styles.specialCategory}>
                {[item.issue, item.section].filter(Boolean).join(" / ")}
              </span>
              <strong>{item.title}</strong>
              {item.subtitle && (
                <span className={styles.specialSubtitle}>{item.subtitle}</span>
              )}
              {item.summary && (
                <span className={styles.specialIntro}>{item.summary}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <LoadMore hasMore={state.hasMore} busy={busy} onLoadMore={loadMore} />
    </div>
  );
}
