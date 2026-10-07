"use client";

import { useState } from "react";

import { Icon } from "@moya/ui";
import { useMasonrySlot } from "../home/catalog-masonry";
import {
  MEDIA_SIZES,
  placeholderStyle,
  responsiveImage,
} from "../media/responsive-media";
import { useContentQuickActions } from "../quick-actions/content-quick-actions";
import { QuickActionCardAction } from "../quick-actions/quick-action-card-action";

import styles from "./topic-detail.module.css";

import type { CSSProperties } from "react";
import type { Topic } from "./topic";

export const TopicCard = ({
  onMediaSettled,
  onOpen,
  topic,
}: {
  readonly onMediaSettled?: () => void;
  readonly onOpen: (topic: Topic, opener: HTMLButtonElement) => void;
  readonly topic: Topic;
}) => {
  const quickActions = useContentQuickActions();
  const [failed, setFailed] = useState(false);
  const slot = useMasonrySlot();
  const cover = topic.cover;
  // The card image keeps its own aspect, so the asset colour fills exactly
  // the box it will cover.
  const image =
    cover === undefined
      ? undefined
      : responsiveImage(cover, MEDIA_SIZES.topicCard(slot));

  const body = (
    <>
      {cover === undefined || failed ? (
        <span
          aria-label={
            failed
              ? `图像无法加载：${topic.title}`
              : `暂无专题封面：${topic.title}`
          }
          className={styles.coverFallback}
          data-topic-cover-state={failed ? "failed" : "missing"}
          role="img"
          style={
            failed && cover !== undefined
              ? ({
                  aspectRatio: `${cover.width} / ${cover.height}`,
                } satisfies CSSProperties)
              : undefined
          }
        >
          <Icon aria-hidden="true" name={failed ? "error" : "image"} />
        </span>
      ) : (
        <img
          alt={cover.alt}
          decoding="async"
          height={cover.height}
          loading="lazy"
          onError={() => {
            setFailed(true);
            onMediaSettled?.();
          }}
          onLoad={onMediaSettled}
          sizes={image?.sizes}
          src={image?.src ?? cover.src}
          srcSet={image?.srcSet}
          style={placeholderStyle(cover.placeholderColor)}
          width={cover.width}
        />
      )}
      <span className={styles.topicCardBody}>
        <span className={styles.badge}>
          {topic.kind === "editorialTopic" ? "专题/策展" : "专题"}
        </span>
        <span className={styles.topicCardTitle}>{topic.title}</span>
        <span className={styles.topicCardBlurb}>{topic.blurb}</span>
      </span>
    </>
  );

  return (
    <article role="listitem">
      {quickActions === null ? (
        <button
          type="button"
          className={styles.topicCard}
          data-topic-card=""
          data-topic-id={topic.id}
          data-topic-kind={topic.kind}
          onClick={(event) => onOpen(topic, event.currentTarget)}
        >
          {body}
        </button>
      ) : (
        <QuickActionCardAction
          className={styles.topicCard}
          content={{ kind: "topic", id: topic.id, title: topic.title }}
          environment={quickActions}
          topicKind={topic.kind}
          onActivate={(opener) => onOpen(topic, opener)}
        >
          {body}
        </QuickActionCardAction>
      )}
    </article>
  );
};
