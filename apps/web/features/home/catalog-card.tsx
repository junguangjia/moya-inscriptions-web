"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import {
  FEED_STAGE_MAX_RATIO,
  slideFit,
  slideFraming,
  slidePositionY,
} from "../authors/feed-post-strip-geometry";
import {
  MEDIA_SIZES,
  mediaLoading,
  placeholderStyle,
  responsiveImage,
} from "../media/responsive-media";
import styles from "./home-screen.module.css";
import {
  CatalogCardLiveBadge,
  CatalogProvinceBadge,
  MediaFallback,
} from "./card-media-parts";
import { useFeedPostSlot, useMasonrySlot } from "./catalog-masonry";
import { CatalogFeedPost } from "./catalog-feed-post";
import { DesktopCardFrame } from "./desktop-card-frame";
import { useContentQuickActions } from "../quick-actions/content-quick-actions";
import { QuickActionCardAction } from "../quick-actions/quick-action-card-action";

import type { ComponentType, CSSProperties, ReactNode } from "react";
import type {
  CatalogSummary,
  MediaFeedFraming,
  PublicMedia,
} from "@moya/contracts";
import type {
  MediaPriority,
  RenditionCandidate,
} from "../media/responsive-media";

export type CatalogCardVariant = "feed" | "inscription";

export interface CatalogCardProps {
  readonly item: CatalogSummary;
  readonly onMediaSettled?: () => void;
  readonly onOpenCatalog?: (
    item: CatalogSummary,
    opener: HTMLButtonElement,
  ) => void;
  /** Set by the list for the first cards of the first visible page only. */
  readonly priority?: MediaPriority | undefined;
  readonly variant: CatalogCardVariant;
}

type CatalogMediaDimensions = Pick<PublicMedia, "height" | "width">;

export const isUltraWideCatalogMedia = (
  media: CatalogMediaDimensions | undefined,
): boolean => {
  if (media === undefined) return false;
  const { height, width } = media;
  return (
    Number.isFinite(height) &&
    Number.isFinite(width) &&
    height > 0 &&
    width > 0 &&
    width / height >= 2.4
  );
};

/** Keep cover crops legible without letting panoramas or scrolls dictate card size. */
export const feedMediaAspectRatio = (media: CatalogMediaDimensions): number => {
  const ratio = media.width / media.height;
  return Number.isFinite(ratio) && ratio > 0
    ? Math.min(3 / 2, Math.max(3 / 4, ratio))
    : 4 / 3;
};

/**
 * The feed card box's height / width (.feedMedia): the image's own shape
 * within 3:4 and 3:2, or 3:2 for a card covering every column (an
 * aligned-row feature is drawn 3:2, and a panorama's own shape clamps there
 * too).
 */
export const feedMediaBoxRatio = (
  media: CatalogMediaDimensions,
  span: boolean,
): number => (span ? 2 / 3 : 1 / feedMediaAspectRatio(media));

export {
  CatalogCardLiveBadge,
  CatalogProvinceBadge,
  MediaFallback,
} from "./card-media-parts";

const catalogKindLabels = {
  calligraphy: "书帖",
  inscription: "碑刻",
} as const satisfies Record<CatalogSummary["kind"], string>;

/** The card image: its anchor `src` and size, plus card candidates up to it. */
export type CatalogCardMediaSource = Pick<
  PublicMedia,
  "src" | "alt" | "width" | "height"
> & {
  readonly renditions?: readonly RenditionCandidate[] | undefined;
  /** The opaque asset's colour, painted behind the covered box while it loads. */
  readonly placeholderColor?: string | undefined;
  /**
   * A work cover's effective feed framing as the Backend reads it (absent:
   * a centred cover), sent only without a cover composition; never on a
   * Catalog image.
   */
  readonly feed?: MediaFeedFraming | undefined;
};

