"use client";

import { useState } from "react";

import { Icon } from "@moya/ui";
import { useContentQuickActions } from "../quick-actions/content-quick-actions";
import { QuickActionCardAction } from "../quick-actions/quick-action-card-action";

import {
  MEDIA_SIZES,
  placeholderStyle,
  responsiveImage,
} from "../media/responsive-media";
import styles from "./home-screen.module.css";
import { feedMediaAspectRatio } from "./catalog-card";
import { useMasonrySlot } from "./catalog-masonry";

import type { NearbyCard } from "./home-feed";
import type { CSSProperties } from "react";

export const HomeContentCard = ({
  item,
  onMediaSettled,
}: {
  readonly item: NearbyCard;
  readonly onMediaSettled?: () => void;
}) => {
  const quickActions = useContentQuickActions();
  const [failed, setFailed] = useState(false);
  const slot = useMasonrySlot();
  const media = item.media;
  const image =
    media === undefined
      ? undefined
      : responsiveImage(media, MEDIA_SIZES.feedCard(media, slot));

  return (
    <article
      className={`${styles.card} ${styles.feedCard}`}
      data-home-content-card=""
      data-home-content-id={item.id}
      role="listitem"
    >
      {media === undefined || failed ? (
        <div
          aria-label={
            failed ? `图像无法加载：${item.title}` : `暂无图像：${item.title}`
          }
          className={styles.mediaFallback}
          data-catalog-media-state={failed ? "failed" : "missing"}
          role="img"
          style={
            failed && media !== undefined
              ? ({
                  "--feed-media-ratio": feedMediaAspectRatio(media),
                } as CSSProperties)
              : undefined
          }
        >
          <Icon aria-hidden="true" name={failed ? "error" : "image"} />
          <span>{failed ? "图像无法加载" : "暂无图像"}</span>
        </div>
      ) : (
        <div
          className={`${styles.media} ${styles.feedMedia}`}
          style={
            {
              "--feed-media-ratio": feedMediaAspectRatio(media),
            } as CSSProperties
          }
        >
          {/* The image covers its box, so the asset colour shows only until it paints. */}
          <img
            alt={media.alt}
            decoding="async"
            height={media.height}
            loading="lazy"
            onError={() => {
              setFailed(true);
              onMediaSettled?.();
            }}
            onLoad={onMediaSettled}
            sizes={image?.sizes}
            src={image?.src ?? media.src}
            srcSet={image?.srcSet}
            style={placeholderStyle(media.placeholderColor)}
            width={media.width}
          />
        </div>
      )}
      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        {item.metadata === undefined ? null : (
          <p className={styles.cardMetadata}>{item.metadata}</p>
        )}
      </div>
      {quickActions === null ? null : (
        <QuickActionCardAction
          className={styles.cardAction}
          content={{ kind: "nearby", id: item.id, title: item.title }}
          environment={quickActions}
        />
      )}
    </article>
  );
};
