"use client";

import styles from "./media.module.css";

import type { FeedStageWindow, Size } from "./media-geometry";
import type { CSSProperties } from "react";

/**
 * The feed display window drawn over the crop box of the edit dialog (#244):
 * what the phone single-column stage will show of this frame. The stage
 * centre-crops a frame taller than itself, so a `cover` window dims the band
 * above and below the visible part; a frame the stage shows whole gets no
 * marks (the switch's description says so). The box follows the cropper's
 * own crop area, which is centred in the viewport; until the cropper has
 * laid it out the overlay is hidden but describes itself.
 */
export const FeedWindowOverlay = ({
  window,
  size,
  subtle = false,
}: {
  readonly window: FeedStageWindow;
  readonly size: Size | null;
  /** A lighter dim, for a crop surface that stays on screen while editing. */
  readonly subtle?: boolean;
}) => {
  const band = `${Math.round(((1 - window.height) / 2) * 100000) / 1000}%`;
  return (
    <div
      aria-hidden="true"
      className={styles.feedOverlay}
      data-feed-fit={window.fit}
      data-feed-window=""
      data-subtle={subtle ? "true" : undefined}
      hidden={size === null}
      style={
        {
          width: size === null ? undefined : `${size.width}px`,
          height: size === null ? undefined : `${size.height}px`,
          "--feed-band": band,
        } as CSSProperties
      }
    >
      {window.fit === "cover" ? (
        <>
          <span className={styles.feedBand} data-edge="top" />
          <span className={styles.feedBand} data-edge="bottom" />
        </>
      ) : null}
    </div>
  );
};

/** The switch description: what the stage shows of this frame, in words. */
export const feedWindowHint = (
  window: FeedStageWindow,
  first: boolean,
): string => {
  const fit =
    window.fit === "cover"
      ? `动态中显示亮处：上下各裁去 ${Math.round(((1 - window.height) / 2) * 100)}%，始终居中`
      : window.fit === "fill"
        ? "动态满幅显示"
        : "动态中整张显示，上下留白";
  return first
    ? `${fit}；手机动态流的画幅介于 1:1 与 4:5，由第 1 张决定，超出部分读者点开后可见。`
    : `${fit}（画幅由第 1 张决定）。`;
};