export const CatalogCardMedia = ({
  live = false,
  media,
  onMediaSettled,
  priority,
  title,
  variant,
}: {
  /** Shows the LIVE badge on a valid cover; never plays anything. */
  readonly live?: boolean;
  readonly media: CatalogCardMediaSource | undefined;
  readonly onMediaSettled?: () => void;
  readonly priority?: MediaPriority | undefined;
  readonly title: string;
  readonly variant: CatalogCardVariant;
}) => {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const slot = useMasonrySlot();

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete === true && image.naturalWidth === 0) {
      setFailed(true);
      onMediaSettled?.();
    }
  }, [media, onMediaSettled]);

  if (media === undefined) {
    return <MediaFallback label={`暂无公开图像：${title}`} state="missing" />;
  }
  if (failed) {
    return (
      <MediaFallback
        {...(variant === "feed"
          ? { aspectRatio: String(feedMediaAspectRatio(media)) }
          : {})}
        label={`图像无法加载：${title}`}
        state="failed"
      />
    );
  }

  const image = responsiveImage(
    media,
    variant === "inscription"
      ? MEDIA_SIZES.inscriptionCard(media)
      : MEDIA_SIZES.feedCard(media, slot),
  );
  // A feed card whose work cover is taller than its box keeps the author's
  // feed framing there, as the phone feed does: the chosen region, or the
  // whole still; every other card covers its box at the centre. Only a
  // framing the author could choose counts: 编辑 offers one for a cover
  // taller than even the tallest feed stage (photo 1's own, at most 4:5),
  // and one kept from an earlier, taller crop is dormant on any other, which
  // a wider box (a 3:2 card across the row) must not bring back.
  const feed =
    variant === "feed" && slideFit(media, FEED_STAGE_MAX_RATIO) === "cover"
      ? media.feed
      : undefined;
  const boxRatio = feedMediaBoxRatio(media, slot?.span === true);
  const framing = slideFraming(media, boxRatio, feed);
  const fit = slot?.desktop
    ? slot.desktop.cropped
      ? "cover"
      : "contain"
    : framing === undefined
      ? "cover"
      : slideFit(media, boxRatio, feed);
  const positionY = slot?.desktop
    ? slidePositionY(
        media,
        slot.desktop.height / slot.desktop.mediaWidth,
        media.feed,
      )
    : framing === undefined
      ? undefined
      : slidePositionY(media, boxRatio, feed);
  return (
    <div
      className={`${styles.media} ${
        variant === "inscription" ? styles.inscriptionMedia : styles.feedMedia
      }`}
      data-catalog-media-state="valid"
      data-feed-framing={framing}
      data-fit={framing === undefined ? undefined : fit}
      style={
        variant === "feed"
          ? ({
              "--feed-media-ratio": feedMediaAspectRatio(media),
              ...(positionY === undefined
                ? {}
                : { "--feed-media-y": positionY }),
            } as CSSProperties)
          : undefined
      }
    >
      {/* The image covers its own box (object-fit: cover), so the asset
          colour behind it shows only until it paints; a whole still leaves
          blank sides that must never be tinted, and an inscription card's
          box can grow taller than its image and keeps its own background. */}
      <img
        ref={imageRef}
        alt={media.alt}
        decoding="async"
        height={media.height}
        {...mediaLoading(priority)}
        onError={() => {
          setFailed(true);
          onMediaSettled?.();
        }}
        onLoad={onMediaSettled}
        sizes={image.sizes}
        src={image.src}
        srcSet={image.srcSet}
        style={
          fit === "cover" ? placeholderStyle(media.placeholderColor) : undefined
        }
        width={media.width}
      />
      {live ? <CatalogCardLiveBadge /> : null}
    </div>
  );
};

