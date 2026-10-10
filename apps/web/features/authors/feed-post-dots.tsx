"use client";
import type { CSSProperties } from "react";
import { mediaDotWindow } from "../detail/media-dot-window";
import styles from "../home/home-screen.module.css";

const nearness = (progress: number, index: number) =>
  Math.max(0, 1 - Math.abs(progress - index));

/**
 * The dot row between a post's stage and its title. It mirrors the strip:
 * the first image's dot is on the right and the comments mark (a small seal)
 * on the left. Dots grow and darken with the live swipe progress; the edge
 * dots of a longer post are smaller to say that more images continue.
 */
export const FeedPostDots = ({
  alts,
  activeIndex,
  progress,
  region,
  hasComments,
  onSelect,
  onSelectComments,
}: {
  readonly alts: readonly string[];
  readonly activeIndex: number;
  readonly progress: number;
  readonly region: "media" | "comments";
  readonly hasComments: boolean;
  readonly onSelect: (index: number) => void;
  readonly onSelectComments: () => void;
}) => {
  const count = alts.length;
  const indicated = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.round(progress)),
  );
  const seal = nearness(progress, count);
  if (count < 2 && !hasComments) return null;
  return (
    <div
      aria-label="选择图像"
      className={styles.postDots}
      data-feed-post-dots=""
      data-feed-post-progress={progress}
      role="group"
    >
      {count < 2
        ? null
        : mediaDotWindow(count, indicated).map(({ index, edge }) => {
            const near = nearness(progress, index);
            return (
              <button
                aria-current={
                  region === "media" && index === activeIndex
                    ? "true"
                    : undefined
                }
                aria-label={`第 ${index + 1} 张图像：${alts[index] ?? ""}`}
                className={styles.postDotTarget}
                data-active={index === indicated ? "true" : "false"}
                data-edge={edge ? "true" : undefined}
                data-feed-post-dot=""
                key={index}
                onClick={() => onSelect(index)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  style={
                    {
                      "--media-dot-size": `${(edge ? 4 : 6) + (edge ? 4 : 2) * near}px`,
                      "--media-dot-weight": `${near * 100}%`,
                    } as CSSProperties
                  }
                />
              </button>
            );
          })}
      {hasComments ? (
        <button
          aria-current={region === "comments" ? "true" : undefined}
          aria-label="转到评论区"
          className={styles.postDotSeal}
          data-active={region === "comments" ? "true" : "false"}
          data-feed-post-dot-comments=""
          onClick={onSelectComments}
          type="button"
        >
          <span
            aria-hidden="true"
            style={
              {
                "--media-dot-size": `${8 + 2 * seal}px`,
                "--media-dot-weight": `${seal * 100}%`,
              } as CSSProperties
            }
          />
        </button>
      ) : null}
    </div>
  );
};
