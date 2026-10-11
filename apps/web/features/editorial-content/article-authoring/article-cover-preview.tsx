"use client";

import styles from "./article-cover-preview.module.css";

import type { ReactNode } from "react";

/**
 * The 文章设置 cover preview (#244): the chosen attachment inside the two real
 * card boxes — the compact 资讯 card's square and the large card's 16:10, both
 * covering their box like discussion-preview's `.newsCard > img` — so the
 * author sees what the card will show. The detail page shows the full
 * picture; nothing is stored for the cover beyond the chosen reference.
 */
export const ArticleCoverPreview = ({
  children,
}: {
  /** The cover as the body renderer draws it; null when no cover is chosen. */
  readonly children: ReactNode;
}) =>
  children === null || children === undefined ? null : (
    <div className={styles.coverPreview} data-article-cover-preview="">
      <div className={styles.coverBoxes}>
        <figure className={styles.coverBox}>
          <div
            aria-hidden="true"
            className={styles.coverFrame}
            data-article-cover-box="square"
            data-shape="square"
          >
            {children}
          </div>
          <figcaption>资讯卡片</figcaption>
        </figure>
        <figure className={styles.coverBox}>
          <div
            aria-hidden="true"
            className={styles.coverFrame}
            data-article-cover-box="large"
            data-shape="large"
          >
            {children}
          </div>
          <figcaption>大图卡片</figcaption>
        </figure>
      </div>
      <p className={styles.coverHint}>
        封面在资讯卡片中按卡片框居中裁切显示；正文页显示完整图片。
      </p>
    </div>
  );
