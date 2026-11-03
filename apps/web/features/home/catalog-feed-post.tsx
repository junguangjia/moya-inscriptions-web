"use client";
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { CatalogSummary } from "@moya/contracts";
import { FeedPostStage } from "../authors/feed-post-stage";
import type { FeedPostStageHandle } from "../authors/feed-post-stage";
import { requestDetailComments } from "../detail/detail-comments-request";
import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";
import type { MediaPriority } from "../media/responsive-media";
import { useOptionalProductShell } from "../product-shell/product-shell";
import { FeedPostActions } from "../quick-actions/feed-post-actions";
import { quickActionContentKey } from "../quick-actions/quick-action-types";
import type { ContentQuickActionEnvironment } from "../quick-actions/quick-action-types";
import { CatalogProvinceBadge, MediaFallback } from "./card-media-parts";
import styles from "./home-screen.module.css";

/**
 * A Catalog summary in the phone single-column feed (QA preview, Topics,
 * Search): the post style with its one representative image and no author
 * bar or comments region by default. An explicit QA renderer may supply
 * colophons in the same existing strip. Without a shell the image opens the record.
 */
export const CatalogFeedPost = ({
  item,
  metadata,
  feedSpan,
  quickActions,
  onOpenCatalog,
  onMediaSettled,
  priority,
  colophon,
}: {
  readonly item: CatalogSummary;
  /** Kind and period, in place of a publication day. */
  readonly metadata: string;
  readonly feedSpan: "full" | undefined;
  readonly quickActions: ContentQuickActionEnvironment | null;
  readonly onOpenCatalog?:
    ((item: CatalogSummary, opener: HTMLButtonElement) => void) | undefined;
  readonly onMediaSettled?: (() => void) | undefined;
  readonly priority?: MediaPriority | undefined;
  readonly colophon?: ReactNode;
}) => {
  const stageRef = useRef<FeedPostStageHandle>(null);
  const shell = useOptionalProductShell();
  const content = { kind: "catalog", id: item.id, title: item.title } as const;
  const target = { type: "catalog", id: item.id } as const;
  const media = useMemo((): DetailMediaPresentation[] => {
    const image = item.representativeMedia;
    return image === undefined
      ? []
      : [
          {
            id: image.id,
            src: localCatalogMediaSrc(image.src, item.id, image.id),
            renditions: localCatalogRenditions(image.renditions),
            alt: item.title,
            width: image.width,
            height: image.height,
            placeholderColor: image.placeholderColor,
          },
        ];
  }, [item]);
  const open = (opener: HTMLElement) => {
    if (onOpenCatalog !== undefined && opener instanceof HTMLButtonElement)
      onOpenCatalog(item, opener);
  };
  const liked =
    quickActions?.likedIds.includes(quickActionContentKey(content)) ?? false;
  const viewer = shell?.activeFeedViewer ?? null;
  const badge = <CatalogProvinceBadge province={item.province} />;
  return (
    <article
      className={`${styles.card} ${styles.feedCard} ${styles.post}`}
      data-catalog-card=""
      data-catalog-card-variant="feed"
      data-catalog-feed-span={feedSpan}
      data-catalog-id={item.id}
      data-catalog-kind={item.kind}
      data-feed-post=""
      role="listitem"
    >
      {media.length > 0 ? (
        <FeedPostStage
          ref={stageRef}
          comments={colophon}
          badge={badge}
          burstEnabled={quickActions !== null && quickActions.ready !== false}
          media={media}
          onDoubleTap={() => {
            if (quickActions !== null && !liked)
              void quickActions.onAction("like", content);
          }}
          onOpenViewer={(index, opener) => {
            const opened =
              shell?.openFeedViewer({
                target,
                media,
                index,
                opener,
                direction: "rtl",
              }) ?? false;
            if (!opened && shell === null) open(opener);
          }}
          priority={priority}
          viewerOpen={
            viewer !== null &&
            viewer.target.type === "catalog" &&
            viewer.target.id === item.id
          }
          {...(onMediaSettled === undefined ? {} : { onMediaSettled })}
        />
      ) : (
        <div className={styles.postStage} data-feed-stage-frame="">
          <MediaFallback
            label={`暂无公开图像：${item.title}`}
            state="missing"
          />
          {badge}
        </div>
      )}
      <h3 className={styles.postTitle} data-feed-post-title="">
        <button
          aria-label={`打开${item.title}`}
          className={styles.postTitleButton}
          data-open-catalog=""
          disabled={onOpenCatalog === undefined}
          onClick={(event) => open(event.currentTarget)}
          type="button"
        >
          <span className={styles.postTitleText}>{item.title}</span>
        </button>
      </h3>
      {onOpenCatalog === undefined ? null : (
        <FeedPostActions
          content={content}
          environment={quickActions}
          onComment={(opener) => {
            if (colophon !== undefined && stageRef.current?.scrollToComments())
              return;
            requestDetailComments(item.id);
            open(opener);
          }}
          trailing={{ kind: "detail", onOpen: open }}
        />
      )}
      {metadata === "" ? null : <p className={styles.postDate}>{metadata}</p>}
    </article>
  );
};