export const CatalogCardPresentation = ({
  item,
  onMediaSettled,
  onOpenCatalog,
  priority,
  variant,
}: CatalogCardProps) => {
  const quickActions = useContentQuickActions();
  const pointerStartYRef = useRef<number | null>(null);
  const suppressActivationRef = useRef(false);
  const feedSpan =
    variant === "feed" && isUltraWideCatalogMedia(item.representativeMedia)
      ? "full"
      : undefined;
  const metadata = [catalogKindLabels[item.kind], item.periodLabel]
    .filter((value) => value !== undefined)
    .join(" · ");
  const post = useFeedPostSlot() && variant === "feed";
  const desktop = useMasonrySlot()?.desktop;

  if (desktop)
    return (
      <DesktopCardFrame
        title={item.title}
        {...(item.summary ? { preview: item.summary } : {})}
        metadata={[metadata, item.province].filter(Boolean).join(" · ")}
        data-catalog-card=""
        data-catalog-card-variant={variant}
        data-catalog-id={item.id}
        data-catalog-kind={item.kind}
        media={
          <CatalogCardMedia
            media={
              item.representativeMedia
                ? {
                    ...item.representativeMedia,
                    src: localCatalogMediaSrc(
                      item.representativeMedia.src,
                      item.id,
                      item.representativeMedia.id,
                    ),
                    renditions: localCatalogRenditions(
                      item.representativeMedia.renditions,
                    ),
                  }
                : undefined
            }
            title={item.title}
            variant="feed"
            priority={priority}
            {...(onMediaSettled ? { onMediaSettled } : {})}
          />
        }
        action={
          onOpenCatalog === undefined ? null : quickActions ? (
            <QuickActionCardAction
              className={styles.cardAction}
              content={{ kind: "catalog", id: item.id, title: item.title }}
              environment={quickActions}
              onActivate={(opener) => onOpenCatalog(item, opener)}
            />
          ) : (
            <button
              type="button"
              aria-label={`打开${item.title}`}
              data-open-catalog=""
              className={styles.cardAction}
              onClick={(event) => {
                if (suppressActivationRef.current) {
                  suppressActivationRef.current = false;
                  event.preventDefault();
                  return;
                }
                onOpenCatalog(item, event.currentTarget);
              }}
              onPointerCancel={() => {
                pointerStartYRef.current = null;
                suppressActivationRef.current = true;
              }}
              onPointerDown={(event) => {
                pointerStartYRef.current = event.clientY;
                suppressActivationRef.current = false;
              }}
              onPointerMove={(event) => {
                const y = pointerStartYRef.current;
                if (y !== null && Math.abs(event.clientY - y) > 8)
                  suppressActivationRef.current = true;
              }}
              onPointerUp={() => {
                pointerStartYRef.current = null;
              }}
            />
          )
        }
      />
    );

  if (post)
    return (
      <CatalogFeedPost
        feedSpan={feedSpan}
        item={item}
        metadata={metadata}
        onOpenCatalog={onOpenCatalog}
        onMediaSettled={onMediaSettled}
        priority={priority}
        quickActions={quickActions}
      />
    );
  return (
    <article
      className={`${styles.card} ${
        variant === "inscription" ? styles.inscriptionCard : styles.feedCard
      }`}
      data-catalog-card=""
      data-catalog-card-variant={variant}
      data-catalog-feed-span={feedSpan}
      data-catalog-id={item.id}
      data-catalog-kind={item.kind}
      role={variant === "feed" ? "listitem" : undefined}
    >
      <CatalogCardMedia
        media={
          item.representativeMedia
            ? {
                ...item.representativeMedia,
                src: localCatalogMediaSrc(
                  item.representativeMedia.src,
                  item.id,
                  item.representativeMedia.id,
                ),
                renditions: localCatalogRenditions(
                  item.representativeMedia.renditions,
                ),
              }
            : undefined
        }
        {...(onMediaSettled === undefined ? {} : { onMediaSettled })}
        priority={priority}
        title={item.title}
        variant={variant}
      />
      <CatalogProvinceBadge province={item.province} />
      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        <p className={styles.cardMetadata}>{metadata}</p>
        {variant === "inscription" && item.summary !== undefined ? (
          <p className={styles.cardSummary}>{item.summary}</p>
        ) : null}
      </div>
      {onOpenCatalog === undefined ? null : quickActions !== null &&
        variant === "feed" ? (
        <QuickActionCardAction
          className={styles.cardAction}
          content={{ kind: "catalog", id: item.id, title: item.title }}
          environment={quickActions}
          onActivate={(opener) => onOpenCatalog(item, opener)}
        />
      ) : (
        <button
          type="button"
          aria-label={`打开${item.title}`}
          className={styles.cardAction}
          data-open-catalog=""
          onClick={(event) => {
            if (suppressActivationRef.current) {
              suppressActivationRef.current = false;
              event.preventDefault();
              return;
            }
            onOpenCatalog(item, event.currentTarget);
          }}
          onPointerCancel={() => {
            pointerStartYRef.current = null;
            suppressActivationRef.current = true;
          }}
          onPointerDown={(event) => {
            pointerStartYRef.current = event.clientY;
            suppressActivationRef.current = false;
          }}
          onPointerMove={(event) => {
            const startY = pointerStartYRef.current;
            if (startY !== null && Math.abs(event.clientY - startY) > 8) {
              suppressActivationRef.current = true;
            }
          }}
          onPointerUp={() => {
            pointerStartYRef.current = null;
          }}
        />
      )}
    </article>
  );
};

const CatalogRenderer = createContext<ComponentType<CatalogCardProps> | null>(
  null,
);
export const CatalogCardRendererProvider = ({
  component,
  children,
}: {
  component: ComponentType<CatalogCardProps>;
  children: ReactNode;
}) => (
  <CatalogRenderer.Provider value={component}>
    {children}
  </CatalogRenderer.Provider>
);
export const CatalogCard = (props: CatalogCardProps) => {
  const Renderer = useContext(CatalogRenderer) ?? CatalogCardPresentation;
  return <Renderer {...props} />;
};
