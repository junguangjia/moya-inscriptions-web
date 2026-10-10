"use client";
import { Icon } from "@moya/ui";
import styles from "./home-screen.module.css";

import type { CSSProperties } from "react";

/*
 * The small media parts shared by two-column cards and single-column posts:
 * the province badge, the truthful missing or failed image box and the Live
 * badge.
 */

export const CatalogProvinceBadge = ({
  province,
}: {
  province: string | undefined;
}) => {
  const label = province?.trim();
  return label ? (
    <span className={styles.provinceBadge} data-catalog-province="">
      {label}
    </span>
  ) : null;
};

/** The truthful missing or failed image box, shared by cards and posts. */
export const MediaFallback = ({
  aspectRatio,
  label,
  state,
}: {
  readonly aspectRatio?: string;
  readonly label: string;
  readonly state: "failed" | "missing";
}) => (
  <div
    aria-label={label}
    className={styles.mediaFallback}
    data-catalog-media-state={state}
    role="img"
    style={
      aspectRatio === undefined
        ? undefined
        : ({ "--feed-media-ratio": aspectRatio } as CSSProperties)
    }
  >
    <Icon aria-hidden="true" name={state === "failed" ? "error" : "image"} />
    <span>{state === "failed" ? "图像无法加载" : "暂无公开图像"}</span>
  </div>
);

/** A Live Photo cover stays a still; the badge only says motion exists. */
export const CatalogCardLiveBadge = () => (
  <span
    aria-label="实况照片"
    className={styles.liveBadge}
    data-card-live-badge=""
    role="img"
  >
    LIVE
  </span>
);
