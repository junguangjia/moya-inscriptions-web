"use client";

import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Icon } from "@moya/ui";
import { FeedPostStage } from "../authors/feed-post-stage";
import { MediaFallback } from "../home/card-media-parts";
import { useAuthReturnView } from "../auth/auth-return";
import {
  CatalogDetailReadingStrip,
  type CatalogDetailReadingStripHandle,
} from "./catalog-detail-reading-strip";
import { DetailInteractionsContext } from "./detail-interactions";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";
import styles from "./desktop-calligraphy-detail-layout.module.css";

interface InformationPosition {
  readonly top: number;
  readonly groups: readonly { key: string; open: boolean; left: number }[];
}
const informationPositions = new Map<string, InformationPosition>();
const captureInformation = (node: HTMLElement): InformationPosition => ({
  top: node.scrollTop,
  groups: [
    ...node.querySelectorAll<HTMLDetailsElement>(
      "[data-desktop-information-group]",
    ),
  ].map((group) => ({
    key: group.dataset.desktopInformationGroup!,
    open: group.open,
    left:
      group.querySelector<HTMLElement>("[data-desktop-group-content]")
        ?.scrollLeft ?? 0,
  })),
});
const saveInformation = (key: string, node: HTMLElement) => {
  informationPositions.delete(key);
  informationPositions.set(key, captureInformation(node));
  if (informationPositions.size > 60)
    informationPositions.delete(informationPositions.keys().next().value!);
};

