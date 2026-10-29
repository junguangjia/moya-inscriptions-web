"use client";

import { useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@moya/ui";

import { FeedPostStage } from "../authors/feed-post-stage";
import { MediaFallback } from "../home/card-media-parts";
import {
  CatalogDetailReadingStrip,
  type CatalogDetailReadingStripHandle,
} from "./catalog-detail-reading-strip";
import { DetailInteractionsContext } from "./detail-interactions";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";
import styles from "./desktop-calligraphy-detail-layout.module.css";

/** Desktop changes composition, while media, colophons and history keep their owners. */
export const DesktopCalligraphyDetailLayout = ({
  activeMediaIndex,
  colophon,
  detail,
  detailActions,
  information,
  leading,
  positionKey,
  onActiveMediaIndexChange,
  onOpenViewer,
  viewerOpen,
}: {
  readonly activeMediaIndex: number;
  readonly colophon?: ReactNode;
  readonly detail: CatalogDetailPresentation;
  readonly detailActions?: ReactNode;
  readonly information: ReactNode;
  readonly leading: ReactNode;
  readonly positionKey?: string | undefined;
  readonly onActiveMediaIndexChange: (index: number) => void;
  readonly onOpenViewer: (index: number, opener: HTMLElement) => void;
  readonly viewerOpen: boolean;
}) => {
  const upper = useRef<CatalogDetailReadingStripHandle>(null);
  const lower = useRef<CatalogDetailReadingStripHandle>(null);
  const upperRegion = useRef<HTMLDivElement>(null);
  const lowerRegion = useRef<HTMLDivElement>(null);
  const scroll = useContext(CatalogDetailScrollContext);
  const [canLike, setCanLike] = useState(false);
  const like = useRef<(() => void) | null>(null);
  const hasColophon =
    colophon !== undefined && colophon !== null && colophon !== false;
  const textOnly = detail.contentType === "work" && detail.media.length === 0;
  const id = `desktop-detail-${detail.id}`;

  const reveal = useCallback(
    (node: HTMLElement | null) => {
      if (node === null) return;
      if (scroll !== null) scroll.restore(scroll.collapseTop(node));
      else node.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    },
    [scroll],
  );
  const revealComments = useCallback(
    () => reveal(lowerRegion.current),
    [reveal],
  );
  const onComment = useCallback(() => {
    if (lower.current?.scrollToComments()) revealComments();
  }, [revealComments]);
  const registerLike = useCallback((run: () => void, enabled: boolean) => {
    like.current = run;
    setCanLike(enabled);
    return () => {
      if (like.current !== run) return;
      like.current = null;
      setCanLike(false);
    };
  }, []);
  const interactions = useMemo(
    () => ({ onComment, registerLike }),
    [onComment, registerLike],
  );

  const media =
    detail.media.length > 0 ? (
      <div className={styles.media} data-detail-calligraphy-media="">
        <FeedPostStage
          activeMediaIndex={activeMediaIndex}
          burstEnabled={canLike}
          enableLivePlayback
          imageFit="contain"
          live={detail.media[0]?.live !== undefined}
          media={detail.media}
          onActiveMediaIndexChange={onActiveMediaIndexChange}
          onDoubleTap={() => like.current?.()}
          onOpenViewer={onOpenViewer}
          viewerOpen={viewerOpen}
        />
      </div>
    ) : textOnly ? undefined : (
      <div className={styles.missingMedia} data-detail-media-state="missing">
        <MediaFallback
          label={`暂无公开图像：${detail.title}`}
          state="missing"
        />
      </div>
    );

  return (
    <DetailInteractionsContext.Provider value={interactions}>
      <div
        className={styles.layout}
        data-desktop-calligraphy-detail=""
        data-desktop-detail-content={
          detail.contentType === "work" ? "work" : "catalog"
        }
        data-detail-text-only={textOnly ? "" : undefined}
      >
        <nav aria-label="书法阅读定位" className={styles.navigation}>
          {detail.media.length === 0 ? null : (
            <button
              aria-controls={`${id}-upper`}
              aria-label="前往图片"
              onClick={() => {
                upper.current?.scrollToMedia();
                reveal(upperRegion.current);
              }}
              title="图片"
              type="button"
            >
              <Icon name="image" />
            </button>
          )}
          <button
            aria-controls={`${id}-upper`}
            aria-label={detail.contentType === "work" ? "前往正文" : "前往资料"}
            onClick={() => {
              upper.current?.scrollToInformation();
              reveal(upperRegion.current);
            }}
            title={detail.contentType === "work" ? "正文" : "资料"}
            type="button"
          >
            <Icon name="category" />
          </button>
          {hasColophon ? (
            <button
              aria-controls={`${id}-colophon`}
              aria-label="前往题跋"
              onClick={onComment}
              title="题跋"
              type="button"
            >
              <Icon name="message" />
            </button>
          ) : null}
        </nav>
        <div
          className={styles.upper}
          data-desktop-detail-upper=""
          ref={upperRegion}
        >
          <CatalogDetailReadingStrip
            ref={upper}
            detailId={detail.id}
            id={`${id}-upper`}
            information={information}
            label={
              detail.contentType === "work" ? "图片与正文" : "图片与馆藏资料"
            }
            leading={leading}
            media={media}
            positionKey={
              positionKey === undefined ? undefined : `${positionKey}:upper`
            }
            variant="desktop-information"
          />
        </div>
        {detailActions === undefined ? null : (
          <div className={styles.actions} data-desktop-detail-actions="">
            {detailActions}
          </div>
        )}
        {hasColophon ? (
          <div
            className={styles.lower}
            data-desktop-detail-colophon=""
            ref={lowerRegion}
          >
            <CatalogDetailReadingStrip
              ref={lower}
              colophon={colophon}
              detailId={detail.id}
              id={`${id}-colophon`}
              information={null}
              label="题跋"
              onRevealReading={revealComments}
              positionKey={
                positionKey === undefined
                  ? undefined
                  : `${positionKey}:colophon`
              }
              variant="desktop-comments"
            />
            <button
              aria-label="写题跋"
              className={styles.compose}
              onClick={() => {
                revealComments();
                lowerRegion.current
                  ?.querySelector<HTMLTextAreaElement>(
                    "[data-colophon-input-box]",
                  )
                  ?.focus();
              }}
              title="写题跋"
              type="button"
            >
              <Icon name="edit" />
            </button>
          </div>
        ) : null}
      </div>
    </DetailInteractionsContext.Provider>
  );
};
