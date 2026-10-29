"use client";

import { useMasonrySlot } from "./catalog-masonry";
import styles from "./desktop-feed.module.css";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/** Reuses each card's native media and activation; only desktop presentation changes. */
export const DesktopCardFrame = ({
  title,
  metadata,
  media,
  preview,
  action,
  ...attributes
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  readonly title: string;
  readonly metadata: string;
  readonly media?: ReactNode;
  readonly preview?: string;
  readonly action?: ReactNode;
}) => {
  const slot = useMasonrySlot()?.desktop;
  return (
    <article {...attributes} className={styles.card} role="listitem">
      <div className={styles.caption}>
        {title === "" ? null : <h3 className={styles.title}>{title}</h3>}
        {metadata === "" ? null : <p className={styles.metadata}>{metadata}</p>}
      </div>
      {media ? (
        <div
          className={styles.media}
          style={
            {
              "--desktop-media-fit": slot?.cropped ? "cover" : "contain",
            } as CSSProperties
          }
        >
          {media}
          {slot?.cropped ? (
            <span className={styles.crop}>局部预览 · 打开查看全图</span>
          ) : null}
        </div>
      ) : (
        <p className={styles.text} data-card-excerpt="">
          {preview}
        </p>
      )}
      {action}
    </article>
  );
};
