"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContentCard as Card } from "@moya/contracts";
import { requestDetailComments } from "../detail/detail-comments-request";
import { CatalogProvinceBadge, MediaFallback } from "../home/card-media-parts";
import type { MediaPriority } from "../media/responsive-media";
import { FeedPostActions } from "../quick-actions/feed-post-actions";
import type { FeedPostTrailingAction } from "../quick-actions/feed-post-actions";
import { useProductShell } from "../product-shell/product-shell";
import type { useContentActions } from "./content-actions";
import { FeedColophon, FeedColophonOutletContext } from "./feed-colophon";
import { FeedPostAuthor } from "./feed-post-author";
import { FeedPostBody } from "./feed-post-body";
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
 * dots and its colophons past the last image, the title (a work's expands
 * its body in place, official content's opens Detail), the action row and
 * the publication day.
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
  const stageRef = useRef<FeedPostStageHandle>(null);
  // The colophon composer and its status render in an outlet outside the
  // strip and outside the Home pager: its track is transformed, which would
  // fix them to the track and keep them under the dock.
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  const [outletHost, setOutletHost] = useState<HTMLElement | null>(null);
  useEffect(() => setOutletHost(document.body), []);
  const work = item.target.type === "work";
  // Only a work with text has a body to expand; any other post opens Detail.
  const expandable = work && (item.title !== "" || excerpt !== "");
  const openContent = (opener: HTMLElement) =>
    shell.openContent(item.target, opener);
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
        <FeedColophonOutletContext.Provider value={outlet}>
          {stage}
        </FeedColophonOutletContext.Provider>
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
        {media.length > 0 && outletHost !== null
          ? createPortal(
              <div data-colophon-composer-outlet="" ref={setOutlet} />,
              outletHost,
            )
          : null}
      </article>
    </div>
  );
};