/** Independent image/information viewports above the existing colophon reader. */
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
  const lower = useRef<CatalogDetailReadingStripHandle>(null);
  const mediaRegion = useRef<HTMLDivElement>(null),
    informationRegion = useRef<HTMLElement>(null),
    lowerRegion = useRef<HTMLElement>(null);
  const scroll = useContext(CatalogDetailScrollContext);
  const [canLike, setCanLike] = useState(false);
  const [paging, setPaging] = useState({ forward: false, backward: false });
  const like = useRef<(() => void) | null>(null);
  const hasColophon =
    colophon !== undefined && colophon !== null && colophon !== false;
  const textOnly = detail.contentType === "work" && detail.media.length === 0;
  const id = `desktop-detail-${detail.id}`;
  useLayoutEffect(() => {
    const node = lowerRegion.current?.querySelector<HTMLElement>(
      "[data-detail-reading-strip]",
    );
    if (!node) return;
    let frame = 0;
    const measure = () => {
      const next = lower.current?.pagingState();
      if (next)
        setPaging((previous) =>
          previous.forward === next.forward &&
          previous.backward === next.backward
            ? previous
            : next,
        );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resize?.observe(node);
    for (const child of node.children) resize?.observe(child);
    const mutation = new MutationObserver(schedule);
    mutation.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    node.addEventListener("scroll", measure);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [detail.id, hasColophon]);
  const informationKey =
    positionKey === undefined ? undefined : `${positionKey}:r4:information`;
  const authPosition = useAuthReturnView(
    `desktop-detail-information:${detail.contentType ?? "catalog"}:${detail.id}`,
    () =>
      informationRegion.current
        ? captureInformation(informationRegion.current)
        : undefined,
  );
  const returnedPosition =
    authPosition !== undefined &&
    Number.isFinite(authPosition.top) &&
    authPosition.top >= 0 &&
    Array.isArray(authPosition.groups) &&
    authPosition.groups.every(
      (group) =>
        typeof group.key === "string" &&
        typeof group.open === "boolean" &&
        Number.isFinite(group.left),
    )
      ? authPosition
      : undefined;
  useLayoutEffect(() => {
    const node = informationRegion.current;
    if (!node || informationKey === undefined) return;
    const saved = returnedPosition ?? informationPositions.get(informationKey);
    if (saved) {
      for (const group of node.querySelectorAll<HTMLDetailsElement>(
        "[data-desktop-information-group]",
      )) {
        const entry = saved.groups.find(
          (entry) => entry.key === group.dataset.desktopInformationGroup,
        );
        if (entry) {
          group.open = entry.open;
          const body = group.querySelector<HTMLElement>(
            "[data-desktop-group-content]",
          );
          if (body) body.scrollLeft = entry.left;
        }
      }
      node.scrollTop = saved.top;
    }
    const remember = () => saveInformation(informationKey, node);
    node.addEventListener("toggle", remember, true);
    node.addEventListener("scroll", remember, true);
    return () => {
      remember();
      node.removeEventListener("toggle", remember, true);
      node.removeEventListener("scroll", remember, true);
    };
  }, [informationKey, returnedPosition]);
  const reveal = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      if (scroll) scroll.restore(scroll.collapseTop(node));
      else node.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    },
    [scroll],
  );
  const revealComments = useCallback(
    () => reveal(lowerRegion.current),
    [reveal],
  );
  const onComment = useCallback(() => {
    if (lower.current?.scrollToComments()) {
      revealComments();
      lowerRegion.current
        ?.querySelector<HTMLElement>("[data-detail-reading-strip]")
        ?.focus({ preventScroll: true });
    }
  }, [revealComments]);
  const registerLike = useCallback((run: () => void, enabled: boolean) => {
    like.current = run;
    setCanLike(enabled);
    return () => {
      if (like.current === run) {
        like.current = null;
        setCanLike(false);
      }
    };
  }, []);
  const interactions = useMemo(
    () => ({ onComment, registerLike }),
    [onComment, registerLike],
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
        <div className={styles.firstScreen} data-desktop-detail-first-screen="">
          <div className={styles.hero} data-desktop-detail-upper="">
            {textOnly ? null : (
              <div
                className={styles.mediaColumn}
                data-desktop-detail-image-pane=""
              >
                <nav aria-label="书法阅读定位" className={styles.navigation}>
                  {detail.media.length === 0 ? null : (
                    <button
                      aria-label="前往图片"
                      title="图片"
                      type="button"
                      onClick={() => {
                        reveal(mediaRegion.current);
                        mediaRegion.current
                          ?.querySelector<HTMLElement>(
                            '[data-feed-slide][aria-hidden="false"] [data-feed-slide-image]',
                          )
                          ?.focus({ preventScroll: true });
                      }}
                    >
                      <Icon name="image" />
                    </button>
                  )}
                  <button
                    aria-label={
                      detail.contentType === "work" ? "前往正文" : "前往资料"
                    }
                    title="资料"
                    type="button"
                    onClick={() =>
                      informationRegion.current?.focus({ preventScroll: true })
                    }
                  >
                    <Icon name="category" />
                  </button>
                  {hasColophon ? (
                    <button
                      aria-controls={`${id}-colophon`}
                      aria-label="前往题跋"
                      title="下方题跋"
                      type="button"
                      onClick={onComment}
                    >
                      <Icon name="message" />
                    </button>
                  ) : null}
                </nav>
                <div
                  className={styles.media}
                  ref={mediaRegion}
                  data-detail-calligraphy-media={
                    detail.media.length ? "" : undefined
                  }
                >
                  {detail.media.length ? (
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
                  ) : (
                    <div
                      className={styles.missingMedia}
                      data-detail-media-state="missing"
                    >
                      <MediaFallback
                        label={`暂无公开图像：${detail.title}`}
                        state="missing"
                      />
                    </div>
                  )}
                  {detail.media.length > 1 ? (
                    <div className={styles.imageEdges} aria-label="图像翻页">
                      <button
                        className={styles.previousImage}
                        type="button"
                        aria-label="上一张图像"
                        title="上一张"
                        disabled={activeMediaIndex === 0}
                        onClick={() =>
                          onActiveMediaIndexChange(activeMediaIndex - 1)
                        }
                      >
                        <Icon name="next" />
                      </button>
                      <button
                        className={styles.nextImage}
                        type="button"
                        aria-label="下一张图像"
                        title="下一张"
                        disabled={activeMediaIndex === detail.media.length - 1}
                        onClick={() =>
                          onActiveMediaIndexChange(activeMediaIndex + 1)
                        }
                      >
                        <Icon name="back" />
                      </button>
                    </div>
                  ) : null}
                </div>
                {detailActions === undefined ? null : (
                  <div
                    className={styles.actions}
                    data-desktop-detail-actions=""
                  >
                    {detailActions}
                  </div>
                )}
              </div>
            )}
            <aside
              className={styles.information}
              ref={informationRegion}
              aria-label={
                detail.contentType === "work" ? "作品资料" : "馆藏资料"
              }
              tabIndex={-1}
              data-desktop-detail-information=""
            >
              <div
                className={styles.informationHeading}
                tabIndex={0}
                role="region"
                aria-label="题名与身份"
              >
                {leading}
              </div>
              <div className={styles.informationGroups}>{information}</div>
            </aside>
          </div>
          {hasColophon ? (
            <button
              className={styles.colophonCue}
              data-desktop-colophon-cue=""
              type="button"
              aria-controls={`${id}-colophon`}
              onClick={onComment}
            >
              <span>题跋</span>
              <span className={styles.cueHint}>向下查看 · 横向阅读</span>
              <Icon name="next" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {textOnly && detailActions !== undefined ? (
          <div className={styles.actions} data-desktop-detail-actions="">
            {detailActions}
          </div>
        ) : null}
        {hasColophon ? (
          <section
            className={styles.lower}
            data-desktop-detail-colophon=""
            ref={lowerRegion}
            aria-label="题跋阅读区"
          >
            <header className={styles.colophonHeader}>
              <div>
                <h2>题跋</h2>
                <p>从右向左，横向阅读</p>
              </div>
              <nav aria-label="题跋横向翻页">
                <button
                  type="button"
                  aria-label="向右读题跋"
                  disabled={!paging.backward}
                  title="向右"
                  aria-controls={`${id}-colophon`}
                  onClick={() => lower.current?.scrollByPage("backward")}
                >
                  <Icon name="next" />
                </button>
                <button
                  type="button"
                  aria-label="向左读题跋"
                  disabled={!paging.forward}
                  title="向左"
                  aria-controls={`${id}-colophon`}
                  onClick={() => lower.current?.scrollByPage("forward")}
                >
                  <Icon name="back" />
                </button>
              </nav>
            </header>
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
          </section>
        ) : null}
      </div>
    </DetailInteractionsContext.Provider>
  );
};
