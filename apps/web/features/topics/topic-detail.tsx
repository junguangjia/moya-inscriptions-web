"use client";

import { useEffect, useState } from "react";

import { Icon } from "@moya/ui";

import { CatalogCard, isUltraWideCatalogMedia } from "../home/catalog-card";
import { CatalogMasonry } from "../home/catalog-masonry";
import { MEDIA_SIZES, responsiveImage } from "../media/responsive-media";
import styles from "./topic-detail.module.css";

import type { CSSProperties, RefObject } from "react";
import type { FeedLayoutPreference } from "../product-shell/preferences";
import type { PresentationPlatform } from "../shell/device-platform";
import type { Topic, TopicImageBlock } from "./topic";

const TopicImage = ({ block }: { readonly block: TopicImageBlock }) => {
  const [failed, setFailed] = useState(false);
  const image = responsiveImage(block.media, MEDIA_SIZES.topicBlock());
  return (
    <figure className={styles.imageBlock} data-topic-block="image">
      {failed ? (
        <div
          aria-label={`图像无法加载：${block.media.alt}`}
          className={styles.blockMediaFallback}
          data-topic-block-media-state="failed"
          role="img"
          style={
            {
              aspectRatio: `${block.media.width} / ${block.media.height}`,
            } satisfies CSSProperties
          }
        >
          <Icon aria-hidden="true" name="error" />
          <span>图像无法加载</span>
        </div>
      ) : (
        <img
          alt={block.media.alt}
          decoding="async"
          height={block.media.height}
          loading="lazy"
          onError={() => setFailed(true)}
          sizes={image.sizes}
          src={image.src}
          srcSet={image.srcSet}
          width={block.media.width}
        />
      )}
      {block.caption === undefined ? null : (
        <figcaption>{block.caption}</figcaption>
      )}
    </figure>
  );
};

export interface TopicDetailProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly feedLayout: FeedLayoutPreference;
  readonly onClose: () => void;
  readonly platform: PresentationPlatform;
  readonly topic: Topic | null;
  readonly onUnavailable?: () => void;
}

export const TopicDetail = ({
  backButtonRef,
  feedLayout,
  onClose,
  platform,
  topic,
  onUnavailable,
}: TopicDetailProps) => {
  useEffect(() => {
    if (topic === null) onUnavailable?.();
  }, [topic, onUnavailable]);
  return (
    <section
      aria-label={topic === null ? "专题未找到" : `专题：${topic.title}`}
      aria-modal="true"
      className={styles.overlay}
      data-topic-detail=""
      data-topic-detail-state={topic === null ? "not-found" : "loaded"}
      role="dialog"
    >
      <header className={styles.detailHeader}>
        <button
          ref={backButtonRef}
          type="button"
          aria-label="返回专题"
          className="yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md"
          data-topic-back=""
          onClick={onClose}
        >
          <Icon name="back" />
        </button>
        <h1>{topic?.title ?? "专题未找到"}</h1>
        <span aria-hidden="true" className={styles.headerSpacer} />
      </header>
      <div className={styles.detailScroll} data-topic-detail-scroll="">
        <main className={styles.reading}>
          {topic === null ? (
            <section className={styles.notFound} role="status">
              <h2>未找到这个专题</h2>
              <p>该专题可能已移除，返回专题列表后可以继续浏览。</p>
            </section>
          ) : (
            <>
              <p className={styles.badge}>
                {topic.kind === "editorialTopic" ? "专题/策展" : "专题"}
              </p>
              <p className={styles.detailBlurb}>{topic.blurb}</p>
              {topic.kind === "editorialTopic" ? (
                <div data-topic-blocks="">
                  {topic.blocks.map((block, index) => {
                    switch (block.type) {
                      case "lead":
                        return (
                          <p
                            key={index}
                            className={styles.lead}
                            data-topic-block="lead"
                          >
                            {block.text}
                          </p>
                        );
                      case "rich-text":
                        return (
                          <p
                            key={index}
                            className={styles.richText}
                            data-topic-block="rich-text"
                          >
                            {block.text}
                          </p>
                        );
                      case "quote":
                        return (
                          <blockquote
                            key={index}
                            className={styles.quote}
                            data-topic-block="quote"
                          >
                            {block.text}
                          </blockquote>
                        );
                      case "image":
                        return <TopicImage key={index} block={block} />;
                      case "video":
                        return (
                          <div
                            key={index}
                            aria-label={block.caption}
                            className={styles.videoPlaceholder}
                            data-topic-block="video"
                            role="img"
                          >
                            {block.caption}
                          </div>
                        );
                    }
                  })}
                </div>
              ) : (
                <section className={styles.collection} data-topic-collection="">
                  {topic.records.length === 0 ? (
                    <p className={styles.collectionEmpty} role="status">
                      当前专题没有可展示的公开档案。
                    </p>
                  ) : (
                    <CatalogMasonry
                      feedLayout={feedLayout}
                      getKey={(record) => record.id}
                      isFullSpan={(record) =>
                        isUltraWideCatalogMedia(record.representativeMedia)
                      }
                      items={topic.records}
                      platform={platform}
                      renderItem={(record, onMediaSettled) => (
                        <CatalogCard
                          item={record}
                          onMediaSettled={onMediaSettled}
                          variant="feed"
                        />
                      )}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </section>
  );
};
