"use client";

import {
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { FeedPostStage } from "../authors/feed-post-stage";
import { MediaFallback } from "../home/card-media-parts";
import {
  CatalogDetailReadingStrip,
  type CatalogDetailReadingStripHandle,
} from "./catalog-detail-reading-strip";
import { DetailInteractionsContext } from "./detail-interactions";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";
import styles from "./catalog-detail.module.css";

export const CalligraphyDetailLayout = ({
  activeMediaIndex,
  colophon,
  detail,
  detailActions,
  information,
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
  readonly positionKey?: string | undefined;
  readonly onActiveMediaIndexChange: (index: number) => void;
  readonly onOpenViewer: (index: number, opener: HTMLElement) => void;
  readonly viewerOpen: boolean;
}) => {
  const reading = useRef<CatalogDetailReadingStripHandle>(null);
  const readingRegion = useRef<HTMLDivElement>(null);
  const detailScroll = useContext(CatalogDetailScrollContext);
  const readingId = useId();
  const [activeRegion, setActiveRegion] = useState<"information" | "comments">(
    "information",
  );
  const hasColophon =
    colophon !== undefined && colophon !== null && colophon !== false;
  const like = useRef<{ run: () => void } | null>(null);
  const [canLike, setCanLike] = useState(false);
  const registerLike = useCallback((run: () => void, enabled: boolean) => {
    const registration = { run };
    like.current = registration;
    setCanLike(enabled);
    return () => {
      if (like.current !== registration) return;
      like.current = null;
      setCanLike(false);
    };
  }, []);
  const revealReading = useCallback(() => {
    const region = readingRegion.current;
    if (region === null) return;
    if (detailScroll !== null)
      detailScroll.restore(detailScroll.collapseTop(region));
    else region.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  }, [detailScroll]);
  const onComment = useCallback(() => {
    if (reading.current?.scrollToComments()) revealReading();
  }, [revealReading]);
  const onInformation = useCallback(() => {
    reading.current?.scrollToStart();
    revealReading();
  }, [revealReading]);
  const interactions = useMemo(
    () => ({ onComment, registerLike }),
    [onComment, registerLike],
  );
  const textOnly = detail.contentType === "work" && detail.media.length === 0;

  return (
    <DetailInteractionsContext.Provider value={interactions}>
      <div
        className={styles.calligraphyDetail}
        data-detail-calligraphy-layout=""
      >
        {detail.media.length > 0 ? (
          <div data-detail-calligraphy-media="">
            <FeedPostStage
              activeMediaIndex={activeMediaIndex}
              burstEnabled={canLike}
              enableLivePlayback
              imageFit="contain"
              live={detail.media[0]?.live !== undefined}
              media={detail.media}
              onActiveMediaIndexChange={onActiveMediaIndexChange}
              onDoubleTap={() => like.current?.run()}
              onOpenViewer={onOpenViewer}
              viewerOpen={viewerOpen}
            />
          </div>
        ) : textOnly ? null : (
          <div data-detail-media-state="missing">
            <MediaFallback
              label={`暂无公开图像：${detail.title}`}
              state="missing"
            />
          </div>
        )}
        {detailActions === undefined ? null : (
          <div className={styles.calligraphyActions}>{detailActions}</div>
        )}
        <div ref={readingRegion}>
          <nav
            aria-label="详情与评论"
            className={styles.calligraphyNavigation}
            data-detail-reading-navigation=""
            dir="ltr"
          >
            <button
              aria-controls={readingId}
              aria-pressed={activeRegion === "comments"}
              data-detail-reading-target="comments"
              disabled={!hasColophon}
              onClick={onComment}
              type="button"
            >
              评论
            </button>
            <button
              aria-controls={readingId}
              aria-pressed={activeRegion === "information"}
              data-detail-reading-target="information"
              onClick={onInformation}
              type="button"
            >
              详情
            </button>
          </nav>
          <CatalogDetailReadingStrip
            ref={reading}
            colophon={colophon}
            detailId={detail.id}
            id={readingId}
            information={information}
            onRegionChange={setActiveRegion}
            onRevealReading={revealReading}
            positionKey={positionKey}
          />
        </div>
      </div>
    </DetailInteractionsContext.Provider>
  );
};
