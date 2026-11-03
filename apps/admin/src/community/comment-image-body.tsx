"use client";

import { Fragment, useState } from "react";
import type { OperatorComment } from "@moya/contracts/internal/community-operator";
import styles from "./community.module.css";

/** Operator URLs are resolved by Backend and remain Owner-authorized on each read. */
export const CommentImageBody = ({
  text,
  images,
}: Pick<OperatorComment, "text" | "images">) => {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const ordered = (images ?? [])
    .map((image, index) => ({ image, index }))
    .sort((a, b) => a.image.offset - b.image.offset || a.index - b.index);
  let previous = 0;
  return (
    <>
      {ordered.map(({ image }, index) => {
        const at = Math.max(previous, Math.min(text.length, image.offset));
        const before = text.slice(previous, at);
        previous = at;
        return (
          <Fragment key={image.id}>
            {before}
            <a
              aria-label={`查看评论附图 ${index + 1}`}
              className={styles.commentImage}
              data-operator-comment-image={image.id}
              href={image.fullSrc ?? image.src}
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              target="_blank"
            >
              {failed.has(image.id) ? (
                <span>附图 {index + 1} 暂不可用，点击重试</span>
              ) : (
                <img
                  alt={`评论附图 ${index + 1}`}
                  decoding="async"
                  height={64}
                  loading="lazy"
                  onError={() => setFailed((old) => new Set(old).add(image.id))}
                  src={image.thumbSrc}
                  width={64}
                />
              )}
            </a>
          </Fragment>
        );
      })}
      {text.slice(previous)}
    </>
  );
};
