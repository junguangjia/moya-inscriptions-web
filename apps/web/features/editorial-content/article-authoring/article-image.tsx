"use client";

import { useEffect, useState } from "react";
import type { MediaCrop } from "@moya/contracts";
import { CatalogViewer } from "../../detail/catalog-viewer";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";
import { resolveRuntimePresentationPlatform } from "../../shell/device-platform";
import { LivePhotoFrame } from "../../publishing/ui/live/live-photo";
import { previewPlacement } from "../../publishing/ui/media/media-geometry";
import styles from "./article-media.module.css";

/** Reader-safe media presentation: existing zoom/Live Photo viewer, no editor imports. */
export const ArticleImage = ({
  media,
  active,
  crop = null,
  onCrop,
}: {
  readonly media: DetailMediaPresentation;
  readonly active: boolean;
  readonly crop?: MediaCrop | null;
  readonly onCrop?: () => void;
}) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const placement = previewPlacement(media, { rotation: 0, crop });
  const frame = {
    ...placement.frame,
    position: "absolute" as const,
    maxWidth: "none",
    objectFit: "fill" as const,
    borderRadius: 0,
  };
  const still = (
    <img
      alt={media.alt}
      src={media.src}
      width={media.width}
      height={media.height}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={frame}
    />
  );
  return (
    <>
      <div
        className={styles.bodyImage}
        data-crop-enabled={onCrop !== undefined ? "true" : undefined}
        role={onCrop !== undefined ? "button" : undefined}
        tabIndex={onCrop !== undefined && active ? 0 : undefined}
        aria-label={onCrop !== undefined ? "裁剪图片" : undefined}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            active &&
            onCrop !== undefined &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            onCrop();
          }
        }}
        style={{ aspectRatio: placement.aspectRatio }}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button, a, [data-article-media-control]") !==
              null
          )
            return;
          if (active) {
            if (onCrop !== undefined) onCrop();
            else setOpen(true);
          }
        }}
      >
        {media.live ? (
          <LivePhotoFrame
            active={active && !open}
            motion={media.live}
            className={styles.bodyLive}
            videoStyle={frame}
            controlAttributes={{ "data-article-media-control": "" }}
          >
            {still}
          </LivePhotoFrame>
        ) : (
          still
        )}
        {onCrop === undefined ? (
          <button
            type="button"
            className={styles.zoomButton}
            aria-label="放大查看原图"
            data-article-media-control=""
            disabled={!active}
            onClick={() => setOpen(true)}
          >
            放大
          </button>
        ) : null}
      </div>
      {open && active ? (
        <CatalogViewer
          index={0}
          media={[media]}
          open
          platform={resolveRuntimePresentationPlatform(
            navigator,
            window.innerWidth,
          )}
          onClose={() => setOpen(false)}
          onIndexChange={() => {}}
          controls={
            onCrop === undefined ? undefined : (
              <div
                className={styles.viewerActions}
                data-detail-viewer-control=""
              >
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onCrop();
                  }}
                >
                  裁剪范围
                </button>
              </div>
            )
          }
        />
      ) : null}
    </>
  );
};
