"use client";

import { useMasonrySlot } from "./catalog-masonry";
import styles from "./desktop-feed.module.css";
import { useId } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/** Keep canonical text intact while giving actual edition notes a quieter role. */
export const desktopCardTitleParts = (title: string) => {
  const bookEnd = title.lastIndexOf("》");
  if (bookEnd > 0 && bookEnd < title.length - 1)
    return {
      primary: title.slice(0, bookEnd + 1),
      suffix: title.slice(bookEnd + 1),
    };
  const trailing = title.match(/^(.*?)(（[^（）]{1,10}）)$/u);
  return trailing
    ? { primary: trailing[1]!, suffix: trailing[2]! }
    : { primary: title, suffix: "" };
};

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
  const excerpt = preview?.trim() ?? "";
  const descriptionId = useId();
  const hasDescription = Boolean(media && excerpt !== "");
  const parts = desktopCardTitleParts(title);
  return (
    <article
      {...attributes}
      className={styles.card}
      data-card-media={media ? "true" : "false"}
      role="listitem"
      aria-describedby={
        [
          attributes["aria-describedby"],
          hasDescription ? descriptionId : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      style={
        {
          ...attributes.style,
          "--desktop-card-height": `${slot?.height ?? 400}px`,
        } as CSSProperties
      }
    >
      <div className={styles.caption} data-card-caption="">
        {title === "" ? null : (
          <h3 className={styles.title} title={title}>
            <span className={styles.titlePrimary} data-card-title-primary="">
              {parts.primary}
            </span>
            {parts.suffix === "" ? null : (
              <span className={styles.titleSuffix} data-card-title-suffix="">
                {parts.suffix}
              </span>
            )}
          </h3>
        )}
        {hasDescription ? (
          <p
            id={descriptionId}
            className={styles.excerpt}
            data-card-caption-excerpt=""
          >
            {excerpt}
          </p>
        ) : null}
        {metadata === "" ? null : (
          <p className={styles.metadata} title={metadata}>
            {metadata}
          </p>
        )}
      </div>
      {media ? (
        <div
          className={styles.media}
          data-card-media-frame=""
          style={
            {
              "--desktop-media-fit": slot?.cropped ? "cover" : "contain",
            } as CSSProperties
          }
        >
          {media}
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
