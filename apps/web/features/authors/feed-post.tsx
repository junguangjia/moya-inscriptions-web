"use client";
import { useId, useMemo, useState } from "react";
import type { ContentCard as Card } from "@moya/contracts";
import { requestDetailComments } from "../detail/detail-comments-request";
import { CatalogProvinceBadge, MediaFallback } from "../home/card-media-parts";
import type { MediaPriority } from "../media/responsive-media";
import { FeedPostActions } from "../quick-actions/feed-post-actions";
import type { FeedPostTrailingAction } from "../quick-actions/feed-post-actions";
import { useProductShell } from "../product-shell/product-shell";
import type { useContentActions } from "./content-actions";
import { FeedPostAuthor } from "./feed-post-author";
import { FeedPostBody } from "./feed-post-body";
import { feedPostMedia } from "./feed-post-media";
import { FeedPostStage } from "./feed-post-stage";
import styles from "../home/home-screen.module.css";

const countFormat = new Intl.NumberFormat("zh-CN");
const postDay = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
});
const postDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" });

/** First publication day; the year only when it is not the current one. */
const PostDate = ({ value }: { value: string | null }) => {
  if (value === null) return null;
  const published = new Date(value);
  if (Number.isNaN(published.getTime())) return null;
  const format =
    published.getFullYear() === new Date().getFullYear() ? postDay : postDate;
  return (
    <p className={styles.postDate} data-feed-post-date="">
      <time dateTime={value} suppressHydrationWarning>
        {format.format(published)}
      </time>
    </p>
  );
};

/**
 * The comments region left of the last image. Until the colophon comments
 * land it names the thread and opens Detail, where comments are read and
 * written today.
 */
const FeedPostComments = ({
  count,
  title,
  onOpen,
}: {
  readonly count: number | null | undefined;
  readonly title: string;
  readonly onOpen: (opener: HTMLButtonElement) => void;
}) => (
  <section
    aria-label={`${title}的评论`}
    className={styles.postComments}
    data-feed-post-comments=""
  >
    <h4 className={styles.postCommentsTitle}>题跋</h4>
    <div>
      <p className={styles.postCommentsCount}>
        {count === null || count === undefined
          ? "评论"
          : count > 0
            ? `${countFormat.format(count)} 则评论`
            : "尚无评论"}
      </p>
      <button
        className={styles.postCommentsOpen}
        data-feed-post-comments-open=""
        onClick={(event) => onOpen(event.currentTarget)}
        type="button"
      >
        {count !== null && count !== undefined && count > 0
          ? "查看评论"
          : "写评论"}
      </button>
    </div>
  </section>
);

/**
 * A phone single-column post: author, the right-to-left image stage with its
 * dots, the title (a work's expands its body in place, official content's
 * opens Detail), the action row and the publication day.
 */
export const FeedPost = ({
  item,
  label,
  excerpt,
  textOnly,
  actions,
  priority,
  onMediaSettled,
}: {
  readonly item: Card;
  readonly label: string;
  readonly excerpt: string;
  readonly textOnly: boolean;
  readonly actions: ReturnType<typeof useContentActions>;
  readonly priority?: MediaPriority | undefined;
  readonly onMediaSettled?: (() => void) | undefined;
}) => {
  const shell = useProductShell();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const media = useMemo(() => feedPostMedia(item, label), [item, label]);
  const work = item.target.type === "work";
  // Only a work with text has a body to expand; any other post opens Detail.
  const expandable = work && (item.title !== "" || excerpt !== "");
  const openContent = (opener: HTMLElement) =>
    shell.openContent(item.target, opener);
  // Until the colophon comments land, comments are read in Detail.
  const openComments = (opener: HTMLElement) => {
    requestDetailComments(item.target.id);
    openContent(opener);
  };
  const toggle = () => setExpanded((value) => !value);
  const viewer = shell.activeFeedViewer;
  const viewerOpen =
    viewer !== null &&
    viewer.target.type === item.target.type &&
    viewer.target.id === item.target.id;
  const badge =
    item.target.type === "catalog" ? (
      <CatalogProvinceBadge province={item.province} />
    ) : null;
  const content = {
    kind: item.target.type,
    id: item.target.id,
    title: label,
  } as const;
  const trailing: FeedPostTrailingAction = expandable
    ? {
        kind: "expand",
        expanded,
        controls: bodyId,
        onToggle: toggle,
      }
    : { kind: "detail", onOpen: openContent };

  const stage =
    media.length > 0 ? (
      <FeedPostStage
        badge={badge}
        burstEnabled={actions.canLike}
        comments={
          <FeedPostComments
            count={actions.environment.commentCount}
            onOpen={openComments}
            title={label}
          />
        }
        live={item.live === true}
        media={media}
        onDoubleTap={() => void actions.ensureLiked()}
        onOpenViewer={(index, opener) => {
          shell.openFeedViewer({
            target: item.target,
            media,
            index,
            opener,
            direction: "rtl",
          });
        }}
        priority={priority}
        viewerOpen={viewerOpen}
        {...(onMediaSettled === undefined ? {} : { onMediaSettled })}
      />
    ) : textOnly ? null : (
      <div className={styles.postStage} data-feed-stage-frame="">
        <MediaFallback label={`暂无公开图像：${label}`} state="missing" />
        {badge}
      </div>
    );

  // A titled post shows its title; an untitled work its body opening.
  const heading =
    item.title !== "" ? (
      <h3 className={styles.postTitle} data-feed-post-title="">
        <button
          className={styles.postTitleButton}
          type="button"
          {...(expandable
            ? {
                "aria-controls": bodyId,
                "aria-expanded": expanded,
                onClick: toggle,
              }
            : {
                "aria-label": `打开${label}`,
                // The Catalog opener, as on two-column cards.
                ...(item.target.type === "catalog"
                  ? { "data-open-catalog": "" }
                  : {}),
                onClick: (event: { currentTarget: HTMLButtonElement }) =>
                  openContent(event.currentTarget),
              })}
        >
          <span className={styles.postTitleText}>{item.title}</span>
        </button>
      </h3>
    ) : excerpt === "" || expanded ? null : (
      // The expand action is the control; the line itself is a larger target.
      <p
        className={styles.postSummary}
        data-card-excerpt=""
        onClick={expandable ? toggle : undefined}
      >
        {excerpt}
      </p>
    );

  return (
    <div>
      <article
        className={`${styles.card} ${styles.feedCard} ${styles.post}`}
        data-card-live={item.live === true && item.media ? "" : undefined}
        data-card-text-only={textOnly ? "" : undefined}
        data-catalog-card-variant="feed"
        data-catalog-id={
          item.target.type === "catalog" ? item.target.id : undefined
        }
        data-content-type={item.target.type}
        data-content-id={item.target.id}
        data-feed-post=""
        data-feed-post-expanded={expanded ? "true" : undefined}
        role="listitem"
      >
        {work && item.authorId !== null ? (
          <FeedPostAuthor authorId={item.authorId} />
        ) : null}
        {stage}
        {heading}
        {expandable ? (
          <FeedPostBody
            expanded={expanded}
            id={bodyId}
            preview={item.title === "" ? excerpt : undefined}
            workId={item.target.id}
          />
        ) : null}
        <FeedPostActions
          content={content}
          environment={actions.environment}
          onComment={openComments}
          trailing={trailing}
        />
        <PostDate value={item.firstPublishedAt} />
      </article>
    </div>
  );
};
