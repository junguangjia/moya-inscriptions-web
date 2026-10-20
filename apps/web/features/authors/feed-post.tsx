"use client";
import { useId, useMemo, useRef, useState } from "react";
import type { ContentCard as Card } from "@moya/contracts";
import { requestDetailComments } from "../detail/detail-comments-request";
import { CatalogProvinceBadge, MediaFallback } from "../home/card-media-parts";
import type { MediaPriority } from "../media/responsive-media";
import { FeedPostActions } from "../quick-actions/feed-post-actions";
import type { FeedPostTrailingAction } from "../quick-actions/feed-post-actions";
import { useProductShell } from "../product-shell/product-shell";
import type { useContentActions } from "./content-actions";
import { FeedColophon } from "./feed-colophon";
import { FeedPostAuthor } from "./feed-post-author";
import { FeedPostBody } from "./feed-post-body";
import { suppressFollowingPointerClicks } from "./feed-post-click-guard";
import { feedPostMedia } from "./feed-post-media";
import { FeedPostStage } from "./feed-post-stage";
import type { FeedPostStageHandle } from "./feed-post-stage";
import styles from "../home/home-screen.module.css";

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
 * A phone single-column post: author, the right-to-left image stage with its
 * dots and its colophons past the last image, the title and a work's body
 * text (both open Detail; only the trailing action expands the body in
 * place), the action row and the publication day.
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
  const [overflow, setOverflow] = useState(false);
  const bodyId = useId();
  const media = useMemo(() => feedPostMedia(item, label), [item, label]);
  const stageRef = useRef<FeedPostStageHandle>(null);
  const work = item.target.type === "work";
  const hasBody = work && excerpt !== "";
  const expandable = hasBody && overflow;
  // `pointer` is false for keyboard and assistive activation (click detail 0).
  const openContent = (opener: HTMLElement, pointer = true) => {
    shell.openContent(item.target, opener);
    // The rest of the tap (a double tap's second click) would land on Detail.
    if (pointer) suppressFollowingPointerClicks();
  };
  // A post with a stage reads its comments as colophons; one without opens
  // Detail on its comments.
  const openComments = (opener: HTMLElement) => {
    if (stageRef.current?.scrollToComments() === true) return;
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
  const trailing: FeedPostTrailingAction | undefined = expandable
    ? {
        kind: "expand",
        expanded,
        controls: bodyId,
        onToggle: toggle,
      }
    : work && hasBody
      ? undefined
      : { kind: "detail", onOpen: openContent };

  const stage =
    media.length > 0 ? (
      <FeedPostStage
        ref={stageRef}
        badge={badge}
        burstEnabled={actions.canLike}
        comments={
          <FeedColophon
            fallbackCount={actions.environment.commentCount}
            target={item.target}
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
        resetOnExit
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
          aria-label={`打开${label}`}
          // The Catalog opener, as on two-column cards.
          {...(item.target.type === "catalog"
            ? { "data-open-catalog": "" }
            : {})}
          onClick={(event) =>
            openContent(event.currentTarget, event.detail !== 0)
          }
        >
          <span className={styles.postTitleText}>{item.title}</span>
        </button>
      </h3>
    ) : work || excerpt === "" ? null : (
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
        {hasBody ? (
          <FeedPostBody
            expanded={expanded}
            id={bodyId}
            preview={excerpt}
            onOverflowChange={setOverflow}
            onOpen={openContent}
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
